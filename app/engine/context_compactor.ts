/**
 * context_compactor.ts — Ovolve 上下文压缩引擎（折叠 / Fold）
 *
 * Ported from `app/backend/context_compactor.py` (1517 lines, wave-6 TS).
 *
 * # 为什么叫「折叠」而不是 compact
 *
 * Compact 是别人的词。Ovolve 的心智模型是**把一叠纸折起来**：内容还在，只是
 * 占的地方小了，而且折痕处留了标记，随时能翻回去。所以：
 *
 * - 对用户：叫「折叠上下文」，摘要卡片叫「折痕」（fold marker）
 * - 对代码：类型仍叫 compaction（和 storage / event_bus 既有命名对齐）
 *
 * # 渐进降级折叠链（4层韧性架构）
 *
 *     1. LLM 摘要   —— 有模型就调模型，产出 Goal/Progress/Decisions/OpenIssues
 *                      四段结构（复用 memory_layer.synthesize_session）
 *     2. 启发式压缩 —— 无模型 / 模型超时 / 模型报错时，规则抽取关键信息
 *     3. 硬截断     —— 连启发式都失败（数据畸形）时，只留最近 N 轮
 *
 * 每一层失败都往下掉，绝不静默返回空摘要。
 *
 * # 防循环（三道闸）
 *
 *     · 冷却期      —— 两次折叠至少间隔 COOLDOWN_S
 *     · 连续上限    —— 连续自动折叠不超过 MAX_CONSECUTIVE 次
 *     · 增量检查    —— 上次折叠后没有新内容就不折
 *
 * 手动触发（用户点按钮 / 敲 /fold）可以**穿透冷却期和增量检查**，但仍受连续
 * 上限保护 —— 用户点十次也不该把 token 全烧在摘要上。
 *
 * # 微折叠 (microfold)
 *
 * 老的工具结果最占地方且最没用（读过的文件内容、命令输出）。微折叠只清工具
 * 结果、不动对话，成本为零，所以在正式折叠**之前**先跑一遍，往往就够了。
 *
 * # 加密
 *
 * 摘要落盘默认明文。打开 `encryption_enabled`（config.json 的
 * `compaction.encryption_enabled`）后，摘要在落库前经 `_seal` 用 CredentialCipher
 * 加密（Fernet 优先，库缺失时退化为 base64 混淆并带 `plain:` 前缀如实标记），
 * 回放路径（router._build_history）经 `_unseal` 解封。已落库的历史明文行无需
 * 迁移——`_unseal` 对无前缀内容原样返回。
 *
 * # 受保护区块（P0-3）
 *
 * 权限规则/安全策略/任务约束这类关键区块，以**结构化元数据**（消息对象上的
 * `stable_block` 字段或 metadata 里的同名键，见 `StableBlock`）声明「压缩时
 * 原样保留」。压缩器按元数据判定：不解析正文文本、不依赖模型自觉、不引入
 * 魔法标记字符串。折叠时这些区块由代码原样拼进摘要——折痕之后唯一会被
 * 回放的东西就是摘要，放别处等于丢掉；N 轮连续压缩零丢失。
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/context_compactor.py -> app/engine/context_compactor.ts.
 *       Public python names (snake_case), the report/meta key names and all
 *       user-visible strings kept verbatim.
 *   §2  every truth gate goes through pyTruth / the python `or` idiom:
 *       `bus or get_event_bus()`, `m.get("tool_name") or m.get("name") or ""`,
 *       `messages[self._flushed_upto:] or messages`, `int(count or 0)`,
 *       `synth` dict-truthiness, `if not summary` (empty string falls to the
 *       next layer), `bool(comp.get("encryption_enabled"))`.
 *   §2  present-but-null: `comp.get(key) is None` SKIPS the cast (a JSON null
 *       really stored is skipped, not defaulted) — dictGet; `raw.get("protected")
 *       is False` is a strict identity gate — only literal false blocks, null
 *       passes through to a default-protected block.
 *   §2  `m.get("role")` on a NON-dict message raises AttributeError and the
 *       enclosing comprehension lets it leak (fold has try/finally, no except) —
 *       getAttr reproduces the raise; the two comprehension sites
 *       (_find_turn_boundaries, _extract_current_goal) are deliberately
 *       dict-only, unlike `_field`/`_content_of` which also accept Row-likes.
 *   §2  `(name or "image").strip()[:120]` in _preserved_artifacts calls .strip
 *       on whatever the metadata held — a non-string leaks AttributeError out of
 *       fold(); add() reproduces the raise before JS would silently coerce.
 *   §2  `transcript_bytes` calls `.encode("utf-8")` directly on the content —
 *       list/dict/int contents raise AttributeError (leaks through
 *       should_flush_memory/fold); the string branch keeps it honest.
 *   §2  sqlite3.Row subscripts: `msg["content"]` raising (KeyError, IndexError,
 *       TypeError) is caught into the documented default — rowSubscript mirrors
 *       the three raise classes before JS would read undefined off a non-dict.
 *   §2  regex word classes: python \b/\w/\s are unicode-aware, JS's are not.
 *       pyRe() rewrites \b to the [\p{L}\p{N}_] lookaround pair, \w to that
 *       class, \s to the python isspace set (adds \x1c-\x1f \x85 \xa0 \u1680
 *       \u2000-\u200a \u2028 \u2029 \u202f \u205f \u3000 vs JS \s), and compiles
 *       with `gu` — the decision-anchor "：：" full-width space and CJK-adjacent
 *       \b in the identifier audit both hinge on this.
 *   §2  `time.time()` / `asyncio.wait_for(timeout=...)` / `from model_registry
 *       import CredentialCipher` / `from storage import get_storage` / config.json
 *       path all sit behind COMPACTOR_SEAMS — same seam discipline as
 *       command_classifier.CLASSIFIER_SEAMS and evolution._set_now_for_parity.
 *   §2  python `round(x, 2)` is round-half-even over the exact binary double —
 *       pyRound copies file_agent.ts's tested implementation (compressionRatio,
 *       chunkRatio, audit retention).
 *   §2  `int(x)` truncates toward zero, strings parse strict (no JS prefix
 *       parse) — pyIntCoerce; `min/max` clamp order in compaction_kwargs_from_config
 *       kept verbatim so a hand-edited config clamps identically.
 *   §2  string slices count CODE POINTS (`[:200]`, `[-half:]`, `[:120]`) —
 *       pySliceChar via Array.from; astral content (emoji) would shift under raw
 *       JS .slice. Unlike the classifier's 20k corpus edge, these slices shape
 *       user-visible summaries, so they are ported exactly rather than pinned.
 *
 * MIGRATION DECISIONS / DIVERGENCES (documented dispositions)
 *   DIVERGENCE(port, set iteration order): python sets iterate in hash order
 *       (PYTHONHASHSEED-randomised for str); JS Sets keep insertion order.
 *       Observable only through `', '.join(list(self._read_files)[-20:])` in the
 *       two summary sections. Insertion order is the honest port of the intent
 *       ("the files we saw, most-recent-capped"); probes keep each set to ONE
 *       member or compare as sorted. No product path depends on that order.
 *   DIVERGENCE(port, task cancellation): asyncio.wait_for CANCELS the pending
 *       summarizer on timeout; JS cannot cancel a promise — the hung summarizer
 *       keeps running to completion in the background. The fold itself behaves
 *       identically (breaks to the heuristic layer on the same tick).
 *   DIVERGENCE(port, lazy import failure classes): `from model_registry import
 *       CredentialCipher` can fail with ImportError (module absent) in python;
 *       the compiled bundle links model_registry_impl at load time, so only the
 *       constructor-failure branch stays reachable. Both paths land in the same
 *       except → warn-once print + None cipher → plaintext passthrough. The
 *       cipher factory is a seam, so probes exercise the failure exactly.
 *   DIVERGENCE(port, json.loads): python parses arbitrary-precision ints and
 *       accepts NaN/Infinity tokens; JSON.parse normalises big ints to doubles.
 *       Only reachable via a hand-mangled metadata.images payload with a >53-bit
 *       integer id; no shipped writer does that.
 *   The broad `except Exception: pass` swallows on storage.add_compaction, the
 *   bus emit, the post-fold warmup, and the provider-signal block in
 *   estimate_tokens_multi stay broad — every one is a documented fail-open
 *   enhancement ("失败不影响主流程"), not a lost error.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { Result } from "./result.js";
import { getEventBus, type Event, type EventBus } from "./event_bus.js";
import { estimateTokens, BYTES_PER_TOKEN } from "./token_estimate.js";
import { get_storage as _defaultGetStorage } from "./storage.js";
import { CredentialCipher } from "./model_registry_impl.js";

// ── python-semantics helpers (house style: file-local) ───────────────────────

class AttributeErrorP extends Error {
    constructor(obj: unknown, attr: string) {
        super(`'${pyTypeName(obj)}' object has no attribute '${attr}'`);
        this.name = "AttributeError";
    }
}

class TypeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "TypeError";
    }
}

class KeyErrorP extends Error {
    constructor(key: string) {
        super(key);
        this.name = "KeyError";
    }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (v instanceof Set) return "set";
    if (v instanceof Map) return "dict";
    if (typeof v === "function") return v.name || "function";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
    }
    return typeof v;
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "function") return true;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length > 0;
    return true;
}

function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

/** python `max(a, b)` for two numbers: b wins only when b > a (NaN loses). */
function pyMax2(a: number, b: number): number {
    return b > a ? b : a;
}

/** python `min(a, b)` for two numbers: b wins only when b < a (NaN loses). */
function pyMin2(a: number, b: number): number {
    return b < a ? b : a;
}

/** python `dict.get(key, dflt)`: present-but-null returns null, not dflt. */
function dictGet(dict: unknown, key: string, dflt: unknown = null): unknown {
    if (dict !== null && typeof dict === "object" && !Array.isArray(dict) &&
        key in (dict as Record<string, unknown>)) {
        return (dict as Record<string, unknown>)[key];
    }
    return dflt;
}

function isPyDict(v: unknown): v is JsonDict {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** python `obj.get(key)` as a method: non-dict receiver raises AttributeError
 *  (the two comprehension sites that use `.get` directly on messages). */
function getAttr(obj: unknown, key: string, dflt: unknown = null): unknown {
    if (!isPyDict(obj)) throw new AttributeErrorP(obj, "get");
    return dictGet(obj, key, dflt);
}

/** python `obj[key]` on a NON-dict: lists/strs TypeErrors on string keys,
 *  Row-like objects KeyError on missing keys; both are caught by the callers. */
function rowSubscript(obj: unknown, key: string): unknown {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        throw new TypeErrorP(`'${pyTypeName(obj)}' object is not subscriptable`);
    }
    if (!(key in (obj as JsonDict))) throw new KeyErrorP(key);
    return (obj as JsonDict)[key];
}

function dictItems(obj: unknown): Array<[string, unknown]> {
    if (!isPyDict(obj)) throw new AttributeErrorP(obj, "items");
    return Object.entries(obj as Record<string, unknown>);
}

/** python `tuple(iterable)` / `for x in v`. */
function pyIter(v: unknown): unknown[] {
    if (Array.isArray(v)) return v.slice();
    if (typeof v === "string") return Array.from(v);
    if (v instanceof Set) return Array.from(v);
    if (v instanceof Map) return Array.from(v.keys());
    if (v !== null && typeof v === "object") return Object.keys(v as object);
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not iterable`);
}

function pyRepr(v: unknown): string {
    if (typeof v === "string") {
        const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
        const esc = v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")
            .replaceAll("\r", "\\r").replaceAll("\t", "\\t");
        if (quote === "'") return "'" + esc.replaceAll("'", "\\'") + "'";
        return '"' + esc.replaceAll('"', '\\"') + '"';
    }
    return pyStr(v);
}

/** python `str(x)` (containers render through repr). */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number" || typeof v === "string") return String(v);
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Set) return "set(" + (v.size ? "{...}" : "()") + ")";
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).map((k) => pyRepr(k) + ": " + pyRepr(o[k])).join(", ") + "}";
}

/** python str.strip() with no args: strips isspace() chars. */
function pyStrip(s: string): string {
    return s.replace(/^[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/, "")
        .replace(/[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/, "");
}

/** python `int(x)`: bools are 1/0, floats truncate toward zero, strings parse
 *  strictly, anything else TypeErrors. */
function pyIntCoerce(raw: unknown): number {
    if (typeof raw === "boolean") return raw ? 1 : 0;
    if (typeof raw === "number") {
        if (Number.isNaN(raw)) throw new Error("ValueError: cannot convert float NaN to integer");
        if (!Number.isFinite(raw)) throw new Error("OverflowError: cannot convert float infinity to integer");
        return Math.trunc(raw);
    }
    if (typeof raw === "string") {
        const m = /^[ \t\n\r\f\v]*([+-]?)(0|[1-9][0-9_]*)[ \t\n\r\f\v]*$/.exec(raw);
        if (!m) throw new Error(`ValueError: invalid literal for int() with base 10: ${pyRepr(raw)}`);
        return Number((m[1] ?? "") + (m[2] ?? "").replaceAll("_", ""));
    }
    throw new TypeErrorP(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(raw)}'`);
}

/** python `float(x)` on unknown input (str/num, inf/nan tokens allowed). */
function pyFloatCoerce(raw: unknown): number {
    if (typeof raw === "boolean") return raw ? 1 : 0;
    if (typeof raw === "number") return raw;
    if (typeof raw === "string") {
        const v = pyStrip(raw);
        if (/^[+-]?inf(inity)?$/i.test(v)) return v.startsWith("-") ? -Infinity : Infinity;
        if (/^nan$/i.test(v)) return NaN;
        if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(v)) {
            throw new Error(`ValueError: could not convert string to float: ${pyRepr(raw)}`);
        }
        return Number(v);
    }
    throw new TypeErrorP(`float() argument must be a string or a real number, not '${pyTypeName(raw)}'`);
}

/** python round(x, digits): banker's rounding on a true tie over the exact
 *  binary double. Copied from the file_agent.ts house implementation. */
function pyRound(x: number, digits: number): number {
    if (!Number.isFinite(x)) return x;
    const neg = x < 0;
    const s = Math.abs(x).toFixed(digits + 20);
    const keep = s.slice(0, s.length - 20);
    const rest = s.slice(s.length - 20).replace(/0+$/, "");
    let v = Number(keep);
    let dir: "up" | "tie" | "down";
    if (rest === "") dir = "tie";
    else if (rest.charAt(0) < "5") dir = "down";
    else if (rest.charAt(0) > "5" || rest.length > 1) dir = "up";
    else dir = "tie";
    const odd = Math.round(Math.abs(v) * Math.pow(10, digits)) % 2 === 1;
    if (dir === "up" || (dir === "tie" && odd)) v += Math.pow(10, -digits);
    return Number((neg ? -v : v).toFixed(digits));
}

/** python s[:n] / s[-n:] over CODE POINTS. */
function pySliceChar(s: string, start: number | null, end: number | null): string {
    const cps = Array.from(s);
    const n = cps.length;
    let a = start === null ? 0 : start < 0 ? Math.max(0, n + start) : Math.min(n, start);
    let b = end === null ? n : end < 0 ? Math.max(0, n + end) : Math.min(n, end);
    if (b < a) b = a;
    return cps.slice(a, b).join("");
}

/** python len(s): code points. */
function pyLenChar(s: string): number {
    return Array.from(s).length;
}

// ── py regex: python-unicode \b / \w / \s, then compile with gu ──────────────

const WORD = "[\\p{L}\\p{N}_]";
const BOUNDARY = "(?:(?<=" + WORD + ")(?!" + WORD + ")|(?<!" + WORD + ")(?=" + WORD + "))";
const PYWS = "[\\t\\n\\x0b\\x0c\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";

function pyRe(source: string, flags = ""): RegExp {
    let s = source.split("\\b").join(BOUNDARY);
    s = s.split("\\w").join(WORD);
    s = s.split("\\s").join(PYWS);
    return new RegExp(s, "u" + flags);
}

/** python re.finditer as an array of {group0, group1} — one exec loop with the
 *  g flag, non-overlapping left-to-right, same as CPython. */
interface PyMatch { full: string; g1: string }
function pyFinditer(pattern: RegExp, text: string): PyMatch[] {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    const out: PyMatch[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        out.push({ full: m[0], g1: m[1] ?? "" });
        if (m[0] === "") re.lastIndex += 1;
    }
    return out;
}

/** str.format for the literal "{name}" / "{tokens}" slots in the templates. */
function pyFormat(template: string, field: string, value: string): string {
    return template.split("{" + field + "}").join(value);
}

/** print(...) onto stdout, like CPython. */
function pyPrint(s: string): void {
    process.stdout.write(s + "\n");
}

type JsonDict = Record<string, unknown>;

// ── 测试缝（时钟 / 超时 / 加密器 / storage / config 路径 / 日志） ─────────────

/** storage 上本单元用到的两个方法（运行时由 storage/domains 混入原型）。 */
type CompactorStorage = {
    last_turn_context_tokens(sid: string): number;
    add_compaction(sid: string, summary: string, tb: unknown, ta: unknown): unknown;
};

export const COMPACTOR_SEAMS = {
    /** python `time.time()` — 浮点秒。 */
    now: (): number => Date.now() / 1000,
    /** python `from storage import get_storage`。 */
    get_storage: (): CompactorStorage => _defaultGetStorage() as unknown as CompactorStorage,
    /** python `from model_registry import CredentialCipher; CredentialCipher()`。 */
    cipherFactory: (): CredentialCipher => new CredentialCipher(),
    /** python `os.path.dirname(os.path.abspath(__file__))/../config.json`。 */
    configPath: (): string => path.resolve(
        path.dirname(url.fileURLToPath(import.meta.url)), "..", "config.json"),
    /** python `log.exception(...)` — WARNING 到 stderr。 */
    logException: (msg: string, _exc: unknown): void => { console.error(msg); },
    /** python `asyncio.wait_for(..., timeout=FOLD_SUMMARY_TIMEOUT_S)`。 */
    waitFor: async <T>(p: Promise<T>, timeoutS: number): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                p,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        const e: Error & { __pyTimeout?: boolean } = new Error("timeout");
                        e.name = "TimeoutError";
                        e.__pyTimeout = true;
                        reject(e);
                    }, timeoutS * 1000);
                }),
            ]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    },
};

// ── 常量 ─────────────────────────────────────────────────────────────────────

/** 第 1 层 LLM 摘要的单次调用上限（秒）。超时按"模型失败"处理——立即降到
 *  启发式层，不重试。量级依据：审计重试最坏 3 次调用，90s × 3 = 270s 的
 *  折叠最坏路径仍有界（与业界压缩超时的 300s 同档），而无限等待会拖死回合。 */
export let FOLD_SUMMARY_TIMEOUT_S = 90.0;

/** 探针缝：rebinds the python module global of the same name. */
export function _set_fold_summary_timeout_s(v: number): void {
    FOLD_SUMMARY_TIMEOUT_S = v;
}

/** 工具结果里可以安全清掉的工具 —— 这些的输出是"读过就没用了"的一次性内容。 */
export const FOLDABLE_TOOLS = new Set<string>([
    "read_file", "write_file", "edit_file", "list_dir", "grep", "glob",
    "run_command", "bash", "web_search", "web_fetch", "semantic_search",
]);

/** 工具结果被微折叠后留下的占位符。保留工具名，让模型知道"这里发生过什么"。 */
export const FOLD_PLACEHOLDER = "[内容已折叠 — 如仍需要请重新读取]";

/** 折叠后必须原样保留的附件占位行。 */
export const IMAGE_FOLD_PLACEHOLDER = "[图片已折叠：{name}]";

/** 占位行在摘要里的小标题。 */
export const PRESERVED_SECTION_TITLE = "### 折叠时保留的附件引用";

/** 参数里不该进摘要的字段（正文/代码，又长又容易泄漏）。 */
export const REDACTED_ARG_FIELDS = new Set<string>([
    "content", "new_string", "old_string", "text", "body", "code", "widget_code",
]);

/** 受保护区块的语义类别注册表（归类与审计标签；未注册类别同样受保护）。 */
export const STABLE_BLOCK_KINDS = new Set<string>([
    "permission_rules", "safety_policy", "task_constraints",
]);

/** 折叠摘要里受保护区块段落的小标题。自有文案。 */
export const PROTECTED_BLOCK_SECTION_TITLE = "### 受保护规则区块（关键约束原文，压缩时按元数据保留）";

// ── 受保护区块（P0-3） ───────────────────────────────────────────────────────

/** 一个「压缩时必须原样保留」的区块声明（python frozen dataclass）。 */
export class StableBlock {
    readonly kind: string;
    readonly priority: number;
    readonly protected: boolean;
    constructor(opts: { kind?: string; priority?: number; protected?: boolean } = {}) {
        this.kind = opts.kind === undefined ? "task_constraints" : opts.kind;
        this.priority = opts.priority === undefined ? 0 : opts.priority;
        this.protected = opts.protected === undefined ? true : opts.protected;
    }
}

/** 把结构化元数据解析成 StableBlock；解析失败或显式关闭保护都返回 None。 */
export function _parse_stable_block(raw: unknown): StableBlock | null {
    if (raw instanceof StableBlock) return raw.protected ? raw : null;
    if (!isPyDict(raw)) return null;
    if (dictGet(raw, "protected") === false) return null;
    let priority: number;
    try {
        priority = pyIntCoerce(pyOr(dictGet(raw, "priority"), 0));
    } catch {
        priority = 0;
    }
    return new StableBlock({
        kind: pyStr(pyOr(dictGet(raw, "kind"), "task_constraints")),
        priority,
    });
}

/** 读一条消息的结构化保护元数据；没有标记返回 None。 */
export function stable_block_of(msg: unknown): StableBlock | null {
    if (msg === null || msg === undefined) return null;
    let metadata: unknown;
    if (isPyDict(msg)) {
        const block = _parse_stable_block(dictGet(msg, "stable_block"));
        if (block) return block;
        metadata = dictGet(msg, "metadata");
    } else {
        try {
            metadata = rowSubscript(msg, "metadata");
        } catch {
            return null;
        }
    }
    if (typeof metadata === "string") {
        try {
            metadata = JSON.parse(metadata);
        } catch {
            return null;
        }
    }
    if (isPyDict(metadata)) {
        return _parse_stable_block(dictGet(metadata, "stable_block"));
    }
    return null;
}

/** 给一条消息打上结构化保护元数据（就地修改并返回）。 */
export function mark_stable_block(msg: unknown, kind: string = "task_constraints",
                                  priority: number = 0): unknown {
    if (isPyDict(msg)) {
        (msg as JsonDict)["stable_block"] = { protected: true, kind, priority };
    }
    return msg;
}

/** 连续折叠次数用尽 —— 再折下去就是在烧钱，不是在省钱。 */
export class FoldLimitReached extends Error {
    constructor(msg?: string) {
        super(msg);
        this.name = "FoldLimitReached";
    }
}

/** 从一行的 metadata 里取出图片引用列表，兼容 dict 与 JSON 字符串。 */
export function _images_in_metadata(metadata: unknown): unknown[] {
    if (!pyTruth(metadata)) return [];
    if (typeof metadata === "string") {
        try {
            metadata = JSON.parse(metadata);
        } catch {
            return [];
        }
    }
    if (!isPyDict(metadata)) return [];
    const imgs = dictGet(metadata, "images");
    return Array.isArray(imgs) ? imgs : [];
}

// ── 引擎 ─────────────────────────────────────────────────────────────────────

export interface CompactorInit {
    max_tokens?: number;
    threshold?: number;
    emergency_threshold?: number;
    cooldown_s?: number;
    max_consecutive?: number;
    reserved_tokens?: number | null;
    tail_turns?: number;
    prune_window_tokens?: number;
    reserve_tokens_floor?: number | null;
    encryption_enabled?: unknown;
}

export class ContextCompactor {
    max_tokens: number;
    threshold: number;
    emergency_threshold: number;
    cooldown_s: number;
    max_consecutive: number;
    reserved_tokens: number;
    reserve_tokens_floor: number;
    tail_turns: number;
    prune_window_tokens: number;
    /** 由 Router 注入；本会话 id。 */
    session_id = "";
    /** 缓存谱系根（Phase 33 联动，见 py 注释）。 */
    _lineage_root = "";
    _fold_count = 0;
    encryption_enabled: boolean;
    _cipher: { encrypt(p: string): unknown; decrypt(s: string): unknown } | null = null;
    _cipher_warned = false;
    _read_files = new Set<string>();
    _modified_files = new Set<string>();
    _bus: EventBus | null = null;
    _last_fold_at = 0.0;
    _consecutive = 0;
    _folding = false;
    _folded_upto = 0;
    _total_folds = 0;
    _total_tokens_saved = 0;
    _summarizer: ((messages: unknown[]) => Promise<unknown>) | null = null;
    _memory_flush: ((messages: unknown[]) => Promise<unknown>) | null = null;
    _post_fold_warmup: ((session_id: string, query: string) => Promise<unknown>) | null = null;
    soft_threshold_tokens = 4000;
    force_flush_transcript_bytes = 2_000_000;
    _flushed_upto = 0;

    /** 消息类型白名单——折叠时必须原样保留的角色/msg_type。 */
    static readonly WHITELIST_ROLES = new Set<string>(["tool_use", "tool_result"]);
    static readonly WHITELIST_MSG_TYPES = new Set<string>(["tool_result", "cancelled_op", "image"]);

    /** 正文里图片痕迹的形态，与 image_store.placeholder 保持一致。 */
    static readonly _IMAGE_TRACE_RE = pyRe("\\[图片:\\s*([^\\]\\n]+)\\]");

    /** 折叠比下限/上限。 */
    static readonly CHUNK_RATIO_MIN = 0.15;
    static readonly CHUNK_RATIO_MAX = 0.40;

    /** 单条消息超过可用窗口的这个比例，就直接换成占位备注而不进摘要。 */
    static readonly OVERSIZED_MESSAGE_RATIO = 0.50;

    static readonly OVERSIZED_PLACEHOLDER =
        "[超大内容已折叠为备注 — 原文约 {tokens} tokens，如仍需要请重新读取来源]";

    /** 摘要里必须保留的标识符形态（详见 py 注释）。 */
    static readonly _IDENT_PATTERNS: RegExp[] = [
        pyRe("[A-Za-z0-9_\\-/\\\\.]+\\.(?:py|ts|tsx|js|jsx|md|json|yml|yaml|toml|css|html)"),
        pyRe("\\b[A-Za-z_][A-Za-z0-9_]{2,}\\s*\\("),
        pyRe("\\b(?:class|def|function)\\s+[A-Za-z_]\\w*"),
        pyRe("\\b[A-Z][A-Z0-9_]{3,}\\b"),
    ];

    /** 关键决策锚点的正则模式。 */
    static readonly _DECISION_PATTERNS: RegExp[] = [
        pyRe("(?:我|用户)决定[：:]\\s*(.+)"),
        pyRe("(?:我|用户)选择[：:]\\s*(.+)"),
        pyRe("(?:我|用户)要求[：:]\\s*(.+)"),
        pyRe("(?:我|用户)确认[：:]\\s*(.+)"),
        pyRe("(?:我|用户)说[：:]\\s*(.+)"),
        pyRe("已确认[：:]\\s*(.+)"),
        pyRe("已决定[：:]\\s*(.+)"),
        pyRe("已选择[：:]\\s*(.+)"),
        pyRe("已修复[：:]\\s*(.+)"),
        pyRe("已应用[：:]\\s*(.+)"),
        pyRe("已修改[：:]\\s*(.+)"),
        pyRe("已创建[：:]\\s*(.+)"),
        pyRe("已删除[：:]\\s*(.+)"),
        pyRe("已更新[：:]\\s*(.+)"),
        pyRe("已重构[：:]\\s*(.+)"),
        pyRe("已实现[：:]\\s*(.+)"),
        pyRe("将采用[：:]\\s*(.+)"),
        pyRe("采用[：:]\\s*(.+)"),
    ];

    /** 受保护区块段落的总 token 预算，0 = 不限。 */
    protected_block_budget_tokens: number = 0;

    /** 回合内预检的触发线。 */
    inline_precheck_ratio: number = 0.85;
    /** 被剪的工具结果保留多少字符（头尾各一半）。 */
    inline_trim_chars: number = 600;
    /** 最近这几条工具结果不剪。 */
    inline_keep_recent: number = 3;

    constructor(init: CompactorInit = {}) {
        const max_tokens = init.max_tokens === undefined ? 80_000 : init.max_tokens;
        this.max_tokens = max_tokens;
        this.threshold = init.threshold === undefined ? 0.80 : init.threshold;
        this.emergency_threshold = init.emergency_threshold === undefined ? 0.90 : init.emergency_threshold;
        this.cooldown_s = init.cooldown_s === undefined ? 15.0 : init.cooldown_s;
        this.max_consecutive = init.max_consecutive === undefined ? 5 : init.max_consecutive;
        // 15% 或 20K 取小 —— 对齐业界方案的 min(20K, max_output_tokens)。
        this.reserved_tokens = init.reserved_tokens !== undefined && init.reserved_tokens !== null
            ? init.reserved_tokens
            : Math.min(20_000, pyIntCoerce(max_tokens * 0.15));
        // 折叠后的空闲地板（py 注释详述互补语义）。
        this.reserve_tokens_floor = init.reserve_tokens_floor !== undefined && init.reserve_tokens_floor !== null
            ? init.reserve_tokens_floor
            : Math.min(8_000, pyIntCoerce(max_tokens * 0.10));
        this.tail_turns = init.tail_turns === undefined ? 2 : init.tail_turns;
        this.prune_window_tokens = init.prune_window_tokens === undefined ? 16_000 : init.prune_window_tokens;
        // 加密开关：开启后折叠摘要以密文落库。默认关。
        this.encryption_enabled = pyTruth(init.encryption_enabled === undefined ? false : init.encryption_enabled);
    }

    // ── 生命周期 ────────────────────────────────────────────────────────────

    /** 本会话的缓存作用域（prompt_cache_planner 的 lineage 语义）。 */
    cache_scope(): string {
        return pyOr(pyOr(this._lineage_root, this.session_id), "") as string;
    }

    /** 一次折叠落地后调用：递增谱系代数。 */
    note_folded(): void {
        this._fold_count += 1;
    }

    mount(bus: EventBus | null = null): void {
        this._bus = pyOr(bus, getEventBus()) as EventBus;
        this._bus.on("session_before_compact", (ev: Event) => this._on_compact(ev), 50);
    }

    /** 注入 LLM 摘要器（Router 启动时调用）。 */
    set_summarizer(fn: (messages: unknown[]) => Promise<unknown>): void {
        this._summarizer = fn;
    }

    /** 注入折叠前记忆冲刷器。 */
    set_memory_flush(fn: (messages: unknown[]) => Promise<unknown>): void {
        this._memory_flush = fn;
    }

    /** 注入折叠后记忆预热器。 */
    set_post_fold_warmup(fn: (session_id: string, query: string) => Promise<unknown>): void {
        this._post_fold_warmup = fn;
    }

    /** transcript 的 UTF-8 原始字节数——硬阈值判断用。 */
    transcript_bytes(messages: unknown[]): number {
        let total = 0;
        for (const m of messages) {
            const c = ContextCompactor._content_of(m);
            if (typeof c !== "string") throw new AttributeErrorP(c, "encode");
            total += Buffer.byteLength(c, "utf-8");
        }
        return total;
    }

    /** 折叠前要不要先冲刷记忆？返回 [决定, 原因码]。 */
    should_flush_memory(messages: unknown[]): [boolean, string] {
        if (this._memory_flush === null) return [false, "no-flusher"];
        if (messages.length <= this._flushed_upto) return [false, "no-new-content"];
        if (this.transcript_bytes(messages) >= this.force_flush_transcript_bytes) return [true, "force-bytes"];
        if (this.estimate_tokens_multi(messages) >= this.soft_threshold_tokens) return [true, "soft-tokens"];
        return [false, "under-threshold"];
    }

    /** 跑一次记忆冲刷。失败返回 0，绝不抛异常打断折叠。 */
    async flush_memory(messages: unknown[]): Promise<number> {
        if (this._memory_flush === null) return 0;
        const tail = messages.slice(this._flushed_upto);
        const fresh = pyTruth(tail) ? tail : messages;
        let count: unknown;
        try {
            count = await this._memory_flush(fresh);
        } catch (exc) {
            pyPrint(`[compactor] memory flush failed: ${exc instanceof Error ? exc.message : pyStr(exc)}`);
            return 0;
        }
        this._flushed_upto = messages.length;
        return pyIntCoerce(pyOr(count, 0));
    }

    /** `session_before_compact` 的订阅者——只在发布者自己不折叠时兜底。 */
    async _on_compact(event: Event): Promise<void> {
        if (pyTruth(dictGet(event.payload, "folds_itself"))) return;
        const sessionId = dictGet(event.payload, "session_id", "") as string;
        const messages = dictGet(event.payload, "messages", []) as unknown[];
        const manual = pyTruth(dictGet(event.payload, "manual"));
        if (!pyTruth(messages)) return;
        const result = await this.fold(sessionId, messages, manual);
        if (result.ok) {
            event.modify({ "summary": (result.value as JsonDict)["summary"], "compacted": true });
        }
    }

    // ── Token 估算 ──────────────────────────────────────────────────────────

    /** 中英混排的 token 估算——实现在 token_estimate（全后端唯一一份）。 */
    estimate_tokens(text: string): number {
        return estimateTokens(text);
    }

    /** Multi-source token estimation — take the MAXIMUM of several heuristics. */
    estimate_tokens_multi(messages: unknown[]): number {
        const estimates: number[] = [this.total_tokens(messages)];
        try {
            if (pyTruth(this.session_id)) {
                const reported = COMPACTOR_SEAMS.get_storage().last_turn_context_tokens(this.session_id);
                const text_est = estimates[0] ?? 0;
                // python 里 `reported <= max(...)` 对 str 上报值抛 TypeError，
                // 被本 try 吞掉（该信号整个作废）；bool/int/float 可比则继续。
                if (typeof reported === "string") {
                    throw new TypeErrorP(
                        `'<=' not supported between instances of 'str' and 'int'`);
                }
                if (pyTruth(reported) && (text_est === 0 || (reported as number) <= Math.max(text_est * 3, 8000))) {
                    estimates.push(pyIntCoerce(reported));
                }
            }
        } catch {
            /* fail-open: 可选增强，失败不影响主流程 */
        }
        let rawBytes = 0;
        for (const m of messages) {
            const c = ContextCompactor._content_of(m);
            if (typeof c !== "string") throw new AttributeErrorP(c, "encode");
            rawBytes += Buffer.byteLength(c, "utf-8");
        }
        if (rawBytes) estimates.push(Math.trunc(rawBytes / BYTES_PER_TOKEN));
        return estimates.length ? Math.max(...estimates) : 0;
    }

    total_tokens(messages: unknown[]): number {
        let total = 0;
        for (const m of messages) total += this.estimate_tokens(ContextCompactor._content_of(m));
        return total;
    }

    /** 兼容 dict 与 sqlite3.Row。 */
    static _content_of(msg: unknown): string {
        if (isPyDict(msg)) return pyOr(dictGet(msg, "content"), "") as string;
        let v: unknown;
        try {
            v = rowSubscript(msg, "content");
        } catch {
            return "";
        }
        return pyOr(v, "") as string;
    }

    static _field(msg: unknown, key: string, dflt: unknown = null): unknown {
        if (isPyDict(msg)) return dictGet(msg, key, dflt);
        try {
            return rowSubscript(msg, key);
        } catch {
            return dflt;
        }
    }

    // ── 触发判断 ────────────────────────────────────────────────────────────

    /** 可用于对话的 token 数 —— 总窗口减去给回复保留的 headroom。 */
    get usable_tokens(): number {
        return Math.max(1, this.max_tokens - this.reserved_tokens);
    }

    usage_ratio(messages: unknown[]): number {
        return this.estimate_tokens_multi(messages) / this.usable_tokens;
    }

    /** 要不要折叠？返回 [决定, 原因码]。手动触发穿透冷却期与增量检查。 */
    should_fold(messages: unknown[], manual: boolean = false): [boolean, string] {
        if (this._folding) return [false, "already-folding"];
        if (this._consecutive >= this.max_consecutive) return [false, "max-consecutive"];
        if (manual) {
            if (messages.length <= 2) return [false, "too-short"];
            return [true, "manual"];
        }
        const ratio = this.usage_ratio(messages);
        if (ratio < this.threshold) return [false, "under-threshold"];
        // 越过紧急线：无视冷却期。
        if (ratio < this.emergency_threshold) {
            if (COMPACTOR_SEAMS.now() - this._last_fold_at < this.cooldown_s) return [false, "cooldown"];
            if (messages.length <= this._folded_upto) return [false, "no-new-content"];
        }
        return [true, "auto"];
    }

    // ── 主入口 ──────────────────────────────────────────────────────────────

    /** 判断消息是否在折叠白名单里，不允许被摘要吞掉。 */
    static _is_whitelisted(msg: unknown): boolean {
        if (stable_block_of(msg)) return true;
        const role = getAttr(msg, "role", "") as string;
        if (ContextCompactor.WHITELIST_ROLES.has(role)) return true;
        const msgType = getAttr(msg, "msg_type", "") as string;
        if (ContextCompactor.WHITELIST_MSG_TYPES.has(msgType)) return true;
        const content = getAttr(msg, "content");
        if (Array.isArray(content)) {
            for (const block of content) {
                if (isPyDict(block) && dictGet(block, "type") === "image") return true;
            }
        }
        if (_images_in_metadata(getAttr(msg, "metadata")).length) return true;
        return false;
    }

    /** 把「折了就找不回来」的东西抽成确定性占位行。 */
    _preserved_artifacts(messages: unknown[], cap: number = 30): string[] {
        const seen = new Set<string>();
        let lines: string[] = [];

        const add = (nameRaw: unknown): void => {
            const name0 = pyOr(nameRaw, "image");
            if (typeof name0 !== "string") throw new AttributeErrorP(name0, "strip");
            const name = pySliceChar(pyStrip(name0), 0, 120);
            if (!name || seen.has(name)) return;
            seen.add(name);
            lines.push(pyFormat(IMAGE_FOLD_PLACEHOLDER, "name", name));
        };

        for (const m of messages) {
            for (const ref of _images_in_metadata(ContextCompactor._field(m, "metadata"))) {
                if (isPyDict(ref)) {
                    add(pyOr(pyOr(dictGet(ref, "name"), dictGet(ref, "id")), "image"));
                }
            }
            // 正文兜底：早期的行、以及用户上传（而非模型生成）的图片只有正文痕迹。
            for (const hit of pyFinditer(ContextCompactor._IMAGE_TRACE_RE, ContextCompactor._content_of(m))) {
                add(hit.g1);
            }
        }

        if (lines.length > cap) {
            const extra = lines.length - cap;
            lines = lines.slice(0, cap).concat([`[还有 ${extra} 张图片未列出]`]);
        }
        return lines;
    }

    /** 收集受保护区块的原文，按优先级排序去重后逐条成行。 */
    _protected_block_lines(messages: unknown[]): string[] {
        const found: Array<[number, number, string, string]> = [];
        const seen = new Set<string>();
        messages.forEach((m, order) => {
            const block = stable_block_of(m);
            if (!block) return;
            const content = pyStrip(pyOr(ContextCompactor._content_of(m), ""));
            if (!content || seen.has(content)) return;
            seen.add(content);
            found.push([block.priority, order, block.kind, content]);
        });
        if (!found.length) return [];
        // 优先级高的排前（同优先级保持首现顺序）：限预算时它们先占坑。
        found.sort((a, b) => (a[0] !== b[0] ? b[0] - a[0] : a[1] - b[1]));
        const lines: string[] = [];
        const budget = Math.max(0, pyIntCoerce(pyOr((this as unknown as JsonDict)["protected_block_budget_tokens"] ?? 0, 0)));
        let used = 0;
        for (const [priority, _order, kind, content] of found) {
            const cost = this.estimate_tokens(content);
            if (budget && used + cost > budget) continue;
            used += cost;
            lines.push(`（${kind}，优先级 ${priority}）\n${content}`);
        }
        return lines;
    }

    /** 找到所有 turn 的起始 index（折叠只允许在 turn 边界切割）。 */
    static _find_turn_boundaries(messages: unknown[]): number[] {
        const boundaries: number[] = [];
        messages.forEach((m, i) => {
            if (getAttr(m, "role") === "user"
                && !["tool_result", "tool_use"].includes(getAttr(m, "msg_type", "") as string)) {
                boundaries.push(i);
            }
        });
        return boundaries;
    }

    /** 把 messages 分成 [可折叠前段, 保留尾部] 两段。 */
    _split_for_fold(messages: unknown[]): [unknown[], unknown[]] {
        const boundaries = ContextCompactor._find_turn_boundaries(messages);
        if (boundaries.length <= this.tail_turns) {
            // 太短了，整个都是"尾部"，不拆
            return [[], messages];
        }
        // python: boundaries[-tail_turns]；tail_turns=0 时 -0 即索引 0。
        const cut = boundaries[this.tail_turns === 0 ? 0 : boundaries.length - this.tail_turns];
        return [messages.slice(0, cut), messages.slice(cut)];
    }

    /** 执行一次折叠。三层降级：LLM → 启发式 → 硬截断。 */
    async fold(sessionId: string, messages: unknown[], manual: boolean = false): Promise<Result> {
        if (!pyTruth(messages)) return Result.failure("没有可折叠的内容");

        this._folding = true;
        try {
            const tokensBefore = this.total_tokens(messages);

            // 折叠是有损的，但有些东西「损了就没了」。必须在任何变形之前抽取。
            const preserved = this._preserved_artifacts(messages);
            const protectedLines = this._protected_block_lines(messages);

            // ── Pre-compaction Memory Flush ──
            let flushed = 0;
            const [doFlush] = this.should_flush_memory(messages);
            if (doFlush) flushed = await this.flush_memory(messages);

            const chunkRatio = this.compute_adaptive_chunk_ratio(messages);
            const oversized = this.replace_oversized(messages);
            this._microfold(messages);

            let strategy = "engineering";
            let summary: string | null = null;

            // ── reserve-token 地板 ──
            const floor = Math.max(0, pyIntCoerce(this.reserve_tokens_floor));

            const meetsFloor = (candidate: string): boolean => {
                const footprint = this.estimate_tokens(candidate) + this._tail_tokens(messages);
                return this.usable_tokens - footprint >= floor;
            };

            // 第 1 层：LLM 摘要（带质量审计 + 重试）
            const MAX_AUDIT_RETRIES = 2;
            if (this._summarizer !== null) {
                for (let attempt = 0; attempt <= MAX_AUDIT_RETRIES; attempt++) {
                    try {
                        const synth = await COMPACTOR_SEAMS.waitFor(
                            this._summarizer(messages), FOLD_SUMMARY_TIMEOUT_S);
                        if (pyTruth(synth)) {
                            const candidate = this._render_llm_summary(synth as JsonDict, messages);
                            const [ok] = this.audit_summary_quality(candidate, messages);
                            if (ok || attempt === MAX_AUDIT_RETRIES) {
                                summary = candidate;
                                strategy = "llm-summary";
                                break;
                            }
                            // 审计失败，重试 — 下一次调用时模型的随机性可能保留更多标识符
                            continue;
                        }
                    } catch (exc) {
                        // 超时不重试：掉启发式（零成本、即时）。其他异常必须留痕
                        // （静默吞异常曾是 P0 事故的放大器——见 py 注释）。
                        if (exc instanceof Error && exc.name === "TimeoutError") break;
                        COMPACTOR_SEAMS.logException(
                            "[compactor] LLM summary layer failed, degrading to heuristic", exc);
                        break;
                    }
                }
            }

            // 地板未达 → 升级下一层。
            let floorEnforced = false;
            if (summary !== null && !meetsFloor(summary)) {
                summary = null;
                floorEnforced = true;
            }

            // 第 2 层：启发式
            if (!summary) {
                try {
                    summary = this._heuristic_summary(messages);
                    strategy = "engineering";
                    if (!meetsFloor(summary)) floorEnforced = true;
                } catch {
                    summary = null;  // 掉到硬截断
                }
            }

            // 第 3 层：硬截断兜底 —— keep 逐级收缩。
            if (!summary || !meetsFloor(summary)) {
                for (const keep of [5, 3, 1]) {
                    const candidate = this._truncate_summary(messages, keep);
                    summary = candidate;
                    strategy = "truncate";
                    if (meetsFloor(candidate)) break;
                }
                // L3 循环（5,3,1）必执行至少一次，此处 summary 已是 string。
                if (!meetsFloor(summary!)) floorEnforced = true;
            }

            // 占位行 / 受保护区块原样拼进摘要正文（三层产出的摘要都要过这一步）。
            if (pyTruth(protectedLines)) {
                summary = `${summary}\n\n${PROTECTED_BLOCK_SECTION_TITLE}\n` + protectedLines.join("\n");
            }
            if (pyTruth(preserved)) {
                summary = `${summary}\n\n${PRESERVED_SECTION_TITLE}\n` + preserved.join("\n");
            }

            const estimatedAfter = this.estimate_tokens(summary!);
            const footprintAfter = estimatedAfter + this._tail_tokens(messages);

            const [sealed, encrypted] = this._seal(summary!);
            try {
                COMPACTOR_SEAMS.get_storage().add_compaction(sessionId, sealed, tokensBefore, estimatedAfter);
            } catch {
                /* 落盘失败不该让折叠整体失败 —— 摘要还能返回给本轮用 */
            }

            // ── 更新防循环状态 ──
            this._last_fold_at = COMPACTOR_SEAMS.now();
            this._consecutive += 1;
            this._folded_upto = messages.length;
            this._total_folds += 1;
            this._total_tokens_saved += Math.max(0, tokensBefore - estimatedAfter);

            const report: JsonDict = {
                "summary": summary,
                "strategy": strategy,
                "tokensBefore": tokensBefore,
                "estimatedTokensAfter": estimatedAfter,
                "compressionRatio": pyRound(tokensBefore / Math.max(estimatedAfter, 1), 2),
                "encrypted": encrypted,
                "manual": manual,
                "memoryFlushed": flushed,
                "chunkRatio": chunkRatio,
                "oversizedReplaced": oversized,
                "preservedArtifacts": preserved.length,
                "protectedBlocks": protectedLines.length,
                // 地板审计：这次折叠是自然降级还是被地板强压过、折叠后空闲还剩多少。
                "reserveFloor": floor,
                "freeTokensAfter": Math.max(0, this.usable_tokens - footprintAfter),
                "floorMet": this.usable_tokens - footprintAfter >= floor,
                "floorEnforced": floorEnforced,
            };

            // Announce it so the WS bridge can show a fold card in the timeline.
            if (this._bus !== null) {
                try {
                    const frame: JsonDict = { ...report };
                    if (!("session_id" in frame)) frame["session_id"] = this.session_id ?? null;
                    await this._bus.emit("context_folded", frame);
                } catch {
                    /* fail-open: 可选增强，失败不影响主流程 */
                }
            }

            // 折叠后记忆预热（fire-and-forget 语义，失败不影响折叠本身）。
            if (this._post_fold_warmup !== null) {
                try {
                    const query = pyOr(this._extract_current_goal(messages), "") as string;
                    if (query) await this._post_fold_warmup(this.session_id, query);
                } catch {
                    /* fail-open: 可选增强，失败不影响主流程 */
                }
            }

            return Result.success(report);
        } finally {
            this._folding = false;
        }
    }

    /** 一个非折叠产生的普通轮次结束时调用——重置"连续折叠"计数。 */
    note_new_turn(): void {
        this._consecutive = 0;
    }

    // ── 自适应折叠比 + 摘要质量审计 ────────────────────────────────────────

    /** 依据消息的平均 token 占比动态决定这次吃掉多少历史。 */
    compute_adaptive_chunk_ratio(messages: unknown[]): number {
        if (!pyTruth(messages)) return ContextCompactor.CHUNK_RATIO_MIN;
        const total = this.total_tokens(messages);
        if (total <= 0) return ContextCompactor.CHUNK_RATIO_MIN;
        const avg_share = (total / messages.length) / this.usable_tokens;
        // avg_share 0.005 → MIN，0.10 → MAX，中间线性插值。
        const lo = 0.005, hi = 0.10;
        let t = (avg_share - lo) / (hi - lo);
        t = Math.max(0.0, Math.min(1.0, t));
        const ratio = ContextCompactor.CHUNK_RATIO_MIN
            + t * (ContextCompactor.CHUNK_RATIO_MAX - ContextCompactor.CHUNK_RATIO_MIN);
        return pyRound(ratio, 3);
    }

    /** 就地把超大消息换成占位备注，返回替换条数。 */
    replace_oversized(messages: unknown[]): number {
        const limit = Math.trunc(this.usable_tokens * ContextCompactor.OVERSIZED_MESSAGE_RATIO);
        let replaced = 0;
        for (const m of messages) {
            if (!isPyDict(m)) continue;
            if (ContextCompactor._is_whitelisted(m)) continue;
            const content = dictGet(m, "content");
            if (typeof content !== "string" || !content) continue;
            const cost = this.estimate_tokens(content);
            if (cost < limit) continue;
            (m as JsonDict)["content"] = pyFormat(ContextCompactor.OVERSIZED_PLACEHOLDER, "tokens", String(cost));
            replaced += 1;
        }
        return replaced;
    }

    /** 从文本里抽出关键标识符集合。 */
    _key_identifiers(text: string, cap: number = 40): Set<string> {
        const found = new Set<string>();
        for (const pat of ContextCompactor._IDENT_PATTERNS) {
            for (const m of pyFinditer(pat, text)) {
                found.add(pyStrip(m.full).replace(/\(+$/, ""));
                if (found.size >= cap) return found;
            }
        }
        return found;
    }

    /** 检查摘要有没有把关键标识符丢掉。Returns [通过与否, 诊断信息]。 */
    audit_summary_quality(summary: string, messages: unknown[],
                          minRetention: number = 0.30): [boolean, JsonDict] {
        if (!summary) return [false, { "reason": "empty-summary" }];
        const source = messages.map((m) => ContextCompactor._content_of(m)).join("\n");
        if (!source) return [true, { "reason": "no-source" }];

        const counts = new Map<string, number>();
        for (const pat of ContextCompactor._IDENT_PATTERNS) {
            for (const m of pyFinditer(pat, source)) {
                const k = pyStrip(m.full).replace(/\(+$/, "");
                counts.set(k, (counts.get(k) ?? 0) + 1);
            }
        }
        const important: string[] = [];
        for (const [k, n] of counts) if (n >= 3) important.push(k);
        if (!important.length) return [true, { "reason": "no-important-identifiers" }];

        const kept = important.filter((k) => summary.includes(k));
        const retention = kept.length / important.length;
        const lostSet = important.filter((k) => !kept.includes(k)).sort();
        const diag: JsonDict = {
            "reason": "retention",
            "importantCount": important.length,
            "keptCount": kept.length,
            "retention": pyRound(retention, 3),
            "threshold": minRetention,
            "lost": lostSet.slice(0, 10),
        };
        return [retention >= minRetention, diag];
    }

    // ── 三层实现 ────────────────────────────────────────────────────────────

    /** 把 synthesize_session 的四段结构渲染成折痕正文。 */
    _render_llm_summary(synth: JsonDict, messages: unknown[]): string {
        const sec = (title: string, key: string): string => {
            const val = dictGet(synth, key);
            if (!pyTruth(val)) return "";
            let body: string;
            if (Array.isArray(val)) {
                body = val.map((x) => `- ${pyStr(x)}`).join("\n");
            } else {
                body = pyStr(val);
            }
            return `### ${title}\n${body}\n\n`;
        };

        const parts: string[] = ["## 折痕 · 对话摘要（此前内容已折叠）\n"];
        parts.push(sec("目标", "Goal"));
        const currentGoal = this._extract_current_goal(messages);
        if (currentGoal) parts.push(`### 当前目标\n${currentGoal}\n\n`);
        parts.push(sec("进展", "Progress"));
        parts.push(sec("关键决策", "Decisions"));
        parts.push(sec("待办 / 悬而未决", "Open Issues"));
        const keyDecisions = this._extract_key_decisions(messages);
        if (keyDecisions.length) {
            parts.push("### 关键决策（锚点）\n");
            for (const d of keyDecisions.slice(0, 5)) parts.push(`- ${d}\n`);
            parts.push("\n");
        }
        if (pyTruth(this._modified_files)) {
            parts.push(`### 改动过的文件\n${[...this._modified_files].slice(-20).join(", ")}\n`);
        }
        return parts.filter((p) => pyTruth(p)).join("").trim();
    }

    /** 规则驱动的结构化摘要（无模型时的主力）。 */
    _heuristic_summary(messages: unknown[]): string {
        const parts: string[] = ["## 折痕 · 对话摘要（启发式）\n"];

        const userMsgs = messages.filter((m) => ContextCompactor._field(m, "role") === "user");
        if (userMsgs.length) {
            parts.push("### 用户诉求");
            for (const m of userMsgs.slice(-5)) parts.push(`- ${pySliceChar(ContextCompactor._content_of(m), 0, 200)}`);
            parts.push("");
        }

        const currentGoal = this._extract_current_goal(messages);
        if (currentGoal) parts.push(`### 当前目标\n${currentGoal}\n`);

        const keyDecisions = this._extract_key_decisions(messages);
        if (keyDecisions.length) {
            parts.push("### 关键决策（锚点）\n");
            for (const d of keyDecisions.slice(0, 5)) parts.push(`- ${d}\n`);
            parts.push("\n");
        }

        const asst = messages.filter((m) => ContextCompactor._field(m, "role") === "assistant");
        if (asst.length) {
            parts.push("### 关键回复");
            for (const m of asst.slice(-3)) parts.push(`- ${pySliceChar(ContextCompactor._content_of(m), 0, 300)}`);
            parts.push("");
        }

        const tools = messages.filter((m) => ContextCompactor._field(m, "msg_type") === "tool_call");
        if (tools.length) {
            parts.push("### 工具调用");
            for (const m of tools.slice(-10)) parts.push(`- ${pySliceChar(ContextCompactor._content_of(m), 0, 100)}`);
            parts.push("");
        }

        if (pyTruth(this._read_files)) {
            parts.push(`### 读过的文件\n${[...this._read_files].slice(-20).join(", ")}`);
        }
        if (pyTruth(this._modified_files)) {
            parts.push(`### 改动过的文件\n${[...this._modified_files].slice(-20).join(", ")}`);
        }

        return parts.join("\n").trim();
    }

    /** 估算折叠后仍会原文保留的尾部占用量。 */
    _tail_tokens(messages: unknown[]): number {
        if (!pyTruth(messages)) return 0;
        const userIdx: number[] = [];
        messages.forEach((m, i) => {
            if (ContextCompactor._field(m, "role") === "user") userIdx.push(i);
        });
        if (!userIdx.length) return 0;
        // python: user_idx[-tail_turns] if len>=tail else [0]；tail=0 时 -0 即索引 0。
        const cut = userIdx.length >= this.tail_turns
            ? userIdx[this.tail_turns === 0 ? 0 : userIdx.length - this.tail_turns]
            : userIdx[0];
        return this.estimate_tokens_multi(messages.slice(cut));
    }

    /** 最后兜底：连启发式都炸了，只把最近几轮原样拼起来。 */
    _truncate_summary(messages: unknown[], keep: number = 5): string {
        const tail = messages.slice(-keep);
        const lines: string[] = ["## 折痕 · 仅保留最近对话（降级兜底）\n"];
        for (const m of tail) {
            const role = ContextCompactor._field(m, "role", "?");
            lines.push(`**${pyStr(role)}**: ${pySliceChar(ContextCompactor._content_of(m), 0, 300)}`);
        }
        return lines.join("\n").trim();
    }

    /** 就地清理保鲜窗口外的工具结果，返回清理条数。 */
    _microfold(messages: unknown[]): number {
        let budget = this.prune_window_tokens;
        let cleared = 0;
        for (let idx = messages.length - 1; idx >= 0; idx--) {
            const m = messages[idx];
            if (!isPyDict(m)) continue;
            if (stable_block_of(m)) continue;  // 受保护区块永不被微折叠清掉
            if (dictGet(m, "msg_type") !== "tool_call") continue;
            const name = pyStr(pyOr(pyOr(dictGet(m, "tool_name"), dictGet(m, "name")), "")).toLowerCase();
            if (name && !FOLDABLE_TOOLS.has(name)) continue;
            const content = pyOr(dictGet(m, "content"), "") as string;
            if (content === FOLD_PLACEHOLDER) continue;
            const cost = this.estimate_tokens(content);
            if (budget - cost >= 0) {
                budget -= cost;  // 还在保鲜窗口内，留着
                continue;
            }
            (m as JsonDict)["content"] = FOLD_PLACEHOLDER;
            cleared += 1;
        }
        return cleared;
    }

    /** 从最近一轮用户消息提取当前目标（确定性，不经过 LLM）。 */
    _extract_current_goal(messages: unknown[]): string {
        const userMsgs: unknown[] = [];
        for (let idx = messages.length - 1; idx >= 0; idx--) {
            const m = messages[idx];
            if (getAttr(m, "role") === "user"
                && !["tool_result", "tool_use"].includes(getAttr(m, "msg_type", "") as string)) {
                userMsgs.push(m);
            }
        }
        if (!userMsgs.length) return "";
        const last = ContextCompactor._content_of(userMsgs[0]);
        return pySliceChar(pyStrip(last), 0, 120);
    }

    /** 从对话中提取关键决策作为确定性锚点（不经过 LLM）。 */
    _extract_key_decisions(messages: unknown[], cap: number = 5): string[] {
        const decisions: string[] = [];
        const seen = new Set<string>();
        for (const m of messages) {
            const content = ContextCompactor._content_of(m);
            if (!content || pyLenChar(content) < 5) continue;
            for (const pat of ContextCompactor._DECISION_PATTERNS) {
                for (const match of pyFinditer(pat, content)) {
                    const decision = pySliceChar(pyStrip(match.g1), 0, 120);
                    if (decision && !seen.has(decision)) {
                        seen.add(decision);
                        decisions.push(decision);
                        if (decisions.length >= cap) return decisions;
                    }
                }
            }
        }
        return decisions;
    }

    // ── 加密钩子 ────────────────────────────────────────────────────────────

    /** 惰性取 CredentialCipher 单例语义的实例；库缺失返回 None（fail-open）。 */
    _get_cipher(): ContextCompactor["_cipher"] {
        if (this._cipher !== null) return this._cipher;
        try {
            this._cipher = COMPACTOR_SEAMS.cipherFactory() as ContextCompactor["_cipher"];
        } catch (exc) {
            if (!this._cipher_warned) {
                this._cipher_warned = true;
                pyPrint(`[compactor] encryption requested but cipher unavailable: ${exc instanceof Error ? exc.message : pyStr(exc)}`);
            }
            return null;
        }
        return this._cipher;
    }

    /** 落盘前封装。返回 [入库文本, 是否已加密]。 */
    _seal(plaintext: string): [string, boolean] {
        if (!this.encryption_enabled) return [plaintext, false];
        const cipher = this._get_cipher();
        if (cipher === null) return [plaintext, false];
        const sealed = cipher.encrypt(plaintext);
        return [sealed as string, pyTruth(sealed) && sealed !== plaintext];
    }

    /** 读盘后解封。对历史明文行原样放行（CredentialCipher 的无前缀语义）。 */
    _unseal(stored: string): string {
        if (!this.encryption_enabled) return stored;
        const cipher = this._get_cipher();
        if (cipher === null) return stored;
        return cipher.decrypt(stored) as string;
    }

    // ── 文件追踪 & 统计 ─────────────────────────────────────────────────────

    track_read_file(p: string): void {
        this._read_files.add(p);
    }

    track_modified_file(p: string): void {
        this._modified_files.add(p);
    }

    get_file_stats(): JsonDict {
        return {
            "readFiles": [...this._read_files],
            "modifiedFiles": [...this._modified_files],
        };
    }

    stats(): JsonDict {
        return {
            "totalFolds": this._total_folds,
            "totalTokensSaved": this._total_tokens_saved,
            "lastFoldAt": this._last_fold_at,
            "consecutive": this._consecutive,
        };
    }

    // ── 回合内 overflow 预检 ────────────────────────────────────────────────

    /** 模型调用前预检：把超额的旧工具结果就地剪掉，剪不动就如实上报。 */
    precheck_inline(messages: unknown[], overheadTokens: number = 0): JsonDict {
        const overhead = Math.max(0, pyIntCoerce(pyOr(overheadTokens, 0)));
        const ceiling = Math.trunc(this.usable_tokens * this.inline_precheck_ratio);
        const report: JsonDict = {
            "pruned": 0, "before": overhead, "after": overhead,
            "overhead": overhead, "ceiling": ceiling,
            "fits": true, "reason": "under-threshold",
        };
        if (!pyTruth(messages)) {
            report["fits"] = overhead <= ceiling;
            if (!report["fits"]) {
                // 系统提示 + 工具定义自己就超线。剪工具结果救不了这个。
                report["reason"] = "overhead-alone-exceeds";
            }
            return report;
        }

        const before = this.estimate_tokens_multi(messages) + overhead;
        report["before"] = before;
        report["after"] = before;
        if (before <= ceiling) return report;

        // 候选：role == "tool" 的旧结果，从最老往新剪，跳过最近 N 条。
        const toolIdx: number[] = [];
        messages.forEach((m, i) => {
            if (ContextCompactor._field(m, "role") === "tool") toolIdx.push(i);
        });
        // python: tool_idx[:-keep] if keep else tool_idx。切片终点是 -keep，
        // 负值再按 python 切片语义从尾部折回（keep=-1 → [:1]）。
        const keep = this.inline_keep_recent;
        const end = -keep;
        const prunable = keep
            ? toolIdx.slice(0, end >= 0
                ? Math.min(end, toolIdx.length)
                : Math.max(0, toolIdx.length + end))
            : toolIdx;
        if (!prunable.length) {
            report["reason"] = "nothing-prunable";
            report["fits"] = false;
            return report;
        }

        const marker = "\n…[本轮上下文超额，此条工具输出已就地剪短；完整内容仍在会话记录里]…\n";
        const half = Math.max(1, Math.floor(this.inline_trim_chars / 2));
        let currentTotal = before;
        for (const i of prunable) {
            const msg = messages[i];
            if (!isPyDict(msg)) continue;
            if (stable_block_of(msg)) continue;  // 受保护区块不做就地剪短
            const text = pyOr(dictGet(msg, "content"), "") as string;
            if (pyLenChar(text) <= this.inline_trim_chars) continue;
            const oldTok = this.estimate_tokens(text);
            const newText = pySliceChar(text, 0, half) + marker + pySliceChar(text, -half, null);
            const newTok = this.estimate_tokens(newText);
            (msg as JsonDict)["content"] = newText;
            report["pruned"] = (report["pruned"] as number) + 1;
            currentTotal -= Math.max(0, oldTok - newTok);
            // 增量判断：够了就停，别过度剪。
            if (currentTotal <= ceiling) break;
        }

        report["after"] = currentTotal;
        report["fits"] = (report["after"] as number) <= ceiling;
        report["reason"] = (report["pruned"] as number) ? "inline-pruned" : "nothing-oversized";
        return report;
    }

    // ── 向后兼容别名（旧调用点仍可用）──────────────────────────────────────

    should_compact(messages: unknown[]): boolean {
        return this.should_fold(messages)[0];
    }
}

// ── 模块级单例与配置 ─────────────────────────────────────────────────────────

let _compactor: ContextCompactor | null = null;

/** 探针缝：rebinds the python module global `_compactor` (set null to reset). */
export function _set_compactor_for_parity(v: ContextCompactor | null): void {
    _compactor = v;
}

/** What the settings page may tune, with the constructor defaults. */
const _TUNABLE_COMPACTION_KEYS: Record<string, (raw: unknown) => number> = {
    max_tokens: pyIntCoerce,
    threshold: pyFloatCoerce,
    emergency_threshold: pyFloatCoerce,
    cooldown_s: pyFloatCoerce,
    max_consecutive: pyIntCoerce,
    reserve_tokens_floor: pyIntCoerce,
};

/** Constructor kwargs for ContextCompactor from config.json's `compaction`. */
export function compaction_kwargs_from_config(): CompactorInit {
    const kwargs: Record<string, number> = {};
    let comp: JsonDict;
    try {
        const cfgPath = COMPACTOR_SEAMS.configPath();
        const root = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        // `.get("compaction") or {}` on the parsed root:
        comp = pyOr(dictGet(root, "compaction"), {}) as JsonDict;
        // python 的 `comp.get(key)` 对非 dict（字符串/数组/数字…）抛
        // AttributeError，由外层 except 归零成 {} —— 如实重现这个泄漏。
        if (!isPyDict(comp)) throw new AttributeErrorP(comp, "get");
        for (const key of Object.keys(_TUNABLE_COMPACTION_KEYS)) {
            const cast = _TUNABLE_COMPACTION_KEYS[key]!;
            if (dictGet(comp, key) === null) continue;
            try {
                kwargs[key] = cast((comp as JsonDict)[key]);
            } catch {
                continue;
            }
        }
    } catch {
        return {};
    }
    let th = pyFloatCoerce(dictGet(kwargs, "threshold", 0.80));
    let em = pyFloatCoerce(dictGet(kwargs, "emergency_threshold", 0.90));
    // python min/max(二元) 的比较语义：b>a / b<a 为假时取 a —— NaN 参与时
    // 与 JS Math.min/max 的 NaN 传播不同，如实复刻（"nan" 手写不会毒死钳位）。
    th = pyMin2(0.95, pyMax2(0.50, th));
    em = pyMin2(0.98, pyMax2(th, em));
    kwargs["threshold"] = th;
    kwargs["emergency_threshold"] = em;
    const mt = pyIntCoerce(dictGet(kwargs, "max_tokens", 80_000));
    if ("reserve_tokens_floor" in kwargs) {
        // 地板不可能超过半个窗口 —— 否则折叠永远"不达标"，层数被白白拉满。
        kwargs["reserve_tokens_floor"] = Math.min(
            Math.max(0, pyIntCoerce(kwargs["reserve_tokens_floor"])), Math.floor(mt / 2));
    }
    const out: CompactorInit = { ...kwargs };
    // 加密是布尔开关，单独处理：非真值一律视为关，坏手写不会炸构造函数。
    try {
        out["encryption_enabled"] = pyTruth(dictGet(comp, "encryption_enabled"));
    } catch {
        delete out["encryption_enabled"];
    }
    return out;
}

export function get_compactor(): ContextCompactor {
    if (_compactor === null) {
        _compactor = new ContextCompactor(compaction_kwargs_from_config());
    }
    return _compactor;
}

/** Module-level multi-source token estimation convenience function. */
export function estimate_tokens_multi(messages: unknown[]): number {
    return get_compactor().estimate_tokens_multi(messages);
}

// PORT STATUS: confidence=high todos=[0]
