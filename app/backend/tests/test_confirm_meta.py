"""test_confirm_meta.py — 确认停点场景语义 meta：字段契约 + 停点形态。

覆盖:
1. build_confirm_meta 纯函数:
   - 非 GUI 工具: 只带 confirm_reason + allow_always=true（与现状等价），
     scenario_tags / confirmation_class / handoff 一律省略（拿不到不编造）；
   - GUI 工具: 裸档 CONFIRM（删除类点击）→ class=always_confirm + 删除标签
     + allow_always=false；无命中 → class=standard、标签省略、allow_always=true；
   - cua_action 门面: 按 args.action 解析 ACTION_SPECS 同源重算（finance 命中、
     未知动作名弃权）；
   - 可预批准场景（对外发布）: allow_always=true（"以后都允许"正是它的解法）；
   - captcha: HANDOFF 档 → handoff=true + guard 标准理由覆盖 ask 语声原文
     + allow_always=false；
   - confirm_reason 原文透传；block_reason 为空时字段省略；
   - 标签按 SCENARIO_TAGS 固定序；畸形输入（None args）不抛异常。
2. 停点形态（最小 Router 直调 _run_tool_call，沿用
   test_steer_interrupt_and_queue_sync 的 mock 手法）:
   - ask → needs_confirmation，confirm_meta 随停点 outcome 返回，
     tool_result 帧 meta 携带 needs_confirmation + 结构化字段，pending 照旧落账；
   - ask × HANDOFF 档 → 停成 denied（不是 needs_confirmation），不落 pending，
     tool_result 帧 meta 带 handoff=true；
   - block → denied 照旧，结构化字段随帧透传。

运行: pytest tests/test_confirm_meta.py -v
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from confirm_meta import (
    CUA_ACTION_TOOL,
    build_confirm_meta,
    handoff_message,
)
from gui_action_classifier import SCENARIO_TAGS


# ── 1. build_confirm_meta 纯函数 ─────────────────────────────────────────────

class TestBuildConfirmMetaNonGui:
    def test_non_gui_tool_gets_reason_and_allow_always_only(self):
        meta = build_confirm_meta(
            "run_command", {"command": "git push --force"},
            block_reason="收到。我将执行 git push --force。回复「同意」我就继续。",
        )
        assert meta["confirm_reason"].startswith("收到。我将执行")
        assert meta["allow_always"] is True
        # 拿不到动作视图：场景字段一律省略，绝不编造
        assert "scenario_tags" not in meta
        assert "confirmation_class" not in meta
        assert "handoff" not in meta

    def test_no_block_reason_omits_confirm_reason(self):
        meta = build_confirm_meta("run_command", {"command": "ls"})
        assert "confirm_reason" not in meta
        assert meta["allow_always"] is True


class TestBuildConfirmMetaGui:
    def test_deletion_click_is_always_confirm_and_locked(self):
        meta = build_confirm_meta(
            "computer_click", {"selector": "text=确认永久删除该文件夹"},
            block_reason="收到。我将点击确认删除。",
        )
        assert meta["confirm_reason"] == "收到。我将点击确认删除。"
        assert meta["scenario_tags"] == ["deletion"]
        assert meta["confirmation_class"] == "always_confirm"
        assert meta["allow_always"] is False
        assert "handoff" not in meta

    def test_plain_click_no_hits_omits_tags_and_unlocks(self):
        meta = build_confirm_meta("computer_click", {"x": 120, "y": 88})
        assert meta["confirmation_class"] == "standard"
        assert "scenario_tags" not in meta
        assert meta["allow_always"] is True
        assert "handoff" not in meta

    def test_captcha_click_is_handoff(self):
        meta = build_confirm_meta(
            "computer_click", {"selector": "text=验证码"},
            block_reason="收到。我将点击人机验证框。回复「同意」我就继续。",
        )
        assert meta["handoff"] is True
        assert meta["confirmation_class"] == "handoff"
        assert meta["allow_always"] is False
        # ask 语声的确认 prompt 不能当移交理由展示——用 guard 标准理由覆盖
        assert meta["confirm_reason"].startswith("这类动作需要用户亲手执行")
        assert "验证码" in meta["confirm_reason"]

    def test_scenario_tags_follow_fixed_order(self):
        meta = build_confirm_meta(
            "computer_type", {"text": "清空后支付"},
        )
        assert meta["scenario_tags"] == [
            t for t in SCENARIO_TAGS if t in ("deletion", "finance")
        ]
        assert meta["scenario_tags"] == ["deletion", "finance"]

    def test_pre_approval_scenario_unlocks_allow_always(self):
        # 对外发布（third_party_comm 可预批准组）：裸档 AWARE → pre_approval 类
        meta = build_confirm_meta("computer_type", {"text": "发布文章：今日总结"})
        assert meta["scenario_tags"] == ["third_party_comm"]
        assert meta["confirmation_class"] == "pre_approval"
        assert meta["allow_always"] is True
        assert "handoff" not in meta


class TestBuildConfirmMetaCuaFacade:
    def test_cua_action_resolves_spec_and_recomputes(self):
        meta = build_confirm_meta(
            CUA_ACTION_TOOL, {"action": "click", "selector": "text=确认支付 ¥128"},
            block_reason="收到。我将在屏幕上点击。",
        )
        assert meta["scenario_tags"] == ["finance"]
        assert meta["confirmation_class"] == "always_confirm"
        assert meta["allow_always"] is False

    def test_cua_action_unknown_action_abstains(self):
        meta = build_confirm_meta(CUA_ACTION_TOOL, {"action": "teleport"})
        assert meta["allow_always"] is True
        assert "scenario_tags" not in meta
        assert "confirmation_class" not in meta
        assert "handoff" not in meta


class TestBuildConfirmMetaRobustness:
    @pytest.mark.parametrize("tool,args,reason", [
        (None, None, None),
        ("", {}, ""),
        ("computer_click", None, None),
        (CUA_ACTION_TOOL, None, "x"),
    ])
    def test_malformed_inputs_do_not_raise(self, tool, args, reason):
        meta = build_confirm_meta(tool, args, block_reason=reason)
        assert isinstance(meta, dict)
        assert meta["allow_always"] in (True, False)


def test_handoff_message_with_and_without_reasons():
    assert handoff_message(["理由甲", "理由乙"]).startswith("这类动作需要用户亲手执行（理由甲")
    assert handoff_message([]) == "这类动作需要用户亲手执行。"
    assert handoff_message(None) == "这类动作需要用户亲手执行。"


# ── 2. 停点形态（最小 Router 直调） ──────────────────────────────────────────

class _FakeEvent:
    """bus.emit 的最小替身：只带停点分支读的两个属性。"""

    def __init__(self, action, block_reason=""):
        from event_bus import EventAction
        self.action = EventAction(action)
        self.block_reason = block_reason
        self.payload = {}


def _make_router(ask_event):
    from risk_control import RiskLevel
    from router import Router

    router = Router(session_id="test-session-confirm-meta", mount_shared=False)
    router.bus = AsyncMock()

    async def _emit(event_name, payload=None):
        if event_name == "pre_tool_use":
            return ask_event
        return _FakeEvent("continue")  # permission_request 沉默放行

    router.bus.emit = AsyncMock(side_effect=_emit)
    router.risk = MagicMock()
    router.risk.classify_risk.return_value = RiskLevel.MEDIUM
    router.risk.has_grant.return_value = False
    router.risk.record_pending = MagicMock()
    return router


def _tool_result_meta(router) -> dict:
    for call in router.bus.emit.call_args_list:
        if call.args and call.args[0] == "tool_result":
            return (call.args[1].get("meta") or {})
    return {}


class TestGateAskNeedsConfirmation:
    @pytest.mark.asyncio
    async def test_ask_stops_with_structured_meta(self):
        reason = "收到。我将点击确认删除。回复「同意」我就继续。"
        router = _make_router(_FakeEvent("ask", block_reason=reason))
        outcome = await router._run_tool_call(
            {"id": "c1", "name": "computer_click",
             "arguments": {"selector": "text=确认永久删除该文件夹"}},
            {},
        )
        assert outcome["trace"]["status"] == "needs_confirmation"
        assert outcome["halt"] is True
        meta = outcome["confirm_meta"]
        assert meta["scenario_tags"] == ["deletion"]
        assert meta["confirmation_class"] == "always_confirm"
        assert meta["allow_always"] is False
        assert meta["confirm_reason"] == reason
        # pending 照旧落账（无场景语义改动）
        router.risk.record_pending.assert_called_once()
        # tool_result 帧携带 needs_confirmation + 结构化字段
        frame_meta = _tool_result_meta(router)
        assert frame_meta.get("needs_confirmation") is True
        assert frame_meta.get("allow_always") is False
        assert frame_meta.get("scenario_tags") == ["deletion"]

    @pytest.mark.asyncio
    async def test_ask_non_gui_keeps_status_quo_shape(self):
        reason = "收到。我将执行 git push --force。回复「同意」我就继续。"
        router = _make_router(_FakeEvent("ask", block_reason=reason))
        outcome = await router._run_tool_call(
            {"id": "c2", "name": "run_command", "arguments": {"command": "git push --force"}},
            {},
        )
        assert outcome["trace"]["status"] == "needs_confirmation"
        assert outcome["content"] == reason
        meta = outcome["confirm_meta"]
        assert meta["confirm_reason"] == reason
        assert meta["allow_always"] is True
        assert "scenario_tags" not in meta
        assert "confirmation_class" not in meta
        assert "handoff" not in meta
        router.risk.record_pending.assert_called_once()


class TestGateHandoffDenied:
    @pytest.mark.asyncio
    async def test_handoff_ask_becomes_denied_not_needs_confirmation(self):
        router = _make_router(_FakeEvent("ask", block_reason="收到。我将点击验证码。"))
        outcome = await router._run_tool_call(
            {"id": "c3", "name": "computer_click", "arguments": {"selector": "text=验证码"}},
            {},
        )
        assert outcome["trace"]["status"] == "denied"
        assert outcome["halt"] is True
        meta = outcome["confirm_meta"]
        assert meta["handoff"] is True
        assert meta["allow_always"] is False
        assert meta["confirm_reason"].startswith("这类动作需要用户亲手执行")
        # 移交类没有可批准的选项——不落 pending
        router.risk.record_pending.assert_not_called()
        frame_meta = _tool_result_meta(router)
        assert frame_meta.get("handoff") is True
        assert "needs_confirmation" not in frame_meta

    @pytest.mark.asyncio
    async def test_block_keeps_denied_and_passes_fields(self):
        router = _make_router(_FakeEvent("block", block_reason="你设置过一条规则禁止这类调用"))
        outcome = await router._run_tool_call(
            {"id": "c4", "name": "run_command", "arguments": {"command": "rm -rf /"}},
            {},
        )
        assert outcome["trace"]["status"] == "denied"
        assert outcome["content"].startswith("已被策略拦截：")
        meta = outcome["confirm_meta"]
        assert meta["confirm_reason"] == "你设置过一条规则禁止这类调用"
        assert meta["allow_always"] is True
        assert "handoff" not in meta
        router.risk.record_pending.assert_not_called()
