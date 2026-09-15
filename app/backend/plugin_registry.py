"""plugin_registry.py — bundles that contribute capabilities to the agent.

A plugin is a directory with a ``plugin.json`` manifest. It does not run code of
its own; it *contributes* things the agent already knows how to load:

    <plugin>/
      plugin.json
      skills/reviewer/SKILL.md
      agents/security-auditor.yaml

Why a bundle instead of a new runtime
-------------------------------------
The obvious reading of "plugin" is a VS Code-style extension host: a second
process, an API surface, activation events. That is the right design when the
host is an editor with a thousand extension points. Ovolve's capabilities are
already file-driven — a skill is a SKILL.md, a sub-agent is a YAML file — so the
useful unit of distribution is a *bundle of those files with one identity, one
version and one on/off switch*. Anthropic's plugin format made the same call.
Building an extension host first would have produced a lot of machinery and
nothing installable.

So the contribution set is deliberately closed and small:
  ``contributes.skills``     — directories, each containing a SKILL.md
  ``contributes.subagents``  — sub-agent YAML files
Anything else in the manifest is carried for display and ignored on purpose,
rather than silently pretending to work. MCP servers are NOT a plugin
contribution: they already have their own lifecycle, config file and UI, and
duplicating that inside a plugin would give two places to look for one server.

State model
-----------
Status is in-memory, exactly like ``skill_loader``: ``discover()`` runs at boot
and a toggle lasts for the process. Persisting the disabled set would mean
writing to config.json from here, which couples a loader to the server's config
module; the loader stays a loader.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Optional

from result import Result

#: Manifest filename. Fixed, not configurable — a plugin the user has to
#: describe twice (once in a manifest, once in a setting) is not installable.
MANIFEST_NAME = "plugin.json"

#: Contribution keys we actually apply. Everything else in `contributes` is
#: preserved for display and reported as unsupported.
SUPPORTED_CONTRIBUTIONS = ("skills", "subagents")


@dataclass
class PluginEntry:
    """One installed plugin plus what it managed to contribute."""
    name: str
    root: str
    version: str = ""
    description: str = ""
    author: str = ""
    homepage: str = ""
    #: ``loaded`` | ``disabled`` | ``broken``
    status: str = "loaded"
    error: str = ""
    #: Names actually registered, so disable() can take exactly them back out.
    skills: list = field(default_factory=list)
    subagents: list = field(default_factory=list)
    #: Declared-but-unapplied contribution keys, surfaced instead of ignored.
    unsupported: list = field(default_factory=list)
    #: Raw `contributes` block, kept so the UI can show what it asked for even
    #: when the plugin is disabled and nothing is registered.
    declared: dict = field(default_factory=dict)

    def to_public(self) -> dict:
        return {
            "name": self.name,
            "root": self.root,
            "version": self.version,
            "description": self.description,
            "author": self.author,
            "homepage": self.homepage,
            "status": self.status,
            "error": self.error,
            "skills": list(self.skills),
            "subagents": list(self.subagents),
            "unsupported": list(self.unsupported),
            "declaredSkills": len(self.declared.get("skills") or []),
            "declaredSubagents": len(self.declared.get("subagents") or []),
        }


def _read_manifest(plugin_dir: str) -> Result:
    """Read + validate ``plugin.json``. Success payload is the parsed dict."""
    path = os.path.join(plugin_dir, MANIFEST_NAME)
    if not os.path.isfile(path):
        return Result.failure(f"{MANIFEST_NAME} not found in {plugin_dir}")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as exc:
        return Result.failure(f"{MANIFEST_NAME} is not valid JSON: {exc}")
    except OSError as exc:
        return Result.failure(f"cannot read {MANIFEST_NAME}: {exc}")
    if not isinstance(data, dict):
        return Result.failure(f"{MANIFEST_NAME} must be a JSON object")
    name = str(data.get("name") or "").strip()
    if not name:
        return Result.failure("manifest is missing 'name'")
    # A name that is a path fragment would let a manifest escape its own
    # directory when the name is later used to build one.
    if any(ch in name for ch in "/\\") or name in (".", ".."):
        return Result.failure(f"illegal plugin name '{name}'")
    # ── manifest v2（Phase 6）：apiVersion / trust / permissions 入门校验 ──
    api_version = str(data.get("apiVersion") or "1")
    if api_version not in ("1", "2"):
        return Result.failure(
            f"unsupported apiVersion {api_version!r} (supported: 1, 2)")
    trust = str(data.get("trust") or "untrusted").strip().lower()
    if trust not in ("trusted", "untrusted", "own"):
        return Result.failure(f"illegal trust {trust!r} "
                              "(expected trusted|untrusted|own)")
    permissions = data.get("permissions")
    if permissions is not None and not isinstance(permissions, dict):
        return Result.failure("'permissions' must be an object "
                              "{filesystem, network, credentials, process}")
    unknown_contribs = [k for k in (data.get("contributes") or {})
                        if k not in SUPPORTED_CONTRIBUTIONS]
    if unknown_contribs and data.get("strictContributions"):
        return Result.failure(f"unsupported contributions: {unknown_contribs}")
    return Result.success(data)


def _resolve_inside(root: str, rel: str) -> Optional[str]:
    """Join ``rel`` onto ``root``, refusing anything that escapes ``root``.

    A manifest is untrusted input. ``"skills": ["../../../etc"]`` must not turn
    into a load from outside the plugin, so containment is checked on the real
    path rather than by string inspection (which ``..`` and symlinks defeat).
    """
    root_real = os.path.realpath(root)
    target = os.path.realpath(os.path.join(root_real, rel))
    if target == root_real or target.startswith(root_real + os.sep):
        return target
    return None


class PluginRegistry:
    """All known plugins, keyed by manifest name. Process-wide singleton."""

    def __init__(self) -> None:
        self._plugins: dict[str, PluginEntry] = {}

    # ------------------------------------------------------------------
    # Install / discovery
    # ------------------------------------------------------------------

    def default_roots(self) -> list:
        """Project-local first, then user-global — same order as skills, so a
        project can pin a plugin version the machine also has globally."""
        here = os.path.dirname(os.path.abspath(__file__))
        project = os.path.abspath(os.path.join(here, "..", ".."))
        return [
            os.path.join(project, ".agents", "plugins"),
            os.path.expanduser(os.path.join("~", ".agents", "plugins")),
        ]

    def import_plugin(self, plugin_dir: str, *, activate: bool = True) -> Result:
        """Register one plugin directory. Returns the PluginEntry payload."""
        plugin_dir = os.path.abspath(os.path.expanduser(plugin_dir))
        manifest = _read_manifest(plugin_dir)
        if not manifest.ok:
            return manifest
        data = manifest.value
        contributes = data.get("contributes") or {}
        if not isinstance(contributes, dict):
            contributes = {}

        entry = PluginEntry(
            name=str(data["name"]).strip(),
            root=plugin_dir,
            version=str(data.get("version") or ""),
            description=str(data.get("description") or ""),
            author=str(data.get("author") or ""),
            homepage=str(data.get("homepage") or ""),
            declared=contributes,
            unsupported=sorted(
                k for k in contributes if k not in SUPPORTED_CONTRIBUTIONS
            ),
        )
        self._plugins[entry.name] = entry
        if activate:
            self._activate(entry)
        else:
            entry.status = "disabled"
        return Result.success(entry.to_public())

    def discover(self, roots: Optional[list] = None) -> dict:
        """Scan the plugin roots and import every ``<root>/<name>/plugin.json``.

        First copy of a name wins, so a project-local plugin shadows the global
        one instead of the two fighting over the same registry slot.
        """
        for root in (roots if roots is not None else self.default_roots()):
            if not os.path.isdir(root):
                continue
            for child in sorted(os.listdir(root)):
                plugin_dir = os.path.join(root, child)
                if not os.path.isdir(plugin_dir):
                    continue
                if not os.path.isfile(os.path.join(plugin_dir, MANIFEST_NAME)):
                    continue
                probe = _read_manifest(plugin_dir)
                if probe.ok and str(probe.value.get("name") or "") in self._plugins:
                    continue  # already claimed by an earlier root
                self.import_plugin(plugin_dir)
        return {
            "loaded": [p.name for p in self._plugins.values() if p.status == "loaded"],
            "broken": [
                {"name": p.name, "error": p.error}
                for p in self._plugins.values() if p.status == "broken"
            ],
        }

    # ------------------------------------------------------------------
    # Activation
    # ------------------------------------------------------------------

    def _activate(self, entry: PluginEntry) -> None:
        """Apply the plugin's contributions. Never raises.

        Partial success is a real state and is reported as one: a plugin whose
        three skills load but whose sub-agent YAML is malformed comes back
        ``loaded`` with an ``error`` describing the miss. Failing the whole
        plugin would throw away work that is fine; failing silently would leave
        the user wondering why their persona never showed up.
        """
        from skill_loader import get_skill_loader, TrustLevel
        from subagent_registry import load_subagent_file, register_subagent_def

        problems: list = []
        entry.skills = []
        entry.subagents = []

        loader = get_skill_loader()
        for rel in (entry.declared.get("skills") or []):
            target = _resolve_inside(entry.root, str(rel))
            if target is None:
                problems.append(f"skill path '{rel}' escapes the plugin directory")
                continue
            # Trust is UNTRUSTED, same as any hand-imported skill: arriving
            # inside a plugin is not evidence about the content.
            res = loader.import_skill(target, TrustLevel.UNTRUSTED)
            if res.ok and isinstance(res.value, dict) and res.value.get("name"):
                entry.skills.append(res.value["name"])
            elif res.ok:
                entry.skills.append(os.path.basename(target))
            else:
                problems.append(f"skill '{rel}': {res.error}")

        for rel in (entry.declared.get("subagents") or []):
            target = _resolve_inside(entry.root, str(rel))
            if target is None:
                problems.append(f"subagent path '{rel}' escapes the plugin directory")
                continue
            definition = load_subagent_file(target)
            if definition is None:
                problems.append(f"subagent '{rel}': not a usable definition")
                continue
            if not register_subagent_def(definition):
                problems.append(
                    f"subagent '{definition.name}' already exists — not overwritten"
                )
                continue
            entry.subagents.append(definition.name)

        nothing_landed = (
            not entry.skills and not entry.subagents
            and (entry.declared.get("skills") or entry.declared.get("subagents"))
        )
        entry.error = "; ".join(problems)
        entry.status = "broken" if nothing_landed else "loaded"

    def _deactivate(self, entry: PluginEntry) -> None:
        """Take the plugin's contributions back out of the live registries."""
        from skill_loader import get_skill_loader
        from subagent_registry import unregister_subagent_def

        loader = get_skill_loader()
        for name in entry.skills:
            try:
                loader.disable_skill(name)
            except Exception:  # noqa: BLE001 — a stuck skill is not fatal here
                pass
        for name in entry.subagents:
            unregister_subagent_def(name)
        entry.skills = []
        entry.subagents = []

    # ------------------------------------------------------------------
    # Toggles / query
    # ------------------------------------------------------------------

    def enable(self, name: str) -> Result:
        entry = self._plugins.get(name)
        if entry is None:
            return Result.failure(f"unknown plugin '{name}'")
        self._activate(entry)
        return Result.success(entry.to_public())

    def disable(self, name: str) -> Result:
        entry = self._plugins.get(name)
        if entry is None:
            return Result.failure(f"unknown plugin '{name}'")
        self._deactivate(entry)
        entry.status = "disabled"
        entry.error = ""
        return Result.success(entry.to_public())

    def remove(self, name: str) -> Result:
        """Forget a plugin (deactivating it first). Files on disk are untouched."""
        entry = self._plugins.pop(name, None)
        if entry is None:
            return Result.failure(f"unknown plugin '{name}'")
        self._deactivate(entry)
        return Result.success({"name": name})

    def list_plugins(self) -> list:
        return [p.to_public() for p in self._plugins.values()]

    def get(self, name: str) -> Optional[PluginEntry]:
        return self._plugins.get(name)


_registry: Optional[PluginRegistry] = None


def get_plugin_registry() -> PluginRegistry:
    global _registry
    if _registry is None:
        _registry = PluginRegistry()
    return _registry
