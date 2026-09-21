//! command_guard.rs - Shell command security grading primitives.
//!
//! Rust implementation of the mechanical parsing primitives consumed by
//! command_classifier.py: segment splitting, tokenization, remote
//! fetch-and-execute shape detection, host extraction, and domain
//! suffix matching. Pure functions; no I/O, no state.

use once_cell::sync::Lazy;
use pyo3::prelude::*;
use regex::Regex;

/// Shell metacharacters stripped from token edges during tokenization.
const TOKEN_META: &[char] = &['"', '\'', '`', '$', '(', ')', '{', '}', '<', '>', '|', '&', ';', '\\'];

/// IPv4 literal pattern (mechanical: no octet range validation — a suspicious
/// address that fails validation would otherwise silently skip egress audit).
static RE_IPV4: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b").unwrap());

/// Domain pattern: dot-joined labels ending in an alphabetic TLD.
/// Matches inside URLs, user@host args, and bare hostnames alike.
static RE_DOMAIN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b").unwrap()
});

/// Split command text into segments by shell control operators.
///
/// Separators: `|`, `&`, `;`, newlines (covers `||`, `&&` as repeated chars).
/// Whitespace-only segments are dropped: `a && b` is 2 segments, not 3.
/// Redirections (`<`, `>`, `>>`) are NOT separators — they belong to a command.
#[pyfunction]
fn split_segments(text: &str) -> Vec<String> {
    text.split(['|', '&', ';', '\n', '\r'])
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Tokenize one command segment: whitespace split + shell meta stripping.
///
/// `sh -c "$(curl x)"` → ["sh", "-c", "curl", "x"] — so fetcher/executor
/// tokens hidden inside command/process substitution are still visible.
/// Does NOT lowercase (callers own case policy). Dots are preserved
/// (command_classifier matches "mkfs.ext4" via its own label logic).
#[pyfunction]
fn tokenize(segment: &str) -> Vec<String> {
    segment
        .split_whitespace()
        .map(|t| t.trim_matches(|c| TOKEN_META.contains(&c)))
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
        .collect()
}

/// Detect the "remote fetch then direct execute" shape inside ONE segment.
///
/// True when the segment contains both a fetcher token and an executor
/// token (case-insensitive). Pipelines (`curl x | sh`) are split into
/// separate segments by split_segments and caught by the caller's
/// cross-segment ordering logic; what remains in a single segment is
/// command substitution (`sh $(curl x)`), process substitution
/// (`bash <(curl x)`), and their variants — exactly this shape.
#[pyfunction]
fn fetch_pipe_exec(segment: &str, fetchers: Vec<String>, executors: Vec<String>) -> bool {
    let tokens: Vec<String> = tokenize(segment).iter().map(|t| t.to_lowercase()).collect();
    let has_fetcher = tokens.iter().any(|t| fetchers.iter().any(|f| f.eq_ignore_ascii_case(t)));
    let has_executor = tokens.iter().any(|t| executors.iter().any(|e| e.eq_ignore_ascii_case(t)));
    has_fetcher && has_executor
}

/// Extract hosts (IPv4 literals + domain names) from command text.
///
/// Order of first appearance, deduplicated, lowercased. Conservative by
/// design: version-like tokens (`foo.tar.gz`) may surface as hosts —
/// an egress false positive raises REVIEW, a missed host never does.
#[pyfunction]
fn extract_hosts(text: &str) -> Vec<String> {
    let mut found: Vec<(usize, String)> = Vec::new();
    for m in RE_IPV4.find_iter(text) {
        found.push((m.start(), m.as_str().to_lowercase()));
    }
    for m in RE_DOMAIN.find_iter(text) {
        found.push((m.start(), m.as_str().to_lowercase()));
    }
    found.sort_by_key(|(pos, _)| *pos);

    let mut hosts: Vec<String> = Vec::new();
    for (_, h) in found {
        if !hosts.contains(&h) {
            hosts.push(h);
        }
    }
    hosts
}

/// Match a host against domain-suffix rules (allow/deny lists).
///
/// Returns the matched rule (truthy) or None. Full-label suffix semantics:
/// `evil.com` matches rule `evil.com`; `sub.evil.com` matches rule
/// `evil.com`; `notevil.com` does NOT match rule `evil.com`.
#[pyfunction]
fn domain_suffix_match(host: &str, domains: Vec<String>) -> Option<String> {
    let h = host.trim().trim_matches('.').to_lowercase();
    for d in &domains {
        let d = d.trim().trim_matches('.').to_lowercase();
        if d.is_empty() {
            continue;
        }
        if h == d || h.ends_with(&format!(".{}", d)) {
            return Some(d);
        }
    }
    None
}

/// Register the command_guard submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "command_guard")?;
    m.add_function(wrap_pyfunction!(split_segments, &m)?)?;
    m.add_function(wrap_pyfunction!(tokenize, &m)?)?;
    m.add_function(wrap_pyfunction!(fetch_pipe_exec, &m)?)?;
    m.add_function(wrap_pyfunction!(extract_hosts, &m)?)?;
    m.add_function(wrap_pyfunction!(domain_suffix_match, &m)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}
