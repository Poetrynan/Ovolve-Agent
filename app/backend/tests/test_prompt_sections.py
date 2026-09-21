# -*- coding: utf-8 -*-
"""test_prompt_sections.py — Section 注册表 / 排序 / 预算裁剪 / 向后兼容。

覆盖 P0-2 的四条验收线：
1. 注册：六层默认映射成 Section；register_section 可追加区块、同名原位覆盖。
2. 排序：stable 排前吃前缀缓存、dynamic 排后；placement 分组互不混流。
3. 预算：单块与总预算两级裁剪；dynamic 先于 stable 让位，protected 永不裁。
4. 向后兼容：assemble 的 system 正文与稳定前缀和旧 render / render_and_prefix
   逐字节一致；规划器从 cache_class 推导的前缀与旧入口产出相同断点。


运行: pytest tests/test_prompt_sections.py -v
"""
import pytest

from prompt_layers import (
    CACHE_CLASS_DYNAMIC,
    CACHE_CLASS_STABLE,
    DEFAULT_PROMPT_BUDGET_TOKENS,
    PLACEMENT_SUFFIX,
    PLACEMENT_SYSTEM,
    PLACEMENT_TOOL_RESULT,
    PromptLayerLoader,
    PromptSection,
    SECTION_BUDGET_TOKENS,
    SECTION_PRIORITIES,
    TRIM_NOTE,
    trim_to_budget,
)
from prompt_cache_planner import (
    plan_cache_breakpoints,
    plan_section_cache_breakpoints,
    stable_prefix_from_sections,
)
from token_estimate import estimate_tokens

#: 隔离用户目录：测试不该读到本机 ~/.ovolve/prompts 下的真实覆盖文件。
_NO_HOME = "Z:/nonexistent-ovolve-test-home"

#: 每轮变化的两个动态层内容（MEMORY / AGENTS）。
_OVERRIDES = {
    "MEMORY": "## 召回片段\n每轮都可能不同。",
    "AGENTS": "## 活动目标\n完成分区组装。",
}


def _loader() -> PromptLayerLoader:
    return PromptLayerLoader(user_home=_NO_HOME, master_prompt="你是 Ovolve。")


def _as_stable(name: str, content: str, **kw) -> PromptSection:
    return PromptSection(name=name, content=content, cache_class=CACHE_CLASS_STABLE, **kw)


def _as_dynamic(name: str, content: str, **kw) -> PromptSection:
    return PromptSection(name=name, content=content, cache_class=CACHE_CLASS_DYNAMIC, **kw)


# ── 注册 ────────────────────────────────────────────────────────────────────

class TestSectionRegistration:

    def test_six_layers_map_to_sections(self):
        secs = _loader().sections()
        assert [s.name for s in secs][:6] == [
            "IDENTITY", "SOUL", "TOOLS", "OUTPUT_RULES", "MEMORY", "AGENTS"]
        by_name = {s.name: s for s in secs}
        assert by_name["IDENTITY"].cache_class == CACHE_CLASS_STABLE
        assert by_name["MEMORY"].cache_class == CACHE_CLASS_DYNAMIC
        assert by_name["IDENTITY"].placement == PLACEMENT_SYSTEM
        assert by_name["IDENTITY"].budget_tokens == SECTION_BUDGET_TOKENS["IDENTITY"]
        assert by_name["IDENTITY"].priority == SECTION_PRIORITIES["IDENTITY"]
        assert by_name["IDENTITY"].protected is True
        assert by_name["MEMORY"].protected is False

    def test_register_appends_extra_section(self):
        loader = _loader()
        loader.register_section(PromptSection(
            name="turn_hints", content="本轮提示",
            placement=PLACEMENT_TOOL_RESULT, source="registry"))
        secs = loader.sections()
        assert secs[-1].name == "turn_hints"
        assert secs[-1].placement == PLACEMENT_TOOL_RESULT

    def test_register_same_name_overrides_layer_in_place(self):
        loader = _loader()
        loader.register_section(PromptSection(name="MEMORY", content="覆盖后的记忆"))
        secs = loader.sections()
        names = [s.name for s in secs]
        assert names.count("MEMORY") == 1
        assert names[4] == "MEMORY"  # 原位替换，不漂到尾部
        assert secs[4].content == "覆盖后的记忆"

    def test_reregister_same_name_updates(self):
        loader = _loader()
        loader.register_section(PromptSection(name="x", content="v1"))
        loader.register_section(PromptSection(name="x", content="v2"))
        assert [s.content for s in loader.sections() if s.name == "x"] == ["v2"]


# ── 排序 ────────────────────────────────────────────────────────────────────

class TestSectionOrdering:

    def test_stable_precedes_dynamic_in_system_text(self):
        asm = _loader().assemble(_OVERRIDES, budget_tokens=0)
        classes = [
            s.cache_class for s in asm.sections
            if s.placement == PLACEMENT_SYSTEM and s.content
        ]
        rank = {CACHE_CLASS_STABLE: 0, CACHE_CLASS_DYNAMIC: 1}
        assert [rank[c] for c in classes] == sorted(rank[c] for c in classes)

    def test_stable_prefix_is_literal_prefix_of_system_text(self):
        asm = _loader().assemble(_OVERRIDES, budget_tokens=0)
        assert asm.stable_prefix
        assert asm.system_text.startswith(asm.stable_prefix)
        # 前缀停在最后一个 stable 区块，不含 dynamic 内容
        assert "每轮都可能不同" not in asm.stable_prefix

    def test_placements_grouped_without_mixing(self):
        loader = _loader()
        loader.register_section(PromptSection(
            name="hints", content="工具结果提示", placement=PLACEMENT_TOOL_RESULT))
        loader.register_section(PromptSection(
            name="footer", content="每轮环境快照",
            placement=PLACEMENT_SUFFIX, cache_class=CACHE_CLASS_DYNAMIC))
        asm = loader.assemble(budget_tokens=0)
        assert "工具结果提示" not in asm.system_text
        assert asm.tool_result_text == "工具结果提示"
        assert asm.suffix_text == "每轮环境快照"
        # 非_system 布局绝不进稳定前缀
        assert "工具结果提示" not in asm.stable_prefix
        assert "每轮环境快照" not in asm.stable_prefix


# ── 预算裁剪 ────────────────────────────────────────────────────────────────

class TestBudgetTrimming:

    def test_trim_to_budget_noop_under_budget(self):
        assert trim_to_budget("短文本", 100) == "短文本"

    def test_trim_to_budget_nonpositive_budget_is_noop(self):
        assert trim_to_budget("短文本", 0) == "短文本"

    def test_trim_to_budget_cuts_head_and_marks(self):
        big = "需要被截断的正文内容" * 200
        out = trim_to_budget(big, 60)
        assert out.endswith(TRIM_NOTE)
        assert out.startswith("需要被截断的正文内容")
        assert estimate_tokens(out) <= 60

    def test_trim_to_budget_deterministic(self):
        big = "同输入永远同裁法" * 300
        assert trim_to_budget(big, 50) == trim_to_budget(big, 50)

    def test_per_section_budget_trims(self):
        loader = _loader()
        loader.register_section(PromptSection(
            name="runaway", content="一段失控膨胀的注入" * 500,
            budget_tokens=50, cache_class=CACHE_CLASS_DYNAMIC))
        asm = loader.assemble(budget_tokens=0)
        assert "runaway" in asm.trimmed
        trimmed_sec = [s for s in asm.sections if s.name == "runaway"][0]
        assert estimate_tokens(trimmed_sec.content) <= 50

    def test_total_budget_trims_dynamic_before_stable(self):
        overrides = {
            "SOUL": "准则", "OUTPUT_RULES": "输出规则",
            "MEMORY": "动态记忆" * 200, "AGENTS": "动态目标" * 200,
        }
        asm = _loader().assemble(overrides, budget_tokens=120)
        assert "MEMORY" in asm.trimmed or "AGENTS" in asm.trimmed
        assert "SOUL" not in asm.trimmed

    def test_total_budget_never_trims_protected(self):
        """预算小到装不下身份：protected 原样保留，如实超支而非截断。"""
        overrides = {"SOUL": "准则", "OUTPUT_RULES": "输出", "MEMORY": "m" * 400}
        asm = _loader().assemble(overrides, budget_tokens=10)
        identity = [s for s in asm.sections if s.name == "IDENTITY"][0]
        assert identity.content == "你是 Ovolve。"
        assert estimate_tokens(asm.system_text) > asm.budget_tokens
        assert "IDENTITY" not in asm.trimmed

    def test_priority_orders_trimming_within_class(self):
        loader = _loader()
        overrides = {
            "IDENTITY": "身份", "SOUL": "准则", "OUTPUT_RULES": "输出",
            "MEMORY": "x" * 80,   # dynamic，priority 10（SECTION_PRIORITIES）
            "AGENTS": "x" * 8,    # dynamic，priority 20，压到最小占位
        }
        loader.register_section(_as_dynamic("low_p", "低" * 40, priority=1))
        loader.register_section(_as_dynamic("high_p", "高" * 40, priority=99))
        full = loader.assemble(overrides, budget_tokens=0)
        # 预算压到总量一半：必然触发裁剪，看裁剪发生顺序是否按 priority 升序
        asm = loader.assemble(overrides, budget_tokens=max(1, full.total_tokens // 2))
        order = list(asm.trimmed)
        assert "low_p" in order and "high_p" in order
        assert order.index("low_p") < order.index("high_p")  # priority 小的先让位
        assert "IDENTITY" not in order and "SOUL" not in order  # protected 永不裁

    def test_default_budget_is_sum_of_section_budgets(self):
        assert DEFAULT_PROMPT_BUDGET_TOKENS == sum(SECTION_BUDGET_TOKENS.values())


# ── 向后兼容 ────────────────────────────────────────────────────────────────

class TestBackwardCompat:

    def test_assemble_matches_legacy_render_and_prefix(self):
        loader = _loader()
        legacy_rendered, legacy_stable = loader.render_and_prefix(_OVERRIDES)
        asm = loader.assemble(_OVERRIDES, budget_tokens=0)
        assert asm.system_text == legacy_rendered
        assert asm.stable_prefix == legacy_stable
        assert legacy_stable  # 前缀非空：IDENTITY..OUTPUT_RULES 都是 stable

    def test_assemble_matches_legacy_render_without_overrides(self):
        loader = _loader()
        assert loader.assemble(budget_tokens=0).system_text == loader.render()

    def test_legacy_api_untouched(self):
        loader = _loader()
        layers = loader.load(_OVERRIDES)
        assert [l.name for l in layers] == [
            "IDENTITY", "SOUL", "TOOLS", "OUTPUT_RULES", "MEMORY", "AGENTS"]
        assert layers[0].protected and not layers[4].protected
        assert loader.stable_prefix(_OVERRIDES) == loader.render_and_prefix(_OVERRIDES)[1]


# ── 规划器消费 cache_class ──────────────────────────────────────────────────

class TestPlannerConsumesCacheClass:

    def test_stable_prefix_from_sections_is_contiguous(self):
        secs = [
            _as_stable("a", "A"),
            _as_stable("b", "B"),
            _as_dynamic("c", "C"),
            _as_stable("d", "D"),   # dynamic 之后的 stable 不回头捞
        ]
        assert stable_prefix_from_sections(secs) == "A\n\nB"

    def test_stable_prefix_ignores_non_system_placement(self):
        secs = [
            _as_stable("s", "SYS"),
            _as_stable("t", "TR", placement=PLACEMENT_TOOL_RESULT),
            _as_stable("f", "FT", placement=PLACEMENT_SUFFIX),
        ]
        assert stable_prefix_from_sections(secs) == "SYS"

    def test_plan_section_breakpoints_place_prefix_marker(self):
        secs = [_as_stable("a", "STABLE_HEAD"), _as_dynamic("b", "TAIL")]
        msgs = [{"role": "system", "content": "STABLE_HEAD_TAIL"},
                {"role": "user", "content": "q"}]
        plan = plan_section_cache_breakpoints(msgs, secs, kind="anthropic")
        assert "system_prefix" in plan.breakpoints
        blocks = plan.messages[0]["content"]
        assert blocks[0]["text"] == "STABLE_HEAD"
        assert "cache_control" in blocks[0]
        assert blocks[1]["text"] == "_TAIL"  # 前缀之后的剩余内容原样保留

    def test_plan_section_breakpoints_respect_kind_whitelist(self):
        secs = [_as_stable("a", "X")]
        plan = plan_section_cache_breakpoints(
            [{"role": "system", "content": "X_Y"}, {"role": "user", "content": "q"}],
            secs, kind="openai")
        assert plan.breakpoints == ()
        assert plan.messages is not None

    def test_plan_section_breakpoints_do_not_mutate_input(self):
        secs = [_as_stable("a", "STABLE_HEAD"), _as_dynamic("b", "TAIL")]
        msgs = [{"role": "system", "content": "STABLE_HEAD_TAIL"},
                {"role": "user", "content": "q"}]
        snapshot = [dict(m) for m in msgs]
        plan_section_cache_breakpoints(msgs, secs, kind="anthropic")
        assert msgs == snapshot

    def test_loader_assemble_feeds_planner(self):
        loader = _loader()
        asm = loader.assemble(_OVERRIDES, budget_tokens=0)
        msgs = [{"role": "system", "content": asm.system_text},
                {"role": "user", "content": "q"}]
        plan = plan_section_cache_breakpoints(msgs, asm.sections, kind="anthropic")
        assert "system_prefix" in plan.breakpoints
        assert plan.messages[0]["content"][0]["text"] == asm.stable_prefix

    def test_stable_prefix_invariant_across_turns(self):
        """两轮 overrides 只变 dynamic 层：稳定前缀逐字节相同——缓存命中的前提。"""
        loader = _loader()
        a1 = loader.assemble({"MEMORY": "第一轮召回"}, budget_tokens=0)
        a2 = loader.assemble({"MEMORY": "第二轮召回"}, budget_tokens=0)
        assert a1.stable_prefix and a1.stable_prefix == a2.stable_prefix

    def test_section_plan_matches_legacy_string_plan(self):
        """分区路线与旧字符串路线在相同内容上产出相同断点。"""
        loader = _loader()
        _, legacy_stable = loader.render_and_prefix(_OVERRIDES)
        asm = loader.assemble(_OVERRIDES, budget_tokens=0)
        msgs = [{"role": "system", "content": asm.system_text},
                {"role": "user", "content": "q"}]
        legacy = plan_cache_breakpoints(msgs, system_prefix=legacy_stable, kind="anthropic")
        modern = plan_section_cache_breakpoints(msgs, asm.sections, kind="anthropic")
        assert modern.breakpoints == legacy.breakpoints


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
