//! shadow_workspace — full shadow-workspace validation pipeline.
//!
//! Rust port of `shadow_workspace.py` (rulebook: the Python module is the
//! spec). Scope of this port:
//!
//! * Fully implemented (std::fs + pyo3 only, no new deps):
//!   - shadow file IO + path safety (`_resolve_shadow_root`, `_safe_shadow_path`,
//!     `_write_shadow`) incl. the temp-dir fail-open fallback
//!   - syntax checkers: `_checker_python` (via `py_compile`), `_checker_json`
//!     (serde_json), `_checker_toml` (via Python `tomllib`)
//!   - `_validate_content`, `preview_write`
//!   - `validate_workcopy` + `_read_overlay_file` + `_materialize_verify_tree`
//!     (dynamic port: talks to the work-copy object through the Python
//!     protocol — `wc.root` / `wc.changes()` — so it works with the Python
//!     `work_copy` today and a future Rust port alike)
//!   - `cleanup_workspace_shadow`
//!   - config shims (`get_mode`, `shadow_enabled`, `shadow_staged`,
//!     `precheck_enabled`) delegating to the live `shadow_config` module with
//!     an env-only fallback (they are module attributes of `shadow_workspace`
//!     in Python too, via `from shadow_config import ...`)
//!
//! * TODO(port) stubs (signatures preserved, default/empty returns):
//!   - `_checker_lsp`               — blocked by lsp_client port
//!   - `_checker_project`           — blocked by verify_gate/executors port
//!   - `_checker_code_graph_impact` — blocked by code_graph port
//!
//! * NOT exported (orchestration layer stays in Python per rulebook §1 sync
//!   default): `validate_and_emit`, `maybe_auto_apply` (async event-bus
//!   orchestration + `shadow_session` dependency).

use pyo3::prelude::*;
use pyo3::exceptions::PyTypeError;
use pyo3::types::{PyAny, PyDict, PyList, PyModule, PyString};
use pyo3::wrap_pyfunction;
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Constants (mirror Python module-level constants exactly)
// ---------------------------------------------------------------------------

const MAX_SHADOW_BYTES: usize = 8 * 1024 * 1024;
const MAX_ISSUES: usize = 50;

/// Python: `SHADOW_SUBDIR = os.path.join(".ovolve", "shadow", "preview")`
fn shadow_subdir() -> PathBuf {
    PathBuf::from(".ovolve").join("shadow").join("preview")
}

/// `shutil.ignore_patterns(...)` used when materializing the verify tree.
const VERIFY_TREE_IGNORE: [&str; 6] = [
    "node_modules",
    "__pycache__",
    ".git",
    "target",
    "dist",
    "build",
];

/// Project-root config files copied into the verify tree.
const PROJECT_ROOT_CONFIGS: [&str; 11] = [
    "package.json",
    "tsconfig.json",
    "jsconfig.json",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "pytest.ini",
    "tox.ini",
    "Cargo.toml",
    "go.mod",
    "Makefile",
];

/// Common source roots copied (structure + overlay) into the verify tree.
const PROJECT_SOURCE_SUBDIRS: [&str; 5] = ["src", "app", "lib", "tests", "test"];

// ---------------------------------------------------------------------------
// Config shims (shadow_config delegation with env-only fallback)
// ---------------------------------------------------------------------------

/// Python: `shadow_config.get_mode()` — prefer the live module (runtime
/// hot-reload source of truth), fall back to env only if it cannot be called.
fn get_mode_impl(py: Python<'_>) -> PyResult<String> {
    match PyModule::import_bound(py, "shadow_config") {
        Ok(cfg) => match cfg.getattr("get_mode").and_then(|f| f.call0()) {
            Ok(mode) => return Ok(mode.extract::<String>()?),
            Err(_) => {} // BUG(port): swallow preserved (fail-open config delegation)
        },
        Err(_) => {} // BUG(port): swallow preserved (fail-open config delegation)
    }
    if let Ok(env) = std::env::var("OVOLVE_SHADOW_MODE") {
        let e = env.trim().to_ascii_lowercase();
        if !e.is_empty() {
            return Ok(e);
        }
    }
    Ok("staged".to_string())
}

fn shadow_enabled_impl(py: Python<'_>) -> PyResult<bool> {
    let mode = get_mode_impl(py)?;
    Ok(!matches!(mode.as_str(), "off" | "0" | "false" | "no"))
}

fn shadow_staged_impl(py: Python<'_>) -> PyResult<bool> {
    let mode = get_mode_impl(py)?;
    // shadow_enabled() and get_mode() == "staged"
    Ok(mode == "staged" && !matches!(mode.as_str(), "off" | "0" | "false" | "no"))
}

/// Python: `shadow_config.precheck_enabled()`.
fn precheck_enabled_impl(py: Python<'_>) -> PyResult<bool> {
    match PyModule::import_bound(py, "shadow_config") {
        Ok(cfg) => match cfg.getattr("precheck_enabled").and_then(|f| f.call0()) {
            Ok(v) => return Ok(v.extract::<bool>()?),
            Err(_) => {} // BUG(port): swallow preserved (fail-open config delegation)
        },
        Err(_) => {} // BUG(port): swallow preserved (fail-open config delegation)
    }
    if let Ok(env) = std::env::var("OVOLVE_SHADOW_PRECHECK") {
        let e = env.trim().to_ascii_lowercase();
        if !e.is_empty() {
            return Ok(!matches!(e.as_str(), "0" | "false" | "no" | "off"));
        }
    }
    Ok(true)
}

// ---------------------------------------------------------------------------
// ShadowIssue dataclass
// ---------------------------------------------------------------------------

/// Python `ShadowIssue` dataclass.
#[pyclass]
#[derive(Clone)]
pub struct ShadowIssue {
    #[pyo3(get, set)]
    pub checker: String,
    /// error | warning | info
    #[pyo3(get, set)]
    pub severity: String,
    #[pyo3(get, set)]
    pub message: String,
    #[pyo3(get, set)]
    pub path: String,
    #[pyo3(get, set)]
    pub line: i64,
    #[pyo3(get, set)]
    pub character: i64,
}

fn issue_at(checker: &str, severity: &str, message: impl Into<String>, path: &str) -> ShadowIssue {
    ShadowIssue {
        checker: checker.to_string(),
        severity: severity.to_string(),
        message: message.into(),
        path: path.to_string(),
        line: 0,
        character: 0,
    }
}

fn issue_to_dict(py: Python<'_>, i: &ShadowIssue) -> PyResult<Py<PyDict>> {
    let d = PyDict::new_bound(py);
    d.set_item("checker", &i.checker)?;
    d.set_item("severity", &i.severity)?;
    d.set_item("message", &i.message)?;
    d.set_item("path", &i.path)?;
    d.set_item("line", i.line)?;
    d.set_item("character", i.character)?;
    Ok(d.unbind())
}

#[pymethods]
impl ShadowIssue {
    #[new]
    #[pyo3(signature = (checker, severity, message, path=None, line=None, character=None))]
    fn new(
        checker: String,
        severity: String,
        message: String,
        path: Option<String>,
        line: Option<i64>,
        character: Option<i64>,
    ) -> Self {
        Self {
            checker,
            severity,
            message,
            path: path.unwrap_or_default(),
            line: line.unwrap_or(0),
            character: character.unwrap_or(0),
        }
    }

    fn to_dict(&self, py: Python<'_>) -> PyResult<Py<PyDict>> {
        issue_to_dict(py, self)
    }
}

// ---------------------------------------------------------------------------
// ShadowPreview dataclass
// ---------------------------------------------------------------------------

/// Python `ShadowPreview` dataclass.
///
/// `issues` and `changes` are exposed via getters that build fresh Python
/// objects each access (the Rust side stores `Vec<ShadowIssue>` / an owned
/// `Py<PyList>` clone; list-identity/mutation semantics differ slightly from
/// the Python dataclass — documented divergence, side-by-side deferred).
#[pyclass]
pub struct ShadowPreview {
    #[pyo3(get, set)]
    pub ok: bool,
    pub issues: Vec<ShadowIssue>,
    #[pyo3(get, set)]
    pub shadow_path: String,
    pub changes: Option<Py<PyList>>,
    #[pyo3(get, set)]
    pub mode: String,
    #[pyo3(get, set)]
    pub pending_apply: bool,
}

fn empty_ok_preview(py: Python<'_>) -> PyResult<ShadowPreview> {
    Ok(ShadowPreview {
        ok: true,
        issues: Vec::new(),
        shadow_path: String::new(),
        changes: Some(PyList::empty_bound(py).unbind()),
        mode: get_mode_impl(py)?,
        pending_apply: false,
    })
}

#[pymethods]
impl ShadowPreview {
    #[new]
    #[pyo3(signature = (ok, issues=None, shadow_path=None, changes=None, mode=None, pending_apply=false))]
    fn new(
        py: Python<'_>,
        ok: bool,
        issues: Option<Vec<ShadowIssue>>,
        shadow_path: Option<String>,
        changes: Option<&Bound<'_, PyList>>,
        mode: Option<String>,
        pending_apply: bool,
    ) -> Self {
        Self {
            ok,
            issues: issues.unwrap_or_default(),
            shadow_path: shadow_path.unwrap_or_default(),
            changes: Some(changes
                .map(|c| c.clone().unbind())
                .unwrap_or_else(|| PyList::empty_bound(py).unbind())),
            // Python default_factory=get_mode — evaluated at construction.
            mode: mode.unwrap_or_else(|| "staged".to_string()),
            pending_apply,
        }
    }

    #[getter]
    fn issues(&self, py: Python<'_>) -> PyResult<Py<PyList>> {
        let list = PyList::empty_bound(py);
        for i in &self.issues {
            list.append(Py::new(py, i.clone())?)?;
        }
        Ok(list.unbind())
    }

    #[setter]
    fn set_issues(&mut self, value: Vec<ShadowIssue>) {
        self.issues = value;
    }

    #[getter]
    fn changes(&self, py: Python<'_>) -> Py<PyList> {
        self.changes.as_ref().map(|c| c.clone_ref(py)).unwrap_or_else(|| PyList::empty_bound(py).unbind())
    }

    #[setter]
    fn set_changes(&mut self, value: &Bound<'_, PyList>) {
        self.changes = Some(value.clone().unbind());
    }

    /// Python `format_error`: first error, formatted; "" when no errors.
    fn format_error(&self) -> String {
        let head = match self.issues.iter().find(|i| i.severity == "error") {
            Some(h) => h,
            None => return String::new(),
        };
        let loc = if !head.path.is_empty() && head.line != 0 {
            format!("{}:{}", head.path, head.line)
        } else {
            head.path.clone()
        };
        let prefix = if !loc.is_empty() {
            format!("{}: ", loc)
        } else {
            String::new()
        };
        format!(
            "shadow validation failed ({}): {}{}",
            head.checker, prefix, head.message
        )
    }

    fn to_dict(&self, py: Python<'_>) -> PyResult<Py<PyDict>> {
        let d = PyDict::new_bound(py);
        d.set_item("ok", self.ok)?;
        let issues = PyList::empty_bound(py);
        for i in self.issues.iter().take(MAX_ISSUES) {
            issues.append(issue_to_dict(py, i)?)?;
        }
        d.set_item("issues", &issues)?;
        d.set_item("changes", self.changes.as_ref().map(|c| c.clone_ref(py)).unwrap_or_else(|| PyList::empty_bound(py).unbind()))?;
        d.set_item("mode", &self.mode)?;
        d.set_item("pending_apply", self.pending_apply)?;
        d.set_item("issue_count", self.issues.len() as u64)?;
        d.set_item(
            "error_count",
            self.issues.iter().filter(|i| i.severity == "error").count() as u64,
        )?;
        d.set_item(
            "warning_count",
            self.issues.iter().filter(|i| i.severity == "warning").count() as u64,
        )?;
        Ok(d.unbind())
    }
}

// ---------------------------------------------------------------------------
// Path safety + shadow file IO
// ---------------------------------------------------------------------------

/// Lexical `os.path.normpath` equivalent (Windows-aware, no FS access).
/// Digest input must be deterministic; mirrors Python's normpath for the
/// drive-letter / relative / dot-segment cases that occur in logical paths.
fn normpath_lexical(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return ".".to_string();
    }
    let mut prefix = String::new(); // "" | "C:" | "\\\\"
    let mut rest = trimmed;
    if trimmed.starts_with("\\\\") {
        prefix = "\\\\".to_string();
        rest = &trimmed[2..];
    } else {
        let b = trimmed.as_bytes();
        if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
            prefix = trimmed[..2].to_string();
            rest = &trimmed[2..];
        }
    }
    let rooted = rest.starts_with('/') || rest.starts_with('\\');
    let mut comps: Vec<&str> = Vec::new();
    for seg in rest.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => {
                if !comps.is_empty() && comps[comps.len() - 1] != ".." {
                    comps.pop();
                } else if prefix.is_empty() && !rooted {
                    comps.push("..");
                }
                // rooted paths: ".." at root is dropped (matches normpath)
            }
            s => comps.push(s),
        }
    }
    if prefix == "\\\\" {
        let joined = comps.join("\\");
        if joined.is_empty() {
            return "\\\\".to_string();
        }
        return format!("\\\\{}", joined);
    }
    if !prefix.is_empty() {
        return format!("{}\\{}", prefix, comps.join("\\"));
    }
    if rooted {
        let joined = comps.join("\\");
        if joined.is_empty() {
            return "\\".to_string();
        }
        return format!("\\{}", joined);
    }
    if comps.is_empty() {
        return ".".to_string();
    }
    comps.join("\\")
}

/// Python `os.path.splitext(str(logical_path).lower())[1]` (with the dot).
fn splitext_lower(p: &str) -> String {
    let lower = p.to_ascii_lowercase();
    match Path::new(&lower).extension().and_then(|e| e.to_str()) {
        Some(e) => format!(".{}", e),
        None => String::new(),
    }
}

/// Join a workspace/root with an overlay-relative path ("a/b/c" segments).
/// Absolute segments replace the base, matching `os.path.join` semantics.
fn join_rel(base: &Path, rel: &str) -> PathBuf {
    let mut p = base.to_path_buf();
    for seg in rel.split('/') {
        p.push(seg);
    }
    p
}

/// Python `_resolve_shadow_root`: workspace shadow dir, temp-dir fallback.
fn resolve_shadow_root(workspace: &str) -> io::Result<String> {
    let ws = workspace.trim();
    if !ws.is_empty() && Path::new(ws).is_dir() {
        let root = Path::new(ws).join(shadow_subdir());
        match fs::create_dir_all(&root) {
            Ok(()) => return Ok(root.to_string_lossy().to_string()),
            Err(_) => {} // except OSError: pass -> fall through to temp fallback
        }
    }
    let fallback = std::env::temp_dir()
        .join("ovolve-shadow")
        .join("preview");
    // Python: makedirs failure here propagates (not caught).
    fs::create_dir_all(&fallback)?;
    Ok(fallback.to_string_lossy().to_string())
}

/// Python `_safe_shadow_path`: sha256(normpath(logical))[:20] + suffix.
fn safe_shadow_path(logical_path: &str, workspace: &str, ext: &str) -> io::Result<String> {
    let root = resolve_shadow_root(workspace)?;
    let normalized = normpath_lexical(if logical_path.is_empty() {
        "preview"
    } else {
        logical_path
    });
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let digest_hex = hex::encode(hasher.finalize());
    let suffix = if ext.is_empty() { ".txt" } else { ext };
    let name = format!("{}{}", &digest_hex[..20], suffix);
    Ok(Path::new(&root)
        .join(name)
        .to_string_lossy()
        .to_string())
}

/// Python `_write_shadow` (private; only called inside caught contexts).
/// Size violation / IO errors become `io::Error` so callers can mirror the
/// Python `except Exception -> shadow_io issue` handling exactly.
fn write_shadow_io(logical_path: &str, content: &str, workspace: &str) -> io::Result<String> {
    // Python: content None -> "" (callers here never pass None).
    if content.len() > MAX_SHADOW_BYTES {
        // Python raises ValueError; _validate_content catches it and turns it
        // into a shadow_io warning, so io::Error preserves observable behavior.
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("content exceeds shadow limit ({} bytes)", MAX_SHADOW_BYTES),
        ));
    }
    let ext = splitext_lower(logical_path);
    let dest = safe_shadow_path(logical_path, workspace, &ext)?;
    fs::write(&dest, content)?; // Python: open(dest, "w", encoding="utf-8")
    Ok(dest)
}

/// Python `_read_overlay_file`: read `<wc.root>/<rel>`; "" on failure.
fn read_overlay_file(wc: &Bound<'_, PyAny>, rel: &str) -> PyResult<String> {
    let root: String = wc.getattr("root")?.extract::<String>()?;
    let full = join_rel(Path::new(&root), rel);
    // Python: except OSError: return "". (Rust read_to_string also folds
    // invalid-UTF-8 decode errors into Err -> "", noted divergence from
    // Python where UnicodeDecodeError would propagate.)
    Ok(fs::read_to_string(&full).unwrap_or_default())
}

/// Recursive copytree with `shutil.ignore_patterns(...)` + dirs_exist_ok=True.
/// Per-entry errors are swallowed (Python wraps the whole copytree call in
/// try/except OSError: pass; per-entry swallow diverges only on mid-tree IO
/// failures, noted for side-by-side testing).
fn copy_tree_ignore(src: &Path, dst: &Path, ignore: &[&str]) {
    if fs::create_dir_all(dst).is_err() {
        return;
    }
    let rd = match fs::read_dir(src) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if ignore.iter().any(|p| *p == name) {
            continue;
        }
        let s = entry.path();
        let d = dst.join(&name);
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => copy_tree_ignore(&s, &d, ignore),
            Ok(ft) if ft.is_file() => {
                let _ = fs::copy(&s, &d); // except OSError: pass (copy2)
            }
            _ => {}
        }
    }
}

fn count_files_recursive(dir: &Path) -> usize {
    let mut n = 0;
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.flatten() {
            match entry.file_type() {
                Ok(ft) if ft.is_dir() => n += count_files_recursive(&entry.path()),
                Ok(ft) if ft.is_file() => n += 1,
                _ => {}
            }
        }
    }
    n
}

// ---------------------------------------------------------------------------
// Checkers
// ---------------------------------------------------------------------------

/// Python `_checker_python`: py_compile with doraise=True. Both `except`
/// branches (PyCompileError / generic Exception) produce the same issue, so
/// they are merged into one catch-all here.
fn checker_python(
    py: Python<'_>,
    shadow_path: &str,
    logical_path: &str,
) -> PyResult<Option<ShadowIssue>> {
    let result: PyResult<()> = (|| {
        let py_compile = PyModule::import_bound(py, "py_compile")?;
        let compile_fn = py_compile.getattr("compile")?;
        // compile(file, cfile=None, dfile=None, doraise=True) — positional.
        compile_fn.call1((shadow_path, py.None(), py.None(), true))?;
        Ok(())
    })();
    match result {
        Ok(()) => Ok(None),
        Err(err) => {
            let msg = err.to_string(); // str(exc)
            Ok(Some(issue_at(
                "python_syntax",
                "error",
                msg,
                logical_path,
            )))
        }
    }
}

/// Python `_checker_json`: json.loads. serde_json error text differs
/// cosmetically from Python's JSONDecodeError message (noted divergence);
/// line semantics match (1-based).
fn checker_json(logical_path: &str, content: &str) -> PyResult<Option<ShadowIssue>> {
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(_) => Ok(None),
        Err(e) => Ok(Some(ShadowIssue {
            checker: "json_syntax".to_string(),
            severity: "error".to_string(),
            message: e.to_string(),
            path: logical_path.to_string(),
            line: e.line() as i64,
            character: 0,
        })),
    }
}

/// Python `_checker_toml`: tomllib.loads (catch-all except -> issue).
/// Uses Python's tomllib (no Rust toml crate in the pinned dep set); on
/// py<3.11 the ImportError becomes an issue exactly like Python today.
fn checker_toml(py: Python<'_>, logical_path: &str, content: &str) -> PyResult<Option<ShadowIssue>> {
    let result: PyResult<()> = (|| {
        let tomllib = PyModule::import_bound(py, "tomllib")?;
        let loads = tomllib.getattr("loads")?;
        loads.call1((content,))?;
        Ok(())
    })();
    match result {
        Ok(()) => Ok(None),
        Err(err) => {
            let msg = err.to_string(); // str(exc)
            Ok(Some(issue_at("toml_syntax", "error", msg, logical_path)))
        }
    }
}

/// Python `_checker_lsp` — blocked by lsp_client port.
/// TODO(port): blocked by lsp_client port (diagnostics_for_file). Signature
/// preserved; returns no issues until the LSP client lands in Rust.
fn checker_lsp(
    _py: Python<'_>,
    _workspace: &str,
    _logical_path: &str,
    _content: &str,
) -> PyResult<Vec<ShadowIssue>> {
    // TODO(port): blocked by lsp_client port
    Ok(vec![])
}

/// Python `_checker_project` — blocked by verify_gate/executors ports.
/// TODO(port): blocked by verify_gate (probe/is_allowed) + executors
/// (guarded_spawn) ports. Returns no issues until then.
fn checker_project(_py: Python<'_>, _verify_root: &str) -> PyResult<Vec<ShadowIssue>> {
    // TODO(port): blocked by work_copy/lsp_client port (verify_gate/executors)
    Ok(vec![])
}

/// Python `_checker_code_graph_impact` — blocked by code_graph port.
/// TODO(port): blocked by code_graph (CodeKnowledgeGraph) port.
fn checker_code_graph_impact(
    _py: Python<'_>,
    _workspace: &str,
    _logical_path: &str,
    _content: &str,
) -> PyResult<Vec<ShadowIssue>> {
    // TODO(port): blocked by work_copy/lsp_client port (code_graph)
    Ok(vec![])
}

// ---------------------------------------------------------------------------
// Core validation
// ---------------------------------------------------------------------------

/// Python `_validate_content`: shadow write + per-extension syntax checkers
/// + LSP + code-graph impact.
fn validate_content(
    py: Python<'_>,
    workspace: &str,
    logical_path: &str,
    content: &str,
) -> PyResult<Vec<ShadowIssue>> {
    if logical_path.is_empty() {
        return Ok(vec![]);
    }
    let ext = splitext_lower(logical_path);
    let shadow_path = match write_shadow_io(logical_path, content, workspace) {
        Ok(p) => p,
        Err(exc) => {
            // except Exception -> shadow_io warning
            return Ok(vec![issue_at(
                "shadow_io",
                "warning",
                exc.to_string(),
                logical_path,
            )]);
        }
    };
    let mut issues: Vec<ShadowIssue> = Vec::new();
    if ext == ".py" {
        if let Some(hit) = checker_python(py, &shadow_path, logical_path)? {
            issues.push(hit);
        }
    } else if ext == ".json" {
        if let Some(hit) = checker_json(logical_path, content)? {
            issues.push(hit);
        }
    } else if ext == ".toml" {
        if let Some(hit) = checker_toml(py, logical_path, content)? {
            issues.push(hit);
        }
    }
    issues.extend(checker_lsp(py, workspace, logical_path, content)?);
    issues.extend(checker_code_graph_impact(py, workspace, logical_path, content)?);
    Ok(issues)
}

/// Python `_materialize_verify_tree`: overlay changes + project configs
/// materialized into a sibling verify-tree dir for project-level probes.
/// The work-copy object is accessed dynamically (`wc.root`, `wc.changes()`).
fn materialize_verify_tree(py: Python<'_>, workspace: &str, wc: &Bound<'_, PyAny>) -> PyResult<String> {
    if wc.is_none() || workspace.is_empty() {
        return Ok(String::new());
    }
    let root: String = wc.getattr("root")?.extract::<String>()?;
    // base = join(dirname(wc.root), "verify-tree")
    let base = Path::new(&root)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default()
        .join("verify-tree");

    // try: rmtree(ignore_errors=True); makedirs(exist_ok=True) except OSError: return ""
    let _ = fs::remove_dir_all(&base); // rmtree ignore_errors=True
    if fs::create_dir_all(&base).is_err() {
        return Ok(String::new());
    }

    // Project root configs (copy2; except OSError: pass)
    for name in PROJECT_ROOT_CONFIGS {
        let src = Path::new(workspace).join(name);
        if src.is_file() {
            let _ = fs::copy(&src, base.join(name)); // except OSError: pass
        }
    }

    // Common source roots: structure copy + ignore patterns (dirs_exist_ok)
    for sub in PROJECT_SOURCE_SUBDIRS {
        let ws_sub = Path::new(workspace).join(sub);
        if ws_sub.is_dir() {
            copy_tree_ignore(&ws_sub, &base.join(sub), &VERIFY_TREE_IGNORE);
        }
    }

    // Overlay changes overwrite (copy2; delete -> remove_file)
    let changes_any = wc.getattr("changes")?.call0()?;
    let changes = changes_any
        .downcast_into::<PyList>()
        .map_err(|e| PyTypeError::new_err(e.to_string()))?;
    let n = changes.len();
    for idx in 0..n {
        let row = changes.get_item(idx)?;
        let rel = row.get_item("rel")?.extract::<String>()?;
        let kind = row.get_item("kind")?.extract::<String>()?;
        let dest = join_rel(&base, &rel);
        if kind == "delete" {
            if dest.is_file() {
                let _ = fs::remove_file(&dest); // except OSError: pass
            }
            continue;
        }
        let src = join_rel(Path::new(&root), &rel);
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent); // except OSError: pass
        }
        let _ = fs::copy(&src, &dest); // except OSError: pass (copy2)
    }

    Ok(base.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Public API (pyfunctions)
// ---------------------------------------------------------------------------

/// Python `preview_write`: single-file拟写入 preview + validation.
#[pyfunction]
#[pyo3(signature = (logical_path, content=None, workspace=None))]
fn preview_write(
    py: Python<'_>,
    logical_path: Option<&str>,
    content: Option<&str>,
    workspace: Option<&str>,
) -> PyResult<ShadowPreview> {
    let logical = logical_path.unwrap_or("");
    if !precheck_enabled_impl(py)?
        || !shadow_enabled_impl(py)?
        || logical.is_empty()
        || content.is_none()
    {
        return empty_ok_preview(py);
    }
    let issues = validate_content(py, workspace.unwrap_or(""), logical, content.unwrap())?;
    let has_error = issues.iter().any(|i| i.severity == "error");
    // validate mode: error blocks; staged mode: single-file error also blocks
    // the overlay write. Both collapse to `block = has_error` in Python.
    let block = has_error;
    Ok(ShadowPreview {
        ok: !block,
        issues,
        shadow_path: String::new(),
        changes: Some(PyList::empty_bound(py).unbind()),
        mode: get_mode_impl(py)?,
        pending_apply: false,
    })
}

/// Python `validate_workcopy`: full staged-overlay validation.
/// `wc` is the work-copy object (duck-typed: `.root`, `.changes()`).
#[pyfunction]
#[pyo3(signature = (wc, workspace))]
fn validate_workcopy(py: Python<'_>, wc: &Bound<'_, PyAny>, workspace: &str) -> PyResult<ShadowPreview> {
    if wc.is_none() {
        return empty_ok_preview(py);
    }
    let changes_any = wc.getattr("changes")?.call0()?;
    let changes = changes_any
        .downcast_into::<PyList>()
        .map_err(|e| PyTypeError::new_err(e.to_string()))?;
    let n = changes.len();
    let mut issues: Vec<ShadowIssue> = Vec::new();
    for idx in 0..n {
        let row = changes.get_item(idx)?;
        let kind = row.get_item("kind")?.extract::<String>()?;
        if kind == "delete" {
            continue;
        }
        let rel = row.get_item("rel")?.extract::<String>()?;
        let logical = join_rel(Path::new(workspace), &rel);
        let content = read_overlay_file(wc, &rel)?;
        issues.extend(validate_content(
            py,
            workspace,
            &logical.to_string_lossy(),
            &content,
        )?);
    }

    let verify_root = materialize_verify_tree(py, workspace, wc)?;
    if !verify_root.is_empty() {
        issues.extend(checker_project(py, &verify_root)?);
    }

    let has_error = issues.iter().any(|i| i.severity == "error");
    let pending_apply = shadow_staged_impl(py)? && n > 0;
    Ok(ShadowPreview {
        ok: !has_error,
        issues,
        shadow_path: String::new(),
        changes: Some(changes.unbind()),
        mode: get_mode_impl(py)?,
        pending_apply,
    })
}

/// Python `cleanup_workspace_shadow`: wipe `<ws>/.ovolve/shadow`, return
/// the number of files removed (best-effort count, rmtree ignores errors).
#[pyfunction]
#[pyo3(signature = (workspace=None))]
fn cleanup_workspace_shadow(workspace: Option<&str>) -> usize {
    let ws = workspace.unwrap_or("").trim();
    if ws.is_empty() {
        return 0;
    }
    let target = Path::new(ws).join(".ovolve").join("shadow");
    if !target.is_dir() {
        return 0;
    }
    let count = count_files_recursive(&target);
    let _ = fs::remove_dir_all(&target); // rmtree(ignore_errors=True)
    count
}

// Config shims exposed as functions (module attributes in Python too).

#[pyfunction]
fn get_mode(py: Python<'_>) -> PyResult<String> {
    get_mode_impl(py)
}

#[pyfunction]
fn shadow_enabled(py: Python<'_>) -> PyResult<bool> {
    shadow_enabled_impl(py)
}

#[pyfunction]
fn shadow_staged(py: Python<'_>) -> PyResult<bool> {
    shadow_staged_impl(py)
}

#[pyfunction]
fn precheck_enabled(py: Python<'_>) -> PyResult<bool> {
    precheck_enabled_impl(py)
}

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------

/// Register the shadow_workspace submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "shadow_workspace")?;
    m.add_class::<ShadowIssue>()?;
    m.add_class::<ShadowPreview>()?;
    m.add("SHADOW_SUBDIR", shadow_subdir().to_string_lossy().to_string())?;
    m.add("MAX_SHADOW_BYTES", MAX_SHADOW_BYTES as u64)?;
    m.add("MAX_ISSUES", MAX_ISSUES as u64)?;
    m.add_function(wrap_pyfunction!(get_mode, &m)?)?;
    m.add_function(wrap_pyfunction!(shadow_enabled, &m)?)?;
    m.add_function(wrap_pyfunction!(shadow_staged, &m)?)?;
    m.add_function(wrap_pyfunction!(precheck_enabled, &m)?)?;
    m.add_function(wrap_pyfunction!(preview_write, &m)?)?;
    m.add_function(wrap_pyfunction!(validate_workcopy, &m)?)?;
    m.add_function(wrap_pyfunction!(cleanup_workspace_shadow, &m)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}

// PORT STATUS: confidence=0.86 todos=[3]
// TODO(port): checker_lsp blocked by lsp_client port
// TODO(port): checker_project blocked by verify_gate/executors port
// TODO(port): checker_code_graph_impact blocked by code_graph port
// validate_and_emit / maybe_auto_apply: orchestration layer, stays in Python.
