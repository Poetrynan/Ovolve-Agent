"""
pyodide_sandbox.py — §7.4 低风险代码沙箱（探针 + AST review fallback）。

修订版 §7.4：Python 代码沙箱优先 Pyodide/WASM（可用时）；不可用时降级为
"AST review + 受限 exec"。本模块是那条降级路径的完整实现，外加对 Pyodide
的可用性探针——v0.1 不捆绑 Pyodide（几十 MB 的 wasm 资产），探针只如实
报告"当前环境装没装"，绝不假装 WASM 隔离存在。

受限执行的三道闸（按序）：
  1. AST review —— 静态拒绝：危险模块导入、下划线属性逃逸（__class__/
     __globals__/__subclasses__ 这条经典逃逸链）、eval/exec 家族。过不了
     审查的代码根本不执行。
  2. 受限 globals —— __builtins__ 换成白名单子集；Python 在 globals 缺
     __builtins__ 键时会自动补全量内建，所以"删掉"不等于"禁用"，必须显式
     放一个受限字典进去。
  3. 进程超时 —— 受限 exec 仍可能死循环；执行放在独立子进程里，超时直接
     terminate（线程做不到这一点——CPython 杀不掉线程，只能留下一个烧 CPU
     的僵尸）。multiprocessing 不可用时降级为线程路径并如实标注能力边界。

诚实边界：这是"低风险代码"的沙箱，不是对抗性隔离。真正的进程隔离在
sandbox.popen_confined；两者按风险等级选用（见 execution_provider）。
"""
from __future__ import annotations

import ast
import io
import json
import os
import queue
import threading
import time
from contextlib import redirect_stdout
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

#: 静态审查直接拒绝的顶层模块——文件系统/进程/网络/解释器本身的入口。
FORBIDDEN_MODULES = frozenset({
    "os", "sys", "subprocess", "socket", "shutil", "ctypes", "signal",
    "importlib", "pathlib", "io", "pickle", "dill", "multiprocessing",
    "threading", "asyncio", "tempfile", "glob", "builtins", "code",
    "codeop", "compileall", "runpy", "webbrowser", "http", "urllib",
    "requests", "ftplib", "smtplib", "telnetlib", "ssl",
})

#: 受限内建白名单：纯计算够用，一个能触达解释器/文件系统的名字都不给。
_ALLOWED_BUILTINS = (
    "abs", "all", "any", "bool", "bytes", "chr", "dict", "divmod",
    "enumerate", "filter", "float", "format", "frozenset", "hash", "int",
    "isinstance", "issubclass", "iter", "len", "list", "map", "max", "min",
    "next", "object", "oct", "ord", "pow", "range", "repr", "reversed",
    "round", "set", "slice", "sorted", "str", "sum", "tuple", "zip",
    "print",   # stdout 被沙箱捕获，print 是纯输出不是能力
)

#: 调用即拒绝的名称——即使绕过 import 直接裸名调用也不行。
#: getattr/setattr 一并禁止：它们是绕过属性审查的万能钥匙。
_FORBIDDEN_CALLS = frozenset({
    "eval", "exec", "compile", "open", "input", "breakpoint", "__import__",
    "globals", "locals", "vars", "getattr", "setattr", "delattr",
    "super", "memoryview", "help", "exit", "quit",
})

#: 结果里 stdout 的上限——一段失控的 print 不该撑爆事件账本。
_MAX_OUTPUT_CHARS = 64_000


@dataclass
class SandboxResult:
    """一次受限执行的完整交代：审查意见、输出、结果、错误——分开摆。"""
    ok: bool
    value: Any = None
    stdout: str = ""
    error: str = ""
    engine: str = "restricted-ast"
    review_problems: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        d = {"ok": self.ok, "engine": self.engine,
             "stdout": self.stdout[:_MAX_OUTPUT_CHARS],
             "error": self.error, "review_problems": self.review_problems}
        try:
            json.dumps(self.value)
            d["value"] = self.value
        except (TypeError, ValueError):
            d["value"] = repr(self.value)
        return d


def ui_app_root() -> str:
    """Electron 工程根（app/ui）——从本文件位置推导，不依赖 CWD。"""
    return os.path.abspath(os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "ui"))


def pyodide_available(app_root: str = None) -> bool:
    """探针：Pyodide 是否已随应用安装（<ui>/node_modules/pyodide）。

    只检查本地存在性，不做网络加载——按需拉几十 MB wasm 资产不是沙箱
    该自作主张的事。未安装返回 False，调用方走 AST fallback。
    """
    return os.path.isdir(os.path.join(app_root or ui_app_root(),
                                      "node_modules", "pyodide"))


def review_code(source: str) -> List[str]:
    """AST 静态审查。返回问题列表——空列表表示放行。

    拒绝的是"能力"，不是"风格"：任何能触达文件系统、进程网络、解释器
    内部或绕过受限命名空间的结构都算能力。
    """
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return [f"语法错误: {e.msg} (line {e.lineno})"]

    problems: List[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] in FORBIDDEN_MODULES:
                    problems.append(
                        f"禁止导入模块: {alias.name} (line {node.lineno})")
        elif isinstance(node, ast.ImportFrom):
            if node.level and node.level > 0:
                problems.append(f"禁止相对导入 (line {node.lineno})")
            elif (node.module or "").split(".")[0] in FORBIDDEN_MODULES:
                problems.append(f"禁止导入模块: {node.module} (line {node.lineno})")
        elif isinstance(node, ast.Call):
            name = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
            if name in _FORBIDDEN_CALLS:
                problems.append(f"禁止调用: {name}() (line {node.lineno})")
        elif isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            # 一个下划线就拦：__class__/__base__/__subclasses__/__globals__
            # 是同一条逃逸链，"只拦双下划线"是给逃逸留门缝。
            problems.append(
                f"禁止下划线属性访问: .{node.attr} (line {node.lineno})")
    return problems


def _restricted_globals() -> Dict[str, Any]:
    import builtins
    table = vars(builtins)
    safe = {n: table[n] for n in _ALLOWED_BUILTINS if n in table}
    return {"__builtins__": safe}


def _prepare_tree(source: str) -> ast.Module:
    """末尾独立表达式改写成 ``__result__ = (...)``，让 ``2 + 2`` 或
    ``fib(20)`` 这样的片段能把值带回来——低风险计算最常见的形态。"""
    tree = ast.parse(source)
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        tree.body[-1] = ast.Assign(
            targets=[ast.Name(id="__result__", ctx=ast.Store())],
            value=tree.body[-1].value)
        ast.fix_missing_locations(tree)
    return tree


def _child_execute(source: str, queue) -> None:
    """子进程入口：review → 受限 exec → 结果入队。必须可被 spawn 反序列化，
    所以只收源码字符串、在子进程内重新编译。"""
    try:
        problems = review_code(source)
        if problems:
            queue.put({"ok": False, "error": "AST review 未通过",
                       "review_problems": problems, "stdout": ""})
            return
        buf = io.StringIO()
        glb = _restricted_globals()
        box: Dict[str, Any] = {}
        code = compile(_prepare_tree(source), "<sandbox>", "exec")
        with redirect_stdout(buf):
            exec(code, glb, box)  # noqa: S102 — 受限命名空间内的执行
        queue.put({"ok": True, "value": box.get("__result__"),
                   "stdout": buf.getvalue(), "error": "",
                   "review_problems": []})
    except BaseException as e:  # noqa: BLE001 — 沙箱把一切异常变成结果
        try:
            queue.put({"ok": False, "error": f"{type(e).__name__}: {e}",
                       "review_problems": [], "stdout": ""})
        except Exception:  # noqa: BLE001 — 队列本身坏了也无处可报
            pass


def _result_from_dict(d: Dict[str, Any]) -> SandboxResult:
    r = SandboxResult(ok=bool(d.get("ok")),
                      stdout=str(d.get("stdout") or ""),
                      error=str(d.get("error") or ""),
                      review_problems=list(d.get("review_problems") or []))
    r.value = d.get("value")
    return r


def _execute_in_process(source: str, timeout_s: float) -> SandboxResult:
    """进程级执行：超时可以真正 terminate——死循环不会留下烧 CPU 的僵尸。"""
    import multiprocessing as mp
    ctx = mp.get_context("spawn")
    queue = ctx.Queue()
    proc = ctx.Process(target=_child_execute, args=(source, queue), daemon=True)
    proc.start()
    proc.join(timeout=max(0.2, timeout_s))
    if proc.is_alive():
        proc.terminate()
        proc.join(timeout=2.0)
        return SandboxResult(ok=False, error=f"执行超时（>{timeout_s}s），进程已终止")
    try:
        return _result_from_dict(queue.get(timeout=5.0))
    except Exception:  # noqa: BLE001
        return SandboxResult(ok=False, error="沙箱进程无返回（异常退出）")


def _execute_in_thread(source: str, timeout_s: float) -> SandboxResult:
    """线程级降级路径：multiprocessing 不可用时（嵌入式解释器等）退回这里。

    CPython 无法强杀线程，超时只能放弃等待——失控循环会留下一个空转的
    守护线程。这是能力边界，不是实现疏忽；能走进程路径时绝不走这里。"""
    buf = io.StringIO()
    glb = _restricted_globals()
    box: Dict[str, Any] = {}

    def target():
        try:
            code = compile(_prepare_tree(source), "<sandbox>", "exec")
            with redirect_stdout(buf):
                exec(code, glb, box)  # noqa: S102 — 受限命名空间内的执行
            box["__ok__"] = True
        except BaseException as e:  # noqa: BLE001
            box["__ok__"] = False
            box["__err__"] = f"{type(e).__name__}: {e}"

    worker = threading.Thread(target=target, daemon=True)
    worker.start()
    worker.join(timeout=max(0.1, timeout_s))
    if worker.is_alive():
        # 如实说"放弃等待"，不谎称已终止。
        return SandboxResult(ok=False, stdout=buf.getvalue(),
                             error=f"执行超时（>{timeout_s}s），已放弃等待")
    if box.get("__ok__"):
        return SandboxResult(ok=True, value=box.get("__result__"),
                             stdout=buf.getvalue())
    return SandboxResult(ok=False, stdout=buf.getvalue(),
                         error=str(box.get("__err__") or "unknown error"))


def execute_restricted(source: str, *, timeout_s: float = 5.0) -> SandboxResult:
    """AST review 通过后，在受限命名空间里执行；默认走进程级（超时可终止），
    multiprocessing 不可用时降级为线程级（超时放弃等待）。"""
    problems = review_code(source)
    if problems:
        return SandboxResult(ok=False, error="AST review 未通过",
                             review_problems=problems)

    try:
        import multiprocessing  # noqa: F401
        return _execute_in_process(source, timeout_s)
    except Exception:  # noqa: BLE001 — 嵌入式/受限环境没有进程原语
        return _execute_in_thread(source, timeout_s)


def run_python_code(source: str, *, timeout_s: float = 5.0) -> Dict[str, Any]:
    """§7.4 入口：Pyodide 可用则交 WASM，否则 AST review + 受限 exec。

    AST review 对两条引擎一视同仁地先跑：受限 exec 靠它挡逃逸，WASM 路径
    靠它挡 Node 版文件系统触达（--permission 与 Pyodide 引导不兼容，见
    _get_worker 注释）——纵深防御，不是单点保证。engine 字段如实标注实际
    走的引擎。
    """
    problems = review_code(source)
    if problems:
        return SandboxResult(ok=False, error="AST review 未通过",
                             review_problems=problems).to_dict()

    if pyodide_available() and _find_node():
        result = _execute_via_pyodide(source, timeout_s=timeout_s)
        if result is not None:
            result.engine = "pyodide-wasm"
            return result.to_dict()
        # worker 起不来（Node 坏了/包损坏）→ 如实降级，不假装 WASM 隔离
        print("[sandbox] pyodide worker unavailable, falling back to "
              "restricted-ast")
    return execute_restricted(source, timeout_s=timeout_s).to_dict()


# ── Pyodide IPC 通道（Node 子进程，stdin/stdout JSON 行协议）─────────────────

_WORKER_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "js", "pyodide_worker.js")

_worker_proc = None          # 常驻 worker；超时后杀掉、下次调用重拉
_worker_queue = None


def _find_node() -> Optional[str]:
    import shutil
    node = shutil.which("node")
    if node:
        return node
    for cand in (r"C:\Program Files\nodejs\node.exe",
                 "/usr/local/bin/node", "/usr/bin/node"):
        if os.path.exists(cand):
            return cand
    return None


def _kill_worker() -> None:
    global _worker_proc, _worker_queue
    proc, _worker_proc = _worker_proc, None
    _worker_queue = None
    if proc is None:
        return
    try:
        proc.kill()
    except Exception:  # noqa: BLE001 — 进程已死等场景
        pass
    try:
        proc.wait(timeout=3)
    except Exception:  # noqa: BLE001 — kill 后仍不退出就只能放弃等待
        pass


def _get_worker(timeout_s: float) -> "queue.Queue[str]":
    """拉起（或复用）常驻 Pyodide worker 并等待就绪帧。

    就绪等待单独给长超时——Pyodide 冷启动要解压 wasm + stdlib，数秒到数十秒；
    执行超时则短。任何一步失败抛 OSError/RuntimeError，由调用方降级。
    """
    global _worker_proc, _worker_queue
    import subprocess

    if _worker_proc is not None and _worker_proc.poll() is None:
        return _worker_queue

    node = _find_node()
    if not node:
        raise RuntimeError("node executable not found")
    js_dir = os.path.dirname(_WORKER_SCRIPT)
    index_url = os.path.join(ui_app_root(), "node_modules", "pyodide")
    args = [node]
    # 曾试过 Node --permission 白名单（fs 只放 worker 脚本 + pyodide 包），
    # 真实安装上验证失败：它的进程内绑定禁令连 Pyodide 自身引导都拦
    # （"process.binding"）。不兼容是事实，不硬装。替代的纵深防御：
    # 调用方在路由前已做 AST review；这里封顶堆内存挡资源失控。
    args += ["--max-old-space-size=512"]
    args.append(_WORKER_SCRIPT)
    if os.path.isdir(index_url):
        args += ["--index-url", index_url, "--module", index_url]

    proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True,
                            encoding="utf-8", errors="replace", bufsize=1)
    lines: "queue.Queue[str]" = queue.Queue()

    def _reader():
        for line in proc.stdout:
            lines.put(line.rstrip("\n"))
        lines.put(None)   # EOF 标记

    threading.Thread(target=_reader, daemon=True).start()
    _worker_proc = proc
    _worker_queue = lines

    # 等就绪帧（或 fatal）。加载超时给足量——冷启动是大头。
    line = _readline(lines, max(30.0, timeout_s * 6))
    frame = json.loads(line) if line else {"event": "dead"}
    if frame.get("event") != "ready":
        _kill_worker()
        raise RuntimeError(f"pyodide worker not ready: {frame}")
    return lines


def _readline(queue, timeout_s: float) -> Optional[str]:
    from queue import Empty
    try:
        return queue.get(timeout=max(0.05, timeout_s))
    except Empty:
        return None


def _execute_via_pyodide(source: str, *, timeout_s: float) -> Optional[SandboxResult]:
    """经 Node worker 在 WASM 里执行。通道故障返回 None（调用方降级）。"""
    try:
        lines = _get_worker(timeout_s)
    except Exception as e:  # noqa: BLE001 — 通道故障如实上报后降级
        print(f"[sandbox] pyodide channel failed: {e}")
        _kill_worker()
        return None

    req_id = int(time.time() * 1000) % 1_000_000
    try:
        _worker_proc.stdin.write(
            json.dumps({"id": req_id, "source": source},
                       ensure_ascii=False) + "\n")
        _worker_proc.stdin.flush()
    except Exception as e:  # noqa: BLE001
        print(f"[sandbox] pyodide write failed: {e}")
        _kill_worker()
        return None

    line = _readline(lines, timeout_s)
    if line is None:
        # 超时或 worker 死亡。WASM 里无法中断单次执行——杀整个 worker，
        # 下次调用重新冷启动。状态不跨超时保留，这是如实声明的能力边界。
        _kill_worker()
        return SandboxResult(ok=False, error=f"执行超时（>{timeout_s}s），"
                             "已终止 WASM worker")
    try:
        frame = json.loads(line)
    except (ValueError, TypeError):
        _kill_worker()
        return SandboxResult(ok=False, error="worker 返回了坏帧")
    return SandboxResult(ok=bool(frame.get("ok")),
                         value=frame.get("value"),
                         stdout=str(frame.get("stdout") or ""),
                         error=str(frame.get("error") or ""))
