"""activity_exec.py — 可杀子进程执行边界（durable activity 的进程语义）。

## 为什么存在

Python 线程不能被外部杀死：一个在 worker 线程里跑的同步工具一旦超时，
``asyncio.wait_for`` 只能取消"等待者"，线程本身带着它的网络连接、文件句柄和
子进程继续跑——UI 显示已暂停，命令还在写文件、还在花钱。这是"任意工具都能
强制停止"这个需求的根问题，任何在线程层面加取消按钮的方案都治不了它。

本模块给出的是**分级执行边界**，不是新的杀线程魔法：

* ``loop``        —— 原生协程工具。取消 await 就是真取消（合作式）。
* ``thread``      —— 同步工具留在 worker 线程。合同如实标注
                    ``abandoned_thread``：只能请求停止，不能保证立即终止。
                    其中自己管理可杀子命令的工具（shell 家族）标注
                    ``killable_subprocess``——它们的副作用边界是子进程，而
                    子进程我们能杀。
* ``subprocess``  —— 工具函数在**独立解释器进程**里执行。父进程持有 PID/
                    进程组（POSIX）/Job Object（Windows 由 taskkill /T 兜底），
                    超时或取消就杀整棵进程树。结果走单行 JSON 哨兵协议回来。

没有 Docker、没有容器编排——Linux 用进程组，macOS 同样（可选 sandbox-exec
由既有 sandbox.py 承担），Windows 用 Job Object 语义的 taskkill /T。这是
Temporal 对 Activity 的同一立场：不承诺杀掉任意 Python 函数，承诺的是
"每个可能阻塞的副作用都运行在一个我们可以终止的东西里"。

## 协议

父进程把 ``{"module": ..., "qualname": ..., "args": ..., "context": ...}``
写进临时 spec 文件并 spawn ``python _activity_child.py <spec>``；子进程导入
模块、解析函数、以 ``(args, context)`` 调用，把 ``{"ok":..,"value":..,
"error":..}`` 用 ``@@ACTIVITY_RESULT@@`` 哨兵前缀打到 stdout。工具自身的
print 输出会混进 stdout——父进程取**最后一个**哨兵行。崩溃/被杀时没有哨兵
行，退出码与 stderr 如实上抛。
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import threading
from typing import Any, Callable, Optional

from result import Result

# ── 执行类别与取消合同 ────────────────────────────────────────────────────────

#: 原生协程：留在事件循环，await 取消即真取消。
EXEC_LOOP = "loop"
#: 同步函数：worker 线程执行。不可杀，除非声明了 manages_own_killable_child。
EXEC_THREAD = "thread"
#: 同步函数：独立解释器进程执行，父进程持句柄可杀。
EXEC_SUBPROCESS = "subprocess"

#: 取消 await 即停止（协程工具）。
CANCEL_COOPERATIVE = "cooperative_cancel"
#: 副作用边界是一个父进程持有的子进程；停止 = 杀掉那棵进程树。
CANCEL_KILLABLE = "killable_subprocess"
#: 线程无法被杀：停止只是放弃等待。non-interruptible。
CANCEL_ABANDONED_THREAD = "abandoned_thread"

#: 子进程比外层 wait_for 多给的一点宽限，让内部计时器先杀树、先返回结构化
#: 失败而不是被外层直接 CancelledError 掐断。
KILL_GRACE_SEC = 3.0

_CHILD_SCRIPT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "_activity_child.py")

_RESULT_SENTINEL = "@@ACTIVITY_RESULT@@"


def resolve_callable_ref(fn: Callable) -> Optional[dict]:
    """函数能否在一个全新解释器里按 module+qualname 解析出来。

    闭包、lambda、绑定方法都解析不了：``<locals>`` 与 ``<lambda>`` 一票否决
    （lambda 的 qualname 是 ``<lambda>``，不含 locals 字样，只查一个标记会漏）。
    解析不了的工具永远不该假装可以子进程隔离——降级到 thread 并如实标注合同。
    父侧再做一次真实的 getattr 链验证，宁可误降级也不给子进程留一颗哑弹。
    """
    if fn is None:
        return None
    mod = getattr(fn, "__module__", None)
    qual = getattr(fn, "__qualname__", None)
    if not mod or not qual or "<" in qual:
        return None
    module = sys.modules.get(mod)
    if module is None or not getattr(module, "__file__", None):
        return None
    obj = module
    for part in qual.split("."):
        try:
            obj = getattr(obj, part)
        except AttributeError:
            return None
    if obj is not fn:
        # 同名不同物（被重赋值过）：按旧名字在子进程里解析出来的是另一个函数。
        return None
    return {"module": mod, "qualname": qual}


def json_safe(value: Any, _depth: int = 0) -> Any:
    """递归剥掉上下文里的活对象（loop、agent 实例……）。

    子进程是全新解释器，带不过去的东西留在这里比在序列化时炸掉好——工具在
    子进程里拿到的是 JSON 安全的子集，缺什么它自己会报参数错误，那是诚实的
    失败；TypeError 中途炸掉整个 spec 是不诚实的失败。
    """
    if _depth > 8:
        return str(value)[:200]
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {
            str(k): json_safe(v, _depth + 1)
            for k, v in list(value.items())[:64]
            if isinstance(k, (str, int, float, bool)) or k is None
        }
    if isinstance(value, (list, tuple, set)):
        return [json_safe(v, _depth + 1) for v in list(value)[:256]]
    return repr(value)[:200]


# ── Activity 状态机 ────────────────────────────────────────────────────────

ACTIVITY_CREATED = "created"
ACTIVITY_PREFLIGHTING = "preflighting"
ACTIVITY_WAITING_APPROVAL = "waiting_approval"
ACTIVITY_RUNNING = "running"
ACTIVITY_STOPPING = "stopping"
ACTIVITY_COMPLETED = "completed"
ACTIVITY_FAILED = "failed"
ACTIVITY_CANCELLED = "cancelled"
ACTIVITY_TIMEOUT = "timeout"
ACTIVITY_UNKNOWN_EFFECT = "unknown_effect"
ACTIVITY_STOP_TIMEOUT = "stop_timeout"

ACTIVITY_TERMINAL_STATES = frozenset({
    ACTIVITY_COMPLETED,
    ACTIVITY_FAILED,
    ACTIVITY_CANCELLED,
    ACTIVITY_TIMEOUT,
    ACTIVITY_UNKNOWN_EFFECT,
    ACTIVITY_STOP_TIMEOUT,
})

MAX_OUTPUT_CAP_BYTES = 512 * 1024  # 512 KB per stream cap


def classify_execution(tool) -> dict:
    """一个工具的真实执行类别与取消合同。注册时算一次，别每次派发重推。

    规则遵循总指令 §5.2 / §14：
    1. 原生协程留在事件循环（loop），await 取消即合作式停止；
    2. 自行管理可杀子进程的工具（如 shell 家族）留在 thread，其可停止性由登记在
       call_id 名下的子进程树保证；
    3. 其余只要是同步函数且能解析出 module+qualname 的，默认升级到独立子进程 Activity
       （subprocess），实现超时杀树与强隔离；
    4. 无法解析的闭包/lambda/动态函数若有中高风险或写副作用，必须如实标注为不可中断
       线程，并禁止在无人值守 Goal 中直接写盘。
    """
    explicit = (getattr(tool, "execution_class", "") or "").strip()
    exec_fn = getattr(tool, "execute", None)
    is_async = False
    try:
        is_async = asyncio.iscoroutinefunction(exec_fn)
    except TypeError:
        pass
    ref = None if is_async else resolve_callable_ref(exec_fn)

    if explicit == EXEC_LOOP or is_async:
        return {
            "class": EXEC_LOOP,
            "contract": CANCEL_COOPERATIVE,
            "interruptible": True,
            "ref": None,
            "reason": "explicit loop override" if explicit == EXEC_LOOP else "native coroutine",
        }
    if explicit == EXEC_THREAD:
        return {
            "class": EXEC_THREAD,
            "contract": CANCEL_KILLABLE if getattr(tool, "manages_own_killable_child", False) else CANCEL_ABANDONED_THREAD,
            "interruptible": getattr(tool, "manages_own_killable_child", False),
            "ref": None,
            "reason": "explicit thread execution class",
        }
    if getattr(tool, "manages_own_killable_child", False):
        # shell 家族：execute 本体 spawn 了登记在 call_id 名下的受限子进程。
        return {
            "class": EXEC_THREAD,
            "contract": CANCEL_KILLABLE,
            "interruptible": True,
            "ref": None,
            "reason": "manages own killable child command",
        }

    # 同步工具：只要能解析出独立引用，默认进可杀子进程 Activity
    risk = str(getattr(tool, "risk_level", "low")).lower()
    is_pure_computation = getattr(tool, "pure_computation", False) or (
        risk == "low" and not getattr(tool, "has_side_effects", False)
    )

    if ref is not None and not is_pure_computation:
        return {
            "class": EXEC_SUBPROCESS,
            "contract": CANCEL_KILLABLE,
            "interruptible": True,
            "ref": ref,
            "reason": getattr(tool, "requires_subprocess", False)
                       and "declared requires_subprocess"
                       or "sync tool isolated in durable subprocess activity",
        }
    if ref is None and not is_pure_computation:
        # 想隔离但解析不了（闭包）：降级线程，但合同必须如实说明
        return {
            "class": EXEC_THREAD,
            "contract": CANCEL_ABANDONED_THREAD,
            "interruptible": False,
            "ref": None,
            "reason": "callable not resolvable in a fresh interpreter",
        }
    return {
        "class": EXEC_THREAD,
        "contract": CANCEL_ABANDONED_THREAD,
        "interruptible": False,
        "ref": None,
        "reason": "pure computation or short sync callable on worker thread",
    }


def autonomous_goal_allows(tool, plan: dict) -> "tuple[bool, str]":
    """autonomous Goal 里能不能放行这个同步写工具。

    规则来自总指令的分级边界：移不进子进程、又不自己管理可杀子命令的同步
    工具，就是 non-interruptible——它可以在交互会话里用（用户在场，随时可以
    看到卡住并亲手处理），但不允许在无人值守的 autonomous Goal 里执行写类
    操作。例外走白名单字段 ``autonomous_write_safe``，留给确实验证过可停的
    工具显式认领。
    """
    if plan["interruptible"]:
        return True, ""
    risk = str(getattr(tool, "risk_level", "low"))
    if risk not in ("medium", "high", "critical"):
        return True, ""
    if getattr(tool, "autonomous_write_safe", False):
        return True, ""
    return False, (
        f"工具 `{tool.name}` 是不可中断的线程内写操作（{plan['reason']}），"
        "不允许在自主目标中执行：暂停无法保证它真的停下来。请改用可中断的"
        "等价工具，或把这一步交给用户手动确认。"
    )


def run_sync_in_subprocess(fn_ref: dict, args: dict, context: dict, *,
                           timeout: float, call_id: str = "",
                           cwd: str = None) -> Result:
    """在可杀子进程里执行一个已解析的工具函数。同步、阻塞、可超时杀树。

    返回值契约：
    * 正常结束 —— 子进程回传的 ok/error/value；
    * 超时     —— 杀树后返回失败，meta 带 ``effect_status="unknown"`` 与
                  ``timed_out=True``：进程死了，但它已经做的事没人知道；
    * 外部取消 —— ``cancel_call(call_id)`` 杀掉了孩子；同上返回 unknown。
    """
    spec = {
        "module": fn_ref["module"],
        "qualname": fn_ref["qualname"],
        "args": json_safe(dict(args or {})),
        "context": json_safe(dict(context or {})),
    }
    spec_path = ""
    try:
        with tempfile.NamedTemporaryFile(
                mode="w", suffix=".json", delete=False,
                encoding="utf-8", prefix="activity-spec-") as fh:
            json.dump(spec, fh, ensure_ascii=False, default=str)
            spec_path = fh.name
    except Exception as exc:
        return Result.failure(f"activity spec write failed: {exc}")

    env = dict(os.environ)
    backend_dir = os.path.dirname(_CHILD_SCRIPT)
    env["PYTHONPATH"] = (
        backend_dir + os.pathsep + env.get("PYTHONPATH", "")
    ).rstrip(os.pathsep)
    env.setdefault("PYTHONUNBUFFERED", "1")
    popen_kwargs: dict = {}
    if os.name == "nt":
        # 新进程组：taskkill /T 能顺藤摸瓜；CREATE_NO_WINDOW 避免桌面闪窗。
        popen_kwargs["creationflags"] = (
            subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        )
    else:
        # 新会话：os.killpg 一杀一窝，孙进程无处可逃。
        popen_kwargs["start_new_session"] = True

    valid_cwd = None
    if cwd and isinstance(cwd, str):
        clean_cwd = cwd.strip(' "\'')
        if clean_cwd and os.path.isdir(clean_cwd):
            valid_cwd = clean_cwd
        elif clean_cwd and os.path.isfile(clean_cwd):
            valid_cwd = os.path.dirname(clean_cwd)
    if not valid_cwd or not os.path.isdir(valid_cwd):
        try:
            cur = os.getcwd()
            if cur and os.path.isdir(cur):
                valid_cwd = cur
        except Exception:
            valid_cwd = None
    if not valid_cwd or not os.path.isdir(valid_cwd):
        valid_cwd = os.path.dirname(os.path.abspath(_CHILD_SCRIPT))

    try:
        proc = subprocess.Popen(
            [sys.executable, _CHILD_SCRIPT, spec_path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace",
            cwd=valid_cwd, env=env, **popen_kwargs,
        )
    except Exception as exc:
        _cleanup_spec(spec_path)
        return Result.failure(f"activity spawn failed: {exc}")

    if call_id:
        try:
            from executors import track_child_process
            track_child_process(call_id, proc)
        except Exception:
            pass  # 登记失败只影响可杀性，不影响执行本身

    budget = max(1.0, float(timeout or 60))
    timed_out = threading.Event()

    def _on_deadline() -> None:
        timed_out.set()
        try:
            from executors import kill_child_process
            kill_child_process(proc)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass  # 进程可能刚好自己退出了

    killer = threading.Timer(budget, _on_deadline)
    killer.daemon = True
    killer.start()

    stdout_data, stderr_data = "", ""
    try:
        stdout_data, stderr_data = proc.communicate()
        if len(stdout_data) > MAX_OUTPUT_CAP_BYTES:
            stdout_data = stdout_data[:MAX_OUTPUT_CAP_BYTES] + "\n...[stdout truncated at output cap]..."
        if len(stderr_data) > MAX_OUTPUT_CAP_BYTES:
            stderr_data = stderr_data[:MAX_OUTPUT_CAP_BYTES] + "\n...[stderr truncated at output cap]..."
    except Exception as exc:
        try:
            from executors import kill_child_process
            kill_child_process(proc)
        except Exception:
            pass
        return Result.failure(f"activity communicate failed: {exc}",
                              effect_status="unknown",
                              call_id=call_id)
    finally:
        killer.cancel()
        if call_id:
            try:
                from executors import untrack_child_process
                # Pass the handle: one call can spawn several children in
                # sequence, and dropping the whole call's entry would unregister
                # a sibling that is still running.
                untrack_child_process(call_id, proc)
            except Exception:
                pass
        _cleanup_spec(spec_path)

    payload = _parse_result_line(stdout_data)
    if payload is not None:
        meta = {"call_id": call_id} if call_id else {}
        if payload.get("ok"):
            return Result.success(payload.get("value"), **meta)
        return Result.failure(str(payload.get("error") or "activity failed"),
                              **meta)

    if timed_out.is_set():
        return Result.failure(
            f"工具在子进程中超过 {int(budget)} 秒未完成，进程树已被终止。"
            "它可能已经完成了部分工作——继续之前请先核对实际状态。",
            effect_status="unknown", timed_out=True,
            call_id=call_id,
        )

    rc = proc.returncode
    stderr_tail = (stderr_data or "").strip()[-600:]
    if rc == 0:
        # 进程活着退出了却没有回传结果：不是被杀，但结果同样未知。
        return Result.failure(
            "子进程退出但没有回传结果（可能是 import 失败前的缓冲丢失）。"
            f"stderr 尾部：{stderr_tail or '（空）'}",
            effect_status="unknown", exit_code=rc, call_id=call_id,
        )
    return Result.failure(
        f"工具子进程异常退出（exit={rc}）。stderr 尾部：{stderr_tail or '（空）'}",
        effect_status="unknown", exit_code=rc, call_id=call_id,
    )


def _parse_result_line(stdout_text: str) -> Optional[dict]:
    """stdout 里最后一个哨兵行就是结果；工具自己的 print 全部忽略。"""
    if not stdout_text:
        return None
    for raw_line in reversed(stdout_text.splitlines()):
        idx = raw_line.find(_RESULT_SENTINEL)
        if idx < 0:
            continue
        blob = raw_line[idx + len(_RESULT_SENTINEL):].strip()
        try:
            data = json.loads(blob)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(data, dict):
            return data
    return None


def _cleanup_spec(spec_path: str) -> None:
    if not spec_path:
        return
    try:
        os.unlink(spec_path)
    except OSError:
        pass  # 临时目录最终会被系统清掉；删不掉不值得打扰任何人
