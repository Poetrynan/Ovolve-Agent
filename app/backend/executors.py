"""executors.py - Dual-layer sandbox executor (Isolated Execution Architecture).

Default: Pyodide WASM sandbox (physically isolated, data stays on machine).
Native: whitelisted commands + AST review + risk confirmation + resource limits.
"""
from __future__ import annotations
import contextvars
import os, ast, subprocess, sys, tempfile, threading, time
from typing import Any, Callable, Optional
from result import Result

# ── 流式输出与可取消进程的登记处 ─────────────────────────────────────────────
#
# 一条命令跑 30 秒，用户在这 30 秒里应该看到输出在滚，而不是盯着转圈。
# 但工具实现是同步函数、跑在 worker 线程里（见 tools.dispatch 的说明），拿不到
# 事件总线所在的事件循环。所以这里放两张按 call_id 索引的表：
#
#   _sinks —— 谁想听这条命令的输出。由 router 在 dispatch 前登记（它持有 loop，
#             能把跨线程回调安全地转成一次 bus.emit），命令结束后注销。
#   _procs —— 正在跑的进程句柄。让「取消这一条」成为可能：以前 interrupt 是
#             回合级的，点一下停整个回合，想单独掐掉一条卡死的命令做不到。
#
# 用 call_id 而不是工具名做键：同一个回合里可以有多条 shell 并行，名字会撞。
#
# 值是**列表**而不是单个句柄：一次工具调用可能连着 spawn 好几个子进程
# （git 工具先 status 再 diff、app 工具先查再关）。用单槽位保存等于后一个
# 覆盖前一个，于是"取消"只杀得掉最后那个，前面几个变成没人管的孤儿。
_OutputSink = Callable[[str], None]
_sinks: dict[str, _OutputSink] = {}
_procs: dict[str, list[subprocess.Popen]] = {}
_stream_lock = threading.Lock()

#: 当前正在执行的 tool call。由 ``tools.dispatch`` 在派发前后设置/复位
#: （见 ``call_scope``）。存在的理由：可杀性不能要求每一个内部 spawn 点都
#: 把 call_id 一路透传下去——``guarded_spawn``、``native_run``、git 只读命令
#: 原本都没有这个参数，于是它们 spawn 出来的子进程谁都杀不到。ContextVar 会
#: 被 ``asyncio.to_thread`` 一并复制进工作线程，所以同步工具里的嵌套 spawn
#: 也能自动认领到正确的 call_id。
_current_call: contextvars.ContextVar[str] = contextvars.ContextVar(
    "executors_current_call", default="")


def current_call_id() -> str:
    """The tool call this code is running inside, or "" outside any call."""
    return _current_call.get() or ""


class call_scope:
    """Mark a block as belonging to one tool call, for child-process tracking.

    Used as a context manager around a dispatch so every subprocess spawned
    underneath — however deep, whether or not it was given a ``call_id`` — can
    be found and killed by ``cancel_call``.
    """

    def __init__(self, call_id: str) -> None:
        self._call_id = str(call_id or "")
        self._token = None

    def __enter__(self) -> str:
        self._token = _current_call.set(self._call_id)
        return self._call_id

    def __exit__(self, *exc) -> bool:
        if self._token is not None:
            _current_call.reset(self._token)
        return False


def bind_call_id(call_id: str):
    """Imperative form of :class:`call_scope`, for a try/finally at a call site
    whose body is too large to re-indent under a ``with``. Returns the token to
    hand back to :func:`unbind_call_id`."""
    return _current_call.set(str(call_id or ""))


def unbind_call_id(token) -> None:
    """Restore the previous ambient call id. Safe with a None token."""
    if token is None:
        return
    try:
        _current_call.reset(token)
    except ValueError:
        # Token from a different context (thread hand-off): the value dies with
        # that context anyway, so there is nothing to restore.
        pass



def register_output_sink(call_id: str, sink: _OutputSink) -> None:
    """登记一条命令的输出去处。没登记就是没人听，命令照跑，只是不推流。"""
    if not call_id:
        return
    with _stream_lock:
        _sinks[call_id] = sink


def unregister_output_sink(call_id: str) -> None:
    """命令结束后清掉。漏清会让这两张表随会话无界增长。"""
    if not call_id:
        return
    with _stream_lock:
        _sinks.pop(call_id, None)
        _procs.pop(call_id, None)



def _emit_line(call_id: str, text: str) -> None:
    """把一行输出交给 sink。sink 抛错绝不能带崩命令本身。"""
    if not call_id or not text:
        return
    with _stream_lock:
        sink = _sinks.get(call_id)
    if sink is None:
        return
    try:
        sink(text)
    except Exception:
        pass  # fail-open: 可选增强，失败不影响主流程

# Whitelisted modules for native execution
NATIVE_ALLOWLIST_MODULES = {
    "math", "cmath", "decimal", "fractions", "random", "statistics",
    "itertools", "functools", "collections", "heapq", "bisect",
    "re", "json", "string", "copy", "textwrap", "datetime", "time",
    "dataclasses", "typing", "numbers", "operator", "enum",
    "numpy", "scipy", "sympy", "pandas", "mpmath",
    "os.path", "hashlib", "base64", "csv", "io", "uuid",
}

# Dangerous AST patterns to block
DANGEROUS_CALLS = {
    "os.system", "os.popen", "os.exec", "os.execv", "os.execvp",
    "subprocess.call", "subprocess.run", "subprocess.Popen",
    "eval", "exec", "compile", "__import__",
    "open",  # File I/O - only allowed through tool layer
}

DANGEROUS_ATTRS = {"system", "popen", "exec", "execv", "fork", "kill"}


class ASTReviewer:
    """Pre-execution AST review: intercept dangerous paths/calls."""

    def review(self, code: str) -> Result:
        try:
            tree = ast.parse(code)
        except SyntaxError as e:
            return Result.failure(f"Syntax error: {e}")

        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                name = self._get_call_name(node)
                if name in DANGEROUS_CALLS:
                    return Result.failure(f"Blocked dangerous call: {name}")
            if isinstance(node, ast.Attribute):
                if node.attr in DANGEROUS_ATTRS:
                    return Result.failure(f"Blocked dangerous attribute: {node.attr}")
            # Check for path traversal patterns
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if ".." in node.value and ("/" in node.value or "\\" in node.value):
                    return Result.failure(f"Blocked path traversal: {node.value}")

        return Result.success("AST review passed")

    def _get_call_name(self, node: ast.Call) -> str:
        func = node.func
        if isinstance(func, ast.Name):
            return func.id
        if isinstance(func, ast.Attribute):
            if isinstance(func.value, ast.Name):
                return f"{func.value.id}.{func.attr}"
            return func.attr
        return ""


def pyodide_run(code: str, timeout: int = 30) -> Result:
    """Run code in Pyodide WASM sandbox (physically isolated).

    Falls back to restricted exec if Pyodide is not available.
    """
    try:
        from pyodide.ffi import run_python_async
        # Real Pyodide environment
        result = run_python_async(code)
        return Result.success(result)
    except ImportError:
        pass  # fail-open: 可选增强，失败不影响主流程

    # Fallback: restricted execution environment
    return _restricted_exec(code, timeout)


def _restricted_exec(code: str, timeout: int = 30) -> Result:
    """Restricted execution as sandbox fallback with safe module import."""
    review = ASTReviewer().review(code)
    if not review.ok:
        return review

    _ALLOWED_SANDBOX_MODULES = {
        "math", "cmath", "decimal", "fractions", "random", "statistics",
        "itertools", "functools", "collections", "heapq", "bisect",
        "re", "json", "string", "copy", "textwrap", "datetime", "time",
        "dataclasses", "typing", "numbers", "operator", "enum",
        "numpy", "scipy", "sympy", "pandas", "mpmath",
    }

    def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
        root = name.split(".")[0]
        if root not in _ALLOWED_SANDBOX_MODULES:
            raise ImportError(f"Import of module '{name}' is restricted in sandbox")
        return __import__(name, globals, locals, fromlist, level)

    safe_builtins = {
        "__import__": _safe_import,
        "print": print, "len": len, "range": range, "str": str, "int": int,
        "float": float, "bool": bool, "list": list, "dict": dict, "tuple": tuple,
        "set": set, "sorted": sorted, "enumerate": enumerate, "zip": zip,
        "map": map, "filter": filter, "sum": sum, "min": min, "max": max,
        "abs": abs, "round": round, "isinstance": isinstance, "issubclass": issubclass,
        "type": type, "any": any, "all": all, "chr": chr, "ord": ord, "hex": hex,
        "oct": oct, "bin": bin, "pow": pow, "divmod": divmod, "repr": repr,
        "iter": iter, "next": next, "reversed": reversed, "slice": slice,
        "hasattr": hasattr, "getattr": getattr, "setattr": setattr,
        "Exception": Exception, "ValueError": ValueError, "TypeError": TypeError,
        "KeyError": KeyError, "IndexError": IndexError, "AttributeError": AttributeError,
        "ZeroDivisionError": ZeroDivisionError, "OverflowError": OverflowError,
        "AssertionError": AssertionError, "RuntimeError": RuntimeError,
        "StopIteration": StopIteration,
        "True": True, "False": False, "None": None,
    }

    safe_globals = {
        "__builtins__": safe_builtins,
        "json": __import__("json"),
        "re": __import__("re"),
        "math": __import__("math"),
        "cmath": __import__("cmath"),
        "datetime": __import__("datetime"),
        "collections": __import__("collections"),
        "itertools": __import__("itertools"),
        "functools": __import__("functools"),
        "random": __import__("random"),
    }

    import io as _io
    import contextlib
    buf = _io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            exec(compile(code, "<sandbox>", "exec"), safe_globals)
        output = buf.getvalue()
        return Result.success(output)
    except Exception as e:
        return Result.failure(f"Sandbox execution error: {e}")


def native_run(code: str, timeout: int = 60, confirm: bool = False) -> Result:
    """Native Python channel: AST review + whitelist + risk confirm + resource limits."""
    review = ASTReviewer().review(code)
    if not review.ok:
        return review

    if not _check_allowlist(code):
        return Result.failure("Code uses non-whitelisted modules")

    if not confirm:
        return Result.failure("Native execution requires confirmation (high risk)")

    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write(code)
            script_path = f.name
        proc = tracked_run(
            [sys.executable, script_path],
            capture_output=True, text=True, timeout=timeout,
            env={**os.environ, "PYTHONUNBUFFERED": "1"}
        )
        os.unlink(script_path)
        if proc.returncode == 0:
            return Result.success(proc.stdout)
        return Result.failure(f"Process exited {proc.returncode}: {proc.stderr}")
    except subprocess.TimeoutExpired:
        return Result.failure(f"Execution timed out after {timeout}s")
    except Exception as e:
        return Result.failure(f"Native execution error: {e}")


def _check_allowlist(code: str) -> bool:
    """Check if code only uses whitelisted modules."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return False
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name not in NATIVE_ALLOWLIST_MODULES and not alias.name.startswith("__"):
                    return False
        if isinstance(node, ast.ImportFrom):
            if node.module and node.module not in NATIVE_ALLOWLIST_MODULES:
                return False
    return True


def run_python(code: str, mode: str = "sandbox", timeout: int = 30, confirm: bool = False) -> Result:
    """Unified entry point for code execution.

    mode: "sandbox" (Pyodide WASM, default) or "native" (whitelisted + AST + confirm)
    """
    if mode == "sandbox":
        return pyodide_run(code, timeout)
    elif mode == "native":
        return native_run(code, timeout, confirm)
    else:
        return Result.failure(f"Unknown execution mode: {mode}")


class BlockedCommandError(Exception):
    """Raised instead of spawning when a command trips a deny-level rule."""


#: Shell metacharacters that turn one command into two. Tool arguments are
#: model-authored text, so any of these inside an app name / search term means
#: the string is no longer a name — it is a second command riding along.
#: Backslash and colon are deliberately allowed: ``C:\Program Files\x.exe`` is a
#: legitimate app name on Windows, and neither character starts a new command in
#: cmd.exe or PowerShell.
_SHELL_METACHARS = ';|&`$><\n\r"\''


def shell_word(value: str, *, label: str = "参数") -> str:
    """Validate a model-supplied token before it is pasted into a shell string.

    Rejects rather than escapes. An app name containing ``;`` or a backtick is
    not a name that failed to quote — it is an injection attempt, and quoting it
    into obedience would hide that. Every caller here builds commands like
    ``taskkill /im "{name}.exe"``, where one unbalanced quote is enough to append
    an arbitrary command, so the check has to happen before interpolation.

    Raises:
        BlockedCommandError: when the value cannot be safely interpolated.
    """
    text = str(value or "")
    if not text.strip():
        raise BlockedCommandError(f"{label}不能为空")
    bad = sorted({c for c in text if c in _SHELL_METACHARS})
    if bad:
        raise BlockedCommandError(
            f"{label}里含有 shell 特殊字符 {''.join(bad)!r}，已拒绝执行。"
            "应用名/搜索词不该带这些字符。"
        )
    if len(text) > 200:
        raise BlockedCommandError(f"{label}过长（{len(text)} 字符），已拒绝执行")
    return text


def _deny_gate(command: str) -> None:
    """Deny-level rule check. Raises rather than returning so no caller can
    accidentally ignore the verdict by dropping a return value."""
    from danger_classifier import classify_command

    verdict = classify_command(command or "", "shell")
    if verdict.blocked:
        raise BlockedCommandError(
            f"已拦下高危命令（{verdict.what or verdict.pattern}）。这一步不会执行。"
        )


def _kill_tree(proc: subprocess.Popen) -> None:
    """Kill the process AND its children.

    ``shell=True`` means the direct child is cmd.exe / sh, and the command the
    user actually cares about is a grandchild. ``proc.kill()`` reaps only the
    shell and leaves the real work running as an orphan — which looked like
    "cancel did nothing".

    Confined processes (Job Objects / sandbox-exec) expose ``kill_tree`` so
    the kernel-side tree dies with the parent, not just the shell fronting it.
    """
    if proc.poll() is not None:
        return
    try:
        from sandbox import terminate_confined
        terminate_confined(proc)
        if proc.poll() is not None:
            return
    except Exception:
        pass  # fail-open: 可选增强，失败不影响主流程
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                           capture_output=True, timeout=5)
        else:
            import signal
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程


def cancel_call(call_id: str) -> bool:
    """Stop every in-flight child of one tool call.

    True when at least one live process was actually killed. Iterates a copy of
    the list: ``_kill_tree`` can take seconds (taskkill/SIGKILL round trip) and
    holding the registry lock across that would block the tool thread trying to
    untrack a child that just exited on its own.
    """
    with _stream_lock:
        procs = list(_procs.get(call_id) or ())
    killed = False
    for proc in procs:
        try:
            if proc.poll() is not None:
                continue
            _kill_tree(proc)
            killed = True
        except Exception as exc:  # noqa: BLE001
            print(f"[executors] kill failed for {call_id}: {exc}")
    return killed


def track_child_process(call_id: str, proc) -> None:
    """Register an externally-spawned child under ``call_id`` so the standard
    cancel path (Router.cancel_hard → cancel_call) can kill it too.

    This is what gives subprocess-isolated tools (activity_exec) the same
    stop story as shell commands: one registry, one kill-tree, one place.

    ``call_id`` falls back to the ambient :func:`current_call_id` so an internal
    spawn point that never had a ``call_id`` parameter still lands in the
    registry instead of becoming unkillable.
    """
    cid = str(call_id or "") or current_call_id()
    if not cid or proc is None:
        return
    with _stream_lock:
        _procs.setdefault(cid, []).append(proc)


def untrack_child_process(call_id: str, proc=None) -> None:
    """Drop the registration for one child, or for all children of the call.

    Passing the handle is the correct form: a call that spawns several children
    in sequence must not have the second spawn's bookkeeping wipe the first
    one's still-running entry.
    """
    cid = str(call_id or "") or current_call_id()
    if not cid:
        return
    with _stream_lock:
        if proc is None:
            _procs.pop(cid, None)
            return
        rest = [p for p in (_procs.get(cid) or ()) if p is not proc]
        if rest:
            _procs[cid] = rest
        else:
            _procs.pop(cid, None)


def kill_child_process(proc) -> None:
    """Kill a tracked child and its tree. Public wrapper over _kill_tree."""
    _kill_tree(proc)


def tracked_run(command, *, timeout: int = 30, cwd: str = None,
                capture_output: bool = True, text: bool = True,
                shell: bool = False, env: dict = None,
                encoding: str = None, errors: str = None,
                call_id: str = "") -> subprocess.CompletedProcess:
    """``subprocess.run`` that the stop button can reach.

    ``subprocess.run`` hides its child handle, so anything spawned through it
    was invisible to ``cancel_call``: Stop/Pause killed the tools that happened
    to go through ``run_shell`` and silently left the rest running. Same
    signature and same ``TimeoutExpired`` contract as ``subprocess.run``, so
    call sites only change the function name.

    On timeout the tree is killed before the exception propagates — the whole
    point, since ``subprocess.run``'s own timeout kills only the direct child
    and a ``shell=True`` command's real work is a grandchild.
    """
    cid = str(call_id or "") or current_call_id()
    valid_cwd = None
    if cwd and isinstance(cwd, str):
        clean = cwd.strip(' "\'')
        if clean and os.path.isdir(clean):
            valid_cwd = clean
        elif clean and os.path.isfile(clean):
            valid_cwd = os.path.dirname(clean)
    popen_kwargs: dict = {"cwd": valid_cwd, "shell": shell}
    if capture_output:
        popen_kwargs["stdout"] = subprocess.PIPE
        popen_kwargs["stderr"] = subprocess.PIPE
    if text:
        popen_kwargs["text"] = True
    if encoding is not None:
        popen_kwargs["encoding"] = encoding
    if errors is not None:
        popen_kwargs["errors"] = errors
    if env is not None:
        popen_kwargs["env"] = env
    proc = subprocess.Popen(command, **popen_kwargs)
    track_child_process(cid, proc)
    try:
        out, err = proc.communicate(timeout=timeout if timeout else None)
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        try:
            out, err = proc.communicate(timeout=5)
        except Exception:  # noqa: BLE001
            out, err = "", ""
        raise subprocess.TimeoutExpired(command, timeout, output=out, stderr=err)
    finally:
        untrack_child_process(cid, proc)
    return subprocess.CompletedProcess(command, proc.returncode, out, err)


def guarded_spawn(command: str, *, timeout: int = 30, cwd: str = None,
                  capture_output: bool = True, text: bool = True):
    """The only sanctioned way to run an internally-composed shell command.

    Every tool that builds its own command string (app launch/close, process
    list/kill, app search) used to call ``subprocess.run(shell=True)`` directly.
    Those call sites were invisible to the policy stack: ``classify_tool_call``
    keys off the tool name, and none of those tools is in its interpreter table,
    so the composed command was never inspected at all. This routes them through
    the same rule tables the shell tool uses, as a last-line deny backstop.

    Only ``deny`` blocks here. A ``confirm`` verdict is already handled upstream
    by the tool's registered risk level (app_install is high, app_close is
    medium), and asking twice for the same click is worse than asking once.

    Goes through :func:`tracked_run`, so these children are killable too — they
    were the largest remaining hole in "Stop actually stops".

    Raises:
        BlockedCommandError: the command matched a deny-level rule.
    """
    _deny_gate(command)
    return tracked_run(
        command, shell=True, capture_output=capture_output, text=text,
        timeout=timeout, cwd=cwd,
    )



#: 单条命令累积输出的上限。超过后停止累积（推流不受影响），末尾补一行说明。
#: 模型的上下文本来也吃不下 200KB 日志，工具层的 truncate 还会再压一次。
_OUTPUT_CAP = 200_000


def run_shell(command: str, timeout: int = 30, cwd: str = None,
              confirm: bool = False, call_id: str = "",
              line_filter: Optional[Callable[[str], str]] = None,
              workspace_root: str = None,
              sandbox_mode: str = None) -> Result:
    """Run a shell command, streaming output line by line as it arrives.

    Every command goes through three gates, in this order:

    1. Path policy (``sandbox-policy.yaml``) — auditable, user-editable.
    2. Danger classifier — deny-level patterns (``format c:`` vs ``git log``).
    3. OS-native confinement (``sandbox.popen_confined``) — kernel last word.

    Confirmation is required but is not a sandbox bypass: a confirmed command
    still runs inside the workspace-write jail unless ``sandbox_mode`` is
    explicitly ``danger-full-access``.
    """
    ws = workspace_root or cwd or os.getcwd()
    mode = (sandbox_mode or "workspace-write").strip().lower()
    # Ambient call id when the caller did not pass one: the streaming sink and
    # the kill registry are both keyed by it, and a shell started from a nested
    # helper is no less worth stopping than one started from the tool itself.
    call_id = str(call_id or "") or current_call_id()


    # Path policy before the confirm check so a forbidden path never pops a
    # "are you sure?" dialog the user cannot usefully say yes to.
    try:
        from path_policy import PathPolicyError, assert_command_allowed
        if mode != "danger-full-access":
            assert_command_allowed(command, cwd=cwd or ws, workspace_root=ws, mode=mode)
        else:
            # Even the explicit bypass keeps the hard floor (OS dirs, secrets).
            assert_command_allowed(
                command, cwd=cwd or ws, workspace_root=ws, mode="danger-full-access",
            )
    except PathPolicyError as e:
        return Result.failure(str(e))

    if not confirm:
        return Result.failure("Shell execution requires confirmation (high risk)")
    try:
        # Rule matching lives in danger_classifier, which knows the difference
        # between `format c:` and `git log --format=%h`. The substring list this
        # replaced blocked the second one too.
        _deny_gate(command)
    except BlockedCommandError as e:
        return Result.failure(str(e))

    budget = max(1, int(timeout or 30))
    try:
        from sandbox import SandboxError, popen_confined, resolve_policy
        sp = resolve_policy(mode, ws, strict=False)
        proc = popen_confined(
            command, sp,
            cwd=cwd,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=False, bufsize=0,
        )
    except SandboxError as e:
        return Result.failure(str(e))
    except Exception as e:
        return Result.failure(f"Shell error: {e}")
    if call_id:
        track_child_process(call_id, proc)

    # Deadline as a timer rather than a check inside the read loop: a command
    # that hangs while producing NO output would never reach the check, and
    # those are exactly the ones worth killing.
    expired = threading.Event()

    def _on_deadline() -> None:
        expired.set()
        _kill_tree(proc)

    killer = threading.Timer(budget, _on_deadline)
    killer.daemon = True
    killer.start()

    def _decode_stream_line(raw: bytes | str) -> str:
        if isinstance(raw, str):
            return raw
        if not raw:
            return ""
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            try:
                return raw.decode("gb18030", errors="replace")
            except Exception:
                return raw.decode("utf-8", errors="replace")

    chunks: list[str] = []
    total = 0
    capped = False
    try:
        if proc.stdout is not None:
            for raw_line in proc.stdout:
                line = _decode_stream_line(raw_line)
                # Redact per line, before it is streamed OR buffered — a leaked
                # MAC/path must not reach the UI even for the split second before
                # the final result is scrubbed.
                if line_filter is not None:
                    try:
                        line = line_filter(line)
                    except Exception:
                        pass  # fail-open: 可选增强，失败不影响主流程
                _emit_line(call_id, line)
                if total < _OUTPUT_CAP:
                    chunks.append(line)
                    total += len(line)
                elif not capped:
                    capped = True
        proc.wait()
    except Exception as e:
        _kill_tree(proc)
        return Result.failure(f"Shell error: {e}", exit_code=proc.returncode)
    finally:
        killer.cancel()
        if call_id:
            untrack_child_process(call_id, proc)
        try:
            from sandbox import release_confinement
            release_confinement(proc)
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

    out = "".join(chunks)
    if capped:
        out += f"\n[输出超过 {_OUTPUT_CAP} 字符，后续已省略]"
    code = proc.returncode

    if expired.is_set():
        # Partial output is the whole point of reporting a timeout this way.
        return Result.failure(
            f"命令超时（{budget}s）已被终止。以下是超时前的输出：\n{out}".rstrip(),
            exit_code=code, timed_out=True,
        )
    if code == 0:
        return Result.success(out, exit_code=0)

    # Smart command failure auto-diagnosis to enable 1-step LLM self-correction
    diagnosis = ""
    low_out = out.lower()
    if "is not recognized as an internal or external command" in low_out or "command not found" in low_out:
        cmd_head = (command.strip().split() or [""])[0]
        diagnosis = f"\n💡 Auto-Diagnosis: Command `{cmd_head}` is not found in PATH. Try invoking via `python -m {cmd_head}` or checking executable path."
    elif "modulenotfounderror: no module named" in low_out:
        diagnosis = "\n💡 Auto-Diagnosis: Missing Python dependency. You can install it via pip or verify the python environment."
    elif "permission denied" in low_out or "access is denied" in low_out:
        diagnosis = "\n💡 Auto-Diagnosis: File or port access denied. The resource may be locked by another running process."

    error_msg = f"Shell exited with code {code}:\n{out}{diagnosis}".rstrip()
    return Result.failure(error_msg, exit_code=code)
