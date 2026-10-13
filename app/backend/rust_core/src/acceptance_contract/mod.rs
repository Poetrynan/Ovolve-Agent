//! acceptance_contract.rs — Versioned goal acceptance contract (Phase 3).
//!
//! Rust implementation of `acceptance_contract.py`. Pure functions
//! (`normalize_contract`, `check_anti_weakening`) are fully ported.

use pyo3::prelude::*;
use std::collections::{HashMap, HashSet};

const _CONTRACT_VERSION: i64 = 1;

/// Normalize any input into a valid contract (Python `normalize_contract`).
#[pyfunction]
#[pyo3(signature = (raw=None, goal_id=""))]
pub fn normalize_contract(raw: Option<Bound<'_, pyo3::types::PyDict>>, goal_id: Option<&str>) -> PyResult<HashMap<String, PyObject>> {
    Python::with_gil(|py| {
        let mut result: HashMap<String, PyObject> = HashMap::new();
        result.insert("goal_id".to_string(), goal_id.unwrap_or("").to_string().into_py(py));

        let raw_dict = match raw {
            Some(d) => d,
            None => pyo3::types::PyDict::new_bound(py),
        };

        let version: i64 = raw_dict.get_item("version").ok()
            .flatten()
            .and_then(|v| v.extract::<i64>().ok())
            .unwrap_or(_CONTRACT_VERSION);
        result.insert("version".to_string(), version.into_py(py));

        let summary: String = raw_dict.get_item("summary").ok()
            .flatten()
            .and_then(|v| v.extract::<String>().ok())
            .unwrap_or_default();
        result.insert("summary".to_string(), summary.into_py(py));

        for key in &["assumptions", "deliverables", "acceptance_criteria", "required_artifacts", "allowed_paths", "forbidden_paths", "out_of_scope"] {
            let items: Vec<String> = raw_dict.get_item(key).ok()
                .flatten()
                .and_then(|v| v.extract::<Vec<String>>().ok())
                .unwrap_or_default();
            result.insert(key.to_string(), items.into_py(py));
        }

        // verification_plan (list of dicts).
        let plan: Vec<HashMap<String, PyObject>> = raw_dict.get_item("verification_plan").ok()
            .flatten()
            .and_then(|v| {
                let list: Result<Vec<Bound<'_, pyo3::types::PyDict>>, _> = v.extract();
                list.ok().map(|items| {
                    items.into_iter().map(|d| {
                        let mut m = HashMap::new();
                        for (k, v) in d.iter() {
                            if let Ok(key_str) = k.extract::<String>() {
                                m.insert(key_str, v.into_py(py));
                            }
                        }
                        m
                    }).collect()
                })
            })
            .unwrap_or_default();
        result.insert("verification_plan".to_string(), plan.into_py(py));

        // Budget with defaults.
        let mut budget: HashMap<String, i64> = HashMap::new();
        let defaults: &[(&str, i64)] = &[
            ("max_iterations", 10), ("max_tokens", 0), ("max_cost", 0),
            ("max_wall_time_seconds", 0), ("max_repair_attempts", 2),
        ];
        for (k, default) in defaults {
            budget.insert(k.to_string(), *default);
        }
        if let Ok(Some(budget_in)) = raw_dict.get_item("budget") {
            if let Ok(b) = budget_in.extract::<Bound<'_, pyo3::types::PyDict>>() {
                for (k, _default) in defaults {
                    if let Ok(Some(v)) = b.get_item(k) {
                        if let Ok(val) = v.extract::<i64>() {
                            budget.insert(k.to_string(), val);
                        }
                    }
                }
            }
        }
        result.insert("budget".to_string(), budget.into_py(py));

        let instrument_required: bool = raw_dict.get_item("instrument_required").ok()
            .flatten()
            .and_then(|v| v.extract::<bool>().ok())
            .unwrap_or(false);
        result.insert("instrument_required".to_string(), instrument_required.into_py(py));

        let behavioral_instrument: HashMap<String, PyObject> = raw_dict.get_item("behavioral_instrument").ok()
            .flatten()
            .and_then(|v| {
                if let Ok(d) = v.extract::<Bound<'_, pyo3::types::PyDict>>() {
                    let mut m = HashMap::new();
                    for (k, val) in d.iter() {
                        if let Ok(key_str) = k.extract::<String>() {
                            m.insert(key_str, val.into_py(py));
                        }
                    }
                    Some(m)
                } else {
                    None
                }
            })
            .unwrap_or_default();
        result.insert("behavioral_instrument".to_string(), behavioral_instrument.into_py(py));

        let human_acceptance_required: bool = raw_dict.get_item("human_acceptance_required").ok()
            .flatten()
            .and_then(|v| v.extract::<bool>().ok())
            .unwrap_or(false);
        result.insert("human_acceptance_required".to_string(), human_acceptance_required.into_py(py));

        let human_accepted: bool = raw_dict.get_item("human_accepted").ok()
            .flatten()
            .and_then(|v| v.extract::<bool>().ok())
            .unwrap_or(false);
        result.insert("human_accepted".to_string(), human_accepted.into_py(py));

        result.insert("human_accepted_at".to_string(),
            raw_dict.get_item("human_accepted_at").ok().flatten().map(|v| v.into_py(py)).into_py(py));
        result.insert("human_accepted_by".to_string(),
            raw_dict.get_item("human_accepted_by").ok().flatten().map(|v| v.into_py(py)).into_py(py));

        Ok(result)
    })
}

/// Anti-weakening gate (Python `check_anti_weakening`).
#[pyfunction]
#[pyo3(signature = (old_contract=None, new_contract=None))]
pub fn check_anti_weakening(
    old_contract: Option<Bound<'_, pyo3::types::PyDict>>,
    new_contract: Option<Bound<'_, pyo3::types::PyDict>>,
) -> (bool, String) {
    let (Some(old), Some(new)) = (old_contract, new_contract) else {
        return (true, String::new());
    };

    // Check acceptance_criteria.
    let old_criteria: HashSet<String> = old.get_item("acceptance_criteria").ok()
        .flatten()
        .and_then(|v| v.extract::<Vec<String>>().ok())
        .unwrap_or_default()
        .into_iter()
        .collect();
    let new_criteria: Vec<String> = new.get_item("acceptance_criteria").ok()
        .flatten()
        .and_then(|v| v.extract::<Vec<String>>().ok())
        .unwrap_or_default();
    let new_criteria_set: HashSet<String> = new_criteria.into_iter().collect();
    let dropped_crit: Vec<_> = old_criteria.difference(&new_criteria_set).collect();
    if !dropped_crit.is_empty() {
        let items: Vec<String> = dropped_crit.into_iter().take(3).cloned().collect();
        return (false, format!("禁止弱化合同：中途丢弃了既有验收标准: {:?}", items));
    }

    // Check required_artifacts.
    let old_artifacts: HashSet<String> = old.get_item("required_artifacts").ok()
        .flatten()
        .and_then(|v| v.extract::<Vec<String>>().ok())
        .unwrap_or_default()
        .into_iter()
        .collect();
    let new_artifacts: Vec<String> = new.get_item("required_artifacts").ok()
        .flatten()
        .and_then(|v| v.extract::<Vec<String>>().ok())
        .unwrap_or_default();
    let new_artifacts_set: HashSet<String> = new_artifacts.into_iter().collect();
    let dropped_art: Vec<_> = old_artifacts.difference(&new_artifacts_set).collect();
    if !dropped_art.is_empty() {
        let items: Vec<String> = dropped_art.into_iter().take(3).cloned().collect();
        return (false, format!("禁止弱化合同：中途丢弃了既必交付产物: {:?}", items));
    }

    // Check verification_plan count.
    let old_plan_len = old.get_item("verification_plan").ok()
        .flatten()
        .and_then(|v| v.extract::<Vec<PyObject>>().ok())
        .unwrap_or_default()
        .len();
    let new_plan_len = new.get_item("verification_plan").ok()
        .flatten()
        .and_then(|v| v.extract::<Vec<PyObject>>().ok())
        .unwrap_or_default()
        .len();
    if new_plan_len < old_plan_len {
        return (false, format!("禁止弱化合同：验证计划项减少 ({} -> {})", old_plan_len, new_plan_len));
    }

    (true, String::new())
}

/// Register the acceptance_contract submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "acceptance_contract")?;
    m.add_function(wrap_pyfunction!(normalize_contract, &m)?)?;
    m.add_function(wrap_pyfunction!(check_anti_weakening, &m)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}
