//! tool_catalog — Rust port of `app/backend/tool_catalog.py`
//! (wave-8, Native→Rust).
//!
//! The visibility view: everything is *registered*, only a subset is
//! *exposed*. `ToolRegistry` owns registration; this module owns the
//! per-turn schema list, and nothing here can widen what may be dispatched.
//!
//! Port posture (instance_lock / worktree / orchestration_advisory
//! precedent): every value flows as a live CPython object. `getattr`, `str`,
//! `int`, `float`, `len`, `max`, `sum`-equivalent counting, `sorted`,
//! `isinstance`, `frozenset`/`set` construction, `operator.le/lt/ge/gt/eq/in/
//! or_/sub/neg`, the `str.strip`/`str.lower`/`str.join`/`dict.get`/
//! `dict.setdefault`/`list.append`/`list.sort` *methods*, the
//! `builtins.__import__` of every function-level `from X import y` and the
//! `Result.success(**payload)` call all go to the real modules and builtins,
//! so truthiness, short-circuit order, exception identities and messages,
//! dict key insertion order and set membership semantics match the canonical
//! implementation by construction rather than by re-derivation.
//!
//! Bug-for-bug items kept verbatim (each pinned by
//! smoke/parity_tool_catalog.py):
//! §1 `group_of` reads `group` and `domain` through the *builtin getattr with
//!    a default*, so a missing attribute yields `""` rather than
//!    AttributeError — and the `or ""` / `or "general"` fall back to the
//!    literal only when the attribute is *falsy*, so `group = 0` yields
//!    `""` → falls through to domain, while `group = " "` survives `.strip()`
//!    as `""` and then also falls through. The returned value is always the
//!    stripped `str(...)` of whichever branch answered.
//! §2 `_relevant_names` short-circuits on `len(q) < 4` *after* the
//!    `(query or "").strip()`, so `None`/`0`/`""` queries never touch the
//!    recommender, and the `try` covers the import, the constructor, the
//!    `recommend(...)` call and the `.get("results", [])` — but NOT the
//!    scoring loop below it, which propagates (a non-iterable `results`
//!    raises out of `visible_names`, and `visible_names` has no handler).
//! §3 the scoring loop skips non-dict rows, skips non-`str` names, skips
//!    names absent from `all_names` (`in`, so a fake container's
//!    `__contains__` is honoured), and thresholds on
//!    `float(row.get("score") or 0) >= RELEVANT_MIN_SCORE` — `score` 0/None
//!    become `0.0`, `"0.2"` parses, and a raising `__float__` escapes through
//!    §2's unguarded loop.
//! §4 `visible_names` builds `all_names` as a real set of `t.name`
//!    (LOAD_ATTR per tool, unhashable name → TypeError from `set.add`) and
//!    returns *that same object* when `len(all_names) <= TRIM_MIN_TOTAL`.
//!    The soft ceiling counts TOOLS, while `is_trimmed` counts
//!    `len(registry.list_tools())` — so `trim_exclude` can be a no-op while
//!    `is_trimmed` says True, whenever two tools share a name. That
//!    asymmetry is in the source and is pinned, not fixed.
//! §5 the three-way view union is `|=`, i.e. set union with an arbitrary
//!    iterable on the right (`revealed` may be a generator, and
//!    `(revealed or ())` only substitutes the empty tuple for a *falsy*
//!    value — an exhausted generator stays itself).
//! §6 `trim_exclude` calls `visible_names` through the module GLOBAL, so a
//!    patched `visible_names` is what runs, and compares with `>=`
//!    (superset; a non-set RHS raises TypeError with CPython's wording).
//!    The untrimmed arm returns `{SEARCH_TOOL_NAME}` only when the meta tool
//!    is actually registered — an empty set would leave it permanently
//!    visible.
//! §7 `_search_impl` re-imports `get_tool_registry` from `tools` on every
//!    call (function-level import, unguarded) and builds its payload by
//!    calling the module-global `_search_payload`, then
//!    `Result.success(**payload)` — a real mapping unpack, so the payload's
//!    two keys land as `value=` and `meta["revealed_tools"]`.
//! §8 `_search_payload` returns the group map for any *falsy* query before
//!    importing the tokenizer; with a query it imports `_tokens` from
//!    `recommender` ONCE, and the haystack is
//!    `" ".join([t.name, t.description or "", group_of(t),
//!    getattr(t,"when_to_use","") or "", getattr(t,"domain","") or ""])` —
//!    five elements built in that order, so `t.name` and `t.description` are
//!    read here and AGAIN later (§9, §10): a property-backed fake can count
//!    every read.
//! §9 `hits = sum(1 for tk in qtokens if tk in hay)` walks the token set in
//!    the interpreter's own iteration order and calls `__contains__` once per
//!    token, then `if query.lower() in t.name.lower(): hits += 2` — a
//!    substring test, not a token test, and `+= 2` happens before the
//!    `if hits:` filter, so a zero-hit tool with a name substring still
//!    scores 2.
//! §10 `scored.sort(key=lambda pair: (-pair[0], pair[1].name))` is a real
//!     decorate-sort-undecorate: the key runs exactly once per row (so the
//!     `name` read inside it is observable), ties on `-hits` fall back to the
//!     name, and the tuple comparison happens with CPython's richcompare.
//!     `picked` then slices `scored[: max(1, limit)]` — `max` first, so a
//!     non-numeric `limit` raises from `max`, while a float `limit` survives
//!     `max` and dies in the slice ("slice indices must be integers or None
//!     or have an __index__ method"). `max(1, 0.5)` returns the ORIGINAL int
//!     1, so a float limit above 0 but below 1 silently becomes 1.
//! §11 the no-match arm reads `_group_overview(tools)["groups"]` with a real
//!     SUBSCRIPT (KeyError if a patched `_group_overview` drops the key), and
//!     both arms return the two-key `{"value": ..., "revealed_tools": ...}`
//!     dict in that insertion order.
//! §12 `_group_overview` skips only the meta tool by name, groups with
//!     `groups.setdefault(group_of(t), [])` (the `[]` literal is built even
//!     when the key exists), and emits `sorted(groups.items())` rows —
//!     code-point order on the group name, `count` from `len(names)`, and
//!     `examples` = `sorted(names)[:5]`, i.e. alphabetised and truncated,
//!     which is NOT the registry order.
//! §13 `register_tools` reads `SEARCH_TOOL_NAME`, `SEARCH_TOOL_DESCRIPTION`,
//!     `SEARCH_RESULT_LIMIT` and `_search_impl` from module globals, builds
//!     the JSON schema literal in source key order (`type`, `properties`,
//!     `required`), and calls the real `tools.ToolDef` with four positionals
//!     plus `domain=`/`risk_level=`. It registers unconditionally: whether
//!     the meta tool is *visible* is `trim_exclude`'s decision, not this
//!     one's.
//!
//! DIVERGENCE(port, binding time): python binds `Result`, `Any`, `Iterable`,
//!     `Optional` and the module's own names once at import; the port reads
//!     every one of them from the live module dict at each use through
//!     `own()`, which is the same dict
//!     `ovolve_core.tool_catalog.__dict__` exposes. Production rebinds
//!     nothing behind the module's back, and the parity probe patches both
//!     module dicts through the same objects, so observable state matches.
//! DIVERGENCE(port, call metadata): a pyo3 `#[pyfunction]` exposes no
//!     `__defaults__`/`__kwdefaults__`/`__annotations__`/real `__doc__`. The
//!     *bindings* CPython's eval loop produces are reproduced instead —
//!     arity, unknown keyword (+ the "Did you mean 'scope'?" suggestion),
//!     "multiple values", "keywords must be strings" and the kwonly tail of
//!     the arity message — through `crate::cpy_call` and `bind_call`. Note
//!     CPython 3.13 does NOT append "(and N keyword-only arguments not
//!     given)" when every keyword-only parameter has a default, which is the
//!     case for both `visible_names` and `trim_exclude`.
//! DIVERGENCE(port, docstrings): crate-wide convention; `__doc__` is None
//!     here and a real docstring in python. No production code reads it.
//! DIVERGENCE(port, sort key identity): the source's `lambda pair: ...` is a
//!     function object that lives only inside the `sort` call; the port uses
//!     a `#[pyfunction]` that is deliberately NOT added to the module dict,
//!     so `dir()` matches. Its observable behaviour (one key call per row,
//!     the `pair[1].name` read, CPython's tuple comparison) is identical.
//! DIVERGENCE(port, generator frame): `sum(1 for tk in qtokens if tk in hay)`
//!     allocates a generator in python; the port counts the same
//!     `__contains__` calls in the same order and builds the same int.
// PORT STATUS: confidence=high todos=[0]

use crate::cpy_call::{too_many_positional, unexpected_keyword};
use parking_lot::Mutex;
use pyo3::exceptions::{
    PyAttributeError, PyException, PyImportError, PyTypeError, PyValueError,
};
use pyo3::prelude::*;
use pyo3::types::{
    PyAny, PyBool, PyDict, PyFrozenSet, PyList, PyModule, PySet, PyString, PyTuple,
};

type B<'py> = Bound<'py, PyAny>;

/// the live `tool_catalog` submodule: `own()` reads the same dict
/// `ovolve_core.tool_catalog.__dict__` exposes to python.
static ST: Mutex<Option<Py<PyModule>>> = Mutex::new(None);

/// the sort key, kept out of the module dict (the source's lambda never had a
/// name either) and created once at register.
static KEYFN: Mutex<Option<Py<PyAny>>> = Mutex::new(None);

// ── module constants (tool_catalog.py:47-98) ────────────────────────────────

/// `CORE_TOOL_NAMES` — the never-trimmed residue of the view. Order here is
/// the source's literal order; it only affects the interpreter's own
/// frozenset build, not membership.
const CORE_NAMES: &[&str] = &[
    // 读
    "read_text", "search_code", "find_files", "list_dir", "get_file_info",
    // 读外部
    "web_search", "web_fetch",
    // 写
    "write_file", "edit_file",
    // 跑
    "shell_executor",
    // Matrix (Computer Use)
    "computer_screenshot", "computer_click", "computer_move_cursor",
    "computer_type", "computer_press_key", "computer_scroll", "computer_drag",
    "app_launch", "window_focus",
    // Voyager (Browser)
    "navigate", "snapshot", "click", "fill", "evaluate",
    // git 的日常闭环（刻意不含 git_push）
    "git_status", "git_diff", "git_add", "git_commit", "git_log",
    // 问 / 派 / 记
    "ask_user", "task", "plan_write", "memory_add", "memory_search",
    // 发现自己没有的能力
    "tool_search", "recommend",
];

const SEARCH_NAME: &str = "tool_search";

/// `SEARCH_TOOL_DESCRIPTION` — adjacent literals concatenated exactly as the
/// source writes them (one string, no separators).
const SEARCH_DESC_PARTS: &[&str] = &[
    "Search the FULL tool registry by keyword. Your visible tool list is ",
    "intentionally trimmed to the tools most likely relevant this turn — more ",
    "tools exist than you can see. Call this when you need a capability that ",
    "isn't in your list (browser control, app/UI automation, web search, ",
    "process management, less-common git operations, or any MCP server tool). ",
    "Matching tools become directly callable for the rest of this turn. ",
    "Omit `query` to list the available tool groups first.",
];

/// the no-match note (§11), two adjacent literals in the source.
const NOTE_NO_MATCH_PARTS: &[&str] = &[
    "没有工具匹配这个关键词。可以不带 query 再调一次看有哪些组，",
    "或者换个说法（工具名和描述都是英文的）。",
];
const NOTE_MATCHED: &str = "这些工具现在已经可以直接调用了（本回合内有效）。";
const NOTE_GROUPS: &str = "带上 query 再调一次就能拿到某一类的具体工具并直接使用。";

/// the `query` property description of the schema literal (§13).
const QUERY_DESC_PARTS: &[&str] = &[
    "What capability you're looking for, in English ",
    "keywords (e.g. 'screenshot', 'browser click', ",
    "'kill process'). Omit to list tool groups.",
];

// ── own-module globals (python's late global lookup) ────────────────────────

fn own<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    let m: Option<Py<PyModule>> = ST.lock().as_ref().map(|p| p.clone_ref(py));
    match m {
        Some(p) => Ok(p.bind(py).getattr(name)?),
        None => Err(PyImportError::new_err(
            "tool_catalog module not registered",
        )),
    }
}

// ── CPython-semantics helpers ───────────────────────────────────────────────

fn builtins(py: Python<'_>) -> PyResult<Bound<'_, PyModule>> {
    Ok(py.import_bound("builtins")?)
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

fn empty_tuple<'py>(py: Python<'py>) -> B<'py> {
    PyTuple::empty_bound(py).into_any()
}

fn empty_list<'py>(py: Python<'py>) -> B<'py> {
    PyList::empty_bound(py).into_any()
}

fn list_of<'py>(py: Python<'py>, items: Vec<B<'py>>) -> B<'py> {
    PyList::new_bound(py, items).into_any()
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

fn bi2<'py>(py: Python<'py>, name: &str, x: &B<'py>, y: &B<'py>) -> PyResult<B<'py>> {
    call_bi(py, name, (x, y))
}

/// `getattr(o, name, default)` — the BUILTIN with three arguments, so a
/// `__getattr__`-backed fake answers and a missing name yields the default.
fn getattr_d<'py>(py: Python<'py>, o: &B<'py>, name: &str, def: &B<'py>) -> PyResult<B<'py>> {
    call_bi(py, "getattr", (o, ps(py, name), def))
}

/// real operator-module binary op — the exact protocol behind `a >= b`,
/// `x in s`, `a - b`, … including reflected fallbacks.
fn op<'py>(py: Python<'py>, name: &str, a: &B<'py>, b: &B<'py>) -> PyResult<B<'py>> {
    Ok(py.import_bound("operator")?.getattr(name)?.call1((a, b))?)
}

fn opb<'py>(py: Python<'py>, name: &str, a: &B<'py>, b: &B<'py>) -> PyResult<bool> {
    Ok(op(py, name, a, b)?.is_truthy()?)
}

fn contains<'py>(py: Python<'py>, seq: &B<'py>, x: &B<'py>) -> PyResult<bool> {
    opb(py, "contains", seq, x)
}

/// unary `-x` (the sort key's `-pair[0]`).
fn neg<'py>(py: Python<'py>, a: &B<'py>) -> PyResult<B<'py>> {
    Ok(py.import_bound("operator")?.getattr("neg")?.call1((a,))?)
}

/// `x or y` — returns the ORIGINAL object when x is truthy.
fn orv<'py>(v: &B<'py>, def: &B<'py>) -> PyResult<B<'py>> {
    Ok(if v.is_truthy()? { v.clone() } else { def.clone() })
}

/// `"".join(pieces)` — the implicit join of adjacent string literals.
fn concat<'py>(py: Python<'py>, pieces: &[&str]) -> B<'py> {
    // The pieces are compile-time literals here, so the join cannot fail;
    // building it in Rust keeps the constant byte-identical to python's.
    let mut s = String::new();
    for p in pieces {
        s.push_str(p);
    }
    ps(py, &s)
}

/// `str(x)` / `int(x)` / `float(x)` / `len(x)` / `sorted(x)` — all through
/// the builtin so subclass overrides and the interpreter's own TypeError
/// wording are preserved.
fn str_of<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    bi1(py, "str", x)
}
fn int_of<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    bi1(py, "int", x)
}
fn float_of<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    bi1(py, "float", x)
}
fn len_of<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    bi1(py, "len", x)
}
fn sorted_of<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    bi1(py, "sorted", x)
}

fn isinstance_of<'py>(py: Python<'py>, x: &B<'py>, cls: &str) -> PyResult<bool> {
    let c = builtins(py)?.getattr(cls)?;
    bi2(py, "isinstance", x, &c)?.is_truthy()
}

/// python's `except Exception:` — BaseExceptions must propagate.
fn is_py_exc(e: &PyErr, py: Python<'_>) -> bool {
    e.is_instance_of::<PyException>(py)
}

fn empty_set<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(PySet::empty_bound(py)?.into_any())
}

fn set_from<'py>(py: Python<'py>, items: Vec<B<'py>>) -> PyResult<B<'py>> {
    let s = PySet::empty_bound(py)?;
    for it in items {
        s.add(&it)?;
    }
    Ok(s.into_any())
}

fn dict_new<'py>(py: Python<'py>) -> Bound<'py, PyDict> {
    PyDict::new_bound(py)
}

fn dict_of<'py>(py: Python<'py>, items: &[(&str, B<'py>)]) -> B<'py> {
    let d = dict_new(py);
    for (k, v) in items {
        d.set_item(*k, v.clone()).ok();
    }
    d.into_any()
}

fn kwargs<'py>(py: Python<'py>, items: &[(&str, &B<'py>)]) -> Bound<'py, PyDict> {
    let kw = dict_new(py);
    for (k, v) in items {
        kw.set_item(*k, (*v).clone()).ok();
    }
    kw
}

/// `d.get(key)` and `d.get(key, default)` — the METHOD, so a mapping fake's
/// override wins and its call count is real.
fn gget<'py>(py: Python<'py>, d: &B<'py>, key: &str) -> PyResult<B<'py>> {
    d.call_method1("get", (ps(py, key),))
}
fn gget_d<'py>(py: Python<'py>, d: &B<'py>, key: &str, def: &B<'py>) -> PyResult<B<'py>> {
    d.call_method1("get", (ps(py, key), def))
}

/// `from <module> import <name>` as the eval loop runs it:
/// `builtins.__import__(mod, {}, {}, (name,), 0)` then `getattr`, with
/// CPython's ImportError wording when the attribute is missing.
fn from_import<'py>(py: Python<'py>, module: &str, name: &str) -> PyResult<B<'py>> {
    let imp = builtins(py)?.getattr("__import__")?;
    let globals = dict_new(py);
    let locals = dict_new(py);
    let fromlist = PyTuple::new_bound(py, std::iter::once(ps(py, name)));
    let mod_obj = imp.call1((
        ps(py, module),
        globals.into_any(),
        locals.into_any(),
        fromlist.into_any(),
        obj(py, 0)?,
    ))?;
    match mod_obj.getattr(name) {
        Ok(v) => Ok(v),
        Err(e) if e.is_instance_of::<PyAttributeError>(py) => {
            let loc = match mod_obj.getattr("__file__") {
                Ok(f) if f.is_instance_of::<PyString>() => f.str()?.to_string_lossy().to_string(),
                _ => "unknown location".to_string(),
            };
            Err(PyImportError::new_err(format!(
                "cannot import name '{}' from '{}' ({})",
                name, module, loc
            )))
        }
        Err(e) => Err(e),
    }
}

/// `obj[:n]` — the real `__getitem__` with a `slice(None, n)`, so a float or
/// str bound raises with CPython's slice wording.
fn slice_from<'py>(
    py: Python<'py>,
    seq: &B<'py>,
    stop: &B<'py>,
) -> PyResult<B<'py>> {
    let sl = call_bi(py, "slice", (none(py), stop.clone()))?;
    seq.call_method1("__getitem__", (&sl,))
}

/// `x, y = item` — CPython's UNPACK_SEQUENCE for the two-target loop.
fn unpack2<'py>(py: Python<'py>, seq: &B<'py>) -> PyResult<(B<'py>, B<'py>)> {
    if seq.is_instance_of::<PyTuple>() || seq.is_instance_of::<PyList>() {
        let len = seq.len()?;
        if len != 2 {
            return Err(if len > 2 {
                PyValueError::new_err("too many values to unpack (expected 2)")
            } else {
                PyValueError::new_err(format!(
                    "not enough values to unpack (expected 2, got {})",
                    len
                ))
            });
        }
        return Ok((seq.get_item(0)?, seq.get_item(1)?));
    }
    let mut it = match seq.iter() {
        Ok(it) => it,
        Err(_) => {
            let tp = bi1(py, "type", seq)?;
            let nm = tp.getattr("__name__")?;
            return Err(PyTypeError::new_err(format!(
                "cannot unpack non-iterable {} object",
                nm.str()?.to_cow()?
            )));
        }
    };
    let a = match it.next() {
        Some(v) => v?,
        None => {
            return Err(PyValueError::new_err(
                "not enough values to unpack (expected 2, got 1)",
            ))
        }
    };
    let b = match it.next() {
        Some(v) => v?,
        None => {
            return Err(PyValueError::new_err(
                "not enough values to unpack (expected 2, got 1)",
            ))
        }
    };
    if it.next().is_some() {
        return Err(PyValueError::new_err(
            "too many values to unpack (expected 2)",
        ));
    }
    Ok((a, b))
}

// ── call binding (cpy_call wording, eval-loop precedence) ───────────────────

fn quoted_one(name: &str) -> String {
    format!("'{}'", name)
}

/// Bind `f(*args, **kwargs)` for a python signature of positional-or-keyword
/// params plus keyword-only params (all kwonly ones here have defaults).
/// CPython's `parse_tuple_and_keywords` owns the error order: non-str keyword
/// → unknown keyword / multiple values (in call order) → surplus positionals
/// → missing required.
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
        // CPython's list style: 'a' / 'a' and 'b' / 'a', 'b', and 'c'.
        let names: Vec<String> = missing.iter().map(|m| quoted_one(m)).collect();
        let last = names.len() - 1;
        let listed = match names.len() {
            1 => names[0].clone(),
            2 => format!("{} and {}", names[0], names[1]),
            _ => format!("{}, and {}", names[..last].join(", "), names[last]),
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

// ── group_of (tool_catalog.py:100) ─────────────────────────────────────────

fn group_of_impl<'py>(py: Python<'py>, tool: &B<'py>) -> PyResult<B<'py>> {
    let g = getattr_d(py, tool, "group", &ps(py, ""))?;
    let explicit = str_of(py, &orv(&g, &ps(py, ""))?)?.call_method0("strip")?;
    if explicit.is_truthy()? {
        return Ok(explicit);
    }
    let dd = getattr_d(py, tool, "domain", &ps(py, ""))?;
    let base = str_of(py, &orv(&dd, &ps(py, "general"))?)?;
    base.call_method0("strip")
}

#[pyfunction]
#[pyo3(signature = (*args, **kwargs))]
fn group_of<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let slots = bind_call("group_of", &["tool"], 1, &[], args, kwargs)?;
    group_of_impl(py, slots[0].as_ref().unwrap())
}

// ── _relevant_names (tool_catalog.py:114) ───────────────────────────────────

fn relevant_names_impl<'py>(
    py: Python<'py>,
    query: &B<'py>,
    scope: &B<'py>,
    all_names: &B<'py>,
) -> PyResult<B<'py>> {
    let q = orv(query, &ps(py, ""))?.call_method0("strip")?;
    if opb(py, "lt", &len_of(py, &q)?, &obj(py, 4)?)? {
        return Ok(empty_set(py)?);
    }
    // §2: the try covers import → recommend → .get("results", []) only.
    let ranked = (|| -> PyResult<B<'py>> {
        let get_recommender = from_import(py, "recommender", "get_recommender")?;
        let rec = get_recommender.call0()?;
        let limit = own(py, "RELEVANT_LIMIT")?;
        let kinds = PyTuple::new_bound(py, std::iter::once(ps(py, "tool")));
        let kinds_any = kinds.into_any();
        let kw = kwargs(
            py,
            &[("limit", &limit), ("kinds", &kinds_any), ("scope", scope)],
        );
        let res = rec.call_method("recommend", (&q,), Some(&kw))?;
        gget_d(py, &res, "results", &empty_list(py))
    })();
    let ranked = match ranked {
        Ok(v) => v,
        Err(e) if is_py_exc(&e, py) => return Ok(empty_set(py)?),
        Err(e) => return Err(e),
    };
    let out = PySet::empty_bound(py)?;
    for row in ranked.iter()? {
        let row = row?;
        if !isinstance_of(py, &row, "dict")? {
            continue;
        }
        let name = gget(py, &row, "name")?;
        // §3: `not isinstance(name, str) or name not in all_names` — the
        // containment test only runs when the name really is a str.
        if !isinstance_of(py, &name, "str")? || !contains(py, all_names, &name)? {
            continue;
        }
        let raw = gget(py, &row, "score")?;
        let score = float_of(py, &orv(&raw, &obj(py, 0)?)?)?;
        if opb(py, "ge", &score, &own(py, "RELEVANT_MIN_SCORE")?)? {
            out.add(&name)?;
        }
    }
    Ok(out.into_any())
}

#[pyfunction]
#[pyo3(signature = (*args, **kwargs))]
fn _relevant_names<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let slots = bind_call(
        "_relevant_names",
        &["query", "scope", "all_names"],
        3,
        &[],
        args,
        kwargs,
    )?;
    relevant_names_impl(
        py,
        slots[0].as_ref().unwrap(),
        slots[1].as_ref().unwrap(),
        slots[2].as_ref().unwrap(),
    )
}

// ── visible_names (tool_catalog.py:142) ────────────────────────────────────

/// `{t.name for t in registry.list_tools()}` — §4.
fn all_names_of<'py>(py: Python<'py>, registry: &B<'py>) -> PyResult<B<'py>> {
    let tools = registry.call_method0("list_tools")?;
    let out = PySet::empty_bound(py)?;
    for t in tools.iter()? {
        out.add(&t?.getattr("name")?)?;
    }
    Ok(out.into_any())
}

fn visible_names_impl<'py>(
    py: Python<'py>,
    registry: &B<'py>,
    query: &B<'py>,
    revealed: &B<'py>,
    scope: &B<'py>,
) -> PyResult<B<'py>> {
    let all_names = all_names_of(py, registry)?;
    if opb(py, "le", &len_of(py, &all_names)?, &own(py, "TRIM_MIN_TOTAL")?)? {
        return Ok(all_names);
    }
    let mut visible: B<'py> = {
        let s = PySet::empty_bound(py)?;
        for n in own(py, "CORE_TOOL_NAMES")?.iter()? {
            let n = n?;
            if contains(py, &all_names, &n)? {
                s.add(&n)?;
            }
        }
        s.into_any()
    };
    let revealed_iter = orv(revealed, &empty_tuple(py))?;
    let mut picked: Vec<B<'py>> = Vec::new();
    for n in revealed_iter.iter()? {
        let n = n?;
        if contains(py, &all_names, &n)? {
            picked.push(n);
        }
    }
    visible = op(py, "or_", &visible, &set_from(py, picked)?)?;
    let rel = own(py, "_relevant_names")?.call((query, scope, &all_names), None)?;
    visible = op(py, "or_", &visible, &rel)?;
    Ok(visible)
}

#[pyfunction]
#[pyo3(signature = (*args, **kwargs))]
fn visible_names<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let slots = bind_call(
        "visible_names",
        &["registry"],
        1,
        &["query", "revealed", "scope"],
        args,
        kwargs,
    )?;
    let query = match slots[1].as_ref() {
        Some(v) => v.clone(),
        None => ps(py, ""),
    };
    let revealed = match slots[2].as_ref() {
        Some(v) => v.clone(),
        None => none(py),
    };
    let scope = match slots[3].as_ref() {
        Some(v) => v.clone(),
        None => ps(py, ""),
    };
    visible_names_impl(py, slots[0].as_ref().unwrap(), &query, &revealed, &scope)
}

// ── trim_exclude (tool_catalog.py:166) ─────────────────────────────────────

fn trim_exclude_impl<'py>(
    py: Python<'py>,
    registry: &B<'py>,
    query: &B<'py>,
    revealed: &B<'py>,
    scope: &B<'py>,
) -> PyResult<B<'py>> {
    let all_names = all_names_of(py, registry)?;
    let kw = kwargs(
        py,
        &[
            ("query", query),
            ("revealed", revealed),
            ("scope", scope),
        ],
    );
    let visible = own(py, "visible_names")?.call((registry,), Some(&kw))?;
    if opb(py, "ge", &visible, &all_names)? {
        let sname = own(py, "SEARCH_TOOL_NAME")?;
        return Ok(if contains(py, &all_names, &sname)? {
            set_from(py, vec![sname])?
        } else {
            empty_set(py)?
        });
    }
    op(py, "sub", &all_names, &visible)
}

#[pyfunction]
#[pyo3(signature = (*args, **kwargs))]
fn trim_exclude<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let slots = bind_call(
        "trim_exclude",
        &["registry"],
        1,
        &["query", "revealed", "scope"],
        args,
        kwargs,
    )?;
    let query = match slots[1].as_ref() {
        Some(v) => v.clone(),
        None => ps(py, ""),
    };
    let revealed = match slots[2].as_ref() {
        Some(v) => v.clone(),
        None => none(py),
    };
    let scope = match slots[3].as_ref() {
        Some(v) => v.clone(),
        None => ps(py, ""),
    };
    trim_exclude_impl(py, slots[0].as_ref().unwrap(), &query, &revealed, &scope)
}

// ── is_trimmed (tool_catalog.py:184) ───────────────────────────────────────

#[pyfunction]
#[pyo3(signature = (*args, **kwargs))]
fn is_trimmed<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let slots = bind_call("is_trimmed", &["registry"], 1, &[], args, kwargs)?;
    let registry = slots[0].as_ref().unwrap();
    let n = len_of(py, &registry.call_method0("list_tools")?)?;
    Ok(bl(py, opb(py, "gt", &n, &own(py, "TRIM_MIN_TOTAL")?)?))
}

// ── the sort key behind §10 ─────────────────────────────────────────────────

#[pyfunction]
#[pyo3(signature = (pair))]
fn pair_sort_key<'py>(py: Python<'py>, pair: &B<'py>) -> PyResult<B<'py>> {
    let hits = pair.get_item(0)?;
    let tool = pair.get_item(1)?;
    let n = neg(py, &hits)?;
    let name = tool.getattr("name")?;
    Ok(PyTuple::new_bound(py, [n, name]).into_any())
}

// ── _search_payload (tool_catalog.py:216) ──────────────────────────────────

fn search_payload_impl<'py>(
    py: Python<'py>,
    registry: &B<'py>,
    query: &B<'py>,
    limit: &B<'py>,
) -> PyResult<B<'py>> {
    let tools = registry.call_method0("list_tools")?;
    if !query.is_truthy()? {
        let overview = own(py, "_group_overview")?.call1((&tools,))?;
        return Ok(dict_of(
            py,
            &[
                ("value", overview),
                ("revealed_tools", empty_list(py)),
            ],
        ));
    }
    let tokens_fn = from_import(py, "recommender", "_tokens")?;
    let qtokens = tokens_fn.call1((query,))?;
    let sname = own(py, "SEARCH_TOOL_NAME")?;
    let scored = PyList::empty_bound(py);
    for t in tools.iter()? {
        let t = t?;
        if opb(py, "eq", &t.getattr("name")?, &sname)? {
            continue;
        }
        let name = t.getattr("name")?;
        let desc = orv(&t.getattr("description")?, &ps(py, ""))?;
        let group = own(py, "group_of")?.call1((&t,))?;
        let wtu = orv(
            &getattr_d(py, &t, "when_to_use", &ps(py, ""))?,
            &ps(py, ""),
        )?;
        let dom = orv(
            &getattr_d(py, &t, "domain", &ps(py, ""))?,
            &ps(py, ""),
        )?;
        let hay_src = list_of(py, vec![name.clone(), desc, group, wtu, dom]);
        let hay_str = ps(py, " ").call_method1("join", (&hay_src,))?;
        let hay = tokens_fn.call1((hay_str,))?;
        let mut hits: i64 = 0;
        for tk in qtokens.iter()? {
            let tk = tk?;
            if contains(py, &hay, &tk)? {
                hits += 1;
            }
        }
        let mut hits = obj(py, hits)?;
        let q_lower = query.call_method0("lower")?;
        let n_lower = t.getattr("name")?.call_method0("lower")?;
        if contains(py, &n_lower, &q_lower)? {
            hits = op(py, "add", &hits, &obj(py, 2)?)?;
        }
        if hits.is_truthy()? {
            let row = PyTuple::new_bound(py, [hits, t.clone()]);
            scored.append(&row)?;
        }
    }
    let key = KEYFN
        .lock()
        .as_ref()
        .map(|p| p.clone_ref(py).into_bound(py))
        .ok_or_else(|| PyImportError::new_err("tool_catalog module not registered"))?;
    let kw = kwargs(py, &[("key", &key)]);
    scored.call_method("sort", (), Some(&kw))?;
    let one = obj(py, 1)?;
    let stop = call_bi(py, "max", (&one, limit.clone()))?;
    let head = slice_from(py, &scored.into_any(), &stop)?;
    let mut picked: Vec<B<'py>> = Vec::new();
    for row in head.iter()? {
        let row = row?;
        let (_, tool) = unpack2(py, &row)?;
        picked.push(tool);
    }
    if picked.is_empty() {
        let overview = own(py, "_group_overview")?.call1((&tools,))?;
        let groups = overview.get_item(ps(py, "groups"))?;
        let value = dict_of(
            py,
            &[
                ("query", query.clone()),
                ("matches", empty_list(py)),
                ("note", concat(py, NOTE_NO_MATCH_PARTS)),
                ("groups", groups),
            ],
        );
        return Ok(dict_of(
            py,
            &[("value", value), ("revealed_tools", empty_list(py))],
        ));
    }
    // §: the two comprehensions are SEPARATE passes and the attribute order
    // inside each dict literal is load-bearing: name, group_of, risk_level,
    // description - and only then, for a second loop, the revealed names.
    let mut matches: Vec<B<'py>> = Vec::with_capacity(picked.len());
    for t in &picked {
        let name = t.getattr("name")?;
        let g = own(py, "group_of")?.call1((t,))?;
        let risk = getattr_d(py, t, "risk_level", &ps(py, "low"))?;
        let desc = orv(&t.getattr("description")?, &ps(py, ""))?;
        matches.push(dict_of(
            py,
            &[
                ("name", name),
                ("group", g),
                ("risk", risk),
                ("description", desc),
            ],
        ));
    }
    let value = dict_of(
        py,
        &[
            ("query", query.clone()),
            ("matches", list_of(py, matches)),
            ("note", ps(py, NOTE_MATCHED)),
        ],
    );
    let mut revealed: Vec<B<'py>> = Vec::with_capacity(picked.len());
    for t in &picked {
        revealed.push(t.getattr("name")?);
    }
    Ok(dict_of(
        py,
        &[
            ("value", value),
            ("revealed_tools", list_of(py, revealed)),
        ],
    ))
}

#[pyfunction]
#[pyo3(signature = (*args, **kwargs))]
fn _search_payload<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let slots = bind_call(
        "_search_payload",
        &["registry", "query", "limit"],
        3,
        &[],
        args,
        kwargs,
    )?;
    search_payload_impl(
        py,
        slots[0].as_ref().unwrap(),
        slots[1].as_ref().unwrap(),
        slots[2].as_ref().unwrap(),
    )
}

// ── _search_impl (tool_catalog.py:202) ─────────────────────────────────────

fn search_impl_body<'py>(py: Python<'py>, args: &B<'py>, _ctx: &B<'py>) -> PyResult<B<'py>> {
    let get_reg = from_import(py, "tools", "get_tool_registry")?;
    let registry = get_reg.call0()?;
    let raw_q = gget(py, args, "query")?;
    let query = str_of(py, &orv(&raw_q, &ps(py, ""))?)?.call_method0("strip")?;
    let raw_l = gget(py, args, "limit")?;
    let limit_default = own(py, "SEARCH_RESULT_LIMIT")?;
    let limit = int_of(py, &orv(&raw_l, &limit_default)?)?;
    // §: CPython loads and attribute-resolves `Result.success` BEFORE it
    // evaluates the `**_search_payload(...)` argument, so a broken `Result`
    // short-circuits the whole search.
    let success = own(py, "Result")?.getattr("success")?;
    let payload = own(py, "_search_payload")?.call((registry, query, limit), None)?;
    // `Result.success(**payload)` — the real mapping unpack (§7).
    let kw: Bound<'py, PyDict> = match payload.downcast::<PyDict>() {
        Ok(d) => d.clone(),
        Err(_) => {
            if payload.getattr("keys").is_err() {
                let tp = bi1(py, "type", &payload)?;
                let nm = tp.getattr("__name__")?;
                return Err(PyTypeError::new_err(format!(
                    "argument after ** must be a mapping, not {}",
                    nm.str()?.to_cow()?
                )));
            }
            bi1(py, "dict", &payload)?.downcast_into::<PyDict>()?
        }
    };
    success.call((), Some(&kw))
}

#[pyfunction]
#[pyo3(signature = (*args, **kwargs))]
fn _search_impl<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let slots = bind_call("_search_impl", &["args", "ctx"], 2, &[], args, kwargs)?;
    search_impl_body(
        py,
        slots[0].as_ref().unwrap(),
        slots[1].as_ref().unwrap(),
    )
}

// ── _group_overview (tool_catalog.py:269) ──────────────────────────────────

fn group_overview_impl<'py>(py: Python<'py>, tools: &B<'py>) -> PyResult<B<'py>> {
    let groups = dict_new(py);
    let sname = own(py, "SEARCH_TOOL_NAME")?;
    for t in tools.iter()? {
        let t = t?;
        if opb(py, "eq", &t.getattr("name")?, &sname)? {
            continue;
        }
        let g = own(py, "group_of")?.call1((&t,))?;
        // §12: `groups.setdefault(group_of(t), [])` — the `[]` literal is
        // built on every iteration, whether or not the key already exists.
        let fresh = empty_list(py);
        let bucket = groups.call_method1("setdefault", (&g, fresh))?;
        bucket.call_method1("append", (t.getattr("name")?,))?;
    }
    let items = groups.call_method0("items")?;
    let rows = sorted_of(py, &items)?;
    let mut out: Vec<B<'py>> = Vec::new();
    for row in rows.iter()? {
        let (g, names) = unpack2(py, &row?)?;
        let count = len_of(py, &names)?;
        let examples = slice_from(py, &sorted_of(py, &names)?, &obj(py, 5)?)?;
        out.push(dict_of(
            py,
            &[
                ("group", g),
                ("count", count),
                ("examples", examples),
            ],
        ));
    }
    Ok(dict_of(
        py,
        &[
            ("groups", list_of(py, out)),
            ("note", ps(py, NOTE_GROUPS)),
        ],
    ))
}

#[pyfunction]
#[pyo3(signature = (*args, **kwargs))]
fn _group_overview<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let slots = bind_call("_group_overview", &["tools"], 1, &[], args, kwargs)?;
    group_overview_impl(py, slots[0].as_ref().unwrap())
}

// ── register_tools (tool_catalog.py:290) ───────────────────────────────────

fn register_tools_impl<'py>(py: Python<'py>, registry: &B<'py>) -> PyResult<B<'py>> {
    let (tool_def, get_reg) = {
        let td = from_import(py, "tools", "ToolDef")?;
        let gr = from_import(py, "tools", "get_tool_registry")?;
        (td, gr)
    };
    // `registry or get_tool_registry()` — the right operand must stay lazy:
    // calling it unconditionally would show up in a counting registry's ledger.
    let reg = if registry.is_truthy()? {
        registry.clone()
    } else {
        get_reg.call0()?
    };
    // LOAD_METHOD comes before the argument expressions in the eval loop, so a
    // registry without `register` raises before ToolDef is ever constructed.
    let register = reg.getattr("register")?;
    let query_desc = concat(py, QUERY_DESC_PARTS);
    let query_prop = dict_of(
        py,
        &[("type", ps(py, "string")), ("description", query_desc)],
    );
    let limit_prop = dict_of(
        py,
        &[
            ("type", ps(py, "integer")),
            ("default", own(py, "SEARCH_RESULT_LIMIT")?),
        ],
    );
    let props = dict_of(
        py,
        &[("query", query_prop), ("limit", limit_prop)],
    );
    let schema = dict_of(
        py,
        &[
            ("type", ps(py, "object")),
            ("properties", props),
            ("required", empty_list(py)),
        ],
    );
    let domain = ps(py, "general");
    let risk = ps(py, "low");
    let kw = kwargs(py, &[("domain", &domain), ("risk_level", &risk)]);
    let tool = tool_def.call(
        (
            own(py, "SEARCH_TOOL_NAME")?,
            own(py, "SEARCH_TOOL_DESCRIPTION")?,
            schema,
            own(py, "_search_impl")?,
        ),
        Some(&kw),
    )?;
    register.call((&tool,), None)?;
    Ok(none(py))
}

#[pyfunction]
#[pyo3(signature = (*args, **kwargs))]
fn register_tools<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<B<'py>> {
    let slots = bind_call("register_tools", &["registry"], 0, &[], args, kwargs)?;
    let registry = match slots[0].as_ref() {
        Some(v) => v.clone(),
        None => none(py),
    };
    register_tools_impl(py, &registry)
}

// ── registration ────────────────────────────────────────────────────────────

/// Register the tool_catalog submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(py, "tool_catalog")?;
    for f in [
        "group_of",
        "_relevant_names",
        "visible_names",
        "trim_exclude",
        "is_trimmed",
        "_search_impl",
        "_search_payload",
        "_group_overview",
        "register_tools",
    ] {
        let obj = match f {
            "group_of" => wrap_pyfunction!(group_of, &m)?,
            "_relevant_names" => wrap_pyfunction!(_relevant_names, &m)?,
            "visible_names" => wrap_pyfunction!(visible_names, &m)?,
            "trim_exclude" => wrap_pyfunction!(trim_exclude, &m)?,
            "is_trimmed" => wrap_pyfunction!(is_trimmed, &m)?,
            "_search_impl" => wrap_pyfunction!(_search_impl, &m)?,
            "_search_payload" => wrap_pyfunction!(_search_payload, &m)?,
            "_group_overview" => wrap_pyfunction!(_group_overview, &m)?,
            _ => wrap_pyfunction!(register_tools, &m)?,
        };
        m.add(f, obj)?;
    }
    // the §10 sort key: created here, never named in the module dict.
    let kf = wrap_pyfunction!(pair_sort_key, &m)?;
    *KEYFN.lock() = Some(kf.as_any().to_object(py));

    let core_items: Vec<B> = CORE_NAMES.iter().map(|s| ps(py, s)).collect();
    m.add(
        "CORE_TOOL_NAMES",
        PyFrozenSet::new_bound(py, &core_items)?,
    )?;
    m.add("SEARCH_TOOL_NAME", SEARCH_NAME)?;
    m.add("TRIM_MIN_TOTAL", 45)?;
    m.add("RELEVANT_LIMIT", 8)?;
    m.add("RELEVANT_MIN_SCORE", 0.08)?;
    m.add("SEARCH_RESULT_LIMIT", 10)?;
    m.add("SEARCH_TOOL_DESCRIPTION", concat(py, SEARCH_DESC_PARTS))?;

    // `from result import Result` and the `from typing import ...` names, so
    // `dir()` and any late global read see what python sees.
    m.add("Result", from_import(py, "result", "Result")?)?;
    for name in ["Any", "Iterable", "Optional"] {
        m.add(name, from_import(py, "typing", name)?)?;
    }
    m.add(
        "annotations",
        py.import_bound("__future__")?.getattr("annotations")?,
    )?;

    *ST.lock() = Some(m.clone().unbind());
    parent.add_submodule(&m)?;
    Ok(())
}
