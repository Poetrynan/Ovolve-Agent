"""stream_circuit_breaker.py — 流式 LLM 断路器（deep-dive 防护）

连续流式失败（超时/传输错误/HTTP 5xx）达到阈值后熔断，避免 GEPA/会诊式
反思在模型不可用时反复重试烧 token。半开状态允许单次探测恢复。
"""
from __future__ import annotations

import time
from enum import Enum
from threading import Lock


class BreakerState(str, Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


_FAILURE_THRESHOLD = 3
_COOLDOWN_S = 60.0
_state = BreakerState.CLOSED
_failures = 0
_opened_at = 0.0
_lock = Lock()


def _trip_codes() -> frozenset[str]:
    return frozenset({"Timeout", "Transport", "HTTP500", "HTTP502", "HTTP503", "HTTP504"})


def check_allowed() -> tuple[bool, str]:
    """Return (allowed, reason). Call before starting a stream."""
    global _state
    with _lock:
        if _state == BreakerState.CLOSED:
            return True, ""
        if _state == BreakerState.OPEN:
            if time.monotonic() - _opened_at >= _COOLDOWN_S:
                _state = BreakerState.HALF_OPEN
                return True, ""
            return False, f"stream circuit open ({_COOLDOWN_S:.0f}s cooldown)"
        return True, ""


def record_success() -> None:
    with _lock:
        global _state, _failures
        _failures = 0
        _state = BreakerState.CLOSED


def record_failure(code: str = "") -> None:
    if code and code not in _trip_codes() and not code.startswith("HTTP5"):
        return
    with _lock:
        global _state, _failures, _opened_at
        if _state == BreakerState.HALF_OPEN:
            _state = BreakerState.OPEN
            _opened_at = time.monotonic()
            _failures = _FAILURE_THRESHOLD
            return
        _failures += 1
        if _failures >= _FAILURE_THRESHOLD:
            _state = BreakerState.OPEN
            _opened_at = time.monotonic()


def status() -> dict:
    with _lock:
        return {
            "state": _state.value,
            "failures": _failures,
            "cooldown_s": _COOLDOWN_S,
        }
