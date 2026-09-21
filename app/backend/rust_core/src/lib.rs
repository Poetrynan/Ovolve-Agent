//! Ovolve Core - Performance-critical modules for Ovolve Agent
//!
//! This crate provides Rust implementations of performance-sensitive backend modules,
//! exposed to Python via PyO3 bindings. All modules maintain 100% API compatibility
//! with their Python counterparts.
//!
//! The top level re-exports the core algorithm functions from the
//! `crates/ovolve_core` crate (levenshtein_distance, compute_similarity,
//! replace_file_content_fast, generate_spill_preview), so that this single
//! extension is a superset of the standalone `crates/ovolve_core`
//! python-bindings build. Downstream Python code (e.g. aider_parser.py)
//! probes for `replace_file_content_fast` at the top level.

use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};

pub mod native_desktop;
pub mod embedder;
pub mod memory_retrieval;
pub mod sandbox;
pub mod context_compactor;
pub mod edge;
pub mod utils;
pub mod storage_engine;
pub mod event_engine;
pub mod wiki_engine;
pub mod patch_engine;
pub mod command_guard;

// ── Top-level re-exports of the core algorithm crate ───────────────────────

fn candidate_to_py<'py>(
    py: Python<'py>,
    c: &ovolve_kernels::CandidateMatch,
) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new_bound(py);
    d.set_item("line_number", c.line_number)?;
    d.set_item("preview", &c.preview)?;
    d.set_item("similarity", c.similarity)?;
    Ok(d)
}

fn replace_result_to_py<'py>(
    py: Python<'py>,
    r: &ovolve_kernels::ReplaceResult,
) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new_bound(py);
    d.set_item("success", r.success)?;
    d.set_item("matched", r.matched)?;
    d.set_item("content", &r.content)?;
    d.set_item("replaced_count", r.replaced_count)?;
    d.set_item("error", r.error.clone())?;
    d.set_item("diagnostics", r.diagnostics.clone())?;
    match &r.candidates {
        Some(cands) => {
            let list = PyList::empty_bound(py);
            for c in cands {
                list.append(candidate_to_py(py, c)?)?;
            }
            d.set_item("candidates", list)?;
        }
        None => d.set_item("candidates", Option::<Vec<PyObject>>::None)?,
    }
    Ok(d)
}

fn spill_preview_to_py<'py>(
    py: Python<'py>,
    p: &ovolve_kernels::SpillPreview,
) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new_bound(py);
    d.set_item("is_spilled", p.is_spilled)?;
    d.set_item("total_lines", p.total_lines)?;
    d.set_item("total_chars", p.total_chars)?;
    d.set_item("preview_content", &p.preview_content)?;
    d.set_item("head_lines", p.head_lines)?;
    d.set_item("tail_lines", p.tail_lines)?;
    d.set_item("omitted_lines", p.omitted_lines)?;
    d.set_item("spill_file_path", p.spill_file_path.clone())?;
    Ok(d)
}

/// Levenshtein distance between two strings (character-based).
#[pyfunction]
fn levenshtein_distance(s1: &str, s2: &str) -> usize {
    ovolve_kernels::levenshtein_distance(s1, s2)
}

/// Normalized character similarity in [0.0, 1.0] (whitespace-insensitive).
#[pyfunction]
fn compute_similarity(s1: &str, s2: &str) -> f64 {
    ovolve_kernels::compute_similarity(s1, s2)
}

/// Precision replacement with fuzzy auto-diagnosis.
///
/// Returns a dict: success, matched, content, replaced_count, error,
/// diagnostics, candidates (list of {line_number, preview, similarity}).
#[pyfunction]
#[pyo3(signature = (original_text, target_content, replacement_content, allow_multiple=false))]
fn replace_file_content_fast<'py>(
    py: Python<'py>,
    original_text: &str,
    target_content: &str,
    replacement_content: &str,
    allow_multiple: bool,
) -> PyResult<Bound<'py, PyDict>> {
    let result = ovolve_kernels::replace_file_content_fast(
        original_text,
        target_content,
        replacement_content,
        allow_multiple,
    );
    replace_result_to_py(py, &result)
}

/// Head-Tail bounded preview for massive tool output.
#[pyfunction]
fn generate_spill_preview<'py>(
    py: Python<'py>,
    raw_output: &str,
    threshold_chars: usize,
    head_lines_count: usize,
    tail_lines_count: usize,
) -> PyResult<Bound<'py, PyDict>> {
    let p = ovolve_kernels::generate_spill_preview(
        raw_output,
        threshold_chars,
        head_lines_count,
        tail_lines_count,
    );
    spill_preview_to_py(py, &p)
}

/// Python module root - registers all submodules and the top-level
/// core algorithm re-exports.
#[pymodule]
fn ovolve_core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.setattr("__doc__", "Ovolve Core - Performance-critical Rust modules for Ovolve Agent")?;

    // Top-level core algorithms (re-exported from crates/ovolve_core)
    m.add_function(wrap_pyfunction!(levenshtein_distance, m)?)?;
    m.add_function(wrap_pyfunction!(compute_similarity, m)?)?;
    m.add_function(wrap_pyfunction!(replace_file_content_fast, m)?)?;
    m.add_function(wrap_pyfunction!(generate_spill_preview, m)?)?;

    // Register submodules
    native_desktop::register(m)?;
    embedder::register(m)?;
    memory_retrieval::register(m)?;
    sandbox::register(m)?;
    context_compactor::register(m)?;
    edge::register(m)?;
    utils::register(m)?;
    storage_engine::register(m)?;
    event_engine::register(m)?;
    wiki_engine::register(m)?;
    patch_engine::register(m)?;
    command_guard::register(m)?;

    // Version info
    m.setattr("__version__", env!("CARGO_PKG_VERSION"))?;

    Ok(())
}
