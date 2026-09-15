"""sandbox.py — OS-native process confinement (the hard boundary).

Every shell command the agent runs is supposed to go through
:func:`popen_confined`. That function is this project's equivalent of
沙箱执行器: a single gate that applies a kernel mechanism, not a
suggestion the child can ignore.

    PathGuard          application-layer, already mounted (obvious oversteps)
    path_policy.yaml   auditable, user-editable, open-source advantage
    popen_confined     THIS MODULE — kernel/OS last word

Platform backends, none of which need root / a sudo prompt:

- Windows: Job Objects (process tree, no breakaway, kill-on-close) plus a
  restricted token when the APIs allow it. Job Objects do not filter the
  filesystem; that is what the path-policy layer and WRITE_RESTRICTED tokens
  are for. Probe reports ``partial`` when only the job is in force, ``full``
  when the write-restricted token is too.
- macOS: ``sandbox-exec`` + a generated Seatbelt profile (``allow default``,
  then ``deny file-write*`` with whitelist subpaths).
- Linux: Landlock (unprivileged, kernel 5.13+) applied in the child via
  ``preexec_fn``, with a bubblewrap fallback if Landlock is missing.

Capability probe is separate from execution. ``probe()`` says what this
machine can actually enforce; callers decide. Default for workspace-write
is "run inside whatever backend we have" — Job Objects exist on every
Windows box this app ships to, so the gate is real, not theatrical.

``danger-full-access`` is the explicit bypass and does not call this module.
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import threading

from dataclasses import dataclass
from typing import Optional

READ_ONLY = "read-only"
WORKSPACE_WRITE = "workspace-write"
DANGER_FULL_ACCESS = "danger-full-access"
SANDBOX_MODES = (READ_ONLY, WORKSPACE_WRITE, DANGER_FULL_ACCESS)
CONFINED_MODES = (READ_ONLY, WORKSPACE_WRITE)

FULL = "full"
PARTIAL = "partial"
UNAVAILABLE = "unavailable"


@dataclass
class SandboxPolicy:
    """One constrained execution. Defaults are filled by :func:`resolve_policy`."""

    mode: str = DANGER_FULL_ACCESS
    workspace_root: str = ""
    extra_writable: tuple = ()
    strict: bool = True
    # 细粒度资源上限（OS 加固深实现）。None = resolve_policy 按模式填默认；
    # 显式传值可覆盖（测试用小上限验证因果）。仅 confined 模式生效——
    # danger-full-access 本来就是"用户明确要的旁路"，不再加码。
    memory_limit_mb: Optional[int] = None
    cpu_rate_percent: Optional[int] = None

    def writable_roots(self) -> tuple:
        if self.mode != WORKSPACE_WRITE:
            return ()
        seen: list = []
        for p in (self.workspace_root, *self.extra_writable):
            if not p:
                continue
            try:
                real = os.path.realpath(p)
            except OSError:
                continue
            if real not in seen:
                seen.append(real)
        return tuple(seen)


@dataclass
class Enforcement:
    """What this machine can actually force, and with which backend."""

    level: str = UNAVAILABLE
    backend: str = ""
    detail: str = ""

    @property
    def usable(self) -> bool:
        return self.level in (FULL, PARTIAL)


class SandboxError(Exception):
    """Constraint requested but the process could not be started under it."""


# ── 细粒度资源上限默认值（按模式）────────────────────────────────────────────
# 内存上限挡的是"一个失控子进程吃光整机内存"；只读模式跑查询，512MB 绰绰有
# 余；workspace-write 要给 pip/npm/编译器留头寸。CPU 速率是硬顶（HARD_CAP），
# 挡的是"死循环把一个核烧满"——90% 仍给系统留呼吸位。
DEFAULT_MEMORY_LIMIT_MB = {READ_ONLY: 512, WORKSPACE_WRITE: 2048}
DEFAULT_CPU_RATE_PERCENT = {READ_ONLY: 50, WORKSPACE_WRITE: 90}


def resolve_policy(mode: str, workspace_root: str = "",
                   strict: bool = True) -> SandboxPolicy:
    """Unknown modes fall back to ``read-only``, never to full access."""
    m = (mode or "").strip().lower()
    if m not in SANDBOX_MODES:
        m = READ_ONLY
    extra: tuple = ()
    if m == WORKSPACE_WRITE:
        extra = _workspace_write_extras(workspace_root or "")
    return SandboxPolicy(
        mode=m, workspace_root=workspace_root or "",
        extra_writable=extra, strict=strict,
        memory_limit_mb=DEFAULT_MEMORY_LIMIT_MB.get(m),
        cpu_rate_percent=DEFAULT_CPU_RATE_PERCENT.get(m),
    )


def _workspace_write_extras(workspace_root: str) -> tuple:
    """Scratch dirs package managers and compilers write without naming them.

    Path policy still refuses a command that *names* ``~/.cache/evil``; this
    list is for the kernel backend, so ``pip install`` / ``npm install`` can
    use their caches. Home itself is not on the list.
    """
    home = os.path.expanduser("~")
    candidates = [
        tempfile.gettempdir(),
        os.path.join(home, ".cache"),
        os.path.join(home, ".npm"),
        os.path.join(home, ".cargo"),
        os.path.join(home, ".local"),
        os.path.join(home, "Library", "Caches"),
        os.path.join(home, "AppData", "Local"),
        os.path.join(home, "AppData", "LocalLow"),
    ]
    if workspace_root:
        candidates.extend((
            os.path.join(workspace_root, "temp"),
            os.path.join(workspace_root, "output"),
        ))
    seen: list = []
    for p in candidates:
        if not p:
            continue
        try:
            real = os.path.realpath(p)
        except OSError:
            continue
        if real not in seen:
            seen.append(real)
    return tuple(seen)


# ── probe ───────────────────────────────────────────────────────────────────

_probe_cache: Optional[Enforcement] = None


def reset_probe_cache() -> None:
    global _probe_cache
    _probe_cache = None


def probe() -> Enforcement:
    """Cached: kernel features do not change during a process lifetime."""
    global _probe_cache
    if _probe_cache is None:
        _probe_cache = _probe_uncached()
    return _probe_cache


def _probe_uncached() -> Enforcement:
    system = platform.system()
    if system == "Windows":
        return _probe_windows()
    if system == "Darwin":
        return _probe_macos()
    if system == "Linux":
        return _probe_linux()
    return Enforcement(UNAVAILABLE, "", f"unsupported OS: {system}")


def _probe_windows() -> Enforcement:
    api = _win_api()
    if api is None:
        return Enforcement(UNAVAILABLE, "", "Win32 APIs unavailable")
    k32 = api["k32"]
    job = k32.CreateJobObjectW(None, None)
    if not job:
        return Enforcement(UNAVAILABLE, "", "CreateJobObject failed")
    k32.CloseHandle(job)
    # Restricted tokens exist on every NT; whether CreateProcessAsUser will
    # accept ours is checked at spawn time. Job Objects alone are already a
    # real kernel boundary (process tree, no breakaway, kill-on-close).
    return Enforcement(
        PARTIAL, "job_object",
        "Job Objects constrain the process tree. Filesystem writes are "
        "enforced by the path-policy layer; a write-restricted token is "
        "applied when CreateProcessAsUser accepts it.",
    )


def _probe_macos() -> Enforcement:
    exe = shutil.which("sandbox-exec") or "/usr/bin/sandbox-exec"
    if os.path.isfile(exe) and os.access(exe, os.X_OK):
        return Enforcement(FULL, "seatbelt", f"sandbox-exec at {exe}")
    return Enforcement(UNAVAILABLE, "", "sandbox-exec not found")


def _probe_linux() -> Enforcement:
    abi = _landlock_abi()
    if abi >= 1:
        return Enforcement(FULL, "landlock", f"Landlock ABI {abi}")
    if shutil.which("bwrap"):
        return Enforcement(PARTIAL, "bwrap", "bubblewrap (Landlock unavailable)")
    return Enforcement(UNAVAILABLE, "", "no Landlock, no bubblewrap")


def confinement_status(workspace_root: str = "") -> dict:
    """Public snapshot for the settings page: kernel backend + policy file."""
    enf = probe()
    policy_source = "built-in"
    try:
        from path_policy import load_policy
        pol = load_policy(workspace_root or os.getcwd())
        policy_source = pol.source
        summary = pol.summary()
    except Exception as exc:  # noqa: BLE001
        summary = {"error": str(exc)}
    return {
        "effective": enf.usable,
        "level": enf.level,
        "backend": enf.backend,
        "detail": enf.detail,
        "os": platform.system(),
        "policy_source": policy_source,
        "policy": summary,
        "note": _status_note(enf, policy_source),
    }


def _status_note(enf: Enforcement, policy_source: str) -> str:
    """Short human summary for APIs/logs. UI should map structured fields to i18n."""
    if not enf.usable:
        return "内核沙箱不可用。命令仍会走路径策略，但没有内核级兜底。"
    src = "内置默认策略" if policy_source == "built-in" else "自定义策略"
    if enf.level == FULL:
        return f"内核沙箱已启用。路径策略：{src}。"
    return f"内核沙箱部分启用。路径策略：{src}。"


def describe_os_confinement() -> str:
    """本机**实际可用**的隔离种类，供 ExecutionPlan.os_confinement 引用。

    词汇表与 execution_provider 对齐：job_object | seatbelt | landlock |
    popen_confined。这是探测结果而不是平台查表——Linux 内核没有 Landlock
    （ABI < 1）时如实报 fallback，macOS 找不到 sandbox-exec 同理。声明字段
    必须反映真实施加的隔离，否则"reversible 徽章变谎言"在隔离维度重演。
    """
    system = platform.system()
    if system == "Windows":
        enf = probe()
        return "job_object" if enf.usable else "popen_confined"
    if system == "Darwin":
        return "seatbelt" if probe().usable else "popen_confined"
    if system == "Linux":
        try:
            if _landlock_abi() >= 1:
                return "landlock"
        except Exception:  # noqa: BLE001 — 探测失败按 fallback，不撒谎
            pass
        return "popen_confined"
    return "popen_confined"


# ── public spawn gate ───────────────────────────────────────────────────────


def popen_confined(command: str, policy: SandboxPolicy, **popen_kw):
    """The only sanctioned way to start a confined shell command.

    Returns a ``subprocess.Popen`` (or a duck-typed stand-in on Windows
    when we have to go through CreateProcessAsUser). ``danger-full-access``
    is a plain ``Popen``.
    """
    if policy.mode == DANGER_FULL_ACCESS:
        return _plain_popen(command, **popen_kw)

    enf = probe()
    if not enf.usable:
        if policy.strict:
            raise SandboxError(
                f"无法在本机强制沙箱约束（{enf.detail or 'unavailable'}），已拒绝执行。"
            )
        return _plain_popen(command, **popen_kw)

    if enf.backend == "seatbelt":
        return _macos_popen(command, policy, **popen_kw)
    if enf.backend == "landlock":
        return _linux_landlock_popen(command, policy, **popen_kw)
    if enf.backend == "bwrap":
        return _linux_bwrap_popen(command, policy, **popen_kw)
    if enf.backend == "job_object":
        return _windows_popen(command, policy, **popen_kw)
    raise SandboxError(f"unknown sandbox backend: {enf.backend}")


def release_confinement(proc) -> None:
    """Drop Job Object handles after the child has exited (Windows)."""
    closer = getattr(proc, "release_job", None)
    if callable(closer):
        try:
            closer()
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程


def terminate_confined(proc) -> None:
    """Kill a confined tree. Job Objects beat taskkill; Unix uses the group."""
    killer = getattr(proc, "kill_tree", None)
    if callable(killer):
        try:
            killer()
            return
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
    job = getattr(proc, "_mb_job", None)
    if job:
        try:
            _win_terminate_job(job)
            return
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程


def run_confined_capture(command: str, *, cwd: str = "", timeout: float = 30.0,
                        mode: str = WORKSPACE_WRITE,
                        strict: bool = False) -> dict:
    """Run one command to completion under confinement and capture its output.

    Exists because two verification paths were calling ``subprocess.run``
    directly — ``skill_lifecycle.approve`` (the candidate's own
    ``verify_command``) and ``validator_registry.command_validator`` (with
    ``shell=True``). Both execute a string that came from *outside* the
    process, at the exact moment the system is deciding whether to trust it.
    Those were the last two unconfined execution paths in the backend, and they
    were the ones with the weakest provenance.

    The returned dict always reports ``confinement`` — the backend that was
    actually in force, or ``"none"``. That field matters more than it looks: a
    gate that says "verification passed" while the command ran unconfined is
    reporting a different fact than it appears to, and the caller must be able
    to tell those apart rather than infer sandboxing from the absence of an
    error.

    ``strict=False`` by default: on a machine with no enforceable backend the
    command still runs, but the evidence says ``confinement: none`` instead of
    quietly implying otherwise. Callers that must not run unconfined pass
    ``strict=True`` and get a ``SandboxError`` recorded as ``error``.

    Returns:
        ``{ran, returncode, output, timeout, confinement, mode, error}``.
        ``output`` is stdout with stderr merged in (same shape the shell
        executor produces, so evidence reads the same everywhere).
    """
    workspace = cwd or os.getcwd()
    policy = resolve_policy(mode, workspace_root=workspace, strict=strict)
    enf = probe()
    out: dict = {
        "ran": False, "returncode": None, "output": "", "timeout": False,
        "confinement": (enf.backend if enf.usable else "none"),
        "mode": policy.mode, "error": "",
    }
    if policy.mode == DANGER_FULL_ACCESS:
        out["confinement"] = "none"

    try:
        proc = popen_confined(
            command, policy, cwd=workspace,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=False, bufsize=0,
        )
    except SandboxError as exc:
        out["error"] = f"confinement unavailable: {exc}"
        return out
    except Exception as exc:  # noqa: BLE001 - OSError, ValueError, Win32 …
        out["error"] = f"cannot start: {exc}"
        return out

    out["ran"] = True
    expired = threading.Event()

    def _on_deadline() -> None:
        expired.set()
        terminate_confined(proc)
        try:
            proc.kill()
        except Exception:
            pass  # fail-open: 树已被 job/进程组带走，单进程 kill 只是兜底

    killer = threading.Timer(max(0.1, float(timeout)), _on_deadline)
    killer.daemon = True
    killer.start()
    try:
        raw = b""
        stream = getattr(proc, "stdout", None)
        if stream is not None:
            try:
                raw = stream.read() or b""
            except Exception as exc:  # noqa: BLE001
                out["error"] = f"read failed: {exc}"
        rc = proc.wait()
        out["returncode"] = None if expired.is_set() else rc
        if isinstance(raw, bytes):
            # 与 run_shell 同一套解码顺序：UTF-8 优先，中文 Windows 回落
            # GB18030。少了这一步，一条中文报错会变成乱码证据。
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = raw.decode("gb18030", errors="replace")
        else:
            text = str(raw or "")
        out["output"] = text
        out["timeout"] = expired.is_set()
    finally:
        killer.cancel()
        release_confinement(proc)
    return out


def _plain_popen(command: str, **kw):
    kw = dict(kw)
    if "cwd" in kw:
        cwd_val = kw.get("cwd")
        if not cwd_val or not isinstance(cwd_val, str) or not os.path.isdir(cwd_val.strip(' "\'')):
            kw["cwd"] = None
        else:
            kw["cwd"] = cwd_val.strip(' "\'')

    if os.name != "nt":
        kw.setdefault("start_new_session", True)
        return subprocess.Popen(command, shell=True, **kw)

    # Windows: Auto-detect PowerShell cmdlets / syntax and route to powershell.exe
    _ps_signatures = (
        "Get-", "Set-", "Select-", "Where-Object", "Format-", "Test-Path",
        "$env:", "$PROFILE", "$HOME", "Invoke-", "Start-Process", "Stop-Process",
        "HKLM:", "HKCU:", "New-Object", "-match ", "-like ", "-eq ", "Remove-Item"
    )
    if any(sig.lower() in command.lower() for sig in _ps_signatures) and not command.strip().lower().startswith("powershell"):
        return subprocess.Popen(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], shell=False, **kw)
    return subprocess.Popen(command, shell=True, **kw)


# ── macOS: sandbox-exec + Seatbelt ──────────────────────────────────────────


def _sbpl_escape(path: str) -> str:
    return path.replace("\\", "\\\\").replace('"', '\\"')


def _macos_profile(policy: SandboxPolicy) -> str:
    """Allow-default, deny-writes, whitelist writable roots.

    ``(deny default)`` looks stricter and breaks DNS, mach lookups, and
    a long tail of libc paths. macOS Seatbelt deployments use this shape.
    """
    lines = [
        "(version 1)",
        "(allow default)",
        "(deny file-write*)",
        '(allow file-write-data (literal "/dev/null"))',
        '(allow file-write-data (literal "/dev/zero"))',
        '(allow file-write-data (regex #"^/dev/tty.*"))',
        '(allow file-ioctl (literal "/dev/dtracehelper"))',
        '(allow file-write* (subpath "/private/tmp"))',
        '(allow file-write* (subpath "/tmp"))',
    ]
    roots = []
    if policy.mode == WORKSPACE_WRITE:
        roots.extend(policy.writable_roots())
    else:
        # read-only still needs a scratch dir for compiler temp files
        roots.append(tempfile.gettempdir())
    seen = set()
    for raw in roots:
        try:
            real = os.path.realpath(raw)
        except OSError:
            continue
        if real in seen:
            continue
        seen.add(real)
        esc = _sbpl_escape(real)
        lines.append(f'(allow file-write* (subpath "{esc}"))')
        # macOS /var is a symlink to /private/var
        if real.startswith("/var/"):
            priv = "/private" + real
            lines.append(f'(allow file-write* (subpath "{_sbpl_escape(priv)}"))')
    return "\n".join(lines) + "\n"


def _macos_popen(command: str, policy: SandboxPolicy, **kw):
    exe = shutil.which("sandbox-exec") or "/usr/bin/sandbox-exec"
    profile = _macos_profile(policy)
    shell = os.environ.get("SHELL") or "/bin/bash"
    argv = [exe, "-p", profile, shell, "-c", command]
    kw = dict(kw)
    kw.pop("start_new_session", None)
    kw.setdefault("start_new_session", True)
    return subprocess.Popen(argv, **kw)


# ── Linux: Landlock (+ optional seccomp) / bwrap ────────────────────────────

_SYS_LANDLOCK_CREATE_RULESET = 444
_SYS_LANDLOCK_ADD_RULE = 445
_SYS_LANDLOCK_RESTRICT_SELF = 446
_LANDLOCK_CREATE_RULESET_VERSION = 1 << 0
_LANDLOCK_RULE_PATH_BENEATH = 1

_LL_EXECUTE = 1 << 0
_LL_WRITE_FILE = 1 << 1
_LL_READ_FILE = 1 << 2
_LL_READ_DIR = 1 << 3
_LL_REMOVE_DIR = 1 << 4
_LL_REMOVE_FILE = 1 << 5
_LL_MAKE_CHAR = 1 << 6
_LL_MAKE_DIR = 1 << 7
_LL_MAKE_REG = 1 << 8
_LL_MAKE_SOCK = 1 << 9
_LL_MAKE_FIFO = 1 << 10
_LL_MAKE_BLOCK = 1 << 11
_LL_MAKE_SYM = 1 << 12
_LL_REFER = 1 << 13
_LL_TRUNCATE = 1 << 14
_LL_IOCTL_DEV = 1 << 15

_LL_READ = _LL_EXECUTE | _LL_READ_FILE | _LL_READ_DIR
_LL_WRITE = (
    _LL_WRITE_FILE | _LL_REMOVE_DIR | _LL_REMOVE_FILE
    | _LL_MAKE_CHAR | _LL_MAKE_DIR | _LL_MAKE_REG | _LL_MAKE_SOCK
    | _LL_MAKE_FIFO | _LL_MAKE_BLOCK | _LL_MAKE_SYM
)


def _libc():
    import ctypes
    try:
        return ctypes.CDLL(None, use_errno=True)
    except Exception:  # noqa: BLE001
        return None


def _landlock_abi() -> int:
    if os.name == "nt":
        return 0
    libc = _libc()
    if libc is None:
        return 0
    try:
        abi = libc.syscall(
            _SYS_LANDLOCK_CREATE_RULESET,
            None, 0, _LANDLOCK_CREATE_RULESET_VERSION,
        )
    except Exception:  # noqa: BLE001
        return 0
    return int(abi) if abi >= 1 else 0


def _ll_handled(abi: int) -> int:
    bits = _LL_READ | _LL_WRITE
    if abi >= 2:
        bits |= _LL_REFER
    if abi >= 3:
        bits |= _LL_TRUNCATE
    if abi >= 5:
        bits |= _LL_IOCTL_DEV
    return bits


def _landlock_apply(policy: SandboxPolicy) -> None:
    """Apply Landlock to the current process. Called in the child, pre-exec."""
    import ctypes
    from ctypes import c_uint32, c_uint64, c_int, sizeof, byref

    abi = _landlock_abi()
    if abi < 1:
        raise SandboxError("Landlock not available in child")

    class RulesetAttr(ctypes.Structure):
        _fields_ = [("handled_access_fs", c_uint64),
                    ("handled_access_net", c_uint64)]

    class PathBeneath(ctypes.Structure):
        _fields_ = [("allowed_access", c_uint64), ("parent_fd", c_int)]

    libc = _libc()
    handled = _ll_handled(abi)
    attr = RulesetAttr(handled_access_fs=handled, handled_access_net=0)
    ruleset = libc.syscall(
        _SYS_LANDLOCK_CREATE_RULESET, byref(attr), ctypes.c_size_t(sizeof(attr)), 0,
    )
    if ruleset < 0:
        raise SandboxError("landlock_create_ruleset failed")

    read_bits = _LL_READ & handled
    write_bits = (_LL_READ | _LL_WRITE) & handled
    if abi >= 2:
        write_bits |= _LL_REFER
        read_bits |= _LL_REFER
    if abi >= 3:
        write_bits |= _LL_TRUNCATE

    def add_path(path: str, access: int) -> None:
        if not path or not os.path.isdir(path):
            return
        flags = os.O_RDONLY
        if hasattr(os, "O_DIRECTORY"):
            flags |= os.O_DIRECTORY
        if hasattr(os, "O_CLOEXEC"):
            flags |= os.O_CLOEXEC
        try:
            fd = os.open(path, flags)
        except OSError:
            return
        try:
            rule = PathBeneath(allowed_access=access, parent_fd=fd)
            rc = libc.syscall(
                _SYS_LANDLOCK_ADD_RULE, c_int(ruleset),
                c_uint32(_LANDLOCK_RULE_PATH_BENEATH), byref(rule), c_uint32(0),
            )
            if rc < 0:
                pass  # skip paths we cannot add rather than abort the whole ruleset
        finally:
            os.close(fd)

    add_path("/", read_bits)
    # Some distros hide /usr behind a mount; adding it explicitly is cheap.
    for extra_read in ("/usr", "/etc", "/opt", "/home"):
        add_path(extra_read, read_bits)

    writable = []
    if policy.mode == WORKSPACE_WRITE:
        writable.extend(policy.writable_roots())
    else:
        writable.append(tempfile.gettempdir())
    for root in writable:
        add_path(root, write_bits)

    PR_SET_NO_NEW_PRIVS = 38
    libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
    rc = libc.syscall(_SYS_LANDLOCK_RESTRICT_SELF, c_int(ruleset), c_uint32(0))
    os.close(ruleset)
    if rc < 0:
        raise SandboxError("landlock_restrict_self failed")
    _seccomp_apply_best_effort()


# x86_64 syscalls we never want a confined agent to make.
_SECCOMP_DENY_X86_64 = (
    101,  # ptrace
    165,  # mount
    166,  # umount2
    167,  # swapon
    168,  # swapoff
    169,  # reboot
    175,  # init_module
    176,  # delete_module
    246,  # kexec_load
    294,  # kexec_file_load
)


def _seccomp_apply_best_effort() -> None:
    """Block a handful of destructive syscalls. Failures are ignored.

    A wrong architecture would filter the wrong numbers, so this only
    installs on x86_64. Landlock is the filesystem boundary; this is extra.
    """
    if platform.machine().lower() not in ("x86_64", "amd64"):
        return
    try:
        import ctypes
        from ctypes import c_uint16, c_uint32, c_uint64, c_void_p, POINTER, sizeof, byref
    except Exception:  # noqa: BLE001
        return

    BPF_LD = 0x00
    BPF_W = 0x00
    BPF_ABS = 0x20
    BPF_JMP = 0x05
    BPF_JEQ = 0x10
    BPF_K = 0x00
    BPF_RET = 0x06
    SECCOMP_RET_ALLOW = 0x7FFF0000
    SECCOMP_RET_ERRNO = 0x00050000
    EPERM = 1
    SECCOMP_SET_MODE_FILTER = 1
    PR_SET_SECCOMP = 22
    SECCOMP_MODE_FILTER = 2

    class SockFilter(ctypes.Structure):
        _fields_ = [("code", c_uint16), ("jt", ctypes.c_uint8),
                    ("jf", ctypes.c_uint8), ("k", c_uint32)]

    class SockFprog(ctypes.Structure):
        _fields_ = [("len", c_uint16), ("filter", POINTER(SockFilter))]

    # seccomp_data.nr is at offset 0
    filters = [SockFilter(BPF_LD | BPF_W | BPF_ABS, 0, 0, 0)]
    deny = SECCOMP_RET_ERRNO | (EPERM & 0xFFFF)
    for nr in _SECCOMP_DENY_X86_64:
        filters.append(SockFilter(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, nr))
        filters.append(SockFilter(BPF_RET | BPF_K, 0, 0, deny))
    filters.append(SockFilter(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW))

    arr = (SockFilter * len(filters))(*filters)
    prog = SockFprog(len(filters), arr)
    libc = _libc()
    if libc is None:
        return
    try:
        # prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog)
        libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, byref(prog))
    except Exception:  # noqa: BLE001
        return


def _linux_landlock_popen(command: str, policy: SandboxPolicy, **kw):
    kw = dict(kw)
    kw.pop("start_new_session", None)

    def _preexec() -> None:
        _landlock_apply(policy)

    return subprocess.Popen(
        command, shell=True, preexec_fn=_preexec, start_new_session=True, **kw,
    )


def _linux_bwrap_popen(command: str, policy: SandboxPolicy, **kw):
    bwrap = shutil.which("bwrap")
    if not bwrap:
        raise SandboxError("bwrap not found")
    argv = [
        bwrap, "--die-with-parent",
        "--ro-bind", "/", "/",
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", "/tmp",
    ]
    for root in policy.writable_roots() or (tempfile.gettempdir(),):
        if root and os.path.isdir(root):
            argv.extend(["--bind", root, root])
    shell = os.environ.get("SHELL") or "/bin/sh"
    argv.extend(["--", shell, "-c", command])
    kw = dict(kw)
    kw.pop("start_new_session", None)
    kw.setdefault("start_new_session", True)
    return subprocess.Popen(argv, **kw)


# ── Windows: Job Objects + restricted token ─────────────────────────────────

_SANDBOX_SID = "S-1-4-20260814"
_DISABLE_MAX_PRIVILEGE = 0x1
_LUA_TOKEN = 0x4
_WRITE_RESTRICTED = 0x8
_TOKEN_DUPLICATE = 0x0002
_TOKEN_QUERY = 0x0008
_TOKEN_ASSIGN_PRIMARY = 0x0001
_TOKEN_ACCESS = _TOKEN_DUPLICATE | _TOKEN_QUERY | _TOKEN_ASSIGN_PRIMARY
_CREATE_UNICODE_ENVIRONMENT = 0x00000400
_CREATE_NO_WINDOW = 0x08000000
_CREATE_SUSPENDED = 0x00000004
_CREATE_NEW_PROCESS_GROUP = 0x00000200
_INFINITE = 0xFFFFFFFF
_STILL_ACTIVE = 259
_STARTF_USESTDHANDLES = 0x00000100
_STARTF_USESHOWWINDOW = 0x00000001
_SW_HIDE = 0
_HANDLE_FLAG_INHERIT = 0x00000001
_DUPLICATE_SAME_ACCESS = 0x00000002
_JobObjectExtendedLimitInformation = 9
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008
_JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400
_JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100
_JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200
# UI 限制（JOBOBJECT_BASIC_UI_RESTRICTIONS，InfoClass=4）。刻意不含
# UILIMIT_HANDLES：子进程要用父进程继承来的 stdout 管道句柄，加上它会
# 掐断输出捕获——这是能力与可观测性的取舍，取后者并如实注释。
_JobObjectBasicUIRestrictions = 4
_JOB_OBJECT_UILIMIT_READCLIPBOARD = 0x0002
_JOB_OBJECT_UILIMIT_WRITECLIPBOARD = 0x0004
_JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS = 0x0008
_JOB_OBJECT_UILIMIT_DISPLAYSETTINGS = 0x0010
_JOB_OBJECT_UILIMIT_GLOBALATOMS = 0x0020
_JOB_OBJECT_UILIMIT_DESKTOP = 0x0040
_JOB_OBJECT_UILIMIT_EXITWINDOWS = 0x0080
# CPU 速率控制（JOBOBJECT_CPU_RATE_CONTROL_INFORMATION，InfoClass=21，Win8+）。
# CpuRate 单位是百分之一百分点：50% = 5000。
_JobObjectCpuRateControlInformation = 21
_JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1
_JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x4
_JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x00000800  # deliberately NOT set
_WAIT_OBJECT_0 = 0
_WAIT_TIMEOUT = 0x00000102


def _win_api():
    """Lazy Win32 surface. None on non-Windows or if ctypes.wintypes fails."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes
    except Exception:  # noqa: BLE001
        return None

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    adv = ctypes.WinDLL("advapi32", use_last_error=True)

    class SID_AND_ATTRIBUTES(ctypes.Structure):
        _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", wintypes.DWORD)]

    class STARTUPINFOW(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR),
            ("lpDesktop", wintypes.LPWSTR), ("lpTitle", wintypes.LPWSTR),
            ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD),
            ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD),
            ("dwXCountChars", wintypes.DWORD), ("dwYCountChars", wintypes.DWORD),
            ("dwFillAttribute", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
            ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD),
            ("lpReserved2", ctypes.c_void_p), ("hStdInput", wintypes.HANDLE),
            ("hStdOutput", wintypes.HANDLE), ("hStdError", wintypes.HANDLE),
        ]

    class PROCESS_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE),
            ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD),
        ]

    class SECURITY_ATTRIBUTES(ctypes.Structure):
        _fields_ = [
            ("nLength", wintypes.DWORD),
            ("lpSecurityDescriptor", ctypes.c_void_p),
            ("bInheritHandle", wintypes.BOOL),
        ]

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
            ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_uint64),
            ("WriteOperationCount", ctypes.c_uint64),
            ("OtherOperationCount", ctypes.c_uint64),
            ("ReadTransferCount", ctypes.c_uint64),
            ("WriteTransferCount", ctypes.c_uint64),
            ("OtherTransferCount", ctypes.c_uint64),
        ]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    class JOBOBJECT_BASIC_UI_RESTRICTIONS(ctypes.Structure):
        _fields_ = [("UIRestrictionsClass", wintypes.DWORD)]

    class JOBOBJECT_CPU_RATE_CONTROL_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("ControlFlags", wintypes.DWORD),
            ("CpuRate", wintypes.DWORD),
        ]

    return {
        "ctypes": ctypes, "wintypes": wintypes, "k32": k32, "adv": adv,
        "SID_AND_ATTRIBUTES": SID_AND_ATTRIBUTES,
        "STARTUPINFOW": STARTUPINFOW,
        "PROCESS_INFORMATION": PROCESS_INFORMATION,
        "SECURITY_ATTRIBUTES": SECURITY_ATTRIBUTES,
        "JOBOBJECT_EXTENDED_LIMIT_INFORMATION": JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        "JOBOBJECT_BASIC_UI_RESTRICTIONS": JOBOBJECT_BASIC_UI_RESTRICTIONS,
        "JOBOBJECT_CPU_RATE_CONTROL_INFORMATION": JOBOBJECT_CPU_RATE_CONTROL_INFORMATION,
    }


def _win_create_job(api, policy: Optional[SandboxPolicy] = None,
                    active_process_limit: int = 64):
    """Create a job with the full confinement stack, degrading per-feature.

    细粒度策略逐项施加、逐项降级：内存上限失败不拖垮 UI 限制，CPU 速率失败
    不拖垮整个 job——每一项都是真实加固，但任何一项缺失都好过没有 job。
    返回 ``(job, applied: dict)``，applied 让审计/测试能看到到底加上了什么。
    """
    k32 = api["k32"]
    ctypes = api["ctypes"]
    job = k32.CreateJobObjectW(None, None)
    if not job:
        return None, {}
    applied: dict = {}
    policy = policy or SandboxPolicy()

    info = api["JOBOBJECT_EXTENDED_LIMIT_INFORMATION"]()
    flags = (
        _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | _JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | _JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
    )
    info.BasicLimitInformation.ActiveProcessLimit = active_process_limit
    if policy.memory_limit_mb:
        # 双上限：单进程 + 全 job 树。字节换算用 1024² 与 JobObject 语义一致。
        limit_bytes = int(policy.memory_limit_mb) * 1024 * 1024
        info.ProcessMemoryLimit = limit_bytes
        info.JobMemoryLimit = limit_bytes
        flags |= _JOB_OBJECT_LIMIT_PROCESS_MEMORY | _JOB_OBJECT_LIMIT_JOB_MEMORY
    info.BasicLimitInformation.LimitFlags = flags
    ok = k32.SetInformationJobObject(
        job, _JobObjectExtendedLimitInformation,
        ctypes.byref(info), ctypes.sizeof(info),
    )
    if not ok:
        k32.CloseHandle(job)
        return None, {}
    applied["kill_on_close"] = True
    applied["active_process_limit"] = active_process_limit
    if policy.memory_limit_mb:
        applied["memory_limit_mb"] = policy.memory_limit_mb

    # UI 限制：剪贴板读写 / 改系统参数 / 改显示设置 / 关机 / 全局原子表 /
    # 新桌面。失败降级（老系统或会话态不支持）——job 本身仍然有效。
    ui = api["JOBOBJECT_BASIC_UI_RESTRICTIONS"]()
    ui.UIRestrictionsClass = (
        _JOB_OBJECT_UILIMIT_READCLIPBOARD
        | _JOB_OBJECT_UILIMIT_WRITECLIPBOARD
        | _JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
        | _JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
        | _JOB_OBJECT_UILIMIT_GLOBALATOMS
        | _JOB_OBJECT_UILIMIT_DESKTOP
        | _JOB_OBJECT_UILIMIT_EXITWINDOWS
    )
    if k32.SetInformationJobObject(
        job, _JobObjectBasicUIRestrictions,
        ctypes.byref(ui), ctypes.sizeof(ui),
    ):
        applied["ui_restrictions"] = True

    # CPU 速率硬顶（Win8+）。失败降级：老系统没有这个 InfoClass。
    if policy.cpu_rate_percent:
        rate = api["JOBOBJECT_CPU_RATE_CONTROL_INFORMATION"]()
        rate.ControlFlags = (_JOB_OBJECT_CPU_RATE_CONTROL_ENABLE
                             | _JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP)
        rate.CpuRate = int(min(99, max(1, policy.cpu_rate_percent)) * 100)
        if k32.SetInformationJobObject(
            job, _JobObjectCpuRateControlInformation,
            ctypes.byref(rate), ctypes.sizeof(rate),
        ):
            applied["cpu_rate_percent"] = policy.cpu_rate_percent

    return job, applied


def _win_terminate_job(job) -> None:
    api = _win_api()
    if api is None or not job:
        return
    api["k32"].TerminateJobObject(job, 1)


def _win_close_handle(handle) -> None:
    api = _win_api()
    if api is None or not handle:
        return
    try:
        api["k32"].CloseHandle(handle)
    except Exception:
        pass  # fail-open: 可选增强，失败不影响主流程


class _WinProc:
    """Popen-shaped wrapper around a CreateProcess handle + Job Object."""

    def __init__(self, h_process, h_thread, pid, stdout_file, job):
        self._h_process = h_process
        self._h_thread = h_thread
        self.pid = pid
        self.stdout = stdout_file
        self.stderr = None
        self.returncode = None
        self._mb_job = job
        self.args = None

    def poll(self):
        if self.returncode is not None:
            return self.returncode
        api = _win_api()
        rc = api["wintypes"].DWORD()
        if not api["k32"].GetExitCodeProcess(self._h_process, api["ctypes"].byref(rc)):
            return None
        if rc.value == _STILL_ACTIVE:
            return None
        self.returncode = int(rc.value)
        return self.returncode

    def wait(self, timeout=None):
        if self.returncode is not None:
            return self.returncode
        api = _win_api()
        ms = _INFINITE if timeout is None else max(0, int(timeout * 1000))
        wr = api["k32"].WaitForSingleObject(self._h_process, ms)
        if wr == _WAIT_TIMEOUT:
            raise subprocess.TimeoutExpired(self.args, timeout)
        rc = api["wintypes"].DWORD()
        api["k32"].GetExitCodeProcess(self._h_process, api["ctypes"].byref(rc))
        self.returncode = int(rc.value)
        return self.returncode

    def kill(self) -> None:
        self.kill_tree()

    def kill_tree(self) -> None:
        if self._mb_job:
            _win_terminate_job(self._mb_job)
        else:
            api = _win_api()
            if api:
                api["k32"].TerminateProcess(self._h_process, 1)

    def release_job(self) -> None:
        if self._mb_job:
            _win_close_handle(self._mb_job)
            self._mb_job = None
        if self._h_thread:
            _win_close_handle(self._h_thread)
            self._h_thread = None
        if self._h_process:
            _win_close_handle(self._h_process)
            self._h_process = None


def _win_restricted_token(api, write_restricted: bool):
    """Build a restricted primary token, or None if the APIs refuse."""
    ctypes = api["ctypes"]
    wintypes = api["wintypes"]
    k32 = api["k32"]
    adv = api["adv"]

    proc = k32.GetCurrentProcess()
    existing = wintypes.HANDLE()
    if not adv.OpenProcessToken(proc, _TOKEN_ACCESS, ctypes.byref(existing)):
        return None

    flags = _DISABLE_MAX_PRIVILEGE | _LUA_TOKEN
    restrict_count = 0
    restrict_arr = None
    sid_mem = None
    if write_restricted:
        flags |= _WRITE_RESTRICTED
        sid_mem = ctypes.c_void_p()
        if not adv.ConvertStringSidToSidW(_SANDBOX_SID, ctypes.byref(sid_mem)):
            k32.CloseHandle(existing)
            return None
        pair = api["SID_AND_ATTRIBUTES"]()
        pair.Sid = sid_mem
        pair.Attributes = 0
        restrict_arr = (api["SID_AND_ATTRIBUTES"] * 1)(pair)
        restrict_count = 1

    new_token = wintypes.HANDLE()
    ok = adv.CreateRestrictedToken(
        existing, flags,
        0, None,
        0, None,
        restrict_count, restrict_arr,
        ctypes.byref(new_token),
    )
    k32.CloseHandle(existing)
    if sid_mem:
        k32.LocalFree(sid_mem)
    if not ok:
        return None
    return new_token


def _win_popen_with_token(command: str, policy: SandboxPolicy, token, job, **kw):
    """CreateProcessAsUser with inherited stdout pipe. None on any failure."""
    api = _win_api()
    ctypes = api["ctypes"]
    wintypes = api["wintypes"]
    k32 = api["k32"]
    adv = api["adv"]

    sa = api["SECURITY_ATTRIBUTES"]()
    sa.nLength = ctypes.sizeof(sa)
    sa.bInheritHandle = True
    sa.lpSecurityDescriptor = None

    stdout_r = wintypes.HANDLE()
    stdout_w = wintypes.HANDLE()
    if not k32.CreatePipe(ctypes.byref(stdout_r), ctypes.byref(stdout_w), ctypes.byref(sa), 0):
        k32.CloseHandle(token)
        return None
    k32.SetHandleInformation(stdout_r, _HANDLE_FLAG_INHERIT, 0)

    # stdin → NUL so the child cannot steal our console
    nul = k32.CreateFileW(
        "NUL", 0x80000000, 1, ctypes.byref(sa), 3, 0x80, None,
    )  # GENERIC_READ, FILE_SHARE_READ, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL

    si = api["STARTUPINFOW"]()
    si.cb = ctypes.sizeof(si)
    si.dwFlags = _STARTF_USESTDHANDLES | _STARTF_USESHOWWINDOW
    si.wShowWindow = _SW_HIDE
    si.hStdInput = nul if nul else None
    si.hStdOutput = stdout_w
    si.hStdError = stdout_w

    pi = api["PROCESS_INFORMATION"]()
    comspec = os.environ.get("COMSPEC") or "cmd.exe"
    cmdline = ctypes.create_unicode_buffer(f'{comspec} /c "{command}"')
    cwd = kw.get("cwd") or None
    flags = _CREATE_UNICODE_ENVIRONMENT | _CREATE_NO_WINDOW | _CREATE_SUSPENDED | _CREATE_NEW_PROCESS_GROUP

    ok = adv.CreateProcessAsUserW(
        token,
        None,
        cmdline,
        None, None,
        True,  # inherit handles
        flags,
        None,  # environment
        cwd,
        ctypes.byref(si),
        ctypes.byref(pi),
    )
    k32.CloseHandle(stdout_w)
    if nul:
        k32.CloseHandle(nul)
    k32.CloseHandle(token)
    if not ok:
        k32.CloseHandle(stdout_r)
        return None

    if job:
        k32.AssignProcessToJobObject(job, pi.hProcess)
    k32.ResumeThread(pi.hThread)

    import msvcrt
    fd = msvcrt.open_osfhandle(int(stdout_r.value), os.O_RDONLY)
    encoding = kw.get("encoding") or "utf-8"
    errors = kw.get("errors") or "replace"
    stdout_file = open(fd, "r", encoding=encoding, errors=errors, buffering=1)
    return _WinProc(pi.hProcess, pi.hThread, int(pi.dwProcessId), stdout_file, job)


def _windows_popen(command: str, policy: SandboxPolicy, **kw):
    """Prefer restricted-token CreateProcess; always fall back to Job+Popen."""
    api = _win_api()
    if api is None:
        raise SandboxError("Win32 APIs unavailable")

    job, applied = _win_create_job(api, policy)
    if job and applied and getattr(policy, "strict", True):
        # 细粒度策略的实际施加情况留痕——"内存上限设了吗"这类问题要有出处。
        print(f"[sandbox] job limits applied: {applied}")
    write_restricted = policy.mode == READ_ONLY
    token = _win_restricted_token(api, write_restricted=write_restricted)

    if token is not None and kw.get("stdout") == subprocess.PIPE:
        proc = _win_popen_with_token(command, policy, token, job, **kw)
        if proc is not None:
            return proc
        # token consumed / process not started — fall through
        token = None

    if token is not None:
        try:
            api["k32"].CloseHandle(token)
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

    # Reliable path: normal Popen (so streaming/encoding stay identical to
    # today's executors) + immediate AssignProcessToJobObject. There is a
    # millisecond race before the job sticks; PathPolicy already ran.
    kw = dict(kw)
    flags = kw.get("creationflags", 0) | _CREATE_NEW_PROCESS_GROUP | _CREATE_NO_WINDOW
    kw["creationflags"] = flags
    _ps_signatures = (
        "Get-", "Set-", "Select-", "Where-Object", "Format-", "Test-Path",
        "$env:", "$PROFILE", "$HOME", "Invoke-", "Start-Process", "Stop-Process",
        "HKLM:", "HKCU:", "New-Object", "-match ", "-like ", "-eq ", "Remove-Item"
    )
    if any(sig.lower() in command.lower() for sig in _ps_signatures) and not command.strip().lower().startswith("powershell"):
        proc = subprocess.Popen(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], shell=False, **kw)
    else:
        proc = subprocess.Popen(command, shell=True, **kw)
    if job:
        handle = getattr(proc, "_handle", None)
        if handle:
            api["k32"].AssignProcessToJobObject(job, int(handle))
        proc._mb_job = job

        orig_kill = proc.kill

        def _kill_tree() -> None:
            _win_terminate_job(job)
            try:
                orig_kill()
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程

        proc.kill_tree = _kill_tree  # type: ignore[attr-defined]
        proc.release_job = lambda: _win_close_handle(job)  # type: ignore[attr-defined]
    return proc


# ── module CLI (Linux trampoline / diagnostics) ─────────────────────────────


def apply_and_exec() -> None:
    """Child entry: apply Landlock from env, then exec remaining argv.

    Used when a caller cannot use ``preexec_fn`` (e.g. spawning via a
    wrapper). Env: ``OVOLVE_SANDBOX_MODE``, ``OVOLVE_SANDBOX_ROOT``.
    """
    args = sys.argv[1:]
    if args and args[0] == "--apply":
        args = args[1:]
    if args and args[0] == "--":
        args = args[1:]
    if not args:
        sys.stderr.write("sandbox.py --apply -- <command>...\n")
        sys.exit(2)
    mode = os.environ.get("OVOLVE_SANDBOX_MODE") or WORKSPACE_WRITE
    root = os.environ.get("OVOLVE_SANDBOX_ROOT") or ""
    policy = resolve_policy(mode, root, strict=True)
    if platform.system() == "Linux":
        _landlock_apply(policy)
    os.execvp(args[0], args)


if __name__ == "__main__":
    if "--apply" in sys.argv:
        apply_and_exec()
    else:
        status = confinement_status()
        json.dump(status, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
