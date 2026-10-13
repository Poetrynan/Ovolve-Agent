//! memory_retrieval.rs — Hybrid retrieval: dense vectors + FTS5 keyword search.
//!
//! Rust implementation of `memory_retrieval.py`. Python is the spec (RULEBOOK §"the
//! old code is the spec"); every divergence below was a measured mismatch against
//! the canonical Python module and is now corrected.
//!
//! Corrections applied (2026-09-22):
//! - `is_cjk`: removed Hangul Jamo (0x1100-0x11FF) and CJK Ext-B (0x20000-0x2A6DF)
//!   ranges that were extra vs. the Python _CJK_RE.
//! - `cjk_bigrams`: single-char CJK runs now yield `[ch]` (was empty), matching
//!   Python's "a run of length 1 yields itself".
//! - `fts_document`: ASCII words are now lowercased and the original text is NOT
//!   prepended — matching Python's `" ".join(words + cjk_bigrams(text))`.
//! - `sanitize_term`: comma (`,`) added to the filter set to match Python's
//!   `_FTS_SPECIAL = set('"*():^-+,')`.
//! - `build_fts_query`: uses `[A-Za-z0-9_]+` word regex, filters len > 1 for
//!   ASCII terms, lowercases ASCII, empty result returns "" (not '""').
//! - `token_len`: reimplemented as `estimate_tokens` (wide_chars + ceil(rest/4),
//!   0 for empty) to mirror `token_estimate.py`.
//! - `split_sentences`: ASCII `.!?;` now only split when followed by whitespace
//!   or end-of-string, matching Python's `(?<=[.!?;])(?=\s)` lookahead.

use pyo3::prelude::*;
use regex::Regex;
use std::collections::{HashMap, HashSet};

// Python _CJK_RE = [\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+
// NO Hangul Jamo (0x1100-0x11FF), NO CJK Ext-B (0x20000-0x2A6DF).
static CJK_RE: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
    Regex::new(r"[\u{3040}-\u{30ff}\u{3400}-\u{4dbf}\u{4e00}-\u{9fff}\u{f900}-\u{faff}\u{ac00}-\u{d7af}]+").unwrap()
});

// Python _WIDE_RE = [\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]
static WIDE_RE: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
    Regex::new(r"[\u{3000}-\u{303f}\u{3040}-\u{30ff}\u{3400}-\u{4dbf}\u{4e00}-\u{9fff}\u{ac00}-\u{d7af}\u{f900}-\u{faff}\u{ff00}-\u{ffef}]").unwrap()
});

// Python _WORD_RE = [A-Za-z0-9_]+
static WORD_RE: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
    Regex::new(r"[A-Za-z0-9_]+").unwrap()
});

// ---------------------------------------------------------------------------
// CJK classification & tokenization
// ---------------------------------------------------------------------------

/// Check if a character is CJK/Hangul (Python `is_cjk`).
#[pyfunction]
pub fn is_cjk(ch: char) -> bool {
    CJK_RE.is_match(&ch.to_string())
}

/// Generate overlapping character bigrams for CJK text (Python `cjk_bigrams`).
/// A single-char run yields itself; runs of length >= 2 yield len-1 bigrams.
#[pyfunction]
pub fn cjk_bigrams(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let search_text = if text.is_empty() { "" } else { text };
    for mat in CJK_RE.find_iter(search_text) {
        let run = mat.as_str();
        let chars: Vec<char> = run.chars().collect();
        if chars.len() == 1 {
            out.push(run.to_string());
        } else {
            for j in 0..chars.len() - 1 {
                out.push(format!("{}{}", chars[j], chars[j + 1]));
            }
        }
    }
    out
}

/// Render text into FTS5 document format (Python `fts_document`).
/// ASCII words pass through lowercased; CJK runs are replaced by their bigrams.
#[pyfunction]
pub fn fts_document(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let words: Vec<String> = WORD_RE.find_iter(text)
        .map(|m| m.as_str().to_lowercase())
        .collect();
    let bigrams = cjk_bigrams(text);
    let mut parts = words;
    parts.extend(bigrams);
    parts.join(" ")
}

// ---------------------------------------------------------------------------
// FTS query building
// ---------------------------------------------------------------------------

/// Sanitize FTS5 operators from user text (Python `_sanitize_term`).
/// Python _FTS_SPECIAL = set('"*():^-+,')  — note the comma.
#[pyfunction]
pub fn sanitize_term(term: &str) -> String {
    term.chars()
        .filter(|c| !matches!(c, '"' | '*' | '(' | ')' | ':' | '^' | '-' | '+' | ','))
        .collect::<String>()
        .trim()
        .to_string()
}

/// Build an FTS5 MATCH expression (Python `build_fts_query`).
#[pyfunction]
pub fn build_fts_query(text: &str, keywords: Option<Vec<String>>) -> String {
    let mut terms: Vec<String> = Vec::new();

    // ASCII words from text: filter len > 1, lowercase (matches Python).
    let search_text = if text.is_empty() { "" } else { text };
    for m in WORD_RE.find_iter(search_text) {
        let w = m.as_str();
        if w.len() > 1 {
            terms.push(w.to_lowercase());
        }
    }
    // CJK bigrams from full text.
    terms.extend(cjk_bigrams(text));

    // Keywords: sanitize, filter len > 1, lowercase.
    if let Some(kw_list) = keywords {
        for kw in kw_list {
            let cleaned = sanitize_term(&kw);
            if cleaned.len() > 1 {
                terms.push(cleaned.to_lowercase());
            }
        }
    }

    // Deduplicate while preserving order; each term double-quoted.
    let mut seen = HashSet::new();
    let mut quoted: Vec<String> = Vec::new();
    for t in terms {
        let cleaned = sanitize_term(&t);
        if cleaned.is_empty() || seen.contains(&cleaned) {
            continue;
        }
        seen.insert(cleaned.clone());
        quoted.push(format!("\"{}\"", cleaned));
    }

    if quoted.is_empty() {
        // Python returns "" (empty string), NOT '""'.
        return String::new();
    }
    quoted.join(" OR ")
}

// ---------------------------------------------------------------------------
// Token estimation (mirrors token_estimate.estimate_tokens)
// ---------------------------------------------------------------------------

/// Estimate token cost: wide_chars + ceil(rest / 4), 0 for empty string.
/// Mirrors `token_estimate.estimate_tokens` exactly.
fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let wide = WIDE_RE.find_iter(text).count();
    let total_chars = text.chars().count();
    let rest = total_chars - wide;
    wide + (rest + 3) / 4
}

/// Public token_len wrapper (Python `_token_len` → `estimate_tokens`).
#[pyfunction]
pub fn token_len(text: &str) -> usize {
    estimate_tokens(text)
}

// ---------------------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------------------

/// Split into sentence-like spans (Python `split_sentences`).
/// Python regex: (?<=[。！？；\n])|(?<=[.!?;])(?=\s)
/// Chinese delimiters always split; ASCII delimiters only when followed by
/// whitespace or end-of-string.
#[pyfunction]
pub fn split_sentences(text: &str) -> Vec<String> {
    if text.is_empty() {
        return vec![];
    }

    let char_indices: Vec<(usize, char)> = text.char_indices().collect();
    let mut sentences: Vec<String> = vec![];
    let mut start: usize = 0;

    for &(i, ch) in &char_indices {
        let is_chinese_delim = matches!(ch, '。' | '！' | '？' | '；' | '\n');

        let next_is_ws_or_end = char_indices
            .iter()
            .find(|&&(pos, _)| pos > i)
            .map_or(true, |&(_, c)| c.is_whitespace());

        let is_ascii_split = matches!(ch, '.' | '!' | '?' | ';') && next_is_ws_or_end;

        if is_chinese_delim || is_ascii_split {
            let end = i + ch.len_utf8();
            let segment = &text[start..end];
            if !segment.is_empty() {
                sentences.push(segment.to_string());
            }
            start = end;
        }
    }

    // Trailing segment after the last split point.
    if start < text.len() {
        let segment = &text[start..];
        if !segment.is_empty() {
            sentences.push(segment.to_string());
        }
    }

    if sentences.is_empty() {
        sentences.push(text.to_string());
    }

    sentences
}

// ---------------------------------------------------------------------------
// Score normalization & fusion
// ---------------------------------------------------------------------------

/// Min-max normalize a score map into 0..1 (Python `normalize_scores`).
#[pyfunction]
pub fn normalize_scores(scores: HashMap<String, f64>, higher_is_better: Option<bool>) -> HashMap<String, f64> {
    let higher = higher_is_better.unwrap_or(true);
    if scores.is_empty() {
        return scores;
    }

    let vals: Vec<f64> = scores.values().cloned().collect();
    let min_val = vals.iter().fold(f64::INFINITY, |a, &b| a.min(b));
    let max_val = vals.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b));
    let range = max_val - min_val;

    if range < 1e-10 {
        // Single candidate or all tie -> 1.0.
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

/// Weighted-sum fusion (Python `fuse`).
#[pyfunction]
pub fn fuse(
    vector_scores: HashMap<String, f64>,
    keyword_scores: HashMap<String, f64>,
    vector_weight: Option<f64>,
    keyword_weight: Option<f64>,
) -> Vec<(String, f64, HashMap<String, f64>)> {
    let wv0 = vector_weight.unwrap_or(0.7);
    let wk0 = keyword_weight.unwrap_or(0.3);

    // Min-max normalize via the shared implementation.
    let nv = {
        let higher = true;
        if vector_scores.is_empty() {
            HashMap::new()
        } else {
            let vals: Vec<f64> = vector_scores.values().cloned().collect();
            let min_v = vals.iter().fold(f64::INFINITY, |a, &b| a.min(b));
            let max_v = vals.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b));
            let range = max_v - min_v;
            if range < 1e-10 {
                vector_scores.into_iter().map(|(k, _)| (k, 1.0)).collect()
            } else {
                vector_scores.into_iter().map(|(k, v)| (k, (v - min_v) / range)).collect()
            }
        }
    };
    let nk = {
        if keyword_scores.is_empty() {
            HashMap::new()
        } else {
            let vals: Vec<f64> = keyword_scores.values().cloned().collect();
            let min_v = vals.iter().fold(f64::INFINITY, |a, &b| a.min(b));
            let max_v = vals.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b));
            let range = max_v - min_v;
            if range < 1e-10 {
                keyword_scores.into_iter().map(|(k, _)| (k, 1.0)).collect()
            } else {
                keyword_scores.into_iter().map(|(k, v)| (k, (v - min_v) / range)).collect()
            }
        }
    };

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

    // Union of candidate ids in sorted order for determinism.
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

    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    out
}

// ---------------------------------------------------------------------------
// Channel declaration (Python `declare_channels` / `describe_channels`)
// ---------------------------------------------------------------------------

/// Which channels actually contributed (Python `declare_channels`).
#[pyfunction]
pub fn declare_channels(
    vector_scores: HashMap<String, f64>,
    keyword_scores: HashMap<String, f64>,
    vector_weight: Option<f64>,
    keyword_weight: Option<f64>,
    embedded_rows: Option<usize>,
    total_rows: Option<usize>,
) -> HashMap<String, PyObject> {
    let vw0 = vector_weight.unwrap_or(0.7);
    let kw0 = keyword_weight.unwrap_or(0.3);

    Python::with_gil(|py| {
        let vec_live = !vector_scores.is_empty();
        let kw_live = !keyword_scores.is_empty();
        let (wv, wk, mode) = if !vec_live && !kw_live {
            (0.0, 0.0, "none")
        } else if !vec_live {
            (0.0, 1.0, "keyword_only")
        } else if !kw_live {
            (1.0, 0.0, "vector_only")
        } else {
            let total = vw0 + kw0;
            if total > 0.0 {
                (vw0 / total, kw0 / total, "hybrid")
            } else {
                (vw0, kw0, "hybrid")
            }
        };

        let mut report: HashMap<String, PyObject> = HashMap::new();
        report.insert("mode".to_string(), mode.to_object(py));
        report.insert("vectorLive".to_string(), vec_live.to_object(py));
        report.insert("keywordLive".to_string(), kw_live.to_object(py));
        report.insert("vectorCandidates".to_string(), vector_scores.len().to_object(py));
        report.insert("keywordCandidates".to_string(), keyword_scores.len().to_object(py));
        report.insert("effectiveVectorWeight".to_string(), ((wv * 10000.0).round() / 10000.0).to_object(py));
        report.insert("effectiveKeywordWeight".to_string(), ((wk * 10000.0).round() / 10000.0).to_object(py));
        report.insert("nominalVectorWeight".to_string(), ((vw0 * 10000.0).round() / 10000.0).to_object(py));
        report.insert("nominalKeywordWeight".to_string(), ((kw0 * 10000.0).round() / 10000.0).to_object(py));
        report.insert("degraded".to_string(), (mode != "hybrid").to_object(py));

        if let Some(total) = total_rows {
            let embedded = embedded_rows.unwrap_or(0);
            report.insert("rows".to_string(), total.to_object(py));
            report.insert("embeddedRows".to_string(), embedded.to_object(py));
            let coverage = if total > 0 {
                ((embedded as f64 / total as f64) * 10000.0).round() / 10000.0
            } else {
                0.0
            };
            report.insert("embeddingCoverage".to_string(), coverage.to_object(py));
            report.insert("vectorUnavailable".to_string(), (embedded == 0).to_object(py));
        }

        report
    })
}

/// One-line human-readable form (Python `describe_channels`).
#[pyfunction]
pub fn describe_channels(report: HashMap<String, PyObject>) -> String {
    Python::with_gil(|py| {
        if report.is_empty() {
            return String::new();
        }

        let mode: String = report.get("mode")
            .and_then(|v| v.extract(py).ok())
            .unwrap_or_default();
        let vec_live: bool = report.get("vectorLive")
            .and_then(|v| v.extract(py).ok())
            .unwrap_or(false);
        let vec_cand: usize = report.get("vectorCandidates")
            .and_then(|v| v.extract(py).ok())
            .unwrap_or(0);
        let vec_w: f64 = report.get("effectiveVectorWeight")
            .and_then(|v| v.extract(py).ok())
            .unwrap_or(0.0);
        let kw_live: bool = report.get("keywordLive")
            .and_then(|v| v.extract(py).ok())
            .unwrap_or(false);
        let kw_cand: usize = report.get("keywordCandidates")
            .and_then(|v| v.extract(py).ok())
            .unwrap_or(0);
        let kw_w: f64 = report.get("effectiveKeywordWeight")
            .and_then(|v| v.extract(py).ok())
            .unwrap_or(0.0);

        let mut parts = vec![
            format!("mode={}", mode),
            format!("vec={}({} cand, w={})",
                if vec_live { "on" } else { "off" }, vec_cand, vec_w),
            format!("kw={}({} cand, w={})",
                if kw_live { "on" } else { "off" }, kw_cand, kw_w),
        ];

        if let Some(embedded_obj) = report.get("embeddedRows") {
            let embedded: usize = embedded_obj.extract(py).unwrap_or(0);
            let rows: usize = report.get("rows")
                .and_then(|v| v.extract(py).ok())
                .unwrap_or(0);
            parts.push(format!("embedded={}/{}", embedded, rows));
        }

        "channels: ".to_string() + &parts.join(" ")
    })
}

/// Human-readable retrieval trace (Python `retrieval_trace`).
#[pyfunction]
pub fn retrieval_trace(
    fused: Vec<(String, f64, HashMap<String, f64>)>,
    limit: Option<usize>,
    channels: Option<HashMap<String, PyObject>>,
) -> Vec<String> {
    let lim = limit.unwrap_or(10);
    let mut lines: Vec<String> = vec![];

    if let Some(ch) = channels {
        let desc = describe_channels(ch);
        if !desc.is_empty() {
            lines.push(desc);
        }
    }

    for (rank, (key, score, parts)) in fused.iter().take(lim).enumerate() {
        let v = parts.get("vec").copied().unwrap_or(0.0);
        let k = parts.get("kw").copied().unwrap_or(0.0);
        let origin = if v > 0.0 && k > 0.0 {
            "both"
        } else if v > 0.0 {
            "vector-only"
        } else {
            "keyword-only"
        };
        lines.push(format!(
            "#{} {} fused={:.3} vec={:.3} kw={:.3} ({})",
            rank + 1, key, score, v, k, origin
        ));
    }

    lines
}

// ---------------------------------------------------------------------------
// Chunking (Python `chunk_text`)
// ---------------------------------------------------------------------------

/// Split text into overlapping chunks at sentence boundaries (Python `chunk_text`).
/// Returns a list of dicts with index / text / tokens / start.
#[pyfunction]
pub fn chunk_text<'a>(
    py: Python<'a>,
    text: &'a str,
    chunk_tokens: Option<usize>,
    overlap_tokens: Option<usize>,
) -> Vec<pyo3::Bound<'a, pyo3::types::PyDict>> {
    use pyo3::types::PyDict;

    let chunk_t = chunk_tokens.unwrap_or(400);
    let overlap_t = overlap_tokens.unwrap_or(80);

    if text.is_empty() || text.trim().is_empty() {
        return vec![];
    }

    let total = estimate_tokens(text);
    if total <= chunk_t {
        let dict = PyDict::new_bound(py);
        dict.set_item("index", 0).unwrap();
        dict.set_item("text", text).unwrap();
        dict.set_item("tokens", total).unwrap();
        dict.set_item("start", 0).unwrap();
        return vec![dict];
    }

    let sentences = split_sentences(text);
    let mut chunks: Vec<pyo3::Bound<'_, pyo3::types::PyDict>> = vec![];
    let mut buf: Vec<String> = vec![];
    let mut buf_tokens: usize = 0;
    let mut cursor: usize = 0;   // char offset of buf[0] within text
    let mut consumed: usize = 0; // char offset just past the last consumed sentence

    for sent in &sentences {
        let st = estimate_tokens(sent);
        if !buf.is_empty() && buf_tokens + st > chunk_t {
            // Flush current buffer.
            let body: String = buf.concat();
            let dict = PyDict::new_bound(py);
            dict.set_item("index", chunks.len()).unwrap();
            dict.set_item("text", &body).unwrap();
            dict.set_item("tokens", buf_tokens).unwrap();
            dict.set_item("start", cursor).unwrap();
            chunks.push(dict);

            // Re-seed with trailing sentences up to overlap_t.
            let mut tail: Vec<String> = vec![];
            let mut tail_tokens: usize = 0;
            for s in buf.iter().rev() {
                let t = estimate_tokens(s);
                if tail_tokens + t > overlap_t && !tail.is_empty() {
                    break;
                }
                tail.insert(0, s.clone());
                tail_tokens += t;
            }
            let tail_len: usize = tail.iter().map(|s| s.chars().count()).sum();
            cursor = consumed - tail_len;
            buf = tail;
            buf_tokens = tail_tokens;
        }

        buf.push(sent.clone());
        buf_tokens += st;
        consumed += sent.chars().count();

        if buf_tokens >= chunk_t {
            let body: String = buf.concat();
            let dict = PyDict::new_bound(py);
            dict.set_item("index", chunks.len()).unwrap();
            dict.set_item("text", &body).unwrap();
            dict.set_item("tokens", buf_tokens).unwrap();
            dict.set_item("start", cursor).unwrap();
            chunks.push(dict);

            let mut tail: Vec<String> = vec![];
            let mut tail_tokens: usize = 0;
            for s in buf.iter().rev() {
                let t = estimate_tokens(s);
                if tail_tokens + t > overlap_t && !tail.is_empty() {
                    break;
                }
                tail.insert(0, s.clone());
                tail_tokens += t;
            }
            let tail_len: usize = tail.iter().map(|s| s.chars().count()).sum();
            cursor = consumed - tail_len;
            buf = tail;
            buf_tokens = tail_tokens;
        }
    }

    // Flush remaining buffer, avoiding a pure duplicate of the previous chunk.
    if !buf.is_empty() {
        let body: String = buf.concat();
        let is_dup = chunks.last()
            .map(|last| {
                last.get_item("text").ok()
                    .flatten()
                    .and_then(|v| v.extract::<String>().ok())
                    .map_or(false, |prev| body == prev || prev.contains(&body))
            })
            .unwrap_or(false);

        if !is_dup {
            let dict = PyDict::new_bound(py);
            dict.set_item("index", chunks.len()).unwrap();
            dict.set_item("text", &body).unwrap();
            dict.set_item("tokens", buf_tokens).unwrap();
            dict.set_item("start", cursor).unwrap();
            chunks.push(dict);
        }
    }

    chunks
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
    m.add_function(wrap_pyfunction!(declare_channels, &m)?)?;
    m.add_function(wrap_pyfunction!(describe_channels, &m)?)?;
    m.add_function(wrap_pyfunction!(retrieval_trace, &m)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}
