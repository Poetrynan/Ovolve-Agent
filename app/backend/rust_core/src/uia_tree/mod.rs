//! uia_tree — Rust port of `app/backend/uia_tree.py` (wave-6, Native→Rust).
//!
//! Reads the Windows UI Automation tree as flat element snapshots (`UiaNode`)
//! and turns a semantic target (Name / ControlType / AutomationID) into a
//! logical click coordinate, with an explicit degrade marker
//! (`UIA_UNAVAILABLE`) so the model falls back to OCR / bare coordinates.
//!
//! Port posture (device_fingerprint / recovery precedent): every value flows as
//! a live CPython object. Every name the python body looks up at call time is
//! read from *this module's own dict* through [`own`] — `UIA_UNAVAILABLE`,
//! `_NAME_CAP`, `MAX_NODES`, `MAX_DEPTH`, `_norm_text`, `budget_trim`,
//! `find_elements`, `node_to_dict`, `UiaNode`, `ctypes`, `sys`, `_Rect`,
//! `_GUID`, `_com`, `_CONTROL_TYPE_NAMES` and all eleven `_SLOT_*` — so patching
//! any of them on `ovolve_core.uia_tree` changes behaviour exactly as patching
//! `uia_tree` does. The whole COM layer runs through **CPython's own ctypes**
//! (`WINFUNCTYPE` / `cast` / `POINTER` / `byref` / `windll.ole32` /
//! `wstring_at` / `SysFreeString`), never against `windows-sys`: this module is
//! the thing that replaces that python code in production, so a second,
//! independently-laid-out FFI would be a second source of truth about memory
//! layout. The `_fields_` lists handed to `ctypes.Structure` are verbatim.
//!
//! Bug-for-bug items kept verbatim (each pinned by smoke/parity_uia_tree.py):
//! §1 `budget_trim`: `max_nodes <= 0` returns a *fresh* `[]`, while the positive
//!    path returns `nodes[:max_nodes]` — a real slice, so the input's own
//!    `__getitem__` sees `slice(None, max_nodes, None)` and `__len__` is never
//!    called on either branch.
//! §2 `walk_elements` has THREE degrade exits and they are not
//!    interchangeable: `backend is None` (identity — a falsy-but-not-None
//!    backend is still called), `except Exception` (a BaseException escapes),
//!    `got is None` (identity again — an empty list falls through to
//!    `budget_trim(list([]))`). The success path always copies with `list(got)`,
//!    so the returned list is never the backend's own object.
//! §3 `walk_elements` calls `budget_trim` through the *module global* and
//!    re-passes the caller's `max_nodes` object, which was handed to
//!    `read_window` first: an exotic `max_nodes` is observed twice, in that
//!    order.
//! §4 `_norm_text` is `str(v or "").strip().lower()`: `__bool__` fires before
//!    `__str__`, so a falsy object whose `__str__` raises never calls it.
//! §5 `find_elements` filters on truthiness (`nd.offscreen`, `not nd.enabled`),
//!    not identity, and an empty normalised key means "no condition" — so a
//!    `name` of `"  "` behaves like no name filter at all. `name` is a
//!    substring test (`in`), `control_type` / `automation_id` are `==` against
//!    the *normalised* node value, and the three node attributes are read only
//!    when their condition is active.
//! §6 `node_to_dict` computes `float(scale_factor or 1.0)` — `or` first, so
//!    0/""/None become the `1.0` object and never reach `float()` — then
//!    `if factor <= 0.01: factor = 1.0`, so a NaN (`<=` is False) keeps its own
//!    value. `type` is NOT `_NAME_CAP`-truncated while `name` and
//!    `automation_id` are; the four rect values each go through `int()`; the
//!    centre is `int(round(cx / factor))` — the real builtins, so python's
//!    banker rounding is shared.
//! §7 `resolve_element_target`: `int(target.get("index") or 1)` is guarded by
//!    `except (TypeError, ValueError)` ONLY, so an `__index__` that raises
//!    anything else escapes; a truthy non-numeric is attempted and collapses to
//!    1 through that same trap. `target.get` runs once for `index`, once per
//!    condition, and ONCE MORE for the raw `!r` in the no-match message — that
//!    last one is the *un-normalised* value, so the message can read `name=0`
//!    for a lookup that filtered on "".
//! §8 the over-range message calls `len(hits)` a second time and interpolates
//!    `idx` twice (`index={idx}` and `occurrence={idx}`); `hits[idx - 1]` is a
//!    real subtraction plus `__getitem__`, and both `find_elements` and
//!    `node_to_dict` are reached through the module globals.
//! §9 `UiaNode` is a plain (non-frozen) dataclass: field order
//!    name/control_type/rect/enabled/offscreen/automation_id drives `__repr__`
//!    (`__qualname__` + `!r` per field, ", " joined), `__eq__` (tuple compare,
//!    `NotImplemented` for a foreign `__class__`) and `__hash__ = None`
//!    (`hash(node)` → "unhashable type: 'UiaNode'"). `center_physical` is
//!    get-only and its `(left + right) // 2` floors towards −∞, so
//!    `rect=(-3, -1, 0, 0)` gives `(-2, -1)`; nothing validates `rect`, and a
//!    non-sequence raises CPython's own unpack wording.
//! §10 `_com` returns a closure with the signature `_invoke(*args)`; calling it
//!     with keywords raises `_invoke() got an unexpected keyword argument 'x'`
//!     BEFORE `fn` is ever invoked, and `ptr` is captured at `_com` time.
//! §11 `_bstr`: the `!= 0` early return and the `not out.value` early return
//!     both skip `SysFreeString`; the inner `try/finally` frees the string even
//!     when `wstring_at` raises, and that raise is then swallowed by the outer
//!     `except Exception` → `""`.
//! §12 `_int` DISCARDS the HRESULT — a failing call still returns
//!     `int(v.value)` (0 from the fresh `c_int(0)`) — while a *raising* one
//!     returns the literal `0` before `v` is touched. `_flag` is
//!     `hr == 0 and bool(v.value)` with the `and` short-circuit, and its
//!     `except` arm returns `False`. `_rect` returns the `(0, 0, 0, 0)` literal
//!     on a failing HRESULT, so a partially-filled struct is dropped.
//! §13 `_snapshot` evaluates its six keyword arguments in written order
//!     (`name` → `control_type` → `rect` → `enabled` → `offscreen` →
//!     `automation_id`), each slot constant read live from the module dict; an
//!     unknown control type id falls back to `"Unknown"` through the live
//!     `_CONTROL_TYPE_NAMES.get`.
//! §14 `_release` is `if ptr and getattr(ptr, "value", None)`: a plain object
//!     without `.value` is skipped in silence, and `Release` itself is
//!     `except Exception: pass`. It returns None either way.
//! §15 `_read` clamps with `cap = max(1, min(int(max_nodes or MAX_NODES),
//!     MAX_NODES))` and the same shape for `depth_cap` against `MAX_DEPTH`, so
//!     the caller's numbers are coerced, floored at 1 and capped at the module
//!     hard ceiling — and both ceiling globals are re-read twice, once for the
//!     `or`, once for `min`.
//! §16 `_walk` guards `if len(out) >= cap or depth > depth_cap` (`len` runs on
//!     every entry, `or` short-circuits the depth test), appends the snapshot
//!     BEFORE descending, returns without the sibling loop when
//!     GetFirstChildElement fails, and re-tests `child.value and len(out) < cap`
//!     each turn. The `finally` releases whatever `child` currently is — the
//!     `break` path therefore releases the *last* child, and a `nxt` that came
//!     back NULL is never released.
//! §17 `_read`'s `finally` releases the walker then the root, so a raising
//!     `_release(walker)` skips the root release; `read_window` catches
//!     `Exception` and returns `None` — the degrade the caller tests with `is`.
//! §18 `__init__`: `hr in (0, 1)` (not `==`) decides `_coinited`; the
//!     `_create_automation` failure arm runs `CoUninitialize` only when
//!     `_coinited`, and re-raises as
//!     `OSError(f"UIA COM unavailable: {exc}") from exc`, so `__cause__` is the
//!     original and `__suppress_context__` is set.
//! §19 `close` reads both attributes through `getattr(self, …, default)`,
//!     releases then nulls `_uia`, and nulls `_coinited` OUTSIDE its own try —
//!     so a raising `CoUninitialize` still clears the flag.
//! §20 every `_com(ptr, slot, restype, *argtypes)(*inner_args)` site is a
//!     DOUBLE call: CPython evaluates the outer call completely (WINFUNCTYPE,
//!     the two `_vtable` casts, the vtable slot read, the cast onto the proto)
//!     and only THEN builds the inner call's arguments. So `byref(out)` /
//!     `c_void_p(hwnd)` land in the ledger AFTER the `_com` machinery, never
//!     before it — [`com_call`] takes a closure for exactly that reason.
//!
//! DIVERGENCE(port, binding time): python binds module globals at import time;
//!     Rust reads them from the live module dict at each call (own dict for its
//!     own names, `sys.modules` for `import`-resolved names). Production never
//!     rebinds an import behind a module's back, and the parity probe patches
//!     both sides through the same objects, so the observable state matches.
//! DIVERGENCE(port, def-time defaults): `max_nodes=MAX_NODES`,
//!     `max_depth=MAX_DEPTH`, `scale_factor=1.0`, `name=""`,
//!     `include_offscreen=False` … are evaluated ONCE by python at def time; the
//!     very same objects are snapshotted here at register time, so patching
//!     `MAX_NODES` afterwards moves the *body* (which re-reads the global) but
//!     not the default. pyo3 exposes no `__defaults__` / `__signature__` to
//!     introspect them — same crate-wide note as recovery / device_fingerprint.
//! DIVERGENCE(port, call grammar): CPython parses a call to a python-defined
//!     function in the eval loop. [`bind_call`] reproduces that grammar,
//!     precedence and wording for the eight module-level functions;
//!     [`bind_init`] does it for the dataclass-generated `__init__`, whose
//!     messages carry the `UiaNode.__init__()` token that pyo3's `#[new]` would
//!     render as `__new__`. Both delegate the two wordings CPython generates
//!     itself to `crate::cpy_call`: the `too_many_positional` plural/"was"/
//!     "from N to M" rules, and the `Did you mean 'x'?` suffix an unexpected
//!     keyword carries — that suffix is computed by a real edit-distance search
//!     over the keyword-eligible parameter names (single case flip suggests,
//!     two do not), so it is reimplemented rather than dropped. recovery /
//!     cua_actions / device_fingerprint predate the shared helper and still
//!     print the suggestionless form.
//! DIVERGENCE(port, class layout): `#[pyclass(dict)]` is unavailable under
//!     abi3-py38, so a `UiaNode` cannot take an unsolicited attribute
//!     (`node.foo = 1` works in python, fails here) and `vars(node)` differs;
//!     `CtypesUiaBackend` likewise keeps its four attributes as descriptor
//!     fields. Nothing in the repository writes an undeclared attribute to
//!     either, and the six declared fields round-trip. Pinned as accepted.
//! DIVERGENCE(port, `center_physical`): the getter is a pyo3 descriptor rather
//!     than a builtin `property`, so `UiaNode.center_physical` displays
//!     differently and has no `fget`. Read semantics and the returned tuple are
//!     identical; the *no-setter* `AttributeError` text is reproduced verbatim
//!     by the port's own `__setattr__`, which is also where the six declared
//!     fields are assigned.
//! DIVERGENCE(port, `_com` return): python returns a nested `def _invoke`; the
//!     port returns a `PyCFunction` closure that forwards positionals and
//!     rejects keywords with CPython's exact wording. `functools.partial` was
//!     rejected because it would forward keywords to the CFuncPtr instead of
//!     raising first. `__name__` is `_invoke` in both.
//! DIVERGENCE(port, construction dispatch): `__init__`'s internal
//!     `self._create_automation()` / `self._guid()` calls are resolved
//!     statically, because pyo3 builds the instance in one step and no
//!     user-visible `self` exists mid-construction. A subclass overriding either
//!     private helper would differ; the repository never subclasses
//!     `CtypesUiaBackend`, and the same two helpers DO dispatch through `self`
//!     when called after construction. Every other post-construction call
//!     (`_read`/`_walk`/`_snapshot`/`_bstr`/`_int`/`_flag`/`_rect`/`_release`)
//!     dispatches through the instance, as python does.
//! DIVERGENCE(port, `_Rect`/`_GUID`/`UiaBackend`): built by calling the real
//!     `type()` instead of a class statement, so `__module__`, `__qualname__`
//!     and `__firstlineno__` metadata differ. The `_fields_` list handed to
//!     `ctypes.Structure` and the `Protocol` base plus `read_window` signature
//!     are verbatim, so with real ctypes/typing the memory layout and the duck
//!     contract are identical.
//! DIVERGENCE(port, non-win32): python guards `import ctypes` with
//!     `if sys.platform == "win32"` and would then hit NameError while building
//!     `_Rect`; this crate only builds on Windows, where the guard always
//!     passes, so `ctypes` is bound eagerly.
// PORT STATUS: confidence=high todos=[0]

use parking_lot::Mutex;
use pyo3::exceptions::{PyAttributeError, PyImportError, PyOSError, PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyCFunction, PyDict, PyFloat, PyList, PyString, PyTuple};

use crate::cpy_call::{too_many_positional, unexpected_keyword};

type B<'py> = Bound<'py, PyAny>;

/// the live `uia_tree` submodule, so `own()` reads the very dict
/// `ovolve_core.uia_tree.__dict__` exposes and a probe's
/// `setattr(mod, "MAX_NODES", …)` is seen by the port.
static ST: Mutex<Option<Py<PyModule>>> = Mutex::new(None);

/// def-time default objects, snapshotted once at register time.
static DEF_MAX_NODES: Mutex<Option<Py<PyAny>>> = Mutex::new(None);
static DEF_MAX_DEPTH: Mutex<Option<Py<PyAny>>> = Mutex::new(None);
static DEF_SCALE: Mutex<Option<Py<PyAny>>> = Mutex::new(None);
static DEF_EMPTY_STR: Mutex<Option<Py<PyAny>>> = Mutex::new(None);
static DEF_FALSE: Mutex<Option<Py<PyAny>>> = Mutex::new(None);
static DEF_TRUE: Mutex<Option<Py<PyAny>>> = Mutex::new(None);

// ── module constants (uia_tree.py:53) ───────────────────────────────────────

const MAX_NODES: i64 = 200;
const MAX_DEPTH: i64 = 8;
const NAME_CAP: i64 = 80;
const UIA_UNAVAILABLE: &str = "uia_unavailable";

const CLSID_CUIAUTOMATION: &str = "{ff48dba4-60ef-4201-aa87-54103eef594e}";
const IID_IUIAUTOMATION: &str = "{30cbe57d-d9d0-452a-ab13-7ac5ac4825ee}";

/// vtable 槽位，取自 UIAutomationCore.dll 的 typelib；IUnknown 占 0/1/2。
const SLOTS: [(&str, i64); 11] = [
    ("_SLOT_IUIA_GET_ROOT", 5),
    ("_SLOT_IUIA_FROM_HANDLE", 6),
    ("_SLOT_IUIA_CONTROL_VIEW_WALKER", 14),
    ("_SLOT_ELEM_CURRENT_CONTROL_TYPE", 21),
    ("_SLOT_ELEM_CURRENT_NAME", 23),
    ("_SLOT_ELEM_CURRENT_ENABLED", 28),
    ("_SLOT_ELEM_CURRENT_AUTOMATION_ID", 29),
    ("_SLOT_ELEM_CURRENT_OFFSCREEN", 38),
    ("_SLOT_ELEM_CURRENT_BOUNDING_RECT", 43),
    ("_SLOT_WALKER_FIRST_CHILD", 4),
    ("_SLOT_WALKER_NEXT_SIBLING", 6),
];

/// CONTROLTYPEID → 名称，50000 基准，与 python 字典字面量同序同值。
const CONTROL_TYPE_NAMES: [(i64, &str); 41] = [
    (50000, "Button"), (50001, "Calendar"), (50002, "CheckBox"),
    (50003, "ComboBox"), (50004, "Edit"), (50005, "Hyperlink"), (50006, "Image"),
    (50007, "ListItem"), (50008, "List"), (50009, "Menu"), (50010, "MenuBar"),
    (50011, "MenuItem"), (50012, "ProgressBar"), (50013, "RadioButton"),
    (50014, "ScrollBar"), (50015, "Slider"), (50016, "Spinner"),
    (50017, "StatusBar"), (50018, "Tab"), (50019, "TabItem"), (50020, "Text"),
    (50021, "ToolBar"), (50022, "ToolTip"), (50023, "Tree"), (50024, "TreeItem"),
    (50025, "Custom"), (50026, "Group"), (50027, "Thumb"), (50028, "DataGrid"),
    (50029, "DataItem"), (50030, "Document"), (50031, "SplitButton"),
    (50032, "Window"), (50033, "Pane"), (50034, "Header"), (50035, "HeaderItem"),
    (50036, "Table"), (50037, "TitleBar"), (50038, "Separator"),
    (50039, "SemanticZoom"), (50040, "AppBar"),
];

/// field order == `dataclasses.fields`; drives `__repr__`, `__eq__`,
/// `__init__` and the `__hash__ = None` shape.
const NODE_FIELDS: [&str; 6] = [
    "name",
    "control_type",
    "rect",
    "enabled",
    "offscreen",
    "automation_id",
];

// ── own-module globals (python's late global lookup) ────────────────────────

fn own<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    let m: Option<Py<PyModule>> = ST.lock().as_ref().map(|p| p.clone_ref(py));
    match m {
        Some(p) => Ok(p.bind(py).getattr(name)?),
        None => Err(PyImportError::new_err("uia_tree module not registered")),
    }
}

fn opt_ref(cell: &Option<PyObject>, py: Python<'_>) -> PyObject {
    match cell {
        Some(p) => p.clone_ref(py),
        None => py.None(),
    }
}

fn defcell<'py>(cell: &Mutex<Option<Py<PyAny>>>, py: Python<'py>) -> B<'py> {    match cell.lock().as_ref() {
        Some(p) => p.clone_ref(py).into_bound(py).into_any(),
        None => py.None().into_bound(py).into_any(),
    }
}

// ── CPython-semantics helpers ───────────────────────────────────────────────

fn builtins(py: Python<'_>) -> PyResult<Bound<'_, PyModule>> {
    Ok(py.import_bound("builtins")?)
}

fn mod_import<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    Ok(py.import_bound(name)?.into_any())
}

fn obj<'py>(py: Python<'py>, v: i64) -> B<'py> {
    v.to_object(py).into_bound(py).into_any()
}

fn flt<'py>(py: Python<'py>, v: f64) -> B<'py> {
    v.to_object(py).into_bound(py).into_any()
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

fn truthy<'py>(py: Python<'py>, v: bool) -> PyResult<B<'py>> {
    bi_get(py, if v { "True" } else { "False" })
}

fn bi_get<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr(name)?)
}

/// real operator-module binary op — the exact protocol behind `a + b`,
/// `a // b`, `a == b`, `a in b`, … including reflected fallbacks.
fn op<'py>(py: Python<'py>, name: &str, a: &B<'py>, b: &B<'py>) -> PyResult<B<'py>> {
    Ok(py.import_bound("operator")?.getattr(name)?.call1((a, b))?)
}

fn cmp<'py>(py: Python<'py>, name: &str, a: &B<'py>, b: &B<'py>) -> PyResult<bool> {
    op(py, name, a, b)?.is_truthy()
}

/// `x or default` — returns the ORIGINAL object when truthy.
fn orv<'py>(v: &B<'py>, def: &B<'py>) -> PyResult<B<'py>> {
    Ok(if v.is_truthy()? { v.clone() } else { def.clone() })
}

/// `f"{x}"` — the real `format(x, "")` an f-string compiles to.
fn fmtv<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("format")?.call1((x, ps(py, "")))?)
}

/// `f"{x:#x}"` — the real `format(x, "#x")`.
fn fmt_spec<'py>(py: Python<'py>, x: &B<'py>, spec: &str) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("format")?.call1((x, ps(py, spec)))?)
}

fn join_with<'py>(py: Python<'py>, sep: &B<'py>, parts: Vec<B<'py>>) -> PyResult<B<'py>> {
    let list = PyList::new_bound(py, parts);
    Ok(sep.call_method1("join", (&list,))?)
}

/// an f-string's concatenation, piece by piece, in source order.
fn fstr<'py>(py: Python<'py>, parts: Vec<B<'py>>) -> PyResult<B<'py>> {
    join_with(py, &ps(py, ""), parts)
}

/// `x[:stop]` with a LIVE stop object, so python's own slice object lands on the
/// input's `__getitem__`.
fn head<'py>(py: Python<'py>, x: &B<'py>, stop: &B<'py>) -> PyResult<B<'py>> {
    let sl = call_bi(py, "slice", (none(py), stop.clone()))?;
    x.get_item(sl)
}

fn contains<'py>(coll: &B<'py>, x: &B<'py>) -> PyResult<bool> {
    coll.contains(x).map_err(Into::into)
}

fn get1<'py>(py: Python<'py>, d: &B<'py>, key: &str) -> PyResult<B<'py>> {
    Ok(d.call_method1("get", (ps(py, key),))?)
}

fn dict_of<'py>(py: Python<'py>, items: Vec<(&str, B<'py>)>) -> B<'py> {
    let d = PyDict::new_bound(py);
    for (k, v) in items {
        d.set_item(k, v).expect("dict set");
    }
    d.into_any()
}

fn kwargs_of<'py>(py: Python<'py>, items: &[(&str, B<'py>)]) -> PyResult<Bound<'py, PyDict>> {
    let kw = PyDict::new_bound(py);
    for (k, v) in items {
        kw.set_item(*k, v)?;
    }
    Ok(kw)
}

fn list_of<'py>(py: Python<'py>, items: Vec<B<'py>>) -> B<'py> {
    PyList::new_bound(py, items).into_any()
}

fn tuple_of<'py>(py: Python<'py>, items: Vec<B<'py>>) -> B<'py> {
    PyTuple::new_bound(py, items).into_any()
}

/// python's `except Exception:` — BaseExceptions must propagate.
fn is_py_exc(e: &PyErr, py: Python<'_>) -> bool {
    e.is_instance_of::<pyo3::exceptions::PyException>(py)
}

/// CPython's `raise A` while `B` is in flight: `A.__context__ = B`, giving the
/// "During handling of the above exception…" repr. PyErr_Restore does not chain
/// it, so attach the attribute directly.
fn raise_with_context(py: Python<'_>, outer: PyErr, inner: PyErr) -> PyErr {
    let outer_val = outer.value_bound(py);
    let inner_val = inner.value_bound(py);
    if let Ok(ctx) = outer_val.getattr("__context__") {
        if ctx.is_none() {
            let _ = outer_val.setattr("__context__", inner_val);
        }
    }
    outer
}

/// `try: BODY finally: CLEANUP` — a raising cleanup replaces the pending body
/// error and chains it, exactly like CPython.
fn try_finally<F: FnOnce() -> PyResult<()>>(
    py: Python<'_>,
    body: PyResult<()>,
    cleanup: F,
) -> PyResult<()> {
    try_finally_val(py, body, cleanup)
}

/// the same, for a `try` whose body VALUE is returned.
fn try_finally_val<T, F: FnOnce() -> PyResult<()>>(
    py: Python<'_>,
    body: PyResult<T>,
    cleanup: F,
) -> PyResult<T> {
    match (body, cleanup()) {
        (v, Ok(())) => v,
        (Ok(_), Err(e)) => Err(e),
        (Err(a), Err(b)) => Err(raise_with_context(py, b, a)),
    }
}

// ── CPython's call grammar ─────────────────────────────────────────────────

/// "'a'", "'a' and 'b'", "'a', 'b', and 'c'" — CPython's `format_missing`.
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

/// CPython binds a call to a python-defined function in the eval loop, so every
/// arity/keyword mistake reads `f() …` with its own precedence: keywords are
/// consumed in CALL order (unexpected → multiple values), surplus positionals
/// are reported after that, missing required parameters last. pyo3's generated
/// parser hard-codes different text. Unfilled slots come back `None` so each
/// function applies its own snapshotted def-time default.
///
/// `varargs` marks a `*argtypes` tail: surplus positionals are collected rather
/// than reported as an arity error (and the missing-argument tier still uses
/// CPython's plain wording, which is what a `*args` signature produces).
fn bind_call<'py>(
    fname: &str,
    params: &[&str],
    required: usize,
    varargs: bool,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<(Vec<Option<B<'py>>>, Vec<B<'py>>)> {
    let total = params.len();
    let nargs = args.len();
    let mut slots: Vec<Option<B<'py>>> = (0..total).map(|_| None).collect();
    let mut extra: Vec<B<'py>> = Vec::new();
    for (i, a) in args.iter().enumerate() {
        let a = a.into_any();
        if i < total {
            slots[i] = Some(a);
        } else if varargs {
            extra.push(a);
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
    if !varargs && nargs > total {
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
    Ok((slots, extra))
}

const UNSET: f64 = f64::MIN;

fn unset_obj() -> Py<PyAny> {
    Python::with_gil(|py| PyFloat::new_bound(py, UNSET).into_any().unbind())
}

fn unset<'py>(v: &B<'py>) -> PyResult<bool> {
    if !v.is_instance_of::<PyFloat>() {
        return Ok(false);
    }
    Ok(op(v.py(), "eq", v, &flt(v.py(), UNSET))?.is_truthy()?)
}

/// CPython parses a call to the dataclass-generated `__init__` in the eval
/// loop, so every arity/keyword mistake reads `Cls.__init__() …`; pyo3's
/// `#[new]` parser hard-codes the token `__new__`. Same grammar and precedence
/// as [`bind_call`], with `self` folded into CPython's counts. Unfilled slots
/// come back as [`UNSET`] so the constructor's own default logic is unchanged.
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
    let mut cands: Vec<&str> = Vec::with_capacity(total + 1);
    cands.push("self");
    cands.extend_from_slice(params);
    if let Some(kw) = kwargs {
        for (k, v) in kw.iter() {
            let key: String = match k.extract() {
                Ok(s) => s,
                Err(_) => return Err(PyTypeError::new_err("keywords must be strings")),
            };
            match params.iter().position(|p| *p == key) {
                None => {
                    if key == "self" {
                        // `self` is bound by the instance already, so naming it
                        // is a duplicate rather than an extraneous keyword.
                        return Err(PyTypeError::new_err(format!(
                            "{}.__init__() got multiple values for argument 'self'",
                            cls
                        )));
                    }
                    return Err(PyTypeError::new_err(unexpected_keyword(
                        &format!("{}.__init__", cls),
                        &key,
                        &cands,
                    )));
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
        return Err(PyTypeError::new_err(too_many_positional(
            &format!("{}.__init__", cls),
            total + 1,
            total - required,
            nargs + 1,
        )));
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

// ── UiaNode (plain, non-frozen dataclass) ───────────────────────────────────

#[pyclass(module = "uia_tree", name = "UiaNode")]
struct UiaNode {
    name: PyObject,
    control_type: PyObject,
    rect: PyObject,
    enabled: PyObject,
    offscreen: PyObject,
    automation_id: PyObject,
}

impl UiaNode {
    fn field<'py>(&self, py: Python<'py>, name: &str) -> B<'py> {
        let p = match name {
            "control_type" => self.control_type.clone_ref(py),
            "rect" => self.rect.clone_ref(py),
            "enabled" => self.enabled.clone_ref(py),
            "offscreen" => self.offscreen.clone_ref(py),
            "automation_id" => self.automation_id.clone_ref(py),
            _ => self.name.clone_ref(py),
        };
        p.into_bound(py)
    }

    fn values<'py>(&self, py: Python<'py>) -> Vec<B<'py>> {
        NODE_FIELDS.iter().map(|n| self.field(py, n)).collect()
    }
}

/// `left, top, right, bottom = seq` — CPython's UNPACK_SEQUENCE: the fast path
/// for a real tuple/list, the iterator path for everything else, and the
/// interpreter's own not-enough / too-many / non-iterable wording.
fn unpack_n<'py>(py: Python<'py>, seq: &B<'py>, n: usize) -> PyResult<Vec<B<'py>>> {
    if seq.is_instance_of::<PyTuple>() || seq.is_instance_of::<PyList>() {
        let len = seq.len()?;
        if len != n {
            return Err(unpack_err(py, n, Some(len)));
        }
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            out.push(seq.get_item(i)?.into_any());
        }
        return Ok(out);
    }
    let iterated: PyResult<Vec<B<'py>>> = (|| {
        // UNPACK_SEQUENCE pulls exactly n items and then peeks one more: the
        // 5th element of `a,b,c,d,e = xs` is consumed and dropped, and an
        // iterator that ends early reports how many it gave.
        let mut out: Vec<B<'py>> = Vec::with_capacity(n + 1);
        let mut it = seq.iter()?;
        for _ in 0..n {
            match it.next() {
                Some(item) => out.push(item?.into_any()),
                None => return Err(unpack_err(py, n, Some(out.len()))),
            }
        }
        if it.next().is_some() {
            return Err(unpack_err(py, n, None));
        }
        Ok(out)
    })();
    match iterated {
        Ok(items) => Ok(items),
        Err(e) if e.is_instance_of::<PyTypeError>(py) => {
            let tp = bi1(py, "type", seq)?;
            let nm = tp.getattr("__name__")?;
            let s = nm.str()?;
            Err(PyTypeError::new_err(format!(
                "cannot unpack non-iterable {} object",
                s.to_cow()?
            )))
        }
        Err(e) => Err(e),
    }
}

fn unpack_err(_py: Python<'_>, n: usize, got: Option<usize>) -> PyErr {
    match got {
        Some(g) if g < n => PyValueError::new_err(format!(
            "not enough values to unpack (expected {}, got {})",
            n, g
        )),
        Some(_) => PyValueError::new_err(format!("too many values to unpack (expected {})", n)),
        None => PyValueError::new_err(format!("too many values to unpack (expected {})", n)),
    }
}

#[pymethods]
impl UiaNode {
    #[new]
    #[pyo3(signature = (*args, **kwargs))]
    fn py_new<'py>(
        py: Python<'py>,
        args: &Bound<'py, PyTuple>,
        kwargs: Option<&Bound<'py, PyDict>>,
    ) -> PyResult<Self> {
        // the generated __init__ stores whatever the caller passed — no
        // coercion, None included — and fires a field default only when that
        // argument is absent.
        let s = bind_init(py, "UiaNode", &NODE_FIELDS, 3, args, kwargs)?;
        let pick = |i: usize, cell: &Mutex<Option<Py<PyAny>>>| -> PyResult<Py<PyAny>> {
            let v = s[i].bind(py).clone();
            if unset(&v)? {
                Ok(cell
                    .lock()
                    .as_ref()
                    .map(|p| p.clone_ref(py))
                    .unwrap_or_else(|| py.None()))
            } else {
                Ok(s[i].clone_ref(py))
            }
        };
        Ok(Self {
            name: s[0].clone_ref(py),
            control_type: s[1].clone_ref(py),
            rect: s[2].clone_ref(py),
            enabled: pick(3, &DEF_TRUE)?,
            offscreen: pick(4, &DEF_FALSE)?,
            automation_id: pick(5, &DEF_EMPTY_STR)?,
        })
    }

    fn __repr__(slf: PyRef<'_, Self>) -> PyResult<String> {
        let py = slf.py();
        let mut parts: Vec<B<'_>> = Vec::with_capacity(NODE_FIELDS.len());
        for (n, v) in NODE_FIELDS.iter().zip(slf.values(py)) {
            parts.push(fstr(py, vec![ps(py, n), ps(py, "="), bi1(py, "repr", &v)?])?);
        }
        let cls = own(py, "UiaNode")?.getattr("__qualname__")?;
        let full = fstr(
            py,
            vec![
                cls,
                ps(py, "("),
                join_with(py, &ps(py, ", "), parts)?,
                ps(py, ")"),
            ],
        )?;
        full.extract::<String>().map_err(Into::into)
    }

    fn __eq__(slf: PyRef<'_, Self>, other: &B<'_>) -> PyResult<PyObject> {
        let py = slf.py();
        let mine = own(py, "UiaNode")?;
        if !other.getattr("__class__")?.is(&mine) {
            return Ok(py.NotImplemented());
        }
        let a = tuple_of(py, slf.values(py));
        let b = tuple_of(
            py,
            NODE_FIELDS
                .iter()
                .map(|n| other.getattr(*n))
                .collect::<PyResult<Vec<_>>>()?,
        );
        Ok(truthy(py, cmp(py, "eq", &a, &b)?)?.unbind())
    }

    /// dataclass(eq=True, frozen=False) sets `__hash__ = None`.
    fn __hash__(&self) -> PyResult<isize> {
        Err(PyTypeError::new_err("unhashable type: 'UiaNode'"))
    }

    /// the six declared fields are readable (python's dataclass stores them as
    /// instance attributes); they stay writable too, see `__setattr__`.
    #[getter]
    fn name<'py>(&self, py: Python<'py>) -> B<'py> {
        self.field(py, "name")
    }

    #[getter]
    fn control_type<'py>(&self, py: Python<'py>) -> B<'py> {
        self.field(py, "control_type")
    }

    #[getter]
    fn rect<'py>(&self, py: Python<'py>) -> B<'py> {
        self.field(py, "rect")
    }

    #[getter]
    fn enabled<'py>(&self, py: Python<'py>) -> B<'py> {
        self.field(py, "enabled")
    }

    #[getter]
    fn offscreen<'py>(&self, py: Python<'py>) -> B<'py> {
        self.field(py, "offscreen")
    }

    #[getter]
    fn automation_id<'py>(&self, py: Python<'py>) -> B<'py> {
        self.field(py, "automation_id")
    }

    /// `@property def center_physical` — the 4-way unpack and the two `// 2`
    /// floor divisions all run on the live objects.
    #[getter]
    fn center_physical<'py>(slf: PyRef<'_, Self>, py: Python<'py>) -> PyResult<B<'py>> {
        let parts = unpack_n(py, &slf.field(py, "rect"), 4)?;
        let two = obj(py, 2);
        let cx = op(py, "floordiv", &op(py, "add", &parts[0], &parts[2])?, &two)?;
        let cy = op(py, "floordiv", &op(py, "add", &parts[1], &parts[3])?, &two)?;
        Ok(tuple_of(py, vec![cx, cy]))
    }

    /// the six declared fields stay writable (python's non-frozen dataclass);
    /// `center_physical` reproduces the property-without-setter wording.
    fn __setattr__(&mut self, name: String, value: &B<'_>) -> PyResult<()> {
        match name.as_str() {
            "name" => self.name = value.clone().unbind(),
            "control_type" => self.control_type = value.clone().unbind(),
            "rect" => self.rect = value.clone().unbind(),
            "enabled" => self.enabled = value.clone().unbind(),
            "offscreen" => self.offscreen = value.clone().unbind(),
            "automation_id" => self.automation_id = value.clone().unbind(),
            "center_physical" => {
                return Err(PyAttributeError::new_err(format!(
                    "property '{}' of 'UiaNode' object has no setter",
                    name
                )))
            }
            other => {
                return Err(PyAttributeError::new_err(format!(
                    "'UiaNode' object has no attribute '{}'",
                    other
                )))
            }
        }
        Ok(())
    }
}

// ── pure function layer ─────────────────────────────────────────────────────

/// def budget_trim(nodes, max_nodes=MAX_NODES)
fn budget_trim_impl<'py>(py: Python<'py>, nodes: &B<'py>, max_nodes: &B<'py>) -> PyResult<B<'py>> {
    if cmp(py, "le", max_nodes, &obj(py, 0))? {
        return Ok(PyList::empty_bound(py).into_any());
    }
    head(py, nodes, max_nodes)
}

#[pyfunction]
#[pyo3(name = "budget_trim", signature = (*args, **kwargs))]
fn py_budget_trim<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let (s, _) = bind_call("budget_trim", &["nodes", "max_nodes"], 1, false, args, kwargs)?;
    let max_nodes = s[1].clone().unwrap_or_else(|| defcell(&DEF_MAX_NODES, py));
    budget_trim_impl(py, s[0].as_ref().expect("required"), &max_nodes)
}

/// def walk_elements(hwnd, backend, max_nodes=MAX_NODES, max_depth=MAX_DEPTH)
fn walk_elements_impl<'py>(
    py: Python<'py>,
    hwnd: &B<'py>,
    backend: &B<'py>,
    max_nodes: &B<'py>,
    max_depth: &B<'py>,
) -> PyResult<B<'py>> {
    if backend.is_none() {
        return own(py, "UIA_UNAVAILABLE");
    }
    let got: PyResult<B<'py>> =
        backend.call_method1("read_window", (hwnd, max_nodes, max_depth));
    let got = match got {
        Ok(v) => v,
        Err(e) if is_py_exc(&e, py) => return own(py, "UIA_UNAVAILABLE"),
        Err(e) => return Err(e),
    };
    if got.is_none() {
        return own(py, "UIA_UNAVAILABLE");
    }
    let copied = bi1(py, "list", &got)?;
    own(py, "budget_trim")?.call1((copied, max_nodes)).map_err(Into::into)
}

#[pyfunction]
#[pyo3(name = "walk_elements", signature = (*args, **kwargs))]
fn py_walk_elements<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let (s, _) = bind_call(
        "walk_elements",
        &["hwnd", "backend", "max_nodes", "max_depth"],
        2,
        false,
        args,
        kwargs,
    )?;
    let max_nodes = s[2].clone().unwrap_or_else(|| defcell(&DEF_MAX_NODES, py));
    let max_depth = s[3].clone().unwrap_or_else(|| defcell(&DEF_MAX_DEPTH, py));
    walk_elements_impl(
        py,
        s[0].as_ref().expect("required"),
        s[1].as_ref().expect("required"),
        &max_nodes,
        &max_depth,
    )
}

/// def _norm_text(v)
fn norm_text_impl<'py>(py: Python<'py>, v: &B<'py>) -> PyResult<B<'py>> {
    let s = bi1(py, "str", &orv(v, &ps(py, ""))?)?;
    Ok(s.call_method0("strip")?.call_method0("lower")?)
}

#[pyfunction]
#[pyo3(name = "_norm_text", signature = (*args, **kwargs))]
fn py_norm_text<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let (s, _) = bind_call("_norm_text", &["v"], 1, false, args, kwargs)?;
    norm_text_impl(py, s[0].as_ref().expect("required"))
}

/// def find_elements(nodes, name="", control_type="", automation_id="",
///                   include_offscreen=False, include_disabled=False)
fn find_elements_impl<'py>(
    py: Python<'py>,
    nodes: &B<'py>,
    name: &B<'py>,
    control_type: &B<'py>,
    automation_id: &B<'py>,
    include_offscreen: &B<'py>,
    include_disabled: &B<'py>,
) -> PyResult<B<'py>> {
    let norm = own(py, "_norm_text")?;
    let n_key = norm.call1((name,))?;
    let ct_key = norm.call1((control_type,))?;
    let aid_key = norm.call1((automation_id,))?;
    let show_off = include_offscreen.is_truthy()?;
    let show_dis = include_disabled.is_truthy()?;
    let hits = PyList::empty_bound(py);
    for nd in nodes.iter()? {
        let nd = nd?.into_any();
        if !show_off && nd.getattr("offscreen")?.is_truthy()? {
            continue;
        }
        if !show_dis && !nd.getattr("enabled")?.is_truthy()? {
            continue;
        }
        if n_key.is_truthy()? {
            let hay = norm.call1((nd.getattr("name")?,))?;
            if !contains(&hay, &n_key)? {
                continue;
            }
        }
        if ct_key.is_truthy()? {
            let hay = norm.call1((nd.getattr("control_type")?,))?;
            if !cmp(py, "eq", &hay, &ct_key)? {
                continue;
            }
        }
        if aid_key.is_truthy()? {
            let hay = norm.call1((nd.getattr("automation_id")?,))?;
            if !cmp(py, "eq", &hay, &aid_key)? {
                continue;
            }
        }
        hits.append(nd)?;
    }
    Ok(hits.into_any())
}

#[pyfunction]
#[pyo3(name = "find_elements", signature = (*args, **kwargs))]
fn py_find_elements<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let (s, _) = bind_call(
        "find_elements",
        &[
            "nodes",
            "name",
            "control_type",
            "automation_id",
            "include_offscreen",
            "include_disabled",
        ],
        1,
        false,
        args,
        kwargs,
    )?;
    let empty = defcell(&DEF_EMPTY_STR, py);
    let falsy = defcell(&DEF_FALSE, py);
    find_elements_impl(
        py,
        s[0].as_ref().expect("required"),
        s[1].as_ref().unwrap_or(&empty),
        s[2].as_ref().unwrap_or(&empty),
        s[3].as_ref().unwrap_or(&empty),
        s[4].as_ref().unwrap_or(&falsy),
        s[5].as_ref().unwrap_or(&falsy),
    )
}

/// def node_to_dict(node, scale_factor=1.0)
fn node_to_dict_impl<'py>(
    py: Python<'py>,
    node: &B<'py>,
    scale_factor: &B<'py>,
) -> PyResult<B<'py>> {
    let one = flt(py, 1.0);
    let factor = bi1(py, "float", &orv(scale_factor, &one)?)?;
    let factor = if cmp(py, "le", &factor, &flt(py, 0.01))? {
        one
    } else {
        factor
    };
    let parts = unpack_n(py, &node.getattr("center_physical")?, 2)?;
    let cap = own(py, "_NAME_CAP")?;
    let name_v = head(py, &node.getattr("name")?, &cap)?;
    let type_v = node.getattr("control_type")?;
    let aid_v = head(py, &node.getattr("automation_id")?, &cap)?;
    let rect = node.getattr("rect")?;
    let mut rect_items: Vec<B<'py>> = Vec::with_capacity(4);
    for i in 0..4 {
        rect_items.push(bi1(py, "int", &rect.get_item(i)?)?);
    }
    let mut center: Vec<B<'py>> = Vec::with_capacity(2);
    for p in &parts {
        let q = op(py, "truediv", p, &factor)?;
        center.push(bi1(py, "int", &bi1(py, "round", &q)?)?);
    }
    let enabled_v = node.getattr("enabled")?;
    Ok(dict_of(
        py,
        vec![
            ("name", name_v),
            ("type", type_v),
            ("automation_id", aid_v),
            ("rect", list_of(py, rect_items)),
            ("center", list_of(py, center)),
            ("enabled", enabled_v),
        ],
    ))
}

#[pyfunction]
#[pyo3(name = "node_to_dict", signature = (*args, **kwargs))]
fn py_node_to_dict<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let (s, _) = bind_call("node_to_dict", &["node", "scale_factor"], 1, false, args, kwargs)?;
    let scale = s[1].clone().unwrap_or_else(|| defcell(&DEF_SCALE, py));
    node_to_dict_impl(py, s[0].as_ref().expect("required"), &scale)
}

/// def resolve_element_target(nodes, target, scale_factor=1.0)
fn resolve_element_target_impl<'py>(
    py: Python<'py>,
    nodes: &B<'py>,
    target: &B<'py>,
    scale_factor: &B<'py>,
) -> PyResult<B<'py>> {
    let one = obj(py, 1);
    let raw = get1(py, target, "index")?;
    let idx: PyResult<B<'py>> = (|| bi1(py, "int", &orv(&raw, &one)?))();
    let idx = match idx {
        Ok(v) => v,
        Err(e)
            if e.is_instance_of::<PyTypeError>(py) || e.is_instance_of::<PyValueError>(py) =>
        {
            one.clone()
        }
        Err(e) => return Err(e),
    };
    if cmp(py, "lt", &idx, &one)? {
        let msg = fstr(
            py,
            vec![
                ps(py, "index 必须从 1 起，收到 "),
                fmtv(py, &idx)?,
                ps(py, "。可改用 click_text 走 OCR 定位，或直接给坐标。"),
            ],
        )?;
        return Ok(tuple_of(py, vec![bi_get(py, "False")?, msg]));
    }
    let empty = ps(py, "");
    let finder = own(py, "find_elements")?;
    let kw = kwargs_of(
        py,
        &[
            (
                "name",
                bi1(py, "str", &orv(&get1(py, target, "name")?, &empty)?)?,
            ),
            (
                "control_type",
                bi1(py, "str", &orv(&get1(py, target, "control_type")?, &empty)?)?,
            ),
            (
                "automation_id",
                bi1(py, "str", &orv(&get1(py, target, "automation_id")?, &empty)?)?,
            ),
        ],
    )?;
    let hits = finder.call((nodes,), Some(&kw))?;
    if !hits.is_truthy()? {
        let msg = fstr(
            py,
            vec![
                ps(py, "在无障碍树中未找到匹配元素（name="),
                bi1(py, "repr", &get1(py, target, "name")?)?,
                ps(py, "）。可改用 click_text 走 OCR 定位，或直接给坐标。"),
            ],
        )?;
        return Ok(tuple_of(py, vec![bi_get(py, "False")?, msg]));
    }
    if cmp(py, "gt", &idx, &call_bi(py, "len", (&hits,))?)? {
        let msg = fstr(
            py,
            vec![
                ps(py, "匹配到 "),
                fmtv(py, &call_bi(py, "len", (&hits,))?)?,
                ps(py, " 个元素，指定的 index="),
                fmtv(py, &idx)?,
                ps(py, " 超出范围（occurrence="),
                fmtv(py, &idx)?,
                ps(py, "）。可改用 click_text 走 OCR 定位，或直接给坐标。"),
            ],
        )?;
        return Ok(tuple_of(py, vec![bi_get(py, "False")?, msg]));
    }
    let pick = hits.get_item(op(py, "sub", &idx, &one)?)?;
    let kw2 = kwargs_of(py, &[("scale_factor", scale_factor.clone())])?;
    let d = own(py, "node_to_dict")?.call((pick,), Some(&kw2))?;
    let center = d.get_item(ps(py, "center"))?;
    Ok(tuple_of(
        py,
        vec![
            bi_get(py, "True")?,
            tuple_of(
                py,
                vec![center.get_item(obj(py, 0))?, center.get_item(obj(py, 1))?],
            ),
        ],
    ))
}

#[pyfunction]
#[pyo3(name = "resolve_element_target", signature = (*args, **kwargs))]
fn py_resolve_element_target<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let (s, _) = bind_call(
        "resolve_element_target",
        &["nodes", "target", "scale_factor"],
        2,
        false,
        args,
        kwargs,
    )?;
    let scale = s[2].clone().unwrap_or_else(|| defcell(&DEF_SCALE, py));
    resolve_element_target_impl(
        py,
        s[0].as_ref().expect("required"),
        s[1].as_ref().expect("required"),
        &scale,
    )
}

// ── ctypes layer: everything runs through the live ctypes module ────────────

fn ctypes<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    own(py, "ctypes")
}

/// `ctypes.c_void_p()` — a fresh NULL pointer object.
fn c_void_p_new(py: Python<'_>) -> PyResult<B<'_>> {
    Ok(ctypes(py)?.getattr("c_void_p")?.call0()?)
}

/// `ctypes.POINTER(ctypes.c_void_p)`, spelled out at each call site as python does.
fn pointer_voidp(py: Python<'_>) -> PyResult<B<'_>> {
    let ct = ctypes(py)?;
    Ok(ct.call_method1("POINTER", (&ct.getattr("c_void_p")?,))?)
}

/// `ctypes.POINTER(<attr>)`
fn pointer_of<'py>(py: Python<'py>, attr: &str) -> PyResult<B<'py>> {
    let ct = ctypes(py)?;
    Ok(ct.call_method1("POINTER", (&ct.getattr(attr)?,))?)
}

/// `_vtable(ptr)`: 双层解引用——只解一层读到的是对象字段，调下去就是拿数据当代码执行。
fn vtable<'py>(py: Python<'py>, ptr: &B<'py>) -> PyResult<B<'py>> {
    let ct = ctypes(py)?;
    let ptype = ct.call_method1("POINTER", (&ct.getattr("c_void_p")?,))?;
    let casted = ct.call_method1("cast", (ptr, &ptype))?;
    let vptr = casted.getattr("contents")?;
    let ptype2 = ctypes(py)?.call_method1("POINTER", (&ct.getattr("c_void_p")?,))?;
    Ok(ct.call_method1("cast", (&vptr, &ptype2))?)
}

#[pyfunction]
#[pyo3(name = "_vtable", signature = (*args, **kwargs))]
fn py_vtable<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let (s, _) = bind_call("_vtable", &["ptr"], 1, false, args, kwargs)?;
    vtable(py, s[0].as_ref().expect("required"))
}

/// `_com(ptr, slot, restype, *argtypes)` → 已绑定 this 的 `_invoke(*args)`。
fn com_impl<'py>(
    py: Python<'py>,
    ptr: &B<'py>,
    slot: &B<'py>,
    restype: &B<'py>,
    argtypes: &[B<'py>],
) -> PyResult<B<'py>> {
    let ct = ctypes(py)?;
    let mut pre: Vec<B<'py>> = vec![restype.clone(), ct.getattr("c_void_p")?];
    pre.extend(argtypes.iter().cloned());
    let proto = ct
        .getattr("WINFUNCTYPE")?
        .call(&PyTuple::new_bound(py, pre), None)?;
    let item = vtable(py, ptr)?.get_item(slot)?;
    let f = ct.call_method1("cast", (&item, &proto))?;
    let f_obj = f.unbind();
    let p_obj = ptr.clone().unbind();
    let invoke = PyCFunction::new_closure_bound(
        py,
        Some(c"_invoke"),
        Some(c"按槽位调用 COM 成员；this 已在绑定时注入。"),
        move |args: &Bound<'_, PyTuple>, kwargs: Option<&Bound<'_, PyDict>>| -> PyResult<PyObject> {
            let py = args.py();
            if let Some(kw) = kwargs {
                for (k, _) in kw.iter() {
                    let key: String = match k.extract() {
                        Ok(s) => s,
                        Err(_) => return Err(PyTypeError::new_err("keywords must be strings")),
                    };
                    return Err(PyTypeError::new_err(format!(
                        "_invoke() got an unexpected keyword argument '{}'",
                        key
                    )));
                }
            }
            let mut items: Vec<Py<PyAny>> = vec![p_obj.clone_ref(py)];
            for a in args.iter() {
                items.push(a.into_any().unbind());
            }
            let call_args = PyTuple::new_bound(py, items);
            Ok(f_obj.bind(py).clone().call(&call_args, None)?.unbind())
        },
    )?;
    Ok(invoke.into_any())
}

#[pyfunction]
#[pyo3(name = "_com", signature = (*args, **kwargs))]
fn py_com<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let (s, extra) = bind_call("_com", &["ptr", "slot", "restype"], 3, true, args, kwargs)?;
    com_impl(
        py,
        s[0].as_ref().expect("required"),
        s[1].as_ref().expect("required"),
        s[2].as_ref().expect("required"),
        &extra,
    )
}

/// `_com(...)(...)` — build the slot invoker and call it, which is exactly what
/// the python expression `_com(a, b, c, d)(e)` does: `_com(...)` runs first
/// (WINFUNCTYPE, the two `_vtable` casts, the vtable slot read, the cast onto
/// the proto), and only then are the inner call's arguments evaluated. So
/// `mk_args` is a closure, not a slice — evaluating it with the other operands
/// would put `byref(...)`/`c_void_p(hwnd)` in the ledger ahead of the `_com`
/// work, which is the whole difference between the two spellings.
fn com_call<'py, F>(
    py: Python<'py>,
    ptr: &B<'py>,
    slot: &B<'py>,
    restype: &B<'py>,
    argtypes: &[B<'py>],
    mk_args: F,
) -> PyResult<B<'py>>
where
    F: FnOnce() -> PyResult<Vec<B<'py>>>,
{
    let f = com_impl(py, ptr, slot, restype, argtypes)?;
    let items: Vec<B<'py>> = mk_args()?;
    let call_args = PyTuple::new_bound(py, items);
    Ok(f.call(&call_args, None)?)
}

enum FieldKind {
    Scalar(&'static str),
    Array(&'static str, i64),
}

/// `class _Rect(ctypes.Structure)` / `class _GUID(…)` — the real `type()` called
/// with a verbatim `_fields_` list.
fn structure_class<'py>(
    py: Python<'py>,
    ct: &B<'py>,
    name: &str,
    fields: &[(&str, FieldKind)],
) -> PyResult<B<'py>> {
    let mut items: Vec<B<'py>> = Vec::with_capacity(fields.len());
    for (n, kind) in fields {
        let ty = match kind {
            FieldKind::Scalar(s) => ct.getattr(*s)?,
            FieldKind::Array(s, k) => op(py, "mul", &ct.getattr(*s)?, &obj(py, *k))?,
        };
        items.push(tuple_of(py, vec![ps(py, n), ty]));
    }
    let ns = PyDict::new_bound(py);
    ns.set_item("__module__", "uia_tree")?;
    ns.set_item("__qualname__", name)?;
    ns.set_item("_fields_", PyList::new_bound(py, items))?;
    let bases = PyTuple::new_bound(py, vec![ct.getattr("Structure")?.unbind()]);
    Ok(builtins(py)?.getattr("type")?.call1((ps(py, name), &bases, &ns))?)
}

// ── CtypesUiaBackend ────────────────────────────────────────────────────────

#[pyclass(subclass, module = "uia_tree", name = "CtypesUiaBackend")]
struct CtypesUiaBackend {
    _ole32: Option<PyObject>,
    _oleaut32: Option<PyObject>,
    _coinited: Option<PyObject>,
    _uia: Option<PyObject>,
}

/// `self._guid(text)`'s body, shared by the pymethod (which dispatches through
/// the instance) and the construction path (which cannot — see the header).
fn guid_of<'py>(py: Python<'py>, ole32: &B<'py>, text: &B<'py>) -> PyResult<B<'py>> {
    let g = own(py, "_GUID")?.call0()?;
    let ct = ctypes(py)?;
    let byref = ct.call_method1("byref", (&g,))?;
    let hr = ole32.call_method1("CLSIDFromString", (text.clone(), byref))?;
    if cmp(py, "ne", &hr, &obj(py, 0))? {
        let msg = fstr(
            py,
            vec![
                ps(py, "CLSIDFromString("),
                fmtv(py, text)?,
                ps(py, ") failed: "),
                fmt_spec(py, &hr, "#x")?,
            ],
        )?;
        return Err(PyOSError::new_err(msg.extract::<String>()?));
    }
    Ok(g)
}

/// `self._create_automation()`'s body, with `self._guid` behind a callback so
/// both dispatch shapes share one implementation.
fn create_automation<'py, G>(
    py: Python<'py>,
    ole32: &B<'py>,
    mut guid: G,
) -> PyResult<B<'py>>
where
    G: FnMut(&B<'py>) -> PyResult<B<'py>>,
{
    let ct = ctypes(py)?;
    let clsid = guid(&own(py, "_CLSID_CUIAUTOMATION")?)?;
    let iid = guid(&own(py, "_IID_IUIAUTOMATION")?)?;
    let out = c_void_p_new(py)?;
    let hr = ole32.call_method1(
        "CoCreateInstance",
        (
            ct.call_method1("byref", (&clsid,))?,
            none(py),
            obj(py, 1),
            ct.call_method1("byref", (&iid,))?,
            ct.call_method1("byref", (&out,))?,
        ),
    )?;
    if cmp(py, "ne", &hr, &obj(py, 0))? || !out.getattr("value")?.is_truthy()? {
        let msg = fstr(
            py,
            vec![
                ps(py, "CoCreateInstance(CUIAutomation) failed: "),
                fmt_spec(py, &hr, "#x")?,
            ],
        )?;
        return Err(PyOSError::new_err(msg.extract::<String>()?));
    }
    Ok(out)
}

/// `cap = max(1, min(int(x or NAME), NAME))` — the budget-discipline clamp,
/// with the ceiling global read twice as python's expression does.
fn clamp<'py>(py: Python<'py>, x: &B<'py>, global: &str) -> PyResult<B<'py>> {
    let live1 = own(py, global)?;
    let coerced = bi1(py, "int", &orv(x, &live1)?)?;
    let live2 = own(py, global)?;
    let minned = call_bi(py, "min", (&coerced, &live2))?;
    call_bi(py, "max", (obj(py, 1), &minned))
}

/// the instance as a plain `Bound`, so every post-construction call below
/// dispatches through `self` the way python's attribute lookup does.
fn me_any<'py>(py: Python<'py>, slf: Py<CtypesUiaBackend>) -> B<'py> {
    slf.into_bound(py).into_any()
}

#[pymethods]
impl CtypesUiaBackend {
    #[new]
    #[pyo3(signature = (*args, **kwargs))]
    fn py_new(
        py: Python<'_>,
        args: &Bound<'_, PyTuple>,
        kwargs: Option<&Bound<'_, PyDict>>,
    ) -> PyResult<Self> {
        // CPython binds `CtypesUiaBackend(...)` before the body runs, so a
        // surplus positional or an extraneous keyword reads
        // `__init__() …` and never gets wrapped as "UIA COM unavailable".
        bind_init(py, "CtypesUiaBackend", &[], 0, args, kwargs)?;
        let platform = own(py, "sys")?.getattr("platform")?;
        if cmp(py, "ne", &platform, &ps(py, "win32"))? {
            return Err(PyOSError::new_err("CtypesUiaBackend only runs on Windows"));
        }
        let ct = ctypes(py)?;
        let windll = ct.getattr("windll")?;
        let ole32 = windll.getattr("ole32")?;
        let oleaut32 = windll.getattr("oleaut32")?;
        // COINIT_APARTMENTTHREADED = 0x2; RPC_E_CHANGED_MODE still works, it
        // just must not CoUninitialize — hence `hr in (0, 1)`, not `==`.
        let hr = ole32.call_method1("CoInitializeEx", (none(py), obj(py, 0x2)))?;
        let coinited = contains(&tuple_of(py, vec![obj(py, 0), obj(py, 1)]), &hr)?;
        let made = create_automation(py, &ole32, |t| guid_of(py, &ole32, t));
        match made {
            Ok(v) => Ok(Self {
                _ole32: Some(ole32.unbind()),
                _oleaut32: Some(oleaut32.unbind()),
                _coinited: Some(truthy(py, coinited)?.unbind()),
                _uia: Some(v.unbind()),
            }),
            Err(e) if is_py_exc(&e, py) => {
                let exc = e.value_bound(py).clone();
                if coinited {
                    ole32.call_method0("CoUninitialize")?;
                }
                let msg = fstr(
                    py,
                    vec![ps(py, "UIA COM unavailable: "), fmtv(py, &exc)?],
                )?;
                let inst = builtins(py)?.getattr("OSError")?.call1((msg,))?;
                inst.setattr("__cause__", &exc)?;
                inst.setattr("__context__", &exc)?;
                inst.setattr("__suppress_context__", truthy(py, true)?)?;
                Err(PyErr::from_value_bound(inst))
            }
            Err(e) => Err(e),
        }
    }

    #[getter]
    fn _ole32(&self, py: Python<'_>) -> PyObject {
        opt_ref(&self._ole32, py)
    }

    #[getter]
    fn _oleaut32(&self, py: Python<'_>) -> PyObject {
        opt_ref(&self._oleaut32, py)
    }

    #[getter]
    fn _coinited(&self, py: Python<'_>) -> PyObject {
        opt_ref(&self._coinited, py)
    }

    #[getter]
    fn _uia(&self, py: Python<'_>) -> PyObject {
        opt_ref(&self._uia, py)
    }

    fn __setattr__(&mut self, name: String, value: &B<'_>) -> PyResult<()> {
        match name.as_str() {
            "_ole32" => self._ole32 = Some(value.clone().unbind()),
            "_oleaut32" => self._oleaut32 = Some(value.clone().unbind()),
            "_coinited" => self._coinited = Some(value.clone().unbind()),
            "_uia" => self._uia = Some(value.clone().unbind()),
            other => {
                return Err(PyAttributeError::new_err(format!(
                    "'CtypesUiaBackend' object has no attribute '{}'",
                    other
                )))
            }
        }
        Ok(())
    }

    /// `def _guid(self, text)`
    #[pyo3(signature = (text))]
    fn _guid<'py>(&self, py: Python<'py>, text: &B<'py>) -> PyResult<B<'py>> {
        guid_of(py, &self.ole32(py)?, text)
    }

    /// `def _create_automation(self)` — dispatches `_guid` through self.
    fn _create_automation<'py>(slf: Py<Self>, py: Python<'py>) -> PyResult<B<'py>> {
        let s = me_any(py, slf);
        let ole32 = s.getattr("_ole32")?;
        create_automation(py, &ole32, |t| s.call_method1("_guid", (t,)))
    }

    /// `def _bstr(self, el, slot)` — `out` is created OUTSIDE the try, so a
    /// failing `c_void_p()` propagates instead of degrading to `""`.
    #[pyo3(signature = (el, slot))]
    fn _bstr<'py>(&self, py: Python<'py>, el: &B<'py>, slot: &B<'py>) -> PyResult<B<'py>> {
        let out = c_void_p_new(py)?;
        let got: PyResult<B<'py>> = (|| {
            let ct = ctypes(py)?;
            let hr = com_call(
                py,
                el,
                slot,
                &ct.getattr("c_long")?,
                &[pointer_voidp(py)?],
                || Ok(vec![ct.call_method1("byref", (&out,))?]),
            )?;
            if cmp(py, "ne", &hr, &obj(py, 0))? {
                return Ok(ps(py, ""));
            }
            let val = out.getattr("value")?;
            if !val.is_truthy()? {
                return Ok(ps(py, ""));
            }
            let oleaut = self.oleaut32(py)?;
            try_finally_val(py, ct.call_method1("wstring_at", (&val,)), || {
                oleaut.call_method1("SysFreeString", (&out,)).map(|_| ())
            })
        })();
        match got {
            Ok(v) => Ok(v),
            Err(e) if is_py_exc(&e, py) => Ok(ps(py, "")),
            Err(e) => Err(e),
        }
    }

    /// `def _int(self, el, slot)` — the HRESULT is deliberately discarded, and
    /// `int(v.value)` sits AFTER the try, so only the call itself degrades to 0.
    #[pyo3(signature = (el, slot))]
    fn _int<'py>(&self, py: Python<'py>, el: &B<'py>, slot: &B<'py>) -> PyResult<B<'py>> {
        let ct = ctypes(py)?;
        let v = ct.getattr("c_int")?.call1((obj(py, 0),))?;
        let got: PyResult<()> = (|| {
            com_call(
                py,
                el,
                slot,
                &ct.getattr("c_long")?,
                &[pointer_of(py, "c_int")?],
                || Ok(vec![ct.call_method1("byref", (&v,))?]),
            )?;
            Ok(())
        })();
        match got {
            Err(e) if is_py_exc(&e, py) => return Ok(obj(py, 0)),
            Err(e) => return Err(e),
            Ok(()) => {}
        }
        bi1(py, "int", &v.getattr("value")?)
    }

    /// `def _flag(self, el, slot)` — `hr == 0 and bool(v.value)` runs AFTER the
    /// try, so only the call itself degrades to `False`.
    #[pyo3(signature = (el, slot))]
    fn _flag<'py>(&self, py: Python<'py>, el: &B<'py>, slot: &B<'py>) -> PyResult<B<'py>> {
        let ct = ctypes(py)?;
        let v = ct.getattr("c_int")?.call1((obj(py, 0),))?;
        let got: PyResult<B<'py>> = (|| {
            com_call(
                py,
                el,
                slot,
                &ct.getattr("c_long")?,
                &[pointer_of(py, "c_int")?],
                || Ok(vec![ct.call_method1("byref", (&v,))?]),
            )
        })();
        let hr = match got {
            Ok(v) => v,
            Err(e) if is_py_exc(&e, py) => return truthy(py, false),
            Err(e) => return Err(e),
        };
        if !cmp(py, "eq", &hr, &obj(py, 0))? {
            return truthy(py, false);
        }
        truthy(py, v.getattr("value")?.is_truthy()?)
    }

    /// `def _rect(self, el, slot)` — the four `int(r.<field>)` reads run AFTER
    /// the try, so a partially-filled struct only degrades on a bad HRESULT.
    #[pyo3(signature = (el, slot))]
    fn _rect<'py>(&self, py: Python<'py>, el: &B<'py>, slot: &B<'py>) -> PyResult<B<'py>> {
        let zero = || tuple_of(py, vec![obj(py, 0), obj(py, 0), obj(py, 0), obj(py, 0)]);
        let ct = ctypes(py)?;
        let cls = own(py, "_Rect")?;
        let r = cls.call0()?;
        let got: PyResult<bool> = (|| {
            let hr = com_call(
                py,
                el,
                slot,
                &ct.getattr("c_long")?,
                &[ct.call_method1("POINTER", (&cls,))?],
                || Ok(vec![ct.call_method1("byref", (&r,))?]),
            )?;
            cmp(py, "ne", &hr, &obj(py, 0))
        })();
        match got {
            Err(e) if is_py_exc(&e, py) => return Ok(zero()),
            Err(e) => return Err(e),
            Ok(true) => return Ok(zero()),
            Ok(false) => {}
        }
        let mut items: Vec<B<'py>> = Vec::with_capacity(4);
        for n in ["left", "top", "right", "bottom"] {
            items.push(bi1(py, "int", &r.getattr(n)?)?);
        }
        Ok(tuple_of(py, items))
    }

    /// `def _snapshot(self, el)` — six keyword arguments, written order.
    #[pyo3(signature = (el))]
    fn _snapshot<'py>(slf: Py<Self>, py: Python<'py>, el: &B<'py>) -> PyResult<B<'py>> {
        let s = me_any(py, slf);
        let name = s.call_method1("_bstr", (el, own(py, "_SLOT_ELEM_CURRENT_NAME")?))?;
        let raw_type = s.call_method1(
            "_int",
            (el, own(py, "_SLOT_ELEM_CURRENT_CONTROL_TYPE")?),
        )?;
        let control_type =
            own(py, "_CONTROL_TYPE_NAMES")?.call_method1("get", (&raw_type, ps(py, "Unknown")))?;
        let rect = s.call_method1(
            "_rect",
            (el, own(py, "_SLOT_ELEM_CURRENT_BOUNDING_RECT")?),
        )?;
        let enabled = s.call_method1("_flag", (el, own(py, "_SLOT_ELEM_CURRENT_ENABLED")?))?;
        let offscreen = s.call_method1("_flag", (el, own(py, "_SLOT_ELEM_CURRENT_OFFSCREEN")?))?;
        let automation_id = s.call_method1(
            "_bstr",
            (el, own(py, "_SLOT_ELEM_CURRENT_AUTOMATION_ID")?),
        )?;
        let kw = kwargs_of(
            py,
            &[
                ("name", name),
                ("control_type", control_type),
                ("rect", rect),
                ("enabled", enabled),
                ("offscreen", offscreen),
                ("automation_id", automation_id),
            ],
        )?;
        Ok(own(py, "UiaNode")?.call((), Some(&kw))?)
    }

    /// `def _release(self, ptr)`
    #[pyo3(signature = (ptr))]
    fn _release<'py>(&self, py: Python<'py>, ptr: &B<'py>) -> PyResult<B<'py>> {
        if !ptr.is_truthy()? {
            return Ok(none(py));
        }
        let value = call_bi(py, "getattr", (ptr, &ps(py, "value"), &none(py)))?;
        if !value.is_truthy()? {
            return Ok(none(py));
        }
        let got: PyResult<B<'py>> = (|| {
            com_call(
                py,
                ptr,
                &obj(py, 2),
                &ctypes(py)?.getattr("c_ulong")?,
                &[],
                || -> PyResult<Vec<B<'py>>> { Ok(vec![]) },
            )
        })();
        match got {
            Ok(_) => Ok(none(py)),
            Err(e) if is_py_exc(&e, py) => Ok(none(py)),
            Err(e) => Err(e),
        }
    }

    /// `def read_window(self, hwnd, max_nodes, max_depth)`
    #[pyo3(signature = (hwnd, max_nodes, max_depth))]
    fn read_window<'py>(
        slf: Py<Self>,
        py: Python<'py>,
        hwnd: &B<'py>,
        max_nodes: &B<'py>,
        max_depth: &B<'py>,
    ) -> PyResult<B<'py>> {
        let got: PyResult<B<'py>> =
            me_any(py, slf).call_method1("_read", (hwnd, max_nodes, max_depth));
        match got {
            Ok(v) => Ok(v),
            Err(e) if is_py_exc(&e, py) => Ok(none(py)),
            Err(e) => Err(e),
        }
    }

    /// `def _read(self, hwnd, max_nodes, max_depth)`
    #[pyo3(signature = (hwnd, max_nodes, max_depth))]
    fn _read<'py>(
        slf: Py<Self>,
        py: Python<'py>,
        hwnd: &B<'py>,
        max_nodes: &B<'py>,
        max_depth: &B<'py>,
    ) -> PyResult<B<'py>> {
        let s = me_any(py, slf);
        let uia = s.getattr("_uia")?;
        let ct = ctypes(py)?;
        let root = c_void_p_new(py)?;
        let hr = com_call(
            py,
            &uia,
            &own(py, "_SLOT_IUIA_FROM_HANDLE")?,
            &ct.getattr("c_long")?,
            &[ct.getattr("c_void_p")?, pointer_voidp(py)?],
            || {
                Ok(vec![
                    ct.getattr("c_void_p")?.call1((hwnd,))?,
                    ct.call_method1("byref", (&root,))?,
                ])
            },
        )?;
        if cmp(py, "ne", &hr, &obj(py, 0))? || !root.getattr("value")?.is_truthy()? {
            return Ok(none(py));
        }
        let walker = c_void_p_new(py)?;
        let hr = com_call(
            py,
            &uia,
            &own(py, "_SLOT_IUIA_CONTROL_VIEW_WALKER")?,
            &ct.getattr("c_long")?,
            &[pointer_voidp(py)?],
            || Ok(vec![ct.call_method1("byref", (&walker,))?]),
        )?;
        if cmp(py, "ne", &hr, &obj(py, 0))? || !walker.getattr("value")?.is_truthy()? {
            // python releases ONLY the root here — the empty walker is left alone.
            s.call_method1("_release", (&root,))?;
            return Ok(none(py));
        }
        let cap = clamp(py, max_nodes, "MAX_NODES")?;
        let depth_cap = clamp(py, max_depth, "MAX_DEPTH")?;
        let out = PyList::empty_bound(py);
        let body = s
            .call_method1(
                "_walk",
                (
                    &walker,
                    &root,
                    out.as_any(),
                    obj(py, 0),
                    &cap,
                    &depth_cap,
                ),
            )
            .map(|_| ());
        // `finally: _release(walker); _release(root)` — a failing first release
        // skips the second one.
        try_finally(py, body, || {
            s.call_method1("_release", (&walker,))?;
            s.call_method1("_release", (&root,))?;
            Ok(())
        })?;
        Ok(out.into_any())
    }

    /// `def _walk(self, walker, el, out, depth, cap, depth_cap)`
    #[allow(clippy::too_many_arguments)]
    #[pyo3(signature = (walker, el, out, depth, cap, depth_cap))]
    fn _walk<'py>(
        slf: Py<Self>,
        py: Python<'py>,
        walker: &B<'py>,
        el: &B<'py>,
        out: &B<'py>,
        depth: &B<'py>,
        cap: &B<'py>,
        depth_cap: &B<'py>,
    ) -> PyResult<B<'py>> {
        let s = me_any(py, slf);
        if cmp(py, "ge", &call_bi(py, "len", (out,))?, cap)? || cmp(py, "gt", depth, depth_cap)? {
            return Ok(none(py));
        }
        let snap = s.call_method1("_snapshot", (el,))?;
        out.call_method1("append", (&snap,))?;
        let ct = ctypes(py)?;
        let child = c_void_p_new(py)?;
        let ok = com_call(
            py,
            walker,
            &own(py, "_SLOT_WALKER_FIRST_CHILD")?,
            &ct.getattr("c_long")?,
            &[ct.getattr("c_void_p")?, pointer_voidp(py)?],
            || Ok(vec![el.clone(), ct.call_method1("byref", (&child,))?]),
        )?;
        if cmp(py, "ne", &ok, &obj(py, 0))? || !child.getattr("value")?.is_truthy()? {
            return Ok(none(py));
        }
        let mut cur = child.clone();
        let body: PyResult<()> = (|| {
            loop {
                if !cur.getattr("value")?.is_truthy()? {
                    break;
                }
                if !cmp(py, "lt", &call_bi(py, "len", (out,))?, cap)? {
                    break;
                }
                s.call_method1(
                    "_walk",
                    (
                        walker,
                        &cur,
                        out,
                        op(py, "add", depth, &obj(py, 1))?,
                        cap,
                        depth_cap,
                    ),
                )?;
                let nxt = c_void_p_new(py)?;
                let ok = com_call(
                    py,
                    walker,
                    &own(py, "_SLOT_WALKER_NEXT_SIBLING")?,
                    &ct.getattr("c_long")?,
                    &[ct.getattr("c_void_p")?, pointer_voidp(py)?],
                    || Ok(vec![cur.clone(), ct.call_method1("byref", (&nxt,))?]),
                )?;
                if cmp(py, "ne", &ok, &obj(py, 0))? || !nxt.getattr("value")?.is_truthy()? {
                    break;
                }
                s.call_method1("_release", (&cur,))?;
                cur = nxt;
            }
            Ok(())
        })();
        // `finally: self._release(child)` releases whatever `child` is NOW.
        try_finally(py, body, || s.call_method1("_release", (&cur,)).map(|_| ()) )?;
        Ok(none(py))
    }

    /// `def close(self)`
    fn close<'py>(slf: Py<Self>, py: Python<'py>) -> PyResult<B<'py>> {
        let s = me_any(py, slf);
        let uia = call_bi(py, "getattr", (&s, &ps(py, "_uia"), &none(py)))?;
        if uia.is_truthy()? {
            // `self._release(self._uia)`: the attribute is read a second time.
            s.call_method1("_release", (s.getattr("_uia")?,))?;
            s.setattr("_uia", none(py))?;
        }
        let coinited = call_bi(py, "getattr", (&s, &ps(py, "_coinited"), &bi_get(py, "False")?))?;
        if coinited.is_truthy()? {
            let got: PyResult<B<'py>> =
                (|| s.getattr("_ole32")?.call_method0("CoUninitialize"))();
            if let Err(e) = got {
                if !is_py_exc(&e, py) {
                    return Err(e);
                }
            }
            s.setattr("_coinited", bi_get(py, "False")?)?;
        }
        Ok(none(py))
    }
}

impl CtypesUiaBackend {
    fn ole32<'py>(&self, py: Python<'py>) -> PyResult<B<'py>> {
        Ok(self
            ._ole32
            .as_ref()
            .map(|p| p.clone_ref(py).into_bound(py))
            .unwrap_or_else(|| py.None().into_bound(py)))
    }

    fn oleaut32<'py>(&self, py: Python<'py>) -> PyResult<B<'py>> {
        Ok(self
            ._oleaut32
            .as_ref()
            .map(|p| p.clone_ref(py).into_bound(py))
            .unwrap_or_else(|| py.None().into_bound(py)))
    }
}

// ── the `UiaBackend` protocol ───────────────────────────────────────────────

/// built on the real `typing.Protocol`, so `__protocol_attrs__`, the
/// instantiation TypeError and the not-`@runtime_checkable` isinstance rejection
/// all come from CPython's own machinery.
fn uia_backend_protocol<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let typing = py.import_bound("typing")?;
    // a real `def` executed through CPython's own compiler, so the attribute is
    // an ordinary python function with a writable `__dict__`, `__module__` and
    // `__qualname__` like the canonical one.
    let globals = PyDict::new_bound(py);
    globals.set_item("__name__", "uia_tree")?;
    py.run_bound(
        "def read_window(self, hwnd, max_nodes, max_depth): ...",
        Some(&globals),
        None,
    )?;
    let rw = globals
        .get_item("read_window")?
        .ok_or_else(|| {
            pyo3::exceptions::PyRuntimeError::new_err("UiaBackend.read_window not defined")
        })?;
    rw.setattr("__qualname__", ps(py, "UiaBackend.read_window"))?;
    // `from __future__ import annotations` is in force in the canonical module,
    // so the annotation VALUES are the source strings, unevaluated.
    let annots = PyDict::new_bound(py);
    annots.set_item("hwnd", "int")?;
    annots.set_item("max_nodes", "int")?;
    annots.set_item("max_depth", "int")?;
    annots.set_item("return", "Optional[List[UiaNode]]")?;
    rw.setattr("__annotations__", annots)?;
    let ns = PyDict::new_bound(py);
    ns.set_item("__module__", "uia_tree")?;
    ns.set_item("__qualname__", "UiaBackend")?;
    ns.set_item(
        "__doc__",
        "后端契约：给 hwnd 返回扁平元素快照列表，失败返回 None。",
    )?;
    ns.set_item("read_window", rw)?;
    Ok(builtins(py)?.getattr("type")?.call1((
        ps(py, "UiaBackend"),
        PyTuple::new_bound(py, vec![typing.getattr("Protocol")?.unbind()]),
        ns,
    ))?)
}

// ── registration ────────────────────────────────────────────────────────────

/// Register the uia_tree submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(py, "uia_tree")?;

    m.add_function(wrap_pyfunction!(py_budget_trim, &m)?)?;
    m.add_function(wrap_pyfunction!(py_walk_elements, &m)?)?;
    m.add_function(wrap_pyfunction!(py_norm_text, &m)?)?;
    m.add_function(wrap_pyfunction!(py_find_elements, &m)?)?;
    m.add_function(wrap_pyfunction!(py_node_to_dict, &m)?)?;
    m.add_function(wrap_pyfunction!(py_resolve_element_target, &m)?)?;
    m.add_function(wrap_pyfunction!(py_vtable, &m)?)?;
    m.add_function(wrap_pyfunction!(py_com, &m)?)?;
    m.add_class::<UiaNode>()?;
    m.add_class::<CtypesUiaBackend>()?;
    m.add("UiaBackend", uia_backend_protocol(py)?)?;

    m.add("MAX_NODES", MAX_NODES)?;
    m.add("MAX_DEPTH", MAX_DEPTH)?;
    m.add("UIA_UNAVAILABLE", UIA_UNAVAILABLE)?;
    m.add("_NAME_CAP", NAME_CAP)?;
    m.add("_CLSID_CUIAUTOMATION", CLSID_CUIAUTOMATION)?;
    m.add("_IID_IUIAUTOMATION", IID_IUIAUTOMATION)?;
    for (n, v) in SLOTS.iter() {
        m.add(*n, *v)?;
    }
    let names = PyDict::new_bound(py);
    for (id, n) in CONTROL_TYPE_NAMES.iter() {
        names.set_item(*id, *n)?;
    }
    m.add("_CONTROL_TYPE_NAMES", &names)?;

    // the def-time default cells: the same objects python's code objects hold.
    *DEF_MAX_NODES.lock() = Some(m.getattr("MAX_NODES")?.into());
    *DEF_MAX_DEPTH.lock() = Some(m.getattr("MAX_DEPTH")?.into());
    *DEF_SCALE.lock() = Some(flt(py, 1.0).unbind());
    *DEF_EMPTY_STR.lock() = Some(ps(py, "").unbind());
    *DEF_FALSE.lock() = Some(bi_get(py, "False")?.into());
    *DEF_TRUE.lock() = Some(bi_get(py, "True")?.into());

    // `from __future__ import annotations` / `import sys` / `from typing …` /
    // `import ctypes` — the same objects under the same names, so `dir()` and
    // every late global lookup match.
    m.add("sys", mod_import(py, "sys")?)?;
    m.add(
        "annotations",
        mod_import(py, "__future__")?.getattr("annotations")?,
    )?;
    m.add(
        "dataclass",
        mod_import(py, "dataclasses")?.getattr("dataclass")?,
    )?;
    for n in ["Any", "Dict", "List", "Optional", "Protocol", "Tuple", "Union"] {
        m.add(n, py.import_bound("typing")?.getattr(n)?)?;
    }
    let ct = mod_import(py, "ctypes")?.into_any();
    m.add("ctypes", &ct)?;
    m.add(
        "_Rect",
        structure_class(
            py,
            &ct,
            "_Rect",
            &[
                ("left", FieldKind::Scalar("c_long")),
                ("top", FieldKind::Scalar("c_long")),
                ("right", FieldKind::Scalar("c_long")),
                ("bottom", FieldKind::Scalar("c_long")),
            ],
        )?,
    )?;
    m.add(
        "_GUID",
        structure_class(
            py,
            &ct,
            "_GUID",
            &[
                ("Data1", FieldKind::Scalar("c_ulong")),
                ("Data2", FieldKind::Scalar("c_ushort")),
                ("Data3", FieldKind::Scalar("c_ushort")),
                ("Data4", FieldKind::Array("c_ubyte", 8)),
            ],
        )?,
    )?;

    // the class docstrings python's `class` statement would have installed;
    // `#[pyclass]` leaves `__doc__` empty.
    m.getattr("UiaNode")?.setattr(
        "__doc__",
        "一个 UIA 元素的快照。坐标为物理像素（与截图一致）。",
    )?;
    m.getattr("CtypesUiaBackend")?.setattr(
        "__doc__",
        "真实现：ctypes 直调 IUIAutomation vtable（零依赖）。\n\n读树路径固定为 ElementFromHandle → ControlViewWalker 深度优先\n（GetFirstChildElement / GetNextSiblingElement）。ControlView 只保留\n对用户有意义的可交互控件，天然滤掉 RawView 里成百上千个无名字容器，\n这是节点预算能压在 MAX_NODES 以内的前提。\n\n结构上不存在环（孩子 + 兄弟的树遍历），防失控靠 MAX_DEPTH / MAX_NODES\n双硬顶，不靠运行时 id 去重。\n\n构造失败（无桌面会话 / COM 拒绝）抛 OSError：调用方 catch 后降级到\nOCR / 坐标路径，绝不静默假装可用。\n",
    )?;

    // pyo3 builds `tp_name` as `module.Name`, so CPython's own messages carry
    // the dotted name where a python-defined class reports the bare one.
    for cls in ["UiaNode", "CtypesUiaBackend", "UiaBackend"] {
        m.getattr(cls)?.setattr("__name__", cls)?;
    }

    *ST.lock() = Some(m.clone().unbind());
    parent.add_submodule(&m)?;
    Ok(())
}
