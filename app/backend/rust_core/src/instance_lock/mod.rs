//! instance_lock — Rust port of `app/backend/instance_lock.py`
//! (wave-8, Native→Rust).
//!
//! The backend's second line of single-instance defence: an advisory
//! `O_CREAT | O_EXCL` lock file in the database directory, whose JSON payload
//! names the holder, plus a PID-liveness probe that decides whether a stale
//! lock may be taken over.
//!
//! Port posture (device_fingerprint / effects / worktree precedent): every
//! value flows as a live CPython object. `os.path.join`, `os.makedirs`,
//! `os.open`/`os.fdopen`/`os.unlink`, `os.getpid`, `os.kill`, `os.name`, the
//! `os.O_*` constants, `json.dumps`/`json.load`/`json.JSONDecodeError`,
//! `time.time`, `sys.argv`, the function-local `import ctypes` (through
//! `builtins.__import__`, so a patched import hook is honoured), the whole
//! `ctypes.windll.kernel32` call chain and every builtin (`int`, `bool`,
//! `isinstance`, `open`, `format`) go to the real modules and builtins, so
//! exception identities and messages, dict key insertion order, the truthiness
//! of `or`/`and`, the `.get(key, default)` call sequence and the ctypes call
//! sequence match the canonical implementation by construction, not by
//! re-derivation. The Windows liveness probe runs *through CPython's ctypes*
//! rather than against `windows-sys`: the port that replaces this file must
//! ask the same question the same way, or `ovolve_core` and
//! `instance_lock.py` would disagree about who is allowed to steal a lock —
//! the one outcome this module exists to prevent.
//!
//! Bug-for-bug items kept verbatim (each pinned by
//! smoke/parity_instance_lock.py):
//! §1 `acquire()` computes `path = lock_path_for(db_dir)` *before* the
//!    `if not db_dir` guard and outside the try, so a non-str `db_dir` escapes
//!    as the raw ntpath TypeError ("expected str, bytes or os.PathLike object,
//!    not int"), while a *falsy* one (None, 0, [], "") still produces
//!    `"backend.lock"` in `lockPath` next to the "no db_dir given" reason.
//! §2 `lock_path_for` is `os.path.join(db_dir or "", LOCK_FILE_NAME)`: `or`
//!    hands the empty str to join for any falsy db_dir, and ntpath never
//!    normalises, so "a//b" → "a//b\\backend.lock", "d/" → "d/backend.lock",
//!    "C:" → "C:backend.lock" (drive-relative, no separator).
//! §3 `_pid_alive`'s `pid <= 0` test runs before the try *and* outside any
//!    handler, so `le`'s own TypeError ("'<=' not supported between instances
//!    of 'str' and 'int'") escapes the function; a `__le__` returning a
//!    non-bool only has to be truthy.
//! §4 the NT tier passes `PROCESS_QUERY_LIMITED_INFORMATION=0x1000`,
//!    `False`, `int(pid)` in that order; a *falsy* handle means dead, any
//!    other value means live; a truthy `GetExitCodeProcess` answers
//!    `code.value == 259`, a falsy one answers True ("query failed: assume
//!    alive"); `CloseHandle` runs in `finally`, so it is called on every
//!    non-exceptional path including the `code.value` read, and a raising
//!    `CloseHandle` replaces the pending exception.
//! §5 the NT tier's `except Exception: return True` — a broken ctypes is
//!    treated as a live holder, never as a stealable lock. A BaseException
//!    (e.g. from a patched `__import__`) escapes the function instead.
//! §6 the POSIX tier answers `os.kill(pid, 0)`: success True,
//!    ProcessLookupError False, PermissionError True, any other OSError True,
//!    and a non-OSError escapes. There is no trailing return: the four arms
//!    cover every reachable path.
//! §7 `_read_lock` catches only `(OSError, json.JSONDecodeError)` — both read
//!    live at raise time — so a UnicodeDecodeError from the utf-8 text layer
//!    escapes it and surfaces in `acquire` as "instance lock error: ...".
//!    JSON that decodes to a list, a scalar, `null` or `true` yields `{}`;
//!    a dict is returned as-is.
//! §8 `pid = int(existing.get("pid") or 0)`: `or` on the live value means pid
//!    0/None/""/[] → 0 while `" 42 "` → 42 and `12.9` → 12 (int() truncates),
//!    and NaN raises ValueError / a list raises TypeError out of `int`.
//! §9 `if pid and _pid_alive(pid)` short-circuits on pid 0, so a lock file
//!    whose pid is 0, absent, null or empty is *always* taken over without any
//!    liveness probe.
//! §10 the self-held test compares the parsed pid with `os.getpid()` using
//!    `==`, so `true` in the file (== 1) reads as "my own pid" in process 1;
//!    the refusal names the pid, and `existing` carries three keys
//!    (pid/startedAt/argv0) read from the *first* file read.
//! §11 the alive-refusal reason re-reads the file:
//!    `_read_lock(path).get('started_at', '?')` is a *second* open. Two reads
//!    per refusal, and they may disagree if the file changed or vanished in
//!    between — `existing` then still reports the old startedAt while the
//!    reason prints `?`.
//! §12 takeover deletes first and reports a failed delete verbatim as
//!    `f"stale lock file could not be removed: {exc}"` (str of the OSError);
//!    the recreated `os.open` is *not* inside the FileExistsError handler, so
//!    a creator that wins the race surfaces as "instance lock error: [Errno
//!    17] File exists: …" with `acquired` still False.
//! §13 `release()` sets `_state["acquired"] = False` only after a successful
//!    unlink; on OSError it returns False and leaves the flag **True** — the
//!    process goes on believing it holds a lock whose file it could not
//!    remove, and `status()` will keep reporting `held: True`.
//! §14 `release`/`status` read `_state` through the module global, so a
//!    replaced `_state` (a fake dict) sees exactly the `.get`/`.update`/
//!    `[]=` traffic python sees: 2 gets in `release`, 3 gets in `status`
//!    (`bool(acquired)` and the `not acquired` guard are separate reads),
//!    `_state.get("lock_path") or ""` turns a None path into "", and
//!    `held` is `bool()` of the raw stored value — the string "no" is True.
//! §15 `status()` adds `heldBy` only when a path exists, the flag is falsy
//!    *and* the holder pid is truthy; `holder.get("pid")` is called twice on
//!    the positive path, and `heldBy` has exactly two keys (no argv0).
//! §16 the payload is `json.dumps` of pid/component/started_at/argv0 in that
//!    order with the default `", "`/`": "` separators and `ensure_ascii=True`
//!    (so a Chinese component name is written `\\u4e2d\\u6587`), `started_at`
//!    is `int(time.time())` (truncation), and `argv0` is
//!    `sys.argv[0] if sys.argv else ""` — the truthiness test, not `len`.
//!    The literal's value expressions are evaluated *in key order*, so a
//!    raising `int(time.time())` (e.g. a patched `time.time` returning None)
//!    still leaves one `os.getpid()` call in the ledger and never reads
//!    `sys.argv`.
//! §17 `os.makedirs(db_dir, exist_ok=True)` runs *before* the first open, so
//!    an uncreatable directory is reported as "instance lock error: …" rather
//!    than as a refusal.
//! §18 success arms `_state.update({"lock_path": path, "acquired": True})` —
//!    that exact two-key dict, in that order — on both the fast path and the
//!    takeover path; no refusal path touches `_state` at all.
//! §19 `acquire` returns *the same dict object* it built (4 keys, fixed order)
//!    on every path, including the outer exception path.
//!
//! DIVERGENCE(port, binding time): python binds module globals at import
//!     time; Rust reads them from the live module dict at each call
//!     (`own()` for its own names — `LOCK_FILE_NAME`, `_state`,
//!     `lock_path_for`, `_read_lock`, `_pid_alive`, `os`, `json`, `sys`,
//!     `time` — and `builtins.__import__` for `ctypes`). Production never
//!     rebinds a name behind a module's back, and the parity probe patches
//!     both module dicts through the same objects, so observable state matches.
//! DIVERGENCE(port, call metadata): a pyo3 `#[pyfunction]` exposes no
//!     `__defaults__`/`__kwdefaults__`/`__annotations__`/real `__doc__`. The
//!     *bindings* CPython's eval loop would produce are reproduced instead —
//!     arity, keyword, "multiple values", "keywords must be strings" and the
//!     "Did you mean 'component'?" suggestion via `crate::cpy_call`, in
//!     CPython's precedence order (keywords first, surplus positionals next,
//!     missing-required last). `_pid_alive`'s `pid: int` and `release() ->
//!     bool` annotations are documentation-only in the source.
//! DIVERGENCE(port, tb): `with … as fh` passes None as the third `__exit__`
//!     argument (pyo3 0.22 exposes no traceback handle); file objects — and
//!     the probe's fakes — ignore it. `__exit__`'s truthy return still
//!     suppresses the body's exception, as in python.
//! DIVERGENCE(port, docstrings): crate-wide convention; `__doc__` on the
//!     functions is None here and a real docstring in python. Pinned as an
//!     accepted divergence, no production code reads it.
// PORT STATUS: confidence=high todos=[0]

use pyo3::exceptions::{
    PyAttributeError, PyException, PyFileExistsError, PyImportError, PyTypeError,
    PyUnboundLocalError,
};
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyDict, PyList, PyString, PyTuple};

use crate::cpy_call::{too_many_positional, unexpected_keyword};

type B<'py> = Bound<'py, PyAny>;

/// the live `instance_lock` submodule: `own()`/`own_set()` read and write the
/// same dict `ovolve_core.instance_lock.__dict__` exposes.
static ST: std::sync::Mutex<Option<Py<PyModule>>> = std::sync::Mutex::new(None);

// ── module constants (instance_lock.py:27) ──────────────────────────────────

const LOCK_NAME: &str = "backend.lock";

/// `PROCESS_QUERY_LIMITED_INFORMATION` / `STILL_ACTIVE` (instance_lock.py:43).
const QUERY_LIMITED: i64 = 0x1000;
const STILL_ACTIVE: i64 = 259;

/// `_pid_alive`'s locals are never observable, so the two names python binds
/// inside the `if` are inlined at the call sites.

// ── own-module globals (python's late global lookup) ────────────────────────

fn own<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    let m: Option<Py<PyModule>> = ST.lock().unwrap().as_ref().map(|p| p.clone_ref(py));
    match m {
        Some(p) => Ok(p.bind(py).getattr(name)?),
        None => Err(PyImportError::new_err("instance_lock module not registered")),
    }
}

// ── CPython-semantics helpers ───────────────────────────────────────────────

fn builtins(py: Python<'_>) -> PyResult<Bound<'_, PyModule>> {
    Ok(py.import_bound("builtins")?)
}

fn mod_import<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    Ok(py.import_bound(name)?.into_any())
}

/// `import ctypes` as the interpreter compiles it: `builtins.__import__(x)`
/// looked up at call time, so a patched import hook is honoured on both sides.
fn imported<'py>(py: Python<'py>, name: &B<'py>) -> PyResult<B<'py>> {
    bi1(py, "__import__", name)
}

fn obj<'py>(py: Python<'py>, v: i64) -> PyResult<B<'py>> {
    Ok(v.to_object(py).into_bound(py).into_any())
}

fn bl<'py>(py: Python<'py>, v: bool) -> B<'py> {
    PyBool::new_bound(py, v).to_owned().into_any()
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

/// real operator-module binary op — the exact protocol behind `a | b`,
/// `a == b`, `a <= b`, … including reflected fallbacks.
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

/// the implicit `"".join(pieces)` of adjacent f-string literals.
fn concat<'py>(py: Python<'py>, parts: Vec<B<'py>>) -> PyResult<B<'py>> {
    let list = PyList::new_bound(py, parts);
    Ok(ps(py, "").call_method1("join", (&list,))?)
}

/// python's `except Exception:` — BaseExceptions must propagate.
fn is_py_exc(e: &PyErr, py: Python<'_>) -> bool {
    e.is_instance_of::<PyException>(py)
}

/// `isinstance(x, cls)` through the real builtin, so a patched class or a
/// subclassing fake answers exactly as python does.
fn inst<'py>(py: Python<'py>, x: &B<'py>, cls: &B<'py>) -> PyResult<bool> {
    bi2(py, "isinstance", x, cls)?.is_truthy()
}

fn bi2<'py>(py: Python<'py>, name: &str, x: &B<'py>, y: &B<'py>) -> PyResult<B<'py>> {
    call_bi(py, name, (x, y))
}

fn err_is<'py>(py: Python<'py>, e: &PyErr, cls: &B<'py>) -> bool {
    e.is_instance_bound(py, cls)
}

/// the builtin `OSError` class, fetched per handler site.
fn oserror(py: Python<'_>) -> PyResult<B<'_>> {
    builtins(py)?.getattr("OSError")
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

/// `dict.get(key)` — the *method*, so a fake mapping's override wins.
fn gget<'py>(py: Python<'py>, d: &B<'py>, key: &str) -> PyResult<B<'py>> {
    d.call_method1("get", (ps(py, key),))
}

/// `dict.get(key, default)`.
fn gget_d<'py>(py: Python<'py>, d: &B<'py>, key: &str, def: &B<'py>) -> PyResult<B<'py>> {
    d.call_method1("get", (ps(py, key), def))
}

/// `with <expr> as fh: fh.write(payload)` — the real protocol: `__enter__`'s
/// result is the target, `__exit__` gets the live exception triple, and a
/// truthy `__exit__` return suppresses the body's error (so the caller
/// continues, exactly as python does).
fn with_write<'py>(py: Python<'py>, ctx: &B<'py>, payload: &B<'py>) -> PyResult<()> {
    let enter = ctx.getattr("__enter__");
    let fh = match enter {
        Err(e) => {
            if e.is_instance_of::<PyAttributeError>(py) {
                let nm = ctx.get_type().getattr("__name__")?;
                return Err(PyTypeError::new_err(format!(
                    "'{}' object does not support the context manager protocol",
                    nm.str()?.to_cow()?
                )));
            }
            return Err(e);
        }
        Ok(m) => m.call0()?,
    };
    match fh.call_method1("write", (payload,)) {
        Ok(_) => {
            ctx.call_method1("__exit__", (none(py), none(py), none(py)))?;
            Ok(())
        }
        Err(e) => {
            let tp = e.get_type_bound(py);
            let val = e.value_bound(py);
            match ctx.call_method1("__exit__", (&tp, val.as_any(), none(py))) {
                Ok(sup) if sup.is_truthy()? => Ok(()),
                Ok(_) => Err(e),
                Err(e2) => Err(e2),
            }
        }
    }
}

// ── call binding (cpy_call wording, eval-loop precedence) ───────────────────

fn quoted_one(name: &str) -> String {
    format!("'{}'", name)
}

/// Bind `f(*args, **kwargs)` for a python-level signature of
/// `positional_or_keyword` params plus optional keyword-only params. Returns
/// one slot per name (positional params first, then kwonly in declaration
/// order). CPython's `parse_tuple_and_keywords` owns the error order: non-str
/// keyword → unknown keyword / multiple values (in call order) → surplus
/// positionals → missing required.
fn bind_call<'py>(
    fname: &str,
    params: &[&str],
    required: usize,
    kwonly: &[&str],
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<Vec<Option<B<'py>>>> {
    let total = params.len();
    let nargs = args.len();
    let mut slots: Vec<Option<B<'py>>> = (0..(total + kwonly.len()))
        .map(|_| None)
        .collect();
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
                None => match kwonly.iter().position(|p| *p == key) {
                    Some(i) => total + i,
                    None => {
                        let mut names: Vec<&str> = params.to_vec();
                        names.extend_from_slice(kwonly);
                        return Err(PyTypeError::new_err(unexpected_keyword(
                            fname, &key, &names,
                        )));
                    }
                },
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
            total.saturating_sub(required),
            nargs,
        )));
    }
    let missing: Vec<&str> = params
        .iter()
        .enumerate()
        .take(required)
        .filter(|(i, _)| slots[*i].is_none())
        .map(|(_, p)| *p)
        .collect();
    if !missing.is_empty() {
        let listed = missing
            .iter()
            .map(|m| quoted_one(m))
            .collect::<Vec<_>>()
            .join(" and ");
        return Err(PyTypeError::new_err(format!(
            "{}() missing {} required positional argument{}: {}",
            fname,
            missing.len(),
            if missing.len() == 1 { "" } else { "s" },
            listed
        )));
    }
    Ok(slots)
}

// ── lock_path_for (instance_lock.py:32) ─────────────────────────────────────

fn lock_path_for_impl<'py>(py: Python<'py>, db_dir: &B<'py>) -> PyResult<B<'py>> {
    let joined = own(py, "os")?
        .getattr("path")?
        .getattr("join")?
        .call1((orv(db_dir, &ps(py, ""))?, own(py, "LOCK_FILE_NAME")?))?;
    Ok(joined)
}

#[pyfunction]
#[pyo3(signature = (*args, **kwargs))]
fn lock_path_for<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let slots = bind_call("lock_path_for", &["db_dir"], 1, &[], args, kwargs)?;
    lock_path_for_impl(py, slots[0].as_ref().unwrap())
}

// ── _pid_alive (instance_lock.py:36) ────────────────────────────────────────

/// `if pid <= 0` — the comparison itself is the observable part (its TypeError
/// wording and the truthiness of a custom `__le__`).
fn le_zero<'py>(py: Python<'py>, pid: &B<'py>) -> PyResult<bool> {
    op(py, "le", pid, &obj(py, 0)?)?.is_truthy()
}

/// The NT tier: `ctypes.windll.kernel32` called through CPython's own ctypes,
/// with the `try/finally` ordering of §4.
fn pid_alive_nt<'py>(py: Python<'py>, pid: &B<'py>) -> PyResult<B<'py>> {
    let attempt = (|| -> PyResult<B<'py>> {
        let ctypes = imported(py, &ps(py, "ctypes"))?;
        let kernel32 = ctypes.getattr("windll")?.getattr("kernel32")?;
        let handle = kernel32.call_method1(
            "OpenProcess",
            (
                obj(py, QUERY_LIMITED)?,
                bl(py, false),
                bi1(py, "int", pid)?,
            ),
        )?;
        if !handle.is_truthy()? {
            return Ok(bl(py, false));
        }
        let body = (|| -> PyResult<B<'py>> {
            let code = ctypes.getattr("c_ulong")?.call0()?;
            let ok = kernel32.call_method1(
                "GetExitCodeProcess",
                (
                    &handle,
                    ctypes.call_method1("byref", (&code,))?,
                ),
            )?;
            if ok.is_truthy()? {
                op(py, "eq", &code.getattr("value")?, &obj(py, STILL_ACTIVE)?)
            } else {
                Ok(bl(py, true))
            }
        })();
        // `finally: CloseHandle(handle)` — a raising finally replaces the body's
        // outcome, exactly as python's unwinder does.
        match kernel32.call_method1("CloseHandle", (&handle,)) {
            Ok(_) => body,
            Err(e) => Err(e),
        }
    })();
    match attempt {
        Ok(v) => Ok(v),
        // `except Exception: return True` — a broken probe is never a licence
        // to steal somebody else's lock.
        Err(e) if is_py_exc(&e, py) => Ok(bl(py, true)),
        Err(e) => Err(e),
    }
}

fn pid_alive_posix<'py>(py: Python<'py>, pid: &B<'py>) -> PyResult<B<'py>> {
    let killed = own(py, "os")?.call_method1("kill", (pid, obj(py, 0)?));
    match killed {
        Ok(_) => Ok(bl(py, true)),
        Err(e) if e.is_instance_of::<pyo3::exceptions::PyProcessLookupError>(py) => {
            Ok(bl(py, false))
        }
        Err(e) if e.is_instance_of::<pyo3::exceptions::PyPermissionError>(py) => Ok(bl(py, true)),
        Err(e) if err_is(py, &e, &oserror(py)?) => Ok(bl(py, true)),
        Err(e) => Err(e),
    }
}

fn pid_alive_impl<'py>(py: Python<'py>, pid: &B<'py>) -> PyResult<B<'py>> {
    if le_zero(py, pid)? {
        return Ok(bl(py, false));
    }
    let is_nt = eq(py, &own(py, "os")?.getattr("name")?, &ps(py, "nt"))?;
    if is_nt {
        pid_alive_nt(py, pid)
    } else {
        pid_alive_posix(py, pid)
    }
}

#[pyfunction]
#[pyo3(signature = (*args, **kwargs))]
fn _pid_alive<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let slots = bind_call("_pid_alive", &["pid"], 1, &[], args, kwargs)?;
    pid_alive_impl(py, slots[0].as_ref().unwrap())
}

// ── _read_lock (instance_lock.py:71) ────────────────────────────────────────

fn read_lock_impl<'py>(py: Python<'py>, path: &B<'py>) -> PyResult<B<'py>> {
    let attempt = (|| -> PyResult<B<'py>> {
        let opened = builtins(py)?.getattr("open")?.call(
            (path,),
            Some(&kwargs(py, &[("encoding", &ps(py, "utf-8"))])?),
        )?;
        let data = {
            let enter = opened.getattr("__enter__");
            let fh = match enter {
                Err(e) => {
                    if e.is_instance_of::<PyAttributeError>(py) {
                        let nm = opened.get_type().getattr("__name__")?;
                        return Err(PyTypeError::new_err(format!(
                            "'{}' object does not support the context manager protocol",
                            nm.str()?.to_cow()?
                        )));
                    }
                    return Err(e);
                }
                Ok(m) => m.call0()?,
            };
            let json = own(py, "json")?;
            let r = json.call_method1("load", (&fh,));
            match r {
                Ok(v) => {
                    opened.call_method1("__exit__", (none(py), none(py), none(py)))?;
                    Ok(v)
                }
                Err(e) => {
                    let tp = e.get_type_bound(py);
                    let val = e.value_bound(py);
                    let sup = opened
                        .call_method1("__exit__", (&tp, val.as_any(), none(py)))?;
                    if sup.is_truthy()? {
                        // the with-block completed without ever binding `data`,
                        // so the `return data if …` below reads an unbound local
                        Err(PyUnboundLocalError::new_err(
                            "local variable 'data' referenced before assignment",
                        ))
                    } else {
                        Err(e)
                    }
                }
            }
        };
        let data = data?;
        let dict_cls = builtins(py)?.getattr("dict")?;
        if inst(py, &data, &dict_cls)? {
            Ok(data)
        } else {
            Ok(empty_dict(py))
        }
    })();
    match attempt {
        Ok(v) => Ok(v),
        Err(e) => {
            let jsondecode = own(py, "json")?.getattr("JSONDecodeError")?;
            if err_is(py, &e, &oserror(py)?) || err_is(py, &e, &jsondecode) {
                Ok(empty_dict(py))
            } else {
                Err(e)
            }
        }
    }
}

#[pyfunction]
#[pyo3(signature = (*args, **kwargs))]
fn _read_lock<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let slots = bind_call("_read_lock", &["path"], 1, &[], args, kwargs)?;
    read_lock_impl(py, slots[0].as_ref().unwrap())
}

// ── acquire (instance_lock.py:80) ───────────────────────────────────────────

/// `json.dumps({"pid": …, "component": …, "started_at": …, "argv0": …})`,
/// built in the literal's key order with the real builtins and modules.
fn build_payload<'py>(py: Python<'py>, component: &B<'py>) -> PyResult<B<'py>> {
    let osm = own(py, "os")?;
    // the literal's evaluation order is observable: pid, component,
    // started_at, argv0 - `os.getpid()` must be called before `int(time.time())`
    // can raise, and `sys.argv` is only read after both.
    let pid = osm.call_method0("getpid")?;
    let started = bi1(
        py,
        "int",
        &own(py, "time")?.call_method0("time")?,
    )?;
    let argv = own(py, "sys")?.getattr("argv")?;
    let argv0 = if argv.is_truthy()? {
        argv.get_item(0)?
    } else {
        ps(py, "")
    };
    let d = dict_of(
        py,
        &[
            ("pid", &pid),
            ("component", component),
            ("started_at", &started),
            ("argv0", &argv0),
        ],
    )?;
    Ok(own(py, "json")?.call_method1("dumps", (&d,))?)
}

/// `fd = os.open(path, O_CREAT|O_EXCL|O_WRONLY)` +
/// `with os.fdopen(fd, "w", encoding="utf-8") as fh: fh.write(payload)`.
fn exclusive_create<'py>(
    py: Python<'py>,
    path: &B<'py>,
    payload: &B<'py>,
) -> PyResult<()> {
    let osm = own(py, "os")?;
    let flags = op(
        py,
        "or_",
        &op(
            py,
            "or_",
            &osm.getattr("O_CREAT")?,
            &osm.getattr("O_EXCL")?,
        )?,
        &osm.getattr("O_WRONLY")?,
    )?;
    let fd = osm.call_method1("open", (path, &flags))?;
    let ctx = osm.call_method(
        "fdopen",
        (&fd, ps(py, "w")),
        Some(&kwargs(py, &[("encoding", &ps(py, "utf-8"))])?),
    )?;
    with_write(py, &ctx, payload)
}

/// `_state.update({"lock_path": path, "acquired": True})`.
fn arm_state<'py>(py: Python<'py>, path: &B<'py>) -> PyResult<()> {
    let st = own(py, "_state")?;
    let upd = dict_of(py, &[("lock_path", path), ("acquired", &bl(py, true))])?;
    st.call_method1("update", (&upd,))?;
    Ok(())
}

fn acquire_body<'py>(
    py: Python<'py>,
    db_dir: &B<'py>,
    component: &B<'py>,
    path: &B<'py>,
    info: &B<'py>,
) -> PyResult<B<'py>> {
    let osm = own(py, "os")?;
    osm.call_method(
        "makedirs",
        (db_dir,),
        Some(&kwargs(py, &[("exist_ok", &bl(py, true))])?),
    )?;
    let payload = build_payload(py, component)?;

    // 先快速路径：文件不存在时 O_EXCL 直接成功。
    match exclusive_create(py, path, &payload) {
        Ok(()) => {
            arm_state(py, path)?;
            info.set_item("acquired", bl(py, true))?;
            return Ok(info.clone());
        }
        Err(e) if e.is_instance_of::<PyFileExistsError>(py) => {}
        Err(e) => return Err(e),
    }

    let existing = own(py, "_read_lock")?.call1((path,))?;
    let pid = bi1(
        py,
        "int",
        &orv(&gget(py, &existing, "pid")?, &obj(py, 0)?)?,
    )?;

    if eq(py, &pid, &osm.call_method0("getpid")?)? {
        // 本进程已持有这把锁：如实拒绝，并把 pid 写进原因。
        info.set_item(
            "reason",
            concat(
                py,
                vec![
                    ps(py, "lock already held by this process (pid="),
                    fmtv(py, &pid)?,
                    ps(py, ")"),
                ],
            )?,
        )?;
        info.set_item(
            "existing",
            dict_of(
                py,
                &[
                    ("pid", &pid),
                    ("startedAt", &gget(py, &existing, "started_at")?),
                    ("argv0", &gget(py, &existing, "argv0")?),
                ],
            )?,
        )?;
        return Ok(info.clone());
    }

    if pid.is_truthy()? && own(py, "_pid_alive")?.call1((&pid,))?.is_truthy()? {
        let second = own(py, "_read_lock")?.call1((path,))?;
        let started = gget_d(py, &second, "started_at", &ps(py, "?"))?;
        info.set_item(
            "reason",
            concat(
                py,
                vec![
                    ps(py, "另一个 "),
                    fmtv(py, component)?,
                    ps(py, " 进程正在运行（pid="),
                    fmtv(py, &pid)?,
                    ps(py, "，自 "),
                    fmtv(py, &started)?,
                    ps(py, " 起）"),
                ],
            )?,
        )?;
        info.set_item(
            "existing",
            dict_of(
                py,
                &[
                    ("pid", &pid),
                    ("startedAt", &gget(py, &existing, "started_at")?),
                    ("argv0", &gget(py, &existing, "argv0")?),
                ],
            )?,
        )?;
        return Ok(info.clone());
    }

    // 持锁者已死（或锁文件损坏）：接管。先删再建，中间仍有竞窗。
    match osm.call_method1("unlink", (path,)) {
        Ok(_) => {}
        Err(e) if err_is(py, &e, &oserror(py)?) => {
            info.set_item(
                "reason",
                concat(
                    py,
                    vec![
                        ps(py, "stale lock file could not be removed: "),
                        fmtv(py, &e.value_bound(py))?,
                    ],
                )?,
            )?;
            return Ok(info.clone());
        }
        Err(e) => return Err(e),
    }
    exclusive_create(py, path, &payload)?;
    arm_state(py, path)?;
    info.set_item("acquired", bl(py, true))?;
    info.set_item(
        "reason",
        concat(
            py,
            vec![
                ps(py, "took over stale lock from dead pid="),
                fmtv(py, &pid)?,
            ],
        )?,
    )?;
    Ok(info.clone())
}

fn acquire_impl<'py>(py: Python<'py>, db_dir: &B<'py>, component: &B<'py>) -> PyResult<B<'py>> {
    let path = own(py, "lock_path_for")?.call1((db_dir,))?;
    let info = dict_of(
        py,
        &[
            ("acquired", &bl(py, false)),
            ("lockPath", &path),
            ("reason", &ps(py, "")),
            ("existing", &none(py)),
        ],
    )?;
    if !db_dir.is_truthy()? {
        info.set_item("reason", ps(py, "no db_dir given"))?;
        return Ok(info);
    }
    let body = acquire_body(py, db_dir, component, &path, &info);
    match body {
        Ok(v) => Ok(v),
        Err(e) if is_py_exc(&e, py) => {
            info.set_item(
                "reason",
                concat(
                    py,
                    vec![
                        ps(py, "instance lock error: "),
                        fmtv(py, &e.value_bound(py))?,
                    ],
                )?,
            )?;
            Ok(info)
        }
        Err(e) => Err(e),
    }
}

#[pyfunction]
#[pyo3(signature = (*args, **kwargs))]
fn acquire<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let slots = bind_call("acquire", &["db_dir"], 1, &["component"], args, kwargs)?;
    let component = match slots[1].clone() {
        Some(v) => v,
        None => ps(py, "backend"),
    };
    acquire_impl(py, slots[0].as_ref().unwrap(), &component)
}

// ── release (instance_lock.py:151) ──────────────────────────────────────────

fn release_impl<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let st = own(py, "_state")?;
    let path = orv(&gget(py, &st, "lock_path")?, &ps(py, ""))?;
    let acquired = gget(py, &st, "acquired")?;
    if !path.is_truthy()? || !acquired.is_truthy()? {
        return Ok(bl(py, false));
    }
    match own(py, "os")?.call_method1("unlink", (&path,)) {
        Ok(_) => {
            st.set_item("acquired", bl(py, false))?;
            Ok(bl(py, true))
        }
        // §13: the flag stays set — the caller is told nothing more.
        Err(e) if err_is(py, &e, &oserror(py)?) => Ok(bl(py, false)),
        Err(e) => Err(e),
    }
}

#[pyfunction]
#[pyo3(signature = (*args, **kwargs))]
fn release<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    bind_call("release", &[], 0, &[], args, kwargs)?;
    release_impl(py)
}

// ── status (instance_lock.py:165) ───────────────────────────────────────────

fn status_impl<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let st = own(py, "_state")?;
    let path = orv(&gget(py, &st, "lock_path")?, &ps(py, ""))?;
    let out = dict_of(
        py,
        &[
            ("held", &bi1(py, "bool", &gget(py, &st, "acquired")?)?),
            ("lockPath", &path),
        ],
    )?;
    if path.is_truthy()? && !gget(py, &st, "acquired")?.is_truthy()? {
        let holder = own(py, "_read_lock")?.call1((&path,))?;
        if gget(py, &holder, "pid")?.is_truthy()? {
            out.set_item(
                "heldBy",
                dict_of(
                    py,
                    &[
                        ("pid", &gget(py, &holder, "pid")?),
                        ("startedAt", &gget(py, &holder, "started_at")?),
                    ],
                )?,
            )?;
        }
    }
    Ok(out)
}

#[pyfunction]
#[pyo3(signature = (*args, **kwargs))]
fn status<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    bind_call("status", &[], 0, &[], args, kwargs)?;
    status_impl(py)
}

// ── registration ────────────────────────────────────────────────────────────

/// Register the instance_lock submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(py, "instance_lock")?;
    for f in [
        "lock_path_for",
        "_pid_alive",
        "_read_lock",
        "acquire",
        "release",
        "status",
    ] {
        let obj = match f {
            "lock_path_for" => wrap_pyfunction!(lock_path_for, &m)?,
            "_pid_alive" => wrap_pyfunction!(_pid_alive, &m)?,
            "_read_lock" => wrap_pyfunction!(_read_lock, &m)?,
            "acquire" => wrap_pyfunction!(acquire, &m)?,
            "release" => wrap_pyfunction!(release, &m)?,
            _ => wrap_pyfunction!(status, &m)?,
        };
        m.add(f, obj)?;
    }

    m.add("LOCK_FILE_NAME", LOCK_NAME)?;
    // `_state: dict = {"lock_path": "", "acquired": False}` — a real dict in
    // the module dict, so conftest-style `clear()/update()` traffic lands on
    // the same object the functions read.
    m.add(
        "_state",
        dict_of(
            py,
            &[("lock_path", &ps(py, "")), ("acquired", &bl(py, false))],
        )?,
    )?;

    // the `import json/os/sys/time` of the python source, plus the
    // `from __future__ import annotations` name that shows up in `dir()`.
    for name in ["json", "os", "sys", "time"] {
        m.add(name, mod_import(py, name)?)?;
    }
    m.add(
        "annotations",
        mod_import(py, "__future__")?.getattr("annotations")?,
    )?;

    *ST.lock().unwrap() = Some(m.clone().unbind());
    parent.add_submodule(&m)?;
    Ok(())
}
