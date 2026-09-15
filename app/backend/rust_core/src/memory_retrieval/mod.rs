//! memory_retrieval.rs - Hybrid retrieval: dense vectors + FTS5 keyword search.
//!
//! Rust implementation of memory_retrieval.py. Provides CJK bigram tokenization,
//! FTS5 query building, score normalization, and weighted-sum fusion.

use pyo3::prelude::*;
use std::collections::HashMap;

/// Check if a character is CJK/Hangul.
/// Mirrors the Python adapter's exact block list — no extras. (Ext-C/D and
/// Compatibility Supplement are NOT in the Python set; including them would
/// change bigram/tokenization behavior for those codepoints.)
#[pyfunction]
pub fn is_cjk(ch: char) -> bool {
    matches!(ch as u32,
        0x4E00..=0x9FFF |    // CJK Unified Ideographs
        0x3400..=0x4DBF |    // CJK Extension A
        0x20000..=0x2A6DF |  // CJK Extension B
        0xF900..=0xFAFF |    // CJK Compatibility Ideographs
        0xAC00..=0xD7AF |    // Hangul Syllables
        0x1100..=0x11FF |    // Hangul Jamo
        0x3040..=0x309F |    // Hiragana
        0x30A0..=0x30FF       // Katakana
    )
}

/// Generate overlapping character bigrams for CJK text.
/// "关闭工具授权" -> ["关闭", "闭工", "工具", "具授", "授权"]
#[pyfunction]
pub fn cjk_bigrams(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut result = Vec::new();
    let mut i = 0;

    while i < chars.len() {
        if is_cjk(chars[i]) {
            // Process CJK run
            let start = i;
            while i < chars.len() && is_cjk(chars[i]) {
                i += 1;
            }
            let cjk_run: String = chars[start..i].iter().collect();
            let cjk_chars: Vec<char> = cjk_run.chars().collect();

            for j in 0..cjk_chars.len().saturating_sub(1) {
                let bigram: String = vec![cjk_chars[j], cjk_chars[j + 1]].into_iter().collect();
                result.push(bigram);
            }
        } else {
            i += 1;
        }
    }

    result
}

/// Render text into FTS5 document format (CJK bigrams + original text).
#[pyfunction]
pub fn fts_document(text: &str) -> String {
    let bigrams = cjk_bigrams(text);
    if bigrams.is_empty() {
        text.to_string()
    } else {
        format!("{} {}", text, bigrams.join(" "))
    }
}

/// Sanitize FTS5 operators from user text.
/// Mirrors the Python adapter: REMOVES the operator chars (keeping neighbors
/// joined) rather than replacing them with spaces, then strips whitespace.
/// "hello-world" -> "helloworld", NOT "hello world".
#[pyfunction]
pub fn sanitize_term(term: &str) -> String {
    term.chars()
        .filter(|c| !matches!(c, '"' | '*' | '(' | ')' | ':' | '^' | '-' | '+'))
        .collect::<String>()
        .trim()
        .to_string()
}

/// Build FTS5 MATCH expression from free text + optional keywords.
/// Empty term list falls back to '""' (the Python adapter's non-empty
/// fallback), so callers can always pass the result straight to MATCH.
#[pyfunction]
pub fn build_fts_query(text: &str, keywords: Option<Vec<String>>) -> String {
    let mut terms: Vec<String> = Vec::new();

    // Process main text
    let sanitized = sanitize_term(text);
    for word in sanitized.split_whitespace() {
        if word.chars().any(|c| is_cjk(c)) {
            // CJK: add bigrams
            for bigram in cjk_bigrams(word) {
                terms.push(format!("\"{}\"", bigram));
            }
        } else if !word.is_empty() {
            terms.push(format!("\"{}\"", word));
        }
    }

    // Add keywords
    if let Some(kw_list) = keywords {
        for kw in kw_list {
            let s = sanitize_term(&kw);
            if !s.is_empty() {
                terms.push(format!("\"{}\"", s));
            }
        }
    }

    if terms.is_empty() {
        // Fallback: match anything — must stay non-empty (Python: '""')
        return "\"\"".to_string();
    }

    terms.join(" OR ")
}

/// Estimate token length (rough heuristic: CJK chars count as 1 token each,
/// non-CJK words split by whitespace).
/// Mirrors the Python adapter's in_word latch exactly: a CJK char counts as
/// 1 token AND latches in_word, so "中a" is ONE token (the 'a' rides along),
/// just like the Python loop.
#[pyfunction]
pub fn token_len(text: &str) -> usize {
    let mut count = 0;
    let mut in_word = false;

    for ch in text.chars() {
        if is_cjk(ch) {
            count += 1;
            in_word = true;
        } else if ch.is_whitespace() {
            in_word = false;
        } else {
            if !in_word {
                count += 1;
                in_word = true;
            }
        }
    }

    count.max(1)
}

/// Split text into sentence-like spans.
#[pyfunction]
pub fn split_sentences(text: &str) -> Vec<String> {
    let delimiters = ['。', '！', '？', '!', '?', '.', '\n', '；', ';'];
    let mut sentences = Vec::new();
    let mut current = String::new();

    for ch in text.chars() {
        current.push(ch);
        if delimiters.contains(&ch) {
            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() {
                sentences.push(trimmed);
            }
            current = String::new();
        }
    }

    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        sentences.push(trimmed);
    }

    // If no delimiters found, return whole text
    if sentences.is_empty() && !text.is_empty() {
        sentences.push(text.to_string());
    }

    sentences
}

/// Split text into overlapping chunks at sentence boundaries.
#[pyfunction]
pub fn chunk_text(
    text: &str,
    max_tokens: Option<usize>,
    overlap: Option<usize>,
) -> Vec<String> {
    let max_t = max_tokens.unwrap_or(256);
    let overlap_sents = overlap.unwrap_or(1);
    let sentences = split_sentences(text);

    if sentences.is_empty() {
        return vec![];
    }

    let mut chunks: Vec<String> = Vec::new();
    let mut current_chunk: Vec<String> = Vec::new();
    let mut current_tokens = 0;

    for sent in &sentences {
        let sent_tokens = token_len(sent);

        if current_tokens + sent_tokens > max_t && !current_chunk.is_empty() {
            // Flush current chunk
            chunks.push(current_chunk.join(" "));

            // Keep overlap sentences for context
            let overlap_start = current_chunk.len().saturating_sub(overlap_sents);
            current_chunk = current_chunk[overlap_start..].to_vec();
            current_tokens = current_chunk.iter().map(|s| token_len(s)).sum();
        }

        current_chunk.push(sent.clone());
        current_tokens += sent_tokens;
    }

    // Flush remaining
    if !current_chunk.is_empty() {
        chunks.push(current_chunk.join(" "));
    }

    chunks
}

/// Min-max normalize a score map into 0..1.
#[pyfunction]
pub fn normalize_scores(scores: HashMap<String, f64>, higher_is_better: Option<bool>) -> HashMap<String, f64> {
    normalize_scores_impl(scores, higher_is_better.unwrap_or(true))
}

/// Shared implementation used by both the #[pyfunction] wrapper and fuse().
fn normalize_scores_impl(scores: HashMap<String, f64>, higher: bool) -> HashMap<String, f64> {
    if scores.is_empty() {
        return scores;
    }

    let vals: Vec<f64> = scores.values().cloned().collect();
    let min_val = vals.iter().fold(f64::INFINITY, |a, &b| a.min(b));
    let max_val = vals.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b));
    let range = max_val - min_val;

    if range < 1e-10 {
        // All scores tie (or a single candidate) -> 1.0, not 0.5.
        // "The only thing I found" must not be scored 0.5 just because
        // there is nothing to compare it against (Python adapter rule).
        return scores.into_iter().map(|(k, _)| (k, 1.0)).collect();
    }

    scores.into_iter().map(|(k, v)| {
        let normalized = if higher {
            (v - min_val) / range
        } else {
            (max_val - v) / range
        };
        (k, normalized)
    }).collect()
}

/// Weighted-sum fusion over the union of both channels' candidate ids.
/// Mirrors the Python adapter contract exactly:
/// each channel is min-max normalized first; weights renormalize when only
/// one channel produced candidates; returns [(id, fused, {"vec","kw"}), ...]
/// sorted best-first (stable sort, matching Python's list.sort).
#[pyfunction]
pub fn fuse(
    vector_scores: HashMap<String, f64>,
    keyword_scores: HashMap<String, f64>,
    vector_weight: Option<f64>,
    keyword_weight: Option<f64>,
) -> Vec<(String, f64, HashMap<String, f64>)> {
    let wv0 = vector_weight.unwrap_or(0.7);
    let wk0 = keyword_weight.unwrap_or(0.3);

    let nv = normalize_scores_impl(vector_scores, true);
    let nk = normalize_scores_impl(keyword_scores, true);

    let (wv, wk) = if nv.is_empty() && nk.is_empty() {
        return vec![];
    } else if nv.is_empty() {
        (0.0, 1.0)
    } else if nk.is_empty() {
        (1.0, 0.0)
    } else {
        let total = wv0 + wk0;
        if total > 0.0 { (wv0 / total, wk0 / total) } else { (wv0, wk0) }
    };

    // Union of candidate ids in deterministic (sorted) order; Python iterates
    // a set (unordered), so any order is spec-compliant — ties keep this order
    // under the stable sort below.
    let mut keys: Vec<String> = nv.keys().chain(nk.keys()).cloned().collect();
    keys.sort();
    keys.dedup();

    let mut out: Vec<(String, f64, HashMap<String, f64>)> = keys.into_iter().map(|key| {
        let v = nv.get(&key).copied().unwrap_or(0.0);
        let k = nk.get(&key).copied().unwrap_or(0.0);
        let mut parts = HashMap::new();
        parts.insert("vec".to_string(), v);
        parts.insert("kw".to_string(), k);
        (key, wv * v + wk * k, parts)
    }).collect();

    // Best-first; sort_by is stable like Python's list.sort(key=lambda t: -t[1])
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// Register the memory_retrieval submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "memory_retrieval")?;
    m.add_function(wrap_pyfunction!(is_cjk, &m)?)?;
    m.add_function(wrap_pyfunction!(cjk_bigrams, &m)?)?;
    m.add_function(wrap_pyfunction!(fts_document, &m)?)?;
    m.add_function(wrap_pyfunction!(sanitize_term, &m)?)?;
    m.add_function(wrap_pyfunction!(build_fts_query, &m)?)?;
    m.add_function(wrap_pyfunction!(token_len, &m)?)?;
    m.add_function(wrap_pyfunction!(split_sentences, &m)?)?;
    m.add_function(wrap_pyfunction!(chunk_text, &m)?)?;
    m.add_function(wrap_pyfunction!(normalize_scores, &m)?)?;
    m.add_function(wrap_pyfunction!(fuse, &m)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}
