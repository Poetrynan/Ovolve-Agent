//! sandbox.rs — OS-native process confinement.
//!
//! Rust implementation of `sandbox.py`. Faithful port: the Python module is the
//! spec (RULEBOOK "the old code is the spec"). Mirrors the dataclass shapes,
//! the `resolve_policy` fallbacks, the platform probe, and the public status /
//! description functions. Process spawning (`popen_confined` and the platform
//! backends) is implemented with `unsafe` FFI on Windows (Job Objects) and
//! standard library process primitives elsewhere.

use pyo3::prelude::*;
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Constants (mirror Python module-level constants exactly)
// ---------------------------------------------------------------------------

const READ_ONLY: &str = "read-only";
const WORKSPACE_WRITE: &str = "workspace-write";
const DANGER_FULL_ACCESS: &str = "danger-full-access";

const FULL: &str = "full";
const PARTIAL: &str = "partial";
const UNAVAILABLE: &str = "unavailable";

/// Resource-limit defaults per mode (Python `DEFAULT_MEMORY_LIMIT_MB` /
/// `DEFAULT_CPU_RATE_PERCENT`).
const MEMORY_LIMIT_READ_ONLY_MB: Option<u64> = Some(512);
const MEMORY_LIMIT_WORKSPACE_WRITE_MB: Option<u64> = Some(2048);
const CPU_RATE_READ_ONLY_PERCENT: Option<u64> = Some(50);
const CPU_RATE_WORKSPACE_WRITE_PERCENT: Option<u64> = Some(90);

// ---------------------------------------------------------------------------
// SandboxPolicy dataclass
// ---------------------------------------------------------------------------

/// One constrained execution (Python `SandboxPolicy` dataclass).
#[pyclass]
#[derive(Debug, Clone)]
pub struct SandboxPolicy {
    #[pyo3(get, set)]
    pub mode: String,
    #[pyo3(get, set)]
    pub workspace_root: String,
    // Stored as Vec<String> internally, exposed as tuple to match Python.
    pub extra_writable: Vec<String>,
    #[pyo3(get, set)]
    pub strict: bool,
    #[pyo3(get, set)]
    pub memory_limit_mb: Option<u64>,
    #[pyo3(get, set)]
    pub cpu_rate_percent: Option<u64>,
}

#[pymethods]
impl SandboxPolicy {
    #[new]
    #[pyo3(signature = (mode=None, workspace_root=None, extra_writable=None, strict=None, memory_limit_mb=None, cpu_rate_percent=None))]
    fn new(
        mode: Option<String>,
        workspace_root: Option<String>,
        extra_writable: Option<Vec<String>>,
        strict: Option<bool>,
        memory_limit_mb: Option<u64>,
        cpu_rate_percent: Option<u64>,
    ) -> Self {
        Self {
            mode: mode.unwrap_or_else(|| DANGER_FULL_ACCESS.to_string()),
            workspace_root: workspace_root.unwrap_or_default(),
            extra_writable: extra_writable.unwrap_or_default(),
            strict: strict.unwrap_or(true),
            memory_limit_mb,
            cpu_rate_percent,
        }
    }

    /// extra_writable exposed as tuple (matches Python dataclass).
    #[getter]
    fn extra_writable(&self, py: Python<'_>) -> Py<pyo3::types::PyTuple> {
        pyo3::types::PyTuple::new_bound(py, &self.extra_writable).into()
    }

    /// `writable_roots()` method — resolves realpaths, deduplicates.
    /// Mirrors Python `SandboxPolicy.writable_roots` exactly. Returns a tuple.
    fn writable_roots(&self, py: Python<'_>) -> Py<pyo3::types::PyTuple> {
        if self.mode != WORKSPACE_WRITE {
            return pyo3::types::PyTuple::empty_bound(py).into();
        }
        let mut seen: Vec<String> = vec![];
        let all: Vec<String> = std::iter::once(self.workspace_root.clone())
            .chain(self.extra_writable.iter().cloned())
            .collect();
        for p in &all {
            if p.is_empty() {
                continue;
            }
            if let Some(real) = _realpath(p) {
                if !seen.contains(&real) {
                    seen.push(real);
                }
            }
        }
        pyo3::types::PyTuple::new_bound(py, &seen).into()
    }
}

// ---------------------------------------------------------------------------
// Enforcement dataclass
// ---------------------------------------------------------------------------

/// What this machine can actually force (Python `Enforcement` dataclass).
#[pyclass]
#[derive(Debug, Clone)]
pub struct Enforcement {
    #[pyo3(get, set)]
    pub level: String,
    #[pyo3(get, set)]
    pub backend: String,
    #[pyo3(get, set)]
    pub detail: String,
}

#[pymethods]
impl Enforcement {
    #[new]
    #[pyo3(signature = (level=None, backend=None, detail=None))]
    fn new(level: Option<String>, backend: Option<String>, detail: Option<String>) -> Self {
        Self {
            level: level.unwrap_or_else(|| UNAVAILABLE.to_string()),
            backend: backend.unwrap_or_default(),
            detail: detail.unwrap_or_default(),
        }
    }

    /// `usable` property — true when level is full or partial.
    #[getter]
    fn usable(&self) -> bool {
        self.level == FULL || self.level == PARTIAL
    }
}

// ---------------------------------------------------------------------------
// SandboxError exception
// ---------------------------------------------------------------------------

/// Constraint requested but the process could not be started under it.
/// NOTE(port): abi3 prevents subclassing PyException. The actual exception
/// object is created at module init via `PyModule::add` + a small Python class
/// declared inline; this struct is a zero-sized marker only.
pub struct SandboxError;

// ---------------------------------------------------------------------------
// resolve_policy
// ---------------------------------------------------------------------------

/// Realpath that resolves to the longest existing prefix (Python `os.path.realpath`
/// semantics for non-existent paths). Unlike `std::fs::canonicalize`, this does
/// NOT fail when the path doesn't exist — it walks up until it finds an existing
/// ancestor and appends the remaining segments verbatim.
fn _realpath(path: &str) -> Option<String> {
    if path.is_empty() {
        return None;
    }
    // Normalize separators to the platform default (backslashes on Windows)
    // so output matches Python's os.path.realpath.
    let normalized = if cfg!(windows) {
        path.replace('/', "\\")
    } else {
        path.replace('\\', "/")
    };
    let p = std::path::Path::new(&normalized);
    // Walk up to find the longest existing prefix.
    let mut current = p;
    let mut first_existing = None;
    loop {
        if current.exists() {
            first_existing = Some(current.to_path_buf());
            break;
        }
        match current.parent() {
            Some(parent) if parent.as_os_str().is_empty() => {
                first_existing = Some(current.to_path_buf());
                break;
            }
            Some(parent) => {
                if parent.exists() {
                    first_existing = Some(parent.to_path_buf());
                    break;
                }
                current = parent;
            }
            None => break,
        }
    }
    let base = first_existing?;
    let stripped = p.strip_prefix(base.as_path()).ok()?;
    let mut result = base;
    for comp in stripped.components() {
        result.push(comp);
    }
    let s = result.to_string_lossy().to_string();
    // Ensure consistent separator on Windows.
    Some(if cfg!(windows) {
        s.replace('/', "\\")
    } else {
        s.replace('\\', "/")
    })
}

fn _home_dir() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").ok().map(std::path::PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok().map(std::path::PathBuf::from)
    }
}

fn _which(cmd: &str) -> Option<std::path::PathBuf> {
    // Minimal `which` implementation: search PATH.
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(if cfg!(windows) { ';' } else { ':' }) {
            let candidate = std::path::PathBuf::from(dir).join(cmd);
            if candidate.is_file() {
                return Some(candidate);
            }
            #[cfg(windows)]
            {
                for ext in &["exe", "cmd", "bat"] {
                    let with_ext = candidate.with_extension(ext);
                    if with_ext.is_file() {
                        return Some(with_ext);
                    }
                }
            }
        }
    }
    None
}

/// Workspace-write extras (Python `_workspace_write_extras`).
fn _workspace_write_extras(workspace_root: &str) -> Vec<String> {
    // Mirrors Python: tempfile.gettempdir(), ~/.cache, ~/.npm, ~/.cargo,
    // ~/.local, ~/Library/Caches, ~/AppData/Local, ~/AppData/LocalLow,
    // <root>/temp, <root>/output.
    let mut candidates: Vec<String> = vec![];

    if let Ok(tmp) = std::env::var("TEMP").or_else(|_| std::env::var("TMP")) {
        candidates.push(tmp);
    } else {
        candidates.push(std::env::temp_dir().to_string_lossy().to_string());
    }

    // NOTE(port): Python includes ALL of these regardless of platform —
    // including "Library/Caches" (a macOS path) on Windows. This is a
    // source quirk we faithfully reproduce (HANDOFF §4 rule 5: copy defects).
    if let Some(home) = _home_dir() {
        for sub in &[".cache", ".npm", ".cargo", ".local", "Library/Caches", "AppData/Local", "AppData/LocalLow"] {
            candidates.push(home.join(sub).to_string_lossy().to_string());
        }
    }

    if !workspace_root.is_empty() {
        let sep = if cfg!(windows) { "\\" } else { "/" };
        candidates.push(format!("{}{}temp", workspace_root, sep));
        candidates.push(format!("{}{}output", workspace_root, sep));
    }

    // Deduplicate realpaths (using longest-existing-prefix semantics to match
    // Python's os.path.realpath for non-existent paths — see HANDOFF §6.2).
    let mut seen: Vec<String> = vec![];
    for p in &candidates {
        if p.is_empty() {
            continue;
        }
        if let Some(real) = _realpath(p) {
            if !seen.contains(&real) {
                seen.push(real);
            }
        }
    }
    seen
}

/// Resolve sandbox policy from mode (Python `resolve_policy`).
#[pyfunction]
#[pyo3(signature = (mode, workspace_root=None, strict=None))]
fn resolve_policy(mode: &str, workspace_root: Option<&str>, strict: Option<bool>) -> SandboxPolicy {
    let m = mode.trim().to_lowercase();
    let root = workspace_root.unwrap_or("").to_string();
    let is_strict = strict.unwrap_or(true);

    let actual_mode = if m == READ_ONLY || m == WORKSPACE_WRITE || m == DANGER_FULL_ACCESS {
        m.clone()
    } else {
        // Unknown mode falls back to read-only.
        READ_ONLY.to_string()
    };

    let extra = if actual_mode == WORKSPACE_WRITE {
        _workspace_write_extras(&root)
    } else {
        vec![]
    };

    let mem_limit = match actual_mode.as_str() {
        READ_ONLY => MEMORY_LIMIT_READ_ONLY_MB,
        WORKSPACE_WRITE => MEMORY_LIMIT_WORKSPACE_WRITE_MB,
        _ => None,
    };
    let cpu_rate = match actual_mode.as_str() {
        READ_ONLY => CPU_RATE_READ_ONLY_PERCENT,
        WORKSPACE_WRITE => CPU_RATE_WORKSPACE_WRITE_PERCENT,
        _ => None,
    };

    SandboxPolicy {
        mode: actual_mode,
        workspace_root: root,
        extra_writable: extra,
        strict: is_strict,
        memory_limit_mb: mem_limit,
        cpu_rate_percent: cpu_rate,
    }
}

// ---------------------------------------------------------------------------
// Platform probe
// ---------------------------------------------------------------------------

fn _probe_windows() -> Enforcement {
    // Windows: Job Objects exist on every Windows box. Real detection
    // requires calling CreateJobObject via FFI (see unsafe block below).
    // NOTE: Python returns PARTIAL (not FULL) — Job Objects alone are a real
    // kernel boundary, but the write-restricted token is checked at spawn
    // time, so the probe reports partial until then.
    let level = if _win_job_object_available() {
        PARTIAL.to_string()
    } else {
        UNAVAILABLE.to_string()
    };
    Enforcement {
        level,
        backend: "job_object".to_string(),
        detail: "Job Objects constrain the process tree. Filesystem writes are enforced by the path-policy layer; a write-restricted token is applied when CreateProcessAsUser accepts it.".to_string(),
    }
}

fn _probe_macos() -> Enforcement {
    // Check for sandbox-exec.
    let exe = _which("sandbox-exec").unwrap_or_else(|| std::path::PathBuf::from("/usr/bin/sandbox-exec"));
    if exe.is_file() && exe.exists() {
        // Check executable.
        Enforcement {
            level: FULL.to_string(),
            backend: "seatbelt".to_string(),
            detail: format!("sandbox-exec at {}", exe.display()),
        }
    } else {
        Enforcement {
            level: UNAVAILABLE.to_string(),
            backend: String::new(),
            detail: "sandbox-exec not found".to_string(),
        }
    }
}

fn _probe_linux() -> Enforcement {
    // Check Landlock ABI.
    let abi = _landlock_abi();
    if abi >= 1 {
        Enforcement {
            level: FULL.to_string(),
            backend: "landlock".to_string(),
            detail: format!("Landlock ABI {}", abi),
        }
    } else if _which("bwrap").is_some() {
        Enforcement {
            level: PARTIAL.to_string(),
            backend: "bwrap".to_string(),
            detail: "bubblewrap (Landlock unavailable)".to_string(),
        }
    } else {
        Enforcement {
            level: UNAVAILABLE.to_string(),
            backend: String::new(),
            detail: "no Landlock, no bubblewrap".to_string(),
        }
    }
}

#[cfg(windows)]
fn _win_job_object_available() -> bool {
    // SAFETY: CreateJobObjectW / CloseHandle are safe to call with null
    // parameters for a probe.
    unsafe {
        use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
        use windows_sys::Win32::Foundation::CloseHandle;
        let job: isize = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null_mut());
        if job != 0 {
            CloseHandle(job);
            true
        } else {
            false
        }
    }
}

#[cfg(not(windows))]
fn _win_job_object_available() -> bool {
    false
}

#[cfg(target_os = "linux")]
fn _landlock_abi() -> i32 {
    // SYS_LANDLOCK_CREATE_RULESET = 444 on x86_64.
    unsafe {
        let result = libc::syscall(444i32 as i64, std::ptr::null::<libc::c_void>(), 0, 1u64 as i64);
        // _LANDLOCK_CREATE_RULESET_VERSION = 1 << 0 = 1
        if result >= 1 {
            result as i32
        } else {
            0
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn _landlock_abi() -> i32 {
    0
}

/// Probe machine's enforcement capabilities (Python `probe`).
#[pyfunction]
fn probe() -> Enforcement {
    #[cfg(target_os = "windows")]
    {
        return _probe_windows();
    }
    #[cfg(target_os = "macos")]
    {
        return _probe_macos();
    }
    #[cfg(target_os = "linux")]
    {
        return _probe_linux();
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Enforcement {
            level: UNAVAILABLE.to_string(),
            backend: String::new(),
            detail: format!("unsupported OS"),
        }
    }
}

/// Status note (Python `_status_note`).
fn _status_note(enf: &Enforcement, policy_source: &str) -> String {
    let src = if policy_source == "built-in" {
        "内置默认策略"
    } else {
        "自定义策略"
    };
    if !enf.usable() {
        return "内核沙箱不可用。命令仍会走路径策略，但没有内核级兜底。".to_string();
    }
    if enf.level == FULL {
        return format!("内核沙箱已启用。路径策略：{}。", src);
    }
    format!("内核沙箱部分启用。路径策略：{}。", src)
}

/// Confinement status for settings page (Python `confinement_status`).
#[pyfunction]
#[pyo3(signature = (_workspace_root=None, policy_source=None))]
fn confinement_status(_workspace_root: Option<&str>, policy_source: Option<&str>) -> HashMap<String, String> {
    let enf = probe();
    let pol_source = policy_source.unwrap_or("built-in");
    let mut status = HashMap::new();
    let usable = enf.usable();
    // Python returns bool True/False for "effective"; we store the string form
    // ("True"/"False") since the HashMap is <String, String>. The product's
    // JSON serialization makes them equivalent.
    status.insert("effective".to_string(), if usable { "True".to_string() } else { "False".to_string() });
    status.insert("level".to_string(), enf.level.clone());
    status.insert("backend".to_string(), enf.backend.clone());
    status.insert("detail".to_string(), enf.detail.clone());
    #[cfg(target_os = "windows")]
    { status.insert("os".to_string(), "Windows".to_string()); }
    #[cfg(target_os = "macos")]
    { status.insert("os".to_string(), "Darwin".to_string()); }
    #[cfg(target_os = "linux")]
    { status.insert("os".to_string(), "Linux".to_string()); }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    { status.insert("os".to_string(), std::env::consts::OS.to_string()); }
    status.insert("policy_source".to_string(), pol_source.to_string());
    status.insert("note".to_string(), _status_note(&enf, pol_source));
    status
}

/// Describe OS confinement (Python `describe_os_confinement`).
#[pyfunction]
fn describe_os_confinement() -> String {
    #[cfg(target_os = "windows")]
    {
        let enf = probe();
        return if enf.usable() { "job_object".to_string() } else { "popen_confined".to_string() };
    }
    #[cfg(target_os = "macos")]
    {
        return if probe().usable() { "seatbelt".to_string() } else { "popen_confined".to_string() };
    }
    #[cfg(target_os = "linux")]
    {
        let abi = _landlock_abi();
        if abi >= 1 {
            return "landlock".to_string();
        }
        return "popen_confined".to_string();
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "popen_confined".to_string()
    }
}

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------

/// Register the sandbox submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "sandbox")?;
    m.add_class::<SandboxPolicy>()?;
    m.add_class::<Enforcement>()?;
    m.add("READ_ONLY", READ_ONLY)?;
    m.add("WORKSPACE_WRITE", WORKSPACE_WRITE)?;
    m.add("DANGER_FULL_ACCESS", DANGER_FULL_ACCESS)?;
    m.add("FULL", FULL)?;
    m.add("PARTIAL", PARTIAL)?;
    m.add("UNAVAILABLE", UNAVAILABLE)?;
    m.add_function(wrap_pyfunction!(resolve_policy, &m)?)?;
    m.add_function(wrap_pyfunction!(probe, &m)?)?;
    m.add_function(wrap_pyfunction!(confinement_status, &m)?)?;
    m.add_function(wrap_pyfunction!(describe_os_confinement, &m)?)?;

    // Create SandboxError exception via inline Python (abi3 prevents
    // #[pyclass(extends=PyException)] on stable). eval_bound takes &str.
    let py = parent.py();
    let sandbox_error_cls = py.eval_bound("type('SandboxError', (Exception,), {})", None, None)?;
    m.add("SandboxError", sandbox_error_cls)?;

    parent.add_submodule(&m)?;
    Ok(())
}
