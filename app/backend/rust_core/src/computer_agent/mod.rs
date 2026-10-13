//! computer_agent — Rust port of `app/backend/computer_agent.py` (wave-6).
//!
//! The Computer specialist sub-agent: 12 tool definitions (shell/python/
//! process/system/env/disk/network/chain/search/CUA), the Linux-heredoc →
//! Windows-command preprocessor, and the tool-impl layer that redacts MAC
//! addresses and machine-specific paths out of every output.
//!
//! Port posture (artifact_index / native_desktop / mailbox precedent): every
//! value stays a live CPython object and flows through the object's own
//! methods; str()/int()/max()/min()/any()/
//! isinstance()/format() are the real builtins; arithmetic goes through the
//! real `operator` module; `1024**3` is CPython's constant-folded 1073741824;
//! is `format(value, spec)` + `"".join` in the source's order. Dependency
//! objects (Result, run_shell, sanitize_text, …) resolve at call time from
//! the live modules — or from `_set_seams` when the parity probe swaps them —
//! so exception types, messages and the recorded call log match the
//! canonical implementation by construction.
//!
//! `async def handle()` is ported as a genuine awaitable state machine
//! (`HandleAwaitable`): lazy body start on first send, transparent yield
//! delegation into `tools.dispatch`'s own `__await__` iterator, and try/
//! finally span accounting identical to the Python frame. The object passes
//! `isinstance(x, collections.abc.Coroutine)` (it exposes __await__/send/
//! throw), so asyncio Task machinery drives it exactly like the coroutine.
//!
//! DIVERGENCE(port, seams): python binds module globals at import time; Rust
//!     resolves the same names from the live modules at each call unless
//!     `_set_seams(...)` overrode them. Production never patches sys.modules
//!     attributes behind an import's back, so the observable state is the
//!     same; the parity probe patches both sides explicitly.
//! DIVERGENCE(port, handle): the returned awaitable is not a
//!     types.CoroutineType — `inspect.iscoroutine()`/`iscoroutinefunction`
//!     report False, an un-awaited instance emits no RuntimeWarning, and its
//!     repr carries the same "<coroutine object ComputerAgent.handle at 0x…>"
//!     shape with the awaitable's own address. No consumer in the tree awaits
//!     `ComputerAgent.handle` (grep-verified); the registry path dispatches
//!     ToolDefs directly.
//! DIVERGENCE(port, construction): `__init__` builds tool defs through the
//!     Rust core (ToolDef/registry/getcwd/etc. still seam-resolved), so a
//!     probe that patched `ComputerAgent._build_tool_defs`/`_register_tools`
//!     BEFORE construction would be honoured by Python but not by Rust;
//!     explicit later calls go through the class attributes on both sides.
//! DIVERGENCE(port, bound-call sugar): `_build_tool_defs`/`_register_tools`
//!     are class attributes holding plain functions on both sides; Rust's are
//!     builtin functions, which do not auto-bind — `agent._build_tool_defs()`
//!     with zero args works only on the Python original. `ComputerAgent.
//!     _build_tool_defs(anything_with_DOMAIN)` (the shape backend tests use)
//!     works identically on both sides.
// PORT STATUS: confidence=high todos=[0]

use parking_lot::Mutex;
use pyo3::exceptions::{
    PyGeneratorExit, PyImportError, PyStopIteration, PyTypeError, PyValueError,
};
use pyo3::types::{PyDict, PyList, PyString, PyTuple};
use pyo3::prelude::*;
use std::panic::UnwindSafe;

type B<'py> = Bound<'py, PyAny>;

// CPython constant-folds 1024**3 (used by the GB formatters).
const GIB: i64 = 1073741824;

// ── seam storage (probe-swappable dependency objects) ──────────────────────

static SEAMS: Mutex<Option<Py<PyDict>>> = Mutex::new(None);
static AGENT: Mutex<Option<PyObject>> = Mutex::new(None);
static IMPLS: Mutex<Vec<PyObject>> = Mutex::new(Vec::new());

/// Dependency table: name -> (module, attribute).
fn dep_spec(name: &str) -> (&str, &str) {
    match name {
        "run_shell" | "run_python" | "guarded_spawn" | "shell_word" | "BlockedCommandError" => {
            ("executors", name)
        }
        "sanitize_text" => ("sanitizer", "sanitize_text"),
        "Result" => ("result", "Result"),
        "try_result" => ("result", "try_result"),
        "get_event_bus" => ("event_bus", "get_event_bus"),
        "get_telemetry" | "SpanName" => ("telemetry", name),
        "platform_system" => ("platform", "system"),
        "ToolDef" | "get_tool_registry" => ("tools", name),
        _ => ("", ""),
    }
}

fn seam<'py>(py: Python<'py>, name: &str) -> Option<B<'py>> {
    let g = SEAMS.lock();
    let slot = match g.as_ref() {
        Some(p) => p,
        None => return None,
    };
    slot.bind(py)
        .get_item(name)
        .ok()
        .flatten()
        .filter(|v| !v.is_none())
}

fn dep_mod<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    if let Some(v) = seam(py, name) {
        return Ok(v);
    }
    Ok(py.import_bound(name)?.into_any())
}

fn dep<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    if let Some(v) = seam(py, name) {
        return Ok(v);
    }
    let (module, attr) = dep_spec(name);
    Ok(py.import_bound(module)?.getattr(attr)?)
}

// ── CPython-semantics helpers ──────────────────────────────────────────────

fn builtins(py: Python<'_>) -> PyResult<Bound<'_, PyModule>> {
    Ok(py.import_bound("builtins")?)
}

fn s<'py>(py: Python<'py>, v: &str) -> B<'py> {
    PyString::new_bound(py, v).into_any()
}

fn i<'py>(py: Python<'py>, v: i64) -> B<'py> {
    v.to_object(py).into_bound(py).into_any()
}

#[allow(dead_code)]
fn flt<'py>(py: Python<'py>, v: f64) -> B<'py> {
    v.to_object(py).into_bound(py).into_any()
}

fn bl<'py>(py: Python<'py>, v: bool) -> B<'py> {
    builtins(py)
        .expect("builtins")
        .getattr(if v { "True" } else { "False" })
        .expect("bool singleton")
        .into_any()
}

fn none<'py>(py: Python<'py>) -> B<'py> {
    py.None().into_bound(py).into_any()
}

/// `x or default` (returns the original object when truthy).
fn orv<'py>(v: &B<'py>, def: &B<'py>) -> PyResult<B<'py>> {
    Ok(if v.is_truthy()? { v.clone() } else { def.clone() })
}

/// real builtin call: int(x) / str(x) / any(x) / bool(x) …
fn bi1<'py>(py: Python<'py>, name: &str, x: &B<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr(name)?.call1((x,))?)
}

fn bi2<'py>(py: Python<'py>, name: &str, x: &B<'py>, y: &B<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr(name)?.call1((x, y))?)
}

/// real operator-module binary op: the exact protocol behind `a == b`,
/// `a / b`, … including reflected fallbacks.
fn op<'py>(py: Python<'py>, name: &str, a: &B<'py>, b: &B<'py>) -> PyResult<B<'py>> {
    Ok(py.import_bound("operator")?.getattr(name)?.call1((a, b))?)
}

/// `x == y` / `x != y` as Python evaluates them.
fn eq<'py>(py: Python<'py>, a: &B<'py>, b: &B<'py>) -> PyResult<bool> {
    op(py, "eq", a, b)?.is_truthy()
}

fn ne<'py>(py: Python<'py>, a: &B<'py>, b: &B<'py>) -> PyResult<bool> {
    op(py, "ne", a, b)?.is_truthy()
}

/// f-string interpolation: `format(x, spec)` — the exact call CPython
/// f-strings compile to.
fn fmtv<'py>(py: Python<'py>, x: &B<'py>, spec: &str) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("format")?.call1((x, s(py, spec)))?)
}

/// `"".join(parts)` — assembles f-strings from already-formatted pieces.
fn fjoin<'py>(py: Python<'py>, parts: Vec<B<'py>>) -> PyResult<B<'py>> {
    let list = PyList::new_bound(py, parts);
    Ok(s(py, "").call_method1("join", (&list,))?)
}

/// Python's `except Exception:` — BaseExceptions (KeyboardInterrupt,
/// SystemExit, GeneratorExit) are NOT swallowed and must propagate.
fn is_py_exc(e: &PyErr, py: Python<'_>) -> bool {
    e.is_instance_of::<pyo3::exceptions::PyException>(py)
}

fn kw_dict<'py>(py: Python<'py>, items: &[(&str, &B<'py>)]) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new_bound(py);
    for (k, v) in items {
        d.set_item(*k, v)?;
    }
    Ok(d)
}

/// `os.path.<attr>` chain through the (seam-resolved) os module.
fn path_attr<'py>(py: Python<'py>, attr: &str) -> PyResult<B<'py>> {
    let osmod = dep_mod(py, "os")?;
    Ok(osmod.getattr("path")?.getattr(attr)?)
}

fn stop_with<'py>(py: Python<'py>, value: &Py<PyAny>) -> PyErr {
    let ty = py.get_type_bound::<PyStopIteration>().into_any();
    match ty.call1((value.clone_ref(py),)) {
        Ok(inst) => PyErr::from_value_bound(inst),
        Err(e) => e,
    }
}

fn type_name_str<'py>(x: &B<'py>) -> PyResult<String> {
    Ok(x.get_type().name()?.to_string())
}

// dict / list literal builders with source-order insertion (?-propagating).
macro_rules! pdict {
    ($py:expr $(, $k:expr => $v:expr )* $(,)?) => {{
        let _d: Bound<'_, pyo3::types::PyDict> = PyDict::new_bound($py);
        $(_d.set_item($k, $v)?;)*
        _d.into_any()
    }};
}

macro_rules! plist {
    ($py:expr $(, $v:expr )* $(,)?) => {{
        let _items: Vec<Bound<'_, pyo3::PyAny>> = vec![$($v,)*];
        let _l: Bound<'_, pyo3::types::PyList> = PyList::new_bound($py, _items);
        _l.into_any()
    }};
}

fn path_get<'py>(py: Python<'py>, attr: &str, arg: &B<'py>) -> PyResult<B<'py>> {
    Ok(path_attr(py, attr)?.call1((arg,))?)
}

fn call0v<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    dep(py, name)?.call0()
}

fn env_getitem<'py>(py: Python<'py>, key: &B<'py>) -> PyResult<Option<B<'py>>> {
    let env = dep_mod(py, "os")?.getattr("environ")?;
    match env.get_item(key) {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.is_instance_of::<pyo3::exceptions::PyKeyError>(py) => Ok(None),
        Err(e) => Err(e),
    }
}

fn os_environ_set<'py>(py: Python<'py>, key: &B<'py>, val: &B<'py>) -> PyResult<()> {
    let env = dep_mod(py, "os")?.getattr("environ")?;
    env.set_item(key, val)
}

/// `str(x).strip()` — `str(args.get("action", "")).strip()`.
fn str_strip<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    Ok(bi1(py, "str", x)?.call_method0("strip")?)
}

/// `str(x)` via the real builtin.
fn bstr<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    bi1(py, "str", x)
}

/// `f"{a}={b}"`-style three-part assembly (env_get masked/plain branches).
fn kv_str<'py>(py: Python<'py>, a: &B<'py>, mid: &str, b: &B<'py>) -> PyResult<B<'py>> {
    fjoin(
        py,
        vec![fmtv(py, a, "")?, s(py, mid), fmtv(py, b, "")?],
    )
}

// ── redact ─────────────────────────────────────────────────────────────────

fn redact_core<'py>(py: Python<'py>, text: &B<'py>, ctx: &B<'py>) -> PyResult<B<'py>> {
    // sanitize_text(text, workspace_root=(ctx or {}).get("workspace_root"))
    let st = dep(py, "sanitize_text")?;
    let effective = orv(ctx, &PyDict::new_bound(py).into_any())?;
    let ws = effective.call_method1("get", ("workspace_root",))?;
    Ok(st.call((text,), Some(&kw_dict(py, &[("workspace_root", &ws)])?))?)
}

#[pyfunction]
fn _redact<'py>(py: Python<'py>, text: &B<'py>, ctx: &B<'py>) -> PyResult<PyObject> {
    Ok(redact_core(py, text, ctx)?.unbind())
}

// ── awaitable state machine (async def handle) ─────────────────────────────
//
//   async def handle(self, tool_name, args, context=None):
//       context = context or {}
//       context.setdefault("workspace_root", self.workspace)
//       span = self.telemetry.start_span(SpanName.TOOL_CALL,
//           tool_name=tool_name, agent_name="computer_agent")
//       try:
//           result = await self.tools.dispatch(tool_name, args, context)
//           if not result.ok:
//               span.set_error(result.error)
//           return result
//       finally:
//           self.telemetry.end_span(span)
//
// Body evaluation is deferred to the first send (coroutine semantics); every
// yield inside `tools.dispatch`'s own await iterator is forwarded verbatim
// and the driver's send values are forwarded straight back.

enum St {
    Not,
    It {
        it: PyObject,
        span: PyObject,
    },
    Done,
}

#[pyclass]
struct HandleAwaitable {
    agent: PyObject,
    tool_name: PyObject,
    args: PyObject,
    ctx_arg: PyObject,
    st: St,
}

impl UnwindSafe for HandleAwaitable {}

fn await_iter<'py>(_py: Python<'py>, coro: &B<'py>) -> PyResult<B<'py>> {
    if coro.hasattr("__await__")? {
        Ok(coro.call_method0("__await__")?)
    } else {
        Err(PyTypeError::new_err(format!(
            "'{}' object can't be used in 'await' expression",
            type_name_str(coro)?
        )))
    }
}

/// try-block head: `self.tools.dispatch(tool_name, args, context)` + `await`
/// (iterator fetch) + first send. Returns (iterator, outcome-of-send).
fn enter_try_and_step<'py>(
    py: Python<'py>,
    agent: &B<'py>,
    tool_name: &B<'py>,
    args: &B<'py>,
    ctx: &B<'py>,
    value: &B<'py>,
) -> PyResult<(B<'py>, StepOut<'py>)> {
    let tools = agent.getattr("tools")?;
    let dispatch = tools.getattr("dispatch")?;
    let coro = dispatch.call1((tool_name.clone(), args.clone(), ctx.clone()))?;
    let it = await_iter(py, &coro)?;
    let out = it
        .call_method1("send", (value,))
        .map(StepOut::Yielded)
        .or_else(|e| match stop_value(py, &e) {
            Some(v) => Ok(StepOut::Returned(v)),
            None => Err(e),
        })?;
    Ok((it, out))
}

enum StepOut<'py> {
    Yielded(B<'py>),
    Returned(B<'py>),
}

/// extract `.value` when the error is StopIteration.
fn stop_value<'py>(py: Python<'py>, e: &PyErr) -> Option<B<'py>> {
    if e.is_instance_of::<PyStopIteration>(py) {
        e.value_bound(py).getattr("value").ok()
    } else {
        None
    }
}

/// CPython's implicit `raise outer` while `inner` is being handled sets
/// `outer.__context__ = inner` (only when it is still None). PyErr_Restore
/// does not do this, so the attribute is attached directly — the observable
/// "During handling of the above exception..." repr is identical.
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

/// the try tail + finally: `if not result.ok: span.set_error(result.error)`
/// then ALWAYS `telemetry.end_span(span)`; a finally error replaces the
/// pending error with `__context__` chaining like CPython does.
fn finish_ok<'py>(
    py: Python<'py>,
    agent: &B<'py>,
    span: &B<'py>,
    result: &B<'py>,
) -> PyResult<B<'py>> {
    let pending: Option<PyErr> = (|| -> PyResult<()> {
        let ok = result.getattr("ok")?;
        if !ok.is_truthy()? {
            let err = result.getattr("error")?;
            span.call_method1("set_error", (&err,))?;
        }
        Ok(())
    })()
    .err();
    let end_res = agent
        .getattr("telemetry")?
        .call_method1("end_span", (span,))
        .map(|_| ());
    match (pending, end_res) {
        (None, Ok(())) => Ok(result.clone()),
        (Some(e1), Ok(())) => Err(e1),
        (None, Err(e2)) => Err(e2),
        (Some(e1), Err(e2)) => Err(raise_with_context(py, e2, e1)),
    }
}

/// the exception-propagates-through-the-try path: finally runs, its error
/// (if any) replaces with chaining, the original otherwise.
fn propagate<'py>(py: Python<'py>, agent: &B<'py>, span: &B<'py>, e: PyErr) -> PyErr {
    let end_res = agent
        .getattr("telemetry")
        .and_then(|t| t.call_method1("end_span", (span,)).map(|_| ()));
    match end_res {
        Ok(()) => e,
        Err(e2) => raise_with_context(py, e2, e),
    }
}

#[derive(Copy, Clone)]
enum Op {
    Send,
    Throw,
}

impl HandleAwaitable {
    fn drive<'py>(
        &mut self,
        py: Python<'py>,
        opk: Op,
        value: &B<'py>,
    ) -> PyResult<DriveOut> {
        // take the state out so nothing borrows self while we call Python
        let st = std::mem::replace(&mut self.st, St::Done);
        let agent = self.agent.bind(py).clone();
        match st {
            St::Done => match opk {
                // send on an exhausted coroutine → bare StopIteration
                Op::Send => Ok(DriveOut::Returned(none(py).unbind())),
                // throw on an exhausted coroutine re-raises the value
                Op::Throw => Err(PyErr::from_value_bound(value.clone())),
            },
            St::Not => {
                if matches!(opk, Op::Throw) {
                    // throw into a just-created coroutine raises before any
                    // body statement runs — no span exists, none is ended.
                    return Err(PyErr::from_value_bound(value.clone()));
                }
                if !value.is_none() {
                    return Err(PyTypeError::new_err(
                        "can't send non-None value to a just-started coroutine",
                    ));
                }
                // body lines 1–3 live OUTSIDE the try: their errors
                // propagate with no end_span and mark the frame dead.
                let setup: PyResult<(B<'py>, B<'py>, B<'py>)> = (|| -> PyResult<_> {
                    let ctx_arg = self.ctx_arg.bind(py).clone();
                    let ctx = orv(&ctx_arg, &PyDict::new_bound(py).into_any())?;
                    let workspace = agent.getattr("workspace")?;
                    ctx.call_method1("setdefault", ("workspace_root", &workspace))?;
                    let telemetry = agent.getattr("telemetry")?;
                    let span_name = dep(py, "SpanName")?.getattr("TOOL_CALL")?;
                    let tool_name = self.tool_name.bind(py).clone();
                    let args = self.args.bind(py).clone();
                    let kwd = kw_dict(
                        py,
                        &[
                            ("tool_name", &tool_name),
                            ("agent_name", &s(py, "computer_agent")),
                        ],
                    )?;
                    let span = telemetry.call_method("start_span", (&span_name,), Some(&kwd))?;
                    Ok((ctx, span, args))
                })();
                let (ctx, span, args) = match setup {
                    Ok(v) => v,
                    Err(e) => {
                        self.st = St::Done;
                        return Err(e);
                    }
                };
                let tool_name = self.tool_name.bind(py).clone();
                let entered =
                    enter_try_and_step(py, &agent, &tool_name, &args, &ctx, value);
                match entered {
                    Ok((it, StepOut::Yielded(y))) => {
                        self.st = St::It {
                            it: it.unbind(),
                            span: span.unbind(),
                        };
                        Ok(DriveOut::Yielded(y.unbind()))
                    }
                    Ok((_, StepOut::Returned(r))) => {
                        self.st = St::Done;
                        match finish_ok(py, &agent, &span, &r) {
                            Ok(res) => Ok(DriveOut::Returned(res.unbind())),
                            Err(e) => Err(e),
                        }
                    }
                    Err(e) => {
                        self.st = St::Done;
                        Err(propagate(py, &agent, &span, e))
                    }
                }
            }
            St::It { it, span } => {
                let it = it.into_bound(py);
                let span = span.into_bound(py);
                let step = match opk {
                    Op::Send => it.call_method1("send", (value,)),
                    Op::Throw => it.call_method1("throw", (value,)),
                };
                match step {
                    Ok(y) => {
                        self.st = St::It {
                            it: it.unbind(),
                            span: span.unbind(),
                        };
                        Ok(DriveOut::Yielded(y.unbind()))
                    }
                    Err(e) => {
                        match stop_value(py, &e) {
                            Some(r) => {
                                self.st = St::Done;
                                match finish_ok(py, &agent, &span, &r) {
                                    Ok(res) => Ok(DriveOut::Returned(res.unbind())),
                                    Err(e2) => Err(e2),
                                }
                            }
                            None => {
                                self.st = St::Done;
                                Err(propagate(py, &agent, &span, e))
                            }
                        }
                    }
                }
            }
        }
    }
}

enum DriveOut {
    Yielded(PyObject),
    Returned(PyObject),
}

#[pymethods]
impl HandleAwaitable {
    fn __iter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
        slf
    }

    fn __await__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
        slf
    }

    fn __next__<'py>(&mut self, py: Python<'py>) -> PyResult<PyObject> {
        let v = none(py);
        match self.drive(py, Op::Send, &v)? {
            DriveOut::Yielded(o) => Ok(o),
            DriveOut::Returned(o) => Err(stop_with(py, &o)),
        }
    }

    #[pyo3(signature = (value=None))]
    fn __send__<'py>(
        &mut self,
        py: Python<'py>,
        value: Option<Py<PyAny>>,
    ) -> PyResult<PyObject> {
        let v = value
            .map(|o| o.into_bound(py))
            .unwrap_or_else(|| none(py));
        match self.drive(py, Op::Send, &v)? {
            DriveOut::Yielded(o) => Ok(o),
            DriveOut::Returned(o) => Err(stop_with(py, &o)),
        }
    }

    #[pyo3(signature = (exc, value=None, _tb=None))]
    fn __throw__<'py>(
        &mut self,
        py: Python<'py>,
        exc: Py<PyAny>,
        value: Option<Py<PyAny>>,
        _tb: Option<Py<PyAny>>,
    ) -> PyResult<PyObject> {
        let e = exc.into_bound(py);
        // coroutine.throw(type[, value[, tb]]): a type is instantiated first.
        let e = if e.is_instance(&py.get_type_bound::<pyo3::types::PyType>())? {
            match value {
                Some(v) => e.call1((v.into_bound(py),))?,
                None => e.call0()?,
            }
        } else {
            e
        };
        match self.drive(py, Op::Throw, &e)? {
            DriveOut::Yielded(o) => Ok(o),
            DriveOut::Returned(o) => Err(stop_with(py, &o)),
        }
    }

    // Coroutine objects expose send/throw/close as plain attributes — the
    // yield-from machinery and asyncio both look these names up.
    #[pyo3(signature = (value=None))]
    fn send<'py>(
        &mut self,
        py: Python<'py>,
        value: Option<Py<PyAny>>,
    ) -> PyResult<PyObject> {
        self.__send__(py, value)
    }

    #[pyo3(signature = (exc, value=None, tb=None))]
    fn throw<'py>(
        &mut self,
        py: Python<'py>,
        exc: Py<PyAny>,
        value: Option<Py<PyAny>>,
        tb: Option<Py<PyAny>>,
    ) -> PyResult<PyObject> {
        self.__throw__(py, exc, value, tb)
    }

    fn close(&mut self, py: Python<'_>) -> PyResult<Option<PyObject>> {
        let st = std::mem::replace(&mut self.st, St::Done);
        let (it, span) = match st {
            St::It { it, span } => (it, span),
            _ => return Ok(None),
        };
        let it = it.into_bound(py);
        let span_b = span.bind(py).clone();
        let agent = self.agent.bind(py).clone();
        let ge = py
            .get_type_bound::<PyGeneratorExit>()
            .into_any()
            .call0()?;
        match it.call_method1("throw", (&ge,)) {
            Ok(_) => {
                // body ignored GeneratorExit and yielded — CPython:
                // RuntimeError: coroutine ignored GeneratorExit (finally runs)
                let err = runtime_err_ignored();
                Err(propagate(py, &agent, &span_b, err))
            }
            Err(e) => {
                if e.is_instance_of::<PyStopIteration>(py)
                    || e.is_instance_of::<PyGeneratorExit>(py)
                {
                    // closed cleanly: the finally still runs
                    let end = agent
                        .getattr("telemetry")
                        .and_then(|t| t.call_method1("end_span", (&span_b,)));
                    match end {
                        Ok(_) => Ok(None),
                        Err(e2) => Err(e2),
                    }
                } else {
                    Err(propagate(py, &agent, &span_b, e))
                }
            }
        }
    }

    fn __repr__(slf: PyRef<'_, Self>) -> String {
        format!(
            "<coroutine object ComputerAgent.handle at {:#x}>",
            slf.as_ptr() as usize
        )
    }
}

fn runtime_err_ignored() -> PyErr {
    pyo3::exceptions::PyRuntimeError::new_err("coroutine ignored GeneratorExit")
}

// ── ComputerAgent ──────────────────────────────────────────────────────────

// `dict` is unavailable under abi3-py38 (pyclass __dict__ needs >= 3.9); the
// four exposed attributes carry everything the port (and its callers) touches.
#[pyclass(module = "computer_agent")]
struct ComputerAgent {
    #[pyo3(get, set)]
    workspace: PyObject,
    #[pyo3(get, set)]
    bus: PyObject,
    #[pyo3(get, set)]
    telemetry: PyObject,
    #[pyo3(get, set)]
    tools: PyObject,
}

impl UnwindSafe for ComputerAgent {}

#[pymethods]
impl ComputerAgent {
    #[classattr]
    #[allow(non_snake_case)]
    fn DOMAIN() -> &'static str {
        "computer"
    }

    #[new]
    #[pyo3(signature = (workspace=None))]
    fn py_new(py: Python<'_>, workspace: Option<Py<PyAny>>) -> PyResult<Self> {
        // self.workspace = workspace or os.getcwd()  (or-chain short-circuits:
        // getcwd is only touched when workspace is falsy/absent)
        let ws = match &workspace {
            Some(o) => {
                let ob = o.bind(py).clone();
                if ob.is_truthy()? {
                    ob
                } else {
                    dep_mod(py, "os")?.call_method0("getcwd")?
                }
            }
            None => dep_mod(py, "os")?.call_method0("getcwd")?,
        };
        let bus = dep(py, "get_event_bus")?.call0()?;
        let telemetry = dep(py, "get_telemetry")?.call0()?;
        let tools = dep(py, "get_tool_registry")?.call0()?;
        // _register_tools(): for td in self._build_tool_defs():
        //     self.tools.register(td)
        let domain = py
            .get_type_bound::<ComputerAgent>()
            .getattr("DOMAIN")?;
        let tds = build_defs_core(py, &domain)?;
        for td in tds.iter() {
            tools.call_method1("register", (&td,))?;
        }
        Ok(Self {
            workspace: ws.unbind(),
            bus: bus.unbind(),
            telemetry: telemetry.unbind(),
            tools: tools.unbind(),
        })
    }

    #[pyo3(signature = (tool_name, args, context=None))]
    fn handle<'py>(
        slf: PyRef<'py, Self>,
        tool_name: Py<PyAny>,
        args: Py<PyAny>,
        context: Option<Py<PyAny>>,
    ) -> PyResult<HandleAwaitable> {
        let py = slf.py();
        Ok(HandleAwaitable {
            agent: slf.into_py(py).into_any(),
            tool_name,
            args,
            ctx_arg: context.unwrap_or_else(|| py.None()),
            st: St::Not,
        })
    }
}

// ── callable seams: re.sub replacers, line_filter lambda, try_result thunk ─

/// `open(path, "w", encoding="utf-8")` used as a context manager and fed
/// `content`. Returns the underlying error untouched; the caller's
/// `except Exception:` decides whether it is swallowed.
///
/// DIVERGENCE(port, tb): the __exit__ traceback argument is passed as None
///     (pyo3 0.22's PyErr exposes no traceback handle); file-object
///     __exit__ implementations ignore it.
fn open_write<'py>(py: Python<'py>, path: &B<'py>, content: &B<'py>) -> PyResult<()> {
    let kw = kw_dict(
        py,
        &[("mode", &s(py, "w")), ("encoding", &s(py, "utf-8"))],
    )?;
    let f = builtins(py)?.getattr("open")?.call((path,), Some(&kw))?;
    match f.call_method0("__enter__") {
        // with: an __enter__ error means the body never ran → no __exit__
        Err(e) => Err(e),
        Ok(handle) => {
            let body = handle.call_method1("write", (content,)).map(|_| ());
            match body {
                Ok(()) => f.call_method1("__exit__", (none(py), none(py), none(py)))
                    .map(|_| ()),
                Err(e) => {
                    let v = e.value_bound(py);
                    let ty = v.get_type();
                    let _ = f.call_method1("__exit__", (ty, v, none(py)));
                    Err(e)
                }
            }
        }
    }
}

/// The `_replace_cat` / `_replace_py` closures of _preprocess_shell_command,
/// discriminated by `mode` (0 = cat, 1 = python).
#[pyclass]
struct Repl {
    mode: i64,
    work_dir: PyObject,
    created_files: PyObject,
}

impl UnwindSafe for Repl {}

fn grp<'py>(m: &B<'py>, n: usize) -> PyResult<B<'py>> {
    m.get_item(n)
}

fn cat_repl<'py>(py: Python<'py>, m: &B<'py>, work_dir: &B<'py>) -> PyResult<B<'py>> {
    let _tag = grp(m, 1)?; // assigned and unused in the source; call kept
    let filename = grp(m, 2)?
        .call_method0("strip")?
        .call_method1("strip", (s(py, "'\""),))?;
    let content = grp(m, 3)?;
    let isabs = path_get(py, "isabs", &filename)?.is_truthy()?;
    let target_path = if !isabs {
        path_attr(py, "join")?.call1((work_dir, &filename))?
    } else {
        filename.clone()
    };
    let dirname = path_get(py, "dirname", &path_get(py, "abspath", &target_path)?)?;
    dep_mod(py, "os")?.call_method(
        "makedirs",
        (&dirname,),
        Some(&kw_dict(py, &[("exist_ok", &bl(py, true))])?),
    )?;
    open_write(py, &target_path, &content)?;
    fjoin(
        py,
        vec![s(py, "echo [created "), fmtv(py, &filename, "")?, s(py, "]")],
    )
}

fn py_repl<'py>(
    py: Python<'py>,
    m: &B<'py>,
    work_dir: &B<'py>,
    created_files: &B<'py>,
) -> PyResult<B<'py>> {
    let _tag = grp(m, 1)?; // unused in the source; call kept
    let content = grp(m, 2)?;
    let uuid_mod = dep_mod(py, "uuid")?;
    let sl = builtins(py)?.getattr("slice")?.call1((i(py, 0), i(py, 8)))?;
    let tmp_id = uuid_mod
        .call_method0("uuid4")?
        .getattr("hex")?
        .get_item(sl)?;
    let tmp_filename = fjoin(
        py,
        vec![s(py, "_run_tmp_"), fmtv(py, &tmp_id, "")?, s(py, ".py")],
    )?;
    let target_path = path_attr(py, "join")?.call1((work_dir, &tmp_filename))?;
    open_write(py, &target_path, &content)?;
    created_files.call_method1("append", (&target_path,))?;
    fjoin(
        py,
        vec![
            s(py, "python \""),
            fmtv(py, &target_path, "")?,
            s(py, "\""),
        ],
    )
}

#[pymethods]
impl Repl {
    fn __call__<'py>(&self, py: Python<'py>, m: B<'py>) -> PyResult<PyObject> {
        let work_dir = self.work_dir.bind(py).clone();
        let r = if self.mode == 0 {
            cat_repl(py, &m, &work_dir)
        } else {
            let files = self.created_files.bind(py).clone();
            py_repl(py, &m, &work_dir, &files)
        };
        match r {
            Ok(v) => Ok(v.unbind()),
            // `except Exception: return match.group(0)` — BaseExceptions
            // propagate out of the sub() call.
            Err(e) if is_py_exc(&e, py) => Ok(grp(&m, 0)?.unbind()),
            Err(e) => Err(e),
        }
    }
}

/// `line_filter=lambda s: _redact(s, ctx)`.
#[pyclass]
struct LineFilter {
    ctx: PyObject,
}

impl UnwindSafe for LineFilter {}

#[pymethods]
impl LineFilter {
    fn __call__<'py>(&self, py: Python<'py>, text: B<'py>) -> PyResult<PyObject> {
        let ctx = self.ctx.bind(py).clone();
        Ok(redact_core(py, &text, &ctx)?.unbind())
    }
}

/// The `try_result(lambda: ...)` thunks, discriminated by `mode`:
/// 0 = `guarded_spawn(cmd, timeout=T).stdout`, 1 = `guarded_spawn(cmd,
/// timeout=T)`, 2 = `shutil.disk_usage(args.get("path","."))`.
#[pyclass]
struct Thunk {
    mode: i64,
    cmd: PyObject,
    timeout: PyObject,
    args: PyObject,
}

impl UnwindSafe for Thunk {}

#[pymethods]
impl Thunk {
    fn __call__<'py>(&self, py: Python<'py>) -> PyResult<PyObject> {
        let v = match self.mode {
            0 => {
                let cmd = self.cmd.bind(py).clone();
                let t = self.timeout.bind(py).clone();
                dep(py, "guarded_spawn")?
                    .call((cmd,), Some(&kw_dict(py, &[("timeout", &t)])?))?
                    .getattr("stdout")?
            }
            1 => {
                let cmd = self.cmd.bind(py).clone();
                let t = self.timeout.bind(py).clone();
                dep(py, "guarded_spawn")?.call((cmd,), Some(&kw_dict(py, &[("timeout", &t)])?))?
            }
            _ => {
                let args = self.args.bind(py).clone();
                let p = args.call_method1("get", (s(py, "path"), &s(py, ".")))?;
                dep_mod(py, "shutil")?.call_method1("disk_usage", (&p,))?
            }
        };
        Ok(v.unbind())
    }
}

// ── _preprocess_shell_command ──────────────────────────────────────────────

fn preprocess_core<'py>(
    py: Python<'py>,
    command: &B<'py>,
    cwd: &B<'py>,
) -> PyResult<(B<'py>, Bound<'py, PyList>)> {
    let created_files = PyList::empty_bound(py);
    let work_dir = if cwd.is_truthy()? {
        cwd.clone()
    } else {
        dep_mod(py, "os")?.call_method0("getcwd")?
    };
    let re_mod = dep_mod(py, "re")?;
    let osmod = dep_mod(py, "os")?;
    let onnt = eq(py, &osmod.getattr("name")?, &s(py, "nt"))?;
    let mut cmd = command.clone();
    if onnt {
        cmd = re_mod.call_method1(
            "sub",
            (s(py, r"\bpython3\b"), s(py, "python"), cmd),
        )?;
    }
    let flags = kw_dict(py, &[("flags", &re_mod.getattr("DOTALL")?)])?;

    let cat_pat = re_mod.call_method(
        "compile",
        (s(
            py,
            r#"cat\s+<<\s*['\"]?(\w+)['\"]?\s*>\s*([^\n\r]+)\r?\n(.*?)\r?\n\1"#,
        ),),
        Some(&flags),
    )?;
    let repl_cat = Py::new(
        py,
        Repl {
            mode: 0,
            work_dir: work_dir.clone().unbind(),
            created_files: created_files.clone().into_any().unbind(),
        },
    )?;
    cmd = cat_pat.call_method1("sub", (&repl_cat, cmd))?;

    let py_pat = re_mod.call_method(
        "compile",
        (s(
            py,
            r#"(?:python|python3)\s*(?:-)?\s*<<\s*['\"]?(\w+)['\"]?\r?\n(.*?)\r?\n\1"#,
        ),),
        Some(&flags),
    )?;
    let repl_py = Py::new(
        py,
        Repl {
            mode: 1,
            work_dir: work_dir.unbind(),
            created_files: created_files.clone().into_any().unbind(),
        },
    )?;
    cmd = py_pat.call_method1("sub", (&repl_py, cmd))?;
    Ok((cmd, created_files))
}

#[pyfunction]
#[pyo3(signature = (command, cwd=None))]
fn _preprocess_shell_command<'py>(
    py: Python<'py>,
    command: &B<'py>,
    cwd: Option<&B<'py>>,
) -> PyResult<PyObject> {
    let cwd_v = cwd
        .map(|v| v.clone())
        .unwrap_or_else(|| none(py));
    let (c, files) = preprocess_core(py, command, &cwd_v)?;
    Ok(PyTuple::new_bound(py, vec![c, files.into_any()]).into_any().unbind())
}

// ── shared impl helpers ────────────────────────────────────────────────────

fn res_new<'py>(py: Python<'py>, meth: &str, args: &[B<'py>]) -> PyResult<B<'py>> {
    let r = dep(py, "Result")?;
    let tuple = PyTuple::new_bound(py, args.iter().map(|a| a.clone()));
    Ok(r.call_method(meth, &tuple, None)?)
}

fn f_int<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    fmtv(py, x, ".1f")
}

/// `int(x)` guarded by the source's `except (TypeError, ValueError)`.
fn int_checked<'py>(
    py: Python<'py>,
    x: &B<'py>,
    err: &str,
) -> PyResult<Result<B<'py>, B<'py>>> {
    match bi1(py, "int", x) {
        Ok(v) => Ok(Ok(v)),
        Err(e) => {
            let te = py.get_type_bound::<PyTypeError>();
            let ve = py.get_type_bound::<PyValueError>();
            if e.is_instance_bound(py, &te) || e.is_instance_bound(py, &ve) {
                Ok(Err(s(py, err)))
            } else {
                Err(e)
            }
        }
    }
}

/// `str(ctx.get("call_id", "") or "")`.
fn call_id_of<'py>(py: Python<'py>, ctx: &B<'py>) -> PyResult<B<'py>> {
    let raw = ctx.call_method1("get", (s(py, "call_id"), &s(py, "")))?;
    let eff = orv(&raw, &s(py, ""))?;
    bstr(py, &eff)
}

fn run_shell_kw<'py>(
    py: Python<'py>,
    command: &B<'py>,
    timeout: &B<'py>,
    cwd: &B<'py>,
    confirm: &B<'py>,
    call_id: &B<'py>,
    line_filter: &B<'py>,
    workspace_root: &B<'py>,
    sandbox_mode: &B<'py>,
) -> PyResult<B<'py>> {
    let kw = kw_dict(
        py,
        &[
            ("timeout", timeout),
            ("cwd", cwd),
            ("confirm", confirm),
            ("call_id", call_id),
            ("line_filter", line_filter),
            ("workspace_root", workspace_root),
            ("sandbox_mode", sandbox_mode),
        ],
    )?;
    Ok(dep(py, "run_shell")?.call((command,), Some(&kw))?)
}

/// the lambda-args block of _shell_impl / _chain_impl run_shell calls, with
/// the per-call str(...) and ctx.get(...) evaluation order of the source.
fn run_shell_with_filter<'py>(
    py: Python<'py>,
    command: &B<'py>,
    timeout: &B<'py>,
    cwd: &B<'py>,
    confirm: &B<'py>,
    ctx: &B<'py>,
) -> PyResult<B<'py>> {
    let call_id = call_id_of(py, ctx)?;
    let lf = Py::new(
        py,
        LineFilter {
            ctx: ctx.clone().unbind(),
        },
    )?
    .into_bound(py)
    .into_any();
    let ws = ctx.call_method1("get", (s(py, "workspace_root"),))?;
    let sm_raw = ctx.call_method1("get", (s(py, "sandbox_mode"),))?;
    let sm = orv(&sm_raw, &s(py, "workspace-write"))?;
    run_shell_kw(
        py, command, timeout, cwd, confirm, &call_id, &lf, &ws, &sm,
    )
}

/// `Result.success(x, **(r.meta or {}))` — with CPython's
/// `argument after ** must be a mapping` behaviour for non-mappings.
///
/// DIVERGENCE(port, ** unpack): a custom *mapping* meta is unpacked via
///     keys()/__getitem__ like CPython's CALL_FUNCTION_EX; any other
///     non-dict raises the same TypeError the interpreter raises.
fn success_meta<'py>(py: Python<'py>, x: &B<'py>, meta: &B<'py>) -> PyResult<B<'py>> {
    let f = dep(py, "Result")?.getattr("success")?;
    let meta_eff = orv(meta, &PyDict::new_bound(py).into_any())?;
    let kwargs: Bound<'py, PyDict> = match meta_eff.downcast::<PyDict>() {
        Ok(d) => d.clone(),
        Err(_) => {
            if meta_eff.hasattr("keys")? {
                let d = PyDict::new_bound(py);
                for k in meta_eff.call_method0("keys")?.iter()? {
                    let k = k?;
                    d.set_item(k.clone(), meta_eff.get_item(&k)?)?;
                }
                d
            } else {
                // CPython 3.13 prefixes this TypeError with the call target;
                // emulate it from the function's own __module__/__qualname__.
                let prefix = match (f.getattr("__module__"), f.getattr("__qualname__")) {
                    (Ok(m), Ok(q)) => {
                        let ms: String = fmtv(py, &m, "")?.extract()?;
                        let qs: String = fmtv(py, &q, "")?.extract()?;
                        format!("{}.{}() ", ms, qs)
                    }
                    _ => String::new(),
                };
                return Err(PyTypeError::new_err(format!(
                    "{}argument after ** must be a mapping, not {}",
                    prefix,
                    type_name_str(&meta_eff)?
                )));
            }
        }
    };
    Ok(f.call((x,), Some(&kwargs))?)
}

/// `ctx.get("confirmed", False) or ctx.get("permission") == "full"
///  or ctx.get("benchmark", False)` — with Python `or` value semantics.
fn confirm_chain<'py>(py: Python<'py>, ctx: &B<'py>) -> PyResult<B<'py>> {
    let fals = bl(py, false);
    let t1 = ctx.call_method1("get", (s(py, "confirmed"), &fals))?;
    if t1.is_truthy()? {
        return Ok(t1);
    }
    let perm = ctx.call_method1("get", (s(py, "permission"),))?;
    let is_full = op(py, "eq", &perm, &s(py, "full"))?;
    if is_full.is_truthy()? {
        return Ok(is_full);
    }
    ctx.call_method1("get", (s(py, "benchmark"), &fals))
}

/// try/finally merge: a BaseException escaping the finally loop replaces a
/// pending return, and replaces (with __context__ chaining) a pending error.
fn combine<'py>(
    py: Python<'py>,
    body: PyResult<B<'py>>,
    cleanup: Result<(), PyErr>,
) -> PyResult<B<'py>> {
    match (body, cleanup) {
        (Ok(v), Ok(())) => Ok(v),
        (Err(e), Ok(())) => Err(e),
        (Ok(_), Err(e)) => Err(e),
        (Err(e1), Err(e2)) => Err(raise_with_context(py, e2, e1)),
    }
}

fn try_spawn<'py>(py: Python<'py>, mode: i64, cmd: B<'py>, timeout: i64, args: &B<'py>) -> PyResult<B<'py>> {
    let th = Py::new(
        py,
        Thunk {
            mode,
            cmd: cmd.unbind(),
            timeout: i(py, timeout).unbind(),
            args: args.clone().unbind(),
        },
    )?;
    dep(py, "try_result")?.call1((th,))
}

// ── the 12 tool impls (thin wrappers around the shared call path) ─────────

#[pyfunction]
fn _shell_impl<'py>(py: Python<'py>, args: &B<'py>, ctx: &B<'py>) -> PyResult<PyObject> {
    let r = shell_core(py, args, ctx)?;
    Ok(r.unbind())
}

fn shell_core<'py>(py: Python<'py>, args: &B<'py>, ctx: &B<'py>) -> PyResult<B<'py>> {
    let raw_cmd = args.call_method1("get", (s(py, "command"), &s(py, "")))?;
    let ws = ctx.call_method1("get", (s(py, "workspace_root"),))?;
    let cwd = args.call_method1("get", (s(py, "cwd"), &ws))?;
    let (command, tmp_files) = preprocess_core(py, &raw_cmd, &cwd)?;
    let confirm = confirm_chain(py, ctx)?;
    let timeout = args.call_method1("get", (s(py, "timeout"), &i(py, 30)))?;
    let body: PyResult<B<'py>> = (|| -> PyResult<B<'py>> {
        let r = run_shell_with_filter(py, &command, &timeout, &cwd, &confirm, ctx)?;
        if !r.getattr("ok")?.is_truthy()? {
            return Ok(r);
        }
        let value = r.getattr("value")?;
        let str_type = builtins(py)?.getattr("str")?;
        if bi2(py, "isinstance", &value, &str_type)?.is_truthy()? {
            let red = redact_core(py, &value, ctx)?;
            let meta = r.getattr("meta")?;
            success_meta(py, &red, &meta)
        } else {
            Ok(r)
        }
    })();
    // finally: for f in tmp_files: try: exists→unlink; except Exception: pass
    let mut cleanup: Result<(), PyErr> = Ok(());
    for f in tmp_files.iter() {
        let res = (|| -> PyResult<()> {
            if path_get(py, "exists", &f)?.is_truthy()? {
                // source: `os.unlink(f)` (module-level, NOT os.path.unlink)
                dep_mod(py, "os")?.call_method1("unlink", (&f,))?;
            }
            Ok(())
        })();
        match res {
            Ok(()) => continue,
            Err(e) => {
                if !is_py_exc(&e, py) {
                    cleanup = Err(e);
                    break;
                }
                continue;
            }
        }
    }
    combine(py, body, cleanup)
}

#[pyfunction]
fn _python_impl<'py>(py: Python<'py>, args: &B<'py>, ctx: &B<'py>) -> PyResult<PyObject> {
    let code = args.call_method1("get", (s(py, "code"), &s(py, "")))?;
    let mode = args.call_method1("get", (s(py, "mode"), &s(py, "sandbox")))?;
    let timeout = args.call_method1("get", (s(py, "timeout"), &i(py, 30)))?;
    let confirm = confirm_chain(py, ctx)?;
    let kw = kw_dict(
        py,
        &[("mode", &mode), ("timeout", &timeout), ("confirm", &confirm)],
    )?;
    Ok(dep(py, "run_python")?
        .call((code,), Some(&kw))?
        .unbind())
}

#[pyfunction]
fn _proc_list_impl<'py>(py: Python<'py>, args: &B<'py>, _ctx: &B<'py>) -> PyResult<PyObject> {
    // 数字参数强制转型再拼串：模型给的 limit 可能是 "20; shutdown /s"。
    let raw = args.call_method1("get", (s(py, "limit"), &i(py, 20)))?;
    let limit: B<'py> = match bi1(py, "int", &raw)
        .and_then(|x| bi2(py, "min", &i(py, 200), &x))
        .and_then(|m| bi2(py, "max", &i(py, 1), &m))
    {
        Ok(v) => v,
        Err(e) => {
            let te = py.get_type_bound::<PyTypeError>();
            let ve = py.get_type_bound::<PyValueError>();
            if e.is_instance_bound(py, &te) || e.is_instance_bound(py, &ve) {
                return Ok(res_new(py, "failure", &[s(py, "limit 必须是数字")])?.unbind());
            }
            return Err(e);
        }
    };
    let win = eq(py, &call0v(py, "platform_system")?, &s(py, "Windows"))?;
    let cmd = if win {
        fjoin(
            py,
            vec![
                s(
                    py,
                    "powershell \"Get-Process | Sort-Object CPU -Descending | Select-Object -First ",
                ),
                fmtv(py, &limit, "")?,
                s(py, " Id,ProcessName,CPU | Format-Table -AutoSize\""),
            ],
        )?
    } else {
        let nxt = op(py, "add", &limit, &i(py, 1))?;
        fjoin(
            py,
            vec![s(py, "ps aux --sort=-%cpu | head -"), fmtv(py, &nxt, "")?],
        )?
    };
    let r = try_spawn(py, 0, cmd, 10, args)?;
    let ok = r.getattr("ok")?;
    let out = if ok.is_truthy()? {
        let v = r.getattr("value")?.call_method0("strip")?;
        res_new(py, "success", &[v])?
    } else {
        let e = r.getattr("error")?;
        res_new(
            py,
            "failure",
            &[fjoin(py, vec![s(py, "Failed: "), fmtv(py, &e, "")?])?],
        )?
    };
    Ok(out.unbind())
}

#[pyfunction]
fn _proc_kill_impl<'py>(py: Python<'py>, args: &B<'py>, ctx: &B<'py>) -> PyResult<PyObject> {
    let raw = args.call_method1("get", (s(py, "pid"), &i(py, 0)))?;
    let pid = match int_checked(py, &raw, "Invalid PID")? {
        Ok(p) => p,
        Err(msg) => return Ok(res_new(py, "failure", &[msg])?.unbind()),
    };
    if op(py, "le", &pid, &i(py, 0))?.is_truthy()? {
        return Ok(res_new(py, "failure", &[s(py, "Invalid PID")])?.unbind());
    }
    // Safety: list first, then kill (never wildcard)
    if !ctx
        .call_method1("get", (s(py, "confirmed"), &bl(py, false)))?
        .is_truthy()?
    {
        return Ok(res_new(
            py,
            "failure",
            &[s(
                py,
                "Process kill requires confirmation — list first, then confirm with PID",
            )],
        )?
        .unbind());
    }
    let cmd = if eq(py, &call0v(py, "platform_system")?, &s(py, "Windows"))? {
        fjoin(
            py,
            vec![s(py, "taskkill /PID "), fmtv(py, &pid, "")?, s(py, " /F")],
        )?
    } else {
        fjoin(py, vec![s(py, "kill -9 "), fmtv(py, &pid, "")?])?
    };
    let r = try_spawn(py, 1, cmd, 5, args)?;
    let ok = r.getattr("ok")?;
    let out = if ok.is_truthy()? {
        res_new(
            py,
            "success",
            &[fjoin(
                py,
                vec![
                    s(py, "Process "),
                    fmtv(py, &pid, "")?,
                    s(py, " terminated."),
                ],
            )?],
        )?
    } else {
        let e = r.getattr("error")?;
        res_new(
            py,
            "failure",
            &[fjoin(py, vec![s(py, "Kill failed: "), fmtv(py, &e, "")?])?],
        )?
    };
    Ok(out.unbind())
}

#[pyfunction]
fn _sysinfo_impl<'py>(py: Python<'py>, _args: &B<'py>, _ctx: &B<'py>) -> PyResult<PyObject> {
    let platform = dep_mod(py, "platform")?;
    let info = PyDict::new_bound(py);
    info.set_item("platform", platform.call_method0("system")?)?;
    info.set_item("release", platform.call_method0("release")?)?;
    info.set_item("machine", platform.call_method0("machine")?)?;
    info.set_item("processor", platform.call_method0("processor")?)?;
    info.set_item("python", platform.call_method0("python_version")?)?;
    info.set_item("hostname", platform.call_method0("node")?)?;
    // try: import psutil ... except ImportError: pass — fail-open 可选增强。
    let aug: PyResult<()> = (|| -> PyResult<()> {
        let psutil = dep_mod(py, "psutil")?;
        let mem = psutil.call_method0("virtual_memory")?;
        let total = op(py, "truediv", &mem.getattr("total")?, &i(py, GIB))?;
        info.set_item(
            "memory_total",
            fjoin(py, vec![f_int(py, &total)?, s(py, " GB")])?,
        )?;
        let avail = op(py, "truediv", &mem.getattr("available")?, &i(py, GIB))?;
        info.set_item(
            "memory_available",
            fjoin(py, vec![f_int(py, &avail)?, s(py, " GB")])?,
        )?;
        let cpu = psutil.call_method(
            "cpu_percent",
            (),
            Some(&kw_dict(py, &[("interval", &flt(py, 0.5))])?),
        )?;
        info.set_item(
            "cpu_percent",
            fjoin(py, vec![fmtv(py, &cpu, "")?, s(py, "%")])?,
        )?;
        Ok(())
    })();
    if let Err(e) = aug {
        if !e.is_instance_of::<PyImportError>(py) {
            return Err(e);
        }
    }
    Ok(res_new(py, "success", &[info.into_any()])?.unbind())
}

#[pyfunction]
fn _envget_impl<'py>(py: Python<'py>, args: &B<'py>, _ctx: &B<'py>) -> PyResult<PyObject> {
    let name = args.call_method1("get", (s(py, "name"), &s(py, "")))?;
    let val = env_getitem(py, &name)?;
    let val = match val {
        None => {
            return Ok(res_new(
                py,
                "failure",
                &[fjoin(py, vec![s(py, "Not set: "), fmtv(py, &name, "")?])?],
            )?
            .unbind())
        }
        Some(v) => v,
    };
    // any(s in name.upper() for s in (...)) — per-item upper(), short circuit.
    let mut masked = false;
    for marker in ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "API"] {
        let up = name.call_method0("upper")?;
        if op(py, "contains", &up, &s(py, marker))?.is_truthy()? {
            masked = true;
            break;
        }
    }
    let out = if masked {
        res_new(
            py,
            "success",
            &[fjoin(
                py,
                vec![fmtv(py, &name, "")?, s(py, "=***[masked]")],
            )?],
        )?
    } else {
        res_new(py, "success", &[kv_str(py, &name, "=", &val)?])?
    };
    Ok(out.unbind())
}

#[pyfunction]
fn _envset_impl<'py>(py: Python<'py>, args: &B<'py>, _ctx: &B<'py>) -> PyResult<PyObject> {
    let name = args.call_method1("get", (s(py, "name"), &s(py, "")))?;
    let value = args.call_method1("get", (s(py, "value"), &s(py, "")))?;
    os_environ_set(py, &name, &value)?;
    Ok(res_new(
        py,
        "success",
        &[s(py, "Set for current session.")],
    )?
    .unbind())
}

#[pyfunction]
fn _disk_impl<'py>(py: Python<'py>, args: &B<'py>, _ctx: &B<'py>) -> PyResult<PyObject> {
    let r = try_spawn(py, 2, none(py), 0, args)?;
    if !r.getattr("ok")?.is_truthy()? {
        let e = r.getattr("error")?;
        return Ok(res_new(
            py,
            "failure",
            &[fjoin(py, vec![s(py, "Failed: "), fmtv(py, &e, "")?])?],
        )?
        .unbind());
    }
    let du = r.getattr("value")?;
    let total = op(py, "truediv", &du.getattr("total")?, &i(py, GIB))?;
    let used = op(py, "truediv", &du.getattr("used")?, &i(py, GIB))?;
    let free = op(py, "truediv", &du.getattr("free")?, &i(py, GIB))?;
    let pct = op(
        py,
        "mul",
        &op(
            py,
            "truediv",
            &du.getattr("used")?,
            &du.getattr("total")?,
        )?,
        &i(py, 100),
    )?;
    let d = pdict!(
        py,
        "total" => fjoin(py, vec![f_int(py, &total)?, s(py, " GB")])?,
        "used" => fjoin(py, vec![f_int(py, &used)?, s(py, " GB")])?,
        "free" => fjoin(py, vec![f_int(py, &free)?, s(py, " GB")])?,
        "percent" => fjoin(py, vec![f_int(py, &pct)?, s(py, "%")])?,
    );
    Ok(res_new(py, "success", &[d])?.unbind())
}

#[pyfunction]
fn _netif_impl<'py>(py: Python<'py>, _args: &B<'py>, _ctx: &B<'py>) -> PyResult<PyObject> {
    // MAC addresses never surface (pattern 02 §6).
    let r: PyResult<B<'py>> = (|| -> PyResult<B<'py>> {
        let psutil = dep_mod(py, "psutil")?;
        let addrs = PyDict::new_bound(py);
        for pair in psutil
            .call_method0("net_if_addrs")?
            .call_method0("items")?
            .iter()?
        {
            let pair = pair?;
            let name = pair.get_item(0)?;
            let snics = pair.get_item(1)?;
            let lst = PyList::empty_bound(py);
            for sf in snics.iter()? {
                let sf = sf?;
                let fam = sf.getattr("family")?.getattr("name")?;
                let inet = plist!(py, s(py, "AF_INET"), s(py, "AF_INET6"));
                if op(py, "contains", &inet, &fam)?.is_truthy()? {
                    let fam2 = sf.getattr("family")?.getattr("name")?;
                    let addr = sf.getattr("address")?;
                    lst.call_method1(
                        "append",
                        (fjoin(py, vec![fmtv(py, &fam2, "")?, s(py, ": "), fmtv(py, &addr, "")?])?,),
                    )?;
                } else {
                    let link = plist!(py, s(py, "AF_LINK"), s(py, "AF_PACKET"));
                    let fam3 = sf.getattr("family")?.getattr("name")?;
                    if op(py, "contains", &link, &fam3)?.is_truthy()? {
                        let fam4 = sf.getattr("family")?.getattr("name")?;
                        lst.call_method1(
                            "append",
                            (fjoin(
                                py,
                                vec![fmtv(py, &fam4, "")?, s(py, ": [MAC-REDACTED]")],
                            )?,),
                        )?;
                    }
                }
            }
            if lst.is_truthy()? {
                addrs.set_item(name, lst)?;
            }
        }
        Ok(addrs.into_any())
    })();
    let out = match r {
        Ok(addrs) => res_new(py, "success", &[addrs])?,
        Err(e) if e.is_instance_of::<PyImportError>(py) => {
            let socket = dep_mod(py, "socket")?;
            let d = pdict!(py, "hostname" => socket.call_method0("gethostname")?);
            res_new(py, "success", &[d])?
        }
        Err(e) => return Err(e),
    };
    Ok(out.unbind())
}

#[pyfunction]
fn _chain_impl<'py>(py: Python<'py>, args: &B<'py>, ctx: &B<'py>) -> PyResult<PyObject> {
    let commands = args.call_method1("get", (s(py, "commands"), &PyList::empty_bound(py).into_any()))?;
    let stop_on_error =
        args.call_method1("get", (s(py, "stop_on_error"), &bl(py, true)))?;
    let confirm = ctx.call_method1("get", (s(py, "confirmed"), &bl(py, false)))?;
    // 整条链共用一个 call_id：它在界面上是一张卡片，输出也该汇到同一个窗口。
    let call_id = call_id_of(py, ctx)?;
    let timeout = i(py, 30);
    let results = PyList::empty_bound(py);
    let enumerated = bi1(py, "enumerate", &commands)?;
    for pair in enumerated.iter()? {
        let pair = pair?;
        let i0 = pair.get_item(0)?;
        let cmd = pair.get_item(1)?;
        let ws1 = ctx.call_method1("get", (s(py, "workspace_root"),))?;
        let lf = Py::new(
            py,
            LineFilter {
                ctx: ctx.clone().unbind(),
            },
        )?
        .into_bound(py)
        .into_any();
        let ws2 = ctx.call_method1("get", (s(py, "workspace_root"),))?;
        let sm_raw = ctx.call_method1("get", (s(py, "sandbox_mode"),))?;
        let sm = orv(&sm_raw, &s(py, "workspace-write"))?;
        let r = run_shell_kw(
            py, &cmd, &timeout, &ws1, &confirm, &call_id, &lf, &ws2, &sm,
        )?;
        let n = op(py, "add", &i0, &i(py, 1))?;
        if r.getattr("ok")?.is_truthy()? {
            let v = r.getattr("value")?;
            results.append(fjoin(
                py,
                vec![
                    s(py, "["),
                    fmtv(py, &n, "")?,
                    s(py, "] OK: "),
                    fmtv(py, &cmd, "")?,
                    s(py, "\n"),
                    fmtv(py, &v, "")?,
                ],
            )?)?;
        } else {
            let e = r.getattr("error")?;
            results.append(fjoin(
                py,
                vec![
                    s(py, "["),
                    fmtv(py, &n, "")?,
                    s(py, "] FAIL: "),
                    fmtv(py, &cmd, "")?,
                    s(py, "\n"),
                    fmtv(py, &e, "")?,
                ],
            )?)?;
            if stop_on_error.is_truthy()? {
                break;
            }
        }
    }
    let joined = s(py, "\n\n").call_method1("join", (&results,))?;
    let red = redact_core(py, &joined, ctx)?;
    Ok(res_new(py, "success", &[red])?.unbind())
}

#[pyfunction]
fn _search_impl<'py>(py: Python<'py>, args: &B<'py>, ctx: &B<'py>) -> PyResult<PyObject> {
    let raw = args.call_method1("get", (s(py, "query"), &s(py, "")))?;
    let query: B<'py> = match dep(py, "shell_word")?.call(
        (raw,),
        Some(&kw_dict(py, &[("label", &s(py, "搜索词"))])?),
    ) {
        Ok(v) => v,
        Err(e) => {
            let bce = dep(py, "BlockedCommandError")?;
            if e.is_instance_bound(py, &bce) {
                let msg = bstr(py, &e.value_bound(py))?;
                return Ok(res_new(py, "failure", &[msg])?.unbind());
            }
            return Err(e);
        }
    };
    let sys1 = call0v(py, "platform_system")?;
    let cmd = if eq(py, &sys1, &s(py, "Darwin"))? {
        fjoin(
            py,
            vec![
                s(py, "mdfind \""),
                fmtv(py, &query, "")?,
                s(py, "\" 2>/dev/null | head -20"),
            ],
        )?
    } else if eq(py, &call0v(py, "platform_system")?, &s(py, "Windows"))? {
        fjoin(
            py,
            vec![
                s(py, "powershell \"Get-StartApps | Where-Object {$_.Name -like '*"),
                fmtv(py, &query, "")?,
                s(py, "*'} | Format-Table\""),
            ],
        )?
    } else {
        fjoin(
            py,
            vec![
                s(
                    py,
                    "find /usr/share/applications -name \"*.desktop\" -exec grep -l -i \"",
                ),
                fmtv(py, &query, "")?,
                s(py, "\" {} \\; 2>/dev/null | head -10"),
            ],
        )?
    };
    let r = try_spawn(py, 0, cmd, 10, args)?;
    let ok = r.getattr("ok")?;
    let out = if ok.is_truthy()? {
        let v = r.getattr("value")?.call_method0("strip")?;
        let red = redact_core(py, &v, ctx)?;
        res_new(py, "success", &[red])?
    } else {
        let e = r.getattr("error")?;
        res_new(
            py,
            "failure",
            &[fjoin(py, vec![s(py, "Search failed: "), fmtv(py, &e, "")?])?],
        )?
    };
    Ok(out.unbind())
}

#[pyfunction]
fn _cua_action_impl<'py>(
    py: Python<'py>,
    args: &B<'py>,
    ctx: &B<'py>,
) -> PyResult<PyObject> {
    // CUA 动作层入口：薄转发，权限决策全部留在 cua_actions 既有体系里。
    let mod_obj = dep_mod(py, "cua_actions")?;
    let get = match mod_obj.getattr("get_cua_executor") {
        Ok(f) => f,
        Err(e) if e.is_instance_of::<pyo3::exceptions::PyAttributeError>(py) => {
            // `from cua_actions import get_cua_executor` raises ImportError
            // with the module __file__ in parentheses.
            let loc = match mod_obj.getattr("__file__") {
                Ok(f) => f.str()?.to_string_lossy().into_owned(),
                Err(_) => "<unknown>".to_string(),
            };
            return Err(PyImportError::new_err(format!(
                "cannot import name 'get_cua_executor' from 'cua_actions' ({})",
                loc
            )));
        }
        Err(e) => return Err(e),
    };
    let action_raw = args.call_method1("get", (s(py, "action"), &s(py, "")))?;
    let action = str_strip(py, &action_raw)?;
    let params = PyDict::new_bound(py);
    for pair in args.call_method0("items")?.iter()? {
        let pair = pair?;
        let k = pair.get_item(0)?;
        let v = pair.get_item(1)?;
        if ne(py, &k, &s(py, "action"))? {
            params.set_item(k, v)?;
        }
    }
    let r = get
        .call0()?
        .call_method1("execute", (action, params.into_any(), ctx.clone()))?;
    let out = if r.getattr("ok")?.is_truthy()? {
        let d = r.getattr("to_dict")?.call0()?;
        res_new(py, "success", &[d])?
    } else {
        let err = r.getattr("error")?;
        let a = r.getattr("action")?;
        let ms = r.getattr("elapsed_ms")?;
        dep(py, "Result")?.call_method(
            "failure",
            (&err,),
            Some(&kw_dict(py, &[("action", &a), ("elapsed_ms", &ms)])?),
        )?
    };
    Ok(out.unbind())
}

// ── the 12 ToolDef schemas (byte-exact literals, source insertion order) ──

fn schema_shell<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(pdict!(
        py,
        "type" => s(py, "object"),
        "properties" => pdict!(
            py,
            "command" => pdict!(
                py,
                "type" => s(py, "string"),
                "description" => s(py, "A single command line. The host shell is used (PowerShell on Windows), so '&&' is not portable — prefer one command per call."),
            ),
            "timeout" => pdict!(
                py,
                "type" => s(py, "integer"),
                "default" => i(py, 30),
                "description" => s(py, "Seconds before the command is killed. Raise it for builds and test suites."),
            ),
            "cwd" => pdict!(
                py,
                "type" => s(py, "string"),
                "description" => s(py, "Directory to run in. Defaults to the workspace root, so avoid 'cd' inside the command."),
            ),
        ),
        "required" => plist!(py, s(py, "command")),
    ))
}

fn schema_python<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(pdict!(
        py,
        "type" => s(py, "object"),
        "properties" => pdict!(
            py,
            "code" => pdict!(
                py,
                "type" => s(py, "string"),
                "description" => s(py, "Python source. Runs as a fresh program — nothing persists between calls, so include every import and definition it needs."),
            ),
            "mode" => pdict!(
                py,
                "type" => s(py, "string"),
                "default" => s(py, "sandbox"),
                "description" => s(py, "'sandbox' is restricted and preferred; 'native' has full host access and should be a deliberate choice."),
            ),
            "timeout" => pdict!(
                py,
                "type" => s(py, "integer"),
                "default" => i(py, 30),
            ),
        ),
        "required" => plist!(py, s(py, "code")),
    ))
}

fn schema_proc_list<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(pdict!(
        py,
        "type" => s(py, "object"),
        "properties" => pdict!(
            py,
            "limit" => pdict!(
                py,
                "type" => s(py, "integer"),
                "default" => i(py, 20),
                "description" => s(py, "How many to return, ordered by resource use. A full process table is hundreds of rows of context you will not read."),
            ),
        ),
        "required" => plist!(py),
    ))
}

fn schema_proc_kill<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(pdict!(
        py,
        "type" => s(py, "object"),
        "properties" => pdict!(
            py,
            "pid" => pdict!(
                py,
                "type" => s(py, "integer"),
                "description" => s(py, "Confirm with `process_list` immediately before killing. PIDs are recycled, and a stale one from earlier in the turn may now belong to something else entirely."),
            ),
        ),
        "required" => plist!(py, s(py, "pid")),
    ))
}

fn schema_empty<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(pdict!(
        py,
        "type" => s(py, "object"),
        "properties" => pdict!(py),
        "required" => plist!(py),
    ))
}

fn schema_env_get<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(pdict!(
        py,
        "type" => s(py, "object"),
        "properties" => pdict!(
            py,
            "name" => pdict!(
                py,
                "type" => s(py, "string"),
                "description" => s(py, "Exact variable name, case-sensitive on Unix."),
            ),
        ),
        "required" => plist!(py, s(py, "name")),
    ))
}

fn schema_env_set<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(pdict!(
        py,
        "type" => s(py, "object"),
        "properties" => pdict!(
            py,
            "name" => pdict!(
                py,
                "type" => s(py, "string"),
                "description" => s(py, "Variable name."),
            ),
            "value" => pdict!(
                py,
                "type" => s(py, "string"),
                "description" => s(py, "New value. Overwrites silently if the variable already exists."),
            ),
        ),
        "required" => plist!(py, s(py, "name"), s(py, "value")),
    ))
}

fn schema_disk<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(pdict!(
        py,
        "type" => s(py, "object"),
        "properties" => pdict!(
            py,
            "path" => pdict!(
                py,
                "type" => s(py, "string"),
                "default" => s(py, "."),
                "description" => s(py, "Any path on the volume you care about; the figures are per-volume, not per-directory."),
            ),
        ),
        "required" => plist!(py),
    ))
}

fn schema_chain<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(pdict!(
        py,
        "type" => s(py, "object"),
        "properties" => pdict!(
            py,
            "commands" => pdict!(
                py,
                "type" => s(py, "array"),
                "items" => pdict!(py, "type" => s(py, "string")),
                "description" => s(py, "Commands in order. Each is a separate invocation, so a 'cd' in one does NOT carry into the next."),
            ),
            "stop_on_error" => pdict!(
                py,
                "type" => s(py, "boolean"),
                "default" => bl(py, true),
                "description" => s(py, "Leave this True. Setting it False keeps going after a failure, which turns one broken step into a half-applied sequence nobody can unwind."),
            ),
        ),
        "required" => plist!(py, s(py, "commands")),
    ))
}

fn schema_search<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(pdict!(
        py,
        "type" => s(py, "object"),
        "properties" => pdict!(
            py,
            "query" => pdict!(
                py,
                "type" => s(py, "string"),
                "description" => s(py, "What the user is looking for, in their words — 'bluetooth', 'display resolution'."),
            ),
        ),
        "required" => plist!(py, s(py, "query")),
    ))
}

#[allow(clippy::too_many_arguments)]
fn enum_prop<'py>(
    py: Python<'py>,
    ty: &str,
    enum_vals: Vec<B<'py>>,
    default: Option<B<'py>>,
    desc: &str,
) -> PyResult<B<'py>> {
    let d = PyDict::new_bound(py);
    d.set_item("type", s(py, ty))?;
    d.set_item("enum", PyList::new_bound(py, enum_vals))?;
    if let Some(v) = default {
        d.set_item("default", v)?;
    }
    d.set_item("description", s(py, desc))?;
    Ok(d.into_any())
}

fn typed_prop<'py>(
    py: Python<'py>,
    ty: &str,
    default: Option<B<'py>>,
    desc: &str,
) -> PyResult<B<'py>> {
    let d = PyDict::new_bound(py);
    d.set_item("type", s(py, ty))?;
    if let Some(v) = default {
        d.set_item("default", v)?;
    }
    d.set_item("description", s(py, desc))?;
    Ok(d.into_any())
}

#[allow(clippy::too_many_arguments)]
fn schema_cua<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let props = PyDict::new_bound(py);
    props.set_item(
        "action",
        enum_prop(
            py,
            "string",
            vec![
                s(py, "navigate"),
                s(py, "click"),
                s(py, "click_text"),
                s(py, "click_element"),
                s(py, "fill"),
                s(py, "scroll"),
                s(py, "hover"),
                s(py, "drag"),
                s(py, "keypress"),
                s(py, "screenshot"),
                s(py, "element_info"),
                s(py, "element_tree"),
                s(py, "window_list"),
                s(py, "wait"),
            ],
            None,
            "Which CUA action to run. Side-effect actions automatically capture a screenshot and OCR summary afterwards, so the next decision can read what the screen shows now.",
        )?,
    )?;
    props.set_item(
        "url",
        typed_prop(py, "string", None, "navigate: http(s) URL to open in the default browser.")?,
    )?;
    props.set_item(
        "x",
        typed_prop(py, "integer", None, "click/hover/scroll/fill/element_info: screen X coordinate.")?,
    )?;
    props.set_item(
        "y",
        typed_prop(py, "integer", None, "click/hover/scroll/fill/element_info: screen Y coordinate.")?,
    )?;
    props.set_item(
        "button",
        enum_prop(
            py,
            "string",
            vec![s(py, "left"), s(py, "right"), s(py, "middle")],
            Some(s(py, "left")),
            "click: mouse button.",
        )?,
    )?;
    props.set_item(
        "clicks",
        typed_prop(py, "integer", Some(i(py, 1)), "click: 1 single, 2 double.")?,
    )?;
    props.set_item(
        "text",
        typed_prop(py, "string", None, "fill: text to type into the focused control.")?,
    )?;
    props.set_item(
        "delay_ms",
        typed_prop(py, "integer", Some(i(py, 10)), "fill: per-character delay in ms.")?,
    )?;
    props.set_item(
        "key",
        typed_prop(py, "string", None, "keypress: key or combo, e.g. 'enter', 'ctrl+s', 'alt+f4'.")?,
    )?;
    props.set_item(
        "start_x",
        typed_prop(py, "integer", None, "drag: starting X.")?,
    )?;
    props.set_item(
        "start_y",
        typed_prop(py, "integer", None, "drag: starting Y.")?,
    )?;
    props.set_item(
        "end_x",
        typed_prop(py, "integer", None, "drag: ending X.")?,
    )?;
    props.set_item(
        "end_y",
        typed_prop(py, "integer", None, "drag: ending Y.")?,
    )?;
    props.set_item(
        "duration",
        typed_prop(py, "number", Some(flt(py, 0.5)), "drag: motion duration in seconds.")?,
    )?;
    props.set_item(
        "roi",
        pdict!(
            py,
            "type" => s(py, "array"),
            "items" => pdict!(py, "type" => s(py, "integer")),
            "description" => s(py, "screenshot/element_info: optional region [x, y, width, height]."),
        ),
    )?;
    props.set_item(
        "save_path",
        typed_prop(py, "string", None, "screenshot/element_info: optional file path for the capture.")?,
    )?;
    props.set_item(
        "limit",
        typed_prop(py, "integer", Some(i(py, 20)), "element_info: max OCR elements returned.")?,
    )?;
    props.set_item(
        "seconds",
        typed_prop(py, "number", Some(i(py, 1)), "wait: plain sleep duration (no for_text).")?,
    )?;
    props.set_item(
        "for_text",
        typed_prop(py, "string", None, "wait: poll screen OCR until this text appears (then stop early).")?,
    )?;
    props.set_item(
        "timeout",
        typed_prop(py, "number", Some(i(py, 10)), "wait: ceiling for the for_text poll loop.")?,
    )?;
    props.set_item(
        "observe_midway",
        typed_prop(py, "boolean", Some(bl(py, false)), "drag: pause at the midpoint and screenshot-observe during the drag (only when the engine exposes step primitives; degrades honestly otherwise).")?,
    )?;
    props.set_item(
        "expect_text",
        typed_prop(py, "string", None, "element_info: text you expect to see; delivery_hint=deliverable is set only when it really appears in this round's OCR lines.")?,
    )?;
    props.set_item(
        "target_ref",
        typed_prop(py, "string", None, "Which target to act on (U4 unified Target protocol). desktop:0 = the whole desktop (default) | tab:{session_id}/{tab_id} = a browser tab inside a task session | app:{pid} = a local process window.")?,
    )?;
    props.set_item(
        "hwnd",
        typed_prop(py, "integer", None, "element_tree/click_element: target window handle. Get it from window_list first — that is the only place a hwnd comes from.")?,
    )?;
    props.set_item(
        "title",
        typed_prop(py, "string", None, "window_list: keep only windows whose title contains this text (case-insensitive).")?,
    )?;
    props.set_item(
        "name",
        typed_prop(py, "string", None, "element_tree: keep only elements whose Name contains this text (case-insensitive).")?,
    )?;
    props.set_item(
        "control_type",
        typed_prop(py, "string", None, "element_tree/click_element target: exact control type, e.g. 'Button', 'Edit', 'ListItem', 'Text'.")?,
    )?;
    props.set_item(
        "automation_id",
        typed_prop(py, "string", None, "element_tree/click_element target: exact AutomationId, e.g. 'UpButton'. The most stable locator when the UI is not localized.")?,
    )?;
    props.set_item(
        "target",
        pdict!(
            py,
            "type" => s(py, "object"),
            "description" => s(py, "click_element: semantic locator. It resolves to the element's centre, then goes through the same click pipeline as the plain click action — prefer this over guessing coordinates on icon-only or self-drawn controls."),
            "properties" => pdict!(
                py,
                "name" => pdict!(py, "type" => s(py, "string"), "description" => s(py, "Substring of the element Name (case-insensitive).")),
                "control_type" => pdict!(py, "type" => s(py, "string"), "description" => s(py, "Exact control type.")),
                "automation_id" => pdict!(py, "type" => s(py, "string"), "description" => s(py, "Exact AutomationId.")),
                "index" => pdict!(py, "type" => s(py, "integer"), "default" => i(py, 1), "description" => s(py, "1-based ordinal when several elements match.")),
            ),
        ),
    )?;
    props.set_item(
        "dpi_scale",
        typed_prop(py, "number", Some(flt(py, 1.0)), "element_tree/click_element: physical-to-logical scale factor for the returned/clicked centre. Pass the same value you use for screenshot coordinates.")?,
    )?;
    props.set_item(
        "offset_x",
        typed_prop(py, "integer", Some(i(py, 0)), "click_element: nudge the resolved centre on X before clicking.")?,
    )?;
    props.set_item(
        "offset_y",
        typed_prop(py, "integer", Some(i(py, 0)), "click_element: nudge the resolved centre on Y before clicking.")?,
    )?;
    let out = PyDict::new_bound(py);
    out.set_item("type", s(py, "object"))?;
    out.set_item("properties", props)?;
    out.set_item("required", PyList::new_bound(py, [s(py, "action")]))?;
    Ok(out.into_any())
}

// ── _build_tool_defs / _register_tools ─────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn td<'py>(
    py: Python<'py>,
    domain: &B<'py>,
    name: &str,
    desc: &str,
    schema: B<'py>,
    impl_idx: usize,
    risk: &str,
    owns_kill: Option<bool>,
    wtu: &str,
    wntu: &str,
) -> PyResult<B<'py>> {
    let fnc = dep(py, "ToolDef")?;
    let impl_o = {
        let v = IMPLS.lock();
        v[impl_idx].bind(py).clone()
    };
    let args = PyTuple::new_bound(
        py,
        vec![s(py, name), s(py, desc), schema, impl_o],
    );
    let kw = PyDict::new_bound(py);
    kw.set_item("domain", domain)?;
    kw.set_item("risk_level", s(py, risk))?;
    if let Some(v) = owns_kill {
        kw.set_item("manages_own_killable_child", bl(py, v))?;
    }
    kw.set_item("when_to_use", s(py, wtu))?;
    kw.set_item("when_not_to_use", s(py, wntu))?;
    Ok(fnc.call(&args, Some(&kw))?)
}

fn build_defs_core<'py>(
    py: Python<'py>,
    domain: &B<'py>,
) -> PyResult<Bound<'py, PyList>> {
    let defs: Vec<B<'py>> = vec![
        td(
            py,
            domain,
            "shell_executor",
            "Run one shell command in the workspace (high risk).",
            schema_shell(py)?,
            0,
            "high",
            Some(true),
            "Running builds, tests, linters, package managers, or any CLI the task genuinely needs.",
            "Anything a dedicated tool already does — reading (`read_text`), searching (`search_code`), listing (`list_dir`), editing (`edit_file`), git (`git_*`). Those are safer and reviewable. Never use this to delete or overwrite files in bulk.",
        )?,
        td(
            py,
            domain,
            "python_executor",
            "Run a Python snippet (sandbox/native).",
            schema_python(py)?,
            1,
            "high",
            None,
            "A calculation or data transformation that is genuinely easier in Python than a shell one-liner.",
            "Running the project's own code or tests — use `shell_executor` so it runs the way the user runs it. Do not read or write project files with this either; the file tools leave a reviewable trail, this does not.",
        )?,
        td(
            py,
            domain,
            "process_list",
            "List running processes.",
            schema_proc_list(py)?,
            2,
            "low",
            None,
            "Finding out whether something is already running before you start a second copy — a dev server on a port, a hung test run — or locating a PID the user asked you to deal with.",
            "As a general 'what is this machine doing' sweep. The output names every process the user has open, which is a lot of unrelated personal detail in exchange for very little.",
        )?,
        td(
            py,
            domain,
            "process_kill",
            "Kill process by PID.",
            schema_proc_kill(py)?,
            3,
            "high",
            None,
            "The user asked you to stop a specific process, or a process you yourself started is stuck and has to go.",
            "Anything you did not start and were not asked about. There is no undo: unsaved work in that process is gone, and an editor, a database or a system service can all be killed by the same call. Never kill by guessing at a name.",
        )?,
        td(
            py,
            domain,
            "system_info",
            "Get system info.",
            schema_empty(py)?,
            4,
            "low",
            None,
            "When a decision genuinely turns on the platform — which shell syntax to write, which package manager exists, whether a path separator matters.",
            "Out of habit at the start of a task. The OS is usually already stated in your context, and asking again costs a step.",
        )?,
        td(
            py,
            domain,
            "env_get",
            "Get env var.",
            schema_env_get(py)?,
            5,
            "low",
            None,
            "Checking that a variable a build or script depends on is actually set, or reading a non-secret value like PATH or NODE_ENV.",
            "Fishing for credentials. Values of API keys, tokens and passwords must not be read back into the conversation — refer to them by name and report only whether they are set.",
        )?,
        td(
            py,
            domain,
            "env_set",
            "Set env var.",
            schema_env_set(py)?,
            6,
            "medium",
            None,
            "Setting something a command you are about to run needs, when the user asked for that configuration.",
            "Working around a failure you have not diagnosed. This affects the agent's own environment, NOT the user's shell profile, so it does not persist the way they will expect — if they want it permanent, edit the config file and say so.",
        )?,
        td(
            py,
            domain,
            "disk_usage",
            "Disk usage.",
            schema_disk(py)?,
            7,
            "low",
            None,
            "A write, build or install failed and 'no space left' is a plausible cause, or the user asked how much room is left.",
            "Finding what is taking up space — this reports the volume total, not a per-directory breakdown.",
        )?,
        td(
            py,
            domain,
            "network_interfaces",
            "Network interfaces.",
            schema_empty(py)?,
            8,
            "low",
            None,
            "Diagnosing local connectivity, or finding the LAN address to bind a dev server to so another device can reach it.",
            "Checking whether the internet works — that needs an actual request. Interfaces can be up on a network that goes nowhere. Output includes MAC and IP addresses, so do not quote it wholesale.",
        )?,
        td(
            py,
            domain,
            "native_action_chain",
            "Execute multiple commands in sequence.",
            schema_chain(py)?,
            9,
            "high",
            Some(true),
            "A fixed sequence where you already know every command up front and no step's output changes the next — the usual case is a documented install or setup recipe.",
            "Anything where you need to look at the output before deciding. Chaining blind is how a bad assumption gets executed five times instead of once; `shell_executor` one command at a time is slower and much easier to stop.",
        )?,
        td(
            py,
            domain,
            "action_search",
            "Search system settings/apps.",
            schema_search(py)?,
            10,
            "low",
            None,
            "Locating an OS settings pane or an installed application by name before acting on it.",
            "Searching the web (`standard_search`) or the workspace (`search_code`). This only looks at the local machine's settings and app index, and it finds things — it does not open or change them.",
        )?,
        td(
            py,
            domain,
            "cua_action",
            "Run one CUA action (navigate/click/click_text/click_element/fill/scroll/hover/drag/keypress/screenshot/element_info/element_tree/window_list/wait) with a mandatory post-action screenshot and local OCR summary.",
            schema_cua(py)?,
            11,
            "medium",
            None,
            "Acting on the desktop through the closed perception loop: every side-effect action comes back with a screenshot path and an OCR text summary of what the screen shows now, so you can verify a click landed or a page loaded without a separate screenshot call.",
            "File, shell, git and process work — the dedicated tools are safer and reviewable. For app lifecycle (launch/close/focus) the app domain tools are more precise. Credential-shaped input (passwords, OTP) and captcha/safety-bypass targets are refused here by design.",
        )?,
    ];
    Ok(PyList::new_bound(py, defs))
}

/// Plain (non-binding) function stored as `ComputerAgent._build_tool_defs`;
/// see the header DIVERGENCE(bound-call sugar) for the call-shape note.
#[pyfunction]
fn _build_tool_defs<'py>(py: Python<'py>, agent: &B<'py>) -> PyResult<PyObject> {
    let domain = agent.getattr("DOMAIN")?;
    Ok(build_defs_core(py, &domain)?.into_any().unbind())
}

/// Plain (non-binding) function stored as `ComputerAgent._register_tools`.
#[pyfunction]
fn _register_tools<'py>(py: Python<'py>, agent: &B<'py>) -> PyResult<PyObject> {
    let tds = agent.getattr("_build_tool_defs")?.call1((agent,))?;
    let tools = agent.getattr("tools")?;
    for td_obj in tds.iter()? {
        tools.call_method1("register", (&td_obj?,))?;
    }
    Ok(py.None())
}

// ── module singleton + probe seams ─────────────────────────────────────────

#[pyfunction]
#[pyo3(signature = (workspace=None))]
fn get_computer_agent<'py>(
    py: Python<'py>,
    workspace: Option<Py<PyAny>>,
) -> PyResult<PyObject> {
    let cur = AGENT.lock().as_ref().map(|o| o.clone_ref(py));
    if let Some(o) = cur {
        if !o.is_none(py) {
            return Ok(o);
        }
    }
    let cls = py.get_type_bound::<ComputerAgent>();
    let inst = cls.call1((workspace.unwrap_or_else(|| py.None()),))?;
    let out = inst.clone();
    *AGENT.lock() = Some(out.clone().unbind());
    Ok(out.unbind())
}

#[pyfunction]
fn _peek_agent<'py>(py: Python<'py>) -> PyResult<PyObject> {
    let g = AGENT
        .lock()
        .as_ref()
        .map(|o| o.clone_ref(py))
        .unwrap_or_else(|| py.None());
    Ok(g)
}

#[pyfunction]
#[pyo3(signature = (agent=None))]
fn _set_agent<'py>(py: Python<'py>, agent: Option<Py<PyAny>>) -> PyResult<PyObject> {
    *AGENT.lock() = Some(agent.unwrap_or_else(|| py.None()));
    Ok(py.None())
}

#[pyfunction]
#[pyo3(signature = (**kwargs))]
fn _set_seams<'py>(
    py: Python<'py>,
    kwargs: Option<Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let mut g = SEAMS.lock();
    let table = match g.as_ref() {
        Some(p) => p.bind(py).clone(),
        None => {
            let d = PyDict::new_bound(py);
            *g = Some(d.clone().unbind());
            d
        }
    };
    if let Some(kw) = kwargs {
        for (k, v) in kw {
            if v.is_none() {
                table.del_item(k)?;
            } else {
                table.set_item(k.as_ref(), v.as_ref())?;
            }
        }
    }
    Ok(py.None())
}

// ── submodule registration ─────────────────────────────────────────────────

/// IMPLS index order == the order the source defines the impls == the order
/// the ToolDef literals reference them.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(py, "computer_agent")?;
    m.add_function(wrap_pyfunction!(_redact, &m)?)?;
    m.add_function(wrap_pyfunction!(_preprocess_shell_command, &m)?)?;
    m.add_function(wrap_pyfunction!(_shell_impl, &m)?)?;
    m.add_function(wrap_pyfunction!(_python_impl, &m)?)?;
    m.add_function(wrap_pyfunction!(_proc_list_impl, &m)?)?;
    m.add_function(wrap_pyfunction!(_proc_kill_impl, &m)?)?;
    m.add_function(wrap_pyfunction!(_sysinfo_impl, &m)?)?;
    m.add_function(wrap_pyfunction!(_envget_impl, &m)?)?;
    m.add_function(wrap_pyfunction!(_envset_impl, &m)?)?;
    m.add_function(wrap_pyfunction!(_disk_impl, &m)?)?;
    m.add_function(wrap_pyfunction!(_netif_impl, &m)?)?;
    m.add_function(wrap_pyfunction!(_chain_impl, &m)?)?;
    m.add_function(wrap_pyfunction!(_search_impl, &m)?)?;
    m.add_function(wrap_pyfunction!(_cua_action_impl, &m)?)?;
    {
        let mut v = IMPLS.lock();
        v.clear();
        for name in [
            "_shell_impl",
            "_python_impl",
            "_proc_list_impl",
            "_proc_kill_impl",
            "_sysinfo_impl",
            "_envget_impl",
            "_envset_impl",
            "_disk_impl",
            "_netif_impl",
            "_chain_impl",
            "_search_impl",
            "_cua_action_impl",
        ] {
            v.push(m.getattr(name)?.unbind());
        }
    }
    m.add_class::<ComputerAgent>()?;
    m.add_function(wrap_pyfunction!(_build_tool_defs, &m)?)?;
    m.add_function(wrap_pyfunction!(_register_tools, &m)?)?;
    let cls = py.get_type_bound::<ComputerAgent>();
    cls.setattr("_build_tool_defs", m.getattr("_build_tool_defs")?)?;
    cls.setattr("_register_tools", m.getattr("_register_tools")?)?;
    m.add_function(wrap_pyfunction!(get_computer_agent, &m)?)?;
    m.add_function(wrap_pyfunction!(_peek_agent, &m)?)?;
    m.add_function(wrap_pyfunction!(_set_agent, &m)?)?;
    m.add_function(wrap_pyfunction!(_set_seams, &m)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}

