"""
test_memory_condenser.py — Tests for Memory Condensation Engine.
"""
from __future__ import annotations

import os
import tempfile
import pytest
from project_memory_protocol import DecisionRecord, ProjectMemoryDocument
from memory_condenser import condense_document, condense_memory_file


def test_condense_document_dedup_and_milestone():
    doc = ProjectMemoryDocument()
    # 25 duplicate or near-duplicate conventions
    doc.conventions = [f"约定 {i % 5}" for i in range(25)]
    # 30 decisions
    for i in range(30):
        doc.decisions.append(
            DecisionRecord(
                date=f"2026-08-{i+1:02d}" if i < 20 else f"2026-09-{i-19:02d}",
                decision=f"系统决策 {i}",
                reason="优化",
            )
        )

    condensed, stats = condense_document(doc, max_decisions=10, max_conventions=10)
    assert len(condensed.conventions) == 5  # only 5 unique conventions existed
    # Kept 10 + 1 milestone = 11 decisions
    assert len(condensed.decisions) == 11
    assert "早期历史决策聚合归档" in condensed.decisions[0].decision
    assert stats["pruned_decisions"] == 20


def test_condense_memory_file_lifecycle():
    with tempfile.TemporaryDirectory() as td:
        mem_path = os.path.join(td, "MEMORY.md")
        doc = ProjectMemoryDocument(
            overview=["测试项目"],
            current_status=["开发中"],
            conventions=["规范 1", "规范 2"],
            decisions=[DecisionRecord(date="2026-09-19", decision="决策 A")],
        )
        with open(mem_path, "w", encoding="utf-8") as f:
            f.write(doc.to_markdown())

        # Within budget, no forced condensation
        res = condense_memory_file(mem_path, force=False)
        assert res["status"] == "skipped"

        # Force condensation
        res_forced = condense_memory_file(mem_path, force=True)
        assert res_forced["status"] == "success"
        assert os.path.isfile(mem_path)
