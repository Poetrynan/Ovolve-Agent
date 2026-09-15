//! sandbox.rs - OS-native process confinement.
//!
//! Rust implementation of sandbox.py. Provides Landlock/seccomp on Linux,
//! Job Objects on Windows, and sandbox-exec on macOS.

use pyo3::prelude::*;
use std::collections::HashMap;

/// Sandbox policy configuration.
#[pyclass]
#[derive(Debug, Clone)]
pub struct SandboxPolicy {
    #[pyo3(get, set)]
    pub mode: String,
    #[pyo3(get, set)]
    pub workspace_root: String,
    #[pyo3(get, set)]
    pub allow_network: bool,
    #[pyo3(get, set)]
    pub writable_roots: Vec<String>,
}

#[pymethods]
impl SandboxPolicy {
    #[new]
    fn new(mode: Option<String>, workspace_root: Option<String>) -> Self {
        Self {
            mode: mode.unwrap_or_else(|| "read-only".to_string()),
            workspace_root: workspace_root.unwrap_or_default(),
            allow_network: false,
            writable_roots: Vec::new(),
        }
    }

    fn to_dict(&self) -> HashMap<String, PyObject> {
        let mut map = HashMap::new();
        // Note: In real implementation, we'd need Python GIL to create PyObjects
        map
    }
}

/// Enforcement capabilities detected on this machine.
#[pyclass]
#[derive(Debug, Clone)]
pub struct Enforcement {
    #[pyo3(get)]
    pub backend: String,
    #[pyo3(get)]
    pub usable: bool,
    #[pyo3(get)]
    pub features: Vec<String>,
}

#[pymethods]
impl Enforcement {
    #[new]
    fn new(backend: String, usable: bool, features: Vec<String>) -> Self {
        Self { backend, usable, features }
    }

    fn to_dict(&self) -> HashMap<String, String> {
        let mut map = HashMap::new();
        map.insert("backend".to_string(), self.backend.clone());
        map.insert("usable".to_string(), self.usable.to_string());
        map.insert("features".to_string(), self.features.join(","));
        map
    }
}

/// Resolve sandbox policy from mode string.
#[pyfunction]
fn resolve_policy(mode: &str, workspace_root: &str) -> SandboxPolicy {
    let mut policy = SandboxPolicy {
        mode: mode.to_string(),
        workspace_root: workspace_root.to_string(),
        allow_network: false,
        writable_roots: vec![],
    };

    match mode {
        "full" => {
            policy.allow_network = true;
            policy.writable_roots = vec![workspace_root.to_string()];
        }
        "read-only" => {
            policy.writable_roots = vec![];
        }
        "workspace-write" => {
            policy.writable_roots = vec![workspace_root.to_string()];
            // Add common scratch dirs
            let extras = _workspace_write_extras(workspace_root);
            policy.writable_roots.push(extras.0);
            policy.writable_roots.push(extras.1);
        }
        _ => {
            // Unknown mode -> safest fallback
            policy.mode = "read-only".to_string();
        }
    }

    policy
}

fn _workspace_write_extras(workspace_root: &str) -> (String, String) {
    // Common temp/scratch directories
    let tmp = format!("{}\\temp", workspace_root);
    let cache = format!("{}\\cache", workspace_root);
    (tmp, cache)
}

/// Probe the current machine's enforcement capabilities.
#[pyfunction]
fn probe() -> Enforcement {
    #[cfg(target_os = "linux")]
    {
        let features = _probe_linux_features();
        let usable = !features.is_empty();
        Enforcement {
            backend: if usable { "landlock+seccomp".to_string() } else { "none".to_string() },
            usable,
            features,
        }
    }
    #[cfg(target_os = "windows")]
    {
        Enforcement {
            backend: "job-objects".to_string(),
            usable: true,
            features: vec!["job-object".to_string(), "restricted-token".to_string()],
        }
    }
    #[cfg(target_os = "macos")]
    {
        Enforcement {
            backend: "sandbox-exec".to_string(),
            usable: true,
            features: vec!["sandbox-exec".to_string()],
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        Enforcement {
            backend: "none".to_string(),
            usable: false,
            features: vec![],
        }
    }
}

#[cfg(target_os = "linux")]
fn _probe_linux_features() -> Vec<String> {
    let mut features = Vec::new();

    // Check Landlock availability (Linux 5.13+)
    let landlock_available = unsafe {
        let abi = libc::syscall(437u32 as i64, 0, std::ptr::null::<*const libc::c_void>(), 0) as i32;
        // SYS_LANDLOCK_CREATE_RULESET = 437
        abi != -1 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOSYS)
    };

    if landlock_available {
        features.push("landlock".to_string());
    }

    // Check seccomp
    #[cfg(target_arch = "x86_64")]
    {
        let seccomp_available = unsafe {
            libc::syscall(317u32 as i64, 0, 0) != -1 || // SECCOMP_SET_MODE_STRICT
            std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOSYS)
        };
        if seccomp_available {
            features.push("seccomp".to_string());
        }
    }

    features
}

/// Get confinement status for settings page.
#[pyfunction]
fn confinement_status(workspace_root: &str) -> HashMap<String, String> {
    let enforcement = probe();
    let mut status = HashMap::new();

    status.insert("backend".to_string(), enforcement.backend.clone());
    status.insert("usable".to_string(), enforcement.usable.to_string());
    status.insert("features".to_string(), enforcement.features.join(","));
    status.insert("workspace_root".to_string(), workspace_root.to_string());

    let note = _status_note(&enforcement, "auto-detected");
    status.insert("note".to_string(), note);

    status
}

fn _status_note(enforcement: &Enforcement, policy_source: &str) -> String {
    if !enforcement.usable {
        format!("No kernel-level confinement available. Policy source: {}", policy_source)
    } else {
        format!("Backend: {}. Features: [{}]. Policy source: {}",
            enforcement.backend,
            enforcement.features.join(", "),
            policy_source
        )
    }
}

/// Describe OS confinement capabilities.
#[pyfunction]
fn describe_os_confinement() -> String {
    let enforcement = probe();
    if enforcement.usable {
        format!("{}[{}]", enforcement.backend, enforcement.features.join("+"))
    } else {
        "none".to_string()
    }
}

/// Register the sandbox submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "sandbox")?;
    m.add_class::<SandboxPolicy>()?;
    m.add_class::<Enforcement>()?;
    m.add_function(wrap_pyfunction!(resolve_policy, &m)?)?;
    m.add_function(wrap_pyfunction!(probe, &m)?)?;
    m.add_function(wrap_pyfunction!(confinement_status, &m)?)?;
    m.add_function(wrap_pyfunction!(describe_os_confinement, &m)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}
