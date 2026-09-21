"""test_snapshot_turn_view.py — 测试回合级快照视图、文件级 diff 与零副作用 revert_check。"""

import os
import sys
import tempfile
import pytest
from pathlib import Path

from app.backend.snapshot_store import SnapshotStore


@pytest.fixture
def temp_store(tmp_path, monkeypatch):
    db_file = tmp_path / "test_snapshots.db"
    monkeypatch.setattr("app.backend.snapshot_store._db_path", lambda: db_file)
    store = SnapshotStore()
    return store


def test_turn_start_and_finish_lifecycle(temp_store):
    sid = "sess-turn-1"
    tid = "turn-101"

    # 1. 回合启动
    st_res = temp_store.turn_start(sid, tid, metadata={"client": "ui"})
    assert st_res["turn_id"] == tid
    assert st_res["status"] == "in_progress"
    assert st_res["started_at"] > 0
    # head_commit 尝试抓取当前 git head，如果不在 repo 中则为空字符串
    assert isinstance(st_res["head_commit"], str)

    # 2. 回合完成
    fn_res = temp_store.turn_finish(sid, tid, metadata={"outcome": "success"})
    assert fn_res["turn_id"] == tid
    assert fn_res["status"] == "finished"
    assert fn_res["finished_at"] >= st_res["started_at"]


def test_turn_diffs_and_revert_check(temp_store, tmp_path):
    sid = "sess-turn-2"
    tid = "turn-102"
    temp_store.turn_start(sid, tid)

    # 准备三个测试文件
    f_created = tmp_path / "created.txt"
    f_modified = tmp_path / "modified.txt"
    f_deleted = tmp_path / "deleted.txt"

    # 初始化 pre-state
    f_modified.write_text("line 1\nline 2\nline 3\n", encoding="utf-8")
    f_deleted.write_text("old line A\nold line B\n", encoding="utf-8")

    # 捕获预镜像 (pre-images) 关联到 turn_id
    temp_store.capture(sid, 1, "create_file", "c1", [str(f_created)], turn_id=tid)
    temp_store.capture(sid, 1, "edit_file", "c2", [str(f_modified)], turn_id=tid)
    temp_store.capture(sid, 1, "delete_file", "c3", [str(f_deleted)], turn_id=tid)

    # 执行变更
    f_created.write_text("new content line 1\nnew content line 2\n", encoding="utf-8")
    f_modified.write_text("line 1\nline 2 MODIFIED\nline 3\nline 4 NEW\n", encoding="utf-8")
    f_deleted.unlink()

    temp_store.turn_finish(sid, tid)

    # 1. 验证 get_turn_diffs
    diffs = temp_store.get_turn_diffs(tid)
    assert len(diffs) == 3
    diff_map = {Path(d["path"]).name: d for d in diffs}

    assert diff_map["created.txt"]["change_type"] == "created"
    assert diff_map["created.txt"]["additions"] == 2
    assert diff_map["created.txt"]["deletions"] == 0

    assert diff_map["modified.txt"]["change_type"] == "modified"
    assert diff_map["modified.txt"]["additions"] >= 1
    assert diff_map["modified.txt"]["deletions"] >= 1

    assert diff_map["deleted.txt"]["change_type"] == "deleted"
    assert diff_map["deleted.txt"]["additions"] == 0
    assert diff_map["deleted.txt"]["deletions"] == 2

    # 2. 验证 revert_check (干跑零副作用)
    created_content_before = f_created.read_text(encoding="utf-8")
    modified_content_before = f_modified.read_text(encoding="utf-8")
    deleted_exists_before = f_deleted.exists()

    revert_plan = temp_store.revert_check(tid)
    assert revert_plan["dry_run"] is True
    assert revert_plan["total_changes"] == 3
    assert str(f_created) in revert_plan["will_delete"]
    assert str(f_modified) in revert_plan["will_restore"]
    assert str(f_deleted) in revert_plan["will_restore"]

    # 确保磁盘未发生任何物理变化（零副作用）
    assert f_created.read_text(encoding="utf-8") == created_content_before
    assert f_modified.read_text(encoding="utf-8") == modified_content_before
    assert f_deleted.exists() == deleted_exists_before
