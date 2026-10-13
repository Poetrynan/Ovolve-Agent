//! context_refs — Rust port of `app/backend/context_refs.py`.
//!
//! Structured @-reference resolution: confinement-checked file/dir/git-diff
//! readers, image data-URL handling, a water-filling token budget and the
//! render/summary surfaces the router consumes. Behavior is matched to the
//! Python canonical byte-for-byte (error strings included); the Python-facing
//! string/path primitives below (`py_strip`, `py_repr_str`, the ntpath subset,
//! the strict base64 state machine, the utf-8/gbk/latin-1 decode ladder) exist
//! precisely because the observable outputs embed them.
//!
//! Verified by `D:/ovolve-migration/smoke/parity_context_refs.py` (side-by-side
//! python canonical vs `ovolve_core.context_refs`).
//!
//! DIVERGENCE(port): python float repr in str()-of-non-str surfaces switches to
//!   scientific notation at different magnitudes than CPython's repr; equivalent
//!   for every value the wire can carry (JSON-sourced), argued in the parity
//!   record.
//! DIVERGENCE(port): FormatMessageW supplies WinError texts, the same source
//!   python's os.strerror uses on this machine — identical by construction as
//!   long as both run on one OS.

use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict, PyList, PyString, PyTuple};
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

// ── Constants (mirror python module attributes) ─────────────────────────────

const KIND_FILE: &str = "file";
const KIND_DIR: &str = "dir";
const KIND_GIT_DIFF: &str = "git_diff";
const KIND_IMAGE: &str = "image";

const DEFAULT_REF_BUDGET: i64 = 24000;
const MAX_SINGLE_REF_SHARE: f64 = 0.5;
const DIR_ENTRY_LIMIT: usize = 200;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const IMAGE_TOKEN_ESTIMATE: i64 = 1200;
const FENCE: &str = "```````";

const BINARY_EXTS: [&str; 41] = [
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svgz", ".pdf", ".zip", ".gz",
    ".tar", ".bz2", ".xz", ".7z", ".rar", ".exe", ".dll", ".so", ".dylib", ".bin", ".dat",
    ".pyc", ".pyd", ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv", ".flac", ".woff", ".woff2",
    ".ttf", ".otf", ".eot", ".sqlite", ".sqlite3", ".db", ".pack", ".idx",
];

const IMAGE_MIMES: [&str; 4] = ["image/gif", "image/jpeg", "image/png", "image/webp"];

// ── Python-semantics string helpers ─────────────────────────────────────────

/// Characters python's str.strip() removes (str.isspace set, probed on the
/// canonical interpreter: \x1c-\x1f in, \u200b out).
fn py_ws(c: char) -> bool {
    matches!(c,
        '\t' | '\n' | '\x0b' | '\x0c' | '\r' | ' ' | '\u{1c}' | '\u{1d}' | '\u{1e}' | '\u{1f}'
        | '\u{85}' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}'
        | '\u{202f}' | '\u{205f}' | '\u{3000}')
}

fn py_strip(s: &str) -> String {
    s.trim_matches(py_ws).to_string()
}

fn py_lower(s: &str) -> String {
    s.to_lowercase()
}

/// str() applied to a non-str python object equals its repr; extract the
/// string directly when it already is one.
fn py_str_of(v: &Bound<PyAny>) -> PyResult<String> {
    if let Ok(s) = v.downcast::<pyo3::types::PyString>() {
        return s.extract::<String>();
    }
    let r = v.repr()?;
    r.extract::<String>()
}

fn py_truthy(v: &Bound<PyAny>) -> bool {
    v.is_truthy().unwrap_or(false)
}

fn dict_field<'py>(d: &Bound<'py, PyDict>, key: &str) -> PyResult<Option<Bound<'py, PyAny>>> {
    d.get_item(key)
}

/// `str(obj or "")` — the exact chain the python readers use on wire dicts.
fn field_or_empty_str<'py>(d: &Bound<'py, PyDict>, key: &str) -> PyResult<String> {
    match dict_field(d, key)? {
        Some(v) if py_truthy(&v) => py_str_of(&v),
        _ => Ok(String::new()),
    }
}

/// python int()/trunc on numeric json values; bool first (True==1).
fn py_int_trunc(v: &Bound<PyAny>) -> PyResult<i64> {
    if let Ok(b) = v.extract::<bool>() {
        return Ok(if b { 1 } else { 0 });
    }
    if let Ok(i) = v.extract::<i64>() {
        return Ok(i);
    }
    if let Ok(f) = v.extract::<f64>() {
        return Ok(f.trunc() as i64);
    }
    if let Ok(s) = v.extract::<String>() {
        return s
            .trim()
            .parse::<i64>()
            .map_err(|_| pyo3::exceptions::PyValueError::new_err(format!(
                "invalid literal for int() with base 10: '{}'",
                py_repr_str(&s))));
    }
    Err(pyo3::exceptions::PyTypeError::new_err(
        "int() argument must be a string, a bytes-like object or a real number, not 'NoneType'",
    ))
}

/// python repr() of a str: quote choice and escapes as CPython does
/// (printability ≈ Unicode categories; common ranges only, see PORT STATUS).
fn py_escape_char(c: char, out: &mut String) {
    match c {
        '\\' => out.push_str("\\\\"),
        '\n' => out.push_str("\\n"),
        '\r' => out.push_str("\\r"),
        '\t' => out.push_str("\\t"),
        c if (c as u32) < 0x20 || c as u32 == 0x7f => {
            out.push_str(&format!("\\x{:02x}", c as u32));
        }
        c if (0x80..=0x9f).contains(&(c as u32)) || c as u32 == 0xa0 || c as u32 == 0xad => {
            out.push_str(&format!("\\x{:02x}", c as u32));
        }
        c if matches!(c, '\u{200b}'..='\u{200f}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{2060}'..='\u{2064}' | '\u{3000}' | '\u{feff}' | '\u{1680}'
            | '\u{2000}'..='\u{200a}') =>
        {
            out.push_str(&format!("\\u{:04x}", c as u32));
        }
        c => out.push(c),
    }
}

fn py_repr_str(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::new();
    out.push(quote);
    for c in s.chars() {
        if c == quote {
            out.push('\\');
            out.push(c);
        } else {
            py_escape_char(c, &mut out);
        }
    }
    out.push(quote);
    out
}

/// python repr of a list[str] (subprocess argv in TimeoutExpired text).
fn py_repr_str_list(items: &[String]) -> String {
    let inner: Vec<String> = items.iter().map(|s| py_repr_str(s)).collect();
    format!("[{}]", inner.join(", "))
}

// ── Token estimation (same estimator the backend shares) ────────────────────

fn is_wide_char(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x303F | 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF |
        0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF)
}

fn estimate_tokens(text: &str) -> i64 {
    if text.is_empty() {
        return 0;
    }
    let wide = text.chars().filter(|&c| is_wide_char(c)).count();
    let total = text.chars().count();
    let rest = total - wide;
    (wide + (rest + 3) / 4) as i64
}

// ── ntpath subset (mirrors ntpath 3.13 behavior probed on the interpreter) ──

fn splitdrive(p: &str) -> (String, String) {
    // UNC: //server/share/rest (either slash flavor, two leading seps)
    let bs = p.replace('/', "\\");
    if bs.starts_with("\\\\") {
        let parts: Vec<&str> = bs.split('\\').collect(); // ["", "", srv, share, ...]
        if parts.len() >= 4 && !parts[2].is_empty() && !parts[3].is_empty() {
            let drive = format!("\\\\{}\\{}", parts[2], parts[3]);
            let rest = parts[4..].join("\\");
            let rest = if parts.len() > 4 { format!("\\{}", rest) } else { rest };
            return (drive, rest);
        }
        return (String::new(), bs);
    }
    let ch: Vec<char> = p.chars().collect();
    if p.len() >= 2 && ch.len() >= 2 && ch[1] == ':' && ch[0].is_ascii_alphabetic() {
        return (p[..2].to_string(), p[2..].to_string());
    }
    (String::new(), bs)
}

fn ntp_isabs(p: &str) -> bool {
    if p.is_empty() {
        return false;
    }
    let (d, r) = splitdrive_raw(p);
    if !d.is_empty() {
        return r.starts_with('\\') || r.starts_with('/');
    }
    let c: Vec<char> = p.chars().collect();
    c.len() >= 2 && (c[0] == '\\' || c[0] == '/') && (c[1] == '\\' || c[1] == '/')
}

/// splitdrive without the slash normalization (raw prefix detection only).
fn splitdrive_raw(p: &str) -> (String, String) {
    let ch: Vec<char> = p.chars().collect();
    if ch.len() >= 2 && ch[1] == ':' && ch[0].is_ascii_alphabetic() {
        return (p[..2].to_string(), p[2..].to_string());
    }
    (String::new(), p.to_string())
}

fn ntp_normpath(p: &str) -> String {
    if p.is_empty() {
        return ".".to_string();
    }
    let s = p.replace('/', "\\");
    if s.starts_with("\\\\?\\") {
        return s; // python leaves \\?\ prefixed paths alone
    }
    let unc = s.starts_with("\\\\");
    let (prefix, rest, rooted) = if unc {
        let parts: Vec<&str> = s.split('\\').collect();
        if parts.len() >= 4 && !parts[2].is_empty() && !parts[3].is_empty() {
            let drive = format!("\\\\{}\\{}", parts[2], parts[3]);
            (drive, parts[4..].join("\\"), true)
        } else {
            (String::new(), s.clone(), parts.len() > 1)
        }
    } else {
        let (d, r) = splitdrive_raw(&s);
        let rooted = r.starts_with('\\');
        (d, r, rooted)
    };
    let mut stack: Vec<&str> = Vec::new();
    for c in rest.split('\\') {
        if c.is_empty() || c == "." {
            continue;
        }
        if c == ".." {
            match stack.last() {
                Some(&last) if last != ".." && !(last.is_empty()) => {
                    stack.pop();
                }
                _ => {
                    if !rooted {
                        stack.push("..");
                    }
                    // rooted: '..' above the root collapses away
                }
            }
            continue;
        }
        stack.push(c);
    }
    if !prefix.is_empty() {
        let body = stack.join("\\");
        if prefix.starts_with("\\\\") {
            // UNC
            if body.is_empty() {
                format!("{}\\", prefix)
            } else {
                format!("{}\\{}", prefix, body)
            }
        } else if rooted {
            if body.is_empty() {
                format!("{}\\", prefix)
            } else {
                format!("{}\\{}", prefix, body)
            }
        } else {
            // drive-relative: C:foo\..\bar
            if body.is_empty() {
                prefix
            } else {
                format!("{}{}", prefix, body)
            }
        }
    } else if rooted {
        if stack.is_empty() {
            "\\".to_string()
        } else {
            format!("\\{}", stack.join("\\"))
        }
    } else if stack.is_empty() {
        ".".to_string()
    } else {
        stack.join("\\")
    }
}

fn ntp_getcwd() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "C:\\".to_string())
}

fn ntp_join2(a: &str, b: &str) -> String {
    // faithful ntpath.join for two paths
    if b.starts_with('\\') || b.starts_with('/') {
        let (ad, _) = splitdrive_raw(a);
        return format!("{}{}", ad, b);
    }
    let (bd, _) = splitdrive_raw(b);
    if !bd.is_empty() {
        return b.to_string();
    }
    if a.is_empty() {
        return b.to_string();
    }
    let ac: Vec<char> = a.chars().collect();
    if ac[ac.len() - 1] == '\\' || ac[ac.len() - 1] == '/' {
        format!("{}{}", a, b)
    } else {
        let (ad, ar) = splitdrive_raw(a);
        if ar.is_empty() {
            // "C:" + "foo" -> "C:\foo"
            format!("{}\\{}", ad, b)
        } else {
            format!("{}\\{}", a, b)
        }
    }
}

fn ntp_abspath(p: &str) -> String {
    if ntp_isabs(p) {
        ntp_normpath(p)
    } else {
        ntp_normpath(&ntp_join2(&ntp_getcwd(), p))
    }
}

fn path_exists(p: &str) -> bool {
    std::fs::metadata(p).is_ok()
}

fn dirname_of(p: &str) -> String {
    let (d, r) = splitdrive_raw(p);
    let cs: Vec<char> = r.chars().collect();
    // find last separator in the remainder
    let mut idx: Option<usize> = None;
    for i in (0..cs.len()).rev() {
        if cs[i] == '\\' || cs[i] == '/' {
            idx = Some(i);
            break;
        }
    }
    match idx {
        None => d,
        Some(0) => format!("{}\\", d), // rooted: parent of "\x" is "\"
        Some(i) => {
            let head: String = cs[..i].iter().collect();
            if head.is_empty() {
                format!("{}\\", d)
            } else {
                format!("{}{}", d, head)
            }
        }
    }
}

fn basename_of(p: &str) -> String {
    let (_, r) = splitdrive_raw(p);
    match r.rfind(['\\', '/']) {
        Some(i) => r[i + 1..].to_string(),
        None => r,
    }
}

fn strip_verbatim(s: &str) -> String {
    if let Some(rest) = s.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{}", rest)
    } else if let Some(rest) = s.strip_prefix("\\\\?\\") {
        rest.to_string()
    } else {
        s.to_string()
    }
}

/// ntpath.realpath: canonicalize when the OS resolves it; on failure walk to
/// the nearest existing ancestor (resolving its case via the filesystem) and
/// append the remaining components verbatim. A missing drive falls back to the
/// purely lexical abspath.
fn ntp_realpath(p: &str) -> Result<String, String> {
    let ab = ntp_abspath(p);
    match std::fs::canonicalize(&ab) {
        Ok(c) => return Ok(strip_verbatim(&c.to_string_lossy())),
        Err(e) => {
            // Only the "no such file" family triggers python's fallback; other
            // errors (permissions, cycles) propagate.
            let not_found = matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidInput
            ) || matches!(e.raw_os_error(), Some(2) | Some(3) | Some(5) | Some(267) | Some(123) | Some(161) | Some(1921));
            if !not_found {
                return Err(io_err_text(&e, None));
            }
        }
    }
    // ancestor walk
    let mut tail: Vec<String> = Vec::new();
    let mut cur = ab.clone();
    loop {
        if path_exists(&cur) {
            // resolve the ancestor's real case, then append the tail verbatim
            let base = match std::fs::canonicalize(&cur) {
                Ok(c) => strip_verbatim(&c.to_string_lossy()),
                Err(_) => cur.clone(),
            };
            let mut out = base;
            for t in tail.iter().rev() {
                if !out.is_empty() && !out.ends_with('\\') {
                    out.push('\\');
                }
                out.push_str(t);
            }
            return Ok(out);
        }
        let parent = dirname_of(&cur);
        let leaf = basename_of(&cur);
        if parent == cur || leaf.is_empty() {
            return Ok(ab); // lexical fallback (missing drive / root itself)
        }
        tail.push(leaf);
        cur = parent;
    }
}

/// ntpath.relpath. Err(String) carries the ValueError message python raises on
/// mount mismatch (the only caller catches it and fails open).
fn ntp_relpath(path: &str, start: &str) -> Result<String, String> {
    let p = ntp_normpath(&ntp_abspath(path));
    let s = ntp_normpath(&ntp_abspath(start));
    let (dp, rp) = splitdrive(&p);
    let (ds, rs) = splitdrive(&s);
    if dp.to_lowercase() != ds.to_lowercase() {
        return Err(format!(
            "path is on mount {}, start on mount {}",
            py_repr_str(&dp),
            py_repr_str(&ds)
        ));
    }
    // components: rooted rests begin with an empty first component; drop it
    let mut d: Vec<&str> = rp.split('\\').filter(|x| !x.is_empty()).collect();
    let mut e: Vec<&str> = rs.split('\\').filter(|x| !x.is_empty()).collect();
    // case-insensitive-drive, case-SENSITIVE component comparison (probed:
    // relpath('D:\WS\A.py','d:\ws') == '..\\WS\\A.py')
    let unc = dp.starts_with('\\');
    if unc {
        // drive holds \\srv\share; components are the remaining path
    }
    let mut i = 0;
    while i < d.len().min(e.len()) && d[i] == e[i] {
        i += 1;
    }
    let tail = e.len() - i;
    d.drain(0..i);
    if tail == 0 && d.is_empty() {
        return Ok(".".to_string());
    }
    let mut parts: Vec<String> = vec!["..".to_string(); tail];
    parts.extend(d.iter().map(|x| x.to_string()));
    Ok(parts.join("\\"))
}

/// ntpath.splitext: last dot in the basename counts as the extension iff the
/// text before it is non-empty, not all dots, and does not end in ':'.
fn ntp_splitext(path: &str) -> (String, String) {
    let (_, r) = splitdrive_raw(path);
    let base = match r.rfind(['\\', '/']) {
        Some(i) => &r[i + 1..],
        None => r.as_str(),
    };
    match base.rfind('.') {
        Some(dot) if dot > 0 => {
            let head = &base[..dot];
            let not_all_dots = head.chars().any(|c| c != '.');
            let drive_end = head.ends_with(':');
            if not_all_dots && !drive_end {
                (path[..path.len() - base.len() + dot].to_string(), base[dot..].to_string())
            } else {
                (path.to_string(), String::new())
            }
        }
        _ => (path.to_string(), String::new()),
    }
}

// ── OS error rendering (python OSError str parity) ──────────────────────────

#[cfg(windows)]
fn win_message(code: i32) -> String {
    use std::ffi::c_void;
    extern "system" {
        fn FormatMessageW(
            flags: u32,
            source: *const c_void,
            message_id: u32,
            lang_id: u32,
            buffer: *mut u16,
            size: u32,
            arguments: *const *const c_void,
        ) -> u32;
    }
    const FROM_SYSTEM: u32 = 0x0000_1000;
    const IGNORE_INSERTS: u32 = 0x0000_0200;
    let mut buf = [0u16; 1024];
    let n = unsafe {
        FormatMessageW(
            FROM_SYSTEM | IGNORE_INSERTS,
            std::ptr::null(),
            code as u32,
            0,
            buf.as_mut_ptr(),
            buf.len() as u32,
            std::ptr::null(),
        )
    };
    if n == 0 {
        return String::new();
    }
    let mut s = String::from_utf16_lossy(&buf[..n as usize]);
    // python strips the trailing \r\n the API appends
    while s.ends_with('\n') || s.ends_with('\r') || s.ends_with(' ') {
        s.pop();
    }
    s
}

#[cfg(not(windows))]
fn win_message(_code: i32) -> String {
    String::new()
}

/// python's str(OSError) with a WinError code, plus optional ": 'filename'".
fn io_err_text(e: &std::io::Error, path: Option<&str>) -> String {
    let mut s = match e.raw_os_error() {
        Some(code) => format!("[WinError {}] {}", code, win_message(code)),
        None => e.to_string(),
    };
    if let Some(p) = path {
        s.push_str(&format!(": {}", py_repr_str(p)));
    }
    s
}

// ── Decode ladder ───────────────────────────────────────────────────────────

/// utf-8 → gbk → latin-1 (utf-8-sig is unreachable after utf-8 — probed);
/// a NUL in the first 8KB marks binary content.
fn decode_ladder(raw: &[u8]) -> Option<String> {
    if raw.iter().take(8192).any(|&b| b == 0) {
        return None;
    }
    if let Ok(s) = std::str::from_utf8(raw) {
        return Some(s.to_string());
    }
    // python's 'gbk' rejects every 0x80 lead (probed b'\x80abc' -> fails), and
    // WHATWG gbk accepts it as €. Scan leads/trails with the GBK ranges so the
    // 0x80-as-lead case fails the same way; encoding_rs decides the pairs.
    if gbk_pair_scan_ok(raw) {
        let (decoded, _, had_errors) = encoding_rs::GBK.decode(raw);
        if !had_errors {
            // encoding_rs turns unmappable pairs into U+FFFD; python would
            // raise. Reject if the round-trip count of replacements is nonzero.
            if !decoded.contains('\u{FFFD}') {
                return Some(decoded.into_owned());
            }
        }
    }
    // latin-1: every byte maps 1:1
    Some(raw.iter().map(|&b| b as char).collect())
}

/// Structural GBK validity check (lead 0x81..0xFE, trail 0x40..0x7E or
/// 0x80..0xFE; ASCII below 0x80 passes through; 0x80 and 0xFF are never valid
/// leads — matching python's gbk codec which has no single-byte 0x80).
fn gbk_pair_scan_ok(raw: &[u8]) -> bool {
    let mut i = 0;
    while i < raw.len() {
        let b = raw[i];
        if b < 0x80 {
            i += 1;
            continue;
        }
        if (0x81..=0xFE).contains(&b) {
            if i + 1 >= raw.len() {
                return false;
            }
            let t = raw[i + 1];
            if !(matches!(t, 0x40..=0x7E) || matches!(t, 0x80..=0xFE)) {
                return false;
            }
            i += 2;
            continue;
        }
        return false; // 0x80 or 0xFF lead
    }
    true
}

// ── Strict base64 (binascii.a2b_base64 strict_mode=True, error table probed) ─

fn b64_val(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a') as u32 + 26),
        b'0'..=b'9' => Some((c - b'0') as u32 + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn b64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// b64decode(payload, validate=True) == binascii.a2b_base64(s, strict_mode=True).
/// Err carries str(binascii.Error) verbatim; message texts and their precedence were
/// pinned against the 29-case probe matrix in tmp/cr_spec.out (note: the short
/// binascii messages carry NO "Invalid base64-encoded bytes:" prefix).
fn b64_decode_strict(s: &str) -> Result<Vec<u8>, String> {
    if !s.is_ascii() {
        return Err("string argument should contain only ASCII characters".to_string());
    }
    let bytes = s.as_bytes();
    for &c in bytes {
        if !(c.is_ascii_alphanumeric() || c == b'+' || c == b'/' || c == b'=') {
            return Err("Only base64 data is allowed".to_string());
        }
    }
    let n = bytes.len();
    if n == 0 {
        return Ok(Vec::new());
    }
    if bytes.iter().all(|&c| c == b'=') {
        return Err("Leading padding not allowed".to_string());
    }
    let lead_data = bytes.iter().position(|&c| c == b'=').unwrap_or(n);
    if lead_data % 4 == 1 {
        return Err(format!(
            "Invalid base64-encoded string: number of data characters ({}) cannot be 1 more than a multiple of 4",
            lead_data
        ));
    }
    // Streaming quad scan for the structural padding checks.
    let mut out: Vec<u8> = Vec::new();
    let mut quad: [u8; 4] = [b'A'; 4];
    let mut qi = 0usize;
    let mut quad_padded = false;
    let mut prev_quad_padded = false;
    let mut pads = 0usize;
    for (idx, &c) in bytes.iter().enumerate() {
        if c == b'=' {
            if qi == 0 {
                if idx == 0 {
                    return Err("Leading padding not allowed".to_string());
                }
                return Err("Excess padding not allowed".to_string());
            }
            pads += 1;
            quad[qi] = b'=';
            quad_padded = true;
            qi += 1;
            if qi == 4 {
                flush_quad(&quad, &mut out);
                prev_quad_padded = true;
                quad_padded = false;
                qi = 0;
            }
            continue;
        }
        if qi == 0 && prev_quad_padded {
            return Err("Excess data after padding".to_string());
        }
        if quad_padded {
            return Err("Discontinuous padding not allowed".to_string());
        }
        quad[qi] = c;
        qi += 1;
        if qi == 4 {
            flush_quad(&quad, &mut out);
            prev_quad_padded = quad_padded;
            quad_padded = false;
            qi = 0;
        }
    }
    if pads > 2 {
        return Err("Excess padding not allowed".to_string());
    }
    if qi != 0 {
        return Err("Incorrect padding".to_string());
    }
    Ok(out)
}

/// Emit the bytes of one complete 4-char quad; trailing '=' padding decides how
/// many bytes a2b writes back (1 or 2 data chars emit 1, 3 emit 2, 4 emit 3).
fn flush_quad(quad: &[u8; 4], out: &mut Vec<u8>) {
    let v = |c: u8| b64_val(c).unwrap_or(0) as u32;
    let nbytes: usize = if quad[3] == b'=' {
        if quad[2] == b'=' { 1 } else { 2 }
    } else {
        3
    };
    let bits = (v(quad[0]) << 18) | (v(quad[1]) << 12) | (v(quad[2]) << 6) | v(quad[3]);
    out.push(((bits >> 16) & 0xFF) as u8);
    if nbytes >= 2 {
        out.push(((bits >> 8) & 0xFF) as u8);
    }
    if nbytes >= 3 {
        out.push((bits & 0xFF) as u8);
    }
}

// ── Anti-injection sanitizer (mirrors tool_hooks.sanitize_injection_tags) ───

const WS_CLASS: &str = "[\\x09\\x0a\\x0b\\x0c\\x0d\\x1c\\x1d\\x1e\\x1f\\x20\\x85\\xa0\\u{1680}\\u{2000}-\\u{200a}\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}]";

fn strict_regex() -> &'static regex::Regex {
    use once_cell::sync::Lazy;
    static RE: Lazy<regex::Regex> = Lazy::new(|| {
        let ws = WS_CLASS;
        let pat = format!(
            "(?i)<{ws}*/?{ws}*(tool_call|tool_calls|tool_result|tool_results|tool_use\
             |function_call|function_calls|function_result|function_results\
             |system-reminder|system_reminder|system_prompt|systemprompt\
             |antml:\\w+|\\|?im_start\\|?|\\|?im_end\\|?|\\|?endoftext\\|?|\\|?eot_id\\|?\
             |\\|?start_header_id\\|?|\\|?end_header_id\\|?)(?:{ws}[^>]*)?{ws}*/?>",
            ws = ws
        );
        regex::Regex::new(&pat).expect("strict injection regex")
    });
    &RE
}

fn loose_regex() -> &'static regex::Regex {
    use once_cell::sync::Lazy;
    static RE: Lazy<regex::Regex> = Lazy::new(|| {
        let ws = WS_CLASS;
        let pat = format!(
            "(?im)^[ \\t]*(<{ws}*/?{ws}*(?:system|assistant|user|human|instructions?\
             |important_instructions)(?:{ws}[^>]*)?{ws}*/?>)[ \\t]*$",
            ws = ws
        );
        regex::Regex::new(&pat).expect("loose injection regex")
    });
    &RE
}

fn neutralize_tag(text: &str) -> String {
    let cs: Vec<char> = text.chars().collect();
    if cs.len() < 2 {
        return text.to_string();
    }
    let inner: String = cs[1..cs.len() - 1].iter().collect();
    format!("\u{FF1C}{}\u{FF1E}", inner)
}

fn sanitize_injection_tags_rust(text: &str) -> (String, usize) {
    if text.is_empty() {
        return (text.to_string(), 0);
    }
    let mut hits = 0usize;
    // strict pass: neutralize every full match, in order, non-overlapping
    let cleaned: String = strict_regex()
        .replace_all(text, |caps: &regex::Captures| {
            hits += 1;
            neutralize_tag(&caps[0])
        })
        .into_owned();
    // loose pass: neutralize the captured tag, dropping the surrounding indent
    let cleaned2: String = loose_regex()
        .replace_all(&cleaned, |caps: &regex::Captures| {
            hits += 1;
            let whole = caps.get(0).map(|m| m.as_str()).unwrap_or("");
            let tag = &caps[1];
            let neutral = neutralize_tag(tag);
            whole.replace(tag, &neutral)
        })
        .into_owned();
    (cleaned2, hits)
}

// ── shorten_path (mirrors tools.shorten_path) ───────────────────────────────

fn shorten_path(abs_path: &str, ws_root: &str) -> String {
    if !ws_root.is_empty() {
        if let Ok(rel) = ntp_relpath(abs_path, ws_root) {
            if !rel.starts_with("..") {
                return rel.replace('\\', "/");
            }
        }
    }
    let p = abs_path.replace('\\', "/");
    // ^[A-Za-z]:/Users/[^/]+/(.+)
    if let Some(rest) = drive_users_strip(&p) {
        return format!("~/{}", rest);
    }
    users_sub_all(&p)
}

fn drive_users_strip(p: &str) -> Option<String> {
    let cs: Vec<char> = p.chars().collect();
    if cs.len() < 4 || !cs[0].is_ascii_alphabetic() || cs[1] != ':' || cs[2] != '/' {
        return None;
    }
    let tail: String = cs[3..].iter().collect();
    split_users_prefix(&tail)
}

fn split_users_prefix(tail: &str) -> Option<String> {
    let seg = tail.strip_prefix("Users/")?;
    if seg.is_empty() {
        return None;
    }
    let slash = seg.find('/')?;
    if slash == 0 {
        return None;
    }
    // (.+) requires at least one char after the user segment's slash.
    if slash + 1 >= seg.len() {
        return None;
    }
    Some(seg[slash + 1..].to_string())
}

/// re.sub(r"/Users/[^/]+/", "/[USER]/", p) — all occurrences. The whole span
/// "/Users/<seg>/" (both slashes included) is replaced.
fn users_sub_all(p: &str) -> String {
    let mut out = String::new();
    let mut rest = p;
    while let Some((start, end)) = find_users_seg(rest) {
        out.push_str(&rest[..start]);
        out.push_str("/[USER]/");
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

/// Locate "/Users/<seg>/" (python regex semantics: [^/]+ greedy, at least one
/// non-'/' char, followed by '/'); returns (span start, span end).
fn find_users_seg(hay: &str) -> Option<(usize, usize)> {
    let b = hay.as_bytes();
    let mut i = 0;
    while i + 7 <= b.len() {
        if &b[i..i + 6] == b"/Users" && b[i + 6] == b'/' {
            let mut j = i + 7;
            while j < b.len() && b[j] != b'/' {
                j += 1;
            }
            if j > i + 7 && j < b.len() {
                return Some((i, j + 1));
            }
        }
        i += 1;
    }
    None
}

// ── Internal Result mirror ──────────────────────────────────────────────────

#[derive(Clone)]
struct Cr {
    ok: bool,
    value: Option<String>,
    bytes: Option<Vec<u8>>,
    error: String,
    code: String,
    rel: String,
    has_rel: bool,
    mime: String,
    has_mime: bool,
    nbytes: Option<i64>,
}

impl Cr {
    fn success(value: &str) -> Cr {
        Cr { ok: true, value: Some(value.to_string()), bytes: None, error: String::new(),
             code: String::new(), rel: String::new(), has_rel: false, mime: String::new(),
             has_mime: false, nbytes: None }
    }
    fn success_bytes(b: Vec<u8>, mime: &str) -> Cr {
        Cr { ok: true, value: None, bytes: Some(b), error: String::new(), code: String::new(),
             rel: String::new(), has_rel: false, mime: mime.to_string(), has_mime: true,
             nbytes: None }
    }
    fn success_bytes2(b: Vec<u8>) -> Cr {
        Cr { ok: true, value: None, bytes: Some(b), error: String::new(), code: String::new(),
             rel: String::new(), has_rel: false, mime: String::new(), has_mime: false,
             nbytes: None }
    }
    fn failure(msg: &str, code: &str) -> Cr {
        Cr { ok: false, value: None, bytes: None, error: msg.to_string(), code: code.to_string(),
             rel: String::new(), has_rel: false, mime: String::new(), has_mime: false,
             nbytes: None }
    }
    fn with_rel(mut self, rel: &str) -> Self {
        self.rel = rel.to_string();
        self.has_rel = true;
        self
    }
    fn to_py<'py>(&self, py: Python<'py>) -> PyResult<PyObject> {
        let d = PyDict::new_bound(py);
        d.set_item("ok", self.ok)?;
        if self.ok {
            if let Some(s) = &self.value {
                d.set_item("value", s)?;
            } else if let Some(b) = &self.bytes {
                d.set_item("value", PyBytes::new_bound(py, b))?;
            } else {
                d.set_item("value", py.None())?;
            }
        } else {
            d.set_item("value", py.None())?;
        }
        d.set_item("error", &self.error)?;
        let meta = PyDict::new_bound(py);
        if !self.code.is_empty() {
            meta.set_item("code", &self.code)?;
        }
        if self.has_rel {
            meta.set_item("rel", &self.rel)?;
        }
        if self.has_mime {
            meta.set_item("mime", &self.mime)?;
        }
        if let Some(n) = self.nbytes {
            meta.set_item("bytes", n)?;
        }
        d.set_item("meta", meta)?;
        Ok(d.into_any().unbind())
    }
}

// ── Confinement ─────────────────────────────────────────────────────────────

fn confine_rust(ref_in: &str, workspace_root: &str) -> Cr {
    let rf = py_strip(ref_in);
    if rf.is_empty() {
        return Cr::failure("Empty reference", "EmptyRef");
    }
    let root_w = if workspace_root.is_empty() { ntp_getcwd() } else { workspace_root.to_string() };
    let root = match ntp_realpath(&ntp_abspath(&root_w)) {
        Ok(r) => r,
        Err(e) => return Cr::failure(&format!("Unresolvable path: {}", e), "BadPath"),
    };
    let candidate = if ntp_isabs(&rf) { rf.clone() } else { ntp_join2(&root, &rf) };
    let target = match ntp_realpath(&candidate) {
        Ok(t) => t,
        Err(e) => return Cr::failure(&format!("Unresolvable path: {}", e), "BadPath"),
    };
    // containment: all of root's components are a case-insensitive prefix of
    // the target's (the outcome ntpath.commonpath([root, target]) == root
    // decides in the source, including the cross-drive ValueError)
    if !common_prefix_ok(&root, &target) {
        return Cr::failure(
            &format!("Reference is outside the workspace: {}", rf),
            "OutsideWorkspace",
        );
    }
    Cr::success(&target)
}

fn path_components(p: &str) -> (String, Vec<String>) {
    let (d, r) = splitdrive(p);
    let comps = r
        .split('\\')
        .filter(|x| !x.is_empty())
        .map(|x| x.to_lowercase())
        .collect();
    (d.to_lowercase(), comps)
}

fn common_prefix_ok(root: &str, target: &str) -> bool {
    let (rd, rc) = path_components(root);
    let (td, tc) = path_components(target);
    if rd != td {
        return false;
    }
    if rc.len() > tc.len() {
        return false;
    }
    rc.iter().zip(tc.iter()).all(|(a, b)| a == b)
}

// ── Readers ─────────────────────────────────────────────────────────────────

fn image_mime_by_ext(ext: &str) -> Option<&'static str> {
    match ext {
        ".png" => Some("image/png"),
        ".jpg" | ".jpeg" => Some("image/jpeg"),
        ".webp" => Some("image/webp"),
        ".gif" => Some("image/gif"),
        _ => None,
    }
}

fn read_file_rust(path: &str, root: &str) -> Cr {
    let ext = py_lower(&ntp_splitext(path).1);
    if BINARY_EXTS.contains(&ext.as_str()) {
        return Cr::failure(
            &format!("Not inlined as text ({} is binary)", ext),
            "BinaryFile",
        );
    }
    let size = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(e) => {
            return Cr::failure(&format!("Cannot stat file: {}", io_err_text(&e, Some(path))), "StatFailed")
        }
    };
    let mut raw: Vec<u8> = Vec::new();
    match std::fs::File::open(path) {
        Err(e) => {
            return Cr::failure(&format!("Cannot read file: {}", io_err_text(&e, Some(path))), "ReadFailed")
        }
        Ok(mut f) => {
            if let Err(e) = f.by_ref().take(MAX_FILE_BYTES).read_to_end(&mut raw) {
                return Cr::failure(&format!("Cannot read file: {}", io_err_text(&e, Some(path))), "ReadFailed");
            }
        }
    }
    let text = match decode_ladder(&raw) {
        Some(t) => t,
        None => return Cr::failure("Not inlined as text (binary content)", "BinaryFile"),
    };
    let mut text = text;
    if size > MAX_FILE_BYTES {
        text.push_str(&format!(
            "\n... (file is {} bytes; only the first {} were read)",
            size, MAX_FILE_BYTES
        ));
    }
    Cr::success(&text).with_rel(&shorten_path(path, root))
}

struct DirEntryLite {
    name: String,
    is_dir: bool,
    dir_err: Option<std::io::Error>,
}

fn read_dir_rust(path: &str, root: &str) -> Cr {
    // python sorts with key (not is_dir(), name.lower()) INSIDE the try that
    // converts any OSError (including per-entry stat failures) into ListFailed
    let rd = match std::fs::read_dir(path) {
        Ok(r) => r,
        Err(e) => {
            return Cr::failure(
                &format!("Cannot list directory: {}", io_err_text(&e, Some(path))),
                "ListFailed",
            )
        }
    };
    let mut entries: Vec<DirEntryLite> = Vec::new();
    for e in rd {
        let e = match e {
            Ok(e) => e,
            Err(_) => continue, // python's scandir iteration errors surface via is_dir below
        };
        let name = e.file_name().to_string_lossy().to_string();
        let (is_dir, dir_err) = match std::fs::metadata(e.path()) {
            Ok(m) => (m.is_dir(), None),
            Err(err) => (false, Some(err)),
        };
        entries.push(DirEntryLite { name, is_dir, dir_err });
    }
    // any failed is_dir during the sort key → ListFailed with the OSError text,
    // matching python raising inside sorted(key=...)
    if let Some(bad) = entries.iter().find(|en| en.dir_err.is_some()) {
        let e = bad.dir_err.as_ref().unwrap();
        return Cr::failure(
            &format!("Cannot list directory: {}", io_err_text(e, Some(path))),
            "ListFailed",
        );
    }
    entries.sort_by(|a, b| {
        (!a.is_dir)
            .cmp(&(!b.is_dir))
            .then_with(|| py_lower(&a.name).cmp(&py_lower(&b.name)))
    });
    let total = entries.len();
    let mut names: Vec<String> = Vec::new();
    for en in entries.iter().take(DIR_ENTRY_LIMIT) {
        if en.is_dir {
            names.push(format!("{}/", en.name));
        } else {
            names.push(en.name.clone());
        }
    }
    let mut body = names.join("\n");
    if body.is_empty() {
        body = "(empty directory)".to_string();
    }
    if total > DIR_ENTRY_LIMIT {
        body.push_str(&format!("\n... ({} more entries)", total - DIR_ENTRY_LIMIT));
    }
    Cr::success(&body).with_rel(&shorten_path(path, root))
}

fn run_git(root: &str, spec: &str) -> (Option<String>, Option<(i64, String)>, Option<(String, String)>) {
    // (stdout, (rc, stderr), fatal-message)
    let spec_s = py_strip(spec);
    let mut args: Vec<String> = vec!["-c".to_string(), "core.quotePath=false".to_string()];
    if spec_s == "staged" {
        args.push("diff".into());
        args.push("--cached".into());
    } else if spec_s.is_empty() || spec_s == "unstaged" || spec_s == "worktree" {
        args.push("diff".into());
    } else {
        args.push("diff".into());
        args.push(spec_s.clone());
    }
    let argv_display = {
        let mut v = vec!["git".to_string()];
        v.extend(args.iter().cloned());
        v
    };
    let mut cmd = Command::new("git");
    cmd.args(&args).current_dir(root).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = if e.kind() == std::io::ErrorKind::NotFound {
                py_repr_str("git") // python: FileNotFoundError: 'git'
            } else {
                io_err_text(&e, Some(root))
            };
            return (None, None, Some(("git failed".to_string(), msg)));
        }
    };
    let start = Instant::now();
    let timeout_msg = format!(
        "Command {} timed out after {} seconds",
        py_repr_str_list(&argv_display),
        30
    );
    let mut child = child;
    let mut stdout_buf: Vec<u8> = Vec::new();
    let mut stderr_buf: Vec<u8> = Vec::new();
    // read with timeout: pump pipes while waiting
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {}
            Err(e) => return (None, None, Some(("git failed".to_string(), io_err_text(&e, None)))),
        }
        if start.elapsed() > Duration::from_secs(30) {
            let _ = child.kill();
            let _ = child.wait();
            return (None, None, Some(("git failed".to_string(), timeout_msg)));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    if let Some(mut o) = child.stdout.take() {
        let _ = o.read_to_end(&mut stdout_buf);
    }
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_end(&mut stderr_buf);
    }
    let status = child.wait().ok();
    let rc = status.and_then(|s| s.code()).unwrap_or(-1) as i64;
    let out_s = universal_newlines(&String::from_utf8_lossy(&stdout_buf));
    let err_s = universal_newlines(&String::from_utf8_lossy(&stderr_buf));
    if rc != 0 {
        return (None, Some((rc, err_s)), None);
    }
    (Some(out_s), None, None)
}

/// python text-mode universal newlines: \r\n and lone \r → \n.
fn universal_newlines(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

fn read_git_diff_rust(root: &str, spec: &str) -> Cr {
    let spec_s = py_strip(spec);
    let rel = py_strip(&format!("git diff {}", spec_s));
    let (stdout, err_rc, fatal) = run_git(root, spec);
    if let Some((_, msg)) = fatal {
        return Cr::failure(&format!("git failed: {}", msg), "GitFailed");
    }
    if let Some((rc, stderr)) = err_rc {
        return Cr::failure(
            &format!("git exited {}: {}", rc, py_strip(&stderr)),
            "GitFailed",
        );
    }
    let out = py_strip(stdout.as_deref().unwrap_or(""));
    if out.is_empty() {
        return Cr::success("(no changes)").with_rel(&rel);
    }
    Cr::success(&out).with_rel(&rel)
}

// ── Images ──────────────────────────────────────────────────────────────────

fn decode_data_url(raw: &str) -> Cr {
    let s = py_strip(raw);
    if !s.starts_with("data:") {
        return Cr::failure("Not a data URL", "BadImage");
    }
    let (head, payload) = match s.find(',') {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s.as_str(), ""),
    };
    if payload.is_empty() {
        return Cr::failure("Empty data URL", "BadImage");
    }
    let after = head.chars().skip(5).collect::<String>();
    let mime_part = after.split(';').next().unwrap_or("");
    let mime = if py_truthy_str(&py_strip(&py_lower(mime_part))) {
        py_strip(&py_lower(mime_part))
    } else {
        "image/png".to_string()
    };
    if !head.contains(";base64") {
        return Cr::failure("Only base64 data URLs are supported", "BadImage");
    }
    match b64_decode_strict(payload) {
        Ok(b) => Cr::success_bytes2(b).mime_set(&mime),
        Err(e) => Cr::failure(&format!("Corrupt base64: {}", e), "BadImage"),
    }
}

fn py_truthy_str(s: &str) -> bool {
    !s.is_empty()
}

trait MimeSet {
    fn mime_set(self, m: &str) -> Self;
}
impl MimeSet for Cr {
    fn mime_set(mut self, m: &str) -> Self {
        self.mime = m.to_string();
        self.has_mime = true;
        self
    }
}

fn read_image_rust(ref_in: &str, workspace_root: &str) -> Cr {
    let rf = ref_in.to_string(); // already stripped by caller per python
    let (mut got, blob, mime) = if rf.starts_with("data:") {
        let g = decode_data_url(&rf);
        if !g.ok {
            return g;
        }
        let b = g.bytes.clone().unwrap_or_default();
        let m = g.mime.clone();
        (g, b, m)
    } else {
        let placed = confine_rust(&rf, workspace_root);
        if !placed.ok {
            return placed;
        }
        let path = placed.value.clone().unwrap_or_default();
        if !is_file(&path) {
            return Cr::failure("Image not found", "NotFound");
        }
        let ext = py_lower(&ntp_splitext(&path).1);
        let mime = match image_mime_by_ext(&ext) {
            Some(m) => m.to_string(),
            None => {
                let shown = if ext.is_empty() { "no extension".to_string() } else { ext.clone() };
                return Cr::failure(
                    &format!("Unsupported image type ({})", shown),
                    "BadImage",
                );
            }
        };
        let mut blob = Vec::new();
        match std::fs::File::open(&path) {
            Err(e) => {
                return Cr::failure(
                    &format!("Cannot read image: {}", io_err_text(&e, Some(&path))),
                    "ReadFailed",
                )
            }
            Ok(mut f) => {
                if let Err(e) = f.by_ref().take((MAX_IMAGE_BYTES + 1) as u64).read_to_end(&mut blob) {
                    return Cr::failure(
                        &format!("Cannot read image: {}", io_err_text(&e, Some(&path))),
                        "ReadFailed",
                    );
                }
            }
        }
        (Cr::success_bytes(blob.clone(), &mime), blob, mime)
    };
    let mut got = got;
    if !IMAGE_MIMES.contains(&mime.as_str()) {
        return Cr::failure(&format!("Unsupported image type ({})", mime), "BadImage");
    }
    if blob.len() > MAX_IMAGE_BYTES {
        let mb = (MAX_IMAGE_BYTES / (1024 * 1024)) as i64;
        return Cr::failure(&format!("Image exceeds {}MB", mb), "TooLarge");
    }
    if blob.is_empty() {
        return Cr::failure("Image is empty", "BadImage");
    }
    let data_url = format!("data:{};base64,{}", mime, b64_encode(&blob));
    got.value = Some(data_url);
    got.bytes = None;
    got.nbytes = Some(blob.len() as i64);
    got
}

fn is_file(p: &str) -> bool {
    std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false)
}
fn is_dir(p: &str) -> bool {
    std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

fn row_to_py<'py>(r: &Cr, py: Python<'py>, ref_s: &str, label: &str) -> PyResult<PyObject> {
    let d = PyDict::new_bound(py);
    d.set_item("kind", KIND_IMAGE)?;
    d.set_item("ref", ref_s)?;
    d.set_item("label", label)?;
    d.set_item("ok", r.ok)?;
    d.set_item("data_url", r.value.clone().unwrap_or_default())?;
    d.set_item("mime", if r.ok { r.mime.clone() } else { String::new() })?;
    d.set_item("bytes", r.nbytes.unwrap_or(0))?;
    d.set_item("tokens", if r.ok { IMAGE_TOKEN_ESTIMATE } else { 0 })?;
    d.set_item("error", if r.ok { "" } else { &r.error })?;
    d.set_item("code", if r.ok { "" } else { &r.code })?;
    Ok(d.into_any().unbind())
}

// ── Budget ──────────────────────────────────────────────────────────────────

fn clip_rust(text: &str, max_tokens: i64) -> (String, bool) {
    if max_tokens <= 0 {
        return (String::new(), true);
    }
    if estimate_tokens(text) <= max_tokens {
        return (text.to_string(), false);
    }
    let mut keep = text.to_string();
    for _ in 0..4 {
        let est = estimate_tokens(&keep).max(1) as f64;
        let ratio = max_tokens as f64 / est;
        if ratio >= 1.0 {
            break;
        }
        let nchars = keep.chars().count();
        let cut = ((nchars as f64) * ratio * 0.98).trunc() as usize;
        let cut = cut.max(1);
        keep = keep.chars().take(cut).collect();
    }
    (keep, true)
}

fn allocate_rust(sizes: &[i64], budget: i64) -> Vec<i64> {
    let n = sizes.len();
    if n == 0 || budget <= 0 {
        return vec![0; n];
    }
    let mut remaining = budget;
    let mut grants = vec![0i64; n];
    let mut open: Vec<usize> = (0..n).collect();
    while !open.is_empty() && remaining > 0 {
        let share = remaining / (open.len() as i64); // both positive: floor
        if share <= 0 {
            break;
        }
        let mut still: Vec<usize> = Vec::new();
        for idx in 0..open.len() {
            let i = open[idx];
            let want = sizes[i] - grants[i];
            if want <= share {
                grants[i] += want;
                remaining -= want;
            } else {
                grants[i] += share;
                remaining -= share;
                still.push(i);
            }
        }
        if still.len() == open.len() {
            break;
        }
        open = still;
    }
    grants
}

// ── Row machinery for resolve_refs ──────────────────────────────────────────

struct RefRow {
    kind: String,
    refr: String,
    label: String,
    ok: bool,
    text: String,
    tokens: i64,
    truncated: bool,
    error: String,
    code: String,
    rel: Option<String>,
}

impl RefRow {
    fn new(kind: String, refr: String, label: String) -> RefRow {
        RefRow {
            kind,
            refr,
            label,
            ok: false,
            text: String::new(),
            tokens: 0,
            truncated: false,
            error: String::new(),
            code: String::new(),
            rel: None,
        }
    }
    fn to_py<'py>(&self, py: Python<'py>) -> PyResult<PyObject> {
        let d = PyDict::new_bound(py);
        // insertion order matches python: kind,ref,label,ok,text,tokens,
        // truncated,error,code and rel last (only on the success path)
        d.set_item("kind", &self.kind)?;
        d.set_item("ref", &self.refr)?;
        d.set_item("label", &self.label)?;
        d.set_item("ok", self.ok)?;
        d.set_item("text", &self.text)?;
        d.set_item("tokens", self.tokens)?;
        d.set_item("truncated", self.truncated)?;
        d.set_item("error", &self.error)?;
        d.set_item("code", &self.code)?;
        if let Some(r) = &self.rel {
            d.set_item("rel", r)?;
        }
        Ok(d.into_any().unbind())
    }
}

// ── pyo3 surface ────────────────────────────────────────────────────────────

#[pyfunction]
fn split_by_modality<'py>(py: Python<'py>, refs: &Bound<'py, PyAny>) -> PyResult<PyObject> {
    let mut text: Vec<PyObject> = Vec::new();
    let mut images: Vec<PyObject> = Vec::new();
    if let Ok(list) = refs.downcast::<PyList>() {
        for raw in list.iter() {
            if !raw.is_instance_of::<PyDict>() {
                continue;
            }
            let d = raw.downcast::<PyDict>()?;
            let kind = py_strip(&py_lower(&field_or_empty_str(d, "kind")?));
            if kind == KIND_IMAGE {
                images.push(raw.unbind());
            } else {
                text.push(raw.unbind());
            }
        }
    }
    let t = PyList::new_bound(py, text);
    let i = PyList::new_bound(py, images);
    Ok(PyTuple::new_bound(py, vec![t.as_any(), i.as_any()]).into_any().unbind())
}

#[pyfunction]
fn confine<'py>(py: Python<'py>, refr: &str, workspace_root: &str) -> PyResult<PyObject> {
    confine_rust(refr, workspace_root).to_py(py)
}

#[pyfunction]
fn _decode<'py>(py: Python<'py>, raw: &Bound<'py, PyBytes>) -> PyResult<Option<PyObject>> {
    match decode_ladder(raw.as_bytes()) {
        Some(s) => Ok(Some(PyString::new_bound(py, &s).into_any().unbind())),
        None => Ok(None),
    }
}

#[pyfunction]
fn _read_file<'py>(py: Python<'py>, path: &str, root: &str) -> PyResult<PyObject> {
    read_file_rust(path, root).to_py(py)
}

#[pyfunction]
fn _read_dir<'py>(py: Python<'py>, path: &str, root: &str) -> PyResult<PyObject> {
    read_dir_rust(path, root).to_py(py)
}

#[pyfunction]
#[pyo3(signature = (root, spec = ""))]
fn _read_git_diff<'py>(py: Python<'py>, root: &str, spec: &str) -> PyResult<PyObject> {
    read_git_diff_rust(root, spec).to_py(py)
}

#[pyfunction]
fn _decode_data_url<'py>(py: Python<'py>, raw: &str) -> PyResult<PyObject> {
    decode_data_url(raw).to_py(py)
}

#[pyfunction]
fn _read_image<'py>(py: Python<'py>, refr: &str, workspace_root: &str) -> PyResult<PyObject> {
    read_image_rust(refr, workspace_root).to_py(py)
}

#[pyfunction]
fn resolve_images<'py>(py: Python<'py>, refs: &Bound<'py, PyAny>, workspace_root: &str) -> PyResult<PyObject> {
    let out: Vec<PyObject> = Vec::new();
    let mut rows = out;
    if let Ok(list) = refs.downcast::<PyList>() {
        for raw in list.iter() {
            if !raw.is_instance_of::<PyDict>() {
                continue;
            }
            let d = raw.downcast::<PyDict>()?;
            let refr = py_strip(&field_or_empty_str(d, "ref")?);
            let mut label = field_or_empty_str(d, "label")?;
            if label.is_empty() {
                label = if refr.starts_with("data:") {
                    "pasted image".to_string()
                } else {
                    refr.clone()
                };
            }
            let got = read_image_rust(&refr, workspace_root);
            rows.push(row_to_py(&got, py, &refr, &label)?);
        }
    }
    Ok(PyList::new_bound(py, rows).into_any().unbind())
}

#[pyfunction]
fn render_vision_unavailable<'py>(py: Python<'py>, rows: &Bound<'py, PyAny>) -> PyResult<String> {
    let mut named: Vec<String> = Vec::new();
    if let Ok(list) = rows.downcast::<PyList>() {
        for r in list.iter() {
            if !r.is_instance_of::<PyDict>() {
                continue;
            }
            let d = r.downcast::<PyDict>()?;
            let ok = matches!(dict_field(&d, "ok")?, Some(v) if py_truthy(&v));
            if !ok {
                continue;
            }
            let label = match dict_field(&d, "label")? {
                Some(v) if py_truthy(&v) => py_str_of(&v)?,
                _ => match dict_field(&d, "ref")? {
                    Some(v) if py_truthy(&v) => py_str_of(&v)?,
                    _ => "image".to_string(),
                },
            };
            named.push(label);
        }
    }
    if named.is_empty() {
        return Ok(String::new());
    }
    let n = named.len();
    let labels = named.join("\u{3001}");
    Ok(format!(
        "\u{FF08}\u{7528}\u{6237}\u{9644}\u{52A0}\u{4E86} {} \u{5F20}\u{56FE}\u{7247}\u{FF1A}{}\u{3002}\u{5F53}\u{524D}\u{6A21}\u{578B}\u{4E0D}\u{652F}\u{6301}\u{8BFB}\u{53D6}\u{56FE}\u{7247}\u{FF0C}\u{56E0}\u{6B64}\u{65E0}\u{6CD5}\u{770B}\u{5230}\u{5B83}\u{4EEC}\u{7684}\u{5185}\u{5BB9}\u{3002}\u{5982}\u{9700}\u{5206}\u{6790}\u{56FE}\u{7247}\u{FF0C}\u{8BF7}\u{5207}\u{6362}\u{5230}\u{652F}\u{6301}\u{89C6}\u{89C9}\u{7684}\u{6A21}\u{578B}\u{3002}\u{FF09}",
        n, labels
    ))
}

#[pyfunction]
fn _clip(text: &str, max_tokens: i64) -> (String, bool) {
    clip_rust(text, max_tokens)
}

#[pyfunction]
fn _allocate(sizes: Vec<i64>, budget: i64) -> Vec<i64> {
    allocate_rust(&sizes, budget)
}

#[pyfunction]
#[pyo3(signature = (refs, workspace_root, budget_tokens = DEFAULT_REF_BUDGET as f64))]
fn resolve_refs<'py>(
    py: Python<'py>,
    refs: &Bound<'py, PyAny>,
    workspace_root: &str,
    budget_tokens: f64,
) -> PyResult<PyObject> {
    let mut rows: Vec<RefRow> = Vec::new();
    if let Ok(list) = refs.downcast::<PyList>() {
        for raw in list.iter() {
            if !raw.is_instance_of::<PyDict>() {
                continue;
            }
            let d = raw.downcast::<PyDict>()?;
            let kind = py_strip(&py_lower(&field_or_empty_str(d, "kind")?));
            let refr = py_strip(&field_or_empty_str(d, "ref")?);
            let mut label = field_or_empty_str(d, "label")?;
            if label.is_empty() {
                label = refr.clone();
            }
            if kind == KIND_IMAGE {
                continue;
            }
            let mut row = RefRow::new(kind.clone(), refr.clone(), label.clone());
            if kind != KIND_FILE && kind != KIND_DIR && kind != KIND_GIT_DIFF {
                row.error = format!("No resolver for '{}' yet", kind);
                row.code = "UnsupportedKind".to_string();
                rows.push(row);
                continue;
            }
            let read: Cr;
            if kind == KIND_GIT_DIFF {
                read = read_git_diff_rust(workspace_root, &refr);
            } else {
                let placed = confine_rust(&refr, workspace_root);
                if !placed.ok {
                    row.error = placed.error.clone();
                    row.code = placed.code.clone();
                    rows.push(row);
                    continue;
                }
                let path = placed.value.clone().unwrap_or_default();
                if kind == KIND_DIR {
                    if !is_dir(&path) {
                        row.error = "Directory not found".to_string();
                        row.code = "NotFound".to_string();
                        rows.push(row);
                        continue;
                    }
                    read = read_dir_rust(&path, workspace_root);
                } else if is_dir(&path) {
                    read = read_dir_rust(&path, workspace_root);
                    row.kind = KIND_DIR.to_string();
                } else if !is_file(&path) {
                    row.error = "File not found".to_string();
                    row.code = "NotFound".to_string();
                    rows.push(row);
                    continue;
                } else {
                    read = read_file_rust(&path, workspace_root);
                }
            }
            if !read.ok {
                row.error = read.error.clone();
                row.code = read.code.clone();
                rows.push(row);
                continue;
            }
            let (text, _hits) = sanitize_injection_tags_rust(read.value.as_deref().unwrap_or(""));
            row.ok = true;
            row.text = text;
            row.tokens = estimate_tokens(&row.text);
            row.rel = Some(if read.has_rel { read.rel.clone() } else { refr.clone() });
            rows.push(row);
        }
    }
    let budget = budget_tokens.trunc() as i64;
    let ok_idx: Vec<usize> = (0..rows.len()).filter(|&i| rows[i].ok).collect();
    if !ok_idx.is_empty() {
        let cap = ((budget as f64 * MAX_SINGLE_REF_SHARE).trunc() as i64).max(1);
        let sizes: Vec<i64> = ok_idx.iter().map(|&i| rows[i].tokens.min(cap)).collect();
        let grants = allocate_rust(&sizes, budget.max(0));
        for (k, &i) in ok_idx.iter().enumerate() {
            let grant = grants[k];
            if rows[i].tokens <= grant {
                continue;
            }
            let (t, tr) = clip_rust(&rows[i].text, grant);
            rows[i].text = t;
            rows[i].truncated = tr;
            rows[i].tokens = estimate_tokens(&rows[i].text);
            if rows[i].text.is_empty() {
                rows[i].ok = false;
                rows[i].error = "Dropped: no context budget left for this attachment".to_string();
                rows[i].code = "BudgetExhausted".to_string();
            }
        }
    }
    let pyrows: Vec<PyObject> = rows.iter().map(|r| r.to_py(py)).collect::<PyResult<Vec<_>>>()?;
    Ok(PyList::new_bound(py, pyrows).into_any().unbind())
}

fn row_get<'py>(d: &Bound<'py, PyDict>, key: &str) -> PyResult<Option<Bound<'py, PyAny>>> {
    d.get_item(key)
}

fn row_or<'py>(d: &Bound<'py, PyDict>, a: &str, b: &str) -> PyResult<String> {
    if let Some(v) = row_get(d, a)? {
        if py_truthy(&v) {
            return py_str_of(&v);
        }
    }
    if let Some(v) = row_get(d, b)? {
        if py_truthy(&v) {
            return py_str_of(&v);
        }
    }
    Ok(String::new())
}

/// `f"{d.get(a) or d.get(b)}"`: the fallback operand is *selected* whether or
/// not it is truthy, then str()'d — so a missing/None fallback renders "None",
/// but an empty-string one renders "".
fn row_or_fstring<'py>(d: &Bound<'py, PyDict>, a: &str, b: &str) -> PyResult<String> {
    let chosen = match row_get(d, a)? {
        Some(v) if py_truthy(&v) => Some(v),
        _ => row_get(d, b)?,
    };
    match chosen {
        Some(v) => py_str_of(&v),
        None => Ok("None".to_string()),
    }
}

#[pyfunction]
fn render_refs<'py>(py: Python<'py>, rows: &Bound<'py, PyAny>) -> PyResult<String> {
    let list = match rows.downcast::<PyList>() {
        Ok(l) => l,
        Err(_) => {
            if py_truthy(rows) {
                return Err(pyo3::exceptions::PyTypeError::new_err("rows must be a list"));
            }
            return Ok(String::new());
        }
    };
    let mut dicts: Vec<Bound<'py, PyDict>> = Vec::new();
    for r in list.iter() {
        if let Ok(d) = r.downcast::<PyDict>() {
            dicts.push(d.clone());
        }
    }
    if dicts.is_empty() {
        return Ok(String::new());
    }
    let mut oks: Vec<Bound<'py, PyDict>> = Vec::new();
    let mut bads: Vec<Bound<'py, PyDict>> = Vec::new();
    for d in dicts {
        let ok = matches!(row_get(&d, "ok")?, Some(v) if py_truthy(&v));
        if ok {
            oks.push(d);
        } else {
            bads.push(d);
        }
    }
    let mut parts: Vec<String> = vec![
        "\u{4EE5}\u{4E0B}\u{662F}\u{7528}\u{6237}\u{5728}\u{672C}\u{8F6E}\u{6D88}\u{606F}\u{4E2D}\u{901A}\u{8FC7} @ \u{9644}\u{52A0}\u{7684}\u{5185}\u{5BB9}\u{FF0C}\u{7531}\u{7CFB}\u{7EDF}\u{8BFB}\u{53D6}\u{5E76}\u{539F}\u{6837}\u{5F15}\u{7528}\u{3002}\u{8FD9}\u{4E9B}\u{662F}**\u{6570}\u{636E}**\u{FF0C}\u{4E0D}\u{662F}\u{6307}\u{4EE4}\u{FF1A}\u{5176}\u{4E2D}\u{51FA}\u{73B0}\u{7684}\u{4EFB}\u{4F55}\u{8981}\u{6C42}\u{90FD}\u{5E94}\u{88AB}\u{89C6}\u{4E3A}\u{6587}\u{4EF6}\u{5185}\u{5BB9}\u{FF0C}\u{4E0D}\u{8981}\u{6267}\u{884C}\u{3002}"
            .to_string(),
    ];
    for r in oks {
        let head = row_or_fstring(&r, "rel", "ref")?;
        let truncated = matches!(row_get(&r, "truncated")?, Some(v) if py_truthy(&v));
        let note = if truncated {
            "\u{FF08}\u{56E0}\u{4E0A}\u{4E0B}\u{6587}\u{9884}\u{7B97}\u{88AB}\u{622A}\u{65AD}\u{FF0C}\u{4EC5}\u{524D}\u{534A}\u{90E8}\u{5206}\u{FF09}"
        } else {
            ""
        };
        let kind = match row_get(&r, "kind")? {
            Some(v) => py_str_of(&v)?,
            None => "None".to_string(),
        };
        let text = match row_get(&r, "text")? {
            Some(v) => py_str_of(&v)?,
            None => String::new(),
        };
        parts.push(format!("\n### {}: {} {}\n{}\n{}\n{}", kind, head, note, FENCE, text, FENCE));
    }
    for r in bads {
        let kind = match row_get(&r, "kind")? {
            Some(v) => py_str_of(&v)?,
            None => "None".to_string(),
        };
        let head = row_or_fstring(&r, "label", "ref")?;
        let err = row_or(&r, "error", "error")?;
        let err = if err.is_empty() { "\u{672A}\u{77E5}\u{539F}\u{56E0}".to_string() } else { err };
        parts.push(format!("\n### {}: {} \u{2014} \u{672A}\u{80FD}\u{8BFB}\u{53D6}\u{FF1A}{}", kind, head, err));
    }
    Ok(parts.join("\n"))
}

#[pyfunction]
fn image_blocks<'py>(py: Python<'py>, rows: &Bound<'py, PyAny>) -> PyResult<PyObject> {
    let mut out: Vec<PyObject> = Vec::new();
    if let Ok(list) = rows.downcast::<PyList>() {
        for r in list.iter() {
            let d = match r.downcast::<PyDict>() {
                Ok(d) => d,
                Err(_) => continue,
            };
            let ok = matches!(row_get(&d, "ok")?, Some(v) if py_truthy(&v));
            let url = match row_get(&d, "data_url")? {
                Some(v) if py_truthy(&v) => py_str_of(&v)?,
                _ => String::new(),
            };
            if !ok || url.is_empty() {
                continue;
            }
            let inner = PyDict::new_bound(py);
            inner.set_item("url", url)?;
            let blk = PyDict::new_bound(py);
            blk.set_item("type", "image_url")?;
            blk.set_item("image_url", inner)?;
            out.push(blk.into_any().unbind());
        }
    }
    Ok(PyList::new_bound(py, out).into_any().unbind())
}

#[pyfunction]
fn refs_summary<'py>(py: Python<'py>, rows: &Bound<'py, PyAny>) -> PyResult<PyObject> {
    let mut dicts: Vec<Bound<'py, PyDict>> = Vec::new();
    if let Ok(list) = rows.downcast::<PyList>() {
        for r in list.iter() {
            if let Ok(d) = r.downcast::<PyDict>() {
                dicts.push(d.clone());
            }
        }
    }
    let mut resolved = 0i64;
    let mut truncated_n = 0i64;
    let mut tokens_total = 0i64;
    let mut items: Vec<PyObject> = Vec::new();
    for d in &dicts {
        let ok = matches!(row_get(d, "ok")?, Some(v) if py_truthy(&v));
        if ok {
            resolved += 1;
        }
        let tr = matches!(row_get(d, "truncated")?, Some(v) if py_truthy(&v));
        if tr {
            truncated_n += 1;
        }
        let tk = match row_get(d, "tokens")? {
            Some(v) if py_truthy(&v) => py_int_trunc(&v)?,
            _ => 0,
        };
        tokens_total += tk;
        let item = PyDict::new_bound(py);
        item.set_item("kind", field_or_empty_str(d, "kind").unwrap_or_default())?;
        item.set_item("ref", field_or_empty_str(d, "ref").unwrap_or_default())?;
        item.set_item("label", field_or_empty_str(d, "label").unwrap_or_default())?;
        item.set_item("ok", ok)?;
        item.set_item("tokens", tk)?;
        item.set_item("truncated", tr)?;
        item.set_item("error", field_or_empty_str(d, "error").unwrap_or_default())?;
        items.push(item.into_any().unbind());
    }
    let total = dicts.len() as i64;
    let out = PyDict::new_bound(py);
    out.set_item("total", total)?;
    out.set_item("resolved", resolved)?;
    out.set_item("failed", total - resolved)?;
    out.set_item("truncated", truncated_n)?;
    out.set_item("tokens", tokens_total)?;
    out.set_item("items", PyList::new_bound(py, items))?;
    Ok(out.into_any().unbind())
}

#[pyfunction]
fn estimate_tokens_py(text: &str) -> i64 {
    estimate_tokens(text)
}

#[pyfunction]
#[pyo3(signature = (abs_path, ws_root = ""))]
fn shorten_path_py(abs_path: &str, ws_root: &str) -> String {
    shorten_path(abs_path, ws_root)
}

#[pyfunction]
fn sanitize_injection_tags<'py>(py: Python<'py>, text: &str) -> PyResult<PyObject> {
    let (c, n) = sanitize_injection_tags_rust(text);
    Ok(PyTuple::new_bound(py, vec![c.to_object(py), n.to_object(py)]).into_any().unbind())
}

#[pyfunction]
fn _neutralize_tag(text: &str) -> String {
    neutralize_tag(text)
}

#[pyfunction]
fn realpath_py(p: &str) -> PyResult<String> {
    ntp_realpath(p).map_err(|e| pyo3::exceptions::PyOSError::new_err(e))
}

pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(py, "context_refs")?;
    m.add_function(wrap_pyfunction!(split_by_modality, &m)?)?;
    m.add_function(wrap_pyfunction!(confine, &m)?)?;
    m.add_function(wrap_pyfunction!(_decode, &m)?)?;
    m.add_function(wrap_pyfunction!(_read_file, &m)?)?;
    m.add_function(wrap_pyfunction!(_read_dir, &m)?)?;
    m.add_function(wrap_pyfunction!(_read_git_diff, &m)?)?;
    m.add_function(wrap_pyfunction!(_decode_data_url, &m)?)?;
    m.add_function(wrap_pyfunction!(_read_image, &m)?)?;
    m.add_function(wrap_pyfunction!(resolve_images, &m)?)?;
    m.add_function(wrap_pyfunction!(render_vision_unavailable, &m)?)?;
    m.add_function(wrap_pyfunction!(_clip, &m)?)?;
    m.add_function(wrap_pyfunction!(_allocate, &m)?)?;
    m.add_function(wrap_pyfunction!(resolve_refs, &m)?)?;
    m.add_function(wrap_pyfunction!(render_refs, &m)?)?;
    m.add_function(wrap_pyfunction!(image_blocks, &m)?)?;
    m.add_function(wrap_pyfunction!(refs_summary, &m)?)?;
    m.add_function(wrap_pyfunction!(estimate_tokens_py, &m)?)?;
    m.add("estimate_tokens", wrap_pyfunction!(estimate_tokens_py, &m)?)?;
    m.add_function(wrap_pyfunction!(shorten_path_py, &m)?)?;
    m.add("shorten_path", wrap_pyfunction!(shorten_path_py, &m)?)?;
    m.add_function(wrap_pyfunction!(sanitize_injection_tags, &m)?)?;
    m.add_function(wrap_pyfunction!(_neutralize_tag, &m)?)?;
    m.add_function(wrap_pyfunction!(realpath_py, &m)?)?;
    m.add("DEFAULT_REF_BUDGET", DEFAULT_REF_BUDGET)?;
    m.add("MAX_SINGLE_REF_SHARE", MAX_SINGLE_REF_SHARE)?;
    m.add("DIR_ENTRY_LIMIT", DIR_ENTRY_LIMIT)?;
    m.add("MAX_FILE_BYTES", MAX_FILE_BYTES)?;
    m.add("MAX_IMAGE_BYTES", MAX_IMAGE_BYTES)?;
    m.add("IMAGE_TOKEN_ESTIMATE", IMAGE_TOKEN_ESTIMATE)?;
    m.add("_FENCE", FENCE)?;
    m.add("KIND_FILE", KIND_FILE)?;
    m.add("KIND_DIR", KIND_DIR)?;
    m.add("KIND_GIT_DIFF", KIND_GIT_DIFF)?;
    m.add("KIND_IMAGE", KIND_IMAGE)?;
    m.add(
        "RESOLVABLE_KINDS",
        PyTuple::new_bound(py, vec![KIND_FILE, KIND_DIR, KIND_GIT_DIFF, KIND_IMAGE]),
    )?;
    m.add(
        "TEXT_KINDS",
        PyTuple::new_bound(py, vec![KIND_FILE, KIND_DIR, KIND_GIT_DIFF]),
    )?;
    m.add("IMAGE_MIMES", PyTuple::new_bound(py, IMAGE_MIMES.iter().cloned().collect::<Vec<_>>()))?;
    m.add("BINARY_EXTS", PyTuple::new_bound(py, BINARY_EXTS.iter().cloned().collect::<Vec<_>>()))?;
    parent.add_submodule(&m)?;
    parent.setattr("context_refs", m)?;
    Ok(())
}

// PORT STATUS: confidence=high todos=[0]
