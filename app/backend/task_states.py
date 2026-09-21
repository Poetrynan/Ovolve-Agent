"""task_states.py — 3-Tier Task Hierarchy & State Transition Engine.

Three-tier hierarchy (Goal / Subagent / Todo) plus an explicit WaitConfirm state.
"""
from __future__ import annotations
import enum
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

try:
    from event_bus import get_event_bus, Event
except ImportError:
    from app.backend.event_bus import get_event_bus, Event

class GoalStatus(str, enum.Enum):
    PENDING = "pending"
    ACTIVE = "active"
    PAUSED = "paused"
    WAITING_USER = "waiting_user"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

class TurnStatus(str, enum.Enum):
    QUEUED = "queued"
    PRE_CHECK = "pre_check"
    RUNNING = "running"
    WAITING_CONFIRMATION = "waiting_confirmation"
    STEER_PENDING = "steer_pending"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

class PlanStepStatus(str, enum.Enum):
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    DONE = "done"
    FAILED = "failed"
    SKIPPED = "skipped"

_VALID_TRANSITIONS = {
    "goal": {
        GoalStatus.PENDING: {GoalStatus.ACTIVE, GoalStatus.CANCELLED},
        GoalStatus.ACTIVE: {GoalStatus.PAUSED, GoalStatus.WAITING_USER, GoalStatus.COMPLETED, GoalStatus.FAILED, GoalStatus.CANCELLED},
        GoalStatus.PAUSED: {GoalStatus.ACTIVE, GoalStatus.CANCELLED},
        GoalStatus.WAITING_USER: {GoalStatus.ACTIVE, GoalStatus.CANCELLED},
        GoalStatus.COMPLETED: set(),
        GoalStatus.FAILED: {GoalStatus.ACTIVE},
        GoalStatus.CANCELLED: set(),
    },
    "turn": {
        TurnStatus.QUEUED: {TurnStatus.PRE_CHECK, TurnStatus.CANCELLED},
        TurnStatus.PRE_CHECK: {TurnStatus.RUNNING, TurnStatus.WAITING_CONFIRMATION, TurnStatus.FAILED, TurnStatus.CANCELLED},
        TurnStatus.RUNNING: {TurnStatus.WAITING_CONFIRMATION, TurnStatus.STEER_PENDING, TurnStatus.COMPLETED, TurnStatus.FAILED, TurnStatus.CANCELLED},
        TurnStatus.WAITING_CONFIRMATION: {TurnStatus.RUNNING, TurnStatus.FAILED, TurnStatus.CANCELLED},
        TurnStatus.STEER_PENDING: {TurnStatus.RUNNING, TurnStatus.CANCELLED},
        TurnStatus.COMPLETED: set(),
        TurnStatus.FAILED: set(),
        TurnStatus.CANCELLED: set(),
    },
}

def validate_transition(layer: str, old_state: Any, new_state: Any) -> bool:
    table = _VALID_TRANSITIONS.get(layer)
    if not table:
        return True
    allowed = table.get(old_state)
    if allowed is None:
        return True
    return new_state in allowed

@dataclass
class TaskStateEvent:
    layer: str
    task_id: str
    old_state: str
    new_state: str
    session_id: str = ""
    timestamp: float = field(default_factory=time.time)
    meta: Dict[str, Any] = field(default_factory=dict)

def record_task_state_transition(
    layer: str,
    task_id: str,
    old_state: Any,
    new_state: Any,
    session_id: str = "",
    meta: Optional[Dict[str, Any]] = None,
) -> TaskStateEvent:
    old_val = old_state.value if hasattr(old_state, "value") else str(old_state)
    new_val = new_state.value if hasattr(new_state, "value") else str(new_state)
    ev = TaskStateEvent(
        layer=layer,
        task_id=task_id,
        old_state=old_val,
        new_state=new_val,
        session_id=session_id,
        meta=meta or {},
    )
    bus = get_event_bus()
    bus.emit_sync("task_state_changed", {
        "layer": layer,
        "task_id": task_id,
        "old_state": old_val,
        "new_state": new_val,
        "session_id": session_id,
        "timestamp": ev.timestamp,
        "meta": ev.meta,
    })
    return ev
