"""P0 加固回归测试：链接绕过、原子写、git 参数注入。

这三项属于项目纪律里「权限 / 数据完整性 / 安全边界」范畴——改错不会让任何功能
报错，只会让防护静默失效，所以必须有留存测试。

按语料组织：加规则时往语料里加行，别改断言。
"""
import os
import subprocess
import sys

import pytest

import path_guard
from event_bus import Event, EventAction
from path_guard import PathGuard


# ── 工具：造一个能逃出工作区的目录链接 ──────────────────────────────────────
#
# Windows 上 `mklink /J`（目录联接）**不需要管理员**，这正是这个绕过好用的原因；
# os.symlink 对目录反而要开发者模式。两条路都试，都不行就跳过——跳过比假绿好。
def _make_dir_link(link_path: str, target: str) -> bool:
    try:
        os.symlink(target, link_path, target_is_directory=True)
        return True
    except (OSError, NotImplementedError, AttributeError):
        pass
    if sys.platform == "win32":
        try:
            proc = subprocess.run(
                ["cmd", "/c", "mklink", "/J", link_path, target],
                capture_output=True, text=True, timeout=15,
            )
            return proc.returncode == 0 and os.path.isdir(link_path)
        except (OSError, subprocess.SubprocessError):
            return False
    return False


def _write_event(path: str, workspace_root: str, content: str = "x") -> Event:
    return Event(
        name="pre_tool_use",
        payload={
            "tool_name": "write_file",
            "args": {"path": path, "content": content},
            "context": {"workspace_root": workspace_root},
        },
    )


def _run_guard(event: Event) -> Event:
    # 直接调 handler，不挂总线：这里测的是判定逻辑，不是订阅机制。
    PathGuard()._on_pre_tool_use(event)
    return event


# ── 语料 1：工作区内的正常写必须放行 ────────────────────────────────────────
def test_ordinary_write_inside_workspace_is_allowed(tmp_path):
    ws = str(tmp_path)
    ev = _run_guard(_write_event(os.path.join(ws, "notes.txt"), ws))
    assert ev.action is EventAction.CONTINUE, ev.block_reason


def test_write_outside_workspace_is_blocked(tmp_path):
    ws = str(tmp_path / "ws")
    os.makedirs(ws, exist_ok=True)
    outside = str(tmp_path / "outside.txt")
    ev = _run_guard(_write_event(outside, ws))
    assert ev.action is EventAction.BLOCK


# ── 语料 2：链接绕过（这次修的就是它）──────────────────────────────────────
#
# 修前 _norm 用 normpath（纯字符串运算），`<ws>/escape/x` 会被判成「在工作区内、
# 不在黑名单里」而放行，尽管 escape 是指向系统目录的联接。
def test_link_escaping_workspace_is_blocked(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    link = ws / "escape"
    if not _make_dir_link(str(link), str(outside)):
        pytest.skip("无法创建目录链接（需要 mklink /J 或符号链接权限）")

    ev = _run_guard(_write_event(str(link / "pwned.txt"), str(ws)))
    assert ev.action is EventAction.BLOCK, (
        "经由链接逃出工作区的写必须被拦截；放行说明 _norm 又退回了 normpath"
    )


@pytest.mark.skipif(sys.platform != "win32", reason="黑名单语料是 Windows 系统目录")
def test_link_into_blacklisted_system_dir_is_blocked(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    link = ws / "sys"
    if not _make_dir_link(str(link), r"C:\Windows"):
        pytest.skip("无法创建目录链接")

    ev = _run_guard(_write_event(str(link / "evil.dll"), str(ws)))
    assert ev.action is EventAction.BLOCK
    assert "protected system location" in ev.block_reason


def test_workspace_behind_a_link_still_matches_itself(tmp_path):
    """两侧都要 realpath：工作区自己在链接后面时不能误拦正常写。"""
    real_ws = tmp_path / "real"
    real_ws.mkdir()
    link_ws = tmp_path / "linked"
    if not _make_dir_link(str(link_ws), str(real_ws)):
        pytest.skip("无法创建目录链接")

    ev = _run_guard(_write_event(str(link_ws / "ok.txt"), str(link_ws)))
    assert ev.action is EventAction.CONTINUE, ev.block_reason


# ── 语料 3：write_file 的原子性 ─────────────────────────────────────────────
#
# 修前用 open(path, "w")，先截断再写。写到一半被杀（退出、tree-kill、磁盘满）
# 目标文件就变成空的或半截，**原内容无从恢复**。
import file_agent
from file_agent import _write_file_impl


def _ctx(ws: str) -> dict:
    return {"workspace_root": ws}


def test_write_file_writes_full_content(tmp_path):
    target = tmp_path / "a.txt"
    r = _write_file_impl({"path": str(target), "content": "hello 世界"}, _ctx(str(tmp_path)))
    assert r.ok, r.error
    assert target.read_text(encoding="utf-8") == "hello 世界"


def test_write_file_append_appends(tmp_path):
    target = tmp_path / "b.txt"
    target.write_text("head\n", encoding="utf-8")
    r = _write_file_impl(
        {"path": str(target), "content": "tail\n", "append": True}, _ctx(str(tmp_path))
    )
    assert r.ok, r.error
    assert target.read_text(encoding="utf-8") == "head\ntail\n"


def test_failed_overwrite_leaves_original_intact(tmp_path, monkeypatch):
    """这是原子性的判据：替换失败时原文件必须还在。

    修前会先截断，所以同样的失败会留下一个空文件。
    """
    target = tmp_path / "precious.txt"
    original = "不能丢的内容\n" * 50
    target.write_text(original, encoding="utf-8")

    def _boom(src, dst):
        raise OSError("simulated crash during replace")

    monkeypatch.setattr(file_agent.os, "replace", _boom)
    r = _write_file_impl({"path": str(target), "content": "新内容"}, _ctx(str(tmp_path)))

    assert not r.ok, "替换失败必须如实报错，不能报成功"
    assert target.read_text(encoding="utf-8") == original, "原文件被破坏 = 非原子写"


def test_failed_overwrite_leaves_no_temp_litter(tmp_path, monkeypatch):
    target = tmp_path / "c.txt"
    target.write_text("x", encoding="utf-8")
    monkeypatch.setattr(
        file_agent.os, "replace", lambda s, d: (_ for _ in ()).throw(OSError("nope"))
    )
    _write_file_impl({"path": str(target), "content": "y"}, _ctx(str(tmp_path)))
    assert not list(tmp_path.glob("*.tmp")), "失败后不应留下临时文件"


# ── 语料 4：git 参数注入 ────────────────────────────────────────────────────
#
# `_git_cmd` 用 shell=False，所以这里防的不是 shell 元字符，而是 **git 自己的
# 选项解析**：--receive-pack=<cmd> / --upload-pack=<cmd> 会让 git 执行任意命令，
# 而这些值来自 tool_call 参数（可被提示注入操纵）。
from file_agent import (
    _git_add_impl, _git_branch_impl, _git_log_impl, _git_pull_impl, _git_push_impl,
)

# 每一行都是一个必须被拒的值。加防护时往语料里加行。
OPTION_LOOKING_VALUES = [
    "--receive-pack=calc.exe",
    "--upload-pack=calc.exe",
    "--exec-path=/tmp/evil",
    "-c",
    "--all",
    "-f",
    "--force",
]


@pytest.mark.parametrize("evil", OPTION_LOOKING_VALUES)
def test_git_push_refuses_option_looking_remote(evil, tmp_path):
    r = _git_push_impl({"remote": evil}, _ctx(str(tmp_path)))
    assert not r.ok
    assert "- 开头" in r.error or "不能为空" in r.error


@pytest.mark.parametrize("evil", OPTION_LOOKING_VALUES)
def test_git_pull_refuses_option_looking_remote(evil, tmp_path):
    r = _git_pull_impl({"remote": evil}, _ctx(str(tmp_path)))
    assert not r.ok


@pytest.mark.parametrize("evil", OPTION_LOOKING_VALUES)
def test_git_add_refuses_option_looking_path(evil, tmp_path):
    r = _git_add_impl({"paths": [evil]}, _ctx(str(tmp_path)))
    assert not r.ok


@pytest.mark.parametrize("evil", OPTION_LOOKING_VALUES)
def test_git_branch_refuses_option_looking_name(evil, tmp_path):
    r = _git_branch_impl({"action": "create", "name": evil}, _ctx(str(tmp_path)))
    assert not r.ok


def test_git_add_rejects_empty_pathspec(tmp_path):
    """空 paths 曾经会退化成 `git add`（无 pathspec），语义不明确。"""
    r = _git_add_impl({"paths": []}, _ctx(str(tmp_path)))
    assert not r.ok


def test_git_log_count_must_be_int(tmp_path):
    r = _git_log_impl({"count": "10; rm -rf /"}, _ctx(str(tmp_path)))
    assert not r.ok
    assert "整数" in r.error


def test_git_log_count_is_bounded(tmp_path):
    """count 被插值进 `-N`，必须夹到合理范围，不能让模型要 10 亿条。"""
    from file_agent import _git_count
    assert _git_count(10**9) <= 500
    assert _git_count(0) >= 1
    assert _git_count(-5) >= 1


# ── 语料 5：8765 API 的 Origin 白名单与 Host 校验 ───────────────────────────
#
# 旧中间件把请求里的 Origin 原样回显，还附带 Allow-Credentials，等于没有同源
# 策略：用户浏览器里任何一个页面都能调用全部路由并读到返回值。这里的每条断言
# 都对应一种「跨源页面拿到能力」的走法。

class _FakeRequest:
    """cors_middleware 只用到 method 与 headers，够了。"""

    def __init__(self, headers=None, method="GET"):
        self.headers = headers or {}
        self.method = method


async def _cors(headers, method="GET"):
    from aiohttp import web as _web
    from server.http_server import cors_middleware

    called = {"n": 0}

    async def _handler(_req):
        called["n"] += 1
        return _web.json_response({"ok": True})

    resp = await cors_middleware(_FakeRequest(headers, method), _handler)
    return resp, called["n"]


def _run_cors(headers, method="GET"):
    """Sync wrapper: this suite runs without an async pytest plugin."""
    import asyncio
    return asyncio.run(_cors(headers, method))



ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "file:///C:/app/index.html"]
HOSTILE_ORIGINS = [
    "https://example.invalid",
    "http://evil.localhost.example",
    "http://localhost:5174",
    "http://127.0.0.1.nip.io:5173",
]


@pytest.mark.parametrize("origin", HOSTILE_ORIGINS)
def test_origin_gate_rejects_foreign_pages(origin):
    from server.http_server import _origin_allowed
    assert not _origin_allowed(origin)


@pytest.mark.parametrize("origin", ALLOWED_ORIGINS)
def test_origin_gate_allows_our_own_ui(origin):
    from server.http_server import _origin_allowed
    assert _origin_allowed(origin)


def test_origin_gate_allows_native_clients():
    """完全没有 Origin 头：我们自己的 Python 客户端与健康探针。"""
    from server.http_server import _origin_allowed
    assert _origin_allowed("")
    assert _origin_allowed("null")


@pytest.mark.parametrize("host", ["evil.example:8765", "app.attacker.test", "0.0.0.0:8765"])
def test_host_gate_rejects_rebinding(host):
    from server.http_server import _host_allowed
    assert not _host_allowed(host)


@pytest.mark.parametrize("host", ["127.0.0.1:8765", "localhost:8765", "localhost", "[::1]:8765"])
def test_host_gate_allows_loopback(host):
    from server.http_server import _host_allowed
    assert _host_allowed(host)


def test_middleware_blocks_hostile_origin_before_the_handler_runs():
    resp, calls = _run_cors({"Origin": "https://example.invalid", "Host": "127.0.0.1:8765"})
    assert resp.status == 403
    assert calls == 0, "路由体不该被执行——很多 POST 只要发出去就已改状态"
    assert "Access-Control-Allow-Origin" not in resp.headers


def test_middleware_blocks_rebound_host():
    resp, calls = _run_cors({"Host": "evil.example:8765"})
    assert resp.status == 421
    assert calls == 0


def test_middleware_echoes_only_whitelisted_origin():
    resp, calls = _run_cors({"Origin": "http://localhost:5173", "Host": "127.0.0.1:8765"})
    assert resp.status == 200
    assert calls == 1
    assert resp.headers["Access-Control-Allow-Origin"] == "http://localhost:5173"
    assert resp.headers["Vary"] == "Origin"


def test_middleware_grants_no_credentials_without_an_origin():
    resp, calls = _run_cors({"Host": "127.0.0.1:8765"})
    assert resp.status == 200
    assert calls == 1
    assert "Access-Control-Allow-Origin" not in resp.headers
    assert "Access-Control-Allow-Credentials" not in resp.headers


def test_middleware_answers_preflight_without_touching_the_route():
    resp, calls = _run_cors(
        {"Origin": "http://127.0.0.1:5173", "Host": "127.0.0.1:8765"}, method="OPTIONS"
    )
    assert resp.status == 204
    assert calls == 0
    assert resp.headers["Access-Control-Allow-Origin"] == "http://127.0.0.1:5173"


# ── 语料 6：命令执行工具的路径止损（B28）───────────────────────────────────
#
# path_guard 以前只看 WRITE_TOOLS，shell_executor / python_executor /
# native_action_chain 完全在防护之外——`_on_pre_tool_use` 对它们直接 return。
# 应该兜底的 sandbox 模块在 app/ 里零 import，等于没人在看。这一组钉住：命令里
# 指向系统目录的绝对路径被拦，cwd 逃出工作区被拦，工作区内的正常命令放行。
def _cmd_event(tool_name: str, args: dict, workspace_root: str) -> Event:
    return Event(
        name="pre_tool_use",
        payload={"tool_name": tool_name, "args": args, "context": {"workspace_root": workspace_root}},
    )


@pytest.mark.skipif(sys.platform != "win32", reason="黑名单语料是 Windows 系统目录")
def test_shell_command_touching_system_dir_is_blocked(tmp_path):
    ws = str(tmp_path)
    ev = _run_guard(
        _cmd_event("shell_executor", {"command": r'echo pwned > C:\Windows\System32\drivers\etc\hosts'}, ws)
    )
    assert ev.action is EventAction.BLOCK, "写入系统目录的 shell 命令必须被拦"


@pytest.mark.skipif(sys.platform != "win32", reason="黑名单语料是 Windows 系统目录")
def test_native_chain_touching_system_dir_is_blocked(tmp_path):
    ws = str(tmp_path)
    ev = _run_guard(
        _cmd_event(
            "native_action_chain",
            {"commands": ["echo ok", r'copy evil.dll "C:\Program Files\x\evil.dll"']},
            ws,
        )
    )
    assert ev.action is EventAction.BLOCK


@pytest.mark.skipif(sys.platform != "win32", reason="黑名单语料是 Windows 系统目录")
def test_python_snippet_writing_system_dir_is_blocked(tmp_path):
    ws = str(tmp_path)
    ev = _run_guard(
        _cmd_event("python_executor", {"code": r"open(r'C:\Windows\System32\x.txt','w').write('x')"}, ws)
    )
    assert ev.action is EventAction.BLOCK


def test_ordinary_shell_command_is_allowed(tmp_path):
    ws = str(tmp_path)
    ev = _run_guard(_cmd_event("shell_executor", {"command": "python -m pytest -q"}, ws))
    assert ev.action is EventAction.CONTINUE, ev.block_reason


def test_shell_cwd_outside_workspace_is_blocked(tmp_path):
    ws = str(tmp_path / "ws")
    os.makedirs(ws, exist_ok=True)
    outside = str(tmp_path / "elsewhere")
    os.makedirs(outside, exist_ok=True)
    ev = _run_guard(_cmd_event("shell_executor", {"command": "dir", "cwd": outside}, ws))
    assert ev.action is EventAction.BLOCK, "cwd 逃出工作区必须被拦"


def test_shell_command_with_relative_paths_is_allowed(tmp_path):
    """相对路径与工作区内绝对路径都不该误伤——否则正常构建全被拦。"""
    ws = str(tmp_path)
    ev = _run_guard(
        _cmd_event("shell_executor", {"command": f'python build.py --out "{os.path.join(ws, "output", "a.txt")}"'}, ws)
    )
    assert ev.action is EventAction.CONTINUE, ev.block_reason
