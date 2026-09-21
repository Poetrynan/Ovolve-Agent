"""Phase 2 — durable recovery primitives.

Pins the guide's Phase 2 acceptance where it is testable in-process:

  * a side-effect ledger: write-class tool calls are recorded before dispatch
    and settled after, and a resumed goal can be told what already landed;
  * cancel honesty: a cancelled turn is recorded as ``turn_cancelled`` in the
    ledger, never as a successful ``turn_completed``;
  * boot recovery: goals left mid-run by a dead process are demoted to paused
    AND get a SYSTEM_RECOVERY_INITIATED event in the ledger;
  * reaped orphan sub-agents get a SUBAGENT_FAILED event, not just a DB row.
"""
from __future__ import annotations

import sqlite3
import uuid

import pytest

from event_store import EventStore
from event_types import EventType


def make_storage(tmp_path):
    from storage import Storage

    return Storage(db_dir=str(tmp_path / "db"))


# ── side-effect ledger ───────────────────────────────────────────────────────

def test_side_effect_lifecycle(tmp_path):
    st = make_storage(tmp_path)
    try:
        st.record_side_effect("sess-1", "goal-1", "call-1", "write_file",
                              "a" * 64)
        # Pending is NOT completed work — a resume must not be told it landed.
        assert st.completed_side_effects("goal-1") == []

        st.settle_side_effect("call-1", ok=True, result_preview="wrote 12 bytes")
        done = st.completed_side_effects("goal-1")
        assert len(done) == 1
        assert done[0]["tool_name"] == "write_file"
        assert done[0]["status"] == "completed"
        assert done[0]["ok"] == 1
    finally:
        st.close()


def test_side_effect_failed_settlement_is_not_completed(tmp_path):
    st = make_storage(tmp_path)
    try:
        st.record_side_effect("sess-1", "goal-1", "call-2", "shell", "b" * 64)
        st.settle_side_effect("call-2", ok=False, result_preview="exit 1")
        assert st.completed_side_effects("goal-1") == []
        # But the row is still queryable for audit.
        c = st._db("sessions")
        row = c.execute("SELECT status FROM tool_side_effects WHERE call_id='call-2'").fetchone()
        assert row["status"] == "failed"
    finally:
        st.close()


def test_side_effect_re_record_same_call_is_one_row(tmp_path):
    st = make_storage(tmp_path)
    try:
        st.record_side_effect("sess-1", "goal-1", "call-3", "write_file", "c" * 64)
        st.record_side_effect("sess-1", "goal-1", "call-3", "write_file", "c" * 64)
        st.settle_side_effect("call-3", ok=True)
        assert len(st.completed_side_effects("goal-1")) == 1
    finally:
        st.close()


def test_resume_advisory_lists_completed_side_effects(tmp_path):
    from recovery import render_completed_side_effects

    st = make_storage(tmp_path)
    try:
        st.record_side_effect("sess-1", "goal-9", "call-a", "write_file", "d" * 64)
        st.settle_side_effect("call-a", ok=True)
        text = render_completed_side_effects("goal-9", st)
        assert "write_file" in text
        assert "d" * 8 in text          # args-hash prefix identifies the call
        assert render_completed_side_effects("goal-none", st) == ""
    finally:
        st.close()


def test_aborted_call_settles_unknown_not_failed(tmp_path):
    """中断的写操作不能记成 failed。

    failed 的语义是「没生效，可以重做」；而一个已经派发出去、然后被
    pause/cancel 打断的调用，结果是**未知**的。记成 failed 会让续跑放心
    重做——对写类工具就是写两次。
    """
    st = make_storage(tmp_path)
    try:
        st.record_side_effect("sess-1", "goal-u", "call-ab", "write_file", "e" * 64)
        st.settle_side_effect("call-ab", ok=False,
                              result_preview="aborted mid-flight", status="unknown")
        row = st._db("sessions").execute(
            "SELECT status, ok FROM tool_side_effects WHERE call_id='call-ab'"
        ).fetchone()
        assert row["status"] == "unknown"
        assert row["ok"] == 0          # 未知不等于成功
        # 未知也不是「已落地」——不能进入 "don't redo" 名单。
        assert st.completed_side_effects("goal-u") == []
    finally:
        st.close()


def test_unknown_side_effects_covers_pending_and_unknown_only(tmp_path):
    st = make_storage(tmp_path)
    try:
        st.record_side_effect("sess-1", "goal-m", "c-pending", "shell", "1" * 64)
        st.record_side_effect("sess-1", "goal-m", "c-unknown", "write_file", "2" * 64)
        st.record_side_effect("sess-1", "goal-m", "c-done", "write_file", "3" * 64)
        st.record_side_effect("sess-1", "goal-m", "c-failed", "shell", "4" * 64)
        st.settle_side_effect("c-unknown", ok=False, status="unknown")
        st.settle_side_effect("c-done", ok=True)
        st.settle_side_effect("c-failed", ok=False)

        ids = [r["call_id"] for r in st.unknown_side_effects("goal-m")]
        assert ids == ["c-pending", "c-unknown"]
        assert st.unknown_side_effects("goal-none") == []
    finally:
        st.close()


def test_resume_advisory_tells_the_model_to_verify_not_skip(tmp_path):
    from recovery import render_unknown_side_effects

    st = make_storage(tmp_path)
    try:
        assert render_unknown_side_effects("goal-v", st) == ""
        st.record_side_effect("sess-1", "goal-v", "call-v", "write_file", "f" * 64)
        st.settle_side_effect("call-v", ok=False, status="unknown")
        text = render_unknown_side_effects("goal-v", st)
        assert "write_file" in text
        assert "不要直接重做" in text
        assert "unknown" in text
    finally:
        st.close()


def test_landed_lookup_only_matches_a_dead_process(tmp_path):
    """重放拦截只认「上一个进程」，不认「本进程里又做了一次」。

    同一次运行里模型重复调用同一个关键操作，是循环检测该管的事；只有跨
    进程（崩溃/暂停之后续跑）那次，重做才等于做了两次。
    """
    st = make_storage(tmp_path)
    try:
        st.record_side_effect("sess-1", "goal-g", "call-g", "git_push", "9" * 64)
        st.settle_side_effect("call-g", ok=True, result_preview="pushed abc123")
        # 本进程写的：不算重放。
        assert st.find_landed_side_effect("goal-g", "git_push", "9" * 64) is None

        c = st._db("sessions")
        c.execute("UPDATE tool_side_effects SET generation='deadproc' WHERE call_id='call-g'")
        c.commit()
        hit = st.find_landed_side_effect("goal-g", "git_push", "9" * 64)
        assert hit and hit["call_id"] == "call-g"
        assert hit["result_preview"] == "pushed abc123"

        # 三个键任一不同就不是同一次调用。
        assert st.find_landed_side_effect("goal-other", "git_push", "9" * 64) is None
        assert st.find_landed_side_effect("goal-g", "git_pull", "9" * 64) is None
        assert st.find_landed_side_effect("goal-g", "git_push", "8" * 64) is None
        assert st.find_landed_side_effect("", "git_push", "9" * 64) is None
    finally:
        st.close()


def test_unlanded_call_from_a_dead_process_is_not_a_replay(tmp_path):
    """只有 completed 才拦。pending/unknown/failed 都不能当「已落地」用——
    拦下一个其实没生效的操作，等于让目标永远做不完那一步。"""
    st = make_storage(tmp_path)
    try:
        for cid, hsh, settle in (("c-p", "a" * 64, None),
                                 ("c-u", "b" * 64, "unknown"),
                                 ("c-f", "c" * 64, "failed")):
            st.record_side_effect("sess-1", "goal-n", cid, "git_push", hsh)
            if settle == "unknown":
                st.settle_side_effect(cid, ok=False, status="unknown")
            elif settle == "failed":
                st.settle_side_effect(cid, ok=False)
        c = st._db("sessions")
        c.execute("UPDATE tool_side_effects SET generation='deadproc' WHERE goal_id='goal-n'")
        c.commit()
        for hsh in ("a" * 64, "b" * 64, "c" * 64):
            assert st.find_landed_side_effect("goal-n", "git_push", hsh) is None
    finally:
        st.close()


def test_side_effect_rows_are_stamped_with_the_writing_process(tmp_path):
    import storage as storage_mod

    st = make_storage(tmp_path)
    try:
        st.record_side_effect("sess-1", "goal-s", "call-s", "write_file", "7" * 64)
        row = st._db("sessions").execute(
            "SELECT generation FROM tool_side_effects WHERE call_id='call-s'"
        ).fetchone()
        assert row["generation"] == storage_mod.PROCESS_GENERATION
        assert "0010_side_effect_generation" in [
            m["id"] for m in st.migration_status()["applied"]]
    finally:
        st.close()


# ── crash injection（真的杀进程，不是 close/reopen）─────────────────────────

def test_killed_process_leaves_an_unknown_effect_a_new_process_can_see(tmp_path):
    """真实断电语义：派发已记账、进程被杀、结算永远没发生。

    其余恢复测试都只是 close/reopen 同一个进程——那验证的是"连接能重开"，
    不是"进程死了之后账本还说得清"。这里用子进程 + kill 制造真正的中途死亡：
    重开的库必须把那条副作用报成未结算（而不是 failed / 不见了），并且它的
    generation 属于一个已经不存在的进程。
    """
    import os
    import subprocess
    import sys
    import time as _t

    from storage import Storage

    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    db_dir = str(tmp_path / "db")
    child_src = (
        "import sys, time\n"
        f"sys.path.insert(0, {backend_dir!r})\n"
        "from storage import Storage, PROCESS_GENERATION\n"
        f"st = Storage(db_dir={db_dir!r})\n"
        "st.record_side_effect('sess-k', 'goal-k', 'call-k', 'write_file', 'd'*64)\n"
        "print('GEN:' + PROCESS_GENERATION, flush=True)\n"
        "time.sleep(60)\n"  # 结算永远不会到来
    )
    # 两头都要钉住编码：子进程的 stdout 被重定向时也走 locale 编码，中文 Windows 上
    # 是 GBK，而 Storage 的启动日志里有 "→"。父进程这边同样得显式 utf-8，否则
    # text=True 会用 GBK 解码，一读就 UnicodeDecodeError——失败的是测试自己，不是
    # 被测代码。
    child_env = dict(os.environ, PYTHONIOENCODING="utf-8")
    proc = subprocess.Popen([sys.executable, "-c", child_src],
                            stdout=subprocess.PIPE, text=True,
                            encoding="utf-8", errors="replace", env=child_env)
    try:
        # Storage 启动时会往 stdout 打日志，所以要读到标记行为止，
        # 不能假设第一行就是我们要的东西。
        child_generation = ""
        deadline = _t.time() + 30
        while _t.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                break
            if line.startswith("GEN:"):
                child_generation = line[4:].strip()
                break
        assert child_generation, "子进程没能写下副作用"
    finally:
        proc.kill()
        proc.wait(timeout=10)
    _t.sleep(0.2)  # 让操作系统把文件锁释放干净

    st = Storage(db_dir=db_dir)
    try:
        unresolved = st.unknown_side_effects("goal-k")
        assert [r["call_id"] for r in unresolved] == ["call-k"]
        assert unresolved[0]["status"] == "pending", \
            "被杀死的调用不能被记成 failed——没人知道它有没有生效"
        assert unresolved[0]["generation"] == child_generation
        assert st.completed_side_effects("goal-k") == []

        # 那条 pending 现在也不是重放拦截的依据：只有 completed 才是。
        assert st.find_landed_side_effect("goal-k", "write_file", "d" * 64) is None

        from recovery import render_unknown_side_effects
        assert "不要直接重做" in render_unknown_side_effects("goal-k", st)
    finally:
        st.close()


# ── cancel honesty ───────────────────────────────────────────────────────────

def test_cancelled_turn_is_recorded_as_cancelled(tmp_path):
    from event_bus import EventBus
    from router_trace import RouterTraceBridge

    store = EventStore(db_path=str(tmp_path / "events.db"))
    bus = EventBus()
    RouterTraceBridge(bus, session_id="sess-1", store=store).mount()

    import asyncio

    async def run():
        await bus.emit("agent_phase", {"session_id": "sess-1", "phase": "turn_entered"})
        await bus.emit("agent_phase", {"session_id": "sess-1", "phase": "turn_completed",
                                       "ok": True, "cancelled": True})

    asyncio.run(run())

    events = store.read_stream("sess-1")
    types = [e.event_type for e in events]
    assert EventType.AGENT_TURN_CANCELLED.value in types
    assert EventType.AGENT_TURN_COMPLETED.value not in types


def test_normal_completion_still_records_completed(tmp_path):
    from event_bus import EventBus
    from router_trace import RouterTraceBridge

    store = EventStore(db_path=str(tmp_path / "events.db"))
    bus = EventBus()
    RouterTraceBridge(bus, session_id="sess-1", store=store).mount()

    import asyncio

    async def run():
        await bus.emit("agent_phase", {"session_id": "sess-1", "phase": "turn_entered"})
        await bus.emit("agent_phase", {"session_id": "sess-1", "phase": "turn_completed",
                                       "ok": True})

    asyncio.run(run())

    types = [e.event_type for e in store.read_stream("sess-1")]
    assert EventType.AGENT_TURN_COMPLETED.value in types


# ── boot recovery ────────────────────────────────────────────────────────────

def test_recover_interrupted_goals_demotes_and_records(tmp_path):
    from recovery import recover_interrupted_goals

    st = make_storage(tmp_path)
    try:
        sid = "sess-r"
        st.create_session(sid, "recovery")
        gid = "goal-r1"
        gc = st._db("goals")
        gc.execute(
            "INSERT INTO goals (id, description, status, session_id, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?)",
            (gid, "do things", "running", sid, 1, 1),
        )
        gc.commit()
        demoted = recover_interrupted_goals(st)
        assert [g["id"] for g in demoted] == [gid]
        row = st.get_goal(gid)
        assert row["status"] == "paused"
        assert "restart" in (row.get("last_error") or "")
        kinds = [e.event_type for e in st.get_event_store().read_stream(sid)]
        assert EventType.SYSTEM_RECOVERY_INITIATED.value in kinds
    finally:
        st.close()


def test_reaped_orphan_gets_subagent_failed_event(tmp_path):
    from recovery import record_reaped_subagents

    st = make_storage(tmp_path)
    try:
        rows = [{"subagent_id": "sa-1", "parent_session_id": "sess-o",
                 "status": "running", "goal_id": "goal-x"}]
        n = record_reaped_subagents(st, rows)
        assert n == 1
        kinds = [e.event_type for e in st.get_event_store().read_stream("sess-o")]
        assert EventType.SUBAGENT_FAILED.value in kinds
    finally:
        st.close()


def test_0002_applies_to_a_database_that_already_ran_0001(tmp_path):
    """回归：tool_side_effects 的 DDL 曾被写进已应用的 0001 迁移里。

    迁移 id 每个库只跑一次，而真实库早已记录 0001 —— 结果表只在测试里
    存在（测试永远从空库起步），真实库永远建不出来。本测试复刻那条升级
    路径：一个只记录了 0001 的旧库，用当前代码打开，0002 必须补上表并
    记入台账。
    """
    import sqlite3

    db_dir = tmp_path / "db"
    db_dir.mkdir()
    c = sqlite3.connect(str(db_dir / "configs.db"))
    c.execute(
        "CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT,"
        " app_version TEXT, applied_at INTEGER)"
    )
    c.execute("INSERT INTO schema_migration (id) VALUES ('0001_subagent_runs')")
    c.commit()
    c.close()

    st = make_storage(tmp_path)
    try:
        row = st._db("sessions").execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
            " AND name='tool_side_effects'"
        ).fetchone()
        assert row, "只跑过 0001 的库升级后必须有 tool_side_effects 表"
        status = st.migration_status()
        applied = [m["id"] for m in status["applied"]]
        assert "0001_subagent_runs" in applied, "0001 已应用过，不得重跑"
        assert "0002_tool_side_effects" in applied
        assert status["pending"] == []
    finally:
        st.close()


# ── 0021–0024 ────────────────────────────────────────────────────────────────

def _ids(st):
    return [m["id"] for m in st.migration_status()["applied"]]


def test_migrations_0021_to_0024_are_registered(tmp_path):
    st = make_storage(tmp_path)
    try:
        applied = _ids(st)
        for mid in ("0021_capability_probes", "0022_memory_hygiene",
                    "0023_workflow_patterns", "0024_caller_call_id"):
            assert mid in applied, mid
        assert st.migration_status()["pending"] == []
    finally:
        st.close()


def test_0024_self_heals_a_ledger_that_lies(tmp_path):
    """回归：台账记着 0001 却没有 subagent_runs 表。

    0024 在这种库上裸 ALTER/建索引会抛 no such table，runner 当失败处理并
    回滚——把本次已跑完的 0002–0023 一起抹掉。所以它必须先自愈建表。
    """
    import sqlite3

    db_dir = tmp_path / "db"
    db_dir.mkdir()
    c = sqlite3.connect(str(db_dir / "configs.db"))
    c.execute("CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT,"
              " app_version TEXT, applied_at INTEGER)")
    c.execute("INSERT INTO schema_migration (id) VALUES ('0001_subagent_runs')")
    c.commit()
    c.close()

    st = make_storage(tmp_path)
    try:
        cols = [r["name"] for r in
                st._db("sessions").execute("PRAGMA table_info(subagent_runs)").fetchall()]
        assert "caller_call_id" in cols
        # 0002 必须还在——0024 失败会把这条一起回滚掉
        assert "0002_tool_side_effects" in _ids(st)
        assert st.migration_status()["pending"] == []
        assert getattr(st, "recovery_mode", None) != "compat"
    finally:
        st.close()


def test_migrations_are_idempotent_on_second_open(tmp_path):
    st = make_storage(tmp_path)
    try:
        assert st.migration_status()["pending"] == []
    finally:
        st.close()
    again = make_storage(tmp_path)
    try:
        assert again.migration_status()["pending"] == []
        assert "0024_caller_call_id" in _ids(again)
    finally:
        again.close()


def test_caller_call_id_round_trips_through_the_ledger(tmp_path):
    st = make_storage(tmp_path)
    try:
        st.upsert_subagent_run("sub-1", parent_session_id="p", status="completed",
                               caller_call_id="call-abc")
        st.upsert_subagent_run("sub-2", parent_session_id="p", status="completed",
                               caller_call_id="call-abc")
        st.upsert_subagent_run("sub-3", parent_session_id="p", status="completed",
                               caller_call_id="call-xyz")
        rows = st.list_subagent_runs("p")
        by_caller = {}
        for r in rows:
            by_caller.setdefault(r["caller_call_id"], []).append(r["subagent_id"])
        assert sorted(by_caller["call-abc"]) == ["sub-1", "sub-2"]
        assert by_caller["call-xyz"] == ["sub-3"]
    finally:
        st.close()


def test_legacy_rows_without_the_column_read_as_empty(tmp_path):
    """老数据没有 caller_call_id——读侧必须拿到空串而不是 KeyError。"""
    st = make_storage(tmp_path)
    try:
        st.upsert_subagent_run("sub-old", parent_session_id="p", status="completed")
        row = [r for r in st.list_subagent_runs("p") if r["subagent_id"] == "sub-old"][0]
        assert row["caller_call_id"] == ""
    finally:
        st.close()
