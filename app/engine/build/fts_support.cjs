"use strict";
/**
 * fts_support.ts 鈥?FTS/document kernels shared by the storage memory domain
 * and the retrieval path, on the verified Rust parity spec.
 *
 * RULEBOOK CITATIONS
 *   搂1  no dependency: RegExp + String only.
 *   搂2  Python `re` on `str` is codepoint-based; the character classes here
 *       are BMP-only, so a plain JS RegExp over UTF-16 units is equivalent.
 *   搂2  casefold鈫抣ower: these kernels lowercase ASCII word runs only, where
 *       the two agree (documented in HANDOFF 搂6.2).
 *   搂4  naming: support module of the storage/retrieval units, not a
 *       translated unit itself. Semantics follow memory_retrieval.py 鈥?the
 *       same spec the Rust module was corrected against (55/55 parity, see
 *       D:/ovolve-migration/verified/memory_retrieval.json).
 *
 * PORT STATUS: confidence=high todos=0
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.is_cjk = is_cjk;
exports.cjk_bigrams = cjk_bigrams;
exports.fts_document = fts_document;
exports._sanitize_term = _sanitize_term;
exports.build_fts_query = build_fts_query;
// BMP-only CJK blocks: kana + CJK ext-A/缁熶竴琛ㄦ剰 + compatibility + Hangul.
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;
// RULEBOOK 搂2 (handoff 搂6.2): a `g`-flagged RegExp carries lastIndex across
// calls. Every exported function below constructs its own RegExp, or uses
// matchAll on a fresh one 鈥?nothing global is shared between calls.
const WORD_RE = /[A-Za-z0-9_]+/g;
/** FTS5 treats these as query syntax; they must never reach MATCH unquoted. */
const FTS_SPECIAL = new Set(['"', '*', '(', ')', ':', '^', '-', '+', ',']);
function is_cjk(ch) {
    return new RegExp("^[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af]").test(ch);
}
function cjk_bigrams(text) {
    const out = [];
    for (const m of (text ?? "").matchAll(new RegExp(CJK_RE.source, "g"))) {
        const run = m[0];
        if (Array.from(run).length === 1) {
            out.push(run);
            continue;
        }
        const chars = Array.from(run);
        for (let i = 0; i + 1 < chars.length; i++) {
            out.push(chars[i] + chars[i + 1]);
        }
    }
    return out;
}
function fts_document(text) {
    if (!text) {
        return "";
    }
    const words = Array.from(text.matchAll(new RegExp(WORD_RE.source, "g"))).map((m) => m[0].toLowerCase());
    return [...words, ...cjk_bigrams(text)].join(" ");
}
function _sanitize_term(term) {
    let out = "";
    for (const ch of term) {
        if (!FTS_SPECIAL.has(ch))
            out += ch;
    }
    return out.trim();
}
function build_fts_query(text, keywords) {
    const terms = [];
    for (const m of (text ?? "").matchAll(new RegExp(WORD_RE.source, "g"))) {
        const w = m[0];
        // Python len(w) > 1 鈥?codepoint count. Word runs are ASCII, so .length
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
    const seen = new Set();
    const quoted = [];
    for (const t0 of terms) {
        const t = _sanitize_term(t0);
        if (!t || seen.has(t))
            continue;
        seen.add(t);
        quoted.push(`"${t}"`);
    }
    return quoted.join(" OR ");
}
