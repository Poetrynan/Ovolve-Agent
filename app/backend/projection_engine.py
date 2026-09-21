"""
projection_engine.py - High-Fidelity State Projection & Time-Travel Engine.

Reconstructs complete SessionState and Message[] histories by folding
immutable AgentEvent streams over deterministic transition reducers.
"""
from __future__ import annotations
import json
import time
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, field, asdict
from event_types import EventType, AgentEvent, SessionSnapshot
from event_store import EventStore, get_event_store
from trace_gateway import TraceGateway


@dataclass
class ProjectedSessionState:
    """Deterministic snapshot projection of an agent session."""
    session_id: str
    title: str = "New Session"
    status: str = "idle"         # "idle" | "running" | "paused" | "error" | "closed"
    created_at: int = 0
    updated_at: int = 0
    current_turn: int = 0
    last_seq: int = 0
    goal_state: Optional[Dict[str, Any]] = None
    messages: List[Dict[str, Any]] = field(default_factory=list)
    active_tools: Dict[str, Any] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> ProjectedSessionState:
        return cls(
            session_id=data["session_id"],
            title=data.get("title", "New Session"),
            status=data.get("status", "idle"),
            created_at=data.get("created_at", 0),
            updated_at=data.get("updated_at", 0),
            current_turn=data.get("current_turn", 0),
            last_seq=data.get("last_seq", 0),
            goal_state=data.get("goal_state"),
            messages=data.get("messages", []),
            active_tools=data.get("active_tools", {}),
            metadata=data.get("metadata", {}),
        )


class SessionProjector:
    """Pure functional deterministic state projector."""

    @staticmethod
    def apply_event(state: ProjectedSessionState, event: AgentEvent) -> ProjectedSessionState:
        """Deterministic state reducer for a single AgentEvent."""
        state.last_seq = event.seq
        state.updated_at = event.timestamp
        p = event.payload or {}
        etype = event.event_type

        if etype == EventType.SESSION_CREATED.value:
            state.title = p.get("title", state.title)
            state.created_at = event.timestamp
            state.metadata.update(p.get("metadata", {}))

        elif etype == EventType.SESSION_FORKED.value:
            state.title = p.get("title", f"Fork of {p.get('source_session_id')}")
            state.created_at = event.timestamp

        elif etype == EventType.SESSION_CLOSED.value:
            state.status = "closed"

        elif etype == EventType.USER_MESSAGE_SUBMITTED.value:
            msg_id = p.get("message_id") or f"user_{event.seq}"
            state.messages.append({
                "id": msg_id,
                "role": "user",
                "content": p.get("content", ""),
                "msg_type": "message",
                "metadata": p.get("metadata", {}),
                "created_at": event.timestamp,
                "seq": event.seq,
            })

        elif etype == EventType.AGENT_TURN_STARTED.value:
            state.status = "running"
            state.current_turn = p.get("turn", state.current_turn + 1)

        elif etype == EventType.AGENT_TURN_COMPLETED.value:
            state.status = "idle"

        elif etype == EventType.AGENT_TURN_PAUSED.value:
            state.status = "paused"

        elif etype == EventType.AGENT_TURN_CANCELLED.value:
            state.status = "idle"

        elif etype == EventType.LLM_RESPONSE_COMPLETED.value:
            msg_id = p.get("message_id") or f"assistant_{event.seq}"
            # Check if this message was already partially constructed
            content = p.get("content", "")
            tool_calls = p.get("tool_calls", [])
            reasoning = p.get("reasoning", "")
            state.messages.append({
                "id": msg_id,
                "role": "assistant",
                "content": content,
                "msg_type": "message",
                "metadata": {
                    "tool_calls": tool_calls,
                    "reasoning": reasoning,
                    **p.get("metadata", {}),
                },
                "created_at": event.timestamp,
                "seq": event.seq,
            })

        elif etype == EventType.TOOL_EXECUTION_STARTED.value:
            tool_id = p.get("call_id") or f"call_{event.seq}"
            state.active_tools[tool_id] = {
                "id": tool_id,
                "tool_name": p.get("tool_name"),
                "args": p.get("args", {}),
                "started_at": event.timestamp,
                "status": "running",
            }

        elif etype == EventType.TOOL_EXECUTION_COMPLETED.value:
            tool_id = p.get("call_id") or f"call_{event.seq}"
            if tool_id in state.active_tools:
                state.active_tools[tool_id]["status"] = "completed"
                state.active_tools[tool_id]["result"] = p.get("result")
                state.active_tools[tool_id]["completed_at"] = event.timestamp

        elif etype == EventType.TOOL_EXECUTION_FAILED.value:
            tool_id = p.get("call_id") or f"call_{event.seq}"
            if tool_id in state.active_tools:
                state.active_tools[tool_id]["status"] = "failed"
                state.active_tools[tool_id]["error"] = p.get("error")
                state.active_tools[tool_id]["completed_at"] = event.timestamp

        elif etype == EventType.CONTEXT_FOLD_COMPLETED.value:
            # Compacted context event
            summary = p.get("summary")
            if summary:
                state.metadata["last_compaction"] = {
                    "at_seq": event.seq,
                    "summary": summary,
                    "folded_events": p.get("folded_events_count", 0),
                }

        return state


class ProjectionEngine:
    """Orchestrates snapshot recovery and stream projection."""

    def __init__(self, event_store: Optional[EventStore] = None):
        self.event_store = event_store or get_event_store()

    def project_session(
        self,
        session_id: str,
        at_seq: Optional[int] = None,
    ) -> ProjectedSessionState:
        """
        Projects full session state from SQLite event stream.
        Utilizes latest snapshot as base for O(1) acceleration.
        """
        initial_state = ProjectedSessionState(session_id=session_id)
        from_seq = 0

        # If projecting up to a specific at_seq, check for snapshot <= at_seq
        latest_snapshot = self.event_store.get_latest_snapshot(session_id)
        if latest_snapshot and (at_seq is None or latest_snapshot.at_seq <= at_seq):
            initial_state = ProjectedSessionState.from_dict(latest_snapshot.state)
            from_seq = latest_snapshot.at_seq + 1

        events = self.event_store.read_stream(
            session_id=session_id,
            from_seq=from_seq,
            to_seq=at_seq,
        )

        state = initial_state
        for ev in events:
            state = SessionProjector.apply_event(state, ev)

        return state

    def fork_at_seq(
        self,
        source_session_id: str,
        fork_point_seq: int,
        new_session_id: str,
        new_title: Optional[str] = None,
    ) -> ProjectedSessionState:
        """
        Performs precise Time-Travel Fork:
        Copies all events from source session up to fork_point_seq into the new session,
        re-anchoring their cryptographic chain hashes to the new session.
        """
        source_events = self.event_store.read_stream(
            session_id=source_session_id,
            from_seq=0,
            to_seq=fork_point_seq,
        )

        # Append fork initiation event first
        title = new_title or f"Fork of {source_session_id} @ seq {fork_point_seq}"
        TraceGateway(self.event_store).append(
            session_id=new_session_id,
            event_type=EventType.SESSION_FORKED,
            payload={
                "source_session_id": source_session_id,
                "fork_point_seq": fork_point_seq,
                "title": title,
                "lineage_root": source_session_id,
            },
            importance="critical",
            idempotency_key=f"session:fork:{new_session_id}",
            actor="system",
        )

        # Batch copy prior events with new session_id
        batch_to_clone = []
        for ev in source_events:
            # Skip the original session created event
            if ev.event_type in (EventType.SESSION_CREATED.value, EventType.SESSION_FORKED.value):
                continue
            batch_to_clone.append({
                "event_type": ev.event_type,
                "payload": ev.payload,
                "causation_id": f"clone_from_{source_session_id}_{ev.seq}",
                "timestamp": ev.timestamp,
                # Carry the attribution across the fork. A cloned turn belongs
                # to the same goal/run/tool call it did in the source session;
                # dropping the ids made the fork's history unqueryable by any
                # dimension except session.
                "run_id": ev.run_id,
                "turn_id": ev.turn_id,
                "step_id": ev.step_id,
                "tool_call_id": ev.tool_call_id,
                "goal_id": ev.goal_id,
                "branch_id": ev.branch_id,
                "actor": ev.actor,
            })

        if batch_to_clone:
            self.event_store.append_batch(new_session_id, batch_to_clone)

        # Project and return state of the newly forked session
        return self.project_session(new_session_id)


_projection_engine: Optional[ProjectionEngine] = None

def get_projection_engine(event_store: Optional[EventStore] = None) -> ProjectionEngine:
    global _projection_engine
    if _projection_engine is None or event_store is not None:
        _projection_engine = ProjectionEngine(event_store)
    return _projection_engine
