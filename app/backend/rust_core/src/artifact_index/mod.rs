//! artifact_index — Rust port of `app/backend/artifact_index.py` (wave-5, Rust).
//!
//! Read-only session artifact index: unions image refs parsed out of message
//! metadata with the snapshot-store change log, collapses per file, resolves
//! on-disk existence, sorts newest-first (seq tiebreak) and caps at
//! MAX_ARTIFACTS. Behavior is matched to the Python canonical bug-for-bug:
//! every value flows through as a live CPython object and int()/round-trip
//! semantics, truthiness (`or`) and os.path / os.stat / json.loads calls go to
//! the *real* Python implementations, so error types, partial-disclosure
//! fail-open scopes and dict key order are identical.
//!
//! DIVERGENCE(port): sort keys (createdAt, seq) are held as i64 in the Rust
//! sorter; CPython ints beyond 2^63 would compare correctly in Python but
//! raise here. Not reachable through the JSON/wire values these fields carry
//! (seq is a sqlite rowid, created_at a unix timestamp).
//! DIVERGENCE(port): the fail-open `except Exception: pass` blocks swallow the
//! exception objects identically; only the raise-site message of a
//! non-dict row reaching `.get` differs in text (never surfaced - swallowed).
// PORT STATUS: confidence=high todos=[0]

use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList, PyString};

type B<'py> = Bound<'py, PyAny>;

const MAX_ARTIFACTS: usize = 400;

// ── CPython-semantics helpers ───────────────────────────────────────────────

fn obj<'py>(py: Python<'py>, v: i64) -> PyResult<B<'py>> {
    Ok(v.to_object(py).into_bound(py).into_any())
}

fn empty_str<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(PyString::new_bound(py, "").into_any())
}

fn builtins(py: Python<'_>) -> PyResult<Bound<'_, PyModule>> {
    Ok(py.import_bound("builtins")?)
}

/// `int(x)` via the real builtin; keeps the result as a Python object.
fn py_int<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("int")?.call1((x,))?)
}

/// `str(x)` / f-string substitution of an arbitrary object.
fn py_str(x: &B<'_>) -> PyResult<String> {
    let s = x.str()?;
    s.extract::<String>()
}

/// `dget(d, k)`: mirrors `d.get(k)` - goes through the object's own `.get`,
/// so non-dict rows raise AttributeError exactly like Python. Returns None
/// for a missing key or an explicit None value (same `or` semantics).
fn dget<'py>(d: &B<'py>, key: &str) -> PyResult<Option<B<'py>>> {
    let v = d.getattr("get")?.call1((key,))?;
    if v.is_none() {
        Ok(None)
    } else {
        Ok(Some(v))
    }
}

/// `x or default` (returns the original object when truthy).
fn or_default<'py>(v: Option<B<'py>>, def: &B<'py>) -> PyResult<B<'py>> {
    match v {
        Some(x) if x.is_truthy()? => Ok(x),
        _ => Ok(def.clone()),
    }
}

fn zero<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    obj(py, 0)
}

/// Python's `except Exception:` — BaseExceptions (KeyboardInterrupt, SystemExit)
/// are NOT swallowed by the canonical fail-open blocks and must propagate.
fn is_py_exc(e: &PyErr, py: Python<'_>) -> bool {
    e.is_instance_of::<pyo3::exceptions::PyException>(py)
}

// ── _rel / _turn_map / _turn_for_seq ────────────────────────────────────────

/// Port of `_rel(path, workspace)`: os.path.relpath through CPython so the
/// cross-drive ValueError and separator rules are identical by construction.
fn rel<'py>(py: Python<'py>, path: &B<'py>, workspace: &B<'py>) -> PyResult<B<'py>> {
    if !workspace.is_truthy()? {
        return Ok(path.clone());
    }
    let ospath = py.import_bound("os")?.getattr("path")?;
    let r = ospath.call_method1("relpath", (path, workspace));
    let relv = match r {
        Ok(v) => v,
        Err(e) if e.is_instance_of::<pyo3::exceptions::PyValueError>(py) => {
            return Ok(path.clone()) // different drive on Windows
        }
        Err(e) => return Err(e),
    };
    if relv.call_method1("startswith", ("..",))?.is_truthy()? {
        return Ok(path.clone());
    }
    let sep = py.import_bound("os")?.getattr("sep")?;
    Ok(relv.call_method1("replace", (sep, "/"))?)
}

/// Port of `_turn_map(messages)`.
fn turn_map<'py>(py: Python<'py>, messages: &B<'py>) -> PyResult<Bound<'py, PyList>> {
    let out = PyList::empty_bound(py);
    for m in messages.iter()? {
        let m = m?;
        let role = dget(&m, "role")?;
        let is_user = match &role {
            Some(r) => r.eq("user")?,
            None => false,
        };
        if is_user {
            let s = or_default(dget(&m, "seq")?, &zero(py)?)?;
            out.append(py_int(py, &s)?)?;
        }
    }
    Ok(out)
}

/// Port of `_turn_for_seq(user_seqs, seq)`.
fn turn_for_seq(user_seqs: &Bound<'_, PyList>, seq: &B<'_>) -> PyResult<i64> {
    let mut turn: i64 = -1;
    for (i, s) in user_seqs.iter().enumerate() {
        if s.le(seq)? {
            turn = i as i64;
        } else {
            break;
        }
    }
    Ok(turn)
}

// ── _image_artifacts ────────────────────────────────────────────────────────

fn image_artifacts<'py>(
    py: Python<'py>,
    messages: &B<'py>,
    user_seqs: &Bound<'py, PyList>,
) -> PyResult<Bound<'py, PyList>> {
    let json_loads = py.import_bound("json")?.getattr("loads")?;
    let out = PyList::empty_bound(py);
    for m in messages.iter()? {
        let m = m?;
        let raw = or_default(dget(&m, "metadata")?, &PyString::new_bound(py, "{}").into_any())?;
        let meta: B<'py> = if raw.downcast::<PyString>().is_ok() {
            match json_loads.call1((raw,)) {
                Ok(v) => v,
                Err(e)
                    if e.is_instance_of::<pyo3::exceptions::PyValueError>(py)
                        || e.is_instance_of::<pyo3::exceptions::PyTypeError>(py) =>
                {
                    continue // a corrupt metadata blob loses its images, not the whole index
                }
                Err(e) => return Err(e),
            }
        } else {
            or_default(Some(raw), &PyDict::new_bound(py).into_any())?
        };
        let refs = match dget(&meta, "images")? {
            Some(v) if v.downcast::<PyList>().is_ok() => v,
            _ => continue, // `if not isinstance(refs, list): continue`
        };
        let seq = py_int(py, &or_default(dget(&m, "seq")?, &zero(py)?)?)?;
        let created = py_int(py, &or_default(dget(&m, "created_at")?, &zero(py)?)?)?;
        for rf in refs.iter()? {
            let rf = rf?;
            if !rf.downcast::<PyDict>().is_ok() {
                continue;
            }
            let idv = match dget(&rf, "id")? {
                Some(v) if v.is_truthy()? => v,
                _ => continue,
            };
            let d = PyDict::new_bound(py);
            d.set_item("id", format!("img:{}", py_str(&idv)?))?;
            d.set_item("kind", "image")?;
            let name = match dget(&rf, "name")? {
                Some(v) if v.is_truthy()? => v,
                _ => {
                    let ext = or_default(dget(&rf, "ext")?, &PyString::new_bound(py, "png").into_any())?;
                    // f"{id}.{ext}" — format() applies str() to non-str members
                    // (the JSON store can carry ints here), so stringify both.
                    PyString::new_bound(py, &format!("{}.{}", py_str(&idv)?, py_str(&ext)?)).into_any()
                }
            };
            d.set_item("name", name)?;
            d.set_item("path", or_default(dget(&rf, "path")?, &empty_str(py)?)?)?;
            let url = match dget(&rf, "url")? {
                Some(v) if v.is_truthy()? => v,
                _ => PyString::new_bound(py, &format!("/api/images/{}", py_str(&idv)?)).into_any(),
            };
            d.set_item("url", url)?;
            d.set_item("mime", or_default(dget(&rf, "mime")?, &PyString::new_bound(py, "image/png").into_any())?)?;
            d.set_item("bytes", py_int(py, &or_default(dget(&rf, "bytes")?, &zero(py)?)?)?)?;
            d.set_item("tool", "")?;
            d.set_item("change", "created")?;
            d.set_item("revisions", 1)?;
            d.set_item("exists", true)?;
            d.set_item("seq", seq.clone())?;
            d.set_item("turnIndex", obj(py, turn_for_seq(user_seqs, &seq)?)?)?;
            d.set_item("createdAt", created.clone())?;
            out.append(d)?;
        }
    }
    Ok(out)
}

// ── _file_artifacts ─────────────────────────────────────────────────────────

fn file_artifacts<'py>(
    py: Python<'py>,
    rows: &B<'py>,
    workspace: &B<'py>,
    user_seqs: &Bound<'py, PyList>,
) -> PyResult<Bound<'py, PyList>> {
    let ospath = py.import_bound("os")?.getattr("path")?;
    let os_stat = py.import_bound("os")?.getattr("stat")?;
    // Real CPython dict: preserves insertion order and lets unhashable/non-str
    // keys raise identically to the Python original.
    let by_path = PyDict::new_bound(py);
    for r in rows.iter()? {
        let r = r?;
        let path = or_default(dget(&r, "path")?, &empty_str(py)?)?;
        if !path.is_truthy()? {
            continue;
        }
        if let Some(k) = dget(&r, "kind")? {
            if k.eq("dir")? {
                continue; // directories aren't artifacts a user opens
            }
        }
        let seq = py_int(py, &or_default(dget(&r, "seq")?, &zero(py)?)?)?;
        let entry = by_path.get_item(&path)?;
        if entry.is_none() {
            let created_now = py_int(py, &or_default(dget(&r, "created_at")?, &zero(py)?)?)?;
            let e = PyDict::new_bound(py);
            e.set_item("id", format!("file:{}", py_str(&path)?))?;
            e.set_item("kind", "file")?;
            let base = ospath.call_method1("basename", (&path,))?;
            e.set_item("name", or_default(Some(base), &path)?)?;
            e.set_item("path", rel(py, &path, workspace)?)?;
            e.set_item("url", "")?;
            e.set_item("mime", "")?;
            e.set_item("bytes", 0)?;
            e.set_item("tool", or_default(dget(&r, "tool_name")?, &empty_str(py)?)?)?;
            let is_missing = match dget(&r, "kind")? {
                Some(k) => k.eq("missing")?,
                None => false,
            };
            e.set_item("change", if is_missing { "created" } else { "modified" })?;
            e.set_item("revisions", 1)?;
            e.set_item("exists", false)?;
            e.set_item("seq", seq.clone())?;
            e.set_item("turnIndex", obj(py, turn_for_seq(user_seqs, &seq)?)?)?;
            e.set_item("createdAt", created_now)?;
            by_path.set_item(&path, &e)?;
            continue;
        }
        let e = entry.unwrap();
        let revs = e.get_item("revisions")?.add(&obj(py, 1)?)?;
        e.set_item("revisions", revs)?;
        if seq.ge(&e.get_item("seq")?)? {
            e.set_item("seq", seq.clone())?;
            e.set_item("turnIndex", obj(py, turn_for_seq(user_seqs, &seq)?)?)?;
            e.set_item("createdAt", py_int(py, &or_default(dget(&r, "created_at")?, &zero(py)?)?)?)?;
            let tool = match dget(&r, "tool_name")? {
                Some(v) if v.is_truthy()? => v,
                _ => e.get_item("tool")?,
            };
            e.set_item("tool", tool)?;
        }
    }
    // Resolve current on-disk state once per path.
    for (path, e) in by_path.iter() {
        match os_stat.call1((&path,)) {
            Ok(st) => {
                e.set_item("exists", true)?;
                e.set_item("bytes", py_int(py, &st.getattr("st_size")?)?)?;
            }
            Err(err) if err.is_instance_of::<pyo3::exceptions::PyOSError>(py) => {
                e.set_item("exists", false)?;
            }
            Err(err) => return Err(err),
        }
    }
    let out = PyList::empty_bound(py);
    for (_, v) in by_path.iter() {
        out.append(v)?;
    }
    Ok(out)
}

// ── build_index ─────────────────────────────────────────────────────────────

#[pyfunction]
#[pyo3(signature = (storage, session_id, workspace=None))]
fn build_index<'py>(
    py: Python<'py>,
    storage: B<'py>,
    session_id: B<'py>,
    workspace: Option<B<'py>>,
) -> PyResult<Bound<'py, PyDict>> {
    let workspace = match workspace {
        Some(w) => w,
        None => empty_str(py)?,
    };
    // 5000 is "the whole session" in practice; get_messages has no all-rows mode.
    let kw = PyDict::new_bound(py);
    kw.set_item("limit", 5000)?;
    kw.set_item("offset", 0)?;
    let messages: B<'py> = match storage.call_method("get_messages", (&session_id,), Some(&kw)) {
        Ok(v) => or_default(Some(v), &PyList::empty_bound(py).into_any())?,
        Err(e) if is_py_exc(&e, py) => PyList::empty_bound(py).into_any(), // except Exception: messages = []
        Err(e) => return Err(e),
    };
    let user_seqs = turn_map(py, &messages)?;

    let mut artifacts: Vec<B<'py>> = Vec::new();
    match image_artifacts(py, &messages, &user_seqs) {
        Ok(ia) => {
            for a in ia.iter() {
                artifacts.push(a);
            }
        }
        Err(e) if is_py_exc(&e, py) => {} // except Exception: pass (fail-open)
        Err(e) => return Err(e),
    }
        let snap = (|| -> PyResult<()> {
            let store = py.import_bound("snapshot_store")?.call_method0("get_snapshot_store")?;
            let rows = store.call_method1("list_since", (&session_id, obj(py, 0)?))?;
            match file_artifacts(py, &rows, &workspace, &user_seqs) {
                Ok(fa) => {
                    for a in fa.iter() {
                        artifacts.push(a);
                    }
                }
                Err(e) if is_py_exc(&e, py) => {} // except Exception: pass (fail-open)
                Err(e) => return Err(e),
            }
            Ok(())
        })();
        if let Err(e) = snap {
            if !is_py_exc(&e, py) {
                return Err(e);
            } // except Exception: pass (fail-open)
        }

    // Newest first, stable for equal timestamps (seq breaks the tie).
    let mut keyed: Vec<(i64, i64, B<'py>)> = Vec::with_capacity(artifacts.len());
    for a in artifacts.drain(..) {
        let created = a.get_item("createdAt")?.extract::<i64>()?;
        let seq = a.get_item("seq")?.extract::<i64>()?;
        keyed.push((created, seq, a));
    }
    keyed.sort_by(|x, y| (y.0, y.1).cmp(&(x.0, x.1)));
    let total = keyed.len();
    keyed.truncate(MAX_ARTIFACTS);

    let mut n_img = 0usize;
    let mut n_file = 0usize;
    let list = PyList::empty_bound(py);
    for (_, _, a) in &keyed {
        match a.get_item("kind")?.extract::<String>()?.as_str() {
            "image" => n_img += 1,
            "file" => n_file += 1,
            _ => {}
        }
        list.append(a)?;
    }

    let counts = PyDict::new_bound(py);
    counts.set_item("image", n_img)?;
    counts.set_item("file", n_file)?;
    let d = PyDict::new_bound(py);
    d.set_item("sessionId", session_id)?;
    d.set_item("workspace", or_default(Some(workspace), &empty_str(py)?)?)?;
    d.set_item("total", total)?;
    d.set_item("truncated", total > list.len())?;
    d.set_item("counts", counts)?;
    d.set_item("artifacts", list)?;
    Ok(d)
}

/// Register the artifact_index submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "artifact_index")?;
    m.add_function(wrap_pyfunction!(build_index, &m)?)?;
    m.add("MAX_ARTIFACTS", MAX_ARTIFACTS)?;
    parent.add_submodule(&m)?;
    Ok(())
}
