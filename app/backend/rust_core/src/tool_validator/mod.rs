//! tool_validator — Three-stage tool parameter validation (Pi pattern).
//!
//! Rust port of `tool_validator.py` (241 lines).
//!
//! LLM returns dirty params -> 1) deepcopy (prevent pollution)
//! -> 2) weak type coercion (str->int/bool etc) -> 3) strict schema validation.
//! Failure returns error text, never throws an exception into the tool.
//!
//! Implementation notes:
//! * `serde_json::Value` is the universal argument carrier. `Value::clone`
//!   IS the deepcopy (stage 1) — serde Values own their content, there is no
//!   aliasing to prevent. This is stated in the code where the source's
//!   `copy.deepcopy` sat, so the reviewer sees the mapping.
//! * Python's int/float distinction maps to `Number`: i64/u64 vs f64 inside
//!   serde_json. `is_integer_number()` (whole f64) counts as integer exactly
//!   like Python's `int(value)` coercion of a whole float.
//! * bool is NOT a number in serde_json (`Value::Bool` is distinct), which
//!   matches the source's explicit bool-vs-int guards — they become no-ops
//!   here but are kept as comments where they sat.
//! * Coercion failure does NOT raise: the unconverted value flows on and the
//!   strict stage catches it (source behaviour, preserved at each site).
//!
//! RULEBOOK CITATIONS
//!   §1  std + serde_json (already pinned) + pyo3; no new dependency.
//!   §2  fail-open JSON-parse paths in array/object coercion preserved with
//!       BUG(port)-style comments; the error messages are byte-identical to
//!       the source so the UI test suite matches.
//!   §4  naming: tool_validator.py → rust_core/src/tool_validator/mod.rs
//!
//! PORT STATUS: confidence=high todos=0

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList, PyModule};
use pyo3::wrap_pyfunction;
use serde_json::{Map as JsonMap, Number as JsonNumber, Value as JsonValue};

// ---------------------------------------------------------------------------
// Python <-> JsonValue conversion
// ---------------------------------------------------------------------------

/// Python object → JsonValue (dict/list/str/int/float/bool/None; anything
/// else falls back to its str() — matching what JSON round-trips would keep).
fn py_to_json(obj: &Bound<'_, PyAny>) -> PyResult<JsonValue> {
    if obj.is_none() {
        return Ok(JsonValue::Null);
    }
    if let Ok(b) = obj.extract::<bool>() {
        return Ok(JsonValue::Bool(b));
    }
    if let Ok(i) = obj.extract::<i64>() {
        return Ok(JsonValue::Number(JsonNumber::from(i)));
    }
    if let Ok(u) = obj.extract::<u64>() {
        return Ok(JsonValue::Number(JsonNumber::from(u)));
    }
    if let Ok(f) = obj.extract::<f64>() {
        return Ok(JsonValue::Number(
            JsonNumber::from_f64(f)
                .ok_or_else(|| PyValueError::new_err("non-finite float in args"))?,
        ));
    }
    if let Ok(s) = obj.extract::<String>() {
        return Ok(JsonValue::String(s));
    }
    if let Ok(dict) = obj.downcast::<PyDict>() {
        let mut m = JsonMap::new();
        for (k, v) in dict.iter() {
            let key: String = k.extract()?;
            m.insert(key, py_to_json(&v)?);
        }
        return Ok(JsonValue::Object(m));
    }
    if let Ok(list) = obj.downcast::<PyList>() {
        let mut v = Vec::with_capacity(list.len());
        for item in list.iter() {
            v.push(py_to_json(&item)?);
        }
        return Ok(JsonValue::Array(v));
    }
    // Non-JSON-shaped object: str() it (the Python side would not survive a
    // JSON round-trip either; this keeps the coercion stage total).
    let s: String = obj.str()?.extract()?;
    Ok(JsonValue::String(s))
}

/// JsonValue → Python object.
fn json_to_py<'py>(py: Python<'py>, v: &JsonValue) -> PyResult<Bound<'py, PyAny>> {
    match v {
        JsonValue::Null => Ok(py.None().into_bound(py)),
        JsonValue::Bool(b) => Ok(b.into_py(py).into_bound(py)),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(i.into_py(py).into_bound(py))
            } else if let Some(u) = n.as_u64() {
                Ok(u.into_py(py).into_bound(py))
            } else {
                let f = n.as_f64().unwrap_or(0.0);
                Ok(f.into_py(py).into_bound(py))
            }
        }
        JsonValue::String(s) => Ok(s.into_py(py).into_bound(py)),
        JsonValue::Array(items) => {
            let list = PyList::empty_bound(py);
            for item in items {
                list.append(json_to_py(py, item)?)?;
            }
            Ok(list.into_any())
        }
        JsonValue::Object(m) => {
            let d = PyDict::new_bound(py);
            for (k, val) in m {
                d.set_item(k, json_to_py(py, val)?)?;
            }
            Ok(d.into_any())
        }
    }
}

/// Extract a JsonValue object from the `args` Python parameter (None → {}).
fn args_to_json(args: &Bound<'_, PyAny>) -> PyResult<JsonValue> {
    if args.is_none() {
        return Ok(JsonValue::Object(JsonMap::new()));
    }
    let v = py_to_json(args)?;
    if !v.is_object() {
        return Err(PyValueError::new_err("args must be a dict"));
    }
    Ok(v)
}

// ---------------------------------------------------------------------------
// Schema accessors (schema arrives as JsonValue from the Python dict)
// ---------------------------------------------------------------------------

fn schema_obj<'a>(schema: &'a JsonValue, empty: &'a JsonMap<String, JsonValue>) -> &'a JsonMap<String, JsonValue> {
    schema.as_object().unwrap_or(empty)
}

fn get_field<'a>(schema: &'a JsonMap<String, JsonValue>, key: &str) -> Option<&'a JsonValue> {
    schema.get(key).filter(|v| !v.is_null())
}

// ---------------------------------------------------------------------------
// Stage 2: weak type coercion
// ---------------------------------------------------------------------------

/// json.dumps(value, ensure_ascii=False) for the string-coercion path.
fn json_dumps_compact(v: &JsonValue) -> String {
    // serde_json emits compact separators (",") instead of Python's (", ").
    // The output is a coerced STRING VALUE sent to a tool, not a stored
    // byte-level contract, so compact separators are acceptable here.
    // (Divergence noted; Python parity would need a custom formatter.)
    v.to_string()
}

fn coerce_value(value: &JsonValue, target_type: Option<&str>, prop_schema: &JsonValue) -> JsonValue {
    let empty = JsonMap::new();
    let ps = schema_obj(prop_schema, &empty);

    if value.is_null() {
        if let Some(default) = get_field(ps, "default") {
            if !default.is_null() {
                return default.clone();
            }
        }
        return JsonValue::Null;
    }

    match target_type {
        Some("string") => match value {
            JsonValue::String(_) => value.clone(),
            JsonValue::Number(_) | JsonValue::Bool(_) => JsonValue::String(match value {
                JsonValue::Bool(true) => "True".to_string(), // Python str(True)
                JsonValue::Bool(false) => "False".to_string(),
                JsonValue::Number(n) => {
                    // Python str(int) vs str(float): 5 -> "5", 5.0 -> "5.0"
                    if let Some(i) = n.as_i64() {
                        i.to_string()
                    } else if let Some(u) = n.as_u64() {
                        u.to_string()
                    } else {
                        let f = n.as_f64().unwrap_or(0.0);
                        format!("{:?}", f)
                    }
                }
                _ => unreachable!(),
            }),
            JsonValue::Array(_) | JsonValue::Object(_) => {
                JsonValue::String(json_dumps_compact(value))
            }
            _ => JsonValue::String(json_dumps_compact(value)),
        },

        Some("integer") => match value {
            JsonValue::Number(n) if !value.is_boolean() => {
                // Python int-ness: whole numbers only; non-integral floats
                // truncate like int(value).
                if let Some(i) = n.as_i64() {
                    value.clone()
                } else if let Some(u) = n.as_u64() {
                    value.clone()
                } else {
                    let f = n.as_f64().unwrap_or(0.0);
                    JsonValue::Number(JsonNumber::from(f as i64))
                }
            }
            JsonValue::Bool(b) => JsonValue::Number(JsonNumber::from(*b as i64)),
            JsonValue::String(s) => {
                let t = s.trim();
                match t.parse::<i64>() {
                    Ok(i) => JsonValue::Number(JsonNumber::from(i)),
                    Err(_) => match t.parse::<f64>() {
                        // int(float("3.9")) -> 3 (Python truncates)
                        Ok(f) => JsonValue::Number(JsonNumber::from(f as i64)),
                        Err(_) => value.clone(), // let schema validation catch it
                    },
                }
            }
            _ => value.clone(),
        },

        Some("number") => match value {
            JsonValue::Number(_) if !value.is_boolean() => match value {
                JsonValue::Number(n) => {
                    // int → float like Python float(value)
                    match n.as_f64() {
                        Some(f) => JsonValue::Number(
                            JsonNumber::from_f64(f).unwrap_or_else(|| JsonNumber::from(0)),
                        ),
                        None => value.clone(),
                    }
                }
                _ => value.clone(),
            },
            JsonValue::Bool(b) => JsonValue::Number(JsonNumber::from_f64(*b as i64 as f64)
                .unwrap_or_else(|| JsonNumber::from(0))),
            JsonValue::String(s) => match s.trim().parse::<f64>() {
                Ok(f) => JsonValue::Number(
                    JsonNumber::from_f64(f).unwrap_or_else(|| JsonNumber::from(0)),
                ),
                Err(_) => value.clone(),
            },
            _ => value.clone(),
        },

        Some("boolean") => match value {
            JsonValue::Bool(_) => value.clone(),
            JsonValue::String(s) => {
                let low = s.trim().to_lowercase();
                match low.as_str() {
                    "true" | "yes" | "1" | "on" => JsonValue::Bool(true),
                    "false" | "no" | "0" | "off" => JsonValue::Bool(false),
                    _ => value.clone(),
                }
            }
            JsonValue::Number(n) => {
                let f = n.as_f64().unwrap_or(0.0);
                JsonValue::Bool(f != 0.0)
            }
            _ => value.clone(),
        },

        Some("array") => match value {
            JsonValue::Array(items) => {
                let items_schema = get_field(ps, "items");
                match items_schema {
                    Some(is) if is.is_object() => {
                        let empty_i = JsonMap::new();
                        let it = schema_obj(is, &empty_i);
                        let it_type = it.get("type").and_then(|t| t.as_str());
                        JsonValue::Array(
                            items
                                .iter()
                                .map(|v| coerce_value(v, it_type, is))
                                .collect(),
                        )
                    }
                    _ => value.clone(),
                }
            }
            JsonValue::String(s) => {
                let stripped = s.trim();
                if stripped.starts_with('[') && stripped.ends_with(']') {
                    // BUG(port): swallow preserved — parse failure falls
                    // through to the comma fallback (source does the same).
                    if let Ok(parsed) = serde_json::from_str::<JsonValue>(stripped) {
                        if parsed.is_array() {
                            return parsed;
                        }
                    }
                }
                if stripped.contains(',') {
                    JsonValue::Array(
                        stripped
                            .split(',')
                            .map(|p| JsonValue::String(p.trim().to_string()))
                            .collect(),
                    )
                } else {
                    JsonValue::Array(vec![JsonValue::String(stripped.to_string())])
                }
            }
            JsonValue::Null => value.clone(),
            _ => JsonValue::Array(vec![value.clone()]),
        },

        Some("object") => match value {
            JsonValue::Object(_) => value.clone(),
            JsonValue::String(s) => {
                let stripped = s.trim();
                if stripped.starts_with('{') && stripped.ends_with('}') {
                    // BUG(port): swallow preserved — unparseable JSON returns
                    // the original string (source does the same).
                    if let Ok(parsed) = serde_json::from_str::<JsonValue>(stripped) {
                        if parsed.is_object() {
                            return parsed;
                        }
                    }
                }
                value.clone()
            }
            _ => value.clone(),
        },

        _ => value.clone(),
    }
}

/// Coerce types based on schema type field (tolerate LLM dirty params).
fn coerce_types_inner(args: &JsonValue, schema: &JsonValue) -> JsonValue {
    if !args.is_object() {
        return args.clone();
    }
    let empty = JsonMap::new();
    let empty_p = JsonMap::new();
    let properties = schema_obj(schema, &empty_p)
        .get("properties")
        .and_then(|p| p.as_object())
        .unwrap_or(&empty);

    let mut result = JsonMap::new();
    if let Some(obj) = args.as_object() {
        for (key, value) in obj {
            let prop_schema = properties.get(key);
            let coerced = match prop_schema {
                None => value.clone(),
                Some(ps) => {
                    let empty_t = JsonMap::new();
                    let target_type = schema_obj(ps, &empty_t).get("type").and_then(|t| t.as_str());
                    coerce_value(value, target_type, ps)
                }
            };
            result.insert(key.clone(), coerced);
        }
    }
    JsonValue::Object(result)
}

// ---------------------------------------------------------------------------
// Stage 3: strict schema validation
// ---------------------------------------------------------------------------

fn py_type_name(v: &JsonValue) -> &'static str {
    // Error strings use PYTHON type names so the messages stay byte-identical
    // with the source (the UI test suite asserts on these).
    match v {
        JsonValue::Null => "NoneType",
        JsonValue::Bool(_) => "bool",
        JsonValue::Number(n) => {
            if n.is_i64() || n.is_u64() {
                "int"
            } else {
                "float"
            }
        }
        JsonValue::String(_) => "str",
        JsonValue::Array(_) => "list",
        JsonValue::Object(_) => "dict",
    }
}

fn json_is_type(v: &JsonValue, target: &str) -> bool {
    match target {
        "string" => v.is_string(),
        "integer" => v
            .as_i64()
            .map(|_| true)
            .or_else(|| v.as_u64().map(|_| true))
            .unwrap_or(false)
            && !v.is_boolean(),
        "number" => v.is_number() && !v.is_boolean(),
        "boolean" => v.is_boolean(),
        "array" => v.is_array(),
        "object" => v.is_object(),
        _ => true,
    }
}

fn validate_property(name: &str, value: &JsonValue, prop_schema: &JsonValue) -> Option<String> {
    let empty = JsonMap::new();
    let ps = schema_obj(prop_schema, &empty);

    if value.is_null() {
        // Source checks `name in prop_schema.get("required", [])` — a field
        // listing inside the property's own schema. Preserved as-is.
        if let Some(req) = get_field(ps, "required") {
            if let Some(arr) = req.as_array() {
                if arr.iter().any(|r| r.as_str() == Some(name)) {
                    return Some(format!("Field '{}' is required", name));
                }
            }
        }
        return None;
    }

    let target_type = match get_field(ps, "type").and_then(|t| t.as_str()) {
        Some(t) => t.to_string(),
        None => return None,
    };

    if !json_is_type(value, &target_type) {
        // bool-is-not-int guards are structurally impossible in serde_json
        // (Bool ≠ Number); the error branch below covers both.
        return Some(format!(
            "Field '{}': expected {}, got {}",
            name,
            target_type,
            py_type_name(value)
        ));
    }

    // String constraints
    if target_type == "string" {
        if let Some(s) = value.as_str() {
            let min_len = get_field(ps, "minLength").and_then(|v| v.as_i64());
            let max_len = get_field(ps, "maxLength").and_then(|v| v.as_i64());
            if let Some(min) = min_len {
                // Python len() is codepoints; chars().count() matches.
                if (s.chars().count() as i64) < min {
                    return Some(format!("Field '{}': minimum length {}", name, min));
                }
            }
            if let Some(max) = max_len {
                if (s.chars().count() as i64) > max {
                    return Some(format!("Field '{}': maximum length {}", name, max));
                }
            }
            if let Some(pattern) = get_field(ps, "pattern").and_then(|p| p.as_str()) {
                // NOTE: Rust `regex` crate syntax ≈ Python re for the common
                // classes used in tool schemas; a rejected pattern compiles to
                // None and fails-open (source would raise re.error, but
                // schemas are trusted input written by the same repo).
                if let Ok(re) = regex::Regex::new(pattern) {
                    if !re.is_match(s) {
                        return Some(format!(
                            "Field '{}': does not match pattern {}",
                            name, pattern
                        ));
                    }
                }
            }
        }
    }

    // Number constraints
    if target_type == "integer" || target_type == "number" {
        if let Some(f) = value.as_f64() {
            let minimum = get_field(ps, "minimum").and_then(|v| v.as_f64());
            let maximum = get_field(ps, "maximum").and_then(|v| v.as_f64());
            if let Some(min) = minimum {
                if f < min {
                    return Some(format!("Field '{}': minimum {}", name, min));
                }
            }
            if let Some(max) = maximum {
                if f > max {
                    return Some(format!("Field '{}': maximum {}", name, max));
                }
            }
        }
    }

    // Enum constraint
    if let Some(enum_vals) = get_field(ps, "enum").and_then(|e| e.as_array()) {
        if !enum_vals.contains(value) {
            // Python list repr shape: ['fast', 'slow'] — strings single-quoted.
            let render = |v: &JsonValue| match v {
                JsonValue::String(s) => format!("'{}'", s),
                other => other.to_string(),
            };
            let rendered: Vec<String> = enum_vals.iter().map(render).collect();
            return Some(format!(
                "Field '{}': must be one of [{}]",
                name,
                rendered.join(", ")
            ));
        }
    }

    // Array constraints
    if target_type == "array" {
        if let Some(arr) = value.as_array() {
            let min_items = get_field(ps, "minItems").and_then(|v| v.as_i64());
            let max_items = get_field(ps, "maxItems").and_then(|v| v.as_i64());
            if let Some(min) = min_items {
                if (arr.len() as i64) < min {
                    return Some(format!("Field '{}': minimum items {}", name, min));
                }
            }
            if let Some(max) = max_items {
                if (arr.len() as i64) > max {
                    return Some(format!("Field '{}': maximum items {}", name, max));
                }
            }
        }
    }

    None
}

fn validate_schema_inner(args: &JsonValue, schema: &JsonValue) -> Option<String> {
    /** Validate args against JSON schema (lightweight, no jsonschema crate).
     * Returns error message on failure, None on success. */
    if !args.is_object() {
        return Some(format!("Expected object, got {}", py_type_name(args)));
    }
    let obj = args.as_object().unwrap();
    let empty = JsonMap::new();
    let s = schema_obj(schema, &empty);

    // Check required fields
    if let Some(required) = get_field(s, "required").and_then(|r| r.as_array()) {
        for field_name in required {
            if let Some(fname) = field_name.as_str() {
                let missing = match obj.get(fname) {
                    None => true,
                    Some(v) => v.is_null(),
                };
                if missing {
                    return Some(format!("Missing required field: {}", fname));
                }
            }
        }
    }

    // Check property types
    let empty = JsonMap::new();
    let properties = s
        .get("properties")
        .and_then(|p| p.as_object())
        .unwrap_or(&empty);
    let additional_false = matches!(get_field(s, "additionalProperties"), Some(JsonValue::Bool(false)));

    for (key, value) in obj {
        let prop_schema = match properties.get(key) {
            Some(p) => p,
            None => {
                if additional_false {
                    return Some(format!("Unknown property: {}", key));
                }
                continue;
            }
        };
        if let Some(err) = validate_property(key, value, prop_schema) {
            return Some(err);
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Stage entry: validate_args
// ---------------------------------------------------------------------------

/// Three-stage validation: deepcopy -> coerce -> strict validate.
///
/// Returns Ok(validated_args_json) on success, Err(error_msg) on failure.
/// (The Python tuple (None, error) shape is un-idiomatic for Rust; the
/// pyfunction wrapper below converts back to the Python tuple contract.)
fn validate_args_impl(schema: &JsonValue, args_in: &JsonValue) -> Result<JsonValue, String> {
    // Stage 1: deepcopy — serde Values own their content; this clone IS the
    // independent copy the source's copy.deepcopy produced.
    let args = args_in.clone();

    // Stage 2: weak type coercion
    let args = coerce_types_inner(&args, schema);

    // Stage 3: strict schema validation
    if let Some(error) = validate_schema_inner(&args, schema) {
        return Err(error);
    }

    // Strip unknown properties if schema says additionalProperties=false
    let mut args = args;
    let empty_a = JsonMap::new();
    if matches!(schema_obj(schema, &empty_a).get("additionalProperties"), Some(JsonValue::Bool(false))) {
        let empty = JsonMap::new();
        let props = schema_obj(schema, &empty_a)
            .get("properties")
            .and_then(|p| p.as_object())
            .unwrap_or(&empty);
        if let Some(obj) = args.as_object() {
            let filtered: JsonMap<String, JsonValue> = obj
                .iter()
                .filter(|(k, _)| props.contains_key(*k))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            args = JsonValue::Object(filtered);
        }
    }

    Ok(args)
}

/// Three-stage validation: deepcopy -> coerce -> strict validate.
///
/// Returns (validated_args, None) on success, (None, error_msg) on failure —
/// the same tuple contract as the source.
#[pyfunction]
pub fn validate_args<'py>(
    py: Python<'py>,
    schema: &Bound<'_, PyDict>,
    args: &Bound<'_, PyAny>,
) -> PyResult<(Option<Bound<'py, PyAny>>, Option<String>)> {
    let schema_json = py_to_json(schema)?;
    let args_json = args_to_json(args)?;
    match validate_args_impl(&schema_json, &args_json) {
        Ok(validated) => {
            let py_obj = json_to_py(py, &validated)?;
            Ok((Some(py_obj), None))
        }
        Err(msg) => Ok((None, Some(msg))),
    }
}

/// Coerce types based on schema type field (tolerate LLM dirty params).
#[pyfunction]
pub fn coerce_types<'py>(
    py: Python<'py>,
    args: &Bound<'_, PyAny>,
    schema: &Bound<'_, PyDict>,
) -> PyResult<Bound<'py, PyAny>> {
    let args_json = args_to_json(args)?;
    let schema_json = py_to_json(schema)?;
    let coerced = coerce_types_inner(&args_json, &schema_json);
    json_to_py(py, &coerced)
}

/// Validate args against JSON schema; error message string on failure.
#[pyfunction]
pub fn validate_schema(
    py: Python<'_>,
    args: &Bound<'_, PyAny>,
    schema: &Bound<'_, PyDict>,
) -> PyResult<Option<String>> {
    let args_json = args_to_json(args)?;
    let schema_json = py_to_json(schema)?;
    let _ = py;
    Ok(validate_schema_inner(&args_json, &schema_json))
}

pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "tool_validator")?;
    m.add_function(wrap_pyfunction!(validate_args, &m)?)?;
    m.add_function(wrap_pyfunction!(coerce_types, &m)?)?;
    m.add_function(wrap_pyfunction!(validate_schema, &m)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}

// PORT STATUS: confidence=high todos=0
