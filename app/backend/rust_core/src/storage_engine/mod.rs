//! storage_engine.rs - Performance-critical storage operations.
//!
//! Rust implementation of CPU-intensive functions from storage.py.
//! These functions handle vector similarity, score normalization, and result fusion.

use pyo3::prelude::*;
use std::collections::HashMap;

/// Cosine similarity between two equal-length float vectors.
/// Returns 0.0 for empty vectors or mismatched lengths.
///
/// f64 throughout: Python's float is double precision — using f32 here
/// would change semantic-search rankings vs the Python reference.
#[pyfunction]
pub fn cosine_similarity(a: Vec<f64>, b: Vec<f64>) -> f64 {
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot: f64 = 0.0;
    let mut na: f64 = 0.0;
    let mut nb: f64 = 0.0;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    let na_sqrt = na.sqrt();
    let nb_sqrt = nb.sqrt();
    // Exact zero test mirrors Python (`if na == 0 or nb == 0`) — no epsilon
    // threshold, so tiny-but-nonzero vectors behave identically to Python.
    if na_sqrt == 0.0 || nb_sqrt == 0.0 {
        return 0.0;
    }
    dot / (na_sqrt * nb_sqrt)
}

/// Batch cosine similarity: compare query against multiple vectors.
/// Returns vector of (index, score) pairs sorted by score descending.
#[pyfunction]
pub fn batch_cosine_similarity(
    query: Vec<f64>,
    vectors: Vec<Vec<f64>>,
) -> Vec<(usize, f64)> {
    let mut results: Vec<(usize, f64)> = vectors
        .iter()
        .enumerate()
        .map(|(i, v)| (i, cosine_similarity(query.clone(), v.clone())))
        .filter(|(_, score)| *score > 0.0)
        .collect();
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results
}

/// Count how many distinct keywords appear in content (case-insensitive).
#[pyfunction]
pub fn keyword_score(content: &str, keywords: Vec<String>) -> u32 {
    if content.is_empty() || keywords.is_empty() {
        return 0;
    }
    let low = content.to_lowercase();
    keywords
        .iter()
        .filter(|kw| !kw.is_empty() && low.contains(&kw.to_lowercase()[..]))
        .count() as u32
}

/// Decode a stored embedding blob back into a list of floats.
/// Handles bytes (JSON string), str (JSON), and list/tuple inputs.
///
/// f64 throughout: embeddings are stored as JSON doubles; f32 would
/// silently truncate precision and change downstream cosine rankings.
#[pyfunction]
pub fn decode_embedding(blob: &Bound<'_, pyo3::types::PyAny>) -> Option<Vec<f64>> {
    // Try bytes/bytearray first
    if let Ok(bytes) = blob.extract::<Vec<u8>>() {
        let s = String::from_utf8_lossy(&bytes);
        return serde_json::from_str::<Vec<f64>>(&s).ok();
    }
    // Try string
    if let Ok(s) = blob.extract::<String>() {
        return serde_json::from_str::<Vec<f64>>(&s).ok();
    }
    // Try list/tuple
    if let Ok(list) = blob.extract::<Vec<f64>>() {
        return Some(list);
    }
    None
}

/// Extract confidence value from a row, with bounds checking.
/// Returns 0.5 for missing/invalid values (the "don't know" midpoint).
#[pyfunction]
pub fn trust_of(confidence: Option<f64>) -> f64 {
    match confidence {
        Some(v) if v > 0.0 && v <= 1.0 => v,
        _ => 0.5,
    }
}

/// Min-max normalize a score map into 0..1.
/// Used for making cosine similarity and BM25 scores comparable.
#[pyfunction]
pub fn normalize_scores_py(
    scores: HashMap<String, f64>,
    higher_is_better: Option<bool>,
) -> HashMap<String, f64> {
    if scores.is_empty() {
        return scores;
    }
    let higher = higher_is_better.unwrap_or(true);
    let vals: Vec<f64> = scores.values().cloned().collect();
    let min_val = vals.iter().fold(f64::INFINITY, |a, &b| a.min(b));
    let max_val = vals.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b));
    let range = max_val - min_val;

    if range < 1e-10 {
        return scores.into_iter().map(|(k, _)| (k, 0.5)).collect();
    }

    scores
        .into_iter()
        .map(|(k, v)| {
            let normalized = if higher {
                (v - min_val) / range
            } else {
                (max_val - v) / range
            };
            (k, normalized)
        })
        .collect()
}

/// Weighted-sum fusion over the union of both channels' candidate ids.
/// Returns Vec of (id, fused_score, {"vec": v, "kw": w}) sorted by fused desc.
#[pyfunction]
pub fn fuse_scores(
    dense_scores: HashMap<String, f64>,
    sparse_scores: HashMap<String, f64>,
    dense_weight: Option<f64>,
    sparse_weight: Option<f64>,
) -> Vec<(String, f64, HashMap<String, f64>)> {
    let dw = dense_weight.unwrap_or(0.7);
    let sw = sparse_weight.unwrap_or(0.3);

    let mut all_ids: Vec<String> = dense_scores.keys().cloned().collect();
    for id in sparse_scores.keys() {
        if !all_ids.contains(id) {
            all_ids.push(id.clone());
        }
    }

    let mut fused: Vec<(String, f64, HashMap<String, f64>)> = all_ids
        .into_iter()
        .map(|id| {
            let d = dense_scores.get(&id).unwrap_or(&0.0);
            let s = sparse_scores.get(&id).unwrap_or(&0.0);
            let score = dw * d + sw * s;
            let mut parts = HashMap::new();
            parts.insert("vec".to_string(), *d);
            parts.insert("kw".to_string(), *s);
            (id, score, parts)
        })
        .collect();

    fused.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    fused
}

/// Register the storage_engine submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "storage_engine")?;
    m.add_function(wrap_pyfunction!(cosine_similarity, &m)?)?;
    m.add_function(wrap_pyfunction!(batch_cosine_similarity, &m)?)?;
    m.add_function(wrap_pyfunction!(keyword_score, &m)?)?;
    m.add_function(wrap_pyfunction!(decode_embedding, &m)?)?;
    m.add_function(wrap_pyfunction!(trust_of, &m)?)?;
    m.add_function(wrap_pyfunction!(normalize_scores_py, &m)?)?;
    m.add_function(wrap_pyfunction!(fuse_scores, &m)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}
