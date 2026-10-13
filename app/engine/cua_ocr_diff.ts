/**
 * cua_ocr_diff.ts — OCR 反馈 diff 化：只把屏幕上"变化的部分"回传给模型.
 *
 * Ported from `app/backend/cua_ocr_diff.py` (193 lines).
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/cua_ocr_diff.py -> app/engine/cua_ocr_diff.ts
 *   §2  behaviour: row-level diff via the verbatim difflib port
 *       (SequenceMatcher, autojunk=False); strict-greater "almost unchanged"
 *       gate at similarity > 0.95 (exactly 0.95 counts as changed); the
 *       latent first-frame quirk — an EMPTY baseline followed by a real
 *       frame is reported as 首帧 again, because diff_ocr_lines keys the
 *       first-frame branch off `not prev_n`, not off the state flag; the
 *       double display caps (12 rows / 600 CODEPOINTS, prefix included,
 *       checked BEFORE appending so a long line is dropped whole);
 *       `result.is_first_frame = True` mutation in update_from_lines even
 *       when the both-empty result came back unchanged_screen.
 *   §2  round(similarity, 3) is Python's correctly-rounded half-EVEN decimal
 *       rounding of the exact binary double (13/16 = 0.8125 -> 0.812, not
 *       toFixed's 0.813); pyRound3 does BigInt exact-rational arithmetic.
 *       pct = int(round(sim*100)) reuses half-even banker's rounding.
 *   §2  update_from_ocr keeps the `item.get("text", "")` nuance: a PRESENT
 *       but null text yields str(None) == "None", which survives the empty
 *       filter and becomes a real diff line.
 *   §M  mirror single-source law: `py_str`/`py_strip`/`py_truth`/`py_iter`/
 *       `PyTypeErrorP` come from `./server/http_server_keys.js`; a private copy
 *       of any of these was measured to flip verdicts. Consequences pinned here
 *       because they are this module's observable behaviour: `str()` of a
 *       container is its CPython repr and of a float the float-repr
 *       (`nan`/`inf`), `str.strip()` trims 0x1c–0x1f and 0x85 but NOT 0xfeff
 *       (unlike JS `trim()`), and `bool(float('nan'))` is True.
 *   §2  CPython enforces the call signature at the call site; `pyArity()`
 *       reproduces the exact TypeError wordings, including the class-qualified
 *       method names and the fact that a bound `self` counts toward "takes N
 *       positional arguments" but never toward the missing-argument list
 *       (evidence: tmp/cuaocr_STATE.md §3, tmp/cuaocr_z_evidence2.txt).
 *       Guards read `arguments.length`, so `Function.length` still reports the
 *       declared arity (the `sf#callable_*` face).
 *   DIVERGENCE(port): python dataclasses become plain objects/classes with
 *       the same fields; tuple returns become 2-element arrays. No
 *       observable change.
 *
 * 连续动作场景下，两次 OCR 文本九成相同——本模块维护"上一次 OCR 行集"，
 * 反馈摘要里只出现增/删/改的行；屏幕几乎没变时输出单行结论。
 */

import { SequenceMatcher } from "./difflib.js";
import {
    PyTypeErrorP,
    py_iter,
    py_str,
    py_strip,
    py_truth,
} from "./server/http_server_keys.js";

/** 行集相似度超过该值视为"屏幕几乎未变"——单行输出，不再罗列变化。
 *  严格大于：恰好 0.95 也算有变化（边界留给真实改动）。 */
export const UNCHANGED_SIMILARITY = 0.95;

/** 变化行的展示上限（行数/字符数双闸），与 cua_actions 的 OCR 摘要预算同思路。 */
export const DIFF_MAX_LINES = 12;
export const DIFF_MAX_CHARS = 600;

const PREFIX_ADD = "[+] ";
const PREFIX_DEL = "[-] ";
const PREFIX_MOD = "[~] ";

/** CPython 的 `', '.join` + 末位 `', and '`（≥3 项带牛津逗号，2 项是 `'a' and 'b'`）。
 *  实测文案表见 tmp/cuaocr_STATE.md §3（本机钉住的解释器）。 */
function joinNames(names: readonly string[]): string {
    if (names.length === 1) return names[0] ?? "";
    if (names.length === 2) return (names[0] ?? "") + " and " + (names[1] ?? "");
    return names.slice(0, -1).join(", ") + ", and " + (names[names.length - 1] ?? "");
}

/** 调用签名检查：JS 忽略缺参/多参，CPython 在调用点就抛 TypeError。
 *  `selfCount` 是**已绑定**的 `self` 个数：CPython 的 "takes N positional arguments"
 *  把 self 计入 N，缺参列表则不含 self（证据：`OcrDiffState.reset()` 报
 *  "takes 1 positional argument but 2 were given"）。 */
function pyArity(
    qualName: string,
    params: readonly string[],
    selfCount: number,
    given: number,
): void {
    const missing = params.slice(Math.max(0, given));
    if (missing.length > 0) {
        throw new PyTypeErrorP(
            `${qualName}() missing ${missing.length} required positional ` +
                `${missing.length === 1 ? "argument" : "arguments"}: ` +
                joinNames(missing.map((p) => `'${p}'`)),
        );
    }
    const takes = params.length + selfCount;
    const got = given + selfCount;
    if (got > takes) {
        throw new PyTypeErrorP(
            `${qualName}() takes ${takes} positional ${takes === 1 ? "argument" : "arguments"} ` +
                `but ${got} ${got === 1 ? "was" : "were"} given`,
        );
    }
}

/** python len(): 码点数。 */
function pyLen(s: string): number {
    return Array.from(s).length;
}

/** python float 的精确十进制 half-even 舍入到 ndigits=3（BigInt 精确有理数，
 *  避免 toFixed 的 half-up 偏差）。输入为非负有限 double（ratio ∈ [0,1]）。 */
export function pyRound3(x: number): number {
    if (!Number.isFinite(x)) {
        return x; // python round(inf,3)=inf, round(nan,3)=nan
    }
    const neg = x < 0;
    const ax = Math.abs(x);
    // 精确分解 double: ax = m * 2^e2（m 为 53-bit 整数）
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, ax);
    const bits = new DataView(buf).getBigUint64(0);
    const exp = Number((bits >> 52n) & 0x7fffn);
    let m: bigint;
    let e2: number;
    if (exp === 0) {
        m = bits & ((1n << 52n) - 1n);
        e2 = -1074;
    } else {
        m = (bits & ((1n << 52n) - 1n)) | (1n << 52n);
        e2 = exp - 1075;
    }
    // N / D = ax * 1000
    let n = m * 1000n;
    let d = 1n;
    if (e2 >= 0) {
        n <<= BigInt(e2);
    } else {
        d = 1n << BigInt(-e2);
    }
    let q = n / d; // BigInt 除法：向零截断（n≥0 ⇒ floor）
    const r = n % d;
    const twice = 2n * r;
    if (twice > d) {
        q += 1n;
    } else if (twice === d) {
        if (q % 2n !== 0n) q += 1n; // half-even
    }
    const out = Number(q) / 1000;
    return neg ? -out : out;
}

/** python int(round(v))：无 ndigits 的 half-even 取整，NaN/±Inf 抛源错误。 */
export function pyIntRound(v: number): number {
    if (Number.isNaN(v)) {
        throw new Error("ValueError: cannot convert float NaN to integer");
    }
    if (!Number.isFinite(v)) {
        throw new Error("OverflowError: cannot convert float infinity to integer");
    }
    const f = Math.floor(v);
    const diff = v - f; // 对 |v|<128 的 double 精确
    let r: number;
    if (diff < 0.5) r = f;
    else if (diff > 0.5) r = f + 1;
    else r = f % 2 === 0 ? f : f + 1; // 恰好 .5：取偶
    return r;
}

/** 一次行级 diff 的完整产物：变化行、统计量、两个快捷判定位。 */
export interface OcrDiffResult {
    changed_lines: string[];
    stats: Record<string, number>;
    unchanged_screen: boolean;
    is_first_frame: boolean;
}

/** 归一化行集：转字符串、去首尾空白、丢空行——OCR 噪声的第一道滤网。 */
function normLines(texts: unknown): string[] {
    const out: string[] = [];
    const src: readonly unknown[] = py_truth(texts) ? py_iter(texts) : [];
    for (const t of src) {
        const s = py_strip(py_str(t));
        if (s) {
            out.push(s);
        }
    }
    return out;
}

function isPyDict(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 对两帧 OCR 行集做行级 diff：返回（变化行, 统计）。
 *  变化行带前缀 [+]/[-]/[~]；相似度超阈值时 unchanged_screen 且变化行为空。
 *  纯函数，不改任何入参。 */
export function diffOcrLines(prev: unknown, curr: unknown): OcrDiffResult {
    pyArity("diff_ocr_lines", ["prev", "curr"], 0, arguments.length);
    const prevN = normLines(prev);
    const currN = normLines(curr);

    if (prevN.length === 0 && currN.length === 0) {
        return {
            changed_lines: [],
            stats: { added: 0, removed: 0, changed: 0, similarity: 1.0, prev_lines: 0, curr_lines: 0 },
            unchanged_screen: true,
            is_first_frame: false,
        };
    }

    // 首帧：没有基线，整屏都是"新增"，但这是建基线不是真变化。
    if (prevN.length === 0) {
        return {
            changed_lines: currN.map((line) => PREFIX_ADD + line),
            stats: {
                added: currN.length, removed: 0, changed: 0,
                similarity: 0.0, prev_lines: 0, curr_lines: currN.length,
            },
            unchanged_screen: false,
            is_first_frame: true,
        };
    }

    const matcher = new SequenceMatcher(null, prevN, currN, false);
    const similarity = matcher.ratio();

    if (similarity > UNCHANGED_SIMILARITY) {
        return {
            changed_lines: [],
            stats: {
                added: 0, removed: 0, changed: 0,
                similarity: pyRound3(similarity),
                prev_lines: prevN.length, curr_lines: currN.length,
            },
            unchanged_screen: true,
            is_first_frame: false,
        };
    }

    const changed: string[] = [];
    let added = 0;
    let removed = 0;
    let modded = 0;
    for (const [tag, i1, i2, j1, j2] of matcher.getOpcodes()) {
        if (tag === "equal") {
            continue;
        }
        if (tag === "delete") {
            for (const line of prevN.slice(i1, i2)) {
                changed.push(PREFIX_DEL + line);
                removed += 1;
            }
        } else if (tag === "insert") {
            for (const line of currN.slice(j1, j2)) {
                changed.push(PREFIX_ADD + line);
                added += 1;
            }
        } else {
            // replace：旧→新成对记 [~]，多出来的部分各自记 [+]/[-]
            const pairs = Math.min(i2 - i1, j2 - j1);
            for (let k = 0; k < pairs; k++) {
                changed.push(PREFIX_MOD + currN[j1 + k]);
                modded += 1;
            }
            for (const line of prevN.slice(i1 + pairs, i2)) {
                changed.push(PREFIX_DEL + line);
                removed += 1;
            }
            for (const line of currN.slice(j1 + pairs, j2)) {
                changed.push(PREFIX_ADD + line);
                added += 1;
            }
        }
    }

    return {
        changed_lines: changed,
        stats: {
            added, removed, changed: modded,
            similarity: pyRound3(similarity),
            prev_lines: prevN.length, curr_lines: currN.length,
        },
        unchanged_screen: false,
        is_first_frame: false,
    };
}

/** 把 diff 结果渲染成反馈摘要：首行计数标记，随后是（限量后的）变化行。 */
export function renderOcrDiff(result: OcrDiffResult): string {
    pyArity("render_ocr_diff", ["result"], 0, arguments.length);
    if (result.is_first_frame) {
        const n = result.stats["added"] ?? 0;
        return `屏幕观察(首帧): 基线已建立（${n} 行），下一步起只回传屏幕变化`;
    }
    if (result.unchanged_screen) {
        const pct = pyIntRound((result.stats["similarity"] ?? 1.0) * 100);
        return `屏幕几乎未变（相似度 ${pct}%），无需重读屏幕内容`;
    }

    const stats = result.stats;
    let header = `屏幕变化: +${stats["added"] ?? 0} 行 / -${stats["removed"] ?? 0} 行`;
    if (stats["changed"]) {
        header += ` / ~${stats["changed"]} 行改动`;
    }

    const shown: string[] = [];
    let used = 0;
    for (const line of result.changed_lines) {
        if (shown.length >= DIFF_MAX_LINES || used + pyLen(line) > DIFF_MAX_CHARS) {
            break;
        }
        shown.push(line);
        used += pyLen(line);
    }

    const dropped = result.changed_lines.length - shown.length;
    const tail = dropped
        ? `\n（另有 ${dropped} 行变化未展示，需要全貌请调 screenshot）`
        : "";
    return [header, ...shown].join("\n") + tail;
}

/** 一个观察目标的滚动基线：记住上一次 OCR 行集，每帧产出 diff 摘要。
 *  每台桌面目标 / 每个浏览器标签各持一个实例；目标切换或会话结束时调
 *  reset() 清基线，避免跨屏幕错比。 */
export class OcrDiffState {
    last_lines: string[] = [];
    has_baseline: boolean = false;

    updateFromLines(texts: unknown): [string, OcrDiffResult] {
        pyArity("OcrDiffState.update_from_lines", ["texts"], 1, arguments.length);
        const curr = normLines(texts);
        if (!this.has_baseline) {
            const result = diffOcrLines([], curr);
            // 首帧空屏（如 OCR 失败）也按"建基线"报告，而不是误导性的"屏幕几乎未变"
            result.is_first_frame = true;
            this.last_lines = curr;
            this.has_baseline = true;
            return [renderOcrDiff(result), result];
        }
        const result = diffOcrLines(this.last_lines, curr);
        this.last_lines = curr;
        return [renderOcrDiff(result), result];
    }

    /** 便捷入口：直接喂 OCR 引擎的原始输出（与 summarize_ocr 同一提取约定）。 */
    updateFromOcr(ocrValue: unknown): [string, OcrDiffResult] {
        pyArity("OcrDiffState.update_from_ocr", ["ocr_value"], 1, arguments.length);
        const lines: string[] = [];
        if (isPyDict(ocrValue)) {
            const raw = "lines" in ocrValue ? ocrValue["lines"] : undefined;
            const items: readonly unknown[] = py_truth(raw) ? py_iter(raw) : [];
            for (const item of items) {
                if (isPyDict(item)) {
                    lines.push(py_str("text" in item ? item["text"] : ""));
                }
            }
        }
        return this.updateFromLines(lines);
    }

    /** 清基线：目标切换/会话结束后调用，下一帧重新按首帧处理。 */
    reset(): void {
        pyArity("OcrDiffState.reset", [], 1, arguments.length);
        this.last_lines = [];
        this.has_baseline = false;
    }
}

// PORT STATUS: confidence=high todos=[0]
