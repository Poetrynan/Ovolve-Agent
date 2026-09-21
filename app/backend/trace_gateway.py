"""
trace_gateway.py — the canonical append gateway into the EventStore.

Why this exists
---------------
Before Phase 1, three modules called ``EventStore.append`` directly and a
fourth channel (the Router's in-memory bus) never reached the store at all.
There was no place that could validate an event, redact a secret, or decide
what a failed write means. This module is that place: every *new* business
event enters the ledger through :meth:`TraceGateway.append`, which

  1. validates the event (session, known type, dict payload, size cap);
  2. redacts obvious secrets from the payload before anything is persisted;
  3. delegates idempotency to the store — a retry with the same
     ``idempotency_key`` returns the stored event, never a duplicate fact;
  4. decides what failure means, by importance:
       - ``"critical"``   state transitions, approvals, tool side effects,
                          verification results: one retry, then RAISE. The
                          caller must enter an error/recovery path — silence
                          here is how "completed" gets printed over a failure.
       - ``"observational"``  trace mirrors, metrics: log loudly, return None.
                          The observed feature keeps running.

The gateway deliberately does NOT know about projections, WebSocket fans or
audit formatting — it is a write path, not a hub. Storage / projection /
Router wiring live with their owners.

EventStore remains the only store; ``append_batch`` (fork-time bulk clone)
stays a store-internal primitive. This module is about the WRITE DISCIPLINE,
not a second data structure.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, Optional

from event_store import EventStore
from event_types import AgentEvent, EventType

log = logging.getLogger(__name__)

CRITICAL = "critical"
OBSERVATIONAL = "observational"

#: Payload keys whose VALUES must never reach the ledger. Matched on key name
#: (recursive, case-insensitive, substring). Values become "[REDACTED]".
_SENSITIVE_KEY_RE = re.compile(
    r"(?:^|_)(?:token|password|passwd|secret|api_?key|auth(?:orization)?|cookie|private_?key|credential)s?(?:$|_)",
    re.IGNORECASE,
)

#: Hard cap on a serialized payload — events ride along every stream read and
#: one runaway tool output must not bloat the whole ledger. Oversize payloads
#: are truncated with a visible marker, not rejected: the fact still lands.
_MAX_PAYLOAD_BYTES = 256 * 1024
_TRUNCATE_AT_BYTES = 64 * 1024

_KNOWN_TYPES = {t.value for t in EventType}


def sanitize_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy of ``payload`` safe to persist: secrets redacted, giant
    strings truncated. Never mutates the caller's dict."""
    def redact(node: Any) -> Any:
        if isinstance(node, dict):
            out = {}
            for k, v in node.items():
                if isinstance(v, str) and _SENSITIVE_KEY_RE.search(str(k)):
                    out[k] = "[REDACTED]"
                else:
                    out[k] = redact(v)
            return out
        if isinstance(node, list):
            return [redact(x) for x in node]
        if isinstance(node, tuple):
            return [redact(x) for x in node]
        if isinstance(node, str) and len(node.encode("utf-8", "replace")) > _TRUNCATE_AT_BYTES:
            return node[:_TRUNCATE_AT_BYTES] + "…[truncated by trace gateway]"
        return node

    return redact(payload)


class TraceGateway:
    """Single write discipline for the EventStore. One instance per owner
    (Storage, ProjectionEngine, RouterTraceBridge) — "canonical" refers to
    the code path, not to a process-wide object."""

    def __init__(self, store: Optional[EventStore] = None):
        self._store = store

    @property
    def store(self) -> EventStore:
        # Lazy: in tests the store singleton is re-pointed at a fresh temp
        # dir constantly, and a gateway bound at construction time would keep
        # writing to a deleted directory.
        if self._store is not None:
            return self._store
        from event_store import get_event_store
        return get_event_store()

    def append(
        self,
        *,
        session_id: str,
        event_type: Any,
        payload: Dict[str, Any],
        importance: str = OBSERVATIONAL,
        idempotency_key: Optional[str] = None,
        causation_id: Optional[str] = None,
        run_id: Optional[str] = None,
        turn_id: Optional[str] = None,
        step_id: Optional[str] = None,
        tool_call_id: Optional[str] = None,
        goal_id: Optional[str] = None,
        branch_id: Optional[str] = None,
        parent_event_id: Optional[str] = None,
        actor: Optional[str] = None,
        visibility: str = "audit",
    ) -> Optional[AgentEvent]:
        """Validate → redact → append. See module docstring for the
        importance contract. Programming errors always raise ValueError;
        storage failures follow the importance policy."""
        # -- validation: these are caller bugs, fail fast regardless of importance
        if not session_id or not isinstance(session_id, str):
            raise ValueError("event needs a non-empty session_id")
        if not isinstance(payload, dict):
            raise ValueError(f"payload must be a dict, got {type(payload).__name__}")
        etype = event_type.value if isinstance(event_type, EventType) else str(event_type)
        if etype not in _KNOWN_TYPES:
            raise ValueError(f"unknown event_type {etype!r} — extend EventType first")

        clean = sanitize_payload(payload)
        try:
            encoded = json.dumps(clean, ensure_ascii=False)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"payload is not JSON-serializable: {exc}") from exc
        if len(encoded.encode("utf-8", "replace")) > _MAX_PAYLOAD_BYTES:
            raise ValueError(
                f"payload exceeds {_MAX_PAYLOAD_BYTES} bytes even after truncation of long strings"
            )

        # -- write, honouring importance on failure
        attempts = 2 if importance == CRITICAL else 1
        for attempt in range(attempts):
            try:
                return self.store.append(
                    session_id,
                    etype,
                    clean,
                    causation_id=causation_id,
                    idempotency_key=idempotency_key,
                    run_id=run_id,
                    turn_id=turn_id,
                    step_id=step_id,
                    tool_call_id=tool_call_id,
                    goal_id=goal_id,
                    branch_id=branch_id,
                    parent_event_id=parent_event_id,
                    actor=actor,
                    visibility=visibility,
                )
            except ValueError:
                raise
            except Exception as exc:
                if attempt + 1 < attempts:
                    log.warning("trace append failed (%s), retrying", exc)
                    continue
                if importance == CRITICAL:
                    raise
                # Observational: the trace mirror must never take down the
                # feature it observes — but the loss is logged, never silent.
                log.exception(
                    "observational event write failed and was dropped: "
                    "session=%s type=%s key=%s", session_id, etype, idempotency_key,
                )
                return None
        return None  # unreachable; keeps type-checkers honest
