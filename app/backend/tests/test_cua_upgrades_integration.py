"""test_cua_upgrades_integration.py — CUA 动作层四项升级（U1/U2/U5/U6）的接线集成测试。

只测"接线"：单件模块的算法行为由各自模块测试兜底（cua_ocr_diff、
gui_action_classifier 的参数化哨兵），本文件验证它们在 cua_actions 执行
管线里被正确组合：

- U1 OCR diff 反馈: CuaDesktopBackend 持 OcrDiffState，连续动作的反馈摘要
  只回传屏幕变化（10 帧 90% 相同行 → 总量降 ≥50%）；无探测点的替身后端
  逐字回退旧 summarize_ocr；diff 状态机坏了也回退（优化不是依赖）。
- U2 场景地板: confirmation_class × scenario_tags × 预批准来源 → 地板档，
  与裸档 escalate 取高；handoff 恒拒、必弹场景预批准买不动、pre_approval
  类合法来源不高于 AWARE、tool_result 来源反注入；纯 standard 无标签与
  旧逻辑逐字一致（零回归哨兵）。
- U5 delivery_hint: element_info 的 expect_text 诚实匹配（对全部 OCR 行
  归一化包含）→ "deliverable"，to_dict 带出契约键；自我声明与非法值不计。
- U6 拖拽中途观察: 分步原语齐备 → down→mid→观察→end→up（try/finally 保
  抬起），中途截图不推进 diff 基线；原语缺失 → 诚实降级且拖拽照常完成。

运行: pytest tests/test_cua_upgrades_integration.py -q
"""
import os

from PIL import Image

from result import Result
from permission_rules import PermissionRule, RuleBehavior

import cua_actions
from cua_actions import (ACTION_SPECS, RESULT_KEYS, ActionSpec,
                         CuaActionRegistry, CuaDesktopBackend, CuaActionResult,
                         summarize_ocr)
from gui_action_classifier import Tier, classify_action


# ── 测试替身 ─────────────────────────────────────────────────────────────────

class PlainBackend:
    """无 diff 探测点的动作后端替身（U1 回退路径 / U2 权限路由通用）。

    __getattr__ 对非下划线方法名合成成功结果——自定义 ActionSpec 的动作名
    不必逐一实现；下划线属性如实缺失（_ocr_diff_state 探测点必须"没有"）。
    """

    name = "plain"

    def __init__(self):
        self.calls = []

    def __getattr__(self, method_name):
        if method_name.startswith("_"):
            raise AttributeError(method_name)

        def _act(params, ctx):
            self.calls.append((method_name, dict(params or {})))
            return Result.success({"method": method_name})
        return _act

    def screenshot(self, params, ctx):
        self.calls.append(("screenshot", dict(params or {})))
        return Result.success({"path": params.get("save_path") or "/tmp/plain.png",
                               "width": 1, "height": 1, "scale_factor": 1.0})


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


def make_registry(backend=None, ocr_fn=None, rules=None):
    return CuaActionRegistry(
        backend=backend if backend is not None else PlainBackend(),
        ocr_fn=ocr_fn,
        rules=rules if rules is not None else FakeRules())


class FakeScreenEngine:
    """native_desktop.NativeDesktopEngine 的形状替身（现役原语面：无分步）。"""

    def __init__(self, fail_capture=False, fail_move_to_end=False):
        self.events = []
        self.fail_capture = fail_capture
        self.fail_move_to_end = fail_move_to_end

    def capture_screen(self, roi=None, quality=80, max_dim=1920):
        if self.fail_capture:
            raise RuntimeError("capture exploded (injected)")
        self.events.append(("capture",))
        return {"image": Image.new("RGB", (16, 16), (255, 255, 255)),
                "width": 16, "height": 16, "scale_factor": 1.0,
                "data_uri": "data:image/jpeg;base64,FAKE"}

    def click(self, x=None, y=None, button="left", clicks=1):
        self.events.append(("click", x, y, button, clicks))

    def move_cursor(self, x, y, smooth=True, duration=0.2):
        self.events.append(("move", x, y))
        if self.fail_move_to_end and \
                len([e for e in self.events if e[0] == "move"]) >= 2:
            raise RuntimeError("move exploded (injected)")

    def drag(self, sx, sy, ex, ey, duration=0.5):
        self.events.append(("drag", sx, sy, ex, ey))

    def scroll(self, clicks, x=None, y=None):
        self.events.append(("scroll", clicks))

    def type_unicode(self, text, delay_per_char=0.01):
        self.events.append(("type", text))

    def press_key(self, key_combo):
        self.events.append(("key", key_combo))


class StepwiseEngine(FakeScreenEngine):
    """具备 U6 分步拖拽鸭子契约的引擎替身（mouse_down/mouse_up/move_cursor）。"""

    def mouse_down(self, x, y):
        self.events.append(("down", x, y))

    def mouse_up(self):
        self.events.append(("up",))


# ── OCR 帧工厂 ───────────────────────────────────────────────────────────────

def ocr_frame(fixed=9, variant=""):
    """一帧 OCR：fixed 行固定文本（可选再加一行变化文本）。"""
    lines = [{"text": f"固定屏幕文本行{i:02d}abcdefghijklmnopqrstuvwxyz",
              "bbox": [[0, i * 10], [10, i * 10], [10, i * 10 + 8], [0, i * 10 + 8]],
              "confidence": 0.9} for i in range(fixed)]
    if variant:
        lines.append({"text": variant,
                      "bbox": [[0, 200], [50, 200], [50, 208], [0, 208]],
                      "confidence": 0.9})
    return {"text": "\n".join(l["text"] for l in lines), "lines": lines}


def scripted_ocr(frames):
    """按调用次序吐帧的 OCR 替身；耗尽后重复最后一帧。"""
    calls = {"n": 0}

    def _ocr(path):
        i = min(calls["n"], len(frames) - 1)
        calls["n"] += 1
        return Result.success(dict(frames[i]))
    return _ocr


def two_line_frame():
    return {"text": "文件\n确定", "lines": [
        {"text": "文件", "bbox": [[0, 0], [10, 0], [10, 10], [0, 10]],
         "confidence": 0.9},
        {"text": "确定", "bbox": [[50, 0], [60, 0], [60, 10], [50, 10]],
         "confidence": 0.9},
    ]}


# ── U1：OCR diff 反馈接线 ────────────────────────────────────────────────────

class TestU1OcrDiffFeedback:

    def _registry(self, frames, tmp_path):
        ocr = scripted_ocr(frames)
        backend = CuaDesktopBackend(engine=FakeScreenEngine(), ocr_fn=ocr)
        return make_registry(backend=backend, ocr_fn=ocr)

    def test_ten_frames_shrink_total_by_half(self, tmp_path):
        # 连续 10 帧、每帧 90% 行相同 → diff 摘要总量比全量摘要降 ≥50%
        frames = [ocr_frame(9, f"变化内容行{i:02d}ABCDEFGHIJKLMNOPQRSTUVWXYZ")
                  for i in range(10)]
        ex = self._registry(frames, tmp_path)
        total = 0
        for _ in range(10):
            r = ex.execute("click", {"x": 1, "y": 2},
                           {"cua_screenshot_dir": str(tmp_path)})
            assert r.ok
            total += len(r.ocr_summary)
        full = sum(len(summarize_ocr(f)) for f in frames)
        assert full > 0
        assert total < full * 0.5, (total, full)

    def test_first_frame_announces_baseline(self, tmp_path):
        frames = [ocr_frame(9, "变化内容行甲"), ocr_frame(9, "变化内容行乙")]
        ex = self._registry(frames, tmp_path)
        r = ex.execute("click", {"x": 1, "y": 2}, {"cua_screenshot_dir": str(tmp_path)})
        assert r.ok
        assert "基线" in r.ocr_summary

    def test_unchanged_frame_is_single_line(self, tmp_path):
        same = ocr_frame(9, "静止行")
        ex = self._registry([same, same], tmp_path)
        for _ in range(2):
            r = ex.execute("click", {"x": 1, "y": 2},
                           {"cua_screenshot_dir": str(tmp_path)})
            assert r.ok
        assert "几乎未变" in r.ocr_summary
        assert "\n" not in r.ocr_summary          # 单行结论

    def test_backend_without_probe_point_falls_back_verbatim(self, tmp_path):
        # 替身后端没有 _ocr_diff_state 探测点 → 逐字回退旧 summarize_ocr
        frame = two_line_frame()
        ocr = scripted_ocr([frame])
        ex = make_registry(backend=PlainBackend(), ocr_fn=ocr)
        r = ex.execute("click", {"x": 1, "y": 2}, {"cua_screenshot_dir": str(tmp_path)})
        assert r.ok
        assert r.ocr_summary == summarize_ocr(frame)

    def test_diff_state_crash_still_returns_legacy_summary(self, tmp_path, monkeypatch):
        # diff 状态机坏了也回退——优化不是依赖，反馈闭环不新增失败面
        def boom(self, ocr_value):
            raise RuntimeError("state poisoned")

        monkeypatch.setattr(cua_actions.OcrDiffState, "update_from_ocr", boom)
        frame = two_line_frame()
        ocr = scripted_ocr([frame])
        ex = make_registry(
            backend=CuaDesktopBackend(engine=FakeScreenEngine(), ocr_fn=ocr),
            ocr_fn=ocr)
        r = ex.execute("click", {"x": 1, "y": 2}, {"cua_screenshot_dir": str(tmp_path)})
        assert r.ok
        assert r.ocr_summary == summarize_ocr(frame)

    def test_diff_state_lives_on_backend_keyed_by_target(self):
        b = CuaDesktopBackend(engine=FakeScreenEngine(), ocr_fn=lambda p: Result.success(ocr_frame(2)))
        s1 = b._ocr_diff_state()
        assert s1 is b._ocr_diff_state("desktop")      # 同键同实例（懒建）
        assert b._ocr_diff_state("browser:tab-1") is not s1   # U4 形参已留


# ── U2：场景地板与预批准路由 ─────────────────────────────────────────────────

def custom_spec(name, cls="standard", tags=()):
    return ActionSpec(name, cua_actions.CAP_POINT, "computer_click", "medium",
                      True, "测试动作", cls, tuple(tags))


class TestU2ScenarioFloor:

    def test_handoff_class_rejects_regardless_of_approval(self):
        ex = make_registry()
        ex.register(custom_spec("nuke", cls="handoff"))
        for ctx in ({}, {"confirmed": True},
                    {"pre_approval_source": "user_first_message"},
                    {"confirmed": True, "pre_approval_source": "confirm_card"}):
            r = ex.execute("nuke", {"x": 1, "y": 2}, dict(ctx))
            assert not r.ok
            assert "亲手" in r.error
            assert "handoff" in r.error        # 理由写明确认类别

    def test_deletion_tag_floor_holds_against_pre_approval(self):
        ex = make_registry()
        ex.register(custom_spec("wipe_item", tags=("deletion",)))
        r = ex.execute("wipe_item", {"x": 1, "y": 2},
                       {"pre_approval_source": "user_first_message"})
        assert not r.ok
        assert "deletion" in r.error           # 理由写明命中标签
        # 单次人工批准仍可放行当次
        assert ex.execute("wipe_item", {"x": 1, "y": 2},
                          {"pre_approval_source": "user_first_message",
                           "confirmed": True}).ok

    def test_pre_approval_class_with_legal_source_not_above_aware(self):
        ex = make_registry()
        ex.register(custom_spec("share_doc", cls="pre_approval"))
        # 合法来源 → 地板 AWARE，无需 ctx["confirmed"]
        assert ex.execute("share_doc", {"x": 1, "y": 2},
                          {"pre_approval_source": "user_first_message"}).ok
        # 反注入：机器侧来源不是授权 → 地板回落 CONFIRM
        assert not ex.execute("share_doc", {"x": 1, "y": 2},
                              {"pre_approval_source": "tool_result"}).ok
        assert ex.execute("share_doc", {"x": 1, "y": 2},
                          {"pre_approval_source": "tool_result",
                           "confirmed": True}).ok

    def test_tag_driven_floor_with_source_whitelist(self):
        ex = make_registry()
        ex.register(custom_spec("enter_secret", tags=("credential",)))
        assert ex.execute("enter_secret", {"x": 1, "y": 2},
                          {"pre_approval_source": "user_first_message"}).ok
        assert not ex.execute("enter_secret", {"x": 1, "y": 2},
                              {"pre_approval_source": "tool_result"}).ok

    def test_parameter_derived_tags_raise_floor(self):
        ex = make_registry()
        # '卸载应用' 只命中场景规则（deletion），裸档 OK——地板凭空抬到 CONFIRM
        r = ex.execute("click", {"selector": "button:has-text('卸载应用')"}, {})
        assert not r.ok
        assert "deletion" in r.error
        assert ex.execute("click", {"selector": "button:has-text('卸载应用')"},
                          {"confirmed": True}).ok

    def test_pre_approved_never_lowers_bare_confirm(self):
        # 裸档 CONFIRM（凭证形态输入）不因合法预批准来源放行——地板只抬不压
        ex = make_registry()
        assert not ex.execute("fill", {"x": 1, "y": 2, "text": "password123"},
                              {"pre_approval_source": "user_first_message"}).ok
        assert ex.execute("fill", {"x": 1, "y": 2, "text": "password123"},
                          {"pre_approval_source": "user_first_message",
                           "confirmed": True}).ok

    def test_standing_allow_cannot_override_confirm_floor(self):
        rules = FakeRules(behavior=RuleBehavior.ALLOW, note="一直允许点击")
        ex = make_registry(rules=rules)
        # '发布' 命中 third_party_comm → 地板 CONFIRM，ALLOW（只解 AWARE）盖不动
        assert not ex.execute("click", {"selector": "button:has-text('发布')"}, {}).ok
        # 合法用户侧预批准来源把地板降回 AWARE → ALLOW 生效
        assert ex.execute("click", {"selector": "button:has-text('发布')"},
                          {"pre_approval_source": "confirm_card"}).ok

    def test_standard_no_tags_matches_legacy_verbatim(self):
        # 零回归哨兵：纯 standard 无标签时，裁决与旧实现逐字一致
        ex = make_registry()
        spec = ex.get("click")
        assert ex.check_permission(spec, {"x": 1, "y": 2}, {}) == (True, "")
        params = {"selector": "button:has-text('注册账号')"}
        ok, reason = ex.check_permission(spec, params, {})
        assert not ok
        verdict = classify_action(spec.guard_tool, params)
        assert verdict.tier is Tier.AWARE
        assert reason == (f"动作需要知情确认（{'；'.join(verdict.reasons[:3])}）。"
                          "用户批准本次调用、或留下一条允许规则后再试。")

    def test_pre_approval_source_flag_never_self_triggers(self):
        # 控制键不是世界内容："user_first_message" 里的 "message" 不得让
        # 普通点击自我触发 third_party_comm 地板
        ex = make_registry()
        assert ex.execute("click", {"x": 1, "y": 2},
                          {"pre_approval_source": "user_first_message"}).ok

    def test_builtin_specs_default_standard(self):
        for spec in ACTION_SPECS:
            assert spec.confirmation_class == "standard"
            assert spec.scenario_tags == ()


# ── U5：delivery_hint 载荷契约 ───────────────────────────────────────────────

class TestU5DeliveryHint:

    def _execute(self, tmp_path, params):
        frame = two_line_frame()
        ocr = scripted_ocr([frame])
        ex = make_registry(
            backend=CuaDesktopBackend(engine=FakeScreenEngine(), ocr_fn=ocr),
            ocr_fn=ocr)
        return ex.execute("element_info", params, {"cua_screenshot_dir": str(tmp_path)})

    def test_hit_sets_deliverable_and_contract_key(self, tmp_path):
        assert "delivery_hint" in RESULT_KEYS
        r = self._execute(tmp_path, {"x": 5, "y": 5, "expect_text": "确定"})
        assert r.ok
        assert r.to_dict()["delivery_hint"] == "deliverable"

    def test_miss_stays_empty(self, tmp_path):
        r = self._execute(tmp_path, {"x": 5, "y": 5, "expect_text": "不存在的文本"})
        assert r.ok
        assert r.to_dict()["delivery_hint"] == ""

    def test_matching_is_normalized(self, tmp_path):
        # 归一化：空白噪声不影响命中（OCR 幻影空格）
        r = self._execute(tmp_path, {"x": 5, "y": 5, "expect_text": " 确 定 "})
        assert r.to_dict()["delivery_hint"] == "deliverable"

    def test_self_declaration_is_ignored(self, tmp_path):
        # 绝不凭自我声明设置：params 塞 delivery_hint 无效
        r = self._execute(tmp_path, {"x": 5, "y": 5, "delivery_hint": "deliverable"})
        assert r.to_dict()["delivery_hint"] == ""

    def test_no_expect_text_no_hint(self, tmp_path):
        r = self._execute(tmp_path, {"x": 5, "y": 5})
        assert r.to_dict()["delivery_hint"] == ""

    def test_invalid_backend_value_coerced_to_empty(self, tmp_path):
        class BraggartBackend(PlainBackend):
            def element_info(self, params, ctx):
                self.calls.append(("element_info", dict(params or {})))
                return Result.success({"elements": [], "count": 0,
                                       "screenshot_path": "/tmp/x.png",
                                       "delivery_hint": "banana"})

        ex = make_registry(backend=BraggartBackend())
        r = ex.execute("element_info", {"x": 1, "y": 1},
                       {"cua_screenshot_dir": str(tmp_path)})
        assert r.ok
        assert r.delivery_hint == ""           # 非法值在边界被契约拦下


# ── U6：拖拽中途观察 ─────────────────────────────────────────────────────────

class TestU6DragMidwayObservation:

    def _run(self, tmp_path, engine, frames):
        ocr = scripted_ocr(frames)
        ex = make_registry(
            backend=CuaDesktopBackend(engine=engine, ocr_fn=ocr), ocr_fn=ocr)
        r = ex.execute("drag", {"start_x": 0, "start_y": 0,
                                "end_x": 100, "end_y": 100,
                                "observe_midway": True},
                       {"cua_screenshot_dir": str(tmp_path)})
        return ex, r

    def test_stepwise_engine_observes_midway(self, tmp_path):
        midway = {"text": "拖拽中途A", "lines": [
            {"text": "拖拽中途A", "bbox": [[0, 0], [9, 0], [9, 9], [0, 9]],
             "confidence": 0.9}]}
        final = {"text": "终态乙", "lines": [
            {"text": "终态乙", "bbox": [[0, 0], [9, 0], [9, 9], [0, 9]],
             "confidence": 0.9}]}
        engine = StepwiseEngine()
        ex, r = self._run(tmp_path, engine, [midway, final])
        assert r.ok
        assert r.details["from"] == [0, 0] and r.details["to"] == [100, 100]
        kinds = [e[0] for e in engine.events]
        assert kinds[:5] == ["down", "move", "capture", "move", "up"]
        assert "drag" not in kinds                    # 未走整段拖拽
        assert engine.events[1] == ("move", 50, 50)   # 停在起终点中点
        assert "拖拽中途观察" in r.feedback_note
        assert "拖拽中途A" in r.feedback_note
        shot = r.details.get("midway_screenshot", "")
        assert shot and os.path.basename(shot).endswith("drag_midway.jpg")
        assert os.path.dirname(shot) == str(tmp_path)
        assert os.path.exists(shot)
        # diff 基线只被动作后帧推进，中途帧从不入基线
        state = ex.backend._ocr_diff_state()
        assert state.has_baseline
        assert state.last_lines == ["终态乙"]
        assert "拖拽中途A" not in "\n".join(state.last_lines)

    def test_unsupported_engine_degrades_honestly(self, tmp_path):
        engine = FakeScreenEngine()   # 无 mouse_down/mouse_up——与现役引擎同构
        ex, r = self._run(tmp_path, engine, [ocr_frame(2)])
        assert r.ok
        assert r.details["from"] == [0, 0] and r.details["to"] == [100, 100]
        assert engine.events[0][0] == "drag"          # 拖拽照常完成
        assert "不可用" in r.feedback_note
        assert "分步拖拽" in r.feedback_note

    def test_midway_capture_failure_still_completes_drag(self, tmp_path):
        engine = StepwiseEngine(fail_capture=True)
        ex, r = self._run(tmp_path, engine, [ocr_frame(2)])
        assert r.ok
        kinds = [e[0] for e in engine.events]
        assert "up" in kinds and "drag" not in kinds
        assert "不可用" in r.feedback_note
        assert "中途截图失败" in r.feedback_note

    def test_move_failure_releases_button_and_reports(self, tmp_path):
        engine = StepwiseEngine(fail_move_to_end=True)
        ex, r = self._run(tmp_path, engine, [ocr_frame(2)])
        assert not r.ok
        assert "拖拽失败" in r.error
        kinds = [e[0] for e in engine.events]
        assert kinds[0] == "down" and kinds[-1] == "up"   # try/finally 保抬起

    def test_midway_summary_budget(self, tmp_path):
        long_line = "L" * 60
        midway = {"text": "\n".join([long_line] * 10),
                  "lines": [{"text": long_line,
                             "bbox": [[0, i], [9, i], [9, i + 1], [0, i + 1]],
                             "confidence": 0.9} for i in range(10)]}
        engine = StepwiseEngine()
        ex, r = self._run(tmp_path, engine, [midway, ocr_frame(2)])
        assert r.ok
        summary = r.details["midway_summary"]
        assert summary.startswith("拖拽中途观察:\n")
        body = summary.split("\n", 1)[1]
        assert len(body) <= 300
        assert len(body.splitlines()) <= 6
