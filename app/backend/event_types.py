"""
event_types.py - Standard 43-Event Model & Immutable Event Data Structures.

Based on the Ovolve Event-Sourced Agent Runtime specification (v1.0):
"Model-visible means logged" - any data reaching the LLM request is reconstructable from the stream.
"""
from __future__ import annotations
import json
import time
from enum import Enum
from dataclasses import dataclass, asdict, field
from typing import Optional, Dict, Any


class EventType(str, Enum):
    # Session lifecycle
    SESSION_CREATED = "session.created"
    SESSION_FORKED = "session.forked"
    SESSION_RESUMED = "session.resumed"
    SESSION_CLOSED = "session.closed"

    # User interactions
    USER_MESSAGE_SUBMITTED = "user.message_submitted"
    USER_MESSAGE_STEERED = "user.message_steered"
    USER_ANSWER_PROVIDED = "user.answer_provided"

    # Agent turn state machine
    AGENT_TURN_STARTED = "agent.turn_started"
    AGENT_TURN_COMPLETED = "agent.turn_completed"
    AGENT_TURN_PAUSED = "agent.turn_paused"
    AGENT_TURN_RESUMED = "agent.turn_resumed"
    AGENT_TURN_CANCELLED = "agent.turn_cancelled"

    # LLM request/response lifecycle
    LLM_REQUEST_SENT = "llm.request_sent"
    LLM_RESPONSE_CHUNK = "llm.response_chunk"
    LLM_RESPONSE_COMPLETED = "llm.response_completed"
    LLM_ERROR_ENCOUNTERED = "llm.error_encountered"

    # Tool call pipeline
    TOOL_CALL_REQUESTED = "tool.call_requested"
    TOOL_CALL_APPROVED = "tool.call_approved"
    TOOL_CALL_DENIED = "tool.call_denied"
    TOOL_EXECUTION_STARTED = "tool.execution_started"
    TOOL_EXECUTION_COMPLETED = "tool.execution_completed"
    TOOL_EXECUTION_FAILED = "tool.execution_failed"
    TOOL_EXECUTION_CANCELLED = "tool.execution_cancelled"

    # Context compaction & memory
    CONTEXT_FOLD_STARTED = "context.fold_started"
    CONTEXT_FOLD_COMPLETED = "context.fold_completed"
    CONTEXT_MICROFOLD_APPLIED = "context.microfold_applied"
    FILE_SNAPSHOT_CAPTURED = "file.snapshot_captured"
    MEMORY_EXTRACTED = "memory.extracted"
    MEMORY_INJECTED = "memory.injected"

    # Sub-agent hierarchy
    SUBAGENT_SPAWNED = "subagent.spawned"
    SUBAGENT_COMPLETED = "subagent.completed"
    SUBAGENT_FAILED = "subagent.failed"

    # Skill lifecycle & experience (learning loop)
    SKILL_STARTED = "skill.started"
    SKILL_COMPLETED = "skill.completed"
    SKILL_FAILED = "skill.failed"
    SKILL_EXPERIENCE_RECORDED = "skill.experience_recorded"

    # Validator evidence (Phase 3 AcceptanceContract)
    VALIDATOR_PASSED = "validator.passed"
    VALIDATOR_FAILED = "validator.failed"
    VALIDATOR_SKIPPED = "validator.skipped"
    VALIDATOR_ERRORED = "validator.errored"

    # System & recovery
    SYSTEM_CHECKPOINT_CREATED = "system.checkpoint_created"
    SYSTEM_ERROR_LOGGED = "system.error_logged"
    SYSTEM_RECOVERY_INITIATED = "system.recovery_initiated"

    # Durable goal execution (checkpoint preflight / Continue-As-New lineage)
    #: Emitted after a successful checkpoint preflight, before the resumed
    #: worker's first round: names the checkpoint the run was rebuilt from and
    #: what its ledger said (dont_redo / verify_before_redo counts).
    GOAL_RESUMED_FROM_CHECKPOINT = "goal.resumed_from_checkpoint"

    #: Goal terminal transitions. These are the events a LearningBundle, an
    #: audit query and the history trace all hang off: before them, "this goal
    #: ended" existed only as a mutable status column, so a finished run left
    #: nothing immutable behind and nothing to anchor idempotency on.
    #: stop_timeout is terminal for the *run*, not the goal: it means we stopped
    #: asking and could not confirm the worker was gone.
    GOAL_COMPLETED = "goal.completed"
    GOAL_FAILED = "goal.failed"
    GOAL_CANCELLED = "goal.cancelled"
    GOAL_STOP_TIMEOUT = "goal.stop_timeout"
    GOAL_RECOVERY_DECIDED = "goal.recovery_decided"

    # Activity lifecycle (Phase 1)
    ACTIVITY_CREATED = "activity.created"
    ACTIVITY_STARTED = "activity.started"
    ACTIVITY_STOPPING = "activity.stopping"
    ACTIVITY_STOP_TIMEOUT = "activity.stop_timeout"
    ACTIVITY_COMPLETED = "activity.completed"
    ACTIVITY_FAILED = "activity.failed"
    ACTIVITY_CANCELLED = "activity.cancelled"
    ACTIVITY_UNKNOWN_EFFECT = "activity.unknown_effect"

    # Side-effect ledger (Phase 2)
    EFFECT_PLANNED = "effect.planned"
    EFFECT_STARTED = "effect.started"
    EFFECT_LANDED = "effect.landed"
    EFFECT_UNKNOWN = "effect.unknown"
    EFFECT_FAILED = "effect.failed"
    EFFECT_VERIFIED = "effect.verified"

    # ConversationEpisode (Phase 4)
    EPISODE_STARTED = "episode.started"
    EPISODE_SEALED = "episode.sealed"

    # LearningItem lifecycle & receipt (Phase 4 & Phase 8)
    LEARNING_ITEM_CREATED = "learning_item.created"
    LEARNING_ITEM_CLASSIFIED = "learning_item.classified"
    LEARNING_ITEM_DEFERRED = "learning_item.deferred"
    LEARNING_ITEM_PROPOSED = "learning_item.proposed"
    LEARNING_ITEM_PUBLISHED = "learning_item.published"
    LEARNING_ITEM_REJECTED = "learning_item.rejected"
    LEARNING_ITEM_FAILED = "learning_item.failed"
    LEARNING_ITEM_ROLLED_BACK = "learning_item.rolled_back"


@dataclass
class AgentEvent:
    """Immutable single atomic event in the session's append-only ledger."""
    seq: int                     # Strictly monotonic sequence number (1, 2, 3...)
    event_type: str              # EventType value
    session_id: str
    timestamp: int               # Microsecond or millisecond Unix timestamp
    payload: Dict[str, Any]      # Structured JSON-serializable payload
    chain_hash: str              # SHA-256(prev_chain_hash + serialized_event_content)
    causation_id: Optional[str] = None   # UUID or event_id that triggered this event
    state_hash: Optional[str] = None     # SHA-256 of pre-event projected state
    resulting_hash: Optional[str] = None # SHA-256 of post-event projected state
    # Phase 1 (canonical run/trace protocol) — identity & correlation. All
    # optional so existing constructors/readers keep working; ``seq`` remains
    # the stream position and must never be used as an identity.
    idempotency_key: Optional[str] = None  # Stable identity of the FACT (retry-safe)
    run_id: Optional[str] = None
    turn_id: Optional[str] = None
    step_id: Optional[str] = None
    tool_call_id: Optional[str] = None
    goal_id: Optional[str] = None
    branch_id: Optional[str] = None
    parent_event_id: Optional[str] = None
    actor: Optional[str] = None            # user|assistant|tool|subagent|system|background
    visibility: str = "audit"              # model|ui|audit|internal
    schema_version: int = 1

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        return d

    @classmethod
    def from_row(cls, row: Any) -> AgentEvent:
        """Hydrate from SQLite Row object or dict."""
        raw_payload = row["payload"] if isinstance(row, dict) or hasattr(row, "__getitem__") else row.payload
        if isinstance(raw_payload, str):
            try:
                payload_dict = json.loads(raw_payload)
            except Exception:
                payload_dict = {"raw": raw_payload}
        else:
            payload_dict = raw_payload or {}

        def _opt(name: str) -> Optional[Any]:
            try:
                return row[name] if name in row.keys() else None
            except Exception:
                return None

        return cls(
            seq=row["seq"],
            event_type=row["event_type"],
            session_id=row["session_id"],
            timestamp=row["timestamp"],
            payload=payload_dict,
            chain_hash=row["chain_hash"],
            causation_id=_opt("causation_id"),
            state_hash=_opt("state_hash"),
            resulting_hash=_opt("resulting_hash"),
            idempotency_key=_opt("idempotency_key"),
            run_id=_opt("run_id"),
            turn_id=_opt("turn_id"),
            step_id=_opt("step_id"),
            tool_call_id=_opt("tool_call_id"),
            goal_id=_opt("goal_id"),
            branch_id=_opt("branch_id"),
            parent_event_id=_opt("parent_event_id"),
            actor=_opt("actor"),
            visibility=_opt("visibility") or "audit",
            schema_version=_opt("schema_version") or 1,
        )


@dataclass
class SessionSnapshot:
    """Materialized projection snapshot for O(1) state recovery."""
    session_id: str
    at_seq: int
    state: Dict[str, Any]
    created_at: int = field(default_factory=lambda: int(time.time() * 1000))
    snapshot_hash: str = ""
