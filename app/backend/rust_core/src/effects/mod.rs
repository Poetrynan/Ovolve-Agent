//! effects — Rust port of `app/backend/effects.py` (wave-6, Native→Rust).
//!
//! Typed side-effect ledger: identity (`operation_id`), observed
//! precondition, planned postcondition, and `reconcile` — the "did my
//! interrupted write/commit actually land?" verdict computed from the world
//! (file bytes, repository state) rather than from the transcript.
//!
//! Port posture (mailbox / computer_agent precedent): every value flows as a
//! live CPython object. `os.path.isabs/join/normpath/abspath/exists/dirname/
//! stat`, `os.name`, `os.linesep`, `open(...).read()`, `hashlib.sha256`,
//! `json.dumps/loads` (with the real `sort_keys` / `ensure_ascii` /
//! `default=str` kwargs), `str()`/`int()`/`float()`/`bool()`/`dict()`/
//! `list()`/`repr()`/`format()`/`isinstance`-equivalents and every `or`
//! short-circuit go to the real modules and builtins, so exception types and
//! messages, dict key insertion order, `[:16]`/`[:32]` slices, truthiness and
//! the exact argv/kwargs handed to `executors.tracked_run` match the
//! canonical implementation by construction, not by re-derivation.
//!
//! Bug-for-bug items kept verbatim (each pinned by smoke/parity_effects.py):
//! §1 `canonical_target` returns the *stringified* `raw` (not "") when the
//!    abspath/normpath chain raises, and only case-folds on `os.name == "nt"`.
//! §2 `file_state` never raises: a missing/unreadable file yields a partial
//!    dict, an oversized one yields the `size:<n>:mtime:<int>` pseudo-hash, and
//!    a read `OSError` downgrades to `{"exists": True, "hash": ""}`.
//! §3 `state_hash` returns `opaque:<size>` only when the hash is empty — and
//!    `state.get('size', 0)` uses an explicit 0 default, so a hash-only dict
//!    produces `opaque:0`.
//! §4 `repo_root` walks up at most 64 levels and accepts `.git` as file *or*
//!    directory (`os.path.exists`, not `isdir`).
//! §5 `_git_out` swallows EVERY exception (including a missing `executors`)
//!    into `(False, "")`, treats a missing `returncode` attribute as 1 (⇒
//!    failure) and a missing `stdout` as "" — and returns a *tuple*.
//! §6 `git_state` strips HEAD/branch but hashes staged/dirty **unstripped**,
//!    and only records `branch_exists` when `branch_of_interest` is truthy
//!    (a 6th key that is otherwise absent).
//! §7 `_dec` returns {} for a descriptor with the wrong prefix, for broken
//!    JSON, and for JSON that decodes to a non-dict.
//! §8 `classify` returns None (not a typed effect) for `git_branch` with an
//!    action outside ("create","switch") — the default is the string "list" —
//!    for a git tool outside a repo, and for a missing/empty target argument;
//!    `move_file` keys its target on `dst` and adds a `source` from `src`.
//! §9 `planned_state_hash` returns "" for `write_file` with a truthy `append`,
//!    for non-str content, and for an unusable encoding (LookupError /
//!    UnicodeEncodeError); it translates "\n" through `os.linesep` before
//!    hashing; `delete_file` → `<missing>`; `copy_file`/`move_file` hash the
//!    *source*'s current state, and an empty `src` gives "".
//! §10 `snapshot_hash` returns "" for a falsy effect and for a git repo it
//!     cannot read; only `git_branch` contributes `branch_of_interest`.
//! §11 `reconcile` truncates every detail field at 16 characters, reports
//!     `unknown` when the target or its current state is missing, prefers
//!     `landed` over `not_started`, and never invents a `conflict` without a
//!     plan.
//! §12 `_reconcile_git` decides `git_add`/`git_pull` purely on "nothing moved"
//!     (HEAD, staged AND dirty equal) and `_reconcile_push` can only ever
//!     answer `landed`/`unknown`; a `branch` of "HEAD" (detached) is unknown.
//! §13 `intent_hash` falls back to `f"{tool}:{args!r}"` only when json fails;
//!     the subsequent strict `.encode("utf-8")` is NOT protected, so a
//!     surrogate-bearing request raises UnicodeEncodeError out of the hash.
//!
//! DIVERGENCE(port, seams): `time.time()` inside `EffectRecord` resolves
//!     through the real module in production; `_set_seams(time_fn=...)` swaps
//!     it for the parity probe only (same `*_SEAMS` convention as mailbox /
//!     cron_manager). Product code never calls it; unsetting restores the live
//!     path, which is the default state.
//! DIVERGENCE(port, EffectRecord is a pyclass): `to_dict`, `from_row`,
//!     `__repr__`, `__eq__` and the unhashable `__hash__` are all reproduced
//!     with the dataclass's own semantics (attribute order, `!r` per field,
//!     tuple equality, `other.__class__ is self.__class__` gate). What differs
//!     is *metaclass introspection*: `dataclasses.fields/asdict/replace` raise
//!     on this class. Nothing in the repository calls them on EffectRecord
//!     (grep-verified: the type is referenced only inside effects.py itself).
//! DIVERGENCE(port, __init__ defaults): pyo3 hands an omitted `Option<T>`
//!     argument and an explicit `None` to Rust identically, while the
//!     dataclass-generated `__init__` distinguishes them. The exposed `__init__`
//!     therefore defaults every optional parameter to the float
//!     [`UNSET`] (= `f64::MIN`, checked with real `==`) and stores anything
//!     else verbatim, so `EffectRecord("op", status=None)` keeps None exactly
//!     as CPython does. Only a caller passing that one float literal could be
//!     mistaken for "absent"; the dataclass's own `TypeError` texts for a
//!     missing/unknown argument are not reproduced (no call site does either).
//! DIVERGENCE(port, f-strings): interpolation uses the real `format(x, "")`
//!     builtin — the exact call CPython f-strings compile to — so exotic
//!     `__format__` implementations behave identically; `.join` assembles the
//!     pieces in the source's order.
//! DIVERGENCE(port, tb): `with open(...) as fh` passes None as the traceback
//!     argument on the clean path and (type, value, None) on the raising path
//!     (pyo3 0.22 exposes no traceback handle); file objects ignore it.
// PORT STATUS: confidence=high todos=[0]

use parking_lot::Mutex;
use pyo3::exceptions::{
    PyAttributeError, PyLookupError, PyOSError, PyTypeError, PyUnicodeEncodeError, PyValueError,
};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyFloat, PyList, PyString, PyTuple, PyType};

type B<'py> = Bound<'py, PyAny>;

// ── module constants (effects.py:63-120) ────────────────────────────────────

const MAX_HASH_BYTES: i64 = 8 * 1024 * 1024;

const KIND_FILE_WRITE: &str = "file_write";
const KIND_FILE_DELETE: &str = "file_delete";
const KIND_FILE_MOVE: &str = "file_move";
const KIND_GIT_COMMIT: &str = "git_commit";
const KIND_GIT_BRANCH: &str = "git_branch";
const KIND_GIT_STAGE: &str = "git_stage";
const KIND_GIT_PUSH: &str = "git_push";
const KIND_GIT_PULL: &str = "git_pull";

const STATUS_PLANNED: &str = "planned";
const STATUS_STARTED: &str = "started";
const STATUS_LANDED: &str = "landed";
const STATUS_VERIFIED: &str = "verified";
const STATUS_NOT_STARTED: &str = "not_started";
const STATUS_CONFLICT: &str = "conflict";
const STATUS_UNKNOWN: &str = "unknown";
const STATUS_REVERTED: &str = "reverted";

const MISSING: &str = "<missing>";
const GIT_STATE_PREFIX: &str = "git:";
const GIT_PLAN_PREFIX: &str = "gitplan:";

/// field order of EffectRecord (dataclass declaration order; drives to_dict,
/// __repr__ and __eq__ exactly like `dataclasses.fields`).
const REC_FIELDS: [&str; 18] = [
    "operation_id",
    "goal_id",
    "run_id",
    "activity_id",
    "tool_call_id",
    "effect_kind",
    "target",
    "intent_hash",
    "precondition",
    "precondition_hash",
    "planned_payload_hash",
    "status",
    "postcondition",
    "postcondition_hash",
    "verification_evidence_refs",
    "attempt_count",
    "created_at",
    "updated_at",
];

/// pyo3 reports an omitted `Option<Py<PyAny>>` argument and an explicit
/// `None` the same way, but the dataclass __init__ the port mirrors treats
/// them differently (`status=None` stores None, `status` absent stores
/// "planned"). The exposed __init__ therefore defaults every optional
/// parameter to this float and compares with real `==`; a caller would have
/// to pass exactly -1.7976931348623157e308 to be mistaken for "absent".
const UNSET: f64 = f64::MIN;

/// [`UNSET`] as a live Python float, for use as a pyo3 signature default (a
/// default expression must match the parameter's Rust type, and `Py<PyAny>`
/// cannot be built in const context).
fn unset_obj() -> Py<PyAny> {
    Python::with_gil(|py| PyFloat::new_bound(py, UNSET).into_any().unbind())
}

struct St {
    time_fn: Option<Py<PyAny>>,
    tool_effects: Option<Py<PyAny>>,
    git_tool_effects: Option<Py<PyAny>>,
    git_kinds: Option<Py<PyAny>>,
    statuses: Option<Py<PyAny>>,
}
static ST: Mutex<St> = Mutex::new(St {
    time_fn: None,
    tool_effects: None,
    git_tool_effects: None,
    git_kinds: None,
    statuses: None,
});

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

fn py_bool<'py>(py: Python<'py>, v: bool) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr(if v { "True" } else { "False" })?)
}

/// real builtin call: int(x) / bool(x) / dict(x) / list(x) / float(x) / repr(x)
fn bi1<'py>(py: Python<'py>, name: &str, x: &B<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr(name)?.call1((x,))?)
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

/// `"".join(parts)` / `sep.join(parts)`.
fn join_with<'py>(py: Python<'py>, sep: &B<'py>, parts: Vec<B<'py>>) -> PyResult<B<'py>> {
    let list = PyList::new_bound(py, parts);
    Ok(sep.call_method1("join", (&list,))?)
}

/// `x[:stop]`
fn head<'py>(py: Python<'py>, x: &B<'py>, stop: i32) -> PyResult<B<'py>> {
    let sl = builtins(py)?.getattr("slice")?.call1((none(py), stop))?;
    Ok(x.get_item(sl)?)
}

/// `x[start:]`
fn tail<'py>(py: Python<'py>, x: &B<'py>, start: i32) -> PyResult<B<'py>> {
    let sl = builtins(py)?.getattr("slice")?.call1((start, none(py)))?;
    Ok(x.get_item(sl)?)
}

/// `d.get(key)` → None when absent (real dict method, so a non-mapping `d`
/// raises AttributeError exactly like python).
fn gget<'py>(py: Python<'py>, d: &B<'py>, key: &str) -> PyResult<B<'py>> {
    Ok(d.call_method1("get", (ps(py, key),))?)
}

/// `d.get(key, default)`
fn gget_d<'py>(py: Python<'py>, d: &B<'py>, key: &str, default: &B<'py>) -> PyResult<B<'py>> {
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

/// `x in coll`
fn contains<'py>(coll: &B<'py>, x: &B<'py>) -> PyResult<bool> {
    Ok(coll.call_method1("__contains__", (x,))?.is_truthy()?)
}

/// `hasattr(x, "keys")` (python: catches AttributeError, nothing else).
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

/// `x is y` by pointer identity (True/False singletons).
fn same(a: &B<'_>, b: &B<'_>) -> bool {
    a.as_ptr() == b.as_ptr()
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

// ── lazily-built module tables (python: import-time literals) ───────────────

fn cached<'py>(
    py: Python<'py>,
    slot: &Option<Py<PyAny>>,
) -> Option<B<'py>> {
    slot.as_ref().map(|p| p.clone_ref(py).into_bound(py))
}

fn tool_effects<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    if let Some(c) = cached(py, &ST.lock().tool_effects) {
        return Ok(c);
    }
    let row = |py: Python<'py>, k: &str, kind: &str, arg: &str| -> PyResult<(String, B<'py>)> {
        let t = PyTuple::new_bound(py, vec![ps(py, kind), ps(py, arg)]);
        Ok((k.to_string(), t.into_any()))
    };
    let d = PyDict::new_bound(py);
    for (k, v) in [
        row(py, "write_file", KIND_FILE_WRITE, "path")?,
        row(py, "edit_file", KIND_FILE_WRITE, "path")?,
        row(py, "delete_file", KIND_FILE_DELETE, "path")?,
        row(py, "move_file", KIND_FILE_MOVE, "dst")?,
        row(py, "copy_file", KIND_FILE_WRITE, "dst")?,
    ] {
        d.set_item(k, v)?;
    }
    ST.lock().tool_effects = Some(d.clone().into_any().unbind());
    Ok(d.into_any())
}

fn git_tool_effects<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    if let Some(c) = cached(py, &ST.lock().git_tool_effects) {
        return Ok(c);
    }
    let d = PyDict::new_bound(py);
    for (k, v) in [
        ("git_commit", KIND_GIT_COMMIT),
        ("git_add", KIND_GIT_STAGE),
        ("git_push", KIND_GIT_PUSH),
        ("git_pull", KIND_GIT_PULL),
        ("git_branch", KIND_GIT_BRANCH),
    ] {
        d.set_item(k, ps(py, v))?;
    }
    ST.lock().git_tool_effects = Some(d.clone().into_any().unbind());
    Ok(d.into_any())
}

fn frozenset_of<'py>(py: Python<'py>, vals: &[&str]) -> PyResult<B<'py>> {
    let t = PyTuple::new_bound(py, vals.iter().map(|v| ps(py, v)).collect::<Vec<_>>());
    Ok(builtins(py)?.getattr("frozenset")?.call1((t,))?)
}

fn git_kinds<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    if let Some(c) = cached(py, &ST.lock().git_kinds) {
        return Ok(c);
    }
    let s = frozenset_of(
        py,
        &[
            KIND_GIT_COMMIT,
            KIND_GIT_BRANCH,
            KIND_GIT_STAGE,
            KIND_GIT_PUSH,
            KIND_GIT_PULL,
        ],
    )?;
    ST.lock().git_kinds = Some(s.clone().unbind());
    Ok(s)
}

fn effect_statuses<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    if let Some(c) = cached(py, &ST.lock().statuses) {
        return Ok(c);
    }
    let s = frozenset_of(
        py,
        &[
            STATUS_PLANNED,
            STATUS_STARTED,
            STATUS_LANDED,
            STATUS_VERIFIED,
            STATUS_NOT_STARTED,
            STATUS_CONFLICT,
            STATUS_UNKNOWN,
            STATUS_REVERTED,
        ],
    )?;
    ST.lock().statuses = Some(s.clone().unbind());
    Ok(s)
}

/// `time.time()` — probe seam or the live module.
fn time_now<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let seam = ST.lock().time_fn.as_ref().map(|p| p.clone_ref(py));
    match seam {
        Some(f) => Ok(f.into_bound(py).call0()?),
        None => Ok(mod_import(py, "time")?.call_method0("time")?),
    }
}

/// "was this __init__ parameter left out?" — see [`UNSET`].
fn unset<'py>(v: &B<'py>) -> PyResult<bool> {
    if !v.is_instance_of::<PyFloat>() {
        return Ok(false);
    }
    v.eq(UNSET)
}

// ── _sha256 / _short ────────────────────────────────────────────────────────

/// `hashlib.sha256(data).hexdigest()` — data is whatever the caller hands over,
/// so a str argument raises the real TypeError.
fn sha256<'py>(py: Python<'py>, data: &B<'py>) -> PyResult<B<'py>> {
    let h = mod_import(py, "hashlib")?.call_method1("sha256", (data,))?;
    h.call_method0("hexdigest")
}

fn short<'py>(py: Python<'py>, blob: &B<'py>) -> PyResult<B<'py>> {
    let s = orstr(py, blob, "")?
        .call_method1("encode", (ps(py, "utf-8"), ps(py, "replace")))?;
    head(py, &sha256(py, &s)?, 32)
}

// ── canonical_target / file_state / state_hash ──────────────────────────────

fn canonical_target_core<'py>(
    py: Python<'py>,
    path: &B<'py>,
    workspace_root: &B<'py>,
) -> PyResult<B<'py>> {
    let raw = orstr(py, path, "")?;
    if !raw.is_truthy()? {
        return Ok(ps(py, ""));
    }
    let osp = mod_import(py, "os")?.getattr("path")?;
    let body: PyResult<B<'py>> = (|| {
        let isabs = osp.call_method1("isabs", (&raw,))?.is_truthy()?;
        let mut cur = raw.clone();
        if !isabs && workspace_root.is_truthy()? {
            cur = osp.call_method1("join", (workspace_root, &cur))?;
        }
        let ab = osp.call_method1("abspath", (&cur,))?;
        osp.call_method1("normpath", (&ab,))
    })();
    match body {
        Ok(o) => {
            let name = mod_import(py, "os")?.getattr("name")?;
            if name.extract::<String>()? == "nt" {
                let rep = o.call_method1("replace", (ps(py, "\\"), ps(py, "/")))?;
                rep.call_method0("lower")
            } else {
                Ok(o)
            }
        }
        // §1: a malformed path returns the *stringified input*, not "".
        Err(e) if is_py_exc(&e, py) => Ok(raw),
        Err(e) => Err(e),
    }
}

fn file_state_core<'py>(py: Python<'py>, path: &B<'py>) -> PyResult<B<'py>> {
    let size0 = obj(py, 0)?;
    let state = dict_of(
        py,
        &[
            ("exists", &py_bool(py, false)?),
            ("hash", &ps(py, "")),
            ("size", &size0),
        ],
    )?;
    let st = match mod_import(py, "os")?.call_method1("stat", (path,)) {
        Ok(v) => v,
        Err(e)
            if e.is_instance_of::<PyOSError>(py) || e.is_instance_of::<PyValueError>(py) =>
        {
            return Ok(state)
        }
        Err(e) => return Err(e),
    };
    state.set_item("exists", py_bool(py, true)?)?;
    let raw_size = getattr_d(&st, "st_size", obj(py, 0)?, py)?;
    let size = bi1(py, "int", &orv(&raw_size, &obj(py, 0)?)?)?;
    state.set_item("size", size.clone())?;
    if size.gt(obj(py, MAX_HASH_BYTES)?)? {
        // §2 f"size:{state['size']}:mtime:{int(getattr(st,'st_mtime',0))}"
        let m = bi1(
            py,
            "int",
            &getattr_d(&st, "st_mtime", obj(py, 0)?, py)?,
        )?;
        let h = join_with(
            py,
            &ps(py, ""),
            vec![
                ps(py, "size:"),
                fmtv(py, &state.get_item("size")?)?,
                ps(py, ":mtime:"),
                fmtv(py, &m)?,
            ],
        )?;
        state.set_item("hash", h)?;
        return Ok(state);
    }
    // with open(path, "rb") as fh: state["hash"] = _sha256(fh.read())
    match read_bytes(py, path) {
        Ok(data) => {
            state.set_item("hash", sha256(py, &data)?)?;
        }
        Err(e) if e.is_instance_of::<PyOSError>(py) => {
            state.set_item("hash", ps(py, ""))?;
        }
        Err(e) => return Err(e),
    }
    Ok(state)
}

/// `with open(path, mode) as fh: fh.read()`
fn read_bytes<'py>(py: Python<'py>, path: &B<'py>) -> PyResult<B<'py>> {
    let f = builtins(py)?
        .getattr("open")?
        .call1((path, ps(py, "rb")))?;
    match f.call_method0("__enter__") {
        Err(e) => Err(e),
        Ok(handle) => match handle.call_method0("read") {
            Ok(v) => {
                f.call_method1("__exit__", (none(py), none(py), none(py)))?;
                Ok(v)
            }
            Err(e) => {
                let val = e.value_bound(py);
                let ty = val.get_type();
                let _ = f.call_method1("__exit__", (ty, val, none(py)));
                Err(e)
            }
        },
    }
}

fn state_hash_core<'py>(py: Python<'py>, state: &B<'py>) -> PyResult<B<'py>> {
    if !state.is_truthy()? {
        return Ok(ps(py, MISSING));
    }
    if !gget(py, state, "exists")?.is_truthy()? {
        return Ok(ps(py, MISSING));
    }
    let h = orstr(
        py,
        &gget(py, state, "hash")?,
        "",
    )?;
    if h.is_truthy()? {
        return Ok(h);
    }
    let size = gget_d(py, state, "size", &obj(py, 0)?)?;
    join_with(
        py,
        &ps(py, ""),
        vec![ps(py, "opaque:"), fmtv(py, &size)?],
    )
}

fn repo_root_core<'py>(py: Python<'py>, path: &B<'py>) -> PyResult<B<'py>> {
    let cur = orstr(py, path, "")?;
    if !cur.is_truthy()? {
        return Ok(ps(py, ""));
    }
    let osp = mod_import(py, "os")?.getattr("path")?;
    let cur = match (|| -> PyResult<B<'py>> {
        let ab = osp.call_method1("abspath", (&cur,))?;
        osp.call_method1("normpath", (&ab,))
    })() {
        Ok(v) => v,
        Err(e) if is_py_exc(&e, py) => return Ok(ps(py, "")),
        Err(e) => return Err(e),
    };
    let mut cur = cur;
    for _ in 0..64 {
        let joined = osp.call_method1("join", (&cur, ps(py, ".git")))?;
        if osp.call_method1("exists", (&joined,))?.is_truthy()? {
            return Ok(cur);
        }
        let parent = osp.call_method1("dirname", (&cur,))?;
        if !parent.is_truthy()? || parent.eq(&cur)? {
            return Ok(ps(py, ""));
        }
        cur = parent;
    }
    Ok(ps(py, ""))
}

// ── git plumbing ────────────────────────────────────────────────────────────

/// `_git_out`: returns the tuple `(ok, stdout)`; every failure is `(False, "")`.
fn git_out<'py>(py: Python<'py>, repo: &B<'py>, args: &B<'py>) -> PyResult<B<'py>> {
    let call: PyResult<B<'py>> = (|| {
        let executors = py.import_bound("executors").map(|m| m.into_any());
        let tracked = match executors {
            Ok(m) => m.getattr("tracked_run")?,
            Err(e) if is_py_exc(&e, py) => {
                return Err(pyo3::exceptions::PyImportError::new_err(
                    "cannot import name 'tracked_run' from 'executors'",
                ))
            }
            Err(e) => return Err(e),
        };
        let l = bi1(py, "list", args)?;
        let pre = PyList::new_bound(
            py,
            vec![ps(py, "git"), ps(py, "-c"), ps(py, "core.quotePath=false")],
        );
        let argv = pre.into_any().call_method1("__add__", (&l,))?;
        let kw = PyDict::new_bound(py);
        kw.set_item("capture_output", py_bool(py, true)?)?;
        kw.set_item("text", py_bool(py, true)?)?;
        kw.set_item("encoding", ps(py, "utf-8"))?;
        kw.set_item("errors", ps(py, "replace"))?;
        kw.set_item("cwd", repo.clone())?;
        kw.set_item("timeout", obj(py, 15)?)?;
        tracked.call((argv,), Some(&kw))
    })();
    let proc = match call {
        Ok(v) => v,
        Err(e) if is_py_exc(&e, py) => {
            return Ok(PyTuple::new_bound(
                py,
                vec![py_bool(py, false)?, ps(py, "")],
            )
            .into_any())
        }
        Err(e) => return Err(e),
    };
    let rc = getattr_d(&proc, "returncode", obj(py, 1)?, py)?;
    if rc.ne(obj(py, 0)?)? {
        return Ok(PyTuple::new_bound(py, vec![py_bool(py, false)?, ps(py, "")]).into_any());
    }
    let out = orstr(py, &getattr_d(&proc, "stdout", ps(py, ""), py)?, "")?;
    Ok(PyTuple::new_bound(py, vec![py_bool(py, true)?, out]).into_any())
}

/// one-shot `(ok, stdout)` helper: the bool and the str of `_git_out`'s tuple.
fn git_out2<'py>(
    py: Python<'py>,
    repo: &B<'py>,
    cmd: Vec<&str>,
) -> PyResult<(bool, B<'py>)> {
    let args = PyList::new_bound(py, cmd.iter().map(|c| ps(py, c)).collect::<Vec<_>>());
    let t = git_out(py, repo, &args.into_any())?;
    let ok = t.get_item(0)?.is_truthy()?;
    let out = t.get_item(1)?;
    Ok((ok, out))
}

fn enc<'py>(py: Python<'py>, prefix: &B<'py>, o: &B<'py>) -> PyResult<B<'py>> {
    let body: PyResult<B<'py>> = (|| {
        let kw = PyDict::new_bound(py);
        kw.set_item("sort_keys", py_bool(py, true)?)?;
        kw.set_item("ensure_ascii", py_bool(py, false)?)?;
        kw.set_item("default", builtins(py)?.getattr("str")?)?;
        let dumped = mod_import(py, "json")?.call_method("dumps", (o,), Some(&kw))?;
        prefix.add(&dumped)
    })();
    match body {
        Ok(v) => Ok(v),
        Err(e) if is_py_exc(&e, py) => Ok(ps(py, "")),
        Err(e) => Err(e),
    }
}

fn dec<'py>(py: Python<'py>, prefix: &B<'py>, blob: &B<'py>) -> PyResult<B<'py>> {
    let raw = orstr(py, blob, "")?;
    let pre = raw.call_method1("startswith", (prefix,))?.is_truthy()?;
    if !pre {
        return Ok(empty_dict(py));
    }
    let plen = prefix.len()?;
    let body = tail(py, &raw, plen as i32);
    let out = match body.and_then(|s| mod_import(py, "json")?.call_method1("loads", (&s,))) {
        Ok(v) => v,
        Err(e) if is_py_exc(&e, py) => return Ok(empty_dict(py)),
        Err(e) => return Err(e),
    };
    if is_dict(&out) {
        Ok(out)
    } else {
        Ok(empty_dict(py))
    }
}

fn git_state_core<'py>(
    py: Python<'py>,
    repo: &B<'py>,
    branch_of_interest: &B<'py>,
) -> PyResult<B<'py>> {
    let state = dict_of(
        py,
        &[
            ("ok", &py_bool(py, false)?),
            ("head", &ps(py, "")),
            ("head_msg", &ps(py, "")),
            ("branch", &ps(py, "")),
            ("staged", &ps(py, "")),
            ("dirty", &ps(py, "")),
        ],
    )?;
    if !repo.is_truthy()? {
        return Ok(state);
    }
    let (ok, top) = git_out2(py, repo, vec!["rev-parse", "--is-inside-work-tree"])?;
    if !ok || top.call_method0("strip")?.ne(ps(py, "true"))? {
        return Ok(state);
    }
    state.set_item("ok", py_bool(py, true)?)?;
    let (ok, head) = git_out2(py, repo, vec!["rev-parse", "HEAD"])?;
    if ok {
        let hs = head.call_method0("strip")?;
        state.set_item("head", hs)?;
        let (ok_msg, msg) = git_out2(py, repo, vec!["log", "-1", "--pretty=%B"])?;
        let hm = if ok_msg {
            short(py, &msg.call_method0("strip")?)?
        } else {
            ps(py, "")
        };
        state.set_item("head_msg", hm)?;
    }
    let (ok, branch) = git_out2(py, repo, vec!["rev-parse", "--abbrev-ref", "HEAD"])?;
    let b = if ok {
        branch.call_method0("strip")?
    } else {
        ps(py, "")
    };
    state.set_item("branch", b)?;
    let (ok, staged) = git_out2(py, repo, vec!["diff", "--cached", "--name-status"])?;
    let s = if ok { short(py, &staged)? } else { ps(py, "") };
    state.set_item("staged", s)?;
    let (ok, dirty) = git_out2(py, repo, vec!["status", "--porcelain"])?;
    let d = if ok { short(py, &dirty)? } else { ps(py, "") };
    state.set_item("dirty", d)?;
    if branch_of_interest.is_truthy()? {
        let e = branch_exists_core(py, repo, branch_of_interest)?;
        state.set_item("branch_exists", e)?;
    }
    Ok(state)
}

fn branch_exists_core<'py>(py: Python<'py>, repo: &B<'py>, name: &B<'py>) -> PyResult<B<'py>> {
    if !(repo.is_truthy()? && name.is_truthy()?) {
        return py_bool(py, false);
    }
    let refspec = join_with(
        py,
        &ps(py, ""),
        vec![ps(py, "refs/heads/"), fmtv(py, name)?],
    )?;
    let args = PyList::new_bound(
        py,
        vec![
            ps(py, "rev-parse"),
            ps(py, "--verify"),
            ps(py, "--quiet"),
            refspec,
        ],
    );
    let t = git_out(py, repo, &args.into_any())?;
    Ok(t.get_item(0)?)
}

// ── classify / hashes ───────────────────────────────────────────────────────

fn classify_core<'py>(
    py: Python<'py>,
    tool_name: &B<'py>,
    args: &B<'py>,
    workspace_root: &B<'py>,
) -> PyResult<Option<B<'py>>> {
    let name_key = orstr(py, tool_name, "")?;
    let entry = tool_effects(py)?.call_method1("get", (&name_key,))?;
    if !entry.is_truthy()? {
        let git_kind = git_tool_effects(py)?.call_method1("get", (&name_key,))?;
        if !git_kind.is_truthy()? {
            return Ok(None);
        }
        // `git_branch action=list` reads; only create/switch change anything.
        if git_kind.eq(ps(py, KIND_GIT_BRANCH))? {
            let defaults = empty_dict(py);
            let action =
                orstr(py, &gget(py, &orv(args, &defaults)?, "action")?, "list")?;
            let allowed = PyTuple::new_bound(py, vec![ps(py, "create"), ps(py, "switch")]);
            if !contains(&allowed.into_any(), &action)? {
                return Ok(None);
            }
        }
        let repo = repo_root_core(py, workspace_root)?;
        if !repo.is_truthy()? {
            return Ok(None);
        }
        let target = canonical_target_core(py, &repo, &ps(py, ""))?;
        return Ok(Some(
            dict_of(
                py,
                &[
                    ("kind", &git_kind),
                    ("target", &target),
                    ("target_arg", &ps(py, "")),
                ],
            )?,
        ));
    }
    let kind = entry.get_item(0)?;
    let target_arg = entry.get_item(1)?;
    let defaults = empty_dict(py);
    let a = orv(args, &defaults)?;
    let raw_target = orstr(py, &a.call_method1("get", (&target_arg,))?, "")?;
    let target = canonical_target_core(py, &raw_target, workspace_root)?;
    if !target.is_truthy()? {
        return Ok(None);
    }
    let out = dict_of(
        py,
        &[
            ("kind", &kind),
            ("target", &target),
            ("target_arg", &target_arg),
        ],
    )?;
    if kind.eq(ps(py, KIND_FILE_MOVE))? {
        let src = orstr(py, &a.call_method1("get", (ps(py, "src"),))?, "")?;
        let source = canonical_target_core(py, &src, workspace_root)?;
        out.set_item("source", source)?;
    }
    Ok(Some(out))
}

fn intent_hash_core<'py>(py: Python<'py>, tool_name: &B<'py>, args: &B<'py>) -> PyResult<B<'py>> {
    let payload = dict_of(py, &[("tool", tool_name), ("args", args)])?;
    let body: PyResult<B<'py>> = (|| {
        let kw = PyDict::new_bound(py);
        kw.set_item("sort_keys", py_bool(py, true)?)?;
        kw.set_item("ensure_ascii", py_bool(py, false)?)?;
        kw.set_item("default", builtins(py)?.getattr("str")?)?;
        mod_import(py, "json")?.call_method("dumps", (&payload,), Some(&kw))
    })();
    let blob = match body {
        Ok(v) => v,
        Err(e) if is_py_exc(&e, py) => join_with(
            py,
            &ps(py, ""),
            vec![
                fmtv(py, tool_name)?,
                ps(py, ":"),
                bi1(py, "repr", args)?,
            ],
        )?,
        Err(e) => return Err(e),
    };
    sha256(py, &blob.call_method1("encode", (ps(py, "utf-8"),))?)
}

fn operation_id_core<'py>(
    py: Python<'py>,
    scope: &B<'py>,
    kind: &B<'py>,
    target: &B<'py>,
    intent: &B<'py>,
) -> PyResult<B<'py>> {
    let parts = vec![
        orstr(py, scope, "")?,
        orstr(py, kind, "")?,
        orstr(py, target, "")?,
        orstr(py, intent, "")?,
    ];
    let blob = join_with(py, &ps(py, "|"), parts)?;
    head(
        py,
        &sha256(py, &blob.call_method1("encode", (ps(py, "utf-8"),))?)?,
        32,
    )
}

fn git_plan_core<'py>(py: Python<'py>, tool_name: &B<'py>, args: &B<'py>) -> PyResult<B<'py>> {
    let a = orv(args, &empty_dict(py))?;
    let plan = ps(py, GIT_PLAN_PREFIX);
    if tool_name.eq(ps(py, "git_commit"))? {
        let msg = orstr(py, &gget(py, &a, "message")?, "")?
            .call_method0("strip")?;
        let mh = if msg.is_truthy()? {
            short(py, &msg)?
        } else {
            ps(py, "")
        };
        let d = dict_of(
            py,
            &[("kind", &ps(py, KIND_GIT_COMMIT)), ("message_hash", &mh)],
        )?;
        return enc(py, &plan, &d);
    }
    if tool_name.eq(ps(py, "git_branch"))? {
        let action = orstr(py, &gget(py, &a, "action")?, "")?;
        let name = orstr(py, &gget(py, &a, "name")?, "")?;
        let allowed = PyTuple::new_bound(py, vec![ps(py, "create"), ps(py, "switch")]);
        if !contains(&allowed.into_any(), &action)? || !name.is_truthy()? {
            return Ok(ps(py, ""));
        }
        let d = dict_of(
            py,
            &[
                ("kind", &ps(py, KIND_GIT_BRANCH)),
                ("action", &action),
                ("branch", &name),
            ],
        )?;
        return enc(py, &plan, &d);
    }
    if tool_name.eq(ps(py, "git_push"))? {
        let remote = orstr(py, &gget(py, &a, "remote")?, "origin")?;
        let branch = orstr(py, &gget(py, &a, "branch")?, "")?;
        let d = dict_of(
            py,
            &[
                ("kind", &ps(py, KIND_GIT_PUSH)),
                ("remote", &remote),
                ("branch", &branch),
            ],
        )?;
        return enc(py, &plan, &d);
    }
    Ok(ps(py, ""))
}

fn planned_state_hash_core<'py>(
    py: Python<'py>,
    tool_name: &B<'py>,
    args: &B<'py>,
) -> PyResult<B<'py>> {
    let name = orstr(py, tool_name, "")?;
    let a = orv(args, &empty_dict(py))?;
    if contains(&git_tool_effects(py)?, &name)? {
        return git_plan_core(py, &name, &a);
    }
    if name.eq(ps(py, "write_file"))? {
        if gget(py, &a, "append")?.is_truthy()? {
            return Ok(ps(py, ""));
        }
        let content = gget(py, &a, "content")?;
        if !content.is_instance_of::<PyString>() {
            return Ok(ps(py, ""));
        }
        let enc_name = orstr(py, &gget(py, &a, "encoding")?, "utf-8")?;
        let linesep = mod_import(py, "os")?.getattr("linesep")?;
        let body: PyResult<B<'py>> = (|| {
            let translated = content.call_method1("replace", (ps(py, "\n"), &linesep))?;
            let data = translated.call_method1("encode", (&enc_name,))?;
            sha256(py, &data)
        })();
        match body {
            Ok(v) => return Ok(v),
            Err(e)
                if e.is_instance_of::<PyLookupError>(py)
                    || e.is_instance_of::<PyUnicodeEncodeError>(py) =>
            {
                return Ok(ps(py, ""))
            }
            Err(e) => return Err(e),
        }
    }
    if name.eq(ps(py, "delete_file"))? {
        return Ok(ps(py, MISSING));
    }
    if name.eq(ps(py, "copy_file"))? || name.eq(ps(py, "move_file"))? {
        let src = orstr(py, &gget(py, &a, "src")?, "")?;
        if !src.is_truthy()? {
            return Ok(ps(py, ""));
        }
        let st = file_state_core(py, &src)?;
        return state_hash_core(py, &st);
    }
    Ok(ps(py, ""))
}

fn snapshot_hash_core<'py>(
    py: Python<'py>,
    tool_name: &B<'py>,
    args: &B<'py>,
    effect: &B<'py>,
) -> PyResult<B<'py>> {
    if !effect.is_truthy()? {
        return Ok(ps(py, ""));
    }
    let kind = orstr(py, &gget(py, effect, "kind")?, "")?;
    let target = orstr(py, &gget(py, effect, "target")?, "")?;
    if contains(&git_kinds(py)?, &kind)? {
        let interest = if orstr(py, tool_name, "")?.eq(ps(py, "git_branch"))? {
            orstr(py, &gget(py, &orv(args, &empty_dict(py))?, "name")?, "")?
        } else {
            ps(py, "")
        };
        let st = git_state_core(py, &target, &interest)?;
        return if gget(py, &st, "ok")?.is_truthy()? {
            enc(py, &ps(py, GIT_STATE_PREFIX), &st)
        } else {
            Ok(ps(py, ""))
        };
    }
    let st = file_state_core(py, &target)?;
    state_hash_core(py, &st)
}

// ── reconcile ───────────────────────────────────────────────────────────────

fn reconcile_core<'py>(
    py: Python<'py>,
    kind: &B<'py>,
    target: &B<'py>,
    precondition_hash: &B<'py>,
    planned_hash: &B<'py>,
) -> PyResult<B<'py>> {
    if contains(&git_kinds(py)?, &orstr(py, kind, "")?)? {
        return reconcile_git(py, kind, target, precondition_hash, planned_hash);
    }
    let current = if target.is_truthy()? {
        let st = file_state_core(py, target)?;
        state_hash_core(py, &st)?
    } else {
        ps(py, "")
    };
    let detail = dict_of(
        py,
        &[
            ("target", target),
            ("current", &head(py, &current, 16)?),
            (
                "precondition",
                &head(py, &orv(precondition_hash, &ps(py, ""))?, 16)?,
            ),
            (
                "planned",
                &head(py, &orv(planned_hash, &ps(py, ""))?, 16)?,
            ),
        ],
    )?;
    let verdict = |py: Python<'py>, status: &str, detail: B<'py>| -> PyResult<B<'py>> {
        dict_of(py, &[("status", &ps(py, status)), ("detail", &detail)])
    };
    if !target.is_truthy()? || !current.is_truthy()? {
        return verdict(py, STATUS_UNKNOWN, detail);
    }
    if planned_hash.is_truthy()? && current.eq(planned_hash)? {
        return verdict(py, STATUS_LANDED, detail);
    }
    if precondition_hash.is_truthy()? && current.eq(precondition_hash)? {
        return verdict(py, STATUS_NOT_STARTED, detail);
    }
    if !planned_hash.is_truthy()? {
        return verdict(py, STATUS_UNKNOWN, detail);
    }
    verdict(py, STATUS_CONFLICT, detail)
}

fn reconcile_git<'py>(
    py: Python<'py>,
    kind: &B<'py>,
    repo: &B<'py>,
    pre_blob: &B<'py>,
    plan_blob: &B<'py>,
) -> PyResult<B<'py>> {
    let now = git_state_core(py, repo, &ps(py, ""))?;
    let pre = dec(py, &ps(py, GIT_STATE_PREFIX), pre_blob)?;
    let plan = dec(py, &ps(py, GIT_PLAN_PREFIX), plan_blob)?;
    let detail = dict_of(
        py,
        &[
            ("target", repo),
            ("kind", kind),
            (
                "head",
                &head(py, &orstr(py, &gget(py, &now, "head")?, "")?, 8)?,
            ),
            (
                "pre_head",
                &head(py, &orstr(py, &gget(py, &pre, "head")?, "")?, 8)?,
            ),
            ("branch", &orstr(py, &gget(py, &now, "branch")?, "")?),
        ],
    )?;
    let verdict = |py: Python<'py>, status: &str, detail: B<'py>| -> PyResult<B<'py>> {
        dict_of(py, &[("status", &ps(py, status)), ("detail", &detail)])
    };
    if !gget(py, &now, "ok")?.is_truthy()? || !pre.is_truthy()? {
        return verdict(py, STATUS_UNKNOWN, detail);
    }
    let now_head = gget(py, &now, "head")?;
    let head_moved = now_head.is_truthy()? && now_head.ne(gget(py, &pre, "head")?)?;
    let unchanged = gget(py, &now, "head")?.eq(gget(py, &pre, "head")?)?
        && gget(py, &now, "staged")?.eq(gget(py, &pre, "staged")?)?;

    if kind.eq(ps(py, KIND_GIT_COMMIT))? {
        if head_moved {
            let want = orstr(py, &gget(py, &plan, "message_hash")?, "")?;
            if !want.is_truthy()? {
                return verdict(py, STATUS_UNKNOWN, detail);
            }
            if gget(py, &now, "head_msg")?.eq(&want)? {
                return verdict(py, STATUS_LANDED, detail);
            }
            return verdict(py, STATUS_CONFLICT, detail);
        }
        if unchanged {
            return verdict(py, STATUS_NOT_STARTED, detail);
        }
        return verdict(py, STATUS_UNKNOWN, detail);
    }

    if kind.eq(ps(py, KIND_GIT_BRANCH))? {
        let name = orstr(py, &gget(py, &plan, "branch")?, "")?;
        if !name.is_truthy()? {
            return verdict(py, STATUS_UNKNOWN, detail);
        }
        detail.set_item("plan_branch", name.clone())?;
        if gget(py, &plan, "action")?.eq(ps(py, "switch"))? {
            if gget(py, &now, "branch")?.eq(&name)? {
                return verdict(py, STATUS_LANDED, detail);
            }
            if gget(py, &now, "branch")?.eq(gget(py, &pre, "branch")?)? {
                return verdict(py, STATUS_NOT_STARTED, detail);
            }
            return verdict(py, STATUS_CONFLICT, detail);
        }
        let exists_now = branch_exists_core(py, repo, &name)?;
        if !exists_now.is_truthy()? {
            return verdict(py, STATUS_NOT_STARTED, detail);
        }
        let pre_be = gget(py, &pre, "branch_exists")?;
        if same(&pre_be, &py_bool(py, false)?) {
            return verdict(py, STATUS_LANDED, detail);
        }
        return verdict(py, STATUS_UNKNOWN, detail);
    }

    if kind.eq(ps(py, KIND_GIT_PUSH))? {
        return reconcile_push(py, repo, &pre, &plan, detail);
    }

    if unchanged && gget(py, &now, "dirty")?.eq(gget(py, &pre, "dirty")?)? {
        return verdict(py, STATUS_NOT_STARTED, detail);
    }
    verdict(py, STATUS_UNKNOWN, detail)
}

fn reconcile_push<'py>(
    py: Python<'py>,
    repo: &B<'py>,
    pre: &B<'py>,
    plan: &B<'py>,
    detail: B<'py>,
) -> PyResult<B<'py>> {
    let remote = orstr(py, &gget(py, plan, "remote")?, "origin")?;
    let branch = orv(
        &orstr(py, &gget(py, plan, "branch")?, "")?,
        &orstr(py, &gget(py, pre, "branch")?, "")?,
    )?;
    let want = orstr(py, &gget(py, pre, "head")?, "")?;
    let shown = join_with(
        py,
        &ps(py, ""),
        vec![remote.clone(), ps(py, "/"), branch.clone()],
    )?;
    detail.set_item("remote", shown)?;
    let verdict = |py: Python<'py>, status: &str, detail: B<'py>| -> PyResult<B<'py>> {
        dict_of(py, &[("status", &ps(py, status)), ("detail", &detail)])
    };
    if !(branch.is_truthy()? && want.is_truthy()?) || branch.eq(ps(py, "HEAD"))? {
        return verdict(py, STATUS_UNKNOWN, detail);
    }
    let refspec = join_with(
        py,
        &ps(py, ""),
        vec![
            ps(py, "refs/remotes/"),
            remote.clone(),
            ps(py, "/"),
            branch.clone(),
        ],
    )?;
    let args = PyList::new_bound(
        py,
        vec![
            ps(py, "rev-parse"),
            ps(py, "--verify"),
            ps(py, "--quiet"),
            refspec,
        ],
    );
    let t = git_out(py, repo, &args.into_any())?;
    let ok = t.get_item(0)?.is_truthy()?;
    let sha = t.get_item(1)?;
    let remote_sha = if ok {
        sha.call_method0("strip")?
    } else {
        ps(py, "")
    };
    if !remote_sha.is_truthy()? {
        return verdict(py, STATUS_UNKNOWN, detail);
    }
    detail.set_item("remote_head", head(py, &remote_sha, 8)?)?;
    if remote_sha.eq(&want)? {
        return verdict(py, STATUS_LANDED, detail);
    }
    let args = PyList::new_bound(
        py,
        vec![
            ps(py, "merge-base"),
            ps(py, "--is-ancestor"),
            want.clone(),
            remote_sha.clone(),
        ],
    );
    let t = git_out(py, repo, &args.into_any())?;
    if t.get_item(0)?.is_truthy()? {
        return verdict(py, STATUS_LANDED, detail);
    }
    verdict(py, STATUS_UNKNOWN, detail)
}

// ── EffectRecord ────────────────────────────────────────────────────────────

/// `@dataclass class EffectRecord` — field order, to_dict, from_row, repr,
/// equality and the unhashable-ness all follow the canonical dataclass.
#[pyclass(module = "effects", name = "EffectRecord")]
struct EffectRecord {
    #[pyo3(get, set)]
    operation_id: PyObject,
    #[pyo3(get, set)]
    goal_id: PyObject,
    #[pyo3(get, set)]
    run_id: PyObject,
    #[pyo3(get, set)]
    activity_id: PyObject,
    #[pyo3(get, set)]
    tool_call_id: PyObject,
    #[pyo3(get, set)]
    effect_kind: PyObject,
    #[pyo3(get, set)]
    target: PyObject,
    #[pyo3(get, set)]
    intent_hash: PyObject,
    #[pyo3(get, set)]
    precondition: PyObject,
    #[pyo3(get, set)]
    precondition_hash: PyObject,
    #[pyo3(get, set)]
    planned_payload_hash: PyObject,
    #[pyo3(get, set)]
    status: PyObject,
    #[pyo3(get, set)]
    postcondition: PyObject,
    #[pyo3(get, set)]
    postcondition_hash: PyObject,
    #[pyo3(get, set)]
    verification_evidence_refs: PyObject,
    #[pyo3(get, set)]
    attempt_count: PyObject,
    #[pyo3(get, set)]
    created_at: PyObject,
    #[pyo3(get, set)]
    updated_at: PyObject,
}

impl std::panic::UnwindSafe for EffectRecord {}

macro_rules! fld {
    ($slf:expr, $py:expr, $name:ident) => {
        $slf.$name.clone_ref($py).into_bound($py)
    };
}

/// The 18 field values in declaration order — this vector *is* the dataclass
/// field order, and it drives to_dict / __repr__ / __eq__ alike.
fn rec_values<'py>(py: Python<'py>, slf: &PyRef<'py, EffectRecord>) -> Vec<B<'py>> {
    vec![
        fld!(slf, py, operation_id),
        fld!(slf, py, goal_id),
        fld!(slf, py, run_id),
        fld!(slf, py, activity_id),
        fld!(slf, py, tool_call_id),
        fld!(slf, py, effect_kind),
        fld!(slf, py, target),
        fld!(slf, py, intent_hash),
        fld!(slf, py, precondition),
        fld!(slf, py, precondition_hash),
        fld!(slf, py, planned_payload_hash),
        fld!(slf, py, status),
        fld!(slf, py, postcondition),
        fld!(slf, py, postcondition_hash),
        fld!(slf, py, verification_evidence_refs),
        fld!(slf, py, attempt_count),
        fld!(slf, py, created_at),
        fld!(slf, py, updated_at),
    ]
}

/// `self.__class__` for the exposed EffectRecord type.
fn rec_class<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(py.get_type_bound::<EffectRecord>().into_any())
}

#[pymethods]
impl EffectRecord {
    #[allow(clippy::too_many_arguments)]
    #[new]
    #[pyo3(signature = (operation_id, goal_id = unset_obj(), run_id = unset_obj(), activity_id = unset_obj(),
                        tool_call_id = unset_obj(), effect_kind = unset_obj(), target = unset_obj(),
                        intent_hash = unset_obj(), precondition = unset_obj(), precondition_hash = unset_obj(),
                        planned_payload_hash = unset_obj(), status = unset_obj(), postcondition = unset_obj(),
                        postcondition_hash = unset_obj(), verification_evidence_refs = unset_obj(),
                        attempt_count = unset_obj(), created_at = unset_obj(), updated_at = unset_obj()))]
    fn py_new(
        py: Python<'_>,
        operation_id: Py<PyAny>,
        goal_id: Py<PyAny>,
        run_id: Py<PyAny>,
        activity_id: Py<PyAny>,
        tool_call_id: Py<PyAny>,
        effect_kind: Py<PyAny>,
        target: Py<PyAny>,
        intent_hash: Py<PyAny>,
        precondition: Py<PyAny>,
        precondition_hash: Py<PyAny>,
        planned_payload_hash: Py<PyAny>,
        status: Py<PyAny>,
        postcondition: Py<PyAny>,
        postcondition_hash: Py<PyAny>,
        verification_evidence_refs: Py<PyAny>,
        attempt_count: Py<PyAny>,
        created_at: Py<PyAny>,
        updated_at: Py<PyAny>,
    ) -> PyResult<Self> {
        // The generated dataclass __init__ stores whatever the caller passed —
        // None included — and only fires the field default when the argument is
        // absent, so "omitted" and "None" must stay distinguishable here.
        macro_rules! dv {
            ($v:expr, $def:expr) => {{
                let v: Py<PyAny> = $v;
                let vb = v.bind(py).clone();
                if unset(&vb)? { $def } else { v }
            }};
        }
        // default_factory=time.time fires per field, in declaration order,
        // only for the fields the caller left out.
        let created = dv!(created_at, time_now(py)?.unbind());
        let updated = dv!(updated_at, time_now(py)?.unbind());
        let empty_s = || ps(py, "").unbind();
        Ok(Self {
            operation_id,
            goal_id: dv!(goal_id, empty_s()),
            run_id: dv!(run_id, empty_s()),
            activity_id: dv!(activity_id, empty_s()),
            tool_call_id: dv!(tool_call_id, empty_s()),
            effect_kind: dv!(effect_kind, empty_s()),
            target: dv!(target, empty_s()),
            intent_hash: dv!(intent_hash, empty_s()),
            precondition: dv!(precondition, empty_dict(py).unbind()),
            precondition_hash: dv!(precondition_hash, empty_s()),
            planned_payload_hash: dv!(planned_payload_hash, empty_s()),
            status: dv!(status, ps(py, STATUS_PLANNED).unbind()),
            postcondition: dv!(postcondition, empty_dict(py).unbind()),
            postcondition_hash: dv!(postcondition_hash, empty_s()),
            verification_evidence_refs: dv!(
                verification_evidence_refs,
                PyList::empty_bound(py).into_any().unbind()
            ),
            attempt_count: dv!(attempt_count, obj(py, 1)?.unbind()),
            created_at: created,
            updated_at: updated,
        })
    }

    fn to_dict(slf: PyRef<'_, Self>) -> PyResult<PyObject> {
        let py = slf.py();
        let d = PyDict::new_bound(py);
        for (name, v) in REC_FIELDS.iter().zip(rec_values(py, &slf)) {
            d.set_item(*name, v)?;
        }
        Ok(d.into_any().unbind())
    }

    #[classmethod]
    #[pyo3(signature = (row,))]
    fn from_row(cls: &Bound<'_, PyType>, row: &B<'_>) -> PyResult<PyObject> {
        let py = cls.py();
        if !row.is_truthy()? {
            let kw = PyDict::new_bound(py);
            kw.set_item("operation_id", ps(py, ""))?;
            return Ok(cls.call((), Some(&kw))?.unbind());
        }
        let d = if has_attr(py, row, "keys")? {
            bi1(py, "dict", row)?
        } else if is_dict(row) {
            row.clone()
        } else {
            empty_dict(py)
        };
        let mut pre = gget(py, &d, "precondition")?;
        let mut post = gget(py, &d, "postcondition")?;
        let mut evidence = gget(py, &d, "verification_evidence_refs")?;
        for slot in [&mut pre, &mut post] {
            if slot.is_instance_of::<PyString>()
                && slot
                    .call_method1("startswith", (ps(py, "{"),))?
                    .is_truthy()?
            {
                match mod_import(py, "json")?.call_method1("loads", (&*slot,)) {
                    Ok(v) => *slot = v,
                    Err(e) if is_py_exc(&e, py) => {}
                    Err(e) => return Err(e),
                }
            }
        }
        if evidence.is_instance_of::<PyString>()
            && evidence
                .call_method1("startswith", (ps(py, "["),))?
                .is_truthy()?
        {
            match mod_import(py, "json")?.call_method1("loads", (&evidence,)) {
                Ok(v) => evidence = v,
                Err(e) if is_py_exc(&e, py) => {}
                Err(e) => return Err(e),
            }
        }
        // python builds the keyword arguments strictly left-to-right; the
        // `or time.time()` fallbacks therefore fire at their own positions.
        let kw = PyDict::new_bound(py);
        kw.set_item(
            "operation_id",
            orstr(py, &gget(py, &d, "operation_id")?, "")?,
        )?;
        kw.set_item("goal_id", orstr(py, &gget(py, &d, "goal_id")?, "")?)?;
        kw.set_item("run_id", orstr(py, &gget(py, &d, "run_id")?, "")?)?;
        kw.set_item(
            "activity_id",
            orstr(py, &gget(py, &d, "activity_id")?, "")?,
        )?;
        kw.set_item(
            "tool_call_id",
            orstr(py, &gget(py, &d, "tool_call_id")?, "")?,
        )?;
        let kind_v = gget(py, &d, "effect_kind")?;
        let kind_v = if kind_v.is_truthy()? {
            kind_v
        } else {
            orstr(py, &gget(py, &d, "kind")?, "")?
        };
        kw.set_item("effect_kind", orstr(py, &kind_v, "")?)?;
        kw.set_item("target", orstr(py, &gget(py, &d, "target")?, "")?)?;
        let ih = gget(py, &d, "intent_hash")?;
        let ih = if ih.is_truthy()? {
            ih
        } else {
            gget(py, &d, "args_hash")?
        };
        kw.set_item("intent_hash", orstr(py, &ih, "")?)?;
        kw.set_item(
            "precondition",
            if is_dict(&pre) { pre.clone() } else { empty_dict(py) },
        )?;
        let pph = gget(py, &d, "precondition_hash")?;
        let pph = if pph.is_truthy()? {
            pph
        } else {
            gget(py, &d, "precondition_state")?
        };
        kw.set_item("precondition_hash", orstr(py, &pph, "")?)?;
        let plp = gget(py, &d, "planned_payload_hash")?;
        let plp = if plp.is_truthy()? {
            plp
        } else {
            gget(py, &d, "planned_state")?
        };
        kw.set_item("planned_payload_hash", orstr(py, &plp, "")?)?;
        let status = gget(py, &d, "status")?;
        kw.set_item(
            "status",
            if status.is_truthy()? {
                status
            } else {
                ps(py, STATUS_PLANNED)
            },
        )?;
        kw.set_item(
            "postcondition",
            if is_dict(&post) { post.clone() } else { empty_dict(py) },
        )?;
        let po = gget(py, &d, "postcondition_hash")?;
        let po = if po.is_truthy()? {
            po
        } else {
            gget(py, &d, "observed_postcondition")?
        };
        kw.set_item("postcondition_hash", orstr(py, &po, "")?)?;
        let refs = if evidence.is_instance_of::<PyList>()
            || evidence.is_instance_of::<PyTuple>()
        {
            bi1(py, "list", &evidence)?
        } else {
            PyList::empty_bound(py).into_any()
        };
        kw.set_item("verification_evidence_refs", refs)?;
        let ac = gget(py, &d, "attempt_count")?;
        kw.set_item(
            "attempt_count",
            bi1(
                py,
                "int",
                &orv(&ac, &obj(py, 1)?)?,
            )?,
        )?;
        let ca = gget(py, &d, "created_at")?;
        let ca = if ca.is_truthy()? {
            ca
        } else {
            time_now(py)?
        };
        kw.set_item("created_at", bi1(py, "float", &ca)?)?;
        let ua = gget(py, &d, "updated_at")?;
        let ua = if ua.is_truthy()? {
            ua
        } else {
            time_now(py)?
        };
        kw.set_item("updated_at", bi1(py, "float", &ua)?)?;
        Ok(cls.call((), Some(&kw))?.unbind())
    }

    fn __repr__(slf: PyRef<'_, Self>) -> PyResult<String> {
        let py = slf.py();
        let parts: PyResult<Vec<B<'_>>> = REC_FIELDS
            .iter()
            .zip(rec_values(py, &slf))
            .map(|(name, v)| {
                join_with(
                    py,
                    &ps(py, ""),
                    vec![ps(py, name), ps(py, "="), bi1(py, "repr", &v)?],
                )
            })
            .collect();
        let cls = rec_class(py)?.getattr("__name__")?;
        let full = join_with(
            py,
            &ps(py, ""),
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
        if !same(&rec_class(py)?, &other.getattr("__class__")?) {
            return Ok(py.NotImplemented());
        }
        let a = PyTuple::new_bound(py, rec_values(py, &slf));
        let b = PyTuple::new_bound(
            py,
            REC_FIELDS
                .iter()
                .map(|n| other.getattr(*n))
                .collect::<PyResult<Vec<_>>>()?,
        );
        Ok(py_bool(py, a.eq(&b)?)?.unbind())
    }

    /// dataclass(eq=True, frozen=False) sets `__hash__ = None`.
    fn __hash__(&self) -> PyResult<isize> {
        Err(PyTypeError::new_err(
            "unhashable type: 'EffectRecord'",
        ))
    }
}

// ── pyfunction surface (names mirror the python module 1:1) ─────────────────

#[pyfunction]
fn _sha256<'py>(py: Python<'py>, data: &B<'py>) -> PyResult<PyObject> {
    Ok(sha256(py, data)?.unbind())
}

#[pyfunction]
#[pyo3(signature = (path, workspace_root = None))]
fn canonical_target<'py>(
    py: Python<'py>,
    path: &B<'py>,
    workspace_root: Option<B<'py>>,
) -> PyResult<PyObject> {
    let wr = workspace_root.unwrap_or_else(|| ps(py, ""));
    Ok(canonical_target_core(py, path, &wr)?.unbind())
}

#[pyfunction]
fn file_state<'py>(py: Python<'py>, path: &B<'py>) -> PyResult<PyObject> {
    Ok(file_state_core(py, path)?.unbind())
}

#[pyfunction]
fn state_hash<'py>(py: Python<'py>, state: &B<'py>) -> PyResult<PyObject> {
    Ok(state_hash_core(py, state)?.unbind())
}

#[pyfunction]
fn repo_root<'py>(py: Python<'py>, path: &B<'py>) -> PyResult<PyObject> {
    Ok(repo_root_core(py, path)?.unbind())
}

#[pyfunction]
fn _git_out<'py>(py: Python<'py>, repo: &B<'py>, args: &B<'py>) -> PyResult<PyObject> {
    Ok(git_out(py, repo, args)?.unbind())
}

#[pyfunction]
fn _short<'py>(py: Python<'py>, blob: &B<'py>) -> PyResult<PyObject> {
    Ok(short(py, blob)?.unbind())
}

#[pyfunction]
fn _enc<'py>(py: Python<'py>, prefix: &B<'py>, o: &B<'py>) -> PyResult<PyObject> {
    Ok(enc(py, prefix, o)?.unbind())
}

#[pyfunction]
fn _dec<'py>(py: Python<'py>, prefix: &B<'py>, blob: &B<'py>) -> PyResult<PyObject> {
    Ok(dec(py, prefix, blob)?.unbind())
}

#[pyfunction]
#[pyo3(signature = (repo, branch_of_interest = None))]
fn git_state<'py>(
    py: Python<'py>,
    repo: &B<'py>,
    branch_of_interest: Option<B<'py>>,
) -> PyResult<PyObject> {
    let bi = branch_of_interest.unwrap_or_else(|| ps(py, ""));
    Ok(git_state_core(py, repo, &bi)?.unbind())
}

#[pyfunction]
fn branch_exists<'py>(
    py: Python<'py>,
    repo: &B<'py>,
    name: &B<'py>,
) -> PyResult<PyObject> {
    Ok(branch_exists_core(py, repo, name)?.unbind())
}

#[pyfunction]
#[pyo3(signature = (tool_name, args, workspace_root = None))]
fn classify<'py>(
    py: Python<'py>,
    tool_name: &B<'py>,
    args: &B<'py>,
    workspace_root: Option<B<'py>>,
) -> PyResult<PyObject> {
    let wr = workspace_root.unwrap_or_else(|| ps(py, ""));
    Ok(match classify_core(py, tool_name, args, &wr)? {
        Some(v) => v.unbind(),
        None => py.None(),
    })
}

#[pyfunction]
fn intent_hash<'py>(
    py: Python<'py>,
    tool_name: &B<'py>,
    args: &B<'py>,
) -> PyResult<PyObject> {
    Ok(intent_hash_core(py, tool_name, args)?.unbind())
}

#[pyfunction]
fn operation_id<'py>(
    py: Python<'py>,
    scope: &B<'py>,
    kind: &B<'py>,
    target: &B<'py>,
    intent: &B<'py>,
) -> PyResult<PyObject> {
    Ok(operation_id_core(py, scope, kind, target, intent)?.unbind())
}

#[pyfunction]
fn _git_plan<'py>(py: Python<'py>, tool_name: &B<'py>, args: &B<'py>) -> PyResult<PyObject> {
    Ok(git_plan_core(py, tool_name, args)?.unbind())
}

#[pyfunction]
fn planned_state_hash<'py>(
    py: Python<'py>,
    tool_name: &B<'py>,
    args: &B<'py>,
) -> PyResult<PyObject> {
    Ok(planned_state_hash_core(py, tool_name, args)?.unbind())
}

#[pyfunction]
fn snapshot_hash<'py>(
    py: Python<'py>,
    tool_name: &B<'py>,
    args: &B<'py>,
    effect: &B<'py>,
) -> PyResult<PyObject> {
    Ok(snapshot_hash_core(py, tool_name, args, effect)?.unbind())
}

#[pyfunction]
fn reconcile<'py>(
    py: Python<'py>,
    kind: &B<'py>,
    target: &B<'py>,
    precondition_hash: &B<'py>,
    planned_hash: &B<'py>,
) -> PyResult<PyObject> {
    Ok(reconcile_core(py, kind, target, precondition_hash, planned_hash)?.unbind())
}

#[pyfunction]
fn _reconcile_git<'py>(
    py: Python<'py>,
    kind: &B<'py>,
    repo: &B<'py>,
    pre_blob: &B<'py>,
    plan_blob: &B<'py>,
) -> PyResult<PyObject> {
    Ok(reconcile_git(py, kind, repo, pre_blob, plan_blob)?.unbind())
}

#[pyfunction]
fn _reconcile_push<'py>(
    py: Python<'py>,
    repo: &B<'py>,
    pre: &B<'py>,
    plan: &B<'py>,
    detail: &B<'py>,
) -> PyResult<PyObject> {
    Ok(reconcile_push(py, repo, pre, plan, detail.clone())?.unbind())
}

/// Probe-only seam for the time source (*_SEAMS convention).
#[pyfunction]
#[pyo3(signature = (time_fn = None))]
fn _set_seams(py: Python<'_>, time_fn: Option<&B<'_>>) -> PyResult<PyObject> {
    ST.lock().time_fn = time_fn.map(|v| v.clone().unbind());
    Ok(py.None())
}

/// Register the effects submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(py, "effects")?;
    m.add_function(wrap_pyfunction!(_sha256, &m)?)?;
    m.add_function(wrap_pyfunction!(canonical_target, &m)?)?;
    m.add_function(wrap_pyfunction!(file_state, &m)?)?;
    m.add_function(wrap_pyfunction!(state_hash, &m)?)?;
    m.add_function(wrap_pyfunction!(repo_root, &m)?)?;
    m.add_function(wrap_pyfunction!(_git_out, &m)?)?;
    m.add_function(wrap_pyfunction!(_short, &m)?)?;
    m.add_function(wrap_pyfunction!(_enc, &m)?)?;
    m.add_function(wrap_pyfunction!(_dec, &m)?)?;
    m.add_function(wrap_pyfunction!(git_state, &m)?)?;
    m.add_function(wrap_pyfunction!(branch_exists, &m)?)?;
    m.add_function(wrap_pyfunction!(classify, &m)?)?;
    m.add_function(wrap_pyfunction!(intent_hash, &m)?)?;
    m.add_function(wrap_pyfunction!(operation_id, &m)?)?;
    m.add_function(wrap_pyfunction!(_git_plan, &m)?)?;
    m.add_function(wrap_pyfunction!(planned_state_hash, &m)?)?;
    m.add_function(wrap_pyfunction!(snapshot_hash, &m)?)?;
    m.add_function(wrap_pyfunction!(reconcile, &m)?)?;
    m.add_function(wrap_pyfunction!(_reconcile_git, &m)?)?;
    m.add_function(wrap_pyfunction!(_reconcile_push, &m)?)?;
    m.add_function(wrap_pyfunction!(_set_seams, &m)?)?;
    m.add_class::<EffectRecord>()?;
    m.add("MAX_HASH_BYTES", MAX_HASH_BYTES)?;
    m.add("KIND_FILE_WRITE", KIND_FILE_WRITE)?;
    m.add("KIND_FILE_DELETE", KIND_FILE_DELETE)?;
    m.add("KIND_FILE_MOVE", KIND_FILE_MOVE)?;
    m.add("KIND_GIT_COMMIT", KIND_GIT_COMMIT)?;
    m.add("KIND_GIT_BRANCH", KIND_GIT_BRANCH)?;
    m.add("KIND_GIT_STAGE", KIND_GIT_STAGE)?;
    m.add("KIND_GIT_PUSH", KIND_GIT_PUSH)?;
    m.add("KIND_GIT_PULL", KIND_GIT_PULL)?;
    m.add("GIT_KINDS", git_kinds(py)?)?;
    m.add("STATUS_PLANNED", STATUS_PLANNED)?;
    m.add("STATUS_STARTED", STATUS_STARTED)?;
    m.add("STATUS_LANDED", STATUS_LANDED)?;
    m.add("STATUS_VERIFIED", STATUS_VERIFIED)?;
    m.add("STATUS_NOT_STARTED", STATUS_NOT_STARTED)?;
    m.add("STATUS_CONFLICT", STATUS_CONFLICT)?;
    m.add("STATUS_UNKNOWN", STATUS_UNKNOWN)?;
    m.add("STATUS_REVERTED", STATUS_REVERTED)?;
    m.add("EFFECT_STATUSES", effect_statuses(py)?)?;
    m.add("_MISSING", MISSING)?;
    m.add("_GIT_STATE_PREFIX", GIT_STATE_PREFIX)?;
    m.add("_GIT_PLAN_PREFIX", GIT_PLAN_PREFIX)?;
    m.add("_TOOL_EFFECTS", tool_effects(py)?)?;
    m.add("_GIT_TOOL_EFFECTS", git_tool_effects(py)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}
