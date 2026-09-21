"""Context-pressure triggered self-evolution probe.

Monitors token usage against budget thresholds and dispatches high-value evolution signals
before destructive compaction drops conversation history.
Based on community reference implementation for context pressure evolution triggers.
"""
from __future__ import annotations

import os
from typing import List, Tuple, Optional, Any

try:
    import context_compactor
except ImportError:
    try:
        from app.backend import context_compactor
    except ImportError:
        context_compactor = None

try:
    from evolution_bridge import notify_context_pressure
except ImportError:
    try:
        from app.backend.evolution_bridge import notify_context_pressure
    except ImportError:
        def notify_context_pressure(session_id: str, turn_id: str, ratio: float) -> Optional[str]:
            return None


def should_trigger_pressure_evolution(
    messages: List[dict],
    max_context_tokens: int,
    threshold: float = 0.8,
) -> Tuple[bool, float]:
    """Pure evaluation function checking if context tokens breach pressure threshold.

    Args:
        messages: List of conversation message dictionaries.
        max_context_tokens: Maximum token budget for context.
        threshold: Ratio threshold (0.0 - 1.0) triggering evolution (default 0.8).

    Returns:
        (should_trigger: bool, current_ratio: float)
    """
    if not messages or max_context_tokens <= 0:
        return False, 0.0

    try:
        if context_compactor is not None and hasattr(context_compactor, "estimate_tokens_multi"):
            current_tokens = context_compactor.estimate_tokens_multi(messages)
        else:
            current_tokens = sum(len(str(m.get("content", ""))) // 3 for m in messages if isinstance(m, dict))
    except Exception:
        return False, 0.0

    if current_tokens <= 0:
        return False, 0.0

    ratio = round(float(current_tokens) / float(max_context_tokens), 4)
    if ratio >= threshold:
        return True, ratio

    return False, ratio


def probe_context_pressure(
    messages: List[dict],
    max_context_tokens: int,
    threshold: float = 0.8,
    session_id: str = "",
    turn_id: str = "",
) -> Tuple[bool, float, Optional[str]]:
    """Probe context pressure and dispatch evolution signal if threshold is exceeded.

    Fail-open: never raises an exception to callers.

    Returns:
        (triggered: bool, ratio: float, signal_id: Optional[str])
    """
    try:
        triggered, ratio = should_trigger_pressure_evolution(
            messages, max_context_tokens, threshold=threshold
        )
        if not triggered:
            return False, ratio, None

        sig_id = None
        if session_id:
            sig_id = notify_context_pressure(session_id, turn_id, ratio)
        return True, ratio, sig_id
    except Exception as exc:
        # Fail-open: evolution monitoring must never disrupt runtime
        return False, 0.0, None

