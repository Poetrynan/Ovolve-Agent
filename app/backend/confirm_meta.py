"""confirm_meta.py — 确认停点的场景语义载荷（U 波次：确认弹窗场景化）。

## 解决什么

确认停点此前只有一个自然语言 prompt（``block_reason``）：前端审批卡看得见
"要你确认"，看不见"为什么是这一档"、"以后都允许"能不能买断。本模块把
guard 层已有的裁决（gui_action_classifier 裸档 + U2 场景地板）**同源重算**
成结构化字段，附在确认停点的 meta 上——判定逻辑零新增：这里只做
gui_action_classifier 纯函数的只读编排，与 cua_actions.check_permission、
make_gui_action_guard_layer 消费同一套词表与合成定律。

## meta 字段契约（tool_result 帧 / 停点 Result.meta）

  · confirm_reason      guard 层拦截原因原文。handoff 停点例外：带的是
                        guard 层对移交类的标准理由（与 check_permission /
                        action-guard 同一文案公式），ask 的确认 prompt 语声
                        （"回复同意我就继续"）不能当驳回理由展示。
  · scenario_tags       detect_scenario_tags 同源重算（SCENARIO_TAGS 固定序）。
                        仅 GUI/computer_* 动作视图可得；拿不到就省略，绝不编造。
  · confirmation_class  裸档 tier 按映射约定合成（OK→standard / AWARE→
                        pre_approval / CONFIRM→always_confirm / HANDOFF→
                        handoff，词表见 CONFIRMATION_CLASSES）；动作规格显式
                        声明了非 standard 政策类时以声明为准。
  · allow_always        bool。"以后都允许"按钮的置灰依据：handoff / 必弹场景
                        （ALWAYS_CONFIRM_SCENARIOS）/ 裸档 CONFIRM → false；
                        可预批准场景与无场景信息 → true（与既有 prompt 里
                        「以后都允许」要约的语义一致）。
  · handoff             仅裁决为 HANDOFF 档时置 true；该动作停成 denied 而
                        不是 needs_confirmation——移交人这件事没有"批准"可选。

非 GUI 工具（shell / 文件读写等）拿不到动作视图：meta 只带 confirm_reason
与 allow_always=true，scenario_tags / confirmation_class / handoff 一律省略。


"""
from __future__ import annotations

from typing import Any, Optional

from gui_action_classifier import (
    ALWAYS_CONFIRM_SCENARIOS,
    CONFIRMATION_CLASSES,
    GUI_TOOLS,
    Tier,
    classify_action,
    detect_scenario_tags,
    escalate_tiers,
    resolve_confirmation_tier,
)

#: CUA 动作层入口工具名（computer_agent 注册的唯一 CUA 门面工具）。
#: 它的 args 里带具体动作名（action=click/fill/...），动作视图按 ACTION_SPECS 解析。
CUA_ACTION_TOOL = "cua_action"

#: 裸档 tier → confirmation_class 映射约定（gui_action_classifier 词表注释同款）。
TIER_TO_CONFIRMATION_CLASS: dict = {
    Tier.OK: "standard",
    Tier.AWARE: "pre_approval",
    Tier.CONFIRM: "always_confirm",
    Tier.HANDOFF: "handoff",
}

#: HANDOFF 停点的标准理由前缀——与 cua_actions.check_permission（HANDOFF 分支）
#: 和 make_gui_action_guard_layer（action-guard:handoff）同一文案公式。
_HANDOFF_REASON_PREFIX = "这类动作需要用户亲手执行"

#: confirm_reason 的长度护栏——guard 原文照搬，但防极端参数把它撑爆。
_REASON_MAX_CHARS = 800


def handoff_message(reasons: Optional[list]) -> str:
    """合成 HANDOFF 停点的驳回理由（guard 层标准语声，非编造）。"""
    clean = [str(r).strip() for r in (reasons or []) if str(r or "").strip()]
    if clean:
        return f"{_HANDOFF_REASON_PREFIX}（{'；'.join(clean[:3])}）"
    return f"{_HANDOFF_REASON_PREFIX}。"


def _action_view(tool_name: Any, args: Any) -> Optional[dict]:
    """把一次工具调用解析成动作分级视图（同源：ACTION_SPECS / GUI_TOOLS）。

    返回 {guard_tool, params, declared_class, declared_tags, view_tool} 或
    None（非 GUI/computer_* 域——拿不到视图就省略场景字段，绝不编造）。
    """
    if not isinstance(args, dict):
        args = {}
    tool = str(tool_name or "").strip()
    if tool == CUA_ACTION_TOOL:
        # cua_action 门面：按 args.action 解析到注册表动作规格，参数体去掉
        # 动作名本身——与 cua_actions.CuaActionRegistry.execute 同一拆包方式。
        action_name = str(args.get("action") or "").strip()
        params = {k: v for k, v in args.items() if k != "action"}
        try:
            from cua_actions import ACTION_SPECS
            spec = next((s for s in ACTION_SPECS if s.name == action_name), None)
        except Exception:
            spec = None
        if spec is None:
            return None
        return {
            "guard_tool": spec.guard_tool,
            "params": params,
            "declared_class": str(spec.confirmation_class or "standard"),
            "declared_tags": tuple(spec.scenario_tags or ()),
            "view_tool": spec.name,
        }
    if tool in GUI_TOOLS:
        return {
            "guard_tool": tool,
            "params": args,
            "declared_class": "standard",
            "declared_tags": (),
            "view_tool": tool,
        }
    return None


def build_confirm_meta(tool_name: Any, args: Any, *,
                       block_reason: Any = "",
                       context: Optional[dict] = None) -> dict:
    """确认停点的结构化 meta。纯函数：不落库、不发事件、不改任何状态。

    Args:
        tool_name: 工具名（停点处的原始工具名，含 cua_action 门面）。
        args: 工具调用参数。
        block_reason: guard 层拦截原因原文（pre_tool_use 的 block_reason）。
        context: 工具上下文（只用于场景语料的控制键剔除，与 check_permission 同源）。

    Returns:
        dict，仅包含可诚实给出的字段：
          - confirm_reason 恒在（原文非空时；handoff 停点为 guard 标准理由）；
          - scenario_tags / confirmation_class 仅动作视图可得时存在；
          - allow_always 恒在（bool）；
          - handoff 仅裁决为 HANDOFF 档时存在且恒 true。
    """
    meta: dict = {}

    reason = str(block_reason or "").strip()
    if reason:
        meta["confirm_reason"] = reason[:_REASON_MAX_CHARS]

    view = _action_view(tool_name, args)
    if view is None:
        # 无场景信息：与现状等价——"以后都允许"不被本模块置灰。
        meta["allow_always"] = True
        return meta

    # 场景标签：spec 静态声明 + 参数语料现检，与 cua_actions.check_permission
    # 完全同源（含 ctx 控制键剔除）。ctx 里拿不到或判定器弃权（空元组）→ 省略。
    tags = tuple(view["declared_tags"])
    try:
        from cua_actions import _detect_ctx_of
        detect_ctx = _detect_ctx_of(context if isinstance(context, dict) else {})
    except Exception:
        detect_ctx = {k: v for k, v in (context or {}).items()
                      if k != "pre_approval_source"}
    tags = tags + detect_scenario_tags(view["view_tool"], view["params"], detect_ctx)
    if tags:
        meta["scenario_tags"] = list(tags)

    # 裸档（classify_action 对非 GUI guard 工具恒 OK 空裁决——不编造）。
    verdict = classify_action(view["guard_tool"], view["params"])

    # confirmation_class：规格显式声明的非 standard 政策类优先，否则按裸档
    # tier 映射约定合成。
    declared = str(view["declared_class"] or "standard").strip().lower() or "standard"
    cls = declared if declared in CONFIRMATION_CLASSES and declared != "standard" \
        else TIER_TO_CONFIRMATION_CLASS[verdict.tier]
    meta["confirmation_class"] = cls

    # 最终档：场景地板 × 裸档取高（合成定律，预批准在停点视角一律未获得——
    # 预批准只能由下一次交互产生，不能由本停点自证）。
    floor = resolve_confirmation_tier(cls, tags, pre_approved=False)
    tier = escalate_tiers(verdict.tier, floor)

    if tier is Tier.HANDOFF:
        meta["handoff"] = True
        # guard 标准理由覆盖 ask 语声的 block_reason：确认 prompt（"回复同意
        # 我就继续"）不能当移交理由展示。
        meta["confirm_reason"] = handoff_message(verdict.reasons)
        meta["allow_always"] = False
        return meta

    # "以后都允许"的发言权：handoff / 必弹场景 / 裸档 CONFIRM（合成类
    # always_confirm）买不动；可预批准场景与无雷区命中 → true。
    must_confirm = (
        cls in ("handoff", "always_confirm")
        or any(t in ALWAYS_CONFIRM_SCENARIOS for t in tags)
    )
    meta["allow_always"] = not must_confirm
    return meta
