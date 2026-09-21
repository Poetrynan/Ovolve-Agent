"""
rust_adapters/event_engine.py - Drop-in acceleration for event_store.py hash operations.

Provides Rust-backed implementations of SHA-256 chain hash operations:
- genesis_hash: Initial anchor hash for session event streams
- compute_chain_hash: Cascading SHA-256 chain hash computation
- verify_chain_hashes: Batch chain verification
- compute_snapshot_hash: State snapshot hash

Falls back to pure Python when Rust extension is unavailable.
All public APIs are 100% compatible with the original event_store.py methods.
"""
from __future__ import annotations
import hashlib
import json
from typing import Any, Dict, List, Optional, Tuple

# Try to import Rust backend (ovolve_core)
try:
    from ovolve_core import event_engine as _rust
    _HAS_RUST = True
except ImportError:
    _HAS_RUST = False

__all__ = [
    "genesis_hash",
    "compute_chain_hash",
    "verify_chain_hashes",
    "compute_snapshot_hash",
    "batch_compute_hashes",
]


def genesis_hash(session_id: str) -> str:
    """Initial hash anchor for a session event stream.
    
    SHA-256("genesis:{session_id}")
    """
    if _HAS_RUST:
        return _rust.genesis_hash(session_id)
    
    # Python fallback
    return hashlib.sha256(f"genesis:{session_id}".encode("utf-8")).hexdigest()


def compute_chain_hash(
    prev_hash: str,
    session_id: str,
    event_type: str,
    timestamp: int,
    payload: dict[str, Any],
) -> str:
    """Cascading SHA-256 tamper-evident chain hash.
    
    SHA-256("{prev_hash}|{session_id}|{event_type}|{timestamp}|{canonical_payload}")
    """
    if _HAS_RUST:
        canonical_payload = json.dumps(payload, sort_keys=True, ensure_ascii=False)
        return _rust.compute_chain_hash(prev_hash, session_id, event_type, timestamp, canonical_payload)
    
    # Python fallback
    canonical_payload = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    seed = f"{prev_hash}|{session_id}|{event_type}|{timestamp}|{canonical_payload}"
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()


def verify_chain_hashes(
    session_id: str,
    events: list[tuple[str, int, dict[str, Any], str]],
) -> tuple[bool, Optional[int], Optional[str]]:
    """Verify a chain of events by recomputing hashes.
    
    Args:
        session_id: The session identifier
        events: List of (event_type, timestamp, payload, expected_hash) tuples
    
    Returns:
        (valid, broken_at_index, error_message)
    """
    if _HAS_RUST:
        # Convert to Rust format: (event_type, timestamp, payload_json, expected_hash)
        rust_events = [
            (et, ts, json.dumps(pl, sort_keys=True, ensure_ascii=False), eh)
            for et, ts, pl, eh in events
        ]
        valid, broken, error = _rust.verify_chain_hashes(session_id, rust_events)
        return (valid, broken, error)
    
    # Python fallback
    expected_prev = genesis_hash(session_id)
    for idx, (event_type, timestamp, payload, expected_hash) in enumerate(events):
        calc_hash = compute_chain_hash(expected_prev, session_id, event_type, timestamp, payload)
        if calc_hash != expected_hash:
            return (
                False,
                idx,
                f"Chain hash mismatch at seq={idx} (expected {calc_hash}, got {expected_hash})",
            )
        expected_prev = expected_hash
    return (True, None, None)


def compute_snapshot_hash(session_id: str, at_seq: int, state: dict[str, Any]) -> str:
    """Compute a snapshot hash for state verification.
    
    SHA-256("{session_id}:{at_seq}:{state_json}")
    """
    if _HAS_RUST:
        state_json = json.dumps(state, sort_keys=True, ensure_ascii=False)
        return _rust.compute_snapshot_hash(session_id, at_seq, state_json)
    
    # Python fallback
    state_str = json.dumps(state, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(f"{session_id}:{at_seq}:{state_str}".encode("utf-8")).hexdigest()


def batch_compute_hashes(
    prev_hashes: list[str],
    session_ids: list[str],
    event_types: list[str],
    timestamps: list[int],
    payloads: list[dict[str, Any]],
) -> list[str]:
    """Batch hash computation for multiple events.
    
    Useful for rebuilding chain hashes during migration.
    All input lists must have the same length.
    """
    if _HAS_RUST:
        payload_jsons = [json.dumps(p, sort_keys=True, ensure_ascii=False) for p in payloads]
        return _rust.batch_compute_hashes(prev_hashes, session_ids, event_types, timestamps, payload_jsons)
    
    # Python fallback
    results = []
    for ph, sid, et, ts, pl in zip(prev_hashes, session_ids, event_types, timestamps, payloads):
        results.append(compute_chain_hash(ph, sid, et, ts, pl))
    return results
