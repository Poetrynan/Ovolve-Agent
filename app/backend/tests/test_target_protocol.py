"""test_target_protocol.py — 桌面/浏览器统一 Target 协议（U4）。

覆盖:
1. TargetRef: 三形态解析 + None 缺省 + 非法形态拒绝（消息列全部合法形态）
   + format 往返一致
2. ObserveResult: 形状与诚实失败位默认值
3. TargetBackend 协议: runtime_checkable 鸭子判定（两实现同过、缺方法不过）
4. 双域参数化: observe 同形状同产物；同一动作同一参数的权限结论两域逐字
   一致，且与 registry.check_permission 直查相同（单源同判哨兵）
5. 桌面 Target 后端: observe 截图+OCR、act 走 registry 闭环（反馈/降级不丢）
6. 浏览器 Target 后端: 六支持动作 + claim 三类失败原样文案 + 不支持动作
   诚实失败（消息含动作名）+ observe 诚实失败路径
7. TargetRouter: 注册校验、未注册域诚实失败、未知动作、tab 自有动作走
   BROWSER_ACTION_SPECS（window_focus 语义）+ 场景地板照常生效
8. 零回归哨兵: CuaDesktopBackend/registry 直接用（不走协议）结果不变

全程假桥/假引擎/假 OCR/假规则——不连真桥、不截真屏、不碰 SQLite。

运行: pytest tests/test_target_protocol.py -q
"""
import base64
import os

import pytest
from PIL import Image

from result import Result
from gui_action_classifier import GUI_TOOLS
from permission_rules import PermissionRule, RuleBehavior

import cua_actions
from browser_sessions import BrowserSessionManager, TabClaim
from cua_actions import (
    BROWSER_ACTION_SPECS,
    RESULT_KEYS,
    BrowserTargetBackend,
    CuaActionRegistry,
    CuaActionResult,
    CuaDesktopBackend,
    DesktopTargetBackend,
    ObserveResult,
    TargetBackend,
    TargetRef,
    TargetRouter,
    format_target_ref,
    parse_target_ref,
)

TAB_REF = "tab:task-a/t001"


# ── 测试替身（与 test_cua_actions / test_browser_sessions 同手法）────────────

class FakeEngine:
    """native_desktop 引擎形状替身：记录点击与键入，不碰真桌面。"""

    def __init__(self, fail_capture=False):
        self.clicks = []
        self.typed = []
        self.fail_capture = fail_capture

    def capture_screen(self, roi=None, quality=80, max_dim=1920):
        if self.fail_capture:
            raise RuntimeError("capture exploded (injected)")
        return {"image": Image.new("RGB", (16, 16), (255, 255, 255)),
                "width": 16, "height": 16, "scale_factor": 1.0,
                "data_uri": "data:image/jpeg;base64,FAKE"}

    def click(self, x=None, y=None, button="left", clicks=1):
        self.clicks.append((x, y, button, clicks))

    def move_cursor(self, x, y, smooth=True, duration=0.2):
        pass

    def scroll(self, clicks, x=None, y=None):
        pass

    def drag(self, sx, sy, ex, ey, duration=0.5):
        pass

    def type_unicode(self, text, delay_per_char=0.01):
        self.typed.append(text)

    def press_key(self, key_combo):
        pass


def fake_ocr_ok(path):
    """两行固定 OCR 结果——两域 observe 的共同产物基线。"""
    return Result.success({
        "text": "文件\n确定",
        "lines": [
            {"text": "文件", "bbox": [[0, 0], [10, 0], [10, 10], [0, 10]],
             "confidence": 0.9},
            {"text": "确定", "bbox": [[50, 0], [60, 0], [60, 10], [50, 10]],
             "confidence": 0.9},
        ],
    })


def fake_ocr_fail(path):
    return Result.failure("PaddleOCR not available", code="OCRUnavailable")


class FakeRules:
    """permission_rules.PermissionRuleStore 的形状替身：只实现 match()。"""

    def __init__(self, behavior=None, note=""):
        self.behavior = behavior
        self.note = note

    def match(self, tool_name, args, workspace_root="", session_id=""):
        if self.behavior is None:
            return None
        return PermissionRule(tool_name=tool_name, behavior=self.behavior,
                              note=self.note, source="user")


class FakeBridge:
    """ElectronBrowserClient 形状替身：记录 (endpoint, payload) 调用序列。"""

    def __init__(self, fail_endpoints=(), titles=None):
        self.calls = []
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
            return Result.success({"tab_id": payload.get("tab_id"), "url": url,
                                   "title": self.titles.get(url, default)})
        if endpoint == "navigate":
            url = payload.get("url", "")
            return Result.success({"url": url,
                                   "title": self.titles.get(url, "Page Title")})
        if endpoint == "tab_snapshot":
            png = base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode("ascii")
            return Result.success({"tab_id": payload.get("tab_id"),
                                   "dataUri": f"data:image/png;base64,{png}",
                                   "width": 800, "height": 600})
        return Result.success({"tab_id": payload.get("tab_id")})


def seq_ids(prefix="t"):
    box = {"n": 0}

    def factory():
        box["n"] += 1
        return f"{prefix}{box['n']:03d}"

    return factory


def make_manager(fail_endpoints=(), titles=None, workspace=None):
    bridge = FakeBridge(fail_endpoints=fail_endpoints, titles=titles)
    mgr = BrowserSessionManager(client=bridge, workspace=workspace,
                                id_factory=seq_ids())
    return mgr, bridge


def make_desktop_target(rules=None, engine=None, ocr=fake_ocr_ok):
    """桌面 Target 后端 + 它唯一共享的注册表（权限单源的物质基础）。"""
    reg = CuaActionRegistry(
        backend=CuaDesktopBackend(engine=engine or FakeEngine(), ocr_fn=ocr),
        ocr_fn=ocr, rules=rules if rules is not None else FakeRules())
    return DesktopTargetBackend(registry=reg), reg


def make_router(rules=None, with_tab=False, titles=None):
    """双域路由器：router 与桌面后端共享同一注册表（单源同判的实体）。"""
    mgr, bridge = make_manager(titles=titles)
    if with_tab:
        mgr.open_tab("task-a", url="https://one.example")
    desktop, reg = make_desktop_target(rules=rules)
    browser = BrowserTargetBackend(manager=mgr, ocr_fn=fake_ocr_ok)
    router = TargetRouter(registry=reg)
    router.register_backend("desktop", desktop)
    router.register_backend("tab", browser)
    return router, reg, mgr, bridge


# ── 1. TargetRef：解析 / 格式化 ──────────────────────────────────────────────

class TestTargetRefParsing:

    def test_none_defaults_to_whole_desktop(self):
        assert parse_target_ref(None) == TargetRef("desktop", "", "0")

    def test_desktop_form(self):
        assert parse_target_ref("desktop:0") == TargetRef("desktop", "", "0")

    def test_tab_form(self):
        assert parse_target_ref("tab:task-a/t001") == \
            TargetRef("tab", "task-a", "t001")

    def test_app_form(self):
        assert parse_target_ref("app:4321") == TargetRef("app", "", "4321")

    @pytest.mark.parametrize("bad", [
        "", "   ",                    # 空串
        "desktop",                    # 缺分隔符
        "printer:1",                  # 未知域
        "desktop:",                   # 缺对象号
        "tab:s1", "tab:/t001", "tab:s1/", "tab:a/b/c",   # 坏分隔
        "app:abc", "desktop:x9",      # 非数字对象号
    ])
    def test_invalid_forms_raise_value_error(self, bad):
        with pytest.raises(ValueError):
            parse_target_ref(bad)

    @pytest.mark.parametrize("bad", ["", "printer:1", "app:abc"])
    def test_error_message_lists_all_legal_forms(self, bad):
        with pytest.raises(ValueError) as ei:
            parse_target_ref(bad)
        msg = str(ei.value)
        assert "desktop:0" in msg and "tab:" in msg and "app:" in msg

    @pytest.mark.parametrize("ref,expected", [
        (TargetRef("desktop", "", "0"), "desktop:0"),
        (TargetRef("tab", "task-a", "t001"), "tab:task-a/t001"),
        (TargetRef("app", "", "4321"), "app:4321"),
    ])
    def test_format_round_trip(self, ref, expected):
        assert format_target_ref(ref) == expected
        assert parse_target_ref(expected) == ref

    def test_format_rejects_unknown_kind(self):
        with pytest.raises(ValueError):
            format_target_ref(TargetRef("printer", "", "1"))


# ── 2. ObserveResult 与协议 ──────────────────────────────────────────────────

class TestObserveResultContract:

    def test_defaults_are_success_with_empty_payload(self):
        r = ObserveResult(ocr_lines=[])
        assert r.ok is True and r.error == ""
        assert r.screenshot_path == "" and r.meta == {}

    def test_honest_failure_shape(self):
        r = ObserveResult(ocr_lines=[], ok=False, error="OCR 不可用: x",
                          screenshot_path="/tmp/s.png")
        assert not r.ok and "OCR" in r.error
        assert r.screenshot_path == "/tmp/s.png"


class TestTargetBackendProtocol:

    def test_both_implementations_satisfy_protocol(self):
        d, _ = make_desktop_target()
        b = BrowserTargetBackend(manager=make_manager()[0], ocr_fn=fake_ocr_ok)
        assert isinstance(d, TargetBackend)
        assert isinstance(b, TargetBackend)

    def test_object_without_protocol_face_is_rejected(self):
        class Half:
            name = "half"

            def observe(self, target_ref, ctx=None):
                return ObserveResult(ocr_lines=[])

        assert not isinstance(Half(), TargetBackend)


# ── 3. 双域参数化：observe 同形状；权限单源同判 ──────────────────────────────

PERMISSION_CASES = [
    # (action, params, ctx, 期望拒绝)——覆盖 CONFIRM / HANDOFF / AWARE / 放行
    ("fill", {"x": 1, "y": 2, "text": "password123"}, {}, True),
    ("click", {"selector": "#g-recaptcha"}, {"confirmed": True}, True),
    ("click", {"selector": "button:has-text('注册账号')"}, {}, True),
    ("scroll", {"clicks": 3}, {}, False),
    ("click", {"x": 1, "y": 2}, {"pre_approval_source": "tool_result"}, False),
]


class TestDualDomain:

    def test_observe_returns_same_shape_both_domains(self, tmp_path):
        d, _ = make_desktop_target()
        mgr, _ = make_manager()
        mgr.open_tab("task-a", url="https://one.example")
        b = BrowserTargetBackend(manager=mgr, ocr_fn=fake_ocr_ok)
        ctx = {"cua_screenshot_dir": str(tmp_path)}
        od = d.observe(parse_target_ref("desktop:0"), ctx)
        ob = b.observe(parse_target_ref(TAB_REF), ctx)
        assert isinstance(od, ObserveResult) and isinstance(ob, ObserveResult)
        for r in (od, ob):
            assert r.ok and r.ocr_lines == ["文件", "确定"]
            assert r.screenshot_path and os.path.exists(r.screenshot_path)
            assert r.screenshot_path.startswith(str(tmp_path))
        assert od.meta["target_ref"] == "desktop:0"
        assert ob.meta["target_ref"] == TAB_REF
        assert ob.meta["tab_id"] == "t001"

    def test_observe_via_router_facade_both_domains(self, tmp_path):
        router, _, _, _ = make_router(with_tab=True)
        ctx = {"cua_screenshot_dir": str(tmp_path)}
        od = router.observe("desktop:0", ctx)
        ob = router.observe(TAB_REF, ctx)
        assert od.ok and ob.ok
        assert od.ocr_lines == ob.ocr_lines

    @pytest.mark.parametrize("action,params,ctx,refused", PERMISSION_CASES)
    def test_permission_verdicts_identical_across_domains(
            self, action, params, ctx, refused):
        router, reg, _, _ = make_router()
        direct_ok, direct_reason = reg.check_permission(
            reg.get(action), dict(params), dict(ctx))
        assert direct_ok is (not refused)      # 哨兵：直查与预期档位一致
        d = router.act("desktop:0", action, dict(params), dict(ctx))
        b = router.act(TAB_REF, action, dict(params), dict(ctx))
        if refused:
            # 两域拒绝逐字一致，且与 check_permission 直查相同——单源同判
            assert not d.ok and not b.ok
            assert d.error == b.error == direct_reason
        else:
            assert direct_ok and direct_reason == ""
            assert d.ok                        # 桌面域真的执行了
            # 浏览器域：放行之后才判能力——不支持的动作报能力事实而非权限话术
            if not b.ok:
                assert f"暂不支持动作 {action}" in b.error

    def test_refusal_never_reaches_desktop_engine(self):
        router, reg, _, _ = make_router()
        d = router.act("desktop:0", "fill",
                       {"x": 1, "y": 2, "text": "password123"}, {})
        assert not d.ok
        engine = reg.backend._engine
        assert engine.clicks == [] and engine.typed == []


# ── 4. 桌面 Target 后端（闭环零损耗）─────────────────────────────────────────

class TestDesktopTargetBackend:

    def test_act_runs_full_registry_closed_loop(self, tmp_path):
        d, reg = make_desktop_target()
        r = d.act(parse_target_ref("desktop:0"), "click", {"x": 3, "y": 4},
                  {"cua_screenshot_dir": str(tmp_path)})
        assert r.ok
        assert r.value["action"] == "click" and r.value["ok"] is True
        assert r.value["screenshot_path"].startswith(str(tmp_path))
        assert "基线" in r.value["ocr_summary"]      # U1 diff 首帧宣布建基线
        assert reg.backend._engine.clicks == [(3, 4, "left", 1)]

    def test_act_refusal_keeps_registry_reason(self):
        d, _ = make_desktop_target()
        r = d.act(parse_target_ref("desktop:0"), "fill",
                  {"x": 1, "y": 2, "text": "password123"}, {})
        assert not r.ok and "单独确认" in r.error
        assert r.meta.get("action") == "fill"

    def test_observe_screenshot_failure_is_honest(self):
        d, _ = make_desktop_target(engine=FakeEngine(fail_capture=True))
        r = d.observe(parse_target_ref("desktop:0"), {})
        assert not r.ok and "观察截图失败" in r.error and r.ocr_lines == []

    def test_observe_ocr_failure_keeps_screenshot(self):
        d, _ = make_desktop_target(ocr=fake_ocr_fail)
        r = d.observe(parse_target_ref("desktop:0"), {})
        assert not r.ok and "OCR" in r.error and r.screenshot_path


# ── 5. 浏览器 Target 后端：动作 ──────────────────────────────────────────────

class TestBrowserTargetBackendActions:

    def _backend(self, fail_endpoints=(), titles=None):
        mgr, bridge = make_manager(fail_endpoints=fail_endpoints, titles=titles)
        b = BrowserTargetBackend(manager=mgr, ocr_fn=fake_ocr_ok)
        return b, mgr, bridge

    def test_navigate_ok_and_state_committed(self):
        b, mgr, bridge = self._backend()
        mgr.open_tab("task-a", url="https://one.example")
        bridge.calls.clear()
        r = b.act(parse_target_ref(TAB_REF), "navigate",
                  {"url": "https://two.example"}, {})
        assert r.ok and r.value["url"] == "https://two.example"
        assert ("navigate", {"url": "https://two.example", "visible": True,
                             "tab_id": "t001"}) in bridge.calls
        assert mgr.session_state("task-a").value["tabs"][0]["url"] == \
            "https://two.example"

    def test_navigate_bad_url_blocked_before_bridge(self):
        b, _, bridge = self._backend()
        r = b.act(parse_target_ref(TAB_REF), "navigate",
                  {"url": "javascript:alert(1)"}, {})
        assert not r.ok and "http(s)" in r.error
        assert bridge.calls == []              # 复用 validate_url，挡在桥前

    def test_navigate_foreign_tab_passes_manager_verbatim(self):
        b, mgr, _ = self._backend()
        mgr.open_tab("task-b", url="https://b.example")
        r = b.act(parse_target_ref("tab:task-a/t001"), "navigate",
                  {"url": "https://evil.example"}, {})
        direct = mgr.navigate_tab("task-a", "https://evil.example", tab_id="t001")
        assert not r.ok and r.error == direct.error
        assert "unknown tab" in r.error

    def test_activate_focuses_and_wakes(self):
        b, mgr, bridge = self._backend()
        mgr.open_tab("task-a", url="https://one.example")
        mgr.open_tab("task-a", url="https://two.example")
        mgr.suspend_tab("task-a", "t001")
        bridge.calls.clear()
        r = b.act(parse_target_ref("tab:task-a/t001"), "activate", {}, {})
        assert r.ok and r.value["state"] == "active"
        assert ("tab_activate", {"tab_id": "t001"}) in bridge.calls
        assert mgr.session_state("task-a").value["active_tab_id"] == "t001"

    def test_activate_unknown_tab_message_verbatim(self):
        b, mgr, _ = self._backend()
        mgr.open_tab("task-a", url="https://one.example")
        r = b.act(parse_target_ref("tab:task-a/ghost"), "activate", {}, {})
        direct = mgr.activate_tab("task-a", "ghost")
        assert not r.ok and r.error == direct.error
        assert "unknown tab" in r.error

    def test_close_terminal_state_message_verbatim(self):
        b, mgr, _ = self._backend()
        mgr.open_tab("task-a", url="https://one.example")
        assert b.act(parse_target_ref(TAB_REF), "close", {}, {}).ok
        r = b.act(parse_target_ref(TAB_REF), "close", {}, {})
        direct = mgr.close_tab("task-a", "t001")
        assert not r.ok and r.error == direct.error
        assert "already closed" in r.error

    def test_suspend_and_resume_strict_transitions(self):
        b, mgr, _ = self._backend()
        mgr.open_tab("task-a", url="https://one.example")
        assert b.act(parse_target_ref(TAB_REF), "suspend", {}, {}).ok
        r_again = b.act(parse_target_ref(TAB_REF), "suspend", {}, {})
        assert not r_again.ok and "cannot be suspended" in r_again.error
        assert b.act(parse_target_ref(TAB_REF), "resume", {}, {}).ok
        r_not = b.act(parse_target_ref(TAB_REF), "resume", {}, {})
        assert not r_not.ok and "cannot be resumed" in r_not.error

    def test_claim_success_receipt(self):
        b, mgr, bridge = self._backend(titles={"https://one.example": "One"})
        mgr.open_tab("task-a", url="https://one.example")
        mgr.open_tab("task-a", url="https://two.example")   # 焦点在 t002
        bridge.calls.clear()
        r = b.act(parse_target_ref("tab:task-a/t001"), "claim",
                  {"title_snapshot": "One",
                   "url_snapshot": "https://one.example"}, {})
        assert r.ok
        claim = r.value["claim"]
        assert isinstance(claim, TabClaim) and claim.claimed_at_ms > 0
        assert r.value["tab"]["tab_id"] == "t001"
        assert mgr.session_state("task-a").value["active_tab_id"] == "t001"
        assert bridge.calls == []              # 认领只提交 Python 侧事实，桥零调用

    def test_claim_three_failures_pass_messages_through_verbatim(self):
        b, mgr, _ = self._backend(titles={"https://one.example": "One"})
        mgr.open_tab("task-a", url="https://one.example")
        params = {"title_snapshot": "One", "url_snapshot": "https://one.example"}

        # ① 无会话的任务
        r_none = b.act(parse_target_ref("tab:task-none/t001"), "claim",
                       dict(params), {})
        direct_none = mgr.claim_tab("task-none", TabClaim(object_id="t001"))
        assert not r_none.ok and r_none.error == direct_none.error

        # ② 快照不符（fail-closed 比对）
        r_stale = b.act(parse_target_ref("tab:task-a/t001"), "claim",
                        {"title_snapshot": "旧标题",
                         "url_snapshot": "https://one.example"}, {})
        direct_stale = mgr.claim_tab("task-a", TabClaim(
            object_id="t001", title_snapshot="旧标题",
            url_snapshot="https://one.example"))
        assert not r_stale.ok and r_stale.error == direct_stale.error
        assert "对象已变化" in r_stale.error

        # ③ 标签不属于当前任务会话
        mgr.begin_session("task-b")
        r_foreign = b.act(parse_target_ref("tab:task-b/t001"), "claim",
                          dict(params), {})
        direct_foreign = mgr.claim_tab("task-b", TabClaim(
            object_id="t001", title_snapshot="One",
            url_snapshot="https://one.example"))
        assert not r_foreign.ok and r_foreign.error == direct_foreign.error
        assert "不属于当前任务会话" in r_foreign.error

    @pytest.mark.parametrize("action", [
        "click", "fill", "hover", "drag", "keypress",
        "screenshot", "element_info", "wait", "teleport"])
    def test_unsupported_actions_fail_honestly_with_action_name(self, action):
        b, _, bridge = self._backend()
        r = b.act(parse_target_ref(TAB_REF), action, {"x": 1, "y": 2}, {})
        assert not r.ok
        assert f"浏览器后端暂不支持动作 {action}" in r.error
        assert bridge.calls == []              # 绝不假装执行

    def test_supported_actions_set_aligned_with_specs(self):
        assert BrowserTargetBackend.SUPPORTED_ACTIONS == \
            set(BROWSER_ACTION_SPECS) | {"navigate"}
        assert "navigate" not in BROWSER_ACTION_SPECS   # navigate 是共享动作

    def test_act_rejects_non_tab_ref(self):
        b, _, _ = self._backend()
        r = b.act(parse_target_ref("desktop:0"), "activate", {}, {})
        assert not r.ok and "tab" in r.error


# ── 6. 浏览器 Target 后端：observe ───────────────────────────────────────────

class TestBrowserTargetBackendObserve:

    def _backend(self, fail_endpoints=(), ocr=fake_ocr_ok):
        mgr, bridge = make_manager(fail_endpoints=fail_endpoints)
        mgr.open_tab("task-a", url="https://one.example")
        return BrowserTargetBackend(manager=mgr, ocr_fn=ocr), mgr, bridge

    def test_observe_captures_and_extracts_lines(self, tmp_path):
        b, _, bridge = self._backend()
        r = b.observe(parse_target_ref(TAB_REF),
                      {"cua_screenshot_dir": str(tmp_path)})
        assert r.ok and r.ocr_lines == ["文件", "确定"]
        assert os.path.exists(r.screenshot_path)
        assert r.meta["tab_id"] == "t001"
        assert any(e == "tab_snapshot" for e, _ in bridge.calls)

    def test_observe_unknown_tab_is_honest_failure(self):
        b, _, bridge = self._backend()
        r = b.observe(parse_target_ref("tab:task-a/ghost"), {})
        assert not r.ok and "unknown tab" in r.error
        assert not any(e == "tab_snapshot" for e, _ in bridge.calls)

    def test_observe_without_session_is_honest_failure(self):
        b, _, _ = self._backend()
        r = b.observe(parse_target_ref("tab:ghost-task/t001"), {})
        assert not r.ok and "no active browser session" in r.error

    def test_observe_bridge_failure_is_honest(self):
        b, _, _ = self._backend(fail_endpoints={"tab_snapshot"})
        r = b.observe(parse_target_ref(TAB_REF), {})
        assert not r.ok and "tab_snapshot" in r.error

    def test_observe_ocr_failure_keeps_screenshot(self):
        b, _, _ = self._backend(ocr=fake_ocr_fail)
        r = b.observe(parse_target_ref(TAB_REF), {})
        assert not r.ok and "OCR" in r.error and r.screenshot_path


# ── 7. TargetRouter：注册 / 解析 / 权限单源 ──────────────────────────────────

class TestTargetRouter:

    def test_register_unknown_kind_raises(self):
        router = TargetRouter(registry=make_desktop_target()[1])
        with pytest.raises(ValueError) as ei:
            router.register_backend("printer", object())
        msg = str(ei.value)
        assert "desktop" in msg and "tab" in msg and "app" in msg

    def test_resolve_unregistered_kind_is_honest_failure(self):
        router = TargetRouter(registry=make_desktop_target()[1])
        router.register_backend("desktop", make_desktop_target()[0])
        r = router.resolve("tab:task-a/t001")
        assert not r.ok and "未注册" in r.error
        ra = router.act("tab:task-a/t001", "activate", {}, {})
        assert not ra.ok and "未注册" in ra.error
        ob = router.observe("tab:task-a/t001", {})
        assert not ob.ok and "未注册" in ob.error

    def test_resolve_accepts_target_ref_instance(self):
        router, _, _, _ = make_router()
        r = router.resolve(TargetRef("desktop", "", "0"))
        assert r.ok and r.value.name == "desktop"

    def test_malformed_ref_via_router_lists_legal_forms(self):
        router, _, _, _ = make_router()
        r = router.act("app:abc", "activate", {}, {})
        assert not r.ok and "desktop:0" in r.error and "app:" in r.error
        ob = router.observe("nonsense", {})
        assert not ob.ok and "desktop:0" in ob.error

    def test_unknown_action_lists_available_names(self):
        router, _, _, _ = make_router()
        r = router.act("desktop:0", "teleport", {}, {})
        assert not r.ok and "未知动作" in r.error and "navigate" in r.error
        rb = router.act(TAB_REF, "teleport", {}, {})
        assert not rb.ok and "activate" in rb.error   # tab 域清单含自有动作

    def test_desktop_domain_has_no_tab_own_action(self):
        router, _, _, _ = make_router()
        r = router.act("desktop:0", "activate", {}, {})
        assert not r.ok and "未知动作" in r.error

    def test_tab_own_actions_declared_with_real_guard_tools(self):
        for spec in BROWSER_ACTION_SPECS.values():
            assert spec.guard_tool in GUI_TOOLS    # 只映射既有词表，不造新工具名
            assert spec.description                # 每个声明带中文说明

    def test_claim_spec_maps_to_window_focus_semantics(self):
        spec = BROWSER_ACTION_SPECS["claim"]
        assert spec.guard_tool == "window_focus"
        assert spec.name not in {s.name for s in cua_actions.ACTION_SPECS}

    def test_shared_action_spec_is_the_same_object_as_registry(self):
        router, reg, _, _ = make_router()
        assert router._spec_for("tab", "navigate") is reg.get("navigate")
        assert router._spec_for("desktop", "navigate") is reg.get("navigate")

    def test_tab_own_action_permission_goes_through_registry(self):
        router, _, _, _ = make_router(with_tab=True)
        r = router.act(TAB_REF, "activate", {}, {})
        assert r.ok                                # 权限放行后能力也支持
        denied, _, _, _ = make_router(
            rules=FakeRules(behavior=RuleBehavior.DENY, note="不许动标签"),
            with_tab=True)
        rd = denied.act(TAB_REF, "activate", {}, {})
        assert not rd.ok
        assert "window_focus" in rd.error and "拒绝" in rd.error

    def test_scenario_floor_applies_to_tab_actions(self):
        # U2 场景地板对标签域同样生效：ctx 语料命中 deletion → CONFIRM 地板
        router, reg, _, _ = make_router()
        ctx = {"note": "先删除全部历史记录再激活"}
        r = router.act(TAB_REF, "activate", {}, dict(ctx))
        direct_ok, direct_reason = reg.check_permission(
            BROWSER_ACTION_SPECS["activate"], {}, dict(ctx))
        assert not direct_ok and not r.ok
        assert r.error == direct_reason
        assert "每次执行都需要当场单独确认" in r.error and "deletion" in r.error

    def test_activate_via_router_reaches_bridge(self):
        router, _, _, bridge = make_router(with_tab=True)
        r = router.act(TAB_REF, "activate", {}, {})
        assert r.ok
        assert ("tab_activate", {"tab_id": "t001"}) in bridge.calls

    def test_act_accepts_target_ref_instance(self):
        router, _, _, _ = make_router(with_tab=True)
        assert router.act(TargetRef("tab", "task-a", "t001"), "activate",
                          {}, {}).ok


# ── 8. 零回归哨兵：既有路径（不走协议）结果不变 ──────────────────────────────

class TestZeroRegressionSentinels:

    def test_direct_registry_click_unchanged(self, tmp_path):
        class RecordingBackend:
            name = "rec"

            def __init__(self):
                self.calls = []

            def click(self, params, ctx):
                self.calls.append(("click", dict(params)))
                return Result.success({"clicked": True})

            def screenshot(self, params, ctx):
                self.calls.append(("screenshot", dict(params)))
                return Result.success({"path": params.get("save_path")
                                       or "/tmp/s.png",
                                       "width": 1, "height": 1,
                                       "scale_factor": 1.0})

        backend = RecordingBackend()
        reg = CuaActionRegistry(backend=backend, ocr_fn=fake_ocr_ok,
                                rules=FakeRules())
        r = reg.execute("click", {"x": 1, "y": 2},
                        {"cua_screenshot_dir": str(tmp_path)})
        assert isinstance(r, CuaActionResult)       # 契约类型不变
        assert r.ok
        assert [c[0] for c in backend.calls] == ["click", "screenshot"]
        assert set(r.to_dict()) == set(RESULT_KEYS)

    def test_direct_registry_refusal_unchanged(self):
        reg = CuaActionRegistry(
            backend=CuaDesktopBackend(engine=FakeEngine()),
            ocr_fn=fake_ocr_ok, rules=FakeRules())
        r = reg.execute("fill", {"x": 1, "y": 2, "text": "password123"}, {})
        assert isinstance(r, CuaActionResult)
        assert not r.ok and "单独确认" in r.error

    def test_direct_desktop_backend_navigate_validation_unchanged(self):
        b = CuaDesktopBackend(engine=FakeEngine(), ocr_fn=fake_ocr_ok)
        assert not b.navigate({"url": "javascript:alert(1)"}, {}).ok

    def test_protocol_imports_do_not_disturb_default_executor(self):
        # U4 不偷换默认执行器：get_cua_executor 仍是桌面注册表
        try:
            ex = cua_actions.get_cua_executor()
            assert isinstance(ex, CuaActionRegistry)
            assert ex.backend.name == "desktop"
        finally:
            cua_actions.set_cua_executor(None)
