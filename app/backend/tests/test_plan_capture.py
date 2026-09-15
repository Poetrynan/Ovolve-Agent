"""Router plan 档轮次自动捕获方案产物（Task 2）。"""
import sys, os, asyncio
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from plan_artifact import get_plan_artifact, latest_ready_for_session


class _FakeBus:
    def __init__(self):
        self.events = []

    async def emit(self, name, payload=None, **kw):
        self.events.append((name, payload))


class _FakeRouter:
    """只挂载被测方法，避免拉起完整 Router（依赖过重）。"""

    from router import Router as _R
    _maybe_capture_plan = _R._maybe_capture_plan

    def __init__(self):
        self.session_id = "sess_plan"
        self.bus = _FakeBus()


def test_capture_plan_on_plan_permission_success():
    r = _FakeRouter()
    r.session_id = "sess_cap_ok"
    out = "方案如下\n```plan\n- [ ] 改 main.py\n- [ ] 跑 pytest\n```"
    asyncio.run(r._maybe_capture_plan({"permission": "plan"}, out))
    art = latest_ready_for_session("sess_cap_ok")
    assert art and "改 main.py" in art["plan_md"]
    name, payload = r.bus.events[-1]
    assert name == "plan_ready" and payload["plan_id"] == art["plan_id"]
    assert len(payload["preview"]) <= 300


def test_no_capture_without_plan_permission_or_empty():
    r = _FakeRouter()
    r.session_id = "sess_cap_no"
    asyncio.run(r._maybe_capture_plan({"permission": "auto"}, "```plan\n- [ ] x\n```"))
    asyncio.run(r._maybe_capture_plan({"permission": "plan"}, "```plan\n```"))
    asyncio.run(r._maybe_capture_plan({"permission": "plan"}, ""))
    assert latest_ready_for_session("sess_cap_no") is None
    assert r.bus.events == []


def test_capture_fail_open_on_bad_output():
    r = _FakeRouter()
    asyncio.run(r._maybe_capture_plan({"permission": "plan"}, None))  # 不抛即过
    assert r.bus.events == []
