//! worktree — Rust port of `app/backend/worktree.py` (wave-7, Native→Rust).
//!
//! Per-subagent git worktree isolation: `create()` opens a detached worktree
//! over the source repo, syncs the parent's dirty/untracked files into it and
//! snapshots the child root; `changes()` diffs the live tree against that
//! snapshot; `discard()` removes and prunes. Every failure mode returns
//! `None` (or silently degrades) so the caller falls back to the work_copy
//! overlay — the fallback is the feature.
//!
//! Port posture (cua_actions / orchestration_advisory precedent): every value
//! flows as a live CPython object and every host touchpoint is read through
//! the interpreter at call time —
//!   * `_git`'s function-level `from executors import tracked_run` goes
//!     through `builtins.__import__("executors")` ONCE PER `_git` CALL
//!     (exactly what CPython executes per call), so a patched executors
//!     module and a counting import hook are both observable;
//!   * `os`, `shutil`, `tempfile`, `uuid`, `hashlib`, `pathlib.Path` are
//!     imported live at each use, so probe patches on the REAL modules
//!     (`os.walk`, `os.path.isdir`, `shutil.which`, …) are seen by both sides;
//!   * `open(path, "rb")` is the real builtin and the `with` block runs the
//!     real `__enter__`/`__exit__` protocol; the 64KiB chunk loop compares
//!     against the real `b""` sentinel with `==` (what
//!     `iter(lambda: f.read(65536), b"")` does);
//!   * `except (OSError, subprocess.TimeoutExpired)` tests the LIVE classes
//!     (`subprocess` imported per check), `except Exception` is the real
//!     PyException root;
//!   * dict key insertion order, the `sorted()` set union, `or` chains and
//!     f-string piece order match by construction.
//!
//! Bug-for-bug items kept verbatim (each pinned by smoke/parity_worktree.py):
//! §1 `_git` re-resolves `executors.tracked_run` on EVERY call, and passes
//!    `cwd`/`capture_output`/`text`/`encoding`/`errors`/`timeout` as kwargs
//!    in source order.
//! §2 `repo_toplevel` returns None for falsy path / not-a-dir / missing git
//!    BEFORE any subprocess; the success path strips `(proc.stdout or "")`
//!    and returns `os.path.abspath(top)` only when non-empty.
//! §3 `_file_fingerprint`: "missing" on a getsize OSError; files above
//!    MAX_HASH_BYTES (module global re-read at call time) return
//!    `f"size:{size}:mtime:{mtime}"` with mtime 0 when getmtime also raises;
//!    an OSError anywhere inside the with-block returns `f"size:{size}"`.
//! §4 `_walk_files` prunes with an IN-PLACE `dirs[:] = …` against the live
//!    walk list, skips `.git/`-prefixed or exactly-`.git` rels, and converts
//!    separators via `.replace("\\", "/")` only on the RELATIVE path.
//! §5 `_snapshot` dict insertion order == walk order.
//! §6 `changes()` sorts the SET UNION `current | previous` (code-point order)
//!    and reports deletes for vanished rels and writes for new-or-changed
//!    fingerprints; the or-chain `rel not in previous or snapshot.get(rel)
//!    != fingerprint` skips BOTH the `.get` and the fingerprint call when
//!    the rel is new; getsize OSError on a changed file yields bytes 0.
//! §7 `report()` copies `id/label/root/kind` then changes/paths — key order
//!    pinned; `paths` comprehends `r["rel"]` (real subscript) over the SAME
//!    rows list.
//! §8 `_sync_dirty` swallows (OSError, TimeoutExpired) and non-zero
//!    returncodes, skips porcelain lines shorter than 4 chars, takes
//!    `line[3:].strip()`, resolves `old -> new` renames to the NEW path,
//!    strips `"` pairs, skips empty/`.git`-prefixed rels, and fail-opens on
//!    copy/remove OSErrors.
//! §9 `create` short-circuits: falsy source_root / not-a-dir / no git → None
//!    before anything runs; failing HEAD verify or `worktree add` removes
//!    the temp parent (ignore_errors=True) and returns None.
//! §10 `wt_id = uuid.uuid4().hex[:8]` — a real slice; the mkdtemp prefix
//!    f-string embeds that 8-char id.
//! §11 relpath ValueError → "."; `rel in (os.curdir, "")` reads os.curdir
//!    live; a rel starting with ".." aborts via the module-global
//!    `discard_path` (patchable) and returns None; a sub-directory rel gets
//!    makedirs(exist_ok=True).
//! §12 the `_sync_dirty` guard in create is `except Exception: pass` —
//!    BaseExceptions propagate.
//! §13 `discard(None)` returns; the parent dir is `str(Path(wt_root).parent)`
//!    when wt_root is truthy, else ""; toplevel/root fall back through `or`
//!    chains (`repo_toplevel or source_root`, `wt_root or root`).
//! §14 WorktreeCopy is a plain dataclass: `kind` defaults to the KIND value
//!    captured at class-creation time, `_snapshot` is a fresh dict per
//!    instance and EXCLUDED from the generated `__repr__` (repr=False), and
//!    `cleanup()` resolves the module-global `discard` at call time.
//!
//! DIVERGENCE(port, binding time): python binds os/shutil/tempfile/uuid/
//!     hashlib/pathlib/subprocess once at import; the port imports them live
//!     at each use. Production rebinds none of them, and probe patches on the
//!     real modules are seen identically by both sides.
//! DIVERGENCE(port, def-time defaults): `label=""`, `kind=KIND`, `wt_root=""`,
//!     `repo_toplevel=""` are evaluated once by python at class creation; the
//!     port snapshots the same values at register time (uia_tree precedent).
//! DIVERGENCE(port, `__future__` leftover): `annotations` name not reproduced
//!     (crate-wide note).
// PORT STATUS: confidence=high todos=[0]

use parking_lot::Mutex;
use pyo3::exceptions::{PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyAny, PyBytes, PyDict, PyList, PyModule, PyString, PyTuple};

use crate::cpy_call::{too_many_positional, unexpected_keyword};

type B<'py> = Bound<'py, PyAny>;

static ST: Mutex<Option<Py<PyModule>>> = Mutex::new(None);

const KIND: &str = "worktree";
const MAX_HASH_BYTES: i64 = 8 * 1024 * 1024;

// ── own-module globals ──────────────────────────────────────────────────────

fn own<'py>(py: Python<'py>, name: &str) -> PyResult<B<'py>> {
    let m: Option<Py<PyModule>> = ST.lock().as_ref().map(|p| p.clone_ref(py));
    match m {
        Some(p) => Ok(p.bind(py).getattr(name)?),
        None => Err(pyo3::exceptions::PyImportError::new_err(
            "worktree module not registered",
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

fn op<'py>(py: Python<'py>, name: &str, a: &B<'py>, b: &B<'py>) -> PyResult<B<'py>> {
    Ok(py.import_bound("operator")?.getattr(name)?.call1((a, b))?)
}

fn opb<'py>(py: Python<'py>, name: &str, a: &B<'py>, b: &B<'py>) -> PyResult<bool> {
    Ok(op(py, name, a, b)?.is_truthy()?)
}

/// `x or y` (returns the ORIGINAL object when x is truthy).
fn orv<'py>(v: &B<'py>, def: &B<'py>) -> PyResult<B<'py>> {
    Ok(if v.is_truthy()? { v.clone() } else { def.clone() })
}

/// `f"{x}"` — the real `format(x, "")` an f-string compiles to.
fn fmtv<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("format")?.call1((x, ps(py, "")))?)
}

/// `"".join(pieces)` — f-string assembly in source order.
fn concat<'py>(py: Python<'py>, pieces: Vec<B<'py>>) -> PyResult<B<'py>> {
    let list = PyList::new_bound(py, pieces);
    Ok(ps(py, "").call_method1("join", (&list,))?)
}

fn str_of<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    bi1(py, "str", x)
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
    e.is_instance_of::<pyo3::exceptions::PyException>(py)
}

/// `isinstance(err, cls)` against a LIVE exception class.
fn err_is<'py>(py: Python<'py>, e: &PyErr, cls: &B<'py>) -> bool {
    e.is_instance_bound(py, cls)
}

/// `except (a, b)` — left to right, isinstance each.
fn err_is_any<'py>(py: Python<'py>, e: &PyErr, classes: &[&B<'py>]) -> bool {
    classes.iter().any(|c| err_is(py, e, c))
}

/// the live `(OSError, subprocess.TimeoutExpired)` pair, fetched per site.
fn os_and_timeout<'py>(py: Python<'py>) -> PyResult<(B<'py>, B<'py>)> {
    let os_err = mod_import(py, "builtins")?.getattr("OSError")?;
    let te = mod_import(py, "subprocess")?.getattr("TimeoutExpired")?;
    Ok((os_err, te))
}

/// `x[:stop]` — a real slice object.
fn slice_head<'py>(py: Python<'py>, x: &B<'py>, stop: i64) -> PyResult<B<'py>> {
    let sl = builtins(py)?
        .getattr("slice")?
        .call1((none(py), obj(py, stop)?))?;
    x.get_item(sl)
}

// ── call binding (cpy_call wording) ─────────────────────────────────────────

fn quoted_and(names: &[&str]) -> String {
    match names.len() {
        1 => format!("'{}'", names[0]),
        2 => format!("'{}' and '{}'", names[0], names[1]),
        n => {
            let head: Vec<String> =
                names[..n - 1].iter().map(|s| format!("'{}'", s)).collect();
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

/// `dirpath, dirs, files = item` for the os.walk triple.
fn unpack3<'py>(py: Python<'py>, seq: &B<'py>) -> PyResult<[B<'py>; 3]> {
    if seq.is_instance_of::<PyTuple>() || seq.is_instance_of::<PyList>() {
        let len = seq.len()?;
        if len != 3 {
            return Err(unpack_err(3, Some(len)));
        }
        return Ok([
            seq.get_item(0)?.into_any(),
            seq.get_item(1)?.into_any(),
            seq.get_item(2)?.into_any(),
        ]);
    }
    let mut out: Vec<B<'py>> = Vec::with_capacity(4);
    let mut it = seq.iter()?;
    for _ in 0..3 {
        match it.next() {
            Some(item) => out.push(item?.into_any()),
            None => return Err(unpack_err(3, Some(out.len()))),
        }
    }
    if it.next().is_some() {
        return Err(unpack_err(3, None));
    }
    Ok([out[0].clone(), out[1].clone(), out[2].clone()])
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

// ── module functions (private helpers exposed for parity) ───────────────────

/// `_git(*args, cwd, timeout=30)` — the function-level
/// `from executors import tracked_run` resolves through `builtins.__import__`
/// on EVERY call, then tracked_run runs with the kwargs in source order (§1).
fn git_impl<'py>(
    py: Python<'py>,
    args: &[B<'py>],
    cwd: &B<'py>,
    timeout: &B<'py>,
) -> PyResult<B<'py>> {
    let executors = bi1(py, "__import__", &ps(py, "executors"))?;
    let tracked_run = executors.getattr("tracked_run")?;
    // python passes ONE LIST as the first positional: tracked_run(["git", *args], …)
    let argv_list = PyList::new_bound(py, {
        let mut v: Vec<B<'py>> = vec![ps(py, "git")];
        v.extend(args.iter().cloned());
        v
    });
    let call_args = PyTuple::new_bound(py, [argv_list.into_any()]);
    let kw = kwargs_of(
        py,
        vec![
            ("cwd", cwd.clone()),
            ("capture_output", builtins(py)?.getattr("True")?.into_any()),
            ("text", builtins(py)?.getattr("True")?.into_any()),
            ("encoding", ps(py, "utf-8")),
            ("errors", ps(py, "replace")),
            ("timeout", timeout.clone()),
        ],
    );
    tracked_run.call(call_args, Some(&kw))
}

/// `_which_git()` — `shutil.which("git")`, shutil imported live.
fn which_git_impl<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let which = mod_import(py, "shutil")?.getattr("which")?;
    which.call1((ps(py, "git"),))
}

/// `repo_toplevel(path)` (§2) — python's `not path or not isdir(path) or not
/// _which_git()` SHORT-CIRCUITS: a falsy path never calls isdir, a falsy
/// isdir never calls which.
fn repo_toplevel_impl<'py>(py: Python<'py>, path: &B<'py>) -> PyResult<B<'py>> {
    let osm = mod_import(py, "os")?;
    if !path.is_truthy()? {
        return Ok(none(py));
    }
    let isdir = osm.getattr("path")?.getattr("isdir")?.call1((path,))?;
    if !isdir.is_truthy()? {
        return Ok(none(py));
    }
    let git = which_git_impl(py)?;
    if !git.is_truthy()? {
        return Ok(none(py));
    }
    let args = [ps(py, "rev-parse"), ps(py, "--show-toplevel")];
    let proc = match git_impl(py, &args, path, &obj(py, 30)?) {
        Ok(p) => p,
        Err(e) => {
            let (oe, te) = os_and_timeout(py)?;
            if err_is_any(py, &e, &[&oe, &te]) {
                return Ok(none(py));
            }
            return Err(e);
        }
    };
    let rc = proc.getattr("returncode")?;
    if opb(py, "ne", &rc, &obj(py, 0)?)? {
        return Ok(none(py));
    }
    let stdout = proc.getattr("stdout")?;
    let top = orv(&stdout, &ps(py, ""))?.call_method0("strip")?;
    if top.is_truthy()? {
        let abspath = osm.getattr("path")?.getattr("abspath")?.call1((&top,))?;
        Ok(abspath)
    } else {
        Ok(none(py))
    }
}

/// `_file_fingerprint(path)` (§3).
fn file_fingerprint_impl<'py>(py: Python<'py>, path: &B<'py>) -> PyResult<B<'py>> {
    let osm = mod_import(py, "os")?;
    let getsize = osm.getattr("path")?.getattr("getsize")?.call1((path,));
    let size = match getsize {
        Ok(s) => s,
        Err(e) => {
            let oe = mod_import(py, "builtins")?.getattr("OSError")?;
            if err_is(py, &e, &oe) {
                return Ok(ps(py, "missing"));
            }
            return Err(e);
        }
    };
    let cap = own(py, "MAX_HASH_BYTES")?;
    if opb(py, "gt", &size, &cap)? {
        let mtime = match osm.getattr("path")?.getattr("getmtime")?.call1((path,)) {
            Ok(m) => m,
            Err(_) => obj(py, 0)?,
        };
        return concat(
            py,
            vec![
                ps(py, "size:"),
                fmtv(py, &size)?,
                ps(py, ":mtime:"),
                fmtv(py, &mtime)?,
            ],
        );
    }
    let hashlib = mod_import(py, "hashlib")?;
    let h = hashlib.getattr("sha256")?.call0()?;
    // with open(path, "rb") as f: for chunk in iter(lambda: f.read(65536), b""): h.update(chunk)
    let opened = builtins(py)?.getattr("open")?.call1((path, ps(py, "rb")));
    let f = match opened {
        Ok(x) => match x.getattr("__enter__") {
            Ok(m) => m.call0()?,
            Err(e) => {
                // the with-statement's own wording when the protocol is absent
                if e.is_instance_of::<pyo3::exceptions::PyAttributeError>(py) {
                    let nm = x.get_type().getattr("__name__")?;
                    return Err(PyTypeError::new_err(format!(
                        "'{}' object does not support the context manager protocol",
                        nm.str()?.to_cow()?
                    )));
                }
                return Err(e);
            }
        },
        Err(e) => {
            let (oe, _) = os_and_timeout(py)?;
            if err_is(py, &e, &oe) {
                return concat(py, vec![ps(py, "size:"), fmtv(py, &size)?]);
            }
            return Err(e);
        }
    };
    let sentinel = PyBytes::new_bound(py, b"");
    loop {
        let chunk = f.call_method1("read", (obj(py, 65536)?,));
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let (oe, _) = os_and_timeout(py)?;
                // __exit__ with the live exception info, then re-raise
                let tp = e.get_type_bound(py);
                let val = e.value_bound(py);
                let _ = f.call_method1("__exit__", (&tp, val.as_any(), none(py)));
                if err_is(py, &e, &oe) {
                    return concat(py, vec![ps(py, "size:"), fmtv(py, &size)?]);
                }
                return Err(e);
            }
        };
        if opb(py, "eq", &chunk, sentinel.as_any())? {
            break;
        }
        if let Err(e) = h.call_method1("update", (&chunk,)) {
            let (oe, _) = os_and_timeout(py)?;
            let tp = e.get_type_bound(py);
            let val = e.value_bound(py);
            let _ = f.call_method1("__exit__", (&tp, val.as_any(), none(py)));
            if err_is(py, &e, &oe) {
                return concat(py, vec![ps(py, "size:"), fmtv(py, &size)?]);
            }
            return Err(e);
        }
    }
    let _ = f.call_method1("__exit__", (none(py), none(py), none(py)))?;
    h.call_method0("hexdigest")
}

/// `_walk_files(root)` (§4).
fn walk_files<'py>(py: Python<'py>, root: &B<'py>) -> PyResult<B<'py>> {
    let osm = mod_import(py, "os")?;
    let walker = osm.getattr("walk")?.call1((root,))?;
    let out = PyList::new_bound(py, Vec::<B>::new());
    let skip = own(py, "_SKIP_DIR_NAMES")?;
    for triple in walker.iter()? {
        let triple = triple?;
        let [dirpath, dirs, files] = unpack3(py, &triple)?;
        // dirs[:] = [d for d in dirs if d not in _SKIP_DIR_NAMES]
        let mut kept: Vec<B<'py>> = Vec::new();
        for d in dirs.iter()? {
            let d = d?;
            let inside = opb(py, "contains", &skip, &d)?;
            if !inside {
                kept.push(d);
            }
        }
        let all_sl = builtins(py)?.getattr("slice")?.call1((none(py),))?;
        dirs.call_method1("__setitem__", (&all_sl, PyList::new_bound(py, kept)))?;
        for name in files.iter()? {
            let name = name?;
            let full = osm
                .getattr("path")?
                .getattr("join")?
                .call1((&dirpath, &name))?;
            let rel_raw = osm
                .getattr("path")?
                .getattr("relpath")?
                .call1((&full, root))?;
            let rel = rel_raw.call_method1("replace", (ps(py, "\\"), ps(py, "/")))?;
            let dotted = rel.call_method1("startswith", (ps(py, ".git/"),))?;
            let is_git = opb(py, "eq", &rel, &ps(py, ".git"))?;
            if dotted.is_truthy()? || is_git {
                continue;
            }
            out.append(&rel)?;
        }
    }
    Ok(out.into_any())
}

/// `_snapshot(root)` (§5).
fn snapshot_impl<'py>(py: Python<'py>, root: &B<'py>) -> PyResult<B<'py>> {
    let osm = mod_import(py, "os")?;
    let join = osm.getattr("path")?.getattr("join")?;
    let snap = PyDict::new_bound(py);
    let rels = walk_files(py, root)?;
    for rel in rels.iter()? {
        let rel = rel?;
        let parts: Vec<B<'py>> = rel
            .call_method1("split", (ps(py, "/"),))?
            .iter()?
            .collect::<PyResult<Vec<_>>>()?;
        let mut args: Vec<B<'py>> = vec![root.clone()];
        args.extend(parts);
        let full = join.call(PyTuple::new_bound(py, args), None)?;
        let fp = file_fingerprint_impl(py, &full)?;
        snap.set_item(&rel, fp)?;
    }
    Ok(snap.into_any())
}

/// `_copy_file(src, dst)`.
fn copy_file_impl<'py>(py: Python<'py>, src: &B<'py>, dst: &B<'py>) -> PyResult<B<'py>> {
    let osm = mod_import(py, "os")?;
    let dirname = osm.getattr("path")?.getattr("dirname")?.call1((dst,))?;
    let dir = orv(&dirname, &ps(py, "."))?;
    let mk = osm.getattr("makedirs")?;
    let kw = kwargs_of(py, vec![("exist_ok", builtins(py)?.getattr("True")?.into_any())]);
    mk.call((&dir,), Some(&kw))?;
    let copy2 = mod_import(py, "shutil")?.getattr("copy2")?;
    copy2.call1((src, dst))
}

/// `_sync_dirty(toplevel, wt_root)` (§8).
fn sync_dirty_impl<'py>(py: Python<'py>, toplevel: &B<'py>, wt_root: &B<'py>) -> PyResult<B<'py>> {
    let osm = mod_import(py, "os")?;
    let (oe, te) = os_and_timeout(py)?;
    let args = [
        ps(py, "status"),
        ps(py, "--porcelain"),
        ps(py, "-uall"),
        ps(py, "--ignore-submodules=none"),
    ];
    let proc = match git_impl(py, &args, toplevel, &obj(py, 30)?) {
        Ok(p) => p,
        Err(e) => {
            if err_is_any(py, &e, &[&oe, &te]) {
                return Ok(none(py));
            }
            return Err(e);
        }
    };
    let rc = proc.getattr("returncode")?;
    if opb(py, "ne", &rc, &obj(py, 0)?)? {
        return Ok(none(py));
    }
    let stdout = proc.getattr("stdout")?;
    let text = orv(&stdout, &ps(py, ""))?;
    let lines = text.call_method0("splitlines")?;
    for line in lines.iter()? {
        let line = line?;
        let l = bi1(py, "len", &line)?;
        if opb(py, "lt", &l, &obj(py, 4)?)? {
            continue;
        }
        let tail = slice_head(py, &line, 3)?;
        let mut rel = tail.call_method0("strip")?;
        let arrow = ps(py, " -> ");
        if opb(py, "contains", &rel, &arrow)? {
            let parts = rel.call_method1("split", (&arrow, &obj(py, 1)?))?;
            rel = parts.get_item(-1)?;
        }
        rel = rel.call_method0("strip")?;
        rel = rel.call_method1("strip", (ps(py, "\""),))?;
        if !rel.is_truthy()? {
            continue;
        }
        let dotted = rel.call_method1("startswith", (ps(py, ".git"),))?;
        if dotted.is_truthy()? {
            continue;
        }
        let src = osm.getattr("path")?.getattr("join")?.call1((toplevel, &rel))?;
        let dst = osm.getattr("path")?.getattr("join")?.call1((wt_root, &rel))?;
        let isfile_src = osm.getattr("path")?.getattr("isfile")?.call1((&src,))?;
        if isfile_src.is_truthy()? {
            if let Err(e) = copy_file_impl(py, &src, &dst) {
                if err_is(py, &e, &oe) {
                    continue; // fail-open
                }
                return Err(e);
            }
        } else {
            let exists_src = osm.getattr("path")?.getattr("exists")?.call1((&src,))?;
            if !exists_src.is_truthy()? {
                let isfile_dst = osm.getattr("path")?.getattr("isfile")?.call1((&dst,))?;
                if isfile_dst.is_truthy()? {
                    if let Err(e) = osm.getattr("remove")?.call1((&dst,)) {
                        if err_is(py, &e, &oe) {
                            continue; // fail-open
                        }
                        return Err(e);
                    }
                }
            }
        }
    }
    Ok(none(py))
}

/// `create(source_root, label="")` (§9-§12). None = caller should overlay.
fn create_impl<'py>(py: Python<'py>, source_root: &B<'py>, label: &B<'py>) -> PyResult<B<'py>> {
    let osm = mod_import(py, "os")?;
    if !source_root.is_truthy()? {
        return Ok(none(py));
    }
    let isdir = osm.getattr("path")?.getattr("isdir")?.call1((source_root,))?;
    if !isdir.is_truthy()? {
        return Ok(none(py));
    }
    let git = which_git_impl(py)?;
    if !git.is_truthy()? {
        return Ok(none(py));
    }
    let toplevel = {
        let f = own(py, "repo_toplevel")?;
        f.call1((source_root,))?
    };
    if !toplevel.is_truthy()? {
        return Ok(none(py));
    }
    let (oe, te) = os_and_timeout(py)?;
    let head_args = [ps(py, "rev-parse"), ps(py, "--verify"), ps(py, "HEAD")];
    let head = match git_impl(py, &head_args, &toplevel, &obj(py, 30)?) {
        Ok(h) => h,
        Err(e) => {
            if err_is_any(py, &e, &[&oe, &te]) {
                return Ok(none(py));
            }
            return Err(e);
        }
    };
    let rc = head.getattr("returncode")?;
    if opb(py, "ne", &rc, &obj(py, 0)?)? {
        return Ok(none(py));
    }

    let u = mod_import(py, "uuid")?.getattr("uuid4")?.call0()?;
    let hex = u.getattr("hex")?;
    let wt_id = slice_head(py, &hex, 8)?;
    let prefix = concat(py, vec![ps(py, "ovolve-wt-"), wt_id.clone(), ps(py, "-")])?;
    let mkdtemp = mod_import(py, "tempfile")?.getattr("mkdtemp")?;
    let kw = kwargs_of(py, vec![("prefix", prefix)]);
    let parent = mkdtemp.call((), Some(&kw))?;
    let wt_path = osm.getattr("path")?.getattr("join")?.call1((&parent, ps(py, "tree")))?;

    let add_args = [
        ps(py, "worktree"),
        ps(py, "add"),
        ps(py, "--detach"),
        ps(py, "--force"),
        wt_path.clone(),
        ps(py, "HEAD"),
    ];
    let added = match git_impl(py, &add_args, &toplevel, &obj(py, 60)?) {
        Ok(a) => a,
        Err(e) => {
            if err_is_any(py, &e, &[&oe, &te]) {
                let rmtree = mod_import(py, "shutil")?.getattr("rmtree")?;
                let kw = kwargs_of(py, vec![("ignore_errors", builtins(py)?.getattr("True")?.into_any())]);
                let _ = rmtree.call((&parent,), Some(&kw));
                return Ok(none(py));
            }
            return Err(e);
        }
    };
    let added_rc = added.getattr("returncode")?;
    // `added.returncode != 0 or not os.path.isdir(wt_path)` SHORT-CIRCUITS:
    // a failing rc skips the isdir call entirely.
    if opb(py, "ne", &added_rc, &obj(py, 0)?)? {
        let rmtree = mod_import(py, "shutil")?.getattr("rmtree")?;
        let kw = kwargs_of(py, vec![("ignore_errors", builtins(py)?.getattr("True")?.into_any())]);
        let _ = rmtree.call((parent.clone(),), Some(&kw));
        return Ok(none(py));
    }
    let isdir_wt = osm.getattr("path")?.getattr("isdir")?.call1((&wt_path,))?;
    if !isdir_wt.is_truthy()? {
        let rmtree = mod_import(py, "shutil")?.getattr("rmtree")?;
        let kw = kwargs_of(py, vec![("ignore_errors", builtins(py)?.getattr("True")?.into_any())]);
        let _ = rmtree.call((parent.clone(),), Some(&kw));
        return Ok(none(py));
    }

    if let Err(e) = {
        let sd = own(py, "_sync_dirty")?;
        sd.call1((&toplevel, &wt_path))
    } {
        if is_py_exc(&e, py) {
            // fail-open: 可选增强，失败不影响主流程
        } else {
            return Err(e);
        }
    }

    let abspath = osm.getattr("path")?.getattr("abspath")?.call1((source_root,));
    let rel = match osm.getattr("path")?.getattr("relpath")?.call1((&abspath?, &toplevel)) {
        Ok(r) => r,
        Err(e) => {
            let ve = mod_import(py, "builtins")?.getattr("ValueError")?;
            if err_is(py, &e, &ve) {
                ps(py, ".")
            } else {
                return Err(e);
            }
        }
    };
    let curdir = osm.getattr("curdir")?;
    let pair = PyTuple::new_bound(py, [curdir, ps(py, "")]).into_any();
    let in_pair = op(py, "contains", &pair, &rel)?;
    let child_root = if in_pair.is_truthy()? {
        wt_path.clone()
    } else {
        let dots = rel.call_method1("startswith", (ps(py, ".."),))?;
        if dots.is_truthy()? {
            let dp = own(py, "discard_path")?;
            dp.call1((&toplevel, &wt_path, &parent))?;
            return Ok(none(py));
        }
        let cr = osm.getattr("path")?.getattr("join")?.call1((&wt_path, &rel))?;
        let mk = osm.getattr("makedirs")?;
        let kw = kwargs_of(py, vec![("exist_ok", builtins(py)?.getattr("True")?.into_any())]);
        mk.call((&cr,), Some(&kw))?;
        cr
    };

    let child_abs = osm.getattr("path")?.getattr("abspath")?.call1((&child_root,))?;
    let source_abs = osm.getattr("path")?.getattr("abspath")?.call1((source_root,))?;
    let wt_abs = osm.getattr("path")?.getattr("abspath")?.call1((&wt_path,))?;
    let snap = {
        let sf = own(py, "_snapshot")?;
        sf.call1((&child_abs,))?
    };
    let wc = own(py, "WorktreeCopy")?;
    let kw = kwargs_of(
        py,
        vec![
            ("id", wt_id),
            ("root", child_abs),
            ("source_root", source_abs),
            ("label", label.clone()),
            ("wt_root", wt_abs),
            ("repo_toplevel", toplevel),
            ("_snapshot", snap),
        ],
    );
    wc.call((), Some(&kw))
}

/// `discard_path(toplevel, wt_path, parent="")` (§8/§13 family).
fn discard_path_impl<'py>(
    py: Python<'py>,
    toplevel: &B<'py>,
    wt_path: &B<'py>,
    parent: &B<'py>,
) -> PyResult<B<'py>> {
    let (oe, te) = os_and_timeout(py)?;
    let args = [ps(py, "worktree"), ps(py, "remove"), ps(py, "--force"), wt_path.clone()];
    if let Err(e) = git_impl(py, &args, toplevel, &obj(py, 60)?) {
        if !err_is_any(py, &e, &[&oe, &te]) {
            return Err(e);
        }
    }
    let rmtree = mod_import(py, "shutil")?.getattr("rmtree")?;
    let kw = kwargs_of(py, vec![("ignore_errors", builtins(py)?.getattr("True")?.into_any())]);
    rmtree.call((wt_path.clone(),), Some(&kw))?;
    if parent.is_truthy()? {
        rmtree.call((parent.clone(),), Some(&kw))?;
    }
    let prune_args = [ps(py, "worktree"), ps(py, "prune")];
    if let Err(e) = git_impl(py, &prune_args, toplevel, &obj(py, 30)?) {
        if !err_is_any(py, &e, &[&oe, &te]) {
            return Err(e);
        }
    }
    Ok(none(py))
}

/// `discard(wt)` (§13).
fn discard_impl<'py>(py: Python<'py>, wt: &B<'py>) -> PyResult<B<'py>> {
    if wt.is_none() {
        return Ok(none(py));
    }
    let wt_root = wt.getattr("wt_root")?;
    let parent = if wt_root.is_truthy()? {
        let path = mod_import(py, "pathlib")?.getattr("Path")?.call1((&wt_root,))?;
        let p = path.getattr("parent")?;
        str_of(py, &p)?
    } else {
        ps(py, "")
    };
    let toplevel = orv(&wt.getattr("repo_toplevel")?, &wt.getattr("source_root")?)?;
    let path = orv(&wt_root, &wt.getattr("root")?)?;
    let dp = own(py, "discard_path")?;
    dp.call1((&toplevel, &path, &parent))
}

// ── WorktreeCopy (plain dataclass, repr=False on _snapshot) ─────────────────

/// One sub-agent's git worktree, duck-typed as a WorkCopy.
#[pyclass(module = "worktree", name = "WorktreeCopy")]
struct WorktreeCopy {
    #[pyo3(get, set)]
    id: PyObject,
    #[pyo3(get, set)]
    root: PyObject,
    #[pyo3(get, set)]
    source_root: PyObject,
    #[pyo3(get, set)]
    label: PyObject,
    #[pyo3(get, set)]
    kind: PyObject,
    #[pyo3(get, set)]
    wt_root: PyObject,
    #[pyo3(get, set)]
    repo_toplevel: PyObject,
    #[pyo3(get)]
    _snapshot: PyObject,
}

#[pymethods]
impl WorktreeCopy {
    #[new]
    #[pyo3(signature = (*args, **kwargs))]
    fn py_new<'py>(
        py: Python<'py>,
        args: &Bound<'py, PyTuple>,
        kwargs: Option<&Bound<'py, PyDict>>,
    ) -> PyResult<Self> {
        let s = bind_init(py, args, kwargs)?;
        Ok(WorktreeCopy {
            id: s[0].clone_ref(py),
            root: s[1].clone_ref(py),
            source_root: s[2].clone_ref(py),
            label: s[3].clone_ref(py),
            kind: s[4].clone_ref(py),
            wt_root: s[5].clone_ref(py),
            repo_toplevel: s[6].clone_ref(py),
            _snapshot: s[7].clone_ref(py),
        })
    }

    /// the generated dataclass __repr__ — _snapshot EXCLUDED (repr=False, §14).
    fn __repr__<'py>(&self, py: Python<'py>) -> PyResult<B<'py>> {
        let r = |v: &PyObject| -> PyResult<B<'py>> { bi1(py, "repr", v.bind(py)) };
        concat(
            py,
            vec![
                ps(py, "WorktreeCopy(id="),
                r(&self.id)?,
                ps(py, ", root="),
                r(&self.root)?,
                ps(py, ", source_root="),
                r(&self.source_root)?,
                ps(py, ", label="),
                r(&self.label)?,
                ps(py, ", kind="),
                r(&self.kind)?,
                ps(py, ", wt_root="),
                r(&self.wt_root)?,
                ps(py, ", repo_toplevel="),
                r(&self.repo_toplevel)?,
                ps(py, ")"),
            ],
        )
    }

    /// dataclass __eq__ over the FULL field order (_snapshot LAST, repr or
    /// not); only when `other.__class__ is self.__class__`.
    fn __eq__<'py>(&self, py: Python<'py>, other: &B<'py>) -> PyResult<PyObject> {
        let cls = <WorktreeCopy as pyo3::PyTypeInfo>::type_object_bound(py);
        if !other.get_type().is(&cls) {
            return Ok(py.NotImplemented());
        }
        let o = other.extract::<PyRef<'py, WorktreeCopy>>()?;
        let mine = PyTuple::new_bound(
            py,
            [
                self.id.bind(py),
                self.root.bind(py),
                self.source_root.bind(py),
                self.label.bind(py),
                self.kind.bind(py),
                self.wt_root.bind(py),
                self.repo_toplevel.bind(py),
                self._snapshot.bind(py),
            ],
        )
        .into_any();
        let theirs = PyTuple::new_bound(
            py,
            [
                o.id.bind(py),
                o.root.bind(py),
                o.source_root.bind(py),
                o.label.bind(py),
                o.kind.bind(py),
                o.wt_root.bind(py),
                o.repo_toplevel.bind(py),
                o._snapshot.bind(py),
            ],
        )
        .into_any();
        let eq = op(py, "eq", &mine, &theirs)?;
        Ok(eq.unbind())
    }

    /// the dataclass sets __hash__ = None (eq=True default): unhashable.
    fn __hash__(&self) -> PyResult<isize> {
        Err(PyTypeError::new_err("unhashable type: 'WorktreeCopy'"))
    }

    /// Files in this worktree that differ from the post-create snapshot (§6).
    fn changes<'py>(&self, py: Python<'py>) -> PyResult<B<'py>> {
        let rows = PyList::new_bound(py, Vec::<B>::new());
        let self_snap = self._snapshot.bind(py);
        let root = self.root.bind(py).clone();
        let current_list = walk_files(py, &root)?;
        let current: B<'py> = call_bi(py, "set", (&current_list,))?;
        let previous: B<'py> = call_bi(py, "set", (self_snap.clone(),))?;
        let union = op(py, "or_", &current, &previous)?;
        let sorted_union = call_bi(py, "sorted", (&union,))?;
        let osm = mod_import(py, "os")?;
        let join = osm.getattr("path")?.getattr("join")?;
        let getsize = osm.getattr("path")?.getattr("getsize")?;
        let oe = mod_import(py, "builtins")?.getattr("OSError")?;
        for rel in sorted_union.iter()? {
            let rel = rel?;
            let parts: Vec<B<'py>> = rel
                .call_method1("split", (ps(py, "/"),))?
                .iter()?
                .collect::<PyResult<Vec<_>>>()?;
            let mut args: Vec<B<'py>> = vec![root.clone()];
            args.extend(parts);
            let full = join.call(PyTuple::new_bound(py, args), None)?;
            let in_current = opb(py, "contains", &current, &rel)?;
            if !in_current {
                let d = PyDict::new_bound(py);
                d.set_item("rel", &rel)?;
                d.set_item("kind", ps(py, "delete"))?;
                d.set_item("bytes", obj(py, 0)?)?;
                rows.append(d.into_any())?;
                continue;
            }
            let in_previous = opb(py, "contains", &previous, &rel)?;
            let changed = if !in_previous {
                true // short-circuit: no .get, no fingerprint call
            } else {
                let got = self_snap.call_method1("get", (&rel,))?;
                let fp = file_fingerprint_impl(py, &full)?;
                !opb(py, "ne", &got, &fp)?
            };
            if changed {
                let size = match getsize.call1((&full,)) {
                    Ok(s) => s,
                    Err(e) => {
                        if err_is(py, &e, &oe) {
                            obj(py, 0)?
                        } else {
                            return Err(e);
                        }
                    }
                };
                let d = PyDict::new_bound(py);
                d.set_item("rel", &rel)?;
                d.set_item("kind", ps(py, "write"))?;
                d.set_item("bytes", &size)?;
                rows.append(d.into_any())?;
            }
        }
        Ok(rows.into_any())
    }

    /// `report()` (§7).
    fn report<'py>(&self, py: Python<'py>) -> PyResult<B<'py>> {
        let rows = self.changes(py)?;
        let mut paths: Vec<B<'py>> = Vec::new();
        for r in rows.iter()? {
            let r = r?;
            paths.push(r.get_item("rel")?);
        }
        let d = PyDict::new_bound(py);
        d.set_item("id", &self.id)?;
        d.set_item("label", &self.label)?;
        d.set_item("root", &self.root)?;
        d.set_item("kind", &self.kind)?;
        d.set_item("changes", &rows)?;
        d.set_item("paths", PyList::new_bound(py, paths))?;
        Ok(d.into_any())
    }

    /// `cleanup()` — the module-global `discard` read at call time (§14).
    fn cleanup<'py>(self_: PyRef<'py, Self>, py: Python<'py>) -> PyResult<B<'py>> {
        let discard = own(py, "discard")?;
        let me: Py<WorktreeCopy> = self_.into();
        let me_any: PyObject = me.into_any();
        discard.call1((me_any.into_bound(py),))
    }
}

/// WorktreeCopy.__init__ binding: (id, root, source_root) required;
/// label/kind/wt_root/repo_toplevel/_snapshot have def-time defaults.
fn bind_init<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<Vec<PyObject>> {
    let params: [&str; 8] = [
        "id", "root", "source_root", "label", "kind", "wt_root", "repo_toplevel", "_snapshot",
    ];
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
    cands.extend_from_slice(&params);
    if let Some(kw) = kwargs {
        for (k, v) in kw.iter() {
            let key: String = match k.extract() {
                Ok(s) => s,
                Err(_) => return Err(PyTypeError::new_err("keywords must be strings")),
            };
            match params.iter().position(|p| *p == key) {
                None => {
                    if key == "self" {
                        return Err(PyTypeError::new_err(
                            "WorktreeCopy.__init__() got multiple values for argument 'self'",
                        ));
                    }
                    return Err(PyTypeError::new_err(unexpected_keyword(
                        "WorktreeCopy.__init__",
                        &key,
                        &cands,
                    )));
                }
                Some(i) => {
                    if slots[i].is_some() {
                        return Err(PyTypeError::new_err(format!(
                            "WorktreeCopy.__init__() got multiple values for argument '{}'",
                            key
                        )));
                    }
                    slots[i] = Some(v.to_object(py));
                }
            }
        }
    }
    if nargs > total {
        return Err(PyTypeError::new_err(too_many_positional(
            "WorktreeCopy.__init__",
            total + 1,
            total - 3, // five fields carry defaults: "from 4 to 9"
            nargs + 1,
        )));
    }
    // only the FIRST THREE are required (label/kind/wt_root/repo_toplevel/
    // _snapshot carry def-time defaults in the dataclass).
    let required = 3;
    let missing: Vec<&str> = params[..required]
        .iter()
        .zip(slots[..required].iter())
        .filter(|(_, s)| s.is_none())
        .map(|(n, _)| *n)
        .collect();
    if !missing.is_empty() {
        let k = missing.len();
        return Err(PyTypeError::new_err(format!(
            "WorktreeCopy.__init__() missing {} required positional argument{}: {}",
            k,
            if k == 1 { "" } else { "s" },
            quoted_and(&missing)
        )));
    }
    // §14: def-time defaults — "" / KIND (class-creation snapshot) / "" / ""
    // and a FRESH dict per instance for _snapshot.
    Ok(slots
        .into_iter()
        .enumerate()
        .map(|(i, s)| match s {
            Some(v) => v,
            None => match i {
                3 | 5 | 6 => ps(py, "").unbind(),
                4 => ps(py, KIND).unbind(),
                _ => PyDict::new_bound(py).into_any().unbind(),
            },
        })
        .collect())
}

// ── exported callables ──────────────────────────────────────────────────────

/// Absolute toplevel of the git repo containing ``path``, or None.
#[pyfunction]
#[pyo3(name = "repo_toplevel", signature = (*args, **kwargs))]
fn py_repo_toplevel<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("repo_toplevel", &["path"], 1, args, kwargs)?;
    Ok(repo_toplevel_impl(py, slots[0].as_ref().expect("validated"))?.unbind())
}

// `_git(*args, cwd, timeout=30)` — §1.
#[pyfunction]
#[pyo3(name = "_git", signature = (*args, **kwargs))]
fn py_git<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    // bind: *args (varargs) + cwd (required keyword, after *args) + timeout=30.
    // All positionals belong to *args; cwd may only arrive by keyword.
    let mut positional: Vec<B<'py>> = Vec::new();
    let mut cwd: Option<B<'py>> = None;
    let mut timeout: Option<B<'py>> = None;
    for a in args.iter() {
        positional.push(a.into_any());
    }
    if let Some(kw) = kwargs {
        for (k, v) in kw.iter() {
            let key: String = k.extract()?;
            match key.as_str() {
                "cwd" => {
                    if cwd.is_some() {
                        return Err(PyTypeError::new_err(
                            "_git() got multiple values for argument 'cwd'",
                        ));
                    }
                    cwd = Some(v.into_any());
                }
                "timeout" => {
                    if timeout.is_some() {
                        return Err(PyTypeError::new_err(
                            "_git() got multiple values for argument 'timeout'",
                        ));
                    }
                    timeout = Some(v.into_any());
                }
                _ => {
                    return Err(PyTypeError::new_err(unexpected_keyword(
                        "_git",
                        &key,
                        &["args", "cwd", "timeout"],
                    )))
                }
            }
        }
    }
    let cwd = match cwd {
        Some(c) => c,
        None => {
            return Err(PyTypeError::new_err(
                "_git() missing 1 required keyword-only argument: 'cwd'",
            ))
        }
    };
    let timeout = timeout.unwrap_or_else(|| obj(py, 30).expect("int"));
    let argv: Vec<B<'py>> = positional;
    Ok(git_impl(py, &argv, &cwd, &timeout)?.unbind())
}

// `_which_git()`.
#[pyfunction]
#[pyo3(name = "_which_git", signature = (*args, **kwargs))]
fn py_which_git<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let _ = bind_call("_which_git", &[], 0, args, kwargs)?;
    Ok(which_git_impl(py)?.unbind())
}

// `_file_fingerprint(path)` — §3.
#[pyfunction]
#[pyo3(name = "_file_fingerprint", signature = (*args, **kwargs))]
fn py_file_fingerprint<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("_file_fingerprint", &["path"], 1, args, kwargs)?;
    Ok(file_fingerprint_impl(py, slots[0].as_ref().expect("validated"))?.unbind())
}

// `_walk_files(root)` — §4.
#[pyfunction]
#[pyo3(name = "_walk_files", signature = (*args, **kwargs))]
fn py_walk_files<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("_walk_files", &["root"], 1, args, kwargs)?;
    Ok(walk_files(py, slots[0].as_ref().expect("validated"))?.unbind())
}

// `_snapshot(root)` — §5.
#[pyfunction]
#[pyo3(name = "_snapshot", signature = (*args, **kwargs))]
fn py_snapshot<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("_snapshot", &["root"], 1, args, kwargs)?;
    Ok(snapshot_impl(py, slots[0].as_ref().expect("validated"))?.unbind())
}

// `_copy_file(src, dst)`.
#[pyfunction]
#[pyo3(name = "_copy_file", signature = (*args, **kwargs))]
fn py_copy_file<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("_copy_file", &["src", "dst"], 2, args, kwargs)?;
    Ok(copy_file_impl(
        py,
        slots[0].as_ref().expect("validated"),
        slots[1].as_ref().expect("validated"),
    )?
    .unbind())
}

// `_sync_dirty(toplevel, wt_root)` — §8.
#[pyfunction]
#[pyo3(name = "_sync_dirty", signature = (*args, **kwargs))]
fn py_sync_dirty<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("_sync_dirty", &["toplevel", "wt_root"], 2, args, kwargs)?;
    Ok(sync_dirty_impl(
        py,
        slots[0].as_ref().expect("validated"),
        slots[1].as_ref().expect("validated"),
    )?
    .unbind())
}

/// Open a detached worktree over ``source_root``. None = caller should overlay.
#[pyfunction]
#[pyo3(name = "create", signature = (*args, **kwargs))]
fn py_create<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("create", &["source_root", "label"], 1, args, kwargs)?;
    let label = slots[1]
        .as_ref()
        .map(|b| b.clone())
        .unwrap_or_else(|| ps(py, "").into_any());
    Ok(create_impl(py, slots[0].as_ref().expect("validated"), &label)?.unbind())
}

// `discard_path(toplevel, wt_path, parent="")`.
#[pyfunction]
#[pyo3(name = "discard_path", signature = (*args, **kwargs))]
fn py_discard_path<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("discard_path", &["toplevel", "wt_path", "parent"], 2, args, kwargs)?;
    let parent = slots[2]
        .as_ref()
        .map(|b| b.clone())
        .unwrap_or_else(|| ps(py, "").into_any());
    Ok(discard_path_impl(
        py,
        slots[0].as_ref().expect("validated"),
        slots[1].as_ref().expect("validated"),
        &parent,
    )?
    .unbind())
}

// `discard(wt)` — §13.
#[pyfunction]
#[pyo3(name = "discard", signature = (*args, **kwargs))]
fn py_discard<'py>(
    py: Python<'py>,
    args: &Bound<'py, PyTuple>,
    kwargs: Option<&Bound<'py, PyDict>>,
) -> PyResult<PyObject> {
    let slots = bind_call("discard", &["wt"], 1, args, kwargs)?;
    Ok(discard_impl(py, slots[0].as_ref().expect("validated"))?.unbind())
}

// ── registration ────────────────────────────────────────────────────────────

pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(py, "worktree")?;
    m.add_function(wrap_pyfunction!(py_repo_toplevel, &m)?)?;
    m.add_function(wrap_pyfunction!(py_git, &m)?)?;
    m.add_function(wrap_pyfunction!(py_which_git, &m)?)?;
    m.add_function(wrap_pyfunction!(py_file_fingerprint, &m)?)?;
    m.add_function(wrap_pyfunction!(py_walk_files, &m)?)?;
    m.add_function(wrap_pyfunction!(py_snapshot, &m)?)?;
    m.add_function(wrap_pyfunction!(py_copy_file, &m)?)?;
    m.add_function(wrap_pyfunction!(py_sync_dirty, &m)?)?;
    m.add_function(wrap_pyfunction!(py_create, &m)?)?;
    m.add_function(wrap_pyfunction!(py_discard_path, &m)?)?;
    m.add_function(wrap_pyfunction!(py_discard, &m)?)?;
    m.add_class::<WorktreeCopy>()?;

    m.add("KIND", KIND)?;
    m.add("MAX_HASH_BYTES", MAX_HASH_BYTES)?;
    let skip_members = PyList::new_bound(
        py,
        vec![
            ps(py, ".git"),
            ps(py, "__pycache__"),
            ps(py, "node_modules"),
            ps(py, ".venv"),
            ps(py, "venv"),
        ],
    );
    let skip = call_bi(py, "set", (&skip_members,))?;
    m.add("_SKIP_DIR_NAMES", skip)?;

    // import-time names the python module binds (stdlib, no cycle risk).
    m.add("hashlib", mod_import(py, "hashlib")?)?;
    m.add("os", mod_import(py, "os")?)?;
    m.add("shutil", mod_import(py, "shutil")?)?;
    m.add("subprocess", mod_import(py, "subprocess")?)?;
    m.add("tempfile", mod_import(py, "tempfile")?)?;
    m.add("uuid", mod_import(py, "uuid")?)?;
    m.add("Path", mod_import(py, "pathlib")?.getattr("Path")?)?;
    m.add("Optional", mod_import(py, "typing")?.getattr("Optional")?)?;

    *ST.lock() = Some(m.clone().unbind());
    parent.add_submodule(&m)?;
    Ok(())
}
