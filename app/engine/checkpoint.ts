/**
 * checkpoint.ts — 自包含检查点（Phase 2 收口）.
 *
 * Ported from `app/backend/checkpoint.py` (273 lines).
 *
 * 总指令 §5.2：checkpoint 必须能回答——当前在哪一步、哪些工具已完成、哪些
 * 副作用不能重做、恢复后如何继续。它不是一段聊天文本。落点：以
 * SYSTEM_CHECKPOINT_CREATED 事件写入既有 EventStore（幂等键 =
 * checkpoint:{scope}:{last_seq}），与事实源同库同链，天然可回放。
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/checkpoint.py -> app/engine/checkpoint.ts;
 *       snake_case public names kept; python kwargs-only params become an
 *       options object.
 *   §2  fail-open guards verbatim: read_stream failure -> events=[];
 *       completed/unknown side-effect and goal_snapshot failures swallowed
 *       (可选增强); trace_event failure prints and returns None; the
 *       event-projection rebuild failure LOUDLY prints the fallback line
 *       before degrading to storage tail (恢复质量悄悄变差必须留痕).
 *   §2  tail-matching asymmetry replicated: stored content is [:500] cut
 *       but the retained_tail content is compared FULL length; first hit
 *       wins via next(); the "content" key via present-but-null .get.
 *   §2  int(checkpoint.get("last_event_seq") or 0) — the falsy gate means
 *       0/None/"" all become 0; a non-numeric string raises uncaught
 *       ValueError "invalid literal for int() with base 10: 'abc'".
 *   §2  digest: json.dumps(retained_tail, ensure_ascii=False, sort_keys=
 *       True) with python's DEFAULT separators (", " / ": ") — the sha256
 *       input is pinned byte-for-byte (pyJsonDumps below), then hex[:16].
 *   §2  f-string interpolation via python str(): None -> "None" (the
 *       "sid:None" last_event_id when the event lacks .seq, and the
 *       idempotency key carrying the same str(None)).
 *   §2  event attribute reads honour the host domain model: python reads
 *       getattr(ev,"event_type","")/session_id on its AgentEvent; the TS
 *       AgentEvent fields are eventType/sessionId (projection_engine.ts
 *       precedent), so reads normalize eventType ?? event_type ?? "".
 *   §2  e["call_id"] is SUBSCRIPT, not .get — missing key raises KeyError
 *       (swallowed by the surrounding fail-open), while .get elsewhere
 *       keeps present-but-null None values.
 *
 * 接线现状：build_checkpoint 每轮结束/完成/暂停取消路径调用；
 * resume_from_checkpoint 是续跑前的强制 preflight（校验不过不得 running）。
 */

import { createHash } from "node:crypto";
import { ProjectedSessionState, SessionProjector } from "./projection_engine.js";

// ---------------------------------------------------------------------------
// python-semantics helpers
// ---------------------------------------------------------------------------

class ValueErrorP extends Error {
    pyMsg: string;
    constructor(msg: string) {
        super(`ValueError: ${msg}`);
        this.name = "ValueError";
        this.pyMsg = msg;
    }
}
class TypeErrorP extends Error {
    pyMsg: string;
    constructor(msg: string) {
        super(`TypeError: ${msg}`);
        this.name = "TypeError";
        this.pyMsg = msg;
    }
}
class KeyErrorP extends Error {
    pyMsg: string;
    constructor(msg: string) {
        super(`KeyError: ${msg}`);
        this.name = "KeyError";
        this.pyMsg = msg;
    }
}
class AttributeErrorP extends Error {
    pyMsg: string;
    constructor(msg: string) {
        super(`AttributeError: ${msg}`);
        this.name = "AttributeError";
        this.pyMsg = msg;
    }
}

/** str(e) as python would render it (no type prefix). */
function excStr(e: unknown): string {
    const m = (e as { pyMsg?: string })?.pyMsg;
    if (m !== undefined) {
        return m;
    }
    return String((e as Error)?.message ?? e);
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

function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return String(v);
    if (typeof v === "string") return v;
    return String(v);
}

/** python int(x)：bool/float 截断、str 解析；失败如实抛 ValueError。 */
function pyInt(v: unknown): number {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") {
        if (Number.isNaN(v)) {
            throw new ValueErrorP("cannot convert float NaN to integer");
        }
        if (!Number.isFinite(v)) {
            throw new OverflowErrorP("cannot convert float infinity to integer");
        }
        return Math.trunc(v);
    }
    if (typeof v === "string") {
        const s = v.trim();
        const m = /^[-+]?[0-9]+$/u.exec(s);
        if (m) {
            return Number(s);
        }
        throw new ValueErrorP(
            "invalid literal for int() with base 10: '" + v.replaceAll("'", "\\'") + "'");
    }
    throw new TypeErrorP(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

class OverflowErrorP extends Error {
    pyMsg: string;
    constructor(msg: string) {
        super(`OverflowError: ${msg}`);
        this.name = "OverflowError";
        this.pyMsg = msg;
    }
}

function isPyDict(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** python dict.get(k, dflt)：present-but-null returns None, not dflt. */
function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
    if (!isPyDict(obj)) {
        throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute 'get'`);
    }
    return key in obj ? obj[key] : dflt;
}

/** python obj[k] 下标（KeyError/TypeError 与源同形）。 */
function dictSub(obj: unknown, key: string): unknown {
    if (isPyDict(obj)) {
        if (!(key in obj)) {
            throw new KeyErrorP(`'${key}'`);
        }
        return obj[key];
    }
    if (Array.isArray(obj)) {
        throw new TypeErrorP("list indices must be integers or slices, not str");
    }
    throw new TypeErrorP("string indices must be integers");
}

/** python dict(m)：copy / 更新序列。str 按字符序列展开（dict("ab") ->
 *  {'a':'b'}，dict("abc") 在元素 #1 处 ValueError）；不可迭代抛
 *  `'X' object is not iterable`，非序列元素抛 cannot-convert TypeError。 */
function pyDictCtor(m: unknown): Record<string, unknown> {
    if (isPyDict(m)) {
        return { ...m };
    }
    let items: unknown[];
    if (Array.isArray(m)) {
        items = m;
    } else if (typeof m === "string") {
        items = Array.from(m);
    } else {
        throw new TypeErrorP(`'${pyTypeName(m)}' object is not iterable`);
    }
    const out: Record<string, unknown> = {};
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let seq: unknown[] | null = null;
        if (Array.isArray(item)) seq = item;
        else if (typeof item === "string") seq = Array.from(item);
        if (seq === null) {
            throw new TypeErrorP(`cannot convert dictionary update sequence element #${i} to a sequence`);
        }
        if (seq.length !== 2) {
            throw new ValueErrorP(
                `dictionary update sequence element #${i} has length ${seq.length}; 2 is required`);
        }
        out[pyStr(seq[0])] = seq[1];
    }
    return out;
}

function iterPy(v: unknown): unknown[] {
    if (Array.isArray(v)) {
        return v;
    }
    if (typeof v === "string") {
        return Array.from(v);
    }
    if (isPyDict(v)) {
        return Object.keys(v);
    }
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not iterable`);
}

function pySliceEnd(s: string, end: number): string {
    const arr = Array.from(s);
    const stop = end < 0 ? Math.max(arr.length + end, 0) : Math.min(end, arr.length);
    return arr.slice(0, Math.min(stop, arr.length)).join("");
}

/** json.dumps(obj, ensure_ascii=False, sort_keys=True) 默认分隔符版。 */
export function pyJsonDumps(v: unknown): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return String(v);
    if (typeof v === "string") {
        // JSON.stringify escapes ", \\, control chars and U+2028/29;
        // ensure_ascii=False python keeps the two line separators raw.
        return JSON.stringify(v)
            .split("\\u2028").join(String.fromCharCode(0x2028))
            .split("\\u2029").join(String.fromCharCode(0x2029));
    }
    if (Array.isArray(v)) {
        return "[" + v.map(pyJsonDumps).join(", ") + "]";
    }
    const keys = Object.keys(v as object).sort((a, b) => {
        const xa = Array.from(a);
        const xb = Array.from(b);
        for (let i = 0; i < Math.min(xa.length, xb.length); i++) {
            const ca = xa[i]!.codePointAt(0)!;
            const cb = xb[i]!.codePointAt(0)!;
            if (ca !== cb) return ca - cb;
        }
        return xa.length - xb.length;
    });
    return "{" + keys.map((k) => pyJsonDumps(k) + ": " + pyJsonDumps((v as Record<string, unknown>)[k])).join(", ") + "}";
}

// ---------------------------------------------------------------------------
// host-model shims: python attribute names -> TS AgentEvent fields
// ---------------------------------------------------------------------------

function evAttr(ev: unknown, snake: string, camel: string, dflt: unknown): unknown {
    if (!isPyDict(ev)) {
        return dflt;
    }
    if (camel in ev) return ev[camel];
    if (snake in ev) return ev[snake];
    return dflt;
}

interface EventStoreLike {
    read_stream(session_id: string): unknown[];
    read_by_dimension(dimension: string, value: string, limit?: number): unknown[];
}

interface StorageLike {
    get_event_store(): EventStoreLike;
    get_messages(sid: string, limit?: number): unknown[];
    completed_side_effects(goal_id: string): unknown[];
    unknown_side_effects(goal_id: string): unknown[];
    get_goal(gid: string): Record<string, unknown> | null;
    trace_event(kwargs: Record<string, unknown>): unknown;
}

// ---------------------------------------------------------------------------
// §5.3 replay：从事件流投影重建对话尾部
// ---------------------------------------------------------------------------

/** §5.3 replay 语义：从事件流**投影**重建对话尾部。
 *  复用既有的确定性投影器（SessionProjector）——消息正文本就在事件里。
 *  只读、零副作用。 */
export function rebuild_tail_from_events(
    storage: StorageLike,
    sid: string,
    opts: { upto_seq?: number; n?: number } = {},
): unknown[] {
    const uptoSeq = "upto_seq" in opts ? opts.upto_seq : 0;
    const n = "n" in opts ? opts.n : 8;
    let state = new ProjectedSessionState({ session_id: sid });
    for (const e of storage.get_event_store().read_stream(sid)) {
        // python 直读属性 e.seq（循环条件与 projector 首行 state.last_seq =
        // event.seq 都是直接访问）——缺 seq 如实抛 AttributeError。
        if (!("seq" in (e as object))) {
            throw new AttributeErrorP("'AgentEvent' object has no attribute 'seq'");
        }
        if (pyTruth(uptoSeq) && (e as { seq: number }).seq > (uptoSeq as number)) {
            break;
        }
        state = SessionProjector.apply_event(state, e as Parameters<typeof SessionProjector.apply_event>[1]);
    }
    if (!pyTruth(n)) {
        return [];
    }
    const msgs = state.messages;
    const k = (n as number) < 0 ? -(n as number) : (n as number);
    return (n as number) < 0 ? msgs.slice(k) : msgs.slice(Math.max(msgs.length - k, 0));
}

// ---------------------------------------------------------------------------
// preflight 读半程：加载最近一份 checkpoint
// ---------------------------------------------------------------------------

/** Newest ``system.checkpoint_created`` event for this goal, as a dict.
 *  Returns None when nothing was ever written (a fresh goal). */
export function load_latest_checkpoint(
    storage: StorageLike,
    opts: { goal_id?: unknown; session_id?: unknown } = {},
): Record<string, unknown> | null {
    const goalId = "goal_id" in opts ? opts.goal_id : "";
    const sessionId = "session_id" in opts ? opts.session_id : "";
    if (!pyTruth(goalId || sessionId)) {
        return null;
    }
    let events: unknown[];
    try {
        if (pyTruth(goalId)) {
            events = storage.get_event_store().read_by_dimension("goal_id", pyStr(goalId), 2000);
        } else {
            events = storage.get_event_store().read_stream(pyStr(sessionId));
        }
    } catch {
        return null;
    }
    let picked: unknown = null;
    for (const ev of events) {
        if (evAttr(ev, "event_type", "eventType", "") !== "system.checkpoint_created") {
            continue;
        }
        // python: payload = ev.payload or {} — 然后 payload.get("goal_id")。
        // 若 payload 是真值非 dict（str/list），.get 抛 AttributeError 不上catch。
        const pRaw = evAttr(ev, "payload", "payload", null);
        const pl = pyTruth(pRaw) ? pRaw : {};
        if (pyTruth(goalId)) {
            // python: str(payload.get("goal_id") or "") != str(goal_id)
            if (pyStr0(dictGet(pl, "goal_id")) !== pyStr(goalId)) {
                continue;
            }
        }
        const evSeq = evAttr(ev, "seq", "seq", 0);
        const pickedSeq = evAttr(picked, "seq", "seq", 0);
        if (picked === null || (evSeq as number) > (pickedSeq as number)) {
            picked = ev;
        }
    }
    if (picked === null) {
        return null;
    }
    const rawPayload = evAttr(picked, "payload", "payload", null);
    const cp = pyDictCtor(pyTruth(rawPayload) ? rawPayload : {});
    // The event row is authoritative about where the checkpoint lives; older
    // payloads may have blanked these.
    if (!("session_id" in cp)) {
        const esid = evAttr(picked, "session_id", "sessionId", "");
        cp["session_id"] = pyTruth(esid) ? esid : "";
    }
    cp["checkpoint_event_seq"] = evAttr(picked, "seq", "seq", null);
    return cp;
}

// ---------------------------------------------------------------------------
// §5.3 resume：校验恢复现场（只读）
// ---------------------------------------------------------------------------

/** §5.3 resume：从 checkpoint 重建恢复现场。**只读**——绝不触发副作用工具。
 *  校验三件事，任何一件不过都如实报告而不是盲续。 */
export function resume_from_checkpoint(
    storage: StorageLike,
    checkpoint: unknown,
): Record<string, unknown> {
    const problems: unknown[] = [];
    const sid = pyStr0(dictGet(checkpoint, "session_id"));
    const seqRaw = dictGet(checkpoint, "last_event_seq");
    const seq = pyInt(pyTruth(seqRaw) ? seqRaw : 0);
    const early = (reason: unknown[]): Record<string, unknown> => ({
        ok: false,
        problems: reason,
        messages: [],
        rebuild_source: "none",
        dont_redo: [],
        verify_before_redo: [],
        goal_snapshot: {},
    });
    if (!sid) {
        return early(["checkpoint 缺 session_id"]);
    }

    let seqs: Set<unknown>;
    try {
        const events = storage.get_event_store().read_stream(sid);
        seqs = new Set(events.map((e) => evAttr(e, "seq", "seq", 0)));
    } catch (e) {
        return early([`stream unreadable: ${excStr(e)}`]);
    }
    if (pyTruth(seq) && !seqs.has(seq)) {
        problems.push(`checkpoint seq ${pyStr(seq)} 不在当前流中——分支可能已移动`);
    }

    // 尾部重建：主源 = 事件流投影；兜底 = 存储直读（并校验尾部仍可寻）
    const tailRaw = dictGet(checkpoint, "retained_tail");
    const tail = (pyTruth(tailRaw) ? tailRaw : []) as unknown[];
    let rebuilt: unknown[] = [];
    let source = "none";
    try {
        const lenOr8 = tail.length > 0 ? tail.length : 8;
        const rebuiltEvt = rebuild_tail_from_events(storage, sid, {
            upto_seq: seq,
            n: Math.max(lenOr8, 8),
        });
        if (pyTruth(rebuiltEvt)) {
            rebuilt = rebuiltEvt;
            source = "events";
        }
    } catch (e) {
        // 主源失败会静默降级到存储直读——恢复质量悄悄变差必须留痕。
        console.log(`[checkpoint] event-projection rebuild failed for ${sid}, falling back to storage tail: ${excStr(e)}`);
    }

    let missing = 0;
    if (!(rebuilt.length > 0) && tail.length > 0) {
        source = "storage";
        let stored: unknown[] = [];
        try {
            stored = iterPy(storage.get_messages(sid, 200)).map((m) => pyDictCtor(m));
        } catch {
            stored = [];
        }
        for (const t of iterPy(tail)) {
            const tKey = pyStr0(dictGet(t, "content"));
            let hit: unknown = null;
            let found = false;
            for (const m of iterPy(stored)) {
                const mKey = pySliceEnd(pyStr0(dictGet(m, "content")), 500);
                if (mKey === tKey) {
                    hit = m;
                    found = true;
                    break;
                }
            }
            if (!found) {
                missing += 1;
            } else {
                rebuilt.push(hit);
            }
        }
    }

    if (tail.length > 0 && rebuilt.length === 0) {
        problems.push("对话尾既无法从事件投影也无法从存储找回");
    }
    if (missing) {
        problems.push(`retained_tail 有 ${pyStr(missing)} 条在存储中找不到（可能已被用户删除）`);
    }

    const dontRaw = dictGet(checkpoint, "completed_side_effects");
    const verifyRaw = dictGet(checkpoint, "unresolved_side_effects");
    const goalRaw = dictGet(checkpoint, "goal_snapshot");
    return {
        ok: problems.length === 0,
        problems,
        session_id: sid,
        messages: rebuilt,
        rebuild_source: source,
        dont_redo: pyTruth(dontRaw) ? [...iterPy(dontRaw)] : [],
        // 未知态单独一条通道：混进 dont_redo 会把"先核对"降级成"别做"。
        verify_before_redo: pyTruth(verifyRaw) ? [...iterPy(verifyRaw)] : [],
        goal_snapshot: pyTruth(goalRaw) ? goalRaw : {},
    };
}

/** str(x or "") — falsy 折叠为 ""，其余 str()。 */
function pyStr0(v: unknown): string {
    return pyTruth(v) ? pyStr(v) : "";
}

// ---------------------------------------------------------------------------
// 拼装：从既有事实源自包含 checkpoint
// ---------------------------------------------------------------------------

/** 从既有事实源拼装一份自包含 checkpoint。取不到任何流时返回 None。 */
export function build_checkpoint(
    storage: StorageLike,
    opts: {
        session_id: string;
        goal_id?: string;
        run_id?: string;
        turn_state?: string;
        current_phase?: string;
        scope?: string;
    },
): Record<string, unknown> | null {
    const sessionId = opts.session_id;
    const goalId = "goal_id" in opts ? opts.goal_id : "";
    const runId = "run_id" in opts ? opts.run_id : "";
    const turnState = "turn_state" in opts ? opts.turn_state : "";
    const currentPhase = "current_phase" in opts ? opts.current_phase : "";
    const scope = "scope" in opts ? opts.scope : "";

    let events: unknown[];
    try {
        events = storage.get_event_store().read_stream(sessionId);
    } catch {
        events = [];
    }
    if (!pyTruth(events)) {
        return null;
    }

    const last = events[events.length - 1];
    let completedSideEffects: unknown = [];
    try {
        if (pyTruth(goalId)) {
            completedSideEffects = iterPy(storage.completed_side_effects(goalId as string))
                .map((e) => dictSub(e, "call_id"));
        } else {
            completedSideEffects = [];
        }
    } catch {
        // fail-open: 可选增强，失败不影响主流程
    }

    // 结果未知的副作用。和 completed 分开存：一个说"别重做"，一个说"先核对"。
    let unresolvedSideEffects: unknown = [];
    if (pyTruth(goalId)) {
        try {
            unresolvedSideEffects = iterPy(storage.unknown_side_effects(goalId as string))
                .map((r) => ({
                    call_id: dictGet(r, "call_id", ""),
                    tool_name: dictGet(r, "tool_name", ""),
                    status: dictGet(r, "status", ""),
                }));
        } catch {
            // fail-open: 可选增强，失败不影响主流程
        }
    }

    let goalSnapshot: Record<string, unknown> = {};
    if (pyTruth(goalId)) {
        try {
            const raw = storage.get_goal(goalId as string);
            const row = pyTruth(raw) ? raw : {};
            // python: (row.get("contract_json") or "")[:4000] — 真值非序列
            // （int）在切片处抛 TypeError，被外层 except 吞掉，goal_snapshot
            // 整个置回 {}（dict 字面量在 try 内构造）。
            const cjRaw = dictGet(row, "contract_json");
            let contract: unknown = "";
            if (pyTruth(cjRaw)) {
                if (typeof cjRaw === "string") {
                    contract = pySliceEnd(cjRaw, 4000);
                } else if (Array.isArray(cjRaw)) {
                    contract = cjRaw.slice(0, 4000);
                } else if (isPyDict(cjRaw)) {
                    throw new TypeErrorP("unhashable type: 'slice'");
                } else {
                    throw new TypeErrorP(`'${pyTypeName(cjRaw)}' object is not subscriptable`);
                }
            }
            goalSnapshot = {
                status: dictGet(row, "status"),
                iteration: dictGet(row, "iteration"),
                plan_json: dictGet(row, "plan_json"),
                contract_json: contract,
                budget_used_last_error: dictGet(row, "last_error"),
            };
        } catch {
            goalSnapshot = {};
        }
    }

    // §5.2 retained_tail / context_snapshot_id：保留尾部是恢复后模型最先
    // 看到的对话；快照 id 是它的确定性指纹——内容变，id 变。
    let retainedTail: Record<string, unknown>[] = [];
    let contextSnapshotId = "";
    try {
        for (let m of iterPy(storage.get_messages(sessionId, 8))) {
            if (!isPyDict(m)) {
                m = pyDictCtor(m);
            }
            const ts = dictGet(m, "timestamp");
            const ca = dictGet(m, "created_at");
            retainedTail.push({
                role: pyStr0(dictGet(m, "role")),
                content: pySliceEnd(pyStr0(dictGet(m, "content")), 500),
                ts: pyTruth(ts) ? ts : (pyTruth(ca) ? ca : ""),
            });
        }
    } catch {
        retainedTail = [];
    }
    if (retainedTail.length > 0) {
        const digestSrc = pyJsonDumps(retainedTail);
        contextSnapshotId = "ctx:" + createHash("sha256").update(digestSrc, "utf8").digest("hex").slice(0, 16);
    }

    const lastSeq = evAttr(last, "seq", "seq", null);
    const checkpoint: Record<string, unknown> = {
        run_id: runId,
        turn_id: "",
        goal_id: goalId,
        session_id: sessionId,
        last_event_seq: lastSeq,
        last_event_id: `${pyStr(sessionId)}:${pyStr(evAttr(last, "seq", "seq", ""))}`,
        turn_state: turnState,
        current_phase: currentPhase,
        pending_tool_calls: [],
        completed_side_effects: completedSideEffects,
        unresolved_side_effects: unresolvedSideEffects,
        goal_snapshot: goalSnapshot,
        context_snapshot_id: contextSnapshotId,
        retained_tail: retainedTail,
        usage_snapshot: {},
        policy_snapshot: {},
        created_at: Math.floor(Date.now() / 1000),
    };
    try {
        const scopeKey = scope && true ? scope : (goalId && true ? goalId : sessionId);
        storage.trace_event({
            session_id: sessionId,
            event_type: "system.checkpoint_created",
            payload: checkpoint,
            importance: "critical",
            idempotency_key: `checkpoint:${pyStr(scopeKey)}:${pyStr(checkpoint["last_event_seq"])}`,
            run_id: pyTruth(runId) ? runId : null,
            goal_id: pyTruth(goalId) ? goalId : null,
        });
    } catch (e) {
        console.log(`[checkpoint] emit failed: ${excStr(e)}`);
        return null;
    }
    return checkpoint;
}

// PORT STATUS: confidence=high todos=[0]
