"""agent_phases.py — Named lifecycle phases for an agent turn.

Why this exists
---------------
An agent turn is a small state machine: resolve mode → assemble context →
call the model → run tools → produce a reply. When something goes wrong (or
just goes slow) we need to know which state we were in. Historically we only
had ``task_started`` / ``completed`` / ``error`` frames — enough to know that
things are broken, not enough to know *where*.

This module defines a small enum of phase names and a helper that emits an
``agent_phase`` event on the event bus each time the turn crosses one. The
frontend can display them (a subtle "assembling context…" indicator), the
backend logs are searchable by phase, and future features (per-phase retries,
per-phase timeouts, per-phase circuit breakers) plug into the same names
without another round of renaming.

The names are drawn from what actually happens today. When we later add new
work — RAG retrieval, plan-verify loops — new phases get added here and only
here.
"""
from __future__ import annotations

import time
from enum import Enum
from typing import Any, Optional


class TurnPhase(str, Enum):
    """The states a single agent turn passes through, in order.

    Values are the short strings emitted on the wire. New phases append to
    this list — never renumber, and never rename a value that's already
    shipped, because frontend and logs both index by these strings.
    """

    TURN_ENTERED = "turn_entered"
    #: Router.handle() has been called. Nothing has been done yet.

    PERMISSION_RESOLVED = "permission_resolved"
    #: The permission level for this turn (plan/readonly/ask/auto/yolo) has been
    #: resolved against workspace defaults + the per-turn choice from the composer.

    WORKSPACE_READY = "workspace_ready"
    #: Sandbox root, path_guard and cwd for tools are locked in for this turn.

    CONTEXT_ENGINE = "context_engine"
    #: Assembling the message list: history + memory prefetch + rules + tool
    #: preamble. This is where compactor decisions happen.

    CONTEXT_ASSEMBLED = "context_assembled"
    #: The full prompt is built. The next thing that happens is the model call.

    MODEL_CALL_STARTED = "model_call_started"
    #: HTTP request to the LLM provider is in flight (or the first stream frame
    #: is being awaited).

    ASSISTANT_OUTPUT_STARTED = "assistant_output_started"
    #: First delta from the model arrived. Between this and the next phase the
    #: user sees streamed text.

    TOOL_EXECUTION_STARTED = "tool_execution_started"
    #: A tool call is about to run. Emitted per tool; contains ``tool`` in the
    #: payload.

    TOOL_EXECUTION_FINISHED = "tool_execution_finished"
    #: Tool result is back (success or failure). Contains ``tool`` and ``ok``.

    STEP_BOUNDARY = "step_boundary"
    #: Between two model steps in a multi-step agent loop. Safe point for
    #: cancellation, steering injection, cost-cap enforcement.

    ASSISTANT_REPLY_FINALIZED = "assistant_reply_finalized"
    #: Model produced its final reply text for this turn. Persistence and
    #: side effects happen after this.

    POST_TURN_HOOKS = "post_turn_hooks"
    #: Everything after the reply: memory extraction, evolution check,
    #: snapshot flush.

    TURN_COMPLETED = "turn_completed"
    #: End of the turn. If we didn't reach here, look at the last emitted
    #: phase to see where we stopped.


PHASE_ORDER: tuple[TurnPhase, ...] = tuple(TurnPhase)


async def emit_phase(
    bus: Any,
    phase: TurnPhase,
    *,
    session_id: str,
    turn_id: Optional[str] = None,
    extra: Optional[dict] = None,
) -> None:
    """Publish an ``agent_phase`` event on the bus.

    Safe to call from anywhere in the turn body — never raises. If the bus
    is missing or the emit itself throws, we swallow the error rather than
    let a debugging aid take the turn down.

    Args:
        bus: The Router's EventBus. If None, the call is a no-op.
        phase: Which named state we're crossing.
        session_id: The session that owns this event. **Required** — without
            it the WS bridge cannot route the frame to the right window
            (see FAQ Q22 on event tagging).
        turn_id: Optional per-turn identifier so consumers can group phases
            of the same turn together across concurrent windows.
        extra: Additional structured payload (e.g. ``{"tool": "read_file"}``
            for TOOL_EXECUTION_STARTED). Keep it small; this event fires
            many times per turn.
    """
    if bus is None:
        return
    payload = {
        "phase": phase.value,
        "session_id": session_id,
        "turn_id": turn_id,
        "ts": time.time(),
    }
    if extra:
        payload.update(extra)
    try:
        await bus.emit("agent_phase", payload)
    except Exception as exc:  # noqa: BLE001 - observability must never crash the run
        print(f"[agent_phases] emit failed for {phase.value}: {exc}")
