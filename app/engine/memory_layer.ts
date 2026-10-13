/**
 * memory_layer.ts — memory extract / dream / recall / prefetch / synthesize.
 *
 * Port of app/backend/memory_layer.py (3264 lines).
 *
 * 事件驱动的记忆门面：所有操作通过 mount(bus) 挂到 EventBus 上。
 *
 * RULEBOOK CITATIONS
 *   §1  deps: node builtins (fs/path/crypto) + ported engine modules only.
 *   §2  bug-for-bug parity incl. __init__ 里 root_dir 参数被 os.getcwd()
 *       覆盖的那一行（见构造器注释）。
 *   §4  naming: source export names kept verbatim (snake_case).
 *
 * 迁移决策（HANDOFF §8.3，用户已批准）：遥测模块不移植、不留 shim——
 * 本源文件里 start_span/end_span 全部直接删除，函数体逐行保持。
 *
 * DIVERGENCE(port) 汇总（每条在正文处有对应注记）：
 *   - Python Enum(str) → 字符串常量（memory_tiers.ts 既有约定），
 *     `tier.value` 形态由字符串本身承担。
 *   - ActiveMemory.recall 在 TS 侧是 Promise（py 为 worker-thread 同步），
 *     active_recall 及其调用链因此 async。
 *   - asyncio 任务/取消 → AbortController + sleepMs，取消只能在 await 边界
 *     发生（与 asyncio 协作式取消同构）；一次 in-flight 抽取中途被取消时
 *     TS 会跑完该次抽取——抽取幂等（写入闸门去重），外部不可观测。
 *   - evolution / memory_domain.item_from_entry 尚未移植（SPLIT 批次）：
 *     计算式说明符动态 import + catch，与源侧 except ImportError 分支同形。
 *   - memory_retrieval 尚未移植：VECTOR/KEYWORD 权重按源常量复制（0.7/0.3，
 *     与 memory_retrieval.py 数值逐位相同），待该单元落地后改回 import。
 *   - UI_DEFAULT_STATUSES 在 memory_domain 移植前先本地复制常量（值已核对
 *     与源一致），待 SPLIT 落地后改 import。
 *   - print(exc) 的异常字符串：Python 与 TS 的异常 str 形态本就不同，
 *     移植保持消息模板逐字一致，异常文本随运行时。
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import * as crypto from "node:crypto";

import { Result } from "./result.js";
import { get_storage } from "./storage.js";
import { pyJsonDumps } from "./storage/storage_funcs.js";
import { pyRepr } from "./executors.js";
import {
    MemoryTier,
    ALWAYS_INJECT_TIERS,
    TOTAL_INJECT_BUDGET,
    estimate_tokens,
    normalize_tier,
    policy_for,
    should_promote,
    summarize_tiers,
    trim_to_budget,
} from "./memory_tiers.js";
import { NEGATIVE_TTL_DAYS, screen_memory_content, staleness_note } from "./memory_guard.js";
import { PrivacySanitizer } from "./sanitizer.js";
import { WikiStore, tripleFromText } from "./wiki_store.js";
import { get_embedder } from "./embedder.js";
import { build_active_memory } from "./active_memory.js";
import type { ActiveMemory, MemoryMeta } from "./active_memory.js";
import { get_reflection_store } from "./reflection_engine.js";
import type { MemoryEntryOpts } from "./storage/domains/memory.js";

// ---------------------------------------------------------------------------
// Python-parity micro helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type JsonDict = Record<string, unknown>;

interface SqlStatementLike {
    fetchone(): Row | null;
    fetchall(): Row[];
}
interface SqlDbLike {
    execute(sql: string, params?: unknown[]): SqlStatementLike;
    commit(): void;
}

/** Python truthiness for JSON-ish values. */
function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map) return v.size > 0;
    if (v instanceof Set) return v.size > 0;
    if (isPyDict(v)) return Object.keys(v as JsonDict).length > 0;
    if (typeof v === "object") return true;
    return Boolean(v);
}

/** Python str() for the value shapes reachable from this file. */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return pyObjRepr(v);
    if (isPyDict(v)) return pyObjRepr(v);
    return String(v);
}

/** str(dict)/str(list) in Python equals the repr: keys and members are
 *  rendered with repr(), not String(). JSON-parsed LLM payloads can reach
 *  ``str(item)`` call sites still holding nested objects/arrays; JS ``String``
 *  would emit "[object Object]" where Python emits "{'a': 1}". */
function isPyDict(v: unknown): boolean {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    if (Buffer.isBuffer(v) || v instanceof Error) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function pyObjRepr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (typeof v === "string") return pyRepr(v);
    if (Array.isArray(v)) return "[" + v.map(pyObjRepr).join(", ") + "]";
    if (isPyDict(v)) {
        const parts = Object.entries(v as JsonDict).map(
            ([k, val]) => pyRepr(k) + ": " + pyObjRepr(val),
        );
        return "{" + parts.join(", ") + "}";
    }
    return String(v);
}

/** JS lost the int/float distinction; sqlite integers keep py str(int)
 *  shape, and floats that JSON-parsed to integral doubles are re-decorated
 *  by the call sites that know the column is REAL (see pyFloatStr). */
function pyNumStr(v: number): string {
    if (Number.isInteger(v) && Math.abs(v) < 1e21) return String(v);
    return String(v);
}

/** str(float(x)) — an integral double formats as "1.0" in Python. */
function pyFloatStr(v: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

/** Python float(x) with the same TypeError/ValueError surface. */
function pyFloat(v: unknown): number {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v === null || v === undefined) throw new TypeError("float() argument must be a string or a number, not 'NoneType'");
    const s = String(v).trim();
    if (s === "") throw new ValueError("could not convert string to float: ''");
    const n = Number(s);
    if (Number.isNaN(n)) throw new ValueError(`could not convert string to float: ${pyRepr(String(v))}`);
    return n;
}

/** Python int(x) for the shapes reachable here. */
function pyInt(v: unknown): number {
    if (typeof v === "number") return Math.trunc(v);
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v === null || v === undefined) throw new TypeError("int() argument must be ...");
    const s = String(v).trim();
    if (!/^[+-]?\d+$/.test(s)) throw new ValueError(`invalid literal for int() with base 10: ${pyRepr(s)}`);
    return parseInt(s, 10);
}

/** str slicing on code points (Python semantics). */
function pySlice(s: string, start?: number | null, end?: number | null): string {
    const arr = Array.from(s ?? "");
    const len = arr.length;
    let a = start === undefined || start === null ? 0 : start;
    let b = end === undefined || end === null ? len : end;
    if (a < 0) a = Math.max(0, len + a);
    if (b < 0) b = Math.max(0, len + b);
    a = Math.min(a, len);
    b = Math.min(b, len);
    if (b <= a) return "";
    return arr.slice(a, b).join("");
}

/** dict.get(k, default): only a MISSING key yields the default (a stored
 *  None yields None, exactly like Python). */
function gget(row: unknown, key: string, def?: unknown): unknown {
    if (row === null || row === undefined) return def === undefined ? undefined : def;
    const obj = row as Record<string, unknown>;
    if (typeof obj !== "object" && typeof obj !== "function") return def === undefined ? undefined : def;
    const v = obj[key];
    if (v === undefined) return def === undefined ? undefined : def;
    return v;
}

/** Python ValueError stand-in (see RULEBOOK §2 mapping used across engine). */
class ValueError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ValueError";
    }
}

/** asyncio.CancelledError analogue for AbortController-based sleeps. */
class CancelledError extends Error {
    constructor(message = "cancelled") {
        super(message);
        this.name = "CancelledError";
    }
}

/** asyncio.TimeoutError analogue. */
class AsyncTimeoutError extends Error {
    constructor(message = "timeout") {
        super(message);
        this.name = "TimeoutError";
    }
}

function isCancelled(e: unknown): boolean {
    return e instanceof CancelledError;
}

/** await asyncio.sleep(seconds) with cooperative abort. */
function sleepMs(seconds: number, controller?: AbortController | null): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const signal = controller?.signal;
        if (signal?.aborted) {
            reject(new CancelledError());
            return;
        }
        const onAbort = () => {
            clearTimeout(t);
            reject(new CancelledError());
        };
        const t = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, seconds * 1000);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** time.strftime("%Y-%m-%d %H:%M") in local time. */
function strftimeMin(d: Date = new Date()): string {
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
}

/** uuid.uuid4().hex */
function uuidHex(): string {
    return crypto.randomUUID().replace(/-/g, "");
}

/** print(...) onto stdout, like CPython. */
function pyPrint(s: string): void {
    process.stdout.write(s + "\n");
}

/** str(exc) for except-as-e prints: CPython yields the message alone. */
function errStr(e: unknown): string {
    if (e instanceof Error) return e.message;
    return pyStr(e);
}

/** JSON.stringify → Buffer utf-8 (json.dumps(x).encode("utf-8")); the
 *  float-repr decoration difference ("1" vs "1.0") is invisible to the
 *  JSON reader both sides use, so pyJsonDumps' plain number form is fine. */
function jsonDumpsBuf(v: unknown): Buffer {
    return Buffer.from(pyJsonDumps(v), "utf-8");
}

/** b.encode("utf-8")[:max_bytes].decode("utf-8", errors="ignore") at a
 *  block boundary: the source bytes were valid UTF-8, so the only invalid
 *  tail is an incomplete sequence — trimming it IS errors="ignore". */
function truncateUtf8Ignore(text: string, maxBytes: number): string {
    const buf = Buffer.from(text, "utf-8");
    if (buf.length <= maxBytes) return text;
    let end = maxBytes;
    // Walk back over continuation bytes (10xxxxxx) to the lead byte.
    while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    // buf[end] is a lead byte; check whether the full sequence fits.
    const lead = buf[end] ?? 0;
    let need = 0;
    if ((lead & 0xe0) === 0xc0) need = 2;
    else if ((lead & 0xf0) === 0xe0) need = 3;
    else if ((lead & 0xf8) === 0xf0) need = 4;
    if (need > 0 && end + need > maxBytes) {
        // sequence would be cut — drop it entirely
    } else {
        end = Math.min(end + need, maxBytes);
    }
    return buf.subarray(0, end).toString("utf-8");
}

function utf8ByteLen(text: string): number {
    return Buffer.byteLength(text, "utf-8");
}

/** str.splitlines(): CPython breaks on the full Unicode set and a trailing
 *  line break does NOT produce an empty last line. */
function pySplitlines(s: string): string[] {
    const brk = /(?:\r\n|[\n\v\f\r\x1c\x1d\x1e\x85\u2028\u2029])/;
    const parts = s.split(new RegExp(brk.source, "g"));
    if (parts.length > 1 && new RegExp(`${brk.source}$`).test(s)) {
        parts.pop();
    }
    return parts;
}

/** str.rstrip() with CPython's isspace set (deliberately NOT \ufeff). */
function pyRstrip(s: string): string {
    return s.replace(/[\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/, "");
}

/** sorted() on strings: Python compares code points. */
function pyStrLess(a: string, b: string): number {
    const A = Array.from(a);
    const B = Array.from(b);
    const n = Math.min(A.length, B.length);
    for (let i = 0; i < n; i++) {
        const ca = A[i]!.codePointAt(0)!;
        const cb = B[i]!.codePointAt(0)!;
        if (ca !== cb) return ca < cb ? -1 : 1;
    }
    if (A.length === B.length) return 0;
    return A.length < B.length ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Recall ranking parameters
// ---------------------------------------------------------------------------

/** Half-life for recency weighting. A memory 30 days old counts half as much
 *  as an identical one recorded today; at 60 days, a quarter. */
export const RECALL_HALFLIFE_DAYS = 30.0;

/** MMR trade-off. 0.7 leans relevance while still refusing to spend all five
 *  injection slots on five phrasings of the same fact. */
export const RECALL_MMR_LAMBDA = 0.7;

/** Over-fetch factor before re-ranking. */
export const RECALL_CANDIDATE_MULTIPLIER = 4;

/** How many (root, session) WORKING-tier buckets to keep alive at once. */
export const MAX_WORKING_BUCKETS = 32;

export function _l2_normalize(vec: number[]): number[] {
    let sum = 0;
    for (const x of vec) {
        const f = pyFloat(x);
        sum += f * f;
    }
    const norm = Math.sqrt(sum);
    if (norm === 0) return [...vec];
    return vec.map((x) => pyFloat(x) / norm);
}

// ---------------------------------------------------------------------------
// Memory types & scopes
// ---------------------------------------------------------------------------

export const MemoryType = {
    FACT: "fact",
    PREFERENCE: "preference",
    CONTEXT: "context",
    PROCEDURE: "procedure",
    DREAM: "dream",
    SESSION: "session",
    /** 踩过的坑：只有吃过亏的人写得出，而且召回它的收益不对称。单独成类并在
     *  _rerank 里拿到加权（见 _TYPE_RECALL_WEIGHT）。 */
    GOTCHA: "gotcha",
} as const;

export const MemoryScope = {
    WORKSPACE: "workspace",
    PROJECT: "project",
    SESSION: "session",
} as const;

// ---------------------------------------------------------------------------
// Memory data class
// ---------------------------------------------------------------------------

export class Memory {
    id: string;
    content: string;
    type: string;
    importance: number;
    scope: string;
    root_dir: string;
    session_id: string;
    tags: string[];
    tier: string;
    created_at: number;
    updated_at: number;
    accessed_at: number;
    archived: boolean;
    embeddings: number[] | null;
    hits: number;
    /** 谁写的：user | agent | import | evolution。决定写入闸门的严格程度。 */
    created_by: string;
    /** 敏感度由闸门贴，不由调用方声明。 */
    sensitivity: string;
    /** 想以什么状态落盘。空 = 交给库的默认（active）。 */
    status: string;
    /** 0016：如果这一条被批准，这几条会被归档。非空 = 它是一份合并提案。 */
    supersedes: string[];
    /** 失效时刻（epoch 秒），0 = 不失效。 */
    valid_until: number;

    constructor(
        content: string,
        mem_type: string = MemoryType.FACT,
        importance: number = 0.5,
        scope: string = MemoryScope.PROJECT,
        root_dir: string = "",
        session_id: string = "",
        tags: string[] | null = null,
        // DIVERGENCE(port): py `tier: str = MemoryTier.SEMANTIC` accepted a
        // str-subclass Enum or a plain string; TS MemoryTier is plain strings.
        tier: string = MemoryTier.SEMANTIC,
        created_by: string = "agent",
    ) {
        this.id = crypto.randomUUID();
        this.content = content;
        this.type = mem_type;
        this.importance = importance;
        this.scope = scope;
        this.root_dir = root_dir;
        this.session_id = session_id;
        this.tags = pyTruth(tags) ? (tags as string[]) : [];
        this.tier = typeof tier === "string" ? tier : pyStr((tier as unknown as { value: unknown }).value);
        this.created_at = Date.now() / 1000;
        this.updated_at = Date.now() / 1000;
        this.accessed_at = 0.0;
        this.archived = false;
        this.embeddings = null;
        this.hits = 0;
        this.created_by = pyTruth(created_by) ? created_by : "agent";
        this.sensitivity = "public";
        this.status = "";
        this.supersedes = [];
        this.valid_until = 0.0;
    }

    add_tag(tag: string): void {
        if (!this.tags.includes(tag)) {
            this.tags.push(tag);
        }
    }

    to_dict(): JsonDict {
        return {
            id: this.id,
            content: this.content,
            type: this.type,
            importance: this.importance,
            scope: this.scope,
            root_dir: this.root_dir,
            session_id: this.session_id,
            tags: this.tags,
            tier: this.tier,
            hits: this.hits,
            created_at: this.created_at,
            updated_at: this.updated_at,
            accessed_at: this.accessed_at,
            archived: this.archived,
        };
    }

    static from_dict(d: JsonDict): Memory {
        const m = new Memory(
            (gget(d, "content", "") ?? "") as string,
            (gget(d, "type", MemoryType.FACT) ?? MemoryType.FACT) as string,
            (gget(d, "importance", 0.5) ?? 0.5) as number,
            (gget(d, "scope", MemoryScope.PROJECT) ?? MemoryScope.PROJECT) as string,
            (gget(d, "root_dir", "") ?? "") as string,
            (gget(d, "session_id", "") ?? "") as string,
            (gget(d, "tags", []) ?? []) as string[],
            // Rows written before C1 carry no tier; normalize_tier lands them
            // in SEMANTIC, exactly what the old flat table behaved like.
            normalize_tier(d["tier"]),
        );
        m.id = (gget(d, "id", uuidHex()) ?? uuidHex()) as string;
        m.created_at = (gget(d, "created_at", Date.now() / 1000) ?? 0) as number;
        m.updated_at = (gget(d, "updated_at", Date.now() / 1000) ?? 0) as number;
        m.accessed_at = (gget(d, "accessed_at", 0.0) ?? 0.0) as number;
        m.archived = pyTruth(gget(d, "archived", 0));
        m.hits = pyInt(pyTruth(gget(d, "hits", 0)) ? d["hits"] : 0);
        return m;
    }
}

// ---------------------------------------------------------------------------
// DebouncedExtractor -- 60s debounce -> LLM refine -> AGENTS.md
// ---------------------------------------------------------------------------

type LlmFn = ((prompt: unknown) => unknown | Promise<unknown>) | null;
type EmbedFn = ((text: string) => number[] | null | Promise<number[] | null>) | null;

export class DebouncedExtractor {
    /** EventBus subscriber for 'tool_result' events. Same file multiple
     *  writes within the window -> reset timer. Timer expires -> read file ->
     *  LLM refine -> write to AGENTS.md + memory_entries. */

    static DEBOUNCE_SECONDS: number = 60.0;

    /** Files the memory layer itself writes. Extracting from these would
     *  create a self-excitation loop. Never schedule extraction for them. */
    static SELF_WRITTEN_BASENAMES: ReadonlySet<string> = new Set(["agents.md", "claude.md"]);

    _layer: MemoryLayer;
    _llm: LlmFn;
    // DIVERGENCE(port): asyncio.Task map -> AbortController map. Cancellation
    // lands on the sleep boundary exactly like CancelledError; a cancel that
    // arrives mid-extract runs the in-flight extract to completion instead —
    // store() is content-deduped and the proposals are signature-deduped, so
    // the extra completion is not observable.
    _timers: Map<string, AbortController>;
    _pending_files: Set<string>;

    constructor(memory_layer: MemoryLayer, llm_callback: LlmFn = null) {
        this._layer = memory_layer;
        this._llm = llm_callback;
        this._timers = new Map();
        this._pending_files = new Set();
    }

    async on_tool_result(event: unknown): Promise<void> {
        const payload = ((event as { payload?: JsonDict }).payload ?? {}) as JsonDict;
        const tool_name = (gget(payload, "tool_name", "") ?? "") as string;
        if (!["write_file", "edit_file", "Write", "Edit"].includes(tool_name)) {
            return;
        }
        // Only extract from writes that actually succeeded.
        let result = (pyTruth(gget(payload, "result")) ? payload["result"] : {}) as unknown;
        if (result && typeof result === "object" && !Array.isArray(result)) {
            if ((result as JsonDict)["ok"] === false) {
                return;
            }
        }
        const args = (pyTruth(gget(payload, "args")) ? payload["args"] : {}) as JsonDict;
        const file_path = (
            pyTruth(args["path"])
                ? args["path"]
                : result && typeof result === "object" && !Array.isArray(result)
                  ? (result as JsonDict)["path"] ?? ""
                  : ""
        ) as string;
        if (!file_path) {
            return;
        }
        if (this._is_self_written(file_path)) {
            return;
        }

        const context = (pyTruth(gget(payload, "context")) ? payload["context"] : {}) as JsonDict;
        const scope: JsonDict = {
            session_id: pyTruth(payload["session_id"]) ? payload["session_id"] : pyTruth(context["session_id"]) ? context["session_id"] : "",
            branch_id: pyTruth(payload["branch_id"]) ? payload["branch_id"] : pyTruth(context["branch_id"]) ? context["branch_id"] : "",
            turn_id: pyTruth(payload["turn_id"]) ? payload["turn_id"] : pyTruth(context["turn_id"]) ? context["turn_id"] : "",
            episode_id: pyTruth(payload["episode_id"]) ? payload["episode_id"] : pyTruth(context["episode_id"]) ? context["episode_id"] : "",
            goal_id: pyTruth(payload["goal_id"]) ? payload["goal_id"] : pyTruth(context["goal_id"]) ? context["goal_id"] : "",
            run_id: pyTruth(payload["run_id"]) ? payload["run_id"] : pyTruth(context["run_id"]) ? context["run_id"] : "",
        };
        await this._schedule_extraction(file_path, { scope });
    }

    _is_self_written(file_path: string): boolean {
        return DebouncedExtractor.SELF_WRITTEN_BASENAMES.has(nodePath.basename(file_path).toLowerCase());
    }

    async _schedule_extraction(file_path: string, opts: { scope?: JsonDict | null } = {}): Promise<void> {
        const scope = opts.scope ?? null;
        const old = this._timers.get(file_path);
        this._timers.delete(file_path);
        if (old) {
            old.abort();
        }
        this._pending_files.add(file_path);
        const controller = new AbortController();
        this._timers.set(file_path, controller);
        void this._debounced_extract(file_path, { scope, _controller: controller });
    }

    async _debounced_extract(
        file_path: string,
        opts: { scope?: JsonDict | null; _controller?: AbortController } = {},
    ): Promise<void> {
        const scope = opts.scope ?? null;
        const controller = opts._controller ?? null;
        try {
            await sleepMs(DebouncedExtractor.DEBOUNCE_SECONDS, controller);
        } catch (e) {
            if (isCancelled(e)) {
                return;
            }
            throw e;
        }
        this._pending_files.delete(file_path);
        this._timers.delete(file_path);
        await this._layer.extract_from_file(file_path, { scope });
    }

    get pending_files(): Set<string> {
        return new Set(this._pending_files);
    }
}

// ---------------------------------------------------------------------------
// DreamConsolidator -- idle background analysis
// ---------------------------------------------------------------------------

export class DreamConsolidator {
    /** 空闲（>5 分钟）时整合最近的记忆：读最近 24h 的 memory_entries → 模型
     *  分析 → **提议**合并 / 提炼更高层的理解 → 落一条 candidate 提案，等用户
     *  裁决（§10.2）；整趟跑在带租约和预算的 job 里（§10.3）。 */

    static IDLE_THRESHOLD_SECONDS: number = 300;
    static CHECK_INTERVAL_SECONDS: number = 300;
    static LOOKBACK_SECONDS: number = 86400;
    /** §10.3 预算：一趟整合最多占这么久的墙上时间。 */
    static MAX_WALL_SECONDS: number = 120;
    /** 喂给模型的输入上限（估算 token）——防模型在无关事实之间编造联系。 */
    static MAX_INPUT_TOKENS: number = 4000;
    /** 续租间隔。必须显著小于租约时长。 */
    static HEARTBEAT_SECONDS: number = 30;

    _layer: MemoryLayer;
    _llm: LlmFn;
    _last_interaction: number;
    _task: Promise<void> | null;
    _controller: AbortController | null;
    _running: boolean;

    constructor(memory_layer: MemoryLayer, llm_callback: LlmFn = null) {
        this._layer = memory_layer;
        this._llm = llm_callback;
        this._last_interaction = Date.now() / 1000;
        this._task = null;
        this._controller = null;
        this._running = false;
    }

    touch(): void {
        this._last_interaction = Date.now() / 1000;
    }

    async start(): Promise<void> {
        if (this._running) {
            return;
        }
        this._running = true;
        this._controller = new AbortController();
        const controller = this._controller;
        this._task = this._dream_loop(controller);
    }

    async stop(): Promise<void> {
        this._running = false;
        if (this._controller) {
            this._controller.abort();
        }
        if (this._task) {
            try {
                await this._task;
            } catch (e) {
                if (!isCancelled(e)) throw e;
                // fail-open: 取消语义即静默，正确
            }
        }
    }

    async _dream_loop(controller: AbortController): Promise<void> {
        while (this._running) {
            await sleepMs(DreamConsolidator.CHECK_INTERVAL_SECONDS, controller);
            if (Date.now() / 1000 - this._last_interaction < DreamConsolidator.IDLE_THRESHOLD_SECONDS) {
                continue;
            }
            await this._layer.dream_consolidate(controller);
        }
    }

    get is_idle(): boolean {
        return Date.now() / 1000 - this._last_interaction >= DreamConsolidator.IDLE_THRESHOLD_SECONDS;
    }
}

// ---------------------------------------------------------------------------
// MemoryLayer -- main facade
// ---------------------------------------------------------------------------

/** 抽取行可能带的类型前缀。识别不出来的一律按 context 处理——多存一条上下文
 *  无害，把它误认成 gotcha 才会污染那个高权重通道。 */
export const _EXTRACTED_KINDS: readonly string[] = ["fact", "preference", "context", "procedure", "gotcha"];

/** 坑类提案在审批队列里的说明。跟通用文案分开，是因为审批人看"项目常识"会
 *  当成一条可有可无的补充，而坑一旦漏掉就要再踩一次。 */
export const GOTCHA_RATIONALE: string =
    "从编辑历史里识别出的**坑**：照着直觉写会出错 · " +
    "采纳后将写入项目规范，避免下次重复踩";

/** 打了这个 tag 的记忆是"断言某物不存在"的观察，带保质期。读侧据此加年龄提示。 */
export const NEGATIVE_TAG: string = "negative-assertion";

export function _row_is_perishable(row: unknown): boolean {
    /** 这条记忆是不是"会过期"的（带保质期，或打了负面断言标记）。 */
    if (!row || typeof row !== "object" || Array.isArray(row)) {
        return false;
    }
    const r = row as JsonDict;
    try {
        const vu = pyTruth(r["valid_until"]) ? r["valid_until"] : 0;
        if (pyFloat(vu) > 0) {
            return true;
        }
    } catch {
        /* fall through, like except (TypeError, ValueError): pass */
    }
    let tags = r["tags"];
    if (typeof tags === "string") {
        try {
            tags = JSON.parse(tags);
        } catch {
            tags = [tags];
        }
    }
    return Array.isArray(tags) && tags.includes(NEGATIVE_TAG);
}

export function _kind_of_extracted_line(line: string): string {
    /** 从 `[gotcha] ...` 这类前缀里读出类型；没有前缀就是 context。 */
    const m = /^\[([a-z]+)\]\s*/i.exec(pyStr(line ?? "").trim());
    if (m && m[1] !== undefined && _EXTRACTED_KINDS.includes(m[1].toLowerCase())) {
        return m[1].toLowerCase();
    }
    return "context";
}

/** Storage 的各域在运行时挂上原型（storage/domains/*）；此处只声明本源用到
 *  的方法形状。 */
interface MemoryLayerStorage {
    memory_embedding_stats(root: string): JsonDict;
    memories_missing_embeddings(root: string, limit?: number): JsonDict[];
    set_memory_embedding(eid: string, blob: Buffer | Uint8Array | null): boolean;
    get_cached_embedding(provider: string, model: string, text: string): number[] | null;
    save_cached_embedding(provider: string, model: string, text: string, vector: number[]): void;
    _decode_embedding(blob: unknown): number[] | null;
    search_memory_hybrid(
        root: string,
        query_text?: string,
        query_embedding?: number[] | null,
        keywords?: string[] | null,
        limit?: number,
        vector_weight?: number | null,
        keyword_weight?: number | null,
        session_id?: string,
        branch_id?: string,
    ): [JsonDict[], string[]];
    find_memories_by_content(root: string, text: string, limit?: number): string[];
    find_conflicting_memories(root: string, text: string, limit?: number): string[];
    confirm_memory(eid: string, opts?: { delta?: number }): boolean;
    link_memory_conflict(a_id: string, b_id: string): boolean;
    save_memory_entry(
        eid: string,
        sid: string,
        root: string,
        scope: string,
        content: string,
        opts?: MemoryEntryOpts,
    ): void;
    get_memory_entries(
        root?: string | null,
        mem_type?: string | null,
        include_archived?: boolean,
        limit?: number | null,
        since?: number | null,
    ): JsonDict[];
    list_memory_roots(include_archived?: boolean): JsonDict[];
    list_memories_needing_review(root: string, limit?: number): JsonDict[];
    claim_dream_run(
        root: string,
        idem_key: string,
        opts?: { owner?: string; lease_seconds?: number },
    ): [string, string];
    heartbeat_dream_run(job_id: string, opts?: { owner?: string; lease_seconds?: number }): boolean;
    finish_dream_run(
        job_id: string,
        status: string,
        opts?: {
            outcome?: string;
            proposal_id?: string;
            input_count?: number;
            tokens_used?: number;
            wall_ms?: number;
        },
    ): boolean;
    update_memory_dream_time(root: string): void;
    update_memory_index(root: string, content: string): void;
    touch_memory_hit(eid: string): void;
    set_memory_tier(eid: string, tier: string): void;
    expire_memories_by_tier(root: string, tier: string, older_than: number): void;
    archive_memory(eid: string): void;
    mark_skills_stale_for_memory(memory_id: string): number;
    save_session_synthesis(session_id: string, synthesis: JsonDict): void;
    get_session_synthesis(session_id: string): JsonDict | null;
    list_skill_experiences(opts?: { limit?: number }): JsonDict[];
    search_sessions_fts(query: string, workspace?: string, limit?: number): JsonDict[];
    upsert_graph_relation(
        root_dir: string,
        source_name: string,
        target_name: string,
        relation_type: string,
        confidence?: number,
        source_type?: string,
        target_type?: string,
    ): string;
    query_related_entities(entity_name: string, root_dir?: string, max_hops?: number): JsonDict[];
    trace_event(kwargs: JsonDict): unknown;
    _db(name: string): SqlDbLike;
}

/** DIVERGENCE(port): memory_retrieval.ts 未移植（后续 wave）。源侧
 *  `from memory_retrieval import VECTOR_WEIGHT, KEYWORD_WEIGHT` 的失败分支
 *  就是 0.7/0.3，与 memory_retrieval.py 的常量逐位相同，故先复制常量；
 *  该单元落地后改回动态 import（同 evolution 的处理方式）。 */
const VECTOR_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;

/** DIVERGENCE(port): memory_domain.ts（SPLIT 批次）未移植；UI_DEFAULT_STATUSES
 *  先本地复制，值与 memory_domain.py:71 逐字核对一致
 *  （("candidate","active","stale","")）。落地后改 import。 */
const UI_DEFAULT_STATUSES: readonly string[] = ["candidate", "active", "stale", ""];

/** 未移植模块的计算式动态 import：TS 侧解析失败走 catch，与 Python 侧
 *  `from evolution import ...` 抛 ImportError 走 except 完全同形。 */
async function _import_unported(name: string): Promise<any> {
    return await import("./" + name + ".js");
}

export class MemoryLayer {
    /** Memory management: extract, dream, recall, prefetch, synthesize. All
     *  operations are event-driven. Mount on EventBus via ``mount(bus)``. */

    static _EXTRACT_PATTERNS: Readonly<Record<string, readonly string[]>> = {
        [MemoryType.PREFERENCE]: [
            "I like (.+)", "I prefer (.+)", "I don't like (.+)",
            "Please (.+)", "Never (.+)", "我喜欢(.+)", "我偏好(.+)",
        ],
        [MemoryType.FACT]: [
            "My name is (.+)", "I work at (.+)", "I use (.+)",
            "Remember that (.+)", "我叫(.+)", "我在(.+)工作",
        ],
    };

    static _STOP_WORDS: ReadonlySet<string> = new Set([
        "the", "a", "an", "is", "are", "was", "were", "be", "been",
        "have", "has", "had", "do", "does", "did", "will", "would",
        "could", "should", "may", "might", "must", "can", "to", "of",
        "in", "for", "on", "with", "at", "by", "from", "as", "and",
        "but", "or", "not", "so", "than", "too", "very", "just",
    ]);

    storage: MemoryLayerStorage;
    // DIVERGENCE(port): self.telemetry 按迁移决策整体删除（HANDOFF §8.3），
    // 各方法体内 start_span/end_span 行移除，其余逐行保持。
    _llm: LlmFn;
    _embed: EmbedFn;
    _root_dir: string;
    _extractor: DebouncedExtractor;
    _dreamer: DreamConsolidator;
    /** Master switch, seeded from config.json's `memory.enabled`. When off:
     *  no extraction, no session synthesis, no recall injection, no dream
     *  consolidation. Manual CRUD from the memory settings page still works. */
    enabled: boolean;
    _bus: unknown;
    /** The instance that OWNS the shared machinery. For a normally constructed
     *  layer that is itself; for a :meth:`for_root` view it is the layer the
     *  view was derived from. */
    _origin: MemoryLayer;
    /** WORKING tier (C1): current-turn scratch, in-process only. Bucketed by
     *  ``(root, session)`` and held on the ORIGIN. */
    _working_buckets: Map<string, Memory[]>;
    _session_scope: string;
    decay_enabled: boolean;
    mmr_enabled: boolean;
    /** C3 Active Memory facade. Built lazily so constructing a MemoryLayer
     *  never spawns a worker thread. */
    _active: ActiveMemory | null;
    /** C4 WikiStore, also lazy — it runs DDL on construction. */
    _wiki: WikiStore | null;

    constructor(opts: {
        llm_callback?: LlmFn;
        embed_callback?: EmbedFn;
        storage?: unknown | null;
        root_dir?: string;
    } = {}) {
        const llm_callback = opts.llm_callback ?? null;
        const embed_callback = opts.embed_callback ?? null;
        this.storage = (pyTruth(opts.storage) ? opts.storage : get_storage()) as MemoryLayerStorage;
        this._llm = llm_callback;
        this._embed = embed_callback;
        this._root_dir = opts.root_dir ?? "";
        this._extractor = new DebouncedExtractor(this, llm_callback);
        this._dreamer = new DreamConsolidator(this, llm_callback);

        this.enabled = true;
        try {
            const _cfg_path = nodePath.join(
                nodePath.dirname(fileURLToPath(import.meta.url)), "..", "config.json");
            let _val: unknown = null;
            {
                const _raw = fs.readFileSync(_cfg_path);
                const _text = new TextDecoder("utf-8").decode(_raw);
                _val = ((JSON.parse(_text) as JsonDict)["memory"] ?? {}) as JsonDict;
                _val = (_val as JsonDict)["enabled"];
            }
            if (_val !== null && _val !== undefined) {
                this.enabled = pyTruth(_val);
            }
        } catch {
            // fail-open: 可选增强，失败不影响主流程
        }
        this._bus = null;
        // bug-for-bug（RULEBOOK §2）：这一行覆盖上面的 root_dir 入参——构造
        // 参数在源实现里从未生效，调用方都靠 for_root()/rescope() 拿 scope。
        this._root_dir = process.cwd();
        this._origin = this;
        this._working_buckets = new Map();
        this._session_scope = "";
        this.decay_enabled = true;
        this.mmr_enabled = true;
        this._active = null;
        this._wiki = null;
    }

    // DIVERGENCE(port): the source defines `memory_enabled` twice (lines 494
    // and 525, identical bodies — the second overwrites the first at class
    // creation). A TS class cannot redeclare a getter; one copy is kept and
    // behaviour is identical.
    get memory_enabled(): boolean {
        /** The master switch, always read through the ORIGIN. ``for_root``
         *  views copy the instance dict, so a plain ``self.enabled`` on a view
         *  freezes the value at view-creation time. Routing through ``_origin``
         *  makes the hot-applied flag visible everywhere at once. */
        try {
            return this._origin.enabled;
        } catch {
            return this.enabled;
        }
    }

    async set_enabled(enabled: boolean): Promise<void> {
        /** Hot-apply the master switch (settings page). Off also stops the
         *  dream consolidator and pending debounced extractions. */
        const target: MemoryLayer = this._origin !== undefined ? this._origin : this;
        target.enabled = pyTruth(enabled);
        if (!enabled) {
            await target.stop_background();
        } else {
            try {
                // Python: asyncio.get_running_loop() raises when there is no
                // loop; JS event loops always "run", so start unconditionally.
                await target.start_background();
            } catch {
                // no loop here; the next router construction starts it
            }
        }
    }

    get _working_key(): string {
        // py tuple key → `${root}\u0000${session}` — the separator cannot
        // appear in a path, so the flat key is collision-free.
        return `${this._root_dir}\u0000${this._session_scope}`;
    }

    get _working(): Memory[] {
        /** This handle's slice of the WORKING tier. Reads through ``_origin``
         *  so every view of the same (root, session) sees one list. */
        const buckets = this._origin._working_buckets;
        const key = this._working_key;
        let bucket = buckets.get(key);
        if (bucket === undefined) {
            bucket = [];
            buckets.set(key, bucket);
            // Evict the oldest inserted bucket rather than let the dict grow
            // for the process lifetime; WORKING is turn-scoped scratch.
            while (buckets.size > MAX_WORKING_BUCKETS) {
                const oldest = buckets.keys().next().value as string;
                buckets.delete(oldest);
            }
        }
        return bucket;
    }

    set _working(value: Memory[]) {
        this._origin._working_buckets.set(this._working_key, [...value]);
    }

    get active(): ActiveMemory {
        /** C3: the resilient recall facade (TTL cache + breaker + timeout).
         *  Built on ``_origin`` so every per-workspace view shares one
         *  instance. */
        const origin = this._origin;
        if (origin._active === null) {
            origin._active = build_active_memory(origin);
        }
        return origin._active;
    }

    async active_recall(
        query: string,
        limit: number = 5,
        session_id: string = "",
        branch_id: string = "",
    ): Promise<[string, MemoryMeta]> {
        /** Cached, breaker-guarded, untrusted-labeled recall for prompt
         *  assembly. Returns ``(wrapped_xml, meta)``.
         *  DIVERGENCE(port): py's ActiveMemory.recall is sync (worker thread);
         *  the TS facade is Promise-based, so this hop is async. Callers
         *  (_on_user_prompt, MCP seam) await it; the resolved tuple is the
         *  same shape. */
        return await this.active.recall(this._root_dir, query, limit, "memory", session_id, branch_id);
    }

    _invalidate_active(): void {
        /** Drop cached recalls for this workspace after a write so the next
         *  turn sees new memories. */
        if (this._origin._active !== null && this._origin._active !== undefined) {
            try {
                this._origin._active.invalidate_root(this._root_dir);
            } catch {
                // fail-open: 可选增强，失败不影响主流程
            }
        }
    }

    set_embed_callback(embed_callback: EmbedFn): void {
        /** Install or replace the embedding function used for semantic
         *  recall. Written to ``_origin`` as well: the embedder is global
         *  configuration, not per-workspace state. */
        this._embed = embed_callback;
        if (this._origin !== this) {
            this._origin._embed = embed_callback;
        }
    }

    get has_embeddings(): boolean {
        return this._embed !== null && this._embed !== undefined;
    }

    retrieval_channels(): JsonDict {
        /** What hybrid retrieval will actually do in this workspace, right
         *  now. ``vectorUsable`` / ``coverage`` say whether the dense channel
         *  contributes anything or fusion silently runs pure lexical. */
        let stats: JsonDict = { rows: 0, embedded: 0, coverage: 0.0, vectorUsable: false };
        try {
            stats = this.storage.memory_embedding_stats(this._root_dir);
        } catch {
            // fail-open: 可选增强，失败不影响主流程
        }
        const usable = pyTruth(gget(stats, "vectorUsable")) && this.has_embeddings;
        return {
            ...stats,
            root: this._root_dir,
            // No embedder wired means queries can't be embedded either, so the
            // channel is dead even if every stored row has a vector.
            embedderWired: this.has_embeddings,
            vectorUsable: usable,
            mode: usable ? "hybrid" : "keyword_only",
            nominalVectorWeight: VECTOR_WEIGHT,
            nominalKeywordWeight: KEYWORD_WEIGHT,
            effectiveVectorWeight: usable ? VECTOR_WEIGHT : 0.0,
            effectiveKeywordWeight: usable ? KEYWORD_WEIGHT : 1.0,
            degraded: !usable,
            pendingEmbeddings: Math.max(
                0,
                pyInt(pyTruth(gget(stats, "rows", 0)) ? stats["rows"] : 0) -
                    pyInt(pyTruth(gget(stats, "embedded", 0)) ? stats["embedded"] : 0),
            ),
        };
    }

    backfill_embeddings(limit: number = 200): JsonDict {
        /** Compute and store vectors for rows that never got one. Returns
         *  ``{processed, embedded, failed, remaining}``. */
        const out: JsonDict = { processed: 0, embedded: 0, failed: 0, remaining: 0 };
        if (!this.has_embeddings) {
            // Without an embedder a backfill is not "broken", it is not
            // applicable.
            out["remaining"] = pyInt(
                gget(this.retrieval_channels(), "pendingEmbeddings", 0),
            );
            return out;
        }
        let todo: JsonDict[];
        try {
            todo = this.storage.memories_missing_embeddings(this._root_dir, Math.max(1, pyInt(limit)));
        } catch {
            return out;
        }
        for (const row of todo) {
            out["processed"] = (out["processed"] as number) + 1;
            const vec = this._embed_text(((pyTruth(row["content"]) ? row["content"] : "") ?? "") as string);
            if (!pyTruth(vec)) {
                out["failed"] = (out["failed"] as number) + 1;
                continue;
            }
            const blob = jsonDumpsBuf(vec as number[]);
            if (this.storage.set_memory_embedding(row["id"] as string, blob)) {
                out["embedded"] = (out["embedded"] as number) + 1;
            } else {
                out["failed"] = (out["failed"] as number) + 1;
            }
        }
        if (pyTruth(out["embedded"])) {
            // Recall results cached before the vectors existed are now wrong:
            // they were ranked without the dense channel.
            this._invalidate_active();
        }
        out["remaining"] = pyInt(gget(this.retrieval_channels(), "pendingEmbeddings", 0));
        return out;
    }

    _embed_text(text: string): number[] | null {
        /** Compute an embedding, returning None on any failure. Cache read →
         *  L2 normalize → provider → cache write; every storage call is
         *  individually guarded (a failing cache must never break recall).
         *  DIVERGENCE(port): py calls the sync embed callback sync; a TS
         *  callback returning a Promise fails the list-of-numbers check and
         *  yields None, exactly like a misbehaving provider in py. */
        if (!this._embed || !text) {
            return null;
        }
        const [provider, model] = this._embed_identity();
        let cached: number[] | null;
        try {
            cached = this.storage.get_cached_embedding(provider, model, text);
        } catch {
            cached = null;
        }
        if (pyTruth(cached)) {
            return _l2_normalize(cached as number[]);
        }
        let vec: unknown;
        try {
            vec = (this._embed as (t: string) => unknown)(text);
        } catch {
            return null;
        }
        if (
            Array.isArray(vec) &&
            vec.length > 0 &&
            vec.every((x) => typeof x === "number" || typeof x === "boolean")
        ) {
            const normalized = _l2_normalize((vec as number[]).map((x) => pyFloat(x)));
            try {
                this.storage.save_cached_embedding(provider, model, text, normalized);
            } catch {
                // fail-open: 可选增强，失败不影响主流程
            }
            return normalized;
        }
        return null;
    }

    _embed_identity(): [string, string] {
        /** (provider, model) label for the active embedding function. The
         *  cache key MUST change when the vector space changes.
         *  DIVERGENCE(port): py's guarded `from embedder import get_embedder`
         *  can also fail at import; embedder.ts is ported so the import half
         *  is static — the runtime fallback label is kept verbatim. */
        try {
            const emb = get_embedder();
            return [pyTruth(emb.backend) ? (emb.backend as string) : "pending", emb.model_name];
        } catch {
            return ["custom", "unknown"];
        }
    }

    // ------------------------------------------------------------------
    // Event bus mounting
    // ------------------------------------------------------------------

    mount(bus: unknown): void {
        /** Subscribe to events on the bus. */
        this._bus = bus;
        const busLike = bus as {
            on(name: string, handler: (event: unknown) => unknown, priority?: number): void;
        };
        busLike.on("tool_result", (event: unknown) => this._extractor.on_tool_result(event), 0);
        busLike.on("user_prompt_submit", (event: unknown) => this._on_user_prompt(event), 10);
    }

    for_root(root: string, session_id: string = ""): MemoryLayer {
        /** A handle on this layer scoped to one workspace (and optionally
         *  session). The handle shares everything expensive and stateful with
         *  its origin (storage, embedder, ActiveMemory, WikiStore, the
         *  background extractor/dreamer). Only the scope differs. */
        const view = Object.create(MemoryLayer.prototype) as MemoryLayer;
        // Copy the instance dict wholesale so the view starts identical, then
        // override only what makes it a distinct scope.
        Object.assign(view, this);
        view._root_dir = root;
        view._session_scope = session_id;
        // Route lazy singletons and config writes to the true owner.
        view._origin = this._origin;
        return view;
    }

    rescope(root: string, session_id?: string | null): void {
        /** Move THIS handle to another workspace, in place. Legal only on a
         *  ``for_root`` handle — calling it on the shared origin is the exact
         *  cross-session mutation this design removed. */
        if (this._origin === this) {
            throw new Error(
                "rescope() is for a for_root handle; the shared layer has no " +
                "current workspace to move. Ask for a handle instead.",
            );
        }
        this._root_dir = root;
        if (session_id !== undefined && session_id !== null) {
            this._session_scope = session_id;
        }
    }

    touch(): void {
        /** Reset the idle timer that gates dream consolidation. */
        this._dreamer.touch();
    }

    async start_background(): Promise<void> {
        /** Start the idle-driven dream consolidation loop. Idempotent. */
        if (!this.memory_enabled) {
            return;
        }
        await this._dreamer.start();
    }

    async stop_background(): Promise<void> {
        /** Stop the dream loop and cancel pending extractions. */
        await this._dreamer.stop();
        for (const controller of [...this._extractor._timers.values()]) {
            controller.abort();
        }
        this._extractor._timers.clear();
    }

    get is_idle(): boolean {
        return this._dreamer.is_idle;
    }

    async _on_user_prompt(event: unknown): Promise<void> {
        /** On user_prompt_submit: touch dreamer + run resilient memory
         *  recall (C3, untrusted framing) + C1 always-inject block + C4 wiki
         *  claims + Reflexion 检索适用的前置避坑反思. */
        this._dreamer.touch();
        const ev = event as { payload?: JsonDict; modify?(p: JsonDict): unknown };
        const payload = (ev.payload ?? {}) as JsonDict;
        const message = (gget(payload, "message", "") ?? "") as string;
        const context = ((pyTruth(gget(payload, "context")) ? payload["context"] : {}) ?? {}) as JsonDict;

        // ── C1: always-inject tier block (WORKING + LONG_TERM) ──
        const inject = this.inject_block();
        if (inject) {
            context["memory_inject"] = inject;
        }

        // ── C3: resilient recall with untrusted framing ──
        const evAny = event as Record<string, unknown>;
        const sidPick = pyTruth(payload["session_id"])
            ? payload["session_id"]
            : pyTruth(payload["sessionId"])
              ? payload["sessionId"]
              : pyTruth(evAny["session_id"])
                ? evAny["session_id"]
                : "";
        const session_id = pyStr(sidPick);
        const bidPick = pyTruth(payload["branch_id"])
            ? payload["branch_id"]
            : pyTruth(payload["branchId"])
              ? payload["branchId"]
              : pyTruth(evAny["branch_id"])
                ? evAny["branch_id"]
                : "";
        const branch_id = pyStr(bidPick);
        const [recalledRaw, meta] = await this.active_recall(message, 5, session_id, branch_id);
        const recalled = recalledRaw;
        if (recalled) {
            context["injected_memories"] = recalled;
            context["_memory_meta"] = meta as unknown;
        }

        // ── C4: wiki claims ──
        const wiki_block = this._render_wiki();
        if (wiki_block) {
            context["wiki_claims"] = wiki_block;

        }

        // ── Reflexion ──
        try {
            const ref_block = get_reflection_store().format_reflection_context(message, undefined, 3);
            if (ref_block) {
                context["reflections"] = ref_block;
            }
        } catch {
            /* swallow, like the source's except Exception */
        }

        if (inject || recalled || wiki_block || pyTruth(gget(context, "reflections"))) {
            ev.modify?.({ ...payload, context: context });
        }
    }

    _render_wiki(): string {
        /** C4: render wiki claims for prompt injection. Lazy-loads WikiStore. */
        try {
            return this.wiki.renderBlock(this._root_dir);
        } catch {
            return "";
        }
    }

    get wiki(): WikiStore {
        /** C4 declarative-knowledge store (claims / confidence /
         *  contradictions). Shared via ``_origin``. */
        const origin = this._origin;
        if (origin._wiki === null || origin._wiki === undefined) {
            origin._wiki = new WikiStore(origin.storage as unknown as { _db(name: string): never });
        }
        return origin._wiki;
    }

    // ------------------------------------------------------------------
    // 1. Debounced extraction
    // ------------------------------------------------------------------

    extract(text: string, context: string = ""): Memory[] {
        /** Extract facts/preferences from conversation text (regex
         *  fallback). */
        if (!this.memory_enabled) {
            return [];
        }
        const memories: Memory[] = [];
        for (const [mem_type, pats] of Object.entries(MemoryLayer._EXTRACT_PATTERNS)) {
            for (const pat of pats) {
                const rx = new RegExp(pat, "gi");
                for (const match of text.matchAll(rx)) {
                    const mem = new Memory(
                        match[0],
                        mem_type,
                        0.7,
                        context ? MemoryScope.SESSION : MemoryScope.PROJECT,
                        this._root_dir,
                        pyStr(context ?? ""),
                    );
                    mem.add_tag("extracted");
                    memories.push(mem);
                }
            }
        }
        return memories;
    }

    async extract_from_file(file_path: string, opts: { scope?: JsonDict | null } = {}): Promise<void> {
        /** Read a file and extract memories from its content (debounced
         *  trigger). */
        let scope = opts.scope ?? null;
        let content: string;
        try {
            const raw = fs.readFileSync(file_path);
            // encoding="utf-8", errors="replace" — TextDecoder's default is
            // U+FFFD replacement, same as CPython's.
            content = pySlice(new TextDecoder("utf-8").decode(raw), 0, 50000);
        } catch {
            return;
        }

        let extracted: Memory[] = [];
        // The source wraps everything below in one outer `try: ... except
        // Exception: end_span(error)` — i.e. any failure after the read is
        // swallowed whole. Mirror that exactly; the arrow mirrors Python's
        // function-scope rebinding of `extracted`.
        try {
            await (async () => {
        if (this._llm) {
            try {
                const prompt = this._build_extraction_prompt(file_path, content);
                const result = await (this._llm as (p: unknown) => unknown)(prompt);
                extracted = this._parse_llm_extraction(result, file_path);
            } catch {
                extracted = [];
            }
            if (!extracted.length) {
                // Model returned prose / nothing usable — keep the regex pass
                // so a wired LLM is never worse than no LLM.
                extracted = this.extract(content);
                for (const m of extracted) {
                    m.root_dir = this._root_dir;
                }
            }
        } else {
            extracted = this.extract(content);
            for (const m of extracted) {
                m.root_dir = this._root_dir;
            }
        }

        for (const mem of extracted) {
            this.store(mem);
        }

        // 补强（Step C & P0-4）：抽取结果发射成 memory.extracted 事件，带完整
        // 6 维结构化溯源与 event_id
        if (extracted.length) {
            try {
                scope = pyTruth(scope) ? scope : {};
                const selfAny = this as unknown as Record<string, unknown>;
                const pick = (k: string): string => {
                    const a = (scope as JsonDict)[k];
                    if (pyTruth(a)) return pyStr(a);
                    const b = selfAny["_" + k];
                    if (pyTruth(b)) return pyStr(b);
                    const c = selfAny[k];
                    if (pyTruth(c)) return pyStr(c);
                    return "";
                };
                const sidRaw = pyTruth((scope as JsonDict)["session_id"])
                    ? pyStr((scope as JsonDict)["session_id"])
                    : pyTruth((this as unknown as Record<string, unknown>)["_session_id"])
                      ? pyStr((this as unknown as Record<string, unknown>)["_session_id"])
                      : pyTruth((this as unknown as Record<string, unknown>)["session_id"])
                        ? pyStr((this as unknown as Record<string, unknown>)["session_id"])
                        : `workspace:${this._root_dir}`;
                const bid = pick("branch_id") || "";
                const tid = pick("turn_id") || "";
                const eid = pick("episode_id") || "";
                const gid = pick("goal_id") || "";
                const rid = pick("run_id") || "";
                const event_id = `mem_ext_${pySlice(uuidHex(), 0, 12)}`;
                this.storage.trace_event({
                    session_id: sidRaw,
                    event_type: "memory.extracted",
                    payload: {
                        event_id,
                        file: file_path,
                        count: extracted.length,
                        facts: extracted.map((m) => pySlice(pyStr(m.content), 0, 200)),
                        session_id: sidRaw,
                        branch_id: bid,
                        turn_id: tid,
                        episode_id: eid,
                        goal_id: gid,
                        run_id: rid,
                        workspace_root: this._root_dir,
                        source_event_ids: [event_id],
                    },
                    importance: "observational",
                    branch_id: bid ? bid : null,
                    turn_id: tid ? tid : null,
                    goal_id: gid ? gid : null,
                });
            } catch (e) {
                pyPrint(`[memory] extracted-event mirror failed: ${errStr(e)}`);
            }
        }

        if (extracted.length) {
            await this._update_agents_md(extracted);
        }
            })();
        } catch {
            /* 外层 except Exception: 只 end_span(error)（遥测已删）——整体静默 */
        }
    }

    _build_extraction_prompt(file_path: string, content: string): JsonDict {
        /** Craft the extraction instruction handed to the LLM callback. The
         *  regex-only extractor was hand-tuned for chat turns; this prompt
         *  adapts the same shape for arbitrary edited files and asks
         *  explicitly for JSON so `_parse_llm_extraction` gets what it
         *  expects. */
        return {
            task: "memory_extraction",
            instruction:
                "You are updating a project's long-term memory (AGENTS.md).\n" +
                "Extract ONLY high-value, reusable project knowledge, architecture conventions, and developer preferences.\n" +
                "Language requirement: Output MUST be in Simplified Chinese (简体中文) unless referencing exact code identifiers.\n" +
                "Path requirement: NEVER use local absolute paths like C:\\Users\\... — ALWAYS use relative workspace paths (e.g. `output/`).\n" +
                "Return ONLY a JSON object, no prose, no code fences:\n" +
                '{"facts": ["..."], "preferences": ["..."], ' +
                '"context": ["..."], "procedures": ["..."], "gotchas": ["..."]}\n' +
                "Rules:\n" +
                "- Skip boilerplate (imports, license headers, trivial file I/O).\n" +
                "- Skip anything that looks like a secret or API key.\n" +
                "- Each item must be a single, clear, human-readable sentence in Chinese.\n" +
                "- Empty arrays are fine — don't invent memories.\n" +
                "- `gotchas` are traps that cost real time: a command that looks\n" +
                "  right and fails silently, an API that returns something other\n" +
                "  than its name implies, a workaround that exists for a reason\n" +
                "  nobody wrote down. Write them as 'do X, not Y, because Z'.\n" +
                "  A gotcha is NOT a missing feature and NOT a TODO.",
            file: nodePath.basename(file_path),
            content: content,
        };
    }

    _parse_llm_extraction(result: unknown, file_path: string): Memory[] {
        /** Parse LLM extraction result into Memory objects. */
        const memories: Memory[] = [];
        if (!result || typeof result !== "object" || Array.isArray(result)) {
            return memories;
        }
        const r = result as JsonDict;
        const type_map: ReadonlyArray<readonly [string, string]> = [
            ["facts", MemoryType.FACT],
            ["preferences", MemoryType.PREFERENCE],
            ["context", MemoryType.CONTEXT],
            ["procedures", MemoryType.PROCEDURE],
            ["gotchas", MemoryType.GOTCHA],
        ];
        for (const [key, mem_type] of type_map) {
            let items = gget(r, key, []);
            if (items === undefined) items = [];
            let iterable: unknown[];
            if (Array.isArray(items)) {
                iterable = items;
            } else if (typeof items === "string") {
                iterable = Array.from(items); // py iterates a str by chars
            } else if (items && typeof items === "object") {
                iterable = Object.keys(items); // py iterating a dict yields keys
            } else {
                throw new TypeError(`'${pyStr(items)}' object is not iterable`);
            }
            for (const item of iterable) {
                if (typeof item === "string") {
                    const imp_key = r["importance"] === undefined ? {} : r["importance"];
                    if (typeof imp_key !== "object" || imp_key === null) {
                        throw new TypeError("importance map is not a dict");
                    }
                    const imp_bag = imp_key as JsonDict;
                    const importance = Object.prototype.hasOwnProperty.call(imp_bag, item)
                        ? imp_bag[item]
                        : 0.6;
                    const mem = new Memory(item, mem_type, importance as number, MemoryScope.PROJECT, this._root_dir);
                    mem.add_tag("llm_extracted");
                    mem.add_tag(nodePath.basename(file_path));
                    memories.push(mem);
                }
            }
        }
        return memories;
    }

    static _CONTEXT_HEADING: string = "## Project Context";

    async _update_agents_md(memories: Memory[]): Promise<void> {
        /** Turn extracted memories into **pending proposals**, never a direct
         *  write. P0-4 fix: AGENTS.md is injected into every turn and the old
         *  bare ``open("w")`` was prompt injection with persistence. The same
         *  lines are still derived, still deduped against what is on disk, and
         *  the memories still land in the DB — but reaching AGENTS.md now
         *  requires a human clicking accept. If the evolution subsystem is
         *  off there is no queue: nothing is proposed and a line is logged
         *  saying so. */
        if (!memories.length) {
            return;
        }
        const agents_md_path = nodePath.join(this._root_dir, "AGENTS.md");
        const new_lines = memories.map((m) => `- [${m.type}] ${m.content}`);

        let existing = "";
        try {
            if (fs.existsSync(agents_md_path)) {
                existing = this._readTextStrict(agents_md_path);
            }
        } catch {
            existing = "";
        }

        const [_head, old_lines, _tail] = this._split_context_section(existing);
        const on_disk = new Set<string>();
        for (const ln of pySplitlines(existing)) {
            if (ln.trim()) on_disk.add(ln.trim());
        }
        for (const ln of old_lines) {
            on_disk.add(ln.trim());
        }
        const fresh = new_lines.filter((ln) => !on_disk.has(ln.trim()));

        // DB-only bookkeeping: what the extractor believes the project context
        // is. This never touched the filesystem and needs no approval.
        const section =
            `${MemoryLayer._CONTEXT_HEADING}\n` +
            `<!-- proposed by memory layer; ` +
            `last extraction ${strftimeMin()} -->\n` +
            [...old_lines, ...fresh].join("\n");
        try {
            this.storage.update_memory_index(this._root_dir, section);
        } catch (exc) {
            pyPrint(`[memory] memory index update failed: ${errStr(exc)}`);
        }

        if (!fresh.length) {
            return;
        }
        await this._queue_context_proposals(fresh);
    }

    /** fs.read with CPython's strict `open(..., encoding="utf-8")`: invalid
     *  bytes raise instead of replacing (the source's UnicodeDecodeError is
     *  NOT an OSError, so callers' except-OSError handlers must not catch
     *  it — a plain Error keeps that shape here). */
    _readTextStrict(p: string): string {
        const buf = fs.readFileSync(p);
        return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    }

    async _queue_context_proposals(lines: string[]): Promise<number> {
        /** Put extracted context lines in the evolution approval queue.
         *  Returns the number of proposals actually created. The import is
         *  dynamic and failure is logged rather than raised: memory
         *  extraction is a background best-effort path, and an unavailable
         *  optional subsystem must not take a user's turn down with it. What
         *  it must NOT do is fall back to writing. */
        let evo: any;
        try {
            evo = await _import_unported("evolution");
            if (!evo.Proposal || !evo.get_evolution_engine || !evo.signature_for || !evo.MODE_POLICIES) {
                throw new Error("cannot import name(s) from 'evolution'");
            }
        } catch (exc) {
            pyPrint(
                `[memory] cannot propose context lines (evolution unavailable): ${errStr(exc)}`,
            );
            return 0;
        }

        const engine = evo.get_evolution_engine(this._root_dir);
        if (!engine.enabled()) {
            pyPrint(
                `[memory] ${lines.length} extracted context line(s) NOT written to ` +
                `AGENTS.md: evolution is off, so there is no approval queue. ` +
                `They remain in memory storage and are still recalled.`,
            );
            return 0;
        }

        const policy = evo.MODE_POLICIES[engine.mode] ?? null;
        if (policy === null || policy === undefined) {
            return 0;
        }
        let made = 0;
        for (const line of lines.slice(0, MemoryLayer.MAX_CONTEXT_PROPOSALS)) {
            if (engine.store.count_open() >= policy.max_open) {
                break;
            }
            // 签名必须带 kind。共用 "extracted_context" 一个命名空间时，
            // `[gotcha] X` 与 `[fact] X` 的正文相同就会被判为同一条已提过的
            // 提案——坑和事实正好是两种都要留的东西，去重掉一条等于丢一条。
            const kind = _kind_of_extracted_line(line);
            // 提案的 kind 跟着走，审批队列里才能一眼分清"这条是坑"。
            const sig = evo.signature_for(`extracted_${kind}`, "", line);
            if (engine.store.has_open_for_signature(sig)) {
                continue;
            }
            const last_rej = engine.store.last_rejected_at(sig);
            if (pyTruth(last_rej) && Date.now() / 1000 - pyFloat(last_rej) < pyFloat(policy.reject_cooldown_s)) {
                continue;
            }
            let clean_line = line.replace(/^\[(?:fact|preference|context|procedure|gotcha)\]\s*/i, "").trim();
            // 路径相对化与清洗
            clean_line = clean_line.replace(/[A-Za-z]:\\[^\s']+[\\/]([A-Za-z0-9_-]+)[\\/]?/g, "$1/");
            clean_line = clean_line.replace(/\/[^\s']+\/([A-Za-z0-9_-]+)\/?/g, "$1/");
            const clean_draft = clean_line.startsWith("-") ? clean_line : `- ${clean_line}`;
            engine.store.insert_proposal(new evo.Proposal({
                id: pySlice(uuidHex(), 0, 12),
                signature: sig,
                kind: `extracted_${kind}`,
                tool_name: "",
                target_file: "AGENTS.md",
                draft: clean_draft,
                rationale: kind === "gotcha"
                    ? GOTCHA_RATIONALE
                    : "从您最近编辑的文件中提炼的项目常识 · 采纳后将写入项目规范并持续生效",
                hits: 1,
                status: "pending",
                created_at: Date.now() / 1000,
            }));
            made += 1;
        }
        return made;
    }

    /** Cap on how many context lines one extraction may queue. Same reasoning
     *  as evolution.MAX_FACT_PROPOSALS: a queue nobody can clear gets bulk-
     *  rejected, which is functionally identical to the feature not existing. */
    static MAX_CONTEXT_PROPOSALS: number = 5;

    _split_context_section(text: string): [string, string[], string] {
        /** Split AGENTS.md into (before, existing bullet lines, after). */
        if (!text.includes(MemoryLayer._CONTEXT_HEADING)) {
            return [text, [], ""];
        }
        const idx = text.indexOf(MemoryLayer._CONTEXT_HEADING);
        const head = text.slice(0, idx);
        const rest = text.slice(idx + MemoryLayer._CONTEXT_HEADING.length);
        const next_section = rest.indexOf("\n## ");
        const body = next_section === -1 ? rest : rest.slice(0, next_section);
        const tail = next_section === -1 ? "" : rest.slice(next_section);
        const lines: string[] = [];
        for (const ln of pySplitlines(body)) {
            if (ln.trim().startsWith("- ")) lines.push(ln.trim());
        }
        return [head, lines, tail];
    }

    _legacy_update_agents_md(memories: Memory[]): void {
        /** Deprecated overwrite-style writer, kept only for reference. */
        const agents_md_path = nodePath.join(this._root_dir, "AGENTS.md");
        const sections = memories.map((m) => `- [${m.type}] ${m.content}`);
        const new_context =
            `\n## Project Context (auto-extracted ${strftimeMin()})\n` +
            sections.join("\n");
        let existing = "";
        try {
            if (fs.existsSync(agents_md_path)) {
                existing = this._readTextStrict(agents_md_path);
            }
            if (existing.includes("## Project Context")) {
                const idx = existing.indexOf("## Project Context");
                const next_section = existing.indexOf("\n## ", idx + 1);
                if (next_section === -1) {
                    existing = pyRstrip(existing.slice(0, idx)) + new_context + "\n";
                } else {
                    existing =
                        pyRstrip(existing.slice(0, idx)) + new_context + "\n" +
                        existing.slice(next_section);
                }
            } else {
                existing = pyRstrip(existing) + new_context + "\n";
            }
            fs.writeFileSync(agents_md_path, existing, "utf-8");
        } catch {
            // fail-open: 可选增强，失败不影响主流程
        }
    }

    // ------------------------------------------------------------------
    // 2. Dream consolidation
    // ------------------------------------------------------------------

    dream(limit: number = 10): string {
        /** Generate a dream summary from recent memories (legacy API). */
        const recent = this.storage.get_memory_entries(this._root_dir, null, false, limit) ?? [];
        if (!recent.length) {
            return "No memories yet.";
        }
        const parts = recent.map(
            (m) => `[${pyStr(gget(m, "type", ""))}] ${pyStr(gget(m, "content", ""))}`,
        );
        return "Memory dream:\n" + parts.join("\n");
    }

    _dream_pool(since: number): JsonDict[] {
        /** 这一趟要看的记忆池：最近新增的 + 长期欠整理的。欠整理的放前面：
         *  预算裁剪是从头保留的（见 :meth:`_dream_inputs`），排在后面就等于
         *  永远被裁掉。按 id 去重，同一条不占两份预算。 */
        const pool: JsonDict[] = [];
        const seen = new Set<string>();
        let review: JsonDict[];
        try {
            review = this.storage.list_memories_needing_review(this._root_dir, 20);
        } catch (e) {
            pyPrint(`[dream] 欠整理清单没查到：${errStr(e)}`);
            review = [];
        }
        const all = [...(review ?? [])].concat(
            ...(this.storage.get_memory_entries(this._root_dir, null, false, 50, since) ?? []),
        );
        for (const r of all) {
            const rid = pyStr(pyTruth(r["id"]) ? r["id"] : "");
            if (!rid || seen.has(rid)) {
                continue;
            }
            seen.add(rid);
            pool.push(r);
        }
        return pool;
    }

    _dream_inputs(recent: JsonDict[], reserved: number = 0): [JsonDict[], string, number] {
        /** 裁到预算之内的输入 + 它的幂等键。返回 ``(rows, idem_key, tokens)``。
         *  键取内容而不是时间窗：同一批记忆无论什么时候再跑一遍，键都一样。
         *  ``reserved`` 是旁证已经吃掉的预算，不扣的话预算就是假的。 */
        const budget = Math.max(0, DreamConsolidator.MAX_INPUT_TOKENS - (pyInt(reserved || 0)));
        const kept: JsonDict[] = [];
        let tokens = 0;
        for (const r of recent) {
            const cost = estimate_tokens(pyStr(gget(r, "content", "")));
            if (tokens + cost > budget) {
                break;
            }
            kept.push(r);
            tokens += cost;
        }
        const ids = kept.map((r) => pyStr(pyTruth(r["id"]) ? r["id"] : "")).sort(pyStrLess);
        let key = "";
        if (ids.length) {
            key = pySlice(
                crypto.createHash("sha256").update(Buffer.from(`${this._root_dir}|${ids.join("|")}`, "utf-8")).digest("hex"),
                0, 32,
            );
        }
        return [kept, key, tokens];
    }

    /** 旁证的条数上限。旁证是判据不是主角，多了会把记忆本身挤出预算。 */
    static _CTX_BUNDLES: number = 5;
    static _CTX_EXPERIENCES: number = 8;

    async _dream_context(): Promise<JsonDict> {
        /** 只读的旁证：最近的目标学习结论 + 技能经验（§10.1）。它们**不进
         *  merge_ids**：一条技能经验不是记忆。它们的作用是判据。两个来源都
         *  可能不可用，少一块就少一块，不报错：Dream 的价值不该依赖在场。 */
        const ctx: JsonDict = {};
        try {
            const evo = await _import_unported("evolution");
            const eng = evo.get_evolution_engine();
            if (eng.enabled()) {
                ctx["goalLearnings"] = eng.store
                    .list_bundles({ limit: MemoryLayer._CTX_BUNDLES })
                    .map((b: JsonDict) => ({
                        decision: pyStr(pyTruth(b["decision"]) ? b["decision"] : ""),
                        why: pySlice(pyStr(pyTruth(b["rationale"]) ? b["rationale"] : ""), 0, 200),
                    }))
                    .filter((x: JsonDict) => !["", "NO_OP"].includes(x["decision"] as string));
            }
        } catch (e) {
            pyPrint(`[dream] 目标学习结论没读到：${errStr(e)}`);
        }
        try {
            ctx["skillExperiences"] = this.storage
                .list_skill_experiences({ limit: MemoryLayer._CTX_EXPERIENCES })
                .map((ex: JsonDict) => ({
                    skill: pyStr(pyTruth(ex["skill_id"]) ? ex["skill_id"] : ""),
                    outcome: pyStr(pyTruth(ex["outcome"]) ? ex["outcome"] : ""),
                    failure: pyStr(pyTruth(ex["failure_class"]) ? ex["failure_class"] : ""),
                    feedback: pySlice(pyStr(pyTruth(ex["user_feedback"]) ? ex["user_feedback"] : ""), 0, 160),
                }));
        } catch (e) {
            pyPrint(`[dream] 技能经验没读到：${errStr(e)}`);
        }
        const out: JsonDict = {};
        for (const [k, v] of Object.entries(ctx)) {
            if (pyTruth(v)) out[k] = v;
        }
        return out;
    }

    _build_dream_prompt(rows: JsonDict[], context?: JsonDict | null): JsonDict {
        /** 整合要问模型的那句话。原来这里直接 ``self._llm(rows)``，把数据库行
         *  丢给回调——生产回调 ``llm_client.call`` 只认 str / 带 instruction 的
         *  dict，于是 Dream 每一趟都以"模型没有给出可用的整合结论"收尾。
         *  只投影 id / 内容 / 类型 / 状态四项，不是整行：行里带 embedding 向量。 */
        const items: JsonDict[] = [];
        for (const r of rows) {
            items.push({
                id: pyStr(pyTruth(r["id"]) ? r["id"] : ""),
                content: pyStr(pyTruth(r["content"]) ? r["content"] : ""),
                type: pyStr(
                    pyTruth(r["mem_type"]) ? r["mem_type"]
                        : pyTruth(r["type"]) ? r["type"] : "",
                ),
                status: pyStr(pyTruth(r["status"]) ? r["status"] : "active"),
                source: pyStr(pyTruth(r["created_by"]) ? r["created_by"] : ""),
                conflicting: !["", "[]"].includes(pyStr(pyTruth(r["conflict_set"]) ? r["conflict_set"] : "[]")),
            });
        }
        const prompt: JsonDict = {
            task: "memory_consolidation",
            instruction:
                "You are consolidating long-term memory .\n" +
                "Synthesize memories below into durable, high-value statements so future sessions can orient quickly.\n" +
                "Find memories that are redundant, overlapping, or in contradiction, and merge them into ONE consolidated record.\n" +
                "Return ONLY a JSON object, no prose, no code fences:\n" +
                '{"summary": "...", "merge_ids": ["...", "..."]}\n\n' +
                "Three Golden Memory Principles:\n" +
                "1. Applicable: Must provide actionable, concrete context or factual rules that future sessions can immediately use.\n" +
                "2. Durable: Focus on enduring truths, project conventions, and user preferences; discard ephemeral transient state.\n" +
                "3. Legible: Single self-contained sentence, written in the same language as the source memories, clear and crisp.\n\n" +
                "Conflict & Security Rules:\n" +
                "- When memories contradict, the newer fact wins. User-explicit memories (source: 'user') strictly override inferred ones.\n" +
                "- `merge_ids` must strictly come from the provided `memories` list.\n" +
                "- Never include secrets, tokens, passwords, or API keys.\n" +
                '- If there is nothing meaningful to consolidate, return {"summary": "", "merge_ids": []}.\n',
            memories: items,
        };
        if (pyTruth(context)) {
            prompt["context"] = context;
        }
        return prompt;
    }

    _parse_dream_result(result: unknown): [string, string[]] {
        /** 从模型回复里取 ``(summary, raw_ids)``。取不到就 ``("", [])``。
         *  回调不一定是 llm_client.call（测试替身、别的客户端），退回文本时也要
         *  能读：一句"没什么可合的"散文应该等于"这趟不提案"，而不是一个异常。 */
        let data = result;
        if (typeof data === "string") {
            const s = data.trim();
            const start = s.indexOf("{");
            const end = s.lastIndexOf("}");
            if (start >= 0 && start < end) {
                try {
                    data = JSON.parse(s.slice(start, end + 1));
                } catch {
                    return ["", []];
                }
            } else {
                return ["", []];
            }
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            return ["", []];
        }
        const d = data as JsonDict;
        const summary = pyStr(pyTruth(d["summary"]) ? d["summary"] : "").trim();
        let raw = pyTruth(d["merge_ids"]) ? d["merge_ids"] : [];
        if (!Array.isArray(raw)) {
            raw = [];
        }
        return [summary, (raw as unknown[]).map((i) => pyStr(i))];
    }

    async _dream_observe(job_id: string, summary: string, merge_ids: string[]): Promise<[string, string, unknown]> {
        /** 把这一趟 Dream 的产物记成一条 EvolutionObservation。返回
         *  ``(decision, reason, obs)``；``obs`` 给 :meth:`_dream_bundle` 用，
         *  档位 off 或记账失败时是 ``None``。两个账本用 ``run_id == job_id``
         *  对上；顺带让 Dream 也过同一道秘密闸门（classify_observation 嗅到
         *  凭证形状就判 NO_OP）。 */
        try {
            const evo = await _import_unported("evolution");
            const engine = evo.get_evolution_engine();
            if (!engine.enabled()) {
                return ["", "", null];
            }
            const obs = new evo.EvolutionObservation({
                run_id: job_id,
                session_id: "dream",
                used_memory: [...(merge_ids ?? [])],
                new_facts: [summary],
                created_at: Date.now() / 1000,
            });
            engine.observe(obs);
            return [
                pyStr(pyTruth(obs.decision) ? obs.decision : ""),
                pyStr(pyTruth(obs.reason) ? obs.reason : ""),
                obs,
            ];
        } catch (e) {
            // 记账失败不能吃掉提案：Dream 的价值不依赖 evolution 库可用。
            pyPrint(`[dream] 观察没记下来：${errStr(e)}`);
            return ["", "", null];
        }
    }

    async _dream_bundle(obs: unknown, job_id: string, proposal_id: string, outcome: string): Promise<void> {
        /** 给这一趟 Dream 落一条 LearningBundle。被拒的那趟也要落
         *  （``outcome="refused"``）："为什么没学"也是审计要回答的问题。
         *  ``bundle_key`` 取 ``dream:{job_id}``，job_id 本身按输入内容幂等。 */
        if (obs === null || obs === undefined || !job_id) {
            return;
        }
        try {
            const evo = await _import_unported("evolution");
            await evo.get_evolution_engine().emit_learning_bundle(
                obs,
                { memoryProposals: proposal_id ? [proposal_id] : [] },
                { bundle_key: `dream:${job_id}`, outcome: outcome },
            );
        } catch (e) {
            pyPrint(`[dream] bundle 没落下来：${errStr(e)}`);
        }
    }

    async dream_consolidate(controller?: AbortController | null): Promise<void> {
        /** 后台整合：把冗余记忆合并成一条更高层的理解——但只**提议**，不执行。
         *  §10.2：产物进 proposal，由人裁决（candidate + supersedes 形状）。
         *  §10.3：整趟跑在有账本的 job 里——job_id、租约、心跳、墙上时间上限、
         *  输入 token 上限、幂等键、取消语义。无论走哪条分支都会往
         *  ``dream_runs`` 写一行结论（DreamJournal）。提案落盘前还要过观察层。
         *  DIVERGENCE(port): asyncio 取消 → AbortController；取消检查点即源里
         *  的 await 边界（sleep / LLM 调用），取消语义与 finish(cancelled) 逐
         *  一对应。 */
        let job_id = "";
        let beat: AbortController | null = null;
        const t0 = Date.now() / 1000;
        try {
            const since = Math.floor(Date.now() / 1000) - DreamConsolidator.LOOKBACK_SECONDS;
            const recent = this._dream_pool(since);
            if (recent.length < 3) {
                return;
            }

            // 旁证先算，因为它要从同一个 token 预算里扣（见 _dream_inputs）。
            const ctx = await this._dream_context();
            this._throwIfCancelled(controller);
            const ctx_tokens = pyTruth(ctx) ? estimate_tokens(pyJsonDumps(ctx)) : 0;
            const [rows, idem_key, tokensRaw] = this._dream_inputs(recent, ctx_tokens);
            let tokens = tokensRaw + ctx_tokens;
            if (rows.length < 3) {
                return;
            }

            const [claimed, verdict] = this.storage.claim_dream_run(this._root_dir, idem_key, {
                lease_seconds:
                    DreamConsolidator.MAX_WALL_SECONDS +
                    DreamConsolidator.HEARTBEAT_SECONDS * 2,
            });
            job_id = claimed;
            if (!job_id) {
                // busy = 别的进程在做同一批；done = 这批已经出过提案了。两种都
                // 不该重做，也都不是错误。
                pyPrint(`[dream] 跳过：${verdict}`);
                return;
            }

            beat = new AbortController();
            const beatPromise = this._dream_heartbeat(job_id, beat);

            if (!this._llm) {
                // 没有 LLM 就没有可靠的合并依据。原来这里按内容前 100 字去重
                // 然后直接归档——精确等价的重复现在由写入闸门在落盘前挡掉。
                this.storage.update_memory_dream_time(this._root_dir);
                this.storage.finish_dream_run(job_id, "noop", {
                    outcome: "没有可用的模型，这一趟没有做任何合并",
                    input_count: rows.length,
                    tokens_used: tokens,
                    wall_ms: Math.trunc((Date.now() / 1000 - t0) * 1000),
                });
                beat.abort();
                await beatPromise.catch(() => undefined);
                return;
            }

            let result: unknown;
            try {
                const prompt = this._build_dream_prompt(rows, ctx);
                const call = Promise.resolve((this._llm as (p: unknown) => unknown)(prompt));
                // asyncio.wait_for(..., timeout=MAX_WALL_SECONDS)
                result = await this._wait_for(call, DreamConsolidator.MAX_WALL_SECONDS, controller);
            } catch (e) {
                if (e instanceof AsyncTimeoutError) {
                    this.storage.finish_dream_run(job_id, "failed", {
                        outcome: `模型超过 ${DreamConsolidator.MAX_WALL_SECONDS}s 没有返回`,
                        input_count: rows.length,
                        tokens_used: tokens,
                        wall_ms: Math.trunc((Date.now() / 1000 - t0) * 1000),
                    });
                    beat.abort();
                    await beatPromise.catch(() => undefined);
                    return;
                }
                if (isCancelled(e)) {
                    throw e; // 外层 cancelled 分支收尾
                }
                this.storage.finish_dream_run(job_id, "failed", {
                    outcome: `模型调用失败：${errStr(e)}`,
                    input_count: rows.length,
                    tokens_used: tokens,
                    wall_ms: Math.trunc((Date.now() / 1000 - t0) * 1000),
                });
                beat.abort();
                await beatPromise.catch(() => undefined);
                return;
            }

            // 落盘之前再确认一次租约还在自己手里。
            if (!this.storage.heartbeat_dream_run(job_id)) {
                pyPrint("[dream] 租约已经不属于这一趟，放弃写入");
                beat.abort();
                await beatPromise.catch(() => undefined);
                return;
            }

            let merge_ids: string[] = [];
            const [summary, raw_ids] = this._parse_dream_result(result);
            if (summary) {
                // 只认这一趟真的读过的那些 id。模型返回一个不在输入里的 id 就
                // 是幻觉，照着它归档等于让幻觉删用户的记忆。
                const seen_ids = new Set(rows.map((r) => pyStr(r["id"])));
                merge_ids = raw_ids.filter((i) => seen_ids.has(i));
                const dropped = raw_ids.length - merge_ids.length;
                if (dropped) {
                    pyPrint(`[dream] 丢掉 ${dropped} 个不在本轮输入里的 merge_id`);
                }
            }

            let proposal_id = "";
            let outcome = "";
            let status = "noop";
            if (summary) {
                const [decision, why, obs] = await this._dream_observe(job_id, summary, merge_ids);
                this._throwIfCancelled(controller);
                if (decision === "NO_OP") {
                    // 观察层看完证据说这条不该固化（最常见的是嗅到了凭证形状）。
                    // 提案不落盘，但理由要留在日记里。
                    await this._dream_bundle(obs, job_id, "", "refused");
                    this.storage.update_memory_dream_time(this._root_dir);
                    this.storage.finish_dream_run(job_id, "noop", {
                        outcome: `这条整合没有提交：${why}`,
                        input_count: rows.length,
                        tokens_used: tokens,
                        wall_ms: Math.trunc((Date.now() / 1000 - t0) * 1000),
                    });
                    beat.abort();
                    await beatPromise.catch(() => undefined);
                    return;
                }
                const dream_mem = new Memory(
                    summary,
                    MemoryType.DREAM,
                    0.9,
                    MemoryScope.PROJECT,
                    this._root_dir,
                    "",
                    null,
                    MemoryTier.DREAMING,
                );
                dream_mem.add_tag("dream");
                // 提案：未批准不进召回，也不动任何既有记忆。
                dream_mem.status = "candidate";
                dream_mem.supersedes = merge_ids;
                const r = this.store(dream_mem);
                if (r.ok) {
                    proposal_id = pyStr(r.value);
                    status = "done";
                    outcome = merge_ids.length
                        ? `提议把 ${merge_ids.length} 条记忆合并成 1 条，等你裁决`
                        : "提议新增 1 条整合记忆，等你裁决";
                } else {
                    status = "failed";
                    outcome = `提案没写下来：${pyStr(r.error)}`;
                    pyPrint(`[dream] ${outcome}`);
                }
                await this._dream_bundle(obs, job_id, proposal_id, r.ok ? "success" : "failure");
            } else {
                outcome = "模型没有给出可用的整合结论，这一趟什么都没改";
            }

            this.storage.update_memory_dream_time(this._root_dir);
            this.storage.finish_dream_run(job_id, status, {
                outcome: outcome,
                proposal_id: proposal_id,
                input_count: rows.length,
                tokens_used: tokens,
                wall_ms: Math.trunc((Date.now() / 1000 - t0) * 1000),
            });
            beat.abort();
            await beatPromise.catch(() => undefined);
        } catch (e) {
            if (isCancelled(e)) {
                // 取消是协作式的：走到这里说明我们停在某个 await 上，没有半个
                // 写入。
                if (job_id) {
                    this.storage.finish_dream_run(job_id, "cancelled", {
                        outcome: "被取消（前台有事要做或应用退出）",
                        wall_ms: Math.trunc((Date.now() / 1000 - t0) * 1000),
                    });
                }
                throw e;
            }
            if (job_id) {
                this.storage.finish_dream_run(job_id, "failed", {
                    outcome: `这一趟出错了：${errStr(e)}`,
                    wall_ms: Math.trunc((Date.now() / 1000 - t0) * 1000),
                });
            }
        } finally {
            if (beat !== null) {
                beat.abort();
            }
        }
    }

    async _dream_heartbeat(job_id: string, controller?: AbortController | null): Promise<void> {
        /** 定期续租。续不上就说明这趟被接管或被取消了，让它自己安静结束。这里
         *  只负责报活，不负责中止——中止由主流程在落盘前那次 heartbeat 检查决
         *  定，这样取消永远发生在两次写入之间。 */
        try {
            for (;;) {
                await sleepMs(DreamConsolidator.HEARTBEAT_SECONDS, controller);
                if (!this.storage.heartbeat_dream_run(job_id)) {
                    return;
                }
            }
        } catch (e) {
            if (isCancelled(e)) {
                return;
            }
            throw e;
        }
    }

    _throwIfCancelled(controller?: AbortController | null): void {
        if (controller?.signal.aborted) {
            throw new CancelledError();
        }
    }

    /** asyncio.wait_for(coro, timeout) analogue: timeout wins over the call,
     *  caller cancellation wins over both. */
    _wait_for(promise: Promise<unknown>, timeout_s: number, controller?: AbortController | null): Promise<unknown> {
        return new Promise<unknown>((resolve, reject) => {
            const signal = controller?.signal;
            const onAbort = () => {
                clearTimeout(t);
                reject(new CancelledError());
            };
            const t = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                reject(new AsyncTimeoutError(`wait_for exceeded ${timeout_s}s`));
            }, timeout_s * 1000);
            if (signal?.aborted) {
                clearTimeout(t);
                reject(new CancelledError());
                return;
            }
            signal?.addEventListener("abort", onAbort, { once: true });
            promise.then(
                (v) => {
                    clearTimeout(t);
                    signal?.removeEventListener("abort", onAbort);
                    resolve(v);
                },
                (e) => {
                    clearTimeout(t);
                    signal?.removeEventListener("abort", onAbort);
                    reject(e);
                },
            );
        });
    }

    // ------------------------------------------------------------------
    // 3. Semantic prefetch (<memory> injection)
    // ------------------------------------------------------------------

    prefetch(
        query: string,
        limit: number = 5,
        root: string = "",
        session_id: string = "",
        branch_id: string = "",
    ): string {
        /** Retrieve relevant memories and format as <memory> XML for
         *  injection. C2: delegates to ``search_memory_hybrid`` (dense
         *  vectors fused with FTS5 keyword search), then decay + MMR. */
        try {
            const actual_root = root || this._root_dir;
            const keywords = this._extract_keywords(query);
            const query_vec = this._embed_text(query);
            const [resultsRaw] = this.storage.search_memory_hybrid(
                actual_root,
                query,
                query_vec,
                pyTruth(keywords) ? keywords : null,
                limit * RECALL_CANDIDATE_MULTIPLIER,
                undefined,
                undefined,
                session_id,
                branch_id,
            );
            let results = this._rerank(resultsRaw ?? [], query_vec, limit);
            if (!results.length) {
                return "";
            }
            // C1: count the recall so promotion can see load-bearing memories.
            this.note_recall(results);
            const blocks: string[] = [];
            const now = Date.now() / 1000;
            for (const m of results) {
                const scope = gget(m, "scope", "project");
                let content = gget(m, "content", "");
                const mem_type = gget(m, "type", "fact");
                // Drift marker: a memory's truth decays with its age. Tagging
                // WHICH rows are stale lets the model weigh them instead of
                // treating recall as ground truth.
                let age_days: number;
                try {
                    const ts = pyTruth(m["updated_at"])
                        ? m["updated_at"]
                        : pyTruth(m["created_at"]) ? m["created_at"] : 0;
                    age_days = (now - pyFloat(ts)) / 86400.0;
                } catch {
                    age_days = 0.0;
                }
                let content_s = pyStr(content);
                if (age_days >= 90) {
                    content_s += ' <drift note="可能已过时：超过 90 天未更新，当作线索而非事实，使用前向用户确认"/>';
                } else if (age_days >= 30) {
                    content_s += ' <drift note="较旧：超过 30 天未更新"/>';
                }
                blocks.push(`<memory context="${pyStr(scope)}" type="${pyStr(mem_type)}">${content_s}</memory>`);
            }
            // 跨会话相关发现（Phase 36）：主召回之外再扫一遍全库（session_id
            // 置空 = 不做会话过滤），取属于**其他会话**的 top 命中。定位为提示
            // 而非事实，条数与长度都从严。
            try {
                const cross = this._cross_session_hits(query, actual_root, {
                    exclude_session: session_id, limit: 2,
                });
                for (const m of cross) {
                    const sid = pySlice(pyStr(pyTruth(m["session_id"]) ? m["session_id"] : "unknown"), 0, 18);
                    const snippet = pySlice(pyStr(gget(m, "content", "")), 0, 260);
                    blocks.push(
                        `<memory context="cross-session" type="discovery" session="${sid}">` +
                        `${snippet} <drift note="来自其他会话的相关发现：仅作线索，使用前与用户确认"/></memory>`,
                    );
                }
            } catch {
                // 跨会话通道失败不阻塞主召回
            }
            // Phase 60 联动: 拓扑图谱关联召回 (Knowledge Graph Recall)
            try {
                const graph_engine = get_graph_memory_engine(this.storage);
                const graph_edges: JsonDict[] = [];
                for (const kw of (pyTruth(keywords) ? keywords : [query]).slice(0, 3)) {
                    const edges = graph_engine.recall_associative_graph(kw, actual_root, 2);
                    if (edges && edges.length) {
                        graph_edges.push(...edges);
                    }
                }
                if (graph_edges.length) {
                    const seen_edges = new Set<string>();
                    const unique_edges: JsonDict[] = [];
                    for (const e of graph_edges) {
                        const edge_sig = JSON.stringify([e["source"] ?? null, e["relation"] ?? null, e["target"] ?? null]);
                        if (!seen_edges.has(edge_sig)) {
                            seen_edges.add(edge_sig);
                            unique_edges.push(e);
                        }
                    }
                    const graph_prompt = graph_engine.format_graph_for_prompt(unique_edges.slice(0, 5));
                    if (graph_prompt) {
                        blocks.push(`<memory context="knowledge_graph" type="graph">${graph_prompt}</memory>`);
                    }
                }
            } catch {
                /* swallow, like the source */
            }

            // Phase 62 约束: 25KB 容量预算与 150 字符单行约束
            const capped_blocks = MemoryIndexCapper.enforce_budget(blocks);
            return capped_blocks.join("\n");
        } catch {
            return "";
        }
    }

    _cross_session_hits(
        query: string,
        root: string,
        opts: { exclude_session: string; limit?: number },
    ): JsonDict[] {
        /** 全库检索中属于**其他会话**的 top 命中（跨会话发现）。复用 C2 混合
         *  检索；过滤掉本会话与无归属的全局条目，只留"别的对话里聊过什么"。 */
        const exclude_session = opts.exclude_session;
        const limit = opts.limit ?? 2;
        const keywords = this._extract_keywords(query);
        const [resultsRaw] = this.storage.search_memory_hybrid(
            root,
            query,
            this._embed_text(query),
            pyTruth(keywords) ? keywords : null,
            limit + 6,
            undefined,
            undefined,
            "",
            "",
        );
        const out: JsonDict[] = [];
        for (const m of resultsRaw ?? []) {
            const sid = pyStr(pyTruth(m["session_id"]) ? m["session_id"] : "");
            if (!sid || sid === exclude_session) {
                continue;
            }
            out.push(m);
            if (out.length >= limit) {
                break;
            }
        }
        // Session message FTS: find past conversations mentioning this topic
        if (out.length < limit) {
            try {
                const ws_row = this.storage._db("sessions").execute(
                    "SELECT workspace FROM sessions WHERE id=?", [exclude_session || ""],
                ).fetchone() as Row | null;
                const workspace = pyStr(
                    pyTruth(ws_row ? (ws_row as JsonDict)["workspace"] : null)
                        ? (ws_row as JsonDict)["workspace"] : "",
                );
                for (const hit of this.storage.search_sessions_fts(query, workspace, limit)) {
                    const sid = pyStr(pyTruth(hit["session_id"]) ? hit["session_id"] : "");
                    if (!sid || sid === exclude_session) {
                        continue;
                    }
                    if (out.some((x) => pyStr(x["session_id"]) === sid)) {
                        continue;
                    }
                    out.push({
                        session_id: sid,
                        content: pyStr(pyTruth(hit["snippet"]) ? hit["snippet"] : ""),
                        scope: "session",
                        type: "conversation",
                    });
                    if (out.length >= limit) {
                        break;
                    }
                }
            } catch {
                /* swallow, like the source's except Exception */
            }
        }
        return out;
    }

    recall(query: string, limit: number = 5): Memory[] {
        /** Recall relevant memories (returns Memory objects). C2: hybrid
         *  retrieval (vector + FTS5 keyword fusion). */
        if (!this.memory_enabled) {
            return [];
        }
        try {
            const keywords = this._extract_keywords(query);
            const query_vec = this._embed_text(query);
            const [resultsRaw] = this.storage.search_memory_hybrid(
                this._root_dir,
                query,
                query_vec,
                pyTruth(keywords) ? keywords : null,
                limit * RECALL_CANDIDATE_MULTIPLIER,
            );
            const results = this._rerank(resultsRaw ?? [], query_vec, limit);
            this.note_recall(results);
            const mems = results.map((m) => Memory.from_dict(m));
            MemoryLayer._annotate_perishable(mems, results);
            return mems;
        } catch {
            return [];
        }
    }

    static _annotate_perishable(mems: Memory[], rows: JsonDict[]): void {
        /** 给带保质期的记忆补一句年龄提示（负面断言就是其中一种）。过了
         *  ``valid_until`` 的行读路径已经不返回了，这里管的是**还在保质期内
         *  但已经不新鲜**的那一段。只改这一次返回的 Memory 副本，不改库里的
         *  正文。 */
        if (!mems.length) {
            return;
        }
        const now = Date.now() / 1000;
        const n = Math.min(mems.length, rows.length);
        for (let i = 0; i < n; i++) {
            const mem = mems[i]!;
            const row = rows[i]!;
            if (!_row_is_perishable(row)) {
                continue;
            }
            const observed =
                (pyTruth(row["updated_at"]) ? pyFloat(row["updated_at"]) : pyFloat(0)) ||
                (pyTruth(row["created_at"]) ? pyFloat(row["created_at"]) : pyFloat(0));
            const note = staleness_note(observed, now);
            if (note && !mem.content.includes(note)) {
                mem.content = `${mem.content} ${note}`;
            }
        }
    }

    _extract_keywords(text: string): string[] {
        /** Extract meaningful keywords from text for search.
         *  DIVERGENCE(port): Python's ``\w`` is Unicode-aware; JS ``\w`` is
         *  ASCII-only, so the class is spelled out with \p{L}\p{N}_ — the
         *  CJK keyword path stays identical. */
        const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
        return words.filter((w) => w.length > 2 && !MemoryLayer._STOP_WORDS.has(w));
    }

    // ------------------------------------------------------------------
    // Recall re-ranking: time decay + MMR diversity
    // ------------------------------------------------------------------

    _decay_weight(row: JsonDict): number {
        /** Exponential recency weight in (0, 1]. 1.0 when decay is disabled.
         *  Uses updated_at in preference to created_at; incorporates access
         *  recency and citation reinforcement. */
        if (!this.decay_enabled) {
            return 1.0;
        }
        const ts = pyTruth(row["updated_at"])
            ? row["updated_at"]
            : pyTruth(row["created_at"]) ? row["created_at"] : 0;
        if (!pyTruth(ts)) {
            return 1.0;
        }
        const now = Date.now() / 1000;
        const created_age = Math.max(0.0, (now - pyFloat(ts)) / 86400.0);
        const accessed_ts = pyTruth(row["accessed_at"])
            ? row["accessed_at"]
            : pyTruth(row["last_accessed_at"]) ? row["last_accessed_at"] : null;
        let effective_age: number;
        if (pyTruth(accessed_ts) && pyFloat(accessed_ts) > 0) {
            const access_age = Math.max(0.0, (now - pyFloat(accessed_ts)) / 86400.0);
            effective_age = 0.2 * created_age + 0.8 * access_age;
        } else {
            effective_age = created_age;
        }

        const base_decay = Math.pow(0.5, effective_age / RECALL_HALFLIFE_DAYS);
        const hits = pyFloat(pyTruth(row["hits"]) ? row["hits"] : 0);
        const citation_bonus = Math.min(1.5, 1.0 + 0.1 * Math.log1p(Math.max(0.0, hits)));
        return Math.min(1.0, base_decay * citation_bonus);
    }

    static _confidence_of(row: JsonDict): number {
        /** 一行的置信度，缺失/异常时按 0.5 处理。0.5 是故意的："不知道"的中
         *  点，而且作为**均匀**乘数对排序没有任何影响。 */
        let v: number;
        try {
            v = pyFloat(row["confidence"]);
        } catch {
            return 0.5;
        }
        if (v <= 0.0 || v > 1.0) {
            return 0.5;
        }
        return v;
    }

    _row_vector(row: JsonDict): number[] | null {
        /** Decode a row's stored embedding, or None. */
        let vec: unknown;
        try {
            vec = this.storage._decode_embedding(row["embedding"]);
        } catch {
            return null;
        }
        if (Array.isArray(vec) && vec.length) {
            return vec as number[];
        }
        return null;
    }

    static _cos(a: number[] | null, b: number[] | null): number {
        if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) {
            return 0.0;
        }
        let dot = 0.0;
        let sa = 0.0;
        let sb = 0.0;
        for (let i = 0; i < a.length; i++) {
            const x = pyFloat(a[i]);
            const y = pyFloat(b[i]);
            dot += x * y;
            sa += x * x;
            sb += y * y;
        }
        const na = Math.sqrt(sa);
        const nb = Math.sqrt(sb);
        if (na === 0 || nb === 0) {
            return 0.0;
        }
        return dot / (na * nb);
    }

    /** 召回侧的类型加权。默认 1.0 = 不干预，只有 gotcha 抬起来。 */
    static _TYPE_RECALL_WEIGHT: Readonly<Record<string, number>> = {
        [MemoryType.GOTCHA]: 1.35,
    };

    _type_weight(row: JsonDict): number {
        /** 坑类记忆在召回时加权：漏召回一条坑的代价（再踩一次）和误召回一条
         *  坑的代价（多读一句话）严重不对称，所以给乘数而不是加常数——乘数只
         *  在它本来就相关时生效。 */
        const t = pyTruth(row["type"]) ? (row["type"] as string) : "";
        return pyFloat(Object.prototype.hasOwnProperty.call(MemoryLayer._TYPE_RECALL_WEIGHT, t)
            ? MemoryLayer._TYPE_RECALL_WEIGHT[t] : 1.0);
    }

    _rerank(rows: JsonDict[], query_vec: number[] | null, limit: number): JsonDict[] {
        /** Re-rank candidates by decayed relevance, then greedily pick for
         *  MMR. Two stages, each independently switchable:
         *  1. Decay. base = relevance x (0.5 + importance) x confidence x
         *     recency_weight x type_weight. Storage already returned rows
         *     best-first; without a query vector we reconstruct a relevance
         *     proxy from the rank position.
         *  2. MMR. Greedily take the candidate maximizing
         *     λ·relevance − (1−λ)·max_similarity_to_already_picked. MMR needs
         *     vectors; without embeddings it silently degrades to plain
         *     decayed ranking rather than pretending to diversify.
         *     importance/confidence 分工的理由见源 docstring（0013 bug 的反
         *     面：那时"很重要但很可能已经不对"的记忆会排到最前面）。 */
        if (!rows.length) {
            return [];
        }
        const n = rows.length;
        interface Scored {
            row: JsonDict; vec: number[] | null; relevance: number; score: number;
        }
        const scored: Scored[] = [];
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!;
            const vec = this._row_vector(row);
            let relevance: number;
            if (query_vec && vec) {
                relevance = Math.max(0.0, MemoryLayer._cos(query_vec, vec));
            } else {
                // Rank-position proxy: first row = 1.0, last = ~0.
                relevance = 1.0 - i / Math.max(1, n);
            }
            const importance = pyFloat(pyTruth(row["importance"]) ? row["importance"] : 0.5);
            const confidence = MemoryLayer._confidence_of(row);
            const base = relevance * (0.5 + importance) * confidence *
                this._decay_weight(row) * this._type_weight(row);
            scored.push({ row, vec, relevance, score: base });
        }

        scored.sort((a, b) => b.score - a.score);

        if (!this.mmr_enabled || limit >= scored.length) {
            return scored.slice(0, limit).map((d) => d.row);
        }

        const selected: Scored[] = [];
        const pool = [...scored];
        while (pool.length && selected.length < limit) {
            let best: Scored | null = null;
            let best_val: number | null = null;
            for (const cand of pool) {
                let redundancy = 0.0;
                if (selected.length && cand.vec) {
                    let mx = 0.0;
                    let any = false;
                    for (const s of selected) {
                        if (s.vec) {
                            any = true;
                            mx = Math.max(mx, MemoryLayer._cos(cand.vec, s.vec));
                        }
                    }
                    redundancy = any ? mx : 0.0;
                }
                const val = RECALL_MMR_LAMBDA * cand.score - (1 - RECALL_MMR_LAMBDA) * redundancy;
                if (best_val === null || val > best_val) {
                    best_val = val;
                    best = cand;
                }
            }
            selected.push(best as Scored);
            pool.splice(pool.indexOf(best as Scored), 1);
        }
        return selected.map((d) => d.row);
    }

    // ------------------------------------------------------------------
    // 4. Session synthesis
    // ------------------------------------------------------------------

    synthesize(topic: string): string {
        /** Synthesize memories around a topic (legacy API). */
        const relevant = this.recall(topic, 10);
        if (!relevant.length) {
            return `No memories about: ${topic}`;
        }
        const parts = [`About ${topic}:`];
        for (const m of relevant) {
            parts.push(`- ${m.type}: ${m.content}`);
        }
        return parts.join("\n");
    }

    /** 会话综述的四个槽位。这是"下一次会话的上下文前缀"的形状，改它等于改
     *  已经存进 session_synthesis 表的历史行的读法，所以它是契约而不是细节。 */
    static _SYNTHESIS_KEYS: readonly string[] = ["Goal", "Progress", "Decisions", "Open Issues"];

    _build_synthesis_prompt(messages: JsonDict[]): JsonDict {
        /** 会话综述要问模型的那句话。和 Dream 那边同一个病根：原来直接
         *  ``self._llm(messages)``，模型没有指令，回不出四槽位 dict，于是每次
         *  都静默退回启发式。取头 4 条 + 尾 20 条：目标在开头，进展和未决在
         *  结尾，中间那段最不值钱。 */
        const head = messages.slice(0, 4);
        const tail = messages.slice(4).slice(-20);
        const items: JsonDict[] = [];
        for (const m of [...head, ...tail]) {
            items.push({
                role: pyStr(pyTruth(m["role"]) ? m["role"] : ""),
                content: pySlice(pyStr(pyTruth(m["content"]) ? m["content"] : ""), 0, 1200),
            });
        }
        return {
            task: "session_synthesis",
            instruction:
                "Summarize the conversation below into a handoff note for the " +
                "next session.\n" +
                "Return ONLY a JSON object, no prose, no code fences:\n" +
                '{"Goal": ["..."], "Progress": ["..."], ' +
                '"Decisions": ["..."], "Open Issues": ["..."]}\n' +
                "Rules:\n" +
                "- Each item is one short sentence, written in the language of " +
                "the conversation.\n" +
                "- `Decisions` are choices already made and their reason; " +
                "`Open Issues` are what is still unresolved.\n" +
                "- Empty arrays are fine — don't invent progress that didn't " +
                "happen.\n" +
                "- Never copy anything that looks like a secret, token or API " +
                "key.",
            messages: items,
        };
    }

    _parse_synthesis(result: unknown): JsonDict | null {
        /** 把模型回复归一成四槽位，读不出就 None（调用方退回启发式）。归一而
         *  不是照抄：一个形状不对的前缀比没有前缀更糟——它看起来像是系统整理
         *  过的。 */
        let data = result;
        if (typeof data === "string") {
            const s = data.trim();
            const start = s.indexOf("{");
            const end = s.lastIndexOf("}");
            if (!(start >= 0 && start < end)) {
                return null;
            }
            try {
                data = JSON.parse(s.slice(start, end + 1));
            } catch {
                return null;
            }
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            return null;
        }
        const d = data as JsonDict;
        const out: JsonDict = {};
        let hit = false;
        for (const key of MemoryLayer._SYNTHESIS_KEYS) {
            let raw = d[key];
            if (typeof raw === "string") {
                raw = raw.trim() ? [raw] : [];
            }
            if (!Array.isArray(raw)) {
                raw = [];
            }
            const items = (raw as unknown[])
                .map((x) => pyStr(x).trim())
                .filter((x) => x !== "");
            if (items.length) {
                hit = true;
            }
            out[key] = items;
        }
        return hit ? out : null;
    }

    async synthesize_session(session_id: string, messages: JsonDict[]): Promise<Result> {
        /** Synthesize a complete session into structured JSON. Produces:
         *  {Goal, Progress, Decisions, Open Issues}. Stored in
         *  session_synthesis, used as next session's context prefix. */
        if (!this.memory_enabled) {
            // The router treats a non-ok Result as "nothing to inject", which
            // is exactly the semantics of the switch being off.
            return Result.failure("memory disabled");
        }
        try {
            if (this._llm) {
                let raw: unknown = null;
                try {
                    const prompt = this._build_synthesis_prompt(messages);
                    raw = await (this._llm as (p: unknown) => unknown)(prompt);
                } catch {
                    raw = null;
                }
                const synthesis = this._parse_synthesis(raw);
                if (synthesis) {
                    this.storage.save_session_synthesis(session_id, synthesis);
                    return Result.success(synthesis);
                }
            }

            // Fallback: simple heuristic synthesis
            const synthesis = this._heuristic_synthesis(messages);
            this.storage.save_session_synthesis(session_id, synthesis);
            return Result.success(synthesis);
        } catch (e) {
            return Result.failure(`Session synthesis failed: ${errStr(e)}`);
        }
    }

    _heuristic_synthesis(messages: JsonDict[]): JsonDict {
        /** Generate a simple heuristic synthesis when LLM is unavailable. */
        const user_msgs = messages.filter((m) => m["role"] === "user");
        const assistant_msgs = messages.filter((m) => m["role"] === "assistant");
        const goals = user_msgs.slice(0, 3).map((m) => pySlice(pyStr(gget(m, "content", "")), 0, 200));
        const progress = assistant_msgs.slice(0, 5).map((m) => pySlice(pyStr(gget(m, "content", "")), 0, 200));
        return {
            Goal: goals,
            Progress: progress,
            Decisions: [],
            "Open Issues": [],
        };
    }

    get_session_synthesis(session_id: string): JsonDict | null {
        /** Retrieve a previously stored session synthesis. */
        if (!this.memory_enabled) {
            return null;
        }
        return this.storage.get_session_synthesis(session_id);
    }

    // ------------------------------------------------------------------
    // 5. Storage operations
    // ------------------------------------------------------------------

    store(memory: Memory): Result {
        /** Store a memory entry. WORKING-tier memories are held in process
         *  only — persisting a current-turn scratch note means it comes back
         *  stale next session, which is worse than not having it at all. */
        try {
            const tier = normalize_tier(memory.tier);
            if (!policy_for(tier).persisted) {
                this._working.push(memory);
                // Bound the scratch list so a long turn can't grow it forever.
                if (this._working.length > 64) {
                    this._working = this._working.slice(-64);
                }
                return Result.success(memory.id);
            }

            // §9.3 写入闸门。秘密整条拒收、prompt injection 整条拒收、一次性
            // 噪声和无归属的臆测拒收、隐形 Unicode 剥除后放行。长期记忆每轮都
            // 会注入模型，这里放过的东西没有第二道防线。trusted 由 created_by
            // 推导，而不是另开一个参数。
            const _v = screen_memory_content(memory.content, { trusted: memory.created_by === "user" });
            if (!_v.allowed) {
                pyPrint(
                    `[memory] store rejected (${_v.reasons.join("; ")}): ` +
                    pyRepr(pySlice(pyStr(memory.content), 0, 80)),
                );
                return Result.failure("memory rejected by safety guard: " + _v.reasons.join("; "));
            }
            memory.content = _v.content;
            memory.sensitivity = _v.sensitivity;
            if (_v.negative_assertion) {
                // 保质期只在这里设一次，且调用方显式设过就尊重它——有些观察
                // 的有效期比默认短（"这个端口现在没人占"以分钟计）。
                if (!memory.valid_until) {
                    memory.valid_until = Date.now() / 1000 + NEGATIVE_TTL_DAYS * 86400;
                }
                memory.add_tag(NEGATIVE_TAG);
            }

            const root = memory.root_dir || this._root_dir;

            // 物理隐私脱敏与相对时间绝对化 (Phase 61 核心内化)
            try {
                memory.content = PrivacySanitizer.clean(memory.content, root);
            } catch {
                /* swallow, like the source's except Exception */
            }

            // §9.3 去重：同一条事实被再观察到一次，不是第二条记忆，而是这条
            // **又被确认了一次**。插一条新行会让召回里出现两条一模一样的内容，
            // 占两份预算，而且新鲜度各算一套。
            for (const dup of this.storage.find_memories_by_content(root, memory.content, 2) ?? []) {
                if (dup === memory.id) {
                    continue; // 就是自己，这是一次更新而不是重复
                }
                this.storage.confirm_memory(dup);
                this._invalidate_active();
                return Result.success(dup);
            }

            // §9.3 写入前冲突检测。命中的话新行落成 candidate 而不是 active：
            // 两条互相矛盾的记忆里必有一条是错的，但库这一层不知道是哪条。
            let peers: string[] = [];
            let status: string | null = memory.status ? memory.status : null;
            try {
                peers = this.storage.find_conflicting_memories(root, memory.content) ?? [];
            } catch (e) {
                // 冲突检测坏了不该让写入失败
                pyPrint(`[memory] conflict detect failed: ${errStr(e)}`);
            }
            if (peers.length) {
                status = "candidate";
            }

            const emb = this._embed_text(memory.content);
            const emb_blob = pyTruth(emb) ? jsonDumpsBuf(emb as number[]) : null;
            const save_opts: MemoryEntryOpts = {
                emb: emb_blob,
                meta: { tags: memory.tags, accessed_at: memory.accessed_at },
                mem_type: memory.type,
                importance: memory.importance,
                tags: memory.tags,
                archived: Number(Boolean(memory.archived)),
                tier: tier,
                hits: memory.hits,
                accessed_at: Math.trunc(pyTruth(memory.accessed_at) ? memory.accessed_at : 0),
                created_by: memory.created_by,
                sensitivity: memory.sensitivity,
                status: status,
                supersedes: memory.supersedes.length ? memory.supersedes : null,
                valid_until: Math.trunc(pyTruth(memory.valid_until) ? memory.valid_until : 0),
            };
            this.storage.save_memory_entry(
                memory.id, memory.session_id, root, memory.scope, memory.content, save_opts,
            );

            // 关系是对称写的，所以从任何一边都看得到分歧。放在写入之后是因为
            // 新行必须先存在——link 会校验两端都在库里。
            for (const peer of peers) {
                try {
                    this.storage.link_memory_conflict(memory.id, peer);
                } catch (e) {
                    pyPrint(`[memory] link conflict ${memory.id}<->${peer} failed: ${errStr(e)}`);
                }
            }
            if (peers.length) {
                pyPrint(
                    `[memory] stored as candidate, conflicts with ${peers.length} live memory(ies): ` +
                    pyRepr(pySlice(pyStr(memory.content), 0, 60)),
                );
            }

            // C4：结构化镜像。放在这里而不是写入之前，是因为 evidence 指向的
            // 那条记忆必须先真的存在。
            this._mirror_to_wiki(memory, root, status);

            // C3: newly stored memory must be visible on the very next recall,
            // not up to the cache TTL later.
            this._invalidate_active();
            return Result.success(memory.id);
        } catch (e) {
            return Result.failure(`Failed to store memory: ${errStr(e)}`);
        }
    }

    _mirror_to_wiki(memory: Memory, root: string, status: string | null): void {
        /** 认得出三元组的那些事实，顺手在 wiki 里也记一条。三道限制：只有
         *  triple_from_text 整串认得的句子才镜像；只镜像会被召回的行；claim
         *  id 由 memory id 派生，同一条记忆改十次也只有一条 claim。失败只打
         *  日志：wiki 是附加视图，它坏了不该让一次正常的记忆写入失败。 */
        if (!(status === null || status === undefined || status === "" || status === "active")) {
            return;
        }
        try {
            const triple = tripleFromText(memory.content);
            if (!triple) {
                return;
            }
            const claim_id = `m-${memory.id}`;
            const wiki = this.wiki;
            if (wiki.get(claim_id) !== null) {
                return; // 这条记忆已经镜像过了，一次更新不该变成第二条断言
            }
            const [subject, predicate, obj] = triple;
            const [ _new, conflicts ] = wiki.add({
                rootDir: root,
                subject: subject,
                predicate: predicate,
                object: obj,
                statement: memory.content,
                confidence: pyFloat(pyTruth(memory.importance) ? memory.importance : 0.5),
                evidence: [memory.id],
                source: `memory:${memory.created_by || ""}`,
                claimId: claim_id,
            });
            if (conflicts.length) {
                pyPrint(
                    `[wiki] ${subject}/${predicate} 与 ${conflicts.length} 条既有断言` +
                    `冲突，两边都标成 disputed：${pyRepr(obj)}`,
                );
            }
        } catch (e) {
            pyPrint(`[wiki] 镜像失败（记忆本身已经写好了）：${errStr(e)}`);
        }
    }

    // ------------------------------------------------------------------
    // C1 tier operations
    // ------------------------------------------------------------------

    working_set(): Memory[] {
        /** Current-turn scratch memories (WORKING tier, never persisted). */
        return [...this._working];
    }

    clear_working(): void {
        /** Drop the working set. Called at turn boundaries. A working note
         *  that outlives its turn is a lie. */
        this._working = [];
    }

    inject_block(): string {
        /** Render the always-inject tiers as one budgeted <memory> block.
         *  Only LONG_TERM and WORKING are injected verbatim; everything else
         *  is retrieved on demand by :meth:`prefetch`. Per-tier budgets are
         *  enforced first, then the combined total. */
        const rendered: string[] = [];
        let used = 0;
        for (const tier of ALWAYS_INJECT_TIERS) {
            const pol = policy_for(tier);
            let rows: JsonDict[];
            if (pol.persisted) {
                const fetched = this.storage.get_memory_entries(this._root_dir, null, undefined, 200) ?? [];
                rows = fetched.filter((r) => normalize_tier(r["tier"]) === tier);
            } else {
                rows = this._working.map((m) => m.to_dict());
            }
            if (!rows.length) {
                continue;
            }

            const [kept, dropped] = trim_to_budget(rows, tier);
            for (const r of kept) {
                const cost = estimate_tokens(pyStr(gget(r, "content", "")));
                if (used + cost > TOTAL_INJECT_BUDGET) {
                    break;
                }
                rendered.push(
                    `<memory tier="${tier}" type="${pyStr(gget(r, "type", "fact"))}">` +
                    `${pyStr(gget(r, "content", ""))}</memory>`,
                );
                used += cost;
            }
            if (dropped) {
                // Say so rather than silently truncating: a user who edited
                // MEMORY.md past the cap needs to know part of it isn't loaded.
                rendered.push(
                    `<memory tier="${tier}" type="notice">` +
                    `（${tier} 超出 ${pol.token_budget} token 预算，` +
                    `已按重要度略去 ${dropped} 条）</memory>`,
                );
            }
        }
        return rendered.join("\n");
    }

    note_recall(rows: JsonDict[]): void {
        /** Record hits for retrieved rows and promote whatever earned it.
         *  This is the engine of the hierarchy: without a hit count nothing
         *  ever moves between tiers and the six tiers are just six labels. */
        for (const r of rows) {
            const eid = r["id"];
            if (!eid) {
                continue;
            }
            try {
                this.storage.touch_memory_hit(eid as string);
            } catch {
                continue;
            }
            const tier = normalize_tier(r["tier"]);
            const hits = (pyTruth(gget(r, "hits", 0)) ? pyInt(r["hits"]) : 0) + 1;
            const target = should_promote(tier, hits);
            if (target !== null && target !== undefined && target !== tier) {
                try {
                    this.storage.set_memory_tier(eid as string, target);
                } catch {
                    // fail-open: 可选增强，失败不影响主流程
                }
            }
        }
    }

    sweep_expired(): Record<string, number> {
        /** Archive entries past their tier TTL. Returns per-tier counts. Only
         *  tiers with a finite TTL are swept. */
        const swept: Record<string, number> = {};
        const now = Date.now() / 1000;
        for (const tier of [MemoryTier.SHORT_TERM_RECALL, MemoryTier.DREAMING]) {
            const pol = policy_for(tier);
            if (pol.ttl_seconds <= 0) {
                continue;
            }
            const cutoff = now - pol.ttl_seconds;
            // limit=None for the same reason as tier_stats: a 1000-row cap
            // made before/after both saturate so the delta read 0.
            const before = (this.storage.get_memory_entries(this._root_dir, null, undefined, null) ?? [])
                .filter((r) => normalize_tier(r["tier"]) === tier).length;
            try {
                this.storage.expire_memories_by_tier(this._root_dir, tier, Math.trunc(cutoff));
            } catch {
                continue;
            }
            const after = (this.storage.get_memory_entries(this._root_dir, null, undefined, null) ?? [])
                .filter((r) => normalize_tier(r["tier"]) === tier).length;
            swept[tier] = Math.max(0, before - after);
        }
        return swept;
    }

    tier_stats(): JsonDict[] {
        /** Per-tier counts / token usage / over-budget flags for the UI.
         *  Reads with ``limit=None`` on purpose — a stat panel must either be
         *  complete or say it isn't; silently truncating is the one option
         *  that isn't allowed. */
        const rows = [...(this.storage.get_memory_entries(this._root_dir, null, undefined, null) ?? [])];
        const all = rows.concat(this._working.map((m) => m.to_dict()));
        return summarize_tiers(all);
    }

    forget(memory_id: string): Result {
        /** Forget (archive) a memory by ID. */
        try {
            this.storage.archive_memory(memory_id);
            // The archived row must stop showing up in recall immediately;
            // otherwise a user "deletes" a memory and the model still cites it
            // for up to one cache TTL.
            this._invalidate_active();
            // Step D：记忆被删/归档同样让依赖它的技能进入待重验。辅助账目，绝
            // 不反过来让删除失败。
            try {
                this.storage.mark_skills_stale_for_memory(memory_id);
            } catch {
                // fail-open: 可选增强，失败不影响主流程
            }
            return Result.success(`Archived memory: ${memory_id}`);
        } catch (e) {
            return Result.failure(`Failed to forget memory: ${errStr(e)}`);
        }
    }

    // ------------------------------------------------------------------
    // Entry-level read/write (settings UI control surface)
    //
    // tier_stats() answers "how much is in there"; these answer "what exactly
    // is in there, and let me fix it". The storage layer already had every
    // atomic operation; these methods only compose them and own the tier-
    // specific rules that storage has no business knowing.
    // ------------------------------------------------------------------

    list_entries(opts: {
        tier?: string | null;
        query?: string;
        limit?: number;
        offset?: number;
        root?: string | null;
        mem_type?: string | null;
        status?: string | null;
    } = {}): JsonDict[] {
        /** Entries with their actual content, for the settings UI. ``root``
         *  scopes the query to one workspace because this layer is a process
         *  singleton while the app has many workspaces open at once. WORKING
         *  is served from the in-process scratch list rather than SQLite. */
        const tier = opts.tier ?? null;
        const query = opts.query ?? "";
        const limit = opts.limit ?? 100;
        const offset = opts.offset ?? 0;
        const root = opts.root ?? null;
        const mem_type = opts.mem_type ?? null;
        const status = opts.status ?? null;

        const want = tier ? normalize_tier(tier) : "";
        const want_type = (mem_type ?? "").trim().toLowerCase();
        const scope = root || this._root_dir;

        let rows: JsonDict[];
        if (want === MemoryTier.WORKING) {
            rows = this._working.map((m) => m.to_dict());
        } else {
            // Over-fetch: get_memory_entries has no tier predicate, so the
            // tier filter happens in Python. Asking for exactly `limit` rows
            // would under-fill any tier that isn't the most recent one.
            const raw = this.storage.get_memory_entries(scope, want_type || null, true, 2000) ?? [];
            rows = MemoryLayer._filter_by_status([...raw], status);
            if (want) {
                rows = rows.filter((r) => normalize_tier(r["tier"]) === want);
            }
        }

        const needle = (query ?? "").trim().toLowerCase();
        if (needle) {
            rows = rows.filter((r) => pyStr(r["content"] ?? "").toLowerCase().includes(needle));
        }

        rows.sort((a, b) => {
            const ka = pyTruth(a["updated_at"])
                ? pyFloat(a["updated_at"])
                : pyTruth(a["created_at"]) ? pyFloat(a["created_at"]) : pyFloat(0);
            const kb = pyTruth(b["updated_at"])
                ? pyFloat(b["updated_at"])
                : pyTruth(b["created_at"]) ? pyFloat(b["created_at"]) : pyFloat(0);
            return kb - ka;
        });
        const window = rows.slice(offset, offset + Math.max(1, pyInt(limit)));
        return window.map((r) => this._public_entry(r));
    }

    count_entries(opts: {
        tier?: string | null;
        query?: string;
        root?: string | null;
        mem_type?: string | null;
        status?: string | null;
    } = {}): number {
        /** How many entries match — so the UI can paginate honestly. */
        const tier = opts.tier ?? null;
        const query = opts.query ?? "";
        const root = opts.root ?? null;
        const mem_type = opts.mem_type ?? null;
        const status = opts.status ?? null;

        const want = tier ? normalize_tier(tier) : "";
        const want_type = (mem_type ?? "").trim().toLowerCase();
        let rows: JsonDict[];
        if (want === MemoryTier.WORKING) {
            rows = this._working.map((m) => m.to_dict());
        } else {
            const raw = this.storage.get_memory_entries(root || this._root_dir, want_type || null, true, 2000) ?? [];
            rows = MemoryLayer._filter_by_status([...raw], status).filter(
                (r) => !want || normalize_tier(r["tier"]) === want,
            );
        }
        const needle = (query ?? "").trim().toLowerCase();
        if (needle) {
            rows = rows.filter((r) => pyStr(r["content"] ?? "").toLowerCase().includes(needle));
        }
        return rows.length;
    }

    static _filter_by_status(rows: JsonDict[], status: string | null): JsonDict[] {
        /** 按生命周期状态筛行。``"all"`` 放行全部，``None`` 用 UI 默认集合。
         *  兼容 0013 之前的行：``status`` 列为空时按 ``archived`` 列推断，否
         *  则老库升级后那些行会因为"状态不在集合里"整批消失。 */
        const want = (status ?? "").trim().toLowerCase();
        if (want === "all") {
            return rows;
        }

        const _st = (r: JsonDict): string => {
            const s = pyStr(r["status"] ?? "");
            if (s) {
                return s;
            }
            return pyTruth(r["archived"]) && pyInt(r["archived"]) !== 0 ? "archived" : "active";
        };

        const allow = new Set<string>(want ? [want] : UI_DEFAULT_STATUSES);
        return rows.filter((r) => allow.has(_st(r)));
    }

    last_dream_at(root?: string | null): number {
        /** When this workspace last completed a dream pass (epoch seconds). */
        const scope = root !== undefined && root !== null ? root : this._root_dir;
        try {
            const row = this.storage._db("memory").execute(
                "SELECT last_dream_at FROM project_memory_index WHERE root_dir=?",
                [scope],
            ).fetchone() as Row | null;
            if (row && pyTruth(row["last_dream_at"])) {
                return pyFloat(row["last_dream_at"]);
            }
        } catch {
            // fail-open: 可选增强，失败不影响主流程
        }
        return 0.0;
    }

    list_roots(): JsonDict[] {
        /** Workspaces that actually hold memories: ``[{root, count}]``.
         *  Deliberately reports what the memory table knows rather than what
         *  the workspace registry knows. */
        try {
            return this.storage.list_memory_roots() ?? [];
        } catch {
            return [];
        }
    }

    _public_entry(row: JsonDict): JsonDict {
        /** Shape one row for the API: camelCase, tags decoded, tier policy
         *  applied. 生命周期字段从 ``memory_domain`` 取，而不是在这里各读一遍
         *  列：那些字段的口径只应该有一个定义。 */
        const tier = normalize_tier(row["tier"]);
        const pol = policy_for(tier);
        let tags = row["tags"];
        if (typeof tags === "string") {
            try {
                tags = JSON.parse(tags);
            } catch {
                tags = [];
            }
        }
        const content = pyStr(row["content"] ?? "");
        const out: JsonDict = {
            id: row["id"] ?? "",
            content: content,
            type: pyTruth(row["type"]) ? row["type"] : MemoryType.FACT,
            tier: tier,
            importance: pyFloat(pyTruth(row["importance"]) ? row["importance"] : 0.0),
            tags: pyTruth(tags) ? tags : [],
            hits: pyInt(pyTruth(row["hits"]) ? row["hits"] : 0),
            createdAt: pyFloat(pyTruth(row["created_at"]) ? row["created_at"] : 0),
            updatedAt: pyFloat(pyTruth(row["updated_at"]) ? row["updated_at"] : 0),
            tokens: estimate_tokens(content),
            // WORKING is wiped every turn, so offering an edit box would be
            // a lie.
            editable: Boolean(pol.persisted),
        };
        let lc: JsonDict;
        try {
            // DIVERGENCE(port): memory_domain（SPLIT 批次）未移植——源侧这条
            // import 整个包在 try 里（ImportError → 提前 return out），且它在
            // 同步函数里，TS 无法同步 import 一个不存在的模块。同形处理：直接
            // 抛，走同一个 catch → return out。SPLIT 落地后改成直连
            // item_from_entry(row).to_api()。
            throw new Error("Cannot find module 'memory_domain'");
        } catch {
            return out;
        }
        lc = {} as JsonDict;
        void lc;
        for (const key of ["kind", "status", "live", "confidence", "source",
            "supersededBy", "statusReason", "validUntil",
            "lastConfirmedAt", "sensitivity", "sourceGoalId",
            "sourceEventIds", "validFrom"]) {
            out[key] = lc[key];
        }

        // WORKING 行来自内存里的 scratch list，没有 status 列，item_from_entry
        // 会兜底成 active。它每轮都被清空，说它"生效中"是对的，但不可编辑这一点
        // 由上面的 tier policy 决定，这里不覆盖。
        return out;
    }

    update_entry(
        memory_id: string,
        content?: string | null,
        tier?: string | null,
        importance?: number | null,
        tags?: string[] | null,
        root?: string | null,
    ): Result {
        /** Edit one stored memory in place. Only non-None fields change.
         *  Re-embeds when the text changed — leaving a stale vector behind
         *  would make the edited memory retrievable by its OLD wording and
         *  invisible under its new wording. */
        try {
            const rows = this.storage.get_memory_entries(root, null, true, 5000) ?? [];
            const row = rows.find((r) => r["id"] === memory_id) ?? null;
            if (row === null) {
                return Result.failure(`No such memory: ${memory_id}`);
            }

            const old_content = pyStr(row["content"] ?? "");
            const new_content = content === undefined || content === null
                ? old_content : pyStr(content).trim();
            if (!new_content) {
                return Result.failure("Memory content cannot be empty");
            }

            let existing_tags = row["tags"];
            if (typeof existing_tags === "string") {
                try {
                    existing_tags = JSON.parse(existing_tags);
                } catch {
                    existing_tags = [];
                }
            }
            const new_tags = tags === undefined || tags === null
                ? (pyTruth(existing_tags) ? (existing_tags as unknown[]) : [])
                : [...(tags as unknown[])];

            const new_tier = tier ? normalize_tier(tier) : normalize_tier(row["tier"]);
            if (!policy_for(new_tier).persisted) {
                return Result.failure(
                    `Tier '${new_tier}' is not persisted and cannot hold an edited entry`,
                );
            }

            const new_importance = importance === undefined || importance === null
                ? pyFloat(pyTruth(row["importance"]) ? row["importance"] : 0.5)
                : pyFloat(importance);

            // Only pay for an embedding when the text actually moved.
            let emb_blob: Buffer | unknown;
            if (new_content !== old_content) {
                const emb = this._embed_text(new_content);
                emb_blob = pyTruth(emb) ? jsonDumpsBuf(emb as number[]) : null;
            } else {
                emb_blob = row["embedding"];
            }

            const save_opts: MemoryEntryOpts = {
                emb: emb_blob as Buffer | null,
                meta: { tags: new_tags, edited_by: "user" },
                mem_type: pyTruth(row["type"]) ? (row["type"] as string) : MemoryType.FACT,
                importance: new_importance,
                tags: new_tags as string[],
                archived: 0,
                tier: new_tier,
                hits: pyInt(pyTruth(row["hits"]) ? row["hits"] : 0),
                accessed_at: Math.trunc(pyTruth(row["accessed_at"]) ? pyFloat(row["accessed_at"]) : 0),
            };
            this.storage.save_memory_entry(
                memory_id,
                (pyTruth(row["session_id"]) ? row["session_id"] : "") as string,
                (pyTruth(row["root_dir"]) ? row["root_dir"] : this._root_dir) as string,
                (pyTruth(row["scope"]) ? row["scope"] : MemoryScope.PROJECT) as string,
                new_content,
                save_opts,
            );
            // save_memory_entry keeps the old tier when handed the 'semantic'
            // default, so an explicit demotion TO semantic needs the direct call.
            if (tier) {
                this.storage.set_memory_tier(memory_id, new_tier);
            }
            this._invalidate_active();
            // Step D：内容被编辑过的记忆同样触发依赖技能的待重验标记。
            try {
                this.storage.mark_skills_stale_for_memory(memory_id);
            } catch {
                // fail-open: 可选增强，失败不影响主流程
            }
            return Result.success(memory_id);
        } catch (e) {
            return Result.failure(`Failed to update memory: ${errStr(e)}`);
        }
    }

    forget_tag(tag: string): Result {
        /** Forget all memories with a given tag. */
        try {
            const all_mems = this.storage.get_memory_entries(this._root_dir, null, false, null) ?? [];
            let count = 0;
            for (const m of all_mems) {
                const tags_raw = gget(m, "tags", "[]");
                let tags: unknown;
                if (typeof tags_raw === "string") {
                    try {
                        tags = JSON.parse(tags_raw);
                    } catch {
                        tags = [];
                    }
                } else {
                    tags = tags_raw;
                }
                if (Array.isArray(tags) && tags.includes(tag)) {
                    this.storage.archive_memory(m["id"] as string);
                    count += 1;
                }
            }
            return Result.success(`Forgot ${count} memories with tag: ${tag}`);
        } catch (e) {
            return Result.failure(`Failed to forget by tag: ${errStr(e)}`);
        }
    }

    get_stats(): JsonDict {
        /** Get memory statistics: total count and breakdown by type. */
        const all_mems = this.storage.get_memory_entries(this._root_dir, null, true, null) ?? [];
        const by_type: Record<string, number> = {};
        for (const m of all_mems) {
            const t = pyStr(gget(m, "type", "unknown"));
            by_type[t] = (by_type[t] ?? 0) + 1;
        }
        return {
            total: all_mems.length,
            by_type: by_type,
        };
    }

    prune_stale_memories(root_dir: string = "", max_age_days: number = 180): JsonDict {
        /** 闲时梦境记忆修剪与陈旧事实证伪 (Phase 62 核心硬内化)。
         *  1. 归档已被 supersede 的旧记录 + 超期且从未被成功召回的陈旧记忆；
         *  2. 清理孤立实体节点 (degree 0，超过 30 天)；
         *  3. 返回修剪前后的存储预算统计与释放空间。 */
        const actual_root = root_dir || this._root_dir;
        const c = this.storage._db("memory");
        const now = Date.now() / 1000;
        const cutoff_ts = now - max_age_days * 86400.0;

        const all_before = c.execute(
            "SELECT id, content, status, hits, updated_at, created_at FROM memory_entries " +
            "WHERE (root_dir=? OR root_dir='') AND status!='archived'",
            [actual_root],
        ).fetchall();
        const budget_before = MemoryIndexCapper.get_budget_stats(all_before.map((m) => ({ ...m })));

        let pruned_count = 0;
        let retired_count = 0;

        // 1. 归档已被 supersede 的旧记录
        const superseded_rows = c.execute(
            "SELECT id FROM memory_entries WHERE (root_dir=? OR root_dir='') AND status='superseded'",
            [actual_root],
        ).fetchall();
        for (const r of superseded_rows) {
            c.execute("UPDATE memory_entries SET status='archived', updated_at=? WHERE id=?", [now, r["id"]]);
            retired_count += 1;
        }

        // 2. 归档超期且从未被成功召回的陈旧记忆 (hits <= 0)
        const stale_rows = c.execute(
            "SELECT id FROM memory_entries WHERE (root_dir=? OR root_dir='') AND status='active' " +
            "AND created_at < ? AND (hits IS NULL OR hits <= 0)",
            [actual_root, cutoff_ts],
        ).fetchall();
        for (const r of stale_rows) {
            c.execute("UPDATE memory_entries SET status='archived', updated_at=? WHERE id=?", [now, r["id"]]);
            pruned_count += 1;
        }

        // 3. 清理孤儿图谱节点 (没有相连边且超过 30 天未更新)
        let orphan_nodes_removed = 0;
        try {
            const orphan_nodes = c.execute(
                "SELECT id FROM graph_entities WHERE (root_dir=? OR root_dir='') " +
                "AND id NOT IN (SELECT source_id FROM graph_relations UNION SELECT target_id FROM graph_relations) " +
                "AND created_at < ?",
                [actual_root, now - 30 * 86400.0],
            ).fetchall();
            for (const o of orphan_nodes) {
                c.execute("DELETE FROM graph_entities WHERE id=?", [o["id"]]);
                orphan_nodes_removed += 1;
            }
        } catch {
            /* swallow, like the source's except Exception */
        }

        c.commit();
        this._invalidate_active();

        const all_after = c.execute(
            "SELECT id, content, status, hits, updated_at, created_at FROM memory_entries " +
            "WHERE (root_dir=? OR root_dir='') AND status!='archived'",
            [actual_root],
        ).fetchall();
        const budget_after = MemoryIndexCapper.get_budget_stats(all_after.map((m) => ({ ...m })));
        const freed_bytes = Math.max(
            0,
            (budget_before["used_bytes"] as number) - (budget_after["used_bytes"] as number),
        );

        return {
            root_dir: actual_root,
            pruned_count: pruned_count,
            retired_count: retired_count,
            orphan_nodes_removed: orphan_nodes_removed,
            freed_bytes: freed_bytes,
            budget_before: budget_before,
            budget_after: budget_after,
        };
    }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _layer: MemoryLayer | null = null;

export function get_memory_layer(
    llm_callback: LlmFn = null,
    embed_callback: EmbedFn = null,
    storage: unknown = null,
    root_dir: string = "",
): MemoryLayer {
    /** Get the global MemoryLayer singleton. */
    if (_layer === null) {
        _layer = new MemoryLayer({
            llm_callback: llm_callback,
            embed_callback: embed_callback,
            storage: storage,
            root_dir: root_dir,
        });
        return _layer;
    }
    if (storage !== null && (_layer.storage as unknown) === null) {
        _layer.storage = storage as MemoryLayerStorage;
    }
    if (root_dir && !_layer._root_dir) {
        _layer._root_dir = root_dir;
    }
    if (llm_callback !== null && _layer._llm === null) {
        _layer._llm = llm_callback;
        _layer._extractor._llm = llm_callback;
        _layer._dreamer._llm = llm_callback;
    }
    if (embed_callback !== null && _layer._embed === null) {
        _layer.set_embed_callback(embed_callback);
    }
    return _layer;
}

// ---------------------------------------------------------------------------
// Phase 59 内化: 实体图谱记忆引擎 (GraphMemoryEngine)
// ---------------------------------------------------------------------------

export class GraphMemoryEngine {
    /** Phase 59 内化模块: 实体关系图谱长期记忆引擎。

        从 ontology 技能提纯，提供强类型三元组 (Subject, Predicate, Object)
    存储、更新与多跳图拓扑关联召回。 */
    _storage: MemoryLayerStorage;

    constructor(storage: MemoryLayerStorage | null = null) {
        this._storage = (pyTruth(storage)
            ? storage
            : get_storage()) as MemoryLayerStorage;
    }

    ingest_triplet(
        root_dir: string,
        subject: string,
        predicate: string,
        object_val: string,
        subject_type: string = "Concept",
        object_type: string = "Concept",
        confidence: number = 1.0,
        properties: JsonDict | null = null,
    ): string {
        /** 抽取并沉淀一条语义三元组边。 */
        // 源侧 properties 形参收下但从未使用，照搬。
        void properties;
        let clean_subj: string;
        let clean_obj: string;
        try {
            // DIVERGENCE(port): 源侧这里是函数体内的 `from sanitizer import
            // PrivacySanitizer`（ImportError 走 except 用原值）。TS 侧
            // sanitizer 已移植且顶层静态导入，try/except 的等效语义保持：
            // clean() 抛错 → 原值直通。
            clean_subj = PrivacySanitizer.clean(subject, root_dir) as string;
            clean_obj = PrivacySanitizer.clean(object_val, root_dir) as string;
        } catch {
            clean_subj = subject;
            clean_obj = object_val;
        }

        return this._storage.upsert_graph_relation(
            root_dir,
            clean_subj,
            clean_obj,
            predicate,
            confidence,
            subject_type,
            object_type,
        );
    }

    recall_associative_graph(
        entity_name: string,
        root_dir: string = "",
        max_hops: number = 2,
    ): JsonDict[] {
        /** 关联召回与当前实体相连的所有拓扑边。 */
        let clean_ent: string;
        try {
            clean_ent = PrivacySanitizer.clean(entity_name, root_dir) as string;
        } catch {
            clean_ent = entity_name;
        }
        return this._storage.query_related_entities(clean_ent, root_dir, max_hops);
    }

    format_graph_for_prompt(related_edges: JsonDict[]): string {
        /** 将图谱关系格式化为适合 LLM 注入的紧凑上下文。 */
        if (!pyTruth(related_edges)) {
            return "";
        }
        const lines: string[] = ["<knowledge_graph>"];
        for (const edge of related_edges) {
            // confidence 列是 sqlite REAL，python 侧 f-string 拿到的是 float，
            // str(1.0)="1.0"；JS 丢了 int/float 之分，按 REAL 列一律渲染成
            // float 形状（见 pyFloatStr）。
            const conf = gget(edge, "confidence", 1.0);
            const conf_s = typeof conf === "number" ? pyFloatStr(conf) : pyStr(conf);
            lines.push(
                `- (${pyStr(gget(edge, "source"))}) --[${pyStr(gget(edge, "relation"))}]--> ` +
                `(${pyStr(gget(edge, "target"))}) [置信度: ${conf_s}]`,
            );
        }
        lines.push("</knowledge_graph>");
        return lines.join("\n");
    }
}

let _graph_engine: GraphMemoryEngine | null = null;

export function get_graph_memory_engine(
    storage: MemoryLayerStorage | null = null,
): GraphMemoryEngine {
    /** 获取 GraphMemoryEngine 全局单例。 */
    if (_graph_engine === null) {
        _graph_engine = new GraphMemoryEngine(storage);
    }
    return _graph_engine;
}

// ---------------------------------------------------------------------------
// Phase 62 内化: 记忆容量预算与索引约束器 (MemoryIndexCapper)
// ---------------------------------------------------------------------------

export class MemoryIndexCapper {
    /** 生产级记忆容量预算与索引约束器 (Phase 62 核心硬内化)。

            - 索引必须保持精炼，单行建议不超过 150 字符；
    - 注入总容量物理封顶 25KB (25,600 Bytes)，杜绝记忆污染上下文与撑爆 Prompt Cache；
    - 超额自动按相关度/置信度截断保留最核心的高价值记忆。 */

    static MAX_LINE_CHARS = 150;
    static MAX_BUDGET_BYTES = 25600;  // 25 KB

    static cap_entry_line(
        text: string,
        max_chars: number = MemoryIndexCapper.MAX_LINE_CHARS,
    ): string {
        /** 单条记忆索引行长修剪. */
        if (!text || Array.from(text).length <= max_chars) {
            return text || "";
        }
        return pyRstrip(pySlice(text, 0, max_chars - 3)) + "...";
    }

    static enforce_budget(
        blocks: string[],
        max_bytes: number = MemoryIndexCapper.MAX_BUDGET_BYTES,
    ): string[] {
        /** 对记忆 XML 块列表进行 25KB 物理预算封顶裁决. */
        const accepted: string[] = [];
        let current_bytes = 0;
        for (const b of blocks) {
            const b_bytes = utf8ByteLen(b);
            if (current_bytes + b_bytes > max_bytes) {
                // 尝试压缩或停止追加
                if (accepted.length === 0) {
                    accepted.push(truncateUtf8Ignore(b, max_bytes));
                }
                break;
            }
            accepted.push(b);
            current_bytes += b_bytes;
        }
        return accepted;
    }

    static get_budget_stats(
        memory_entries: JsonDict[],
        max_bytes: number = MemoryIndexCapper.MAX_BUDGET_BYTES,
    ): JsonDict {
        /** 计算当前记忆库容量预算统计. */
        let total_bytes = 0;
        for (const m of memory_entries) {
            total_bytes += utf8ByteLen(pyStr(gget(m, "content", "")));
        }
        return {
            used_bytes: total_bytes,
            max_bytes: max_bytes,
            usage_ratio:
                Math.round(Math.min(1.0, total_bytes / Math.max(1, max_bytes)) * 10000) / 10000,
            entries_count: memory_entries.length,
            healthy: total_bytes <= max_bytes,
        };
    }
}

// PORT STATUS: confidence=high todos=[0]
