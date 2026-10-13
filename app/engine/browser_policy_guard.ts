/**
 * browser_policy_guard.ts — 浏览器自动化脚本分级策略与安全沙箱.
 *
 * Ported from `app/backend/browser_policy_guard.py` (126 lines).
 *
 * 按脚本对页面状态的影响分级管控，敏感凭证读取一律阻断。READ_ONLY 放行 /
 * MUTATING 审计 / BLOCKED_DANGEROUS 硬阻断 + URL 协议白名单。
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/browser_policy_guard.py -> app/engine/browser_policy_guard.ts
 *   §2  behaviour: classify order is AST-verdict → empty → dangerous sweep →
 *       mutating sweep → default; the py `(x, Enum)` membership test compares
 *       str-Enum members by VALUE, so a plain "mutating" string qualifies and
 *       `reason` uses dict `.get(default)` semantics — a present-but-null
 *       reason yields null, not the default (argGet idiom); `str(js_code or
 *       "")` falsy gate; slices are *codepoint* slices (astral-safe).
 *   §2  (str, Enum) → string union + const table (memory_tiers.ts precedent);
 *       py `str(member)` prints "ScriptExecutionTier.X" while the value string is
 *       used everywhere downstream — every observed consumer compares/serialises
 *       the value, so no caller sees a diff.
 *   §2/§BUG  CPYTHON REGEX SEMANTICS ARE THE CONTRACT, V8'S ARE NOT. This is a
 *       security guard: each pattern's verdict decides allow / audit / block, so a
 *       character-class difference between runtimes is a BYPASS, not a typo. The
 *       backfill chain measured the four sets this module leans on with CPython
 *       3.13.14 as the judge (the interpreter the chain runs, self-reported version;
 *       installed under versions/3.13.12/), over the WHOLE codepoint range
 *       (tmp/brows_oracle_py.py = BMP scan, tmp/brows_oracle_full.py =
 *       U+10000..U+10FFFF, tmp/brows_oracle_diff.txt = the diff), and the port now
 *       reproduces CPython instead of V8. Each row below is a measured divergence
 *       of the previous port, with the verdict flip it caused:
 *         D1 `\b` / `\w`: py `\w` is 49701 BMP characters (all Unicode letters and
 *            numbers plus `_`); JS `\w` is 63 (ASCII only). "文档document.cookie",
 *            "document.cookie文档", "éeval(", "αeval(", "１eval(", "𐀀eval(" were
 *            BLOCKED_DANGEROUS in the port and READ_ONLY in CPython (over-block:
 *            a strict-mode guard rejecting legitimate CJK-labelled scripts).
 *            py `\w` also *excludes* code points V8's newer UCD calls letters or
 *            numbers - 8 in the BMP (U+1C89 U+1C8A U+A7CB-A7CD U+A7DA-A7DC) and, above
 *            the BMP, ranges such as U+105C0-U+105F3, U+13460-U+143FA, U+16D40-U+16D79
 *            (D6 below). PY_WORD_STALE carries them so the boundary assertions re-open
 *            exactly where CPython does.
 *            Evidence: `word` (49701 code points) and the `probes` rows of
 *            tmp/brows_oracle_py.json, emitted by tmp/brows_oracle_py.py under the
 *            pinned CPython (self-reported 3.13.14) - e.g. probe "文档document.cookie"
 *            and "１eval(" come back false there, which is the over-block being undone.
 *         D2 `\s`: py `\s` == `str.isspace()` (29 BMP codepoints; adds
 *            U+001C-U+001F + U+0085, drops U+FEFF relative to JS's 25).
 *            "document\u0085.cookie" and "document\u001c.cookie" were READ_ONLY in
 *            the port but BLOCKED_DANGEROUS in CPython - a fail-OPEN bypass of the
 *            cookie rule; "document\ufeff.cookie" went the other way (port
 *            over-blocked).
 *            Evidence: the `space` array (29 entries) and the `document\u001c.cookie`
 *            / `document\u0085.cookie` rows of `probes` in tmp/brows_oracle_py.json,
 *            plus the runtime-vs-runtime whitespace diff in tmp/brows_icase_sets.json
 *            (`space_py` vs `space_js`).
 *         D3 `re.IGNORECASE` is WIDER than JS `/i` for three letters: CPython's
 *            (lower, upper, title) triple folds U+0130/U+0131 into `i`, U+212A into
 *            `k` and U+017F (LONG S) into `s`; V8's simple case folding does not
 *            fold those back. Measured: "localſtorage.clear()" was READ_ONLY in the
 *            port and BLOCKED_DANGEROUS in CPython — again fail-open on a
 *            destructive-data rule. The patterns are therefore compiled WITHOUT the
 *            `/i` flag, from per-letter classes built out of CPython's measured
 *            sets (`ciExpand`), so case folding is CPython's, not V8's.
 *            Evidence: tmp/brows_icase_sets.json, which carries CPython's fold
 *            triples and V8's side by side (`icase_py` vs `icase_js`: `i`="Iiİı",
 *            `k`="KkK", `s`="Ssſ") and the same `icase` key of
 *            tmp/brows_oracle_py.json; the flip itself is probe
 *            "localſtorage.clear()" -> ls_clear=true there.
 *         D4 `str.strip()` == py whitespace, `String.trim()` == JS whitespace; the
 *            empty-script gate and the empty-URL gate are decided by it. "\u001c",
 *            "\u0085" are EMPTY for CPython ("Empty script" / "URL 不能为空") and
 *            "\ufeff" is NOT empty - the old port had all three backwards.
 *            Evidence: the same 29-entry `space` array of tmp/brows_oracle_py.json is
 *            what CPython's `str.strip()` removes (tmp/brows_oracle_py.py scans the whole
 *            BMP with `re.match(r"\s", c)`, and py `\s` for a str pattern IS
 *            `str.isspace()` - the D2 statement above), and tmp/brows_icase_sets.json
 *            diffs it against JS's trim set (`space_py` vs `space_js`); the gate's own
 *            `empty`/`url` case groups re-measure the three rows live against the real
 *            backend source.
 *         D5 `str(x)` of a container: the old port used JSON.stringify, so a list
 *            URL rendered `["javascript:alert(1)` where CPython renders
 *            `['javascript:alert(1)` — the reason string is exactly what gets
 *            logged and grep'd downstream. pyStr now renders CPython `repr`
 *            (single quotes, `, `/`: ` separators, `\n\r\t\\` escapes and CPython's
 *            `\xNN`/`\uXXXX`/`\UXXXXXXXX` escapes for everything
 *            `str.isprintable()` rejects), and floats are spelled the way CPython
 *            spells them (`pyFloatStr`: shortest round-trip digits, exponent form
 *            unless the decimal point sits in (-4, 16], two exponent digits, always
 *            a `.` or an exponent).
 *            Evidence: tmp/brows_repr_diff.txt - the CPython-side rows are printed by
 *            the pinned interpreter (line 1: `PY exit=0 PYROWS=75 python=3.13.14`) and
 *            the port's rendering is compared against them: row [0] `py:list
 *            str="['javascript:alert(1)']"` is exactly the single-quote list face the
 *            old JSON.stringify port got wrong, row [36] `py:float str="1e-05"` pins
 *            the exponent spelling, and the closing `BATTERY values=75 match=61
 *            lang_property=14 unexplained_divergences=0` records that the only
 *            remaining diffs are the 14 integral-`float` rows that are a JS
 *            language property (no int/float tag), not a port defect.
 *         D6 astral `\b`: the fix for D1 was still V8's word set above the BMP. CPython
 *            3.13.14's `\w` has NO members above the BMP beyond the 88857 it knows, while
 *            V8's `\p{L}\p{N}` adds ~4374 code points in 23 contiguous ranges (measured
 *            code-point by code-point in tmp/brows_astral_ranges.txt, cross-checked
 *            against a live `re.match(r"\w", chr(cp))` probe of every range boundary in
 *            tmp/brows_astral_check.txt and per-range in tmp/brows_astral_adjudicate.txt).
 *            Measured verdict flips of the port before the fix: "𓑦document.cookie𓑦"
 *            (U+13460 either side) was READ_ONLY here and BLOCKED_DANGEROUS in CPython -
 *            fail-OPEN on the credential rule - and "𓑦new Function('x')" matched as
 *            'Function(' instead of 'new Function(', i.e. a different reason text
 *            reached the audit log. PY_WORD_STALE now carries those ranges.
 *         D7 `str(float)` in the exponent branch lost its `e`: `1e-05` was spelled
 *            "1-05", `1.5e-07` "1.5-07", `5e-324` "5-324" in any reason string that
 *            echoes a numeric URL (found by the repr group of the case table, where
 *            CPython's `str({'a': 1e-05})` and the port's disagreed character by
 *            character). pyFloatStr now emits CPython's `e`-plus-sign-plus-two-digits.
 *       NOTE (language property, documented not pinned): JS has no int/float
 *       split, so an integral JS number follows `str(int)`; CPython's
 *       `str(1e16)`/"1e+16" is unreachable from a JS caller that received `1e16`
 *       as a Number. Non-integral floats - the reachable ones - match exactly
 *       (tmp/brows_repr_diff.txt battery). No id is exempt in the comparator.
 *         D8 `str.lower()` vs `String.prototype.toLowerCase()` in `validate_url`: the
 *            source's only observable use of lower() is
 *            `u = str(url or "").strip().lower()`, and the reason strings echo `u`
 *            back (`{u[:30]}` / `{u[:20]}`), so the lowered text is a PUBLIC face.
 *            V8 ships a newer Unicode than CPython 3.13 and folds 27 code points that
 *            CPython leaves alone - measured over the WHOLE range (U+0000..U+10FFFF,
 *            code point by code point, pinned CPython 3.13.14 vs the chain's
 *            node v22.18.0) in tmp/lead_brows_lower_diff.txt against CPython's full
 *            lower() map (tmp/brows_lower_py.json, 1433 non-identity entries):
 *            U+1C89, U+A7CB, U+A7CC, U+A7DA, U+A7DC and U+10D50..U+10D65. The
 *            `ok`/deny verdict never flips on them (none of them can spell a scheme),
 *            but the reason string handed to the audit log does, so `py_lower` (§M)
 *            protects exactly those 27 and lets V8's own toLowerCase handle the rest.
 *            A context battery of 810 multi-code-point strings (Greek sigmas, İ/ı,
 *            ﬁ, titlecase digraphs, plus a protected char adjacent to a sigma) showed
 *            differing=0, i.e. the two runtimes agree on the context-dependent rules
 *            and only the code-point table needs pinning.
 *   §M  single source: the closed CPython-mirror layer is
 *       `app/engine/server/http_server_keys.ts` §M. This module IMPORTS from it
 *       (`PY_ISSPACE`, `py_strip`, `py_truth`, `py_lower`) - the whitespace set, the
 *       truthiness faces and the case-fold table are exactly the mirrors whose
 *       private re-typing has already flipped verdicts elsewhere in the migration,
 *       and `steer_protocol.ts` shows the layer is not `server/`-private in practice.
 *       What stays local is only what §M cannot express without a regression: the
 *       reason-string formatters (`pyReasonStr`/`pyReasonRepr`/`pyFloatStr`), because
 *       §M's `py_float_repr` is `String(x)` + `.0` and does not reproduce CPython's
 *       exponent spelling (`str(1e-5)` is "1e-05") - escalated as a §M defect in
 *       tmp/brows_STATE.md rather than copied or "unified".
 *   §2  py `re.sub(pattern, " ", code)` is the leftmost non-overlapping global
 *       replace = JS `/g` replace, and `[\s\S]` means "any character" in both
 *       runtimes even though the two `\s` sets differ, so
 *       `strip_comments_and_strings` needs no translation (proved row by row in
 *       tmp/brows_facts_py.json / tmp/brows_facts_ts.json).
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import { PY_ISSPACE, py_lower, py_strip, py_truth } from "./server/http_server_keys.js";

/** Danger-tier enum: values are what callers compare and persist. */
export const ScriptExecutionTier = {
    READ_ONLY: "read_only",
    MUTATING: "mutating",
    BLOCKED_DANGEROUS: "blocked_dangerous",
} as const;
export type ScriptExecutionTier = (typeof ScriptExecutionTier)[keyof typeof ScriptExecutionTier];

/**
 * CPython `\w` for `str` patterns: Unicode letters + Unicode numbers + `_`,
 * minus the code points CPython's UCD does not treat as word characters.
 * `[\p{L}\p{N}_]` MINUS PY_WORD_STALE == py `\w`, measured code-point by code-point
 * against `python -B` scans of the whole range (tmp/brows_oracle_py.py = BMP: py
 * `\w` = 49701 code points; tmp/brows_oracle_full.py = U+10000..U+10FFFF: 88857;
 * tmp/brows_astral_ranges.txt + tmp/brows_astral_adjudicate.txt = the V8-vs-CPython
 * diff that produced the ranges below: 0 code points are in py `\w` but missing from
 * `[\p{L}\p{N}_]`, so V8's set is a strict superset. The exceptions listed here are
 * the contiguous ranges where V8 really does match and CPython really does not (V8
 * ships a newer UCD than CPython 3.13, so it knows scripts and reserved blocks
 * CPython does not; the remaining ranges in that diff are non-word for BOTH runtimes
 * and need no exception). A `\b` compiled on bare `\p{L}` therefore opens a boundary
 * CPython keeps shut (fail-OPEN on the destructive rules: a code point from
 * U+13460-U+143FA either side of "document.cookie" is BLOCKED_DANGEROUS in CPython
 * and was READ_ONLY here) - the port re-opens the boundary for exactly those code
 * points, which is what PY_WORD_STALE is for.
 */
const PY_WORD = "[\\p{L}\\p{N}_]";
const PY_WORD_STALE =
    "[\\u{1c89}\\u{1c8a}\\u{a7cb}-\\u{a7cd}\\u{a7da}-\\u{a7dc}"
    + "\\u{105c0}-\\u{105f3}\\u{10d40}-\\u{10d65}\\u{10d6f}-\\u{10d85}\\u{10ec2}-\\u{10ec7}"
    + "\\u{11380}-\\u{11389}\\u{1138b}\\u{1138e}\\u{11390}-\\u{113b5}\\u{113b7}\\u{113d1}"
    + "\\u{113d3}\\u{116d0}-\\u{116e3}\\u{11bc0}-\\u{11be0}\\u{11bf0}-\\u{11bf9}"
    + "\\u{13460}-\\u{143fa}\\u{16100}-\\u{1611d}\\u{16130}-\\u{16139}\\u{16d40}-\\u{16d6c}"
    + "\\u{16d70}-\\u{16d79}\\u{18cff}\\u{1ccf0}-\\u{1ccf9}\\u{1e5d0}-\\u{1e5ed}"
    + "\\u{1e5f0}-\\u{1e5fa}]";
const PY_WORD_DOT = "[\\p{L}\\p{N}_.]";

/**
 * CPython `\s` for `str` patterns == `str.isspace()`: 29 BMP codepoints, none astral.
 * The set is §M's measured `PY_ISSPACE`; the class is rendered from it here instead of
 * re-typed, so the `\s` class and `str.strip()`'s character set cannot drift apart.
 */
const PY_SPACE =
    "[" + [...PY_ISSPACE].map((cp) => "\\u" + cp.toString(16).padStart(4, "0")).join("") + "]";

/** `\b` immediately BEFORE a word char: previous char is not a py word char (or none). */
const PY_B_BEFORE = `(?: (?<!${PY_WORD}) | (?<=${PY_WORD_STALE}) )`.replace(/ /g, "");
/** `\b` immediately AFTER a word char: next char is not a py word char (or none). */
const PY_B_AFTER = `(?: (?!${PY_WORD}) | (?=${PY_WORD_STALE}) )`.replace(/ /g, "");
/** `(?<![\w.])`: previous char is neither a py word char nor `.` (or none). */
const PY_NOT_WORD_DOT_BEFORE = `(?: (?<!${PY_WORD_DOT}) | (?<=${PY_WORD_STALE}) )`.replace(/ /g, "");

/**
 * Characters CPython's `re.IGNORECASE` folds onto an ASCII letter but V8's `/i`
 * does not: measured per letter over the WHOLE BMP (tmp/brows_icase_sets.json, from
 * tmp/brows_oracle_py.py) exactly three of the 24 letters the patterns use differ, by
 * exactly these code points; and the above-BMP scan (tmp/brows_oracle_full.json,
 * `above_icase_nonempty`) found no code point above the BMP that folds onto any of
 * them, so this table is complete rather than a BMP-sized guess.
 */
const CI_EXTRA: Record<string, string> = {
    i: "\u0130\u0131",
    k: "\u212a",
    s: "\u017f",
};

/**
 * Expand every ASCII letter of a regex SOURCE into the class CPython's IGNORECASE
 * actually matches. Letters inside `[...]` and inside escapes are left alone - a
 * nested `[` would change what the class means - which is why this walks the
 * source instead of running a replace over it.
 */
function ciExpand(src: string): string {
    let out = "";
    let inClass = false;
    let escaped = false;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i] as string;
        if (escaped) { out += ch; escaped = false; continue; }
        if (ch === "\\") { out += ch; escaped = true; continue; }
        if (inClass) {
            if (ch === "]") inClass = false;
            out += ch;
            continue;
        }
        if (ch === "[") { inClass = true; out += ch; continue; }
        if (ch >= "a" && ch <= "z") {
            const extra = (CI_EXTRA[ch] ?? "").replace(/[[\\\]]/g, (c) => "\\" + c);
            out += `[${ch}${ch.toUpperCase()}${extra}]`;
            continue;
        }
        out += ch;
    }
    return out;
}

/** Compile a token source (@B/@A/@NWD/@S/@W) into a CPython-semantics RegExp. */
function pyRe(src: string): RegExp {
    const s = src
        .replace(/@B/g, PY_B_BEFORE)
        .replace(/@A/g, PY_B_AFTER)
        .replace(/@NWD/g, PY_NOT_WORD_DOT_BEFORE)
        .replace(/@S/g, PY_SPACE)
        .replace(/@W/g, PY_WORD);
    return new RegExp(ciExpand(s), "u");
}

/**
 * 危险模式特征正则（拦截高危数据外发、恶意重定向、原生沙箱逃逸）
 * One entry per Python pattern; the Python original is quoted on each line so the
 * mapping is auditable, and `re.IGNORECASE` is carried by ciExpand (NOT by a JS
 * `/i` flag - see D3 in the header).
 */
export const DANGEROUS_PATTERNS: RegExp[] = [
    pyRe(String.raw`@Bdocument@S*\.@S*cookie@A`), // \bdocument\s*\.\s*cookie\b
    pyRe(String.raw`@Blocalstorage@S*\.@S*clear@S*\(`), // \blocalStorage\s*\.\s*clear\s*\(
    pyRe(String.raw`@Bsessionstorage@S*\.@S*clear@S*\(`), // \bsessionStorage\s*\.\s*clear\s*\(
    pyRe(String.raw`(?:window@S*\.@S*)?location@S*=@S*['"]javascript:`), // (?:window\s*\.\s*)?location\s*=\s*['"]javascript:
    pyRe(String.raw`@NWDeval@S*\(`), // (?<![\w\.])eval\s*\(
    pyRe(String.raw`(?:@NWDnew@S+function@S*\(|@NWDfunction@S*\()`), // (?:(?<![\w\.])new\s+Function\s*\(|(?<![\w\.])Function\s*\()
];

/** 修改状态动作特征正则 */
export const MUTATING_PATTERNS: RegExp[] = [
    pyRe(String.raw`\.click\(\)`), // \.click\(\)
    pyRe(String.raw`\.submit\(\)`), // \.submit\(\)
    pyRe(String.raw`\.value@S*=`), // \.value\s*=
    pyRe(String.raw`\.checked@S*=`), // \.checked\s*=
    pyRe(String.raw`\.innerhtml@S*=`), // \.innerHTML\s*=
    pyRe(String.raw`\.innertext@S*=`), // \.innerText\s*=
    pyRe(String.raw`\.dispatchevent\(`), // \.dispatchEvent\(
    pyRe(String.raw`history\.pushstate`), // history.pushState
];

/** 安全允许的 URL 协议头 */
export const ALLOWED_SCHEMES: readonly string[] = [
    "http://", "https://", "file://", "about:blank", "chrome-devtools://",
];

/**
 * python truthiness (`bool(x)`) is §M's `py_truth` (imported above), NOT a local copy:
 * the mirror layer already carries the CPython faces this module can reach (NaN is true,
 * an empty dict/list is false) and task #124/#125 history shows a re-typed private truth
 * mirror is where wrong-faces get introduced.
 */

/** python `str.isprintable()`: false for Cc/Cf/Cs/Co/Cn/Zl/Zp/Zs, except U+0020. */
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
function pyIsPrintable(ch: string): boolean {
    if (ch === " ") return true;
    return !NON_PRINTABLE.test(ch);
}

const HEX = "0123456789abcdef";
/** python's shortest escape form for a non-printable codepoint: \xNN / \uXXXX / \UXXXXXXXX. */
function pyEscapeCodepoint(cp: number): string {
    const digit = (n: number) => HEX[(cp >> n) & 0xf];
    if (cp <= 0xff) return "\\x" + digit(4) + digit(0);
    if (cp <= 0xffff) return "\\u" + digit(12) + digit(8) + digit(4) + digit(0);
    return "\\U" + digit(28) + digit(24) + digit(20) + digit(16) + digit(12) + digit(8) + digit(4) + digit(0);
}

/** python `repr(str)`: quote switch + `\n\r\t\\` + the escaped non-printables. */
function pyReasonReprStr(s: string): string {
    const hasSingle = s.includes("'");
    const hasDouble = s.includes('"');
    const q = hasSingle && !hasDouble ? '"' : "'";
    let out = q;
    for (const ch of s) {
        if (ch === "\\") out += "\\\\";
        else if (ch === q) out += "\\" + q;
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (pyIsPrintable(ch)) out += ch;
        else out += pyEscapeCodepoint(ch.codePointAt(0) as number);
    }
    return out + q;
}

/**
 * python `str(float)` (the repr form): shortest round-trip digits rendered with
 * CPython's rules - exponent form unless the decimal point sits in (-4, 16], a
 * minimum of two exponent digits, and always a `.` or an exponent so a float never
 * prints like an int. JS `String()` already yields the shortest digits; only the
 * spelling differs.
 */
function pyFloatStr(v: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    const neg = v < 0 || Object.is(v, -0);
    const raw = String(Math.abs(v));
    let digits = "";
    let decpt = 0;
    const eIdx = raw.indexOf("e");
    const mant = eIdx < 0 ? raw : raw.slice(0, eIdx);
    const exp10 = eIdx < 0 ? 0 : Number(raw.slice(eIdx + 1));
    const dot = mant.indexOf(".");
    if (dot < 0) {
        digits = mant;
        decpt = mant.length + exp10;
    } else {
        const ip = mant.slice(0, dot);
        digits = ip + mant.slice(dot + 1);
        decpt = ip.length + exp10;
    }
    while (digits.startsWith("0")) { digits = digits.slice(1); decpt -= 1; }
    digits = digits.replace(/0+$/, "");
    if (digits === "") { digits = "0"; decpt = 1; }
    let body: string;
    if (decpt <= -4 || decpt > 16) {
        const e = decpt - 1;
        const coeff = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits[0];
        const ad = Math.abs(e);
        body = coeff + "e" + (e < 0 ? "-" : "+") + (ad < 10 ? "0" : "") + String(ad);
    } else if (decpt <= 0) {
        body = "0." + "0".repeat(-decpt) + digits;
    } else if (decpt >= digits.length) {
        body = digits + "0".repeat(decpt - digits.length) + ".0";
    } else {
        body = digits.slice(0, decpt) + "." + digits.slice(decpt);
    }
    return (neg ? "-" : "") + body;
}

/** python `repr(x)` for the JSON-shaped values a JS caller can hand in. */
function pyReasonRepr(v: unknown): string {
    if (typeof v === "string") return pyReasonReprStr(v);
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatStr(v);
    if (Array.isArray(v)) return "[" + v.map(pyReasonRepr).join(", ") + "]";
    const parts: string[] = [];
    for (const k of Object.keys(v as object)) {
        parts.push(pyReasonReprStr(k) + ": " + pyReasonRepr((v as Record<string, unknown>)[k]));
    }
    return "{" + parts.join(", ") + "}";
}

/**
 * python `str(x)`: scalars print themselves, containers print their `repr`.
 * This one is deliberately LOCAL and renamed away from §M's `py_str`: §M's
 * `py_float_repr` is `String(x)` + `.0`, which does not reproduce CPython's exponent
 * spelling (`str(1e-5)` is "1e-05"), and this module's only observable channel for a
 * number is the reason string that echoes it (D7, tmp/brows_repr_diff.txt). Importing
 * §M's formatter here would reintroduce a measured divergence, so the gap is escalated
 * as a §M defect instead (see tmp/brows_STATE.md), and the local helper carries a name
 * that says so.
 */
function pyReasonStr(v: unknown): string {
    if (typeof v === "string") return v;
    return pyReasonRepr(v);
}

/** python `s[:n]` counts codepoints, not UTF-16 units. */
function pySlice(s: string, n: number): string {
    const chars = Array.from(s);
    return chars.length > n ? chars.slice(0, n).join("") : s;
}

/**剔除 JavaScript 单行/多行注释与字符串字面量，暴露纯粹的语法执行结构。*/
export function strip_comments_and_strings(code: string): string {
    const pattern = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;
    return code.replace(pattern, " ");
}

export class BrowserPolicyGuard {
    /** 对将要被 evaluate 的 JS 脚本进行安全性与副作用分级。 */
    static classify_script(
        js_code: unknown,
        ast_verdict?: unknown,
    ): [ScriptExecutionTier, unknown] {
        if (
            py_truth(ast_verdict) && ast_verdict !== null && typeof ast_verdict === "object"
            && !Array.isArray(ast_verdict)
        ) {
            const o = ast_verdict as Record<string, unknown>;
            const tier = "tier" in o ? o["tier"] : undefined;
            const tiers: unknown[] = [
                ScriptExecutionTier.BLOCKED_DANGEROUS,
                ScriptExecutionTier.MUTATING,
                ScriptExecutionTier.READ_ONLY,
            ];
            if (tiers.includes(tier)) {
                const reason = "reason" in o ? o["reason"] : "External AST verdict";
                return [tier as ScriptExecutionTier, reason];
            }
        }

        const code = py_strip(py_truth(js_code) ? pyReasonStr(js_code) : "");
        if (code === "") {
            return [ScriptExecutionTier.READ_ONLY, "Empty script"];
        }

        // 静态词法净化：剔除注释与字符串字面量，保留真实执行语义
        const stripped_code = strip_comments_and_strings(code);

        // 1. 优先校验是否存在阻断级危险模式
        for (const pat of DANGEROUS_PATTERNS) {
            const match = pat.exec(stripped_code);
            if (match) {
                return [
                    ScriptExecutionTier.BLOCKED_DANGEROUS,
                    `Blocked dangerous pattern: '${match[0]}'`,
                ];
            }
        }

        // 2. 校验是否存在状态修改模式
        for (const pat of MUTATING_PATTERNS) {
            const match = pat.exec(stripped_code);
            if (match) {
                return [
                    ScriptExecutionTier.MUTATING,
                    `Mutating action detected: '${match[0]}'`,
                ];
            }
        }

        // 3. 默认为只读查询
        return [ScriptExecutionTier.READ_ONLY, "Read-only DOM query"];
    }

    /** 校验导航目标 URL 的协议安全合规性。 */
    static validate_url(url: unknown): [boolean, string] {
        // D8: CPython's `str.lower()`, NOT `String.prototype.toLowerCase()` - 27 code
        // points are lowercase in CPython 3.13's UCD and get folded by V8's newer one
        // (measured code point by code point: tmp/lead_brows_lower_diff.txt), and the
        // reason text echoes the lowered URL, so this is an observable public face.
        const u = py_lower(py_strip(py_truth(url) ? pyReasonStr(url) : ""));
        if (u === "") {
            return [false, "URL 不能为空"];
        }

        for (const bad of ["javascript:", "vbscript:", "data:text/html"]) {
            if (u.startsWith(bad)) {
                return [false, `Blocked unsafe URL scheme: ${pySlice(u, 30)}`];
            }
        }

        for (const allowed of ALLOWED_SCHEMES) {
            if (u.startsWith(allowed)) {
                return [true, "Valid URL scheme"];
            }
        }

        return [false, `Unsupported URL protocol: ${pySlice(u, 20)}`];
    }
}

// PORT STATUS: confidence=high todos=[0]
