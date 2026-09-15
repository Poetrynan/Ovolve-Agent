"""test_cua_actions.py — CUA 动作执行层：注册表 + 权限路由 + 截图 OCR 反馈闭环。

覆盖:
1. 注册表: 首批十动作齐全、describe 形状、未知动作拒绝
2. 统一结果契约: to_dict 键集稳定（RESULT_KEYS）
3. 权限路由: HANDOFF/CONFIRM/AWARE 三级走既有 gui_action_classifier 分级,
   permission_rules 的 standing 规则先裁且 DENY 永远赢、ALLOW 可预批准 AWARE
4. 截图反馈闭环: 副作用动作后强制 screenshot→OCR 调用序列（先动作后反馈）;
   纯感知动作不追加反馈
5. 反馈降级: OCR 不可用 / 反馈截图失败只记 note，不推翻已成功的动作
6. 桌面后端: navigate URL 白名单、element_info 最近元素、wait 轮询命中/超时
7. computer_agent 接入: cua_action 工具已注册、schema 必填 action、impl 薄转发;
   router 的 computer_agent 角色放行该工具

不依赖真实桌面: 后端/OCR/规则全部注入假实现。

运行: pytest tests/test_cua_actions.py -v
"""
import pytest

from result import Result
from gui_action_classifier import Tier, classify_action
from permission_rules import PermissionRule, RuleBehavior

import cua_actions
from cua_actions import ACTION_SPECS, RESULT_KEYS


# ── 测试替身 ─────────────────────────────────────────────────────────────────

class FakeBackend:
    """记录调用序列的假后端——编排测试只关心"谁先谁后"，不关心 SendInput。"""

    name = "fake"

    def __init__(self, fail_actions=(), fail_screenshot=False):
        self.calls = []                       # (method, params) 依序追加
        self.fail_actions = set(fail_actions)
        self.fail_screenshot = fail_screenshot
        self.shot_counter = 0

    def _shot(self, params):
        self.calls.append(("screenshot", dict(params or {})))
        if self.fail_screenshot:
            return Result.failure("no screen (injected)")
        self.shot_counter += 1
        return Result.success({
            "path": params.get("save_path") or f"/tmp/fake_shot_{self.shot_counter}.png",
            "width": 100, "height": 80, "scale_factor": 1.0,
        })

    def _act(self, method, params):
        self.calls.append((method, dict(params or {})))
        if method in self.fail_actions:
            return Result.failure(f"{method} failed (injected)")
        return Result.success({"method": method})

    def navigate(self, params, ctx): return self._act("navigate", params)
    def click(self, params, ctx): return self._act("click", params)
    def click_text(self, params, ctx): return self._act("click_text", params)
    def fill(self, params, ctx): return self._act("fill", params)
    def scroll(self, params, ctx): return self._act("scroll", params)
    def hover(self, params, ctx): return self._act("hover", params)
    def drag(self, params, ctx): return self._act("drag", params)
    def keypress(self, params, ctx): return self._act("keypress", params)
    def wait(self, params, ctx): return self._act("wait", params)

    def screenshot(self, params, ctx):
        return self._shot(params)

    def element_info(self, params, ctx):
        return self._act("element_info", params)


def fake_ocr_ok(path):
    """两行固定 OCR 结果：一个在左上（文件），一个偏右（确定）。"""
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
        self.queries = []

    def match(self, tool_name, args, workspace_root="", session_id=""):
        self.queries.append((tool_name, dict(args or {})))
        if self.behavior is None:
            return None
        return PermissionRule(tool_name=tool_name, behavior=self.behavior,
                              note=self.note, source="user")


def make_registry(backend=None, ocr_fn=fake_ocr_ok, rules=None):
    # rules 默认给形状替身：编排测试不触发真实 PermissionRuleStore（SQLite）。
    return cua_actions.CuaActionRegistry(
        backend=backend or FakeBackend(), ocr_fn=ocr_fn,
        rules=rules if rules is not None else FakeRules())


# ── 1. 注册表 ────────────────────────────────────────────────────────────────

class TestRegistry:

    def test_registered_action_set(self):
        ex = make_registry()
        assert set(ex.names()) == {
            "navigate", "click", "click_text", "click_element", "fill", "scroll",
            "hover", "drag", "keypress", "screenshot", "element_info",
            "element_tree", "window_list", "wait",
        }

    def test_action_specs_are_frozen_metadata(self):
        for spec in ACTION_SPECS:
            assert spec.guard_tool, f"{spec.name} 必须声明权限路由目标"
            assert spec.capability and spec.risk_level in ("low", "medium", "high")

    def test_describe_shape(self):
        ex = make_registry()
        d = ex.describe()
        # 冻结契约：describe() 必须一条不漏地覆盖 ACTION_SPECS。
        # 数字变了就说明有人增删了动作——这正是这条断言想让人停下来看的地方。
        assert len(d) == len(ACTION_SPECS) == 14
        for item in d:
            assert set(item.keys()) == {
                "name", "capability", "guard_tool", "risk_level",
                "side_effect", "description"}

    def test_unknown_action_rejected_without_backend_call(self):
        backend = FakeBackend()
        ex = make_registry(backend=backend)
        r = ex.execute("teleport", {"x": 1}, {})
        assert not r.ok
        assert "未知动作" in r.error
        assert backend.calls == []


# ── 2. 统一结果契约 ──────────────────────────────────────────────────────────

class TestResultContract:

    def test_to_dict_keys_stable(self):
        ex = make_registry()
        r = ex.execute("click", {"x": 1, "y": 2}, {})
        assert set(r.to_dict().keys()) == set(RESULT_KEYS)
        assert r.ok is True and r.action == "click"

    def test_failure_result_shape(self):
        ex = make_registry(backend=FakeBackend(fail_actions={"click"}))
        r = ex.execute("click", {"x": 1, "y": 2}, {})
        assert not r.ok and "injected" in r.error
        assert set(r.to_dict().keys()) == set(RESULT_KEYS)

    def test_backend_exception_becomes_failure(self):
        # 后端炸了也绝不向上抛——Result 纪律在动作层同样成立
        class BombBackend(FakeBackend):
            def click(self, params, ctx):
                raise RuntimeError("boom")

        ex = make_registry(backend=BombBackend())
        r = ex.execute("click", {"x": 1, "y": 2}, {})
        assert not r.ok and "boom" in r.error


# ── 3. 权限路由（复用既有分级与规则，不新增决策点）─────────────────────────────

class TestPermissionRouting:

    def test_plain_click_passes_without_confirmation(self):
        backend = FakeBackend()
        ex = make_registry(backend=backend, rules=FakeRules())
        r = ex.execute("click", {"x": 5, "y": 6}, {})
        assert r.ok
        assert backend.calls[0][0] == "click"   # 真的放行到后端了

    def test_handoff_refused_and_backend_never_called(self):
        # 点验证码类目标 → classify_action 判 HANDOFF → 一律拒绝
        backend = FakeBackend()
        ex = make_registry(backend=backend, rules=FakeRules())
        r = ex.execute("click", {"selector": "#g-recaptcha"}, {"confirmed": True})
        assert not r.ok
        assert "亲手" in r.error
        assert backend.calls == []              # 连 confirmed 都救不回来

    def test_confirm_refused_without_confirmed(self):
        backend = FakeBackend()
        ex = make_registry(backend=backend, rules=FakeRules())
        r = ex.execute("fill", {"x": 1, "y": 2, "text": "password123"}, {})
        assert not r.ok
        assert "单独确认" in r.error
        assert backend.calls == []

    def test_confirm_passes_with_single_call_approval(self):
        # 单次人工批准语义：ctx["confirmed"] 只对本次调用生效
        backend = FakeBackend()
        ex = make_registry(backend=backend, rules=FakeRules())
        r = ex.execute("fill", {"x": 1, "y": 2, "text": "password123"},
                       {"confirmed": True})
        assert r.ok
        assert backend.calls[0][0] == "fill"

    def test_aware_refused_without_confirmation_or_rule(self):
        # U2 语义升级注：'发布' 现会命中 third_party_comm 场景地板（CONFIRM），
        # AWARE 语义哨兵改用无场景标签的 '注册账号'；带标签场景的地板升降级
        # 由 tests/test_cua_upgrades_integration.py 专测。
        backend = FakeBackend()
        ex = make_registry(backend=backend, rules=FakeRules())
        r = ex.execute("click", {"selector": "button:has-text('注册账号')"}, {})
        assert not r.ok
        assert "知情确认" in r.error

    def test_aware_preapproved_by_standing_allow_rule(self):
        # 用户对 computer_click 留过"以后都允许"→ AWARE 不再打扰。
        # U2 语义升级注：改用无场景标签的 '注册账号'——带标签场景的地板在
        # ALLOW 之上（ALLOW 只解 AWARE），由 integration 测试专测。
        backend = FakeBackend()
        rules = FakeRules(behavior=RuleBehavior.ALLOW, note="一直允许点击")
        ex = make_registry(backend=backend, rules=rules)
        r = ex.execute("click", {"selector": "button:has-text('注册账号')"}, {})
        assert r.ok
        assert rules.queries[0][0] == "computer_click"   # 按声明路由到既有工具名

    def test_deny_rule_always_wins(self):
        # 就算已获单次确认，DENY 规则仍然赢——与 permission_rules 严格序一致
        backend = FakeBackend()
        rules = FakeRules(behavior=RuleBehavior.DENY, note="用户明确禁止")
        ex = make_registry(backend=backend, rules=rules)
        r = ex.execute("click", {"selector": "button:has-text('发布')"},
                       {"confirmed": True})
        assert not r.ok
        assert "拒绝" in r.error
        assert backend.calls == []

    def test_ask_rule_requires_confirmation_even_for_ok_tier(self):
        backend = FakeBackend()
        rules = FakeRules(behavior=RuleBehavior.ASK)
        ex = make_registry(backend=backend, rules=rules)
        assert not ex.execute("scroll", {"clicks": 3}, {}).ok
        assert ex.execute("scroll", {"clicks": 3}, {"confirmed": True}).ok

    def test_guard_routing_matches_classifier_directly(self):
        # 动作层的裁决必须与直接调 classify_action 的结果一致（同源不加戏）
        spec = make_registry().get("fill")
        params = {"text": "password123"}
        allowed, _ = make_registry().check_permission(spec, params, {})
        assert classify_action(spec.guard_tool, params).tier is Tier.CONFIRM
        assert not allowed

    def test_rules_store_outage_fails_closed_for_aware(self):
        # 规则体系不可用时不放宽：AWARE 仍然要求确认（分级照跑）
        class ExplodingRules:
            def match(self, *a, **k):
                raise RuntimeError("store down")

        backend = FakeBackend()
        ex = make_registry(backend=backend, rules=ExplodingRules())
        assert not ex.execute("click", {"selector": "text=提交"}, {}).ok
        assert backend.calls == []


# ── 4. 截图 OCR 反馈闭环 ─────────────────────────────────────────────────────

class TestScreenshotFeedbackLoop:

    def test_side_effect_action_appends_screenshot_then_ocr(self, tmp_path):
        backend = FakeBackend()
        ocr_paths = []

        def ocr(path):
            ocr_paths.append(path)
            return fake_ocr_ok(path)

        ex = make_registry(backend=backend, ocr_fn=ocr)
        r = ex.execute("click", {"x": 5, "y": 6},
                       {"cua_screenshot_dir": str(tmp_path)})
        assert r.ok
        # 调用序列：先动作，后反馈截图——顺序反了就成了"拍执行前"的照片
        assert [c[0] for c in backend.calls] == ["click", "screenshot"]
        assert r.screenshot_path
        assert r.screenshot_path.startswith(str(tmp_path))   # 落在注入目录
        assert ocr_paths == [r.screenshot_path]              # OCR 读的就是那张图
        assert "确定" in r.ocr_summary

    def test_observation_action_gets_no_extra_feedback(self, tmp_path):
        backend = FakeBackend()
        ex = make_registry(backend=backend)
        for action, params in (("element_info", {"x": 1, "y": 1}),
                               ("wait", {"seconds": 0}),
                               ("screenshot", {})):
            backend.calls.clear()
            r = ex.execute(action, params, {"cua_screenshot_dir": str(tmp_path)})
            assert r.ok, action
            assert [c[0] for c in backend.calls] == [action], \
                f"{action} 是感知动作，不应追加反馈截图"
            assert r.screenshot_path == ""

    def test_side_effect_set_covers_the_acting_actions(self):
        side_effect = {s.name for s in ACTION_SPECS if s.side_effect}
        # click_element 会真的动鼠标，必须计入副作用集（element_tree 只读，不算）。
        assert side_effect == {"navigate", "click", "click_text", "click_element",
                               "fill", "scroll", "hover", "drag", "keypress"}

    def test_failed_action_skips_feedback(self, tmp_path):
        # 动作本身失败时不再截图——失败原因在 error 里，反馈属于成功路径
        backend = FakeBackend(fail_actions={"click"})
        ex = make_registry(backend=backend)
        r = ex.execute("click", {"x": 1, "y": 2},
                       {"cua_screenshot_dir": str(tmp_path)})
        assert not r.ok
        assert [c[0] for c in backend.calls] == ["click"]

    def test_ocr_unavailable_degrades_but_action_stays_ok(self, tmp_path):
        backend = FakeBackend()
        ex = make_registry(backend=backend, ocr_fn=fake_ocr_fail)
        r = ex.execute("click", {"x": 1, "y": 2},
                       {"cua_screenshot_dir": str(tmp_path)})
        assert r.ok                       # 动作已作用于世界，不能改判失败
        assert r.screenshot_path          # 截图仍可用
        assert r.ocr_summary == ""
        assert "OCR" in r.feedback_note

    def test_feedback_screenshot_failure_degrades(self, tmp_path):
        backend = FakeBackend(fail_screenshot=True)
        ex = make_registry(backend=backend)
        r = ex.execute("click", {"x": 1, "y": 2},
                       {"cua_screenshot_dir": str(tmp_path)})
        assert r.ok
        assert r.screenshot_path == ""
        assert "反馈截图失败" in r.feedback_note


# ── 5. 桌面后端（假引擎 + 假 OCR，不打真桌面）─────────────────────────────────

class FakeEngine:
    """native_desktop.NativeDesktopEngine 的形状替身。"""

    def __init__(self):
        self.clicks = []

    def capture_screen(self, roi=None, quality=80, max_dim=1920):
        from PIL import Image
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
        pass

    def press_key(self, key_combo):
        pass


class TestDesktopBackend:

    def _backend(self, ocr_fn=fake_ocr_ok):
        return cua_actions.CuaDesktopBackend(engine=FakeEngine(), ocr_fn=ocr_fn)

    def test_screenshot_saves_and_reports(self, tmp_path):
        b = self._backend()
        r = b.screenshot({"save_path": str(tmp_path / "s.jpg"), "with_data_uri": True}, {})
        assert r.ok
        assert (tmp_path / "s.jpg").exists()
        assert r.value["data_uri"].startswith("data:image/jpeg")

    def test_navigate_validates_url(self):
        b = self._backend()
        assert not b.navigate({"url": "javascript:alert(1)"}, {}).ok
        assert not b.navigate({"url": "file:///etc/passwd"}, {}).ok
        assert not b.navigate({"url": "https://x.com; rm -rf /"}, {}).ok
        assert not b.navigate({}, {}).ok

    def test_navigate_opens_valid_url(self, monkeypatch):
        captured = {}

        def fake_spawn(command, **kwargs):
            captured["command"] = command

            class P:  # subprocess 形状
                stdout = ""
            return P()

        import executors
        monkeypatch.setattr(executors, "guarded_spawn", fake_spawn)
        r = self._backend().navigate({"url": "https://example.com/page?a=1"}, {})
        assert r.ok and r.value["url"] == "https://example.com/page?a=1"
        assert "https://example.com/page?a=1" in captured["command"]

    def test_navigate_deny_from_guard_becomes_failure(self, monkeypatch):
        import executors

        def denying_spawn(command, **kwargs):
            raise executors.BlockedCommandError("deny")

        monkeypatch.setattr(executors, "guarded_spawn", denying_spawn)
        assert not self._backend().navigate({"url": "https://example.com"}, {}).ok

    def test_element_info_nearest_element(self, tmp_path):
        b = self._backend()
        r = b.element_info({"x": 55, "y": 5,
                            "save_path": str(tmp_path / "e.png")}, {})
        assert r.ok
        texts = [e["text"] for e in r.value["elements"]]
        assert "文件" in texts and "确定" in texts
        assert r.value["nearest"]["text"] == "确定"       # 距 (55,5) 最近

    def test_element_info_reports_ocr_outage(self, tmp_path):
        b = self._backend(ocr_fn=fake_ocr_fail)
        r = b.element_info({}, {})
        assert not r.ok and "OCR" in r.error

    def test_wait_plain_sleep(self, monkeypatch):
        slept = []
        monkeypatch.setattr(cua_actions.time, "sleep", slept.append)
        r = self._backend().wait({"seconds": 2.5}, {})
        assert r.ok and r.value["found"] is None
        assert slept == [2.5]

    def test_wait_for_text_hits_on_first_poll(self, tmp_path):
        r = self._backend().wait({"for_text": "确定", "timeout": 5}, {})
        assert r.ok and r.value["found"] is True and r.value["polled"] == 1

    def test_wait_for_text_timeout_without_sleep(self, tmp_path):
        # timeout=0 → 首轮轮询后立即判超时，测试不需要真等待
        r = self._backend(ocr_fn=lambda p: Result.success(
            {"text": "空白", "lines": []})).wait(
            {"for_text": "确定", "timeout": 0}, {})
        assert r.ok and r.value["found"] is False

    def test_wait_clamps_oversized_values(self, monkeypatch):
        slept = []
        monkeypatch.setattr(cua_actions.time, "sleep", slept.append)
        r = self._backend().wait({"seconds": 9999}, {})
        assert r.ok and slept == [30.0]        # 上限 30s，模型给再大也不照办


# ── 6. computer_agent 接入与角色放行 ─────────────────────────────────────────

class TestComputerAgentIntegration:

    def test_cua_action_tooldef_registered(self):
        from computer_agent import ComputerAgent

        class _D:
            DOMAIN = "computer"

        defs = {t.name: t for t in ComputerAgent._build_tool_defs(_D())}
        td = defs.get("cua_action")
        assert td is not None
        assert td.domain == "computer" and td.risk_level == "medium"
        assert td.schema["required"] == ["action"]
        assert set(td.schema["properties"]["action"]["enum"]) == \
            set(make_registry().names())

    def test_impl_forwards_to_executor(self, tmp_path):
        import computer_agent
        backend = FakeBackend()
        cua_actions.set_cua_executor(make_registry(backend=backend))
        try:
            r = computer_agent._cua_action_impl(
                {"action": "click", "x": 1, "y": 2},
                {"cua_screenshot_dir": str(tmp_path)})
            assert r.ok
            assert r.value["action"] == "click" and r.value["ok"] is True
            assert [c[0] for c in backend.calls] == ["click", "screenshot"]
        finally:
            cua_actions.set_cua_executor(None)   # 复位，防止污染其他测试

    def test_impl_surfaces_permission_refusal_as_failure(self):
        import computer_agent
        cua_actions.set_cua_executor(make_registry(rules=FakeRules()))
        try:
            r = computer_agent._cua_action_impl(
                {"action": "fill", "text": "password123"}, {})
            assert not r.ok
            assert "单独确认" in r.error
        finally:
            cua_actions.set_cua_executor(None)

    def test_router_role_admits_cua_action(self):
        # 子代理 allowed_tools 同时管可见与派发——角色清单不放行，工具就到不了
        from router import AGENT_ROLES
        assert "cua_action" in AGENT_ROLES["computer_agent"]["tools"]

# ── 8. BareModifierGuard 物理按键与鼠标冲突防护集成 ──────────────────────────

class TestBareModifierGuardIntegration:
    class MockBlockedGuard:
        def wait_for_bare_state(self, timeout_ms=250):
            return (False, "物理修饰键处于按下态: Ctrl")

    def test_point_action_blocked_by_modifier_guard(self):
        backend = FakeBackend()
        ex = make_registry(backend=backend)
        ex.modifier_guard = self.MockBlockedGuard()
        r = ex.execute("click", {"x": 10, "y": 20}, {})
        assert not r.ok
        assert "物理输入冲突防护拦截" in r.error
        assert "Ctrl" in r.error
        assert backend.calls == []  # 后端未被调用

    def test_modifier_guard_can_be_skipped_with_flag(self):
        backend = FakeBackend()
        ex = make_registry(backend=backend)
        ex.modifier_guard = self.MockBlockedGuard()
        r = ex.execute("click", {"x": 10, "y": 20}, {"skip_modifier_guard": True})
        assert r.ok
        assert len(backend.calls) >= 1

    def test_perceive_action_not_blocked_by_modifier_guard(self):
        backend = FakeBackend()
        ex = make_registry(backend=backend)
        ex.modifier_guard = self.MockBlockedGuard()
        r = ex.execute("screenshot", {}, {})
        assert r.ok
        assert any(c[0] == "screenshot" for c in backend.calls)


# ── 9. TextAnchor 本地 OCR 锚点与 DPI 补偿集成 ─────────────────────────────

class TestTextAnchorIntegration:
    def test_click_text_with_ocr_lines(self):
        fake_lines = [
            {"text": "搜索文档", "bbox": [[100, 200], [180, 200], [180, 230], [100, 230]]}
        ]
        class MockEngine:
            def __init__(self):
                self.clicked_coords = []
            def click(self, x, y, button="left", clicks=1):
                self.clicked_coords.append((x, y, button, clicks))

        engine = MockEngine()
        backend = cua_actions.CuaDesktopBackend(engine=engine)
        ex = make_registry(backend=backend)

        r = ex.execute("click_text", {"text": "搜索", "ocr_lines": fake_lines}, {})
        assert r.ok
        assert engine.clicked_coords == [(140, 215, "left", 1)]

    def test_click_delegates_to_text_target(self):
        fake_lines = [
            {"text": "查看详情", "bbox": [[50, 50], [90, 50], [90, 70], [50, 70]]}
        ]
        class MockEngine:
            def __init__(self):
                self.clicked_coords = []
            def click(self, x, y, button="left", clicks=1):
                self.clicked_coords.append((x, y, button, clicks))

        engine = MockEngine()
        backend = cua_actions.CuaDesktopBackend(engine=engine)
        ex = make_registry(backend=backend)

        r = ex.execute("click", {"text_target": "查看详情", "ocr_lines": fake_lines}, {})
        assert r.ok
        assert engine.clicked_coords == [(70, 60, "left", 1)]

    def test_click_text_not_found_fails_gracefully(self):
        fake_lines = [
            {"text": "取消", "bbox": [[10, 10], [30, 10], [30, 20], [10, 20]]}
        ]
        backend = cua_actions.CuaDesktopBackend(engine=None)
        ex = make_registry(backend=backend)
        r = ex.execute("click_text", {"text": "找不到的按钮", "ocr_lines": fake_lines}, {})
        assert not r.ok
        assert "未在屏幕识别文本中找到目标锚点" in r.error
