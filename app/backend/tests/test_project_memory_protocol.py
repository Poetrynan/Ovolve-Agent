"""
test_project_memory_protocol.py — Tests for Ovolve Project Memory Protocol.
"""
from __future__ import annotations

import pytest
from project_memory_protocol import (
    DecisionRecord,
    ProjectMemoryDocument,
    is_explicit_persistence_intent,
    validate_memory_budget,
    MAX_MEMORY_LINES,
    MAX_MEMORY_TOKENS,
)


def test_decision_record_formatting_and_parsing():
    dec = DecisionRecord(
        date="2026-09-19",
        decision="采用五章节项目记忆协议",
        reason="消除上下文污染与膨胀",
        impact="提高长期记忆检索命中率",
        source="架构评审",
    )
    line = dec.format_line()
    assert "[2026-09-19] 采用五章节项目记忆协议" in line
    assert "原因：消除上下文污染与膨胀" in line
    assert "来源：架构评审" in line

    parsed = DecisionRecord.parse_line(line)
    assert parsed is not None
    assert parsed.date == "2026-09-19"
    assert parsed.decision == "采用五章节项目记忆协议"
    assert parsed.reason == "消除上下文污染与膨胀"
    assert parsed.impact == "提高长期记忆检索命中率"
    assert parsed.source == "架构评审"


def test_project_memory_document_roundtrip():
    doc = ProjectMemoryDocument(
        overview=["Ovolve AI Agent 桌面应用开发", "基于 Python 与 React 架构"],
        current_status=["正在执行 Stage 3 自进化深度升级"],
        conventions=["统一使用类型标注与显式错误处理", "必须执行自动化回归验证"],
        decisions=[
            DecisionRecord(
                date="2026-09-19",
                decision="统一工程约定",
                reason="降低协作与维护成本",
                impact="全仓统一编码规范",
                source="AIPM 决议",
            )
        ],
        practices=["优先运行 pytest 带有 basetemp 参数"],
    )

    md = doc.to_markdown()
    assert "## 1. 项目概览" in md
    assert "## 2. 当前状态" in md
    assert "## 3. 稳定信息与工作约定" in md
    assert "## 4. 决策记录" in md
    assert "## 5. 可复用经验与最佳实践" in md

    # Parse back
    doc2 = ProjectMemoryDocument.parse(md)
    assert len(doc2.overview) == 2
    assert "Ovolve AI Agent 桌面应用开发" in doc2.overview[0]
    assert len(doc2.current_status) == 1
    assert len(doc2.conventions) == 2
    assert len(doc2.decisions) == 1
    assert doc2.decisions[0].decision == "统一工程约定"
    assert len(doc2.practices) == 1


def test_explicit_persistence_intent_gating():
    # True positives
    assert is_explicit_persistence_intent("请记住：以后测试命令必须加 basetemp 参数")
    assert is_explicit_persistence_intent("把这个决策写入记忆")
    assert is_explicit_persistence_intent("请作为团队工作约定保存下来")
    assert is_explicit_persistence_intent("Please save to memory: use pnpm")
    assert is_explicit_persistence_intent("更新项目记忆：已升级到 Phase 82")

    # False positives (should NOT trigger persistence)
    assert not is_explicit_persistence_intent("你能记住什么东西吗？")
    assert not is_explicit_persistence_intent("帮我查看一下当前的记忆")
    assert not is_explicit_persistence_intent("今天天气怎么样")
    assert not is_explicit_persistence_intent("解释一下这段代码的逻辑")


def test_validate_memory_budget():
    normal_text = "line 1\nline 2\nline 3"
    budget = validate_memory_budget(normal_text)
    assert budget["valid"] is True
    assert budget["lines"] == 3
    assert budget["exceeds_lines"] is False

    # Exceed lines
    large_lines = "\n".join([f"line {i}" for i in range(MAX_MEMORY_LINES + 50)])
    budget_large = validate_memory_budget(large_lines)
    assert budget_large["valid"] is False
    assert budget_large["exceeds_lines"] is True
