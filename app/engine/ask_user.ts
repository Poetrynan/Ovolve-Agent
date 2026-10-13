/**
 * ask_user.ts — PORT of app/backend/ask_user.py (wave 4, SPLIT -> single TS).
 *
 * RULEBOOK CITATIONS
 *   §2  functional identity is supreme — every python-ism is reproduced
 *       bug-for-bug, including the latent ones listed below.
 *   §2  broad-swall inventory (source lines, verbatim semantics):
 *       L86-88  json.loads except Exception -> one opaque message
 *       L143-144 _picked_labels except (ValueError, TypeError, IndexError) -> continue
 *       L165-166 render_answer except (ValueError, TypeError) -> continue
 *                (OverflowError is NOT caught there — crash propagates, mirrored)
 *       L217-218 _ensure_loaded kv_get except Exception -> return (db locked -> memory-only)
 *       L231-232 per-row parse except Exception -> continue
 *       L247-248 _persist except Exception -> pass (fail-open)
 *       L586-587 parse_auto_resolution json except Exception -> None
 *       L599-601 int(row.get("q")) except (TypeError, ValueError) -> None (Overflow re-raised)
 *   §2  latent quirks kept:
 *       - item.get("options") being a *string* iterates per character, so "ab"
 *         yields two single-char options and passes the >=2 gate (source does).
 *       - isinstance(x, int) includes bool: picked=True -> [True] -> int(True)=1.
 *       - non-int floats (1.5) are dropped from auto-resolution "picked", but
 *         bool is accepted; negative ints pass isinstance yet fail 0 <= i.
 *       - _picked_labels: negative picked idx indexes from the END of options
 *         (python list[i] with i<0), only out-of-range falls to IndexError.
 *       - "；".join(parts) crashes (TypeError) if a stored option label is
 *         non-str — labels from the ledger are not re-validated. Mirrored via
 *         pyJoin.
 *       - data.get("resolved") is not True: 1 / "true" reject; only literal
 *         JSON true passes.
 *       - MAX_QUESTIONS slice happens BEFORE validation; eviction keeps the 4
 *         newest by created_at (stable desc sort).
 *       - the .py source file uses CR CR LF line endings, so every line break
 *         inside the two triple-quoted prompt constants compiles to "\n\n"
 *         under python universal newlines — reproduced verbatim via
 *         join("\n\n") array construction.
 *   §4  naming: app/backend/ask_user.py -> app/engine/ask_user.ts.
 *
 * MIGRATION DECISIONS
 *   SPLIT unit ships as single TS (HANDOFF.md §7.3, app_agent.ts precedent).
 *   storage: static import of get_storage (verified unit, permission_rules.ts
 *   precedent) but invoked lazily inside _store(), preserving the source's
 *   "import order must not decide db creation" behaviour.
 *   tools: bind_tools_module seam (red_team.ts / app_agent.ts precedent) —
 *   the source's in-function `from tools import ToolDef` avoids a circular
 *   import; until the wave-4 tools.py unit lands the host binds it.
 *   asyncio.Future -> settled-flag deferred: this module only ever marks a
 *   future done via deliver_answer, so a settled flag is equivalent.
 *
 * DIVERGENCE(port) — one-line equivalence arguments:
 *   1. pyJsonLoads = JSON.parse; python's json.loads additionally accepts
 *      NaN/Infinity tokens: model output is schema-constrained JSON and every
 *      failure path folds into the same except branch (identical message).
 *   2. register_waiter's asyncio.get_running_loop() can raise RuntimeError
 *      outside a loop; the JS runtime always has one — only a failure mode is
 *      removed, never added.
 *   3. integer-valued JSON floats ("1.0") are Python floats (fail
 *      isinstance(int)) but JS numbers (pass Number.isInteger): observable
 *      only for hand-written 1.0 literals from a frontend that emits ints.
 *   4. str.strip()/rstrip(): JS trims \uFEFF, Python does not — inputs are
 *      model-authored text where BOM does not occur.
 */

import { Result } from "./result.js";
import { get_storage } from "./storage.js";

// ---------------------------------------------------------------------------
// python-semantics mirrors (verbatim copies of the verified app_agent.ts set)
// ---------------------------------------------------------------------------

class ValueErrorP extends Error {
    constructor(msg: string) {
        super(`ValueError: ${msg}`);
        this.name = "ValueError";
        this.pyMsg = msg;
    }
    pyMsg: string;
}
class TypeErrorP extends Error {
    constructor(msg: string) {
        super(`TypeError: ${msg}`);
        this.name = "TypeError";
        this.pyMsg = msg;
    }
    pyMsg: string;
}
class IndexErrorP extends Error {
    constructor(msg: string) {
        super(`IndexError: ${msg}`);
        this.name = "IndexError";
        this.pyMsg = msg;
    }
    pyMsg: string;
}
class KeyErrorP extends Error {
    constructor(key: string) {
        super(`KeyError: ${key}`);
        this.name = "KeyError";
        this.pyMsg = key;
    }
    pyMsg: string;
}
class OverflowErrorP extends Error {
    constructor(msg: string) {
        super(`OverflowError: ${msg}`);
        this.name = "OverflowError";
        this.pyMsg = msg;
    }
    pyMsg: string;
}
class AttributeErrorP extends Error {
    constructor(msg: string) {
        super(`AttributeError: ${msg}`);
        this.name = "AttributeError";
        this.pyMsg = msg;
    }
    pyMsg: string;
}
class RuntimeErrorP extends Error {
    constructor(msg: string) {
        super(`RuntimeError: ${msg}`);
        this.name = "RuntimeError";
        this.pyMsg = msg;
    }
    pyMsg: string;
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    return "dict";
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as object).length > 0;
    return true;
}

function isDict(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** python dict.get(k, dflt)：present-but-null returns null, not dflt. */
function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
    if (!isDict(obj)) {
        throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute 'get'`);
    }
    return key in (obj as object) ? (obj as Record<string, unknown>)[key] : dflt;
}

/** python obj[key] on a mapping — miss -> KeyError(repr). */
function dictSub(obj: unknown, key: string): unknown {
    if (!isDict(obj)) {
        throw new TypeErrorP(`'${pyTypeName(obj)}' object is not subscriptable`);
    }
    if (!(key in (obj as object))) {
        throw new KeyErrorP(`'${key}'`);
    }
    return (obj as Record<string, unknown>)[key];
}

/** python int(x). */
function pyInt(v: unknown): number {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") {
        if (Number.isNaN(v)) throw new ValueErrorP("cannot convert float NaN to integer");
        if (!Number.isFinite(v)) throw new OverflowErrorP("cannot convert float infinity to integer");
        return Math.trunc(v);
    }
    if (typeof v === "string") {
        const s = v.trim();
        if (/^[-+]?[0-9]+$/u.test(s)) return Number(s);
        throw new ValueErrorP(`invalid literal for int() with base 10: '${s}'`);
    }
    throw new TypeErrorP(
        `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

/** python float(x). */
function pyFloat(v: unknown): number {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") return v;
    if (typeof v === "string") {
        const s = v.trim();
        if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) || /^[-+]?inf(inity)?$/i.test(s) || /^[-+]?nan$/i.test(s)) {
            const lowered = s.toLowerCase();
            if (lowered.startsWith("+inf") || lowered === "inf" || lowered === "infinity") return Infinity;
            if (lowered.startsWith("-inf")) return -Infinity;
            if (lowered === "nan" || lowered === "+nan" || lowered === "-nan") return NaN;
            return Number(s);
        }
        throw new ValueErrorP(`could not convert string to float: '${s}'`);
    }
    throw new TypeErrorP(
        `float() argument must be a string or a real number, not '${pyTypeName(v)}'`);
}

/** str(x) for f-strings: containers render in repr form. */
function pyReprVal(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") {
        if (Number.isNaN(v)) return "nan";
        if (v === Infinity) return "inf";
        if (v === -Infinity) return "-inf";
        return String(v);
    }
    if (typeof v === "string") {
        const q = v.includes("'") && !v.includes('"') ? '"' : "'";
        const body = v
            .replaceAll("\\", "\\\\")
            .replaceAll("\n", "\\n")
            .replaceAll("\r", "\\r")
            .replaceAll("\t", "\\t");
        return q + body.replaceAll(q === "'" ? "'" : '"', "\\" + q) + q;
    }
    if (Array.isArray(v)) return "[" + v.map(pyReprVal).join(", ") + "]";
    const keys = Object.keys(v as object);
    return "{" + keys.map((k) => pyReprVal(k) + ": " + pyReprVal((v as Record<string, unknown>)[k])).join(", ") + "}";
}

function pyStrVal(v: unknown): string {
    if (typeof v === "string") return v;
    return pyReprVal(v);
}

/** code-point slice s[start:end]. */
function pySlice(s: string, start: number, end?: number): string {
    const chars = Array.from(s);
    return chars.slice(start, end).join("");
}

/** python `for x in obj` over str/list/dict; anything else TypeError. */
function pyIter(v: unknown): unknown[] {
    if (typeof v === "string") return Array.from(v);
    if (Array.isArray(v)) return v.slice();
    if (isDict(v)) return Object.keys(v);
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not iterable`);
}

/** python seq[i] on a list, negative-from-end; miss -> IndexError. */
function pyIndexList(seq: unknown, i: number): unknown {
    if (!Array.isArray(seq)) {
        throw new TypeErrorP(`'${pyTypeName(seq)}' object is not subscriptable`);
    }
    const k = i < 0 ? seq.length + i : i;
    if (!(k >= 0 && k < seq.length)) {
        throw new IndexErrorP("list index out of range");
    }
    return seq[k];
}

/** python sep.join(seq): non-str items raise TypeError like CPython. */
function pyJoin(seq: unknown[], sep: string): string {
    for (let i = 0; i < seq.length; i++) {
        if (typeof seq[i] !== "string") {
            throw new TypeErrorP(
                `sequence item ${i}: expected str instance, ${pyTypeName(seq[i])} found`);
        }
    }
    return seq.join(sep);
}

/** python json.loads (see DIVERGENCE(port) 1). */
function pyJsonLoads(s: string): unknown {
    return JSON.parse(s);
}

/** `x or dflt` truthiness gate. */
function orDefault(v: unknown, dflt: unknown): unknown {
    return pyTruth(v) ? v : dflt;
}

/** first truthy dict.get() in a chain, else "" — mirrors `a.get(k1) or ... or ""`. */
function orChain(obj: unknown, keys: string[]): unknown {
    for (const k of keys) {
        const v = dictGet(obj, k);
        if (pyTruth(v)) return v;
    }
    return "";
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** 一次提问最多几个问题。 */
export const MAX_QUESTIONS = 3;
/** 每个问题最多几个预设选项（不含前端永远追加的「其他」自由输入）。 */
export const MAX_OPTIONS = 5;
/** 每个会话最多挂几组未回答的问题，超了淘汰最旧的。 */
export const MAX_PENDING = 4;
/** 未回答问题的存活期（读取时丢弃，不自动替用户作答）。 */
export const PENDING_TTL_S = 86400;
/** kv 命名空间。一个会话所有待答问题存成一条 JSON 数组。 */
const _KV_NS = "ask_user";

/** 挂起等待的兜底上限（router 侧消费；常量本身是协议的一部分）。 */
export const ASK_WAIT_TIMEOUT_S = 1800;

function _kv_key(session_id: string): string {
    return `pending:${session_id}`;
}

/** test seam: pin the wall clock (python time.time — seconds, float). */
let _timeFn: () => number = () => Date.now() / 1000;
export function bind_time_fn(fn: (() => number) | null): void {
    _timeFn = fn ?? (() => Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

/**
 * 把一个选项归一成 ``{label, description}``。纯字符串/{label}/{value,label}/
 * {name,detail} 全部接住（源注释）。
 */
function _one_option(raw: unknown): { label: string; description: string } | null {
    let label: string, desc: string;
    if (typeof raw === "string") {
        label = raw.trim();
        desc = "";
    } else if (isDict(raw)) {
        label = pyStrVal(orChain(raw, ["label", "value", "name"])).trim();
        desc = pyStrVal(orChain(raw, ["description", "detail", "hint"])).trim();
    } else {
        return null;
    }
    if (!pyTruth(label)) {
        return null;
    }
    return { label: pySlice(label, 0, 120), description: pySlice(desc, 0, 200) };
}

/**
 * 校验并归一化模型给的 questions，返回 ``(questions, error)``。error 非空时
 * questions 为空。位置序号 index 由 out.length 生成（源的稳定序号方案）。
 */
export function normalize_questions(rawIn: unknown): [Record<string, unknown>[], string] {
    let raw = rawIn;
    if (typeof raw === "string") {
        try {
            raw = pyJsonLoads(raw);
        } catch {
            return [[], "questions 必须是数组，不是字符串"];
        }
    }
    if (isDict(raw)) {
        raw = [raw];
    }
    if (!Array.isArray(raw) || raw.length === 0) {
        return [[], "questions 不能为空"];
    }

    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < Math.min(raw.length, MAX_QUESTIONS); i++) {
        const item = raw[i];
        if (!isDict(item)) {
            return [[], `第 ${i + 1} 个问题不是对象`];
        }
        const text = pyStrVal(orChain(item, ["question", "prompt", "title"])).trim();
        if (!pyTruth(text)) {
            return [[], `第 ${i + 1} 个问题缺少 question 文本`];
        }
        // 源如此：options 是字符串时按字符迭代，"ab" 也算两个选项。
        const optItems = pyIter(orDefault(dictGet(item, "options"), []));
        const options: unknown[] = [];
        for (const o of optItems) {
            const oo = _one_option(o);
            if (oo) options.push(oo);
        }
        if (options.length < 2) {
            return [[], `「${pySlice(text, 0, 20)}」至少要给 2 个选项，只有一个选项就不必问`];
        }
        out.push({
            index: out.length,
            question: pySlice(text, 0, 400),
            options: options.slice(0, MAX_OPTIONS),
            multiSelect: pyTruth(dictGet(item, "multiSelect"))
                || pyTruth(dictGet(item, "allowMultiple"))
                || pyTruth(dictGet(item, "multi_select")),
        });
    }
    return [out, ""];
}

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

/** 一组已经问出去、还没收到答案的问题。 */
export class PendingQuestion {
    call_id: string;
    session_id: string;
    header: string;
    questions: Record<string, unknown>[];
    created_at: number;

    constructor(call_id: string, session_id: string, header: string,
        questions: Record<string, unknown>[], created_at?: number) {
        this.call_id = call_id;
        this.session_id = session_id;
        this.header = header;
        this.questions = questions;
        this.created_at = created_at ?? _timeFn();
    }
}

interface StorageLike {
    kv_get(key: string, ns?: string, defaultValue?: unknown): unknown;
    kv_set(key: string, value: unknown, ns?: string): void;
}

export class AskUserStore {
    private _storage: unknown;
    private _pending = new Map<string, PendingQuestion>();
    private _loaded = new Set<string>();

    constructor(storage: unknown = null) {
        this._storage = storage;
    }

    // ── 持久化 ────────────────────────────────────────────────────────────
    /** 惰性取 storage。构造时就取会让导入顺序决定能否建库。 */
    private _store(): StorageLike {
        if (this._storage === null || this._storage === undefined) {
            this._storage = get_storage() as unknown as StorageLike;
        }
        return this._storage as StorageLike;
    }

    private _ensure_loaded(session_id: string): void {
        if (!pyTruth(session_id) || this._loaded.has(session_id)) {
            // No session id means nothing to key the ledger by. Loading under a
            // blank key would let two unrelated callers share one bucket.
            return;
        }
        this._loaded.add(session_id);
        let rowsRaw: unknown;
        try {
            rowsRaw = orDefault(this._store().kv_get(_kv_key(session_id), _KV_NS, []), []);
        } catch {
            return; // 库锁了就退化成纯内存，比让工具调用炸掉好
        }
        const now = _timeFn();
        for (const row of Array.isArray(rowsRaw) ? rowsRaw : []) {
            let entry: PendingQuestion;
            try {
                const caRaw = dictGet(row, "created_at");
                if (now - pyFloat(orDefault(caRaw, 0)) > PENDING_TTL_S) {
                    continue;
                }
                entry = new PendingQuestion(
                    pyStrVal(dictSub(row, "call_id")),
                    session_id,
                    pyStrVal(orDefault(dictGet(row, "header"), "")),
                    pyIter(orDefault(dictGet(row, "questions"), [])) as Record<string, unknown>[],
                    pyFloat(orDefault(dictGet(row, "created_at"), now)),
                );
            } catch {
                continue;
            }
            if (pyTruth(entry.questions)) {
                if (!this._pending.has(entry.call_id)) {
                    this._pending.set(entry.call_id, entry);
                }
            }
        }
    }

    private _persist(session_id: string): void {
        if (!pyTruth(session_id)) {
            return;
        }
        try {
            this._store().kv_set(
                _kv_key(session_id),
                this.pending_for(session_id).map((e) => ({
                    call_id: e.call_id, header: e.header,
                    questions: e.questions, created_at: e.created_at,
                })),
                _KV_NS,
            );
        } catch {
            // fail-open: 可选增强，失败不影响主流程（源 `except Exception: pass`）
        }
    }

    // ── 账本 ──────────────────────────────────────────────────────────────
    record(call_id: string, session_id: string, header: string,
        questions: Record<string, unknown>[]): PendingQuestion {
        this._ensure_loaded(session_id);
        const entry = new PendingQuestion(call_id, session_id, header, questions);
        this._pending.set(call_id, entry);
        for (const stale of this.pending_for(session_id).slice(MAX_PENDING)) {
            this._pending.delete(stale.call_id);
        }
        this._persist(session_id);
        return entry;
    }

    /** 该会话未回答的问题，最新的在前。 */
    pending_for(session_id: string): PendingQuestion[] {
        this._ensure_loaded(session_id);
        const rows = [...this._pending.values()].filter((e) => e.session_id === session_id);
        rows.sort((a, b) => b.created_at - a.created_at);
        return rows;
    }

    /**
     * 消费一组问题，返回要写进 transcript 的用户消息；对不上号返回 null。
     * call_id 省略时退回该会话最新的一组。
     */
    resolve(session_id: string, call_id = "", answers: unknown = null,
        skipped = false): string | null {
        this._ensure_loaded(session_id);
        let entry: PendingQuestion | null = pyTruth(call_id)
            ? (this._pending.get(call_id) ?? null) : null;
        if (entry !== null && entry.session_id !== session_id) {
            return null; // 跨会话的 call_id，不认
        }
        if (entry === null) {
            const rows = this.pending_for(session_id);
            if (!rows.length) {
                return null;
            }
            entry = rows[0]!; // rows.length checked above
        }
        this._pending.delete(entry.call_id);
        this._persist(session_id);
        return pyTruth(skipped) ? SKIP_REPLY : render_answer(entry, answers);
    }

    /** 丢掉该会话所有未答问题，返回丢了几组。 */
    discard_session(session_id: string): number {
        const rows = this.pending_for(session_id);
        for (const e of rows) {
            this._pending.delete(e.call_id);
        }
        if (rows.length) {
            this._persist(session_id);
        }
        return rows.length;
    }

    /** 给前端重建卡片用的数据。空列表本身也是有效信息——表示没有待答。 */
    snapshot(session_id: string): Record<string, unknown>[] {
        return this.pending_for(session_id).map((e) => ({
            callId: e.call_id, toolName: "ask_user", header: e.header,
            questions: e.questions, createdAt: e.created_at,
        }));
    }
}

let _storeSingleton: AskUserStore | null = null;

export function get_ask_user_store(): AskUserStore {
    if (_storeSingleton === null) {
        _storeSingleton = new AskUserStore();
    }
    return _storeSingleton;
}

/** 测试接缝：装一个干净的账本，或传 null 复位。 */
export function set_ask_user_store(store: AskUserStore | null): void {
    _storeSingleton = store;
}

// ---------------------------------------------------------------------------
// answer rendering
// ---------------------------------------------------------------------------

/**
 * 从一条答案里取出选中的选项文案和自由输入。越界下标直接丢掉而不是报错
 * （源注释：前后端各持一份问题副本，存在错位窗口）。
 */
function _picked_labels(question: Record<string, unknown>, answer: Record<string, unknown>): [unknown[], string] {
    const labels: unknown[] = [];
    let picked = dictGet(answer, "picked");
    if (typeof picked === "boolean" || (typeof picked === "number" && Number.isInteger(picked))) {
        // 源 isinstance(picked, int)——bool 也算 int；见 DIVERGENCE(port) 3。
        picked = [picked];
    }
    for (const idx of pyIter(orDefault(picked, []))) {
        let opt: unknown;
        try {
            opt = pyIndexList(dictSub(question, "options"), pyInt(idx));
        } catch (e) {
            if (e instanceof ValueErrorP || e instanceof TypeErrorP || e instanceof IndexErrorP) {
                continue;
            }
            throw e;
        }
        labels.push(dictSub(opt, "label"));
    }
    const free = pyStrVal(orDefault(dictGet(answer, "text"), "")).trim();
    return [labels, pySlice(free, 0, 500)];
}

/** 把点选结果渲染成一条正常的人类用户消息（源刻意不用 JSON）。 */
export function render_answer(pending: PendingQuestion, answers: unknown): string {
    const byIndex = new Map<number, Record<string, unknown>>();
    let ans = answers;
    if (isDict(ans)) {
        ans = [ans];
    }
    for (const a of pyIter(orDefault(ans, []))) {
        if (!isDict(a)) {
            continue;
        }
        const rawIdx = dictGet(a, "q", dictGet(a, "index", dictGet(a, "questionIndex")));
        try {
            byIndex.set(pyInt(rawIdx), a);
        } catch (e) {
            // 源只捕 (ValueError, TypeError)——OverflowError 继续上抛。
            if (e instanceof ValueErrorP || e instanceof TypeErrorP) {
                continue;
            }
            throw e;
        }
    }

    const lines: string[] = [];
    for (const q of pending.questions) {
        const [labels, free] = _picked_labels(q, byIndex.get(dictSub(q, "index") as number) ?? {});
        const parts = labels.slice();
        if (pyTruth(free)) {
            parts.push(`其他：${free}`);
        }
        lines.push(`- ${pyStrVal(dictSub(q, "question"))} → ` + (parts.length ? pyJoin(parts, "；") : "（没选，你定）"));
    }
    return "我选了：\n" + pyJoin(lines, "\n");
}

/** 用户明确跳过时替代答案的那句话（防模型把跳过读成没看见，原样再问）。 */
export const SKIP_REPLY = "这几个问题我先不选。你按最合理的默认继续做，不要再问一遍。";

// ---------------------------------------------------------------------------
// suspend（进程内等待者）——见源注释：Future 是快车道，账本才是真相
// ---------------------------------------------------------------------------

interface Waiter {
    promise: Promise<{ answers: unknown; skipped: boolean }>;
    resolve: (v: { answers: unknown; skipped: boolean }) => void;
    settled: boolean;
}

const _waiters = new Map<string, Waiter>();

/** 为一次提问登记等待者，返回等答案的 Promise。 */
export function register_waiter(call_id: string): Promise<{ answers: unknown; skipped: boolean }> {
    let resolveFn: (v: { answers: unknown; skipped: boolean }) => void = () => undefined;
    const promise = new Promise<{ answers: unknown; skipped: boolean }>((res) => { resolveFn = res; });
    const w: Waiter = { promise, resolve: resolveFn, settled: false };
    _waiters.set(call_id, w);
    return promise;
}

export function drop_waiter(call_id: string): void {
    _waiters.delete(call_id);
}

export function has_waiter(call_id: string): boolean {
    const w = _waiters.get(call_id);
    return w !== undefined && !w.settled;
}

/** 把点选结果交给正在等它的那个回合。没人等就返回 false（调用方回落）。 */
export function deliver_answer(call_id: string, answers: unknown = null, skipped: unknown = false): boolean {
    const w = _waiters.get(call_id);
    if (w === undefined) {
        return false;
    }
    _waiters.delete(call_id);
    if (w.settled) {
        return false;
    }
    w.settled = true;
    w.resolve({ answers, skipped: pyTruth(skipped) });
    return true;
}

// ---------------------------------------------------------------------------
// tool definition surface
// ---------------------------------------------------------------------------

export const ASK_USER_SCHEMA = {
    "type": "object",
    "properties": {
        "header": {
            "type": "string",
            "description": "Very short title for the whole ask, e.g. 'Pick a package manager'.",
        },
        "questions": {
            "type": "array",
            "description": `1-${MAX_QUESTIONS} questions. Each needs at least 2 options.`,
            "items": {
                "type": "object",
                "properties": {
                    "question": { "type": "string", "description": "The question itself." },
                    "options": {
                        "type": "array",
                        "description": `2-${MAX_OPTIONS} concrete choices.`,
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "Short choice text." },
                                "description": {
                                    "type": "string",
                                    "description": "One line on the trade-off. Optional.",
                                },
                            },
                            "required": ["label"],
                        },
                    },
                    "multiSelect": {
                        "type": "boolean",
                        "default": false,
                        "description": "True when several options can be picked together.",
                    },
                },
                "required": ["question", "options"],
            },
        },
    },
    "required": ["questions"],
};

export const ASK_USER_DESCRIPTION =
    "Ask the user to choose between concrete options when you are at a fork you " +
    "cannot resolve yourself, and picking wrong would waste real work. The turn " +
    "stops here and the user answers by clicking; a free-text 'other' box is always " +
    "offered, so never spend an option on it. Do NOT use this to ask permission for " +
    "a risky action (that gate is automatic), to ask something the codebase can " +
    "answer, or to re-ask what the user already told you.";

/** 问题的纯文本形态：halt 返回值 + 无卡片入口（CLI/机器人）。 */
function _render_for_transcript(header: string, questions: Record<string, unknown>[]): string {
    const lines: string[] = [pyTruth(header) ? header : "需要你定一下："];
    questions.forEach((q, i) => {
        lines.push(`${i + 1}. ${pyStrVal(dictSub(q, "question"))}`);
        lines.push("   " + pyJoin(
            pyIter(dictSub(q, "options")).map((o) => dictSub(o, "label")), " / "));
    });
    return pyJoin(lines, "\n");
}

export function _ask_user_impl(args: Record<string, unknown>, ctx: Record<string, unknown>): Result {
    const [questions, err] = normalize_questions(dictGet(args, "questions"));
    if (pyTruth(err)) {
        // 失败也是一次可用的反馈：说清哪里不对，模型下一步就能改对。
        return Result.failure(`ask_user 参数不合法：${err}`);
    }

    const call_id = pyStrVal(orDefault(dictGet(ctx, "call_id"), ""));
    const session_id = pyStrVal(orDefault(dictGet(ctx, "session_id"), ""));
    if (!pyTruth(call_id)) {
        return Result.failure("ask_user 缺少 call_id，无法把答案对回这次提问");
    }

    const header = pySlice(pyStrVal(orDefault(dictGet(args, "header"), "")).trim(), 0, 80);
    get_ask_user_store().record(call_id, session_id, header, questions);
    return Result.success(
        _render_for_transcript(header, questions),
        { ask_header: header, ask_questions: questions },
    );
}

/** tools.py surface consumed here (wave-4 SPLIT, not landed yet). */
export interface ToolsModuleLike {
    ToolDef: new (
        name: string,
        description: string,
        schema: Record<string, unknown>,
        impl: (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown,
        kwargs: Record<string, unknown>,
    ) => unknown;
}

let _toolsMod: ToolsModuleLike | null = null;

/** Host binding point for the tools package (SPLIT seam, app_agent.ts
 *  precedent — the source imports ToolDef inside the factory to dodge the
 *  import cycle; unbound mirrors the source's ImportError at call time. */
export function bind_tools_module(mod: ToolsModuleLike | null): void {
    _toolsMod = mod;
}

/** 建 ``ask_user`` 的 ToolDef（domain=general, risk=low, halts_turn）。 */
export function create_ask_user_tool(): unknown {
    const mod = _toolsMod;
    if (mod === null) {
        throw new RuntimeErrorP("tools registry not bound (tools.py SPLIT seam)");
    }
    return new mod.ToolDef(
        "ask_user",
        ASK_USER_DESCRIPTION,
        ASK_USER_SCHEMA,
        _ask_user_impl,
        { domain: "general", risk_level: "low", halts_turn: true },
    );
}

// ---------------------------------------------------------------------------
// prompt injection
// ---------------------------------------------------------------------------

/** 注进 OUTPUT_RULES 层的行为约束（「先自己找答案，找不到再问」）。
 *  源文件行尾为 CR CR LF，python 通用换行编译后每个行尾成为 "\n\n"（潜在
 *  源码怪癖，按字节保留）——用 join("\n\n") 逐字复刻。 */
export const ASK_USER_PROMPT_BLOCK = [
    '## 反问用户（ask_user）',
    '',
    '只在这三种情况用 `ask_user`：',
    '- 存在多条都合理的路，选错要推翻已经做完的工作（技术选型、改动范围、要不要动别人的模块）。',
    '- 用户的要求有歧义，而歧义会导致完全不同的结果。',
    '- 需要只有用户才知道的信息（业务规则、外部约定、他的偏好）。',
    '',
    '不要用它：',
    '- 危险操作的许可 —— 那条门禁是自动的，不需要你问。',
    '- 代码里能查到的答案 —— 先自己查。翻两个文件就能确定的事，问了是浪费。',
    '- 用户已经说过的事 —— 重复问是在告诉他你没在听。',
    '- 「要不要我继续」这类假问题 —— 直接做。',
    '',
    '用的时候：每个选项要是一条具体的路，附一句代价或后果；不要造「其他」选项，',
    '输入框永远都在。问完这一轮就停住等答案，别自己替用户选一个然后接着做。',
].join('\n\n');

/** 要注入的提问行为约束；工具不可用时返回空串。 */
export function prompt_block(is_available: boolean = true): string {
    return is_available ? ASK_USER_PROMPT_BLOCK : "";
}

// ---------------------------------------------------------------------------
// auto-resolution
// ---------------------------------------------------------------------------

export const AUTO_RESOLVE_SYSTEM = [
    '你在判定一件事：AI 助手打算向用户提的问题，是否其实已经有答案了。',
    '',
    '对每个问题，只有满足以下之一才算「已确定」：',
    '- 用户在对话里已经明说过（哪怕用词不同）；',
    '- 项目现状或对话中已陈述的事实唯一地决定了它（例如已经在用某个工具链）。',
    '',
    '以下情况一律算「未确定」，不要替用户猜：',
    '- 纯偏好、审美、优先级取舍；',
    '- 你只是觉得某个选项更常见 / 更合理；',
    '- 需要用户才知道的业务约定、外部约定；',
    '- 证据要靠推测才能连上。',
    '',
    '严格只输出 JSON，不要代码块、不要解释：',
    '{"resolved": true/false,',
    ' "answers": [{"q": <问题序号>, "picked": [<选项下标>], "evidence": "<对话里的依据，一句话>"}]}',
    '',
    'resolved 为 true 时，answers 必须覆盖每一个问题，且每题都要有非空 evidence。',
    '只要有一题拿不准，直接输出 {"resolved": false, "answers": []}。',
].join('\n\n');

/** 把待判定的问题渲染成判定请求。 */
export function build_auto_resolve_user_prompt(header: string, questions: Record<string, unknown>[]): string {
    const lines: string[] = ["助手打算问的问题：" + (pyTruth(header) ? `（${header}）` : "")];
    for (const q of questions) {
        lines.push(`[${pyStrVal(dictSub(q, "index"))}] ${pyStrVal(dictSub(q, "question"))}`);
        const opts = pyIter(dictSub(q, "options"));
        opts.forEach((opt, i) => {
            const dRaw = dictGet(opt, "description");
            const desc = pyTruth(dRaw) ? ` —— ${pyStrVal(dRaw)}` : "";
            lines.push(`    ${i}. ${pyStrVal(dictSub(opt, "label"))}${desc}`);
        });
    }
    lines.push("");
    lines.push("逐题判断是否已确定，按要求输出 JSON。");
    return pyJoin(lines, "\n");
}

/** 判定模型偶尔会套一层 ```json，剥掉再解析。 */
function _strip_json_fence(text: unknown): string {
    let t = pyStrVal(orDefault(text, "")).trim();
    if (t.startsWith("```")) {
        const nl = t.indexOf("\n");
        t = nl >= 0 ? t.slice(nl + 1) : t;
        if (t.trimEnd().endsWith("```")) {
            t = t.trimEnd().slice(0, -3);
        }
    }
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    return (start >= 0 && end > start) ? t.slice(start, end + 1) : t;
}

/**
 * 解析判定结果；不满足全部纪律就返回 null（= 照常问人）。刻意写得难通过。
 */
export function parse_auto_resolution(text: string,
    questions: Record<string, unknown>[]): { answers: unknown[]; reason: string } | null {
    let data: unknown;
    try {
        data = pyJsonLoads(_strip_json_fence(text));
    } catch {
        return null;
    }
    if (!isDict(data) || dictGet(data, "resolved") !== true) {
        return null;
    }
    const rows = dictGet(data, "answers");
    if (!Array.isArray(rows) || rows.length !== questions.length) {
        return null;
    }

    const byIndex = new Map<number, Record<string, unknown>>();
    for (const row of rows) {
        if (!isDict(row)) {
            return null;
        }
        let qi: number;
        try {
            qi = pyInt(dictGet(row, "q"));
        } catch (e) {
            if (e instanceof TypeErrorP || e instanceof ValueErrorP) {
                return null;
            }
            throw e;
        }
        let picked = dictGet(row, "picked");
        if (typeof picked === "boolean" || (typeof picked === "number" && Number.isInteger(picked))) {
            picked = [picked];
        }
        if (!Array.isArray(picked) || picked.length === 0) {
            return null;
        }
        const evRaw = dictGet(row, "evidence");
        if (!pyTruth(pyStrVal(orDefault(evRaw, "")).trim())) {
            return null; // 没有依据就不算已确定
        }
        byIndex.set(qi, {
            q: qi, picked,
            evidence: pySlice(pyStrVal(dictSub(row, "evidence")).trim(), 0, 200),
        });
    }

    const answers: unknown[] = [];
    const reasons: string[] = [];
    for (const q of questions) {
        const qIdx = dictSub(q, "index") as number;
        const row = byIndex.get(qIdx);
        if (row === undefined) {
            return null;
        }
        const opts = dictSub(q, "options") as unknown[];
        const valid: number[] = [];
        for (const i of row["picked"] as unknown[]) {
            // 源：isinstance(i, int)——bool 在内、1.5 与 "1" 在外；见 DIVERGENCE 3。
            if ((typeof i === "number" && Number.isInteger(i)) || typeof i === "boolean") {
                const iv = pyInt(i);
                if (0 <= iv && iv < opts.length) {
                    valid.push(iv);
                }
            }
        }
        if (!valid.length) {
            return null;
        }
        let kept = valid;
        if (kept.length > 1 && !pyTruth(dictGet(q, "multiSelect"))) {
            kept = kept.slice(0, 1);
        }
        answers.push({ q: qIdx, picked: kept });
        const label = pyJoin(kept.map((k) => dictSub(pyIndexList(opts, k), "label")), "、");
        reasons.push(`${pyStrVal(dictSub(q, "question"))} → ${label}（依据：${pyStrVal(dictSub(row, "evidence"))}）`);
    }
    return { answers, reason: pyJoin(reasons, "\n") };
}

// PORT STATUS: confidence=high todos=[0]
