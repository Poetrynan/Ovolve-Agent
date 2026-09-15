"""
tool_validator.py - Three-stage tool parameter validation (Pi pattern).

LLM returns dirty params -> 1) deepcopy (prevent pollution)
-> 2) weak type coercion (str->int/bool etc) -> 3) strict schema validation.
Failure returns error text, never throws exception into the tool.
"""

from __future__ import annotations

import copy
import re
from typing import Any, Optional, Tuple


def validate_args(schema: dict, args: dict) -> Tuple[Optional[dict], Optional[str]]:
    """Three-stage validation: deepcopy -> coerce -> strict validate.

    Returns (validated_args, None) on success, (None, error_msg) on failure.
    """
    if args is None:
        args = {}

    # Stage 1: deepcopy (prevent caller mutation)
    args = copy.deepcopy(args)

    # Stage 2: weak type coercion (tolerate LLM output)
    args = coerce_types(args, schema)

    # Stage 3: strict schema validation
    error = validate_schema(args, schema)
    if error:
        return None, error

    # Strip unknown properties if schema says additionalProperties=false
    if schema.get("additionalProperties") is False:
        props = set(schema.get("properties", {}).keys())
        args = {k: v for k, v in args.items() if k in props}

    return args, None


def coerce_types(args: dict, schema: dict) -> dict:
    """Coerce types based on schema type field (tolerate LLM dirty params)."""
    if not isinstance(args, dict):
        return args

    properties = schema.get("properties", {})
    result = {}

    for key, value in args.items():
        prop_schema = properties.get(key)
        if prop_schema is None:
            result[key] = value
            continue

        target_type = prop_schema.get("type")
        result[key] = _coerce_value(value, target_type, prop_schema)

    return result


def _coerce_value(value: Any, target_type: Optional[str], prop_schema: dict) -> Any:
    """Coerce a single value to the target type."""
    if value is None:
        if prop_schema.get("default") is not None:
            return prop_schema["default"]
        return None

    if target_type == "string":
        if isinstance(value, str):
            return value
        if isinstance(value, (int, float, bool)):
            return str(value)
        if isinstance(value, (list, dict)):
            import json
            return json.dumps(value, ensure_ascii=False)
        return str(value)

    if target_type == "integer":
        if isinstance(value, int) and not isinstance(value, bool):
            return value
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, float):
            return int(value)
        if isinstance(value, str):
            try:
                return int(value.strip())
            except ValueError:
                try:
                    return int(float(value.strip()))
                except ValueError:
                    return value  # let schema validation catch it
        return value

    if target_type == "number":
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
        if isinstance(value, bool):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value.strip())
            except ValueError:
                return value
        return value

    if target_type == "boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            low = value.strip().lower()
            if low in ("true", "yes", "1", "on"):
                return True
            if low in ("false", "no", "0", "off"):
                return False
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        return value

    if target_type == "array":
        if isinstance(value, list):
            items_schema = prop_schema.get("items")
            if items_schema and isinstance(items_schema, dict):
                return [_coerce_value(v, items_schema.get("type"), items_schema) for v in value]
            return value
        if isinstance(value, str):
            # Try to parse as JSON array
            stripped = value.strip()
            if stripped.startswith("[") and stripped.endswith("]"):
                import json
                try:
                    return json.loads(stripped)
                except (json.JSONDecodeError, ValueError):
                    pass  # fail-open: 可选增强，失败不影响主流程
            # Comma-separated fallback
            if "," in stripped:
                return [s.strip() for s in stripped.split(",")]
            return [stripped]
        if value is not None:
            return [value]
        return value

    if target_type == "object":
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            stripped = value.strip()
            if stripped.startswith("{") and stripped.endswith("}"):
                import json
                try:
                    return json.loads(stripped)
                except (json.JSONDecodeError, ValueError):
                    pass  # fail-open: 可选增强，失败不影响主流程
        return value

    return value


def validate_schema(args: dict, schema: dict) -> Optional[str]:
    """Validate args against JSON schema (lightweight, no jsonschema dependency).

    Returns error message string on failure, None on success.
    """
    if not isinstance(args, dict):
        return f"Expected object, got {type(args).__name__}"

    # Check required fields
    required = schema.get("required", [])
    for field_name in required:
        if field_name not in args or args[field_name] is None:
            return f"Missing required field: {field_name}"

    # Check property types
    properties = schema.get("properties", {})
    for key, value in args.items():
        if key not in properties:
            if schema.get("additionalProperties") is False:
                return f"Unknown property: {key}"
            continue

        prop_schema = properties[key]
        error = _validate_property(key, value, prop_schema)
        if error:
            return error

    return None


def _validate_property(name: str, value: Any, prop_schema: dict) -> Optional[str]:
    """Validate a single property value against its schema."""
    if value is None:
        if name in (prop_schema.get("required", [])):
            return f"Field '{name}' is required"
        return None

    target_type = prop_schema.get("type")
    if target_type is None:
        return None

    type_map = {
        "string": str,
        "integer": int,
        "number": (int, float),
        "boolean": bool,
        "array": list,
        "object": dict,
    }

    expected = type_map.get(target_type)
    if expected is None:
        return None

    # bool is subclass of int in Python, handle separately
    if target_type == "integer" and isinstance(value, bool):
        return f"Field '{name}': expected integer, got boolean"
    if target_type == "number" and isinstance(value, bool):
        return f"Field '{name}': expected number, got boolean"

    if not isinstance(value, expected):
        return f"Field '{name}': expected {target_type}, got {type(value).__name__}"

    # String constraints
    if target_type == "string" and isinstance(value, str):
        min_len = prop_schema.get("minLength")
        max_len = prop_schema.get("maxLength")
        if min_len is not None and len(value) < min_len:
            return f"Field '{name}': minimum length {min_len}"
        if max_len is not None and len(value) > max_len:
            return f"Field '{name}': maximum length {max_len}"
        pattern = prop_schema.get("pattern")
        if pattern and not re.search(pattern, value):
            return f"Field '{name}': does not match pattern {pattern}"

    # Number constraints
    if target_type in ("integer", "number") and isinstance(value, (int, float)):
        minimum = prop_schema.get("minimum")
        maximum = prop_schema.get("maximum")
        if minimum is not None and value < minimum:
            return f"Field '{name}': minimum {minimum}"
        if maximum is not None and value > maximum:
            return f"Field '{name}': maximum {maximum}"

    # Enum constraint
    enum_vals = prop_schema.get("enum")
    if enum_vals is not None and value not in enum_vals:
        return f"Field '{name}': must be one of {enum_vals}"

    # Array constraints
    if target_type == "array" and isinstance(value, list):
        min_items = prop_schema.get("minItems")
        max_items = prop_schema.get("maxItems")
        if min_items is not None and len(value) < min_items:
            return f"Field '{name}': minimum items {min_items}"
        if max_items is not None and len(value) > max_items:
            return f"Field '{name}': maximum items {max_items}"

    return None
