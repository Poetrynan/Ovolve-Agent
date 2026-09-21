"""Hook runner: event coverage, subagent lifecycle mapping, http hooks."""
from __future__ import annotations

import json
import urllib.error

import pytest

import hook_runner
from hook_runner import HookRunner


def _runner(tmp_path, cfg: dict) -> HookRunner:
    path = tmp_path / "hooks.json"
    path.write_text(json.dumps(cfg), encoding="utf-8")
    r = HookRunner(project_dir=str(tmp_path), session_id="s1")
    r.load([str(path)])
    return r


# ── 事件覆盖 ─────────────────────────────────────────────────────────────────

def test_eleven_events_are_supported():
    assert len(hook_runner.HOOK_EVENTS) == 11
    assert "PostCompact" in hook_runner.HOOK_EVENTS
    assert "SubagentStart" in hook_runner.HOOK_EVENTS


def test_fold_has_a_hook_point_on_both_sides():
    assert hook_runner.BUS_TO_HOOK["session_before_compact"] == ("PreCompact",)
    assert hook_runner.BUS_TO_HOOK["context_folded"] == ("PostCompact",)


def test_unknown_events_are_reported_not_silently_dropped(tmp_path):
    r = _runner(tmp_path, {"enabled": True,
                           "events": {"NoSuchEvent": [{"hooks": [{"command": "true"}]}]}})
    assert any("NoSuchEvent" in p for p in r.problems)


# ── 子代理生命周期 → hook 事件 ────────────────────────────────────────────────

@pytest.mark.parametrize("status,expected", [
    ("spawning", "SubagentStart"),
    ("completed", "SubagentStop"),
    ("error", "SubagentStop"),
    ("killed", "SubagentStop"),
    ("timeout", "SubagentStop"),
    ("stale", "SubagentStop"),
    ("spawn_error", "SubagentStop"),
    ("lost", "SubagentStop"),
    ("running", ""),          # 中间态：不该有 hook
    ("settling", ""),
    ("idle", ""),
])
def test_subagent_status_maps_to_exactly_one_hook(status, expected):
    r = HookRunner()
    assert r._hook_event_for("subagent_state", {"status": status}) == expected


def test_subagent_start_fires_once_per_life():
    """spawning 是唯一进入 Start 的状态——running 每次进度更新都会再来一次。"""
    assert hook_runner.SUBAGENT_START_STATUSES == frozenset({"spawning"})
    assert "running" not in hook_runner.SUBAGENT_START_STATUSES


def test_fold_payload_is_handed_over_without_the_summary():
    """摘要是压缩后的整段对话——不能原样进 hook 的 stdin。"""
    r = HookRunner()
    payload = {"summary": "整段对话的压缩正文", "strategy": "llm-summary", "manual": False}
    out = r._hook_payload_for("context_folded", payload)
    assert "summary" not in out
    assert out["strategy"] == "llm-summary"


# ── http hook ───────────────────────────────────────────────────────────────

def test_http_hook_validates(tmp_path):
    r = _runner(tmp_path, {"enabled": True, "events": {"SubagentStart": [
        {"hooks": [{"type": "http", "url": "https://example.test/hook",
                    "method": "POST", "headers": {"X-A": "b"}, "timeoutMs": 1500}]}]}})
    assert not r.problems, r.problems
    spec = r.matchers["SubagentStart"][0]["hooks"][0]
    assert spec["type"] == "http"
    assert spec["method"] == "POST"
    assert spec["timeout_ms"] == 1500


def test_http_hook_rejects_unknown_fields_and_methods(tmp_path):
    r = _runner(tmp_path, {"enabled": True, "events": {"SubagentStart": [
        {"hooks": [{"type": "http", "url": "https://x.test", "command": "echo"}]},
        {"hooks": [{"type": "http", "url": "https://x.test", "method": "TRACE"}]}]}})
    assert any("not valid for its type" in p for p in r.problems)
    assert any("method" in p for p in r.problems)


def test_unknown_hook_type_still_reported(tmp_path):
    r = _runner(tmp_path, {"enabled": True, "events": {"Stop": [
        {"hooks": [{"type": "grpc", "url": "x"}]}]}})
    assert any("unknown hook type" in p for p in r.problems)


class _Resp:
    def __init__(self, payload: bytes):
        self._payload = payload

    def read(self):
        return self._payload

    def close(self):
        pass


def _http_spec(**over):
    spec = {"type": "http", "command": "https://x.test/hook", "url": "https://x.test/hook",
            "method": "POST", "headers": {}, "body": None, "timeout_ms": 1000,
            "args": [], "shell": None, "status_message": "", "source": "t"}
    spec.update(over)
    return spec


@pytest.mark.asyncio
async def test_http_2xx_is_parsed_like_stdout(monkeypatch):
    monkeypatch.setattr(hook_runner.web_outbound, "open_url",
                        lambda *a, **k: _Resp(b'{"additionalContext": "hi"}'))
    r = HookRunner()
    out = await r.run_one(_http_spec(), "coder", "SubagentStart", {})
    assert out.status == "pass"
    assert out.context == "hi"


@pytest.mark.asyncio
async def test_http_4xx_does_not_block(monkeypatch):
    """4xx = 我们把请求写错了，不该拿用户的回合陪葬。"""
    def boom(*a, **k):
        raise urllib.error.HTTPError("https://x.test", 400, "Bad Request", {}, None)

    monkeypatch.setattr(hook_runner.web_outbound, "open_url", boom)
    r = HookRunner()
    out = await r.run_one(_http_spec(), "coder", "SubagentStart", {})
    assert out.status == "pass"          # 不 block
    assert "400" in out.reason
    assert r.log[-1]["status"] == "warning"


@pytest.mark.asyncio
async def test_http_5xx_is_a_failed_hook(monkeypatch):
    def boom(*a, **k):
        raise urllib.error.HTTPError("https://x.test", 503, "Unavailable", {}, None)

    monkeypatch.setattr(hook_runner.web_outbound, "open_url", boom)
    r = HookRunner()
    out = await r.run_one(_http_spec(), "coder", "SubagentStart", {})
    assert out.status == "error"
    assert "503" in out.reason


@pytest.mark.asyncio
async def test_http_connect_timeout_is_a_timeout_not_a_crash(monkeypatch):
    """连不上按超时处理（Python 3.11+ 里 socket 超时就是 TimeoutError）。"""
    def hang(*a, **k):
        raise TimeoutError("connect timeout")

    monkeypatch.setattr(hook_runner.web_outbound, "open_url", hang)
    r = HookRunner()
    out = await r.run_one(_http_spec(timeout_ms=10), "coder", "SubagentStart", {})
    assert out.status == "timeout"
    assert r.log[-1]["status"] == "timeout"


@pytest.mark.asyncio
async def test_http_unreachable_is_a_failed_hook(monkeypatch):
    def boom(*a, **k):
        raise OSError("no route to host")

    monkeypatch.setattr(hook_runner.web_outbound, "open_url", boom)
    r = HookRunner()
    out = await r.run_one(_http_spec(), "coder", "SubagentStart", {})
    assert out.status == "error"
    assert "no route" in out.reason


# ── 调用链（E.2） ────────────────────────────────────────────────────────────

def test_subagent_session_carries_caller_call_id():
    from subagent_runtime import SubagentSession

    sess = SubagentSession(subagent_id="s", subagent_type="explore", label="",
                           parent_session_id="p", child_session_id="c",
                           caller_call_id="call-1")
    assert sess.to_public()["callerCallId"] == "call-1"


def test_subagent_session_without_caller_has_no_key():
    """没取到父调用 id 时暴露 null，而不是一个空字符串假装有关联。"""
    from subagent_runtime import SubagentSession

    sess = SubagentSession(subagent_id="s", subagent_type="explore", label="",
                           parent_session_id="p", child_session_id="c")
    assert sess.to_public()["callerCallId"] is None
