"""
router_trace.py — mirror the Router's bus traffic into the EventStore.

Why this exists
---------------
The Router already narrates everything it does on its in-memory event bus
(``agent_phase`` crossings, ``pre_tool_use`` gates, ``tool_result`` settles),
but that narration evaporated with the process: the EventStore never saw a
single turn. This bridge is the missing pipe — it subscribes to the bus and
appends the corresponding EventType rows through the canonical
:class:`~trace_gateway.TraceGateway`, so a turn becomes rebuildable from the
ledger (Phase 1 acceptance) without the Router itself learning about
persistence.

Mapping policy: only phases with a clean counterpart in the existing 35-event
vocabulary are recorded — no new event types, no renames. Tool lifecycle is
taken from ``pre_tool_use`` / ``tool_result`` (richer: real ``call_id``,
status, error), NOT from the ``tool_execution_*`` phases, which would double-
record the same call.

Failure contract: everything here is OBSERVATIONAL. A broken trace mirror
must never break the turn it is tracing — the gateway logs the loss loudly
and the agent keeps running. (Phase 2 turns the critical subset — approvals,
side effects — fail-closed where the Router can act on it.)
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, Optional

from event_types import EventType
from trace_gateway import TraceGateway, OBSERVATIONAL

log = logging.getLogger(__name__)

_PHASE_TO_EVENT = {
    "turn_entered": EventType.AGENT_TURN_STARTED,
    "model_call_started": EventType.LLM_REQUEST_SENT,
    "turn_completed": EventType.AGENT_TURN_COMPLETED,
}


class RouterTraceBridge:
    """One bridge per Router (per session). It filters bus traffic by
    ``session_id``, so several routers sharing a process-wide bus each record
    only their own session's events."""

    def __init__(self, bus, session_id: str, store=None):
        self._bus = bus
        self._session_id = session_id
        self._gateway = TraceGateway(store)  # store=None → resolve lazily
        self._current_turn: Optional[str] = None
        # Goal/run attribution for the turn in flight. Held on the bridge
        # because only SOME frames carry it: the phase emit knows it from the
        # turn context, `tool_result` carries the whole context dict, and
        # `pre_tool_use` may arrive before either. Sticky-per-turn is what makes
        # every event of a goal's turn answer "which goal was this".
        self._current_goal: str = ""
        self._current_run: str = ""

    # ── wiring ──────────────────────────────────────────────────────────────

    def mount(self) -> None:
        """Subscribe. Low priority so guards and risk control run first — by
        the time the bridge sees ``pre_tool_use``, ``event.action`` already
        reflects the gate's verdict and can be recorded with the request."""
        self._bus.on("agent_phase", self._on_phase, priority=-100)
        self._bus.on("pre_tool_use", self._on_pre_tool_use, priority=-100)
        self._bus.on("tool_result", self._on_tool_result, priority=-100)

    def unmount(self) -> None:
        self._bus.off("agent_phase", self._on_phase)
        self._bus.off("pre_tool_use", self._on_pre_tool_use)
        self._bus.off("tool_result", self._on_tool_result)

    # ── helpers ─────────────────────────────────────────────────────────────

    @staticmethod
    def _terminal_event_type(phase: str, p: Dict[str, Any]) -> Optional[EventType]:
        """Which EventType a phase crossing maps to (None = don't record)."""
        if phase == "turn_completed" and p.get("cancelled"):
            return EventType.AGENT_TURN_CANCELLED
        return _PHASE_TO_EVENT.get(phase)

    def _absorb_correlation(self, p: Dict[str, Any]) -> None:
        """Learn goal/run attribution from whichever frame happens to carry it.

        Read from the top level first (the phase emit puts them there) then from
        the nested ``context`` (what the tool frames pass through verbatim).
        Only non-empty values overwrite: a frame that omits the keys must not
        erase what an earlier frame in the same turn established.
        """
        ctx = p.get("context") if isinstance(p.get("context"), dict) else {}
        goal = str(p.get("goal_id") or ctx.get("goal_id") or "")
        run = str(p.get("run_id") or ctx.get("run_id") or "")
        if goal:
            self._current_goal = goal
        if run:
            self._current_run = run

    def _append(self, *, event_type, payload: Dict[str, Any], key: str, **correlation) -> None:
        correlation.setdefault("goal_id", self._current_goal or None)
        correlation.setdefault("run_id", self._current_run or None)
        self._gateway.append(
            session_id=self._session_id,
            event_type=event_type,
            payload=payload,
            importance=OBSERVATIONAL,
            idempotency_key=key,
            actor="assistant",
            **correlation,
        )

    # ── handlers (sync: the store is sync, and the bus supports both) ───────

    def _on_phase(self, event) -> None:
        try:
            p = event.payload or {}
            if p.get("session_id") != self._session_id:
                return
            phase = p.get("phase")
            if self._terminal_event_type(phase, p) is None:
                return

            if phase == "turn_entered":
                # A new turn owns its own attribution. Resetting first is what
                # keeps a goal turn's ids from bleeding into the next, ordinary
                # chat turn on the same session.
                self._current_goal = ""
                self._current_run = ""
            self._absorb_correlation(p)

            turn_id = p.get("turn_id") or self._current_turn
            if phase == "turn_entered":
                turn_id = p.get("turn_id") or uuid.uuid4().hex[:12]
                self._current_turn = turn_id
            if phase == "turn_completed" and turn_id is None:
                # A completion without a recorded start (bridge mounted
                # mid-turn): still record it, just without correlation.
                turn_id = None

            # Cancel honesty: a turn the user stopped is a DIFFERENT terminal
            # fact from a finished one. The Router stamps ``cancelled`` on the
            # TURN_COMPLETED phase; recording it as AGENT_TURN_CANCELLED keeps
            # a replayed ledger from showing interrupted work as successful.
            etype = self._terminal_event_type(phase, p)

            payload: Dict[str, Any] = {"phase": phase}
            if "step" in p:
                payload["step"] = p["step"]
            if "tool" in p:
                payload["tool"] = p["tool"]
            if "ok" in p:
                payload["ok"] = bool(p.get("ok"))
            if p.get("cancelled"):
                payload["cancelled"] = True
            key = f"phase:{self._session_id}:{turn_id}:{phase}"
            if "step" in p:
                key += f":s{p['step']}"
            self._append(
                event_type=etype, payload=payload, key=key,
                turn_id=turn_id,
                step_id=str(p["step"]) if "step" in p else None,
            )
            if phase == "turn_completed":
                self._current_turn = None
                self._current_goal = ""
                self._current_run = ""
        except Exception:
            log.exception("trace bridge failed on agent_phase — turn continues untraced")

    def _on_pre_tool_use(self, event) -> None:
        try:
            p = event.payload or {}
            if p.get("session_id") != self._session_id:
                return
            call_id = p.get("call_id") or uuid.uuid4().hex[:12]
            self._absorb_correlation(p)
            self._append(
                event_type=EventType.TOOL_CALL_REQUESTED,
                payload={
                    "tool": p.get("tool_name", ""),
                    "call_id": call_id,
                    "args": p.get("args", {}),
                    # Set by higher-priority guards before we run; the gate
                    # verdict at request time is part of the audit fact.
                    "action": event.action.value,
                    "block_reason": event.block_reason or "",
                },
                key=f"tool:{self._session_id}:{call_id}:requested",
                turn_id=self._current_turn,
                tool_call_id=call_id,
            )
        except Exception:
            log.exception("trace bridge failed on pre_tool_use — turn continues untraced")

    def _on_tool_result(self, event) -> None:
        try:
            p = event.payload or {}
            if p.get("session_id") != self._session_id:
                return
            call_id = p.get("call_id") or uuid.uuid4().hex[:12]
            result = p.get("result") or {}
            self._absorb_correlation(p)
            ok = bool(result.get("ok"))
            status = str(p.get("status") or ("completed" if ok else "failed"))
            if status == "cancelled":
                etype = EventType.TOOL_EXECUTION_CANCELLED
            elif ok:
                etype = EventType.TOOL_EXECUTION_COMPLETED
            else:
                etype = EventType.TOOL_EXECUTION_FAILED
            error = result.get("error")
            self._append(
                event_type=etype,
                payload={
                    "tool": p.get("tool_name", ""),
                    "call_id": call_id,
                    "status": status,
                    # The full value/output stays out of the ledger — the
                    # message rows carry it; here only the settle verdict and
                    # a short error class matter.
                    "error": (str(error)[:200] if error else ""),
                },
                key=f"tool:{self._session_id}:{call_id}:settled",
                turn_id=self._current_turn,
                tool_call_id=call_id,
            )
        except Exception:
            log.exception("trace bridge failed on tool_result — turn continues untraced")
