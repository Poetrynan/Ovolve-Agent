//! aider_parser.rs — SEARCH/REPLACE parsing + indentation-tolerant matching.
//!
//! Rust implementation of `aider_parser.py`. Faithful port: the Python module is
//! the spec (RULEBOOK "the old code is the spec").
//!
//! Implements the pure-Python fallback path of the original: levenshtein distance,
//! similarity scoring, block parsing, indentation realignment, and the
//! four-strategy match (exact → rstrip → reindent → fuzzy).
//!
//! The optional Rust-backend (`replace_file_content_fast`) call is NOT mirrored
//! here — this module IS the backend that the Python version falls back to.

use pyo3::prelude::*;
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SIMILARITY_THRESHOLD: f64 = 0.8;
const DIAGNOSTIC_SIMILARITY_FLOOR: f64 = 0.55;

// ---------------------------------------------------------------------------
// Similarity primitives (mirror the Python implementation)
// ---------------------------------------------------------------------------

/// Edit distance over code points. Two-row DP: O(min(n,m)) memory.
#[pyfunction]
pub fn levenshtein_distance(s1: &str, s2: &str) -> usize {
    if s1 == s2 {
        return 0;
    }
    let a: Vec<char> = s1.chars().collect();
    let b: Vec<char> = s2.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    // Ensure a is the longer one.
    let (a, b) = if a.len() < b.len() { (b, a) } else { (a, b) };
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            cur[j + 1] = std::cmp::min(
                std::cmp::min(prev[j + 1] + 1, cur[j] + 1),
                prev[j] + cost,
            );
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Whitespace-insensitive similarity in [0,1].
#[pyfunction]
pub fn compute_similarity(s1: &str, s2: &str) -> f64 {
    let clean1: String = s1.chars().filter(|c| !c.is_whitespace()).collect();
    let clean2: String = s2.chars().filter(|c| !c.is_whitespace()).collect();
    if clean1.is_empty() || clean2.is_empty() {
        return 0.0;
    }
    if clean1 == clean2 {
        return 1.0;
    }
    if clean1.contains(&clean2) || clean2.contains(&clean1) {
        return 0.85;
    }
    let max_len = std::cmp::max(clean1.len(), clean2.len());
    if max_len == 0 {
        return 1.0;
    }
    let dist = levenshtein_distance(&clean1, &clean2) as f64;
    (1.0 - dist / max_len as f64).max(0.0)
}

// ---------------------------------------------------------------------------
// AiderBlock
// ---------------------------------------------------------------------------

#[pyclass]
#[derive(Debug, Clone)]
pub struct AiderBlock {
    #[pyo3(get, set)]
    pub search: String,
    #[pyo3(get, set)]
    pub replace: String,
    #[pyo3(get, set)]
    pub path: String,
    #[pyo3(get, set)]
    pub index: usize,
}

#[pymethods]
impl AiderBlock {
    #[new]
    #[pyo3(signature = (search, replace, path=None, index=None))]
    fn new(search: String, replace: String, path: Option<String>, index: Option<usize>) -> Self {
        Self {
            search,
            replace,
            path: path.unwrap_or_default(),
            index: index.unwrap_or(0),
        }
    }
}

// ---------------------------------------------------------------------------
// MatchRegion
// ---------------------------------------------------------------------------

#[pyclass]
#[derive(Debug, Clone)]
pub struct MatchRegion {
    #[pyo3(get, set)]
    pub start: usize,
    #[pyo3(get, set)]
    pub end: usize,
    #[pyo3(get, set)]
    pub similarity: f64,
    #[pyo3(get, set)]
    pub strategy: String,
    #[pyo3(get, set)]
    pub file_indent: String,
    #[pyo3(get, set)]
    pub search_indent: String,
    #[pyo3(get, set)]
    pub line_number: usize,
}

#[pymethods]
impl MatchRegion {
    #[new]
    #[pyo3(signature = (start, end, similarity, strategy, file_indent=None, search_indent=None, line_number=None))]
    fn new(
        start: usize, end: usize, similarity: f64, strategy: String,
        file_indent: Option<String>, search_indent: Option<String>, line_number: Option<usize>,
    ) -> Self {
        Self {
            start, end, similarity, strategy,
            file_indent: file_indent.unwrap_or_default(),
            search_indent: search_indent.unwrap_or_default(),
            line_number: line_number.unwrap_or(0),
        }
    }
}

// ---------------------------------------------------------------------------
// ReplaceOutcome
// ---------------------------------------------------------------------------

#[pyclass]
#[derive(Debug)]
pub struct ReplaceOutcome {
    #[pyo3(get, set)]
    pub ok: bool,
    #[pyo3(get, set)]
    pub content: String,
    #[pyo3(get, set)]
    pub similarity: f64,
    #[pyo3(get, set)]
    pub strategy: String,
    #[pyo3(get, set)]
    pub backend: String,
    #[pyo3(get, set)]
    pub replaced_count: usize,
    #[pyo3(get, set)]
    pub line_number: usize,
    #[pyo3(get, set)]
    pub error: String,
    #[pyo3(get, set)]
    pub diagnostics: String,
    #[pyo3(get, set)]
    pub candidates: Vec<HashMap<String, PyObject>>,
}

#[pymethods]
impl ReplaceOutcome {
    #[new]
    #[pyo3(signature = (ok, content=None, similarity=None, strategy=None, backend=None, replaced_count=None, line_number=None, error=None, diagnostics=None, candidates=None))]
    fn new(
        ok: bool, content: Option<String>, similarity: Option<f64>, strategy: Option<String>,
        backend: Option<String>, replaced_count: Option<usize>, line_number: Option<usize>,
        error: Option<String>, diagnostics: Option<String>, candidates: Option<Vec<HashMap<String, PyObject>>>,
    ) -> Self {
        Self {
            ok,
            content: content.unwrap_or_default(),
            similarity: similarity.unwrap_or(0.0),
            strategy: strategy.unwrap_or_default(),
            backend: backend.unwrap_or("rust-aider_parser".to_string()),
            replaced_count: replaced_count.unwrap_or(0),
            line_number: line_number.unwrap_or(0),
            error: error.unwrap_or_default(),
            diagnostics: diagnostics.unwrap_or_default(),
            candidates: candidates.unwrap_or_default(),
        }
    }
}

// ---------------------------------------------------------------------------
// Indentation helpers
// ---------------------------------------------------------------------------

fn _leading_ws(line: &str) -> String {
    let len = line.len() - line.trim_start().len();
    line[..len].to_string()
}

fn common_indent_lines(lines: &[&str]) -> String {
    let mut prefix: Option<String> = None;
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let ws = _leading_ws(line);
        match &mut prefix {
            Some(p) => {
                let mut i = 0;
                let limit = std::cmp::min(p.len(), ws.len());
                while i < limit && p.as_bytes()[i] == ws.as_bytes()[i] {
                    i += 1;
                }
                *p = p[..i].to_string();
                if p.is_empty() {
                    break;
                }
            }
            None => {
                prefix = Some(ws);
            }
        }
    }
    prefix.unwrap_or_default()
}

fn dedent_block_lines(lines: &[String]) -> (Vec<String>, String) {
    let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
    let prefix = common_indent_lines(&refs);
    if prefix.is_empty() {
        return (lines.to_vec(), String::new());
    }
    let out: Vec<String> = lines.iter().map(|line| {
        if line.starts_with(&prefix) {
            line[prefix.len()..].to_string()
        } else {
            line.trim_start().to_string()
        }
    }).collect();
    (out, prefix)
}

fn reindent_block(text: &str, from_indent: &str, to_indent: &str) -> String {
    if from_indent == to_indent {
        return text.to_string();
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let out: Vec<String> = lines.iter().map(|line| {
        if line.trim().is_empty() {
            String::new()
        } else if from_indent.is_empty() {
            format!("{}{}", to_indent, line.trim_start())
        } else if line.starts_with(from_indent) {
            format!("{}{}", to_indent, &line[from_indent.len()..])
        } else {
            format!("{}{}", to_indent, line.trim_start())
        }
    }).collect();
    out.join("\n")
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

fn _clean_path_candidate(line: &str) -> String {
    let s = line.trim().trim_matches('`').trim().trim_end_matches(':').trim();
    if s.is_empty() || s.len() > 400 {
        return String::new();
    }
    // Check path chars: [\w./\\@:+~-]+
    if !s.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '/' || c == '\\' || c == '@' || c == ':' || c == '+' || c == '~' || c == '-') {
        return String::new();
    }
    if !s.contains('.') && !s.contains('/') && !s.contains('\\') {
        return String::new();
    }
    s.to_string()
}

/// Parse SEARCH/REPLACE blocks from text.
#[pyfunction]
pub fn parse_aider_blocks(text: &str) -> Vec<AiderBlock> {
    if text.is_empty() {
        return vec![];
    }
    let mut blocks: Vec<AiderBlock> = vec![];
    let mut path_candidate = String::new();
    let mut state = "idle";
    let mut search_lines: Vec<String> = vec![];
    let mut replace_lines: Vec<String> = vec![];
    let mut current_path = String::new();

    let normalized = text.replace("\r\n", "\n").replace("\r", "\n");
    for raw in normalized.split('\n') {
        match state {
            "idle" => {
                if raw.trim_start().starts_with("<<<<<") && raw.trim_end().ends_with("SEARCH") {
                    state = "search";
                    search_lines.clear();
                    replace_lines.clear();
                    current_path = path_candidate.clone();
                    continue;
                }
                // CODE_FENCE check: ```...``` between path and SEARCH
                let t = raw.trim();
                if t.starts_with("```") && t.ends_with("```") && t.len() > 3 {
                    continue;
                }
                let cand = _clean_path_candidate(raw);
                if !cand.is_empty() {
                    path_candidate = cand;
                }
                continue;
            }
            "search" => {
                if raw.trim().starts_with("=======") {
                    state = "replace";
                    continue;
                }
                search_lines.push(raw.to_string());
                continue;
            }
            _ => {
                // replace state
                let t = raw.trim();
                if t.starts_with(">>>>>") && (t.ends_with("REPLACE") || t.len() == 5 || t[5..].trim().is_empty() || t[5..].trim() == "REPLACE") {
                    blocks.push(AiderBlock {
                        search: search_lines.join("\n"),
                        replace: replace_lines.join("\n"),
                        path: current_path.clone(),
                        index: blocks.len(),
                    });
                    state = "idle";
                    path_candidate = String::new();
                    continue;
                }
                replace_lines.push(raw.to_string());
            }
        }
    }

    // Unterminated trailing block.
    if state == "replace" {
        blocks.push(AiderBlock {
            search: search_lines.join("\n"),
            replace: replace_lines.join("\n"),
            path: current_path,
            index: blocks.len(),
        });
    }
    blocks
}

/// Cheap probe: does this text contain a SEARCH/REPLACE fence?
#[pyfunction]
pub fn has_aider_block(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    text.split('\n').any(|ln| {
        let t = ln.trim_start();
        t.starts_with("<<<<<") && t.trim_end().ends_with("SEARCH")
    })
}

// ---------------------------------------------------------------------------
// Line offsets helper
// ---------------------------------------------------------------------------

fn _line_offsets(content: &str) -> (Vec<String>, Vec<usize>) {
    let mut lines = Vec::new();
    let mut offsets = Vec::new();
    let mut pos = 0;
    for piece in content.split('\n') {
        offsets.push(pos);
        let stripped = piece.trim_end_matches('\n').trim_end_matches('\r');
        lines.push(stripped.to_string());
        pos += piece.len() + 1; // +1 for the newline we split on
    }
    // Adjust offsets: split('\n') doesn't give us the original byte offsets correctly.
    // Recompute properly.
    lines.clear();
    offsets.clear();
    pos = 0;
    for piece in content.split_inclusive('\n') {
        offsets.push(pos);
        let stripped = piece.trim_end_matches('\n').trim_end_matches('\r');
        lines.push(stripped.to_string());
        pos += piece.len();
    }
    (lines, offsets)
}

fn _region_end(lines: &[String], offsets: &[usize], start_idx: usize, count: usize) -> usize {
    let last = start_idx + count - 1;
    offsets[last] + lines[last].len()
}

// ---------------------------------------------------------------------------
// find_match
// ---------------------------------------------------------------------------

/// Locate `search` in `content`, escalating through four strategies.
#[pyfunction]
#[pyo3(signature = (content, search, threshold=None))]
pub fn find_match(content: &str, search: &str, threshold: Option<f64>) -> Option<MatchRegion> {
    let thr = threshold.unwrap_or(DEFAULT_SIMILARITY_THRESHOLD);
    if search.is_empty() {
        return None;
    }

    // 1. Exact substring.
    if let Some(idx) = content.find(search) {
        let line_number = content[..idx].chars().filter(|c| *c == '\n').count() + 1;
        return Some(MatchRegion {
            start: idx,
            end: idx + search.len(),
            similarity: 1.0,
            strategy: "exact".to_string(),
            file_indent: String::new(),
            search_indent: String::new(),
            line_number,
        });
    }

    let (lines, offsets) = _line_offsets(content);
    let search_lines: Vec<&str> = search.split('\n').collect();
    let n = search_lines.len();
    if n == 0 || lines.len() < n {
        return None;
    }

    let search_rstrip: Vec<String> = search_lines.iter().map(|s| s.trim_end().to_string()).collect();
    let (dedented_search, search_indent) = dedent_block_lines(
        &search_lines.iter().map(|s| s.to_string()).collect::<Vec<_>>()
    );
    let dedented_rstrip: Vec<String> = dedented_search.iter().map(|s| s.trim_end().to_string()).collect();
    let search_joined = search_lines.join("\n");

    let mut best: Option<MatchRegion> = None;

    for i in 0..=lines.len() - n {
        let window: Vec<&str> = lines[i..i + n].iter().map(|s| s.as_str()).collect();

        // 2. Trailing whitespace only.
        let window_rstrip: Vec<String> = window.iter().map(|w| w.trim_end().to_string()).collect();
        if window_rstrip == search_rstrip {
            return Some(MatchRegion {
                start: offsets[i],
                end: _region_end(&lines, &offsets, i, n),
                similarity: 1.0,
                strategy: "rstrip".to_string(),
                file_indent: common_indent_lines(&window),
                search_indent: search_indent.clone(),
                line_number: i + 1,
            });
        }

        // 3. Indentation drift.
        let (dedented_window, window_indent) = dedent_block_lines(
            &window.iter().map(|s| s.to_string()).collect::<Vec<_>>()
        );
        let dedented_window_rstrip: Vec<String> = dedented_window.iter().map(|s| s.trim_end().to_string()).collect();
        if dedented_window_rstrip == dedented_rstrip {
            return Some(MatchRegion {
                start: offsets[i],
                end: _region_end(&lines, &offsets, i, n),
                similarity: 1.0,
                strategy: "reindent".to_string(),
                file_indent: window_indent,
                search_indent: search_indent.clone(),
                line_number: i + 1,
            });
        }

        // 4. Fuzzy.
        let window_joined = window.join("\n");
        let sim = compute_similarity(&search_joined, &window_joined);
        if sim >= thr {
            let is_better = best.as_ref().map_or(true, |b| sim > b.similarity);
            if is_better {
                best = Some(MatchRegion {
                    start: offsets[i],
                    end: _region_end(&lines, &offsets, i, n),
                    similarity: sim,
                    strategy: "fuzzy".to_string(),
                    file_indent: window_indent,
                    search_indent: search_indent.clone(),
                    line_number: i + 1,
                });
            }
        }
    }

    best
}

// ---------------------------------------------------------------------------
// build_diagnostics
// ---------------------------------------------------------------------------

/// Near-miss report for a failed match.
#[pyfunction]
pub fn build_diagnostics(content: &str, search: &str) -> (String, Vec<HashMap<String, PyObject>>) {
    Python::with_gil(|py| {
        let lines: Vec<&str> = content.split('\n').collect();
        let search_lines: Vec<&str> = search.split('\n').collect();
        let first = search_lines.first().map(|s| s.trim()).unwrap_or("");
        let mut candidates: Vec<HashMap<String, PyObject>> = vec![];

        if !first.is_empty() {
            let target_line_count = search_lines.len();
            for (idx, line) in lines.iter().enumerate() {
                let sim = compute_similarity(first, line);
                if sim < DIAGNOSTIC_SIMILARITY_FLOOR {
                    continue;
                }
                let start_ctx = idx.saturating_sub(2);
                let end_ctx = std::cmp::min(lines.len(), idx + target_line_count + 2);
                let preview: Vec<String> = (start_ctx..end_ctx)
                    .map(|i| format!("{:4} | {}", i + 1, lines[i]))
                    .collect();
                let mut cand = HashMap::new();
                cand.insert("line_number".to_string(), (idx + 1).to_object(py));
                cand.insert("similarity".to_string(), ((sim * 10000.0).round() / 10000.0).to_object(py));
                cand.insert("preview".to_string(), preview.join("\n").to_object(py));
                candidates.push(cand);
                if candidates.len() >= 3 {
                    break;
                }
            }
        }

        if candidates.is_empty() {
            return (String::new(), vec![]);
        }

        let hints: Vec<String> = candidates.iter().map(|c| {
            let py_c = c.clone();
            Python::with_gil(|py| {
                let line_num: usize = py_c.get("line_number").unwrap().extract(py).unwrap();
                let sim: f64 = py_c.get("similarity").unwrap().extract(py).unwrap();
                let preview: String = py_c.get("preview").unwrap().extract(py).unwrap();
                format!("Near Line {} (similarity {:.2}):\n{}", line_num, sim, preview)
            })
        }).collect();

        let msg = format!(
            "Auto-Diagnosis: the SEARCH text was not found (check whitespace/indentation/typo). Closest candidate line(s):\n{}\nAdjust the SEARCH text to match the exact lines above.",
            hints.join("\n---\n")
        );
        (msg, candidates)
    })
}

// ---------------------------------------------------------------------------
// replace_once
// ---------------------------------------------------------------------------

/// Replace one (or all exact) occurrence(s) of search with replace.
#[pyfunction]
#[pyo3(signature = (content, search, replace, threshold=None, allow_multiple=None))]
pub fn replace_once(
    content: &str, search: &str, replace: &str,
    threshold: Option<f64>, allow_multiple: Option<bool>,
) -> ReplaceOutcome {
    let thr = threshold.unwrap_or(DEFAULT_SIMILARITY_THRESHOLD);
    let multi = allow_multiple.unwrap_or(false);

    if search.is_empty() {
        return ReplaceOutcome::new(false, Some(content.to_string()), None, None, None, None, None, Some("empty SEARCH text".to_string()), None, None);
    }

    if multi {
        let count = content.matches(search).count();
        if count > 1 {
            return ReplaceOutcome::new(
                true,
                Some(content.replace(search, replace)),
                Some(1.0),
                Some("exact".to_string()),
                Some("rust-aider_parser".to_string()),
                Some(count),
                Some(content[..content.find(search).unwrap_or(0)].chars().filter(|c| *c == '\n').count() + 1),
                None, None, None,
            );
        }
    }

    let region = find_match(content, search, Some(thr));
    if region.is_none() {
        let (diag, candidates) = build_diagnostics(content, search);
        return ReplaceOutcome::new(
            false, Some(content.to_string()), None, None,
            Some("rust-aider_parser".to_string()), None, None,
            Some(format!("SEARCH text not found and no candidate reached the similarity threshold {:.2}", thr)),
            Some(diag), Some(candidates),
        );
    }
    let region = region.unwrap();

    if region.strategy == "exact" && !multi {
        let occurrences = content.matches(search).count();
        if occurrences > 1 {
            return ReplaceOutcome::new(
                false, Some(content.to_string()), Some(1.0), Some("exact".to_string()),
                Some("rust-aider_parser".to_string()), None, None,
                Some(format!("SEARCH text appears {} times; add surrounding context or set allow_multiple=true", occurrences)),
                None, None,
            );
        }
    }

    let replacement = if (region.strategy == "reindent" || region.strategy == "fuzzy")
        && region.file_indent != region.search_indent {
        reindent_block(replace, &region.search_indent, &region.file_indent)
    } else {
        replace.to_string()
    };

    let new_content = format!("{}{}{}", &content[..region.start], replacement, &content[region.end..]);
    ReplaceOutcome::new(
        true, Some(new_content), Some(region.similarity), Some(region.strategy.clone()),
        Some("rust-aider_parser".to_string()), Some(1), Some(region.line_number),
        None, None, None,
    )
}

// ---------------------------------------------------------------------------
// apply_aider_blocks
// ---------------------------------------------------------------------------

/// Apply every parsed block in order; the first failure aborts the whole set.
#[pyfunction]
pub fn apply_aider_blocks(content: &str, blocks_or_text: &str, threshold: Option<f64>) -> ReplaceOutcome {
    let blocks = parse_aider_blocks(blocks_or_text);
    if blocks.is_empty() {
        return ReplaceOutcome::new(
            false, Some(content.to_string()), None, None,
            Some("rust-aider_parser".to_string()), None, None,
            Some("no SEARCH/REPLACE block found".to_string()),
            None, None,
        );
    }

    let mut current = content.to_string();
    let mut applied = 0;
    let mut worst: f64 = 1.0;
    let mut strategies: Vec<String> = vec![];

    for block in &blocks {
        let outcome = replace_once(&current, &block.search, &block.replace, threshold, None);
        if !outcome.ok {
            return ReplaceOutcome::new(
                false, Some(content.to_string()), None, None,
                Some(outcome.backend), Some(applied), None,
                Some(format!("block #{} failed: {}", block.index + 1, outcome.error)),
                Some(outcome.diagnostics), Some(outcome.candidates),
            );
        }
        current = outcome.content.clone();
        applied += 1;
        worst = worst.min(outcome.similarity);
        if !strategies.contains(&outcome.strategy) {
            strategies.push(outcome.strategy.clone());
        }
    }

    ReplaceOutcome::new(
        true, Some(current), Some(worst), Some(strategies.join("+")),
        Some("rust-aider_parser".to_string()), Some(applied), None,
        None, None, None,
    )
}

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------

pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "aider_parser")?;
    m.add_function(wrap_pyfunction!(levenshtein_distance, &m)?)?;
    m.add_function(wrap_pyfunction!(compute_similarity, &m)?)?;
    m.add_function(wrap_pyfunction!(parse_aider_blocks, &m)?)?;
    m.add_function(wrap_pyfunction!(has_aider_block, &m)?)?;
    m.add_function(wrap_pyfunction!(find_match, &m)?)?;
    m.add_function(wrap_pyfunction!(build_diagnostics, &m)?)?;
    m.add_function(wrap_pyfunction!(replace_once, &m)?)?;
    m.add_function(wrap_pyfunction!(apply_aider_blocks, &m)?)?;
    m.add_class::<AiderBlock>()?;
    m.add_class::<MatchRegion>()?;
    m.add_class::<ReplaceOutcome>()?;
    parent.add_submodule(&m)?;
    Ok(())
}
