//! event_engine.rs - Cryptographic chain operations for event store.
//!
//! Rust implementation of SHA-256 chain hash computation and verification.
//! These are CPU-intensive operations that benefit from Rust's speed.

use pyo3::prelude::*;
use sha2::{Sha256, Digest};

/// Compute the genesis hash for a session event stream.
/// This is the initial anchor hash: SHA-256("genesis:{session_id}")
#[pyfunction]
pub fn genesis_hash(session_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("genesis:{}", session_id).as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Compute the cascading chain hash for an event.
/// SHA-256("{prev_hash}|{session_id}|{event_type}|{timestamp}|{canonical_payload}")
#[pyfunction]
pub fn compute_chain_hash(
    prev_hash: &str,
    session_id: &str,
    event_type: &str,
    timestamp: i64,
    payload_json: &str,
) -> String {
    let mut hasher = Sha256::new();
    let seed = format!("{}|{}|{}|{}|{}", prev_hash, session_id, event_type, timestamp, payload_json);
    hasher.update(seed.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Verify a chain of events by recomputing hashes.
/// Returns (valid, broken_at_seq, error_message)
#[pyfunction]
pub fn verify_chain_hashes(
    session_id: &str,
    events: Vec<(String, i64, String, String)>, // (event_type, timestamp, payload_json, expected_hash)
) -> (bool, Option<usize>, Option<String>) {
    let mut expected_prev = genesis_hash(session_id);
    
    for (idx, (event_type, timestamp, payload_json, expected_hash)) in events.iter().enumerate() {
        let calc_hash = compute_chain_hash(
            &expected_prev,
            session_id,
            event_type,
            *timestamp,
            payload_json,
        );
        if calc_hash != *expected_hash {
            return (
                false,
                Some(idx),
                Some(format!(
                    "Chain hash mismatch at index={} (expected {}, got {})",
                    idx, calc_hash, expected_hash
                )),
            );
        }
        expected_prev = expected_hash.clone();
    }
    
    (true, None, None)
}

/// Compute a snapshot hash for state verification.
/// SHA-256("{session_id}:{at_seq}:{state_json}")
#[pyfunction]
pub fn compute_snapshot_hash(session_id: &str, at_seq: i64, state_json: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{}:{}:{}", session_id, at_seq, state_json).as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Batch hash computation for multiple payloads.
/// Useful for rebuilding chain hashes during migration.
#[pyfunction]
pub fn batch_compute_hashes(
    prev_hashes: Vec<String>,
    session_ids: Vec<String>,
    event_types: Vec<String>,
    timestamps: Vec<i64>,
    payloads: Vec<String>,
) -> Vec<String> {
    prev_hashes
        .iter()
        .zip(session_ids.iter())
        .zip(event_types.iter())
        .zip(timestamps.iter())
        .zip(payloads.iter())
        .map(|((((ph, sid), et), ts), pl)| {
            compute_chain_hash(ph, sid, et, *ts, pl)
        })
        .collect()
}

/// Register the event_engine submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "event_engine")?;
    m.add_function(wrap_pyfunction!(genesis_hash, &m)?)?;
    m.add_function(wrap_pyfunction!(compute_chain_hash, &m)?)?;
    m.add_function(wrap_pyfunction!(verify_chain_hashes, &m)?)?;
    m.add_function(wrap_pyfunction!(compute_snapshot_hash, &m)?)?;
    m.add_function(wrap_pyfunction!(batch_compute_hashes, &m)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}
