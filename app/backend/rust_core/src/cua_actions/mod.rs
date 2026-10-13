//! cua_actions — Rust port of `app/backend/cua_actions.py` (wave-6).
//!
//! The CUA action layer: the action registry, the desktop execution backend,
//! the permission routing that reuses gui_action_classifier + permission_rules
//! without adding a single new decision point, the screenshot→OCR feedback
//! loop, and the U4 desktop/browser unified Target protocol.
//!
//! Port posture (effects / goal_plan / computer_agent precedent): every value
//! stays a live CPython object and flows through that object's own methods.
//! str()/int()/float()/bool()/len()/max()/min()/round()/sum()/dict()/list()/
//! repr()/hash()/callable()/getattr()/sorted()/isinstance() are the real
//! builtins, `<`/`<=`/`==`/`in` go through the real `operator` module, f-strings
//! are `format(x, "")` + `"".join` in source order, and `re.compile` is the real
//! `re` module. Dependencies (`Result`, `classify_action`, `OcrDiffState`,
//! `native_desktop`, `uia_tree`, `permission_rules`, `edge.ocr`, `executors`,
//! `bare_modifier_guard`, `user_dirs`, `time`, `os`, `tempfile`, `platform`)
//! resolve through the live import system at call time, so exception classes,
//! messages and the recorded call ledger match the canonical implementation by
//! construction — and the module's own globals are read from its own dict, so
//! `monkeypatch.setattr(cua_actions, "_virtual_screen_bounds", …)` behaves the
//! same on both sides. No production seam is needed; there is no
//! `_set_seams` here.
//!
//! Bug-for-bug list (each item is pinned by a parity scenario):
//! §1 `CuaActionRegistry.get` keys on `str(name or "").strip()`, so 0 / "" /
//!     None / False all collapse to the empty key and " click " finds `click`.
//! §2 `execute`'s unknown-action message interpolates the RAW `name` object
//!     (`f"未知动作: {name}"`) while `action=` stores `str(name or "")`.
//! §3 `details=dict(value)` only when the Result is ok AND value is a dict — a
//!     successful backend returning a non-dict silently loses its payload.
//! §4 `delivery_hint` is re-validated at the boundary (`str(v or "") in
//!     DELIVERY_HINTS`), so a backend's "banana" degrades to "" rather than
//!     erroring; a falsy hint (0, None) also becomes "".
//! §5 `_append_midway_note` runs for EVERY action (failed ones too), reads the
//!     backend's own `value` object rather than the copied `details`, and takes
//!     `midway_summary or midway_note` — a present-but-empty summary silently
//!     falls through to the note.
//! §6 `summarize_ocr` truncates to 800 characters FIRST and appends the
//!     "... [OCR 文本已截断]" marker AFTER, so the return can exceed the cap;
//!     the 24-line gate is applied to the non-empty list, not the raw lines.
//! §7 `_detect_ctx_of` drops exactly `pre_approval_source` (frozenset `in`),
//!     everything else — including `confirmed` — is fed to the tag detector.
//! §8 `validate_url` strips BEFORE matching, so `f" {url} "` is accepted; the
//!     whitelist excludes `+ @ , '`, spaces and angle brackets, and
//!     `str(url or "")` makes `url=0` an empty string (ValueError), not "0".
//! §9 `wait` returns ok=True even when the text never appears; `found` is
//!     None / True / False, the plain-delay path never polls, and the hit-path
//!     `waited` is `timeout - max(0.0, deadline - monotonic())`.
//! §10 `window_list` reads `int(limit or 20)` (so limit=0 → 20, non-numeric →
//!     20 via the except), filters by title BEFORE slicing, and clamps with
//!     `max(1, min(limit, 100))`.
//! §11 `element_tree` passes the SAME list object to `find_elements` when no
//!     name/type/automation_id is given (`hits is got`), and `count` counts
//!     `hits`, not the capped slice.
//! §12 `click_element` adds the offsets BEFORE the screen-bounds guard, and the
//!     guard is skipped entirely when `bw <= 0 or bh <= 0` (bounds unknown).
//! §13 `_supports_step_drag` probes `callable(getattr(engine, n, None))` over
//!     `_STEP_DRAG_PRIMITIVES` read at call time.
//! §14 the observed-drag `value` dict is built as {"from","to"} first, then
//!     `midway_summary` / `midway_note` / `midway_screenshot` are appended only
//!     when truthy — dict key order is observable.
//! §15 `try/finally` guarantees `mouse_up()` and swallows its failure with a
//!     bare `except Exception: pass` — a raise there never changes the drag's
//!     own outcome.
//! §16 `_get_uia_backend`'s lazy init is `hasattr`-driven (the instance
//!     attribute does not exist before the first call) and prints to stdout on
//!     failure — the print, not an exception, is the observable degradation.
//! §17 `navigate` decides the command from `platform.system()` at call time and
//!     treats a non-zero exit code as success (`guarded_spawn` raising is the
//!     only failure signal).
//! §18 `element_info`: `count` is `len(lines)` (ALL lines) while `elements` is
//!     capped at `limit`, `nearest` is computed over the CAPPED items, ties
//!     resolve to the first minimum, `expect_text` is matched against every
//!     line (not just the capped ones), and a params-level `delivery_hint`
//!     key is ignored by design.
//! §19 malformed/missing bbox degrades to `[0, 0]` through real `round()`
//!     (banker's rounding) and real `float()`/`sum()`/`len()`.
//! §20 `observe()` builds `meta` as {target_ref, screenshot_path} + the
//!     keys whose value `is not None` in source order, and keeps the screenshot
//!     path on every OCR-stage failure.
//! §21 `TargetRouter.resolve`'s unregistered message joins
//!     `sorted(self._backends)` with ", " and falls back to the literal "无".
//! §22 `_spec_for` consults the registry for EVERY kind first, so a tab action
//!     shadowed by a registered name uses the registry's spec object.
//! §23 `action_names(kind)` is `sorted(set(registry.names()) ∪ tab specs)` —
//!     the desktop kind also gets the tab-only names if a spec of that name is
//!     registered on the shared registry.
//! §24 `format_target_ref` reads `kind` with a `getattr(..., "")` default but
//!     touches `ref.session_id` / `ref.object_id` directly (AttributeError is
//!     part of the contract for a half-built ref).
//! §25 `parse_target_ref` accepts a `TargetRef` instance by identity, defaults
//!     None to `desktop:0`, and requires `body.isdigit()` — so "-1" and "1.0"
//!     are rejected while a non-ASCII digit is accepted (real str.isdigit).
//! §26 `BrowserTargetBackend.act` checks `ref.kind != "tab"` BEFORE the empty
//!     session id, and `observe` checks the session id BEFORE the tab id.
//! §27 `DesktopTargetBackend.__init__`'s three-way wiring: registry wins, then
//!     desktop_backend (building a registry around it), then the process
//!     singleton — and `registry.backend` is fetched even when both are given.
//!
//! DIVERGENCE(port, binding time): python binds module globals at import time;
//!     Rust reads them from the live module dict at each call (own dict for its
//!     own names, `sys.modules` for other modules). Production never rebinds an
//!     import behind a module's back, and the parity probe patches both sides
//!     through the same `sys.modules` objects, so the observable state matches.
//! DIVERGENCE(port, `__init__` default for now_fn): `now_fn=time.perf_counter`
//!     is evaluated ONCE at def time in python; Rust looks `time.perf_counter`
//!     up when the argument is omitted. Both sides see the same object as long
//!     as the fake is installed before the module is loaded (the probe does
//!     exactly that); swapping `time.perf_counter` afterwards is observable and
//!     is pinned as an accepted-divergence scenario.
//! DIVERGENCE(port, TargetBackend): the Protocol object is created at register
//!     time by calling the real `type()` on `typing.Protocol` and passing it to
//!     `typing.runtime_checkable`, so `__protocol_attrs__`, `isinstance`
//!     duck-checking, the `issubclass` TypeError text and the
//!     "cannot be instantiated" TypeError all come from CPython's own
//!     machinery. The residue: the protocol's `observe`/`act` members are Rust
//!     builtins, so they carry no `__annotations__` — pinned, not hidden.
//! DIVERGENCE(port, class layout): `ActionSpec` / `TargetRef` reproduce the
//!     frozen-dataclass `__setattr__`/`__delattr__` (`FrozenInstanceError`,
//!     an AttributeError subclass) with the exact `cannot assign to field 'x'`
//!     text; `CuaActionResult` / `ObserveResult` reproduce the mutable
//!     dataclass `__init__` (omitted-vs-None tri-state through the `UNSET`
//!     float sentinel, `default_factory` firing only for omitted fields),
//!     `__repr__`, tuple `__eq__` and the unhashable `__hash__`.
// PORT STATUS: confidence=high todos=[0]

use parking_lot::Mutex;
use pyo3::exceptions::{
    PyAttributeError, PyImportError, PyTypeError, PyValueError,
};
use pyo3::types::{PyCFunction, PyDict, PyFloat, PyList, PySet, PyString, PyTuple};
use pyo3::prelude::*;
use std::panic::UnwindSafe;

type B<'py> = Bound<'py, PyAny>;

// ── module constants (values mirror the python source 1:1) ─────────────────

pub const CAP_PERCEIVE: &str = "perceive";
pub const CAP_POINT: &str = "point";
pub const CAP_TYPE: &str = "type";
pub const CAP_NAVIGATE: &str = "navigate";
pub const CAP_WAIT: &str = "wait";
pub const CAP_TAB_MANAGE: &str = "tab_manage";

const OCR_SUMMARY_MAX_LINES: i64 = 24;
const OCR_SUMMARY_MAX_CHARS: i64 = 800;
const DRAG_MIDWAY_MAX_LINES: i64 = 6;
const DRAG_MIDWAY_MAX_CHARS: i64 = 300;

const URL_PATTERN_SRC: &str = r"^https?://[A-Za-z0-9\-._~:/?#&=%]+$";

/// 非法引用的报错尾注——消息必须列出全部合法形态。
const TARGET_REF_USAGE: &str = "target_ref 合法形态: desktop:0 | tab:{session_id}/{tab_id} | app:{pid}";

static ST: Mutex<Option<Py<PyModule>>> = Mutex::new(None);

/// pyo3 cannot tell an omitted `Option<Py<PyAny>>` argument from an explicit
/// `None`, but the dataclass-generated `__init__` this port mirrors stores
/// whichever the caller passed. Every optional parameter therefore defaults to
/// this float and is compared with real `==`; a caller would have to pass
/// exactly -1.7976931348623157e308 to be mistaken for "absent".
const UNSET: f64 = f64::MIN;

fn unset_obj() -> Py<PyAny> {
    Python::with_gil(|py| PyFloat::new_bound(py, UNSET).into_any().unbind())
}

fn unset<'py>(v: &B<'py>) -> PyResult<bool> {
    if !v.is_instance_of::<PyFloat>() {
        return Ok(false);
    }
    v.eq(UNSET)
}

/// "'a'", "'a' and 'b'", "'a', 'b', and 'c'" — the list CPython's
/// `format_missing` builds for the missing-positional message.
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

/// CPython parses a call to the dataclass-generated `__init__` in the eval
/// loop, so every arity/keyword TypeError reads `Cls.__init__() ...`; pyo3's
/// `#[new]` parser hard-codes the token `__new__`. The constructors below
/// therefore take `(*args, **kwargs)` and let this binder match them, keeping
/// CPython's message grammar AND its precedence: keywords are consumed in call
/// order (unexpected → multiple values), surplus positionals are reported
/// after that, missing required names last. Unfilled slots come back as the
/// UNSET sentinel, so each constructor's own default logic is unchanged.
fn bind_init<'py>(
    py: Python<'py>,
    cls: &str,
    params: &[&str],
    required: usize,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<Vec<Py<PyAny>>> {
    let total = params.len();
    let nargs = args.len();
    let mut slots: Vec<Option<Py<PyAny>>> = (0..total).map(|_| None).collect();
    for (i, a) in args.iter().enumerate() {
        if i < total {
            slots[i] = Some(a.to_object(py));
        }
    }
    if let Some(kw) = kwargs {
        for (k, v) in kw.iter() {
            let key: String = k.extract()?;
            match params.iter().position(|p| *p == key) {
                None => {
                    return Err(PyTypeError::new_err(format!(
                        "{}.__init__() got an unexpected keyword argument '{}'",
                        cls, key
                    )))
                }
                Some(i) => {
                    if slots[i].is_some() {
                        return Err(PyTypeError::new_err(format!(
                            "{}.__init__() got multiple values for argument '{}'",
                            cls, key
                        )));
                    }
                    slots[i] = Some(v.to_object(py));
                }
            }
        }
    }
    if nargs > total {
        let given = nargs + 1;
        let take = if required == total {
            format!("{}.__init__() takes {} positional arguments but {} were given",
                    cls, total + 1, given)
        } else {
            format!("{}.__init__() takes from {} to {} positional arguments but {} were given",
                    cls, required + 1, total + 1, given)
        };
        return Err(PyTypeError::new_err(take));
    }
    let missing: Vec<&str> = params[..required]
        .iter()
        .zip(&slots[..required])
        .filter(|(_, s)| s.is_none())
        .map(|(n, _)| *n)
        .collect();
    if !missing.is_empty() {
        let k = missing.len();
        return Err(PyTypeError::new_err(format!(
            "{}.__init__() missing {} required positional argument{}: {}",
            cls,
            k,
            if k == 1 { "" } else { "s" },
            quoted_and(&missing)
        )));
    }
    Ok(slots
        .into_iter()
        .map(|s| s.unwrap_or_else(unset_obj))
        .collect())
}

/// `def f(x=None)`-style parameters: an explicit None and an omitted argument
/// mean the same thing, so the UNSET slot collapses to None as well.
fn slot_opt<'py>(py: Python<'py>, v: &Py<PyAny>) -> PyResult<Option<Py<PyAny>>> {
    let b = v.bind(py).clone();
    if unset(&b)? || b.is_none() {
        Ok(None)
    } else {
        Ok(Some(v.clone_ref(py)))
    }
}

// ── own-module globals (python's late global lookup) ────────────────────────

fn own<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    let m: Option<Py<PyModule>> = ST.lock().as_ref().map(|p| p.clone_ref(py));
    match m {
        Some(p) => Ok(p.bind(py).getattr(name)?),
        None => Err(PyImportError::new_err("cua_actions module not registered")),
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

fn flt<'py>(py: Python<'py>, v: f64) -> PyResult<B<'py>> {
    Ok(v.to_object(py).into_bound(py).into_any())
}

fn ps<'py>(py: Python<'py>, v: &str) -> B<'py> {
    PyString::new_bound(py, v).into_any()
}

fn none<'py>(py: Python<'py>) -> B<'py> {
    py.None().into_bound(py).into_any()
}

fn py_bool<'py>(py: Python<'py>, v: bool) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr(if v { "True" } else { "False" })?)
}

/// real builtin call with N arguments: int(x) / max(a, b) / getattr(o, n, d)
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

/// real operator-module binary op — the exact protocol behind `a < b`,
/// `a == b`, `a - b`, … including reflected fallbacks.
fn op<'py>(py: Python<'py>, name: &str, a: &B<'py>, b: &B<'py>) -> PyResult<B<'py>> {
    Ok(py.import_bound("operator")?.getattr(name)?.call1((a, b))?)
}

fn lt<'py>(py: Python<'py>, a: &B<'py>, b: &B<'py>) -> PyResult<bool> {
    op(py, "lt", a, b)?.is_truthy()
}

fn le<'py>(py: Python<'py>, a: &B<'py>, b: &B<'py>) -> PyResult<bool> {
    op(py, "le", a, b)?.is_truthy()
}

fn eq<'py>(py: Python<'py>, a: &B<'py>, b: &B<'py>) -> PyResult<bool> {
    op(py, "eq", a, b)?.is_truthy()
}

/// `x in coll` — the real container protocol.
fn contains<'py>(coll: &B<'py>, x: &B<'py>) -> PyResult<bool> {
    Ok(coll.call_method1("__contains__", (x,))?.is_truthy()?)
}

/// `x or default` (returns the original object when truthy).
fn orv<'py>(v: &B<'py>, def: &B<'py>) -> PyResult<B<'py>> {
    Ok(if v.is_truthy()? { v.clone() } else { def.clone() })
}

/// `str(x or default)` — the source's most common idiom.
fn orstr<'py>(py: Python<'py>, v: &B<'py>, def: &str) -> PyResult<B<'py>> {
    Ok(orv(v, &ps(py, def))?.str()?.into_any())
}

/// `f"{x}"` — the real `format(x, "")` an f-string compiles to.
fn fmtv<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("format")?.call1((x, ps(py, "")))?)
}

/// `f"{x:spec}"`.
fn fmtsp<'py>(py: Python<'py>, x: &B<'py>, spec: &str) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("format")?.call1((x, ps(py, spec)))?)
}

/// `sep.join(parts)`.
fn join_with<'py>(py: Python<'py>, sep: &B<'py>, parts: Vec<B<'py>>) -> PyResult<B<'py>> {
    let list = PyList::new_bound(py, parts);
    Ok(sep.call_method1("join", (&list,))?)
}

/// `str(...)` of an f-string fragment list, joined in source order.
fn fstr<'py>(py: Python<'py>, parts: Vec<B<'py>>) -> PyResult<B<'py>> {
    join_with(py, &ps(py, ""), parts)
}

/// `d.get(key)` / `d.get(key, default)` through the real dict method, so a
/// non-mapping `d` raises AttributeError exactly like python.
fn gget<'py>(py: Python<'py>, d: &B<'py>, key: &str) -> PyResult<B<'py>> {
    Ok(d.call_method1("get", (ps(py, key),))?)
}

fn gget_o<'py>(py: Python<'py>, d: &B<'py>, key: &str, default: &B<'py>) -> PyResult<B<'py>> {
    Ok(d.call_method1("get", (ps(py, key), default))?)
}

/// `getattr(o, name, default)` — swallows AttributeError only.
fn getattr_d<'py>(o: &B<'py>, name: &str, default: B<'py>, py: Python<'_>) -> PyResult<B<'py>> {
    match o.getattr(name) {
        Ok(v) => Ok(v),
        Err(e) if e.is_instance_of::<PyAttributeError>(py) => Ok(default),
        Err(e) => Err(e),
    }
}

/// `hasattr(x, name)` (python: catches AttributeError, nothing else).
fn has_attr(py: Python<'_>, x: &B<'_>, name: &str) -> PyResult<bool> {
    match x.getattr(name) {
        Ok(_) => Ok(true),
        Err(e) if e.is_instance_of::<PyAttributeError>(py) => Ok(false),
        Err(e) => Err(e),
    }
}

fn is_dict(x: &B<'_>) -> bool {
    x.is_instance_of::<PyDict>()
}

/// `x is y` by pointer identity.
fn same(a: &B<'_>, b: &B<'_>) -> bool {
    a.as_ptr() == b.as_ptr()
}

/// python's `except Exception:` — BaseExceptions (KeyboardInterrupt,
/// SystemExit, GeneratorExit) are NOT swallowed and must propagate.
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

fn list_of<'py>(py: Python<'py>, items: Vec<B<'py>>) -> B<'py> {
    PyList::new_bound(py, items).into_any()
}

fn tuple_of<'py>(py: Python<'py>, items: Vec<B<'py>>) -> PyResult<B<'py>> {
    Ok(PyTuple::new_bound(py, items).into_any())
}

fn frozenset_of<'py>(py: Python<'py>, vals: &[&str]) -> PyResult<B<'py>> {
    let set = PySet::empty_bound(py)?;
    for v in vals {
        set.add(*v)?;
    }
    Ok(frozenset_ctor(py)?.call1((&set,))?)
}

fn frozenset_ctor<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    builtins(py)?.getattr("frozenset")
}

/// `x[key]` / `x[key] = v` through the real mapping/sequence protocol.
fn get_item<'py>(py: Python<'py>, x: &B<'py>, key: &str) -> PyResult<B<'py>> {
    let _ = py;
    x.get_item(key)
}

/// `x[i]` for an int index.
fn get_idx<'py>(x: &B<'py>, i: isize) -> PyResult<B<'py>> {
    x.get_item(i)
}

/// `x[:stop]`
fn head<'py>(py: Python<'py>, x: &B<'py>, stop: &B<'py>) -> PyResult<B<'py>> {
    let sl = builtins(py)?.getattr("slice")?.call1((none(py), stop))?;
    x.get_item(sl)
}

/// `len(x)` — real builtin (code points for str, entries for containers).
fn plen<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<usize> {
    Ok(bi1(py, "len", x)?.extract::<usize>()?)
}

/// raise `module.attr(msg)` — used for `dataclasses.FrozenInstanceError`.
fn raise_from<'py>(py: Python<'py>, module: &str, attr: &str, msg: String) -> PyErr {
    let res: PyResult<B<'py>> = (|| {
        let m = mod_import(py, module)?;
        let cls = m.getattr(attr)?;
        Ok(cls.call1((msg,))?)
    })();
    match res {
        Ok(inst) => PyErr::from_value_bound(inst),
        Err(e) => e,
    }
}

// ── ActionSpec (frozen dataclass) ──────────────────────────────────────────

/// declaration order == `dataclasses.fields`, and it drives __repr__, __eq__,
/// __hash__ and the tuple the frozen __init__ builds.
const SPEC_FIELDS: [&str; 8] = [
    "name",
    "capability",
    "guard_tool",
    "risk_level",
    "side_effect",
    "description",
    "confirmation_class",
    "scenario_tags",
];

#[pyclass(module = "cua_actions", name = "ActionSpec", frozen)]
struct ActionSpec {
    #[pyo3(get)]
    name: PyObject,
    #[pyo3(get)]
    capability: PyObject,
    #[pyo3(get)]
    guard_tool: PyObject,
    #[pyo3(get)]
    risk_level: PyObject,
    #[pyo3(get)]
    side_effect: PyObject,
    #[pyo3(get)]
    description: PyObject,
    #[pyo3(get)]
    confirmation_class: PyObject,
    #[pyo3(get)]
    scenario_tags: PyObject,
}

fn spec_field(py: Python<'_>, slf: &ActionSpec, name: &str) -> Py<PyAny> {
    match name {
        "capability" => slf.capability.clone_ref(py),
        "guard_tool" => slf.guard_tool.clone_ref(py),
        "risk_level" => slf.risk_level.clone_ref(py),
        "side_effect" => slf.side_effect.clone_ref(py),
        "description" => slf.description.clone_ref(py),
        "confirmation_class" => slf.confirmation_class.clone_ref(py),
        "scenario_tags" => slf.scenario_tags.clone_ref(py),
        _ => slf.name.clone_ref(py),
    }
}

fn spec_values<'py>(py: Python<'py>, slf: &ActionSpec) -> Vec<B<'py>> {
    SPEC_FIELDS
        .iter()
        .map(|n| spec_field(py, slf, n).into_bound(py))
        .collect()
}

fn spec_class<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(py.get_type_bound::<ActionSpec>().into_any())
}

#[pymethods]
impl ActionSpec {
    #[new]
    #[pyo3(signature = (*args, **kwargs))]
    fn py_new<'py>(
        py: Python<'py>,
        args: &Bound<'py, PyTuple>,
        kwargs: Option<&Bound<'py, PyDict>>,
    ) -> PyResult<Self> {
        // The generated frozen __init__ stores whatever the caller passed
        // (no coercion, None included) and fires the field default only when
        // the argument is absent.
        let s = bind_init(py, "ActionSpec", &SPEC_FIELDS, 5, args, kwargs)?;
        macro_rules! dv {
            ($i:expr, $def:expr) => {{
                let v: Py<PyAny> = s[$i].clone_ref(py);
                let vb = v.bind(py).clone();
                if unset(&vb)? { $def } else { v }
            }};
        }
        Ok(Self {
            name: s[0].clone_ref(py),
            capability: s[1].clone_ref(py),
            guard_tool: s[2].clone_ref(py),
            risk_level: s[3].clone_ref(py),
            side_effect: s[4].clone_ref(py),
            description: dv!(5, ps(py, "").unbind()),
            confirmation_class: dv!(6, ps(py, "standard").unbind()),
            scenario_tags: dv!(7, PyTuple::empty_bound(py).into_any().unbind()),
        })
    }

    fn __repr__(slf: PyRef<'_, Self>) -> PyResult<String> {
        let py = slf.py();
        let parts: PyResult<Vec<B<'_>>> = SPEC_FIELDS
            .iter()
            .zip(spec_values(py, &slf))
            .map(|(n, v)| {
                fstr(
                    py,
                    vec![ps(py, n), ps(py, "="), bi1(py, "repr", &v)?],
                )
            })
            .collect();
        let cls = spec_class(py)?.getattr("__name__")?;
        let full = fstr(
            py,
            vec![
                cls,
                ps(py, "("),
                join_with(py, &ps(py, ", "), parts?)?,
                ps(py, ")"),
            ],
        )?;
        full.extract::<String>().map_err(Into::into)
    }

    fn __eq__(slf: PyRef<'_, Self>, other: &B<'_>) -> PyResult<PyObject> {
        let py = slf.py();
        if !same(&spec_class(py)?, &other.getattr("__class__")?) {
            return Ok(py.NotImplemented());
        }
        let a = PyTuple::new_bound(py, spec_values(py, &slf));
        let b = PyTuple::new_bound(
            py,
            SPEC_FIELDS
                .iter()
                .map(|n| other.getattr(*n))
                .collect::<PyResult<Vec<_>>>()?,
        );
        Ok(py_bool(py, a.eq(&b)?)?.unbind())
    }

    /// frozen dataclass: `__hash__ = hash(tuple(fields))`.
    fn __hash__(slf: PyRef<'_, Self>) -> PyResult<isize> {
        let py = slf.py();
        let t = PyTuple::new_bound(py, spec_values(py, &slf));
        bi1(py, "hash", &t.as_any())?.extract::<isize>()
    }

    /// `@dataclass(frozen=True)` installs exactly this guard.
    fn __setattr__(&self, name: &B<'_>, _value: &B<'_>) -> PyResult<()> {
        let py = name.py();
        Err(frozen_err(py, "assign", name)?)
    }

    fn __delattr__(&self, name: &B<'_>) -> PyResult<()> {
        let py = name.py();
        Err(frozen_err(py, "delete", name)?)
    }
}

/// python's message: `cannot assign to field 'name'` / `cannot delete field …`.
fn frozen_err(py: Python<'_>, verb: &str, name: &B<'_>) -> PyResult<PyErr> {
    let shown = fstr(
        py,
        vec![
            ps(py, "cannot "),
            ps(py, verb),
            ps(py, " to field "),
            bi1(py, "repr", name)?,
        ],
    )?
    .extract::<String>()?;
    Ok(raise_from(py, "dataclasses", "FrozenInstanceError", shown))
}

// ── CuaActionResult (mutable dataclass) ────────────────────────────────────

const RESULT_FIELDS: [&str; 9] = [
    "ok",
    "action",
    "error",
    "details",
    "screenshot_path",
    "ocr_summary",
    "feedback_note",
    "delivery_hint",
    "elapsed_ms",
];

#[pyclass(module = "cua_actions", name = "CuaActionResult")]
struct CuaActionResult {
    #[pyo3(get, set)]
    ok: PyObject,
    #[pyo3(get, set)]
    action: PyObject,
    #[pyo3(get, set)]
    error: PyObject,
    #[pyo3(get, set)]
    details: PyObject,
    #[pyo3(get, set)]
    screenshot_path: PyObject,
    #[pyo3(get, set)]
    ocr_summary: PyObject,
    #[pyo3(get, set)]
    feedback_note: PyObject,
    #[pyo3(get, set)]
    delivery_hint: PyObject,
    #[pyo3(get, set)]
    elapsed_ms: PyObject,
}

fn car_field(py: Python<'_>, slf: &CuaActionResult, name: &str) -> Py<PyAny> {
    match name {
        "action" => slf.action.clone_ref(py),
        "error" => slf.error.clone_ref(py),
        "details" => slf.details.clone_ref(py),
        "screenshot_path" => slf.screenshot_path.clone_ref(py),
        "ocr_summary" => slf.ocr_summary.clone_ref(py),
        "feedback_note" => slf.feedback_note.clone_ref(py),
        "delivery_hint" => slf.delivery_hint.clone_ref(py),
        "elapsed_ms" => slf.elapsed_ms.clone_ref(py),
        _ => slf.ok.clone_ref(py),
    }
}

fn car_values<'py>(py: Python<'py>, slf: &CuaActionResult) -> Vec<B<'py>> {
    RESULT_FIELDS
        .iter()
        .map(|n| car_field(py, slf, n).into_bound(py))
        .collect()
}

fn car_class<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(py.get_type_bound::<CuaActionResult>().into_any())
}

#[pymethods]
impl CuaActionResult {
    #[new]
    #[pyo3(signature = (*args, **kwargs))]
    fn py_new<'py>(
        py: Python<'py>,
        args: &Bound<'py, PyTuple>,
        kwargs: Option<&Bound<'py, PyDict>>,
    ) -> PyResult<Self> {
        let s = bind_init(py, "CuaActionResult", &RESULT_FIELDS, 2, args, kwargs)?;
        macro_rules! dv {
            ($i:expr, $def:expr) => {{
                let v: Py<PyAny> = s[$i].clone_ref(py);
                let vb = v.bind(py).clone();
                if unset(&vb)? { $def } else { v }
            }};
        }
        Ok(Self {
            ok: s[0].clone_ref(py),
            action: s[1].clone_ref(py),
            error: dv!(2, ps(py, "").unbind()),
            // default_factory=dict → a fresh dict per omitted field, and only
            // for omitted ones (`details=None` really stores None).
            details: dv!(3, PyDict::new_bound(py).into_any().unbind()),
            screenshot_path: dv!(4, ps(py, "").unbind()),
            ocr_summary: dv!(5, ps(py, "").unbind()),
            feedback_note: dv!(6, ps(py, "").unbind()),
            delivery_hint: dv!(7, ps(py, "").unbind()),
            elapsed_ms: dv!(8, obj(py, 0)?.unbind()),
        })
    }

    fn to_dict(slf: PyRef<'_, Self>) -> PyResult<B<'_>> {
        let py = slf.py();
        dict_of(
            py,
            &[
                ("ok", &car_field(py, &slf, "ok").into_bound(py)),
                ("action", &car_field(py, &slf, "action").into_bound(py)),
                ("error", &car_field(py, &slf, "error").into_bound(py)),
                ("details", &car_field(py, &slf, "details").into_bound(py)),
                (
                    "screenshot_path",
                    &car_field(py, &slf, "screenshot_path").into_bound(py),
                ),
                (
                    "ocr_summary",
                    &car_field(py, &slf, "ocr_summary").into_bound(py),
                ),
                (
                    "feedback_note",
                    &car_field(py, &slf, "feedback_note").into_bound(py),
                ),
                (
                    "delivery_hint",
                    &car_field(py, &slf, "delivery_hint").into_bound(py),
                ),
                (
                    "elapsed_ms",
                    &car_field(py, &slf, "elapsed_ms").into_bound(py),
                ),
            ],
        )
    }

    fn __repr__(slf: PyRef<'_, Self>) -> PyResult<String> {
        let py = slf.py();
        let parts: PyResult<Vec<B<'_>>> = RESULT_FIELDS
            .iter()
            .zip(car_values(py, &slf))
            .map(|(n, v)| {
                fstr(
                    py,
                    vec![ps(py, n), ps(py, "="), bi1(py, "repr", &v)?],
                )
            })
            .collect();
        let cls = car_class(py)?.getattr("__name__")?;
        let full = fstr(
            py,
            vec![
                cls,
                ps(py, "("),
                join_with(py, &ps(py, ", "), parts?)?,
                ps(py, ")"),
            ],
        )?;
        full.extract::<String>().map_err(Into::into)
    }

    fn __eq__(slf: PyRef<'_, Self>, other: &B<'_>) -> PyResult<PyObject> {
        let py = slf.py();
        if !same(&car_class(py)?, &other.getattr("__class__")?) {
            return Ok(py.NotImplemented());
        }
        let a = PyTuple::new_bound(py, car_values(py, &slf));
        let b = PyTuple::new_bound(
            py,
            RESULT_FIELDS
                .iter()
                .map(|n| other.getattr(*n))
                .collect::<PyResult<Vec<_>>>()?,
        );
        Ok(py_bool(py, a.eq(&b)?)?.unbind())
    }

    /// dataclass(eq=True, frozen=False) sets `__hash__ = None`.
    fn __hash__(&self) -> PyResult<isize> {
        Err(PyTypeError::new_err(
            "unhashable type: 'CuaActionResult'",
        ))
    }
}

// ── free helpers (names mirror the python module 1:1) ──────────────────────

/// `time.<attr>` resolved through the live `time` module at call time — the
/// same attribute chain python's `import time; time.sleep(...)` walks, so a
/// probe-side patch of `time.sleep` is seen by both sides.
fn time_attr<'py>(py: Python<'py>, attr: &str) -> PyResult<B<'py>> {
    Ok(mod_import(py, "time")?.getattr(attr)?)
}

fn feedback_dir<'py>(py: Python<'py>, ctx: Option<&B<'py>>) -> PyResult<B<'py>> {
    // `ctx or {}` sits OUTSIDE the try: a non-mapping ctx raises AttributeError
    // before any import is attempted, exactly like python.
    let empty = empty_dict(py);
    let view = match ctx {
        Some(c) => orv(c, &empty)?,
        None => empty,
    };
    let ovr = gget(py, &view, "cua_screenshot_dir")?;
    if ovr.is_truthy()? {
        return ovr.str().map(|v| v.into_any());
    }
    let got: PyResult<B<'py>> = (|| {
        let ud = mod_import(py, "user_dirs")?;
        let home = ud.getattr("home_dir")?.call0()?;
        home.call_method1("__truediv__", (ps(py, "cua_shots"),))?.str().map(|v| v.into_any())
    })();
    match got {
        Ok(v) => Ok(v),
        Err(e) if is_py_exc(&e, py) => {
            // os.path.join(tempfile.gettempdir(), "ovolve_cua")
            let tmp = mod_import(py, "tempfile")?.getattr("gettempdir")?.call0()?;
            let osmod = mod_import(py, "os")?;
            let join = osmod.getattr("path")?.getattr("join")?;
            Ok(join.call1((&tmp, ps(py, "ovolve_cua")))?)
        }
        Err(e) => Err(e),
    }
}

fn feedback_path<'py>(
    py: Python<'py>,
    action: &B<'py>,
    ctx: Option<&B<'py>>,
) -> PyResult<B<'py>> {
    // time.strftime("%Y%m%d_%H%M%S") + f"_{int(time.time() * 1000) % 1000:03d}"
    let s1 = time_attr(py, "strftime")?.call1((ps(py, "%Y%m%d_%H%M%S"),))?;
    let tmod = time_attr(py, "time")?.call0()?;
    let ms = op(py, "mul", &tmod, &obj(py, 1000)?)?;
    let rem = op(py, "mod", &ms, &obj(py, 1000)?)?;
    let i = bi1(py, "int", &rem)?;
    let suffix = fstr(
        py,
        vec![
            ps(py, "_"),
            fmtsp(py, &i, "03d")?,
        ],
    )?;
    let ts = op(py, "add", &s1, &suffix)?;
    let d = feedback_dir(py, ctx)?;
    let name = fstr(
        py,
        vec![ts, ps(py, "_"), fmtv(py, action)?, ps(py, ".jpg")],
    )?;
    let join = mod_import(py, "os")?.getattr("path")?.getattr("join")?;
    Ok(join.call1((&d, &name))?)
}

fn summarize_ocr<'py>(py: Python<'py>, ocr_value: &B<'py>) -> PyResult<B<'py>> {
    if !ocr_value.is_instance_of::<PyDict>() {
        return Ok(ps(py, ""));
    }
    let lines_raw = gget(py, ocr_value, "lines")?;
    let empty_list = PyList::empty_bound(py).into_any();
    let lines = orv(&lines_raw, &empty_list)?;
    let mut texts: Vec<B<'py>> = Vec::new();
    for item in lines.iter()? {
        let l = item?;
        if !l.is_instance_of::<PyDict>() {
            continue;
        }
        let t = gget_d_str(py, &l, "text")?;
        texts.push(t.call_method0("strip")?);
    }
    let texts = list_of(py, texts);
    let kept = text_filter(py, &texts)?;
    let max_lines = own(py, "OCR_SUMMARY_MAX_LINES")?;
    let capped = head(py, &kept, &max_lines)?;
    let joined = ps(py, "\n").call_method1("join", (&capped,))?;
    let cap = own(py, "OCR_SUMMARY_MAX_CHARS")?;
    if lt(py, &cap, &bi1(py, "len", &joined)?)? {
        let cut = head(py, &joined, &cap)?;
        return op(
            py,
            "add",
            &cut,
            &ps(py, "\n... [OCR 文本已截断]"),
        );
    }
    Ok(joined)
}

/// `l.get("text", "")` → the value the source then wraps in `str(...)`.
fn gget_d_str<'py>(py: Python<'py>, d: &B<'py>, key: &str) -> PyResult<B<'py>> {
    let v = gget_o(py, d, key, &ps(py, ""))?;
    bi1(py, "str", &v)
}

/// `[t for t in texts if t]` — a fresh list, source order, real truthiness
/// probe on every element.
fn text_filter<'py>(py: Python<'py>, texts: &B<'py>) -> PyResult<B<'py>> {
    let out = PyList::empty_bound(py);
    for item in texts.iter()? {
        let t = item?;
        if t.is_truthy()? {
            out.append(t)?;
        }
    }
    Ok(out.into_any())
}

fn validate_url<'py>(py: Python<'py>, url: &B<'py>) -> PyResult<B<'py>> {
    let text = orstr(py, url, "")?.call_method0("strip")?;
    let pat = own(py, "_URL_PATTERN")?;
    if !pat.call_method1("match", (&text,))?.is_truthy()? {
        return Err(PyValueError::new_err(
            "url 必须是 http(s) 链接，且只含常见 URL 字符",
        ));
    }
    Ok(text)
}

fn detect_ctx_of<'py>(py: Python<'py>, ctx: &B<'py>) -> PyResult<B<'py>> {
    let fz = own(py, "_CTX_CONTROL_KEYS")?;
    let out = PyDict::new_bound(py);
    let items = ctx.call_method0("items")?;
    for pair in items.iter()? {
        let p = pair?;
        let k = p.get_item(0)?;
        if !contains(&fz, &k)? {
            out.set_item(k, p.get_item(1)?)?;
        }
    }
    Ok(out.into_any())
}

fn match_norm<'py>(py: Python<'py>, text: &B<'py>) -> PyResult<B<'py>> {
    let s = bi1(py, "str", text)?;
    let parts = s.call_method0("split")?;
    let joined = ps(py, "").call_method1("join", (&parts,))?;
    joined.call_method0("casefold")
}

fn list_top_level_windows<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let m = mod_import(py, "native_desktop")?;
    Ok(m.getattr("list_top_level_windows")?.call0()?)
}

/// `(x, y, w, h)` of the virtual screen; `(0, 0, 0, 0)` whenever anything at
/// all goes wrong (non-Windows, no ctypes.windll, a failing GetSystemMetrics).
fn virtual_screen_bounds<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let got: PyResult<B<'py>> = (|| {
        let sysmod = mod_import(py, "sys")?;
        let plat = sysmod.getattr("platform")?;
        if !same_str(py, &plat, "win32")? {
            return zero_bounds(py);
        }
        let ctypes = mod_import(py, "ctypes")?;
        let u = ctypes.getattr("windll")?.getattr("user32")?;
        let g = u.getattr("GetSystemMetrics")?;
        let vals: PyResult<Vec<B<'py>>> = [76i64, 77, 78, 79]
            .iter()
            .map(|ix| {
                let raw = g.call1((obj(py, *ix)?,))?;
                bi1(py, "int", &raw)
            })
            .collect();
        tuple_of(py, vals?)
    })();
    match got {
        Ok(v) => Ok(v),
        Err(e) if is_py_exc(&e, py) => zero_bounds(py),
        Err(e) => Err(e),
    }
}

fn zero_bounds<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    tuple_of(py, vec![obj(py, 0)?, obj(py, 0)?, obj(py, 0)?, obj(py, 0)?])
}

/// `x == "<literal>"` with a short-circuit on the common str case.
fn same_str<'py>(py: Python<'py>, x: &B<'py>, lit: &str) -> PyResult<bool> {
    if let Ok(s) = x.downcast::<PyString>() {
        return Ok(s.to_cow()?.as_ref() == lit);
    }
    eq(py, x, &ps(py, lit))
}

/// PaddleOCR's four-point bbox → centre. The *whole* body sits inside the
/// `except (TypeError, ValueError)` trap, so a non-iterable bbox, a point that
/// isn't indexable and a non-numeric coordinate all collapse to `[0, 0]`.
fn bbox_center<'py>(py: Python<'py>, bbox: &B<'py>) -> PyResult<B<'py>> {
    let got: PyResult<B<'py>> = (|| {
        let two = obj(py, 2)?;
        let mut pts: Vec<B<'py>> = Vec::new();
        for item in bbox.iter()? {
            let p = item?;
            if !is_seq(py, &p)? {
                continue;
            }
            if le(py, &two, &bi1(py, "len", &p)?)? {
                pts.push(p);
            }
        }
        if pts.is_empty() {
            return zero_pair(py);
        }
        let float_cls = builtins(py)?.getattr("float")?;
        let mut xs: Vec<B<'py>> = Vec::with_capacity(pts.len());
        let mut ys: Vec<B<'py>> = Vec::with_capacity(pts.len());
        for p in &pts {
            xs.push(float_cls.call1((p.get_item(0)?,))?);
            ys.push(float_cls.call1((p.get_item(1)?,))?);
        }
        Ok(list_of(
            py,
            vec![axis_mean(py, xs)?, axis_mean(py, ys)?],
        ))
    })();
    match got {
        Ok(v) => Ok(v),
        Err(e) if is_type_or_value(&e, py) => zero_pair(py),
        Err(e) => Err(e),
    }
}

/// `round(sum(vals) / len(vals))` — real `sum`/`len`/`round`, so the banker's
/// rounding of `.5` values is CPython's, not a reimplemented one.
fn axis_mean<'py>(py: Python<'py>, vals: Vec<B<'py>>) -> PyResult<B<'py>> {
    let l = list_of(py, vals);
    let total = bi1(py, "sum", &l)?;
    let n = bi1(py, "len", &l)?;
    let avg = op(py, "truediv", &total, &n)?;
    Ok(bi1(py, "round", &avg)?)
}

fn zero_pair<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(list_of(py, vec![obj(py, 0)?, obj(py, 0)?]))
}

fn is_type_or_value(e: &PyErr, py: Python<'_>) -> bool {
    e.is_instance_of::<pyo3::exceptions::PyTypeError>(py)
        || e.is_instance_of::<pyo3::exceptions::PyValueError>(py)
}

// ── Result plumbing ────────────────────────────────────────────────────────

/// `from result import Result` resolved at call time — the same `sys.modules`
/// object the canonical module bound at import.
fn result_cls<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    mod_import(py, "result")?.getattr("Result")
}

fn ok_res<'py>(py: Python<'py>, v: B<'py>) -> PyResult<B<'py>> {
    Ok(result_cls(py)?.call_method1("success", (&v,))?)
}

fn fail_res<'py>(py: Python<'py>, msg: B<'py>) -> PyResult<B<'py>> {
    Ok(result_cls(py)?.call_method1("failure", (&msg,))?)
}

/// `Result.failure(msg, meta={…})`.
fn fail_res_meta<'py>(py: Python<'py>, msg: B<'py>, meta: &B<'py>) -> PyResult<B<'py>> {
    let kw = PyDict::new_bound(py);
    kw.set_item("meta", meta)?;
    Ok(result_cls(py)?.call_method("failure", (&msg,), Some(&kw))?)
}

/// `except Exception as e: return Result.failure(f"<prefix>{e}")` — the
/// action-layer degradation idiom every backend action ends with. A BaseException
/// still propagates, exactly like python.
macro_rules! fail_on_exc {
    ($py:expr, $prefix:expr, $body:expr) => {
        match $body {
            Ok(v) => Ok(v),
            Err(e) if is_py_exc(&e, $py) => {
                let ev = e.value_bound($py);
                fail_res(
                    $py,
                    fstr($py, vec![ps($py, $prefix), fmtv($py, &ev)?])?,
                )
            }
            Err(e) => Err(e),
        }
    };
}

fn kwargs<'py>(py: Python<'py>, items: &[(&str, &B<'py>)]) -> PyResult<Bound<'py, PyDict>> {
    let kw = PyDict::new_bound(py);
    for (k, v) in items {
        kw.set_item(*k, (*v).clone())?;
    }
    Ok(kw)
}

/// `x = [1, 2]` style two-element payload list.
fn pair<'py>(py: Python<'py>, a: &B<'py>, b: &B<'py>) -> PyResult<B<'py>> {
    Ok(list_of(py, vec![a.clone(), b.clone()]))
}

// ── ACTION_SPECS / BROWSER_ACTION_SPECS (source-order tuples) ─────────────

struct SpecRow {
    name: &'static str,
    capability: &'static str,
    guard_tool: &'static str,
    risk_level: &'static str,
    side_effect: bool,
    description: &'static str,
}

/// The first fourteen rows are `ACTION_SPECS`, the last five
/// `BROWSER_ACTION_SPECS` — declared once here and turned into real
/// `ActionSpec` objects at register time.
const SPEC_ROWS: [SpecRow; 19] = [
    // ACTION_SPECS
    SpecRow { name: "navigate", capability: CAP_NAVIGATE, guard_tool: "navigate",
              risk_level: "medium", side_effect: true,
              description: "在默认浏览器中打开一个 http(s) URL" },
    SpecRow { name: "click", capability: CAP_POINT, guard_tool: "computer_click",
              risk_level: "medium", side_effect: true,
              description: "在坐标处点击鼠标（可选按键与连击次数）" },
    SpecRow { name: "click_text", capability: CAP_POINT, guard_tool: "computer_click",
              risk_level: "medium", side_effect: true,
              description: "通过 OCR 文本锚点定位并点击目标元素" },
    SpecRow { name: "fill", capability: CAP_TYPE, guard_tool: "computer_type",
              risk_level: "medium", side_effect: true,
              description: "向焦点控件键入文本；给坐标时先点击聚焦再输入" },
    SpecRow { name: "scroll", capability: CAP_POINT, guard_tool: "computer_scroll",
              risk_level: "low", side_effect: true,
              description: "滚动滚轮（正数向上，负数向下），可先移到坐标" },
    SpecRow { name: "hover", capability: CAP_POINT, guard_tool: "computer_move_cursor",
              risk_level: "low", side_effect: true,
              description: "平滑移动光标到坐标（触发悬停态/工具提示）" },
    SpecRow { name: "drag", capability: CAP_POINT, guard_tool: "computer_drag",
              risk_level: "medium", side_effect: true,
              description: "从起点坐标拖拽到终点坐标" },
    SpecRow { name: "keypress", capability: CAP_TYPE, guard_tool: "computer_press_key",
              risk_level: "medium", side_effect: true,
              description: "按下按键或组合键（enter / ctrl+s / alt+f4）" },
    SpecRow { name: "screenshot", capability: CAP_PERCEIVE,
              guard_tool: "computer_screenshot", risk_level: "low", side_effect: false,
              description: "截取屏幕并落盘（感知动作，自身即反馈）" },
    SpecRow { name: "window_list", capability: CAP_PERCEIVE, guard_tool: "snapshot",
              risk_level: "low", side_effect: false,
              description: "枚举可见窗口（hwnd/标题/pid）；element_tree 与 click_element 的 hwnd 从这里取" },
    SpecRow { name: "element_tree", capability: CAP_PERCEIVE, guard_tool: "snapshot",
              risk_level: "low", side_effect: false,
              description: "读取目标窗口的无障碍树（语义元素：名称/类型/位置），给坐标时优先用它" },
    SpecRow { name: "click_element", capability: CAP_POINT, guard_tool: "computer_click",
              risk_level: "medium", side_effect: true,
              description: "按语义条件（名称/类型/automation_id）定位无障碍树元素并点击其中心" },
    SpecRow { name: "element_info", capability: CAP_PERCEIVE, guard_tool: "snapshot",
              risk_level: "low", side_effect: false,
              description: "截屏 + 本地 OCR，返回可见文本元素及其位置；给坐标时附最近元素" },
    SpecRow { name: "wait", capability: CAP_WAIT, guard_tool: "computer_screenshot",
              risk_level: "low", side_effect: false,
              description: "等待若干秒，或轮询 OCR 直到目标文本出现" },
    // BROWSER_ACTION_SPECS (a dict keyed by name; keys == spec names, so the
    // rows alone rebuild it, in source order)
    SpecRow { name: "activate", capability: CAP_TAB_MANAGE, guard_tool: "window_focus",
              risk_level: "low", side_effect: true,
              description: "激活（聚焦）任务会话里的一个标签；挂起中的标签被激活即唤醒并夺焦点" },
    SpecRow { name: "close", capability: CAP_TAB_MANAGE, guard_tool: "window_focus",
              risk_level: "medium", side_effect: true,
              description: "关闭任务会话里的一个标签（终态不可再操作；焦点交给最近的在世标签）" },
    SpecRow { name: "suspend", capability: CAP_TAB_MANAGE, guard_tool: "window_focus",
              risk_level: "low", side_effect: true,
              description: "挂起一个活动标签以省内存（页面实体拆下、状态保留，可 resume 恢复）" },
    SpecRow { name: "resume", capability: CAP_TAB_MANAGE, guard_tool: "window_focus",
              risk_level: "low", side_effect: true,
              description: "恢复一个挂起的标签（不夺焦点——聚焦是 activate 的事）" },
    SpecRow { name: "claim", capability: CAP_TAB_MANAGE, guard_tool: "window_focus",
              risk_level: "low", side_effect: true,
              description: "凭「提及即引用」快照认领既有标签：标题与 URL 逐一全等比对，不符即拒" },
];

/// `ACTION_SPECS` = rows 0..14 and `BROWSER_ACTION_SPECS` = rows 14..19 keyed
/// by name — both built from real `ActionSpec` calls with the six positional
/// arguments the source writes.
fn spec_at<'py>(py: Python<'py>, ix: usize) -> PyResult<B<'py>> {
    let r = &SPEC_ROWS[ix];
    Ok(py.get_type_bound::<ActionSpec>().call1((
        ps(py, r.name),
        ps(py, r.capability),
        ps(py, r.guard_tool),
        ps(py, r.risk_level),
        py_bool(py, r.side_effect)?,
        ps(py, r.description),
    ))?)
}

fn specs_tuple<'py>(py: Python<'py>, rows: &[usize]) -> PyResult<B<'py>> {
    let mut v = Vec::new();
    for r in rows {
        v.push(spec_at(py, *r)?);
    }
    Ok(PyTuple::new_bound(py, v).into_any())
}

fn action_specs<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    specs_tuple(py, &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
}

/// `{name: spec}` in the source's declaration order.
fn browser_action_specs<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let d = PyDict::new_bound(py);
    for ix in 14..19 {
        let s = spec_at(py, ix)?;
        d.set_item(s.getattr("name")?, &s)?;
    }
    Ok(d.into_any())
}

// ── CuaDesktopBackend ──────────────────────────────────────────────────────

/// Release the pyclass borrow into a plain object handle, so `self.x = …`
/// inside a method is the real `setattr` (and a nested `self._other()` call
/// re-borrows exactly the way python re-enters a method).
fn me_handle<'py>(py: Python<'py>, slf: PyRef<'py, CuaDesktopBackend>) -> B<'py> {
    slf.into_py(py).into_bound(py).into_any()
}

/// `#[pyclass(dict)]` is unavailable under abi3-py38, so the five instance
/// attributes python's `__init__` (plus the two lazily created ones) creates are
/// declared here. `_uia_backend` is the injection point the tests assign
/// directly; `_uia_backend_instance` carries the UNSET sentinel while python
/// would have no such attribute at all — see the class-layout DIVERGENCE note in
/// the header, and `hasattr`-driven one-time init below.
#[pyclass(module = "cua_actions", name = "CuaDesktopBackend")]
struct CuaDesktopBackend {
    #[pyo3(get, set)]
    _engine: PyObject,
    #[pyo3(get, set)]
    _ocr_fn: PyObject,
    #[pyo3(get, set)]
    _ocr_diff_states: PyObject,
    #[pyo3(get, set)]
    _uia_backend: PyObject,
    #[pyo3(get, set)]
    _uia_backend_instance: PyObject,
}

impl UnwindSafe for CuaDesktopBackend {}

/// `def __init__(self, engine=None, ocr_fn=None)` — the names bind_init matches.
const DESKTOP_BACKEND_PARAMS: [&str; 2] = ["engine", "ocr_fn"];

/// The `_recognize` closure of `_get_ocr_fn`: the `OCR` class is captured when
/// `_get_ocr_fn` runs (python binds the closure cell then) and the instance
/// lives in a shared `holder` dict, built on the first call.
#[pyclass(module = "cua_actions", name = "_recognize")]
struct OcrRecognizer {
    holder: PyObject,
    ocr_cls: PyObject,
}

impl UnwindSafe for OcrRecognizer {}

#[pymethods]
impl OcrRecognizer {
    fn __call__<'py>(&self, py: Python<'py>, path: &B<'py>) -> PyResult<B<'py>> {
        let h = self.holder.bind(py).clone();
        if !contains(&h, &ps(py, "ocr"))? {
            h.set_item("ocr", self.ocr_cls.bind(py).call0()?)?;
        }
        Ok(h.get_item("ocr")?.call_method1("recognize", (path,))?)
    }
}

/// `int(params.get(key, <default>))` — the source's most frequent read.
fn pint<'py>(
    py: Python<'py>,
    params: &B<'py>,
    key: &str,
    default: i64,
) -> PyResult<B<'py>> {
    bi1(py, "int", &gget_o(py, params, key, &obj(py, default)?)?)
}

/// `float(params.get(key, <default>))`.
fn pfloat<'py>(
    py: Python<'py>,
    params: &B<'py>,
    key: &str,
    default: f64,
) -> PyResult<B<'py>> {
    bi1(py, "float", &gget_o(py, params, key, &flt(py, default)?)?)
}

#[pymethods]
impl CuaDesktopBackend {
    #[classattr]
    fn name() -> &'static str {
        "desktop"
    }

    #[new]
    #[pyo3(signature = (*args, **kwargs))]
    fn py_new<'py>(
        py: Python<'py>,
        args: &Bound<'py, PyTuple>,
        kwargs: Option<&Bound<'py, PyDict>>,
    ) -> PyResult<Self> {
        let s = bind_init(py, "CuaDesktopBackend", &DESKTOP_BACKEND_PARAMS, 0, args, kwargs)?;
        Ok(Self {
            _engine: slot_opt(py, &s[0])?.unwrap_or_else(|| py.None()),
            _ocr_fn: slot_opt(py, &s[1])?.unwrap_or_else(|| py.None()),
            _ocr_diff_states: PyDict::new_bound(py).into_any().unbind(),
            _uia_backend: py.None(),
            _uia_backend_instance: PyFloat::new_bound(py, UNSET).into_any().unbind(),
        })
    }

    // ── lazy state ────────────────────────────────────────────────────────

    #[pyo3(signature = (target_ref = None))]
    fn _ocr_diff_state<'py>(
        &self,
        py: Python<'py>,
        target_ref: Option<&B<'py>>,
    ) -> PyResult<B<'py>> {
        let dflt = ps(py, "desktop");
        let tr: B<'py> = target_ref.cloned().unwrap_or_else(|| dflt.clone());
        let key = bi1(py, "str", &orv(&tr, &dflt)?)?;
        let states = self._ocr_diff_states.bind(py).clone();
        let state = states.call_method1("get", (&key,))?;
        if state.is_none() {
            let st = own(py, "OcrDiffState")?.call0()?;
            states.set_item(&key, &st)?;
            return Ok(st);
        }
        Ok(state)
    }

    fn _get_engine<'py>(slf: PyRef<'py, Self>) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = me_handle(py, slf);
        let eng = me.getattr("_engine")?;
        if !eng.is_none() {
            return Ok(eng);
        }
        let v = mod_import(py, "native_desktop")?
            .getattr("get_native_desktop")?
            .call0()?;
        me.setattr("_engine", &v)?;
        Ok(v)
    }

    fn _get_ocr_fn<'py>(slf: PyRef<'py, Self>) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = me_handle(py, slf);
        let f = me.getattr("_ocr_fn")?;
        if !f.is_none() {
            return Ok(f);
        }
        let rec = Py::new(
            py,
            OcrRecognizer {
                holder: PyDict::new_bound(py).into_any().unbind(),
                ocr_cls: py.import_bound("edge.ocr")?.getattr("OCR")?.into_any().unbind(),
            },
        )?
        .into_bound(py);
        me.setattr("_ocr_fn", &rec)?;
        Ok(rec.into_any())
    }

    // ── internal tools ────────────────────────────────────────────────────

    #[staticmethod]
    fn _roi_of<'py>(params: &B<'py>) -> PyResult<B<'py>> {
        let py = params.py();
        let roi = gget(py, params, "roi")?;
        if !roi.is_truthy()? || !eq(py, &bi1(py, "len", &roi)?, &obj(py, 4)?)? {
            return Ok(none(py));
        }
        let got: PyResult<B<'py>> = (|| {
            let mut v = Vec::new();
            for i in 0..4 {
                v.push(bi1(py, "int", &get_idx(&roi, i)?)?);
            }
            tuple_of(py, v)
        })();
        match got {
            Ok(v) => Ok(v),
            Err(e) if is_type_or_value(&e, py) => Ok(none(py)),
            Err(e) => Err(e),
        }
    }

    #[staticmethod]
    fn _save_capture<'py>(res: &B<'py>, path: &B<'py>) -> PyResult<B<'py>> {
        let py = res.py();
        let mut path = path.clone();
        if !path.is_truthy()? {
            let mk = mod_import(py, "tempfile")?.getattr("mkstemp")?;
            let kw = kwargs(
                py,
                &[
                    ("prefix", &ps(py, "ovolve_cua_")),
                    ("suffix", &ps(py, ".png")),
                ],
            )?;
            let tmp = mk.call((), Some(&kw))?;
            let fd = tmp.get_item(0)?;
            path = tmp.get_item(1)?;
            mod_import(py, "os")?.getattr("close")?.call1((&fd,))?;
        }
        let osmod = mod_import(py, "os")?;
        let p = osmod.getattr("path")?;
        let dir_ = p.getattr("dirname")?.call1((
            p.getattr("abspath")?.call1((&path,))?,
        ))?;
        let exist_ok = py_bool(py, true)?;
        osmod.getattr("makedirs")?
            .call((&dir_,), Some(&kwargs(py, &[("exist_ok", &exist_ok)])?))?;
        res.get_item("image")?
            .call_method1("save", (&path,))?;
        Ok(path)
    }

    fn _get_uia_backend<'py>(slf: PyRef<'py, Self>) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = me_handle(py, slf);
        let inst = me.getattr("_uia_backend_instance")?;
        if unset(&inst)? {
            // python: `if not hasattr(self, "_uia_backend_instance")` — the
            // sentinel stands in for the attribute that does not exist yet, so
            // the import attempt and its stdout print happen exactly once.
            me.setattr("_uia_backend_instance", none(py))?;
            match mod_import(py, "uia_tree")?.getattr("CtypesUiaBackend")?.call0() {
                Ok(v) => me.setattr("_uia_backend_instance", &v)?,
                Err(e) if is_py_exc(&e, py) => {
                    let ev = e.value_bound(py);
                    builtins(py)?.getattr("print")?.call1((fstr(
                        py,
                        vec![
                            ps(py, "[cua] UIA backend unavailable (degrading): "),
                            fmtv(py, &ev)?,
                        ],
                    )?,))?;
                }
                Err(e) => return Err(e),
            }
        }
        let injected = me.getattr("_uia_backend")?;
        if !injected.is_none() {
            return Ok(injected);
        }
        me.getattr("_uia_backend_instance")
    }

    // ── actions (one per ActionSpec.name) ─────────────────────────────────

    fn screenshot<'py>(
        slf: PyRef<'py, Self>,
        params: &B<'py>,
        _ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = me_handle(py, slf);
        fail_on_exc!(
            py,
            "截图失败: ",
            (|| {
                let engine = me.getattr("_get_engine")?.call0()?;
                let q = pint(py, params, "quality", 80)?;
                let res = engine.call_method(
                    "capture_screen",
                    (),
                    Some(&kwargs(py, &[("roi", &me.getattr("_roi_of")?.call1((params,))?), ("quality", &q)])?),
                )?;
                let mut path = orstr(py, &gget(py, params, "save_path")?, "")?;
                if path.is_truthy()? {
                    path = me.getattr("_save_capture")?.call1((&res, &path))?;
                }
                let value = PyDict::new_bound(py);
                value.set_item("path", &path)?;
                value.set_item("width", res.get_item("width")?)?;
                value.set_item("height", res.get_item("height")?)?;
                value.set_item("scale_factor", res.get_item("scale_factor")?)?;
                if gget(py, params, "with_data_uri")?.is_truthy()? {
                    value.set_item("data_uri", res.get_item("data_uri")?)?;
                }
                ok_res(py, value.into_any())
            })()
        )
    }

    fn window_list<'py>(
        slf: PyRef<'py, Self>,
        params: &B<'py>,
        _ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let _me = me_handle(py, slf);
        let mut rows = match own(py, "_list_top_level_windows")?.call0() {
            Ok(v) => v,
            Err(e) if is_py_exc(&e, py) => {
                let ev = e.value_bound(py);
                return fail_res(
                    py,
                    fstr(
                        py,
                        vec![
                            ps(py, "无法枚举窗口（无桌面会话或权限不足）："),
                            fmtv(py, &ev)?,
                            ps(py, "。可改用 element_info 走 OCR，或直接给坐标。"),
                        ],
                    )?,
                );
            }
            Err(e) => return Err(e),
        };
        let want = orstr(py, &gget(py, params, "title")?, "")?
            .call_method0("strip")?
            .call_method0("lower")?;
        if want.is_truthy()? {
            let mut kept: Vec<B<'py>> = Vec::new();
            for r in rows.iter()? {
                let r = r?;
                let t = orstr(py, &gget(py, &r, "title")?, "")?.call_method0("lower")?;
                if contains(&t, &want)? {
                    kept.push(r);
                }
            }
            rows = list_of(py, kept);
        }
        let twenty = obj(py, 20)?;
        let limit = match bi1(py, "int", &orv(&gget(py, params, "limit")?, &twenty)?) {
            Ok(v) => v,
            Err(e) if is_type_or_value(&e, py) => twenty,
            Err(e) => return Err(e),
        };
        let hundred = obj(py, 100)?;
        let clamped = bi2(
            py,
            "max",
            &obj(py, 1)?,
            &bi2(py, "min", &limit, &hundred)?,
        )?;
        let rows = head(py, &rows, &clamped)?;
        let out = PyDict::new_bound(py);
        out.set_item("count", bi1(py, "len", &rows)?)?;
        out.set_item("windows", &rows)?;
        ok_res(py, out.into_any())
    }

    fn element_tree<'py>(
        slf: PyRef<'py, Self>,
        params: &B<'py>,
        _ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = me_handle(py, slf);
        let target = bi1(py, "int", &orv(&gget(py, params, "hwnd")?, &obj(py, 0)?)?)?;
        if !target.is_truthy()? {
            return fail_res(
                py,
                ps(py, "element_tree 缺少 hwnd 参数。先用 window_list 枚举可见窗口，把它返回的 hwnd 传进来。"),
            );
        }
        let uia = mod_import(py, "uia_tree")?;
        let backend = me.getattr("_get_uia_backend")?.call0()?;
        let got = uia.getattr("walk_elements")?.call(
            (),
            Some(&kwargs(
                py,
                &[
                    ("hwnd", &target),
                    ("backend", &backend),
                    ("max_nodes", &uia.getattr("MAX_NODES")?),
                ],
            )?),
        )?;
        let sentinel = uia.getattr("UIA_UNAVAILABLE")?;
        if same(&got, &sentinel) {
            return fail_res(
                py,
                fstr(
                    py,
                    vec![
                        fmtv(py, &sentinel)?,
                        ps(py, ": 目标窗口的无障碍树不可读（非标准控件或 COM 不可用）。请改用 element_info（OCR）或直接给坐标。"),
                    ],
                )?,
            );
        }
        let name = orstr(py, &gget(py, params, "name")?, "")?;
        let ctype = orstr(py, &gget(py, params, "control_type")?, "")?;
        let aid = orstr(py, &gget(py, params, "automation_id")?, "")?;
        let hits = if name.is_truthy()? || ctype.is_truthy()? || aid.is_truthy()? {
            uia.getattr("find_elements")?.call(
                (&got,),
                Some(&kwargs(
                    py,
                    &[
                        ("name", &name),
                        ("control_type", &ctype),
                        ("automation_id", &aid),
                    ],
                )?),
            )?
        } else {
            got.clone()
        };
        let dpi = pfloat(py, params, "dpi_scale", 1.0)?;
        let n2d = uia.getattr("node_to_dict")?;
        let mut els: Vec<B<'py>> = Vec::new();
        for n in hits.iter()? {
            els.push(n2d.call((&n?,), Some(&kwargs(py, &[("scale_factor", &dpi)])?))?);
        }
        let out = PyDict::new_bound(py);
        out.set_item("count", bi1(py, "len", &hits)?)?;
        out.set_item("elements", list_of(py, els))?;
        ok_res(py, out.into_any())
    }

    fn click_element<'py>(
        slf: PyRef<'py, Self>,
        params: &B<'py>,
        _ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = me_handle(py, slf);
        let target = gget(py, params, "target")?;
        if !is_dict(&target) || !target.is_truthy()? {
            return fail_res(
                py,
                ps(py, "click_element 缺少 target 参数（{name?/control_type?/automation_id?/index?}）"),
            );
        }
        let hwnd = bi1(py, "int", &orv(&gget(py, params, "hwnd")?, &obj(py, 0)?)?)?;
        if !hwnd.is_truthy()? {
            return fail_res(
                py,
                ps(py, "click_element 缺少 hwnd 参数。先用 window_list 枚举可见窗口，把它返回的 hwnd 传进来。"),
            );
        }
        let uia = mod_import(py, "uia_tree")?;
        let backend = me.getattr("_get_uia_backend")?.call0()?;
        let got = uia.getattr("walk_elements")?.call(
            (),
            Some(&kwargs(
                py,
                &[
                    ("hwnd", &hwnd),
                    ("backend", &backend),
                    ("max_nodes", &uia.getattr("MAX_NODES")?),
                ],
            )?),
        )?;
        let sentinel = uia.getattr("UIA_UNAVAILABLE")?;
        if same(&got, &sentinel) {
            return fail_res(
                py,
                fstr(
                    py,
                    vec![
                        fmtv(py, &sentinel)?,
                        ps(py, ": 目标窗口的无障碍树不可读。可改用 click_text 走 OCR 定位，或直接给坐标。"),
                    ],
                )?,
            );
        }
        let dpi = pfloat(py, params, "dpi_scale", 1.0)?;
        let res = uia.getattr("resolve_element_target")?.call(
            (&got, &target),
            Some(&kwargs(py, &[("scale_factor", &dpi)])?),
        )?;
        if !res.get_item(0)?.is_truthy()? {
            return fail_res(py, bi1(py, "str", &res.get_item(1)?)?);
        }
        let mut tx = res.get_item(1)?.get_item(0)?;
        let mut ty = res.get_item(1)?.get_item(1)?;
        // the offsets land BEFORE the off-screen guard (§12)
        tx = op(py, "add", &tx, &pint(py, params, "offset_x", 0)?)?;
        ty = op(py, "add", &ty, &pint(py, params, "offset_y", 0)?)?;
        let b = own(py, "_virtual_screen_bounds")?.call0()?;
        let bx = b.get_item(0)?;
        let by = b.get_item(1)?;
        let bw = b.get_item(2)?;
        let bh = b.get_item(3)?;
        let zero = obj(py, 0)?;
        if lt(py, &zero, &bw)? && lt(py, &zero, &bh)? {
            // `bx <= tx < bx + bw and by <= ty < by + bh` — the && chain
            // short-circuits in the same order, so nothing past the first false
            // conjunct is evaluated.
            let inside = le(py, &bx, &tx)?
                && lt(py, &tx, &op(py, "add", &bx, &bw)?)?
                && le(py, &by, &ty)?
                && lt(py, &ty, &op(py, "add", &by, &bh)?)?;
            if !inside {
                return fail_res(
                    py,
                    fstr(
                        py,
                        vec![
                            ps(py, "目标元素解析到屏幕外坐标 ("),
                            fmtv(py, &tx)?,
                            ps(py, ", "),
                            fmtv(py, &ty)?,
                            ps(py, ")，已拒绝点击。当前虚拟屏幕为 ("),
                            fmtv(py, &bx)?,
                            ps(py, ", "),
                            fmtv(py, &by)?,
                            ps(py, ") 起 "),
                            fmtv(py, &bw)?,
                            ps(py, "×"),
                            fmtv(py, &bh)?,
                            ps(py, "——通常说明目标窗口被最小化了。先用 window_list 确认窗口状态，把它恢复/激活后再试，或改用 click_text 走 OCR 定位。"),
                        ],
                    )?,
                );
            }
        }
        let button = bi1(py, "str", &gget_o(py, params, "button", &ps(py, "left"))?)?;
        let clicks = pint(py, params, "clicks", 1)?;
        fail_on_exc!(
            py,
            "点击目标元素失败: ",
            (|| {
                let engine = me.getattr("_get_engine")?.call0()?;
                engine.call_method(
                    "click",
                    (),
                    Some(&kwargs(py, &[("x", &tx), ("y", &ty), ("button", &button), ("clicks", &clicks)])?),
                )?;
                let out = PyDict::new_bound(py);
                out.set_item("clicked", pair(py, &tx, &ty)?)?;
                out.set_item("target", bi1(py, "dict", &target)?)?;
                out.set_item("button", &button)?;
                out.set_item("clicks", &clicks)?;
                ok_res(py, out.into_any())
            })()
        )
    }

    fn click_text<'py>(
        slf: PyRef<'py, Self>,
        params: &B<'py>,
        _ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = me_handle(py, slf);
        // `str(params.get("text") or params.get("text_target") or "")` — the
        // or-chain short-circuits, so `text_target` is only read when `text` is
        // falsy; both keys are always present in the dict, so no `.get` error.
        let t0 = gget(py, params, "text")?;
        let target = if t0.is_truthy()? {
            t0
        } else {
            let t1 = gget(py, params, "text_target")?;
            if t1.is_truthy()? {
                t1
            } else {
                ps(py, "")
            }
        };
        let target = bi1(py, "str", &target)?
            .call_method0("strip")?;
        if !target.is_truthy()? {
            return fail_res(py, ps(py, "click_text 缺少 text 或 text_target 参数"));
        }
        let mut ocr_lines = gget(py, params, "ocr_lines")?;
        if !ocr_lines.is_truthy()? {
            let step: PyResult<B<'py>> = (|| {
                let engine = me.getattr("_get_engine")?.call0()?;
                let q = obj(py, 80)?;
                let res = engine.call_method(
                    "capture_screen",
                    (),
                    Some(&kwargs(py, &[("quality", &q)])?),
                )?;
                let path = me
                    .getattr("_save_capture")?
                    .call1((&res, &ps(py, "")))?;
                let ocr = me.getattr("_get_ocr_fn")?.call0()?.call1((&path,))?;
                if !ocr.getattr("ok")?.is_truthy()? {
                    return fail_res(
                        py,
                        fstr(
                            py,
                            vec![
                                ps(py, "OCR 不可用: "),
                                fmtv(py, &ocr.getattr("error")?)?,
                            ],
                        )?,
                    );
                }
                let v = orv(&ocr.getattr("value")?, &empty_dict(py))?;
                Ok(orv(&v.get_item("lines")?, &PyList::empty_bound(py).into_any())?)
            })();
            ocr_lines = match step {
                Ok(v) => v,
                Err(e) if is_py_exc(&e, py) => {
                    let ev = e.value_bound(py);
                    return fail_res(
                        py,
                        fstr(
                            py,
                            vec![
                                ps(py, "屏幕感知获取失败: "),
                                fmtv(py, &ev)?,
                            ],
                        )?,
                    );
                }
                Err(e) => return Err(e),
            };
        }
        let anchor = py
            .import_bound("cua_text_anchor")?
            .getattr("TextAnchorResolver")?
            .getattr("resolve_click_target")?
            .call(
                (),
                Some(&kwargs(
                    py,
                    &[
                        ("ocr_boxes", &ocr_lines),
                        ("text", &target),
                        ("exact", &bi1(py, "bool", &gget_o(py, params, "exact", &py_bool(py, false)?)?)?),
                        ("scale_factor", &pfloat(py, params, "dpi_scale", 1.0)?),
                    ],
                )?),
            )?;
        if !anchor.get_item(0)?.is_truthy()? {
            return fail_res(
                py,
                fstr(
                    py,
                    vec![
                        ps(py, "未在屏幕识别文本中找到目标锚点: "),
                        fmtv(py, &target)?,
                        ps(py, " ("),
                        fmtv(py, &anchor.get_item(1)?)?,
                        ps(py, ")"),
                    ],
                )?,
            );
        }
        let mut tx = anchor.get_item(1)?.get_item(0)?;
        let mut ty = anchor.get_item(1)?.get_item(1)?;
        tx = op(py, "add", &tx, &pint(py, params, "offset_x", 0)?)?;
        ty = op(py, "add", &ty, &pint(py, params, "offset_y", 0)?)?;
        let button = bi1(py, "str", &gget_o(py, params, "button", &ps(py, "left"))?)?;
        let clicks = pint(py, params, "clicks", 1)?;
        fail_on_exc!(
            py,
            "点击目标锚点失败: ",
            (|| {
                let engine = me.getattr("_get_engine")?.call0()?;
                engine.call_method(
                    "click",
                    (),
                    Some(&kwargs(py, &[("x", &tx), ("y", &ty), ("button", &button), ("clicks", &clicks)])?),
                )?;
                let out = PyDict::new_bound(py);
                out.set_item("clicked", pair(py, &tx, &ty)?)?;
                out.set_item("text_target", &target)?;
                out.set_item("button", &button)?;
                out.set_item("clicks", &clicks)?;
                ok_res(py, out.into_any())
            })()
        )
    }

    fn click<'py>(
        slf: PyRef<'py, Self>,
        params: &B<'py>,
        ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = me_handle(py, slf);
        let route = gget(py, params, "text_target")?.is_truthy()?
            || (gget(py, params, "text")?.is_truthy()? && !contains(params, &ps(py, "x"))?);
        if route {
            return me.getattr("click_text")?.call1((params, ctx));
        }
        fail_on_exc!(
            py,
            "点击失败: ",
            (|| {
                let engine = me.getattr("_get_engine")?.call0()?;
                let x = pint(py, params, "x", 0)?;
                let y = pint(py, params, "y", 0)?;
                let button = bi1(py, "str", &gget_o(py, params, "button", &ps(py, "left"))?)?;
                let clicks = pint(py, params, "clicks", 1)?;
                engine.call_method(
                    "click",
                    (),
                    Some(&kwargs(py, &[("x", &x), ("y", &y), ("button", &button), ("clicks", &clicks)])?),
                )?;
                let out = PyDict::new_bound(py);
                out.set_item("clicked", pair(py, &x, &y)?)?;
                out.set_item("button", &button)?;
                out.set_item("clicks", &clicks)?;
                ok_res(py, out.into_any())
            })()
        )
    }

    fn hover<'py>(
        slf: PyRef<'py, Self>,
        params: &B<'py>,
        _ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = me_handle(py, slf);
        fail_on_exc!(
            py,
            "悬停失败: ",
            (|| {
                let engine = me.getattr("_get_engine")?.call0()?;
                let x = pint(py, params, "x", 0)?;
                let y = pint(py, params, "y", 0)?;
                let smooth = bi1(
                    py,
                    "bool",
                    &gget_o(py, params, "smooth", &py_bool(py, true)?)?,
                )?;
                engine.call_method(
                    "move_cursor",
                    (),
                    Some(&kwargs(py, &[("x", &x), ("y", &y), ("smooth", &smooth)])?),
                )?;
                let out = PyDict::new_bound(py);
                out.set_item("hovered", pair(py, &x, &y)?)?;
                ok_res(py, out.into_any())
            })()
        )
    }

    fn fill<'py>(
        slf: PyRef<'py, Self>,
        params: &B<'py>,
        _ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = me_handle(py, slf);
        fail_on_exc!(
            py,
            "填充失败: ",
            (|| {
                let engine = me.getattr("_get_engine")?.call0()?;
                let text = bi1(py, "str", &gget_o(py, params, "text", &ps(py, ""))?)?;
                let x = gget(py, params, "x")?;
                let y = gget(py, params, "y")?;
                let mut focused = false;
                if !x.is_none() && !y.is_none() {
                    engine.call_method(
                        "click",
                        (),
                        Some(&kwargs(
                            py,
                            &[
                                ("x", &bi1(py, "int", &x)?),
                                ("y", &bi1(py, "int", &y)?),
                            ],
                        )?),
                    )?;
                    focused = true;
                }
                if text.is_truthy()? {
                    let delay = op(
                        py,
                        "truediv",
                        &pfloat(py, params, "delay_ms", 10.0)?,
                        &flt(py, 1000.0)?,
                    )?;
                    engine.call_method(
                        "type_unicode",
                        (&text,),
                        Some(&kwargs(py, &[("delay_per_char", &delay)])?),
                    )?;
                }
                let out = PyDict::new_bound(py);
                out.set_item("typed_chars", bi1(py, "len", &text)?)?;
                out.set_item("focused_by_click", py_bool(py, focused)?)?;
                ok_res(py, out.into_any())
            })()
        )
    }

    fn scroll<'py>(
        slf: PyRef<'py, Self>,
        params: &B<'py>,
        _ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = me_handle(py, slf);
        fail_on_exc!(
            py,
            "滚动失败: ",
            (|| {
                let engine = me.getattr("_get_engine")?.call0()?;
                let clicks = pint(py, params, "clicks", 0)?;
                let x = gget(py, params, "x")?;
                let y = gget(py, params, "y")?;
                let xv = if x.is_none() { none(py) } else { bi1(py, "int", &x)? };
                let yv = if y.is_none() { none(py) } else { bi1(py, "int", &y)? };
                engine.call_method(
                    "scroll",
                    (&clicks,),
                    Some(&kwargs(py, &[("x", &xv), ("y", &yv)])?),
                )?;
                let out = PyDict::new_bound(py);
                out.set_item("scrolled", &clicks)?;
                ok_res(py, out.into_any())
            })()
        )
    }

    fn drag<'py>(
        slf: PyRef<'py, Self>,
        params: &B<'py>,
        ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = me_handle(py, slf);
        fail_on_exc!(
            py,
            "拖拽失败: ",
            (|| {
                let engine = me.getattr("_get_engine")?.call0()?;
                let sx = pint(py, params, "start_x", 0)?;
                let sy = pint(py, params, "start_y", 0)?;
                let ex = pint(py, params, "end_x", 0)?;
                let ey = pint(py, params, "end_y", 0)?;
                let duration = pfloat(py, params, "duration", 0.5)?;
                if gget(py, params, "observe_midway")?.is_truthy()? {
                    return me.getattr("_drag_observed")?
                        .call1((&engine, &sx, &sy, &ex, &ey, &duration, ctx));
                }
                engine.call_method(
                    "drag",
                    (&sx, &sy, &ex, &ey),
                    Some(&kwargs(py, &[("duration", &duration)])?),
                )?;
                let out = PyDict::new_bound(py);
                out.set_item("from", pair(py, &sx, &sy)?)?;
                out.set_item("to", pair(py, &ex, &ey)?)?;
                ok_res(py, out.into_any())
            })()
        )
    }

    // ── U6: midway observation ────────────────────────────────────────────

    /// Duck-typed contract probe over `_STEP_DRAG_PRIMITIVES` (§13), read from
    /// the module dict at call time.
    #[staticmethod]
    fn _supports_step_drag<'py>(engine: &B<'py>) -> PyResult<bool> {
        let py = engine.py();
        let prims = own(py, "_STEP_DRAG_PRIMITIVES")?;
        let callable = builtins(py)?.getattr("callable")?;
        for n in prims.iter()? {
            let name = n?.extract::<String>()?;
            let attr = getattr_d(engine, &name, none(py), py)?;
            if !callable.call1((&attr,))?.is_truthy()? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    #[allow(clippy::too_many_arguments)]
    fn _drag_observed<'py>(
        slf: PyRef<'py, Self>,
        engine: &B<'py>,
        sx: &B<'py>,
        sy: &B<'py>,
        ex: &B<'py>,
        ey: &B<'py>,
        duration: &B<'py>,
        ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = me_handle(py, slf);
        let value = PyDict::new_bound(py);
        value.set_item("from", pair(py, sx, sy)?)?;
        value.set_item("to", pair(py, ex, ey)?)?;
        if !Self::_supports_step_drag(engine)? {
            engine.call_method(
                "drag",
                (sx, sy, ex, ey),
                Some(&kwargs(py, &[("duration", duration)])?),
            )?;
            value.set_item("midway_note", ps(py, "拖拽中途观察不可用（引擎不支持分步拖拽）"))?;
            return ok_res(py, value.into_any());
        }
        let two = obj(py, 2)?;
        let mid_x = op(py, "floordiv", &op(py, "add", sx, ex)?, &two)?;
        let mid_y = op(py, "floordiv", &op(py, "add", sy, ey)?, &two)?;
        let mut pressed = false;
        let body: PyResult<B<'py>> = (|| {
            engine.call_method1("mouse_down", (sx, sy))?;
            pressed = true;
            engine.call_method1("move_cursor", (&mid_x, &mid_y))?;
            let obs = me.getattr("_midway_observe")?.call1((ctx,))?;
            let out = PyTuple::new_bound(py, vec![obs.get_item(0)?, obs.get_item(1)?, obs.get_item(2)?]);
            engine.call_method1("move_cursor", (ex, ey))?;
            Ok(out.into_any())
        })();
        // try/finally: the button always comes back up and a failure there is
        // swallowed (`except Exception: pass`), so it never rewrites the drag.
        if pressed {
            match engine.call_method0("mouse_up") {
                Ok(_) => {}
                Err(e) if is_py_exc(&e, py) => {}
                Err(e) => return Err(e),
            }
        }
        let obs = body?;
        let (summary, note, shot) = (obs.get_item(0)?, obs.get_item(1)?, obs.get_item(2)?);
        if summary.is_truthy()? {
            value.set_item("midway_summary", &summary)?;
        }
        if note.is_truthy()? {
            value.set_item("midway_note", &note)?;
        }
        if shot.is_truthy()? {
            value.set_item("midway_screenshot", &shot)?;
        }
        ok_res(py, value.into_any())
    }

    /// `(summary, note, screenshot_path)`; every failure collapses into `note`
    /// so the drag is never judged by its observation.
    fn _midway_observe<'py>(slf: PyRef<'py, Self>, ctx: &B<'py>) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = me_handle(py, slf);
        let empty = ps(py, "");
        let step: PyResult<B<'py>> = (|| {
            let engine = me.getattr("_get_engine")?.call0()?;
            let q = obj(py, 70)?;
            let res = engine.call_method(
                "capture_screen",
                (),
                Some(&kwargs(py, &[("quality", &q)])?),
            )?;
            let fp = own(py, "feedback_path")?.call1((ps(py, "drag_midway"), ctx))?;
            me.getattr("_save_capture")?.call1((&res, &fp))
        })();
        let path = match step {
            Ok(v) => v,
            Err(e) if is_py_exc(&e, py) => {
                let ev = e.value_bound(py);
                return Ok(PyTuple::new_bound(
                    py,
                    vec![
                        empty.clone(),
                        fstr(
                            py,
                            vec![
                                ps(py, "拖拽中途观察不可用（中途截图失败: "),
                                fmtv(py, &ev)?,
                                ps(py, "）"),
                            ],
                        )?,
                        empty,
                    ],
                )
                .into_any());
            }
            Err(e) => return Err(e),
        };
        // Stage 2 distinguishes the three python exits: `ocr.ok` False returns
        // early with `ocr.error`, an exception returns with `str(e)`, and both
        // keep the screenshot path.
        let stage2: PyResult<std::result::Result<B<'py>, B<'py>>> = (|| {
            let ocr = me.getattr("_get_ocr_fn")?.call0()?.call1((&path,))?;
            if ocr.getattr("ok")?.is_truthy()? {
                Ok(Ok(ocr))
            } else {
                Ok(Err(ocr.getattr("error")?))
            }
        })();
        let (ocr, note) = match stage2 {
            Ok(Ok(o)) => (Some(o), None),
            Ok(Err(err_val)) => (None, Some(identify_note(py, &err_val)?)),
            Err(e) if is_py_exc(&e, py) => {
                let ev = e.value_bound(py);
                (None, Some(identify_note(py, &ev)?))
            }
            Err(e) => return Err(e),
        };
        if let Some(n) = note {
            return Ok(PyTuple::new_bound(py, vec![empty.clone(), n, path]).into_any());
        }
        let ocr = match ocr {
            Some(o) => o,
            None => return Err(PyImportError::new_err("midway observation lost its result")),
        };
        let mut texts: Vec<B<'py>> = Vec::new();
        let v = orv(&ocr.getattr("value")?, &empty_dict(py))?;
        let lines = orv(&v.get_item("lines")?, &PyList::empty_bound(py).into_any())?;
        for item in lines.iter()? {
            let item = item?;
            if !is_dict(&item) {
                continue;
            }
            let t = bi1(py, "str", &gget_o(py, &item, "text", &ps(py, ""))?)?
                .call_method0("strip")?;
            if t.is_truthy()? {
                texts.push(t);
            }
        }
        let max_lines = own(py, "DRAG_MIDWAY_MAX_LINES")?;
        let body = ps(py, "\n")
            .call_method1("join", (&head(py, &list_of(py, texts), &max_lines)?,))?;
        let cap = own(py, "DRAG_MIDWAY_MAX_CHARS")?;
        let body = if lt(py, &cap, &body)? {
            head(py, &body, &cap)?
        } else {
            body
        };
        let body = if body.is_truthy()? {
            body
        } else {
            ps(py, "（未识别到文本）")
        };
        Ok(PyTuple::new_bound(
            py,
            vec![
                fstr(py, vec![ps(py, "拖拽中途观察:\n"), fmtv(py, &body)?])?,
                empty,
                path,
            ],
        )
        .into_any())
    }

    fn keypress<'py>(
        slf: PyRef<'py, Self>,
        params: &B<'py>,
        _ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = me_handle(py, slf);
        fail_on_exc!(
            py,
            "按键失败: ",
            (|| {
                let engine = me.getattr("_get_engine")?.call0()?;
                let key = bi1(py, "str", &gget_o(py, params, "key", &ps(py, ""))?)?;
                if !key.call_method0("strip")?.is_truthy()? {
                    return fail_res(py, ps(py, "key 不能为空"));
                }
                engine.call_method1("press_key", (&key,))?;
                let out = PyDict::new_bound(py);
                out.set_item("key", &key)?;
                ok_res(py, out.into_any())
            })()
        )
    }

    fn navigate<'py>(
        slf: PyRef<'py, Self>,
        params: &B<'py>,
        _ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let _me = me_handle(py, slf);
        let url = match validate_url(py, &gget_o(py, params, "url", &ps(py, ""))?) {
            Ok(v) => v,
            Err(e) if e.is_instance_of::<PyValueError>(py) => {
                let ev = e.value_bound(py);
                return fail_res(py, bi1(py, "str", &ev)?);
            }
            Err(e) => return Err(e),
        };
        fail_on_exc!(
            py,
            "打开链接失败: ",
            (|| {
                let plat = mod_import(py, "platform")?;
                let cmd = if same_str(py, &plat.getattr("system")?.call0()?, "Darwin")? {
                    fstr(py, vec![ps(py, "open \""), fmtv(py, &url)?, ps(py, "\"")])?
                } else if same_str(py, &plat.getattr("system")?.call0()?, "Windows")? {
                    fstr(
                        py,
                        vec![
                            ps(py, "powershell \"Start-Process '"),
                            fmtv(py, &url)?,
                            ps(py, "'\""),
                        ],
                    )?
                } else {
                    fstr(py, vec![ps(py, "xdg-open \""), fmtv(py, &url)?, ps(py, "\"")])?
                };
                let gs = mod_import(py, "executors")?.getattr("guarded_spawn")?;
                // The source's `lambda: guarded_spawn(cmd, timeout=10)`. Built
                // with CPython's own compiler over a namespace dict so the
                // object is a real function (`__name__ == "<lambda>"`, late
                // global lookup of `gs`/`cmd`) — see the header.
                let ns = PyDict::new_bound(py);
                ns.set_item("gs", &gs)?;
                ns.set_item("cmd", &cmd)?;
                let thunk = py.eval_bound("lambda: gs(cmd, timeout=10)", Some(&ns), None)?;
                let r = mod_import(py, "result")?
                    .getattr("try_result")?
                    .call1((&thunk,))?;
                if r.getattr("ok")?.is_truthy()? {
                    let out = PyDict::new_bound(py);
                    out.set_item("url", &url)?;
                    return ok_res(py, out.into_any());
                }
                fail_res(
                    py,
                    fstr(
                        py,
                        vec![
                            ps(py, "打开链接失败: "),
                            fmtv(py, &r.getattr("error")?)?,
                        ],
                    )?,
                )
            })()
        )
    }

    fn element_info<'py>(
        slf: PyRef<'py, Self>,
        params: &B<'py>,
        _ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = me_handle(py, slf);
        fail_on_exc!(
            py,
            "元素识别失败: ",
            (|| {
                let engine = me.getattr("_get_engine")?.call0()?;
                let q = pint(py, params, "quality", 80)?;
                let res = engine.call_method(
                    "capture_screen",
                    (),
                    Some(&kwargs(
                        py,
                        &[
                            ("roi", &me.getattr("_roi_of")?.call1((params,))?),
                            ("quality", &q),
                        ],
                    )?),
                )?;
                let path = me.getattr("_save_capture")?.call1((
                    &res,
                    &orstr(py, &gget(py, params, "save_path")?, "")?,
                ))?;
                let ocr = me.getattr("_get_ocr_fn")?.call0()?.call1((&path,))?;
                if !ocr.getattr("ok")?.is_truthy()? {
                    let meta = PyDict::new_bound(py);
                    meta.set_item("screenshot_path", &path)?;
                    return fail_res_meta(
                        py,
                        fstr(
                            py,
                            vec![
                                ps(py, "OCR 不可用: "),
                                fmtv(py, &ocr.getattr("error")?)?,
                            ],
                        )?,
                        &meta,
                    );
                }
                let v = orv(&ocr.getattr("value")?, &empty_dict(py))?;
                let lines = orv(&v.get_item("lines")?, &PyList::empty_bound(py).into_any())?;
                let hundred = obj(py, 100)?;
                let twenty = obj(py, 20)?;
                let limit = match bi2(
                    py,
                    "max",
                    &obj(py, 1)?,
                    &bi2(
                        py,
                        "min",
                        &hundred,
                        &bi1(py, "int", &gget_o(py, params, "limit", &twenty)?)?,
                    )?,
                ) {
                    Ok(val) => val,
                    Err(e) if is_type_or_value(&e, py) => twenty,
                    Err(e) => return Err(e),
                };
                let mut items: Vec<Bound<'py, PyDict>> = Vec::new();
                for l in head(py, &lines, &limit)?.iter()? {
                    let l = l?;
                    if !is_dict(&l) {
                        continue;
                    }
                    let bbox = orv(&l.get_item("bbox")?, &PyList::empty_bound(py).into_any())?;
                    let center = own(py, "_bbox_center")?.call1((&bbox,))?;
                    let it = PyDict::new_bound(py);
                    it.set_item("text", bi1(py, "str", &gget_o(py, &l, "text", &ps(py, ""))?)?)?;
                    it.set_item("center", &center)?;
                    it.set_item("confidence", gget_o(py, &l, "confidence", &flt(py, 0.0)?)?)?;
                    items.push(it);
                }
                let out = PyDict::new_bound(py);
                out.set_item("elements", list_of(py, items.iter().map(|d| d.clone().into_any()).collect()))?;
                out.set_item("count", bi1(py, "len", &lines)?)?;
                out.set_item("screenshot_path", &path)?;
                // U5: only screen evidence sets the hint — a params-level key of
                // the same name is never read (§18).
                let expect = orstr(py, &gget(py, params, "expect_text")?, "")?
                    .call_method0("strip")?;
                if expect.is_truthy()? {
                    let norm = own(py, "_match_norm")?;
                    let needle = norm.call1((&expect,))?;
                    if needle.is_truthy()? {
                        let mut hit = false;
                        for l in lines.iter()? {
                            let l = l?;
                            if !is_dict(&l) {
                                continue;
                            }
                            let t = bi1(py, "str", &gget_o(py, &l, "text", &ps(py, ""))?)?;
                            if contains(&norm.call1((&t,))?, &needle)? {
                                hit = true;
                                break;
                            }
                        }
                        if hit {
                            out.set_item("delivery_hint", ps(py, "deliverable"))?;
                        }
                    }
                }
                let x = gget(py, params, "x")?;
                let y = gget(py, params, "y")?;
                if !x.is_none() && !y.is_none() && !items.is_empty() {
                    let step: PyResult<Bound<'py, PyDict>> = (|| {
                        let px = bi1(py, "float", &x)?;
                        let pv = bi1(py, "float", &y)?;
                        let two = obj(py, 2)?;
                        let mut best: Option<(B<'py>, usize)> = None;
                        for (ix, it) in items.iter().enumerate() {
                            let it = it.clone().into_any();
                            let c = get_item(py, &it, "center")?;
                            let score = op(
                                py,
                                "add",
                                &op(py, "pow", &op(py, "sub", &get_idx(&c, 0)?, &px)?, &two)?,
                                &op(py, "pow", &op(py, "sub", &get_idx(&c, 1)?, &pv)?, &two)?,
                            )?;
                            let take = match &best {
                                None => true,
                                Some((b, _)) => lt(py, &score, b)?,
                            };
                            if take {
                                best = Some((score, ix));
                            }
                        }
                        Ok(match best {
                            Some((_, ix)) => items[ix].clone(),
                            None => return Err(pyo3::exceptions::PyValueError::new_err(
                                "min() arg is an empty sequence",
                            )),
                        })
                    })();
                    match step {
                        Ok(n) => out.set_item("nearest", n)?,
                        Err(e) if is_type_or_value(&e, py) => {}
                        Err(e) => return Err(e),
                    }
                }
                ok_res(py, out.into_any())
            })()
        )
    }

    fn wait<'py>(
        slf: PyRef<'py, Self>,
        params: &B<'py>,
        _ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = me_handle(py, slf);
        let seconds = clamp_param(py, params, "seconds", 1.0, 0.0, 30.0)?;
        let timeout = clamp_param(py, params, "timeout", 10.0, 0.0, 60.0)?;
        let for_text = orstr(py, &gget(py, params, "for_text")?, "")?
            .call_method0("strip")?;
        let found_dict = |found: Option<B<'py>>,
                         waited: B<'py>,
                         polled: &B<'py>,
                         path: &B<'py>|
         -> PyResult<Bound<'py, PyDict>> {
            let out = PyDict::new_bound(py);
            out.set_item("waited", &waited)?;
            out.set_item("found", found.unwrap_or_else(|| none(py)))?;
            out.set_item("polled", polled)?;
            out.set_item("screenshot_path", path)?;
            Ok(out)
        };
        if !for_text.is_truthy()? {
            time_attr(py, "sleep")?.call1((&seconds,))?;
            let out = PyDict::new_bound(py);
            out.set_item("waited", &seconds)?;
            out.set_item("found", none(py))?;
            return ok_res(py, out.into_any());
        }
        let deadline = op(py, "add", &time_attr(py, "monotonic")?.call0()?, &timeout)?;
        let mut polled = obj(py, 0)?;
        let needle = for_text.call_method0("lower")?;
        let empty = ps(py, "");
        loop {
            polled = op(py, "add", &polled, &obj(py, 1)?)?;
            let mut path = empty.clone();
            let step: PyResult<B<'py>> = (|| {
                let engine = me.getattr("_get_engine")?.call0()?;
                let q = obj(py, 70)?;
                let res = engine.call_method(
                    "capture_screen",
                    (),
                    Some(&kwargs(py, &[("quality", &q)])?),
                )?;
                path = me
                    .getattr("_save_capture")?
                    .call1((&res, &empty))?;
                let ocr = me.getattr("_get_ocr_fn")?.call0()?.call1((&path,))?;
                if ocr.getattr("ok")?.is_truthy()? {
                    return gget_o(
                        py,
                        &orv(&ocr.getattr("value")?, &empty_dict(py))?,
                        "text",
                        &empty,
                    );
                }
                Ok(empty.clone())
            })();
            let text = match step {
                Ok(v) => v,
                Err(e) if is_py_exc(&e, py) => {
                    let ev = e.value_bound(py);
                    return fail_res(
                        py,
                        fstr(
                            py,
                            vec![ps(py, "等待轮询失败: "), fmtv(py, &ev)?],
                        )?,
                    );
                }
                Err(e) => return Err(e),
            };
            if contains(&bi1(py, "str", &text)?.call_method0("lower")?, &needle)? {
                let now = time_attr(py, "monotonic")?.call0()?;
                let waited = op(
                    py,
                    "sub",
                    &timeout,
                    &bi2(py, "max", &flt(py, 0.0)?, &op(py, "sub", &deadline, &now)?)?,
                )?;
                return ok_res(
                    py,
                    found_dict(
                        Some(py_bool(py, true)?),
                        waited,
                        &polled,
                        &path,
                    )?
                    .into_any(),
                );
            }
            let remaining = op(py, "sub", &deadline, &time_attr(py, "monotonic")?.call0()?)?;
            if le(py, &remaining, &obj(py, 0)?)? {
                return ok_res(
                    py,
                    found_dict(
                        Some(py_bool(py, false)?),
                        timeout.clone(),
                        &polled,
                        &path,
                    )?
                    .into_any(),
                );
            }
            time_attr(py, "sleep")?.call1((
                &bi2(py, "min", &flt(py, 0.5)?, &remaining)?,
            ))?;
        }
    }
}

/// The nested `_clamp` of `wait`: `float()` on a bad value falls back to the
/// default, then `max(lo, min(hi, v))`.
fn clamp_param<'py>(
    py: Python<'py>,
    params: &B<'py>,
    name: &str,
    default: f64,
    lo: f64,
    hi: f64,
) -> PyResult<B<'py>> {
    let d = flt(py, default)?;
    let raw = gget_o(py, params, name, &d)?;
    let v = match bi1(py, "float", &raw) {
        Ok(v) => v,
        Err(e) if is_type_or_value(&e, py) => d,
        Err(e) => return Err(e),
    };
    Ok(bi2(
        py,
        "max",
        &flt(py, lo)?,
        &bi2(py, "min", &flt(py, hi)?, &v)?,
    )?)
}

/// `f"拖拽中途观察不可用（中途识别失败: {x}）"`.
fn identify_note<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    fstr(
        py,
        vec![
            ps(py, "拖拽中途观察不可用（中途识别失败: "),
            fmtv(py, x)?,
            ps(py, "）"),
        ],
    )
}

// ── CuaActionRegistry ───────────────────────────────────────────────────────

#[pyclass(module = "cua_actions", name = "CuaActionRegistry")]
struct CuaActionRegistry {
    #[pyo3(get, set)]
    backend: PyObject,
    #[pyo3(get, set)]
    _ocr_fn: PyObject,
    #[pyo3(get, set)]
    _rules: PyObject,
    #[pyo3(get, set)]
    _now: PyObject,
    #[pyo3(get, set)]
    modifier_guard: PyObject,
    #[pyo3(get, set)]
    _specs: PyObject,
}

/// `def __init__(self, backend=None, ocr_fn=None, rules=None,`
/// `now_fn=time.perf_counter, modifier_guard=None)`
const REGISTRY_PARAMS: [&str; 5] =
    ["backend", "ocr_fn", "rules", "now_fn", "modifier_guard"];

/// Every `self.x` of the python body is a real attribute access on this handle
/// (see the `#[pyclass(dict)]` note above `CuaDesktopBackend`), so a method the
/// python code reaches through `self.` stays overridable at runtime.
fn reg_handle<'py>(py: Python<'py>, slf: PyRef<'py, CuaActionRegistry>) -> B<'py> {
    slf.into_py(py).into_bound(py).into_any()
}

/// `CuaActionResult(ok=…, action=…, …)` through the live class, with the
/// caller's keyword names — the dataclass defaults and `default_factory` fire
/// exactly the way they do in python.
fn car_new<'py>(py: Python<'py>, items: &[(&str, &B<'py>)]) -> PyResult<B<'py>> {
    Ok(own(py, "CuaActionResult")?.call((), Some(&kwargs(py, items)?))?)
}

/// `getattr(x, name, default)` with a dynamic attribute name (the builtin, so a
/// non-str name raises TypeError like python instead of a Rust error).
fn dyn_getattr<'py>(
    py: Python<'py>,
    x: &B<'py>,
    name: &B<'py>,
    default: &B<'py>,
) -> PyResult<B<'py>> {
    Ok(builtins(py)?
        .getattr("getattr")?
        .call1((x, name, default))?)
}

/// `isinstance(x, (tuple, list))` — the real builtin over a tuple of types.
fn is_seq<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<bool> {
    let bi = builtins(py)?;
    Ok(bi.getattr("isinstance")?
        .call1((x, tuple_of(py, vec![bi.getattr("tuple")?, bi.getattr("list")?])?))?
        .is_truthy()?)
}

/// `from permission_rules import RuleBehavior; RuleBehavior.<name>` — the
/// import sits inside the branch that needs it, like python's.
fn rule_behavior<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    Ok(mod_import(py, "permission_rules")?
        .getattr("RuleBehavior")?
        .getattr(name)?)
}

#[pymethods]
impl CuaActionRegistry {
    #[new]
    #[pyo3(signature = (*args, **kwargs))]
    fn py_new<'py>(
        py: Python<'py>,
        args: &Bound<'py, PyTuple>,
        kwargs: Option<&Bound<'py, PyDict>>,
    ) -> PyResult<Bound<'py, Self>> {
        let s = bind_init(py, "CuaActionRegistry", &REGISTRY_PARAMS, 0, args, kwargs)?;
        let backend = slot_opt(py, &s[0])?;
        let ocr_fn = slot_opt(py, &s[1])?;
        let rules = slot_opt(py, &s[2])?;
        // `if modifier_guard is None:` — an explicit None and an omitted
        // argument mean the same thing here, so Option is exact.
        let modifier_guard = slot_opt(py, &s[4])?;
        let guard: B<'py> = match &modifier_guard {
            Some(v) => v.bind(py).clone(),
            None => mod_import(py, "bare_modifier_guard")?
                .getattr("BareModifierGuard")?
                .call0()?,
        };
        let nowf = {
            let raw = s[3].bind(py).clone();
            // DIVERGENCE(port, now_fn default) — see the header.
            if unset(&raw)? {
                time_attr(py, "perf_counter")?
            } else {
                raw
            }
        };
        let me = Py::new(
            py,
            pyo3::PyClassInitializer::from(Self {
                backend: backend.unwrap_or_else(|| py.None()),
                _ocr_fn: ocr_fn.unwrap_or_else(|| py.None()),
                _rules: rules.unwrap_or_else(|| py.None()),
                _now: nowf.unbind(),
                modifier_guard: guard.unbind(),
                _specs: PyDict::new_bound(py).into_any().unbind(),
            }),
        )?
        .into_bound(py);
        for spec in own(py, "ACTION_SPECS")?.iter()? {
            me.call_method1("register", (spec?,))?;
        }
        Ok(me)
    }

    fn register<'py>(&self, py: Python<'py>, spec: &B<'py>) -> PyResult<B<'py>> {
        self._specs
            .bind(py)
            .call_method1("__setitem__", (spec.getattr("name")?, spec))
    }

    fn get<'py>(&self, py: Python<'py>, name: &B<'py>) -> PyResult<B<'py>> {
        let key = orstr(py, name, "")?.call_method0("strip")?;
        self._specs.bind(py).call_method1("get", (&key,))
    }

    fn names<'py>(&self, py: Python<'py>) -> PyResult<B<'py>> {
        call_bi(py, "sorted", (self._specs.bind(py),))
    }

    fn describe<'py>(&self, py: Python<'py>) -> PyResult<B<'py>> {
        let out = PyList::empty_bound(py);
        let vals = self._specs.bind(py).call_method0("values")?;
        for s in vals.iter()? {
            let s = s?;
            out.append(dict_of(
                py,
                &[
                    ("name", &s.getattr("name")?),
                    ("capability", &s.getattr("capability")?),
                    ("guard_tool", &s.getattr("guard_tool")?),
                    ("risk_level", &s.getattr("risk_level")?),
                    ("side_effect", &s.getattr("side_effect")?),
                    ("description", &s.getattr("description")?),
                ],
            )?)?;
        }
        Ok(out.into_any())
    }

    fn _match_rule<'py>(
        &self,
        guard_tool: &B<'py>,
        params: &B<'py>,
        ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = ctx.py();
        let mut store = self._rules.bind(py).clone();
        if store.is_none() {
            store = match mod_import(py, "permission_rules")
                .and_then(|m| m.getattr("get_permission_rules")?.call0())
            {
                Ok(v) => v,
                Err(e) if is_py_exc(&e, py) => return Ok(none(py)),
                Err(e) => return Err(e),
            };
        }
        let call = || -> PyResult<B<'py>> {
            let ws = orstr(py, &gget(py, ctx, "workspace_root")?, "")?;
            let sid = orstr(py, &gget(py, ctx, "session_id")?, "")?;
            let kw = kwargs(py, &[("workspace_root", &ws), ("session_id", &sid)])?;
            store.getattr("match")?.call((guard_tool, params), Some(&kw))
        };
        match call() {
            Ok(v) => Ok(v),
            Err(e) if is_py_exc(&e, py) => Ok(none(py)),
            Err(e) => Err(e),
        }
    }

    /// `(是否放行, 拒绝原因)` — the three existing decision layers, composed
    /// exactly as python composes them (no new scoring, no new rules).
    fn check_permission<'py>(
        slf: PyRef<'py, Self>,
        spec: &B<'py>,
        params: &B<'py>,
        ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = reg_handle(py, slf);
        let ctx = orv(ctx, &empty_dict(py))?;
        let rule = me.getattr("_match_rule")?.call1((
            spec.getattr("guard_tool")?,
            params.clone(),
            ctx.clone(),
        ))?;
        if !rule.is_none() {
            let deny = rule_behavior(py, "DENY")?;
            if same(&rule.getattr("behavior")?, &deny) {
                let note = orv(&rule.getattr("note")?, &ps(py, "用户设置"))?;
                return tuple_of(
                    py,
                    vec![
                        py_bool(py, false)?,
                        fstr(
                            py,
                            vec![
                                ps(py, "已有规则拒绝 "),
                                fmtv(py, &spec.getattr("guard_tool")?)?,
                                ps(py, " 的这类调用（"),
                                fmtv(py, &note)?,
                                ps(py, "）"),
                            ],
                        )?,
                    ],
                );
            }
            let ask = rule_behavior(py, "ASK")?;
            if same(&rule.getattr("behavior")?, &ask) && !gget(py, &ctx, "confirmed")?.is_truthy()? {
                return tuple_of(
                    py,
                    vec![
                        py_bool(py, false)?,
                        fstr(
                            py,
                            vec![
                                ps(py, "已有规则要求 "),
                                fmtv(py, &spec.getattr("guard_tool")?)?,
                                ps(py, " 每次询问，本次调用未获确认。"),
                            ],
                        )?,
                    ],
                );
            }
        }
        let verdict = own(py, "classify_action")?
            .call1((spec.getattr("guard_tool")?, params.clone()))?;
        let t1 = builtins(py)?
            .getattr("tuple")?
            .call1((spec.getattr("scenario_tags")?,))?;
        let dctx = own(py, "_detect_ctx_of")?.call1((&ctx,))?;
        let t2 = own(py, "detect_scenario_tags")?
            .call1((spec.getattr("name")?, params.clone(), dctx))?;
        let tags = op(py, "add", &t1, &t2)?;
        let pre_approved = own(py, "is_pre_approval_source")?
            .call1((gget(py, &ctx, "pre_approval_source")?,))?;
        let floor = own(py, "resolve_confirmation_tier")?.call1((
            spec.getattr("confirmation_class")?,
            tags.clone(),
            pre_approved.clone(),
        ))?;
        let tier =
            own(py, "escalate_tiers")?.call1((verdict.getattr("tier")?, floor))?;

        let reasons = builtins(py)?.getattr("list")?.call1((head(
            py,
            &verdict.getattr("reasons")?,
            &obj(py, 3)?,
        )?,))?;
        let cc = spec.getattr("confirmation_class")?;
        let cls_norm = orstr(py, &cc, "standard")?
            .call_method0("strip")?
            .call_method0("lower")?;
        if !contains(
            &tuple_of(py, vec![ps(py, ""), ps(py, "standard")])?,
            &cls_norm,
        )? {
            reasons.call_method1(
                "append",
                (fstr(py, vec![ps(py, "确认类别 "), fmtv(py, &cc)?])?,),
            )?;
        }
        if tags.is_truthy()? {
            reasons.call_method1(
                "append",
                (op(
                    py,
                    "add",
                    &ps(py, "场景标签 "),
                    &ps(py, "、").call_method1("join", (&tags,))?,
                )?,),
            )?;
        }
        let reason_txt = ps(py, "；").call_method1("join", (&reasons,))?;
        if same(&tier, &own(py, "Tier")?.getattr("HANDOFF")?) {
            return tuple_of(
                py,
                vec![
                    py_bool(py, false)?,
                    fstr(
                        py,
                        vec![
                            ps(py, "这类动作需要用户亲手执行（"),
                            fmtv(py, &reason_txt)?,
                            ps(py, "）"),
                        ],
                    )?,
                ],
            );
        }
        let confirmed = gget(py, &ctx, "confirmed")?.is_truthy()?;
        if same(&tier, &own(py, "Tier")?.getattr("CONFIRM")?) && !confirmed {
            return tuple_of(
                py,
                vec![
                    py_bool(py, false)?,
                    fstr(
                        py,
                        vec![
                            ps(py, "每次执行都需要当场单独确认，预批准不适用（"),
                            fmtv(py, &reason_txt)?,
                            ps(py, "）。获得用户对本次调用的批准后重试。"),
                        ],
                    )?,
                ],
            );
        }
        if same(&tier, &own(py, "Tier")?.getattr("AWARE")?) && !confirmed {
            let mut ok = pre_approved.is_truthy()?;
            if !ok {
                let allow = rule_behavior(py, "ALLOW")?;
                ok = !rule.is_none() && same(&rule.getattr("behavior")?, &allow);
            }
            if !ok {
                return tuple_of(
                    py,
                    vec![
                        py_bool(py, false)?,
                        fstr(
                            py,
                            vec![
                                ps(py, "动作需要知情确认（"),
                                fmtv(py, &reason_txt)?,
                                ps(py, "）。用户批准本次调用、或留下一条允许规则后再试。"),
                            ],
                        )?,
                    ],
                );
            }
        }
        tuple_of(py, vec![py_bool(py, true)?, ps(py, "")])
    }

    /// 查表 → 权限 → 后端 → 反馈闭环。绝不抛异常（后端异常折成 failure Result）。
    #[pyo3(signature = (name, params = None, ctx = None))]
    fn execute<'py>(
        slf: PyRef<'py, Self>,
        name: Py<PyAny>,
        params: Option<Py<PyAny>>,
        ctx: Option<Py<PyAny>>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = reg_handle(py, slf);
        let t0 = me.getattr("_now")?.call0()?;
        let nb = name.into_bound(py);
        let spec = me.getattr("get")?.call1((nb.clone(),))?;
        if spec.is_none() {
            let avail = ps(py, ", ")
                .call_method1("join", (&me.getattr("names")?.call0()?,))?;
            return car_new(
                py,
                &[
                    ("ok", &py_bool(py, false)?),
                    ("action", &orstr(py, &nb, "")?),
                    (
                        "error",
                        &fstr(
                            py,
                            vec![
                                ps(py, "未知动作: "),
                                // §2: the RAW name object is what the message
                                // interpolates, while action= stores str(name or "").
                                fmtv(py, &nb)?,
                                ps(py, "。可用动作: "),
                                avail,
                            ],
                        )?,
                    ),
                ],
            );
        }
        let mut params = match &params {
            Some(v) => v.bind(py).clone(),
            None => empty_dict(py),
        };
        if !is_dict(&params) {
            params = empty_dict(py);
        }
        let mut ctx = match &ctx {
            Some(v) => v.bind(py).clone(),
            None => empty_dict(py),
        };
        if !is_dict(&ctx) {
            ctx = empty_dict(py);
        }
        let perm =
            me.getattr("check_permission")?
                .call1((spec.clone(), params.clone(), ctx.clone()))?;
        let allowed = perm.get_item(0)?.is_truthy()?;
        if !allowed {
            return car_new(
                py,
                &[
                    ("ok", &py_bool(py, false)?),
                    ("action", &spec.getattr("name")?),
                    ("error", &perm.get_item(1)?),
                ],
            );
        }

        // 物理输入冲突防护拦截（仅针对外设控制动作 CAP_POINT / CAP_TYPE）
        let caps = tuple_of(py, vec![own(py, "CAP_POINT")?, own(py, "CAP_TYPE")?])?;
        if contains(&caps, &spec.getattr("capability")?)?
            && !gget(py, &ctx, "skip_modifier_guard")?.is_truthy()?
        {
            let guard = me.getattr("modifier_guard")?;
            if !guard.is_none() {
                let gr = guard.getattr("wait_for_bare_state")?.call(
                    (),
                    Some(&kwargs(py, &[("timeout_ms", &obj(py, 250)?)])?),
                )?;
                let seq = is_seq(py, &gr)?;
                let bare_default = if seq {
                    get_idx(&gr, 0)?
                } else {
                    py_bool(py, gr.is_truthy()?)?
                };
                let clean = dyn_getattr(py, &gr, &ps(py, "bare"), &bare_default)?;
                let reason_default = if seq && plen(py, &gr)? > 1 {
                    get_idx(&gr, 1)?
                } else {
                    bi1(py, "str", &gr)?
                };
                let reason = dyn_getattr(py, &gr, &ps(py, "reason"), &reason_default)?;
                if !clean.is_truthy()? {
                    return car_new(
                        py,
                        &[
                            ("ok", &py_bool(py, false)?),
                            ("action", &spec.getattr("name")?),
                            (
                                "error",
                                &fstr(
                                    py,
                                    vec![
                                        ps(py, "物理输入冲突防护拦截: "),
                                        fmtv(py, &reason)?,
                                    ],
                                )?,
                            ),
                        ],
                    );
                }
            }
        }

        let backend = me.getattr("backend")?;
        let fun = if backend.is_none() {
            none(py)
        } else {
            dyn_getattr(py, &backend, &spec.getattr("name")?, &none(py))?
        };
        if !bi1(py, "callable", &fun)?.is_truthy()? {
            let tname = builtins(py)?
                .getattr("type")?
                .call1((&backend,))?
                .getattr("__name__")?;
            let bname = dyn_getattr(py, &backend, &ps(py, "name"), &tname)?;
            return car_new(
                py,
                &[
                    ("ok", &py_bool(py, false)?),
                    ("action", &spec.getattr("name")?),
                    (
                        "error",
                        &fstr(
                            py,
                            vec![
                                ps(py, "后端 "),
                                fmtv(py, &bname)?,
                                ps(py, " 不支持动作 "),
                                fmtv(py, &spec.getattr("name")?)?,
                            ],
                        )?,
                    ),
                ],
            );
        }
        let r: B<'py> = match fun.call1((params.clone(), ctx.clone())) {
            Ok(v) => v,
            Err(e) if is_py_exc(&e, py) => own(py, "Result")?
                .getattr("failure")?
                .call1((fstr(
                    py,
                    vec![ps(py, "动作执行异常: "), fmtv(py, &e.value_bound(py))?],
                )?,))?,
            Err(e) => return Err(e),
        };
        let r_ok = dyn_getattr(py, &r, &ps(py, "ok"), &py_bool(py, false)?)?
            .is_truthy()?;
        let value = dyn_getattr(py, &r, &ps(py, "value"), &none(py))?;
        let err = orstr(
            py,
            &dyn_getattr(py, &r, &ps(py, "error"), &ps(py, ""))?,
            "",
        )?;
        let details = if r_ok && is_dict(&value) {
            builtins(py)?.getattr("dict")?.call1((&value,))?
        } else {
            empty_dict(py)
        };
        let result = car_new(
            py,
            &[
                ("ok", &py_bool(py, r_ok)?),
                ("action", &spec.getattr("name")?),
                ("error", &err),
                ("details", &details),
            ],
        )?;
        if r_ok && is_dict(&value) {
            // U5：delivery_hint 只认后端按屏幕证据算出的合法值，其余一律落空
            let hint = orstr(py, &gget(py, &value, "delivery_hint")?, "")?;
            if contains(&own(py, "DELIVERY_HINTS")?, &hint)? {
                result.setattr("delivery_hint", &hint)?;
            }
        }
        if result.getattr("ok")?.is_truthy()? && spec.getattr("side_effect")?.is_truthy()? {
            me.getattr("_apply_feedback")?
                .call1((result.clone(), ctx.clone()))?;
        }
        me.getattr("_append_midway_note")?
            .call1((result.clone(), value))?;
        let now = me.getattr("_now")?.call0()?;
        let elapsed = bi1(
            py,
            "int",
            &op(py, "mul", &op(py, "sub", &now, &t0)?, &obj(py, 1000)?)?,
        )?;
        result.setattr("elapsed_ms", &elapsed)?;
        Ok(result)
    }

    /// 副作用动作后的强制反馈：截图落盘 → OCR 摘要。反馈环节任何一步失败都只
    /// 降级（记 note），绝不把已成功的动作改判为失败。
    fn _apply_feedback<'py>(
        slf: PyRef<'py, Self>,
        result: &B<'py>,
        ctx: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = reg_handle(py, slf);
        let body: PyResult<()> = (|| {
            let path = own(py, "feedback_path")?
                .call1((result.getattr("action")?, ctx.clone()))?;
            let kw = dict_of(
                py,
                &[
                    ("save_path", &path),
                    ("quality", &obj(py, 70)?),
                ],
            )?;
            let shot = me
                .getattr("backend")?
                .getattr("screenshot")?
                .call1((kw, ctx.clone()))?;
            if !dyn_getattr(py, &shot, &ps(py, "ok"), &py_bool(py, false)?)?.is_truthy()? {
                result.setattr(
                    "feedback_note",
                    &fstr(
                        py,
                        vec![
                            ps(py, "反馈截图失败: "),
                            fmtv(
                                py,
                                &dyn_getattr(py, &shot, &ps(py, "error"), &ps(py, ""))?,
                            )?,
                        ],
                    )?,
                )?;
                return Ok(());
            }
            let sv = orv(
                &shot.getattr("value")?,
                &empty_dict(py),
            )?;
            let path = gget_o(py, &sv, "path", &ps(py, ""))?;
            result.setattr("screenshot_path", &path)?;
            let mut ocr_fn = me.getattr("_ocr_fn")?;
            if ocr_fn.is_none() {
                let backend = me.getattr("backend")?;
                if has_attr(py, &backend, "_get_ocr_fn")? {
                    ocr_fn = backend.call_method0("_get_ocr_fn")?;
                }
            }
            if ocr_fn.is_none() {
                result.setattr("feedback_note", &ps(py, "OCR 不可用: 未配置识别器"))?;
                return Ok(());
            }
            let ocr = ocr_fn.call1((&path,))?;
            if ocr.getattr("ok")?.is_truthy()? {
                let val = orv(&ocr.getattr("value")?, &empty_dict(py))?;
                result.setattr(
                    "ocr_summary",
                    &me.getattr("_diff_aware_summary")?.call1((val,))?,
                )?;
            } else {
                result.setattr(
                    "feedback_note",
                    &fstr(
                        py,
                        vec![
                            ps(py, "OCR 不可用: "),
                            fmtv(py, &ocr.getattr("error")?)?,
                        ],
                    )?,
                )?;
            }
            Ok(())
        })();
        if let Err(e) = body {
            if !is_py_exc(&e, py) {
                return Err(e);
            }
            result.setattr(
                "feedback_note",
                &fstr(
                    py,
                    vec![
                        ps(py, "反馈环节降级: "),
                        fmtv(py, &e.value_bound(py))?,
                    ],
                )?,
            )?;
        }
        Ok(none(py))
    }

    /// U1：优先走 OcrDiffState 的增量摘要，异常时逐字回退旧 summarize_ocr。
    fn _diff_aware_summary<'py>(&self, ocr_value: &B<'py>) -> PyResult<B<'py>> {
        let py = ocr_value.py();
        let getter = getattr_d(
            &self.backend.bind(py).clone(),
            "_ocr_diff_state",
            none(py),
            py,
        )?;
        if !bi1(py, "callable", &getter)?.is_truthy()? {
            return own(py, "summarize_ocr")?.call1((ocr_value,));
        }
        let body: PyResult<B<'py>> = (|| {
            let state = getter.call0()?;
            let pair = state.call_method1("update_from_ocr", (ocr_value,))?;
            pair.get_item(0)
        })();
        match body {
            Ok(v) => Ok(v),
            Err(e) if is_py_exc(&e, py) => own(py, "summarize_ocr")?.call1((ocr_value,)),
            Err(e) => Err(e),
        }
    }

    /// U6：把拖拽中途观察的摘要/降级说明附进反馈通道。
    #[staticmethod]
    fn _append_midway_note<'py>(
        py: Python<'py>,
        result: &B<'py>,
        value: &B<'py>,
    ) -> PyResult<B<'py>> {
        if !is_dict(value) {
            return Ok(none(py));
        }
        let extra = orstr(
            py,
            &orv(
                &gget(py, value, "midway_summary")?,
                &gget(py, value, "midway_note")?,
            )?,
            "",
        )?;
        if !extra.is_truthy()? {
            return Ok(none(py));
        }
        let cur = result.getattr("feedback_note")?;
        let joined = if cur.is_truthy()? {
            op(py, "add", &op(py, "add", &cur, &ps(py, "\n"))?, &extra)?
                .call_method0("strip")?
        } else {
            extra
        };
        result.setattr("feedback_note", &joined)?;
        Ok(none(py))
    }
}

// ── process singleton ───────────────────────────────────────────────────────

/// `global _executor` sits in the module dict, so the singleton cell is the
/// same object the probe (and `cua_actions._executor`) reads.
fn own_set(py: Python<'_>, name: &str, value: &B<'_>) -> PyResult<()> {
    let m: Option<Py<PyModule>> = ST.lock().as_ref().map(|p| p.clone_ref(py));
    match m {
        Some(p) => p.bind(py).setattr(name, value),
        None => Err(PyImportError::new_err("cua_actions module not registered")),
    }
}

fn get_cua_executor<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let cur = own(py, "_executor")?;
    if !cur.is_none() {
        return Ok(cur);
    }
    let backend = own(py, "CuaDesktopBackend")?.call0()?;
    let reg = own(py, "CuaActionRegistry")?
        .call((), Some(&kwargs(py, &[("backend", &backend)])?))?;
    own_set(py, "_executor", &reg)?;
    Ok(reg)
}

/// 替换单例（测试）。传 None 复位，下次取用时重建。
fn set_cua_executor<'py>(py: Python<'py>, executor: Option<Py<PyAny>>) -> PyResult<B<'py>> {
    let value = match &executor {
        Some(v) => v.bind(py).clone(),
        None => none(py),
    };
    own_set(py, "_executor", &value)?;
    Ok(none(py))
}

// ── TargetRef / ObserveResult (U4) ──────────────────────────────────────────

const TARGET_REF_FIELDS: [&str; 3] = ["kind", "session_id", "object_id"];

#[pyclass(module = "cua_actions", name = "TargetRef", frozen)]
struct TargetRef {
    #[pyo3(get)]
    kind: PyObject,
    #[pyo3(get)]
    session_id: PyObject,
    #[pyo3(get)]
    object_id: PyObject,
}

fn tr_field(py: Python<'_>, slf: &TargetRef, name: &str) -> Py<PyAny> {
    match name {
        "session_id" => slf.session_id.clone_ref(py),
        "object_id" => slf.object_id.clone_ref(py),
        _ => slf.kind.clone_ref(py),
    }
}

fn tr_values<'py>(py: Python<'py>, slf: &TargetRef) -> Vec<B<'py>> {
    TARGET_REF_FIELDS
        .iter()
        .map(|n| tr_field(py, slf, n).into_bound(py))
        .collect()
}

fn tr_class<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(py.get_type_bound::<TargetRef>().into_any())
}

#[pymethods]
impl TargetRef {
    #[new]
    #[pyo3(signature = (*args, **kwargs))]
    fn py_new<'py>(
        py: Python<'py>,
        args: &Bound<'py, PyTuple>,
        kwargs: Option<&Bound<'py, PyDict>>,
    ) -> PyResult<Self> {
        let s = bind_init(py, "TargetRef", &TARGET_REF_FIELDS, 1, args, kwargs)?;
        macro_rules! dv {
            ($i:expr, $def:expr) => {{
                let v: Py<PyAny> = s[$i].clone_ref(py);
                let vb = v.bind(py).clone();
                if unset(&vb)? { $def } else { v }
            }};
        }
        Ok(Self {
            kind: s[0].clone_ref(py),
            session_id: dv!(1, ps(py, "").unbind()),
            object_id: dv!(2, ps(py, "").unbind()),
        })
    }

    /// 规范字符串形态（format_target_ref 的便捷入口）。
    fn format<'py>(slf: PyRef<'py, Self>) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = slf.into_py(py).into_bound(py).into_any();
        format_target_ref(py, &me)
    }

    fn __repr__(slf: PyRef<'_, Self>) -> PyResult<String> {
        let py = slf.py();
        let parts: PyResult<Vec<B<'_>>> = TARGET_REF_FIELDS
            .iter()
            .zip(tr_values(py, &slf))
            .map(|(n, v)| fstr(py, vec![ps(py, n), ps(py, "="), bi1(py, "repr", &v)?]))
            .collect();
        let cls = tr_class(py)?.getattr("__name__")?;
        fstr(
            py,
            vec![
                cls,
                ps(py, "("),
                join_with(py, &ps(py, ", "), parts?)?,
                ps(py, ")"),
            ],
        )
        .and_then(|v| v.extract::<String>().map_err(Into::into))
    }

    fn __eq__(slf: PyRef<'_, Self>, other: &B<'_>) -> PyResult<PyObject> {
        let py = slf.py();
        if !same(&tr_class(py)?, &other.getattr("__class__")?) {
            return Ok(py.NotImplemented());
        }
        let a = PyTuple::new_bound(py, tr_values(py, &slf));
        let b = PyTuple::new_bound(
            py,
            TARGET_REF_FIELDS
                .iter()
                .map(|n| other.getattr(*n))
                .collect::<PyResult<Vec<_>>>()?,
        );
        Ok(py_bool(py, a.eq(&b)?)?.unbind())
    }

    fn __hash__(slf: PyRef<'_, Self>) -> PyResult<isize> {
        let py = slf.py();
        let t = PyTuple::new_bound(py, tr_values(py, &slf));
        bi1(py, "hash", &t.as_any())?.extract::<isize>()
    }

    fn __setattr__(&self, name: &B<'_>, _value: &B<'_>) -> PyResult<()> {
        let py = name.py();
        Err(frozen_err(py, "assign", name)?)
    }

    fn __delattr__(&self, name: &B<'_>) -> PyResult<()> {
        let py = name.py();
        Err(frozen_err(py, "delete", name)?)
    }
}

/// TargetRef → 规范字符串。desktop/app 两段式；tab 三段式（会话号不可省）。
fn format_target_ref<'py>(py: Python<'py>, reference: &B<'py>) -> PyResult<B<'py>> {
    let kind = orstr(py, &getattr_d(reference, "kind", ps(py, ""), py)?, "")?
        .call_method0("strip")?
        .call_method0("lower")?;
    if eq(py, &kind, &ps(py, "tab"))? {
        return fstr(
            py,
            vec![
                ps(py, "tab:"),
                fmtv(py, &reference.getattr("session_id")?)?,
                ps(py, "/"),
                fmtv(py, &reference.getattr("object_id")?)?,
            ],
        );
    }
    if contains(&tuple_of(py, vec![ps(py, "desktop"), ps(py, "app")])?, &kind)? {
        return fstr(
            py,
            vec![
                fmtv(py, &kind)?,
                ps(py, ":"),
                fmtv(py, &reference.getattr("object_id")?)?,
            ],
        );
    }
    Err(PyValueError::new_err(
        fstr(
            py,
            vec![
                ps(py, "未知目标域: "),
                bi1(py, "repr", &kind)?,
                ps(py, "。"),
                own(py, "_TARGET_REF_USAGE")?,
            ],
        )?
        .extract::<String>()?,
    ))
}

/// `a, sep, b = s.partition(x)` — the real str method's 3-tuple.
fn partition<'py>(
    py: Python<'py>,
    s: &B<'py>,
    sep: &str,
) -> PyResult<(B<'py>, B<'py>, B<'py>)> {
    let t = s.call_method1("partition", (ps(py, sep),))?;
    Ok((t.get_item(0)?, t.get_item(1)?, t.get_item(2)?))
}

/// 字符串 → TargetRef；None 缺省整块桌面。绝不猜、绝不静默回落。
fn parse_target_ref<'py>(py: Python<'py>, raw: &B<'py>) -> PyResult<B<'py>> {
    let cls = own(py, "TargetRef")?;
    if raw.is_none() {
        return cls.call1((ps(py, "desktop"), ps(py, ""), ps(py, "0")));
    }
    if builtins(py)?
        .getattr("isinstance")?
        .call1((raw, cls.clone()))?
        .is_truthy()?
    {
        return Ok(raw.clone());
    }
    let usage = own(py, "_TARGET_REF_USAGE")?;
    let text = raw.str()?.call_method0("strip")?;
    let bad = |lit: &str, extra: Option<B<'py>>| {
        let mut parts = vec![ps(py, lit)];
        if let Some(e) = extra {
            parts.push(e);
            parts.push(ps(py, "。"));
        }
        parts.push(usage.clone());
        parts
    };
    if !text.is_truthy()? {
        return Err(PyValueError::new_err(
            fstr(py, bad("target_ref 不能为空。", None))?
                .extract::<String>()?,
        ));
    }
    let (domain, sep, body) = partition(py, &text, ":")?;
    if !sep.is_truthy()? {
        return Err(PyValueError::new_err(
            fstr(
                py,
                bad(
                    "target_ref 缺少域分隔符 ':': ",
                    Some(bi1(py, "repr", &text)?),
                ),
            )?
            .extract::<String>()?,
        ));
    }
    let domain = domain
        .call_method0("strip")?
        .call_method0("lower")?;
    if !contains(&own(py, "TARGET_KINDS")?, &domain)? {
        return Err(PyValueError::new_err(
            fstr(
                py,
                bad(
                    "未知目标域 ",
                    Some(bi1(py, "repr", &domain)?),
                ),
            )?
            .extract::<String>()?,
        ));
    }
    let body = body.call_method0("strip")?;
    if !body.is_truthy()? {
        return Err(PyValueError::new_err(
            fstr(
                py,
                bad(
                    "target_ref 缺少对象号: ",
                    Some(bi1(py, "repr", &text)?),
                ),
            )?
            .extract::<String>()?,
        ));
    }
    if eq(py, &domain, &ps(py, "tab"))? {
        let (sid, slash, tid) = partition(py, &body, "/")?;
        let sid = sid.call_method0("strip")?;
        let tid = tid.call_method0("strip")?;
        let nested = contains(&tid, &ps(py, "/"))?;
        if !slash.is_truthy()?
            || !sid.is_truthy()?
            || !tid.is_truthy()?
            || nested
        {
            return Err(PyValueError::new_err(
                fstr(
                    py,
                    vec![
                        ps(py, "tab 域引用需要会话号与标签号两段齐全、以单个 '/' 分隔: "),
                        bi1(py, "repr", &text)?,
                        ps(py, "。"),
                        usage.clone(),
                    ],
                )?
                .extract::<String>()?,
            ));
        }
        return cls.call1((ps(py, "tab"), sid, tid));
    }
    if !body.call_method0("isdigit")?.is_truthy()? {
        let what = if eq(py, &domain, &ps(py, "desktop"))? {
            "显示器编号"
        } else {
            "进程 PID"
        };
        return Err(PyValueError::new_err(
            fstr(
                py,
                vec![
                    fmtv(py, &domain)?,
                    ps(py, " 域对象号必须是数字（"),
                    ps(py, what),
                    ps(py, "）: "),
                    bi1(py, "repr", &text)?,
                    ps(py, "。"),
                    usage,
                ],
            )?
            .extract::<String>()?,
        ));
    }
    cls.call1((domain, ps(py, ""), body))
}

/// 后端入口的防御性归一：接受 TargetRef 或其字符串形态。
fn as_target_ref<'py>(py: Python<'py>, raw: &B<'py>) -> PyResult<B<'py>> {
    if builtins(py)?
        .getattr("isinstance")?
        .call1((raw, own(py, "TargetRef")?))?
        .is_truthy()?
    {
        return Ok(raw.clone());
    }
    parse_target_ref(py, raw)
}

const OBSERVE_FIELDS: [&str; 5] = [
    "ocr_lines",
    "screenshot_path",
    "meta",
    "ok",
    "error",
];

#[pyclass(module = "cua_actions", name = "ObserveResult")]
struct ObserveResult {
    #[pyo3(get, set)]
    ocr_lines: PyObject,
    #[pyo3(get, set)]
    screenshot_path: PyObject,
    #[pyo3(get, set)]
    meta: PyObject,
    #[pyo3(get, set)]
    ok: PyObject,
    #[pyo3(get, set)]
    error: PyObject,
}

fn obs_field(py: Python<'_>, slf: &ObserveResult, name: &str) -> Py<PyAny> {
    match name {
        "screenshot_path" => slf.screenshot_path.clone_ref(py),
        "meta" => slf.meta.clone_ref(py),
        "ok" => slf.ok.clone_ref(py),
        "error" => slf.error.clone_ref(py),
        _ => slf.ocr_lines.clone_ref(py),
    }
}

fn obs_values<'py>(py: Python<'py>, slf: &ObserveResult) -> Vec<B<'py>> {
    OBSERVE_FIELDS
        .iter()
        .map(|n| obs_field(py, slf, n).into_bound(py))
        .collect()
}

fn obs_class<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(py.get_type_bound::<ObserveResult>().into_any())
}

#[pymethods]
impl ObserveResult {
    #[new]
    #[pyo3(signature = (*args, **kwargs))]
    fn py_new<'py>(
        py: Python<'py>,
        args: &Bound<'py, PyTuple>,
        kwargs: Option<&Bound<'py, PyDict>>,
    ) -> PyResult<Self> {
        let s = bind_init(py, "ObserveResult", &OBSERVE_FIELDS, 1, args, kwargs)?;
        macro_rules! dv {
            ($i:expr, $def:expr) => {{
                let v: Py<PyAny> = s[$i].clone_ref(py);
                let vb = v.bind(py).clone();
                if unset(&vb)? { $def } else { v }
            }};
        }
        Ok(Self {
            ocr_lines: s[0].clone_ref(py),
            screenshot_path: dv!(1, ps(py, "").unbind()),
            meta: dv!(2, PyDict::new_bound(py).into_any().unbind()),
            ok: dv!(3, py_bool(py, true)?.unbind()),
            error: dv!(4, ps(py, "").unbind()),
        })
    }

    fn __repr__(slf: PyRef<'_, Self>) -> PyResult<String> {
        let py = slf.py();
        let parts: PyResult<Vec<B<'_>>> = OBSERVE_FIELDS
            .iter()
            .zip(obs_values(py, &slf))
            .map(|(n, v)| fstr(py, vec![ps(py, n), ps(py, "="), bi1(py, "repr", &v)?]))
            .collect();
        let cls = obs_class(py)?.getattr("__name__")?;
        fstr(
            py,
            vec![
                cls,
                ps(py, "("),
                join_with(py, &ps(py, ", "), parts?)?,
                ps(py, ")"),
            ],
        )
        .and_then(|v| v.extract::<String>().map_err(Into::into))
    }

    fn __eq__(slf: PyRef<'_, Self>, other: &B<'_>) -> PyResult<PyObject> {
        let py = slf.py();
        if !same(&obs_class(py)?, &other.getattr("__class__")?) {
            return Ok(py.NotImplemented());
        }
        let a = PyTuple::new_bound(py, obs_values(py, &slf));
        let b = PyTuple::new_bound(
            py,
            OBSERVE_FIELDS
                .iter()
                .map(|n| other.getattr(*n))
                .collect::<PyResult<Vec<_>>>()?,
        );
        Ok(py_bool(py, a.eq(&b)?)?.unbind())
    }

    fn __hash__(&self) -> PyResult<isize> {
        Err(PyTypeError::new_err("unhashable type: 'ObserveResult'"))
    }
}

/// 从 OCR 引擎输出提取非空文本行（与 summarize_ocr 同一提取约定）。
fn ocr_lines_of<'py>(py: Python<'py>, ocr_value: &B<'py>) -> PyResult<B<'py>> {
    let out = PyList::empty_bound(py);
    if is_dict(ocr_value) {
        let lines = orv(&gget(py, ocr_value, "lines")?, &list_of(py, vec![]))?;
        for item in lines.iter()? {
            let item = item?;
            if !is_dict(&item) {
                continue;
            }
            let t = bi1(py, "str", &gget_o(py, &item, "text", &ps(py, ""))?)?
                .call_method0("strip")?;
            if t.is_truthy()? {
                out.append(t)?;
            }
        }
    }
    Ok(out.into_any())
}

// ── U4 target backends and router ───────────────────────────────────────────

fn obs_new<'py>(py: Python<'py>, items: &[(&str, &B<'py>)]) -> PyResult<B<'py>> {
    Ok(own(py, "ObserveResult")?.call((), Some(&kwargs(py, items)?))?)
}

fn obs_fail<'py>(py: Python<'py>, msg: &B<'py>) -> PyResult<B<'py>> {
    obs_new(
        py,
        &[
            ("ocr_lines", &list_of(py, vec![])),
            ("ok", &py_bool(py, false)?),
            ("error", msg),
        ],
    )
}

/// 失败时已拿到的中间产物（截图路径）照样带上。
fn obs_fail_shot<'py>(
    py: Python<'py>,
    msg: &B<'py>,
    path: &B<'py>,
    meta: &B<'py>,
) -> PyResult<B<'py>> {
    obs_new(
        py,
        &[
            ("ocr_lines", &list_of(py, vec![])),
            ("ok", &py_bool(py, false)?),
            ("error", msg),
            ("screenshot_path", path),
            ("meta", meta),
        ],
    )
}

/// `{target_ref, screenshot_path}` + the keys whose value `is not None` (§20).
fn obs_meta<'py>(
    py: Python<'py>,
    reference: &B<'py>,
    path: &B<'py>,
    src: &B<'py>,
    keys: &[&str],
) -> PyResult<B<'py>> {
    let m = PyDict::new_bound(py);
    m.set_item(
        "target_ref",
        own(py, "format_target_ref")?.call1((reference,))?,
    )?;
    m.set_item("screenshot_path", path)?;
    for k in keys {
        let v = gget(py, src, k)?;
        if !v.is_none() {
            m.set_item(*k, v)?;
        }
    }
    Ok(m.into_any())
}

/// `_get_ocr_fn` of both target backends: the `OCR` class is captured when the
/// getter runs, the instance lives in a shared `holder` dict.
fn make_recognizer<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(Py::new(
        py,
        OcrRecognizer {
            holder: PyDict::new_bound(py).into_any().unbind(),
            ocr_cls: py
                .import_bound("edge.ocr")?
                .getattr("OCR")?
                .into_any()
                .unbind(),
        },
    )?
    .into_bound(py)
    .into_any())
}

fn result_success<'py>(py: Python<'py>, value: &B<'py>) -> PyResult<B<'py>> {
    Ok(own(py, "Result")?.call_method1("success", (value,))?)
}

fn result_failure<'py>(py: Python<'py>, msg: &B<'py>) -> PyResult<B<'py>> {
    Ok(own(py, "Result")?.call_method1("failure", (msg,))?)
}

#[pyclass(module = "cua_actions", name = "DesktopTargetBackend")]
struct DesktopTargetBackend {
    #[pyo3(get, set)]
    _registry: PyObject,
    #[pyo3(get, set)]
    _desktop: PyObject,
}

impl UnwindSafe for DesktopTargetBackend {}

fn dtb_handle<'py>(py: Python<'py>, slf: PyRef<'py, DesktopTargetBackend>) -> B<'py> {
    slf.into_py(py).into_bound(py).into_any()
}

/// `def __init__(self, desktop_backend=None, registry=None)`
const DESKTOP_TARGET_PARAMS: [&str; 2] = ["desktop_backend", "registry"];

#[pymethods]
impl DesktopTargetBackend {
    #[classattr]
    fn name() -> &'static str {
        "desktop"
    }

    #[new]
    #[pyo3(signature = (*args, **kwargs))]
    fn py_new<'py>(
        py: Python<'py>,
        args: &Bound<'py, PyTuple>,
        kwargs: Option<&Bound<'py, PyDict>>,
    ) -> PyResult<Self> {
        // §27: registry wins, then desktop_backend (a registry is built around
        // it), then the process singleton — and registry.backend is fetched
        // even when both arguments are given. An explicit None is as absent as
        // an omitted argument, which is what `is not None` means in python.
        let s = bind_init(py, "DesktopTargetBackend", &DESKTOP_TARGET_PARAMS, 0, args, kwargs)?;
        let d_arg = slot_opt(py, &s[0])?.map(|p| p.bind(py).clone());
        let r_arg = slot_opt(py, &s[1])?.map(|p| p.bind(py).clone());
        let (reg, desk): (B<'py>, B<'py>) = if let Some(rb) = r_arg {
            let d = match &d_arg {
                Some(d) => d.clone(),
                None => rb.getattr("backend")?,
            };
            (rb, d)
        } else if let Some(db) = &d_arg {
            let kw = PyDict::new_bound(py);
            kw.set_item("backend", db)?;
            let r = own(py, "CuaActionRegistry")?.call((), Some(&kw))?;
            (r, db.clone())
        } else {
            let g = get_cua_executor(py)?;
            let desk = g.getattr("backend")?;
            (g, desk)
        };
        Ok(Self {
            _registry: reg.unbind(),
            _desktop: desk.unbind(),
        })
    }

    #[pyo3(signature = (target_ref, ctx = None))]
    fn observe<'py>(
        slf: PyRef<'py, Self>,
        target_ref: &B<'py>,
        ctx: Option<Py<PyAny>>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = dtb_handle(py, slf);
        let ctx = match &ctx {
            Some(c) => c.bind(py).clone(),
            None => none(py),
        };
        let ctx = if is_dict(&ctx) { ctx } else { empty_dict(py) };
        let reference = own(py, "_as_target_ref")?.call1((target_ref.clone(),))?;
        let shot = (|| -> PyResult<B<'py>> {
            let p = own(py, "feedback_path")?.call1((ps(py, "observe"), ctx.clone()))?;
            let kw = dict_of(
                py,
                &[("save_path", &p), ("quality", &obj(py, 70)?)],
            )?;
            me.getattr("_desktop")?
                .call_method("screenshot", (kw, ctx.clone()), None)
        })();
        let shot = match shot {
            Ok(v) => v,
            Err(e) if is_py_exc(&e, py) => {
                return obs_fail(
                    py,
                    &fstr(
                        py,
                        vec![ps(py, "观察截图失败: "), fmtv(py, &e.value_bound(py))?],
                    )?,
                )
            }
            Err(e) => return Err(e),
        };
        if !getattr_d(&shot, "ok", py_bool(py, false)?, py)?.is_truthy()? {
            return obs_fail(
                py,
                &fstr(
                    py,
                    vec![
                        ps(py, "观察截图失败: "),
                        fmtv(py, &getattr_d(&shot, "error", ps(py, ""), py)?)?,
                    ],
                )?,
            );
        }
        let probe = shot.getattr("value")?;
        let value = if is_dict(&probe) {
            shot.getattr("value")?
        } else {
            empty_dict(py)
        };
        let path = bi1(py, "str", &gget_o(py, &value, "path", &ps(py, ""))?)?;
        let meta = obs_meta(
            py,
            &reference,
            &path,
            &value,
            &["width", "height", "scale_factor"],
        )?;
        let ocr = (|| -> PyResult<B<'py>> {
            let f = me
                .getattr("_desktop")?
                .call_method0("_get_ocr_fn")?;
            f.call1((&path,))
        })();
        let ocr = match ocr {
            Ok(v) => v,
            Err(e) if is_py_exc(&e, py) => {
                return obs_fail_shot(
                    py,
                    &fstr(
                        py,
                        vec![ps(py, "观察识别失败: "), fmtv(py, &e.value_bound(py))?],
                    )?,
                    &path,
                    &meta,
                )
            }
            Err(e) => return Err(e),
        };
        if !ocr.getattr("ok")?.is_truthy()? {
            return obs_fail_shot(
                py,
                &fstr(
                    py,
                    vec![ps(py, "OCR 不可用: "), fmtv(py, &ocr.getattr("error")?)?],
                )?,
                &path,
                &meta,
            );
        }
        obs_new(
            py,
            &[
                ("ocr_lines", &own(py, "_ocr_lines_of")?.call1((ocr.getattr("value")?,))?),
                ("screenshot_path", &path),
                ("meta", &meta),
            ],
        )
    }

    #[pyo3(signature = (target_ref, action, params = None, ctx = None))]
    fn act<'py>(
        slf: PyRef<'py, Self>,
        target_ref: &B<'py>,
        action: &B<'py>,
        params: Option<Py<PyAny>>,
        ctx: Option<Py<PyAny>>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = dtb_handle(py, slf);
        let _ = target_ref;
        let p = match &params {
            Some(v) => v.bind(py).clone(),
            None => none(py),
        };
        let c = match &ctx {
            Some(v) => v.bind(py).clone(),
            None => none(py),
        };
        let car = me
            .getattr("_registry")?
            .call_method1("execute", (orstr(py, action, "")?, p, c))?;
        if car.getattr("ok")?.is_truthy()? {
            return result_success(py, &car.call_method0("to_dict")?);
        }
        Ok(own(py, "Result")?.call_method(
            "failure",
            (car.getattr("error")?,),
            Some(&kwargs(
                py,
                &[
                    ("action", &car.getattr("action")?),
                    ("elapsed_ms", &car.getattr("elapsed_ms")?),
                ],
            )?),
        )?)
    }
}

#[pyclass(module = "cua_actions", name = "BrowserTargetBackend")]
struct BrowserTargetBackend {
    #[pyo3(get, set)]
    _manager: PyObject,
    #[pyo3(get, set)]
    _ocr_fn: PyObject,
}

impl UnwindSafe for BrowserTargetBackend {}

fn btb_handle<'py>(py: Python<'py>, slf: PyRef<'py, BrowserTargetBackend>) -> B<'py> {
    slf.into_py(py).into_bound(py).into_any()
}

/// `def __init__(self, manager, ocr_fn=None)`
const BROWSER_TARGET_PARAMS: [&str; 2] = ["manager", "ocr_fn"];

#[pymethods]
impl BrowserTargetBackend {
    #[classattr]
    fn name() -> &'static str {
        "browser"
    }

    /// 本域真正支持的动作集（能力诚实性的唯一依据）。
    #[classattr]
    #[allow(non_snake_case)]
    fn SUPPORTED_ACTIONS(py: Python<'_>) -> PyResult<PyObject> {
        frozenset_of(
            py,
            &[
                "navigate",
                "activate",
                "close",
                "suspend",
                "resume",
                "claim",
            ],
        )
        .map(|v| v.unbind())
    }

    #[new]
    #[pyo3(signature = (*args, **kwargs))]
    fn py_new<'py>(
        py: Python<'py>,
        args: &Bound<'py, PyTuple>,
        kwargs: Option<&Bound<'py, PyDict>>,
    ) -> PyResult<Self> {
        let s = bind_init(py, "BrowserTargetBackend", &BROWSER_TARGET_PARAMS, 1, args, kwargs)?;
        Ok(Self {
            _manager: s[0].clone_ref(py),
            _ocr_fn: slot_opt(py, &s[1])?.unwrap_or_else(|| py.None()),
        })
    }

    fn _get_ocr_fn<'py>(slf: PyRef<'py, Self>) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = btb_handle(py, slf);
        let f = me.getattr("_ocr_fn")?;
        if !f.is_none() {
            return Ok(f);
        }
        let rec = make_recognizer(py)?;
        me.setattr("_ocr_fn", &rec)?;
        Ok(rec.into_any())
    }

    #[pyo3(signature = (target_ref, ctx = None))]
    fn observe<'py>(
        slf: PyRef<'py, Self>,
        target_ref: &B<'py>,
        ctx: Option<Py<PyAny>>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = btb_handle(py, slf);
        let ctx = match &ctx {
            Some(c) => c.bind(py).clone(),
            None => none(py),
        };
        let ctx = if is_dict(&ctx) { ctx } else { empty_dict(py) };
        let reference = own(py, "_as_target_ref")?.call1((target_ref.clone(),))?;
        let task_id = orstr(py, &reference.getattr("session_id")?, "")?;
        if !task_id.is_truthy()? {
            return obs_fail(
                py,
                &fstr(
                    py,
                    vec![
                        ps(py, "观察失败: 缺少会话号。"),
                        own(py, "_TARGET_REF_USAGE")?,
                    ],
                )?,
            );
        }
        let object_id = orstr(py, &reference.getattr("object_id")?, "")?;
        let stem = fstr(
            py,
            vec![
                ps(py, "tab_"),
                orv(&object_id, &ps(py, "focus"))?,
                ps(py, "_"),
                time_attr(py, "strftime")?.call1((ps(py, "%Y%m%d_%H%M%S"),))?,
                ps(py, "_"),
            ],
        )?;
        let ms = op(
            py,
            "mod",
            &op(py, "mul", &time_attr(py, "time")?.call0()?, &obj(py, 1000)?)?,
            &obj(py, 1000)?,
        )?;
        let name = fstr(
            py,
            vec![
                stem,
                fmtsp(py, &bi1(py, "int", &ms)?, "03d")?,
                ps(py, ".png"),
            ],
        )?;
        let join = mod_import(py, "os")?.getattr("path")?.getattr("join")?;
        let save_path = match join.call1((&feedback_dir(py, Some(&ctx))?, &name)) {
            Ok(v) => v,
            Err(e) if is_py_exc(&e, py) => ps(py, ""),
            Err(e) => return Err(e),
        };
        let tab_arg = orv(&object_id, &none(py))?;
        let r = (|| -> PyResult<B<'py>> {
            me.getattr("_manager")?.call_method(
                "capture_tab",
                (task_id.clone(),),
                Some(&kwargs(
                    py,
                    &[
                        ("tab_id", &tab_arg),
                        ("save_path", &orv(&save_path, &none(py))?),
                    ],
                )?),
            )
        })();
        let r = match r {
            Ok(v) => v,
            Err(e) if is_py_exc(&e, py) => {
                return obs_fail(
                    py,
                    &fstr(
                        py,
                        vec![ps(py, "标签截图失败: "), fmtv(py, &e.value_bound(py))?],
                    )?,
                )
            }
            Err(e) => return Err(e),
        };
        if !getattr_d(&r, "ok", py_bool(py, false)?, py)?.is_truthy()? {
            let msg = orv(
                &getattr_d(&r, "error", ps(py, ""), py)?,
                &ps(py, "标签截图失败"),
            )?;
            return obs_fail(py, &bi1(py, "str", &msg)?);
        }
        let probe = r.getattr("value")?;
        let info = if is_dict(&probe) {
            r.getattr("value")?
        } else {
            empty_dict(py)
        };
        let path = bi1(py, "str", &gget_o(py, &info, "path", &ps(py, ""))?)?;
        let meta = obs_meta(
            py,
            &reference,
            &path,
            &info,
            &["tab_id", "session_id", "width", "height"],
        )?;
        let ocr = (|| -> PyResult<B<'py>> {
            me.call_method0("_get_ocr_fn")?.call1((&path,))
        })();
        let ocr = match ocr {
            Ok(v) => v,
            Err(e) if is_py_exc(&e, py) => {
                return obs_fail_shot(
                    py,
                    &fstr(
                        py,
                        vec![ps(py, "观察识别失败: "), fmtv(py, &e.value_bound(py))?],
                    )?,
                    &path,
                    &meta,
                )
            }
            Err(e) => return Err(e),
        };
        if !ocr.getattr("ok")?.is_truthy()? {
            return obs_fail_shot(
                py,
                &fstr(
                    py,
                    vec![ps(py, "OCR 不可用: "), fmtv(py, &ocr.getattr("error")?)?],
                )?,
                &path,
                &meta,
            );
        }
        obs_new(
            py,
            &[
                (
                    "ocr_lines",
                    &own(py, "_ocr_lines_of")?.call1((ocr.getattr("value")?,))?,
                ),
                ("screenshot_path", &path),
                ("meta", &meta),
            ],
        )
    }

    #[pyo3(signature = (target_ref, action, params = None, ctx = None))]
    fn act<'py>(
        slf: PyRef<'py, Self>,
        target_ref: &B<'py>,
        action: &B<'py>,
        params: Option<Py<PyAny>>,
        ctx: Option<Py<PyAny>>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = btb_handle(py, slf);
        let _ = ctx;
        let params = match &params {
            Some(v) => v.bind(py).clone(),
            None => none(py),
        };
        let params = if is_dict(&params) { params } else { empty_dict(py) };
        let reference = own(py, "_as_target_ref")?.call1((target_ref.clone(),))?;
        if !same_str(py, &orstr(py, &reference.getattr("kind")?, "")?, "tab")? {
            return result_failure(
                py,
                &fstr(
                    py,
                    vec![
                        ps(py, "浏览器后端只服务 tab 域目标，收到: "),
                        fmtv(py, &own(py, "format_target_ref")?.call1((&reference,))?)?,
                    ],
                )?,
            );
        }
        let task_id = orstr(py, &reference.getattr("session_id")?, "")?;
        let tab_id = orstr(py, &reference.getattr("object_id")?, "")?;
        if !task_id.is_truthy()? {
            return result_failure(
                py,
                &fstr(
                    py,
                    vec![
                        ps(py, "浏览器后端缺少会话号。"),
                        own(py, "_TARGET_REF_USAGE")?,
                    ],
                )?,
            );
        }
        let act = orstr(py, action, "")?.call_method0("strip")?;
        let mgr = me.getattr("_manager")?;
        if same_str(py, &act, "navigate")? {
            let url = match own(py, "validate_url")?
                .call1((gget_o(py, &params, "url", &ps(py, ""))?,))
            {
                Ok(v) => v,
                Err(e) if e.is_instance_of::<PyValueError>(py) => {
                    return result_failure(py, &bi1(py, "str", &e.value_bound(py))?)
                }
                Err(e) => return Err(e),
            };
            return mgr.call_method(
                "navigate_tab",
                (task_id, url),
                Some(&kwargs(py, &[("tab_id", &orv(&tab_id, &none(py))?)])?),
            );
        }
        for (n, m) in [
            ("activate", "activate_tab"),
            ("close", "close_tab"),
            ("suspend", "suspend_tab"),
            ("resume", "resume_tab"),
        ] {
            if same_str(py, &act, n)? {
                return mgr.call_method1(m, (task_id, tab_id));
            }
        }
        if same_str(py, &act, "claim")? {
            let claim = own(py, "TabClaim")?.call(
                (),
                Some(&kwargs(
                    py,
                    &[
                        ("object_id", &tab_id),
                        (
                            "title_snapshot",
                            &orstr(py, &gget(py, &params, "title_snapshot")?, "")?,
                        ),
                        (
                            "url_snapshot",
                            &orstr(py, &gget(py, &params, "url_snapshot")?, "")?,
                        ),
                    ],
                )?),
            )?;
            return mgr.call_method1("claim_tab", (task_id, claim));
        }
        result_failure(
            py,
            &fstr(
                py,
                vec![ps(py, "浏览器后端暂不支持动作 "), fmtv(py, &act)?],
            )?,
        )
    }
}

/// 目标路由器：按 TargetRef 的域派发 observe/act，权限两域单源同判。
#[pyclass(module = "cua_actions", name = "TargetRouter")]
struct TargetRouter {
    #[pyo3(get, set)]
    _registry: PyObject,
    #[pyo3(get, set)]
    _backends: PyObject,
}

impl UnwindSafe for TargetRouter {}

fn router_handle<'py>(py: Python<'py>, slf: PyRef<'py, TargetRouter>) -> B<'py> {
    slf.into_py(py).into_bound(py).into_any()
}

/// `def __init__(self, registry=None)`
const ROUTER_PARAMS: [&str; 1] = ["registry"];

#[pymethods]
impl TargetRouter {
    #[new]
    #[pyo3(signature = (*args, **kwargs))]
    fn py_new<'py>(
        py: Python<'py>,
        args: &Bound<'py, PyTuple>,
        kwargs: Option<&Bound<'py, PyDict>>,
    ) -> PyResult<Self> {
        let s = bind_init(py, "TargetRouter", &ROUTER_PARAMS, 0, args, kwargs)?;
        Ok(Self {
            _registry: slot_opt(py, &s[0])?.unwrap_or_else(|| py.None()),
            _backends: PyDict::new_bound(py).into_any().unbind(),
        })
    }

    /// 权限/声明单源：未注入时懒取进程级桌面注册表。
    #[getter]
    fn registry<'py>(slf: PyRef<'py, Self>) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = router_handle(py, slf);
        let cur = me.getattr("_registry")?;
        if !cur.is_none() {
            return Ok(cur);
        }
        let reg = get_cua_executor(py)?;
        me.setattr("_registry", &reg)?;
        me.getattr("_registry")
    }

    fn register_backend<'py>(&self, kind: &B<'py>, backend: &B<'py>) -> PyResult<B<'py>> {
        let py = kind.py();
        let kind = orstr(py, kind, "")?.call_method0("strip")?.call_method0("lower")?;
        if !contains(&own(py, "TARGET_KINDS")?, &kind)? {
            let joined = ps(py, ", ")
                .call_method1("join", (&own(py, "TARGET_KINDS")?,))?;
            return Err(PyValueError::new_err(
                fstr(
                    py,
                    vec![
                        ps(py, "未知目标域: "),
                        bi1(py, "repr", &kind)?,
                        ps(py, "。合法域: "),
                        joined,
                    ],
                )?
                .extract::<String>()?,
            ));
        }
        self._backends
            .bind(py)
            .call_method1("__setitem__", (&kind, backend))?;
        Ok(none(py))
    }

    fn resolve<'py>(&self, py: Python<'py>, target_ref: &B<'py>) -> PyResult<B<'py>> {
        let reference = match own(py, "_as_target_ref")?.call1((target_ref,)) {
            Ok(v) => v,
            Err(e) if e.is_instance_of::<PyValueError>(py) => {
                return result_failure(py, &bi1(py, "str", &e.value_bound(py))?)
            }
            Err(e) => return Err(e),
        };
        let backend = self
            ._backends
            .bind(py)
            .call_method1("get", (reference.getattr("kind")?,))?;
        if backend.is_none() {
            let sorted = call_bi(py, "sorted", (self._backends.bind(py),))?;
            let registered = orv(
                &ps(py, ", ").call_method1("join", (&sorted,))?,
                &ps(py, "无"),
            )?;
            return result_failure(
                py,
                &fstr(
                    py,
                    vec![
                        ps(py, "目标域 "),
                        fmtv(py, &reference.getattr("kind")?)?,
                        ps(py, " 未注册后端（已注册: "),
                        registered,
                        ps(py, "）——该域目标当前不可观察也不可操作"),
                    ],
                )?,
            );
        }
        result_success(py, &backend)
    }

    fn _spec_for<'py>(
        slf: PyRef<'py, Self>,
        kind: &B<'py>,
        action: &B<'py>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let reg = router_handle(py, slf).getattr("registry")?;
        let spec = reg.call_method1("get", (action,))?;
        if !spec.is_none() {
            return Ok(spec);
        }
        if same_str(py, kind, "tab")? {
            return own(py, "BROWSER_ACTION_SPECS")?
                .call_method1("get", (action,));
        }
        Ok(none(py))
    }

    fn action_names<'py>(slf: PyRef<'py, Self>, kind: &B<'py>) -> PyResult<B<'py>> {
        let py = slf.py();
        let reg = router_handle(py, slf).getattr("registry")?;
        let names = builtins(py)?
            .getattr("set")?
            .call1((reg.call_method0("names")?,))?;
        if same_str(
            py,
            &orstr(py, kind, "")?
                .call_method0("strip")?
                .call_method0("lower")?,
            "tab",
        )? {
            names.call_method1("update", (&own(py, "BROWSER_ACTION_SPECS")?,))?;
        }
        call_bi(py, "sorted", (&names,))
    }

    #[pyo3(signature = (target_ref, ctx = None))]
    fn observe<'py>(
        slf: PyRef<'py, Self>,
        target_ref: &B<'py>,
        ctx: Option<Py<PyAny>>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = router_handle(py, slf);
        let reference = match own(py, "_as_target_ref")?.call1((target_ref,)) {
            Ok(v) => v,
            Err(e) if e.is_instance_of::<PyValueError>(py) => {
                return obs_fail(py, &bi1(py, "str", &e.value_bound(py))?)
            }
            Err(e) => return Err(e),
        };
        let resolved = me.call_method1("resolve", (&reference,))?;
        if !resolved.getattr("ok")?.is_truthy()? {
            return obs_fail(py, &bi1(py, "str", &resolved.getattr("error")?)?);
        }
        let c = match &ctx {
            Some(v) => v.bind(py).clone(),
            None => none(py),
        };
        let c = if is_dict(&c) { c } else { empty_dict(py) };
        let out = (|| -> PyResult<B<'py>> {
            resolved
                .getattr("value")?
                .call_method1("observe", (reference, c))
        })();
        match out {
            Ok(v) => Ok(v),
            Err(e) if is_py_exc(&e, py) => obs_fail(
                py,
                &fstr(
                    py,
                    vec![ps(py, "观察失败: "), fmtv(py, &e.value_bound(py))?],
                )?,
            ),
            Err(e) => Err(e),
        }
    }

    #[pyo3(signature = (target_ref, action, params = None, ctx = None))]
    fn act<'py>(
        slf: PyRef<'py, Self>,
        target_ref: &B<'py>,
        action: &B<'py>,
        params: Option<Py<PyAny>>,
        ctx: Option<Py<PyAny>>,
    ) -> PyResult<B<'py>> {
        let py = slf.py();
        let me = router_handle(py, slf);
        let reference = match own(py, "_as_target_ref")?.call1((target_ref,)) {
            Ok(v) => v,
            Err(e) if e.is_instance_of::<PyValueError>(py) => {
                return result_failure(py, &bi1(py, "str", &e.value_bound(py))?)
            }
            Err(e) => return Err(e),
        };
        let params = match &params {
            Some(v) => v.bind(py).clone(),
            None => none(py),
        };
        let params = if is_dict(&params) { params } else { empty_dict(py) };
        let ctx = match &ctx {
            Some(v) => v.bind(py).clone(),
            None => none(py),
        };
        let ctx = if is_dict(&ctx) { ctx } else { empty_dict(py) };
        let action = orstr(py, action, "")?.call_method0("strip")?;
        let resolved = me.call_method1("resolve", (&reference,))?;
        if !resolved.getattr("ok")?.is_truthy()? {
            return result_failure(py, &bi1(py, "str", &resolved.getattr("error")?)?);
        }
        let kind = reference.getattr("kind")?;
        let spec = me.call_method1("_spec_for", (&kind, &action))?;
        if spec.is_none() {
            let names = me.call_method1("action_names", (&kind,))?;
            return result_failure(
                py,
                &fstr(
                    py,
                    vec![
                        ps(py, "未知动作: "),
                        fmtv(py, &action)?,
                        ps(py, "。可用动作: "),
                        ps(py, ", ").call_method1("join", (&names,))?,
                    ],
                )?,
            );
        }
        let reg = me.getattr("registry")?;
        let perm =
            reg.call_method1("check_permission", (spec, params.clone(), ctx.clone()))?;
        if !perm.get_item(0)?.is_truthy()? {
            return result_failure(py, &perm.get_item(1)?);
        }
        let out = (|| -> PyResult<B<'py>> {
            resolved.getattr("value")?.call_method1(
                "act",
                (reference, action, params, ctx),
            )
        })();
        match out {
            Ok(v) => Ok(v),
            Err(e) if is_py_exc(&e, py) => result_failure(
                py,
                &fstr(
                    py,
                    vec![ps(py, "动作派发异常: "), fmtv(py, &e.value_bound(py))?],
                )?,
            ),
            Err(e) => Err(e),
        }
    }
}

// ── callable seams / module wiring ──────────────────────────────────────────

#[pyfunction]
#[pyo3(name = "feedback_dir")]
#[pyo3(signature = (ctx = None))]
fn feedback_dir_py<'py>(py: Python<'py>, ctx: Option<&B<'py>>) -> PyResult<B<'py>> {
    feedback_dir(py, ctx)
}

#[pyfunction]
#[pyo3(name = "feedback_path")]
#[pyo3(signature = (action, ctx = None))]
fn feedback_path_py<'py>(py: Python<'py>, action: &B<'py>, ctx: Option<&B<'py>>) -> PyResult<B<'py>> {
    feedback_path(py, action, ctx)
}

#[pyfunction]
#[pyo3(name = "summarize_ocr")]
fn summarize_ocr_py<'py>(py: Python<'py>, ocr_value: &B<'py>) -> PyResult<B<'py>> {
    summarize_ocr(py, ocr_value)
}

#[pyfunction]
#[pyo3(name = "validate_url")]
fn validate_url_py<'py>(py: Python<'py>, url: &B<'py>) -> PyResult<B<'py>> {
    validate_url(py, url)
}

#[pyfunction]
#[pyo3(name = "_detect_ctx_of")]
fn detect_ctx_of_py<'py>(py: Python<'py>, ctx: &B<'py>) -> PyResult<B<'py>> {
    detect_ctx_of(py, ctx)
}

#[pyfunction]
#[pyo3(name = "_match_norm")]
fn match_norm_py<'py>(py: Python<'py>, text: &B<'py>) -> PyResult<B<'py>> {
    match_norm(py, text)
}

#[pyfunction]
#[pyo3(name = "_list_top_level_windows")]
fn list_top_level_windows_py<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    list_top_level_windows(py)
}

#[pyfunction]
#[pyo3(name = "_virtual_screen_bounds")]
fn virtual_screen_bounds_py<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    virtual_screen_bounds(py)
}

#[pyfunction]
#[pyo3(name = "_bbox_center")]
fn bbox_center_py<'py>(py: Python<'py>, bbox: &B<'py>) -> PyResult<B<'py>> {
    bbox_center(py, bbox)
}

#[pyfunction]
#[pyo3(name = "_as_target_ref")]
fn as_target_ref_py<'py>(py: Python<'py>, target_ref: &B<'py>) -> PyResult<B<'py>> {
    as_target_ref(py, target_ref)
}

#[pyfunction]
#[pyo3(name = "format_target_ref")]
fn format_target_ref_py<'py>(py: Python<'py>, reference: &B<'py>) -> PyResult<B<'py>> {
    format_target_ref(py, reference)
}

#[pyfunction]
#[pyo3(name = "parse_target_ref")]
fn parse_target_ref_py<'py>(py: Python<'py>, target_ref: &B<'py>) -> PyResult<B<'py>> {
    parse_target_ref(py, target_ref)
}

#[pyfunction]
#[pyo3(name = "_ocr_lines_of")]
fn ocr_lines_of_py<'py>(py: Python<'py>, ocr_value: &B<'py>) -> PyResult<B<'py>> {
    ocr_lines_of(py, ocr_value)
}

#[pyfunction]
#[pyo3(name = "get_cua_executor")]
fn get_cua_executor_py<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    get_cua_executor(py)
}

#[pyfunction]
#[pyo3(name = "set_cua_executor")]
#[pyo3(signature = (executor = None))]
fn set_cua_executor_py<'py>(py: Python<'py>, executor: Option<Py<PyAny>>) -> PyResult<B<'py>> {
    set_cua_executor(py, executor)
}

/// The `TargetBackend` protocol object: created by the real `type()` on
/// `typing.Protocol` and wrapped by the real `runtime_checkable`, so
/// `__protocol_attrs__`, the isinstance duck-check and the instantiation
/// TypeError all come from CPython's own machinery (see the header).
fn target_backend_protocol<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let typing = py.import_bound("typing")?;
    let ns = PyDict::new_bound(py);
    ns.set_item("__module__", "cua_actions")?;
    ns.set_item("__qualname__", "TargetBackend")?;
    ns.set_item(
        "__doc__",
        "桌面/浏览器统一目标协议（U4）：observe 只读世界，act 改世界。\n\n后端只长这张脸（鸭子类型；runtime_checkable 供接线自检）。动作层/权限层\n不区分域——同一动作同一参数在两域的权限结论必须逐字一致（单源同判，\n见 TargetRouter）。\n",
    )?;
    let str_cls = builtins(py)?.getattr("str")?;
    let ann = PyDict::new_bound(py);
    ann.set_item("name", str_cls)?;
    ns.set_item("__annotations__", ann)?;
    ns.set_item(
        "observe",
        PyCFunction::new_closure_bound(
            py,
            Some(c"observe"),
            Some(c"观察目标：截图 + OCR 提取行，产物是 ObserveResult（诚实失败位）。"),
            |_a: &Bound<'_, PyTuple>, _k: Option<&Bound<'_, PyDict>>| -> PyResult<PyObject> {
                Ok(_a.py().None())
            },
        )?
        .into_any(),
    )?;
    ns.set_item(
        "act",
        PyCFunction::new_closure_bound(
            py,
            Some(c"act"),
            Some(c"对目标执行一个动作：结果是与全库同纪律的 Result（绝不抛异常）。"),
            |_a: &Bound<'_, PyTuple>, _k: Option<&Bound<'_, PyDict>>| -> PyResult<PyObject> {
                Ok(_a.py().None())
            },
        )?
        .into_any(),
    )?;
    let cls = builtins(py)?.getattr("type")?.call1((
        ps(py, "TargetBackend"),
        tuple_of(py, vec![typing.getattr("Protocol")?])?,
        ns.clone(),
    ))?;
    Ok(typing.getattr("runtime_checkable")?.call1((cls,))?)
}

pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(py, "cua_actions")?;
    m.add_class::<ActionSpec>()?;
    m.add_class::<CuaActionResult>()?;
    m.add_class::<CuaDesktopBackend>()?;
    m.add_class::<CuaActionRegistry>()?;
    m.add_class::<TargetRef>()?;
    m.add_class::<ObserveResult>()?;
    m.add_class::<DesktopTargetBackend>()?;
    m.add_class::<BrowserTargetBackend>()?;
    m.add_class::<TargetRouter>()?;
    m.add_function(wrap_pyfunction!(feedback_dir_py, &m)?)?;
    m.add_function(wrap_pyfunction!(feedback_path_py, &m)?)?;
    m.add_function(wrap_pyfunction!(summarize_ocr_py, &m)?)?;
    m.add_function(wrap_pyfunction!(validate_url_py, &m)?)?;
    m.add_function(wrap_pyfunction!(detect_ctx_of_py, &m)?)?;
    m.add_function(wrap_pyfunction!(match_norm_py, &m)?)?;
    m.add_function(wrap_pyfunction!(list_top_level_windows_py, &m)?)?;
    m.add_function(wrap_pyfunction!(virtual_screen_bounds_py, &m)?)?;
    m.add_function(wrap_pyfunction!(bbox_center_py, &m)?)?;
    m.add_function(wrap_pyfunction!(format_target_ref_py, &m)?)?;
    m.add_function(wrap_pyfunction!(parse_target_ref_py, &m)?)?;
    m.add_function(wrap_pyfunction!(as_target_ref_py, &m)?)?;
    m.add_function(wrap_pyfunction!(ocr_lines_of_py, &m)?)?;
    m.add_function(wrap_pyfunction!(get_cua_executor_py, &m)?)?;
    m.add_function(wrap_pyfunction!(set_cua_executor_py, &m)?)?;

    m.add("CAP_PERCEIVE", CAP_PERCEIVE)?;
    m.add("CAP_POINT", CAP_POINT)?;
    m.add("CAP_TYPE", CAP_TYPE)?;
    m.add("CAP_NAVIGATE", CAP_NAVIGATE)?;
    m.add("CAP_WAIT", CAP_WAIT)?;
    m.add("CAP_TAB_MANAGE", CAP_TAB_MANAGE)?;
    m.add("OCR_SUMMARY_MAX_LINES", OCR_SUMMARY_MAX_LINES)?;
    m.add("OCR_SUMMARY_MAX_CHARS", OCR_SUMMARY_MAX_CHARS)?;
    m.add("DRAG_MIDWAY_MAX_LINES", DRAG_MIDWAY_MAX_LINES)?;
    m.add("DRAG_MIDWAY_MAX_CHARS", DRAG_MIDWAY_MAX_CHARS)?;
    m.add("_STEP_DRAG_PRIMITIVES", tuple_of(py, vec![ps(py, "mouse_down"), ps(py, "mouse_up"), ps(py, "move_cursor")])?)?;
    m.add("_CTX_CONTROL_KEYS", frozenset_of(py, &["pre_approval_source"])?)?;
    m.add(
        "_URL_PATTERN",
        py.import_bound("re")?.getattr("compile")?.call1((
            ps(py, URL_PATTERN_SRC),
        ))?,
    )?;
    m.add("ACTION_SPECS", action_specs(py)?)?;
    m.add("BROWSER_ACTION_SPECS", browser_action_specs(py)?)?;
    m.add(
        "RESULT_KEYS",
        tuple_of(
            py,
            vec![
                ps(py, "ok"),
                ps(py, "action"),
                ps(py, "error"),
                ps(py, "details"),
                ps(py, "screenshot_path"),
                ps(py, "ocr_summary"),
                ps(py, "feedback_note"),
                ps(py, "delivery_hint"),
                ps(py, "elapsed_ms"),
            ],
        )?,
    )?;
    m.add(
        "DELIVERY_HINTS",
        tuple_of(py, vec![ps(py, "deliverable"), ps(py, "handoff")])?,
    )?;
    m.add(
        "TARGET_KINDS",
        tuple_of(py, vec![ps(py, "desktop"), ps(py, "tab"), ps(py, "app")])?,
    )?;
    m.add("_TARGET_REF_USAGE", TARGET_REF_USAGE)?;
    m.add("TargetBackend", target_backend_protocol(py)?)?;
    m.add("_executor", py.None())?;

    // pyo3 builds `tp_name` as `module.Name`, so CPython's own messages
    // (`'cua_actions.X' object has no attribute 'y'`) carry the dotted name
    // while python-defined classes report the bare one. Re-assigning
    // `__name__` re-seeds the heap type's bare name; `__module__`,
    // `__qualname__` and `repr(cls)` are untouched (verified by parity).
    for name in [
        "ActionSpec",
        "CuaActionResult",
        "CuaDesktopBackend",
        "CuaActionRegistry",
        "TargetRef",
        "ObserveResult",
        "DesktopTargetBackend",
        "BrowserTargetBackend",
        "TargetRouter",
    ] {
        m.getattr(name)?.setattr("__name__", name)?;
    }

    // the from-imports at the top of the python module, resolved the same way
    for (name, module, attr) in [
        ("Result", "result", "Result"),
        ("TabClaim", "browser_sessions", "TabClaim"),
        ("OcrDiffState", "cua_ocr_diff", "OcrDiffState"),
    ] {
        m.add(name, mod_import(py, module)?.getattr(attr)?)?;
    }
    let gac = mod_import(py, "gui_action_classifier")?;
    for name in [
        "Tier",
        "classify_action",
        "detect_scenario_tags",
        "escalate_tiers",
        "is_pre_approval_source",
        "resolve_confirmation_tier",
    ] {
        m.add(name, gac.getattr(name)?)?;
    }

    *ST.lock() = Some(m.clone().unbind());
    parent.add_submodule(&m)?;
    Ok(())
}


