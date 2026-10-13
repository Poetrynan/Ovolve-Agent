//! mailbox — Rust port of `app/backend/mailbox.py` (wave-5, Native→Rust).
//!
//! Persistent delivery channel between subagents/background tasks/system
//! components: mailbox_messages is the "delivered, unread" audit track
//! (consume marks, never deletes); mailbox_deferred is the "not yet
//! delivered" queue (offline targets queue, online re-delivery goes strictly
//! in order and only dequeues on per-message confirmation).
//!
//! Port posture (artifact_index / native_desktop precedent): every value
//! flows through as a live CPython object. `.get`/`.strip`/`.split`/
//! `.replace`/`[a:b]` go to the object's own methods, int()/bool()/dict()/
//! format()/callable() are the real builtins, re and json run through the
//! real modules, and every sqlite statement is issued against the caller's
//! own `storage._db("sessions")` object with byte-identical SQL text and the
//! same call order — so exception types and messages, dict key insertion
//! order, truthiness (`or`/`if x:`) semantics, uuid/time consumption counts
//! and the recorded SQL/param log match the canonical implementation by
//! construction, not by re-derivation.
//!
//! DIVERGENCE(port, seams): `uuid.uuid4()` / `time.time()` resolve through
//!     the real modules in production; `_set_seams(uuid_fn=..., time_fn=...)`
//!     swaps them for the parity probe only (mirrors the *_SEAMS convention
//!     on the TS side). Product code never calls it; unsetting restores the
//!     live path, which is the default state.
//! DIVERGENCE(port, exc repr): `error = f"{type(exc).__name__}: {exc}"` is
//!     rebuilt from the live exception object (str() via to_string_lossy);
//!     identical for every exception the suite raises, which are all
//!     surrogate-free messages.
//! DIVERGENCE(port, f-strings): interpolation uses the real `format(x, "")`
//!     builtin — the exact call CPython f-strings compile to — so exotic
//!     `__format__` implementations behave identically; `.join` assembles the
//!     pieces in the source's order.
// PORT STATUS: confidence=high todos=[0]

use parking_lot::Mutex;
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList, PyString, PyTuple};

type B<'py> = Bound<'py, PyAny>;

const KIND_TASK: &str = "task";
const KIND_CONTROL: &str = "control";
const KIND_RESULT: &str = "result";
const KIND_INFO: &str = "info";

// F1: teammate-message 协议常量
const TEAMMATE_MESSAGE_MAX_SUMMARY: i32 = 80; // summary 截断长度
const TAG_PATTERN: &str = r#"\[teammate-message\s+sender="([^"]*)"(?:\s+summary="([^"]*)")?\s*\](.*?)\[/teammate-message\]"#;
const PLAIN_PATTERN: &str = r"\[@(\w+)\]\s*(.*)"; // [@sender] summary 降级格式

// SQL constants — byte-identical reassembly of the python source's
// multi-literal concatenations (spacing included).
const SQL_ENSURE_MESSAGES: &str = "CREATE TABLE IF NOT EXISTS mailbox_messages (id TEXT PRIMARY KEY, box_id TEXT NOT NULL, sender TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'info', payload TEXT NOT NULL DEFAULT '{}', consumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)";
const SQL_INSERT_MESSAGE: &str = "INSERT INTO mailbox_messages (id, box_id, sender, kind, payload, consumed, created_at) VALUES (?,?,?,?,?,0,?)";
const SQL_UNREAD: &str = "SELECT * FROM mailbox_messages WHERE box_id=? AND consumed=0 ORDER BY created_at, rowid LIMIT ?";
const SQL_DRAIN_HEAD: &str = "UPDATE mailbox_messages SET consumed=1 WHERE id IN (";
const SQL_CONSUME: &str = "UPDATE mailbox_messages SET consumed=1 WHERE id=? AND consumed=0";
const SQL_ENSURE_DEFERRED: &str = "CREATE TABLE IF NOT EXISTS mailbox_deferred (id TEXT PRIMARY KEY, box_id TEXT NOT NULL, sender TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'info', payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER NOT NULL DEFAULT 0)";
const SQL_DEFERRED_INDEX: &str = "CREATE INDEX IF NOT EXISTS idx_mailbox_deferred_box ON mailbox_deferred(box_id, created_at)";
const SQL_INSERT_DEFERRED: &str = "INSERT INTO mailbox_deferred (id, box_id, sender, kind, payload, created_at, attempts, last_attempt_at) VALUES (?,?,?,?,?,?,0,0)";
const SQL_PENDING: &str = "SELECT * FROM mailbox_deferred WHERE box_id=? ORDER BY created_at, rowid LIMIT ?";
const SQL_PENDING_COUNT: &str = "SELECT COUNT(*) AS n FROM mailbox_deferred WHERE box_id=?";
const SQL_PROMOTE: &str = "INSERT OR IGNORE INTO mailbox_messages (id, box_id, sender, kind, payload, consumed, created_at) VALUES (?,?,?,?,?,0,?)";
const SQL_DELETE_DEFERRED: &str = "DELETE FROM mailbox_deferred WHERE id=?";
const SQL_ATTEMPT: &str = "UPDATE mailbox_deferred SET attempts=attempts+1, last_attempt_at=? WHERE id=?";

struct St {
    tag_re: Option<Py<PyAny>>,
    plain_re: Option<Py<PyAny>>,
    kinds: Option<Py<PyAny>>,
    uuid_fn: Option<Py<PyAny>>,
    time_fn: Option<Py<PyAny>>,
}
static ST: Mutex<St> = Mutex::new(St {
    tag_re: None,
    plain_re: None,
    kinds: None,
    uuid_fn: None,
    time_fn: None,
});

// ── CPython-semantics helpers ───────────────────────────────────────────────

fn builtins(py: Python<'_>) -> PyResult<Bound<'_, PyModule>> {
    Ok(py.import_bound("builtins")?)
}

fn obj<'py>(py: Python<'py>, v: i64) -> PyResult<B<'py>> {
    Ok(v.to_object(py).into_bound(py).into_any())
}

fn ps<'py>(py: Python<'py>, v: &str) -> B<'py> {
    PyString::new_bound(py, v).into_any()
}

fn pi<'py>(py: Python<'py>, v: i64) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("int")?.call1((v,))?)
}

fn none<'py>(py: Python<'py>) -> B<'py> {
    py.None().into_bound(py).into_any()
}

fn py_bool<'py>(py: Python<'py>, v: bool) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr(if v { "True" } else { "False" })?)
}

/// `x or default` (returns the original object when truthy).
fn orv<'py>(v: &B<'py>, def: &B<'py>) -> PyResult<B<'py>> {
    Ok(if v.is_truthy()? { v.clone() } else { def.clone() })
}

/// real builtin call: int(x) / bool(x) / dict(x).
fn bi1<'py>(py: Python<'py>, name: &str, x: &B<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr(name)?.call1((x,))?)
}

fn bi_callable<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<bool> {
    builtins(py)?.getattr("callable")?.call1((x,))?.extract::<bool>()
}

/// f-string interpolation: `format(x, "")`.
fn fmtv<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("format")?.call1((x, ps(py, "")))?)
}

/// `str(x)`.
fn strf<'py>(x: &B<'py>) -> PyResult<B<'py>> {
    Ok(x.str()?.into_any())
}

/// `slice(None, stop)` — the exact object behind `[:stop]`.
fn py_slice<'py>(py: Python<'py>, stop: i32) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("slice")?.call1((none(py), stop))?)
}

/// `"".join(parts)` — used to assemble f-strings from already-formatted parts.
fn fconcat<'py>(py: Python<'py>, parts: Vec<B<'py>>) -> PyResult<B<'py>> {
    let list = PyList::new_bound(py, parts);
    Ok(ps(py, "").call_method1("join", (&list,))?)
}

/// Python's `except Exception:` — BaseExceptions (KeyboardInterrupt,
/// SystemExit) are NOT swallowed and must propagate.
fn is_py_exc(e: &PyErr, py: Python<'_>) -> bool {
    e.is_instance_of::<pyo3::exceptions::PyException>(py)
}

fn exc_repr(py: Python<'_>, e: &PyErr) -> PyResult<String> {
    let v = e.value_bound(py);
    let name = v.getattr("__class__")?.getattr("__name__")?.extract::<String>()?;
    let msg = v.str()?.to_string_lossy().into_owned();
    Ok(format!("{}: {}", name, msg))
}

// ── lazily-initialized module-level objects (python: import-time constants) ─

fn tag_re<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let cached = ST.lock().tag_re.as_ref().map(|p| p.clone_ref(py));
    if let Some(c) = cached {
        return Ok(c.into_bound(py));
    }
    let re = py.import_bound("re")?;
    let dotall = re.getattr("DOTALL")?;
    let kw = PyDict::new_bound(py);
    kw.set_item("flags", dotall)?;
    let compiled =
        re.call_method("compile", (ps(py, TAG_PATTERN),), Some(&kw))?;
    ST.lock().tag_re = Some(compiled.clone().unbind());
    Ok(compiled)
}

fn plain_re<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let cached = ST.lock().plain_re.as_ref().map(|p| p.clone_ref(py));
    if let Some(c) = cached {
        return Ok(c.into_bound(py));
    }
    let re = py.import_bound("re")?;
    let compiled = re.call_method1("compile", (ps(py, PLAIN_PATTERN),))?;
    ST.lock().plain_re = Some(compiled.clone().unbind());
    Ok(compiled)
}

fn kinds<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let cached = ST.lock().kinds.as_ref().map(|p| p.clone_ref(py));
    if let Some(c) = cached {
        return Ok(c.into_bound(py));
    }
    let t = PyTuple::new_bound(
        py,
        vec![
            ps(py, KIND_TASK),
            ps(py, KIND_CONTROL),
            ps(py, KIND_RESULT),
            ps(py, KIND_INFO),
        ],
    );
    ST.lock().kinds = Some(t.clone().into_any().unbind());
    Ok(t.into_any())
}

fn kind_norm<'py>(py: Python<'py>, kind: &B<'py>) -> PyResult<B<'py>> {
    if !kinds(py)?
        .call_method1("__contains__", (kind,))?
        .is_truthy()?
    {
        return Ok(ps(py, KIND_INFO));
    }
    Ok(kind.clone())
}

// ── json / uuid / time through the live modules (or probe seams) ────────────

fn jdumps<'py>(py: Python<'py>, payload: &B<'py>) -> PyResult<B<'py>> {
    let json = py.import_bound("json")?;
    let kw = PyDict::new_bound(py);
    kw.set_item("ensure_ascii", false)?;
    Ok(json.call_method("dumps", (payload,), Some(&kw))?)
}

fn jloads<'py>(py: Python<'py>, s: &B<'py>) -> PyResult<B<'py>> {
    Ok(py.import_bound("json")?.call_method1("loads", (s,))?)
}

fn json_decode_error<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    Ok(py.import_bound("json")?.getattr("JSONDecodeError")?)
}

fn new_id<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let seam = ST.lock().uuid_fn.as_ref().map(|p| p.clone_ref(py));
    let u = match seam {
        Some(f) => f.into_bound(py).call0()?,
        None => py.import_bound("uuid")?.call_method0("uuid4")?,
    };
    let hex = u.getattr("hex")?;
    Ok(hex.get_item(py_slice(py, 12)?)?)
}

/// `int(time.time())` — time() only fires when no value is supplied upstream.
fn now_int<'py>(py: Python<'py>) -> PyResult<B<'py>> {
    let seam = ST.lock().time_fn.as_ref().map(|p| p.clone_ref(py));
    let t = match seam {
        Some(f) => f.into_bound(py).call0()?,
        None => py.import_bound("time")?.call_method0("time")?,
    };
    bi1(py, "int", &t)
}

/// `int(<created_at>)` / plain `int(limit)` etc.
fn py_int<'py>(py: Python<'py>, x: &B<'py>) -> PyResult<B<'py>> {
    bi1(py, "int", x)
}

// ── F1 teammate-message protocol ────────────────────────────────────────────

/// summary 缺省时从 content 首行提取（前两处调用点同款表达式）。
fn auto_summary<'py>(py: Python<'py>, content: &B<'py>) -> PyResult<B<'py>> {
    let base = orv(content, &ps(py, ""))?;
    let stripped = base.call_method0("strip")?;
    let parts = stripped.call_method1("split", (ps(py, "\n"), 1))?;
    let first = parts.get_item(0)?;
    let first_line = first.call_method0("strip")?;
    if first_line.is_truthy()? {
        return first_line.get_item(py_slice(py, TEAMMATE_MESSAGE_MAX_SUMMARY)?);
    }
    Ok(ps(py, "(no content)"))
}

fn fmt_teammate_msg<'py>(
    py: Python<'py>,
    sender: &B<'py>,
    content: &B<'py>,
    summary: &B<'py>,
) -> PyResult<B<'py>> {
    let summary = if summary.is_truthy()? {
        summary.get_item(py_slice(py, TEAMMATE_MESSAGE_MAX_SUMMARY)?)?
    } else {
        auto_summary(py, content)?
    };
    let raw = orv(content, &ps(py, ""))?;
    let clean = raw.call_method1("replace", (ps(py, "\n"), ps(py, " ")))?;
    let clean = clean.call_method0("strip")?;
    fconcat(
        py,
        vec![
            ps(py, "[teammate-message sender=\""),
            fmtv(py, sender)?,
            ps(py, "\" summary=\""),
            fmtv(py, &summary)?,
            ps(py, "\"]"),
            fmtv(py, &clean)?,
            ps(py, "[/teammate-message]"),
        ],
    )
}

fn strip_teammate_msg<'py>(py: Python<'py>, text: &B<'py>) -> PyResult<B<'py>> {
    if !text.is_truthy()? {
        return Ok(ps(py, ""));
    }
    let m = tag_re(py)?.call_method1("search", (text,))?;
    if m.is_truthy()? {
        let sender = m.call_method1("group", (1,))?;
        let g2 = m.call_method1("group", (2,))?;
        let summary = orv(&g2, &ps(py, "(no summary)"))?;
        return fconcat(
            py,
            vec![ps(py, "[@"), fmtv(py, &sender)?, ps(py, "] "), fmtv(py, &summary)?],
        );
    }
    let stripped = text.call_method0("strip")?;
    let m2 = plain_re(py)?.call_method1("match", (&stripped,))?;
    if m2.is_truthy()? {
        let g1 = m2.call_method1("group", (1,))?;
        let g2 = m2.call_method1("group", (2,))?;
        return fconcat(
            py,
            vec![ps(py, "[@"), fmtv(py, &g1)?, ps(py, "] "), fmtv(py, &g2)?],
        );
    }
    Ok(text.clone())
}

fn make_payload<'py>(
    py: Python<'py>,
    sender: &B<'py>,
    content: &B<'py>,
    summary: &B<'py>,
) -> PyResult<B<'py>> {
    let summary = if summary.is_truthy()? {
        summary.clone()
    } else {
        auto_summary(py, content)?
    };
    let formatted = fmt_teammate_msg(py, sender, content, &summary)?;
    let d = PyDict::new_bound(py);
    d.set_item("formatted", formatted)?;
    d.set_item("sender", sender)?;
    d.set_item(
        "summary",
        summary.get_item(py_slice(py, TEAMMATE_MESSAGE_MAX_SUMMARY)?)?,
    )?;
    d.set_item("content", orv(content, &ps(py, ""))?)?;
    Ok(d.into_any())
}

// ── mailbox_messages track ──────────────────────────────────────────────────

/// 从工具参数行 dict 解码 payload（unread / pending 共用体，源码同款 try/except）。
fn row_to_msg<'py>(py: Python<'py>, r: &B<'py>) -> PyResult<B<'py>> {
    let d = bi1(py, "dict", r)?;
    let pv = orv(&d.call_method1("get", ("payload",))?, &ps(py, "{}"))?;
    match jloads(py, &pv) {
        Ok(v) => {
            d.set_item("payload", v)?;
        }
        Err(e) => {
            let jd = json_decode_error(py)?;
            if e.is_instance_bound(py, &jd)
                || e.is_instance_of::<pyo3::exceptions::PyTypeError>(py)
            {
                d.set_item("payload", PyDict::new_bound(py))?;
            } else {
                return Err(e);
            }
        }
    }
    Ok(d)
}

fn rows_to_msgs<'py>(py: Python<'py>, rows: &B<'py>) -> PyResult<B<'py>> {
    let out = PyList::empty_bound(py);
    for r in rows.iter()? {
        let r = r?;
        out.append(row_to_msg(py, &r)?)?;
    }
    Ok(out.into_any())
}

fn ensure_table<'py>(py: Python<'py>, storage: &B<'py>) -> PyResult<()> {
    let c = storage.call_method1("_db", ("sessions",))?;
    c.call_method1("execute", (ps(py, SQL_ENSURE_MESSAGES),))?;
    c.call_method0("commit")?;
    Ok(())
}

fn send_core<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
    sender: &B<'py>,
    kind: &B<'py>,
    payload: Option<&B<'py>>,
    summary: &B<'py>,
) -> PyResult<B<'py>> {
    let kind = kind_norm(py, kind)?;
    let empty = PyDict::new_bound(py).into_any();
    let payload = match payload {
        Some(p) => bi1(py, "dict", &orv(p, &empty)?)?,
        None => bi1(py, "dict", &empty)?,
    };
    if summary.is_truthy()? {
        payload.set_item(
            "summary",
            summary.get_item(py_slice(py, TEAMMATE_MESSAGE_MAX_SUMMARY)?)?,
        )?;
    } else if !payload
        .call_method1("__contains__", ("summary",))?
        .is_truthy()?
    {
        let c1 = payload.call_method1("get", (ps(py, "content"), ps(py, "")))?;
        let c2 =
            payload.call_method1("get", (ps(py, "formatted"), ps(py, "")))?;
        let content = orv(&c1, &c2)?;
        if content.is_truthy()? {
            let m = tag_re(py)?.call_method1("search", (&content,))?;
            let mut promoted = false;
            if m.is_truthy()? {
                let g2 = m.call_method1("group", (2,))?;
                if g2.is_truthy()? {
                    payload.set_item(
                        "summary",
                        g2.get_item(py_slice(py, TEAMMATE_MESSAGE_MAX_SUMMARY)?)?,
                    )?;
                    promoted = true;
                }
            }
            if !promoted {
                payload.set_item("summary", auto_summary(py, &content)?)?;
            }
        } else {
            payload.set_item("summary", ps(py, "(no content)"))?;
        }
    }
    let mid = new_id(py)?;
    let c = storage.call_method1("_db", ("sessions",))?;
    let params = PyTuple::new_bound(
        py,
        vec![
            mid.clone(),
            strf(box_id)?,
            strf(&orv(sender, &ps(py, "unknown"))?)?,
            kind,
            jdumps(py, &payload)?,
            now_int(py)?,
        ],
    );
    c.call_method1("execute", (ps(py, SQL_INSERT_MESSAGE), &params))?;
    c.call_method0("commit")?;
    Ok(mid)
}

fn unread_core<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
    limit: &B<'py>,
) -> PyResult<B<'py>> {
    let params =
        PyTuple::new_bound(py, vec![strf(box_id)?, py_int(py, limit)?]);
    let cur = storage
        .call_method1("_db", ("sessions",))?
        .call_method1("execute", (ps(py, SQL_UNREAD), params))?;
    let rows = cur.call_method0("fetchall")?;
    rows_to_msgs(py, &rows)
}

fn drain_core<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
    limit: &B<'py>,
) -> PyResult<B<'py>> {
    let msgs = unread_core(py, storage, box_id, limit)?;
    if msgs.is_truthy()? {
        let ids = PyList::empty_bound(py);
        for m in msgs.iter()? {
            ids.append(m?.get_item("id")?)?;
        }
        let mut ph = String::new();
        for _ in 0..ids.len() {
            if !ph.is_empty() {
                ph.push(',');
            }
            ph.push('?');
        }
        let sql = format!("{}{})", SQL_DRAIN_HEAD, ph);
        let sql = PyString::new_bound(py, &sql).into_any();
        let c = storage.call_method1("_db", ("sessions",))?;
        c.call_method1("execute", (sql, &ids))?;
        c.call_method0("commit")?;
        for m in msgs.iter()? {
            m?.set_item("consumed", 1)?;
        }
    }
    Ok(msgs)
}

fn consume_core<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    message_id: &B<'py>,
) -> PyResult<B<'py>> {
    let c = storage.call_method1("_db", ("sessions",))?;
    let params = PyTuple::new_bound(py, vec![message_id.clone()]);
    let cur = c.call_method1("execute", (ps(py, SQL_CONSUME), params))?;
    c.call_method0("commit")?;
    let gt = cur.getattr("rowcount")?.gt(0)?;
    py_bool(py, gt)
}

// ── deferred track ──────────────────────────────────────────────────────────

fn ensure_deferred<'py>(py: Python<'py>, storage: &B<'py>) -> PyResult<()> {
    let c = storage.call_method1("_db", ("sessions",))?;
    c.call_method1("execute", (ps(py, SQL_ENSURE_DEFERRED),))?;
    c.call_method1("execute", (ps(py, SQL_DEFERRED_INDEX),))?;
    c.call_method0("commit")?;
    Ok(())
}

fn defer_core<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
    sender: &B<'py>,
    kind: &B<'py>,
    payload: Option<&B<'py>>,
) -> PyResult<B<'py>> {
    let kind = kind_norm(py, kind)?;
    ensure_deferred(py, storage)?;
    let did = new_id(py)?;
    // python: c = storage._db(...) happens BEFORE dict(payload or {}) is
    // evaluated inside the args tuple — so a bad payload still logs the _db.
    let c = storage.call_method1("_db", ("sessions",))?;
    let empty = PyDict::new_bound(py).into_any();
    let p = match payload {
        Some(p) => bi1(py, "dict", &orv(p, &empty)?)?,
        None => bi1(py, "dict", &empty)?,
    };
    let params = PyTuple::new_bound(
        py,
        vec![
            did.clone(),
            strf(box_id)?,
            strf(&orv(sender, &ps(py, "unknown"))?)?,
            kind,
            jdumps(py, &p)?,
            now_int(py)?,
        ],
    );
    c.call_method1("execute", (ps(py, SQL_INSERT_DEFERRED), params))?;
    c.call_method0("commit")?;
    Ok(did)
}

fn pending_core<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
    limit: &B<'py>,
) -> PyResult<B<'py>> {
    ensure_deferred(py, storage)?;
    let params =
        PyTuple::new_bound(py, vec![strf(box_id)?, py_int(py, limit)?]);
    let cur = storage
        .call_method1("_db", ("sessions",))?
        .call_method1("execute", (ps(py, SQL_PENDING), params))?;
    let rows = cur.call_method0("fetchall")?;
    rows_to_msgs(py, &rows)
}

fn pending_count_core<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
) -> PyResult<B<'py>> {
    ensure_deferred(py, storage)?;
    let params = PyTuple::new_bound(py, vec![strf(box_id)?]);
    let r = storage
        .call_method1("_db", ("sessions",))?
        .call_method1("execute", (ps(py, SQL_PENDING_COUNT), params))?
        .call_method0("fetchone")?;
    if r.is_truthy()? {
        return py_int(py, &r.get_item("n")?);
    }
    obj(py, 0)
}

fn promote_core<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    msg: &B<'py>,
) -> PyResult<B<'py>> {
    let c = storage.call_method1("_db", ("sessions",))?;
    // python evaluates the args tuple strictly left-to-right; the KeyError on
    // msg["id"] must fire BEFORE any time consumption or payload get below.
    let id_s = strf(&msg.get_item("id")?)?;
    let box_s = strf(&msg.get_item("box_id")?)?;
    let sender_s = strf(&orv(
        &msg.call_method1("get", ("sender",))?,
        &ps(py, "unknown"),
    )?)?;
    let kind_s = strf(&orv(
        &msg.call_method1("get", ("kind",))?,
        &ps(py, KIND_INFO),
    )?)?;
    let pl = msg.call_method1("get", ("payload",))?;
    let payload_s = jdumps(py, &orv(&pl, &PyDict::new_bound(py).into_any())?)?;
    let created_raw = msg.call_method1("get", ("created_at",))?;
    let created = if created_raw.is_truthy()? {
        py_int(py, &created_raw)?
    } else {
        now_int(py)?
    };
    let params =
        PyTuple::new_bound(py, vec![id_s, box_s, sender_s, kind_s, payload_s, created]);
    c.call_method1("execute", (ps(py, SQL_PROMOTE), params))?;
    c.call_method0("commit")?;
    py_bool(py, true)
}

fn deliver_pending_core<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
    deliver: Option<&B<'py>>,
    limit: &B<'py>,
) -> PyResult<B<'py>> {
    ensure_deferred(py, storage)?;
    let c = storage.call_method1("_db", ("sessions",))?;
    let mut delivered: i64 = 0;
    let mut stopped_at: Option<B<'py>> = None;
    let mut error: Option<B<'py>> = None;
    for msg in pending_core(py, storage, box_id, limit)?.iter()? {
        let msg = msg?;
        let mut ok = false;
        // ok = bool(deliver(msg)) — 投递动作的失败是数据不是崩溃：
        // except Exception 捕获（BaseException 照抛，见 is_py_exc 闸）。
        let attempt: PyResult<B<'py>> = match deliver {
            Some(f) => bi1(py, "bool", &f.call1((msg.clone(),))?),
            None => promote_core(py, storage, &msg),
        };
        match attempt {
            Ok(v) => ok = v.is_truthy()?,
            Err(e) if is_py_exc(&e, py) => {
                error = Some(ps(py, &exc_repr(py, &e)?))
            }
            Err(e) => return Err(e),
        }
        let now = now_int(py)?;
        if ok {
            let params = PyTuple::new_bound(py, vec![msg.get_item("id")?]);
            c.call_method1("execute", (ps(py, SQL_DELETE_DEFERRED), params))?;
            c.call_method0("commit")?;
            delivered += 1;
        } else {
            let params =
                PyTuple::new_bound(py, vec![now, msg.get_item("id")?]);
            c.call_method1("execute", (ps(py, SQL_ATTEMPT), params))?;
            c.call_method0("commit")?;
            stopped_at = Some(msg.get_item("id")?);
            break;
        }
    }
    let d = PyDict::new_bound(py);
    d.set_item("box_id", strf(box_id)?)?;
    d.set_item("delivered", obj(py, delivered)?)?;
    d.set_item("remaining", pending_count_core(py, storage, box_id)?)?;
    d.set_item("stopped_at", stopped_at.unwrap_or_else(|| none(py)))?;
    d.set_item("error", error.unwrap_or_else(|| none(py)))?;
    Ok(d.into_any())
}

fn send_or_defer_core<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
    sender: &B<'py>,
    kind: &B<'py>,
    payload: Option<&B<'py>>,
    online: Option<&B<'py>>,
) -> PyResult<B<'py>> {
    let online_v = match online {
        Some(v) => v.clone(),
        None => none(py),
    };
    let is_online = if bi_callable(py, &online_v)? {
        online_v.call1((storage, box_id))?
    } else {
        bi1(py, "bool", &online_v)?
    };
    if is_online.is_truthy()? {
        let mid =
            send_core(py, storage, box_id, sender, kind, payload, &ps(py, ""))?;
        Ok(PyTuple::new_bound(py, vec![mid, py_bool(py, true)?]).into_any())
    } else {
        let did = defer_core(py, storage, box_id, sender, kind, payload)?;
        Ok(PyTuple::new_bound(py, vec![did, py_bool(py, false)?]).into_any())
    }
}

// ── pyfunction surface (names mirror the python module 1:1) ─────────────────

#[pyfunction]
#[pyo3(signature = (sender, content, summary = None))]
fn format_teammate_message<'py>(
    py: Python<'py>,
    sender: &B<'py>,
    content: &B<'py>,
    summary: Option<B<'py>>,
) -> PyResult<PyObject> {
    let summary = summary.unwrap_or_else(|| ps(py, ""));
    Ok(fmt_teammate_msg(py, sender, content, &summary)?.unbind())
}

#[pyfunction]
fn strip_teammate_message<'py>(
    py: Python<'py>,
    text: &B<'py>,
) -> PyResult<PyObject> {
    Ok(strip_teammate_msg(py, text)?.unbind())
}

#[pyfunction]
#[pyo3(signature = (sender, content, summary = None))]
fn make_teammate_payload<'py>(
    py: Python<'py>,
    sender: &B<'py>,
    content: &B<'py>,
    summary: Option<B<'py>>,
) -> PyResult<PyObject> {
    let summary = summary.unwrap_or_else(|| ps(py, ""));
    Ok(make_payload(py, sender, content, &summary)?.unbind())
}

#[pyfunction]
fn _ensure_table<'py>(py: Python<'py>, storage: &B<'py>) -> PyResult<PyObject> {
    ensure_table(py, storage)?;
    Ok(py.None())
}

#[pyfunction]
#[pyo3(signature = (storage, box_id, sender, *, kind = None, payload = None, summary = None))]
fn send<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
    sender: &B<'py>,
    kind: Option<B<'py>>,
    payload: Option<&B<'py>>,
    summary: Option<B<'py>>,
) -> PyResult<PyObject> {
    let kind = kind.unwrap_or_else(|| ps(py, KIND_INFO));
    let summary = summary.unwrap_or_else(|| ps(py, ""));
    Ok(send_core(py, storage, box_id, sender, &kind, payload, &summary)?
        .unbind())
}

#[pyfunction]
#[pyo3(signature = (storage, box_id, sender, content, summary = None))]
fn send_teammate<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
    sender: &B<'py>,
    content: &B<'py>,
    summary: Option<B<'py>>,
) -> PyResult<PyObject> {
    let summary = summary.unwrap_or_else(|| ps(py, ""));
    let payload = make_payload(py, sender, content, &summary)?;
    let kind = ps(py, KIND_INFO);
    let empty_summary = ps(py, "");
    Ok(send_core(
        py,
        storage,
        box_id,
        sender,
        &kind,
        Some(&payload),
        &empty_summary,
    )?
    .unbind())
}

#[pyfunction]
#[pyo3(signature = (storage, box_id, *, limit = None))]
fn unread<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
    limit: Option<B<'py>>,
) -> PyResult<PyObject> {
    let limit = match limit {
        Some(v) => v,
        None => pi(py, 50)?,
    };
    Ok(unread_core(py, storage, box_id, &limit)?.unbind())
}

#[pyfunction]
#[pyo3(signature = (storage, box_id, *, limit = None))]
fn drain<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
    limit: Option<B<'py>>,
) -> PyResult<PyObject> {
    let limit = match limit {
        Some(v) => v,
        None => pi(py, 50)?,
    };
    Ok(drain_core(py, storage, box_id, &limit)?.unbind())
}

#[pyfunction]
fn consume<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    message_id: &B<'py>,
) -> PyResult<PyObject> {
    Ok(consume_core(py, storage, message_id)?.unbind())
}

#[pyfunction]
fn _ensure_deferred_table<'py>(
    py: Python<'py>,
    storage: &B<'py>,
) -> PyResult<PyObject> {
    ensure_deferred(py, storage)?;
    Ok(py.None())
}

#[pyfunction]
#[pyo3(signature = (storage, box_id, sender, *, kind = None, payload = None))]
fn defer<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
    sender: &B<'py>,
    kind: Option<B<'py>>,
    payload: Option<&B<'py>>,
) -> PyResult<PyObject> {
    let kind = kind.unwrap_or_else(|| ps(py, KIND_INFO));
    Ok(defer_core(py, storage, box_id, sender, &kind, payload)?.unbind())
}

#[pyfunction]
#[pyo3(signature = (storage, box_id, sender, *, kind = None, payload = None, online = None))]
fn send_or_defer<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
    sender: &B<'py>,
    kind: Option<B<'py>>,
    payload: Option<&B<'py>>,
    online: Option<&B<'py>>,
) -> PyResult<PyObject> {
    let kind = kind.unwrap_or_else(|| ps(py, KIND_INFO));
    Ok(send_or_defer_core(
        py, storage, box_id, sender, &kind, payload, online,
    )?
    .unbind())
}

#[pyfunction]
fn _deferred_row_to_msg<'py>(
    py: Python<'py>,
    r: &B<'py>,
) -> PyResult<PyObject> {
    Ok(row_to_msg(py, r)?.unbind())
}

#[pyfunction]
#[pyo3(signature = (storage, box_id, *, limit = None))]
fn pending<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
    limit: Option<B<'py>>,
) -> PyResult<PyObject> {
    let limit = match limit {
        Some(v) => v,
        None => pi(py, 50)?,
    };
    Ok(pending_core(py, storage, box_id, &limit)?.unbind())
}

#[pyfunction]
fn pending_count<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
) -> PyResult<PyObject> {
    Ok(pending_count_core(py, storage, box_id)?.unbind())
}

#[pyfunction]
fn _promote_to_mailbox<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    msg: &B<'py>,
) -> PyResult<PyObject> {
    Ok(promote_core(py, storage, msg)?.unbind())
}

#[pyfunction]
#[pyo3(signature = (storage, box_id, *, deliver = None, limit = None))]
fn deliver_pending<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
    deliver: Option<&B<'py>>,
    limit: Option<B<'py>>,
) -> PyResult<PyObject> {
    let limit = match limit {
        Some(v) => v,
        None => pi(py, 50)?,
    };
    Ok(deliver_pending_core(py, storage, box_id, deliver, &limit)?.unbind())
}

#[pyfunction]
#[pyo3(signature = (storage, box_id, *, deliver = None, limit = None))]
fn mark_online<'py>(
    py: Python<'py>,
    storage: &B<'py>,
    box_id: &B<'py>,
    deliver: Option<&B<'py>>,
    limit: Option<B<'py>>,
) -> PyResult<PyObject> {
    let limit = match limit {
        Some(v) => v,
        None => pi(py, 50)?,
    };
    Ok(deliver_pending_core(py, storage, box_id, deliver, &limit)?.unbind())
}

/// Probe-only seam for uuid/time sources (*_SEAMS convention).
#[pyfunction]
#[pyo3(signature = (uuid_fn = None, time_fn = None))]
fn _set_seams(
    py: Python<'_>,
    uuid_fn: Option<&B<'_>>,
    time_fn: Option<&B<'_>>,
) -> PyResult<PyObject> {
    let mut g = ST.lock();
    g.uuid_fn = uuid_fn.map(|v| v.clone().unbind());
    g.time_fn = time_fn.map(|v| v.clone().unbind());
    Ok(py.None())
}

/// Register the mailbox submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(py, "mailbox")?;
    m.add_function(wrap_pyfunction!(format_teammate_message, &m)?)?;
    m.add_function(wrap_pyfunction!(strip_teammate_message, &m)?)?;
    m.add_function(wrap_pyfunction!(make_teammate_payload, &m)?)?;
    m.add_function(wrap_pyfunction!(_ensure_table, &m)?)?;
    m.add_function(wrap_pyfunction!(send, &m)?)?;
    m.add_function(wrap_pyfunction!(send_teammate, &m)?)?;
    m.add_function(wrap_pyfunction!(unread, &m)?)?;
    m.add_function(wrap_pyfunction!(drain, &m)?)?;
    m.add_function(wrap_pyfunction!(consume, &m)?)?;
    m.add_function(wrap_pyfunction!(_ensure_deferred_table, &m)?)?;
    m.add_function(wrap_pyfunction!(defer, &m)?)?;
    m.add_function(wrap_pyfunction!(send_or_defer, &m)?)?;
    m.add_function(wrap_pyfunction!(_deferred_row_to_msg, &m)?)?;
    m.add_function(wrap_pyfunction!(pending, &m)?)?;
    m.add_function(wrap_pyfunction!(pending_count, &m)?)?;
    m.add_function(wrap_pyfunction!(_promote_to_mailbox, &m)?)?;
    m.add_function(wrap_pyfunction!(deliver_pending, &m)?)?;
    m.add_function(wrap_pyfunction!(mark_online, &m)?)?;
    m.add_function(wrap_pyfunction!(_set_seams, &m)?)?;
    m.add("KIND_TASK", KIND_TASK)?;
    m.add("KIND_CONTROL", KIND_CONTROL)?;
    m.add("KIND_RESULT", KIND_RESULT)?;
    m.add("KIND_INFO", KIND_INFO)?;
    m.add("KINDS", kinds(py)?)?;
    m.add("TEAMMATE_MESSAGE_MAX_SUMMARY", TEAMMATE_MESSAGE_MAX_SUMMARY)?;
    m.add("TEAMMATE_MESSAGE_TAG_RE", tag_re(py)?)?;
    m.add("TEAMMATE_MESSAGE_PLAIN_RE", plain_re(py)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}
