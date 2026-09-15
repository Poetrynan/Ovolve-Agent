# -*- coding: utf-8 -*-
"""test_context_compactor_stable_block.py — 受保护区块（P0-3 StableBlock）。

覆盖稳定区块保护的四条验收线：
1. 元数据：mark_stable_block / stable_block_of 的挂载、两种存放形态
   （内存 dict 顶层键 / storage JSON metadata）、坏数据 fail-open 朝
   「未保护」方向（绝不把普通消息误判成受保护）。
2. 折叠保留：fold 的摘要器（启发式 / LLM）无论丢不丢，受保护区块原文
   都由代码拼进摘要；连续 N 轮压缩 100% 保留；无区块时不加段落。
3. 预算：protected_block_budget_tokens 限预算时按优先级整块取舍，
   默认 0 = 100% 保留，绝不把一条规则截成半句。
4. 就地改写：replace_oversized / _microfold / precheck_inline 三条
   落刀点全部绕开受保护区块（fold 摘要路径由 _is_whitelisted 覆盖）。


运行: pytest tests/test_context_compactor_stable_block.py -v
"""
import json

import pytest

from context_compactor import (
    PROTECTED_BLOCK_SECTION_TITLE,
    ContextCompactor,
    FOLD_PLACEHOLDER,
    mark_stable_block,
    stable_block_of,
)


def _msgs(n_turns: int, content: str = "这是一段足够长的对话内容用来撑起 token 数量。") -> list:
    out = []
    for i in range(n_turns):
        out.append({"role": "user", "content": f"{content} 第{i}轮"})
        out.append({"role": "assistant", "content": f"好的，已处理第{i}轮。"})
    return out


# ═══ P0-3 受保护区块（StableBlock 结构化元数据）══════════════════════════════

def _rule_block(tag: str, kind: str = "safety_policy", priority: int = 5) -> dict:
    """一条受保护区块消息：标记全在结构化元数据上，正文里没有任何标记文本。"""
    return mark_stable_block(
        {"role": "user", "content": f"[{tag}] 绝不允许删除用户目录。"},
        kind=kind, priority=priority)


class TestStableBlockMetadata:

    def test_mark_and_read_roundtrip(self):
        m = mark_stable_block(
            {"role": "user", "content": "规则正文"}, kind="permission_rules", priority=3)
        block = stable_block_of(m)
        assert block is not None
        assert block.kind == "permission_rules"
        assert block.priority == 3
        assert block.protected is True

    def test_storage_json_metadata_form_recognized(self):
        """storage.get_messages 返回的 metadata 是 JSON 文本——这条路径也要认。"""
        m = {
            "role": "user", "content": "规则正文",
            "metadata": json.dumps({
                "stable_block": {"protected": True, "kind": "safety_policy", "priority": 2}}),
        }
        block = stable_block_of(m)
        assert block is not None and block.kind == "safety_policy"

    def test_unmarked_message_is_not_protected(self):
        assert stable_block_of({"role": "user", "content": "普通消息"}) is None
        assert stable_block_of(None) is None

    def test_explicit_protected_false_opts_out(self):
        m = {"role": "user", "content": "x", "stable_block": {"protected": False}}
        assert stable_block_of(m) is None

    def test_corrupt_metadata_reads_as_unprotected(self):
        m = {"role": "user", "content": "x", "metadata": "{not json"}
        assert stable_block_of(m) is None


class TestProtectedBlockSurvival:

    @pytest.mark.asyncio
    async def test_protected_block_survives_heuristic_fold(self):
        c = ContextCompactor(max_tokens=100_000, reserve_tokens_floor=0)
        out = await c.fold("sess-prot-1", [_rule_block("P-RULE-1")] + _msgs(4))
        assert out.ok
        assert out.value["protectedBlocks"] == 1
        assert "[P-RULE-1]" in out.value["summary"]
        assert PROTECTED_BLOCK_SECTION_TITLE in out.value["summary"]

    @pytest.mark.asyncio
    async def test_protected_block_survives_llm_summary_that_drops_it(self):
        """摘要器把规则全丢了：区块原文仍由代码拼回摘要。"""
        c = ContextCompactor(max_tokens=100_000, reserve_tokens_floor=0)

        async def forgetful_summarizer(_m):
            return {"Goal": "做完了", "Progress": "都做完了",
                    "Decisions": [], "Open Issues": []}

        c.set_summarizer(forgetful_summarizer)
        out = await c.fold("sess-prot-2", [_rule_block("P-RULE-2")] + _msgs(4))
        assert out.ok and out.value["strategy"] == "llm-summary"
        assert "[P-RULE-2]" in out.value["summary"]

    @pytest.mark.asyncio
    async def test_no_protected_blocks_adds_no_section(self):
        c = ContextCompactor(max_tokens=100_000, reserve_tokens_floor=0)
        out = await c.fold("sess-prot-3", _msgs(3))
        assert out.value["protectedBlocks"] == 0
        assert PROTECTED_BLOCK_SECTION_TITLE not in out.value["summary"]

    @pytest.mark.asyncio
    async def test_protected_blocks_survive_five_consecutive_folds(self):
        """P0-3 验收线：压缩 N 轮后受保护区块 100% 保留。

        每轮注入一条新的受保护区块；上一轮摘要以受保护 system 行回注
        （摘要是已压缩形态，本身就该受保护）。任何一轮丢块即失败。
        """
        c = ContextCompactor(max_tokens=100_000, reserve_tokens_floor=0)
        summary = ""
        for i in range(5):
            history = []
            if summary:
                # 上一轮摘要是折痕之后唯一被回放的东西，回注时同样打保护标记
                history.append(mark_stable_block(
                    {"role": "system", "content": summary},
                    kind="task_constraints", priority=100))
            history.append(_rule_block(f"P-RULE-{i}", priority=i))
            history.extend(_msgs(3, content=f"第{i}段对话内容" + "撑" * 60))
            out = await c.fold(f"sess-prot-chain-{i}", history)
            assert out.ok
            summary = out.value["summary"]
            for j in range(i + 1):
                assert f"[P-RULE-{j}]" in summary, \
                    f"第 {i} 轮折叠丢了第 {j} 轮注入的受保护区块"

    def test_duplicate_blocks_deduplicated(self):
        c = ContextCompactor(max_tokens=100_000)
        lines = c._protected_block_lines([_rule_block("P-DUP"), _rule_block("P-DUP")])
        assert len(lines) == 1

    def test_budget_keeps_high_priority_first(self):
        """限预算时整块取舍：优先级高的先占坑，绝不留半块。"""
        c = ContextCompactor(max_tokens=100_000)
        c.protected_block_budget_tokens = 8
        lines = c._protected_block_lines([
            mark_stable_block({"role": "user", "content": "低优先规则 ABCD"}, priority=1),
            mark_stable_block({"role": "user", "content": "高优先规则 EFGH"}, priority=9),
        ])
        assert any("高优先规则" in ln for ln in lines)
        assert not any("低优先规则" in ln for ln in lines)


class TestProtectedBlockInPlaceGuards:

    def test_replace_oversized_spares_protected_block(self):
        c = ContextCompactor(max_tokens=1_000)
        big = "关" * 20_000
        history = [
            mark_stable_block({"role": "user", "content": big}, kind="safety_policy"),
            {"role": "assistant", "content": "y" * 20_000},
        ]
        assert c.replace_oversized(history) == 1
        assert history[0]["content"] == big

    def test_microfold_spares_protected_block(self):
        c = ContextCompactor(prune_window_tokens=0)
        m = mark_stable_block(
            {"role": "tool", "msg_type": "tool_call",
             "tool_name": "read_file", "content": "规则输出" * 50},
            kind="permission_rules")
        assert c._microfold([m]) == 0
        assert m["content"] != FOLD_PLACEHOLDER

    def test_precheck_inline_spares_protected_block(self):
        c = ContextCompactor(max_tokens=1_000, reserved_tokens=0)
        protected_content = "权限规则" * 2_000
        history = [
            {"role": "tool", "content": "普通输出A" * 2_000},
            mark_stable_block({"role": "tool", "content": protected_content},
                              kind="permission_rules"),
            {"role": "tool", "content": "普通输出B" * 2_000},
            {"role": "tool", "content": "普通输出C" * 2_000},
            {"role": "tool", "content": "普通输出D" * 2_000},
        ]
        report = c.precheck_inline(history, overhead_tokens=0)
        assert history[1]["content"] == protected_content  # 受保护：原样
        assert report["pruned"] >= 1                        # 普通旧结果确实被剪了


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
