"""P1-3 — 会话模型 I/O 审计轨（jsonl）+ 信箱未投递补投 验收。

结构化
SQLite + 逐会话 jsonl 原始流水 + 父子关联字段）与 reference agent brain/ 未投递
队列——
"""
import json
import sqlite3

import pytest

from event_store import EventStore
from mailbox import (
    KIND_INFO,
    defer,
    deliver_pending,
    mark_online,
    pending,
    pending_count,
    send,
    send_or_defer,
    unread,
)
from session_audit import DIRECTION_REQUEST, SessionAuditTrack
from storage import Storage


def _storage(tmp_path):
    return Storage(db_dir=str(tmp_path / "db"))


# ── A 部分：jsonl 审计轨 ─────────────────────────────────────────────────────

class TestAuditTrackBasics:

    def test_record_and_read_roundtrip(self, tmp_path):
        track = SessionAuditTrack(base_dir=str(tmp_path / "logs"))
        assert track.record("s1", "request", model="m-a",
                            payload={"content": "你好"})
        assert track.record("s1", "response", model="m-a", turn=1,
                            tokens={"input": 10, "output": 5},
                            payload={"content": "回复"})
        assert track.record("s1", "event", event="usage",
                            tokens={"input": 10})
        entries = track.read("s1")
        assert [e["seq"] for e in entries] == [1, 2, 3]
        assert [e["direction"] for e in entries] == [
            "request", "response", "event"]
        assert entries[0]["payload"]["content"] == "你好"
        assert entries[1]["tokens"] == {"input": 10, "output": 5}
        # 每条都带时间戳、模型与可回放的 canonical event_type
        assert all(e["ts"] and "event_type" in e for e in entries)
        assert entries[0]["event_type"] == "llm.request_sent"
        assert entries[1]["event_type"] == "llm.response_completed"
        assert entries[2]["event_type"] == "llm.response_completed"

    def test_subagent_session_id_is_filesystem_safe(self, tmp_path):
        # 子代理 id 形如 bench-x::sub::y —— Windows 非法字符必须被清洗，
        # 逻辑 id 不动，读写仍然一致。
        sid = "bench-x::sub::y"
        track = SessionAuditTrack(base_dir=str(tmp_path / "logs"))
        assert track.record(sid, "request", payload={"n": 1})
        entries = track.read(sid)
        assert len(entries) == 1 and entries[0]["session_id"] == sid
        # 目录名里不允许出现 Windows 非法字符
        assert ":" not in str(track._live_path(sid).parent.name)

    def test_parent_ref_auto_fill_and_override(self, tmp_path):
        track = SessionAuditTrack(
            base_dir=str(tmp_path / "logs"),
            parent_lookup=lambda sid: {"child": "parent-x"}.get(sid, ""),
        )
        track.record("child", "request")
        track.record("orphan", "request")
        track.record("child", "response", parent_ref="explicit-parent")
        entries = {e["session_id"]: e for e in track.read("child") + track.read("orphan")}
        child_req = [e for e in track.read("child") if e["direction"] == "request"][0]
        child_resp = [e for e in track.read("child") if e["direction"] == "response"][0]
        orphan = track.read("orphan")[0]
        assert child_req["parent_ref"] == "parent-x"   # 惰性查表自动补齐
        assert orphan["parent_ref"] == ""              # 无父会话 → 空串，不是缺字段
        assert child_resp["parent_ref"] == "explicit-parent"  # 显式传参优先

    def test_read_missing_session_returns_empty(self, tmp_path):
        track = SessionAuditTrack(base_dir=str(tmp_path / "logs"))
        assert track.read("no-such-session") == []


class TestRotation:

    def test_rotation_by_size_keeps_order_and_data(self, tmp_path):
        # 每条 ~360 字节 > rotate_bytes=200 → 每写一条滚动一次；
        # keep_files=6 时全部滚动文件都在保留期内，一条不许丢。
        track = SessionAuditTrack(base_dir=str(tmp_path / "logs"),
                                  rotate_bytes=200, keep_files=6)
        for i in range(6):
            track.record("rot", "event", event="turn_started",
                         payload={"i": i, "pad": "x" * 80})
        sdir = track._live_path("rot").parent
        rotated = sorted(p.name for p in sdir.glob("model_io.jsonl.*"))
        assert len(rotated) == 5, f"应有 5 个滚动文件，实际 {rotated}"
        entries = track.read("rot")
        assert [e["payload"]["i"] for e in entries] == list(range(6)), \
            "读回顺序必须与写入顺序一致（跨滚动文件），滚动不许丢数据"
        assert track._live_path("rot").exists()

    def test_rotation_retention_cap_drops_oldest(self, tmp_path):
        # keep_files=1 → 至多 .1 + 活文件 = 最近两条；最旧的按设计出保留期
        track = SessionAuditTrack(base_dir=str(tmp_path / "logs"),
                                  rotate_bytes=200, keep_files=1)
        for i in range(4):
            track.record("cap", "event", event="turn_started",
                         payload={"i": i, "pad": "x" * 80})
        entries = track.read("cap")
        assert [e["payload"]["i"] for e in entries] == [2, 3], \
            "保留上限裁掉最旧滚动文件，最新数据必须完整"

    def test_seq_continues_across_restart(self, tmp_path):
        base = str(tmp_path / "logs")
        t1 = SessionAuditTrack(base_dir=base)
        t1.record("s", "request")
        t2 = SessionAuditTrack(base_dir=base)  # 模拟进程重启：新实例同一目录
        t2.record("s", "response")
        seqs = [e["seq"] for e in t2.read("s")]
        assert seqs == [1, 2], "重启后 seq 必须续号而不是从 1 重来"

    def test_archive_session_moves_files(self, tmp_path):
        track = SessionAuditTrack(base_dir=str(tmp_path / "logs"))
        track.record("arch", "request")
        dest = track.archive_session("arch")
        assert dest, "归档必须返回目标目录"
        assert not track._live_path("arch").exists()
        assert track.read("arch") == []
        # 归档后该会话从 0 重新计 seq，继续审计不受影响
        track.record("arch", "request")
        assert [e["seq"] for e in track.read("arch")] == [1]


class TestCorruptionTolerance:

    def test_corrupt_line_skipped_and_write_continues(self, tmp_path):
        track = SessionAuditTrack(base_dir=str(tmp_path / "logs"))
        track.record("c1", "request", payload={"n": 1})
        track.record("c1", "response", payload={"n": 2})
        track.record("c1", "event", event="usage")
        # 人为损坏中间一行（模拟磁盘/进程中断留下的半行）
        live = track._live_path("c1")
        lines = live.read_text(encoding="utf-8").splitlines()
        lines[1] = '{"seq": 2, "trunc'  # 半截 JSON
        live.write_text("\n".join(lines) + "\n", encoding="utf-8")

        entries = track.read("c1")
        assert [e["seq"] for e in entries] == [1, 3], "损坏行跳过，好行保全"
        # 损坏之后继续写入不抛、seq 不回退
        assert track.record("c1", "request", payload={"n": 4})
        seqs = [e["seq"] for e in track.read("c1")]
        assert seqs == [1, 3, 4]

    def test_fail_open_on_unwritable_base(self, tmp_path):
        # 把"目录"位置放成一个文件 → mkdir 失败 → 必须吞掉而不是炸主流程
        blocker = tmp_path / "blocker"
        blocker.write_text("not a dir", encoding="utf-8")
        track = SessionAuditTrack(base_dir=str(blocker))
        assert track.record("f1", "request") is False
        assert track.dropped_writes == 1, "丢弃必须可数——静默降级等于埋雷"
        assert track.read("f1") == []

    def test_storage_survives_broken_audit_tracker(self, tmp_path):
        st = _storage(tmp_path)
        try:
            st.create_session("s-broken", "t")
            class _Broken:
                def record(self, *a, **k):
                    raise RuntimeError("audit track exploded")
                def note_parent(self, *a, **k):
                    raise RuntimeError("audit track exploded")
            st._session_audit = _Broken()
            mid = st.add_message("s-broken", "user", "消息照常落库")
            assert mid, "审计轨损坏绝不允许阻塞会话主流程"
            assert st.count_messages("s-broken") == 1
        finally:
            st.close()


class TestParallelWithSqlite:

    def test_add_message_writes_both_tracks(self, tmp_path):
        st = _storage(tmp_path)
        try:
            st.create_session("s-par", "并行轨道")
            st.add_message("s-par", "user", "帮我改标题")
            st.add_message("s-par", "assistant", "已改好",
                           metadata={"model": "glm-x", "turnId": "t-1"})
            # SQLite 查询面：消息照常在
            msgs = st.get_messages("s-par")
            assert [m["role"] for m in msgs] == ["user", "assistant"]
            # jsonl 审计/回放面：request/response 与 SQLite 并行落盘
            entries = st._session_audit.read("s-par")
            assert [e["direction"] for e in entries] == ["request", "response"]
            assert entries[0]["payload"]["content"] == "帮我改标题"
            assert entries[1]["model"] == "glm-x"
            assert entries[1]["turn_id"] == "t-1"
        finally:
            st.close()

    def test_record_usage_writes_token_usage_event(self, tmp_path):
        st = _storage(tmp_path)
        try:
            st.create_session("s-usage", "用量")
            st.record_usage("s-usage", "turn-9", 120, 45, model_id="m-1",
                            latency_ms=800, cost_micros=42)
            assert st.get_usage("s-usage")["total"] == 165
            entry = st._session_audit.read("s-usage")[0]
            assert entry["direction"] == "event"
            assert entry["event"] == "usage"
            assert entry["model"] == "m-1"
            assert entry["tokens"] == {"input": 120, "output": 45,
                                       "reasoning": 0, "cache_creation": 0,
                                       "cache_read": 0}
            assert entry["payload"]["cost_micros"] == 42
        finally:
            st.close()

    def test_parent_child_relation_in_audit_track(self, tmp_path):
        st = _storage(tmp_path)
        try:
            st.create_session("parent-s", "父会话")
            st.create_session("child-s", "子会话", parent_id="parent-s")
            st.add_message("child-s", "user", "子代理收到任务")
            entry = st._session_audit.read("child-s")[0]
            # 父子关联字段：自造名 parent_ref，指向父会话 id
            assert entry["parent_ref"] == "parent-s"
            # 父会话自己的流水 parent_ref 为空
            st.add_message("parent-s", "user", "父会话消息")
            parent_entry = st._session_audit.read("parent-s")[0]
            assert parent_entry["parent_ref"] == ""
        finally:
            st.close()


class TestGoldenReplayCompat:

    def test_jsonl_replays_into_fresh_event_store(self, tmp_path):
        st = _storage(tmp_path)
        try:
            st.create_session("s-replay", "回放源")
            st.add_message("s-replay", "user", "第一问")
            st.add_message("s-replay", "assistant", "第一答")
            st.record_usage("s-replay", "t1", 30, 12, model_id="m-r")
            n_entries = len(st._session_audit.read("s-replay"))
        finally:
            st.close()

        store = EventStore(db_path=str(tmp_path / "replay" / "events.db"))
        st2 = Storage(db_dir=str(tmp_path / "db"))  # 重开：顺带验证重启后可读
        try:
            report = st2._session_audit.replay_into_store("s-replay", store)
        finally:
            st2.close()
        assert report["appended"] == n_entries and report["problems"] == []
        verdict = store.verify_chain("s-replay")
        assert verdict.get("valid"), verdict
        # 重放流与 jsonl 一一对应（事件数一致）
        assert len(store.read_stream("s-replay")) == n_entries


# ── B 部分：信箱未投递补投 ───────────────────────────────────────────────────

class TestMailboxDeferred:

    def test_defer_and_pending_order(self, tmp_path):
        st = _storage(tmp_path)
        try:
            for i in range(3):
                defer(st, "mailbox:box-a", "sender-1",
                      payload={"n": i, "kind_note": KIND_INFO})
            msgs = pending(st, "mailbox:box-a")
            assert [m["payload"]["n"] for m in msgs] == [0, 1, 2], \
                "积压必须按投递顺序可窥视"
            assert pending_count(st, "mailbox:box-a") == 3
            # 积压不是未读——没补投前正式信箱必须是空的
            assert unread(st, "mailbox:box-a") == []
        finally:
            st.close()

    def test_mark_online_promotes_in_order_and_clears(self, tmp_path):
        st = _storage(tmp_path)
        try:
            ids = [defer(st, "mailbox:box-b", "sender-1", payload={"n": i})
                   for i in range(3)]
            report = mark_online(st, "mailbox:box-b")
            assert report["delivered"] == 3 and report["remaining"] == 0
            msgs = unread(st, "mailbox:box-b")
            assert [m["payload"]["n"] for m in msgs] == [0, 1, 2], \
                "补投进正式信箱后顺序不许乱"
            assert [m["id"] for m in msgs] == ids, "升格保留原 id，轨迹可追"
            # 确认后移除：重连再补投一次必须零重复
            again = mark_online(st, "mailbox:box-b")
            assert again["delivered"] == 0 and pending_count(st, "mailbox:box-b") == 0
            assert len(unread(st, "mailbox:box-b")) == 3
        finally:
            st.close()

    def test_head_not_acked_blocks_the_queue(self, tmp_path):
        st = _storage(tmp_path)
        try:
            for i in range(3):
                defer(st, "mailbox:box-c", "sender-1", payload={"n": i})
            acked = []
            def flaky_deliver(msg):
                acked.append(msg["payload"]["n"])
                return msg["payload"]["n"] > 0  # 首条拒收
            report = deliver_pending(st, "mailbox:box-c", deliver=flaky_deliver)
            assert report["delivered"] == 0
            assert report["stopped_at"] == pending(st, "mailbox:box-c")[0]["id"]
            assert report["remaining"] == 3
            # 头条未确认，后面不许越过——只试探过第一条
            assert acked == [0]
            # 失败尝试必须留下观测痕迹
            assert pending(st, "mailbox:box-c")[0]["attempts"] == 1
            # 对端恢复（ack 全过）→ 一次补投清空整队
            report2 = deliver_pending(st, "mailbox:box-c",
                                      deliver=lambda m: True)
            assert report2["delivered"] == 3 and report2["remaining"] == 0
        finally:
            st.close()

    def test_partial_ack_delivers_prefix_only(self, tmp_path):
        st = _storage(tmp_path)
        try:
            for i in range(4):
                defer(st, "mailbox:box-d", "sender-1", payload={"n": i})
            report = deliver_pending(
                st, "mailbox:box-d", deliver=lambda m: m["payload"]["n"] < 2)
            assert report["delivered"] == 2
            assert report["remaining"] == 2
            assert report["stopped_at"] is not None
            # 自定义投递动作=调用方自己的搬运通道：确认的两条出队即走，
            # 不重复落正式信箱；未确认的两条原位留队
            assert [m["payload"]["n"] for m in pending(st, "mailbox:box-d")] == [2, 3]
            assert unread(st, "mailbox:box-d") == []
        finally:
            st.close()

    def test_deliver_exception_counts_as_nack(self, tmp_path):
        st = _storage(tmp_path)
        try:
            defer(st, "mailbox:box-e", "sender-1", payload={"n": 1})
            def boom(msg):
                raise ValueError("transport down")
            report = deliver_pending(st, "mailbox:box-e", deliver=boom)
            assert report["delivered"] == 0 and report["remaining"] == 1
            assert "ValueError" in (report["error"] or "")
            assert pending_count(st, "mailbox:box-e") == 1, \
                "投递动作抛异常视为未确认，消息不许丢"
        finally:
            st.close()

    def test_queue_survives_restart(self, tmp_path):
        db_dir = str(tmp_path / "db")
        st1 = Storage(db_dir=db_dir)
        try:
            defer(st1, "mailbox:persistent", "sender-1", payload={"note": "活过重启"})
            defer(st1, "mailbox:persistent", "sender-1", payload={"note": "第二条"})
        finally:
            st1.close()

        st2 = Storage(db_dir=db_dir)  # 模拟进程重启
        try:
            assert pending_count(st2, "mailbox:persistent") == 2, \
                "延迟队列持久化——重启不许丢积压"
            report = mark_online(st2, "mailbox:persistent")
            assert report["delivered"] == 2
            msgs = unread(st2, "mailbox:persistent")
            assert [m["payload"]["note"] for m in msgs] == \
                ["活过重启", "第二条"]
        finally:
            st2.close()

    def test_send_or_defer_routes_by_online_state(self, tmp_path):
        st = _storage(tmp_path)
        try:
            # 在线 → 立即投递，不进队列
            mid, delivered = send_or_defer(st, "mailbox:route", "s1",
                                           payload={"n": 1}, online=True)
            assert delivered and len(unread(st, "mailbox:route")) == 1
            assert pending_count(st, "mailbox:route") == 0
            # 离线 → 进延迟队列，不产生"永远读不到的未读"
            _, delivered2 = send_or_defer(st, "mailbox:route", "s1",
                                          payload={"n": 2}, online=False)
            assert not delivered2
            assert unread(st, "mailbox:route")[-1]["payload"]["n"] == 1  # 只有在线那条
            assert pending_count(st, "mailbox:route") == 1
            # online 可以是可调用（由调用方定义"在线"）
            seen = {}
            def online_probe(storage, box_id):
                seen["box"] = box_id
                return False
            send_or_defer(st, "mailbox:route2", "s1", online=online_probe)
            assert seen["box"] == "mailbox:route2"
            assert pending_count(st, "mailbox:route2") == 1
        finally:
            st.close()

    def test_promoted_message_consumes_normally(self, tmp_path):
        st = _storage(tmp_path)
        try:
            defer(st, "mailbox:flow", "sender-1", payload={"n": 1})
            mark_online(st, "mailbox:flow")
            msgs = unread(st, "mailbox:flow")
            assert len(msgs) == 1
            # 升格消息走既有 consume 轨道：消费即标记，不删除
            from mailbox import consume
            assert consume(st, msgs[0]["id"]) is True
            assert consume(st, msgs[0]["id"]) is False  # 不可重复消费
            assert unread(st, "mailbox:flow") == []
        finally:
            st.close()
