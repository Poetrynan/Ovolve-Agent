"""test_browser_sessions.py — 浏览器多标签会话管理（P1-1）。

覆盖:
1. 会话隔离: 标签归属校验、跨任务不可见不可操作、任务切换只动 outgoing
2. 标签生命周期状态机: open/activate/suspend/resume/close 全迁移 + 非法迁移拒绝
3. 会话挂起/恢复: 快照保存、active 标签挂起、恢复收敛、焦点/视口还原
4. 视口: 每标签设置/复位、参数校验、桥失败不提交（两侧不漂移）
5. 并发任务互不干扰: 交错操作下桥调用目标正确、end_session 只关自家标签
6. 截图就绪: capture_tab 落盘 PNG、value 形状与 cua 桌面后端截图同族、失败路径
7. browser_agent 接线: 新工具注册齐全、_navigate 走会话、task_id 解析优先级

不依赖真实 Electron: 桥客户端注入假实现（记录调用序列，返回形状真实）。

运行: pytest tests/test_browser_sessions.py -q
"""
import base64

import pytest

from result import Result

import browser_sessions
from browser_sessions import (
    TAB_ACTIVE,
    TAB_CLOSED,
    TAB_SUSPENDED,
    BrowserSession,
    BrowserSessionManager,
    MAX_SESSIONS,
    resolve_task_id,
)


# ── 测试替身 ─────────────────────────────────────────────────────────────────

class FakeBridge:
    """ElectronBrowserClient 的形状替身：记录 (endpoint, payload) 调用序列。"""

    def __init__(self, fail_endpoints=(), titles=None):
        self.calls = []                       # [(endpoint, payload)] 依序追加
        self.fail = set(fail_endpoints)
        self.titles = dict(titles or {})
        self._n = 0

    def call(self, endpoint, payload=None, timeout=35):
        payload = dict(payload or {})
        self.calls.append((endpoint, payload))
        if endpoint in self.fail:
            return Result.failure(f"{endpoint} failed (injected)")
        if endpoint == "tab_open":
            self._n += 1
            url = payload.get("url", "")
            default = f"Page {self._n}" if url else "New Tab"
            return Result.success({
                "tab_id": payload.get("tab_id"),
                "url": url,
                "title": self.titles.get(url, default),
            })
        if endpoint == "navigate":
            url = payload.get("url", "")
            return Result.success({"url": url, "title": self.titles.get(url, "Page Title")})
        if endpoint == "tab_snapshot":
            png = base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode("ascii")
            return Result.success({
                "tab_id": payload.get("tab_id"),
                "dataUri": f"data:image/png;base64,{png}",
                "width": 800, "height": 600,
            })
        # tab_activate / tab_close / tab_suspend / tab_resume / viewport / ...
        return Result.success({"tab_id": payload.get("tab_id")})


def seq_ids(prefix="t"):
    """确定性 tab id 工厂：断言里可以点名具体标签。"""
    box = {"n": 0}

    def factory():
        box["n"] += 1
        return f"{prefix}{box['n']:03d}"

    return factory


def make_manager(fail_endpoints=(), titles=None, workspace=None):
    bridge = FakeBridge(fail_endpoints=fail_endpoints, titles=titles)
    mgr = BrowserSessionManager(client=bridge, workspace=workspace, id_factory=seq_ids())
    return mgr, bridge


class _AgentShim:
    """BrowserAgent 的形状替身：_get_sessions_or_fail 只认 .sessions。"""
    DOMAIN = "browser"

    def __init__(self, mgr):
        self.sessions = mgr


# ── 1. 会话隔离 ──────────────────────────────────────────────────────────────

class TestSessionIsolation:

    def test_tabs_are_private_to_their_task(self):
        mgr, bridge = make_manager()
        ra = mgr.open_tab("task-a", url="https://a.example")
        rb = mgr.open_tab("task-b", url="https://b.example")
        assert ra.ok and rb.ok
        tab_a = ra.value["tab_id"]
        tab_b = rb.value["tab_id"]
        assert tab_a != tab_b                       # 各会话的 id 空间独立

        # 跨任务不可操作：B 的标签在 A 的会话里不存在
        r = mgr.close_tab("task-a", tab_b)
        assert not r.ok and "unknown tab" in r.error
        # 跨任务不可见：A 的列表里没有 B 的标签
        listed = mgr.list_tabs("task-a").value
        assert [t["tab_id"] for t in listed["tabs"]] == [tab_a]
        # 两侧状态完好：谁也没被误关
        assert mgr.list_tabs("task-b").value["tabs"][0]["tab_id"] == tab_b

    def test_switch_task_suspends_only_outgoing(self):
        mgr, bridge = make_manager()
        mgr.open_tab("a", url="https://a1.example")
        mgr.open_tab("a", url="https://a2.example")
        bridge.calls.clear()
        mgr.open_tab("b", url="https://b1.example")
        rb_calls = list(bridge.calls)
        bridge.calls.clear()

        r = mgr.switch_task("a", "b")
        assert r.ok
        # 只挂起了 a 的两个标签，b 的标签动都没动
        suspended = [p["tab_id"] for e, p in bridge.calls if e == "tab_suspend"]
        assert len(suspended) == 2
        assert all(tid.startswith("t0") for tid in suspended)
        assert not any(e == "tab_suspend" for e, p in rb_calls)
        # a 全挂起，b 保持 active
        assert all(t["state"] == TAB_SUSPENDED
                   for t in mgr.list_tabs("a").value["tabs"])
        assert mgr.list_tabs("b").value["tabs"][0]["state"] == TAB_ACTIVE

    def test_session_cap_is_a_memory_guard(self):
        mgr, _ = make_manager()
        for i in range(MAX_SESSIONS):
            assert mgr.begin_session(f"task-{i}").ok
        r = mgr.begin_session("one-too-many")
        assert not r.ok and "too many" in r.error


# ── 2. 标签生命周期状态机（纯会话，不碰桥）────────────────────────────────────

class TestTabLifecycleStateMachine:

    def _session(self):
        s = BrowserSession(session_id="bs-x", task_id="x")
        s.open_tab("t1", url="https://one.example")
        return s

    def test_open_is_active_and_takes_focus(self):
        s = self._session()
        assert s.active_tab_id == "t1"
        assert s.get_tab("t1").state == TAB_ACTIVE

    def test_open_duplicate_id_rejected(self):
        s = self._session()
        assert not s.open_tab("t1").ok
        assert "already exists" in s.open_tab("t1").error

    def test_open_background_tab_keeps_focus(self):
        s = self._session()
        r = s.open_tab("t2", focus=False)
        assert r.ok
        assert s.active_tab_id == "t1"              # 焦点没被后台标签抢走

    def test_activate_switches_focus_and_wakes(self):
        s = self._session()
        s.open_tab("t2")
        assert s.active_tab_id == "t2"
        s.suspend_tab("t1")
        r = s.activate_tab("t1")                    # 激活挂起标签 = 唤醒 + 夺焦点
        assert r.ok
        assert s.get_tab("t1").state == TAB_ACTIVE
        assert s.active_tab_id == "t1"

    def test_activate_unknown_or_closed_rejected(self):
        s = self._session()
        assert "unknown tab" in s.activate_tab("ghost").error
        s.close_tab("t1")
        assert "is closed" in s.activate_tab("t1").error

    def test_suspend_strict_transitions(self):
        s = self._session()
        assert s.suspend_tab("t1").ok
        r = s.suspend_tab("t1")
        assert not r.ok and "already suspended" in r.error
        assert "unknown tab" in s.suspend_tab("ghost").error

    def test_resume_strict_transitions(self):
        s = self._session()
        r = s.resume_tab("t1")                      # active → resume 是非法迁移
        assert not r.ok and "not suspended" in r.error
        s.suspend_tab("t1")
        assert s.resume_tab("t1").ok
        assert s.get_tab("t1").state == TAB_ACTIVE

    def test_closed_is_terminal(self):
        s = self._session()
        assert s.close_tab("t1").ok
        for op in (s.activate_tab, s.suspend_tab, s.resume_tab, s.close_tab):
            r = op("t1")
            assert not r.ok and "closed" in r.error

    def test_focus_repoints_when_focused_tab_goes(self):
        s = self._session()
        s.open_tab("t2")
        r = s.close_tab("t2")                       # 关的是焦点标签
        assert r.ok and r.value["new_focus"] == "t1"
        s.suspend_tab("t1")                         # 挂起最后一个 → 无焦点
        assert s.active_tab_id is None

    def test_snapshot_excludes_closed_tabs(self):
        s = self._session()
        s.open_tab("t2")
        s.close_tab("t1")
        snap = s.snapshot_state()
        assert [t["tab_id"] for t in snap["tabs"]] == ["t2"]

    def test_restore_rejects_foreign_snapshot(self):
        s = self._session()
        other = BrowserSession(session_id="bs-y", task_id="y")
        r = s.restore_state(other.snapshot_state())
        assert not r.ok and "belongs to session" in r.error

    def test_restore_recreates_missing_tabs(self):
        s = self._session()
        s.close_tab("t1")
        snap = {"session_id": s.session_id, "task_id": s.task_id,
                "active_tab_id": "t1",
                "tabs": [{"tab_id": "t1", "url": "https://one.example",
                          "title": "One", "state": TAB_ACTIVE,
                          "viewport": {"width": 390, "height": 844}}]}
        r = s.restore_state(snap)
        assert r.ok
        assert s.get_tab("t1").state == TAB_ACTIVE
        assert s.get_tab("t1").viewport == {"width": 390, "height": 844}
        assert s.active_tab_id == "t1"


# ── 3. 会话挂起/恢复（编排层收敛）────────────────────────────────────────────

class TestSuspendResumeSession:

    def test_suspend_parks_actives_and_snapshots(self):
        mgr, bridge = make_manager()
        mgr.open_tab("a", url="https://one.example")
        mgr.open_tab("a", url="https://two.example")
        mgr.suspend_tab("a", "t001")                # 预先挂起一个（本就 non-active）
        bridge.calls.clear()

        r = mgr.suspend_session("a")
        assert r.ok
        assert r.value["suspended"] == 1            # 只挂起仍 active 的那个
        assert r.value["snapshot_tabs"] == 2        # 快照含全部在世标签
        suspended = [p["tab_id"] for e, p in bridge.calls if e == "tab_suspend"]
        assert suspended == ["t002"]
        assert all(t["state"] == TAB_SUSPENDED
                   for t in mgr.list_tabs("a").value["tabs"])

    def test_resume_converges_and_restores_focus(self):
        mgr, bridge = make_manager()
        mgr.open_tab("a", url="https://one.example")
        mgr.open_tab("a", url="https://two.example")   # 焦点 t002
        mgr.suspend_session("a")
        bridge.calls.clear()

        r = mgr.resume_session("a")
        assert r.ok and r.value["restored_tabs"] == 2
        resumed = [p["tab_id"] for e, p in bridge.calls if e == "tab_resume"]
        assert sorted(resumed) == ["t001", "t002"]
        activated = [p["tab_id"] for e, p in bridge.calls if e == "tab_activate"]
        assert activated == ["t002"]                # 焦点还原
        state = mgr.session_state("a").value
        assert state["active_tab_id"] == "t002"
        assert all(t["state"] == TAB_ACTIVE for t in state["tabs"])
        assert state["has_saved_snapshot"] is False  # 快照消费即清

    def test_resume_restores_viewport_of_focus_tab(self):
        mgr, _ = make_manager()
        mgr.open_tab("a", url="https://one.example")
        mgr.set_viewport("a", 390, 844)
        mgr.suspend_session("a")
        r = mgr.resume_session("a")
        assert r.ok
        tab = mgr.session_state("a").value
        focus = tab["active_tab_id"]
        record = next(t for t in tab["tabs"] if t["tab_id"] == focus)
        assert record["viewport"] == {"width": 390, "height": 844}

    def test_resume_without_snapshot_fails(self):
        mgr, _ = make_manager()
        mgr.open_tab("a")
        r = mgr.resume_session("a")
        assert not r.ok and "no saved state" in r.error

    def test_resume_reports_bridge_drift_honestly(self):
        mgr, bridge = make_manager(fail_endpoints={"tab_resume"})
        mgr.open_tab("a", url="https://one.example")
        mgr.suspend_session("a")
        r = mgr.resume_session("a")
        assert r.ok                                  # 状态恢复成功……
        assert r.value["bridge_errors"]              # ……但漂移如实上报
        assert "t001" in r.value["bridge_errors"][0]

    def test_end_session_closes_and_drops_state(self):
        mgr, _ = make_manager()
        mgr.open_tab("a", url="https://one.example")
        mgr.suspend_session("a")
        r = mgr.end_session("a")
        assert r.ok and r.value["closed"] == 1
        assert "no active browser session" in mgr.list_tabs("a").error
        assert not mgr.resume_session("a").ok        # 快照也随之清掉


# ── 4. 视口（每标签独立）────────────────────────────────────────────────────

class TestViewport:

    def test_set_on_focused_and_explicit_tabs(self):
        mgr, bridge = make_manager()
        mgr.open_tab("a", url="https://one.example")
        mgr.open_tab("a", url="https://two.example")
        bridge.calls.clear()

        r = mgr.set_viewport("a", 390, 844)          # 缺省 = 焦点标签
        assert r.ok and r.value["tab_id"] == "t002"
        r = mgr.set_viewport("a", 1280, 800, tab_id="t001")
        assert r.ok and r.value["tab_id"] == "t001"
        vp_calls = [(p["tab_id"], p["width"], p["height"])
                    for e, p in bridge.calls if e == "viewport"]
        assert vp_calls == [("t002", 390, 844), ("t001", 1280, 800)]
        assert mgr.session_state("a").value["tabs"][0]["viewport"] == {"width": 1280, "height": 800}

    def test_reset_clears_override(self):
        mgr, bridge = make_manager()
        mgr.open_tab("a", url="https://one.example")
        mgr.set_viewport("a", 390, 844)
        r = mgr.reset_viewport("a")
        assert r.ok
        payload = [p for e, p in bridge.calls if e == "viewport"][-1]
        assert payload["reset"] is True
        assert mgr.list_tabs("a").value["tabs"][0]["viewport"] is None

    def test_invalid_params_rejected_before_bridge(self):
        mgr, bridge = make_manager()
        mgr.open_tab("a")
        bridge.calls.clear()
        for w, h in ((0, 100), (100, -1), ("wide", 100), (99999, 10)):
            assert not mgr.set_viewport("a", w, h).ok, (w, h)
        assert not mgr.set_viewport("a", 100, 100, tab_id="ghost").ok
        assert not mgr.reset_viewport("a", tab_id="ghost").ok
        assert bridge.calls == []                    # 全部被状态机/校验挡在桥前

    def test_bridge_failure_rolls_back_state(self):
        mgr, _ = make_manager(fail_endpoints={"viewport"})
        mgr.open_tab("a")
        r = mgr.set_viewport("a", 390, 844)
        assert not r.ok
        assert mgr.list_tabs("a").value["tabs"][0]["viewport"] is None  # 未提交，两侧不漂移


# ── 5. 并发任务互不干扰 ─────────────────────────────────────────────────────

class TestConcurrentTasks:

    def test_interleaved_ops_target_their_own_tabs(self):
        mgr, bridge = make_manager()
        mgr.open_tab("a", url="https://a.example")
        mgr.open_tab("b", url="https://b.example")
        bridge.calls.clear()

        mgr.navigate_tab("a", "https://a2.example")  # 各自的焦点标签
        mgr.navigate_tab("b", "https://b2.example")
        navs = [(p["tab_id"], p["url"]) for e, p in bridge.calls if e == "navigate"]
        assert navs == [("t001", "https://a2.example"), ("t002", "https://b2.example")]

    def test_end_session_spares_other_tasks(self):
        mgr, bridge = make_manager()
        mgr.open_tab("a")
        mgr.open_tab("b")
        bridge.calls.clear()
        mgr.end_session("a")
        closed = [p["tab_id"] for e, p in bridge.calls if e == "tab_close"]
        assert closed == ["t001"]
        assert mgr.list_tabs("b").value["live_count"] == 1
        assert not mgr.close_tab("a", "t002").ok     # a 没了，b 的标签更碰不到

    def test_navigate_to_foreign_tab_rejected(self):
        mgr, _ = make_manager()
        mgr.open_tab("a", url="https://a.example")
        mgr.open_tab("b", url="https://b.example")
        r = mgr.navigate_tab("a", "https://evil.example", tab_id="t002")
        assert not r.ok and "unknown tab" in r.error

    def test_background_tab_wake_keeps_focus_story(self):
        mgr, bridge = make_manager()
        mgr.open_tab("a", url="https://one.example")
        mgr.open_tab("a", url="https://two.example")   # 焦点 t002
        mgr.suspend_tab("a", "t001")
        bridge.calls.clear()
        r = mgr.navigate_tab("a", "https://one.example", tab_id="t001")
        assert r.ok
        # 导航即唤醒即展示：状态 active、焦点跟随（Electron 侧同步 showTab）
        assert mgr.session_state("a").value["active_tab_id"] == "t001"
        assert ("tab_activate", {"tab_id": "t001"}) not in bridge.calls  # navigate 自带唤醒
        assert [e for e, _ in bridge.calls if e == "navigate"] == ["navigate"]


# ── 6. 截图就绪（供 CUA 动作层未来复用）─────────────────────────────────────

class TestScreenshotReady:

    def test_capture_saves_png_with_stable_shape(self, tmp_path):
        mgr, _ = make_manager()
        mgr.open_tab("a", url="https://one.example")
        out = tmp_path / "shot.png"
        r = mgr.capture_tab("a", tab_id=None, save_path=str(out))
        assert r.ok
        assert set(r.value.keys()) == {"path", "width", "height", "tab_id", "session_id"}
        assert r.value["width"] == 800 and r.value["height"] == 600
        assert out.exists() and out.stat().st_size > 0
        with open(out, "rb") as f:
            assert f.read(4) == b"\x89PNG"

    def test_capture_default_path_lands_in_workspace(self, tmp_path):
        mgr, _ = make_manager(workspace=str(tmp_path))
        mgr.open_tab("a", url="https://one.example")
        r = mgr.capture_tab("a")
        assert r.ok
        assert str(r.value["path"]).startswith(str(tmp_path / "screenshots"))

    def test_capture_unknown_tab_fails_before_bridge(self):
        mgr, bridge = make_manager()
        mgr.open_tab("a")
        assert not mgr.capture_tab("a", tab_id="ghost").ok
        assert not mgr.capture_tab("never-opened").ok    # 无会话也无焦点
        assert not any(e == "tab_snapshot" for e, _ in bridge.calls)

    def test_capture_bridge_failure_is_a_failure(self):
        mgr, _ = make_manager(fail_endpoints={"tab_snapshot"})
        mgr.open_tab("a")
        r = mgr.capture_tab("a")
        assert not r.ok and "tab_snapshot" in r.error

    def test_capture_wakes_suspended_tab(self):
        mgr, bridge = make_manager()
        mgr.open_tab("a", url="https://one.example")
        mgr.suspend_tab("a", "t001")
        r = mgr.capture_tab("a", tab_id="t001")
        assert r.ok                                  # Electron 唤醒后拍摄
        state = mgr.session_state("a").value
        assert state["active_tab_id"] == "t001"      # 两侧对齐为 active + 焦点


# ── 7. browser_agent 接线 ───────────────────────────────────────────────────

class TestBrowserAgentWiring:

    def _tool_defs(self):
        from browser_agent import BrowserAgent
        domain = type("D", (), {"DOMAIN": "browser"})
        return {td.name: td for td in BrowserAgent._build_tool_defs(domain())}

    def test_session_tools_registered(self):
        defs = self._tool_defs()
        for name in ("tab_open", "tab_switch", "tab_close", "tab_suspend",
                     "tab_resume", "tab_list", "viewport", "tab_screenshot",
                     "session_suspend", "session_resume"):
            assert name in defs, name
        assert defs["tab_switch"].schema["required"] == ["tab_id"]
        assert defs["tab_open"].domain == "browser"

    def test_navigate_routes_through_session(self):
        mgr, bridge = make_manager(titles={"https://one.example": "One"})
        ctx = {"_agent": _AgentShim(mgr)}
        from browser_agent import _navigate
        r = _navigate({"url": "https://one.example"}, ctx)
        assert r.ok
        assert "Navigated to: https://one.example" in r.value
        assert "(Title: One; tab t001)" in r.value
        # 会话内事实同步：一个标签、焦点在其上
        assert mgr.session_state("default").value["active_tab_id"] == "t001"
        assert [e for e, _ in bridge.calls] == ["tab_open"]

    def test_navigate_with_tab_id_targets_that_tab(self):
        mgr, bridge = make_manager()
        mgr.open_tab("a", url="https://one.example")
        mgr.open_tab("a", url="https://two.example")
        bridge.calls.clear()
        from browser_agent import _navigate
        r = _navigate({"url": "https://one.example", "tab_id": "t001", "task_id": "a"},
                      {"_agent": _AgentShim(mgr)})
        assert r.ok
        assert [e for e, _ in bridge.calls] == ["navigate"]
        assert bridge.calls[0][1]["tab_id"] == "t001"

    def test_navigate_rejects_foreign_tab(self):
        mgr, _ = make_manager()
        mgr.open_tab("a")
        mgr.open_tab("b")
        from browser_agent import _navigate
        r = _navigate({"url": "https://x.example", "tab_id": "t002", "task_id": "a"},
                      {"_agent": _AgentShim(mgr)})
        assert not r.ok and "unknown tab" in r.error

    def test_tab_list_tool_formats_focused_marker(self):
        mgr, _ = make_manager()
        mgr.open_tab("a", url="https://one.example")
        mgr.open_tab("a", url="https://two.example")
        from browser_agent import _tab_list
        r = _tab_list({"task_id": "a"}, {"_agent": _AgentShim(mgr)})
        assert r.ok
        assert "(focused)" in r.value
        assert "t001" in r.value and "t002" in r.value

    def test_resolve_task_id_precedence(self):
        assert resolve_task_id({"task_id": "t"}, {"task_id": "c", "session_id": "s"}) == "t"
        assert resolve_task_id({}, {"task_id": "c", "session_id": "s"}) == "c"
        assert resolve_task_id({}, {"session_id": "s"}) == "s"
        assert resolve_task_id({}, {}) == browser_sessions.DEFAULT_TASK_ID

    def test_event_log_is_bounded(self):
        mgr, _ = make_manager()
        for i in range(300):
            mgr.begin_session(f"task-{i}")
            mgr.end_session(f"task-{i}")
        assert len(mgr.event_log) == 200             # deque 上限，不无限生长
