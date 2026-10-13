//! subprocess_isolation — Rust port of `app/backend/subprocess_isolation.py`
//! (wave-9, Native→Rust).
//!
//! OS-level subprocess isolation for F5 teammate workers: on Windows a Job
//! Object with KILL_ON_JOB_CLOSE so children die with the parent; on Unix
//! ``start_new_session`` + ``killpg`` for tree teardown. Every system call is
//! a live CPython object read through the interpreter at call time, so a probe
//! patching the real modules (`os.name`, `os.kill`, `os.getpgid`, `os.killpg`,
//! `ctypes.windll.kernel32.*`, `subprocess.run`, `time.time/sleep`,
//! `signal.SIG*`) is seen identically by both sides:
//!   * `ctypes.Structure` subclasses are built with the real `builtins.type`
//!     (the layout is computed by CPython itself, never re-derived);
//!   * kernel32 functions are attribute lookups on the live
//!     `ctypes.windll.kernel32` object, called with the real argument
//!     protocol (``ctypes.byref``/``sizeof`` included);
//!   * `os.name`, `os.kill`, `os.getpgid`, `os.killpg`, `os.remove`-
//!     family calls, `subprocess.CREATE_*` constants, `subprocess.run`,
//!     `time.time`/`time.sleep`, `signal.SIGTERM`/`SIGKILL`, the module
//!     `log` and the module constants are read live per call.
//!
//! Bug-for-bug items kept verbatim (each pinned by smoke/parity_subprocess_isolation.py):
//! §1 `popen_isolation_kwargs` imports `subprocess` INSIDE the function (only
//!    on the nt branch) and ORs the two CREATE_* constants into
//!    `creationflags`; the posix branch sets `start_new_session=True`.
//! §2 `_win_api` returns None unless `os.name == "nt"`, and swallows ANY
//!    exception out of `ctypes.windll.kernel32` — a broken kernel32 reads as
//!    "no job support", not an error.
//! §3 `create_worker_job` defines its Structure subclasses INSIDE the function
//!    (fresh classes per call), sets `LimitFlags` through the nested
//!    `BasicLimitInformation` attribute, and on `SetInformationJobObject`
//!    failure closes the handle and returns None.
//! §4 `assign_pid_to_job` short-circuits on `not job or pid <= 0`, computes
//!    `access = PROCESS_SET_QUOTA | PROCESS_TERMINATE` (0x0101), and closes
//!    the OpenProcess handle in a `finally` — even when AssignProcessToJobObject
//!    raised.
//! §5 `close_job`/`terminate_job` swallow `not job` and any exception from
//!    the api calls, but `_win_api` returning None short-circuits BEFORE the
//!    truthiness check is reached in the call order `api is None or not job`.
//! §6 `is_process_running` requires `isinstance(pid, int)` AND `pid > 0`
//!    (a bool passes isinstance! `True` is an int) before `os.kill(pid, 0)`;
//!    the OSError arm returns False — including ESRCH and EPERM alike.
//! §7 `kill_process_tree` returns True immediately when the process is not
//!    running; the job arm terminates then polls on `time.time()`/`time.sleep`
//!    against a 5s deadline; the Windows arm runs `taskkill /T` then
//!    `taskkill /T /F`, the posix arm `getpgid`+`SIGTERM` then `SIGKILL`;
//!    ANY exception lands in `log.warning` + a fallback `os.kill` with
//!    `SIGKILL` on posix / `SIGTERM` on Windows — and the fallback's own
//!    exceptions are swallowed.
//! §8 the module `log` is `logging.getLogger(__name__)` evaluated ONCE at
//!    import time (the port reproduces it at register time — same interpreter).
//!
//! DIVERGENCE(port, binding time): python binds logging/ctypes/os/signal/
//!     subprocess/time once at import; the port imports them live at each
//!     use. Production rebinds none of them, and probe patches on the real
//!     modules are seen by both sides.
//! DIVERGENCE(port, `__future__` leftover): `annotations` name not reproduced
//!     (crate-wide note).
// PORT STATUS: confidence=high todos=[0]

use parking_lot::Mutex;
use pyo3::exceptions::PyTypeError;
use pyo3::prelude::*;
use pyo3::types::{PyAny, PyDict, PyList, PyModule, PyString, PyTuple};

use crate::cpy_call::{too_many_positional, unexpected_keyword};

type B<'py> = Bound<'py, PyAny>;

static ST: Mutex<Option<Py<PyModule>>> = Mutex::new(None);

// ── own-module globals ──────────────────────────────────────────────────────

fn own<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    let m: Option<Py<PyModule>> = ST.lock().as_ref().map(|p| p.clone_ref(py));
    match m {
        Some(p) => Ok(p.bind(py).getattr(name)?),
        None => Err(pyo3::exceptions::PyImportError::new_err(
            "subprocess_isolation module not registered",
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

fn obj<'py>(py: Python<'py>, v: i64) -> PyResult<B<'py>> {
    Ok(v.to_object(py).into_bound(py).into_any())
}

fn ps<'py>(py: Python<'py>, v: &str) -> B<'py> {
    PyString::new_bound(py, v).into_any()
}

fn none<'py>(py: Python<'py>) -> B<'py> {
    py.None().into_bound(py).into_any()
}

fn flt<'py>(py: Python<'py>, v: f64) -> B<'py> {
    pyo3::types::PyFloat::new_bound(py, v).into_any()
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

fn op<'py>(py: Python<'py>, name: &str, a: &B<'py>, b: &B<'py>) -> PyResult<B<'py>> {
    Ok(py.import_bound("operator")?.getattr(name)?.call1((a, b))?)
}

fn opb<'py>(py: Python<'py>, name: &str, a: &B<'py>, b: &B<'py>) -> PyResult<bool> {
    Ok(op(py, name, a, b)?.is_truthy()?)
}

fn kwargs_of<'py>(py: Python<'py>, items: Vec<(&str, B<'py>)>) -> Bound<'py, PyDict> {
    let kw = PyDict::new_bound(py);
    for (k, v) in items {
        kw.set_item(k, v).expect("str key");
    }
    kw
}

/// python's `except Exception:` — BaseExceptions must propagate.
fn is_py_exc(e: &PyErr, py: Python<'_>) -> bool {
    e.is_instance_of::<pyo3::exceptions::PyException>(py)
}

/// `isinstance(err, cls)` against a LIVE exception class.
fn err_is<'py>(py: Python<'py>, e: &PyErr, cls: &B<'py>) -> bool {
    e.is_instance_bound(py, cls)
}

/// `except (a, b)` — left to right, isinstance each.
fn err_is_any<'py>(py: Python<'py>, e: &PyErr, classes: &[&B<'py>]) -> bool {
    classes.iter().any(|c| err_is(py, e, c))
}

// ── call binding (cpy_call wording) ─────────────────────────────────────────

fn quoted_and(names: &[&str]) -> String {
    match names.len() {
        1 => format!("'{}'", names[0]),
        2 => format!("'{}' and '{}'", names[0], names[1]),
        n => {
            let head: Vec<String> =
                names[..n - 1].iter().map(|s| format!("'{}'", s)).collect();
            format!("{}, and '{}'", head.join(", "), names[n - 1])
        }
    }
}

fn bind_call<'py>(
    fname: &str,
    params: &[&str],
    required: usize,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<Vec<Option<B<'py>>>> {
    let total = params.len();
    let nargs = args.len();
    let mut slots: Vec<Option<B<'py>>> = (0..total).map(|_| None).collect();
    for (i, a) in args.iter().enumerate() {
        if i < total {
            slots[i] = Some(a.into_any());
        }
    }
    if let Some(kw) = kwargs {
        for (k, v) in kw.iter() {
            let key: String = match k.extract() {
                Ok(s) => s,
                Err(_) => return Err(PyTypeError::new_err("keywords must be strings")),
            };
            let idx = match params.iter().position(|p| *p == key) {
                Some(i) => i,
                None => {
                    return Err(PyTypeError::new_err(unexpected_keyword(
                        fname, &key, params,
                    )))
                }
            };
            if slots[idx].is_some() {
                return Err(PyTypeError::new_err(format!(
                    "{}() got multiple values for argument '{}'",
                    fname, key
                )));
            }
            slots[idx] = Some(v.into_any());
        }
    }
    if nargs > total {
        return Err(PyTypeError::new_err(too_many_positional(
            fname,
            total,
            total - required,
            nargs,
        )));
    }
    let missing: Vec<&str> = params[..required]
        .iter()
        .enumerate()
        .filter(|(i, _)| slots[*i].is_none())
        .map(|(_, p)| *p)
        .collect();
    if !missing.is_empty() {
        return Err(PyTypeError::new_err(format!(
            "{}() missing {} required positional argument{}: {}",
            fname,
            missing.len(),
            if missing.len() == 1 { "" } else { "s" },
            quoted_and(&missing)
        )));
    }
    Ok(slots)
}

// ── live os / ctypes / subprocess / signal / time helpers ───────────────────

/// the live `os` module, imported per use.
fn os_mod<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    mod_import(py, "os")
}

/// `os.name`
fn os_name<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    os_mod(py)?.getattr("name")
}

/// `os.kill(pid, sig)` — the real call.
fn os_kill<'py>(py: Python<'py>, pid: &B<'py>, sig: &B<'py>) -> PyResult<B<'py>> {
    os_mod(py)?.getattr("kill")?.call1((pid, sig))
}

/// `ctypes.windll.kernel32` — the live chain, or None when windll is absent.
fn kernel32<'py>(py: Python<'py>) -> PyResult<Option<B<'py>>> {
    // errors PROPAGATE: _win_api wraps this in `except Exception: None`
    let ctypes = mod_import(py, "ctypes")?;
    let windll = ctypes.getattr("windll")?;
    let k32 = windll.getattr("kernel32")?;
    Ok(Some(k32))
}

/// a `ctypes.<TYPE>` scalar class, read live.
fn ctypes_type<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    mod_import(py, "ctypes")?.getattr(name)
}

/// a Structure subclass built with the REAL `builtins.type` — the layout is
/// computed by CPython itself, exactly as the python `class` statement does.
/// `fields` maps names to either a ctypes type NAME (str) or an already-built
/// Structure subclass (for the nested structs).
fn ctypes_structure<'py>(
    py: Python<'py>,
    name: &str,
    fields: &[(&str, B<'py>)],
) -> PyResult<B<'py>> {
    let ctypes = mod_import(py, "ctypes")?;
    let structure = ctypes.getattr("Structure")?;
    let bases = PyTuple::new_bound(py, [structure.into_any()]);
    let ns = PyDict::new_bound(py);
    let mut fl: Vec<B<'py>> = Vec::new();
    for (fname, ftype) in fields {
        fl.push(PyTuple::new_bound(py, [ps(py, fname), ftype.clone()]).into_any());
    }
    ns.set_item("_fields_", PyList::new_bound(py, fl))?;
    call_bi(py, "type", (ps(py, name), &bases.into_any(), &ns.into_any()))
}

/// `def f(a, b, *, kw1=N1, kw2=N2)` — CPython's grammar for a positional tail
/// followed by KEYWORD-ONLY parameters: positionals fill ONLY the
/// positional-or-keyword slots (surplus is the "takes N positional arguments
/// but M were given" error, no multiple-values detour), the keyword-only
/// slots never take a position, and their absence in `kwargs` is not an error
/// (the def-time default applies). `required` of the positional params are
/// positional-or-keyword; the rest are keyword-only with defaults.
fn bind_call_kw<'py>(
    fname: &str,
    pos_params: &[&str],
    required: usize,
    kwonly: &[&str],
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<(Vec<Option<B<'py>>>, Vec<Option<B<'py>>>)> {
    let total = pos_params.len();
    let nargs = args.len();
    let mut slots: Vec<Option<B<'py>>> = (0..total).map(|_| None).collect();
    for (i, a) in args.iter().enumerate() {
        if i < total {
            slots[i] = Some(a.into_any());
        }
    }
    if nargs > total {
        return Err(PyTypeError::new_err(too_many_positional(
            fname,
            total,
            total - required,
            nargs,
        )));
    }
    let mut kw_slots: Vec<Option<B<'py>>> = (0..kwonly.len()).map(|_| None).collect();
    if let Some(kw) = kwargs {
        for (k, v) in kw.iter() {
            let key: String = match k.extract() {
                Ok(s) => s,
                Err(_) => return Err(PyTypeError::new_err("keywords must be strings")),
            };
            match pos_params.iter().position(|p| *p == key) {
                Some(i) => {
                    if slots[i].is_some() {
                        return Err(PyTypeError::new_err(format!(
                            "{}() got multiple values for argument '{}'",
                            fname, key
                        )));
                    }
                    slots[i] = Some(v.into_any());
                }
                None => match kwonly.iter().position(|p| *p == key) {
                    Some(i) => {
                        if kw_slots[i].is_some() {
                            return Err(PyTypeError::new_err(format!(
                                "{}() got multiple values for argument '{}'",
                                fname, key
                            )));
                        }
                        kw_slots[i] = Some(v.into_any());
                    }
                    None => {
                        return Err(PyTypeError::new_err(unexpected_keyword(
                            fname,
                            &key,
                            pos_params,
                        )))
                    }
                },
            }
        }
    }
    let missing: Vec<&str> = pos_params[..required]
        .iter()
        .enumerate()
        .filter(|(i, _)| slots[*i].is_none())
        .map(|(_, p)| *p)
        .collect();
    if !missing.is_empty() {
        return Err(PyTypeError::new_err(format!(
            "{}() missing {} required positional argument{}: {}",
            fname,
            missing.len(),
            if missing.len() == 1 { "" } else { "s" },
            quoted_and(&missing)
        )));
    }
    Ok((slots, kw_slots))
}

// ── module functions ────────────────────────────────────────────────────────

/// `popen_isolation_kwargs()` — §1: function-level `import subprocess` only on
/// the nt branch, OR-ing the two CREATE_* constants.
fn popen_isolation_kwargs_impl<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    if opb(py, "eq", &os_name(py)?, &ps(py, "nt"))? {
        let subprocess = bi1(py, "__import__", &ps(py, "subprocess"))?;
        let new_group = subprocess.getattr("CREATE_NEW_PROCESS_GROUP")?;
        let no_window = subprocess.getattr("CREATE_NO_WINDOW")?;
        let creationflags = op(py, "or_", &new_group, &no_window)?;
        let kw = PyDict::new_bound(py);
        kw.set_item("creationflags", &creationflags)?;
        Ok(kw.into_any())
    } else {
        let kw = PyDict::new_bound(py);
        kw.set_item("start_new_session", builtins(py)?.getattr("True")?.into_any())?;
        Ok(kw.into_any())
    }
}

/// `_win_api()` — §2: None unless nt; ANY exception out of windll.kernel32 is
/// swallowed (read as "no job support"); the success path returns the
/// `{"ctypes":…, "k32":…}` dict.
fn win_api_impl<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    if !opb(py, "eq", &os_name(py)?, &ps(py, "nt"))? {
        return Ok(none(py));
    }
    let k32 = match kernel32(py) {
        Ok(k) => k,
        Err(e) => {
            if is_py_exc(&e, py) {
                return Ok(none(py));
            } else {
                return Err(e);
            }
        }
    };
    let ctypes = mod_import(py, "ctypes")?;
    let d = PyDict::new_bound(py);
    d.set_item("ctypes", &ctypes)?;
    d.set_item("k32", &k32)?;
    Ok(d.into_any())
}

/// `create_worker_job()` — §3: fresh Structure subclasses per call, nested
/// attribute write, CloseHandle + None on failure.
fn create_worker_job_impl<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let api = win_api_impl(py)?;
    if api.is_none() {
        return Ok(none(py));
    }
    let k32 = api.get_item("k32")?;
    let create = k32.getattr("CreateJobObjectW")?;
    let job = create.call1((none(py), none(py)))?;
    if !job.is_truthy()? {
        return Ok(none(py));
    }
    let basic_fields: Vec<(&str, B<'py>)> = vec![
        ("PerProcessUserTimeLimit", ctypes_type(py, "c_int64")?),
        ("PerJobUserTimeLimit", ctypes_type(py, "c_int64")?),
        ("LimitFlags", ctypes_type(py, "c_uint32")?),
        ("MinimumWorkingSetSize", ctypes_type(py, "c_size_t")?),
        ("MaximumWorkingSetSize", ctypes_type(py, "c_size_t")?),
        ("ActiveProcessLimit", ctypes_type(py, "c_uint32")?),
        ("Affinity", ctypes_type(py, "c_size_t")?),
        ("PriorityClass", ctypes_type(py, "c_uint32")?),
        ("SchedulingClass", ctypes_type(py, "c_uint32")?),
    ];
    let basic = ctypes_structure(
        py,
        "JOBOBJECT_BASIC_LIMIT_INFORMATION",
        &basic_fields,
    )?;
    let io_fields: Vec<(&str, B<'py>)> = vec![
        ("ReadOperationCount", ctypes_type(py, "c_uint64")?),
        ("WriteOperationCount", ctypes_type(py, "c_uint64")?),
        ("OtherOperationCount", ctypes_type(py, "c_uint64")?),
        ("ReadTransferCount", ctypes_type(py, "c_uint64")?),
        ("WriteTransferCount", ctypes_type(py, "c_uint64")?),
        ("OtherTransferCount", ctypes_type(py, "c_uint64")?),
    ];
    let io = ctypes_structure(py, "IO_COUNTERS", &io_fields)?;
    let extended_fields: Vec<(&str, B<'py>)> = vec![
        ("BasicLimitInformation", basic),
        ("IoInfo", io),
        ("ProcessMemoryLimit", ctypes_type(py, "c_size_t")?),
        ("JobMemoryLimit", ctypes_type(py, "c_size_t")?),
        ("PeakProcessMemoryUsed", ctypes_type(py, "c_size_t")?),
        ("PeakJobMemoryUsed", ctypes_type(py, "c_size_t")?),
    ];
    let extended = ctypes_structure(
        py,
        "JOBOBJECT_EXTENDED_LIMIT_INFORMATION",
        &extended_fields,
    )?;
    let info = extended.call0()?;
    info.getattr("BasicLimitInformation")?
        .setattr("LimitFlags", own(py, "_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE")?)?;
    let byref = mod_import(py, "ctypes")?.getattr("byref")?;
    let byref_info = byref.call1((&info,))?;
    let sizeof = mod_import(py, "ctypes")?.getattr("sizeof")?;
    let size = sizeof.call1((&info,))?;
    let ok = k32.getattr("SetInformationJobObject")?.call1((
        &job,
        &own(py, "_JobObjectExtendedLimitInformation")?,
        &byref_info,
        &size,
    ))?;
    if !ok.is_truthy()? {
        k32.getattr("CloseHandle")?.call1((&job,))?;
        return Ok(none(py));
    }
    Ok(job)
}

/// `assign_pid_to_job(pid, job)` — §4: short-circuit, OR'd access mask,
/// finally-close.
fn assign_pid_to_job_impl<'py>(
    py: Python<'py>,
    pid: &B<'py>,
    job: &B<'py>,
) -> PyResult<B<'py>> {
    if !job.is_truthy()? || opb(py, "le", pid, &obj(py, 0)?)? {
        return Ok(builtins(py)?.getattr("False")?.into_any());
    }
    let api = win_api_impl(py)?;
    if api.is_none() {
        return Ok(builtins(py)?.getattr("False")?.into_any());
    }
    let k32 = api.get_item("k32")?;
    let set_quota = obj(py, 0x0100)?;
    let terminate = obj(py, 0x0001)?;
    let access = op(py, "or_", &set_quota, &terminate)?;
    let handle = k32.getattr("OpenProcess")?.call1((&access, builtins(py)?.getattr("False")?, pid))?;
    if !handle.is_truthy()? {
        return Ok(builtins(py)?.getattr("False")?.into_any());
    }
    let assigned = k32.getattr("AssignProcessToJobObject")?.call1((job, &handle));
    k32.getattr("CloseHandle")?.call1((&handle,))?;
    match assigned {
        Ok(r) => Ok(r),
        Err(e) => Err(e),
    }
}

/// `close_job(job)` — §5: api-None short-circuits, exceptions swallowed.
fn close_job_impl<'py>(py: Python<'py>, job: &B<'py>) -> PyResult<B<'py>> {
    let api = win_api_impl(py)?;
    if api.is_none() {
        return Ok(none(py));
    }
    if !job.is_truthy()? {
        return Ok(none(py));
    }
    if let Err(e) = api.get_item("k32")?.getattr("CloseHandle")?.call1((job,)) {
        if is_py_exc(&e, py) {
            // pass
        } else {
            return Err(e);
        }
    }
    Ok(none(py))
}

/// `terminate_job(job)` — §5 with TerminateJobObject(job, 1).
fn terminate_job_impl<'py>(py: Python<'py>, job: &B<'py>) -> PyResult<B<'py>> {
    let api = win_api_impl(py)?;
    if api.is_none() {
        return Ok(none(py));
    }
    if !job.is_truthy()? {
        return Ok(none(py));
    }
    if let Err(e) = api
        .get_item("k32")?
        .getattr("TerminateJobObject")?
        .call1((job, obj(py, 1)?))
    {
        if is_py_exc(&e, py) {
            // pass
        } else {
            return Err(e);
        }
    }
    Ok(none(py))
}

/// `is_process_running(pid)` — §6: isinstance(int) AND pid > 0 (bools pass),
/// os.kill(pid, 0), OSError -> False.
fn is_process_running_impl<'py>(py: Python<'py>, pid: &B<'py>) -> PyResult<B<'py>> {
    if !pid.is_instance_of::<pyo3::types::PyLong>()
        || opb(py, "le", pid, &obj(py, 0)?)?
    {
        return Ok(builtins(py)?.getattr("False")?.into_any());
    }
    match os_kill(py, pid, &obj(py, 0)?) {
        Ok(_) => Ok(builtins(py)?.getattr("True")?.into_any()),
        Err(e) => {
            let oe = builtins(py)?.getattr("OSError")?;
            if err_is(py, &e, &oe) {
                Ok(builtins(py)?.getattr("False")?.into_any())
            } else {
                Err(e)
            }
        }
    }
}

/// `kill_process_tree(pid, *, job=None, grace_s=5.0)` — §7.
fn kill_process_tree_impl<'py>(
    py: Python<'py>,
    pid: &B<'py>,
    job: &B<'py>,
    grace_s: &B<'py>,
) -> PyResult<B<'py>> {
    if !is_process_running_impl(py, pid)?.is_truthy()? {
        return Ok(builtins(py)?.getattr("True")?.into_any());
    }
    if job.is_truthy()? {
        terminate_job_impl(py, job)?;
        let time = mod_import(py, "time")?;
        let deadline = op(py, "add", &time.getattr("time")?.call0()?, grace_s)?;
        loop {
            // python: `while time.time() < deadline:` — the clock is read
            // FIRST, then the body polls the process and sleeps.
            let now = time.getattr("time")?.call0()?;
            if !opb(py, "lt", &now, &deadline)? {
                break;
            }
            if !is_process_running_impl(py, pid)?.is_truthy()? {
                return Ok(builtins(py)?.getattr("True")?.into_any());
            }
            time.getattr("sleep")?.call1((flt(py, 0.05),))?;
        }
    }
    match kill_process_tree_inner(py, pid, grace_s) {
        Ok(r) => Ok(r),
        Err(e) => {
            let oe = mod_import(py, "builtins")?.getattr("Exception")?;
            if err_is(py, &e, &oe) {
                let log = own(py, "log")?;
                log.getattr("warning")?.call1((
                    ps(py, "[subprocess] kill tree pid=%s failed: %s"),
                    pid.clone(),
                    e.value_bound(py).clone(),
                ))?;
                let sig = if opb(py, "ne", &os_name(py)?, &ps(py, "nt"))? {
                    mod_import(py, "signal")?.getattr("SIGKILL")?
                } else {
                    mod_import(py, "signal")?.getattr("SIGTERM")?
                };
                if let Err(e2) = os_kill(py, pid, &sig) {
                    let oe2 = builtins(py)?.getattr("OSError")?;
                    if !err_is(py, &e2, &oe2) {
                        return Err(e2);
                    }
                }
                let running = is_process_running_impl(py, pid)?;
                if running.is_truthy()? {
                    Ok(builtins(py)?.getattr("False")?.into_any())
                } else {
                    Ok(builtins(py)?.getattr("True")?.into_any())
                }
            } else {
                Err(e)
            }
        }
    }
}

/// the platform arm of kill_process_tree (Windows taskkill / posix killpg).
fn kill_process_tree_inner<'py>(
    py: Python<'py>,
    pid: &B<'py>,
    grace_s: &B<'py>,
) -> PyResult<B<'py>> {
    if opb(py, "eq", &os_name(py)?, &ps(py, "nt"))? {
        let subprocess = bi1(py, "__import__", &ps(py, "subprocess"))?;
        let run = subprocess.getattr("run")?;
        let argv = PyList::new_bound(py, vec![
            ps(py, "taskkill"),
            ps(py, "/PID"),
            call_bi(py, "str", (pid.clone(),))?,
            ps(py, "/T"),
        ]);
        let kw = kwargs_of(
            py,
            vec![
                ("capture_output", builtins(py)?.getattr("True")?.into_any()),
                ("timeout", call_bi(py, "max", (&flt(py, 1.0), grace_s))?),
            ],
        );
        run.call((PyList::new_bound(py, argv).into_any(),), Some(&kw))?;
        let time = mod_import(py, "time")?;
        let deadline = op(py, "add", &time.getattr("time")?.call0()?, grace_s)?;
        loop {
            // python: `while time.time() < deadline:` — the clock is read
            // FIRST, then the body polls the process and sleeps.
            let now = time.getattr("time")?.call0()?;
            if !opb(py, "lt", &now, &deadline)? {
                break;
            }
            if !is_process_running_impl(py, pid)?.is_truthy()? {
                return Ok(builtins(py)?.getattr("True")?.into_any());
            }
            time.getattr("sleep")?.call1((flt(py, 0.05),))?;
        }
        let argv2 = PyList::new_bound(py, vec![
            ps(py, "taskkill"),
            ps(py, "/PID"),
            call_bi(py, "str", (pid.clone(),))?,
            ps(py, "/T"),
            ps(py, "/F"),
        ]);
        let kw2 = kwargs_of(
            py,
            vec![
                ("capture_output", builtins(py)?.getattr("True")?.into_any()),
                ("timeout", op(py, "add", &flt(py, 1.0), grace_s)?),
            ],
        );
        run.call((PyList::new_bound(py, argv2).into_any(),), Some(&kw2))?;
    } else {
        let osm = os_mod(py)?;
        let pgid = osm.getattr("getpgid")?.call1((pid,))?;
        let term = mod_import(py, "signal")?.getattr("SIGTERM")?;
        osm.getattr("killpg")?.call1((&pgid, &term))?;
        let time = mod_import(py, "time")?;
        let deadline = op(py, "add", &time.getattr("time")?.call0()?, grace_s)?;
        loop {
            // python: `while time.time() < deadline:` — the clock is read
            // FIRST, then the body polls the process and sleeps.
            let now = time.getattr("time")?.call0()?;
            if !opb(py, "lt", &now, &deadline)? {
                break;
            }
            if !is_process_running_impl(py, pid)?.is_truthy()? {
                return Ok(builtins(py)?.getattr("True")?.into_any());
            }
            time.getattr("sleep")?.call1((flt(py, 0.05),))?;
        }
        if is_process_running_impl(py, pid)?.is_truthy()? {
            let sigkill = mod_import(py, "signal")?.getattr("SIGKILL")?;
            osm.getattr("killpg")?.call1((&pgid, &sigkill))?;
        }
    }
    let running = is_process_running_impl(py, pid)?;
    // `return not is_process_running(pid)` — operator.not_ was removed in
    // 3.13 (same fate as operator.len): use the truthiness negation directly.
    if running.is_truthy()? {
        Ok(builtins(py)?.getattr("False")?.into_any())
    } else {
        Ok(builtins(py)?.getattr("True")?.into_any())
    }
}

// ── exported callables ──────────────────────────────────────────────────────

#[pyfunction]
#[pyo3(name = "_win_api", signature = (*args, **kwargs))]
fn py_win_api<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let _ = bind_call("_win_api", &[], 0, args, kwargs)?;
    Ok(win_api_impl(py)?.unbind())
}

#[pyfunction]
#[pyo3(name = "popen_isolation_kwargs", signature = (*args, **kwargs))]
fn py_popen_isolation_kwargs<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let _ = bind_call("popen_isolation_kwargs", &[], 0, args, kwargs)?;
    Ok(popen_isolation_kwargs_impl(py)?.unbind())
}

#[pyfunction]
#[pyo3(name = "create_worker_job", signature = (*args, **kwargs))]
fn py_create_worker_job<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let _ = bind_call("create_worker_job", &[], 0, args, kwargs)?;
    Ok(create_worker_job_impl(py)?.unbind())
}

#[pyfunction]
#[pyo3(name = "assign_pid_to_job", signature = (*args, **kwargs))]
fn py_assign_pid_to_job<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("assign_pid_to_job", &["pid", "job"], 2, args, kwargs)?;
    Ok(assign_pid_to_job_impl(
        py,
        slots[0].as_ref().expect("validated"),
        slots[1].as_ref().expect("validated"),
    )?
    .unbind())
}

#[pyfunction]
#[pyo3(name = "close_job", signature = (*args, **kwargs))]
fn py_close_job<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("close_job", &["job"], 1, args, kwargs)?;
    Ok(close_job_impl(py, slots[0].as_ref().expect("validated"))?.unbind())
}

#[pyfunction]
#[pyo3(name = "terminate_job", signature = (*args, **kwargs))]
fn py_terminate_job<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("terminate_job", &["job"], 1, args, kwargs)?;
    Ok(terminate_job_impl(py, slots[0].as_ref().expect("validated"))?.unbind())
}

#[pyfunction]
#[pyo3(name = "is_process_running", signature = (*args, **kwargs))]
fn py_is_process_running<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("is_process_running", &["pid"], 1, args, kwargs)?;
    Ok(is_process_running_impl(py, slots[0].as_ref().expect("validated"))?.unbind())
}

/// `kill_process_tree(pid, *, job=None, grace_s=5.0)` — keyword-only tail.
#[pyfunction]
#[pyo3(name = "kill_process_tree", signature = (*args, **kwargs))]
fn py_kill_process_tree<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let (slots, kw) = bind_call_kw(
        "kill_process_tree",
        &["pid"],
        1,
        &["job", "grace_s"],
        args,
        kwargs,
    )?;
    let job = kw[0]
        .as_ref()
        .map(|b| b.clone())
        .unwrap_or_else(|| none(py));
    let grace = kw[1]
        .as_ref()
        .map(|b| b.clone())
        .unwrap_or_else(|| flt(py, 5.0));
    Ok(kill_process_tree_impl(
        py,
        slots[0].as_ref().expect("validated"),
        &job,
        &grace,
    )?
    .unbind())
}

// ── registration ────────────────────────────────────────────────────────────

pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(py, "subprocess_isolation")?;
    m.add_function(wrap_pyfunction!(py_popen_isolation_kwargs, &m)?)?;
    m.add_function(wrap_pyfunction!(py_create_worker_job, &m)?)?;
    m.add_function(wrap_pyfunction!(py_assign_pid_to_job, &m)?)?;
    m.add_function(wrap_pyfunction!(py_close_job, &m)?)?;
    m.add_function(wrap_pyfunction!(py_terminate_job, &m)?)?;
    m.add_function(wrap_pyfunction!(py_is_process_running, &m)?)?;
    m.add_function(wrap_pyfunction!(py_kill_process_tree, &m)?)?;

    m.add("_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE", 0x00002000i64)?;
    m.add("_JobObjectExtendedLimitInformation", 9i64)?;
    m.add("_win_api", wrap_pyfunction!(py_win_api, &m)?)?;

    // import-time names (evaluated once, like the python module level).
    m.add("ctypes", mod_import(py, "ctypes")?)?;
    m.add("os", os_mod(py)?)?;
    m.add("signal", mod_import(py, "signal")?)?;
    m.add("time", mod_import(py, "time")?)?;
    m.add("logging", mod_import(py, "logging")?)?;
    let logger = m
        .getattr("logging")?
        .call_method1("getLogger", (m.getattr("__name__")?,))?;
    m.add("log", &logger)?;

    *ST.lock() = Some(m.clone().unbind());
    parent.add_submodule(&m)?;
    Ok(())
}
