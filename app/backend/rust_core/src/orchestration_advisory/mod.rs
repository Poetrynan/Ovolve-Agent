//! orchestration_advisory — Rust port of `app/backend/orchestration_advisory.py`
//! (wave-7, Native→Rust).
//!
//! Six-criteria scoring for finished sub-agent batches: per-criterion scores in
//! 0..1 (or None when not computable), an overall mean rounded to 3 decimals,
//! a per-criterion human detail line and one factual Chinese `parent_note`.
//! Advisory only: the module never blocks and never touches storage.
//!
//! Port posture (recovery / uia_tree precedent): every value flows as a live
//! CPython object. `results` is iterated with the real iterator protocol; the
//! per-row `r.get(...)` calls are REAL attribute lookups, so a non-dict row
//! raises the interpreter's own `AttributeError`; `is True` / `is False` are
//! identity checks against the interpreter's singletons; `in`, `or`, `==`,
//! `<`, `>`, `<=`, `>=`, `-`, `+`, `/` are the real operators (via the
//! `operator` module, i.e. the same rich-compare calls the interpreter makes);
//! `len`, `str`, `float`, `int`, `sum`, `round`, `min`, `max`, `format`,
//! `repr`, `slice` are the real builtins. So exception types and messages,
//! dict key insertion order, f-string piece order, and the exact number of
//! `.get` / `__gt__` / `__str__` / `__ge__` calls match the canonical
//! implementation by construction, not by re-derivation.
//!
//! Bug-for-bug items kept verbatim (each pinned by smoke/parity_orchestration_advisory.py):
//! §1 the empty-batch short-circuit returns BEFORE any row is touched, and its
//!    `scores`/`details` are dict comprehensions over the module global
//!    `_CRITERIA` read at call time (patched `_CRITERIA` reshapes both dicts;
//!    a non-iterable one detonates there) — while the NON-empty path's
//!    `scores` dict literal is hard-coded and never reads `_CRITERIA`.
//! §2 `r.get("ok") is True` / `is False` are IDENTITY checks: ok=1, ok=0,
//!    ok="yes" or a truthy imposter never count, on either side.
//! §3 the contract pass is
//!    `ok is True and "result contract rejected" not in str(r.get("error",""))`
//!    — the error `.get` runs only when the ok test passed (short-circuit),
//!    so contract-rejected rows pay no error read in the pass loop.
//! §4 `results` is iterated EIGHT separate times (ok / contract-pass /
//!    contract-reject / startedAt / text / blocked / final_marker /
//!    has_output) while `len()` was taken ONCE up front: a one-shot iterator
//!    reports `n` from `len` but feeds only the first pass, so every later
//!    pass sees nothing (contract rate becomes None, timing falls to the
//!    no-data branch, …).
//! §5 `r.get("startedAt", 0) or 0`: a present-but-falsy value (0, "", None,
//!    False) becomes the literal 0; a truthy non-number survives UNCHANGED
//!    and detonates at `t > 0` with the operator's own TypeError.
//! §6 `t > 0` is evaluated 1 + 2N times: once per item in `any()` (which
//!    short-circuits), then AGAIN per item in min's generator and AGAIN in
//!    max's. A scripted `__gt__` that answers True once and False afterwards
//!    makes `any()` pass and the filters empty — the batch then dies with
//!    "min() arg is an empty sequence" or "max() arg is an empty sequence",
//!    not with a score.
//! §7 min/max compare (new, current) with Py_LT / Py_GT and keep the FIRST on
//!    ties; `span = max_t - min_t` is the number protocol (bool - bool → int
//!    0), and `span <= 2.0` is the INCLUSIVE full-parallelism boundary.
//! §8 the clamp is `max(0.0, min(1.0, float(x)))` with comparison semantics,
//!    so NaN clamps to **1.0** (min(1.0, nan) keeps 1.0) and -0.0 clamps to
//!    positive 0.0 — both observable through the probe's float repr.
//! §9 cost_efficiency: `est_tokens = total_chars / 3.0` where total_chars
//!    counts CODE POINTS of `str(text or "")` — `str()` of a non-str goes
//!    through `__str__` (counted), None-or-empty is skipped by the `or`. The
//!    detail line's `int(est_tokens)` TRUNCATES toward zero.
//! §10 blocked: `status == "blocked"` short-circuits the whole blockedReason
//!    chain (no blockedReason `.get`, no `str()`); otherwise the lease check
//!    reads blockedReason TWICE (two `.get`s, two `str()`s — `租约` substring
//!    first, then `"lease" in str(...).lower()` with Unicode lowering) when
//!    the first miss fires.
//! §11 result_quality averages via true division: `(m1 + m2) / 2.0`, falling
//!    back to whichever sub-metric exists (never None for n > 0).
//! §12 `overall = round(sum(present) / len(present), 3)` — the builtin round
//!    (banker's rounding on the decimal digit), summed in scores insertion
//!    order; `scores.values()` is the real view.
//! §13 the detail strings are f-strings evaluated in source order;
//!    `{parallelism_util:.0%}` is `format(x, ".0%")` — ties-to-even on the
//!    double, and a non-float parallelism_util detonates there.
//! §14 the parent note assembles parts in order (total, blocked, grade,
//!    weak); the grade thresholds compare the SAME overall object three
//!    times (>= 0.85 / 0.6 / 0.4 — a counting `__ge__` sees up to three
//!    calls); `weak` keeps dict iteration order and `min(key=lambda kv:
//!    kv[1])` keeps the FIRST minimum on ties; `_CRITERIA_CN` is read from
//!    the module dict at call time (patched table → KeyError / TypeError
//!    from the real subscript), and the weakest value renders with `:.0%`.
//! §15 Advisory is a NON-frozen dataclass: attributes are settable; `__eq__`
//!    compares the 4-field tuple only when `other.__class__ is
//!    self.__class__` (else `NotImplemented`); `__hash__` is None, so the
//!    instances are unhashable; `__repr__` is the generated field form.
//! §16 assess_batch constructs its result through the module global
//!    `Advisory` read at call time — a patched Advisory builds the return
//!    value with the kwargs in source order (scores, overall, parent_note,
//!    details). Call-binding mistakes reproduce the eval loop's grammar with
//!    the `Advisory.__init__()` qualifier for the constructor.
//!
//! DIVERGENCE(port, `__future__` leftover): `from __future__ import
//!     annotations` leaves the name `annotations` bound in the python
//!     module's namespace; the crate does not reproduce that leftover (same
//!     crate-wide note as recovery). No code path can read it.
//! DIVERGENCE(port, class annotations): the dataclass stores
//!     `Advisory.__annotations__` (stringified under the future import); the
//!     port carries no annotations dict. Nothing in the module or its
//!     consumers reads it.
//! DIVERGENCE(port, docstrings): function/class `__doc__` text comes from the
//!     Rust doc comments; wording is kept but byte layout is not asserted.
// PORT STATUS: confidence=high todos=[0]

use crate::cpy_call::{too_many_positional, unexpected_keyword};
use parking_lot::Mutex;
use pyo3::exceptions::{PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyAny, PyDict, PyFloat, PyList, PyModule, PyString, PyTuple};

type B<'py> = Bound<'py, PyAny>;

/// the live `orchestration_advisory` submodule, so `own()` reads the same dict
/// that `ovolve_core.orchestration_advisory.__dict__` exposes to python.
static ST: Mutex<Option<Py<PyModule>>> = Mutex::new(None);

// ── own-module globals (python's late global lookup) ────────────────────────

fn own<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    let m: Option<Py<PyModule>> = ST.lock().as_ref().map(|p| p.clone_ref(py));
    match m {
        Some(p) => Ok(p.bind(py).getattr(name)?),
        None => Err(pyo3::exceptions::PyImportError::new_err(
            "orchestration_advisory module not registered",
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

fn flt<'py>(py: Python<'py>, v: f64) -> B<'py> {
    PyFloat::new_bound(py, v).into_any()
}

fn ps<'py>(py: Python<'py>, v: &str) -> B<'py> {
    PyString::new_bound(py, v).into_any()
}

fn none<'py>(py: Python<'py>) -> B<'py> {
    py.None().into_bound(py).into_any()
}

/// the interpreter's own True/False singletons (identity checks target these).
fn true_obj<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("True")?)
}

fn false_obj<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("False")?)
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

/// real operator-module binary op — the exact protocol behind `a - b`,
/// `t > 0`, `x in s`, `a == b`, … including reflected fallbacks.
fn op<'py>(py: Python<'py>, name: &str, a: &B<'py>, b: &B<'py>) -> PyResult<B<'py>> {
    Ok(py.import_bound("operator")?.getattr(name)?.call1((a, b))?)
}

fn opb<'py>(py: Python<'py>, name: &str, a: &B<'py>, b: &B<'py>) -> PyResult<bool> {
    Ok(op(py, name, a, b)?.is_truthy()?)
}

/// `x in seq` — the same `PySequence_Contains` the interpreter runs.
fn contains<'py>(py: Python<'py>, seq: &B<'py>, x: &B<'py>) -> PyResult<bool> {
    opb(py, "contains", seq, x)
}

/// `x or y` (returns the ORIGINAL object when x is truthy).
fn orv<'py>(v: &B<'py>, def: &B<'py>) -> PyResult<B<'py>> {
    Ok(if v.is_truthy()? { v.clone() } else { def.clone() })
}

/// `f"{x}"` — the real `format(x, "")` an f-string compiles to.
fn fmtv<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("format")?.call1((x, ps(py, "")))?)
}

/// `f"{x:spec}"` — the real `format(x, spec)`.
fn fmts<'py>(py: Python<'py>, x: &B<'py>, spec: &str) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("format")?.call1((x, ps(py, spec)))?)
}

/// `"".join(pieces)` — assembles the pieces of an f-string in source order.
fn concat<'py>(py: Python<'py>, pieces: Vec<B<'py>>) -> PyResult<B<'py>> {
    let list = PyList::new_bound(py, pieces);
    Ok(ps(py, "").call_method1("join", (&list,))?)
}

/// `str(x)` — the builtin, so `__str__` overrides are seen (and counted).
fn str_of<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    bi1(py, "str", x)
}

/// `len(x)` — the builtin (same TypeError wording).
fn len_of<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    bi1(py, "len", x)
}

/// `float(x)` — the builtin (str-parsing, NaN/inf, and the
/// "argument must be a string or a real number" TypeError all included).
fn float_of<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    bi1(py, "float", x)
}

// ── call binding (cpy_call wording, eval-loop precedence) ───────────────────

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

/// CPython parses a call to the dataclass-generated `__init__` in the eval
/// loop, so every arity/keyword mistake reads `Advisory.__init__() …`; pyo3's
/// `#[new]` parser hard-codes the token `__new__`. Same grammar as
/// [`bind_call`], with `self` folded into CPython's counts. All four fields
/// are required (the dataclass declares no defaults), so no UNSET handling.
fn bind_init<'py>(
    py: Python<'py>,
    cls: &str,
    params: &[&str],
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<Vec<PyObject>> {
    let total = params.len();
    let nargs = args.len();
    let mut slots: Vec<Option<PyObject>> = (0..total).map(|_| None).collect();
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
            0,
            nargs + 1,
        )));
    }
    let missing: Vec<&str> = params
        .iter()
        .zip(slots.iter())
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
        .map(|s| s.expect("validated: all required slots filled"))
        .collect())
}

// ── iteration / aggregation over live objects ───────────────────────────────

/// `for r in results:` — the real iterator protocol, one pass per call site.
fn pass_count<'py, F>(results: &B<'py>, mut pred: F) -> PyResult<i64>
where
    F: FnMut(&B<'py>) -> PyResult<bool>,
{
    let mut c: i64 = 0;
    for r in results.iter()? {
        let r = r?;
        if pred(&r)? {
            c += 1;
        }
    }
    Ok(c)
}

/// builtin min()/max() over already-collected items, no key: compares
/// (new, current) with Py_LT / Py_GT, keeps the FIRST on ties, and the
/// empty input raises the interpreter's own ValueError.
fn py_minmax<'py>(py: Python<'py>, items: &[B<'py>], want_max: bool) -> PyResult<B<'py>> {
    if items.is_empty() {
        return Err(PyValueError::new_err(format!(
            "{}() arg is an empty sequence",
            if want_max { "max" } else { "min" }
        )));
    }
    let cmp = if want_max { "gt" } else { "lt" };
    let mut cur = items[0].clone();
    for x in items.iter().skip(1) {
        if opb(py, cmp, x, &cur)? {
            cur = x.clone();
        }
    }
    Ok(cur)
}

/// builtin min() with `key=lambda kv: kv[1]`: the key is a real SUBSCRIPT, so
/// a non-subscriptable item raises from there; ties keep the first item.
fn min_key_sub1<'py>(py: Python<'py>, items: &[B<'py>]) -> PyResult<B<'py>> {
    if items.is_empty() {
        return Err(PyValueError::new_err("min() arg is an empty sequence"));
    }
    let mut cur = items[0].clone();
    let mut cur_key = cur.get_item(1)?;
    for x in items.iter().skip(1) {
        let kx = x.get_item(1)?;
        if opb(py, "lt", &kx, &cur_key)? {
            cur = x.clone();
            cur_key = kx;
        }
    }
    Ok(cur)
}

/// `left, right = item` — CPython's UNPACK_SEQUENCE for the two-tuple loop,
/// with the interpreter's own not-enough / too-many / non-iterable wording.
fn unpack_n<'py>(py: Python<'py>, seq: &B<'py>, n: usize) -> PyResult<Vec<B<'py>>> {
    if seq.is_instance_of::<PyTuple>() || seq.is_instance_of::<PyList>() {
        let len = seq.len()?;
        if len != n {
            return Err(unpack_err(n, Some(len)));
        }
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            out.push(seq.get_item(i)?.into_any());
        }
        return Ok(out);
    }
    let iterated: PyResult<Vec<B<'py>>> = (|| {
        let mut out: Vec<B<'py>> = Vec::with_capacity(n + 1);
        let mut it = seq.iter()?;
        for _ in 0..n {
            match it.next() {
                Some(item) => out.push(item?.into_any()),
                None => return Err(unpack_err(n, Some(out.len()))),
            }
        }
        if it.next().is_some() {
            return Err(unpack_err(n, None));
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

fn unpack_err(n: usize, got: Option<usize>) -> PyErr {
    match got {
        Some(g) if g < n => PyValueError::new_err(format!(
            "not enough values to unpack (expected {}, got {})",
            n, g
        )),
        Some(_) => PyValueError::new_err(format!("too many values to unpack (expected {})", n)),
        None => PyValueError::new_err(format!("too many values to unpack (expected {})", n)),
    }
}

// ── the clamp and the safe fraction ─────────────────────────────────────────

/// `_clamp01(x)` body: `max(0.0, min(1.0, float(x)))` — COMPARISON semantics
/// (§8), so NaN clamps to 1.0 and -0.0 to positive 0.0.
fn clamp01_of<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    let f = float_of(py, x)?;
    let v: f64 = f.extract()?;
    let lo = if v < 1.0 { v } else { 1.0 };
    let hi = if lo > 0.0 { lo } else { 0.0 };
    Ok(flt(py, hi))
}

/// `_frac(numer, denom)`: None when `denom <= 0` (the comparison is a live
/// operator call), else the clamped true division.
fn frac_of<'py>(py: Python<'py>, numer: &B<'py>, denom: &B<'py>) -> PyResult<B<'py>> {
    if opb(py, "le", denom, &obj(py, 0)?)? {
        return Ok(none(py));
    }
    let q = op(py, "truediv", numer, denom)?;
    clamp01_of(py, &q)
}

// ── Advisory (non-frozen dataclass) ─────────────────────────────────────────

/// The advisory output for one batch run.
///
/// Attributes:
///     scores: per-criterion score (0..1) or None if not computable.
///     overall: mean of non-None criterion scores, or None if none computable.
///     parent_note: one-sentence summary for the parent agent.
///     details: per-criterion human-readable breakdown.
#[pyclass(module = "orchestration_advisory", name = "Advisory")]
struct Advisory {
    #[pyo3(get, set)]
    scores: PyObject,
    #[pyo3(get, set)]
    overall: PyObject,
    #[pyo3(get, set)]
    parent_note: PyObject,
    #[pyo3(get, set)]
    details: PyObject,
}

const ADVISORY_FIELDS: [&str; 4] = ["scores", "overall", "parent_note", "details"];

#[pymethods]
impl Advisory {
    #[new]
    #[pyo3(signature = (*args, **kwargs))]
    fn py_new<'py>(
        py: Python<'py>,
        args: &Bound<'py, PyTuple>,
        kwargs: Option<&Bound<'py, PyDict>>,
    ) -> PyResult<Self> {
        let s = bind_init(py, "Advisory", &ADVISORY_FIELDS, args, kwargs)?;
        Ok(Advisory {
            scores: s[0].clone_ref(py),
            overall: s[1].clone_ref(py),
            parent_note: s[2].clone_ref(py),
            details: s[3].clone_ref(py),
        })
    }

    fn __repr__<'py>(&self, py: Python<'py>) -> PyResult<B<'py>> {
        let r = |v: &PyObject| -> PyResult<B<'py>> { bi1(py, "repr", v.bind(py)) };
        concat(
            py,
            vec![
                ps(py, "Advisory(scores="),
                r(&self.scores)?,
                ps(py, ", overall="),
                r(&self.overall)?,
                ps(py, ", parent_note="),
                r(&self.parent_note)?,
                ps(py, ", details="),
                r(&self.details)?,
                ps(py, ")"),
            ],
        )
    }

    /// dataclass __eq__: field-tuple equality ONLY when
    /// `other.__class__ is self.__class__`, else NotImplemented.
    fn __eq__<'py>(&self, py: Python<'py>, other: &B<'py>) -> PyResult<PyObject> {
        let cls = <Advisory as pyo3::PyTypeInfo>::type_object_bound(py);
        if !other.get_type().is(&cls) {
            return Ok(py.NotImplemented());
        }
        let o = other.extract::<PyRef<'py, Advisory>>()?;
        let mine = PyTuple::new_bound(
            py,
            [
                self.scores.bind(py),
                self.overall.bind(py),
                self.parent_note.bind(py),
                self.details.bind(py),
            ],
        )
        .into_any();
        let theirs = PyTuple::new_bound(
            py,
            [
                o.scores.bind(py),
                o.overall.bind(py),
                o.parent_note.bind(py),
                o.details.bind(py),
            ],
        )
        .into_any();
        let eq = op(py, "eq", &mine, &theirs)?;
        Ok(eq.unbind())
    }

    /// the dataclass sets `__hash__ = None` (eq=True default): instances are
    /// unhashable, with the interpreter's own wording.
    fn __hash__(&self) -> PyResult<isize> {
        Err(PyTypeError::new_err("unhashable type: 'Advisory'"))
    }
}

// ── _compose_note ───────────────────────────────────────────────────────────

fn compose_note_impl<'py>(
    py: Python<'py>,
    scores: &B<'py>,
    overall: &B<'py>,
    ok_count: &B<'py>,
    total: &B<'py>,
    blocked: &B<'py>,
) -> PyResult<B<'py>> {
    if opb(py, "eq", total, &obj(py, 0)?)? {
        return Ok(ps(py, "No sub-agents were dispatched."));
    }

    let mut parts: Vec<B<'py>> = Vec::new();
    parts.push(concat(
        py,
        vec![
            fmtv(py, total)?,
            ps(py, " 个子代理中 "),
            fmtv(py, ok_count)?,
            ps(py, " 个成功"),
        ],
    )?);

    if opb(py, "gt", blocked, &obj(py, 0)?)? {
        parts.push(concat(
            py,
            vec![fmtv(py, blocked)?, ps(py, " 个因租约冲突被阻塞")],
        )?);
    }

    if !overall.is_none() {
        let graded = if opb(py, "ge", overall, &flt(py, 0.85))? {
            ps(py, "整体协调优秀")
        } else if opb(py, "ge", overall, &flt(py, 0.6))? {
            ps(py, "整体协调良好")
        } else if opb(py, "ge", overall, &flt(py, 0.4))? {
            ps(py, "协调一般，建议检查失败项")
        } else {
            ps(py, "协调较差，建议重试或重新规划")
        };
        parts.push(graded);
    }

    // weak = [(k, v) for k, v in scores.items() if v is not None and v < 0.5]
    let items = scores.call_method0("items")?;
    let mut weak: Vec<B<'py>> = Vec::new();
    for item in items.iter()? {
        let item = item?;
        let pair = unpack_n(py, &item, 2)?;
        let k = &pair[0];
        let v = &pair[1];
        if !v.is_none() && opb(py, "lt", v, &flt(py, 0.5))? {
            weak.push(PyTuple::new_bound(py, [k.clone(), v.clone()]).into_any());
        }
    }
    if !weak.is_empty() {
        let weakest = min_key_sub1(py, &weak)?;
        let wk = weakest.get_item(0)?;
        let wv = weakest.get_item(1)?;
        let cn = own(py, "_CRITERIA_CN")?.get_item(&wk)?;
        parts.push(concat(
            py,
            vec![
                ps(py, "最弱项: "),
                fmtv(py, &cn)?,
                ps(py, " ("),
                fmts(py, &wv, ".0%")?,
                ps(py, ")"),
            ],
        )?);
    }

    let joined = ps(py, "；").call_method1("join", (PyList::new_bound(py, parts),))?;
    op(py, "add", &joined, &ps(py, "。"))
}

// ── assess_batch ────────────────────────────────────────────────────────────

fn assess_batch_impl<'py>(py: Python<'py>, results: &B<'py>) -> PyResult<B<'py>> {
    let n_obj = len_of(py, results)?;
    let n: i64 = n_obj.extract()?;
    if n == 0 {
        // §1: dict comprehensions over the module global, read at call time.
        let crit = own(py, "_CRITERIA")?;
        let scores = PyDict::new_bound(py);
        for k in crit.iter()? {
            scores.set_item(k?, py.None())?;
        }
        let details = PyDict::new_bound(py);
        for k in crit.iter()? {
            details.set_item(k?, ps(py, "no data"))?;
        }
        let kw = PyDict::new_bound(py);
        kw.set_item("scores", &scores)?;
        kw.set_item("overall", py.None())?;
        kw.set_item("parent_note", ps(py, "No sub-agents were dispatched."))?;
        kw.set_item("details", &details)?;
        return own(py, "Advisory")?.call((), Some(&kw));
    }

    // §4: eight separate passes over `results`.
    let true_o = true_obj(py)?;
    let false_o = false_obj(py)?;

    // ── 1. success_rate ─────────────────────────────────────────────────
    let ok_count = pass_count(results, |r| {
        let v = r.call_method1("get", (ps(py, "ok"),))?;
        Ok(v.is(&true_o))
    })?;
    let ok_obj = obj(py, ok_count)?;
    let success_rate = frac_of(py, &ok_obj, &n_obj)?;

    // ── 2. contract_pass_rate ───────────────────────────────────────────
    // §3: the error .get runs only when the ok identity test passed.
    let needle = ps(py, "result contract rejected");
    let contract_passes = pass_count(results, |r| {
        let ok = r.call_method1("get", (ps(py, "ok"),))?;
        if !ok.is(&true_o) {
            return Ok(false);
        }
        let err = r.call_method1("get", (ps(py, "error"), ps(py, "")))?;
        let err_s = str_of(py, &err)?;
        Ok(!contains(py, &err_s, &needle)?)
    })?;
    let rejected_by_contract = pass_count(results, |r| {
        let ok = r.call_method1("get", (ps(py, "ok"),))?;
        if !ok.is(&false_o) {
            return Ok(false);
        }
        let err = r.call_method1("get", (ps(py, "error"), ps(py, "")))?;
        let err_s = str_of(py, &err)?;
        Ok(contains(py, &err_s, &needle)?)
    })?;
    let cp_obj = obj(py, contract_passes)?;
    let rej_obj = obj(py, rejected_by_contract)?;
    let denom = op(py, "add", &cp_obj, &rej_obj)?;
    let contract_pass_rate = frac_of(py, &cp_obj, &denom)?;

    // ── 3. parallelism_util ─────────────────────────────────────────────
    let started_at: Vec<B<'py>> = {
        let mut v: Vec<B<'py>> = Vec::new();
        let zero = obj(py, 0)?;
        for r in results.iter()? {
            let r = r?;
            let raw = r.call_method1("get", (ps(py, "startedAt"), &zero))?;
            v.push(orv(&raw, &zero)?);
        }
        v
    };
    let zero = obj(py, 0)?;
    let mut any_pos = false;
    for t in &started_at {
        if opb(py, "gt", t, &zero)? {
            any_pos = true;
            break;
        }
    }
    let parallelism_util = if any_pos {
        // §6: `t > 0` is re-evaluated per item inside each filter generator.
        let mut filtered: Vec<B<'py>> = Vec::new();
        for t in &started_at {
            if opb(py, "gt", t, &zero)? {
                filtered.push(t.clone());
            }
        }
        let min_t = py_minmax(py, &filtered, false)?;
        let max_t = py_minmax(py, &filtered, true)?;
        let span = op(py, "sub", &max_t, &min_t)?;
        if opb(py, "le", &span, &flt(py, 2.0))? {
            flt(py, 1.0)
        } else {
            let scaled = op(py, "truediv", &span, &flt(py, 30.0))?;
            let inverted = op(py, "sub", &flt(py, 1.0), &scaled)?;
            clamp01_of(py, &inverted)?
        }
    } else {
        if ok_count == n {
            flt(py, 1.0)
        } else {
            flt(py, 0.5)
        }
    };

    // ── 4. cost_efficiency ──────────────────────────────────────────────
    let total_chars = pass_count_charlen(results)?;
    let total_obj = obj(py, total_chars)?;
    let est_tokens = op(py, "truediv", &total_obj, &flt(py, 3.0))?;
    let cost_efficiency = if opb(py, "gt", &est_tokens, &obj(py, 0)?)? {
        let per = op(py, "truediv", &est_tokens, &flt(py, 2000.0))?;
        let ratio = op(py, "truediv", &ok_obj, &per)?;
        clamp01_of(py, &ratio)?
    } else {
        none(py)
    };

    // ── 5. lease_health ─────────────────────────────────────────────────
    let blocked = pass_count_blocked(results)?;
    let blocked_obj = obj(py, blocked)?;
    let remaining = op(py, "sub", &n_obj, &blocked_obj)?;
    let lease_health = frac_of(py, &remaining, &n_obj)?;

    // ── 6. result_quality ───────────────────────────────────────────────
    let marked_done = pass_count(results, |r| {
        let v = r.call_method1("get", (ps(py, "final_marker"),))?;
        Ok(v.is(&true_o))
    })?;
    let marked_obj = obj(py, marked_done)?;
    let has_output = pass_count(results, |r| {
        let raw = r.call_method1("get", (ps(py, "text"), ps(py, "")))?;
        let t = orv(&raw, &ps(py, ""))?;
        let s = str_of(py, &t)?;
        let stripped = s.call_method0("strip")?;
        let l = len_of(py, &stripped)?;
        Ok(opb(py, "gt", &l, &obj(py, 20)?)?)
    })?;
    let has_obj = obj(py, has_output)?;
    let m1 = frac_of(py, &marked_obj, &n_obj)?;
    let m2 = frac_of(py, &has_obj, &n_obj)?;
    let result_quality = if !m1.is_none() && !m2.is_none() {
        let sum = op(py, "add", &m1, &m2)?;
        op(py, "truediv", &sum, &flt(py, 2.0))?
    } else if !m1.is_none() {
        m1
    } else if !m2.is_none() {
        m2
    } else {
        none(py)
    };

    // ── aggregate ───────────────────────────────────────────────────────
    let scores = PyDict::new_bound(py);
    scores.set_item("success_rate", &success_rate)?;
    scores.set_item("contract_pass_rate", &contract_pass_rate)?;
    scores.set_item("parallelism_util", &parallelism_util)?;
    scores.set_item("cost_efficiency", &cost_efficiency)?;
    scores.set_item("lease_health", &lease_health)?;
    scores.set_item("result_quality", &result_quality)?;

    let values = scores.call_method0("values")?;
    let mut present: Vec<B<'py>> = Vec::new();
    for v in values.iter()? {
        let v = v?;
        if !v.is_none() {
            present.push(v);
        }
    }
    let overall = if !present.is_empty() {
        let cnt = obj(py, present.len() as i64)?;
        let list = PyList::new_bound(py, present);
        let total_sum = call_bi(py, "sum", (&list,))?;
        let mean = op(py, "truediv", &total_sum, &cnt)?;
        call_bi(py, "round", (mean, obj(py, 3)?))?
    } else {
        none(py)
    };

    // ── details ─────────────────────────────────────────────────────────
    let details = PyDict::new_bound(py);
    details.set_item(
        "success_rate",
        concat(
            py,
            vec![
                fmtv(py, &ok_obj)?,
                ps(py, "/"),
                fmtv(py, &n_obj)?,
                ps(py, " succeeded"),
            ],
        )?,
    )?;
    if opb(py, "gt", &denom, &obj(py, 0)?)? {
        details.set_item(
            "contract_pass_rate",
            concat(
                py,
                vec![
                    fmtv(py, &cp_obj)?,
                    ps(py, " passed, "),
                    fmtv(py, &rej_obj)?,
                    ps(py, " rejected by contract"),
                ],
            )?,
        )?;
    } else {
        details.set_item("contract_pass_rate", ps(py, "no contract data"))?;
    }
    details.set_item(
        "parallelism_util",
        concat(
            py,
            vec![
                ps(py, "parallelism utilization: "),
                fmts(py, &parallelism_util, ".0%")?,
            ],
        )?,
    )?;
    if !cost_efficiency.is_none() {
        let est_int = call_bi(py, "int", (&est_tokens,))?;
        details.set_item(
            "cost_efficiency",
            concat(
                py,
                vec![
                    ps(py, "~"),
                    fmtv(py, &est_int)?,
                    ps(py, " tokens for "),
                    fmtv(py, &ok_obj)?,
                    ps(py, " results"),
                ],
            )?,
        )?;
    } else {
        details.set_item("cost_efficiency", ps(py, "no output data"))?;
    }
    details.set_item(
        "lease_health",
        concat(
            py,
            vec![
                fmtv(py, &blocked_obj)?,
                ps(py, " blocked by lease contention"),
            ],
        )?,
    )?;
    details.set_item(
        "result_quality",
        concat(
            py,
            vec![
                fmtv(py, &marked_obj)?,
                ps(py, " declared done, "),
                fmtv(py, &has_obj)?,
                ps(py, " have substantive output"),
            ],
        )?,
    )?;

    let parent_note = compose_note_impl(py, scores.as_any(), &overall, &ok_obj, &n_obj, &blocked_obj)?;

    let kw = PyDict::new_bound(py);
    kw.set_item("scores", scores)?;
    kw.set_item("overall", &overall)?;
    kw.set_item("parent_note", &parent_note)?;
    kw.set_item("details", details)?;
    own(py, "Advisory")?.call((), Some(&kw))
}

/// `sum(len(str(r.get("text", "") or "")) for r in results)` — §9: code-point
/// lengths of the `__str__`-ed text (or of "" when the value is falsy).
fn pass_count_charlen(results: &Bound<'_, PyAny>) -> PyResult<i64> {
    let mut total: i64 = 0;
    for r in results.iter()? {
        let r = r?;
        let raw = r.call_method1("get", (ps(results.py(), "text"), ps(results.py(), "")))?;
        let t = orv(&raw, &ps(results.py(), ""))?;
        let s = str_of(results.py(), &t)?;
        let l = len_of(results.py(), &s)?;
        total += l.extract::<i64>()?;
    }
    Ok(total)
}

/// the blocked counter: `status == "blocked" or "租约" in str(
/// r.get("blockedReason", "")) or "lease" in str(r.get("blockedReason",
/// "")).lower()` — §10 short-circuits and reads blockedReason twice on a miss.
fn pass_count_blocked(results: &Bound<'_, PyAny>) -> PyResult<i64> {
    let py = results.py();
    let mut blocked: i64 = 0;
    for r in results.iter()? {
        let r = r?;
        let status = r.call_method1("get", (ps(py, "status"),))?;
        if opb(py, "eq", &status, &ps(py, "blocked"))? {
            blocked += 1;
            continue;
        }
        let br = r.call_method1("get", (ps(py, "blockedReason"), ps(py, "")))?;
        let br_s = str_of(py, &br)?;
        if contains(py, &br_s, &ps(py, "租约"))? {
            blocked += 1;
            continue;
        }
        let br2 = r.call_method1("get", (ps(py, "blockedReason"), ps(py, "")))?;
        let br2_s = str_of(py, &br2)?;
        let lowered = br2_s.call_method0("lower")?;
        if contains(py, &lowered, &ps(py, "lease"))? {
            blocked += 1;
        }
    }
    Ok(blocked)
}

// ── exported callables ──────────────────────────────────────────────────────

/// Score a batch of sub-agent results on six criteria.
///
/// Args:
///     results: list of dicts as returned by ``SubagentRuntime.spawn_batch``
///         (keys: ok, type, label, text, error, subagent_id, stale,
///         final_marker, mergeNote, status, blockedReason).
///
/// Returns:
///     An ``Advisory`` with per-criterion scores, overall score, and a
///     parent-facing note.
#[pyfunction]
#[pyo3(name = "assess_batch", signature = (*args, **kwargs))]
fn py_assess_batch<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("assess_batch", &["results"], 1, args, kwargs)?;
    let results = slots[0].as_ref().expect("validated by bind_call");
    Ok(assess_batch_impl(py, results)?.unbind())
}

/// One factual sentence for the parent agent.
#[pyfunction]
#[pyo3(name = "_compose_note", signature = (*args, **kwargs))]
fn py_compose_note<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call(
        "_compose_note",
        &["scores", "overall", "ok_count", "total", "blocked"],
        5,
        args,
        kwargs,
    )?;
    let pick = |i: usize| -> B<'py> { slots[i].as_ref().expect("validated by bind_call").clone() };
    Ok(compose_note_impl(py, &pick(0), &pick(1), &pick(2), &pick(3), &pick(4))?.unbind())
}

/// Safe fraction: None when denominator is 0 (not computable).
#[pyfunction]
#[pyo3(name = "_frac", signature = (*args, **kwargs))]
fn py_frac<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("_frac", &["numer", "denom"], 2, args, kwargs)?;
    let numer = slots[0].as_ref().expect("validated by bind_call");
    let denom = slots[1].as_ref().expect("validated by bind_call");
    Ok(frac_of(py, numer, denom)?.unbind())
}

/// `_clamp01(x)`: the comparison clamp (§8) — NaN lands on 1.0, -0.0 on +0.0.
#[pyfunction]
#[pyo3(name = "_clamp01", signature = (*args, **kwargs))]
fn py_clamp01<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("_clamp01", &["x"], 1, args, kwargs)?;
    let x = slots[0].as_ref().expect("validated by bind_call");
    Ok(clamp01_of(py, x)?.unbind())
}

// ── registration ────────────────────────────────────────────────────────────

pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(py, "orchestration_advisory")?;
    m.add_function(wrap_pyfunction!(py_assess_batch, &m)?)?;
    m.add_function(wrap_pyfunction!(py_compose_note, &m)?)?;
    m.add_function(wrap_pyfunction!(py_frac, &m)?)?;
    m.add_function(wrap_pyfunction!(py_clamp01, &m)?)?;
    m.add_class::<Advisory>()?;

    let criteria = PyList::new_bound(
        py,
        [
            "success_rate",
            "contract_pass_rate",
            "parallelism_util",
            "cost_efficiency",
            "lease_health",
            "result_quality",
        ],
    );
    m.add("_CRITERIA", criteria)?;
    let cn = PyDict::new_bound(py);
    cn.set_item("success_rate", "成功率")?;
    cn.set_item("contract_pass_rate", "契约通过率")?;
    cn.set_item("parallelism_util", "并行利用率")?;
    cn.set_item("cost_efficiency", "成本效率")?;
    cn.set_item("lease_health", "租约健康度")?;
    cn.set_item("result_quality", "结果质量")?;
    m.add("_CRITERIA_CN", cn)?;

    // import-time names the python module binds (stdlib, no cycle risk).
    m.add("dataclasses", mod_import(py, "dataclasses")?)?;
    m.add("List", mod_import(py, "typing")?.getattr("List")?)?;
    m.add("Optional", mod_import(py, "typing")?.getattr("Optional")?)?;

    *ST.lock() = Some(m.clone().unbind());
    parent.add_submodule(&m)?;
    Ok(())
}
