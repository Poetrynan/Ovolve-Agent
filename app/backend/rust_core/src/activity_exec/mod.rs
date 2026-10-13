//! activity_exec — Rust port of `app/backend/activity_exec.py`
//! (wave-2, Native→Rust, PyO3 submodule `ovolve_core.activity_exec`).
//!
//! The Python source is the "killable subprocess execution boundary" for
//! durable activities: execution-class taxonomy, a JSON-safe context stripper,
//! a callable-reference resolver, an autonomous-goal gate, a sentinel-line
//! result parser and the `run_sync_in_subprocess` spawn/timeout/kill-tree
//! driver.  Like `worker_sidecar` and `subprocess_isolation`, this port keeps
//! every value a LIVE CPython object and reaches each dependency (os, sys,
//! json, subprocess, tempfile, threading, asyncio, Result, and the module's
//! own globals) through the interpreter at call time, so a probe patching the
//! real modules is seen identically by both sides.
//!
//! Public surface (bug-for-bug, pinned by tmp/a1_probe_rs.py + a1_probe_py.py):
//! §1 constants EXEC_LOOP/THREAD/SUBPROCESS, CANCEL_COOPERATIVE/KILLABLE/
//!    ABANDONED_THREAD, KILL_GRACE_SEC = 3.0 (declared, never used by the
//!    source — kept as a declared constant, same as the source),
//!    _CHILD_SCRIPT, _RESULT_SENTINEL, ACTIVITY_* state machine names,
//!    ACTIVITY_TERMINAL_STATES (a frozenset), MAX_OUTPUT_CAP_BYTES = 512*1024.
//! §2 `resolve_callable_ref(fn)` — None-passes; truthy `__module__`/
//!    `__qualname__` + `"<" in qual` single-vote rejection (lambda qualname is
//!    `<lambda>`); `sys.modules.get(mod)` with a truthy `__file__`; segmentwise
//!    getattr walk (AttributeError -> None, everything else propagates); the
//!    `obj is not fn` identity veto (reassigned names).  Returns
//!    {"module": mod, "qualname": qual}.
//! §3 `json_safe(value, _depth=0)` — depth > 8 -> str(value)[:200]; None /
//!    bool / int / float / str pass through; dicts keep only keys that are
//!    str/int/float/bool or None, first 64 items, keys via str(k); lists/tuples/
//!    sets -> first 256 elements as a list; everything else repr(value)[:200].
//!    Recursion re-reads the module-global `json_safe` (rebinding-visible).
//! §4 `classify_execution(tool)` — explicit class, asyncio.iscoroutinefunction
//!    with the source's TypeError-only guard, resolve_callable_ref for the ref,
//!    the manages_own_killable_child / risk-lower / pure-computation cascade
//!    and the exact reason strings, incl. the `requires_subprocess and "…" or
//!    "…"` chain.
//! §5 `autonomous_goal_allows(tool, plan)` — plan["interruptible"] indexing
//!    (KeyError propagates), risk WITHOUT `.lower()` here (the source only
//!    lowercases in classify_execution — a preserved asymmetry, so "HIGH" is
//!    allowed), the autonomous_write_safe whitelist field, and the verbatim
//!    Chinese rejection string built from tool.name and plan["reason"].
//! §6 `run_sync_in_subprocess(fn_ref, args, context, *, timeout, call_id="",
//!    cwd=None)` — spec dict built with `dict(args or {})`/`json_safe`;
//!    NamedTemporaryFile(mode/suffix/delete=False/encoding/prefix) + with-enter
//!    + json.dump(ensure_ascii=False, default=str) + spec_path = fh.name +
//!    with-exit, all inside the source's `except Exception` ->
//!    "activity spec write failed: {exc}"; env = dict(os.environ) with
//!    PYTHONPATH = backend_dir + os.pathsep + old, rstripped, and
//!    PYTHONUNBUFFERED setdefault; the NT CREATE_NEW_PROCESS_GROUP |
//!    CREATE_NO_WINDOW vs start_new_session split; the cwd strip(' "\'') /
//!    isdir / isfile->dirname ladder with the getcwd try and the
//!    dirname(abspath(_CHILD_SCRIPT)) floor; Popen([sys.executable,
//!    _CHILD_SCRIPT, spec_path], stdout/stderr=PIPE, text, encoding, errors,
//!    cwd, env, **popen_kwargs) -> "activity spawn failed: {exc}" + spec
//!    cleanup; the conditional `from executors import track_child_process`
//!    (Exception-swallowed); budget = max(1.0, float(timeout or 60)) — which
//!    RAISES after the child is already spawned on a bad timeout (preserved
//!    defect: no kill, no cleanup, spec orphaned); threading.Event + the
//!    _on_deadline timer (kill via executors.kill_child_process, falling back
//!    to proc.kill()) + Timer(budget, fn).daemon=True.start(); communicate +
//!    the MAX_OUTPUT_CAP_BYTES char-cap truncations; the except-Exception
//!    communicate path (kill, then "activity communicate failed: {exc}" with
//!    effect_status unknown); the finally (killer.cancel, untrack by handle
//!    when call_id, _cleanup_spec); the three-state sentinel outcome ->
//!    Result.success(value, **meta) / Result.failure(str(error or "activity
//!    failed"), **meta) / the timeout / rc==0 / rc!=0 unknown-effect failures
//!    with the verbatim Chinese strings and `[-600:]` stderr tails.
//! §7 `_parse_result_line(stdout_text)` — last sentinel line wins, per-line
//!    find/strip/json.loads with the (JSONDecodeError, ValueError)-only
//!    continue, dict-only acceptance.
//! §8 `_cleanup_spec(spec_path)` — falsy-guarded os.unlink with the OSError
//!    swallow (TypeError from a non-str path PROPAGATES — preserved).
//!
//! DIVERGENCE(port, binding time): python binds os/sys/json/subprocess/
//!     tempfile/threading/asyncio/Result at import; the port mirrors each onto
//!     its own module dict at registration and re-reads the attribute live at
//!     every use (equivalence: same interpreter objects; the probe patches the
//!     real stdlib modules and/or the module globals on BOTH sides).
//! DIVERGENCE(port, Result availability): the source's import-time
//!     `from result import Result` cannot fail an PyO3 submodule without
//!     killing every sibling unit's ovolve_core import, so the port resolves
//!     `result.Result` lazily on first use and propagates the identical
//!     ModuleNotFoundError AT CALL time; the env-at-import probe pins this.
//! DIVERGENCE(port, _on_deadline): the source's nested closure becomes
//!     functools.partial over the module-visible `_on_deadline_impl`; the
//!     callable's identity is never observable in the parity table (only the
//!     actions it performs when the virtual deadline fires), and the probe
//!     drives it explicitly.
//! DIVERGENCE(port, `__future__` leftover): `from __future__ import
//!     annotations` binds the `annotations` __future__ feature only — not a
//!     module attribute, so nothing to reproduce.
//! DIVERGENCE(port, awaitables): none — the source has no coroutines; only the
//!     module docstrings describe the loop class.
//! Preserved source defects (never fixed): KILL_GRACE_SEC is defined but never
//!     used; classify_execution lowercases risk while autonomous_goal_allows
//!     does not; budget/Timer failures happen AFTER the child is spawned and
//!     leak the child + spec file; the communicate cap counts CHARACTERS in a
//!     variable named *_BYTES; a failing json.dump leaves the temp file
//!     behind (spec_path was never assigned, so _cleanup_spec cannot see it);
//!     the spec-write exception handler swallows the with-exit error chain.
// PORT STATUS: 本文件无 TODO(port)。

use parking_lot::Mutex;
use pyo3::exceptions::{PyAttributeError, PyException, PyTypeError};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList, PyModule, PyString, PyTuple};

use crate::cpy_call::{too_many_positional, unexpected_keyword};

type B<'py> = Bound<'py, PyAny>;

static ST: Mutex<Option<Py<PyModule>>> = Mutex::new(None);

// ── own-module globals (live reads so probe-side rebinding is honoured) ─────

fn own<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    let m: Option<Py<PyModule>> = ST.lock().as_ref().map(|p| p.clone_ref(py));
    match m {
        Some(p) => Ok(p.bind(py).getattr(name)?),
        None => Err(pyo3::exceptions::PyImportError::new_err(
            "activity_exec module not registered",
        )),
    }
}

fn builtins(py: Python<'_>) -> PyResult<Bound<'_, PyModule>> {
    Ok(py.import_bound("builtins")?)
}

fn bi<'py, A: pyo3::IntoPy<Py<PyTuple>>>(py: Python<'py>, name: &str, a: A) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr(name)?.call1(a)?)
}

fn bi1<'py>(py: Python<'py>, name: &str, x: &B<'py>) -> PyResult<B<'py>> {
    bi(py, name, (x,))
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

fn flt<'py>(py: Python<'py>, v: f64) -> PyResult<B<'py>> {
    Ok(pyo3::types::PyFloat::new_bound(py, v).into_any())
}

fn py_bool<'py>(py: Python<'py>, v: bool) -> B<'py> {
    builtins(py)
        .expect("builtins")
        .getattr(if v { "True" } else { "False" })
        .expect("bool")
}

fn op<'py>(py: Python<'py>, name: &str, a: &B<'py>, b: &B<'py>) -> PyResult<B<'py>> {
    Ok(py.import_bound("operator")?.getattr(name)?.call1((a, b))?)
}

fn opb<'py>(py: Python<'py>, name: &str, a: &B<'py>, b: &B<'py>) -> PyResult<bool> {
    Ok(op(py, name, a, b)?.is_truthy()?)
}

/// `b in a` — the `in` operator (sequence/substring/membership semantics).
fn contains<'py>(py: Python<'py>, a: &B<'py>, b: &B<'py>) -> PyResult<bool> {
    opb(py, "contains", a, b)
}

/// `x or default` — returns the original object when truthy.
fn orv<'py>(v: &B<'py>, def: &B<'py>) -> PyResult<B<'py>> {
    Ok(if v.is_truthy()? { v.clone() } else { def.clone() })
}

/// `slice(None, stop)` — the exact object behind `[:stop]`.
fn py_slice<'py>(py: Python<'py>, stop: &B<'py>) -> PyResult<B<'py>> {
    Ok(bi(py, "slice", (none(py), stop))?)
}

/// `slice(start, stop)` — the exact object behind `[start:stop]`.
fn py_slice2<'py>(py: Python<'py>, start: &B<'py>, stop: &B<'py>) -> PyResult<B<'py>> {
    Ok(bi(py, "slice", (start, stop))?)
}

/// `x[start:]`
fn islice_from<'py>(py: Python<'py>, x: &B<'py>, start: &B<'py>) -> PyResult<B<'py>> {
    x.get_item(py_slice2(py, start, &none(py))?)
}

/// `f"{v}"` — empty format spec, exactly what an f-string interpolation uses.
fn fmt0<'py>(py: Python<'py>, v: &B<'py>) -> PyResult<B<'py>> {
    Ok(bi(py, "format", (v, ps(py, "")))?)
}

/// `getattr(o, name, default)` — swallows ONLY AttributeError, like CPython.
fn ga<'py>(py: Python<'py>, o: &B<'py>, name: &str, default: &B<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("getattr")?.call1((o, ps(py, name), default))?)
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
    e.is_instance_of::<PyException>(py)
}

/// `isinstance(err, cls)` against a LIVE exception class.
fn err_is<'py>(py: Python<'py>, e: &PyErr, cls: &B<'py>) -> bool {
    e.is_instance_bound(py, cls)
}

/// `__import__("name", None, None, (fromlist...), 0)` — the from-import path.
fn from_import<'py>(py: Python<'py>, name: &str, item: &str) -> PyResult<B<'py>> {
    let m = bi(
        py,
        "__import__",
        (ps(py, name), py.None().into_bound(py), py.None().into_bound(py), PyTuple::new_bound(py, [ps(py, item)]).into_any(), obj(py, 0)?),
    )?;
    Ok(m)
}

fn from_import_getattr<'py>(py: Python<'py>, name: &str, item: &str) -> PyResult<B<'py>> {
    let m = from_import(py, name, item)?;
    Ok(m.getattr(item)?)
}

// ── call binding (cpy_call wording) ─────────────────────────────────────────

fn quoted_and(names: &[&str]) -> String {
    match names.len() {
        1 => format!("'{}'", names[0]),
        2 => format!("'{}' and '{}'", names[0], names[1]),
        n => {
            let head: Vec<String> = names[..n - 1].iter().map(|s| format!("'{}'", s)).collect();
            format!("{}, and '{}'", head.join(", "), names[n - 1])
        }
    }
}

fn fill_kwargs<'py>(
    fname: &str,
    pos_params: &[&str],
    kwonly: &[&str],
    slots: &mut Vec<Option<B<'py>>>,
    kw_slots: &mut Vec<Option<B<'py>>>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<()> {
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
                            fname, &key, pos_params,
                        )))
                    }
                },
            }
        }
    }
    Ok(())
}

fn missing_required(
    fname: &str,
    params: &[&str],
    required: usize,
    slots: &[Option<B<'_,>>],
    kind: &str,
) -> Option<PyErr> {
    let missing: Vec<&str> = params[..required]
        .iter()
        .enumerate()
        .filter(|(i, _)| slots[*i].is_none())
        .map(|(_, p)| *p)
        .collect();
    if missing.is_empty() {
        return None;
    }
    let phrase = match kind {
        "keyword-only" => "required keyword-only argument",
        _ => "required positional argument",
    };
    Some(PyTypeError::new_err(format!(
        "{}() missing {} {}{}: {}",
        fname,
        missing.len(),
        phrase,
        if missing.len() == 1 { "" } else { "s" },
        quoted_and(&missing)
    )))
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
    let mut dummy: Vec<Option<B<'py>>> = Vec::new();
    fill_kwargs(fname, params, &[], &mut slots, &mut dummy, kwargs)?;
    if nargs > total {
        return Err(PyTypeError::new_err(too_many_positional(
            fname, total, total - required, nargs,
        )));
    }
    if let Some(e) = missing_required(fname, params, required, &slots, "positional") {
        return Err(e);
    }
    Ok(slots)
}

/// `def f(a, b, *, kw1, kw2=D)` — positional tail + keyword-only tail.
fn bind_call_kw<'py>(
    fname: &str,
    pos_params: &[&str],
    required: usize,
    kwonly: &[&str],
    kw_required: usize,
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
    let mut kw_slots: Vec<Option<B<'py>>> = (0..kwonly.len()).map(|_| None).collect();
    fill_kwargs(fname, pos_params, kwonly, &mut slots, &mut kw_slots, kwargs)?;
    if nargs > total {
        return Err(PyTypeError::new_err(too_many_positional(
            fname, total, total - required, nargs,
        )));
    }
    if let Some(e) = missing_required(fname, pos_params, required, &slots, "positional") {
        return Err(e);
    }
    if let Some(e) = missing_required(fname, kwonly, kw_required, &kw_slots, "keyword-only") {
        return Err(e);
    }
    Ok((slots, kw_slots))
}

fn kw_or<'py, F: FnOnce() -> PyResult<B<'py>>>(slot: &Option<B<'py>>, def: F) -> PyResult<B<'py>> {
    match slot {
        Some(v) => Ok(v.clone()),
        None => def(),
    }
}

// ── §2 resolve_callable_ref ─────────────────────────────────────────────────

fn resolve_callable_ref_impl<'py>(py: Python<'py>, fn_: &B<'py>) -> PyResult<B<'py>> {
    if fn_.is_none() {
        return Ok(none(py));
    }
    let module_name = ga(py, fn_, "__module__", &none(py))?;
    let qualname = ga(py, fn_, "__qualname__", &none(py))?;
    if !(module_name.is_truthy()? && qualname.is_truthy()?) {
        return Ok(none(py));
    }
    if contains(py, &qualname, &ps(py, "<"))? {
        return Ok(none(py));
    }
    let modules = own(py, "sys")?.getattr("modules")?;
    let module = modules.call_method1("get", (module_name.clone(),))?;
    if module.is_none() || !(ga(py, &module, "__file__", &none(py))?.is_truthy()?) {
        return Ok(none(py));
    }
    let parts: Vec<B<'py>> = qualname
        .call_method1("split", (ps(py, "."),))?
        .iter()?
        .collect::<Result<Vec<_>, _>>()?;
    let getattr_fn = builtins(py)?.getattr("getattr")?;
    let mut obj = module;
    for part in parts {
        obj = match getattr_fn.call1((obj, part)) {
            Ok(o) => o,
            Err(e) => {
                if e.is_instance_of::<PyAttributeError>(py) {
                    return Ok(none(py));
                }
                return Err(e);
            }
        };
    }
    if obj.as_ptr() != fn_.as_ptr() {
        return Ok(none(py));
    }
    let d = PyDict::new_bound(py);
    d.set_item("module", module_name)?;
    d.set_item("qualname", qualname)?;
    Ok(d.into_any())
}

// ── §3 json_safe ────────────────────────────────────────────────────────────

fn json_safe_impl<'py>(py: Python<'py>, value: &B<'py>, depth: &B<'py>) -> PyResult<B<'py>> {
    let eight = obj(py, 8)?;
    if opb(py, "gt", depth, &eight)? {
        let s = bi1(py, "str", value)?;
        return s.get_item(py_slice(py, &obj(py, 200)?)?);
    }
    if value.is_none()
        || value.is_instance_of::<pyo3::types::PyBool>()
        || value.is_instance_of::<pyo3::types::PyInt>()
        || value.is_instance_of::<pyo3::types::PyFloat>()
        || value.is_instance_of::<PyString>()
    {
        return Ok(value.clone());
    }
    if value.is_instance_of::<PyDict>() {
        let items = bi1(py, "list", &value.call_method0("items")?)?;
        let capped = items.get_item(py_slice(py, &obj(py, 64)?)?)?;
        let out = PyDict::new_bound(py);
        for pair in capped.iter()? {
            let pair = pair?;
            let k = pair.get_item(0)?;
            let v = pair.get_item(1)?;
            let key_ok = k.is_instance_of::<PyString>()
                || k.is_instance_of::<pyo3::types::PyInt>()
                || k.is_instance_of::<pyo3::types::PyFloat>()
                || k.is_instance_of::<pyo3::types::PyBool>()
                || k.is_none();
            if !key_ok {
                continue;
            }
            // python evaluates the comprehension key `str(k)` before the value
            // expression `json_safe(v, _depth + 1)`.
            let ks = k.str()?;
            let vd = op(py, "add", depth, &obj(py, 1)?)?;
            let safe = own(py, "json_safe")?.call1((v, vd))?;
            out.set_item(ks, safe)?;
        }
        return Ok(out.into_any());
    }
    if value.is_instance_of::<PyList>()
        || value.is_instance_of::<PyTuple>()
        || value.is_instance_of::<pyo3::types::PySet>()
    {
        let l = bi1(py, "list", value)?;
        let capped = l.get_item(py_slice(py, &obj(py, 256)?)?)?;
        let out = PyList::empty_bound(py);
        for v in capped.iter()? {
            let vd = op(py, "add", depth, &obj(py, 1)?)?;
            let safe = own(py, "json_safe")?.call1((v?, vd))?;
            out.append(safe)?;
        }
        return Ok(out.into_any());
    }
    let r = value.repr()?;
    Ok(r.get_item(py_slice(py, &obj(py, 200)?)?)?)
}

// ── §4 classify_execution ───────────────────────────────────────────────────

fn classify_execution_impl<'py>(py: Python<'py>, tool: &B<'py>) -> PyResult<B<'py>> {
    let explicit_src = ga(py, tool, "execution_class", &ps(py, ""))?;
    let explicit = if explicit_src.is_truthy()? {
        explicit_src
    } else {
        ps(py, "")
    };
    let explicit = explicit.call_method0("strip")?;
    let exec_fn = ga(py, tool, "execute", &none(py))?;
    let is_async: B<'py> = match own(py, "asyncio")?
        .call_method1("iscoroutinefunction", (exec_fn.clone(),))
    {
        Ok(v) => v,
        Err(e) => {
            let te = builtins(py)?.getattr("TypeError")?;
            if err_is(py, &e, &te) {
                py_bool(py, false)
            } else {
                return Err(e);
            }
        }
    };
    let ref_: B<'py> = if is_async.is_truthy()? {
        none(py)
    } else {
        own(py, "resolve_callable_ref")?.call1((exec_fn.clone(),))?
    };

    let exec_loop = own(py, "EXEC_LOOP")?;
    let exec_thread = own(py, "EXEC_THREAD")?;
    let exec_subprocess = own(py, "EXEC_SUBPROCESS")?;
    let cancel_coop = own(py, "CANCEL_COOPERATIVE")?;
    let cancel_kill = own(py, "CANCEL_KILLABLE")?;
    let cancel_abandon = own(py, "CANCEL_ABANDONED_THREAD")?;

    let d = PyDict::new_bound(py);
    let explicit_is_loop = opb(py, "eq", &explicit, &exec_loop)?;
    if explicit_is_loop || is_async.is_truthy()? {
        d.set_item("class", exec_loop)?;
        d.set_item("contract", cancel_coop)?;
        d.set_item("interruptible", py_bool(py, true))?;
        d.set_item("ref", none(py))?;
        let reason = if explicit_is_loop {
            "explicit loop override"
        } else {
            "native coroutine"
        };
        d.set_item("reason", ps(py, reason))?;
        return Ok(d.into_any());
    }
    if opb(py, "eq", &explicit, &exec_thread)? {
        let managed = ga(py, tool, "manages_own_killable_child", &py_bool(py, false))?;
        let managed_again =
            ga(py, tool, "manages_own_killable_child", &py_bool(py, false))?;
        d.set_item("class", exec_thread)?;
        let contract = if managed.is_truthy()? {
            cancel_kill
        } else {
            cancel_abandon
        };
        d.set_item("contract", contract)?;
        d.set_item("interruptible", managed_again)?;
        d.set_item("ref", none(py))?;
        d.set_item("reason", ps(py, "explicit thread execution class"))?;
        return Ok(d.into_any());
    }
    if ga(py, tool, "manages_own_killable_child", &py_bool(py, false))?.is_truthy()? {
        d.set_item("class", exec_thread)?;
        d.set_item("contract", cancel_kill)?;
        d.set_item("interruptible", py_bool(py, true))?;
        d.set_item("ref", none(py))?;
        d.set_item("reason", ps(py, "manages own killable child command"))?;
        return Ok(d.into_any());
    }

    let risk_src = ga(py, tool, "risk_level", &ps(py, "low"))?;
    let risk = bi1(py, "str", &risk_src)?.call_method0("lower")?;
    let pure_flag = ga(py, tool, "pure_computation", &py_bool(py, false))?;
    let is_pure: B<'py> = if pure_flag.is_truthy()? {
        pure_flag
    } else {
        let low = opb(py, "eq", &risk, &ps(py, "low"))?;
        if !low {
            py_bool(py, false)
        } else {
            py_bool(py, !ga(py, tool, "has_side_effects", &py_bool(py, false))?.is_truthy()?)
        }
    };
    // python: `if ref is not None and not is_pure_computation:` — the two
    // isolation branches fire when is_pure is FALSEY; the final fallthrough
    // is the pure/short-sync case.
    let not_pure = !is_pure.is_truthy()?;
    let ref_none = ref_.is_none();

    if !ref_none && not_pure {
        d.set_item("class", exec_subprocess)?;
        d.set_item("contract", cancel_kill)?;
        d.set_item("interruptible", py_bool(py, true))?;
        d.set_item("ref", ref_)?;
        let req = ga(py, tool, "requires_subprocess", &py_bool(py, false))?;
        let reason = if req.is_truthy()? {
            "declared requires_subprocess"
        } else {
            "sync tool isolated in durable subprocess activity"
        };
        d.set_item("reason", ps(py, reason))?;
        return Ok(d.into_any());
    }
    if ref_none && not_pure {
        d.set_item("class", exec_thread)?;
        d.set_item("contract", cancel_abandon)?;
        d.set_item("interruptible", py_bool(py, false))?;
        d.set_item("ref", none(py))?;
        d.set_item("reason", ps(py, "callable not resolvable in a fresh interpreter"))?;
        return Ok(d.into_any());
    }
    d.set_item("class", exec_thread)?;
    d.set_item("contract", cancel_abandon)?;
    d.set_item("interruptible", py_bool(py, false))?;
    d.set_item("ref", none(py))?;
    d.set_item(
        "reason",
        ps(py, "pure computation or short sync callable on worker thread"),
    )?;
    Ok(d.into_any())
}

// ── §5 autonomous_goal_allows ───────────────────────────────────────────────

fn autonomous_goal_allows_impl<'py>(
    py: Python<'py>,
    tool: &B<'py>,
    plan: &B<'py>,
) -> PyResult<B<'py>> {
    let interruptible = plan.get_item("interruptible")?;
    if interruptible.is_truthy()? {
        return Ok(PyTuple::new_bound(py, [py_bool(py, true), ps(py, "")]).into_any());
    }
    let risk_src = ga(py, tool, "risk_level", &ps(py, "low"))?;
    let risk = bi1(py, "str", &risk_src)?;
    let levels = PyTuple::new_bound(
        py,
        [ps(py, "medium"), ps(py, "high"), ps(py, "critical")],
    );
    if !contains(py, &levels.into_any(), &risk)? {
        return Ok(PyTuple::new_bound(py, [py_bool(py, true), ps(py, "")]).into_any());
    }
    if ga(py, tool, "autonomous_write_safe", &py_bool(py, false))?.is_truthy()? {
        return Ok(PyTuple::new_bound(py, [py_bool(py, true), ps(py, "")]).into_any());
    }
    let name = fmt0(py, &tool.getattr("name")?)?;
    let reason = fmt0(py, &plan.get_item("reason")?)?;
    let mut msg = String::from("工具 `");
    msg.push_str(&name.extract::<String>()?);
    msg.push_str("` 是不可中断的线程内写操作（");
    msg.push_str(&reason.extract::<String>()?);
    msg.push_str("），不允许在自主目标中执行：暂停无法保证它真的停下来。请改用可中断的等价工具，或把这一步交给用户手动确认。");
    Ok(PyTuple::new_bound(py, [py_bool(py, false), ps(py, &msg)]).into_any())
}

// ── §7 _parse_result_line ───────────────────────────────────────────────────

fn parse_result_line_impl<'py>(py: Python<'py>, stdout_text: &B<'py>) -> PyResult<B<'py>> {
    if !stdout_text.is_truthy()? {
        return Ok(none(py));
    }
    let sentinel = own(py, "_RESULT_SENTINEL")?;
    let lines: Vec<B<'py>> = stdout_text
        .call_method0("splitlines")?
        .iter()?
        .collect::<Result<Vec<_>, _>>()?;
    let ve = builtins(py)?.getattr("ValueError")?;
    let jsonm = own(py, "json")?;
    for raw_line in lines.iter().rev() {
        let idx = raw_line.call_method1("find", (sentinel.clone(),))?;
        if opb(py, "lt", &idx, &obj(py, 0)?)? {
            continue;
        }
        let start = op(py, "add", &idx, &bi1(py, "len", &sentinel)?)?;
        let blob = islice_from(py, raw_line, &start)?.call_method0("strip")?;
        let data: B<'py> = match jsonm.call_method1("loads", (blob,)) {
            Ok(d) => d,
            Err(e) => {
                if err_is(py, &e, &ve) {
                    continue;
                }
                return Err(e);
            }
        };
        if data.is_instance_of::<PyDict>() {
            return Ok(data);
        }
    }
    Ok(none(py))
}

// ── §8 _cleanup_spec ────────────────────────────────────────────────────────

fn cleanup_spec_impl<'py>(py: Python<'py>, spec_path: &B<'py>) -> PyResult<B<'py>> {
    if !spec_path.is_truthy()? {
        return Ok(none(py));
    }
    let r = own(py, "os")?.call_method1("unlink", (spec_path,));
    match r {
        Ok(_) => Ok(none(py)),
        Err(e) => {
            let oe = builtins(py)?.getattr("OSError")?;
            if err_is(py, &e, &oe) {
                Ok(none(py))
            } else {
                Err(e)
            }
        }
    }
}

// ── §6 run_sync_in_subprocess ───────────────────────────────────────────────

/// The source's `_on_deadline` closure (see DIVERGENCE(port, _on_deadline)).
#[pyfunction]
#[pyo3(signature = (timed_out, proc))]
#[pyo3(name = "_on_deadline_impl")]
fn py_on_deadline_impl<'py>(
    py: Python<'py>,
    timed_out: &Bound<'py, PyAny>,
    proc: &Bound<'py, PyAny>,
) -> PyResult<PyObject> {
    timed_out.call_method0("set")?;
    let r: PyResult<()> = (|| -> PyResult<()> {
        let f = from_import_getattr(py, "executors", "kill_child_process")?;
        f.call1((proc,))?;
        Ok(())
    })();
    if let Err(e) = r {
        if !is_py_exc(&e, py) {
            return Err(e);
        }
        let kr = proc.call_method0("kill");
        if let Err(e2) = kr {
            if !is_py_exc(&e2, py) {
                return Err(e2);
            }
        }
    }
    Ok(py.None())
}

/// `from result import Result` — registration binds the attribute eagerly when
/// the backend tree is importable; otherwise the attribute is missing and the
/// first call resolves it lazily, propagating the identical ModuleNotFound-
/// Error wording at call time (DIVERGENCE(port, Result availability)).
fn get_result_cls<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    match own(py, "Result") {
        Ok(cls) => Ok(cls),
        Err(e) if e.is_instance_of::<PyAttributeError>(py) => {
            let res = py.import_bound("result")?;
            let cls = res.getattr("Result")?;
            if let Some(m) = ST.lock().as_ref() {
                let _ = m.bind(py).setattr("Result", cls.clone());
            }
            Ok(cls)
        }
        Err(e) => Err(e),
    }
}

fn result_call<'py>(
    py: Python<'py>,
    which: &str,
    first: B<'py>,
    kw: &Bound<'py, PyDict>,
) -> PyResult<B<'py>> {
    let cls = get_result_cls(py)?;
    Ok(cls.call_method(which, (first,), Some(kw))?)
}

fn run_sync_impl<'py>(
    py: Python<'py>,
    fn_ref: &B<'py>,
    args: &B<'py>,
    context: &B<'py>,
    timeout: &B<'py>,
    call_id: &B<'py>,
    cwd: &B<'py>,
) -> PyResult<B<'py>> {
    let nn = none(py);
    // ── spec = {"module":…, "qualname":…, "args":…, "context":…} ───────────
    let js = own(py, "json_safe")?;
    let dict_b = builtins(py)?.getattr("dict")?;
    let args_or = if args.is_truthy()? { args.clone() } else { PyDict::new_bound(py).into_any() };
    let args_safe = js.call1((dict_b.call1((args_or,))?,))?;
    let ctx_or = if context.is_truthy()? { context.clone() } else { PyDict::new_bound(py).into_any() };
    let ctx_safe = js.call1((dict_b.call1((ctx_or,))?,))?;
    let spec = PyDict::new_bound(py);
    spec.set_item("module", fn_ref.get_item("module")?)?;
    spec.set_item("qualname", fn_ref.get_item("qualname")?)?;
    spec.set_item("args", args_safe)?;
    spec.set_item("context", ctx_safe)?;

    // ── temp spec file (the source's `with NamedTemporaryFile(...)`) ───────
    let sec: PyResult<B<'py>> = (|| -> PyResult<B<'py>> {
        let tf_kw = kwargs_of(
            py,
            vec![
                ("mode", ps(py, "w")),
                ("suffix", ps(py, ".json")),
                ("delete", py_bool(py, false)),
                ("encoding", ps(py, "utf-8")),
                ("prefix", ps(py, "activity-spec-")),
            ],
        );
        let t = own(py, "tempfile")?.call_method("NamedTemporaryFile", (), Some(&tf_kw))?;
        let fh = t.call_method0("__enter__")?;
        let body: PyResult<B<'py>> = (|| -> PyResult<B<'py>> {
            let dump_kw = kwargs_of(
                py,
                vec![
                    ("ensure_ascii", py_bool(py, false)),
                    ("default", builtins(py)?.getattr("str")?),
                ],
            );
            own(py, "json")?.call_method(
                "dump",
                (spec.clone(), fh.clone()),
                Some(&dump_kw),
            )?;
            Ok(fh.getattr("name")?)
        })();
        // python's `with` hands __exit__ the live exception triple, and the
        // driver records that third slot as an opaque traceback object (a
        // `null` there is observable), so the traceback is recovered from the
        // exception instance's own `__traceback__` — the identical object
        // CPython installs there when it raises.
        let (et, ev, etb) = match &body {
            Ok(_) => (nn.clone(), nn.clone(), nn.clone()),
            Err(e) => {
                let v: B<'py> = e.value_bound(py).as_any().clone();
                let cls = v.getattr("__class__").unwrap_or_else(|_| nn.clone());
                let tb = v.getattr("__traceback__").unwrap_or_else(|_| nn.clone());
                (cls, v, tb)
            }
        };
        let ex = fh.call_method("__exit__", (et, ev, etb), None);
        match (body, ex) {
            (Ok(v), Ok(_)) => Ok(v),
            (_, Err(e)) => Err(e),
            (Err(e), Ok(_)) => Err(e),
        }
    })();
    let spec_path: B<'py> = match sec {
        Ok(p) => p,
        Err(e) => {
            if !is_py_exc(&e, py) {
                return Err(e);
            }
            let kw = PyDict::new_bound(py);
            let msg = op(
                py,
                "add",
                &ps(py, "activity spec write failed: "),
                &fmt0(py, &e.value_bound(py))?,
            )?;
            return result_call(py, "failure", msg, &kw);
        }
    };

    // ── env ────────────────────────────────────────────────────────────────
    let osm = own(py, "os")?;
    let env = dict_b.call1((osm.getattr("environ")?,))?;
    let env: Bound<'py, PyDict> = env.downcast_into()?;
    let pathmod = osm.getattr("path")?;
    let child_script = own(py, "_CHILD_SCRIPT")?;
    let backend_dir = pathmod.call_method1("dirname", (child_script,))?;
    let pathsep = osm.getattr("pathsep")?;
    let old_pp = env.call_method1("get", (ps(py, "PYTHONPATH"), ps(py, "")))?;
    let joined = op(py, "add", &op(py, "add", &backend_dir, &pathsep)?, &old_pp)?;
    let stripped = joined.call_method1("rstrip", (pathsep,))?;
    env.set_item("PYTHONPATH", stripped)?;
    env.call_method1("setdefault", (ps(py, "PYTHONUNBUFFERED"), ps(py, "1")))?;

    // ── popen_kwargs (the os.name split) ───────────────────────────────────
    let subprocess_m = own(py, "subprocess")?;
    let popen_kwargs = PyDict::new_bound(py);
    if opb(py, "eq", &osm.getattr("name")?, &ps(py, "nt"))? {
        let cg = subprocess_m.getattr("CREATE_NEW_PROCESS_GROUP")?;
        let cn = subprocess_m.getattr("CREATE_NO_WINDOW")?;
        popen_kwargs.set_item("creationflags", op(py, "or_", &cg, &cn)?)?;
    } else {
        popen_kwargs.set_item("start_new_session", py_bool(py, true))?;
    }

    // ── cwd ladder ─────────────────────────────────────────────────────────
    let mut valid_cwd = nn.clone();
    if cwd.is_truthy()? && cwd.is_instance_of::<PyString>() {
        let clean = cwd.call_method1("strip", (ps(py, " \"'"),))?;
        if clean.is_truthy()? && pathmod.call_method1("isdir", (&clean,))?.is_truthy()? {
            valid_cwd = clean;
        } else if clean.is_truthy()? && pathmod.call_method1("isfile", (&clean,))?.is_truthy()? {
            valid_cwd = pathmod.call_method1("dirname", (&clean,))?;
        }
    }
    let bad_cwd = |vc: &B<'py>| -> PyResult<bool> {
        Ok(!vc.is_truthy()? || !pathmod.call_method1("isdir", (vc,))?.is_truthy()?)
    };
    if bad_cwd(&valid_cwd)? {
        let r: PyResult<()> = (|| -> PyResult<()> {
            let cur = osm.call_method0("getcwd")?;
            if cur.is_truthy()? && pathmod.call_method1("isdir", (&cur,))?.is_truthy()? {
                valid_cwd = cur;
            }
            Ok(())
        })();
        if let Err(e) = r {
            if !is_py_exc(&e, py) {
                return Err(e);
            }
            valid_cwd = nn.clone();
        }
    }
    if bad_cwd(&valid_cwd)? {
        let abs = pathmod.call_method1("abspath", (own(py, "_CHILD_SCRIPT")?,))?;
        valid_cwd = pathmod.call_method1("dirname", (&abs,))?;
    }

    // ── Popen ──────────────────────────────────────────────────────────────
    let argv = PyList::new_bound(
        py,
        vec![
            own(py, "sys")?.getattr("executable")?,
            own(py, "_CHILD_SCRIPT")?,
            spec_path.clone(),
        ],
    );
    let kw = PyDict::new_bound(py);
    kw.set_item("stdout", subprocess_m.getattr("PIPE")?)?;
    kw.set_item("stderr", subprocess_m.getattr("PIPE")?)?;
    kw.set_item("text", py_bool(py, true))?;
    kw.set_item("encoding", ps(py, "utf-8"))?;
    kw.set_item("errors", ps(py, "replace"))?;
    kw.set_item("cwd", valid_cwd)?;
    kw.set_item("env", env)?;
    for (k, v) in popen_kwargs.iter() {
        kw.set_item(k, v)?;
    }
    let proc: B<'py> = match subprocess_m.call_method("Popen", (argv,), Some(&kw)) {
        Ok(p) => p,
        Err(e) => {
            if !is_py_exc(&e, py) {
                return Err(e);
            }
            own(py, "_cleanup_spec")?.call1((spec_path.clone(),))?;
            let kwe = PyDict::new_bound(py);
            let msg = op(
                py,
                "add",
                &ps(py, "activity spawn failed: "),
                &fmt0(py, &e.value_bound(py))?,
            )?;
            return result_call(py, "failure", msg, &kwe);
        }
    };

    if call_id.is_truthy()? {
        let r: PyResult<()> = (|| -> PyResult<()> {
            let m = from_import(py, "executors", "track_child_process")?;
            m.getattr("track_child_process")?.call1((call_id.clone(), proc.clone()))?;
            Ok(())
        })();
        if let Err(e) = r {
            if !is_py_exc(&e, py) {
                return Err(e);
            }
        }
    }

    // ── budget / deadline timer ────────────────────────────────────────────
    let to = if timeout.is_truthy()? { timeout.clone() } else { obj(py, 60)? };
    let fv = bi1(py, "float", &to)?;
    let budget = bi(py, "max", (flt(py, 1.0)?, fv))?;
    let th = own(py, "threading")?;
    let timed_out = th.call_method0("Event")?;
    let fn_dl = py
        .import_bound("functools")?
        .call_method1("partial", (own(py, "_on_deadline_impl")?, timed_out.clone(), proc.clone()))?;
    let killer = th.call_method1("Timer", (budget.clone(), fn_dl))?;
    killer.setattr("daemon", py_bool(py, true))?;
    killer.call_method0("start")?;

    let run_finally = |py: Python<'py>| -> PyResult<()> {
        killer.call_method0("cancel")?;
        if call_id.is_truthy()? {
            let r: PyResult<()> = (|| -> PyResult<()> {
                let m = from_import(py, "executors", "untrack_child_process")?;
                m.getattr("untrack_child_process")?
                    .call1((call_id.clone(), proc.clone()))?;
                Ok(())
            })();
            if let Err(e) = r {
                if !is_py_exc(&e, py) {
                    return Err(e);
                }
            }
        }
        own(py, "_cleanup_spec")?.call1((spec_path.clone(),))?;
        Ok(())
    };

    // ── communicate (try / except Exception / finally) ─────────────────────
    // python initialises stdout_data/stderr_data = "", "" before the try, but
    // every path that reaches the code below the try/finally assigns them
    // first — a plain deferred binding reproduces the observable behaviour.
    let stdout_data: B<'py>;
    let stderr_data: B<'py>;
    let comm = proc.call_method0("communicate");
    if let Err(e) = comm {
        // the except-Exception arm (or a BaseException, which only the finally
        // still intercepts)
        if is_py_exc(&e, py) {
            let kr: PyResult<()> = (|| -> PyResult<()> {
                let m = from_import(py, "executors", "kill_child_process")?;
                m.getattr("kill_child_process")?.call1((proc.clone(),))?;
                Ok(())
            })();
            if let Err(e2) = kr {
                if !is_py_exc(&e2, py) {
                    run_finally(py)?;
                    return Err(e2);
                }
            }
            let kfw = kwargs_of(
                py,
                vec![
                    ("effect_status", ps(py, "unknown")),
                    ("call_id", call_id.clone()),
                ],
            );
            let msg = op(
                py,
                "add",
                &ps(py, "activity communicate failed: "),
                &fmt0(py, &e.value_bound(py))?,
            )?;
            let failv = result_call(py, "failure", msg, &kfw)?;
            run_finally(py)?;
            return Ok(failv);
        }
        run_finally(py)?;
        return Err(e);
    }
    let body: PyResult<(B<'py>, B<'py>)> = (|| -> PyResult<(B<'py>, B<'py>)> {
        let pair = comm.unwrap();
        let o = pair.get_item(0)?;
        let e = pair.get_item(1)?;
        let cap = own(py, "MAX_OUTPUT_CAP_BYTES")?;
        let o = if opb(py, "gt", &bi1(py, "len", &o)?, &cap)? {
            let head = o.get_item(py_slice(py, &cap)?)?;
            op(py, "add", &head, &ps(py, "\n...[stdout truncated at output cap]..."))?
        } else {
            o
        };
        let e = if opb(py, "gt", &bi1(py, "len", &e)?, &cap)? {
            let head = e.get_item(py_slice(py, &cap)?)?;
            op(py, "add", &head, &ps(py, "\n...[stderr truncated at output cap]..."))?
        } else {
            e
        };
        Ok((o, e))
    })();
    match body {
        Ok((o, e)) => {
            stdout_data = o;
            stderr_data = e;
        }
        Err(e1) => {
            if !is_py_exc(&e1, py) {
                run_finally(py)?;
                return Err(e1);
            }
            let kr: PyResult<()> = (|| -> PyResult<()> {
                let m = from_import(py, "executors", "kill_child_process")?;
                m.getattr("kill_child_process")?.call1((proc.clone(),))?;
                Ok(())
            })();
            if let Err(e2) = kr {
                if !is_py_exc(&e2, py) {
                    run_finally(py)?;
                    return Err(e2);
                }
            }
            let kfw = kwargs_of(
                py,
                vec![
                    ("effect_status", ps(py, "unknown")),
                    ("call_id", call_id.clone()),
                ],
            );
            let msg = op(
                py,
                "add",
                &ps(py, "activity communicate failed: "),
                &fmt0(py, &e1.value_bound(py))?,
            )?;
            let failv = result_call(py, "failure", msg, &kfw)?;
            run_finally(py)?;
            return Ok(failv);
        }
    }
    run_finally(py)?;

    // ── the three-state sentinel outcome ───────────────────────────────────
    let payload = own(py, "_parse_result_line")?.call1((stdout_data,))?;
    if !payload.is_none() {
        let meta = PyDict::new_bound(py);
        if call_id.is_truthy()? {
            meta.set_item("call_id", call_id.clone())?;
        }
        if payload.call_method1("get", (ps(py, "ok"),))?.is_truthy()? {
            let val = payload.call_method1("get", (ps(py, "value"),))?;
            return result_call(py, "success", val, &meta);
        }
        let ev = payload.call_method1("get", (ps(py, "error"),))?;
        let msg = bi1(py, "str", &orv(&ev, &ps(py, "activity failed"))?)?;
        return result_call(py, "failure", msg, &meta);
    }

    if timed_out.call_method0("is_set")?.is_truthy()? {
        let ib = bi1(py, "int", &budget)?;
        let mut msg = String::from("工具在子进程中超过 ");
        msg.push_str(&fmt0(py, &ib)?.extract::<String>()?);
        msg.push_str(" 秒未完成，进程树已被终止。它可能已经完成了部分工作——继续之前请先核对实际状态。");
        let kwf = kwargs_of(
            py,
            vec![
                ("effect_status", ps(py, "unknown")),
                ("timed_out", py_bool(py, true)),
                ("call_id", call_id.clone()),
            ],
        );
        return result_call(py, "failure", ps(py, &msg), &kwf);
    }

    let rc = proc.getattr("returncode")?;
    let se = if stderr_data.is_truthy()? { stderr_data.clone() } else { ps(py, "") };
    let tail_full = se.call_method0("strip")?;
    let tail = tail_full.get_item(py_slice2(py, &obj(py, -600)?, &nn)?)?;
    let tail_or = orv(&tail, &ps(py, "（空）"))?;
    let mut msg = String::new();
    if opb(py, "eq", &rc, &obj(py, 0)?)? {
        msg.push_str("子进程退出但没有回传结果（可能是 import 失败前的缓冲丢失）。stderr 尾部：");
        msg.push_str(&tail_or.extract::<String>()?);
    } else {
        msg.push_str("工具子进程异常退出（exit=");
        msg.push_str(&fmt0(py, &rc)?.extract::<String>()?);
        msg.push_str("）。stderr 尾部：");
        msg.push_str(&tail_or.extract::<String>()?);
    }
    let kwf = kwargs_of(
        py,
        vec![
            ("effect_status", ps(py, "unknown")),
            ("exit_code", rc),
            ("call_id", call_id.clone()),
        ],
    );
    result_call(py, "failure", ps(py, &msg), &kwf)
}

// ── pyfunction wrappers (python call-binding wording via cpy_call) ─────────

#[pyfunction]
#[pyo3(name = "resolve_callable_ref", signature = (*args, **kwargs))]
fn py_resolve_callable_ref<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("resolve_callable_ref", &["fn"], 1, args, kwargs)?;
    Ok(resolve_callable_ref_impl(py, slots[0].as_ref().expect("fn"))?.unbind())
}

#[pyfunction]
#[pyo3(name = "json_safe", signature = (*args, **kwargs))]
fn py_json_safe<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("json_safe", &["value", "_depth"], 1, args, kwargs)?;
    let depth = kw_or(&slots[1], || obj(py, 0))?;
    Ok(json_safe_impl(py, slots[0].as_ref().expect("value"), &depth)?.unbind())
}

#[pyfunction]
#[pyo3(name = "classify_execution", signature = (*args, **kwargs))]
fn py_classify_execution<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("classify_execution", &["tool"], 1, args, kwargs)?;
    Ok(classify_execution_impl(py, slots[0].as_ref().expect("tool"))?.unbind())
}

#[pyfunction]
#[pyo3(name = "autonomous_goal_allows", signature = (*args, **kwargs))]
fn py_autonomous_goal_allows<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call(
        "autonomous_goal_allows",
        &["tool", "plan"],
        2,
        args,
        kwargs,
    )?;
    Ok(autonomous_goal_allows_impl(
        py,
        slots[0].as_ref().expect("tool"),
        slots[1].as_ref().expect("plan"),
    )?
    .unbind())
}

#[pyfunction]
#[pyo3(name = "run_sync_in_subprocess", signature = (*args, **kwargs))]
fn py_run_sync_in_subprocess<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let (slots, kw) = bind_call_kw(
        "run_sync_in_subprocess",
        &["fn_ref", "args", "context"],
        3,
        &["timeout", "call_id", "cwd"],
        1,
        args,
        kwargs,
    )?;
    let timeout = kw_or(&kw[0], || obj(py, 60))?;
    let call_id = kw_or(&kw[1], || Ok(ps(py, "")))?;
    let cwd = kw_or(&kw[2], || Ok(nn(py)))?;
    Ok(run_sync_impl(
        py,
        slots[0].as_ref().expect("fn_ref"),
        slots[1].as_ref().expect("args"),
        slots[2].as_ref().expect("context"),
        &timeout,
        &call_id,
        &cwd,
    )?
    .unbind())
}

fn nn<'py>(py: Python<'py>) -> B<'py> {
    none(py)
}

#[pyfunction]
#[pyo3(name = "_parse_result_line", signature = (*args, **kwargs))]
fn py_parse_result_line<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("_parse_result_line", &["stdout_text"], 1, args, kwargs)?;
    Ok(parse_result_line_impl(py, slots[0].as_ref().expect("stdout_text"))?.unbind())
}

#[pyfunction]
#[pyo3(name = "_cleanup_spec", signature = (*args, **kwargs))]
fn py_cleanup_spec<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("_cleanup_spec", &["spec_path"], 1, args, kwargs)?;
    Ok(cleanup_spec_impl(py, slots[0].as_ref().expect("spec_path"))?.unbind())
}

// ── registration ────────────────────────────────────────────────────────────

fn child_script_default(py: Python<'_>) -> PyResult<String> {
    // The source anchors the child script next to activity_exec.py.  The port
    // resolves the same directory from the `result` module (co-located in the
    // backend tree in production and in every guarded probe), then falls back
    // to OVOLVE_BACKEND_DIR so a deployment without a preloaded `result` still
    // resolves.  The observable value the parity table pins is the canonical
    // `os.path.join(dirname(abspath(activity_exec.__file__)), "_activity_child.py")`.
    if let Ok(res) = py.import_bound("result") {
        if let Ok(f) = res.getattr("__file__") {
            if let Ok(s) = f.extract::<String>() {
                let dir = std::path::Path::new(&s)
                    .parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();
                return Ok(join_os(&dir, "_activity_child.py"));
            }
        }
    }
    if let Ok(dir) = std::env::var("OVOLVE_BACKEND_DIR") {
        return Ok(join_os(&dir, "_activity_child.py"));
    }
    Ok(join_os("", "_activity_child.py"))
}

fn join_os(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        return name.to_string();
    }
    let sep = if dir.ends_with('\\') || dir.ends_with('/') { "" } else { "\\" };
    format!("{}{}{}", dir, sep, name)
}

pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(py, "activity_exec")?;
    *ST.lock() = Some(m.clone().unbind());

    // import-time surface: the source's `import`s are module attributes here,
    // so own() re-reads exactly what the python module's globals hold.
    m.add("asyncio", py.import_bound("asyncio")?)?;
    m.add("json", py.import_bound("json")?)?;
    m.add("os", py.import_bound("os")?)?;
    m.add("subprocess", py.import_bound("subprocess")?)?;
    m.add("sys", py.import_bound("sys")?)?;
    m.add("tempfile", py.import_bound("tempfile")?)?;
    m.add("threading", py.import_bound("threading")?)?;
    // `from result import Result` is resolved lazily (DIVERGENCE note above);
    // try eagerly so production has the attribute at import like the source,
    // but never let it fail the shared extension's import.
    if let Ok(res) = py.import_bound("result") {
        if let Ok(r) = res.getattr("Result") {
            m.add("Result", r)?;
        }
    }

    m.add("EXEC_LOOP", "loop")?;
    m.add("EXEC_THREAD", "thread")?;
    m.add("EXEC_SUBPROCESS", "subprocess")?;
    m.add("CANCEL_COOPERATIVE", "cooperative_cancel")?;
    m.add("CANCEL_KILLABLE", "killable_subprocess")?;
    m.add("CANCEL_ABANDONED_THREAD", "abandoned_thread")?;
    m.add("KILL_GRACE_SEC", 3.0)?;
    m.add("_CHILD_SCRIPT", child_script_default(py)?)?;
    m.add("_RESULT_SENTINEL", "@@ACTIVITY_RESULT@@")?;
    m.add("ACTIVITY_CREATED", "created")?;
    m.add("ACTIVITY_PREFLIGHTING", "preflighting")?;
    m.add("ACTIVITY_WAITING_APPROVAL", "waiting_approval")?;
    m.add("ACTIVITY_RUNNING", "running")?;
    m.add("ACTIVITY_STOPPING", "stopping")?;
    m.add("ACTIVITY_COMPLETED", "completed")?;
    m.add("ACTIVITY_FAILED", "failed")?;
    m.add("ACTIVITY_CANCELLED", "cancelled")?;
    m.add("ACTIVITY_TIMEOUT", "timeout")?;
    m.add("ACTIVITY_UNKNOWN_EFFECT", "unknown_effect")?;
    m.add("ACTIVITY_STOP_TIMEOUT", "stop_timeout")?;
    let term = PyList::new_bound(
        py,
        [
            "completed",
            "failed",
            "cancelled",
            "timeout",
            "unknown_effect",
            "stop_timeout",
        ],
    );
    m.add(
        "ACTIVITY_TERMINAL_STATES",
        bi1(py, "frozenset", &term.into_any())?,
    )?;
    m.add("MAX_OUTPUT_CAP_BYTES", 512 * 1024)?;

    m.add_function(wrap_pyfunction!(py_resolve_callable_ref, &m)?)?;
    m.add_function(wrap_pyfunction!(py_json_safe, &m)?)?;
    m.add_function(wrap_pyfunction!(py_classify_execution, &m)?)?;
    m.add_function(wrap_pyfunction!(py_autonomous_goal_allows, &m)?)?;
    m.add_function(wrap_pyfunction!(py_run_sync_in_subprocess, &m)?)?;
    m.add_function(wrap_pyfunction!(py_parse_result_line, &m)?)?;
    m.add_function(wrap_pyfunction!(py_cleanup_spec, &m)?)?;
    m.add_function(wrap_pyfunction!(py_on_deadline_impl, &m)?)?;

    parent.add_submodule(&m)?;
    Ok(())
}

// PORT STATUS: 本文件无 TODO(port)。
