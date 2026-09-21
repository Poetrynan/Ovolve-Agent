//! context_compactor.rs - Context folding/compression engine.
//!
//! Rust implementation of context_compactor.py. Provides token estimation,
//! text splitting, and heuristic summarization.

use pyo3::prelude::*;
use std::collections::HashMap;

/// Wide character check — mirrors token_estimate._WIDE_RE exactly:
/// CJK punctuation, kana, CJK Ext-A, CJK Unified, Hangul syllables,
/// CJK compatibility ideographs, fullwidth/halfwidth forms.
fn is_wide_char(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x303F | 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF |
        0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF
    )
}

/// Token estimation — the canonical backend algorithm (token_estimate.py):
/// 1 token per wide character + ceil(non-wide chars / 4). Empty text = 0.
#[pyfunction]
fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let wide = text.chars().filter(|&c| is_wide_char(c)).count();
    let rest = text.chars().count() - wide;
    wide + (rest + 3) / 4
}

/// Count wide characters (1 token each) — mirrors token_estimate.wide_chars.
#[pyfunction]
fn wide_chars(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    text.chars().filter(|&c| is_wide_char(c)).count()
}

/// Byte-length signal: utf-8 bytes / 3.5, truncated toward zero —
/// mirrors token_estimate.estimate_bytes (BYTES_PER_TOKEN = 3.5).
#[pyfunction]
fn estimate_bytes(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    (text.len() as f64 / 3.5) as usize
}

/// Estimate tokens for multiple messages.
#[pyfunction]
fn estimate_tokens_multi(messages: Vec<HashMap<String, String>>) -> usize {
    messages.iter()
        .map(|msg| {
            msg.get("content")
                .map(|c| estimate_tokens(c))
                .unwrap_or(0)
        })
        .sum()
}

/// Calculate total tokens from message list.
#[pyfunction]
fn total_tokens(messages: Vec<HashMap<String, String>>) -> usize {
    estimate_tokens_multi(messages)
}

/// Calculate usage ratio given token limit.
#[pyfunction]
fn usage_ratio(messages: Vec<HashMap<String, String>>, token_limit: Option<usize>) -> f64 {
    let limit = token_limit.unwrap_or(8192) as f64;
    if limit <= 0.0 {
        return 0.0;
    }
    let used = total_tokens(messages) as f64;
    (used / limit).min(1.0)
}

/// Check if folding is needed based on token usage.
#[pyfunction]
fn should_fold(messages: Vec<HashMap<String, String>>, token_limit: Option<usize>, threshold: Option<f64>) -> (bool, String) {
    let limit = token_limit.unwrap_or(8192);
    let thresh = threshold.unwrap_or(0.8);
    let used = total_tokens(messages);
    let ratio = used as f64 / limit as f64;

    if ratio >= thresh {
        (true, format!("usage={:.0}% >= threshold={:.0}%", ratio * 100.0, thresh * 100.0))
    } else {
        (false, format!("usage={:.0}% < threshold={:.0}%", ratio * 100.0, thresh * 100.0))
    }
}

/// Find turn boundaries in message list.
#[pyfunction]
fn find_turn_boundaries(messages: Vec<HashMap<String, String>>) -> Vec<usize> {
    let mut boundaries = Vec::new();
    for (i, msg) in messages.iter().enumerate() {
        if let Some(role) = msg.get("role") {
            if role == "user" {
                boundaries.push(i);
            }
        }
    }
    boundaries
}

/// Split messages into [foldable_prefix, keep_tail].
#[pyfunction]
fn split_for_fold(messages: Vec<HashMap<String, String>>, keep_last_n: Option<usize>) -> (Vec<HashMap<String, String>>, Vec<HashMap<String, String>>) {
    let keep = keep_last_n.unwrap_or(4);
    let total = messages.len();

    if total <= keep {
        return (vec![], messages);
    }

    let split_point = total - keep;
    let prefix = messages[..split_point].to_vec();
    let tail = messages[split_point..].to_vec();

    (prefix, tail)
}

/// Extract key identifiers from text (paths, URLs, etc).
/// Match rule mirrors the Python adapter fallback exactly:
/// starts with '/' or 'http', or contains a backslash.
#[pyfunction]
fn key_identifiers(text: &str, cap: Option<usize>) -> Vec<String> {
    let limit = cap.unwrap_or(40);
    let mut ids = Vec::new();

    for word in text.split_whitespace() {
        if word.starts_with('/') || word.starts_with("http") || word.contains('\\') {
            ids.push(word.to_string());
        }
        if ids.len() >= limit {
            break;
        }
    }

    ids
}

/// Generate heuristic summary from messages.
#[pyfunction]
fn heuristic_summary(messages: Vec<HashMap<String, String>>) -> String {
    let mut summary_parts = Vec::new();
    summary_parts.push("# Session Summary".to_string());

    // Extract user messages for key topics
    let user_msgs: Vec<String> = messages.iter()
        .filter(|m| m.get("role").map(|r| r == "user").unwrap_or(false))
        .filter_map(|m| m.get("content").cloned())
        .collect();

    if !user_msgs.is_empty() {
        summary_parts.push("## Topics discussed:".to_string());
        for (i, msg) in user_msgs.iter().take(5).enumerate() {
            // Char-boundary-safe preview (byte slicing would panic on CJK)
            let preview: String = msg.chars().take(80).collect();
            summary_parts.push(format!("{}. {}", i + 1, preview));
        }
    }

    // Extract key identifiers from all messages
    let all_text: String = messages.iter()
        .filter_map(|m| m.get("content"))
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");

    let ids = key_identifiers(&all_text, Some(20));
    if !ids.is_empty() {
        summary_parts.push("\n## Key references:".to_string());
        for id in ids.iter().take(10) {
            summary_parts.push(format!("- {}", id));
        }
    }

    summary_parts.join("\n")
}

/// Audit summary quality by checking key identifier preservation.
#[pyfunction]
fn audit_summary_quality(summary: &str, original_messages: Vec<HashMap<String, String>>) -> HashMap<String, String> {
    let mut result = HashMap::new();

    let all_text: String = original_messages.iter()
        .filter_map(|m| m.get("content"))
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");

    let original_ids = key_identifiers(&all_text, Some(40));
    let preserved: Vec<&str> = original_ids.iter()
        .filter(|id| summary.contains(id.as_str()))
        .map(|s| s.as_str())
        .collect();

    let coverage = if original_ids.is_empty() {
        1.0
    } else {
        preserved.len() as f64 / original_ids.len() as f64
    };

    result.insert("coverage".to_string(), format!("{:.2}", coverage));
    result.insert("preserved_count".to_string(), preserved.len().to_string());
    result.insert("total_count".to_string(), original_ids.len().to_string());
    result.insert("status".to_string(), if coverage >= 0.8 { "pass".to_string() } else { "warn".to_string() });

    result
}

/// Calculate adaptive chunk ratio based on message sizes.
#[pyfunction]
fn compute_adaptive_chunk_ratio(messages: Vec<HashMap<String, String>>, token_limit: Option<usize>) -> f64 {
    let limit = token_limit.unwrap_or(8192) as f64;
    if messages.is_empty() || limit <= 0.0 {
        return 0.3;
    }

    let total_tokens = total_tokens(messages.clone()) as f64;
    let avg_share = (total_tokens / messages.len() as f64) / limit;

    // Linear interpolation: avg_share 0.005 -> 0.15, 0.10 -> 0.40
    let min_ratio = 0.15;
    let max_ratio = 0.40;
    let min_share = 0.005;
    let max_share = 0.10;

    if avg_share <= min_share {
        min_ratio
    } else if avg_share >= max_share {
        max_ratio
    } else {
        let t = (avg_share - min_share) / (max_share - min_share);
        min_ratio + t * (max_ratio - min_ratio)
    }
}

/// Replace oversized messages with placeholder notes.
#[pyfunction]
fn replace_oversized(messages: Vec<HashMap<String, String>>, max_tokens: Option<usize>) -> (Vec<HashMap<String, String>>, usize) {
    let max_t = max_tokens.unwrap_or(1000);
    let mut replaced = 0;
    let mut result = Vec::new();

    for msg in messages {
        let content_len = msg.get("content").map(|c| estimate_tokens(c)).unwrap_or(0);
        if content_len > max_t {
            let mut new_msg = msg.clone();
            new_msg.insert("content".to_string(),
                format!("[Oversized content: {} tokens]", content_len));
            result.push(new_msg);
            replaced += 1;
        } else {
            result.push(msg);
        }
    }

    (result, replaced)
}

/// Register the context_compactor submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "context_compactor")?;
    m.add_function(wrap_pyfunction!(estimate_tokens, &m)?)?;
    m.add_function(wrap_pyfunction!(wide_chars, &m)?)?;
    m.add_function(wrap_pyfunction!(estimate_bytes, &m)?)?;
    m.add_function(wrap_pyfunction!(estimate_tokens_multi, &m)?)?;
    m.add_function(wrap_pyfunction!(total_tokens, &m)?)?;
    m.add_function(wrap_pyfunction!(usage_ratio, &m)?)?;
    m.add_function(wrap_pyfunction!(should_fold, &m)?)?;
    m.add_function(wrap_pyfunction!(find_turn_boundaries, &m)?)?;
    m.add_function(wrap_pyfunction!(split_for_fold, &m)?)?;
    m.add_function(wrap_pyfunction!(key_identifiers, &m)?)?;
    m.add_function(wrap_pyfunction!(heuristic_summary, &m)?)?;
    m.add_function(wrap_pyfunction!(audit_summary_quality, &m)?)?;
    m.add_function(wrap_pyfunction!(compute_adaptive_chunk_ratio, &m)?)?;
    m.add_function(wrap_pyfunction!(replace_oversized, &m)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}
