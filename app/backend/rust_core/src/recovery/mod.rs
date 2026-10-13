//! recovery — Rust port of `app/backend/recovery.py` (wave-6, Native→Rust).
//!
//! What happens to in-flight work when the process dies: demote stranded goals
//! to `paused` and say so in the ledger, mirror reaped orphan sub-agents into
//! the ledger, and render the two continuation-prompt advisories ("already
//! landed, do NOT redo" / "outcome unknown, verify first").
//!
//! Port posture (device_fingerprint / goal_plan / effects precedent): every
//! value flows as a live CPython object. `storage.list_goals()`,
//! `update_goal_fields()`, `reap_goal_claim()`, `release_goal()`,
//! `completed_side_effects()`, `unknown_side_effects()` and
//! `get_event_store()` are issued against the caller's object; `TraceGateway`,
//! `EventType`, `OBSERVATIONAL`, `log` and `_MAX_ADVISORY_ENTRIES` are read from
//! this module's own dict at call time; `import effects` inside
//! `_verdict_suffix` goes through `builtins.__import__`; `str()`/`format()`/
//! `getattr()`/`len()`/`slice` are the real builtins; `or`, `in`, `-` and `>`
//! are real operators; `[:8]`, `[:_MAX_ADVISORY_ENTRIES]` and `[-1]` are real
//! slices; `{**g, ...}` is a real dict merge. So exception types and messages,
//! dict key insertion order, f-string piece order, `.get` call counts and the
//! recorded storage/gateway/logger traffic match the canonical implementation by
//! construction, not by re-derivation.
//!
//! Bug-for-bug items kept verbatim (each pinned by smoke/parity_recovery.py):
//! §1 `auto_resume` is a DEAD parameter: `recover_interrupted_goals` never reads
//!    it, so passing an object whose `__bool__` raises changes nothing - yet the
//!    argument is still bound, so a wrong keyword still errors.
//! §2 `gateway.append(...)` failing is logged and execution FALLS THROUGH: the
//!    ledger write may be lost, yet the goal still lands in the returned
//!    `demoted` list (there is no `continue` in that except arm).
//! §3 the `except AttributeError` arm (older storage without generation-aware
//!    reaping) also falls through to the ledger append and the `demoted.append`,
//!    unlike the generic `except Exception` arm which `continue`s. So an
//!    `AttributeError` out of `storage.update_goal_fields` itself - not only out
//!    of `reap_goal_claim` - takes the fallback path and still reports the goal
//!    as demoted.
//! §4 `gid = g.get("id") or ""` then `if not gid: continue`: id 0, "", False,
//!    None or any other falsy value skips the row; a truthy non-str id is kept
//!    UNCHANGED (never coerced) and flows into `update_goal_fields`, the
//!    idempotency f-string and the payload.
//! §5 `status` is read with `.get` TWICE per kept row - once in the filter, once
//!    for `from_status = g.get("status") or "running"` - and skipped rows pay
//!    only the first, so `.get` counts are per-row-branch observable.
//! §6 `from_status` is `... or "running"`, unreachable for the filter's four
//!    statuses (all truthy) but still evaluated; `can_auto_resume` is exactly
//!    `from_status in ("running", "queued")`.
//! §7 the demoted entry is `{**g, "from_status":…, "can_auto_resume":…}`: the
//!    original row's key order comes FIRST and these two keys OVERWRITE same-
//!    named keys from the row, while every other value (including the row's own
//!    `status`, which still says "running") is shared by reference.
//! §8 `render_completed_side_effects` slices the call id WITHOUT `str()`
//!    (`r.get('call_id', '?')[:8]`) while `render_unknown_side_effects` wraps it
//!    in `str()`: a non-str, non-sliceable call_id raises TypeError out of the
//!    first and works in the second. `args_hash` is str()-ed in both.
//! §9 the advisory cap is read from the module global at FOUR points (slice
//!    bound, `>` comparison, subtraction, and the subtraction only runs when the
//!    comparison passed), and `len(rows)` is called again for the tail line.
//! §10 `_verdict_suffix`'s `try` covers ONLY `import effects` + `reconcile`:
//!     `rec["status"]` is evaluated outside it, so a missing key (KeyError), a
//!     non-subscriptable `rec` (TypeError) escape through
//!     `render_unknown_side_effects` to the caller.
//! §11 `kind`/`target` are BOTH computed (`str(row.get(...) or "")`) before
//!     `if not (kind and target)`, so two `.get`s and two `str()`s happen even
//!     for a row that is about to be rejected.
//! §12 `GIT_KINDS` is read with `getattr(effects, "GIT_KINDS", ())` AFTER
//!     reconcile has already run, and only then consulted, so a missing
//!     attribute silently keeps the file-wording labels rather than failing. The
//!     bound name `effects` comes from the ONE `import` inside the try, so no
//!     second `__import__` happens per row.
//! §13 both label tables are dict literals looked up with `.get(status, "")`, so
//!     an unexpected `rec["status"]` yields "" and the function returns ""
//!     instead of raising; the git table REPLACES the file table wholesale.
//! §14 `short = target.rsplit("/", 1)[-1] or target` splits on FORWARD slash
//!     only, so a Windows path keeps its whole text, and an empty last field
//!     falls back to the full target.
//! §15 `record_reaped_subagents` returns 0 before constructing the gateway when
//!     `rows` is falsy, so an empty list never calls `get_event_store`.
//! §16 `row.get('subagent_id', '')` runs TWICE per row (payload, then the
//!     idempotency f-string) and `row.get("subagent_id")` a THIRD time - with no
//!     default - only on the failure path, as a `log.exception` argument.
//! §17 `session_id` is `parent or child or "subagents"` on falsiness, so an
//!     empty-string parent falls through to the child.
//! §18 `render_*_side_effects`'s `except Exception: return ""` guards ONLY the
//!     storage call: a `rows` whose `__len__`/`__getitem__`/iteration raises, or
//!     a row that is not a dict, escapes (there is no per-row try in either).
//! §19 `if not rows: return ""` is truthiness, so a rows object with a raising
//!     `__bool__`/`__len__` escapes rather than returning "".
//! §20 the empty-string returns are `""`, the text is `"\n".join(lines)` with
//!     pieces appended in source order, and the git "landed" label is TWO
//!     adjacent string literals in python, i.e. one value.
//! §21 the overflow line is a SECOND `len(rows)` and a second read of
//!     `_MAX_ADVISORY_ENTRIES`: `if len(rows) > CAP` and then
//!     `f"... {len(rows) - CAP} ..."` — a rows object that instruments `__len__`
//!     (or a slice that swaps the cap) counts three calls in total, not one.
//! §22 `_verdict_suffix` uses ONE-argument `.get` everywhere (`row.get(k)` plus
//!     `or ""`), while both render loops use TWO-argument `.get` with the `'?'`
//!     / `''` defaults — the argument count is part of the observable traffic.
//!
//! DIVERGENCE(port, dependency binding): the canonical module binds `logging`,
//!     `EventType`, `TraceGateway` and `OBSERVATIONAL` once, at import time;
//!     this port holds the same objects as module attributes and reads them
//!     through its own dict at call time. Equivalent in every supported flow:
//!     production rebinds none of them, and a caller that patches
//!     `recovery.OBSERVATIONAL` is seen by BOTH sides, because python's global
//!     lookup and this port's `own()` hit the same dict slot.
//! DIVERGENCE(port, import cycle): `TraceGateway`, `OBSERVATIONAL` and
//!     `EventType` are NOT bound during `register()`; the module carries a
//!     PEP 562 `__getattr__` that resolves them from `trace_gateway` /
//!     `event_types` on first access and caches the objects into the same dict
//!     slots the eager binding would have used. Importing them at registration
//!     would make `import ovolve_core` re-enter the product's own import chain
//!     (`trace_gateway` -> `event_store` -> `rust_adapters` -> `ovolve_core`)
//!     and hit `AttributeError: partially initialized module 'trace_gateway'`,
//!     because the crate is loaded from inside that very cycle. Observable
//!     difference: `dir(recovery)` lists the three names only after the first
//!     access, and an import failure of those modules surfaces at that access
//!     rather than at `import recovery`. Every value is identical — the same
//!     singleton module objects, read once and cached — and all four callables
//!     are only ever reachable after the app's own imports have completed, so no
//!     production flow can observe the deferral. `logging` and `typing.List` stay
//!     eager: they are stdlib and cannot participate in that cycle.
//! DIVERGENCE(port, call grammar): pyo3's generated argument parser reports
//!     arity/keyword mistakes as `recovery.f() takes no arguments (1 given)` /
//!     `takes no keyword arguments`, where CPython's python-defined function
//!     says `f() takes 0 positional arguments but 1 was given` / `f() got an
//!     unexpected keyword argument 'x'`. [`bind_call`] reimplements CPython's
//!     message grammar AND its precedence (keywords in call order -> surplus
//!     positionals -> missing required), pinned by an 18-shape battery per
//!     function. Same fix as `cua_actions`' `bind_init`, extended from `__init__`
//!     (where self is counted) to plain functions (where it is not).
//! DIVERGENCE(port, `log` binding time): `log = logging.getLogger(__name__)`
//!     runs once at import; the port calls `logging.getLogger(<module __name__>)`
//!     during `register()` and stores the result as the module attribute `log`,
//!     so the logger object, its name and its level are exactly what the python
//!     module would have bound. Rebinding `recovery.log` afterwards is honoured
//!     by both sides (each reads the global).
//! DIVERGENCE(port, docstrings): crate-wide convention — the doc text lives in
//!     this header comment, so `__doc__` on the functions is not reproduced.
//!     Nothing in the repository reads `recovery.__doc__` (grep: the module is
//!     imported for its four public callables only).
//! DIVERGENCE(port, `__future__` leftover): `from __future__ import annotations`
//!     leaves the name `annotations` bound in the python module's namespace; the
//!     crate does not reproduce that leftover on any ported module, so
//!     `dir(recovery)` differs by that single dead name. No code path can read
//!     it (it exists only to switch the compiler's annotation behaviour).
// PORT STATUS: confidence=high todos=[0]

use parking_lot::Mutex;
use pyo3::exceptions::{PyAttributeError, PyImportError, PyTypeError};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList, PyString, PyTuple};

type B<'py> = Bound<'py, PyAny>;

/// the live `recovery` submodule, so `own()` reads the same dict that
/// `ovolve_core.recovery.__dict__` exposes to python.
static ST: Mutex<Option<Py<PyModule>>> = Mutex::new(None);

/// `_MAX_ADVISORY_ENTRIES` (recovery.py:43). The cap is re-read from the module
/// dict on every call, exactly like python's global lookup, so this constant is
/// only the seed value.
const ADVISORY_CAP: i64 = 20;

// ── own-module globals (python's late global lookup) ────────────────────────

fn own<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    let m: Option<Py<PyModule>> = ST.lock().as_ref().map(|p| p.clone_ref(py));
    match m {
        Some(p) => Ok(p.bind(py).getattr(name)?),
        None => Err(PyImportError::new_err("recovery module not registered")),
    }
}

// ── CPython-semantics helpers ───────────────────────────────────────────────

fn builtins(py: Python<'_>) -> PyResult<Bound<'_, PyModule>> {
    Ok(py.import_bound("builtins")?)
}

fn mod_import<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    Ok(py.import_bound(name)?.into_any())
}

/// `import effects` as the interpreter compiles it: `builtins.__import__(name)`,
/// looked up at call time, so a patched import hook is honoured on both sides.
fn imported<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    bi1(py, "__import__", &ps(py, name))
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

/// the interpreter's own `True` object (never a Rust bool).
fn true_obj<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("True")?)
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

/// real operator-module binary op — the exact protocol behind `a - b`, `a > b`,
/// `x in a`, … including reflected fallbacks.
fn op<'py>(py: Python<'py>, name: &str, a: &B<'py>, b: &B<'py>) -> PyResult<B<'py>> {
    Ok(py.import_bound("operator")?.getattr(name)?.call1((a, b))?)
}

fn gt<'py>(py: Python<'py>, a: &B<'py>, b: &B<'py>) -> PyResult<bool> {
    op(py, "gt", a, b)?.is_truthy()
}

/// `x in seq` — `operator.contains(seq, x)`, i.e. the same `PySequence_Contains`
/// the interpreter runs (which always yields a real bool).
fn contains_v<'py>(py: Python<'py>, seq: &B<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    op(py, "contains", seq, x)
}

fn contains<'py>(py: Python<'py>, seq: &B<'py>, x: &B<'py>) -> PyResult<bool> {
    Ok(contains_v(py, seq, x)?.is_truthy()?)
}

/// `x or y` (returns the ORIGINAL object when x is truthy).
fn orv<'py>(v: &B<'py>, def: &B<'py>) -> PyResult<B<'py>> {
    Ok(if v.is_truthy()? { v.clone() } else { def.clone() })
}

/// `f"{x}"` — the real `format(x, "")` an f-string compiles to.
fn fmtv<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("format")?.call1((x, ps(py, "")))?)
}

/// `"".join(pieces)` — assembles the pieces of an f-string in source order.
fn concat<'py>(py: Python<'py>, pieces: Vec<B<'py>>) -> PyResult<B<'py>> {
    let list = PyList::new_bound(py, pieces);
    Ok(ps(py, "").call_method1("join", (&list,))?)
}

/// `x[:stop]` with an arbitrary stop object (the live global, not an int).
fn slice_head<'py>(py: Python<'py>, x: &B<'py>, stop: &B<'py>) -> PyResult<B<'py>> {
    let sl = builtins(py)?.getattr("slice")?.call1((none(py), stop))?;
    x.get_item(sl)
}

/// `x[:8]`
fn head8<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    let stop = obj(py, 8)?;
    slice_head(py, x, &stop)
}

/// `x[-1]` — a real integer SUBSCRIPT, not `x[-1:]`: the latter yields a
/// one-element list and would stringify as `"['c.py']"`.
fn tail1<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    let from = obj(py, -1)?;
    x.get_item(&from)
}

/// python's `except Exception:` — BaseExceptions must propagate.
fn is_py_exc(e: &PyErr, py: Python<'_>) -> bool {
    e.is_instance_of::<pyo3::exceptions::PyException>(py)
}

/// a `{str: obj}` dict literal, inserted in the listed order.
fn dict_of<'py>(py: Python<'py>, items: &[(&str, &B<'py>)]) -> B<'py> {
    let d = PyDict::new_bound(py);
    for (k, v) in items {
        d.set_item(*k, (*v).clone()).expect("str key");
    }
    d.into_any()
}

/// a `{str: str}` dict literal, later looked up with the real `.get`.
fn str_map<'py>(py: Python<'py>, items: &[(&str, &str)]) -> B<'py> {
    let d = PyDict::new_bound(py);
    for (k, v) in items {
        d.set_item(*k, *v).expect("str key");
    }
    d.into_any()
}

fn kwargs_of<'py>(py: Python<'py>, items: &[(&str, &B<'py>)]) -> Bound<'py, PyDict> {
    let kw = PyDict::new_bound(py);
    for (k, v) in items {
        kw.set_item(*k, (*v).clone()).expect("str key");
    }
    kw
}

/// `table.get(key, "")` — the real `.get`, so an unhashable key raises from the
/// right place and a dict-subclass `get` override is honoured.
fn map_get<'py>(py: Python<'py>, table: &B<'py>, key: &B<'py>) -> PyResult<B<'py>> {
    Ok(table.call_method1("get", (key, ps(py, "")))?)
}

/// `x.get(key, default)` — real attribute lookup + call, so the number of `.get`
/// calls and the "default applies only when the key is ABSENT" semantics
/// survive on a dict subclass.
fn get2<'py>(py: Python<'py>, x: &B<'py>, key: &str, def: &str) -> PyResult<B<'py>> {
    Ok(x.call_method1("get", (ps(py, key), ps(py, def)))?)
}

fn get1<'py>(py: Python<'py>, x: &B<'py>, key: &str) -> PyResult<B<'py>> {
    Ok(x.call_method1("get", (ps(py, key),))?)
}

// ── CPython's plain-function call grammar ───────────────────────────────────

/// CPython binds a call to a python-defined function in the eval loop, so every
/// arity/keyword mistake reads `f() ...` with its own precedence: keywords are
/// consumed in CALL order (unexpected -> multiple values), surplus positionals
/// are reported after that, and missing required parameters last. pyo3's
/// generated parser hard-codes different text. The grammar below was read off
/// CPython 3.13 with tmp/rec_grammar.py (18 call shapes x 7 signatures).
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
    // positionals fill the first `min(nargs, total)` slots; surplus is reported
    // only after the keyword pass, which is what the interpreter does.
    for i in 0..std::cmp::min(nargs, total) {
        slots[i] = Some(args.get_item(i)?.clone().into_any());
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
                    return Err(PyTypeError::new_err(format!(
                        "{}() got an unexpected keyword argument '{}'",
                        fname, key
                    )))
                }
            };
            if slots[idx].is_some() {
                return Err(PyTypeError::new_err(format!(
                    "{}() got multiple values for argument '{}'",
                    fname, key
                )));
            }
            slots[idx] = Some(v);
        }
    }
    if nargs > total {
        let given = if nargs == 1 {
            "1 was given".to_string()
        } else {
            format!("{} were given", nargs)
        };
        let msg = if total == required {
            let noun = if total == 1 {
                "positional argument"
            } else {
                "positional arguments"
            };
            format!("{}() takes {} {} but {}", fname, total, noun, given)
        } else {
            format!(
                "{}() takes from {} to {} positional arguments but {}",
                fname, required, total, given
            )
        };
        return Err(PyTypeError::new_err(msg));
    }
    let missing: Vec<&str> = params[..required]
        .iter()
        .enumerate()
        .filter(|(i, _)| slots[*i].is_none())
        .map(|(_, p)| *p)
        .collect();
    if !missing.is_empty() {
        let listed = if missing.len() == 1 {
            format!("'{}'", missing[0])
        } else {
            let (last, rest) = missing.split_last().expect("len >= 2");
            let head: Vec<String> = rest.iter().map(|p| format!("'{}'", p)).collect();
            format!("{}, and '{}'", head.join(", "), last)
        };
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

/// `log.exception(msg)` / `log.exception(fmt, *args)` — the module-level logger,
/// read live so that patching `recovery.log` is visible on both sides.
fn log_exc<'py>(py: Python<'py>, msg: &str, args: &[B<'py>]) -> PyResult<()> {
    let handler = own(py, "log")?.getattr("exception")?;
    let mut items: Vec<PyObject> = Vec::with_capacity(1 + args.len());
    items.push(ps(py, msg).unbind());
    for a in args {
        items.push(a.clone().unbind());
    }
    let call_args = PyTuple::new_bound(py, items);
    handler.call(&call_args, None)?;
    Ok(())
}

// ── recover_interrupted_goals ───────────────────────────────────────────────

fn tuple_of<'py>(py: Python<'py>, items: &[&str]) -> B<'py> {
    let v: Vec<PyObject> = items.iter().map(|s| ps(py, s).unbind()).collect();
    PyTuple::new_bound(py, v).into_any()
}

/// def recover_interrupted_goals(storage, auto_resume=False) -> List[dict]
fn recover_interrupted_goals_impl<'py>(
    py: Python<'py>,
    storage: &B<'py>,
) -> PyResult<B<'py>> {
    // gateway = TraceGateway(storage.get_event_store()) — before the try, so a
    // raising event store escapes.
    let store = storage.call_method0("get_event_store")?;
    let gateway = own(py, "TraceGateway")?.call1((store,))?;
    let demoted = PyList::empty_bound(py);

    // stranded = [g for g in storage.list_goals() if g.get("status") in (...)]
    let listing: PyResult<Vec<B<'py>>> = (|| {
        let mut out: Vec<B<'py>> = Vec::new();
        let statuses = tuple_of(py, &["running", "queued", "stopping", "stop_timeout"]);
        let rows = storage.call_method0("list_goals")?;
        for g in rows.iter()? {
            let g = g?;
            if contains(py, &statuses, &get1(py, &g, "status")?)? {
                out.push(g);
            }
        }
        Ok(out)
    })();
    let stranded = match listing {
        Ok(v) => v,
        Err(e) if is_py_exc(&e, py) => {
            log_exc(
                py,
                "recovery: could not list goals — skipping goal recovery",
                &[],
            )?;
            return Ok(demoted.into_any());
        }
        Err(e) => return Err(e),
    };

    for g in stranded {
        // gid = g.get("id") or ""
        let raw_id = get1(py, &g, "id")?;
        let gid = orv(&raw_id, &ps(py, ""))?;
        if !gid.is_truthy()? {
            continue;
        }
        // from_status = g.get("status") or "running"  (second .get on this row)
        let status2 = get1(py, &g, "status")?;
        let from_status = orv(&status2, &ps(py, "running"))?;
        // can_auto_resume = from_status in ("running", "queued")
        let can_auto_resume =
            contains_v(py, &tuple_of(py, &["running", "queued"]), &from_status)?;

        let demote: PyResult<()> = (|| {
            storage.call_method(
                "update_goal_fields",
                (&gid,),
                Some(&kwargs_of(
                    py,
                    &[
                        ("status", &ps(py, "paused")),
                        ("last_error", &ps(py, "Interrupted by server restart")),
                    ],
                )),
            )?;
            storage.call_method1("reap_goal_claim", (&gid,))?;
            Ok(())
        })();
        match demote {
            Ok(()) => {}
            Err(e) if e.is_instance_of::<PyAttributeError>(py) => {
                // Older storage without generation-aware reaping: fall back to
                // the ownerless release. NOTE: no `continue` here (§3).
                let released: PyResult<()> =
                    storage.call_method1("release_goal", (&gid,)).map(|_| ());
                match released {
                    Ok(()) => {}
                    Err(e2) if is_py_exc(&e2, py) => {
                        log_exc(
                            py,
                            "recovery: claim release failed for goal %s",
                            &[gid.clone()],
                        )?;
                    }
                    Err(e2) => return Err(e2),
                }
            }
            Err(e) if is_py_exc(&e, py) => {
                log_exc(py, "recovery: failed to demote goal %s", &[gid.clone()])?;
                continue;
            }
            Err(e) => return Err(e),
        }

        // gateway.append(...) — kwargs evaluated in source order; a failure is
        // logged and execution still falls through to demoted.append() (§2).
        let appended: PyResult<B<'py>> = (|| {
            let session_id = orv(&get1(py, &g, "session_id")?, &gid)?;
            let event_type = own(py, "EventType")?.getattr("SYSTEM_RECOVERY_INITIATED")?;
            let payload = dict_of(
                py,
                &[
                    ("goal_id", &gid),
                    ("from_status", &from_status),
                    ("to_status", &ps(py, "paused")),
                    ("can_auto_resume", &can_auto_resume),
                    ("cause", &ps(py, "server restart")),
                ],
            );
            let key = concat(py, vec![ps(py, "recovery:goal:"), fmtv(py, &gid)?])?;
            gateway.call_method(
                "append",
                (),
                Some(&kwargs_of(
                    py,
                    &[
                        ("session_id", &session_id),
                        ("event_type", &event_type),
                        ("payload", &payload),
                        ("importance", &own(py, "OBSERVATIONAL")?),
                        ("idempotency_key", &key),
                        ("goal_id", &gid),
                        ("actor", &ps(py, "system")),
                    ],
                )),
            )
        })();
        match appended {
            Ok(_) => {}
            Err(e) if is_py_exc(&e, py) => {
                log_exc(py, "recovery: ledger write failed for goal %s", &[gid.clone()])?;
            }
            Err(e) => return Err(e),
        }

        // demoted.append({**g, "from_status":…, "can_auto_resume":…})
        let row = PyDict::new_bound(py);
        row.call_method1("update", (&g,))?;
        row.set_item("from_status", from_status)?;
        row.set_item("can_auto_resume", can_auto_resume)?;
        demoted.append(row.into_any())?;
    }
    Ok(demoted.into_any())
}

// ── record_reaped_subagents ─────────────────────────────────────────────────

/// def record_reaped_subagents(storage, rows: List[dict]) -> int
fn record_reaped_subagents_impl<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    rows: &B<'py>,
) -> PyResult<B<'py>> {
    if !rows.is_truthy()? {
        return obj(py, 0);
    }
    let store = storage.call_method0("get_event_store")?;
    let gateway = own(py, "TraceGateway")?.call1((store,))?;
    let mut written: i64 = 0;
    for row in rows.iter()? {
        let row = row?;
        let res: PyResult<()> = (|| {
            let parent = get1(py, &row, "parent_session_id")?;
            let child = get1(py, &row, "child_session_id")?;
            let session_id = orv(&parent, &orv(&child, &ps(py, "subagents"))?)?;
            let sid = get2(py, &row, "subagent_id", "")?;
            let payload = dict_of(
                py,
                &[
                    ("subagent_id", &sid),
                    ("subagent_type", &get2(py, &row, "subagent_type", "")?),
                    ("label", &get2(py, &row, "label", "")?),
                    ("cause", &ps(py, "Interrupted by server restart")),
                    ("reaped", &true_obj(py)?),
                ],
            );
            let key = concat(
                py,
                vec![
                    ps(py, "recovery:subagent:"),
                    fmtv(py, &get2(py, &row, "subagent_id", "")?)?,
                ],
            )?;
            gateway.call_method(
                "append",
                (),
                Some(&kwargs_of(
                    py,
                    &[
                        ("session_id", &session_id),
                        ("event_type", &own(py, "EventType")?.getattr("SUBAGENT_FAILED")?),
                        ("payload", &payload),
                        ("importance", &own(py, "OBSERVATIONAL")?),
                        ("idempotency_key", &key),
                        ("actor", &ps(py, "system")),
                    ],
                )),
            )?;
            Ok(())
        })();
        match res {
            Ok(()) => written += 1,
            Err(e) if is_py_exc(&e, py) => {
                let logged = get1(py, &row, "subagent_id")?;
                log_exc(
                    py,
                    "recovery: ledger write failed for subagent %s",
                    &[logged],
                )?;
            }
            Err(e) => return Err(e),
        }
    }
    obj(py, written)
}

// ── render_completed_side_effects ───────────────────────────────────────────

/// def render_completed_side_effects(goal_id: str, storage) -> str
fn render_completed_side_effects_impl<'py>(
    py: Python<'py>,
    goal_id: &B<'py>,
    storage: &B<'py>,
) -> PyResult<B<'py>> {
    let fetched: PyResult<B<'py>> = storage.call_method1("completed_side_effects", (goal_id,));
    let rows = match fetched {
        Ok(v) => v,
        Err(e) if is_py_exc(&e, py) => return Ok(ps(py, "")),
        Err(e) => return Err(e),
    };
    if !rows.is_truthy()? {
        return Ok(ps(py, ""));
    }
    let cap = own(py, "_MAX_ADVISORY_ENTRIES")?;
    let lines = PyList::empty_bound(py);
    lines.append(ps(
        py,
        "Side effects that already COMPLETED for this goal (do NOT redo them):",
    ))?;
    for r in slice_head(py, &rows, &cap)?.iter()? {
        let r = r?;
        // Each f-string field is FORMATTED as soon as its expression is
        // evaluated, exactly like the compiled bytecode, so a `__format__` /
        // `__str__` with side effects fires in the canonical order.
        let tool = get2(py, &r, "tool_name", "?")?;
        let ftool = fmtv(py, &tool)?;
        // §8: the call id is sliced WITHOUT str() here.
        let call = head8(py, &get2(py, &r, "call_id", "?")?)?;
        let fcall = fmtv(py, &call)?;
        let ah_raw = get2(py, &r, "args_hash", "")?;
        let ah_str = bi1(py, "str", &ah_raw)?;
        let args = head8(py, &ah_str)?;
        let fargs = fmtv(py, &args)?;
        let line = concat(
            py,
            vec![
                ps(py, "  - "),
                ftool,
                ps(py, " (call "),
                fcall,
                ps(py, ", args#"),
                fargs,
                ps(py, ")"),
            ],
        )?;
        lines.append(line)?;
    }
    let n = bi1(py, "len", &rows)?;
    if gt(py, &n, &cap)? {
        // §21: the canonical tail line re-reads BOTH names and calls `len(rows)`
        // a second time — `len(rows) > CAP` and then `len(rows) - CAP` — so a
        // container that counts its own `__len__` sees two calls, not one.
        let n2 = bi1(py, "len", &rows)?;
        let cap2 = own(py, "_MAX_ADVISORY_ENTRIES")?;
        let more = op(py, "sub", &n2, &cap2)?;
        let fm = fmtv(py, &more)?;
        lines.append(concat(
            py,
            vec![ps(py, "  ... and "), fm, ps(py, " more")],
        )?)?;
    }
    let nl = ps(py, "\n");
    Ok(join_lines(&nl, &lines)?)
}

fn join_lines<'py>(
    sep: &B<'py>,
    lines: &Bound<'py, PyList>,
) -> PyResult<B<'py>> {
    Ok(sep.call_method1("join", (lines,))?)
}

// ── _verdict_suffix ─────────────────────────────────────────────────────────

fn file_labels<'py>(py: Python<'py>) -> B<'py> {
    str_map(
        py,
        &[
            (
                "landed",
                "现场核对：目标**已经是**这次要写成的样子——重做等于写第二遍",
            ),
            (
                "not_started",
                "现场核对：目标与动手前逐字节相同——可以放心重做一次",
            ),
            (
                "conflict",
                "现场核对：目标变成了第三种样子（中间被别人改过）——先读再决定，别覆盖",
            ),
            (
                "unknown",
                "现场核对：证据不足，无法判断是否已生效",
            ),
        ],
    )
}

fn git_labels<'py>(py: Python<'py>) -> B<'py> {
    str_map(
        py,
        &[
            (
                "landed",
                "现场核对：这次 git 操作**已经生效**（提交已在 HEAD／已推到远端）——重做会多一次",
            ),
            (
                "not_started",
                "现场核对：HEAD 和暂存区与动手前一致——这一步没做成，可以重做",
            ),
            (
                "conflict",
                "现场核对：仓库被别人动过（HEAD 不是我们这次的提交）——先看 git log 再决定",
            ),
            (
                "unknown",
                "现场核对：证据不足，无法判断这次 git 操作是否已生效",
            ),
        ],
    )
}

/// def _verdict_suffix(row: dict) -> str
fn verdict_suffix<'py>(py: Python<'py>, row: &B<'py>) -> PyResult<B<'py>> {
    // §11: both sides of the guard are computed BEFORE the test, and each is
    // `str(row.get(k) or "")` — a ONE-argument `.get` (no default), so the
    // recorded call carries one argument on both sides.
    let ek = get1(py, row, "effect_kind")?;
    let kind = bi1(py, "str", &orv(&ek, &ps(py, ""))?)?;
    let tg = get1(py, row, "target")?;
    let target = bi1(py, "str", &orv(&tg, &ps(py, ""))?)?;
    if !(kind.is_truthy()? && target.is_truthy()?) {
        return Ok(ps(py, ""));
    }
    // the try covers ONLY the import + the reconcile call (§10), and the two
    // hash stringifications are arguments to reconcile, so a raising `.get` or
    // `__str__` on them is swallowed here exactly as python swallows it.
    let probed: PyResult<(B<'py>, B<'py>)> = (|| {
        let effects = imported(py, "effects")?;
        // the callable part is resolved BEFORE the arguments are built, exactly
        // like `LOAD effects / LOAD_ATTR reconcile / <args> / CALL`: a module
        // without `reconcile` therefore never reaches the two hash `.get`s.
        let fun = effects.getattr("reconcile")?;
        let pre_raw = get1(py, row, "pre_hash")?;
        let pre = bi1(py, "str", &orv(&pre_raw, &ps(py, ""))?)?;
        let plan_raw = get1(py, row, "planned_hash")?;
        let planned = bi1(py, "str", &orv(&plan_raw, &ps(py, ""))?)?;
        let rec = fun.call1((&kind, &target, &pre, &planned))?;
        Ok((effects, rec))
    })();
    let (effects, rec) = match probed {
        Ok(v) => v,
        Err(e) if is_py_exc(&e, py) => return Ok(ps(py, "")),
        Err(e) => return Err(e),
    };

    // OUTSIDE the try: a missing key escapes the whole render.
    let status = rec.get_item(ps(py, "status"))?;
    let file_table = file_labels(py);
    let mut label = map_get(py, &file_table, &status)?;
    // §12: GIT_KINDS is consulted only after reconcile ran.
    let git_kinds = call_bi(
        py,
        "getattr",
        (&effects, ps(py, "GIT_KINDS"), &tuple_of(py, &[])),
    )?;
    if contains(py, &git_kinds, &kind)? {
        let git_table = git_labels(py);
        label = map_get(py, &git_table, &status)?;
    }
    if !label.is_truthy()? {
        return Ok(ps(py, ""));
    }
    let sep = ps(py, "/");
    let maxsplit = obj(py, 1)?;
    let parts = target.call_method1("rsplit", (&sep, &maxsplit))?;
    let last = tail1(py, &parts)?;
    let short = orv(&last, &target)?;
    let fl = fmtv(py, &label)?;
    let fs = fmtv(py, &short)?;
    concat(
        py,
        vec![
            ps(py, "\n      "),
            fl,
            ps(py, "（"),
            fs,
            ps(py, "）"),
        ],
    )
}

// ── render_unknown_side_effects ─────────────────────────────────────────────

/// def render_unknown_side_effects(goal_id: str, storage) -> str
fn render_unknown_side_effects_impl<'py>(
    py: Python<'py>,
    goal_id: &B<'py>,
    storage: &B<'py>,
) -> PyResult<B<'py>> {
    let fetched: PyResult<B<'py>> = storage.call_method1("unknown_side_effects", (goal_id,));
    let rows = match fetched {
        Ok(v) => v,
        Err(e) if is_py_exc(&e, py) => return Ok(ps(py, "")),
        Err(e) => return Err(e),
    };
    if !rows.is_truthy()? {
        return Ok(ps(py, ""));
    }
    let cap = own(py, "_MAX_ADVISORY_ENTRIES")?;
    let lines = PyList::empty_bound(py);
    lines.append(ps(py, "状态未知：可能已生效，续跑前请先核对，不要直接重做："))?;
    for r in slice_head(py, &rows, &cap)?.iter()? {
        let r = r?;
        // expression/format interleaving as in `render_completed_side_effects`;
        // `_verdict_suffix(r)` is the LAST thing evaluated, because it is the
        // right-hand operand of the `+` that follows the whole f-string.
        let tool = get2(py, &r, "tool_name", "?")?;
        let ftool = fmtv(py, &tool)?;
        let cid_raw = get2(py, &r, "call_id", "?")?;
        let cid_str = bi1(py, "str", &cid_raw)?;
        let call = head8(py, &cid_str)?;
        let fcall = fmtv(py, &call)?;
        let ah_raw = get2(py, &r, "args_hash", "")?;
        let ah_str = bi1(py, "str", &ah_raw)?;
        let args = head8(py, &ah_str)?;
        let fargs = fmtv(py, &args)?;
        let status = get2(py, &r, "status", "?")?;
        let fstatus = fmtv(py, &status)?;
        let suffix = verdict_suffix(py, &r)?;
        let line = concat(
            py,
            vec![
                ps(py, "  - "),
                ftool,
                ps(py, " (call "),
                fcall,
                ps(py, ", args#"),
                fargs,
                ps(py, ", "),
                fstatus,
                ps(py, ")"),
                suffix,
            ],
        )?;
        lines.append(line)?;
    }
    let n = bi1(py, "len", &rows)?;
    if gt(py, &n, &cap)? {
        // §21: the canonical tail line re-reads BOTH names and calls `len(rows)`
        // a second time — `len(rows) > CAP` and then `len(rows) - CAP` — so a
        // container that counts its own `__len__` sees two calls, not one.
        let n2 = bi1(py, "len", &rows)?;
        let cap2 = own(py, "_MAX_ADVISORY_ENTRIES")?;
        let more = op(py, "sub", &n2, &cap2)?;
        let fm = fmtv(py, &more)?;
        lines.append(concat(
            py,
            vec![ps(py, "  ... 另有 "), fm, ps(py, " 条")],
        )?)?;
    }
    let nl = ps(py, "\n");
    Ok(join_lines(&nl, &lines)?)
}

// ── python-visible wrappers ─────────────────────────────────────────────────

#[pyfunction]
#[pyo3(name = "recover_interrupted_goals", signature = (*args, **kwargs))]
fn py_recover_interrupted_goals<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call(
        "recover_interrupted_goals",
        &["storage", "auto_resume"],
        1,
        args,
        kwargs,
    )?;
    // §1: `auto_resume` is bound but never read by the canonical body.
    let storage = slots[0].as_ref().expect("validated by bind_call");
    Ok(recover_interrupted_goals_impl(py, storage)?.unbind())
}

#[pyfunction]
#[pyo3(name = "record_reaped_subagents", signature = (*args, **kwargs))]
fn py_record_reaped_subagents<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call(
        "record_reaped_subagents",
        &["storage", "rows"],
        2,
        args,
        kwargs,
    )?;
    let storage = slots[0].as_ref().expect("validated by bind_call");
    let rows = slots[1].as_ref().expect("validated by bind_call");
    Ok(record_reaped_subagents_impl(py, storage, rows)?.unbind())
}

#[pyfunction]
#[pyo3(name = "render_completed_side_effects", signature = (*args, **kwargs))]
fn py_render_completed_side_effects<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call(
        "render_completed_side_effects",
        &["goal_id", "storage"],
        2,
        args,
        kwargs,
    )?;
    let goal_id = slots[0].as_ref().expect("validated by bind_call");
    let storage = slots[1].as_ref().expect("validated by bind_call");
    Ok(render_completed_side_effects_impl(py, goal_id, storage)?.unbind())
}

#[pyfunction]
#[pyo3(name = "render_unknown_side_effects", signature = (*args, **kwargs))]
fn py_render_unknown_side_effects<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call(
        "render_unknown_side_effects",
        &["goal_id", "storage"],
        2,
        args,
        kwargs,
    )?;
    let goal_id = slots[0].as_ref().expect("validated by bind_call");
    let storage = slots[1].as_ref().expect("validated by bind_call");
    Ok(render_unknown_side_effects_impl(py, goal_id, storage)?.unbind())
}

#[pyfunction]
#[pyo3(name = "_verdict_suffix", signature = (*args, **kwargs))]
fn py_verdict_suffix<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("_verdict_suffix", &["row"], 1, args, kwargs)?;
    let row = slots[0].as_ref().expect("validated by bind_call");
    Ok(verdict_suffix(py, row)?.unbind())
}

// ── registration ────────────────────────────────────────────────────────────

/// The three names `register()` cannot bind eagerly (see the import-cycle
/// divergence in this file's header): the two gateway names come from
/// `trace_gateway`, the enum from `event_types`.
fn deferred_dependency(py: Python<'_>, name: &str) -> PyResult<Option<PyObject>> {
    let source = match name {
        "TraceGateway" | "OBSERVATIONAL" => "trace_gateway",
        "EventType" => "event_types",
        _ => return Ok(None),
    };
    let value = mod_import(py, source)?.getattr(name)?;
    // Cache into the module dict, exactly where the eager binding would have
    // put it, so `own()` and `recovery.__dict__` see it from then on.
    let st = ST.lock();
    if let Some(m) = st.as_ref() {
        m.bind(py).setattr(name, &value)?;
    }
    Ok(Some(value.unbind()))
}

/// PEP 562 module `__getattr__`, i.e. the fallback python's own module
/// implementation runs when a name is not in the module dict.
#[pyfunction]
#[pyo3(name = "__getattr__", signature = (name))]
fn py_module_getattr<'py>(py: Python<'py>, name: &B<'py>) -> PyResult<PyObject> {
    let name_str = name.str()?;
    let key = name_str.to_cow()?;
    if let Some(value) = deferred_dependency(py, &key)? {
        return Ok(value);
    }
    Err(PyAttributeError::new_err(format!(
        "module 'recovery' has no attribute '{}'",
        key
    )))
}

/// Register the recovery submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(py, "recovery")?;
    m.add_function(wrap_pyfunction!(py_recover_interrupted_goals, &m)?)?;
    m.add_function(wrap_pyfunction!(py_record_reaped_subagents, &m)?)?;
    m.add_function(wrap_pyfunction!(py_render_completed_side_effects, &m)?)?;
    m.add_function(wrap_pyfunction!(py_verdict_suffix, &m)?)?;
    m.add_function(wrap_pyfunction!(py_render_unknown_side_effects, &m)?)?;
    m.add("__getattr__", wrap_pyfunction!(py_module_getattr, &m)?)?;

    m.add("_MAX_ADVISORY_ENTRIES", ADVISORY_CAP)?;

    // `import logging` / `from typing import List` — stdlib, no cycle risk, so
    // they keep the import-time binding. The two `from X import Y` lines are
    // deferred to `__getattr__` above.
    m.add("logging", mod_import(py, "logging")?)?;
    m.add("List", mod_import(py, "typing")?.getattr("List")?)?;

    // log = logging.getLogger(__name__) — evaluated once, at import, exactly
    // like the python line it replaces.
    let logger = m
        .getattr("logging")?
        .call_method1("getLogger", (m.getattr("__name__")?,))?;
    m.add("log", &logger)?;

    *ST.lock() = Some(m.clone().unbind());
    parent.add_submodule(&m)?;
    Ok(())
}
