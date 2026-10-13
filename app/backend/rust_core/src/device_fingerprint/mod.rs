//! device_fingerprint — Rust port of `app/backend/device_fingerprint.py`
//! (wave-6, Native→Rust).
//!
//! Anonymous device identity (`_FINGERPRINT_SALT` + sha256 of node id /
//! platform / home dir, truncated to 32 hex chars) plus the coarse capability
//! report (`platform_info` / `cpu_info` / `memory_info` / `disk_info` /
//! `accelerators`) that `mcp_server/tools/system_tools.py` hands to the model.
//!
//! Port posture (effects / goal_plan / cua_actions precedent): every value
//! flows as a live CPython object. `uuid.getnode`, `platform.*`,
//! `os.path.expanduser`, `os.cpu_count`, `os.sysconf`, `shutil.disk_usage`,
//! `hashlib.sha256`, `sys.maxsize`, `int()`/`str()`/`round()`/`format()`/
//! `list()`/`type()` and the two function-local `import psutil` /
//! `import ctypes` statements go to the real modules and builtins, so
//! exception types and messages, dict key insertion order, the `[:32]` slice,
//! truthiness of `or`, python's banker rounding in `round(x, 1)` and the
//! exact call sequence into `ctypes.windll.kernel32` match the canonical
//! implementation by construction, not by re-derivation. The Windows memory
//! probe is executed *through CPython's own ctypes* rather than re-implemented
//! against `windows-sys`: the struct layout is built from the same `_fields_`
//! list, so production behaviour cannot drift from the python it replaces.
//!
//! Bug-for-bug items kept verbatim (each pinned by
//! smoke/parity_device_fingerprint.py):
//! §1 `device_id()` caches on *truthiness*: a `_cached_id` of "", 0, None or
//!    False re-derives on every call, while any other pre-set value (an int,
//!    a list) is handed back verbatim — the attribute is never re-typed.
//! §2 the raw string is `"|".join` of exactly four pieces and only
//!    `uuid.getnode()` goes through `str()`; `self._salt + raw` concatenates
//!    the salt *first*, so a str salt raises the real
//!    "can only concatenate str (not \"bytes\") to str" and a salt without
//!    `__add__` raises before sha256 is ever called.
//! §3 the digest is `hexdigest()` sliced `[:32]` — 128 bits of a 256-bit hash.
//! §4 `platform_info()` keeps the literal's key order and `is_64bit` is the
//!    *result object* of a real `sys.maxsize > 2 ** 32` comparison, evaluated at
//!    call time from the live `sys` object — so a patched `maxsize` whose `__gt__`
//!    returns a non-bool puts that non-bool in the dict on both sides.
//! §5 `cpu_info()` is `os.cpu_count() or 0` and
//!    `platform.processor() or "unknown"` — a fake returning None/0 gives 0,
//!    an empty processor string gives "unknown", and "0" (truthy) is kept.
//! §6 `memory_info()` returns `{}` only when the total is *None*: a 0 total
//!    still produces `{"total_gib": 0.0}`. The GiB conversion is
//!    `round(total / (1024 ** 3), 1)` — python's round-half-to-even on the
//!    float, so 1.25 GiB reports 1.2 and 1.35 reports 1.4 (or 1.3, depending
//!    on the binary value; both sides share the builtin).
//! §7 `disk_info()` computes `path or os.path.expanduser("~")` (so "" and 0
//!    fall back to the home dir) and swallows **only OSError** — a TypeError
//!    from an exotic path escapes — then reads `usage.total`/`usage.free` and
//!    rounds both, in that key order.
//! §8 `accelerators()` iterates a *snapshot* (`list(result)`), writes True on
//!    a successful `__import__(name)` and False from `except Exception`, so a
//!    BaseException from a patched import hook propagates, and the returned
//!    dict keeps the literal's key order with all three keys always present.
//! §9 `report()` wraps the *whole* payload build in `except Exception as exc`
//!    and returns `Result.failure(f"Device report failed: {exc}",
//!    code="ReportFailed")` — including an exception raised while writing the
//!    `device_id` cache — otherwise `Result.success(payload)`.
//! §10 `_total_memory_bytes()` has three tiers with *different* catch sets:
//!    psutil catches Exception and falls through; the POSIX `os.sysconf` tier
//!    catches only (AttributeError, ValueError, OSError), so a TypeError from a
//!    patched `sysconf` escapes the whole function; and it multiplies only when
//!    *both* `pages > 0` and `page_size > 0` (`and` short-circuits), otherwise
//!    it continues to the Windows tier.
//! §11 the Windows tier is gated on `platform.system() == "Windows"` at call
//!    time; its `except Exception` **returns None** instead of falling through
//!    (so a ctypes failure can never reach a later tier), the MEMORYSTATUSEX
//!    class is rebuilt on every call, `dwLength` is assigned
//!    `ctypes.sizeof(cls)` on the *instance*, and a falsy
//!    `GlobalMemoryStatusEx` result falls out to the trailing `return None`.
//! §12 `memory_info()` reaches `_total_memory_bytes` through `self.`, so a
//!    subclass-level override wins (an instance-level one is impossible here for
//!    the `__dict__` reason below); the method really is a `@staticmethod`.
//! §13 `get_device_fingerprint()` compares the module global with `is None`,
//!    not truthiness — a `_fingerprint` of "" or 0 is returned as-is forever —
//!    and it constructs through the *module global* `DeviceFingerprint`, so
//!    patching the class changes what the singleton holds.
//! §14 one `report()` call reads `os.path.expanduser("~")` twice (once via
//!    `device_id`, once via `disk_info`) and calls `platform.system()` twice
//!    (once for the id, once for the memory tier guard).
//!
//! DIVERGENCE(port, binding time): python binds module globals at import time;
//!     Rust reads them from the live module dict at each call (own dict for its
//!     own names, `sys.modules` for `import`-resolved names inside functions).
//!     Production never rebinds an import behind a module's back, and the parity
//!     probe patches both sides through the same `sys.modules` objects, so the
//!     observable state matches.
//! DIVERGENCE(port, class layout): `#[pyclass(dict)]` is unavailable under
//!     abi3-py38, so `_salt` and `_cached_id` are descriptor fields rather than
//!     `__dict__` entries. `vars(instance)` therefore raises TypeError here and
//!     yields the two attributes in python, and assigning an unrelated
//!     attribute (`d.foo = 1`) fails here but works in python. Nothing in the
//!     repository introspects either; pinned as an accepted divergence. The
//!     class is declared `subclass`, so deriving from `DeviceFingerprint` and
//!     overriding `_total_memory_bytes` on the subtype behaves as in python.
//! DIVERGENCE(port, `__init__` metadata): pyo3's `#[new]` exposes no
//!     `__defaults__` / `__signature__`, but the default *object* is the very
//!     bytes object registered as `_FINGERPRINT_SALT` (snapshotted at register
//!     time, exactly like python's def-time evaluation), so
//!     `DeviceFingerprint()._salt is _FINGERPRINT_SALT` holds on both sides.
//!     The arity/keyword TypeErrors are reproduced from CPython's own message
//!     grammar and precedence by [`bind_salt`].
//! DIVERGENCE(port, MemoryStatusEx): the class is built by calling the real
//!     `type()` builtin instead of a class statement, so `__qualname__` and
//!     `__module__` differ. The class never escapes the function — only
//!     `ctypes.sizeof(cls)`, the instance and `stat.ullTotalPhys` do — and the
//!     `_fields_` list handed to ctypes is verbatim, so with real ctypes the
//!     memory layout is identical.
//! DIVERGENCE(port, docstrings): crate-wide convention — the module's
//!     doc-comment style mirrors no other ported unit's `__doc__`, and this one
//!     follows suit (see the docaudit note in the unit record).
// PORT STATUS: confidence=high todos=[0]

use parking_lot::Mutex;
use pyo3::exceptions::{
    PyAttributeError, PyImportError, PyOSError, PyTypeError, PyValueError,
};
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict, PyList, PyString, PyTuple};

type B<'py> = Bound<'py, PyAny>;

/// the live `device_fingerprint` submodule, so `own()`/`own_set()` read and
/// write the same dict `ovolve_core.device_fingerprint.__dict__` exposes.
static ST: Mutex<Option<Py<PyModule>>> = Mutex::new(None);

/// `def __init__(self, salt: bytes = _FINGERPRINT_SALT)`: python evaluates the
/// default ONCE, at def time, and it is the same object the module attribute
/// holds. Snapshot it at register time instead of re-reading the attribute, so
/// patching `_FINGERPRINT_SALT` afterwards does not move the default.
static SALT_DEFAULT: Mutex<Option<Py<PyAny>>> = Mutex::new(None);

// ── module constants (device_fingerprint.py:26) ─────────────────────────────

const SALT: &[u8] = b"ovolve-device-v1";

/// `_total_memory_bytes()`'s MEMORYSTATUSEX layout, field-for-field.
const MEM_STATUS_FIELDS: [(&str, &str); 9] = [
    ("dwLength", "c_ulong"),
    ("dwMemoryLoad", "c_ulong"),
    ("ullTotalPhys", "c_ulonglong"),
    ("ullAvailPhys", "c_ulonglong"),
    ("ullTotalPageFile", "c_ulonglong"),
    ("ullAvailPageFile", "c_ulonglong"),
    ("ullTotalVirtual", "c_ulonglong"),
    ("ullAvailVirtual", "c_ulonglong"),
    ("ullAvailExtendedVirtual", "c_ulonglong"),
];

/// `def __init__(self, salt=...)` — the name CPython's messages quote.
const FP_PARAMS: &str = "salt";

/// `2 ** 32`, the right-hand side of `is_64bit` (the GiB divisor is computed
/// by the real `**` operator at each call site, as python does).
const U64_BOUND: i64 = 4294967296;

// ── own-module globals (python's late global lookup) ────────────────────────

fn own<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    let m: Option<Py<PyModule>> = ST.lock().as_ref().map(|p| p.clone_ref(py));
    match m {
        Some(p) => Ok(p.bind(py).getattr(name)?),
        None => Err(PyImportError::new_err("device_fingerprint module not registered")),
    }
}

/// `global _fingerprint = ...` — the module dict is the singleton cell, so
/// `ovolve_core.device_fingerprint._fingerprint` is the same object the python
/// module's `_fingerprint` is for `device_fingerprint.py`.
fn own_set(py: Python<'_>, name: &str, value: &B<'_>) -> PyResult<()> {
    let m: Option<Py<PyModule>> = ST.lock().as_ref().map(|p| p.clone_ref(py));
    match m {
        Some(p) => p.bind(py).setattr(name, value),
        None => Err(PyImportError::new_err(
            "device_fingerprint module not registered",
        )),
    }
}

// ── CPython-semantics helpers ───────────────────────────────────────────────

fn builtins(py: Python<'_>) -> PyResult<Bound<'_, PyModule>> {
    Ok(py.import_bound("builtins")?)
}

fn mod_import<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    Ok(py.import_bound(name)?.into_any())
}

/// `import x` as the interpreter compiles it: `builtins.__import__(x)`, looked
/// up at call time, so a patched import hook is honoured on both sides. Used
/// for the two function-local imports (`psutil`, `ctypes`) and the runtime
/// accelerator probe.
fn imported<'py>(py: Python<'py>, name: &B<'py>) -> PyResult<B<'py>> {
    bi1(py, "__import__", name)
}

fn obj<'py>(py: Python<'py>, v: i64) -> PyResult<B<'py>> {
    Ok(v.to_object(py).into_bound(py).into_any())
}

fn ps<'py>(py: Python<'py>, v: &str) -> B<'py> {
    PyString::new_bound(py, v).into_any()
}

fn none<'py>(py: Python<'py>) -> B<'py> {
    py.None().into_bound(py).into_any()
}

fn call_bi<'py, A: IntoPy<Py<PyTuple>>>(
    py: Python<'py>,
    name: &str,
    args: A,
) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr(name)?.call(args, None)?)
}

fn bi1<'py>(py: Python<'py>, name: &str, x: &B<'py>) -> PyResult<B<'py>> {
    call_bi(py, name, (x,))
}

fn bi2<'py>(py: Python<'py>, name: &str, x: &B<'py>, y: &B<'py>) -> PyResult<B<'py>> {
    call_bi(py, name, (x, y))
}

/// real operator-module binary op — the exact protocol behind `a + b`,
/// `a / b`, `a == b`, … including reflected fallbacks.
fn op<'py>(py: Python<'py>, name: &str, a: &B<'py>, b: &B<'py>) -> PyResult<B<'py>> {
    Ok(py.import_bound("operator")?.getattr(name)?.call1((a, b))?)
}

fn eq<'py>(py: Python<'py>, a: &B<'py>, b: &B<'py>) -> PyResult<bool> {
    op(py, "eq", a, b)?.is_truthy()
}

/// `x or default` (returns the original object when truthy).
fn orv<'py>(v: &B<'py>, def: &B<'py>) -> PyResult<B<'py>> {
    Ok(if v.is_truthy()? { v.clone() } else { def.clone() })
}

/// `f"{x}"` — the real `format(x, "")` an f-string compiles to.
fn fmtv<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("format")?.call1((x, ps(py, "")))?)
}

/// `sep.join(parts)`.
fn join_with<'py>(py: Python<'py>, sep: &B<'py>, parts: Vec<B<'py>>) -> PyResult<B<'py>> {
    let list = PyList::new_bound(py, parts);
    Ok(sep.call_method1("join", (&list,))?)
}

/// `x[:stop]`
fn head<'py>(py: Python<'py>, x: &B<'py>, stop: i64) -> PyResult<B<'py>> {
    let sl = builtins(py)?.getattr("slice")?.call1((none(py), stop))?;
    x.get_item(sl)
}

/// python's `except Exception:` — BaseExceptions must propagate.
fn is_py_exc(e: &PyErr, py: Python<'_>) -> bool {
    e.is_instance_of::<pyo3::exceptions::PyException>(py)
}

fn empty_dict<'py>(py: Python<'py>) -> B<'py> {
    PyDict::new_bound(py).into_any()
}

fn dict_of<'py>(py: Python<'py>, items: &[(&str, &B<'py>)]) -> PyResult<B<'py>> {
    let d = PyDict::new_bound(py);
    for (k, v) in items {
        d.set_item(*k, (*v).clone())?;
    }
    Ok(d.into_any())
}

fn kwargs<'py>(py: Python<'py>, items: &[(&str, &B<'py>)]) -> PyResult<Bound<'py, PyDict>> {
    let kw = PyDict::new_bound(py);
    for (k, v) in items {
        kw.set_item(*k, (*v).clone())?;
    }
    Ok(kw)
}

// ── DeviceFingerprint ───────────────────────────────────────────────────────

#[pyclass(subclass, module = "device_fingerprint", name = "DeviceFingerprint")]
struct DeviceFingerprint {
    #[pyo3(get, set)]
    _salt: PyObject,
    #[pyo3(get, set)]
    _cached_id: PyObject,
}

/// the def-time default, as a pyo3 signature expression (these are evaluated
/// per call, so the cached object is handed out rather than rebuilt).
fn default_salt() -> Py<PyAny> {
    Python::with_gil(|py| {
        if let Some(p) = SALT_DEFAULT.lock().as_ref() {
            return p.clone_ref(py);
        }
        PyBytes::new_bound(py, SALT).into_any().unbind()
    })
}

/// CPython parses a call to a python-defined `__init__` in the eval loop, so
/// every arity/keyword TypeError reads `DeviceFingerprint.__init__() ...`;
/// pyo3's `#[new]` parser hard-codes the token `__new__`. [`bind_salt`] keeps
/// CPython's message grammar *and* its precedence: keywords are consumed in
/// call order (unexpected → multiple values), surplus positionals are reported
/// after that, and there is no required-parameter tier to check here.
fn bind_salt<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let nargs = args.len();
    let mut value: Option<B<'py>> = None;
    if let Some(kw) = kwargs {
        for (k, v) in kw.iter() {
            let key: String = match k.extract() {
                Ok(s) => s,
                // CPython's `parse_tuple_and_keywords` rejects the whole call
                // with its own unprefixed message before any name is checked.
                Err(_) => return Err(PyTypeError::new_err("keywords must be strings")),
            };
            if key == "self" {
                // `self` is already filled by the instance, so naming it is a
                // duplicate, not an unexpected keyword.
                return Err(PyTypeError::new_err(
                    "DeviceFingerprint.__init__() got multiple values for argument 'self'",
                ));
            }
            if key != FP_PARAMS {
                return Err(PyTypeError::new_err(format!(
                    "DeviceFingerprint.__init__() got an unexpected keyword argument '{}'",
                    key
                )));
            }
            if nargs >= 1 || value.is_some() {
                return Err(PyTypeError::new_err(
                    "DeviceFingerprint.__init__() got multiple values for argument 'salt'",
                ));
            }
            value = Some(v);
        }
    }
    if nargs > 1 {
        return Err(PyTypeError::new_err(format!(
            "DeviceFingerprint.__init__() takes from 1 to 2 positional arguments but {} were given",
            nargs + 1
        )));
    }
    if nargs == 1 && value.is_none() {
        value = Some(args.get_item(0)?.into_any());
    }
    Ok(match value {
        Some(v) => v,
        None => default_salt().into_bound(py),
    })
}

/// `os.path.expanduser("~")` — the attribute chain, not a shortcut.
fn expand_home<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(own(py, "os")?
        .getattr("path")?
        .call_method1("expanduser", (ps(py, "~"),))?)
}

#[pymethods]
impl DeviceFingerprint {
    #[new]
    #[pyo3(signature = (*args, **kwargs))]
    fn py_new<'py>(
        py: Python<'py>,
        args: &Bound<'py, PyTuple>,
        kwargs: Option<&Bound<'py, PyDict>>,
    ) -> PyResult<Self> {
        let salt = bind_salt(py, args, kwargs)?;
        Ok(Self {
            _salt: salt.unbind(),
            _cached_id: py.None(),
        })
    }

    /// def device_id(self) -> str
    fn device_id<'py>(slf: Py<DeviceFingerprint>, py: Python<'py>) -> PyResult<PyObject> {
        let cached = slf.bind(py).borrow()._cached_id.bind(py).clone();
        if cached.is_truthy()? {
            return Ok(cached.unbind());
        }
        let uuid_mod = own(py, "uuid")?;
        let plat = own(py, "platform")?;
        let joined = join_with(
            py,
            &ps(py, "|"),
            vec![
                bi1(py, "str", &uuid_mod.call_method0("getnode")?)?,
                plat.call_method0("system")?,
                plat.call_method0("machine")?,
                expand_home(py)?,
            ],
        )?;
        let raw = joined.call_method1("encode", (ps(py, "utf-8"),))?;
        let salt = slf.bind(py).borrow()._salt.bind(py).clone();
        let digest_input = op(py, "add", &salt, &raw)?;
        let hexs = own(py, "hashlib")?
            .call_method1("sha256", (&digest_input,))?
            .call_method0("hexdigest")?;
        let derived = head(py, &hexs, 32)?;
        slf.bind(py).borrow_mut()._cached_id = derived.clone().unbind();
        Ok(derived.unbind())
    }

    /// def platform_info(self) -> dict
    fn platform_info<'py>(slf: Py<DeviceFingerprint>, py: Python<'py>) -> PyResult<PyObject> {
        let _ = &slf;
        let plat = own(py, "platform")?;
        let sysmod = own(py, "sys")?;
        // the dict display evaluates left to right, so all five `platform` calls
        // happen before `sys.maxsize` is read: which one raises first is part of
        // the observable behaviour.
        Ok(dict_of(
            py,
            &[
                ("os", &plat.call_method0("system")?),
                ("os_release", &plat.call_method0("release")?),
                ("arch", &plat.call_method0("machine")?),
                ("python", &plat.call_method0("python_version")?),
                ("python_impl", &plat.call_method0("python_implementation")?),
                // the comparison's own result object goes into the dict,
                // unconverted: a patched `__gt__` handing back a non-bool shows
                // up verbatim on both sides.
                (
                    "is_64bit",
                    &op(py, "gt", &sysmod.getattr("maxsize")?, &obj(py, U64_BOUND)?)?,
                ),
            ],
        )?
        .unbind())
    }

    /// def cpu_info(self) -> dict
    fn cpu_info<'py>(slf: Py<DeviceFingerprint>, py: Python<'py>) -> PyResult<PyObject> {
        let _ = &slf;
        // source order, so the two truthiness probes interleave with the two
        // calls exactly as python's dict display does.
        let cores = orv(&own(py, "os")?.call_method0("cpu_count")?, &obj(py, 0)?)?;
        let family = orv(
            &own(py, "platform")?.call_method0("processor")?,
            &ps(py, "unknown"),
        )?;
        Ok(dict_of(
            py,
            &[
                ("logical_cores", &cores),
                ("processor_family", &family),
            ],
        )?
        .unbind())
    }

    /// def memory_info(self) -> dict
    fn memory_info<'py>(slf: Py<DeviceFingerprint>, py: Python<'py>) -> PyResult<PyObject> {
        let me = slf.into_bound(py).into_any();
        let total = me.call_method0("_total_memory_bytes")?;
        if total.is_none() {
            return Ok(empty_dict(py).unbind());
        }
        let gib = op(py, "pow", &obj(py, 1024)?, &obj(py, 3)?)?;
        let rounded = bi2(py, "round", &op(py, "truediv", &total, &gib)?, &obj(py, 1)?)?;
        Ok(dict_of(py, &[("total_gib", &rounded)])?.unbind())
    }

    /// def disk_info(self, path: str = None) -> dict
    #[pyo3(signature = (path = None))]
    fn disk_info<'py>(
        slf: Py<DeviceFingerprint>,
        py: Python<'py>,
        path: Option<&B<'py>>,
    ) -> PyResult<PyObject> {
        let _ = &slf;
        // `target = path or os.path.expanduser("~")` — the fallback expression
        // only runs when `path` is falsy (or absent), so a truthy path never
        // triggers an `expanduser` call.
        let target = match path {
            Some(p) if p.is_truthy()? => p.clone(),
            _ => expand_home(py)?,
        };
        let usage: PyResult<B<'py>> = (|| own(py, "shutil")?.call_method1("disk_usage", (&target,)))();
        let usage = match usage {
            Ok(u) => u,
            // `except OSError:` — nothing else is swallowed.
            Err(e) if e.is_instance_of::<PyOSError>(py) => {
                return Ok(empty_dict(py).unbind())
            }
            Err(e) => return Err(e),
        };
        let gib = op(py, "pow", &obj(py, 1024)?, &obj(py, 3)?)?;
        let total = bi2(
            py,
            "round",
            &op(py, "truediv", &usage.getattr("total")?, &gib)?,
            &obj(py, 1)?,
        )?;
        let free = bi2(
            py,
            "round",
            &op(py, "truediv", &usage.getattr("free")?, &gib)?,
            &obj(py, 1)?,
        )?;
        Ok(dict_of(py, &[("total_gib", &total), ("free_gib", &free)])?.unbind())
    }

    /// def accelerators(self) -> dict
    fn accelerators<'py>(slf: Py<DeviceFingerprint>, py: Python<'py>) -> PyResult<PyObject> {
        let _ = &slf;
        let flags = dict_of(
            py,
            &[
                ("openvino", &py_bool(py, false)?),
                ("onnxruntime", &py_bool(py, false)?),
                ("paddleocr", &py_bool(py, false)?),
            ],
        )?;
        let names = bi1(py, "list", &flags)?;
        for i in 0..names.len()? {
            let name = names.get_item(i)?;
            // `__import__(name)` with the object itself, so a non-str key gives
            // CPython's own TypeError instead of a Rust conversion error.
            let probed: PyResult<B<'py>> = (|| imported(py, &name))();
            let ok = match probed {
                Ok(_) => true,
                Err(e) if is_py_exc(&e, py) => false,
                Err(e) => return Err(e),
            };
            flags.set_item(
                name,
                if ok {
                    py_bool(py, true)?
                } else {
                    py_bool(py, false)?
                },
            )?;
        }
        Ok(flags.unbind())
    }

    /// def report(self) -> Result
    fn report<'py>(slf: Py<DeviceFingerprint>, py: Python<'py>) -> PyResult<PyObject> {
        let me = slf.into_bound(py).into_any();
        let payload: PyResult<B<'py>> = (|| {
            dict_of(
                py,
                &[
                    ("device_id", &me.call_method0("device_id")?),
                    ("platform", &me.call_method0("platform_info")?),
                    ("cpu", &me.call_method0("cpu_info")?),
                    ("memory", &me.call_method0("memory_info")?),
                    ("disk", &me.call_method0("disk_info")?),
                    ("accelerators", &me.call_method0("accelerators")?),
                ]
            )
        })();
        match payload {
            Ok(p) => Ok(own(py, "Result")?.call_method1("success", (&p,))?.unbind()),
            Err(e) if is_py_exc(&e, py) => {
                let msg = join_with(
                    py,
                    &ps(py, ""),
                    vec![
                        ps(py, "Device report failed: "),
                        fmtv(py, &e.value_bound(py))?,
                    ],
                )?;
                let kw = kwargs(py, &[("code", &ps(py, "ReportFailed"))])?;
                Ok(own(py, "Result")?
                    .call_method("failure", (msg,), Some(&kw))?
                    .unbind())
            }
            Err(e) => Err(e),
        }
    }

    /// @staticmethod def _total_memory_bytes() -> Optional[int]
    #[staticmethod]
    fn _total_memory_bytes<'py>(py: Python<'py>) -> PyResult<PyObject> {
        Ok(total_memory_bytes(py)?.unbind())
    }
}

/// the real `True`/`False` singletons (the interpreter's own objects, so
/// `x is True` works on both sides).
fn py_bool<'py>(py: Python<'py>, v: bool) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr(if v { "True" } else { "False" })?)
}

/// `DeviceFingerprint._total_memory_bytes()` — three tiers, three catch sets.
fn total_memory_bytes<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    // tier 1: psutil (`except Exception: pass` → fall through)
    let psutil_tier: PyResult<B<'py>> = (|| {
        let psutil = imported(py, &ps(py, "psutil"))?;
        let vm = psutil.call_method0("virtual_memory")?;
        bi1(py, "int", &vm.getattr("total")?)
    })();
    match psutil_tier {
        Ok(v) => return Ok(v),
        Err(e) if is_py_exc(&e, py) => {}
        Err(e) => return Err(e),
    }

    // tier 2: POSIX sysconf (`except (AttributeError, ValueError, OSError)`)
    let sysconf_tier: PyResult<Option<B<'py>>> = (|| {
        let osm = own(py, "os")?;
        let pages = osm.call_method1("sysconf", (ps(py, "SC_PHYS_PAGES"),))?;
        let page_size = osm.call_method1("sysconf", (ps(py, "SC_PAGE_SIZE"),))?;
        if pages.gt(&obj(py, 0)?)? && page_size.gt(&obj(py, 0)?)? {
            return Ok(Some(op(py, "mul", &pages, &page_size)?));
        }
        Ok(None)
    })();
    match sysconf_tier {
        Ok(Some(v)) => return Ok(v),
        Ok(None) => {}
        Err(e)
            if e.is_instance_of::<PyAttributeError>(py)
                || e.is_instance_of::<PyValueError>(py)
                || e.is_instance_of::<PyOSError>(py) => {}
        Err(e) => return Err(e),
    }

    // tier 3: Windows GlobalMemoryStatusEx
    if eq(py, &own(py, "platform")?.call_method0("system")?, &ps(py, "Windows"))? {
        let win_tier: PyResult<B<'py>> = (|| {
            let ctypes = imported(py, &ps(py, "ctypes"))?;
            let mut fields: Vec<B<'py>> = Vec::with_capacity(MEM_STATUS_FIELDS.len());
            for (n, t) in MEM_STATUS_FIELDS.iter() {
                fields.push(
                    PyTuple::new_bound(py, vec![ps(py, n).unbind(), ctypes.getattr(*t)?.unbind()])
                        .into_any(),
                );
            }
            let ns = PyDict::new_bound(py);
            ns.set_item("_fields_", PyList::new_bound(py, fields))?;
            let bases = PyTuple::new_bound(py, vec![ctypes.getattr("Structure")?.unbind()]);
            let cls = call_bi(py, "type", (ps(py, "MemoryStatusEx"), &bases, &ns))?;
            let stat = cls.call0()?;
            let size = ctypes.call_method1("sizeof", (&cls,))?;
            stat.setattr("dwLength", &size)?;
            let ok = ctypes
                .getattr("windll")?
                .getattr("kernel32")?
                .call_method1("GlobalMemoryStatusEx", (ctypes.call_method1("byref", (&stat,))?,))?;
            if ok.is_truthy()? {
                bi1(py, "int", &stat.getattr("ullTotalPhys")?)
            } else {
                Ok(none(py))
            }
        })();
        match win_tier {
            // `except Exception: return None` — this tier never falls through.
            Ok(v) => return Ok(v),
            Err(e) if is_py_exc(&e, py) => return Ok(none(py)),
            Err(e) => return Err(e),
        }
    }
    Ok(none(py))
}

// ── module singleton ────────────────────────────────────────────────────────

/// def get_device_fingerprint() -> DeviceFingerprint
fn get_device_fingerprint<'py>(py: Python<'py>) -> PyResult<PyObject> {
    let cur = own(py, "_fingerprint")?;
    if !cur.is_none() {
        return Ok(cur.unbind());
    }
    let made = own(py, "DeviceFingerprint")?.call0()?;
    own_set(py, "_fingerprint", &made)?;
    Ok(made.unbind())
}

#[pyfunction]
#[pyo3(name = "get_device_fingerprint")]
fn py_get_device_fingerprint(py: Python<'_>) -> PyResult<PyObject> {
    get_device_fingerprint(py)
}

// ── registration ────────────────────────────────────────────────────────────

/// Register the device_fingerprint submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(py, "device_fingerprint")?;
    m.add_function(wrap_pyfunction!(py_get_device_fingerprint, &m)?)?;
    m.add_class::<DeviceFingerprint>()?;

    // `import`-ed modules and the `from result import Result` of the python
    // source: the same objects, held under the same names.
    let salt = PyBytes::new_bound(py, SALT).into_any();
    m.add("_FINGERPRINT_SALT", &salt)?;
    *SALT_DEFAULT.lock() = Some(salt.clone().unbind());
    for name in ["hashlib", "os", "platform", "shutil", "sys", "uuid"] {
        m.add(name, mod_import(py, name)?)?;
    }
    m.add("Optional", mod_import(py, "typing")?.getattr("Optional")?)?;
    m.add("Result", mod_import(py, "result")?.getattr("Result")?)?;
    m.add("_fingerprint", py.None())?;

    // pyo3 builds `tp_name` as `module.Name`, so CPython's own messages carry
    // the dotted name where a python-defined class reports the bare one.
    m.getattr("DeviceFingerprint")?
        .setattr("__name__", "DeviceFingerprint")?;

    *ST.lock() = Some(m.clone().unbind());
    parent.add_submodule(&m)?;
    Ok(())
}
