"""test_browser_claim.py — fail-closed 认领协议（U3）。

覆盖:
1. 认领四路: 成功 / 对象消失 / 标题变化 / url 变化
2. 快照比对原始全等: 尾随空格 / 大小写 / 补斜杠 / 子路径全部拒绝——无相似度、
   无 url 前缀豁免、不归一化空白与大小写；失败消息同时携带旧快照与新现状
3. 接管语义: 成功即聚焦、挂起标签顺带唤醒；失败不碰状态、不盖章
4. 编排层: auto_begin=False（认领不偷偷建会话）、跨任务隔离（对方会话零波及
   + 桥零调用）、事件流水只记成功
5. app 域预留: AppClaim 三元组 + claim_app_window 桩
6. 快照/恢复: 认领不污染 snapshot_state 往返

不依赖真实 Electron: 桥客户端注入假实现（记录调用序列，返回形状真实）。

运行: pytest tests/test_browser_claim.py -q
"""
import base64
import time

import pytest

from result import Result

from browser_sessions import (
    TAB_ACTIVE,
    TAB_SUSPENDED,
    AppClaim,
    BrowserSession,
    BrowserSessionManager,
    TabClaim,
)


# ── 测试替身（与 test_browser_sessions.py 同手法）────────────────────────────

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


def _session_with_tab(url="https://one.example", title="One"):
    """纯会话（不碰桥）: 一个标签 t1，标题/url 可定制。"""
    s = BrowserSession(session_id="bs-x", task_id="x")
    s.open_tab("t1", url=url, title=title)
    return s


# ── 1. 认领四路（会话层状态机）───────────────────────────────────────────────

class TestSessionClaimPaths:

    def test_claim_success_focuses_and_stamps(self):
        s = _session_with_tab()
        s.open_tab("t2", url="https://two.example", title="Two")   # 焦点在 t2
        claim = TabClaim(object_id="t1", title_snapshot="One",
                         url_snapshot="https://one.example")
        assert claim.claimed_at_ms == 0
        r = s.claim_tab(claim)
        assert r.ok
        assert set(r.value.keys()) == {"tab", "claim"}              # tab 记录 + claim 回执
        assert r.value["claim"] is claim                            # 回执就是凭据本体
        assert r.value["tab"]["tab_id"] == "t1"
        assert claim.claimed_at_ms > 10**12                          # 毫秒纪元时间戳
        assert s.active_tab_id == "t1"                               # 接管即聚焦
        assert s.get_tab("t1").state == TAB_ACTIVE

    def test_claim_wakes_suspended_tab(self):
        s = _session_with_tab()
        s.suspend_tab("t1")
        r = s.claim_tab(TabClaim(object_id="t1", title_snapshot="One",
                                 url_snapshot="https://one.example"))
        assert r.ok
        assert s.get_tab("t1").state == TAB_ACTIVE                   # 挂起标签被唤醒
        assert s.active_tab_id == "t1"                               # 并夺焦点

    def test_claim_missing_tab_rejected(self):
        s = _session_with_tab()
        r = s.claim_tab(TabClaim(object_id="ghost", title_snapshot="One",
                                 url_snapshot="https://one.example"))
        assert not r.ok
        assert "ghost" in r.error
        assert "不存在" in r.error and "可能已关闭" in r.error

    def test_claim_closed_tab_rejected_as_missing(self):
        s = _session_with_tab()
        s.close_tab("t1")                                            # closed 是终态
        r = s.claim_tab(TabClaim(object_id="t1", title_snapshot="One",
                                 url_snapshot="https://one.example"))
        assert not r.ok
        assert "不存在" in r.error and "可能已关闭" in r.error

    def test_claim_title_changed_rejected_with_both_snapshots(self):
        s = _session_with_tab()
        s.note_navigation("t1", "https://one.example", title="One — Updated")
        claim = TabClaim(object_id="t1", title_snapshot="One",
                         url_snapshot="https://one.example")
        r = s.claim_tab(claim)
        assert not r.ok
        # 旧快照与新现状同屏出现，请用户自己判断要谁
        assert ("引用时: One | https://one.example → "
                "当前: One — Updated | https://one.example") in r.error
        assert "请重新引用后再认领" in r.error
        assert claim.claimed_at_ms == 0                              # 失败不盖章

    def test_claim_url_changed_rejected_with_both_snapshots(self):
        s = _session_with_tab()
        s.note_navigation("t1", "https://one.example/next", title="One")
        r = s.claim_tab(TabClaim(object_id="t1", title_snapshot="One",
                                 url_snapshot="https://one.example"))
        assert not r.ok
        assert ("引用时: One | https://one.example → "
                "当前: One | https://one.example/next") in r.error
        assert "请重新引用后再认领" in r.error

    def test_failed_claim_leaves_state_untouched(self):
        s = _session_with_tab()
        s.open_tab("t2", url="https://two.example", title="Two")
        s.suspend_tab("t1")                                          # t1 挂起、焦点 t2
        r = s.claim_tab(TabClaim(object_id="t1", title_snapshot="Stale",
                                 url_snapshot="https://one.example"))
        assert not r.ok
        assert s.get_tab("t1").state == TAB_SUSPENDED                # 不因认领失败被唤醒
        assert s.active_tab_id == "t2"                               # 焦点也没被挪动


# ── 2. 近似一律拒绝（无相似度 / 无前缀豁免 / 不归一化）───────────────────────

class TestClaimStrictEquality:

    def _claim(self, title, url):
        return TabClaim(object_id="t1", title_snapshot=title, url_snapshot=url)

    def test_trailing_whitespace_is_not_normalized(self):
        s = _session_with_tab()                                      # 标题 "One"
        assert not s.claim_tab(self._claim("One ", "https://one.example")).ok
        assert not s.claim_tab(self._claim(" One", "https://one.example")).ok

    def test_case_difference_is_not_normalized(self):
        s = _session_with_tab()
        assert not s.claim_tab(self._claim("one", "https://one.example")).ok
        assert not s.claim_tab(self._claim("ONE", "https://one.example")).ok

    def test_added_trailing_slash_is_not_forgiven(self):
        s = _session_with_tab()                                      # url 无尾斜杠
        r = s.claim_tab(self._claim("One", "https://one.example/"))
        assert not r.ok and "对象已变化" in r.error

    def test_subpath_is_not_a_prefix_match(self):
        s = _session_with_tab()
        r = s.claim_tab(self._claim("One", "https://one.example/sub"))
        assert not r.ok and "对象已变化" in r.error

    def test_empty_snapshot_never_matches_populated_record(self):
        s = _session_with_tab()
        assert not s.claim_tab(TabClaim(object_id="t1")).ok          # 缺省空快照

    def test_empty_matches_empty_only(self):
        s = BrowserSession(session_id="bs-x", task_id="x")
        s.open_tab("t1")                                             # 无 url 无标题
        r = s.claim_tab(TabClaim(object_id="t1"))
        assert r.ok                                                  # 两边皆空 = 全等
        assert s.active_tab_id == "t1"


# ── 3. 凭据资格 / 盖章纪律 / 快照往返 ────────────────────────────────────────

class TestSessionClaimGuards:

    def test_wrong_kind_claim_rejected(self):
        s = _session_with_tab()
        r = s.claim_tab(TabClaim(object_id="t1", title_snapshot="One",
                                 url_snapshot="https://one.example", kind="window"))
        assert not r.ok and "凭据" in r.error

    def test_non_tab_claim_object_rejected_not_raised(self):
        s = _session_with_tab()
        r = s.claim_tab(AppClaim(window_title="One", process_id=42, started_at_ms=1))
        assert not r.ok                                              # Result 纪律: 不抛异常

    def test_claimed_at_ms_stamped_only_on_success(self):
        s = _session_with_tab()
        bad = TabClaim(object_id="t1", title_snapshot="Stale", url_snapshot="x")
        s.claim_tab(bad)
        assert bad.claimed_at_ms == 0                                # 失败不盖章
        good = TabClaim(object_id="t1", title_snapshot="One",
                        url_snapshot="https://one.example")
        before = int(time.time() * 1000)
        s.claim_tab(good)
        assert good.claimed_at_ms >= before                          # 成功才盖章

    def test_claim_does_not_pollute_snapshot_roundtrip(self):
        s = _session_with_tab()
        s.open_tab("t2", url="https://two.example", title="Two")
        s.claim_tab(TabClaim(object_id="t1", title_snapshot="One",
                             url_snapshot="https://one.example"))
        snap = s.snapshot_state()
        assert set(snap["tabs"][0].keys()) == {
            "tab_id", "url", "title", "state", "viewport", "opened_at"}
        s2 = BrowserSession(session_id="bs-x", task_id="x")
        r = s2.restore_state(snap)
        assert r.ok
        assert s2.get_tab("t1").state == TAB_ACTIVE
        assert s2.get_tab("t1").title == "One"


# ── 4. 编排层: 会话门槛 / 跨任务隔离 / 事件流水 ─────────────────────────────

class TestManagerClaim:

    def test_claim_success_keeps_python_focus_story(self):
        mgr, bridge = make_manager(titles={"https://one.example": "One",
                                           "https://two.example": "Two"})
        mgr.open_tab("a", url="https://one.example")
        mgr.open_tab("a", url="https://two.example")                 # 焦点 t002
        bridge.calls.clear()
        claim = TabClaim(object_id="t001", title_snapshot="One",
                         url_snapshot="https://one.example")
        r = mgr.claim_tab("a", claim)
        assert r.ok
        assert r.value["tab"]["tab_id"] == "t001"
        assert r.value["claim"] is claim
        assert claim.claimed_at_ms > 10**12
        state = mgr.session_state("a").value
        assert state["active_tab_id"] == "t001"                      # 接管即聚焦
        assert state["tabs"][0]["state"] == TAB_ACTIVE
        # 认领是纯状态编排，桥零调用；Electron 聚焦由编排层后续 tab_activate 收敛
        assert bridge.calls == []
        assert mgr.event_log[-1]["event"] == "claim_tab"
        assert mgr.event_log[-1]["tab_id"] == "t001"

    def test_claim_never_secretly_begins_a_session(self):
        mgr, bridge = make_manager()
        claim = TabClaim(object_id="t001", title_snapshot="One", url_snapshot="x")
        r = mgr.claim_tab("ghost-task", claim)
        assert not r.ok
        assert "no active browser session" in r.error                 # 既有失败原样透出
        assert "no active browser session" in mgr.list_tabs("ghost-task").error
        assert bridge.calls == []                                     # 没建会话也没碰桥

    def test_claim_cross_task_isolated_and_zero_bridge_calls(self):
        mgr, bridge = make_manager()
        mgr.open_tab("a", url="https://a.example")
        mgr.open_tab("b", url="https://b.example")                    # b 家的 t002
        bridge.calls.clear()
        r = mgr.claim_tab("a", TabClaim(object_id="t002", title_snapshot="Page 2",
                                        url_snapshot="https://b.example"))
        assert not r.ok
        assert "不属于当前任务会话" in r.error
        # 对方会话零波及
        b_state = mgr.session_state("b").value
        assert b_state["tabs"][0]["state"] == TAB_ACTIVE
        assert b_state["active_tab_id"] == "t002"
        assert bridge.calls == []                                     # 桥零调用
        assert all(ev["event"] != "claim_tab" for ev in mgr.event_log)

    def test_claim_ghost_id_treated_as_foreign(self):
        mgr, _ = make_manager()
        mgr.open_tab("a", url="https://a.example")
        r = mgr.claim_tab("a", TabClaim(object_id="t999", title_snapshot="x",
                                        url_snapshot="y"))
        assert not r.ok and "不属于当前任务会话" in r.error

    def test_claim_wakes_suspended_tab_through_manager(self):
        mgr, _ = make_manager(titles={"https://one.example": "One"})
        mgr.open_tab("a", url="https://one.example")
        mgr.suspend_tab("a", "t001")
        r = mgr.claim_tab("a", TabClaim(object_id="t001", title_snapshot="One",
                                        url_snapshot="https://one.example"))
        assert r.ok
        state = mgr.session_state("a").value
        assert state["active_tab_id"] == "t001"
        assert state["tabs"][0]["state"] == TAB_ACTIVE

    def test_failed_claim_is_not_logged(self):
        mgr, _ = make_manager()
        mgr.open_tab("a", url="https://one.example")
        mgr.claim_tab("a", TabClaim(object_id="t001", title_snapshot="Stale",
                                    url_snapshot="https://one.example"))
        assert all(ev["event"] != "claim_tab" for ev in mgr.event_log)


# ── 5. app 域预留 ────────────────────────────────────────────────────────────

class TestAppClaimReserved:

    def test_app_claim_carries_triple(self):
        c = AppClaim(window_title="文档.docx - 编辑器", process_id=4242, started_at_ms=99)
        assert (c.window_title, c.process_id, c.started_at_ms) == \
            ("文档.docx - 编辑器", 4242, 99)
        assert AppClaim().window_title == ""
        assert AppClaim().process_id == 0
        assert AppClaim().started_at_ms == 0

    def test_claim_app_window_is_a_reserved_stub(self):
        mgr, bridge = make_manager()
        r = mgr.claim_app_window("a", AppClaim(window_title="X", process_id=1,
                                               started_at_ms=1))
        assert not r.ok
        assert "预留" in r.error and "远程执行" in r.error
        assert bridge.calls == []
