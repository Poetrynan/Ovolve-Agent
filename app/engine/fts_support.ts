/**
 * fts_support.ts — FTS/document kernels shared by the storage memory domain
 * and the retrieval path, on the verified Rust parity spec.
 *
 * RULEBOOK CITATIONS
 *   §1  no dependency: RegExp + String only.
 *   §2  Python `re` on `str` is codepoint-based; the character classes here
 *       are BMP-only, so a plain JS RegExp over UTF-16 units is equivalent.
 *   §2  casefold→lower: these kernels lowercase ASCII word runs only, where
 *       the two agree (documented in HANDOFF §6.2).
 *   §4  naming: support module of the storage/retrieval units, not a
 *       translated unit itself. Semantics follow memory_retrieval.py — the
 *       same spec the Rust module was corrected against (55/55 parity, see
 *       D:/ovolve-migration/verified/memory_retrieval.json).
 *
 * PORT STATUS: confidence=high todos=0
 */

// BMP-only CJK blocks: kana + CJK ext-A/统一表意 + compatibility + Hangul.
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;
// RULEBOOK §2 (handoff §6.2): a `g`-flagged RegExp carries lastIndex across
// calls. Every exported function below constructs its own RegExp, or uses
// matchAll on a fresh one — nothing global is shared between calls.

const WORD_RE = /[A-Za-z0-9_]+/g;

/** FTS5 treats these as query syntax; they must never reach MATCH unquoted. */
const FTS_SPECIAL = new Set(['"', '*', '(', ')', ':', '^', '-', '+', ',']);

export function is_cjk(ch: string): boolean {
  return new RegExp("^[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af]").test(ch);
}

export function cjk_bigrams(text: string): string[] {
  const out: string[] = [];
  for (const m of (text ?? "").matchAll(new RegExp(CJK_RE.source, "g"))) {
    const run = m[0];
    if (Array.from(run).length === 1) {
      out.push(run);
      continue;
    }
    const chars = Array.from(run);
    for (let i = 0; i + 1 < chars.length; i++) {
      out.push(chars[i]! + chars[i + 1]!);
    }
  }
  return out;
}

export function fts_document(text: string): string {
  if (!text) {
    return "";
  }
  const words = Array.from((text as string).matchAll(new RegExp(WORD_RE.source, "g"))).map((m) =>
    m[0].toLowerCase()
  );
  return [...words, ...cjk_bigrams(text)].join(" ");
}

export function _sanitize_term(term: string): string {
  let out = "";
  for (const ch of term) {
    if (!FTS_SPECIAL.has(ch)) out += ch;
  }
  return out.trim();
}

export function build_fts_query(text: string, keywords?: readonly string[] | null): string {
  const terms: string[] = [];
  for (const m of (text ?? "").matchAll(new RegExp(WORD_RE.source, "g"))) {
    const w = m[0];
    // Python len(w) > 1 — codepoint count. Word runs are ASCII, so .length
    // (UTF-16 units) equals the codepoint count here.
    if (w.length > 1) {
      terms.push(w.toLowerCase());
    }
  }
  terms.push(...cjk_bigrams(text));
  for (const kw of keywords ?? []) {
    const cleaned = _sanitize_term(String(kw));
    if (cleaned.length > 1) {
      terms.push(cleaned.toLowerCase());
    }
  }

  const seen = new Set<string>();
  const quoted: string[] = [];
  for (const t0 of terms) {
    const t = _sanitize_term(t0);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    quoted.push(`"${t}"`);
  }
  return quoted.join(" OR ");
}
