/**
 * stream_scrubber.ts — port of app/backend/stream_scrubber.py (unit 158, wave 7).
 *
 * SOURCE: app/backend/stream_scrubber.py (174 lines) — the cross-delta state
 * machine that filters inline <think>…</think> blocks out of a streaming
 * completion: NORMAL holds back possible tag prefixes (longest
 * suffix==prefix match), IN_THINK swallows content as reasoning, flush()
 * returns everything held back and resets. Plus the static one-shot variant
 * and the leaked-protocol-tag stripper.
 *
 * RULEBOOK CITATIONS (§ numbering as in HANDOFF_V4 / RULEBOOK)
 *   §4 naming: python spellings verbatim — strip_protocol_tags,
 *     _longest_suffix_prefix, StreamingThinkScrubber, feed, flush, scrub_static,
 *     THINK_OPEN, THINK_CLOSE, and the private _state/_buf/_drain.
 *   §2 re semantics: _PROTOCOL_TAG_PATTERN keeps python's alternation order
 *     (tool_call BEFORE tool_calls — irrelevant to the outcome here because
 *     [^>]* absorbs the tail either way, but the order is verbatim) and
 *     IGNORECASE maps to the JS i flag; sub is global on both sides.
 *   §2 keyword-only: _drain(*, final) rejects a positional call with
 *     CPython's arity wording ("takes 1 positional argument but 2 were
 *     given", self counted) — the probe pins it.
 *   §2 tuple return: feed/flush return [visible, reasoning] pairs in that
 *     order; the probe compares both components.
 *
 * QUIRKS PINNED BY THE PARITY PROBE
 *   1. feed("") and feed(None) return ("", "") WITHOUT touching the buffer;
 *      a truthy non-str (5) raises TypeError("can only concatenate str (not
 *      \"int\") to str") INSIDE _buf += delta — after the falsy gate.
 *   2. _longest_suffix_prefix returns -1 for nothing: its range starts at
 *      min(len(needle)-1, len(haystack)) so a haystack that already ENDS with
 *      needle[:k] returns k (the caller is expected to have checked
 *      containment first); k is strictly < len(needle).
 *   3. The NORMAL hold-back has three distinct arms: hold < len(buf) emits
 *      buf[:-hold] and keeps the tail; hold == len(buf) holds EVERYTHING; a
 *      no-hold buf is emitted whole. Each arm is reachable and pinned.
 *   4. flush() after flush() is a no-op returning ("", "") — the state reset
 *      to NORMAL happens even when the drain left content in _buf.
 *   5. strip_protocol_tags(None) -> "" via `if not text`; the .strip() at the
 *      end is python isspace() semantics.
 *   6. scrub_static concatenates reasoning blocks in order and runs the
 *      protocol-tag strip ONLY over the visible side.
 */

class TypeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "TypeError"; }
}

function pyMissing(fname: string, names: readonly string[]): TypeErrorP {
    const q = names.map((s) => `'${s}'`);
    const list = q.length === 1
        ? (q[0] as string)
        : q.length === 2
            ? `${q[0]} and ${q[1]}`
            : q.slice(0, -1).join(", ") + ", and " + q[q.length - 1];
    const plural = names.length === 1 ? "positional argument" : "positional arguments";
    return new TypeErrorP(`${fname}() missing ${names.length} required ${plural}: ${list}`);
}

/** python's "takes <takes> positional argument(s) but N was/were given". */
function pyTooMany(fname: string, takes: string, given: number): TypeErrorP {
    const noun = takes === "1" ? "positional argument" : "positional arguments";
    const verb = given === 1 ? "was" : "were";
    return new TypeErrorP(`${fname}() takes ${takes} ${noun} but ${given} ${verb} given`);
}

/** python str.strip() with no args: strips exactly str.isspace() code points.
 *  EVIDENCE (tmp/strsc_oracle_facts.json, pinned interpreter, measured
 *  2026-09-29): F3_strip_codepoints["U+FEFF"] = {py_isspace:false,
 *  codepoints_through:[120,65279,120]} and F3_bom_direct
 *  = {out:"<BOM>abc<BOM>", codepoints:[65279,97,98,99,65279]} — CPython KEEPS
 *  the BOM. The previous class used the JS \s shorthand, which ALSO eats
 *  U+FEFF, so strip_protocol_tags("\uFEFFabc\uFEFF") returned "abc" here while
 *  CPython returned the BOM-wrapped string. The class below is CPython's
 *  isspace() set spelled out (\x09-\x0d, \x1c-\x20, \x85, \xa0, \u1680,
 *  \u2000-\u200a, \u2028, \u2029, \u202f, \u205f, \u3000) and deliberately
 *  excludes \uFEFF, \u200b and \u2060 (all isspace()==False in CPython; the
 *  oracle rows F3_zwsp_direct / F3_wj_direct pin the latter two as kept). */
const _PY_WS_LEADING = /^[\x09-\x0d\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;
const _PY_WS_TRAILING = /[\x09-\x0d\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/;

function pyStrip(s: string): string {
    return s.replace(_PY_WS_LEADING, "").replace(_PY_WS_TRAILING, "");
}

// ── module constants ─────────────────────────────────────────────────────────

export const THINK_OPEN = "<think>";
export const THINK_CLOSE = "</think>";

const _PROTOCOL_TAG_PATTERN = /<\/?(?:longcat|tool_call|tool_calls|function_call|arg_key|arg_val|arg_value)[^>]*>/gi;

// ── strip_protocol_tags ──────────────────────────────────────────────────────

/** Strip leaked raw RPC/model protocol tags from text. */
export function strip_protocol_tags(text: unknown): string {
    if (arguments.length === 0) throw pyMissing("strip_protocol_tags", ["text"]);
    if (arguments.length > 1) throw pyTooMany("strip_protocol_tags", "1", arguments.length);
    // python: `if not text: return ""` — a truthy non-str would die inside
    // re.sub with "expected string or bytes-like object"; the falsy gate
    // returns "" for None/""/0 without touching re.
    if (typeof text === "string") {
        if (text.length === 0) return "";
        return pyStrip(text.replace(_PROTOCOL_TAG_PATTERN, ""));
    }
    if (text === null || text === undefined || text === false || (typeof text === "number" && text === 0)) return "";
    throw new TypeErrorP(`expected string or bytes-like object, got '${pyTypeNameOf(text)}'`);
}

// ── _longest_suffix_prefix ───────────────────────────────────────────────────

/** haystack 末尾与 needle 开头重合的最长长度。
 *  返回值 k 满足 haystack.endswith(needle[:k]) 且 0 <= k < len(needle)。 */
export function _longest_suffix_prefix(haystack: unknown, needle: unknown): number {
    if (arguments.length < 2) throw pyMissing("_longest_suffix_prefix", ["haystack", "needle"].slice(arguments.length));
    if (arguments.length > 2) throw pyTooMany("_longest_suffix_prefix", "2", arguments.length);
    const h = haystack as string;
    const n = needle as string;
    for (let k = Math.min(n.length - 1, h.length); k > 0; k--) {
        if (h.endsWith(n.slice(0, k))) return k;
    }
    return 0;
}

// ── StreamingThinkScrubber ───────────────────────────────────────────────────

/** 跨 delta 维持状态的内嵌思考块过滤器。 */
export class StreamingThinkScrubber {
    _state: string;
    _buf: string;

    constructor() {
        this._state = "NORMAL"; // NORMAL | IN_THINK
        this._buf = "";
    }

    /** 喂入一个 delta，返回 (visible, reasoning)。 */
    feed(delta: unknown): [string, string] {
        if (arguments.length === 0) throw pyMissing("StreamingThinkScrubber.feed", ["delta"]);
        // EVIDENCE (tmp/strsc_oracle_facts.json F9_too_many.feed_two): CPython says
        // "StreamingThinkScrubber.feed() takes 2 positional arguments but 3 were
        // given" - the qualified name AND self counted in both numbers.
        if (arguments.length > 1) throw pyTooMany("StreamingThinkScrubber.feed", "2", arguments.length + 1);
        // python `if not delta: return "", ""`. EVIDENCE (tmp/strsc_oracle_facts.json
        // F2_feed_nonstr.nan = {"exc_type":"TypeError","exc_msg":"can only concatenate
        // str (not \"float\") to str"} + F1_bool_faces): CPython's float('nan') is
        // TRUTHY (`not nan` is False), so feed(nan) falls THROUGH the gate into
        // `self._buf += nan` and raises TypeError. JS `!NaN` is TRUE (NaN is falsy),
        // so the naive `if (!delta)` wrongly returned ["", ""] — a genuine port bug,
        // fixed here by keeping NaN out of the falsy gate. The only other JS/CPython
        // truthiness disagreement (empty containers) is out of feed's declared
        // `delta: str` contract, so it is not fed (see strsc_STATE / oracle).
        if (!delta && !Number.isNaN(delta)) return ["", ""];
        if (typeof delta !== "string") {
            // python: self._buf += delta with _buf being a str
            throw new TypeErrorP(
                `can only concatenate str (not "${pyTypeNameOf(delta)}") to str`);
        }
        this._buf += delta;
        return this._drain({ final: false });
    }

    /** 流收尾：交还一切被 hold 的内容。调用后状态机复位。 */
    flush(): [string, string] {
        // EVIDENCE (tmp/strsc_oracle_facts.json F9_too_many.flush_one_arg): CPython
        // "StreamingThinkScrubber.flush() takes 1 positional argument but 2 were
        // given" - self counted, so takes=1 and given=arguments.length+1.
        if (arguments.length > 0) throw pyTooMany("StreamingThinkScrubber.flush", "1", arguments.length + 1);
        const [visible, reasoning] = this._drain({ final: true });
        let v = visible;
        let r = reasoning;
        if (this._buf) {
            if (this._state === "IN_THINK") {
                r += this._buf;
            } else {
                v += this._buf;
            }
            this._buf = "";
        }
        this._state = "NORMAL";
        return [v, r];
    }

    _drain(kw: { final: boolean }): [string, string] {
        // python: _drain(self, *, final) — keyword-only. Two distinct CPython
        // wordings, BOTH measured (tmp/strsc_oracle_facts.json F9_drain_kwonly):
        //   positional call -> "StreamingThinkScrubber._drain() takes 1
        //     positional argument but N were given" (N counts SELF, d10/d11/z07);
        //   no argument at all -> "StreamingThinkScrubber._drain() missing 1
        //     required keyword-only argument: 'final'".
        if (arguments.length === 0) {
            throw new TypeErrorP(
                "StreamingThinkScrubber._drain() missing 1 required keyword-only argument: 'final'");
        }
        if (typeof kw !== "object" || kw === null) {
            throw new TypeErrorP(
                `StreamingThinkScrubber._drain() takes 1 positional argument but ${arguments.length + 1} were given`);
        }
        const final = kw.final;
        const visibleParts: string[] = [];
        const reasoningParts: string[] = [];

        while (this._buf) {
            if (this._state === "NORMAL") {
                const idx = this._buf.indexOf(THINK_OPEN);
                if (idx >= 0) {
                    visibleParts.push(this._buf.slice(0, idx));
                    this._buf = this._buf.slice(idx + THINK_OPEN.length);
                    this._state = "IN_THINK";
                    continue;
                }
                if (final) {
                    visibleParts.push(this._buf);
                    this._buf = "";
                    break;
                }
                const hold = _longest_suffix_prefix(this._buf, THINK_OPEN);
                if (hold && hold < this._buf.length) {
                    visibleParts.push(this._buf.slice(0, this._buf.length - hold));
                    this._buf = this._buf.slice(this._buf.length - hold);
                    break; // 等下一个 delta 来决断
                }
                if (hold === this._buf.length) {
                    break; // 整个 buf 都可能是标签前缀，全部 hold
                }
                visibleParts.push(this._buf);
                this._buf = "";
                break;
            } else { // IN_THINK
                const idx = this._buf.indexOf(THINK_CLOSE);
                if (idx >= 0) {
                    reasoningParts.push(this._buf.slice(0, idx));
                    this._buf = this._buf.slice(idx + THINK_CLOSE.length);
                    this._state = "NORMAL";
                    continue;
                }
                if (final) {
                    reasoningParts.push(this._buf);
                    this._buf = "";
                    this._state = "NORMAL";
                    break;
                }
                const hold = _longest_suffix_prefix(this._buf, THINK_CLOSE);
                if (hold && hold < this._buf.length) {
                    reasoningParts.push(this._buf.slice(0, this._buf.length - hold));
                    this._buf = this._buf.slice(this._buf.length - hold);
                    break;
                }
                if (hold === this._buf.length) {
                    break;
                }
                reasoningParts.push(this._buf);
                this._buf = "";
                break;
            }
        }

        return [visibleParts.join(""), reasoningParts.join("")];
    }
}

function pyTypeNameOf(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
    }
    return typeof v;
}

// ── scrub_static ─────────────────────────────────────────────────────────────

/** 非流式版本：一次性从完整文本里剥离思考块与协议残留标签。 */
export function scrub_static(text: unknown): [string, string] {
    if (arguments.length === 0) throw pyMissing("scrub_static", ["text"]);
    if (arguments.length > 1) throw pyTooMany("scrub_static", "1", arguments.length);
    const scrubber = new StreamingThinkScrubber();
    const [visible, reasoning] = scrubber.feed(text);
    const [v2, r2] = scrubber.flush();
    const cleanVisible = strip_protocol_tags(visible + v2);
    return [cleanVisible, reasoning + r2];
}

// PORT STATUS: confidence=high todos=[0]
