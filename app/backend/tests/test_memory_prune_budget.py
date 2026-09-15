# -*- coding: utf-8 -*-
"""
test_memory_prune_budget.py — 单元测试：记忆 25KB 预算控制与闲时梦境修剪 (Phase 62)。
"""
import time
import tempfile
import pytest
from memory_layer import MemoryIndexCapper, MemoryLayer
from storage import Storage


def test_memory_index_capper_line_and_budget():
    # 1. 测试单行 150 字符限制
    long_line = "A" * 300
    capped = MemoryIndexCapper.cap_entry_line(long_line, max_chars=150)
    assert len(capped) <= 150
    assert capped.endswith("...")

    # 2. 测试 25KB 物理预算封顶
    small_blocks = [f"<memory id='{i}'>{'X' * 5000}</memory>" for i in range(10)]
    budgeted = MemoryIndexCapper.enforce_budget(small_blocks, max_bytes=25600)
    total_bytes = sum(len(b.encode('utf-8')) for b in budgeted)
    assert total_bytes <= 25600
    assert len(budgeted) == 5  # 5 * ~5000 = ~25000 bytes


def test_memory_budget_stats_calculation():
    entries = [
        {"content": "short fact"},
        {"content": "another fact with more content for test"},
    ]
    stats = MemoryIndexCapper.get_budget_stats(entries, max_bytes=1000)
    assert stats["entries_count"] == 2
    assert stats["used_bytes"] > 0
    assert stats["usage_ratio"] > 0
    assert stats["healthy"] is True


def test_memory_layer_prune_stale_memories():
    with tempfile.TemporaryDirectory() as tmp_dir:
        st = Storage(tmp_dir)
        try:
            mem_layer = MemoryLayer(storage=st, root_dir=tmp_dir)
            now = time.time()
            c = st._db("memory")

            # 插入 1 条有效活跃记忆 (hits=5)
            c.execute(
                "INSERT INTO memory_entries (id, root_dir, content, status, hits, created_at, updated_at) "
                "VALUES ('mem-active', ?, 'Active valuable fact', 'active', 5, ?, ?)",
                (tmp_dir, now, now)
            )

            # 插入 1 条已被取代的旧记忆 (status='superseded')
            c.execute(
                "INSERT INTO memory_entries (id, root_dir, content, status, hits, created_at, updated_at) "
                "VALUES ('mem-superseded', ?, 'Old superseded fact', 'superseded', 1, ?, ?)",
                (tmp_dir, now - 5000, now - 5000)
            )

            # 插入 1 条超过 200 天且从未被召回的陈旧记忆 (hits=0)
            c.execute(
                "INSERT INTO memory_entries (id, root_dir, content, status, hits, created_at, updated_at) "
                "VALUES ('mem-stale', ?, 'Ancient never used fact', 'active', 0, ?, ?)",
                (tmp_dir, now - 200 * 86400, now - 200 * 86400)
            )

            # 插入 1 个孤儿实体节点 (没有连线且 40 天未更新)
            c.execute(
                "INSERT INTO graph_entities (id, root_dir, name, type, created_at, updated_at) "
                "VALUES ('orphan-ent', ?, 'OrphanConcept', 'Concept', ?, ?)",
                (tmp_dir, now - 40 * 86400, now - 40 * 86400)
            )
            c.commit()

            # 执行修剪
            report = mem_layer.prune_stale_memories(root_dir=tmp_dir, max_age_days=180)

            assert report["pruned_count"] == 1         # mem-stale 被归档
            assert report["retired_count"] == 1        # mem-superseded 被归档
            assert report["orphan_nodes_removed"] == 1 # orphan-ent 被物理删除
            assert report["freed_bytes"] > 0

            # 验证 active 记忆不受影响
            active_row = c.execute("SELECT status FROM memory_entries WHERE id='mem-active'").fetchone()
            assert active_row["status"] == "active"
        finally:
            st.close()
