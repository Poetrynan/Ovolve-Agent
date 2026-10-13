/**
 * token_estimate.ts — the single source of truth for backend token estimation.
 *
 * Ported from `app/backend/token_estimate.py` (135 lines).
 *
 * Before that module there were four independent char-ratio estimators in the
 * backend and they disagreed with each other:
 *
 *     context_compactor.estimate_tokens   CJK / 1.8 + rest / 4   (0.56 tok/CJK char)
 *     memory_tiers.estimate_tokens        CJK * 1.0 + rest / 4   (1.00 tok/CJK char)
 *     memory_retrieval._token_len         a hand-copied clone of the above
 *     llm_client.estimate_request_tokens  utf-8 bytes / 3.5
 *
 * They also disagreed on what counts as CJK, so the same conversation produced
 * numbers up to 1.8x apart depending on which subsystem asked. That is not a
 * rounding difference — it decides whether context folding fires.
 *
 * The canonical choice is the **pessimistic** one, 1 token per wide character:
 * under-estimating skips a fold and the next request dies with a context-length
 * error the user has to drive around; over-estimating folds one turn early and
 * costs a summarisation nobody notices.
 *
 * This is not a tokenizer. Real BPE lives on the frontend
 * (`app/ui/src/lib/tokens.ts`). The backend needs a cheap, stable,
 * dependency-free number that never *under*-counts.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/token_estimate.py -> app/engine/token_estimate.ts
 *   §2  float/formatting: ceil and floor division reproduced explicitly
 *   §2  broad swallow: the Rust probe's `except Exception` is preserved
 *   §3  DIVERGENCE(port) for the FFI decision — see RUST_ACCELERATED below
 *
 * PORT STATUS: confidence=high todos=0
 */

/**
 * Characters that occupy one token each. Deliberately broader than any of the
 * ranges it replaces, because every range that was *missing* from a subsystem
 * caused that subsystem to under-count:
 *
 *   3000-303f  CJK punctuation
 *   3040-30ff  hiragana + katakana
 *   3400-4dbf  CJK Unified Ext-A
 *   4e00-9fff  CJK Unified (the common Chinese block)
 *   ac00-d7af  Hangul syllables
 *   f900-faff  CJK compatibility ideographs
 *   ff00-ffef  fullwidth / halfwidth forms
 *
 * RULEBOOK §2: every range here is inside the BMP, so no surrogate pair can
 * straddle one. The `u` flag is still set so the class behaves the same way if
 * a future range moves outside the BMP.
 */
const WIDE_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/gu;

/** Non-wide characters per token. The long-standing ~4 chars/token rule for English prose and code. */
export const CHARS_PER_TOKEN = 4;

/** utf-8 bytes per token for the byte-length signal. 3.5 is what the rate limiter has always reserved with. */
export const BYTES_PER_TOKEN = 3.5;

// Image cost is not defined here on purpose. It lives in
// `context_refs.IMAGE_TOKEN_ESTIMATE` next to the machinery that owns image
// handling; duplicating the constant here would be the exact kind of fork this
// module exists to kill.

/**
 * DIVERGENCE(port): the source probes the compiled Rust core first
 * (`ovolve_core.context_compactor`) and falls back to the pure-Python body when
 * the extension is missing. It probes directly rather than through
 * `rust_adapters` to avoid an import cycle, since that adapter delegates back
 * here.
 *
 * Resolved per AMEND-07: the pure implementation below IS the shipped
 * behaviour on this machine — probe 2026-09-23 showed `from
 * ovolve_core.context_compactor import ...` raising ModuleNotFoundError for
 * the installed product Python (submodule import path), so the source itself
 * runs the fallback — AND the fallback is exact: the Rust mirror agrees with
 * it on a 209-string corpus (0 mismatches across estimate_tokens /
 * wide_chars / estimate_bytes; D:/ovolve-migration/tmp/te_parity.py,
 * verified/token_estimate_rust_parity.json). Routing TS through a subprocess
 * bridge to reach that same Rust code would only add latency; identical
 * numbers, so no observable difference. RUST_ACCELERATED stays false.
 */
const RUST_ACCELERATED = false;
export { RUST_ACCELERATED };

/** How many characters in `text` are counted at one token each. */
export function wideChars(text: string): number {
  if (!text) {
    return 0;
  }
  // RULEBOOK §2: Python's `len(findall(...))` counts non-overlapping matches.
  // `String.match` with /g does the same, and returns null for no match.
  return (text.match(WIDE_RE) ?? []).length;
}

/**
 * Estimate the token cost of `text`.
 *
 * Ceiling division on the tail, so any non-empty string costs at least 1 — a
 * zero estimate reads as "free", and nothing is free.
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  const wide = wideChars(text);
  // RULEBOOK §2: Python len(text) counts CODE POINTS; text.length counts
  // UTF-16 code units, so astral chars (emoji) would inflate `rest`.
  // Array.from iterates code points — the faithful mapping.
  const rest = Array.from(text).length - wide;
  // RULEBOOK §2: Python `(rest + 3) // 4` is floor division, not truncation.
  // `rest` is non-negative here, so Math.floor is equivalent.
  return wide + Math.floor((rest + CHARS_PER_TOKEN - 1) / CHARS_PER_TOKEN);
}

/**
 * The byte-length signal: utf-8 length / BYTES_PER_TOKEN.
 *
 * Kept alongside the char estimate rather than folded into it because they fail
 * in opposite directions, and callers that care take the max of both.
 *
 * RULEBOOK §2 (numeric policy): `int(x)` on a positive float truncates toward
 * zero, so Math.floor is the faithful mapping. Note `text.length` is UTF-16 code
 * units and is NOT the byte count — Buffer.byteLength is, and it is what the
 * Python `len(text.encode("utf-8"))` actually measured.
 */
export function estimateBytes(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.floor(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
}

/**
 * Estimate any value: strings directly, everything else via compact JSON.
 *
 * Tool-call arguments and JSON schemas arrive as objects, and stringifying them
 * the same way every caller does is half the point of centralising this.
 */
export function estimateTokensOf(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "string") {
    return estimateTokens(value);
  }
  try {
    // RULEBOOK §2: the source uses `separators=(",", ":")` — no spaces after
    // separators. JSON.stringify already omits them, so the byte count matches.
    return estimateTokens(JSON.stringify(value));
  } catch {
    // RULEBOOK §2 (broad swallow): preserved. A circular structure throws in
    // both languages, and the source falls back to `str(value)` rather than
    // propagating. Reproduced.
    return estimateTokens(String(value));
  }
}
