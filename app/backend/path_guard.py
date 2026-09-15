"""
path_guard.py - Process-artifact isolation (pattern 02 §6 / pattern 01 1.9).

Mounted as the highest-priority ``pre_tool_use`` subscriber so a path violation
hard-blocks a write BEFORE the risk controller can ever approve it.

Rules enforced on file-mutating tools (write/edit/delete/move/copy):
  1. Never write inside a blacklisted system directory (e.g. C:\\Windows\\System32) —
     blocked even if the user "confirmed", because that is never a safe target.
  2. Never escape the workspace root via ``..`` traversal or an absolute path
     that lands outside the workspace / sanctioned temp / output dirs — blocked
     with guidance to use a workspace-relative path or the ``temp/`` / ``output/``
     scratch dirs.
  3. Never overwrite a GUIDING file (AGENTS.md / MEMORY.md / SOUL.md). These are
     the agent's own long-term memory and behavioural contract; a model that can
     rewrite them can silently rewrite its own instructions, and one bad
     ``write_file`` erases months of accumulated context. The memory layer
     maintains them through its own merge path (plain file IO, not tools), so
     this only closes the door on the MODEL, not on the system.
  4. Date-scoped files (``...2026-08-12...``) are APPEND-ONLY: a daily log or
     journal entry is a historical record. Adding to it is normal; rewriting
     yesterday's entry is falsification. Enforced by comparing the proposed
     content against what's on disk — a write whose content doesn't start with
     the current content is a rewrite, not an append.
  5. Command-running tools (``shell_executor`` / ``python_executor`` /
     ``native_action_chain``) get a narrower version of rules 1-2: their ``cwd``
     must stay inside the workspace, and no absolute path mentioned in the
     command text may land in a blacklisted system directory. Rules 1-4 only
     ever looked at the file tools, so ``shell_executor`` with
     ``echo x > C:\\Windows\\System32\\drivers\\etc\\hosts`` walked straight
     past all of them. The workspace fence is deliberately NOT applied to
     command text — builds, package managers and git legitimately touch caches
     and config outside the workspace, so fencing them there would break normal
     work while adding nothing (a shell can always write via a relative path).

``temp/`` (intermediate artifacts) and ``output/`` (final products) live under
the workspace root and are auto-created; ``ensure_workspace_dirs`` returns them.
"""
from __future__ import annotations

import fnmatch
import os
import re
from typing import Optional

from event_bus import EventBus, Event, get_event_bus

# Tools that mutate the filesystem, mapped to the arg keys carrying targets.
# ``paths`` is a list; ``path`` / ``src`` / ``dst`` are single strings.
WRITE_TOOLS = {
    "write_file": ["path"],
    "edit_file": ["path"],
    "delete_file": ["path"],
    "move_file": ["src", "dst"],
    "copy_file": ["dst"],
    "convert_file": ["output_path", "dst"],
}

# Command-running tools. ``text`` args carry a command line / snippet whose
# absolute paths get blacklist-checked; ``dir`` args are real directories and get
# the full workspace fence.
COMMAND_TOOLS = {
    "shell_executor": {"text": ["command"], "dir": ["cwd"]},
    "python_executor": {"text": ["code"], "dir": ["cwd"]},
    "native_action_chain": {"text": ["commands"], "dir": ["cwd"]},
}

# Always-forbidden roots (extended from config path_blacklist at mount time).
DEFAULT_BLACKLIST = [
    r"C:\Windows",
    r"C:\Program Files",
    r"C:\Program Files (x86)",
    "/System",
    "/usr/bin",
    "/bin",
    "/sbin",
    "/etc",
]

# Guiding files: READONLY for the MODEL (not the system's own merge path).
# Basename match, case-insensitive. The memory layer writes AGENTS.md through
# plain file IO (not routed through tools), so only the model is locked out.
READONLY_BASENAMES: frozenset = frozenset({
    "agents.md", "memory.md", "soul.md",
})

# ---------------------------------------------------------------------------
# Rule 6 — Anti-tampering test write-protection (Track R2).
#
# A benchmark candidate (or any agent) must NEVER edit or delete the test
# suite, because rewriting the assertions is the single easiest way to inflate
# a score: ``check = lambda x: True`` or a deleted ``assert`` makes a broken
# solution look perfect. These paths are therefore hard-blocked at the
# highest-priority pre-tool gate, BEFORE the risk controller can approve them
# and regardless of any "confirmed" flag.
#
# Blocked targets:
#   * any path under a directory named ``tests`` (case-insensitive component);
#   * any file matching one of the test-file globs below
#     (``*_test.py``, ``*.test.ts``, ``*.test.tsx``, ``*.spec.ts``,
#      ``conftest.py``, ``pytest.ini``, ``vitest.config.*``, ``jest.config.*``).
#
# ESCAPE HATCH (default DENY):
#   The default is tamper-blocking. To deliberately allow edits to test files
#   (e.g. a human refactoring the suite, or a test-writing agent run), set the
#   environment variable ``OVOLVE_ALLOW_TEST_EDITS=1`` OR construct
#   ``PathGuard(allow_test_edits=True))`` / ``init_path_guard(allow_test_edits=True)``.
#   Both are opt-in and off by default. The env var is read at decision time so
#   it can be toggled for a single process without restarting the guard.
# ---------------------------------------------------------------------------
TEST_DIR_NAMES: frozenset = frozenset({"tests"})

TEST_FILE_GLOBS: tuple[str, ...] = (
    "*_test.py",
    "*.test.ts",
    "*.test.tsx",
    "*.spec.ts",
    "conftest.py",
    "pytest.ini",
    "vitest.config.*",
    "jest.config.*",
)

#: Marker embedded in every test-protection block reason so callers (and the
#: audit) can detect a tamper attempt unambiguously.
TAMPER_MARKER = "TAMPER_DETECTED"

#: Env var that, when set to ``1``/``true``, disables test protection. Default
#: is unset == DENY.
_ALLOW_TEST_EDITS_ENV = "OVOLVE_ALLOW_TEST_EDITS"

# Date-scoped file pattern: anything with a YYYY-MM-DD substring. Such files
# are append-only: new content must be a prefix-superset of the existing body.
_DATE_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}")

# Absolute paths inside a command line. Windows drive paths (``C:\...`` or
# ``C:/...``) and POSIX paths (``/usr/...``); both quoted and bare. This is a
# best-effort extractor for the loss-stop check, not a shell parser -- it only
# needs to catch an absolute path aimed at a protected directory.
_ABS_PATH_PATTERN = re.compile(
    r"""["']?(                     # optional opening quote
        [A-Za-z]:[\\/][^"'\s|&;<>]*  # C:\... or C:/...
        |                          # or
        /[^"'\s|&;<>]+             # /usr/... /etc/...
    )["']?""",
    re.VERBOSE,
)


_QUOTED_PATTERN = re.compile(r'"([^"]*)"|\'([^\']*)\'')
_ABS_LIKE = re.compile(r"^(?:[A-Za-z]:[\\/]|/)")


def _abs_paths_in(text: str) -> list[str]:
    """Absolute-looking paths mentioned in a command line."""
    if not text or not isinstance(text, str):
        return []
    out: list[str] = []
    # Quoted first: a quoted path is the only way to write one containing
    # spaces, and `C:\Program Files\...` is exactly that case. The bare-token
    # pass below would stop at `C:\Program`.
    for m in _QUOTED_PATTERN.finditer(text):
        s = (m.group(1) or m.group(2) or "").strip()
        if s and _ABS_LIKE.match(s):
            out.append(s)
    for m in _ABS_PATH_PATTERN.finditer(text):
        p = m.group(1)
        # A lone "/" or a POSIX path of one char is almost always a flag or
        # regex, not a target. Drive paths are always kept.
        if re.match(r"^[A-Za-z]:", p) or len(p) > 2:
            out.append(p)
    return out




def ensure_workspace_dirs(workspace_root: str) -> dict:
    """Create and return the sanctioned scratch dirs under the workspace.

    Returns:
        ``{"temp": <path>, "output": <path>}``.
    """
    try:
        os.makedirs(workspace_root, exist_ok=True)
    except OSError:
        pass
    temp = os.path.join(workspace_root, "temp")
    output = os.path.join(workspace_root, "output")
    for d in (temp, output):
        try:
            os.makedirs(d, exist_ok=True)
        except OSError:
            pass  # fail-open: 可选增强，失败不影响主流程
    return {"temp": temp, "output": output}


def _real(path: str) -> str:
    """Fully resolved, comparison-ready absolute path.

    ``realpath`` rather than ``normpath`` because normpath is pure string
    arithmetic: it happily reports ``<ws>\\link\\x`` as living inside ``<ws>``
    even when ``link`` is a symlink or a Windows junction pointing at
    ``C:\\Windows\\System32``. That made both the workspace fence and the
    blacklist bypassable by anyone who could create a link inside the
    workspace -- and on Windows ``mklink /J`` needs no elevation.

    realpath resolves as far as the path exists and leaves the rest intact, so
    it works for targets that have not been created yet (the common case for a
    write). Both sides of every comparison must go through here, otherwise a
    workspace that itself sits behind a link would stop matching.
    """
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def _norm(path: str, workspace_root: str) -> str:
    """Absolute, link-resolved path (relative paths resolve against the workspace)."""
    if not os.path.isabs(path):
        path = os.path.join(workspace_root, path)
    return _real(path)


def _within(child: str, parent: str) -> bool:
    """True when ``child`` is inside ``parent`` (both already normalized)."""
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:
        # Different drives on Windows -> not contained.
        return False

def real_path(path: str) -> str:
    """Public read-side counterpart of :func:`_real`.

    The HTTP layer (``server/http_server.py`` /api/files) reuses this exact
    resolution for its read whitelist, so an attacker cannot exploit a
    resolution mismatch between the write guard and the file-serving endpoint:
    both sides call the same realpath + normcase logic.
    （同作者），Never cache the result across an FS mutation —
    realpath resolves symlinks as they exist *now*.
    """
    return _real(path)


def is_within(child: str, parent: str) -> bool:
    """Public containment check: ``child`` inside ``parent`` after both are
    resolved through :func:`_real` (symlink/junction aware, case-normalized).

    Same semantics as :func:`_within`, but accepts unresolved input so callers
    cannot forget the resolution step — the step is exactly what defeats the
    ``mklink /J`` escape described in :func:`_real`.
    """
    return _within(_real(child), _real(parent))


def _test_protection_enabled(allow_override: bool = False) -> bool:
    """Whether test-file write-protection is active.

    Protection is ON unless explicitly disabled. Disable via the instance flag
    (``allow_test_edits=True``) or the ``OVOLVE_ALLOW_TEST_EDITS`` env var.
    The env var wins at decision time so it can be toggled per-process.
    """
    if allow_override:
        return False
    val = os.environ.get(_ALLOW_TEST_EDITS_ENV, "")
    return val.strip().lower() not in ("1", "true", "yes", "on")


def _is_test_target(resolved: str) -> bool:
    """True when ``resolved`` (already normalized/absolute) is a test artifact.

    Catches (a) any path whose components include a directory literally named
    ``tests`` and (b) any basename matching the test-file globs. Case-insensitive
    on Windows where ``os.path`` returns mixed case.
    """
    if not resolved:
        return False
    norm = os.path.normpath(resolved)
    parts = [p for p in norm.split(os.sep) if p and p != "."]
    lowered = [p.lower() for p in parts]
    if any(d in lowered for d in TEST_DIR_NAMES):
        return True
    basename = parts[-1].lower() if parts else ""
    if not basename:
        return False
    return any(fnmatch.fnmatch(basename, g.lower()) for g in TEST_FILE_GLOBS)


def _test_block_reason(target: str) -> str:
    """Block reason carrying the TAMPER_DETECTED marker for the audit pipeline."""
    return (
        f"{TAMPER_MARKER}: refusing agent write/delete to test artifact "
        f"`{target}`. Test files are protected against score tampering. "
        f"To override (not recommended) set {_ALLOW_TEST_EDITS_ENV}=1 or "
        f"construct PathGuard(allow_test_edits=True)."
    )


# Operators that, inside a command line, imply a write to their target path.
_WRITE_INTENT_TOKENS = (">>", " >", "tee ", "sed -i", "2>", "| tee", "1>")


def _command_writes_test(text: str, workspace_root: str, allow_test_edits: bool) -> Optional[str]:
    """Best-effort detection of a command that writes into a test artifact.

    Used by the command-running tools (``shell_executor`` / ``python_executor`` /
    ``native_action_chain``) which were previously outside the file-tool gate. We
    only flag a token when it both (a) resolves to a protected test path and
    (b) is accompanied by an explicit write intent, so reads like ``cat tests/x``
    or ``pytest tests/`` are NOT blocked. Returns the offending token or None.
    """
    if not _test_protection_enabled(allow_test_edits):
        return None
    if not isinstance(text, str) or not text.strip():
        return None
    if not any(tok in text for tok in _WRITE_INTENT_TOKENS):
        return None

    candidates: set[str] = set(_abs_paths_in(text))
    for m in _QUOTED_PATTERN.finditer(text):
        s = (m.group(1) or m.group(2) or "").strip()
        if s:
            candidates.add(s)
    for tok in re.findall(r"[^\s\"'>|&;()]+", text):
        if "/" in tok or "\\" in tok or "." in tok:
            candidates.add(tok)
    for c in candidates:
        try:
            resolved = _norm(c, workspace_root)
        except Exception:
            continue
        if _is_test_target(resolved):
            return c
    return None


class PathGuard:
    """Enforce workspace isolation for file-mutating tools."""

    PRIORITY: int = 300  # above remote decorator (200) and risk controller (100)

    def __init__(self, blacklist: Optional[list[str]] = None, allow_test_edits: bool = False) -> None:
        self._bus: Optional[EventBus] = None
        self.blacklist = list(DEFAULT_BLACKLIST)
        if blacklist:
            self.blacklist.extend(blacklist)
        # Track R2: test-file write-protection. Opt-in disable only.
        self.allow_test_edits = bool(allow_test_edits)
        self.block_count: int = 0

    def mount(self, bus: EventBus = None) -> None:
        self._bus = bus or get_event_bus()
        self._bus.on("pre_tool_use", self._on_pre_tool_use, priority=self.PRIORITY)

    def unmount(self) -> None:
        if self._bus:
            self._bus.off("pre_tool_use", self._on_pre_tool_use)

    def _blacklisted(self, target: str) -> Optional[str]:
        """Return the offending blacklist root if ``target`` is inside one."""
        for root in self.blacklist:
            if not root:
                continue
            nr = _real(root)
            if _within(target, nr):
                return root
        return None

    def _allowed_roots(self, workspace_root: str) -> list[str]:
        """Workspace root plus the sanctioned scratch dirs, all link-resolved."""
        allowed = [_real(workspace_root)]
        dirs = ensure_workspace_dirs(workspace_root)
        allowed.extend(_real(d) for d in dirs.values())
        return allowed

    def _check_command_tool(
        self, tool_name: str, args: dict, workspace_root: str, event: Event,
        context: Optional[dict] = None,
    ) -> None:
        """Rule 5: the loss-stop for tools that run commands.

        These tools were entirely outside the guard: ``WRITE_TOOLS.get(name)``
        returned None for them and the handler returned immediately, so every
        rule above could be sidestepped by asking for a shell command instead of
        a write. Path policy (and the OS sandbox at spawn) now cover the
        command text; this method is the pre_tool_use half of that.
        """
        context = context or {}
        spec = COMMAND_TOOLS[tool_name]

        for key in spec["dir"]:
            raw = args.get(key)
            if not isinstance(raw, str) or not raw.strip():
                continue
            resolved = _norm(raw, workspace_root)
            if not any(_within(resolved, root) for root in self._allowed_roots(workspace_root)):
                perm = context.get("permission")
                if context.get("confirmed") or perm in ("full", "yolo", "never", "full_access"):
                    continue
                self.block_count += 1
                event.block(
                    f"Refused: `{tool_name}` targets directory `{raw}` outside allowed workspace roots.\n"
                    f"如需授权在该外部路径执行，请把该目录加入工作区白名单 (allowed_paths)。"
                )
                return

        texts: list[str] = []
        for key in spec["text"]:
            val = args.get(key)
            if isinstance(val, str):
                texts.append(val)
            elif isinstance(val, list):
                texts.extend(v for v in val if isinstance(v, str))

        # Rule 6: a command that writes into a test artifact is a tamper attempt.
        for text in texts:
            offending = _command_writes_test(text, workspace_root, self.allow_test_edits)
            if offending:
                self.block_count += 1
                event.block(_test_block_reason(offending))
                return

        for text in texts:
            # 1. Literal mention of a protected root. Catches the forms the
            #    extractor cannot tokenise, above all an unquoted path with a
            #    space in it (`copy x C:\Program Files\y`).
            low = text.lower()
            for root in self.blacklist:
                if root and root.lower() in low:
                    self.block_count += 1
                    event.block(
                        f"Refused: `{tool_name}` names a protected system location "
                        f"({root}). Commands that touch system directories are blocked "
                        f"regardless of intent — do the work inside the workspace."
                    )
                    return
            # 2. Resolved check, so `C:/Windows/...`, trailing `..` and case
            #    differences land on the same verdict.
            for candidate in _abs_paths_in(text):
                offending = self._blacklisted(_real(candidate))
                if offending:
                    self.block_count += 1
                    event.block(
                        f"Refused: `{tool_name}` names a protected system location "
                        f"({offending}) in `{candidate}`. Commands that touch system "
                        f"directories are blocked regardless of intent — do the work "
                        f"inside the workspace."
                    )
                    return

        # Path policy (sandbox-policy.yaml): finer-grained than the blacklist,
        # and it sees redirections (`echo x > ..`) that the extractor above
        # only flags when they are already absolute + blacklisted.
        cwd = workspace_root
        for key in spec["dir"]:
            raw = args.get(key)
            if isinstance(raw, str) and raw.strip():
                cwd = raw
                break
        try:
            from path_policy import evaluate_command
            for text in texts:
                verdict = evaluate_command(
                    text, cwd=cwd, workspace_root=workspace_root,
                )
                if not verdict.allowed:
                    self.block_count += 1
                    event.block(verdict.reason)
                    return
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程


    def _on_pre_tool_use(self, event: Event) -> None:
        tool_name = event.payload.get("tool_name", "")
        args = event.payload.get("args", {}) or {}
        context = event.payload.get("context", {}) or {}
        workspace_root = context.get("workspace_root") or os.getcwd()

        if tool_name in COMMAND_TOOLS:
            self._check_command_tool(tool_name, args, workspace_root, event, context)
            return

        keys = WRITE_TOOLS.get(tool_name)
        if not keys:
            return
        allowed = self._allowed_roots(workspace_root)


        targets: list[str] = []
        for key in keys:
            val = args.get(key)
            if isinstance(val, str) and val:
                targets.append(val)
        # write_file/git_add style: a ``paths`` list.
        if isinstance(args.get("paths"), list):
            targets.extend([p for p in args["paths"] if isinstance(p, str)])

        for raw in targets:
            resolved = _norm(raw, workspace_root)

            # Rule 6 (Track R2): hard-block agent writes/deletes to test artifacts.
            # Checked first and unconditionally — no "confirmed" / permission escape,
            # because rewriting the test suite is exactly how a candidate fakes a pass.
            if _test_protection_enabled(self.allow_test_edits) and _is_test_target(resolved):
                self.block_count += 1
                event.block(_test_block_reason(raw))
                return

            offending = self._blacklisted(resolved)
            if offending:
                self.block_count += 1
                event.block(
                    f"Refused: `{tool_name}` targets a protected system location "
                    f"({offending}). This is never a safe write target."
                )
                return

            if not any(_within(resolved, root) for root in allowed):
                perm = context.get("permission")
                if context.get("confirmed") or perm in ("full", "yolo", "never", "full_access"):
                    continue
                self.block_count += 1
                event.block(
                    f"Refused: `{tool_name}` targets `{raw}` outside allowed workspace roots.\n"
                    f"如需授权写入该外部路径，请把该目录加入工作区白名单 (allowed_paths)。"
                )
                return

            # Rule 3: guiding files are readonly for the model.
            basename = os.path.basename(resolved).lower()
            if basename in READONLY_BASENAMES and not context.get("allow_guiding_write"):
                self.block_count += 1
                event.block(
                    f"Refused: `{basename}` is a guiding file maintained by the "
                    f"memory layer. The model must not overwrite it directly — use "
                    f"the memory tools or let the extraction pipeline manage it."
                )
                return

            # Rule 4: date-scoped files are append-only.
            if tool_name in ("write_file",) and _DATE_PATTERN.search(os.path.basename(raw)):
                new_content = args.get("content") or ""
                if new_content and os.path.isfile(resolved):
                    try:
                        with open(resolved, "r", encoding="utf-8", errors="replace") as f:
                            existing = f.read()
                    except OSError:
                        existing = ""
                    if existing and not new_content.startswith(existing):
                        self.block_count += 1
                        event.block(
                            f"Refused: `{os.path.basename(raw)}` is a date-scoped "
                            f"journal file. It is append-only — new content must "
                            f"start with the existing body. Use edit_file to "
                            f"append instead of write_file to overwrite."
                        )
                        return

    def get_stats(self) -> dict:
        return {"blocks": self.block_count}


_guard: Optional[PathGuard] = None


def get_path_guard() -> PathGuard:
    global _guard
    if _guard is None:
        _guard = PathGuard()
    return _guard


def init_path_guard(blacklist: Optional[list[str]] = None, allow_test_edits: bool = False) -> PathGuard:
    global _guard
    _guard = PathGuard(blacklist=blacklist, allow_test_edits=allow_test_edits)
    _guard.mount()
    return _guard
