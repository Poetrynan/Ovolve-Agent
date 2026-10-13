//! goal_plan — Rust port of `app/backend/goal_plan.py` (wave-6, Native→Rust).
//!
//! The single read/write side of `goals.plan_json`: normalize anything into a
//! valid item list, seed a plan from the goal brief, flip items from a verifier
//! verdict, render the continuation block for a resumed goal, and expose the
//! `plan_write` tool.
//!
//! Port posture (effects / mailbox precedent): every value flows as a live
//! CPython object. `json.loads/dumps` run through the real module, `str`/`int`/
//! `bool`/`dict`/`list`/`len`/`isinstance`/`getattr`/`slice` are the real
//! builtins, `[:20]`/`[:120]`/`[:limit]` are real slices on the caller's own
//! objects, membership in `PLAN_STATUSES` goes through that tuple's own
//! `__contains__`, and every storage call is issued against whatever
//! `get_storage()` returns *now* — so exception types and messages, dict key
//! insertion order, `or` short-circuit targets, truthiness, `str()`/`.strip()`
//! call counts and the recorded storage traffic match the canonical
//! implementation by construction, not by re-derivation.
//!
//! Bug-for-bug items kept verbatim (each pinned by smoke/parity_goal_plan.py):
//! §1 `normalize_plan` accepts a *list* only: a tuple (even of valid dicts)
//!    normalizes to []. A JSON string that fails to parse, or that parses to a
//!    non-list, also gives [].
//! §2 the `enumerate` index that seeds item ids counts SKIPPED entries:
//!    `[{bad}, {title:x}]` gives id "2", because `i` runs over `raw[:20]`
//!    before any filtering.
//! §3 an entry that is a bare string becomes `{"title": entry}` and then loses
//!    everything else — its id is still the positional index.
//! §4 title falls back title → text → ""; a falsy `title` (0, [], "") does NOT
//!    stop the `or` chain, and the result is stripped then truncated at 120
//!    AFTER the emptiness test, so a 130-character title survives as an item
//!    and is cut at write time.
//! §5 `status` is `str(entry.get('status') or 'pending')`, stripped AND
//!    lower-cased, and an unknown value silently becomes "pending" rather than
//!    dropping the item.
//! §6 `seed_plan_from_brief` only looks at `brief.deliverables` when
//!    `brief is not None` (identity, not truthiness); a dict brief is the only
//!    one that gets the `.get` fallback; non-list deliverables give []. Each
//!    deliverable is stringified TWICE per item (the filter and the value), so
//!    a custom `__str__` with side effects fires twice.
//! §7 `seed_plan_from_brief` returns the list it built BEFORE normalizing, and
//!    `save_plan` normalizes a second copy internally — the returned items and
//!    the stored ones are different objects.
//! §8 `apply_completion` returns a NEW list of `dict(x)` copies; `all_done`
//!    short-circuits before `completed` is ever looked at; `wanted` accepts
//!    list/tuple/set only, so a *frozenset*, a dict or a str falls into the
//!    scalar branch and is stringified WHOLE (`"{1, 2}"` matches nothing);
//!    `completed=0` still enters the scalar branch (`0 not in (None, "")`),
//!    and a hit test is `str(idx)` OR `item["id"]` against that string set.
//! §9 `render_unfinished` normalizes the input THREE times per call (once via
//!    `unfinished`, twice for `done` and the header total) and `limit` is used
//!    raw — a non-int limit raises from the slice, not from a coercion.
//! §10 `build_resume_checkpoint_prompt` binds `st` with `is not None`, but
//!    `load_plan(goal_id)` underneath STILL uses the module-level
//!    `get_storage()`, so a caller-supplied storage is only consulted twice
//!    (get_goal + render_completed_side_effects). The recovery import is
//!    inside the try, so a missing/broken `recovery` is silently skipped.
//! §11 `_plan_write` replaces context with `{}` on any FALSY value (an empty
//!    dict, "" or None), then requires a truthy stripped goal_id; `(args or
//!    {})` means a list/tuple args raises AttributeError from `.get` instead of
//!    returning a failure Result.
//! §12 `save_plan` returns `bool(update_goal_fields(...))` — a storage that
//!    answers with a truthy object of any type reads as success, and
//!    `json.dumps(..., ensure_ascii=False)` keeps CJK titles verbatim.
//! §13 `register_tools` hands `ToolDef` the six kwargs in source order
//!    (name, description, schema, execute, domain, risk_level) and the same
//!    module-level `PLAN_WRITE_SCHEMA` object every call.
//!
//! DIVERGENCE(port, dependency binding): the canonical module binds `Result`,
//!     `get_storage` and `ToolDef` once, at import time; this port resolves
//!     them through their modules at call time (`import X; X.attr`). Equivalent
//!     in every supported flow: production rebinds none of them, and the test
//!     suite swaps the storage *singleton inside* `storage` (`_storage`), which
//!     both schemes observe. A caller that rebinds
//!     `goal_plan.get_storage = ...` after import would be seen by the
//!     canonical module only — nothing in the repository does that (grep:
//!     `goal_plan.get_storage` is never assigned).
//! DIVERGENCE(port, import-time vs call-time ImportError): importing a missing
//!     `result`/`storage`/`tools` raises when the canonical MODULE loads, here
//!     when the first function runs. The exception type and message are the
//!     same; only the moment differs. Unreachable in a working install.
//! DIVERGENCE(port, f-strings): interpolation uses the real `format(x, "")`
//!     builtin — the exact call CPython f-strings compile to — and `.join`
//!     assembles the pieces in the source's order.
//! DIVERGENCE(port, optional-parameter defaults): `all_done`, `context` and
//!     `storage` are read by the canonical code through truthiness or an
//!     `is not None` test only, so an explicit `None` and an omitted argument
//!     collapse to the same behaviour on BOTH sides and pyo3's plain `None`
//!     default is exact. `render_unfinished`'s `limit` is the exception — it is
//!     used as a slice bound and as the right-hand side of `>`, so an explicit
//!     `None` must survive: it carries the effects-style float sentinel
//!     (`unset_obj`) instead, and only the omitted call substitutes
//!     ``RESUME_ITEM_LIMIT``. A caller that passed the literal value
//!     ``-1.7976931348623157e308`` as `limit` would see the default instead —
//!     no such call exists in the repository, and the same trade-off is already
//!     accepted for ``EffectRecord.__init__``.
// PORT STATUS: confidence=high todos=[0]

use parking_lot::Mutex;
use pyo3::exceptions::{PyAttributeError, PyTypeError};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyFloat, PyList, PySet, PyString, PyTuple};

type B<'py> = Bound<'py, PyAny>;

/// Sentinel for a pyo3 default that must survive an explicit `None` (effects
/// precedent): a float no caller would pass, produced per call.
const UNSET: f64 = f64::MIN;

fn unset_obj() -> Py<PyAny> {
    Python::with_gil(|py| PyFloat::new_bound(py, UNSET).into_any().unbind())
}

fn is_unset<'py>(py: Python<'py>, v: &B<'py>) -> PyResult<bool> {
    let _ = py;
    if !v.is_instance_of::<PyFloat>() {
        return Ok(false);
    }
    v.eq(UNSET)
}

const PLAN_STATUSES: [&str; 4] = ["pending", "in_progress", "completed", "blocked"];
const MAX_PLAN_ITEMS: i64 = 20;
const MAX_TITLE_CHARS: i64 = 120;
const RESUME_ITEM_LIMIT: i64 = 8;

const HEADER_SNAPSHOT: &str = "# 目标断点续跑快照 (Goal Checkpoint Snapshot)";
const ALL_DONE_LINE: &str = "所有规划子步骤均已完成，请执行最终交付成果核验。";
const REQUIRE_LINE: &str = "\n【执行要求】直接从当前未完成的步骤开始执行，严禁重复执行已落地的操作。";
const NO_GOAL_1: &str = "当前回合没有绑定目标，plan_write 无处可写。";
const NO_GOAL_2: &str = "长任务请先在「目标」面板建目标再执行；单轮对话里直接做就行。";
const EMPTY_ITEMS: &str = "items 为空或全部条目缺少 title，没有可写入的内容。";

const PLAN_WRITE_DESCRIPTION: &str = "维护当前目标的子任务清单，写进目标自己的进度表（前端「目标」面板的进度条读的就是这张表）。\n\
\n\
什么时候用：任务需要三步以上、跨多个文件或多轮才能做完，或者你已经做完了清单里的某一项。\n\
什么时候别用：读一个文件、答一个问题、改一处拼写——这类活儿列清单只是噪音，直接做。\n\
\n\
规则：\n\
- 传整份清单（整表替换），不要只传变动项。\n\
- 同一时刻最多一项 in_progress；开始下一项前先把上一项标 completed。\n\
- 只有真的做完并验证过才标 completed，没验证就还是 in_progress。\n\
- 卡住了标 blocked 并在 title 里写清卡在哪，不要假装完成。\n\
- 只在目标执行中可用；普通对话里没有目标可写，会直接返回错误。";

struct St {
    statuses: Option<Py<PyAny>>,
    schema: Option<Py<PyAny>>,
    module: Option<Py<PyAny>>,
}
static ST: Mutex<St> = Mutex::new(St {
    statuses: None,
    schema: None,
    module: None,
});

// ── CPython-semantics helpers ───────────────────────────────────────────────

fn builtins(py: Python<'_>) -> PyResult<Bound<'_, PyModule>> {
    Ok(py.import_bound("builtins")?)
}

fn mod_import<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    Ok(py.import_bound(name)?.into_any().clone())
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

/// `x or y` (returns the original object when truthy).
fn orv<'py>(v: &B<'py>, def: &B<'py>) -> PyResult<B<'py>> {
    Ok(if v.is_truthy()? { v.clone() } else { def.clone() })
}

/// real builtin call with one argument.
fn bi1<'py>(py: Python<'py>, name: &str, x: &B<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr(name)?.call1((x,))?)
}

/// `len(x)`.
fn blen<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    bi1(py, "len", x)
}

/// f-string interpolation: `format(x, "")`.
fn fmtv<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("format")?.call1((x, ps(py, "")))?)
}

/// `str(x)`.
fn strf<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    let _ = py;
    Ok(x.str()?.into_any())
}

/// `slice(None, stop)` — the exact object behind `[:stop]`.
fn py_slice<'py>(py: Python<'py>, stop: B<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("slice")?.call1((none(py), stop))?)
}

/// `"".join(parts)` — assembles f-strings from already-formatted pieces.
fn join_with<'py>(py: Python<'py>, sep: &B<'py>, parts: Vec<B<'py>>) -> PyResult<B<'py>> {
    let list = PyList::new_bound(py, parts);
    Ok(sep.call_method1("join", (&list,))?)
}

/// `d.get(k)` / `d.get(k, default)` — the mapping's own method.
fn gget<'py>(py: Python<'py>, d: &B<'py>, k: &str) -> PyResult<B<'py>> {
    let _ = py;
    d.call_method1("get", (k,))
}

fn empty_list<'py>(py: Python<'py>) -> B<'py> {
    PyList::empty_bound(py).into_any()
}

fn empty_dict<'py>(py: Python<'py>) -> B<'py> {
    PyDict::new_bound(py).into_any()
}

/// Python's `except Exception:` — BaseExceptions must propagate.
fn is_py_exc(e: &PyErr, py: Python<'_>) -> bool {
    e.is_instance_of::<pyo3::exceptions::PyException>(py)
}

// ── json through the live module ────────────────────────────────────────────

fn jloads<'py>(py: Python<'py>, s: &B<'py>) -> PyResult<B<'py>> {
    Ok(mod_import(py, "json")?.call_method1("loads", (s,))?)
}

fn jdumps_ascii_false<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    let kw = PyDict::new_bound(py);
    kw.set_item("ensure_ascii", false)?;
    Ok(mod_import(py, "json")?.call_method("dumps", (x,), Some(&kw))?)
}

/// `except (json.JSONDecodeError, TypeError):`
fn is_decode_or_type(py: Python<'_>, e: &PyErr) -> PyResult<bool> {
    if e.is_instance_of::<PyTypeError>(py) {
        return Ok(true);
    }
    let jd = mod_import(py, "json")?.getattr("JSONDecodeError")?;
    Ok(e.is_instance_bound(py, &jd))
}

// ── dependency resolution (result/storage/tools) ────────────────────────────

fn dep<'py>(py: Python<'py>, module: &str, attr: &str) -> PyResult<B<'py>> {
    Ok(mod_import(py, module)?.getattr(attr)?)
}

fn storage_call<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    dep(py, "storage", "get_storage")?.call0()
}

// ── module-level objects ────────────────────────────────────────────────────

fn statuses<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let cached = ST.lock().statuses.as_ref().map(|p| p.clone_ref(py));
    if let Some(c) = cached {
        return Ok(c.into_bound(py));
    }
    let t = PyTuple::new_bound(
        py,
        PLAN_STATUSES.iter().map(|s| ps(py, s)).collect::<Vec<_>>(),
    );
    ST.lock().statuses = Some(t.clone().into_any().unbind());
    Ok(t.into_any())
}

/// `PLAN_WRITE_SCHEMA`, built once like the python literal.
fn plan_write_schema<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let cached = ST.lock().schema.as_ref().map(|p| p.clone_ref(py));
    if let Some(c) = cached {
        return Ok(c.into_bound(py));
    }
    let title_prop = dict_of(py, &[
        ("type", &ps(py, "string")),
        ("description", &ps(py, "一句话说清这一步要产出什么")),
    ])?;
    let status_prop = dict_of(py, &[
        ("type", &ps(py, "string")),
        (
            "enum",
            &bi1(py, "list", &statuses(py)?)?,
        ),
        ("description", &ps(py, "pending / in_progress / completed / blocked")),
    ])?;
    let item_props = dict_of(py, &[
        ("title", &title_prop),
        ("status", &status_prop),
    ])?;
    let item_obj = dict_of(py, &[
        ("type", &ps(py, "object")),
        ("properties", &item_props),
        ("required", &PyList::new_bound(py, vec![ps(py, "title")])),
    ])?;
    let items = dict_of(py, &[
        ("type", &ps(py, "array")),
        (
            "description",
            &ps(py, "完整的子任务列表（整表替换，不是增量）。顺序即执行顺序。"),
        ),
        ("items", &item_obj),
    ])?;
    let props = dict_of(py, &[("items", &items)])?;
    let schema = dict_of(py, &[
        ("type", &ps(py, "object")),
        ("properties", &props),
        ("required", &PyList::new_bound(py, vec![ps(py, "items")])),
    ])?;
    ST.lock().schema = Some(schema.clone().unbind());
    Ok(schema)
}

fn dict_of<'py>(py: Python<'py>, items: &[(&str, &B<'py>)]) -> PyResult<B<'py>> {
    let d = PyDict::new_bound(py);
    for (k, v) in items {
        d.set_item(*k, v)?;
    }
    Ok(d.into_any())
}

// ── normalize_plan ──────────────────────────────────────────────────────────

fn normalize_plan<'py>(py: Python<'py>, raw: &B<'py>) -> PyResult<B<'py>> {
    let mut raw = raw.clone();
    if raw.is_instance_of::<PyString>() {
        let src = orv(&raw, &ps(py, "[]"))?;
        match jloads(py, &src) {
            Ok(v) => raw = v,
            Err(e) => {
                if is_decode_or_type(py, &e)? {
                    return Ok(empty_list(py));
                }
                return Err(e);
            }
        }
    }
    if !raw.is_instance_of::<PyList>() {
        return Ok(empty_list(py));
    }
    let capped = raw.get_item(py_slice(py, obj(py, MAX_PLAN_ITEMS)?)?)?;
    let items = PyList::empty_bound(py);
    for (i, entry) in capped.iter()?.enumerate() {
        let mut entry = entry?;
        if entry.is_instance_of::<PyString>() {
            let d = PyDict::new_bound(py);
            d.set_item("title", &entry)?;
            entry = d.into_any();
        }
        if !entry.is_instance_of::<PyDict>() {
            continue;
        }
        let t1 = gget(py, &entry, "title")?;
        let t2 = gget(py, &entry, "text")?;
        let title = strf(py, &orv(&t1, &orv(&t2, &ps(py, ""))?)?)?
            .call_method0("strip")?;
        if !title.is_truthy()? {
            continue;
        }
        let s1 = gget(py, &entry, "status")?;
        let status = strf(py, &orv(&s1, &ps(py, "pending"))?)?
            .call_method0("strip")?
            .call_method0("lower")?;
        let status = if statuses(py)?
            .call_method1("__contains__", (&status,))?
            .is_truthy()?
        {
            status
        } else {
            ps(py, "pending")
        };
        let d = PyDict::new_bound(py);
        d.set_item(
            "id",
            strf(
                py,
                &orv(
                    &gget(py, &entry, "id")?,
                    &obj(py, (i + 1) as i64)?,
                )?,
            )?,
        )?;
        d.set_item(
            "title",
            title.get_item(py_slice(py, obj(py, MAX_TITLE_CHARS)?)?)?,
        )?;
        d.set_item("status", status)?;
        items.append(d)?;
    }
    Ok(items.into_any())
}

// ── load_plan / save_plan / seed_plan_from_brief ────────────────────────────

fn load_plan_core<'py>(py: Python<'py>, goal_id: &B<'py>) -> PyResult<B<'py>> {
    let row = storage_call(py)?.call_method1("get_goal", (goal_id,))?;
    if !row.is_truthy()? {
        return Ok(empty_list(py));
    }
    normalize_plan(py, &gget(py, &row, "plan_json")?)
}

fn save_plan_core<'py>(
    py: Python<'py>,
    goal_id: &B<'py>,
    items: &B<'py>,
) -> PyResult<B<'py>> {
    let payload = jdumps_ascii_false(py, &normalize_plan(py, items)?)?;
    let kw = PyDict::new_bound(py);
    kw.set_item("plan_json", payload)?;
    let ok = storage_call(py)?.call_method("update_goal_fields", (goal_id,), Some(&kw))?;
    bi1(py, "bool", &ok)
}

fn seed_plan_from_brief_core<'py>(
    py: Python<'py>,
    goal_id: &B<'py>,
    brief: &B<'py>,
) -> PyResult<B<'py>> {
    let existing = load_plan_core(py, goal_id)?;
    if existing.is_truthy()? {
        return Ok(existing);
    }
    let mut deliverables = empty_list(py);
    if !brief.is_none() {
        let raw = builtins(py)?
            .getattr("getattr")?
            .call((brief, ps(py, "deliverables"), none(py)), None)?;
        let raw = if raw.is_none() && brief.is_instance_of::<PyDict>() {
            gget(py, brief, "deliverables")?
        } else {
            raw
        };
        if raw.is_instance_of::<PyList>() {
            let kept = PyList::empty_bound(py);
            for d in raw.iter()? {
                let d = d?;
                let s = strf(py, &d)?.call_method0("strip")?;
                if s.is_truthy()? {
                    // python re-evaluates str(d).strip() for the value.
                    kept.append(strf(py, &d)?.call_method0("strip")?)?;
                }
            }
            deliverables = kept.into_any();
        }
    }
    if !deliverables.is_truthy()? {
        return Ok(empty_list(py));
    }
    let capped = deliverables.get_item(py_slice(py, obj(py, MAX_PLAN_ITEMS)?)?)?;
    let items = PyList::empty_bound(py);
    for (i, d) in capped.iter()?.enumerate() {
        let d = d?;
        let it = PyDict::new_bound(py);
        it.set_item("id", strf(py, &obj(py, (i + 1) as i64)?)?)?;
        it.set_item(
            "title",
            d.get_item(py_slice(py, obj(py, MAX_TITLE_CHARS)?)?)?,
        )?;
        it.set_item("status", ps(py, "pending"))?;
        items.append(it)?;
    }
    save_plan_core(py, goal_id, &items.clone().into_any())?;
    Ok(items.into_any())
}

// ── apply_completion / unfinished / render_unfinished / plan_digest ─────────

fn apply_completion_core<'py>(
    py: Python<'py>,
    items: &B<'py>,
    completed: &B<'py>,
    all_done: &B<'py>,
) -> PyResult<B<'py>> {
    let norm = normalize_plan(py, items)?;
    let out = PyList::empty_bound(py);
    for x in norm.iter()? {
        out.append(bi1(py, "dict", &x?)?)?;
    }
    let out_b = out.clone().into_any();
    if !out_b.is_truthy()? {
        return Ok(PyTuple::new_bound(
            py,
            vec![out_b, obj(py, 0)?],
        )
        .into_any());
    }
    if all_done.is_truthy()? {
        let mut flipped = 0i64;
        for x in out.iter() {
            if x.get_item("status")?.ne(ps(py, "completed"))? {
                flipped += 1;
            }
        }
        for x in out.iter() {
            x.set_item("status", ps(py, "completed"))?;
        }
        return Ok(PyTuple::new_bound(
            py,
            vec![out_b, obj(py, flipped)?],
        )
        .into_any());
    }
    let wanted = PySet::empty_bound(py)?;
    let seq = completed.is_instance_of::<PyList>()
        || completed.is_instance_of::<PyTuple>()
        || completed.is_instance_of::<PySet>();
    if seq {
        for c in completed.iter()? {
            wanted.add(strf(py, &c?)?.call_method0("strip")?)?;
        }
    } else {
        let needles = PyTuple::new_bound(py, vec![none(py), ps(py, "")]);
        if !needles
            .call_method1("__contains__", (completed,))?
            .is_truthy()?
        {
            wanted.add(strf(py, completed)?.call_method0("strip")?)?;
        }
    }
    let wanted_b = wanted.clone().into_any();
    if !wanted_b.is_truthy()? {
        return Ok(PyTuple::new_bound(
            py,
            vec![out_b, obj(py, 0)?],
        )
        .into_any());
    }
    let mut flipped = 0i64;
    for (idx, item) in out.iter().enumerate() {
        let idx_s = strf(py, &obj(py, (idx + 1) as i64)?)?;
        let mut hit = wanted_b.call_method1("__contains__", (&idx_s,))?.is_truthy()?;
        if !hit {
            hit = wanted_b
                .call_method1("__contains__", (item.get_item("id")?,))?
                .is_truthy()?;
        }
        if hit && item.get_item("status")?.ne(ps(py, "completed"))? {
            item.set_item("status", ps(py, "completed"))?;
            flipped += 1;
        }
    }
    Ok(PyTuple::new_bound(py, vec![out_b, obj(py, flipped)?]).into_any())
}

fn unfinished_core<'py>(py: Python<'py>, items: &B<'py>) -> PyResult<B<'py>> {
    let norm = normalize_plan(py, items)?;
    let out = PyList::empty_bound(py);
    for x in norm.iter()? {
        let x = x?;
        if x.get_item("status")?.ne(ps(py, "completed"))? {
            out.append(x)?;
        }
    }
    Ok(out.into_any())
}

fn render_unfinished_core<'py>(
    py: Python<'py>,
    items: &B<'py>,
    limit: &B<'py>,
) -> PyResult<B<'py>> {
    let left = unfinished_core(py, items)?;
    if !left.is_truthy()? {
        return Ok(ps(py, ""));
    }
    let total = normalize_plan(py, items)?;
    let done = blen(py, &total)?
        .sub(&blen(py, &left)?)?;
    let total2 = normalize_plan(py, items)?;
    let lines = PyList::empty_bound(py);
    lines.append(fconcat(
        py,
        vec![
            ps(py, "计划进度："),
            fmtv(py, &done)?,
            ps(py, "/"),
            fmtv(py, &blen(py, &total2)?)?,
            ps(py, " 项已完成。还剩："),
        ],
    )?)?;
    for x in left.get_item(py_slice(py, limit.clone())?)?.iter()? {
        let x = x?;
        let st = x.get_item("status")?;
        let mark = if st.eq(ps(py, "in_progress"))? {
            "进行中"
        } else if st.eq(ps(py, "blocked"))? {
            "受阻"
        } else {
            "未开始"
        };
        lines.append(fconcat(
            py,
            vec![
                ps(py, "  ["),
                ps(py, mark),
                ps(py, "] "),
                fmtv(py, &x.get_item("title")?)?,
            ],
        )?)?;
    }
    if blen(py, &left)?.gt(limit)? {
        lines.append(fconcat(
            py,
            vec![
                ps(py, "  ……还有 "),
                fmtv(py, &blen(py, &left)?.sub(limit)?)?,
                ps(py, " 项"),
            ],
        )?)?;
    }
    lines.append(ps(py, "接着做还没完成的部分，不要从头重做已完成的项。"))?;
    join_with(py, &ps(py, "\n"), lines.iter().collect::<Vec<_>>())
}

/// `"".join` over pieces that are already strings/objects.
fn fconcat<'py>(py: Python<'py>, parts: Vec<B<'py>>) -> PyResult<B<'py>> {
    join_with(py, &ps(py, ""), parts)
}

fn plan_digest_core<'py>(py: Python<'py>, items: &B<'py>) -> PyResult<B<'py>> {
    let norm = normalize_plan(py, items)?;
    if !norm.is_truthy()? {
        return Ok(ps(py, "no plan"));
    }
    let mut done = 0i64;
    for x in norm.iter()? {
        if x?.get_item("status")?.eq(ps(py, "completed"))? {
            done += 1;
        }
    }
    fconcat(
        py,
        vec![
            fmtv(py, &obj(py, done)?)?,
            ps(py, "/"),
            fmtv(py, &blen(py, &norm)?)?,
            ps(py, " completed"),
        ],
    )
}

// ── build_resume_checkpoint_prompt ──────────────────────────────────────────

fn build_resume_checkpoint_prompt_core<'py>(
    py: Python<'py>,
    goal_id: &B<'py>,
    storage: Option<&B<'py>>,
) -> PyResult<B<'py>> {
    let st = match storage {
        Some(v) if !v.is_none() => v.clone(),
        _ => storage_call(py)?,
    };
    let goal = st.call_method1("get_goal", (goal_id,))?;
    if !goal.is_truthy()? {
        return Ok(ps(py, ""));
    }
    let plan = load_plan_core(py, goal_id)?;
    let rem = render_unfinished_core(py, &plan, &obj(py, RESUME_ITEM_LIMIT)?)?;
    let title = orv(
        &gget(py, &goal, "title")?,
        &orv(
            &gget(py, &goal, "description")?,
            goal_id,
        )?,
    )?;
    let mut parts: Vec<B<'py>> = vec![
        ps(py, HEADER_SNAPSHOT),
        fconcat(py, vec![ps(py, "目标: "), fmtv(py, &title)?])?,
    ];
    // try: from recovery import render_completed_side_effects ...
    let side: PyResult<()> = (|| {
        let f = mod_import(py, "recovery")?
            .getattr("render_completed_side_effects")?;
        let block = f.call1((goal_id, &st))?;
        if block.is_truthy()? {
            parts.push(fconcat(
                py,
                vec![ps(py, "\n"), fmtv(py, &block)?],
            )?);
        }
        Ok(())
    })();
    if let Err(e) = side {
        if !is_py_exc(&e, py) {
            return Err(e);
        }
    }
    if rem.is_truthy()? {
        parts.push(fconcat(py, vec![ps(py, "\n"), fmtv(py, &rem)?])?);
    } else {
        parts.push(ps(py, ALL_DONE_LINE));
    }
    parts.push(ps(py, REQUIRE_LINE));
    join_with(py, &ps(py, "\n"), parts)
}

// ── _plan_write ─────────────────────────────────────────────────────────────

fn result_call<'py>(
    py: Python<'py>,
    ctor: &str,
    msg: B<'py>,
) -> PyResult<B<'py>> {
    Ok(dep(py, "result", "Result")?.call_method1(ctor, (msg,))?)
}

fn plan_write_core<'py>(
    py: Python<'py>,
    args: &B<'py>,
    context: Option<&B<'py>>,
) -> PyResult<B<'py>> {
    let ctx = match context {
        Some(v) if v.is_truthy()? => v.clone(),
        _ => empty_dict(py),
    };
    let goal_id = strf(
        py,
        &orv(&gget(py, &ctx, "goal_id")?, &ps(py, ""))?,
    )?
    .call_method0("strip")?;
    if !goal_id.is_truthy()? {
        return result_call(
            py,
            "failure",
            fconcat(py, vec![ps(py, NO_GOAL_1), ps(py, NO_GOAL_2)])?,
        );
    }
    let items = normalize_plan(
        py,
        &gget(py, &orv(args, &empty_dict(py))?, "items")?,
    )?;
    if !items.is_truthy()? {
        return result_call(py, "failure", ps(py, EMPTY_ITEMS));
    }
    let saved = save_plan_core(py, &goal_id, &items)?;
    if !saved.is_truthy()? {
        return result_call(
            py,
            "failure",
            fconcat(py, vec![ps(py, "目标不存在或已被删除："), fmtv(py, &goal_id)?])?,
        );
    }
    let payload = dict_of(
        py,
        &[
            ("goal_id", &goal_id),
            ("items", &items),
            ("progress", &plan_digest_core(py, &items)?),
        ],
    )?;
    result_call(py, "success", payload)
}

// ── register_tools ──────────────────────────────────────────────────────────

fn register_tools_core<'py>(py: Python<'py>, registry: &B<'py>) -> PyResult<()> {
    let execute = ST
        .lock()
        .module
        .as_ref()
        .map(|m| m.clone_ref(py).into_bound(py).getattr("_plan_write"))
        .transpose()?
        .ok_or_else(|| PyAttributeError::new_err("goal_plan module not registered"))?;
    let kw = PyDict::new_bound(py);
    kw.set_item("name", ps(py, "plan_write"))?;
    kw.set_item("description", ps(py, PLAN_WRITE_DESCRIPTION))?;
    kw.set_item("schema", plan_write_schema(py)?)?;
    kw.set_item("execute", execute)?;
    kw.set_item("domain", ps(py, "general"))?;
    kw.set_item("risk_level", ps(py, "low"))?;
    let td = dep(py, "tools", "ToolDef")?.call((), Some(&kw))?;
    registry.call_method1("register", (&td,))?;
    Ok(())
}

// ── exposed pyfunctions ─────────────────────────────────────────────────────

#[pyfunction]
#[pyo3(name = "normalize_plan", signature = (raw,))]
fn normalize_plan_py<'py>(py: Python<'py>, raw: &B<'py>) -> PyResult<B<'py>> {
    normalize_plan(py, raw)
}

#[pyfunction]
#[pyo3(name = "load_plan", signature = (goal_id,))]
fn load_plan_py<'py>(py: Python<'py>, goal_id: &B<'py>) -> PyResult<B<'py>> {
    load_plan_core(py, goal_id)
}

#[pyfunction]
#[pyo3(name = "save_plan", signature = (goal_id, items))]
fn save_plan_py<'py>(
    py: Python<'py>,
    goal_id: &B<'py>,
    items: &B<'py>,
) -> PyResult<B<'py>> {
    save_plan_core(py, goal_id, items)
}

#[pyfunction]
#[pyo3(name = "seed_plan_from_brief", signature = (goal_id, brief))]
fn seed_plan_from_brief_py<'py>(
    py: Python<'py>,
    goal_id: &B<'py>,
    brief: &B<'py>,
) -> PyResult<B<'py>> {
    seed_plan_from_brief_core(py, goal_id, brief)
}

#[pyfunction]
#[pyo3(name = "apply_completion", signature = (items, completed, all_done = None))]
fn apply_completion_py<'py>(
    py: Python<'py>,
    items: &B<'py>,
    completed: &B<'py>,
    all_done: Option<&B<'py>>,
) -> PyResult<B<'py>> {
    let ad = match all_done {
        Some(v) => v.clone(),
        None => py_bool(py, false)?,
    };
    apply_completion_core(py, items, completed, &ad)
}

#[pyfunction]
#[pyo3(name = "unfinished", signature = (items,))]
fn unfinished_py<'py>(py: Python<'py>, items: &B<'py>) -> PyResult<B<'py>> {
    unfinished_core(py, items)
}

#[pyfunction]
#[pyo3(name = "render_unfinished", signature = (items, limit = unset_obj()))]
fn render_unfinished_py<'py>(
    py: Python<'py>,
    items: &B<'py>,
    limit: Py<PyAny>,
) -> PyResult<B<'py>> {
    // `limit` is the one optional parameter that is NOT read by truthiness:
    // python does `left[:limit]` and `len(left) > limit`, so an explicit None
    // has to stay None (full slice, then TypeError from the comparison).
    let lb = limit.into_bound(py);
    let l = if is_unset(py, &lb)? {
        obj(py, RESUME_ITEM_LIMIT)?
    } else {
        lb
    };
    render_unfinished_core(py, items, &l)
}

#[pyfunction]
#[pyo3(name = "plan_digest", signature = (items,))]
fn plan_digest_py<'py>(py: Python<'py>, items: &B<'py>) -> PyResult<B<'py>> {
    plan_digest_core(py, items)
}

#[pyfunction]
#[pyo3(name = "build_resume_checkpoint_prompt", signature = (goal_id, storage = None))]
fn build_resume_checkpoint_prompt_py<'py>(
    py: Python<'py>,
    goal_id: &B<'py>,
    storage: Option<&B<'py>>,
) -> PyResult<B<'py>> {
    build_resume_checkpoint_prompt_core(py, goal_id, storage)
}

#[pyfunction]
#[pyo3(name = "_plan_write", signature = (args, context = None))]
fn plan_write_py<'py>(
    py: Python<'py>,
    args: &B<'py>,
    context: Option<&B<'py>>,
) -> PyResult<B<'py>> {
    plan_write_core(py, args, context)
}

#[pyfunction]
#[pyo3(name = "register_tools", signature = (registry,))]
fn register_tools_py<'py>(py: Python<'py>, registry: &B<'py>) -> PyResult<B<'py>> {
    register_tools_core(py, registry)?;
    Ok(none(py))
}

/// Register the goal_plan submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(py, "goal_plan")?;
    m.add_function(wrap_pyfunction!(normalize_plan_py, &m)?)?;
    m.add_function(wrap_pyfunction!(load_plan_py, &m)?)?;
    m.add_function(wrap_pyfunction!(save_plan_py, &m)?)?;
    m.add_function(wrap_pyfunction!(seed_plan_from_brief_py, &m)?)?;
    m.add_function(wrap_pyfunction!(apply_completion_py, &m)?)?;
    m.add_function(wrap_pyfunction!(unfinished_py, &m)?)?;
    m.add_function(wrap_pyfunction!(render_unfinished_py, &m)?)?;
    m.add_function(wrap_pyfunction!(plan_digest_py, &m)?)?;
    m.add_function(wrap_pyfunction!(build_resume_checkpoint_prompt_py, &m)?)?;
    m.add_function(wrap_pyfunction!(plan_write_py, &m)?)?;
    m.add_function(wrap_pyfunction!(register_tools_py, &m)?)?;
    m.add("PLAN_STATUSES", statuses(py)?)?;
    m.add("MAX_PLAN_ITEMS", MAX_PLAN_ITEMS)?;
    m.add("MAX_TITLE_CHARS", MAX_TITLE_CHARS)?;
    m.add("RESUME_ITEM_LIMIT", RESUME_ITEM_LIMIT)?;
    m.add("PLAN_WRITE_DESCRIPTION", PLAN_WRITE_DESCRIPTION)?;
    m.add("PLAN_WRITE_SCHEMA", plan_write_schema(py)?)?;
    ST.lock().module = Some(m.clone().into_any().unbind());
    parent.add_submodule(&m)?;
    Ok(())
}
