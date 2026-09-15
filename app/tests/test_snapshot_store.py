"""红线测试：快照回滚。

这个模块会 ``open(path,"wb")`` 和 ``os.unlink()``——它是全仓唯一有权覆盖和删除
用户文件的地方，却一直没有测试。这里按 ``kind`` 逐种做 round-trip，重点是那个
``skip`` 分支：文件太大时我们只记了「意图」而没有留原文，回滚**恢复不了**它，
前端必须把这种情况显示出来（见 agentStore 的 session_truncated 处理）。

DB 指向 tmp_path，绝不碰 ~/.ovolve。
"""
import os
from pathlib import Path

import pytest

import snapshot_store as ss
from snapshot_store import SnapshotStore


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(ss, "_db_path", lambda: tmp_path / "snap.db")
    return SnapshotStore()


def test_file_kind_restores_previous_content(store, tmp_path):
    f = tmp_path / "a.txt"
    f.write_text("before", encoding="utf-8")
    store.capture("s1", 10, "write_file", "c1", [str(f)])
    f.write_text("after", encoding="utf-8")

    report = store.rollback_since("s1", 10)
    assert f.read_text(encoding="utf-8") == "before"
    assert str(f) in [os.path.abspath(p) for p in report["restored"]]
    assert report["skipped"] == [] and report["errors"] == []


def test_missing_kind_deletes_what_was_created(store, tmp_path):
    f = tmp_path / "new.txt"
    store.capture("s1", 10, "write_file", "c1", [str(f)])  # 当时不存在
    f.write_text("created by the agent", encoding="utf-8")

    report = store.rollback_since("s1", 10)
    assert not f.exists()
    assert report["count"] == 1


def test_dir_kind_recreates_the_directory(store, tmp_path):
    d = tmp_path / "emptydir"
    d.mkdir()
    store.capture("s1", 10, "delete_file", "c1", [str(d)])
    d.rmdir()

    store.rollback_since("s1", 10)
    assert d.is_dir()


def test_skip_kind_does_not_restore_and_says_so(store, tmp_path, monkeypatch):
    """A2 的根因：太大的文件只记了意图，没有原文，回滚恢复不了。

    这里把上限压到 8 字节而不是真写一个 2MB 文件——走的是同一条分支，测试快
    三个数量级。断言的重点是「没恢复」+「明确报告在 skipped 里」，而不是
    「回滚失败」：静默成功才是这条红线要防的东西。
    """
    monkeypatch.setattr(ss, "MAX_SNAPSHOT_BYTES", 8)
    f = tmp_path / "big.bin"
    f.write_bytes(b"x" * 64)
    store.capture("s1", 10, "write_file", "c1", [str(f)])

    assert [r["kind"] for r in store.list_since("s1", 10)] == ["skip"]

    f.write_bytes(b"y" * 64)
    report = store.rollback_since("s1", 10)

    assert f.read_bytes() == b"y" * 64          # 没有被恢复
    assert os.path.abspath(str(f)) in report["skipped"]
    assert report["restored"] == []
    assert report["count"] == 0                  # count 只数真正做成的事


def test_rollback_is_idempotent(store, tmp_path):
    f = tmp_path / "a.txt"
    f.write_text("before", encoding="utf-8")
    store.capture("s1", 10, "write_file", "c1", [str(f)])
    f.write_text("after", encoding="utf-8")

    first = store.rollback_since("s1", 10)
    second = store.rollback_since("s1", 10)
    assert first["count"] == 1
    assert second["count"] == 0 and second["restored"] == []


def test_rollback_respects_the_seq_boundary(store, tmp_path):
    """回滚 seq>=10 不能碰 seq=5 的快照——不然「撤回这一条」会撤掉更早的工作。"""
    old = tmp_path / "old.txt"
    new = tmp_path / "new.txt"
    old.write_text("old-v1", encoding="utf-8")
    new.write_text("new-v1", encoding="utf-8")
    store.capture("s1", 5, "write_file", "c1", [str(old)])
    store.capture("s1", 10, "write_file", "c2", [str(new)])
    old.write_text("old-v2", encoding="utf-8")
    new.write_text("new-v2", encoding="utf-8")

    store.rollback_since("s1", 10)
    assert new.read_text(encoding="utf-8") == "new-v1"
    assert old.read_text(encoding="utf-8") == "old-v2"   # 更早的那条没被动
    # 更早的快照还留着，仍然可以单独回滚
    assert [r["seq"] for r in store.list_since("s1", 0)] == [5]


def test_sessions_are_isolated(store, tmp_path):
    """一个会话的回滚绝不能动到另一个会话的文件。"""
    a = tmp_path / "a.txt"
    b = tmp_path / "b.txt"
    a.write_text("a1", encoding="utf-8")
    b.write_text("b1", encoding="utf-8")
    store.capture("s1", 1, "write_file", "c1", [str(a)])
    store.capture("s2", 1, "write_file", "c2", [str(b)])
    a.write_text("a2", encoding="utf-8")
    b.write_text("b2", encoding="utf-8")

    store.rollback_since("s1", 0)
    assert a.read_text(encoding="utf-8") == "a1"
    assert b.read_text(encoding="utf-8") == "b2"


def test_capture_never_raises_on_a_bad_path(store):
    """快照失败只能降级成「这一步没有回滚」，绝不能把异常抛进工具管线。"""
    store.capture("s1", 1, "write_file", "c1", ["", None, "\x00illegal"])  # type: ignore[list-item]
    # 空路径被跳过；非法路径要么记成 missing 要么被吞掉，关键是没抛异常
    assert isinstance(store.list_since("s1", 0), list)


def test_clear_session_drops_only_that_session(store, tmp_path):
    f = tmp_path / "a.txt"
    f.write_text("x", encoding="utf-8")
    store.capture("s1", 1, "write_file", "c1", [str(f)])
    store.capture("s2", 1, "write_file", "c2", [str(f)])
    assert store.clear_session("s1") == 1
    assert store.list_since("s1", 0) == []
    assert len(store.list_since("s2", 0)) == 1
