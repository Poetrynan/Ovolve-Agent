import pytest

try:
    from task_states import (
        GoalStatus,
        TurnStatus,
        PlanStepStatus,
        TaskStateEvent,
        record_task_state_transition,
        validate_transition,
    )
    from event_bus import get_event_bus
except ImportError:
    from app.backend.task_states import (
        GoalStatus,
        TurnStatus,
        PlanStepStatus,
        TaskStateEvent,
        record_task_state_transition,
        validate_transition,
    )
    from app.backend.event_bus import get_event_bus

def test_goal_status_values():
    assert GoalStatus.ACTIVE.value == "active"
    assert GoalStatus.COMPLETED.value == "completed"
    assert GoalStatus.FAILED.value == "failed"

def test_turn_status_values():
    assert TurnStatus.PRE_CHECK.value == "pre_check"
    assert TurnStatus.WAITING_CONFIRMATION.value == "waiting_confirmation"
    assert TurnStatus.STEER_PENDING.value == "steer_pending"

def test_validate_transition():
    assert validate_transition("turn", TurnStatus.PRE_CHECK, TurnStatus.RUNNING) is True
    assert validate_transition("turn", TurnStatus.COMPLETED, TurnStatus.RUNNING) is False

def test_record_task_state_transition_emits_event():
    bus = get_event_bus()
    captured = []
    def _handler(ev):
        captured.append(ev)
    bus.subscribe("task_state_changed", _handler)
    try:
        ev = record_task_state_transition(
            layer="turn",
            task_id="turn_test_123",
            old_state=TurnStatus.PRE_CHECK,
            new_state=TurnStatus.RUNNING,
            session_id="sess_1",
            meta={"step": 0},
        )
        assert ev.task_id == "turn_test_123"
        assert len(captured) >= 1
        assert captured[-1].payload["new_state"] == "running"
    finally:
        bus.unsubscribe("task_state_changed", _handler)
