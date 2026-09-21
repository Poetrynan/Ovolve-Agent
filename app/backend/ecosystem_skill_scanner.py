# -*- coding: utf-8 -*-
"""ecosystem_skill_scanner.py — Multi-protocol ecosystem skill scanner & adapter (Module 4).

Implementation providing:
1. Multi-protocol discovery (.claude/skills, .agents/skills, .skills, workspace-level).
2. Deep frontmatter parsing for Claude Code and open agent skills.
3. Automatic protocol detection ("claude-code", "open-agent").
4. Seamless adaptation into Ovolve native SkillEntry for zero-overhead runtime execution.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import os
from pathlib import Path
import re
from typing import Any, Optional, Sequence, Union

from skill_loader import SkillEntry, TrustLevel, normalize_bool


_IGNORED_DIRS = frozenset({
    ".git",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    "venv",
    ".venv",
    "temp",
    "temp.__todelete",
    ".gemini",
})


@dataclass
class EcosystemSkill:
    name: str
    description: str
    path: str
    protocol: str  # "claude-code" | "ovolve-native" | "open-agent"
    frontmatter: dict[str, Any] = field(default_factory=dict)
    instructions: str = ""
    tools: list[str] = field(default_factory=list)
    requires: list[str] = field(default_factory=list)
    content_hash: str = ""


def _parse_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    """Parse YAML frontmatter delimited by ---."""
    if not content.startswith("---"):
        return {}, content

    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}, content

    raw_fm = parts[1]
    body = parts[2].strip()

    fm: dict[str, Any] = {}
    lines = raw_fm.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            i += 1
            continue

        if ":" in stripped:
            key, val = stripped.split(":", 1)
            key = key.strip()
            val = val.strip()

            # Multiline list handling:
            # key:
            #   - item1
            #   - item2
            if not val:
                seq: list[str] = []
                j = i + 1
                while j < len(lines):
                    nxt = lines[j].strip()
                    if not nxt or nxt.startswith("#"):
                        j += 1
                        continue
                    if nxt.startswith("- "):
                        item = nxt[2:].strip().strip("\"'")
                        seq.append(item)
                        j += 1
                        continue
                    break
                if seq:
                    fm[key] = seq
                    i = j
                    continue

            # Inline list handling [a, b]
            if val.startswith("[") and val.endswith("]"):
                inner = val[1:-1]
                items = [p.strip().strip("\"'") for p in inner.split(",") if p.strip()]
                fm[key] = items
            else:
                fm[key] = val.strip("\"'")
        i += 1

    return fm, body


class EcosystemSkillScanner:
    """Discovers and adapts skills across multi-vendor ecosystem formats."""

    def __init__(self, search_roots: Optional[Sequence[Union[str, Path]]] = None):
        self.search_roots = [Path(r) for r in search_roots] if search_roots else []

    def scan(self, workspace_root: Optional[Union[str, Path]] = None) -> list[EcosystemSkill]:
        """Scans configured search roots or workspace_root for SKILL.md files."""
        skills: list[EcosystemSkill] = []
        visited_paths: set[Path] = set()

        roots_to_check: list[Path] = []
        if self.search_roots:
            roots_to_check.extend(self.search_roots)

        if workspace_root:
            w = Path(workspace_root).resolve()
            roots_to_check.extend([
                w / ".claude" / "skills",
                w / ".agents" / "skills",
                w / ".skills",
                w,
            ])

        for root in roots_to_check:
            if not root.exists():
                continue

            for dirpath, dirnames, filenames in os.walk(root):
                # Prune ignored directories in-place
                dirnames[:] = [d for d in dirnames if d not in _IGNORED_DIRS]

                for fname in filenames:
                    if fname.lower() in ("skill.md", "skill.yaml"):
                        skill_file = Path(dirpath) / fname
                        resolved_file = skill_file.resolve()
                        if resolved_file in visited_paths:
                            continue
                        visited_paths.add(resolved_file)

                        parsed = self._parse_skill_file(resolved_file)
                        if parsed:
                            skills.append(parsed)

        return skills

    def _parse_skill_file(self, skill_file: Path) -> Optional[EcosystemSkill]:
        """Parses a single SKILL.md file into EcosystemSkill."""
        try:
            content = skill_file.read_text(encoding="utf-8")
        except Exception:  # noqa: BLE001
            return None

        content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]
        fm, body = _parse_frontmatter(content)

        name = str(fm.get("name") or skill_file.parent.name or "unnamed-skill")
        description = str(fm.get("description") or "")

        # Protocol detection
        parts = skill_file.parts
        if ".claude" in parts or "tools" in fm:
            protocol = "claude-code"
        elif "user-invocable" in fm or "requires-bins" in fm or ".agents" in parts:
            protocol = "ovolve-native"
        else:
            protocol = "open-agent"

        # Extract tools
        tools_raw = fm.get("tools") or fm.get("allowed-tools") or fm.get("allowed_tools") or []
        if isinstance(tools_raw, str):
            tools = [p.strip() for p in tools_raw.split(",") if p.strip()]
        elif isinstance(tools_raw, list):
            tools = [str(t).strip() for t in tools_raw if str(t).strip()]
        else:
            tools = []

        # Extract requirements
        reqs_raw = fm.get("requires") or []
        if isinstance(reqs_raw, list):
            requires = [str(r).strip() for r in reqs_raw if str(r).strip()]
        else:
            requires = []

        return EcosystemSkill(
            name=name,
            description=description,
            path=str(skill_file),
            protocol=protocol,
            frontmatter=fm,
            instructions=body,
            tools=tools,
            requires=requires,
            content_hash=content_hash,
        )

    def adapt_to_skill_entry(
        self,
        skill: EcosystemSkill,
        trust: TrustLevel = TrustLevel.VERIFIED,
    ) -> SkillEntry:
        """Adapts an EcosystemSkill into a native Ovolve SkillEntry."""
        skill_dir = str(Path(skill.path).parent)
        entry = SkillEntry(
            name=skill.name,
            path=skill_dir,
            description=skill.description,
            version=skill.content_hash,
            trust=trust,
        )
        entry.body = skill.instructions
        entry.frontmatter = dict(skill.frontmatter)
        entry.declared_version = str(skill.frontmatter.get("version") or "")
        entry.allowed_tools = list(skill.tools)
        entry.requires = list(skill.requires)
        entry.source = f"ecosystem:{skill.protocol}"

        # Populate boolean visibility flags
        entry.user_invocable = normalize_bool(
            skill.frontmatter.get("user-invocable") or skill.frontmatter.get("user_invocable"),
            True,
        )
        entry.disable_model_invocation = normalize_bool(
            skill.frontmatter.get("disable-model-invocation") or skill.frontmatter.get("disable_model_invocation"),
            False,
        )

        return entry
