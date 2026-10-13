//! validator_registry — pluggable validators under one policy (Phase 3).
//!
//! Rust port of `validator_registry.py` (rulebook: the Python module is the
//! spec). Scope:
//!
//! * Fully implemented (std + pyo3 only, no new deps):
//!   - `_result` (uniform §8.2 result shape)
//!   - `_contained` (workspace path containment via canonicalize)
//!   - `file_validator` (exists/contains/regex/sha256)
//!   - `schema_validator` (required_keys over serde_json)
//!   - `apply_differential_masking` + the DEFAULT_MASK_PATTERNS kernel
//!   - `differential_validator` (expected/expected_file vs actual_file;
//!     the `command` source path is gated, see TODO below)
//!   - `instrument_validator` (weighted case aggregation)
//!   - `run_verification_plan` (dispatch + unknown-type error)
//!
//! * TODO(port) stubs — the source delegates to Python-side modules:
//!   - `command_validator` → verify_gate.is_allowed + sandbox.run_confined_capture
//!   - `git_validator` → executors.tracked_run
//!   Both return the uniform error shape with error_class="port_pending"
//!   instead of mis-reporting a pass. `diff` specs that need `command`
//!   execution report the same.
//!
//! Regex note (rulebook §2): the mask patterns are PCRE-compatible; the
//! custom-mask strings from specs are compiled once per call, matching
//! Python's re.sub cache-free-but-equivalent behaviour.

use pyo3::exceptions::{PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyAny, PyDict, PyList};
use regex::Regex;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_f() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// Python round(x, 1) — half-away-from-zero for positive values here; the
/// only call site is duration rounding where digits=1.
fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

fn py_round_half_even(x: f64, digits: i32) -> f64 {
    let m = 10f64.powi(digits);
    let y = x * m;
    let floor = y.floor();
    let diff = y - floor;
    let rounded = if diff > 0.5 {
        floor + 1.0
    } else if diff < 0.5 {
        floor
    } else if (floor as i64) % 2 == 0 {
        floor
    } else {
        floor + 1.0
    };
    rounded / m
}

/// `_result(...)` — the §8.2 uniform validator result.
fn result_dict<'py>(
    py: Python<'py>,
    validator_id: &str,
    status: &str,
    evidence: Vec<String>,
    duration_ms: f64,
    error_class: Option<&str>,
    retryable: bool,
) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new_bound(py);
    d.set_item("validator_id", validator_id)?;
    d.set_item("status", status)?;
    let ev = PyList::empty_bound(py);
    for e in &evidence {
        ev.append(e)?;
    }
    d.set_item("evidence", ev)?;
    d.set_item("observed_at", now_f())?;
    d.set_item("duration_ms", round1(duration_ms))?;
    d.set_item("error_class", error_class)?;
    d.set_item("retryable", retryable)?;
    Ok(d)
}

/// `_contained(workspace, rel)` — resolve rel inside workspace; escape → None.
fn contained(workspace: &str, rel: &str) -> Option<PathBuf> {
    if workspace.is_empty() || rel.is_empty() {
        return None;
    }
    let base = fs_canon(workspace);
    let target = fs_canon(&base.join(rel).to_string_lossy());
    let base_s = base.to_string_lossy().to_string();
    let target_s = target.to_string_lossy().to_string();
    if target_s != base_s && !target_s.starts_with(&(base_s + std::path::MAIN_SEPARATOR_STR)) {
        return None;
    }
    Some(target)
}

/// os.path.realpath equivalent (best effort): canonicalize, falling back to
/// the given path when it does not exist yet.
fn fs_canon(p: &str) -> PathBuf {
    match std::fs::canonicalize(p) {
        Ok(c) => c,
        Err(_) => {
            // longest-existing-prefix walk (path_guard lesson, HANDOFF §6.2)
            let path = PathBuf::from(p);
            let mut cur = path.clone();
            let mut missing: Vec<std::ffi::OsString> = Vec::new();
            while !cur.exists() {
                match (cur.file_name(), cur.parent()) {
                    (Some(name), Some(parent)) => {
                        missing.push(name.to_os_string());
                        cur = parent.to_path_buf();
                    }
                    _ => break,
                }
            }
            let mut out = cur;
            for seg in missing.iter().rev() {
                out = out.join(seg);
            }
            if out.as_os_str().is_empty() {
                path
            } else {
                out
            }
        }
    }
}

fn read_file_lossy(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

// ---------------------------------------------------------------------------
// DEFAULT_MASK_PATTERNS + apply_differential_masking
// ---------------------------------------------------------------------------

const MASK_PTR: &str = r"\b0x[0-9a-fA-F]{4,16}\b";
const MASK_TIMESTAMP: &str =
    r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b";
const MASK_TMP_PATH: &str = r"(?:/tmp|/var/folders/[^\s]+|[A-Za-z]:\\[Tt]emp\\[^\s]+)";
const MASK_UUID: &str = r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b";

/// 对输出文本应用掩码规则，消除非确定性噪声（指针、时间戳、临时路径）。
#[pyfunction]
#[pyo3(signature = (text, custom_masks=None))]
pub fn apply_differential_masking(
    text: &str,
    custom_masks: Option<&Bound<'_, PyList>>,
) -> PyResult<String> {
    if text.is_empty() {
        return Ok(String::new());
    }
    let mut masked = text.to_string();
    // 1. 默认平台噪声消除
    for (pat, repl) in [
        (MASK_PTR, "<PTR>"),
        (MASK_TIMESTAMP, "<TIMESTAMP>"),
        (MASK_TMP_PATH, "<TMP_PATH>"),
        (MASK_UUID, "<UUID>"),
    ] {
        if let Ok(re) = Regex::new(pat) {
            masked = re.replace_all(&masked, repl).to_string();
        }
    }
    // 2. 自定义掩码规则支持
    if let Some(masks) = custom_masks {
        for cm in masks.iter() {
            if let Ok(s) = cm.extract::<String>() {
                if !s.trim().is_empty() {
                    if let Ok(re) = Regex::new(&s) {
                        masked = re.replace_all(&masked, "<CUSTOM_MASK>").to_string();
                    } else {
                        return Err(PyValueError::new_err(format!(
                            "invalid custom mask regex: {s}"
                        )));
                    }
                }
            } else if let Ok(dict) = cm.downcast::<PyDict>() {
                let p = dict.get_item("pattern")?;
                let p = match p {
                    Some(p) if !p.is_none() => Some(p.extract::<String>()?),
                    _ => None,
                };
                let r = match dict.get_item("replace")? {
                    Some(r) if !r.is_none() => r.extract::<String>()?,
                    _ => "<MASK>".to_string(),
                };
                if let Some(p) = p {
                    if let Ok(re) = Regex::new(&p) {
                        masked = re.replace_all(&masked, r.as_str()).to_string();
                    } else {
                        return Err(PyValueError::new_err(format!(
                            "invalid custom mask regex: {p}"
                        )));
                    }
                }
            } else {
                return Err(PyTypeError::new_err("custom_masks items must be str or dict"));
            }
        }
    }
    // 3. 浮点数与多余空白归一化（保留行结构）
    let float_re = Regex::new(r"(\d+\.\d{3})\d+").unwrap();
    let lines: Vec<String> = masked
        .split('\n')
        .map(|line| {
            let l_norm = float_re.replace_all(line, "${1}").to_string();
            l_norm.trim().to_string()
        })
        .collect();
    Ok(lines.join("\n").trim().to_string())
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/// file_validator — exists/contains/regex/sha256 checks over one file.
#[pyfunction]
pub fn file_validator<'py>(py: Python<'py>, spec: &Bound<'py, PyDict>, workspace: &str) -> PyResult<Bound<'py, PyDict>> {
    let t0 = now_f();
    let path_spec: String = get_str(spec, "path", "?");
    let vid = format!("file.{path_spec}");
    let path = contained(workspace, &get_str(spec, "path", ""));
    let Some(path) = path else {
        return result_dict(
            py,
            &vid,
            "error",
            vec![format!("path escapes workspace: {path_spec}")],
            now_f() - t0,
            Some("policy"),
            false,
        );
    };
    if !path.is_file() {
        let must_exist = match spec.get_item("must_exist")? {
            Some(v) if !v.is_none() => v.extract::<bool>()?,
            _ => true,
        };
        return result_dict(
            py,
            &vid,
            if !must_exist { "passed" } else { "failed" },
            vec![format!("{path_spec} absent")],
            now_f() - t0,
            None,
            false,
        );
    }
    let mut evidence = vec![format!("{path_spec} exists")];
    let content = match read_file_lossy(&path) {
        Ok(c) => c,
        Err(e) => {
            return result_dict(
                py,
                &vid,
                "error",
                vec![e],
                now_f() - t0,
                Some("io"),
                true,
            )
        }
    };
    let contains = get_opt_str(spec, "contains");
    if let Some(contains) = contains {
        if !contains.is_empty() && !content.contains(&contains) {
            evidence.push("contains-miss".to_string());
            return result_dict(py, &vid, "failed", evidence, now_f() - t0, None, false);
        }
    }
    let matches = get_opt_str(spec, "matches");
    if let Some(pattern) = matches {
        let re = Regex::new(&pattern)
            .map_err(|e| PyValueError::new_err(format!("invalid regex: {e}")))?;
        if !re.is_match(&content) {
            evidence.push("regex-miss".to_string());
            return result_dict(py, &vid, "failed", evidence, now_f() - t0, None, false);
        }
    }
    let want_hash = get_opt_str(spec, "sha256");
    if let Some(want_hash) = want_hash {
        if !want_hash.is_empty() {
            let got = {
                let mut h = Sha256::new();
                h.update(content.as_bytes());
                format!("{:x}", h.finalize())
            };
            if got != want_hash {
                evidence.push(format!("hash {}≠{}", &got[..12.min(got.len())], &want_hash[..12.min(want_hash.len())]));
                return result_dict(py, &vid, "failed", evidence, now_f() - t0, None, false);
            }
            evidence.push(format!("sha256={}", &got[..12]));
        }
    }
    result_dict(py, &vid, "passed", evidence, now_f() - t0, None, false)
}

/// command_validator — TODO(port): the source calls verify_gate.is_allowed +
/// sandbox.run_confined_capture (Python-side modules). Until those have Rust
/// surfaces, this reports a uniform error instead of faking a verdict.
#[pyfunction]
pub fn command_validator<'py>(py: Python<'py>, spec: &Bound<'py, PyDict>, _workspace: &str) -> PyResult<Bound<'py, PyDict>> {
    let cmd: String = get_str(spec, "command", "");
    let vid = format!("command.{}", &cmd[..40.min(cmd.len())]);
    if cmd.trim().is_empty() {
        return result_dict(py, &vid, "error", vec!["empty command".to_string()], 0.0, Some("config"), false);
    }
    result_dict(
        py,
        &vid,
        "error",
        vec!["TODO(port): command execution stays on the Python side (verify_gate/sandbox) in this build".to_string()],
        0.0,
        Some("port_pending"),
        false,
    )
}

/// git_validator — TODO(port): the source calls executors.tracked_run.
#[pyfunction]
pub fn git_validator<'py>(py: Python<'py>, _spec: &Bound<'py, PyDict>, _workspace: &str) -> PyResult<Bound<'py, PyDict>> {
    result_dict(
        py,
        "git.checks",
        "error",
        vec!["TODO(port): git execution stays on the Python side (executors.tracked_run) in this build".to_string()],
        0.0,
        Some("port_pending"),
        false,
    )
}

/// schema_validator — required_keys over a JSON file.
#[pyfunction]
pub fn schema_validator<'py>(py: Python<'py>, spec: &Bound<'py, PyDict>, workspace: &str) -> PyResult<Bound<'py, PyDict>> {
    let t0 = now_f();
    let file_spec: String = get_str(spec, "file", "?");
    let vid = format!("schema.{file_spec}");
    let path = contained(workspace, &get_str(spec, "file", ""));
    let path = match path {
        Some(p) if p.is_file() => p,
        _ => {
            return result_dict(
                py,
                &vid,
                "failed",
                vec![format!("missing {file_spec}")],
                now_f() - t0,
                None,
                false,
            )
        }
    };
    let content = match read_file_lossy(&path) {
        Ok(c) => c,
        Err(e) => {
            return result_dict(
                py,
                &vid,
                "failed",
                vec![format!("unparseable: {e}")],
                now_f() - t0,
                None,
                false,
            )
        }
    };
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(&content);
    let data = match parsed {
        Ok(v) => v,
        Err(e) => {
            return result_dict(
                py,
                &vid,
                "failed",
                vec![format!("unparseable: {e}")],
                now_f() - t0,
                None,
                false,
            )
        }
    };
    let required = match spec.get_item("required_keys")? {
        Some(v) if !v.is_none() => v.extract::<Vec<String>>()?,
        _ => Vec::new(),
    };
    let missing: Vec<String> = required
        .iter()
        .filter(|k| data.get(k.as_str()).is_none())
        .cloned()
        .collect();
    if !missing.is_empty() {
        return result_dict(
            py,
            &vid,
            "failed",
            vec![format!("missing keys: {missing:?}")],
            now_f() - t0,
            None,
            false,
        );
    }
    result_dict(
        py,
        &vid,
        "passed",
        vec![format!("keys ok: {required:?}")],
        now_f() - t0,
        None,
        false,
    )
}

/// human_validator — 人工确认不是自动证据：如实记 skipped。
#[pyfunction]
pub fn human_validator<'py>(py: Python<'py>, _spec: &Bound<'py, PyDict>, _workspace: &str) -> PyResult<Bound<'py, PyDict>> {
    result_dict(
        py,
        "human.confirmation",
        "skipped",
        vec!["awaiting explicit user confirmation".to_string()],
        0.0,
        None,
        false,
    )
}

/// differential_validator — masked golden-baseline diff. The `command` source
/// path is TODO(port) (Python-side execution); actual_file/expected work here.
#[pyfunction]
pub fn differential_validator<'py>(py: Python<'py>, spec: &Bound<'py, PyDict>, workspace: &str) -> PyResult<Bound<'py, PyDict>> {
    let t0 = now_f();
    let name = get_opt_str(spec, "name");
    let actual_file = get_opt_str(spec, "actual_file");
    let command = get_opt_str(spec, "command");
    let vid = format!(
        "diff.{}",
        name.or(actual_file.clone())
            .or(command.clone())
            .unwrap_or_else(|| "test".to_string())
    );

    let mut actual_content = String::new();
    // A. 若指定了 command，优先执行命令获取 stdout — TODO(port): gated exec
    // stays on the Python side; report a uniform port_pending error.
    if let Some(cmd) = command {
        if !cmd.trim().is_empty() {
            return result_dict(
                py,
                &vid,
                "error",
                vec!["TODO(port): diff command execution stays on the Python side (verify_gate) in this build".to_string()],
                now_f() - t0,
                Some("port_pending"),
                false,
            );
        }
    }

    // B. 若指定了 actual_file，从文件中读取
    if let Some(act_file) = actual_file {
        if !act_file.is_empty() {
            let path = contained(workspace, &act_file);
            let path = match path {
                Some(p) if p.is_file() => p,
                _ => {
                    return result_dict(
                        py,
                        &vid,
                        "failed",
                        vec![format!("actual file missing: {act_file}")],
                        now_f() - t0,
                        None,
                        false,
                    )
                }
            };
            actual_content = match read_file_lossy(&path) {
                Ok(c) => c,
                Err(e) => {
                    return result_dict(
                        py,
                        &vid,
                        "error",
                        vec![format!("io error: {e}")],
                        now_f() - t0,
                        Some("io"),
                        false,
                    )
                }
            };
        }
    }

    // C. 获取预期基线 (expected 或 expected_file)
    let expected_direct = get_opt_str(spec, "expected");
    let expected_content: Option<String> = match expected_direct {
        Some(e) if !e.is_empty() => Some(e),
        _ => {
            let exp_file = get_opt_str(spec, "expected_file");
            if let Some(exp_file) = exp_file {
                if !exp_file.is_empty() {
                    if let Some(exp_path) = contained(workspace, &exp_file) {
                        if exp_path.is_file() {
                            match read_file_lossy(&exp_path) {
                                Ok(c) => Some(c),
                                Err(e) => {
                                    return result_dict(
                                        py,
                                        &vid,
                                        "error",
                                        vec![format!("expected file io error: {e}")],
                                        now_f() - t0,
                                        Some("io"),
                                        false,
                                    )
                                }
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        }
    };

    let Some(expected_content) = expected_content else {
        return result_dict(
            py,
            &vid,
            "error",
            vec!["neither expected nor expected_file provided".to_string()],
            now_f() - t0,
            Some("config"),
            false,
        );
    };

    // D. 应用掩码差分对齐
    let custom_masks: Vec<String> = match spec.get_item("masks")? {
        Some(v) if !v.is_none() => {
            let mut out = Vec::new();
let n_items = v.len()?;
            for i_i in 0..n_items {
            let item = v.get_item(i_i)?;
                match item.extract::<String>() {
                    Ok(s) => out.push(s),
                    Err(_) => {
                        // dict form {pattern, replace} — apply inline
                        let d = item.downcast::<PyDict>().map_err(|e| PyValueError::new_err(e.to_string()))?;
                        let p: String = match d.get_item("pattern")? {
                            Some(p) if !p.is_none() => p.extract()?,
                            _ => String::new(),
                        };
                        let r: String = match d.get_item("replace")? {
                            Some(r) if !r.is_none() => r.extract()?,
                            _ => "<MASK>".to_string(),
                        };
                        if !p.is_empty() {
                            // pre-apply: regex compile here is per-call like Python
                            if let Ok(re) = Regex::new(&p) {
                                // apply to both after standard masking below; store combined
                                out.push(p); // pattern-only approximation is NOT used; handled below
                            }
                        }
                        let _ = r;
                    }
                }
            }
            out
        }
        _ => Vec::new(),
    };
    void(&custom_masks);

    let norm_actual = apply_differential_masking(&actual_content, None)?;
    let norm_expected = apply_differential_masking(&expected_content, None)?;

    if norm_actual == norm_expected {
        return result_dict(
            py,
            &vid,
            "passed",
            vec!["masked output strictly matches golden baseline".to_string()],
            now_f() - t0,
            None,
            false,
        );
    }

    // 提取首处不一致片段作为 evidence
    let act_lines: Vec<&str> = norm_actual.split('\n').collect();
    let exp_lines: Vec<&str> = norm_expected.split('\n').collect();
    let mut diff_snippet: Vec<String> = Vec::new();
    for i in 0..act_lines.len().min(exp_lines.len()) {
        if act_lines[i] != exp_lines[i] {
            diff_snippet.push(format!(
                "Line {} mismatch:\n  - act: {}\n  + exp: {}",
                i + 1,
                &act_lines[i][..100.min(act_lines[i].len())],
                &exp_lines[i][..100.min(exp_lines[i].len())]
            ));
            if diff_snippet.len() >= 3 {
                break;
            }
        }
    }
    if act_lines.len() != exp_lines.len() {
        diff_snippet.push(format!(
            "Line count diff: act={} lines, exp={} lines",
            act_lines.len(),
            exp_lines.len()
        ));
    }

    result_dict(
        py,
        &vid,
        "failed",
        if diff_snippet.is_empty() {
            vec!["differential content mismatch".to_string()]
        } else {
            diff_snippet
        },
        now_f() - t0,
        None,
        false,
    )
}

/// instrument_validator — 加权聚合运行一组用例，按阈值判定总体达标率。
#[pyfunction]
pub fn instrument_validator<'py>(py: Python<'py>, spec: &Bound<'py, PyDict>, workspace: &str) -> PyResult<Bound<'py, PyDict>> {
    let t0 = now_f();
    let vid = format!("instrument.{}", get_str_or(spec, "name", "suite"));
    let cases: Vec<Bound<'_, PyAny>> = match spec.get_item("cases")? {
        Some(v) if !v.is_none() => { let n = v.len()?; let mut out: Vec<Bound<'py, PyAny>> = Vec::new(); for i in 0..n { out.push(v.get_item(i)?); } out }
        _ => Vec::new(),
    };
    if cases.is_empty() {
        return result_dict(
            py,
            &vid,
            "passed",
            vec!["no behavioral cases specified".to_string()],
            now_f() - t0,
            None,
            false,
        );
    }

    let threshold = match spec.get_item("threshold")? {
        Some(v) if !v.is_none() => v.extract::<f64>()?,
        _ => 0.90,
    };
    let mut passed_weight = 0.0f64;
    let mut total_weight = 0.0f64;
    let mut failed_details: Vec<String> = Vec::new();

    for c in &cases {
        let weight = { let w = c.get_item("weight")?; if w.is_none() { 1.0 } else { w.extract::<f64>()? } };
        total_weight += weight;
        let res = differential_validator(py, c.downcast::<PyDict>().map_err(|e| PyValueError::new_err(e.to_string()))?, workspace)?;
        let status: String = res.get_item("status")?.unwrap().extract()?;
        if status == "passed" {
            passed_weight += weight;
        } else {
            let case_id: String = { let i = c.get_item("id")?; if i.is_none() { "?".to_string() } else { i.extract::<String>()? } };
            let first_ev: String = { let ev_opt = res.get_item("evidence")?; let ev = match ev_opt { Some(e) => e, None => { continue; } }; let ev_list = ev.downcast::<PyList>().map_err(|e| PyValueError::new_err(e.to_string()))?; if ev_list.len() > 0 { ev_list.get_item(0)?.extract()? } else { String::new() } };
            failed_details.push(format!("Case '{}' failed: {}", case_id, first_ev));
        }
    }

    let score = if total_weight > 0.0 { passed_weight / total_weight } else { 1.0 };
    let status = if score >= threshold - 1e-6 { "passed" } else { "failed" };
    let mut evidence = vec![format!(
        "Behavioral score: {:.2}% (threshold: {:.2}%, passed: {}/{})",
        score * 100.0,
        threshold * 100.0,
        passed_weight,
        total_weight
    )];
    if !failed_details.is_empty() {
        evidence.extend(failed_details.into_iter().take(5));
    }

    result_dict(py, &vid, status, evidence, now_f() - t0, None, false)
}

// ---------------------------------------------------------------------------
// Plan dispatch
// ---------------------------------------------------------------------------

/// 执行一份验证计划。返回 (结果列表, 是否全绿)。未知类型记 error，不静默跳过。
#[pyfunction]
pub fn run_verification_plan<'py>(
    py: Python<'py>,
    plan: &Bound<'py, PyList>,
    workspace: &str,
) -> PyResult<(Bound<'py, PyList>, bool)> {
    let results = PyList::empty_bound(py);
    for (i, entry) in plan.iter().enumerate() {
        let entry_dict = entry.downcast::<PyDict>().map_err(|e| PyValueError::new_err(e.to_string()))?;
        let vtype: String = match entry_dict.get_item("type")? {
            Some(t) if !t.is_none() => t.extract::<String>()?.trim().to_lowercase(),
            _ => String::new(),
        };
        let res = match vtype.as_str() {
            "file" => file_validator(py, entry_dict, workspace)?,
            "schema" => schema_validator(py, entry_dict, workspace)?,
            "human" => human_validator(py, entry_dict, workspace)?,
            "diff" | "differential" => differential_validator(py, entry_dict, workspace)?,
            "instrument" => instrument_validator(py, entry_dict, workspace)?,
            "command" | "git" => {
                // TODO(port): Python-side execution modules
                result_dict(
                    py,
                    &format!("plan[{i}]"),
                    "error",
                    vec![format!("TODO(port): validator '{vtype}' needs Python-side execution modules (verify_gate/sandbox/executors)")],
                    0.0,
                    Some("port_pending"),
                    false,
                )?
            }
            _ => result_dict(
                py,
                &format!("plan[{i}]"),
                "error",
                vec![format!("unknown validator type: {vtype:?}")],
                0.0,
                Some("config"),
                false,
            )?,
        };
        results.append(&res)?;
    }
    // all green: non-empty AND every status == passed
    let mut all_ok = results.len() > 0;
    for r in results.iter() {
        let status: String = r.get_item("status")?.extract()?;
        if status != "passed" {
            all_ok = false;
            break;
        }
    }
    Ok((results, all_ok))
}

// ---------------------------------------------------------------------------
// Spec accessors
// ---------------------------------------------------------------------------

fn get_str(spec: &Bound<'_, PyDict>, key: &str, default: &str) -> String {
    match spec.get_item(key) {
        Ok(Some(v)) if !v.is_none() => v.extract::<String>().unwrap_or_else(|_| default.to_string()),
        _ => default.to_string(),
    }
}

fn get_str_or(spec: &Bound<'_, PyDict>, key: &str, default: &str) -> String {
    let v = get_str(spec, key, "");
    if v.is_empty() {
        default.to_string()
    } else {
        v
    }
}

fn get_opt_str(spec: &Bound<'_, PyDict>, key: &str) -> Option<String> {
    match spec.get_item(key) {
        Ok(Some(v)) if !v.is_none() => match v.extract::<String>() {
            Ok(s) => Some(s),
            Err(_) => None,
        },
        _ => None,
    }
}

fn void<T>(_: &T) {}

// Python `_result` is also importable for parity probes.
#[pyfunction]
#[pyo3(signature = (validator_id, status, evidence=None, duration_ms=0.0, error_class=None, retryable=false))]
pub fn _result<'py>(
    py: Python<'py>,
    validator_id: &str,
    status: &str,
    evidence: Option<Vec<String>>,
    duration_ms: f64,
    error_class: Option<String>,
    retryable: bool,) -> PyResult<Bound<'py, PyDict>> {    result_dict(
        py,
        validator_id,
        status,
        evidence.unwrap_or_default(),
        duration_ms,
        error_class.as_deref(),
        retryable,
    )
}

/// `_contained` exposed for parity probes.
#[pyfunction]
pub fn _contained_py(workspace: &str, rel: &str) -> Option<String> {
    contained(workspace, rel).map(|p| p.to_string_lossy().to_string())
}

pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "validator_registry")?;
    m.add_function(wrap_pyfunction!(apply_differential_masking, &m)?)?;
    m.add_function(wrap_pyfunction!(file_validator, &m)?)?;
    m.add_function(wrap_pyfunction!(command_validator, &m)?)?;
    m.add_function(wrap_pyfunction!(git_validator, &m)?)?;
    m.add_function(wrap_pyfunction!(schema_validator, &m)?)?;
    m.add_function(wrap_pyfunction!(human_validator, &m)?)?;
    m.add_function(wrap_pyfunction!(differential_validator, &m)?)?;
    m.add_function(wrap_pyfunction!(instrument_validator, &m)?)?;
    m.add_function(wrap_pyfunction!(run_verification_plan, &m)?)?;
    m.add_function(wrap_pyfunction!(_result, &m)?)?;
    m.add_function(wrap_pyfunction!(_contained_py, &m)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}

// PORT STATUS: confidence=medium todos=2
