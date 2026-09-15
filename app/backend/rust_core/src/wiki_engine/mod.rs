//! wiki_engine.rs - Text processing for wiki claim store.
//!
//! Rust implementation of text normalization, negation detection,
//! and triple extraction from wiki_store.py.

use pyo3::prelude::*;
use regex::Regex;
use std::collections::HashMap;

/// Normalize text: case-fold + whitespace-collapse.
/// Used for subject/predicate key generation.
/// Accepts None (returns empty string, matching Python `str(text or "")`).
#[pyfunction]
pub fn normalize_text(text: Option<&str>) -> String {
    let text = text.unwrap_or("");
    if text.is_empty() {
        return String::new();
    }
    let trimmed = text.trim().to_lowercase();
    // Collapse whitespace (equivalent to _WS.sub(" ", ...))
    let re = Regex::new(r"\s+").unwrap();
    re.replace_all(&trimmed, " ").to_string()
}

/// Generate a stable subject+predicate key for grouping.
#[pyfunction]
pub fn subject_predicate_key(subject: &str, predicate: &str) -> String {
    let s = normalize_text(Some(subject));
    let p = normalize_text(Some(predicate));
    format!("{}::{}", s, p)
}

/// Check if text contains any negation markers.
/// Case-insensitive for ASCII, exact for CJK.
/// Accepts None (returns false, matching Python `if not text: return False`).
#[pyfunction]
pub fn has_negation(text: Option<&str>) -> bool {
    let text = text.unwrap_or("");
    if text.is_empty() {
        return false;
    }
    let low = text.to_lowercase();
    // Common negation markers (English + Chinese)
    let markers = [
        "not ", "no ", "don't", "doesn't", "didn't", "won't", "can't",
        "never", "neither", "nobody", "nothing", "nowhere",
        "不", "没", "没有", "不是", "别", "未", "无", "非",
    ];
    markers.iter().any(|m| low.contains(m))
}

/// Extract (subject, predicate, object) triple from text.
/// Returns None if no pattern matches.
/// Semantics match Python's `pat.fullmatch(s)` with `re.IGNORECASE`:
/// each pattern is anchored with `\A...\z` and case-insensitive via `(?i)`.
#[pyfunction]
pub fn triple_from_text(text: Option<&str>) -> Option<(String, String, String)> {
    let s = text.unwrap_or("").trim();
    if s.is_empty() {
        return None;
    }

    // Define patterns (matching the Python TRIPLE_PATTERNS).
    // `(?i)` == re.IGNORECASE; `\A`/`\z` == fullmatch (whole-string, unlike captures' free search).
    let patterns: Vec<(&str, &str, &str)> = vec![
        // English name patterns
        ("用户", "名字", r"(?i)\Amy name is(?:n't| not)?\s+(.{1,40}?)\s*[.。!！]?\s*\z"),
        // Chinese name patterns
        ("用户", "名字", r"(?i)\A我(?:的名字)?(?:不|并不)?(?:就)?叫\s*(.{1,40}?)\s*[.。!！]?\s*\z"),
        // English work patterns
        ("用户", "工作单位", r"(?i)\Ai (?:don't |do not )?work at\s+(.{1,40}?)\s*[.。!！]?\s*\z"),
        // Chinese work patterns
        ("用户", "工作单位", r"(?i)\A我(?:不|没|没有|已经不)?在\s*(.{1,40}?)\s*工作\s*[.。!！]?\s*\z"),
        // English timezone patterns
        ("用户", "时区", r"(?i)\Amy timezone is(?:n't| not)?\s+(.{1,40}?)\s*[.。!！]?\s*\z"),
        // Chinese timezone patterns
        ("用户", "时区", r"(?i)\A我(?:的)?时区(?:不)?是\s*(.{1,40}?)\s*[.。!！]?\s*\z"),
    ];

    // Object reject pattern (half-sentence detection)
    let object_reject = Regex::new(r"[，,。；;！!？?\n、]").unwrap();

    for (subject, predicate, pat) in patterns {
        if let Ok(re) = Regex::new(pat) {
            if let Some(caps) = re.captures(s) {
                if let Some(m) = caps.get(1) {
                    let obj = m.as_str().trim_matches(|c: char| " \t、，,：:".contains(c));
                    if obj.is_empty() || object_reject.is_match(obj) {
                        continue;
                    }
                    return Some((subject.to_string(), predicate.to_string(), obj.to_string()));
                }
            }
        }
    }
    None
}

/// Detect conflicts between a new claim and existing peers.
/// Two-stage: structural (different object) → textual (negation mismatch).
#[pyfunction]
#[pyo3(signature = (new_object, new_statement, peers))]
pub fn detect_conflicts(
    new_object: Option<&str>,
    new_statement: Option<&str>,
    peers: Vec<(String, String, String)>, // (object, statement, id)
) -> Vec<String> {
    let new_obj_norm = normalize_text(new_object);
    let new_negated = has_negation(new_statement);
    let mut conflicts = Vec::new();

    for (peer_obj, peer_stmt, peer_id) in peers {
        let peer_obj_norm = normalize_text(Some(&peer_obj));
        
        // Structural: same s+p, different object (both non-empty)
        if !new_obj_norm.is_empty() 
            && !peer_obj_norm.is_empty() 
            && new_obj_norm != peer_obj_norm 
        {
            conflicts.push(peer_id);
            continue;
        }
        
        // Textual: negation mismatch
        if new_negated != has_negation(Some(&peer_stmt)) {
            conflicts.push(peer_id);
        }
    }

    conflicts
}

/// Register the wiki_engine submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "wiki_engine")?;
    m.add_function(wrap_pyfunction!(normalize_text, &m)?)?;
    m.add_function(wrap_pyfunction!(subject_predicate_key, &m)?)?;
    m.add_function(wrap_pyfunction!(has_negation, &m)?)?;
    m.add_function(wrap_pyfunction!(triple_from_text, &m)?)?;
    m.add_function(wrap_pyfunction!(detect_conflicts, &m)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}
