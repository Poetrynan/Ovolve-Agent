/**
 * storage_funcs.ts — module-level functions of storage.py.
 *
 * Ported from `app/backend/storage.py` module level (lines 1–205).
 *
 * RULEBOOK CITATIONS
 *   §2  dict ordering: json.dumps default (no sort_keys) preserves insertion
 *       order — JS objects preserve it too; the sortKeys variant implements
 *       sort_keys=True.
 *   §2  Python float repr: json.dumps uses shortest float that round-trips,
 *       same as JS String(number) for non-integral values.
 *   §4  naming: part of the storage unit (storage.py → storage/).
 *
 * PORT STATUS: confidence=high todos=0
 */

import { PLACEHOLDER_PROVIDER_IDS } from "./storage_consts.js";

// ---------------------------------------------------------------------------
// Python-compatible JSON serialization
// ---------------------------------------------------------------------------

/**
 * json.dumps(value, ensure_ascii=False) with Python's default separators
 * (", " / ": "). Byte-compat with Python output for the JSON value model
 * (null/bool/int/float/str/list/dict).
 */
export function pyJsonDumps(value: unknown, sortKeys = false): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value) || !Number.isFinite(value)) return "null";
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => pyJsonDumps(v, sortKeys)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = sortKeys ? Object.keys(obj).sort() : Object.keys(obj);
    return `{${keys
      .map((k) => `${JSON.stringify(k)}: ${pyJsonDumps(obj[k], sortKeys)}`)
      .join(", ")}}`;
  }
  return "null";
}

/** json.dumps(payload, sort_keys=True, ensure_ascii=False) — the hash canonical form. */
export function canonicalJson(value: unknown): string {
  return pyJsonDumps(value, true);
}

/**
 * json.dump(data, fh, ensure_ascii=False, indent=1) — the migration journal
 * format. Python's indent mode separators are (",", ": "): items land on
 * their own lines with 1-space indent steps, no trailing space after commas.
 */
export function pyJsonIndent(value: unknown, level = 0): string {
  const pad = " ".repeat(level);
  const padIn = " ".repeat(level + 1);
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value) || !Number.isFinite(value)) return "null";
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((v) => padIn + pyJsonIndent(v, level + 1)).join(",\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return "{}";
    return `{\n${keys
      .map((k) => `${padIn}${JSON.stringify(k)}: ${pyJsonIndent(obj[k], level + 1)}`)
      .join(",\n")}\n${pad}}`;
  }
  return "null";
}

// ---------------------------------------------------------------------------
// split_usage_model_id
// ---------------------------------------------------------------------------

/**
 * Split a ``turn_usage.model_id`` into [provider_id, model_id].
 *
 * Deliberately does NOT substitute a default model name (see source
 * docstring: a previous version answered "openai:LongCat-2.0" for anything
 * it could not parse — correct only for the one machine it was written on).
 *
 * Returns ["", ""] when nothing usable is left, so callers can skip the row.
 */
export function split_usage_model_id(raw: string): [string, string] {
  raw = String(raw ?? "").trim();
  if (!raw) {
    return ["", ""];
  }
  if (!raw.includes(":")) {
    // No prefix at all: pre-prefix row, or a placeholder standing alone.
    return PLACEHOLDER_PROVIDER_IDS.has(raw.toLowerCase()) ? ["", ""] : ["", raw];
  }
  const idx = raw.indexOf(":");
  let provider_id = raw.slice(0, idx).trim();
  const model_id = raw.slice(idx + 1).trim();
  if (PLACEHOLDER_PROVIDER_IDS.has(provider_id.toLowerCase())) {
    provider_id = "";
  }
  return [provider_id, model_id];
}
