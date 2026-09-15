"""path_policy.py — auditable filesystem policy (the open-source layer).

OS-native confinement in ``sandbox.py`` is the hard boundary: the kernel
refuses writes the process is not allowed to make. This module is the layer
users can *read*, edit, and contribute to.

A ``sandbox-policy.yaml`` in the workspace (or ``~/.ovolve/``) is the source
of truth. Built-in defaults match ``app/sandbox-policy.example.yaml`` so a
missing file is not a missing policy.

This is not a shell parser and does not claim to be. It extracts the paths a
command *names* (redirections, absolute paths, path-like arguments) and checks
them against the YAML. Anything it cannot see is the OS sandbox's job.

Rule matching: most-specific path wins. ``.git: ro`` beats ``workspace: rw``
for files under ``.git``. Writes that match nothing are denied; reads that
match nothing are allowed (unless a ``none`` rule covers them).
"""
from __future__ import annotations

import ipaddress
import os
import re
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Iterable, Optional

from path_guard import DEFAULT_BLACKLIST, READONLY_BASENAMES

#: Access values accepted in the YAML.
RW, RO, NONE = "rw", "ro", "none"
_ACCESS = {RW, RO, NONE}

_POLICY_FILENAMES = ("sandbox-policy.yaml", "sandbox-policy.yml")

#: Guiding files: the model must not overwrite them via the shell either.
#: PathGuard already blocks the file tools; this closes the shell hole.
_GUIDING_GLOBS = tuple(f"**/{name}" for name in (
    "AGENTS.md", "MEMORY.md", "SOUL.md", "agents.md", "memory.md", "soul.md",
))


# ── tiny YAML subset ────────────────────────────────────────────────────────
#
# Zero extra dependency. Understands the policy schema: nested maps, lists of
# scalars, ``key: value``, comments, quoted strings. Not a YAML implementation.


def _parse_scalar(raw: str):
    s = raw.strip()
    if not s:
        return ""
    if s[0] in "\"'" and len(s) >= 2 and s[-1] == s[0]:
        return s[1:-1]
    if s.startswith("#"):
        return ""
    if " #" in s:
        s = s[:s.index(" #")].rstrip()
    low = s.lower()
    if low in ("true", "yes", "on"):
        return True
    if low in ("false", "no", "off"):
        return False
    if low in ("null", "none", "~"):
        return None
    try:
        return int(s)
    except ValueError:
        pass  # fail-open: 可选增强，失败不影响主流程
    try:
        return float(s)
    except ValueError:
        pass  # fail-open: 可选增强，失败不影响主流程
    return s


def load_simple_yaml(text: str) -> dict:
    """Indent-based YAML subset → dict. Good enough for sandbox-policy.yaml."""
    lines: list[tuple[int, str]] = []
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        lines.append((indent, raw.strip()))

    def parse_block(index: int, indent: int):
        mapping: dict = {}
        sequence: list = []
        is_list: Optional[bool] = None
        while index < len(lines):
            i, content = lines[index]
            if i < indent:
                break
            if i > indent and is_list is None:
                # stray deeper indent; treat as this level
                pass  # 控制流占位（非吞异常）：首个更深缩进暂按本级吸收，类型待定
            elif i > indent:
                break
            if content.startswith("- "):
                if is_list is False:
                    raise ValueError("YAML subset: mixed dict/list at the same indent")
                is_list = True
                item = content[2:].strip()
                if item.endswith(":") or (": " in item and not item.startswith("{")):
                    # list of maps is out of scope; store the scalar form
                    sequence.append(_parse_scalar(item))
                    index += 1
                else:
                    sequence.append(_parse_scalar(item))
                    index += 1
                continue
            is_list = False
            if content.endswith(":"):
                key = content[:-1].strip().strip("\"'")
                nxt = index + 1
                if nxt < len(lines) and lines[nxt][0] > i:
                    child, index = parse_block(nxt, lines[nxt][0])
                    mapping[key] = child
                else:
                    mapping[key] = {}
                    index += 1
                continue
            if ": " in content:
                key, val = content.rsplit(": ", 1)
                mapping[key.strip().strip("\"'")] = _parse_scalar(val)
                index += 1
                continue
            if ":" in content and not content.startswith("http"):
                key, val = content.rsplit(":", 1)
                mapping[key.strip().strip("\"'")] = _parse_scalar(val)
                index += 1
                continue
            index += 1
        return (sequence if is_list else mapping), index

    if not lines:
        return {}
    doc, _ = parse_block(0, lines[0][0])
    return doc if isinstance(doc, dict) else {}


# ── glob / path matching ────────────────────────────────────────────────────


def _slash(path: str) -> str:
    return path.replace("\\", "/")


def _norm_path(path: str) -> str:
    try:
        real = os.path.realpath(os.path.abspath(os.path.expanduser(os.path.expandvars(path))))
    except OSError:
        real = os.path.abspath(os.path.expanduser(os.path.expandvars(path)))
    return _slash(os.path.normcase(real))


def _expand_braces(pattern: str) -> list[str]:
    m = re.search(r"\{([^{}]+)\}", pattern)
    if not m:
        return [pattern]
    out: list[str] = []
    for part in m.group(1).split(","):
        expanded = pattern[:m.start()] + part.strip() + pattern[m.end():]
        out.extend(_expand_braces(expanded))
    return out


def _glob_to_re(pattern: str) -> re.Pattern:
    i = 0
    out: list[str] = ["^"]
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.+/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    out.append("$")
    flags = re.IGNORECASE if os.name == "nt" else 0
    return re.compile("".join(out), flags)


def _pattern_matches(path: str, pattern: str) -> bool:
    """True when ``path`` (already normalised) matches a glob or prefix."""
    pat = _slash(pattern).rstrip("/")
    if not pat:
        return False
    exact = pat[:-3] if pat.endswith("/**") else pat
    if path == exact or path.startswith(exact + "/"):
        return True
    if any(ch in pat for ch in "*?{"):
        for variant in _expand_braces(pat):
            if _glob_to_re(variant).match(path):
                return True
            # ``foo/**`` also matches ``foo`` itself
            if variant.endswith("/**") and _glob_to_re(variant[:-3]).match(path):
                return True
    return False


# ── command path extraction ─────────────────────────────────────────────────

_REDIR_PREFIX = re.compile(r"^(?:\d+)?(>>?|<)(?!&)")


def _find_redirections(command: str) -> list[tuple[str, str]]:
    """Lexically extract shell redirections outside quotes and heredocs.

    Returns list of (access, target) where access is 'read' or 'write'.
    """
    if not command:
        return []

    cmd = command
    # If heredoc is present, only scan the first command line for redirections;
    # lines after the first newline are standard input body, not shell operators.
    if "<<" in cmd:
        lines = cmd.splitlines(True)
        cmd = lines[0]

    intents: list[tuple[str, str]] = []
    i = 0
    n = len(cmd)
    quote = None

    while i < n:
        ch = cmd[i]

        if ch in ('"', "'"):
            if quote is None:
                quote = ch
            elif quote == ch:
                quote = None
            i += 1
            continue

        if quote is not None:
            i += 1
            continue

        if ch == '\\':
            i += 2
            continue

        m = _REDIR_PREFIX.match(cmd[i:])
        if m:
            op = m.group(1)
            # '<<' is heredoc input; ignore here as it feeds literal stdin
            if op.startswith("<<"):
                i += m.end()
                continue
            access = "write" if ">" in op else "read"
            j = i + m.end()

            while j < n and cmd[j].isspace():
                j += 1

            target = []
            target_quote = None
            while j < n:
                tch = cmd[j]
                if target_quote:
                    if tch == target_quote:
                        target_quote = None
                    else:
                        target.append(tch)
                    j += 1
                    continue

                if tch in ('"', "'"):
                    target_quote = tch
                    j += 1
                    continue

                if tch.isspace() or tch in (';', '&', '|', ')', '>', '<'):
                    break

                target.append(tch)
                j += 1

            target_str = "".join(target).strip()
            if target_str:
                intents.append((access, target_str))
            i = j
            continue

        i += 1

    return intents
_QUOTED = re.compile(r"\"([^\"]+)\"|'([^']+)'")
_ABS_LIKE = re.compile(r"^(?:[A-Za-z]:[\\/]|~[/\\]|/)")
_PATHY = re.compile(r"[\\/]|\.[A-Za-z0-9]{1,8}$")
_IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")

_WRAPPERS = {
    "sudo", "doas", "env", "nice", "nohup", "command", "time", "stdbuf",
    "winpty", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh",
    "pwsh.exe",
}

_WRITE_VERBS = {
    "rm", "rmdir", "rd", "del", "erase", "remove-item",
    "mv", "move", "ren", "rename",
    "cp", "copy", "xcopy", "robocopy", "install",
    "mkdir", "md", "touch", "new-item", "ni",
    "tee", "dd",
    "chmod", "chown", "icacls", "attrib", "chattr",
    "ln", "mklink", "link",
    "sed", "perl",
    "tar", "unzip", "expand-archive",
    "npm", "pnpm", "yarn", "pip", "pip3", "poetry", "cargo", "go",
    "docker",
}

#: git is a read OR a write depending on the subcommand. Treating every
#: `git log <path>` as a write would refuse `git log C:\Windows` because
#: that path is ro — and logging it is the opposite of dangerous.
_GIT_WRITE = {
    "add", "commit", "checkout", "restore", "reset", "rm", "mv",
    "stash", "merge", "rebase", "cherry-pick", "clean", "apply",
    "init", "config", "tag", "branch", "switch", "revert",
}

_READ_VERBS = {
    "cat", "type", "more", "less", "head", "tail", "bat",
    "ls", "dir", "tree", "find", "where", "which", "where.exe",
    "grep", "rg", "ag", "findstr", "select-string",
    "stat", "file", "wc", "diff", "cmp",
    "get-content", "get-childitem", "get-item",
}

_CD_VERBS = {"cd", "chdir", "set-location", "pushd"}


def _strip_wrappers(tokens: list[str]) -> list[str]:
    i = 0
    while i < len(tokens):
        verb = tokens[i].lower().rsplit("\\", 1)[-1].rsplit("/", 1)[-1]
        if verb.endswith(".exe"):
            verb = verb[:-4]
        if verb in _WRAPPERS or "=" in tokens[i]:
            i += 1
            if verb in {"cmd", "cmd.exe"} and i < len(tokens) and tokens[i].lower() in {"/c", "/k"}:
                i += 1
            continue
        break
    return tokens[i:]


def _tokenize(command: str) -> list[str]:
    """Rough argv split: quoted strings stay together, redirections stay in."""
    out: list[str] = []
    buf: list[str] = []
    quote = ""
    for ch in command.strip():
        if quote:
            if ch == quote:
                quote = ""
            else:
                buf.append(ch)
            continue
        if ch in "\"'":
            quote = ch
            continue
        if ch.isspace():
            if buf:
                out.append("".join(buf))
                buf = []
            continue
        buf.append(ch)
    if buf:
        out.append("".join(buf))
    return out


def _pick(m: re.Match) -> str:
    return next((g for g in m.groups() if g), "")


@dataclass(frozen=True)
class PathIntent:
    """One filesystem touch a command appears to make."""

    path: str
    access: str  # "read" | "write"
    source: str  # "redir" | "arg" | "cd" | "literal"


def extract_intents(command: str, cwd: str) -> list[PathIntent]:
    """Best-effort path intents from a command line.

    Misses are expected (``python -c 'open(...)'`` with no literal path, a
    write through a variable). The OS sandbox is what catches those.
    """
    if not command or not isinstance(command, str):
        return []
    cwd = cwd or os.getcwd()
    found: list[PathIntent] = []
    seen: set[tuple[str, str]] = set()

    def add(raw: str, access: str, source: str) -> None:
        raw = (raw or "").strip().strip("\"'`;,()[]{}")
        if not raw or raw in {"-", "/dev/null", "/dev/zero", "/dev/stdin", "/dev/stdout", "/dev/stderr", "NUL", "nul"}:
            return
        # If source is "redir", ensure it's not a numeric comparison operator fragment like "0", "0:", "1", "0,0"
        if source == "redir":
            if re.match(r"^\d+[:,\)]*$", raw) or re.match(r"^[0-9]+$", raw):
                return
            if raw.endswith(":"):
                return
            # If redirection target has non-path syntax like comparison tokens or code keywords
            if raw in {"True", "False", "None", "null", "nil", "undefined", "then", "do", "end", "else"}:
                return
        if raw.startswith("-") and not _ABS_LIKE.match(raw):
            return
        # Drive root must be letter: [A-Za-z]:
        if re.match(r"^\d+:[\\/]", raw) or re.match(r"^\d+:", raw):
            return
        resolved = raw
        if not os.path.isabs(os.path.expanduser(raw)):
            resolved = os.path.join(cwd, raw)
        key = (_norm_path(resolved), access)
        if key in seen:
            return
        seen.add(key)
        found.append(PathIntent(path=key[0], access=access, source=source))

    for access, target in _find_redirections(command):
        add(target, access, "redir")

    tokens = _strip_wrappers(_tokenize(command))
    verb = ""
    if tokens:
        verb = tokens[0].lower().rsplit("\\", 1)[-1].rsplit("/", 1)[-1]
        if verb.endswith(".exe"):
            verb = verb[:-4]

    if verb in _CD_VERBS and len(tokens) >= 2:
        add(tokens[1], "read", "cd")

    write_ctx = verb in _WRITE_VERBS
    read_ctx = verb in _READ_VERBS or not write_ctx
    args = tokens[1:] if tokens else []
    if verb == "git":
        sub = (args[0].lower() if args else "").lstrip("-")
        write_ctx = sub in _GIT_WRITE
        read_ctx = not write_ctx
        args = args[1:]
    skip_next = False
    for tok in args:
        if skip_next:
            skip_next = False
            continue
        if tok.startswith("-"):
            flag = tok.split("=", 1)[0].lower()
            if flag in {"-m", "--message", "--author", "-F", "--file"} and "=" not in tok:
                skip_next = True
            continue
        looks = bool(_ABS_LIKE.match(tok) or _PATHY.search(tok))
        if not looks:
            continue
        if write_ctx:
            add(tok, "write", "arg")
        elif read_ctx:
            add(tok, "read", "arg")

    # Absolute paths mentioned anywhere, classified by the verb.
    for m in _QUOTED.finditer(command):
        s = (m.group(1) or m.group(2) or "").strip()
        if s and _ABS_LIKE.match(s):
            add(s, "write" if write_ctx else "read", "literal")
    for m in re.finditer(
        r"([A-Za-z]:[\\/][^\s\"'|&;<>]+|/(?:etc|usr|bin|sbin|System|home|Users|root)[^\s\"'|&;<>]*)",
        command,
    ):
        add(m.group(1), "write" if write_ctx else "read", "literal")

    return found


def extract_ips(command: str) -> list[str]:
    if not command:
        return []
    return [m.group(0) for m in _IPV4.finditer(command)]


# ── policy ──────────────────────────────────────────────────────────────────


@dataclass
class FsRule:
    """One filesystem entry from the YAML, already resolved to a real path."""

    raw: str
    path: str
    access: str

    @property
    def specificity(self) -> int:
        return len(self.path)


@dataclass
class PolicyVerdict:
    allowed: bool
    reason: str = ""
    path: str = ""
    access: str = ""
    rule: str = ""


class PathPolicyError(Exception):
    """Raised when a command names a path the policy forbids."""

    def __init__(self, verdict: PolicyVerdict):
        super().__init__(verdict.reason)
        self.verdict = verdict


@dataclass
class PathPolicy:
    """Resolved policy for one workspace. Build via :func:`load_policy`."""

    workspace_root: str
    rules: list[FsRule] = field(default_factory=list)
    network_default: str = "allow"
    network_block: tuple = ()
    source: str = "built-in"

    # Fluent builders for tests and callers that skip YAML.

    def allow_read(self, pattern: str) -> "PathPolicy":
        return self._add(pattern, RO)

    def allow_write(self, pattern: str) -> "PathPolicy":
        return self._add(pattern, RW)

    def deny_write(self, pattern: str) -> "PathPolicy":
        return self._add(pattern, RO)

    def deny_all(self, pattern: str) -> "PathPolicy":
        return self._add(pattern, NONE)

    def _add(self, pattern: str, access: str) -> "PathPolicy":
        resolved = _resolve_key(pattern, self.workspace_root)
        for p in resolved:
            self.rules.append(FsRule(raw=pattern, path=p, access=access))
        return self

    def _matching(self, path: str) -> Optional[FsRule]:
        hits = [r for r in self.rules if _pattern_matches(path, r.path) or _pattern_matches(path, r.path + "/**")]
        if not hits:
            return None
        hits.sort(key=lambda r: r.specificity, reverse=True)
        return hits[0]

    def check_path(self, path: str, access: str) -> PolicyVerdict:
        """Check one resolved path. ``access`` is ``read`` or ``write``."""
        normed = _norm_path(path)

        # Hard floor: guiding files are never writable through this layer.
        base = os.path.basename(normed).lower()
        if access == "write" and base in READONLY_BASENAMES:
            return PolicyVerdict(
                False,
                reason=f"Refused: `{os.path.basename(path)}` is a guiding file. "
                       "The model must not overwrite it from the shell.",
                path=normed, access=access, rule="guiding-file",
            )

        rule = self._matching(normed)
        if rule is None:
            if access == "write":
                return PolicyVerdict(
                    False,
                    reason=f"Refused: write to `{path}` is outside the allowed paths "
                           f"(workspace / tmp). Edit sandbox-policy.yaml to allow it.",
                    path=normed, access=access, rule="default-deny-write",
                )
            return PolicyVerdict(True, path=normed, access=access, rule="default-allow-read")

        if rule.access == NONE:
            return PolicyVerdict(
                False,
                reason=f"Refused: `{path}` is classified `{rule.raw}: none` "
                       f"in {self.source}.",
                path=normed, access=access, rule=rule.raw,
            )
        if access == "write" and rule.access == RO:
            return PolicyVerdict(
                False,
                reason=f"Refused: `{path}` is read-only (`{rule.raw}: ro` in {self.source}).",
                path=normed, access=access, rule=rule.raw,
            )
        return PolicyVerdict(True, path=normed, access=access, rule=rule.raw)

    def check_network(self, command: str) -> PolicyVerdict:
        if (self.network_default or "allow").lower() == "deny":
            # A total network deny is a kernel-sandbox concern; here we only
            # catch literal IPs that also sit on the block list, plus any IP
            # at all when default=deny.
            ips = extract_ips(command)
            if ips:
                return PolicyVerdict(
                    False,
                    reason=f"Refused: network is denied by policy; command names {ips[0]}.",
                    path=ips[0], access="network", rule="network.default",
                )
        blocked = _parse_cidrs(self.network_block)
        for ip_s in extract_ips(command):
            try:
                ip = ipaddress.ip_address(ip_s)
            except ValueError:
                continue
            for net, raw in blocked:
                if ip in net:
                    return PolicyVerdict(
                        False,
                        reason=f"Refused: `{ip_s}` is in blocked range `{raw}`.",
                        path=ip_s, access="network", rule=raw,
                    )
        return PolicyVerdict(True, access="network")

    def evaluate_command(self, command: str, cwd: str = "") -> PolicyVerdict:
        net = self.check_network(command)
        if not net.allowed:
            return net
        for intent in extract_intents(command, cwd or self.workspace_root):
            verdict = self.check_path(intent.path, intent.access)
            if not verdict.allowed:
                return verdict
        return PolicyVerdict(True)

    def assert_allowed(self, command: str, cwd: str = "") -> None:
        verdict = self.evaluate_command(command, cwd)
        if not verdict.allowed:
            raise PathPolicyError(verdict)

    def summary(self) -> dict:
        return {
            "source": self.source,
            "workspace": self.workspace_root,
            "filesystem": [{"path": r.path, "access": r.access, "raw": r.raw} for r in self.rules],
            "network": {
                "default": self.network_default,
                "block": list(self.network_block),
            },
        }


def _parse_cidrs(entries: Iterable) -> list[tuple[ipaddress._BaseNetwork, str]]:
    out: list[tuple[ipaddress._BaseNetwork, str]] = []
    for raw in entries or ():
        s = str(raw).strip()
        if not s:
            continue
        try:
            out.append((ipaddress.ip_network(s, strict=False), s))
        except ValueError:
            continue
    return out


def _resolve_key(key: str, workspace_root: str) -> list[str]:
    """Map a YAML key (``workspace``, ``tmp``, ``.git``, ``~/.ssh``, …) to paths."""
    key = (key or "").strip()
    ws = _norm_path(workspace_root or os.getcwd())
    if key in {"workspace", "workspace/**", "{workspace}", "{workspace}/**"}:
        return [ws]
    if key in {"tmp", "temp", "tmp/**"}:
        extras = [tempfile.gettempdir()]
        extras.append(os.path.join(workspace_root, "temp"))
        extras.append(os.path.join(workspace_root, "output"))
        # Cross-platform scratch directories: standard POSIX /tmp, /temp
        # On Windows, drive-relative /tmp resolves to <drive>:/tmp (C:/tmp, D:/tmp, etc.)
        if sys.platform == "win32":
            drives = {
                "c:", "d:",
                os.path.splitdrive(workspace_root)[0].lower(),
                os.path.splitdrive(tempfile.gettempdir())[0].lower(),
            }
            for d in drives:
                if d:
                    extras.append(f"{d}/tmp")
                    extras.append(f"{d}/temp")
        else:
            extras.extend(["/tmp", "/var/tmp"])
        return [_norm_path(p) for p in extras]
    if key.startswith("workspace/") or key.startswith("workspace\\"):
        rest = key[len("workspace"):].lstrip("/\\")
        return [_norm_path(os.path.join(workspace_root, rest))]
    if key.startswith("{workspace}"):
        rest = key[len("{workspace}"):].lstrip("/\\")
        return [_norm_path(os.path.join(workspace_root, rest))] if rest else [ws]
    # Bare relative (``.git``, ``src``) → under the workspace.
    expanded = os.path.expanduser(os.path.expandvars(key))
    if not os.path.isabs(expanded) and not re.match(r"^[A-Za-z]:[\\/]", expanded):
        expanded = os.path.join(workspace_root, expanded)
    return [_norm_path(expanded)]


def builtin_filesystem() -> dict[str, str]:
    """Defaults matching sandbox-policy.example.yaml, plus PathGuard's floor."""
    fs: dict[str, str] = {
        "workspace": RW,
        "tmp": RW,
        ".git": RW,
        "~/.ssh": NONE,
        "~/.gnupg": NONE,
        "/etc": NONE,
        "/System": RO,
        "/usr/bin": RO,
        "/bin": RO,
        "/sbin": RO,
        "C:/Windows": RO,
        "C:/Program Files": RO,
        "C:/Program Files (x86)": RO,
    }
    # PathGuard blacklist is a write-deny floor even if the YAML forgets it.
    for root in DEFAULT_BLACKLIST:
        fs.setdefault(root.replace("\\", "/"), RO)
    return fs


def _find_policy_file(workspace_root: str) -> Optional[str]:
    try:
        from user_dirs import home_dir as _user_home_dir
    except ImportError:  # pragma: no cover - packaged import shape
        from app.backend.user_dirs import home_dir as _user_home_dir
    candidates: list[str] = []
    if workspace_root:
        for name in _POLICY_FILENAMES:
            candidates.append(os.path.join(workspace_root, name))
            candidates.append(os.path.join(workspace_root, ".ovolve", name))
            candidates.append(os.path.join(workspace_root, ".ovolve", name))
    # New home (~/.ovolve, migrated from ~/.ovolve by user_dirs) first, then
    # the legacy location so a not-yet-migrated policy file still applies.
    for base in (str(_user_home_dir()),
                 os.path.join(os.path.expanduser("~"), ".ovolve")):
        for name in _POLICY_FILENAMES:
            candidates.append(os.path.join(base, name))
    for p in candidates:
        if os.path.isfile(p):
            return p
    return None


def load_policy(workspace_root: str, *, mode: str = "workspace-write") -> PathPolicy:
    """Load YAML (if any) and resolve it against ``workspace_root``.

    ``mode=read-only`` forces every filesystem entry to ``ro`` except ``tmp``
    (compilers still need a scratch dir). ``danger-full-access`` keeps the
    hard floor (system dirs, secrets, guiding files) but allows writes
    anywhere else.
    """
    ws = workspace_root or os.getcwd()
    fs_map = builtin_filesystem()
    net_default = "allow"
    net_block: list[str] = ["169.254.169.254/32", "169.254.0.0/16"]
    source = "built-in"

    path = _find_policy_file(ws)
    if path:
        try:
            with open(path, "r", encoding="utf-8") as f:
                doc = load_simple_yaml(f.read())
        except (OSError, ValueError):
            doc = {}
        else:
            source = path
            user_fs = doc.get("filesystem") or {}
            if isinstance(user_fs, dict):
                for k, v in user_fs.items():
                    access = str(v or "").strip().lower()
                    if access in _ACCESS:
                        fs_map[str(k)] = access
            user_net = doc.get("network") or {}
            if isinstance(user_net, dict):
                if user_net.get("default"):
                    net_default = str(user_net["default"]).strip().lower()
                block = user_net.get("block") or []
                if isinstance(block, list) and block:
                    net_block = [str(x) for x in block]

    mode = (mode or "").strip().lower()
    if mode == "read-only":
        fs_map = {k: (RW if k in {"tmp", "temp", "tmp/**"} else RO) for k, v in fs_map.items()}
        fs_map["workspace"] = RO
        fs_map["tmp"] = RW
    elif mode == "danger-full-access":
        # Keep secrets + OS dirs; drop the default-deny-write by marking
        # a catch-all rw. Specific none/ro rules still win on specificity.
        fs_map["/"] = RW
        if os.name == "nt":
            fs_map["C:/"] = RW

    policy = PathPolicy(
        workspace_root=_norm_path(ws),
        network_default=net_default,
        network_block=tuple(net_block),
        source=source,
    )
    for key, access in fs_map.items():
        policy._add(str(key), access)
    # Guiding-file globs as ro so a write intent matching them is denied even
    # when the workspace itself is rw. check_path also has a basename floor.
    for g in _GUIDING_GLOBS:
        for resolved in _resolve_key(g, ws):
            policy.rules.append(FsRule(raw=g, path=resolved, access=RO))
    return policy


def evaluate_command(command: str, *, cwd: str, workspace_root: str,
                     mode: str = "workspace-write") -> PolicyVerdict:
    return load_policy(workspace_root, mode=mode).evaluate_command(command, cwd or workspace_root)


def assert_command_allowed(command: str, *, cwd: str, workspace_root: str,
                           mode: str = "workspace-write") -> PathPolicy:
    policy = load_policy(workspace_root, mode=mode)
    policy.assert_allowed(command, cwd or workspace_root)
    return policy
