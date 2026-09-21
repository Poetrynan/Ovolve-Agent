//! patch_engine — Hunk-level unified diff apply (Rust acceleration path).

use pyo3::prelude::*;
use pyo3::types::PyDict;
use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, Clone)]
struct Hunk {
    old_start: usize,
    lines: Vec<String>,
}

fn hunk_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@").unwrap())
}

fn strip_nl(s: &str) -> String {
    s.trim_end_matches(['\r', '\n']).to_string()
}

fn norm(s: &str) -> String {
    strip_nl(s).replace('\t', "    ")
}

fn parse_hunks(patch: &str) -> Vec<Hunk> {
    let mut hunks = Vec::new();
    let mut current: Option<Hunk> = None;
    for raw in patch.lines() {
        if raw.starts_with("diff ")
            || raw.starts_with("--- ")
            || raw.starts_with("+++ ")
            || raw.starts_with("index ")
        {
            continue;
        }
        if let Some(caps) = hunk_re().captures(raw) {
            if let Some(h) = current.take() {
                hunks.push(h);
            }
            let old_start: usize = caps[1].parse().unwrap_or(1);
            current = Some(Hunk {
                old_start,
                lines: Vec::new(),
            });
            continue;
        }
        if let Some(ref mut h) = current {
            if !raw.is_empty() {
                let b = raw.as_bytes();
                if b[0] == b' ' || b[0] == b'+' || b[0] == b'-' {
                    h.lines.push(raw.to_string());
                }
            }
        }
    }
    if let Some(h) = current {
        hunks.push(h);
    }
    hunks
}

fn find_hunk_pos(lines: &[String], hunk: &Hunk) -> Option<usize> {
    // Pre-image of a hunk = its context (" ") AND deletion ("-") lines in
    // order. Matching only context lines contiguously fails whenever a
    // deletion sits between two context lines — the common case.
    let ctx: Vec<String> = hunk
        .lines
        .iter()
        .filter(|l| l.starts_with(' ') || l.starts_with('-'))
        .map(|l| strip_nl(&l[1..]))
        .collect();
    if ctx.is_empty() {
        return Some(hunk.old_start.saturating_sub(1));
    }
    let hint = hunk.old_start.saturating_sub(1);
    let mut candidates: Vec<usize> = (hint.saturating_sub(8)..(hint + 8).min(lines.len()))
        .collect();
    for i in 0..lines.len() {
        if !candidates.contains(&i) {
            candidates.push(i);
        }
    }
    for pos in candidates {
        if pos + ctx.len() > lines.len() {
            continue;
        }
        let window: Vec<String> = (0..ctx.len()).map(|i| strip_nl(&lines[pos + i])).collect();
        if window == ctx {
            return Some(pos);
        }
        let wn: Vec<String> = window.iter().map(|x| norm(x)).collect();
        let cn: Vec<String> = ctx.iter().map(|x| norm(x)).collect();
        if wn == cn {
            return Some(pos);
        }
    }
    None
}

fn newline_for(lines: &[String], idx: usize, out: &[String]) -> String {
    if idx < lines.len() {
        if lines[idx].ends_with('\n') {
            return "\n".to_string();
        }
        return String::new();
    }
    if let Some(last) = out.last() {
        if last.ends_with('\n') {
            return "\n".to_string();
        }
        return String::new();
    }
    if lines.iter().any(|l| l.ends_with('\n')) {
        return "\n".to_string();
    }
    // Python's initial nl = "\n" survives when all guards fall through
    // (idx past EOF, empty out, empty lines).
    "\n".to_string()
}

fn apply_hunk(lines: Vec<String>, hunk: &Hunk) -> Result<Vec<String>, String> {
    let pos = find_hunk_pos(&lines, hunk).ok_or_else(|| {
        format!("context not found near line {}", hunk.old_start)
    })?;
    let mut out: Vec<String> = Vec::new();
    let mut idx = pos;
    for ln in &hunk.lines {
        if ln.is_empty() {
            continue;
        }
        let kind = ln.as_bytes()[0] as char;
        let body = &ln[1..];
        match kind {
            ' ' => {
                if idx >= lines.len() {
                    return Err(format!("context extends past EOF at line {}", idx + 1));
                }
                if norm(&lines[idx]) != norm(body) {
                    return Err(format!("context mismatch at line {}", idx + 1));
                }
                out.push(lines[idx].clone());
                idx += 1;
            }
            '-' => {
                if idx >= lines.len() {
                    return Err(format!("delete past EOF at line {}", idx + 1));
                }
                if norm(&lines[idx]) != norm(body) && strip_nl(&lines[idx]) != strip_nl(body) {
                    return Err(format!("delete mismatch at line {}", idx + 1));
                }
                idx += 1;
            }
            '+' => {
                let nl = newline_for(&lines, idx, &out);
                out.push(format!("{}{}", body, nl));
            }
            _ => {}
        }
    }
    let mut result = Vec::new();
    result.extend_from_slice(&lines[..pos]);
    result.extend(out);
    result.extend_from_slice(&lines[idx..]);
    Ok(result)
}

fn apply_unified_patch_inner(content: &str, patch: &str) -> (bool, String, String, i32) {
    if patch.trim().is_empty() {
        return (false, String::new(), "empty patch".to_string(), 0);
    }
    let hunks = parse_hunks(patch);
    if hunks.is_empty() {
        return (false, String::new(), "no hunks found in patch".to_string(), 0);
    }
    let had_trailing_nl = content.ends_with('\n');
    let mut lines: Vec<String> = content
        .split_inclusive('\n')
        .map(|s| s.to_string())
        .collect();
    if !content.is_empty() && !had_trailing_nl {
        if let Some(last) = lines.last_mut() {
            *last = last.trim_end_matches('\n').to_string();
        }
    }
    let mut applied = 0;
    for hunk in hunks {
        match apply_hunk(lines, &hunk) {
            Ok(next) => {
                lines = next;
                applied += 1;
            }
            Err(e) => return (false, String::new(), e, applied),
        }
    }
    let mut out: String = lines.concat();
    if had_trailing_nl && !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    (true, out, String::new(), applied)
}

#[pyfunction]
pub fn apply_unified_patch(py: Python<'_>, content: &str, patch: &str) -> PyResult<PyObject> {
    let (ok, result_content, error, hunks) = apply_unified_patch_inner(content, patch);
    let dict = PyDict::new_bound(py);
    dict.set_item("ok", ok)?;
    dict.set_item("content", result_content)?;
    dict.set_item("error", error)?;
    dict.set_item("hunks_applied", hunks)?;
    Ok(dict.into())
}

pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "patch_engine")?;
    m.add_function(wrap_pyfunction!(apply_unified_patch, &m)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}
