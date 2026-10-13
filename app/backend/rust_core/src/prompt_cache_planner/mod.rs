//! prompt_cache_planner — Rust port of `app/backend/prompt_cache_planner.py`
//! (wave-7, Native→Rust).
//!
//! Prompt cache breakpoint planner: maps knowledge of static vs dynamic content
//! to Anthropic-style `cache_control` breakpoints for prefix caching.
//!
//! Features:
//! - StablePrefixRegistry: thread-safe LRU registry for static prompt scaffolds.
//! - plan_cache_breakpoints: places breakpoints on system prefix, system tail,
//!   and turn history (2nd and 3rd non-system messages from end).
//! - Section integration: derives stable prefix from PromptSection sequences.
//!
//! RULEBOOK CITATIONS:
//! - §4 naming: app/backend/prompt_cache_planner.py -> rust_core/src/prompt_cache_planner/mod.rs
//! - §2 live CPython objects, preserving exact dict key order, tuple return types,
//!   and error identity.

use std::sync::{Arc, Mutex, OnceLock};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyFrozenSet, PyList, PyMapping, PyString, PyTuple};

pub const REGISTRY_MAX_ENTRIES: usize = 32;
pub const REGISTRY_MAX_TOTAL_CHARS: usize = 512 * 1024;

// ── CachePlan pyclass ─────────────────────────────────────────────────────────

#[pyclass(name = "CachePlan", frozen, module = "ovolve_core.prompt_cache_planner")]
pub struct CachePlan {
    #[pyo3(get)]
    pub messages: PyObject,
    #[pyo3(get)]
    pub breakpoints: Py<PyTuple>,
}

#[pymethods]
impl CachePlan {
    #[new]
    fn new(messages: PyObject, breakpoints: Py<PyTuple>) -> Self {
        Self {
            messages,
            breakpoints,
        }
    }

    fn __repr__(&self, py: Python<'_>) -> PyResult<String> {
        let msgs_repr = self.messages.bind(py).repr()?;
        let bp_repr = self.breakpoints.bind(py).repr()?;
        Ok(format!(
            "CachePlan(messages={}, breakpoints={})",
            msgs_repr, bp_repr
        ))
    }

    fn __eq__(&self, py: Python<'_>, other: &Bound<'_, PyAny>) -> PyResult<bool> {
        if let Ok(other_plan) = other.extract::<PyRef<CachePlan>>() {
            let msgs_eq = self
                .messages
                .bind(py)
                .rich_compare(other_plan.messages.bind(py), pyo3::pyclass::CompareOp::Eq)?;
            let bp_eq = self
                .breakpoints
                .bind(py)
                .rich_compare(other_plan.breakpoints.bind(py), pyo3::pyclass::CompareOp::Eq)?;
            return Ok(msgs_eq.is_truthy()? && bp_eq.is_truthy()?);
        }
        if let (Ok(other_msgs), Ok(other_bp)) =
            (other.getattr("messages"), other.getattr("breakpoints"))
        {
            let msgs_eq = self
                .messages
                .bind(py)
                .rich_compare(&other_msgs, pyo3::pyclass::CompareOp::Eq)?;
            let bp_eq = self
                .breakpoints
                .bind(py)
                .rich_compare(&other_bp, pyo3::pyclass::CompareOp::Eq)?;
            return Ok(msgs_eq.is_truthy()? && bp_eq.is_truthy()?);
        }
        Ok(false)
    }
}

// ── StablePrefixRegistry ──────────────────────────────────────────────────────

struct RegistryData {
    max_entries: usize,
    max_total_chars: usize,
    entries: Vec<(String, String)>, // insertion-ordered, oldest at index 0
    total_chars: usize,
}

impl RegistryData {
    fn new(max_entries: usize, max_total_chars: usize) -> Self {
        Self {
            max_entries,
            max_total_chars,
            entries: Vec::new(),
            total_chars: 0,
        }
    }

    fn register(&mut self, key: String, prefix: String) {
        if key.is_empty() || prefix.is_empty() {
            return;
        }
        if let Some(pos) = self.entries.iter().position(|(k, _)| k == &key) {
            let (_, old_val) = self.entries.remove(pos);
            self.total_chars = self.total_chars.saturating_sub(old_val.chars().count());
        }
        self.total_chars += prefix.chars().count();
        self.entries.push((key, prefix));
        self.evict_locked();
    }

    fn get(&mut self, key: &str) -> String {
        if let Some(pos) = self.entries.iter().position(|(k, _)| k == key) {
            let item = self.entries.remove(pos);
            let val = item.1.clone();
            self.entries.push(item);
            val
        } else {
            String::new()
        }
    }

    fn longest_match(&self, text: &str) -> (String, String) {
        let mut best_key = String::new();
        let mut best_prefix = String::new();
        for (key, prefix) in &self.entries {
            if !prefix.is_empty()
                && text.starts_with(prefix)
                && prefix.chars().count() > best_prefix.chars().count()
            {
                best_key = key.clone();
                best_prefix = prefix.clone();
            }
        }
        (best_key, best_prefix)
    }

    fn size(&self) -> usize {
        self.entries.len()
    }

    fn evict_locked(&mut self) {
        while (self.entries.len() > self.max_entries || self.total_chars > self.max_total_chars)
            && self.entries.len() > 1
        {
            let (_, oldest_val) = self.entries.remove(0);
            self.total_chars = self.total_chars.saturating_sub(oldest_val.chars().count());
        }
    }
}

#[pyclass(name = "StablePrefixRegistry", module = "ovolve_core.prompt_cache_planner")]
pub struct StablePrefixRegistry {
    data: Arc<Mutex<RegistryData>>,
}

#[pymethods]
impl StablePrefixRegistry {
    #[new]
    #[pyo3(signature = (max_entries = REGISTRY_MAX_ENTRIES, max_total_chars = REGISTRY_MAX_TOTAL_CHARS))]
    fn new(max_entries: usize, max_total_chars: usize) -> Self {
        Self {
            data: Arc::new(Mutex::new(RegistryData::new(max_entries, max_total_chars))),
        }
    }

    #[pyo3(signature = (key, prefix = None))]
    fn register(&self, key: String, prefix: Option<String>) {
        let p = prefix.unwrap_or_default();
        let mut d = self.data.lock().unwrap();
        d.register(key, p);
    }

    fn get(&self, key: &str) -> String {
        let mut d = self.data.lock().unwrap();
        d.get(key)
    }

    fn longest_match(&self, text: &str) -> (String, String) {
        let d = self.data.lock().unwrap();
        d.longest_match(text)
    }

    fn size(&self) -> usize {
        let d = self.data.lock().unwrap();
        d.size()
    }
}

static GLOBAL_REGISTRY: OnceLock<Py<StablePrefixRegistry>> = OnceLock::new();

#[pyfunction]
pub fn get_stable_prefix_registry(py: Python<'_>) -> PyResult<Py<StablePrefixRegistry>> {
    if let Some(reg) = GLOBAL_REGISTRY.get() {
        return Ok(reg.clone_ref(py));
    }
    let reg = Py::new(py, StablePrefixRegistry::new(REGISTRY_MAX_ENTRIES, REGISTRY_MAX_TOTAL_CHARS))?;
    let _ = GLOBAL_REGISTRY.set(reg.clone_ref(py));
    Ok(GLOBAL_REGISTRY.get().unwrap().clone_ref(py))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

#[pyfunction]
#[pyo3(signature = (ttl = ""))]
pub fn _cache_marker<'py>(py: Python<'py>, ttl: &str) -> PyResult<Bound<'py, PyDict>> {
    let outer = PyDict::new_bound(py);
    let inner = PyDict::new_bound(py);
    inner.set_item("type", "ephemeral")?;
    if !ttl.is_empty() {
        inner.set_item("ttl", ttl)?;
    }
    outer.set_item("cache_control", inner)?;
    Ok(outer)
}

#[pyfunction]
pub fn _split_system_prefix<'py>(
    _py: Python<'py>,
    msgs: &Bound<'py, PyAny>,
    prefix: &str,
) -> PyResult<(Option<Bound<'py, PyAny>>, Option<String>)> {
    let len = msgs.len()?;
    if len == 0 {
        return Ok((None, None));
    }
    let first = msgs.get_item(0)?;
    let role = first.call_method1("get", ("role",))?;
    if role.extract::<String>().unwrap_or_default() != "system" {
        return Ok((None, None));
    }
    let content_obj = first.call_method1("get", ("content",))?;
    let content = match content_obj.extract::<String>() {
        Ok(s) => s,
        Err(_) => return Ok((None, None)),
    };
    if prefix.is_empty() || !content.starts_with(prefix) || prefix.len() >= content.len() {
        return Ok((None, None));
    }
    let rest = content[prefix.len()..].to_string();
    Ok((Some(first), Some(rest)))
}

#[pyfunction]
#[pyo3(signature = (msg, block_index, ttl = ""))]
pub fn _apply_block_marker<'py>(
    py: Python<'py>,
    msg: &Bound<'py, PyDict>,
    block_index: isize,
    ttl: &str,
) -> PyResult<Bound<'py, PyDict>> {
    let content_obj = msg.call_method1("get", ("content",))?;
    let blocks = PyList::empty_bound(py);

    if let Ok(s) = content_obj.extract::<String>() {
        let b = PyDict::new_bound(py);
        b.set_item("type", "text")?;
        b.set_item("text", s)?;
        blocks.append(b)?;
    } else if let Ok(list) = content_obj.downcast::<PyList>() {
        for item in list.iter() {
            let d = PyDict::new_bound(py);
            if let Ok(mapping) = item.downcast::<PyMapping>() {
                d.update(mapping)?;
            } else if let Ok(dict) = item.downcast::<PyDict>() {
                d.update(dict.as_mapping())?;
            }
            blocks.append(d)?;
        }
    } else {
        return Ok(msg.clone());
    }

    let len = blocks.len() as isize;
    if block_index >= len || block_index < -len {
        return Ok(msg.clone());
    }

    let actual_idx = if block_index < 0 {
        (len + block_index) as usize
    } else {
        block_index as usize
    };

    let target_block = blocks.get_item(actual_idx)?;
    if let Ok(dict) = target_block.downcast::<PyDict>() {
        dict.update(_cache_marker(py, ttl)?.as_mapping())?;
    }

    let new_msg = PyDict::new_bound(py);
    new_msg.update(msg.as_mapping())?;
    new_msg.set_item("content", blocks)?;
    Ok(new_msg)
}

// ── Planning functions ───────────────────────────────────────────────────────

#[pyfunction]
#[pyo3(signature = (msgs, *, system_prefix = "", kind = "", system_tail = false, scope = "", ttl = ""))]
pub fn plan_cache_breakpoints<'py>(
    py: Python<'py>,
    msgs: &Bound<'py, PyAny>,
    system_prefix: &str,
    kind: &str,
    system_tail: bool,
    scope: &str,
    ttl: &str,
) -> PyResult<CachePlan> {
    let _ = scope;
    let kind_lower = kind.to_lowercase();
    let is_valid_kind = kind_lower == "anthropic" || kind_lower == "oauth";
    let is_valid_ttl = ttl.is_empty() || ttl == "1h";

    if !is_valid_kind || !is_valid_ttl {
        let empty_bp = PyTuple::empty_bound(py).unbind();
        return Ok(CachePlan::new(msgs.clone().unbind(), empty_bp));
    }

    let marker = _cache_marker(py, ttl)?;
    let out = PyList::empty_bound(py);
    for item in msgs.iter()? {
        out.append(item?)?;
    }
    let mut placed: Vec<String> = Vec::new();

    // 1. system prefix
    if !system_prefix.is_empty() {
        let (_, rest_opt) = _split_system_prefix(py, &out, system_prefix)?;
        if let Some(rest) = rest_opt {
            let b0 = PyDict::new_bound(py);
            b0.set_item("type", "text")?;
            b0.set_item("text", system_prefix)?;
            b0.update(marker.as_mapping())?;

            let b1 = PyDict::new_bound(py);
            b1.set_item("type", "text")?;
            b1.set_item("text", rest)?;

            let content_list = PyList::new_bound(py, &[b0, b1]);
            let new_first = PyDict::new_bound(py);
            new_first.set_item("role", "system")?;
            new_first.set_item("content", content_list)?;
            out.set_item(0, new_first)?;
            placed.push("system_prefix".to_string());
        }
    }

    // 2. system tail
    if system_tail && out.len() > 0 {
        let first = out.get_item(0)?;
        let role = first.call_method1("get", ("role",))?;
        if role.extract::<String>().unwrap_or_default() == "system" {
            let content_obj = first.call_method1("get", ("content",))?;
            if let Ok(s) = content_obj.extract::<String>() {
                let blocks = PyList::empty_bound(py);
                let b = PyDict::new_bound(py);
                b.set_item("type", "text")?;
                b.set_item("text", s)?;
                b.update(marker.as_mapping())?;
                blocks.append(b)?;

                let new_first = PyDict::new_bound(py);
                if let Ok(first_dict) = first.downcast::<PyDict>() {
                    new_first.update(first_dict.as_mapping())?;
                }
                new_first.set_item("content", blocks)?;
                out.set_item(0, new_first)?;
                placed.push("system_tail".to_string());
            } else if let Ok(list) = content_obj.downcast::<PyList>() {
                if list.len() > 0 {
                    let blocks = PyList::empty_bound(py);
                    for item in list.iter() {
                        let d = PyDict::new_bound(py);
                        if let Ok(m) = item.downcast::<PyMapping>() {
                            d.update(m)?;
                        } else if let Ok(dict) = item.downcast::<PyDict>() {
                            d.update(dict.as_mapping())?;
                        }
                        blocks.append(d)?;
                    }
                    let last_idx = blocks.len() - 1;
                    let last_block = blocks.get_item(last_idx)?;
                    if let Ok(d) = last_block.downcast::<PyDict>() {
                        d.update(marker.as_mapping())?;
                    }
                    let new_first = PyDict::new_bound(py);
                    if let Ok(first_dict) = first.downcast::<PyDict>() {
                        new_first.update(first_dict.as_mapping())?;
                    }
                    new_first.set_item("content", blocks)?;
                    out.set_item(0, new_first)?;
                    placed.push("system_tail".to_string());
                }
            }
        }
    }

    // 3. non-system tail: 2nd and 3rd from end
    let mut non_system_indices: Vec<usize> = Vec::new();
    for i in 0..out.len() {
        let m = out.get_item(i)?;
        let role = m.call_method1("get", ("role",))?;
        if role.extract::<String>().unwrap_or_default() != "system" {
            non_system_indices.push(i);
        }
    }

    if non_system_indices.len() >= 3 {
        let n = non_system_indices.len();
        let idx1 = non_system_indices[n - 3];
        let idx2 = non_system_indices[n - 2];

        for &idx in &[idx1, idx2] {
            let item = out.get_item(idx)?;
            if let Ok(dict_item) = item.downcast::<PyDict>() {
                let marked = _apply_block_marker(py, dict_item, -1, ttl)?;
                out.set_item(idx, marked)?;
                placed.push(format!("tail:{}", idx));
            }
        }
    }

    let bp_tuple = PyTuple::new_bound(py, placed.iter().map(|s| s.as_str())).unbind();
    Ok(CachePlan::new(out.unbind().into(), bp_tuple))
}

#[pyfunction]
#[pyo3(signature = (session_id, lineage_root = None))]
pub fn resolve_cache_scope(session_id: &str, lineage_root: Option<&str>) -> String {
    if let Some(r) = lineage_root {
        if !r.is_empty() {
            return r.to_string();
        }
    }
    session_id.to_string()
}

#[pyfunction]
#[pyo3(signature = (msgs, explicit_prefix = ""))]
pub fn resolve_effective_system_prefix(
    py: Python<'_>,
    msgs: &Bound<'_, PyAny>,
    explicit_prefix: &str,
) -> PyResult<String> {
    let prefix = explicit_prefix;
    if !prefix.is_empty() && msgs.len()? > 0 {
        let first = msgs.get_item(0)?;
        let role = first.call_method1("get", ("role",))?;
        if role.extract::<String>().unwrap_or_default() == "system" {
            let content_obj = first.call_method1("get", ("content",))?;
            if let Ok(s) = content_obj.extract::<String>() {
                if s.starts_with(prefix) {
                    return Ok(prefix.to_string());
                }
            }
        }
    }

    if msgs.len()? > 0 {
        let first = msgs.get_item(0)?;
        let role = first.call_method1("get", ("role",))?;
        if role.extract::<String>().unwrap_or_default() == "system" {
            let content_obj = first.call_method1("get", ("content",))?;
            if let Ok(s) = content_obj.extract::<String>() {
                let reg = get_stable_prefix_registry(py)?;
                let (_, matched) = reg.bind(py).borrow().longest_match(&s);
                if !matched.is_empty() {
                    return Ok(matched);
                }
            }
        }
    }

    Ok(prefix.to_string())
}

#[pyfunction]
#[pyo3(signature = (sections = None))]
pub fn stable_prefix_from_sections(sections: Option<&Bound<'_, PyAny>>) -> PyResult<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(sec_iter) = sections {
        if let Ok(it) = sec_iter.iter() {
            for item_res in it {
                let item = item_res?;
                let placement = item
                    .getattr("placement")
                    .map(|v| v.to_string())
                    .unwrap_or_else(|_| "system".to_string());
                if placement != "system" {
                    continue;
                }
                let cache_class = item
                    .getattr("cache_class")
                    .map(|v| v.to_string())
                    .unwrap_or_default();
                if cache_class != "stable" {
                    break;
                }
                let content = item
                    .getattr("content")
                    .map(|v| v.extract::<String>().unwrap_or_default())
                    .unwrap_or_default();
                let trimmed = content.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_string());
                }
            }
        }
    }
    Ok(parts.join("\n\n"))
}

#[pyfunction]
#[pyo3(signature = (msgs, sections, *, kind, ttl = "", scope = "", system_tail = false))]
pub fn plan_section_cache_breakpoints<'py>(
    py: Python<'py>,
    msgs: &Bound<'py, PyAny>,
    sections: Option<&Bound<'py, PyAny>>,
    kind: &str,
    ttl: &str,
    scope: &str,
    system_tail: bool,
) -> PyResult<CachePlan> {
    let prefix = stable_prefix_from_sections(sections)?;
    plan_cache_breakpoints(
        py,
        msgs,
        &prefix,
        kind,
        system_tail,
        scope,
        ttl,
    )
}

// ── Module registration ──────────────────────────────────────────────────────

pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(py, "prompt_cache_planner")?;

    m.setattr("__doc__", "Prompt cache breakpoint planner (Rust port)")?;

    // Constants
    let kinds_raw = ["anthropic", "oauth"];
    let kinds = PyFrozenSet::new_bound(py, &kinds_raw)?;
    m.setattr("CACHE_BREAKPOINT_KINDS", kinds)?;

    let ttls_raw = ["", "1h"];
    let ttls = PyFrozenSet::new_bound(py, &ttls_raw)?;
    m.setattr("CACHE_TTLS", ttls)?;

    m.setattr("REGISTRY_MAX_ENTRIES", REGISTRY_MAX_ENTRIES)?;
    m.setattr("REGISTRY_MAX_TOTAL_CHARS", REGISTRY_MAX_TOTAL_CHARS)?;

    // Classes
    m.add_class::<CachePlan>()?;
    m.add_class::<StablePrefixRegistry>()?;

    // Functions
    m.add_function(wrap_pyfunction!(get_stable_prefix_registry, &m)?)?;
    m.add_function(wrap_pyfunction!(_cache_marker, &m)?)?;
    m.add_function(wrap_pyfunction!(_split_system_prefix, &m)?)?;
    m.add_function(wrap_pyfunction!(_apply_block_marker, &m)?)?;
    m.add_function(wrap_pyfunction!(plan_cache_breakpoints, &m)?)?;
    m.add_function(wrap_pyfunction!(resolve_cache_scope, &m)?)?;
    m.add_function(wrap_pyfunction!(resolve_effective_system_prefix, &m)?)?;
    m.add_function(wrap_pyfunction!(stable_prefix_from_sections, &m)?)?;
    m.add_function(wrap_pyfunction!(plan_section_cache_breakpoints, &m)?)?;

    parent.add_submodule(&m)?;
    Ok(())
}
