"""Phase 1 — canonical trace gateway, idempotency, correlation, bridge.

Pins the guide's Phase 1 acceptance in executable form:

  * duplicate appends with the same idempotency key must not create a second
    fact (a retried write after a crash is the whole point of the key);
  * run/turn/step/tool correlation fields must survive a round-trip so a turn
    can be rebuilt from the stream;
  * an events.db created by an OLDER build (no new columns) must be migrated
    in place, not rejected;
  * the gateway is the single write path: it validates, redacts secrets, and
    fails loudly for critical events instead of silently dropping them;
  * RouterTraceBridge maps the bus phases onto the existing EventType
    vocabulary with a stable per-turn id.
"""
from __future__ import annotations

import sqlite3
import uuid

import pytest

from event_store import EventStore
from event_types import EventType


def make_store(tmp_path) -> EventStore:
    return EventStore(db_path=str(tmp_path / "events.db"))


# ── idempotency ──────────────────────────────────────────────────────────────

def test_append_with_same_idempotency_key_returns_existing_event(tmp_path):
    store = make_store(tmp_path)
    sid = str(uuid.uuid4())
    first = store.append(sid, EventType.SESSION_CREATED, {"title": "t"},
                         idempotency_key=f"session:create:{sid}")
    again = store.append(sid, EventType.SESSION_CREATED, {"title": "t"},
                         idempotency_key=f"session:create:{sid}")
    assert again.seq == first.seq
    assert store.get_event_count(sid) == 1


def test_different_keys_still_append_normally(tmp_path):
    store = make_store(tmp_path)
    sid = str(uuid.uuid4())
    store.append(sid, EventType.USER_MESSAGE_SUBMITTED, {"m": 1}, idempotency_key="a")
    store.append(sid, EventType.USER_MESSAGE_SUBMITTED, {"m": 2}, idempotency_key="b")
    assert store.get_event_count(sid) == 2


# ── correlation fields ───────────────────────────────────────────────────────

def test_correlation_fields_round_trip(tmp_path):
    store = make_store(tmp_path)
    sid = str(uuid.uuid4())
    store.append(
        sid, EventType.TOOL_EXECUTION_STARTED, {"tool": "read_file"},
        run_id="run-1", turn_id="turn-1", step_id="step-3",
        tool_call_id="call-9", goal_id="goal-2", branch_id="br-1",
        parent_event_id="ev-7", actor="assistant", visibility="model",
    )
    events = store.read_stream(sid)
    assert events[0].turn_id == "turn-1"
    assert events[0].run_id == "run-1"
    assert events[0].step_id == "step-3"
    assert events[0].tool_call_id == "call-9"
    assert events[0].goal_id == "goal-2"
    assert events[0].branch_id == "br-1"
    assert events[0].parent_event_id == "ev-7"
    assert events[0].actor == "assistant"
    assert events[0].visibility == "model"
    assert events[0].schema_version == 1


def test_chain_still_verifies_with_new_fields(tmp_path):
    store = make_store(tmp_path)
    sid = str(uuid.uuid4())
    for i in range(5):
        store.append(sid, EventType.USER_MESSAGE_SUBMITTED, {"i": i},
                     turn_id="turn-1", idempotency_key=f"k{i}")
    report = store.verify_chain(sid)
    assert report["valid"] is True


# ── in-place migration of an old-schema events.db ────────────────────────────

def test_old_schema_db_is_migrated_in_place(tmp_path):
    db = tmp_path / "events.db"
    conn = sqlite3.connect(db)
    # The pre-Phase-1 schema, verbatim.
    conn.execute("""
        CREATE TABLE agent_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            causation_id TEXT,
            timestamp INTEGER NOT NULL,
            payload TEXT NOT NULL,
            state_hash TEXT,
            resulting_hash TEXT,
            chain_hash TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()

    store = EventStore(db_path=str(db))  # must migrate, not crash
    sid = str(uuid.uuid4())
    store.append(sid, EventType.SESSION_CREATED, {"title": "migrated"},
                 turn_id="turn-1")
    events = store.read_stream(sid)
    assert len(events) == 1
    assert events[0].turn_id == "turn-1"
    assert store.verify_chain(sid)["valid"] is True


# ── gateway ──────────────────────────────────────────────────────────────────

def test_gateway_rejects_invalid_events(tmp_path):
    from trace_gateway import TraceGateway

    gw = TraceGateway(make_store(tmp_path))
    with pytest.raises(ValueError):
        gw.append(session_id="", event_type=EventType.SESSION_CREATED, payload={})
    with pytest.raises(ValueError):
        gw.append(session_id="s", event_type="not.a.real.event", payload={})
    with pytest.raises(ValueError):
        gw.append(session_id="s", event_type=EventType.SESSION_CREATED, payload="not-a-dict")  # type: ignore[arg-type]


def test_gateway_redacts_secrets_from_payload(tmp_path):
    from trace_gateway import TraceGateway

    gw = TraceGateway(make_store(tmp_path))
    sid = str(uuid.uuid4())
    gw.append(session_id=sid, event_type=EventType.TOOL_EXECUTION_COMPLETED,
              payload={"tool": "shell", "output": "ok",
                       "api_key": "sk-super-secret", "nested": {"password": "hunter2"}})
    (ev,) = gw.store.read_stream(sid)
    assert "sk-super-secret" not in str(ev.payload)
    assert "hunter2" not in str(ev.payload)
    assert ev.payload["api_key"] == "[REDACTED]"
    assert ev.payload["nested"]["password"] == "[REDACTED]"


def test_gateway_critical_failure_raises_observational_degrades(tmp_path):
    from trace_gateway import TraceGateway

    store = make_store(tmp_path)

    def boom(*a, **k):
        raise sqlite3.OperationalError("disk full")

    store.append = boom  # type: ignore[method-assign]
    gw = TraceGateway(store)
    with pytest.raises(sqlite3.OperationalError):
        gw.append(session_id="s", event_type=EventType.SESSION_CREATED,
                  payload={}, importance="critical")
    # Observational events degrade instead of raising: the trace mirror must
    # never take down the feature it is observing. (Failure is logged, not
    # silent — that is the gateway's contract, not this test's concern.)
    assert gw.append(session_id="s", event_type=EventType.AGENT_TURN_STARTED,
                     payload={}, importance="observational") is None


def test_storage_appends_become_idempotent(tmp_path):
    from storage import Storage

    st = Storage(db_dir=str(tmp_path / "db"))
    try:
        sid = str(uuid.uuid4())
        st.create_session(sid, "once")
        st.create_session(sid, "twice")  # INSERT OR IGNORE + same idempotency key
        events = st.get_event_store().read_stream(sid)
        created = [e for e in events if e.event_type == EventType.SESSION_CREATED.value]
        assert len(created) == 1
        assert st.get_event_store().verify_chain(sid)["valid"] is True
    finally:
        st.close()


# ── router trace bridge ──────────────────────────────────────────────────────

def test_bridge_maps_phases_to_events_with_stable_turn_id(tmp_path):
    from event_bus import EventBus
    from router_trace import RouterTraceBridge

    store = make_store(tmp_path)
    bus = EventBus()
    bridge = RouterTraceBridge(bus, session_id="sess-1", store=store)
    bridge.mount()

    async def run():
        await bus.emit("agent_phase", {"session_id": "sess-1", "phase": "turn_entered", "turn_id": None})
        await bus.emit("agent_phase", {"session_id": "sess-1", "phase": "model_call_started", "turn_id": None})
        await bus.emit("agent_phase", {"session_id": "sess-1", "phase": "turn_completed", "turn_id": None})
        # Another session's traffic on the same bus must be ignored.
        await bus.emit("agent_phase", {"session_id": "sess-2", "phase": "turn_entered", "turn_id": None})

    import asyncio
    asyncio.run(run())

    events = store.read_stream("sess-1")
    types = [e.event_type for e in events]
    assert types == [
        EventType.AGENT_TURN_STARTED.value,
        EventType.LLM_REQUEST_SENT.value,
        EventType.AGENT_TURN_COMPLETED.value,
    ]
    turn_ids = {e.turn_id for e in events}
    assert len(turn_ids) == 1 and None not in turn_ids
    assert store.get_event_count("sess-2") == 0
    assert store.verify_chain("sess-1")["valid"] is True


def test_bridge_never_raises_into_the_bus(tmp_path):
    from event_bus import EventBus
    from router_trace import RouterTraceBridge

    store = make_store(tmp_path)
    store.append = lambda *a, **k: (_ for _ in ()).throw(sqlite3.OperationalError("gone"))
    bus = EventBus()
    RouterTraceBridge(bus, session_id="sess-1", store=store).mount()

    import asyncio

    async def run():
        await bus.emit("agent_phase", {"session_id": "sess-1", "phase": "turn_entered"})

    asyncio.run(run())  # must not raise


# ── goal/run attribution + cross-cutting query ───────────────────────────────

def test_bridge_stamps_goal_and_run_on_every_event_of_the_turn(tmp_path):
    """一个目标的回合里，phase/工具事件都必须带得上 goal_id/run_id。

    以前这条链只写 turn_id/tool_call_id，于是「这个目标干了什么」在账本里
    无从筛选——调度器手上明明同时有 goal_id 和 run_id。
    """
    from event_bus import EventBus
    from router_trace import RouterTraceBridge

    store = make_store(tmp_path)
    bus = EventBus()
    RouterTraceBridge(bus, session_id="sess-g", store=store).mount()

    import asyncio

    async def run():
        await bus.emit("agent_phase", {"session_id": "sess-g", "phase": "turn_entered",
                                       "goal_id": "goal-1", "run_id": "run-1"})
        await bus.emit("pre_tool_use", {"session_id": "sess-g", "call_id": "c1",
                                        "tool_name": "write_file", "args": {}})
        await bus.emit("tool_result", {"session_id": "sess-g", "call_id": "c1",
                                       "tool_name": "write_file", "status": "completed",
                                       "result": {"ok": True},
                                       "context": {"goal_id": "goal-1", "run_id": "run-1"}})
        await bus.emit("agent_phase", {"session_id": "sess-g", "phase": "turn_completed",
                                       "ok": True})

    asyncio.run(run())

    events = store.read_stream("sess-g")
    assert len(events) == 4
    assert {e.goal_id for e in events} == {"goal-1"}
    assert {e.run_id for e in events} == {"run-1"}


def test_next_plain_turn_does_not_inherit_the_goal(tmp_path):
    from event_bus import EventBus
    from router_trace import RouterTraceBridge

    store = make_store(tmp_path)
    bus = EventBus()
    RouterTraceBridge(bus, session_id="sess-h", store=store).mount()

    import asyncio

    async def run():
        await bus.emit("agent_phase", {"session_id": "sess-h", "phase": "turn_entered",
                                       "goal_id": "goal-1", "run_id": "run-1"})
        await bus.emit("agent_phase", {"session_id": "sess-h", "phase": "turn_completed",
                                       "ok": True})
        # 普通聊天回合：没有 goal_id，不能沿用上一回合的。
        await bus.emit("agent_phase", {"session_id": "sess-h", "phase": "turn_entered"})
        await bus.emit("agent_phase", {"session_id": "sess-h", "phase": "turn_completed",
                                       "ok": True})

    asyncio.run(run())

    events = store.read_stream("sess-h")
    assert [e.goal_id for e in events] == ["goal-1", "goal-1", None, None]


def test_read_by_dimension_spans_sessions_and_rejects_unknown_columns(tmp_path):
    """目标跨会话：续跑会开新会话，所以按 session 读永远读不全一个目标。"""
    from event_types import EventType as ET

    store = make_store(tmp_path)
    for sid in ("sess-a", "sess-b"):
        store.append(sid, ET.AGENT_TURN_STARTED, {"phase": "turn_entered"},
                     goal_id="goal-x", run_id=f"run-{sid}")
    store.append("sess-a", ET.AGENT_TURN_STARTED, {"phase": "turn_entered"},
                 goal_id="goal-other")

    rows = store.read_by_dimension("goal_id", "goal-x")
    assert len(rows) == 2
    assert {r.session_id for r in rows} == {"sess-a", "sess-b"}
    assert [r.seq for r in rows] == sorted(r.seq for r in rows)

    # 收窄到单会话 / 空值 / 非白名单列
    assert len(store.read_by_dimension("goal_id", "goal-x", session_id="sess-a")) == 1
    assert store.read_by_dimension("goal_id", "") == []
    with pytest.raises(ValueError):
        store.read_by_dimension("payload", "anything")


def test_append_batch_keeps_attribution(tmp_path):
    """fork 克隆过去的历史必须保留 goal/run/turn 归属，否则副本查不出任何维度。"""
    from event_types import EventType as ET

    store = make_store(tmp_path)
    out = store.append_batch("sess-fork", [{
        "event_type": ET.AGENT_TURN_STARTED,
        "payload": {"phase": "turn_entered"},
        "goal_id": "goal-z",
        "run_id": "run-z",
        "turn_id": "turn-z",
        "actor": "assistant",
    }])
    assert out[0].goal_id == "goal-z"
    row = store.read_stream("sess-fork")[0]
    assert (row.goal_id, row.run_id, row.turn_id) == ("goal-z", "run-z", "turn-z")
    assert store.read_by_dimension("goal_id", "goal-z")[0].session_id == "sess-fork"
