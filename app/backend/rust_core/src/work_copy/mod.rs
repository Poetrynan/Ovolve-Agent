//! work_copy — per-subagent write isolation (UA3).
//!
//! Rust port of `work_copy.py` (rulebook: the Python module is the spec).
//!
//! Scope of this port:
//!
//! * Fully implemented (std::fs + pyo3 only, no new deps):
//!   - path mapping (`rel` / `overlay_path`) with the same escape rules
//!   - `prepare` (seeded overlay writes), `tombstone`, `save`, `changes`,
//!     `report`
//!   - module functions: `create`, `open_at`, `for_ctx`, `redirect_write`,
//!     `record_delete`, `discard`, `find_conflicts`
//!   - `describe_merge` / `describe_merge_status` (pure string/dict logic)
//!
//! * TODO(port) — merge execution (`work_copy.merge`) stays in Python:
//!   it composes `path_lock.write_lock` (a Python threading primitive) with
//!   the overlay walk; rulebook §1 keeps orchestration on the Python side.
//!   The pure helpers it needs (`find_conflicts`, `changes`) are here.
//!
//! The Python `WorkCopy` is a mutable dataclass holding a `deleted` set and a
//! live-registry dict keyed by normalized overlay root. The pyclass here keeps
//! the same public surface; the registry is a module-level `Mutex<HashMap>`
//! (rulebook §2: module-level mutable state → OnceLock/LazyLock + Mutex).

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyAny, PyDict, PyList, PySet, PyString};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

// ---------------------------------------------------------------------------
// Constants (mirror Python module-level constants exactly)
// ---------------------------------------------------------------------------

/// Kill switch. Off means every sub-agent writes straight to the workspace.
const WORK_COPY_ENABLED: bool = true;

/// The ctx key a redirected tool looks for (the source's obfuscated key).
const CTX_KEY: &str = "***";

/// Manifest filename inside an overlay; also the "this is an overlay" marker.
const MANIFEST: &str = ".ovolve-workcopy.json";

/// Don't seed absurdly large files into an overlay.
const MAX_SEED_BYTES: u64 = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Path helpers (mirror _norm / _overlay_root)
// ---------------------------------------------------------------------------

/// os.path.normcase(normpath(abspath(p))) — Windows: lowercase + backslashes.
fn norm_path(p: &str) -> String {
    let abs = fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
    let s = abs.to_string_lossy().to_string();
    // Python normcase on Windows lowercases and maps / to \.
    s.replace('/', "\\").to_lowercase()
}

/// A canonicalized normcase for registry keys only (does not touch disk).
fn norm_key(p: &str) -> String {
    p.replace('/', "\\").to_lowercase()
}

fn overlay_root(py: Python<'_>) -> PyResult<PathBuf> {
    let temp = py.import_bound("tempfile")?.getattr("gettempdir")?.call0()?;
    let base: String = temp.extract()?;
    let root = Path::new(&base).join("ovolve-workcopies");
    fs::create_dir_all(&root).map_err(|e| PyValueError::new_err(e.to_string()))?;
    Ok(root)
}

// ---------------------------------------------------------------------------
// WorkCopy pyclass
// ---------------------------------------------------------------------------

/**
 * One sub-agent's private overlay over the real workspace.
 */
#[pyclass]
pub struct WorkCopy {
    #[pyo3(get)]
    pub id: String,
    #[pyo3(get)]
    pub root: String,
    #[pyo3(get)]
    pub source_root: String,
    #[pyo3(get, set)]
    pub label: String,
    #[pyo3(get, set)]
    pub kind: String,
    deleted: BTreeSet<String>,
}

impl WorkCopy {
    fn rel_impl(&self, real_path: &str) -> Option<String> {
        let base = Path::new(&self.source_root);
        let target = Path::new(real_path);
        let r = pathdiff_rel(target, base)?;
        if r == "." || r.starts_with("../") || r == ".." {
            return None;
        }
        Some(r.replace('\\', "/"))
    }

    fn overlay_path_impl(&self, real_path: &str) -> Option<PathBuf> {
        let r = self.rel_impl(real_path)?;
        let mut p = PathBuf::from(&self.root);
        for seg in r.split('/') {
            p = p.join(seg);
        }
        Some(p)
    }

    fn save_impl(&self) {
        let manifest = json_manifest(&self.id, &self.label, &self.source_root, &self.deleted);
        let _ = fs::write(Path::new(&self.root).join(MANIFEST), manifest);
        // fail-open: 可选增强，失败不影响主流程
    }
}

/// os.path.relpath without depending on pathdiff: lexical, then normalized.
fn pathdiff_rel(target: &Path, base: &Path) -> Option<String> {
    let t = target.to_string_lossy().to_string();
    let b = base.to_string_lossy().to_string();
    let tn = t.replace('/', "\\").to_lowercase();
    let bn = b.replace('/', "\\").to_lowercase();
    if tn == bn {
        return Some(".".to_string());
    }
    let tb: Vec<&str> = tn.split('\\').filter(|s| !s.is_empty()).collect();
    let bb: Vec<&str> = bn.split('\\').filter(|s| !s.is_empty()).collect();
    if tb.len() < bb.len() {
        return None;
    }
    for (i, seg) in bb.iter().enumerate() {
        if tb[i] != *seg {
            return None;
        }
    }
    let rest: Vec<&str> = tb[bb.len()..].to_vec();
    if rest.is_empty() {
        return Some(".".to_string());
    }
    Some(rest.join("/"))
}

fn json_manifest(id: &str, label: &str, source_root: &str, deleted: &BTreeSet<String>) -> String {
    // json.dumps(..., ensure_ascii=False): non-ASCII passes through.
    let items: Vec<String> = deleted
        .iter()
        .map(|d| format!("\"{}\"", d.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect();
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        "{{\"id\": \"{}\", \"label\": \"{}\", \"sourceRoot\": \"{}\", \"deleted\": [{}]}}",
        esc(id),
        esc(label),
        esc(source_root),
        items.join(", ")
    )
}

#[pymethods]
impl WorkCopy {
    /// cleanup() → discard(self); the registry removal happens in the module
    /// function discard() — here we only drop the directory.
    fn cleanup(&self, py: Python<'_>) -> PyResult<()> {
        let _ = fs::remove_dir_all(&self.root);
        let registry = live_registry();
        if let Ok(mut map) = registry.lock() {
            map.remove(&norm_key(&self.root));
        }
        let _ = py;
        Ok(())
    }

    /// Workspace-relative form of a real path, or None if it's outside.
    fn rel(&self, real_path: &str) -> Option<String> {
        self.rel_impl(real_path)
    }

    fn overlay_path(&self, real_path: &str) -> Option<String> {
        self.overlay_path_impl(real_path)
            .map(|p| p.to_string_lossy().to_string())
    }

    /// Overlay path for a write, seeded from the real file when needed.
    #[pyo3(signature = (real_path, seed=true))]
    fn prepare(&mut self, real_path: &str, seed: bool) -> Option<String> {
        let dest = self.overlay_path_impl(real_path)?;
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if seed && !dest.exists() && Path::new(real_path).is_file() {
            // A failed seed degrades to "write from scratch", not a crash.
            if let Ok(meta) = fs::metadata(real_path) {
                if meta.len() <= MAX_SEED_BYTES {
                    let _ = fs::copy(real_path, &dest);
                }
            }
        }
        // A path tombstoned and now written again is alive.
        if let Some(r) = self.rel_impl(real_path) {
            self.deleted.remove(&r);
        }
        Some(dest.to_string_lossy().to_string())
    }

    /// Record "the sub-agent deleted this". Returns whether it was recorded.
    fn tombstone(&mut self, real_path: &str) -> bool {
        let Some(r) = self.rel_impl(real_path) else {
            return false;
        };
        self.deleted.insert(r);
        // Drop any overlay copy: keeping it would make the merge see both a
        // new version AND a delete for the same path.
        if let Some(dest) = self.overlay_path_impl(real_path) {
            if dest.exists() {
                if dest.is_file() {
                    let _ = fs::remove_file(&dest);
                } else {
                    let _ = fs::remove_dir_all(&dest);
                }
            }
        }
        self.save_impl();
        true
    }

    fn save(&self) {
        self.save_impl();
    }

    /// Every change this overlay holds, as {rel, kind, bytes}.
    fn changes<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        let rows = PyList::empty_bound(py);
        let root = PathBuf::from(&self.root);
        walk_rows(py, &root, &root, &rows)?;
        let deleted_sorted: Vec<&String> = self.deleted.iter().collect();
        for rel in deleted_sorted {
            let d = PyDict::new_bound(py);
            d.set_item("rel", rel)?;
            d.set_item("kind", "delete")?;
            d.set_item("bytes", 0)?;
            rows.append(&d)?;
        }
        Ok(rows)
    }

    /// Summary for the parent: which paths, how many, and where they live.
    fn report<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let d = PyDict::new_bound(py);
        d.set_item("id", &self.id)?;
        d.set_item("label", &self.label)?;
        d.set_item("root", &self.root)?;
        d.set_item("changes", self.changes(py)?)?;
        Ok(d)
    }

    fn __repr__(&self) -> String {
        format!(
            "WorkCopy(id={}, root={}, source_root={})",
            self.id, self.root, self.source_root
        )
    }
}

/// Walk the overlay tree, appending {rel, kind: write, bytes} rows.
fn walk_rows(
    py: Python<'_>,
    root: &Path,
    dir: &Path,
    rows: &Bound<'_, PyList>,
) -> PyResult<()> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()), // OSError -> skip silently (os.walk semantics)
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            walk_rows(py, root, &p, rows)?;
        } else {
            let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if name == MANIFEST && norm_key(&p.to_string_lossy()) == norm_key(&root.to_string_lossy()) {
                continue;
            }
            let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            let rel = p
                .strip_prefix(root)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let d = PyDict::new_bound(rows.py());
            d.set_item("rel", rel)?;
            d.set_item("kind", "write")?;
            d.set_item("bytes", size)?;
            rows.append(&d)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Live registry (Python `_live: dict[str, WorkCopy]`)
// ---------------------------------------------------------------------------

fn live_registry() -> &'static Mutex<HashMap<String, Py<WorkCopy>>> {
    static LIVE: OnceLock<Mutex<HashMap<String, Py<WorkCopy>>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_wc(
    py: Python<'_>,
    source_root: &str,
    root: &str,
    wc_id: &str,
    label: &str,
) -> PyResult<WorkCopy> {
    let wc = WorkCopy {
        id: wc_id.to_string(),
        root: root.to_string(),
        source_root: fs::canonicalize(source_root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| source_root.to_string()),
        label: label.to_string(),
        kind: "overlay".to_string(),
        deleted: BTreeSet::new(),
    };
    wc.save_impl();
    if let Ok(mut map) = live_registry().lock() {
        map.insert(norm_key(root), Py::new(py, wc.clone_shallow())?);
    }
    // _register returns the ORIGINAL WorkCopy (not the registry copy); the
    // registry holds its own clone keyed by normalized root.
    Ok(wc)
}

impl WorkCopy {
    /// Registry entries are shared objects; Python's `_live` maps to the same
    /// instance, so a shallow copy is the closest Rust analog here.
    fn clone_shallow(&self) -> WorkCopy {
        WorkCopy {
            id: self.id.clone(),
            root: self.root.clone(),
            source_root: self.source_root.clone(),
            label: self.label.clone(),
            kind: self.kind.clone(),
            deleted: self.deleted.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Module-level functions
// ---------------------------------------------------------------------------

/// Open a fresh overlay over `source_root`. None when isolation is off or the
/// source isn't a usable directory.
#[pyfunction]
pub fn create(py: Python<'_>, source_root: &str, label: Option<&str>) -> PyResult<Option<WorkCopy>> {
    let label = label.unwrap_or("");
    if !WORK_COPY_ENABLED || source_root.is_empty() || !Path::new(source_root).is_dir() {
        return Ok(None);
    }
    let wc_id = py
        .import_bound("uuid")?
        .getattr("uuid4")?
        .call0()?
        .getattr("hex")?
        .extract::<String>()?[..8]
        .to_string();
    let dir = overlay_root(py)?;
    let prefix = format!("wc-{}-", wc_id);
    let mk = py
        .import_bound("tempfile")?
        .getattr("mkdtemp")?
        .call1((prefix, dir.to_string_lossy().to_string()))?;
    let root: String = mk.extract()?;
    Ok(Some(register_wc(py, source_root, &root, &wc_id, label)?))
}

/// Open an overlay at a caller-chosen path (shadow workspace sessions).
#[pyfunction]
#[pyo3(signature = (source_root, overlay_root, wc_id=None, label=None))]
pub fn open_at(
    py: Python<'_>,
    source_root: &str,
    overlay_root: &str,
    wc_id: Option<&str>,
    label: Option<&str>,
) -> PyResult<Option<WorkCopy>> {
    let label = label.unwrap_or("");
    if !WORK_COPY_ENABLED || source_root.is_empty() || !Path::new(source_root).is_dir() {
        return Ok(None);
    }
    let root = fs::canonicalize(overlay_root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| overlay_root.to_string());
    if let Err(e) = fs::create_dir_all(&root) {
        let _ = e;
        return Ok(None);
    }
    let id = match wc_id {
        Some(w) if !w.is_empty() => w.to_string(),
        _ => py
            .import_bound("uuid")?
            .getattr("uuid4")?
            .call0()?
            .getattr("hex")?
            .extract::<String>()?[..8]
            .to_string(),
    };
    Ok(Some(register_wc(py, source_root, &root, &id, label)?))
}

/// The overlay this tool call should write into, if any.
#[pyfunction]
pub fn for_ctx(py: Python<'_>, ctx: &Bound<'_, PyAny>) -> PyResult<Option<Py<WorkCopy>>> {
    if !ctx.is_instance_of::<PyDict>() {
        return Ok(None);
    }
    let root = ctx.get_item(CTX_KEY)?;
    if root.is_none() {
        return Ok(None);
    }
    let root_str: String = root.extract()?;
    let map = live_registry();
    let guard = map.lock().map_err(|e| PyValueError::new_err(e.to_string()))?;
    match guard.get(&norm_key(&root_str)) {
        Some(obj) => Ok(Some(obj.clone_ref(py))),
        None => Ok(None),
    }
}

/// Map a real path to its overlay location. Unchanged when not isolated.
#[pyfunction]
#[pyo3(signature = (path, ctx, seed=true))]
pub fn redirect_write(py: Python<'_>, path: &str, ctx: &Bound<'_, PyAny>, seed: bool) -> PyResult<String> {
    let wc = for_ctx(py, ctx)?;
    let Some(wc) = wc else {
        return Ok(path.to_string());
    };
    let bound = wc.bind(py);
    let mut borrowed = bound.borrow_mut();
    match borrowed.prepare(path, seed) {
        Some(dest) => Ok(dest),
        None => Ok(path.to_string()),
    }
}

/// Record a delete against the overlay. False when not isolated.
#[pyfunction]
pub fn record_delete(py: Python<'_>, path: &str, ctx: &Bound<'_, PyAny>) -> PyResult<bool> {
    let wc = for_ctx(py, ctx)?;
    let Some(wc) = wc else {
        return Ok(false);
    };
    let bound = wc.bind(py);
    let mut borrowed = bound.borrow_mut();
    Ok(borrowed.tombstone(path))
}

/// Throw the overlay away. Used for failed sub-agents and after a merge.
#[pyfunction]
pub fn discard(py: Python<'_>, wc: Option<&Bound<'_, WorkCopy>>) -> PyResult<()> {
    let Some(wc) = wc else {
        return Ok(());
    };
    let root = wc.borrow().root.clone();
    {
        let registry = live_registry();
        if let Ok(mut map) = registry.lock() {
            map.remove(&norm_key(&root));
        }
    }
    let _ = fs::remove_dir_all(&root);
    Ok(())
}

/// Workspace-relative paths that more than one overlay touched.
#[pyfunction]
pub fn find_conflicts<'py>(
    py: Python<'py>,
    copies: &Bound<'py, PyList>,
) -> PyResult<Bound<'py, PyDict>> {
    let mut seen: HashMap<String, Vec<String>> = HashMap::new();
    for item in copies.iter() {
        let wc_any = item;
        // Accept WorkCopy instances (changes() is the protocol).
        let changes = wc_any.getattr("changes")?.call0()?;
        for idx in 0..changes.len()? {
            let row = changes.get_item(idx)?;
            let rel: String = row.get_item("rel")?.extract()?;
            let who = if let Ok(label) = wc_any.getattr("label") {
                let l: String = label.extract()?;
                if l.is_empty() {
                    wc_any.getattr("id")?.extract::<String>()?
                } else {
                    l
                }
            } else {
                wc_any.getattr("id")?.extract::<String>()?
            };
            seen.entry(rel).or_default().push(who);
        }
    }
    let out = PyDict::new_bound(py);
    let mut rels: Vec<&String> = seen.iter().filter(|(_, v)| v.len() > 1).map(|(k, _)| k).collect();
    rels.sort();
    for rel in rels {
        out.set_item(rel, seen.get(rel).unwrap())?;
    }
    Ok(out)
}

/// One short paragraph for the parent agent's tool result.
#[pyfunction]
pub fn describe_merge(py: Python<'_>, result: &Bound<'_, PyDict>) -> PyResult<String> {
    let mut bits: Vec<String> = Vec::new();
    let applied_len = dict_len(result, "applied")?;
    let deleted_len = dict_len(result, "deleted")?;
    let n = applied_len + deleted_len;
    if n > 0 {
        bits.push(format!("已合并 {} 个文件改动", n));
    }
    let conflicts = result.get_item("conflicts")?;
    let conflicts = match conflicts {
        Some(c) if !c.is_none() => c,
        _ => PyDict::new_bound(py).into_any(),
    };
    let conflicts = conflicts.downcast::<PyDict>().map_err(|e| PyValueError::new_err(e.to_string()))?;
    if conflicts.len() > 0 {
        let mut detail_parts: Vec<String> = Vec::new();
        let mut keys: Vec<String> = Vec::new();
        for (k, _) in conflicts.iter() {
            keys.push(k.extract::<String>()?);
        }
        keys.sort();
        for p in &keys {
            let who = conflicts.get_item(p)?.unwrap();
            let who_list = who.downcast::<PyList>().map_err(|e| PyValueError::new_err(e.to_string()))?;
            let names_len = who_list.len();
            let mut names: Vec<String> = Vec::new();
            for i in 0..names_len {
                names.push(who_list.get_item(i)?.extract::<String>()?);
            }
            detail_parts.push(format!("{}（{}）", p, names.join("、")));
        }
        bits.push(format!(
            "有 {} 个文件被多个子代理同时改了，都没有合并，需要你自己决定：{}",
            conflicts.len(),
            detail_parts.join("; ")
        ));
    }
    let errors = result.get_item("errors")?;
    if let Some(errors) = errors {
        if !errors.is_none() {
            let errors_len = errors.len()?;
            for idx in 0..errors_len {
                let e = errors.get_item(idx)?;
                let path: String = e.get_item("path")?.extract()?;
                let err: String = e.get_item("error")?.extract()?;
                bits.push(format!("合并 {} 失败：{}", path, err));
            }
        }
    }
    Ok(bits.join(" "))
}

fn dict_len(d: &Bound<'_, PyDict>, key: &str) -> PyResult<usize> {
    match d.get_item(key)? {
        Some(v) if !v.is_none() => {
            if let Ok(l) = v.downcast::<PyList>() {
                return Ok(l.len());
            }
            let _ = PyString::new_bound(d.py(), key);
            Ok(0)
        }
        _ => Ok(0),
    }
}

// ---------------------------------------------------------------------------
// F4: merge 状态机
// ---------------------------------------------------------------------------

pub const MERGE_STATUS_EMPTY: &str = "empty";
pub const MERGE_STATUS_SAFE: &str = "safe_merge";
pub const MERGE_STATUS_CONFLICTS: &str = "merge_with_conflicts";
pub const MERGE_STATUS_FAILED: &str = "merge_back_failed";

/// F4: 将 merge 结果判定为结构化状态。判定优先级: errors > conflicts > safe > empty。
#[pyfunction]
pub fn describe_merge_status(py: Python<'_>, result: &Bound<'_, PyDict>) -> PyResult<String> {
    let applied_len = dict_len(result, "applied")?;
    let deleted_len = dict_len(result, "deleted")?;
    let errors_len = dict_len(result, "errors")?;
    let conflicts = result.get_item("conflicts")?;
    let conflicts_nonempty = match conflicts {
        Some(c) if !c.is_none() => c.len()? > 0,
        _ => false,
    };
    // 判定优先级：errors > conflicts > safe > empty
    if errors_len > 0 && applied_len == 0 {
        return Ok(MERGE_STATUS_FAILED.to_string());
    }
    if conflicts_nonempty {
        return Ok(MERGE_STATUS_CONFLICTS.to_string());
    }
    if applied_len > 0 || deleted_len > 0 {
        return Ok(MERGE_STATUS_SAFE.to_string());
    }
    Ok(MERGE_STATUS_EMPTY.to_string())
}

// TODO(port): merge() execution stays in Python — it composes
// path_lock.write_lock (a threading primitive) with the overlay walk; the
// rulebook's §1 sync default keeps that orchestration out of Rust. The pure
// helpers it needs (find_conflicts, WorkCopy.changes) are provided here.

pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "work_copy")?;
    m.add_function(wrap_pyfunction!(create, &m)?)?;
    m.add_function(wrap_pyfunction!(open_at, &m)?)?;
    m.add_function(wrap_pyfunction!(for_ctx, &m)?)?;
    m.add_function(wrap_pyfunction!(redirect_write, &m)?)?;
    m.add_function(wrap_pyfunction!(record_delete, &m)?)?;
    m.add_function(wrap_pyfunction!(discard, &m)?)?;
    m.add_function(wrap_pyfunction!(find_conflicts, &m)?)?;
    m.add_function(wrap_pyfunction!(describe_merge, &m)?)?;
    m.add_function(wrap_pyfunction!(describe_merge_status, &m)?)?;
    m.add_class::<WorkCopy>()?;
    m.add("WORK_COPY_ENABLED", WORK_COPY_ENABLED)?;
    m.add("CTX_KEY", CTX_KEY)?;
    m.add("MANIFEST", MANIFEST)?;
    m.add("MAX_SEED_BYTES", MAX_SEED_BYTES)?;
    m.add("MERGE_STATUS_EMPTY", MERGE_STATUS_EMPTY)?;
    m.add("MERGE_STATUS_SAFE", MERGE_STATUS_SAFE)?;
    m.add("MERGE_STATUS_CONFLICTS", MERGE_STATUS_CONFLICTS)?;
    m.add("MERGE_STATUS_FAILED", MERGE_STATUS_FAILED)?;
    parent.add_submodule(&m)?;
    Ok(())
}

// PORT STATUS: confidence=medium todos=1
