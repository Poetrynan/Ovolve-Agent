"""evolution_bridge.py — Bridge connecting Agent runtime events to the Self-Evolution Engine.

Dispatches interruptions, steering, loop faults and consecutive failures into evolution.db.
Strictly adheres to Fail-Open: zero evolution failure may impact user dialogue.
"""
from __future__ import annotations
from typing import Optional

def _get_engine():
    try:
        import evolution
        return evolution.get_evolution_engine()
    except Exception:
        return None

def notify_turn_interrupted(session_id: str, turn_id: str, reason: str = "") -> Optional[str]:
    """Record an interruption event as negative feedback to evolution store."""
    try:
        engine = _get_engine()
        if not engine or not engine.enabled():
            return None
        return engine.record(
            kind="interrupted",
            tool_name="user_action",
            detail=f"Turn {turn_id} interrupted: {reason or 'user cancel'}",
            session_id=session_id,
            failure_kind="tool_unavailable",
        )
    except Exception as exc:
        print(f"[evolution_bridge] notify_turn_interrupted failed (fail-open): {exc}")
        return None

def notify_user_correction(session_id: str, turn_id: str, correction: str) -> Optional[str]:
    """Record mid-flight user steering / correction as high-value evolution signal."""
    try:
        engine = _get_engine()
        if not engine or not engine.enabled():
            return None
        return engine.record(
            kind="user_correction",
            tool_name="user_intervention",
            detail=f"Turn {turn_id} user correction: {correction}",
            session_id=session_id,
            failure_kind="user_correction",
        )
    except Exception as exc:
        print(f"[evolution_bridge] notify_user_correction failed (fail-open): {exc}")
        return None

def notify_loop_fault(session_id: str, turn_id: str, tool_name: str, loop_msg: str) -> Optional[str]:
    """Record circuit breaker trips and loop faults."""
    try:
        engine = _get_engine()
        if not engine or not engine.enabled():
            return None
        return engine.record(
            kind="loop_fault",
            tool_name=tool_name or "agent_loop",
            detail=f"Turn {turn_id} circuit breaker: {loop_msg}",
            session_id=session_id,
            failure_kind="loop_fault",
        )
    except Exception as exc:
        print(f"[evolution_bridge] notify_loop_fault failed (fail-open): {exc}")
        return None

def notify_tool_failure(session_id: str, turn_id: str, tool_name: str, error_msg: str,
                        failure_kind: Optional[str] = None) -> Optional[str]:
    """Record tool execution failure / rejection with structured failure_kind."""
    try:
        engine = _get_engine()
        if not engine or not engine.enabled():
            return None
        return engine.record(
            kind="tool_failure",
            tool_name=tool_name,
            detail=f"Turn {turn_id} tool '{tool_name}' failed: {error_msg[:200]}",
            session_id=session_id,
            failure_kind=failure_kind or "tool_unavailable",
        )
    except Exception as exc:
        print(f"[evolution_bridge] notify_tool_failure failed (fail-open): {exc}")
        return None


def notify_context_pressure(session_id: str, turn_id: str, ratio: float) -> Optional[str]:
    """Record context pressure threshold breach as evolution trigger signal."""
    try:
        engine = _get_engine()
        if not engine or not engine.enabled():
            return None
        return engine.record(
            kind="context_pressure",
            tool_name="context_engine",
            detail=f"Turn {turn_id} context pressure at {ratio:.1%}",
            session_id=session_id,
            failure_kind="context_pressure",
        )
    except Exception as exc:
        print(f"[evolution_bridge] notify_context_pressure failed (fail-open): {exc}")
        return None

