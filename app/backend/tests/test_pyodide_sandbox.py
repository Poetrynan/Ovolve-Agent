"""§7.4 低风险代码沙箱：探针 + AST review + 受限 exec（HANDOFF 任务 7）。"""
import json

import pytest

from pyodide_sandbox import (execute_restricted, pyodide_available,
                             review_code, run_python_code)


def test_review_blocks_dangerous_capabilities():
    cases = [
        "import os\nos.system('dir')",                 # 危险模块
        "from subprocess import run",                   # from-import
        "from .secret import key",                      # 相对导入
        "open('/etc/passwd')",                          # 文件入口裸调用
        "eval('2+2')",                                  # eval 家族
        "getattr(g, '__globals__')",                    # 万能钥匙
        "().__class__.__bases__[0].__subclasses__()",   # 经典逃逸链
    ]
    for src in cases:
        problems = review_code(src)
        assert problems, f"必须拒绝：{src!r}"

    assert review_code("x = [i ** 2 for i in range(10)]") == []
    assert review_code("def fib(n):\n    a, b = 0, 1\n"
                       "    for _ in range(n):\n        a, b = b, a + b\n"
                       "    return a\nfib(10)") == []


def test_restricted_exec_runs_pure_computation():
    r = execute_restricted("total = sum(range(100))\ntotal")
    assert r.ok and r.value == 4950, r.to_dict()

    # stdout 被捕获；末表达式带回返回值
    r2 = execute_restricted("print('hi from sandbox')\n40 + 2")
    assert r2.ok and r2.value == 42 and "hi from sandbox" in r2.stdout


def test_restricted_exec_cannot_escape():
    # 内建被换成了白名单子集——open/os 都拿不到
    r = execute_restricted("open('x')")
    assert not r.ok and "review" in (r.error or "") or r.review_problems, \
        "open 调用必须在审查阶段就被拒"

    # 即使代码里不出现禁词，受限 globals 里也没有全量内建可偷
    r2 = execute_restricted("__builtins__")
    assert r2.ok
    keys = set(r2.value.keys()) if isinstance(r2.value, dict) else set()
    assert "open" not in keys and "__import__" not in keys


def test_timeout_abandons_runaway_loop():
    r = execute_restricted("while True:\n    x = 1", timeout_s=0.5)
    assert not r.ok and "超时" in r.error


def test_result_is_json_serializable():
    r = execute_restricted("{'k': [1, 2]}")
    d = r.to_dict()
    json.dumps(d, ensure_ascii=False)   # 不抛即通过


def test_pyodide_probe_reports_honestly():
    # 探针对不存在的安装路径必须返回 False 且绝不抛异常
    assert pyodide_available("C:/definitely/not/a/real/app") is False
    out = run_python_code("6 * 7")
    assert out["ok"]
    # 引擎标注与机器现实一致；WASM 通道的 value 是 repr 字符串（"42"），
    # 受限 exec 返回原生 int 42——类型随引擎不同是如实声明的能力差异。
    if pyodide_available():
        assert out["engine"].startswith("pyodide"), out["engine"]
        assert str(out["value"]) == "42"
    else:
        assert out["engine"] == "restricted-ast"
        assert out["value"] == 42


# ── Pyodide IPC 通道：stub worker 验证管线，真实 pyodide 门控放行 ────────────

_STUB_OK = r"""
process.stdin.setEncoding('utf8');
function emit(o){ process.stdout.write(JSON.stringify(o) + "\n"); }
emit({ event: "ready" });
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); }
    catch { emit({ id: null, ok: false, error: "bad json" }); continue; }
    emit({ id: req.id, ok: true,
           value: "stub:" + String(req.source || ""),
           stdout: "", error: "" });
  }
});
process.stdin.on("end", () => process.exit(0));
"""

_STUB_SLOW = r"""
process.stdin.setEncoding('utf8');
function emit(o){ process.stdout.write(JSON.stringify(o) + "\n"); }
emit({ event: "ready" });
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); }
    catch { emit({ id: null, ok: false, error: "bad json" }); continue; }
    // 10s 后才回——任何 <10s 的超时都会触发客户端杀 worker 的路径
    setTimeout(() => emit({ id: req.id, ok: true, value: "slow",
                             stdout: "", error: "" }), 10000);
  }
});
process.stdin.on("end", () => process.exit(0));
"""


@pytest.fixture(autouse=True)
def _kill_worker_after_each():
    """worker 是模块级常驻状态：任何测试结束都必须杀掉，否则真实 worker
    会泄漏进后续 stub 测试（本文件真实发生过——stub 测试拿到真机结果）。"""
    import pyodide_sandbox as ps
    yield
    ps._kill_worker()


@pytest.fixture()
def _channel(monkeypatch):
    """独立通道视图：结束清理由 autouse 夹具负责。"""
    import pyodide_sandbox as ps
    return ps


def test_pyodide_channel_roundtrip(_channel, tmp_path, monkeypatch):
    stub = tmp_path / "stub_worker.js"
    stub.write_text(_STUB_OK, encoding="utf-8")
    monkeypatch.setattr(_channel, "_WORKER_SCRIPT", str(stub))
    r = _channel._execute_via_pyodide("1 + 1", timeout_s=5)
    assert r is not None and r.ok
    assert r.value == "stub:1 + 1"
    assert _channel._worker_proc.poll() is None, "worker 应保持常驻复用"
    # 第二次请求复用同一进程
    pid_before = _channel._worker_proc.pid
    r2 = _channel._execute_via_pyodide("2 + 2", timeout_s=5)
    assert r2.ok and _channel._worker_proc.pid == pid_before


def test_pyodide_timeout_kills_worker(_channel, tmp_path, monkeypatch):
    stub = tmp_path / "slow_worker.js"
    stub.write_text(_STUB_SLOW, encoding="utf-8")
    monkeypatch.setattr(_channel, "_WORKER_SCRIPT", str(stub))
    r = _channel._execute_via_pyodide("long job", timeout_s=1)
    assert r is not None and not r.ok and "超时" in r.error
    assert _channel._worker_proc is None, "超时后必须杀掉 worker"
    assert _channel._worker_queue is None


def test_run_python_code_routes_to_wasm_when_available(
        _channel, tmp_path, monkeypatch):
    """装了 pyodide 且 Node 可用 → 引擎字段必须如实标 pyodide-wasm。"""
    import shutil
    stub = tmp_path / "stub_worker.js"
    stub.write_text(_STUB_OK, encoding="utf-8")
    monkeypatch.setattr(_channel, "pyodide_available", lambda p=None: True)
    monkeypatch.setattr(_channel, "_find_node",
                        lambda: shutil.which("node"))
    monkeypatch.setattr(_channel, "_WORKER_SCRIPT", str(stub))
    out = _channel.run_python_code("3 * 7")
    assert out["ok"] and out["engine"] == "pyodide-wasm"
    assert out["value"] == "stub:3 * 7"


def test_real_pyodide_when_installed():
    """真实 Pyodide 存在时的门控验证；未安装则跳过——探针如实，不造假。"""
    from pyodide_sandbox import _find_node, _kill_worker
    if not (pyodide_available() and _find_node()):
        pytest.skip("pyodide 未安装（npm install --no-save pyodide 可启用）")
    try:
        out = run_python_code("import math\nmath.gcd(1071, 462)\n",
                              timeout_s=120)
        assert out["ok"] and out["value"] == "21", out
        assert out["engine"].startswith("pyodide")
    finally:
        _kill_worker()
