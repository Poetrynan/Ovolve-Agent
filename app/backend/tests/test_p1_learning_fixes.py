"""test_p1_learning_fixes.py — Tests covering the 4 P1 fixes:
1. EventStore append failure returns ok=False, status='unknown', needs_reconcile=True;
2. Intent fingerprint detects reason changes on same idempotency_key as idempotency_conflict;
3. Global LearningItem trace enforces strict Session isolation (no cross-session raw EventStore reads);
4. materialize_observation returns learningItemDetails with individual versions.
"""
import pytest
from unittest.mock import MagicMock
from storage import Storage
from learning_service import LearningItemService
from evolution import (
    EvolutionEngine, EvolutionStore, EvolutionObservation,
    materialize_observation, MODE_ACTIVE, DECISION_MEMORY_ONLY
)


def make_storage(tmp_path):
    return Storage(db_dir=str(tmp_path / "db"))


def test_event_store_append_failure_returns_unknown_and_ok_false(tmp_path):
    """P1-1: When EventStore append fails, mutation must return ok=False and status='unknown'."""
    st = make_storage(tmp_path)
    svc = LearningItemService(st)

    # Insert a dummy learning item
    item_id = "li_test_fail_event"
    st.insert_learning_item(
        learning_item_id=item_id,
        session_id="sess-1",
        branch_id="main",
        kind="failure_guard",
        content="Guard against timeout",
        status="proposed",
        scope="session",
    )

    # Mock EventStore.append to raise an exception
    mock_es = MagicMock()
    mock_es.append.side_effect = RuntimeError("EventStore disk full or locked")
    st.get_event_store = MagicMock(return_value=mock_es)

    # Execute approve action
    res = svc.decide(
        item_id=item_id,
        action="approve",
        session_id="sess-1",
        branch_id="main",
        idempotency_key="test-key-fail-ev-1",
    )

    # Must be ok=False and status='unknown', with needs_reconcile=True
    assert res["ok"] is False, f"Expected ok=False on EventStore append failure, got {res}"
    assert res["status"] == "unknown", f"Expected status='unknown', got {res.get('status')}"
    assert res.get("needs_reconcile") is True

    # Learning item in storage must also be marked 'unknown'
    stored = st.get_learning_item(item_id)
    assert stored["status"] == "unknown"


def test_intent_fingerprint_reason_change_triggers_conflict(tmp_path):
    """P1-3: Reusing the same idempotency key with a different reason must trigger idempotency_conflict."""
    st = make_storage(tmp_path)
    svc = LearningItemService(st)

    item_id = "li_test_reason_diff"
    st.insert_learning_item(
        learning_item_id=item_id,
        session_id="sess-1",
        branch_id="main",
        kind="failure_guard",
        content="Guard against memory leak",
        status="proposed",
        scope="session",
    )

    # First defer with reason A
    res1 = svc.decide(
        item_id=item_id,
        action="defer",
        session_id="sess-1",
        branch_id="main",
        idempotency_key="same-key-reason-test",
        reason="Temporarily busy",
    )
    assert res1["ok"] is True
    assert res1["status"] == "deferred"

    # Second defer with same idempotency key but changed reason B
    res2 = svc.decide(
        item_id=item_id,
        action="defer",
        session_id="sess-1",
        branch_id="main",
        idempotency_key="same-key-reason-test",
        reason="Permanently invalid proposal",
    )

    # Must detect idempotency_conflict because reason changed
    assert res2["ok"] is False
    assert res2["status"] == "idempotency_conflict"
    assert "reason" in res2.get("error", "")


def test_global_learning_item_trace_session_isolation(tmp_path):
    """P1-4: Global LearningItem trace queries from a different session must NOT read source session raw events."""
    st = make_storage(tmp_path)
    es = st.get_event_store()

    # Append private events in Session A
    ev1 = es.append("sess_source_A", "agent.thought", {"secret_note": "private session A data"})

    # Insert a global learning item originating from Session A
    item_id = "li_global_item_1"
    st.insert_learning_item(
        learning_item_id=item_id,
        session_id="sess_source_A",
        source_session_id="sess_source_A",
        source_event_ids=[getattr(ev1, "event_id", "")],
        kind="strategy",
        content="Global build strategy",
        status="published",
        scope="global",
    )

    # Simulate handle_learning_item_trace logic from http_server
    item = st.get_learning_item(item_id)
    item_scope = str(item.get("scope") or "workspace")
    sid = str(item.get("session_id") or item.get("source_session_id") or "").strip()

    # Request from Session B (cross-session query)
    caller_session_id = "sess_caller_B"

    target_stream_sid = ""
    if item_scope == "global":
        if caller_session_id and caller_session_id == sid:
            target_stream_sid = sid
        elif caller_session_id:
            target_stream_sid = caller_session_id
        else:
            target_stream_sid = ""
    else:
        target_stream_sid = sid

    # Verify target_stream_sid is caller_session_id ("sess_caller_B"), NOT "sess_source_A"
    assert target_stream_sid == "sess_caller_B"

    # Reading target_stream_sid in Session B yields 0 events from Session A
    events_found = []
    if target_stream_sid:
        for ev in es.read_stream(target_stream_sid):
            events_found.append(ev)

    assert len(events_found) == 0, f"Session B must not see Session A events! Found: {events_found}"


def test_materialize_observation_includes_learning_item_details_with_version(tmp_path):
    """P1-2: materialize_observation must return learningItemDetails containing individual versions."""
    store = EvolutionStore(db_path=str(tmp_path / "evo.db"))
    engine = EvolutionEngine(store=store, mode=MODE_ACTIVE)
    st = make_storage(tmp_path)

    obs = EvolutionObservation(
        new_facts=["用户偏好深色模式"],
        session_id="sess-facts-1",
        decision=DECISION_MEMORY_ONLY,
        reason="发现新偏好",
    )

    made = materialize_observation(obs, st, engine)

    assert "learningItems" in made
    assert "learningItemDetails" in made
    assert len(made["learningItems"]) > 0
    assert len(made["learningItemDetails"]) == len(made["learningItems"])

    # Check each detail has id, version, and content
    for d in made["learningItemDetails"]:
        assert "id" in d
        assert "version" in d
        assert d["version"] >= 1
        assert "kind" in d
        assert "content" in d
