/**
 * browser_sessions.ts — 浏览器多标签会话管理.
 *
 * Ported from `app/backend/browser_sessions.py` (898 lines, wave-5 TS).
 * Prerequisite for browser_agent.ts: the two modules form the dep-map SCC,
 * broken the same way here — browser_agent.ts statically imports this file
 * and this file only reaches ElectronBrowserClient through an injectable seam.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/browser_sessions.py -> app/engine/browser_sessions.ts.
 *   §2  every `or` gate is TRUTHINESS (pyTruth), never `??`: an empty-string
 *       tab url folds to "" through `url or ""`, a present-but-null snapshot
 *       key reads via dictGet (get(k) yields None, get(k, d) yields d only
 *       when the key is absent), `str(...)` calls use pyStr (bool -> True/False,
 *       containers -> repr-style, ints stay ints).
 *   §2  `int(width)`/`float(opened_at)` coercion keeps the CPython contract
 *       (probe-pinned against 3.13): int(800.9) truncates toward zero,
 *       int(None) raises TypeError (caught by set_viewport), int("1_0") == 10,
 *       int(float("nan")) raises ValueError (caught) while int(float("inf"))
 *       raises OverflowError which ESCAPES the (TypeError, ValueError) catch
 *       and crashes the whole call — preserved. float("abc") raises
 *       ValueError("could not convert string to float: 'abc'") and
 *       restore_state has NO handler for it: the exception propagates through
 *       resume_session exactly like the source (bug-for-bug, Result 纪律
 *       excepted where the source itself violates it).
 *   §2  isinstance(x, int) in restore_state accepts bool (python bool IS int)
 *       — isPyInt mirrors that; a snapshot viewport {"width": true} survives.
 *   §2  restore_state validates entries WHILE mutating: a malformed entry in
 *       the middle leaves the earlier entries already applied to the session.
 *       The partial-application is the source behaviour and is kept.
 *   §2  to_dict/summary/merged dicts rely on python dict insertion order;
 *       tabs is a Map (arbitrary keys incl. numeric strings keep insertion
 *       order, unlike a plain JS object), and every returned object literal
 *       spells its keys in the source order.
 *   §2  base64.b64decode(validate=False) semantics pinned by a 39-case
 *       differential matrix (tmp/py_matrix_b64.json): alphabet-invalid chars
 *       are dropped, "=" counts toward the quad, trailing-payload check is
 *       (data % 4 == 1) -> "Invalid base64-encoded string: number of data
 *       characters (N) cannot be 1 more than a multiple of 4"; a remainder of
 *       3 needs >=1 trailing pad, 2 needs >=2, else "Incorrect padding".
 *       pyB64decode() reimplements exactly that (e.g. "QQ==QQ" decodes to the
 *       same 3 bytes as "QQQQ", "QQ=Q" errors).
 *   §2  claim protocol is fail-closed with raw != != (no normalization): the
 *       CN refusal texts quote both the referenced snapshot and the current
 *       state; a successful claim MUTATES the caller's TabClaim.claimed_at_ms
 *       (int(time.time()*1000)) and embeds the live claim object in the
 *       success payload. The three claim methods were monkey-patched onto the
 *       classes in python (分区约束); they are ordinary methods here — same
 *       dispatch, same behaviour.
 *   §2  manager prechecks are READ-ONLY (never commit before the bridge
 *       answers), set_viewport commits first and rolls the viewport back on
 *       bridge failure while reset_viewport calls the bridge first — the two
 *       opposite orderings are preserved per method.
 *
 * MIGRATION DECISIONS / DIVERGENCES (documented dispositions)
 *   DIVERGENCE(port, async bridge): python drives the 8766 bridge
 *       synchronously (urllib). Node has no sync HTTP, so every manager
 *       method that can touch the bridge returns Promise<Result> with the
 *       SAME resolution values; the pure-state BrowserSession stays fully
 *       synchronous and the injected BridgeClient may even answer
 *       synchronously (await tolerates both). Callers (browser_agent.ts)
 *       live in async land already. Behaviour of every step (payload,
 *       ordering, commit-on-success) is byte-identical.
 *   DIVERGENCE(port, lazy import seam): `_bridge()` used
 *       `from browser_agent import ElectronBrowserClient` at call time to
 *       break the module cycle. Here browser_agent.ts registers
 *       SESSION_SEAMS.createBridgeClient at import; production always
 *       injects a client explicitly (BrowserAgent passes its own), so the
 *       seam default is only reachable for a standalone manager. If
 *       unregistered, _bridge throws an ImportError-named Error instead of
 *       constructing — no production path hits it (same argument as
 *       providers/index.ts async bridge divergence).
 *   DIVERGENCE(port, path join separators): node's path.join normalizes
 *       EVERY separator in the result to "\" on Windows, while
 *       os.path.join (ntpath) leaves "/" already present in the base alone,
 *       so a mixed-separator workspace yields "D:\\ws\\screenshots\\x.png"
 *       here vs "D:/ws\\screenshots\\x.png" in python. Both forms are the
 *       same file for every consumer (os/fs open, mkdir, display); the probe
 *       therefore feeds both sides a single-separator workspace so the
 *       screenshot paths serialize identically.
 *   DIVERGENCE(port, repr of JSON numbers): `!r` texts (viewport coercion
 *       failure, snapshot session-id / tab-state diagnostics) print python
 *       floats with ".0"; JS cannot distinguish 800 (int) from 800.0 (float)
 *       after JSON transport. Unreachable in practice: every width/height/
 *       state value the bridge or our own to_dict produces is an int or str,
 *       and the probe pins the reachable cases.
 *   DIVERGENCE(port, viewport extra keys): dict(viewport) copy preserves any
 *       extra keys in python order; a JS object literal re-sorts
 *       integer-like extra keys ("1") first. Unreachable: set_viewport only
 *       writes {width,height} and Electron's payloads carry no numeric keys.
 *   deque(maxlen=200) -> array push + shift at 201 (identical ring-buffer
 *       drop-oldest behaviour, same entry key order).
 *   time/uuid/tempfile are read through SESSION_SEAMS so the parity probe
 *       pins them identically on both sides (house pattern: BOT_SEAMS).
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Result } from "./result.js";

type JsonDict = Record<string, unknown>;

// ── 标签生命周期状态 ─────────────────────────────────────────────────────────
export const TAB_ACTIVE = "active";          // 在世且可用（焦点与否由 session.active_tab_id 决定）
export const TAB_SUSPENDED = "suspended";    // 挂起省内存：Electron 已拆下页面，状态保留
export const TAB_CLOSED = "closed";          // 终态：不可再操作

const LIVE_STATES: readonly string[] = [TAB_ACTIVE, TAB_SUSPENDED];

/** 找不到任务级会话时使用的兜底任务号（单任务/手工使用的默认会话）。 */
export const DEFAULT_TASK_ID = "default";

/** 同时在册的会话上限——内存护栏，防止失控任务把标签表撑爆。 */
export const MAX_SESSIONS = 16;

// ---------------------------------------------------------------------------
// seams (house pattern: BOT_SEAMS in bot_remote.ts) — the parity probe pins
// these so both sides see identical ids/timestamps/temps.
// ---------------------------------------------------------------------------
export type BridgeClient = {
    call(endpoint: string, payload: JsonDict, opts?: { timeout?: number }): Result | Promise<Result>;
};

export const SESSION_SEAMS = {
    /** uuid.uuid4().hex — 32 lowercase hex chars. */
    uuid4Hex: (): string => randomUUID().replace(/-/g, ""),
    /** time.time() — float seconds. */
    now: (): number => Date.now() / 1000,
    /** tempfile.gettempdir(). */
    tempdir: (): string => os.tmpdir(),
    /**
     * DIVERGENCE(port, lazy import seam): replaces the runtime
     * `from browser_agent import ElectronBrowserClient`; browser_agent.ts
     * registers the factory at module load; production injects a client and
     * never consults this.
     */
    createBridgeClient: null as null | (() => BridgeClient),
};

// ---------------------------------------------------------------------------
// python-semantics helpers (house style: bot_remote.ts / file_agent.ts)
// ---------------------------------------------------------------------------

class TypeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "TypeError"; }
}
class ValueErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ValueError"; }
}
class OverflowErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "OverflowError"; }
}
class ImportErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ImportError"; }
}
class BinasciiErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "binascii.Error"; }
}
class AttributeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "AttributeError"; }
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "function") return true; // python functions are truthy
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map) return v.size > 0;
    return Object.keys(v as object).length > 0;
}

function pyOr(a: unknown, b: unknown): unknown {
    return pyTruth(a) ? a : b;
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (v instanceof Map) return "dict";
    if (typeof v === "function") return "function";
    if (v instanceof Error) return v.name || "Error";
    if (typeof v === "object") return v.constructor?.name ?? "object";
    return typeof v;
}

/** python `str(x)` on the primitives that flow through this module. */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (typeof v === "string") return v;
    return pyRepr(v);
}

/** number -> python str(): ints plain, floats keep a ".0"/exponent shape. */
function pyNumStr(v: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    // DIVERGENCE(port, repr of JSON numbers): JS cannot tell an int 800 from
    // a float 800.0 after JSON transport; ints print bare.
    if (Number.isInteger(v) && Math.abs(v) < 1e21) return String(v);
    return String(v);
}

function pyReprStr(s: string): string {
    // CPython prefers single quotes; switches to double when the value
    // contains ' but no ".
    const hasSingle = s.includes("'");
    const hasDouble = s.includes('"');
    const quote = hasSingle && !hasDouble ? '"' : "'";
    let out = quote;
    for (const ch of s) {
        if (ch === "\\") out += "\\\\";
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (ch === quote) out += "\\" + quote;
        else if (ch.codePointAt(0)! < 0x20) out += "\\x" + ch.codePointAt(0)!.toString(16).padStart(2, "0");
        else out += ch;
    }
    return out + quote;
}

/** repr() for the JSON-ish values that can reach an `!r` f-string. */
function pyRepr(v: unknown): string {
    if (typeof v === "string") return pyReprStr(v);
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Map) {
        const parts: string[] = [];
        for (const [k, val] of v) parts.push(`${pyReprKey(k)}: ${pyRepr(val)}`);
        return "{" + parts.join(", ") + "}";
    }
    if (typeof v === "object") {
        const parts: string[] = [];
        for (const [k, val] of Object.entries(v as JsonDict)) parts.push(`${pyReprStr(k)}: ${pyRepr(val)}`);
        return "{" + parts.join(", ") + "}";
    }
    return String(v);
}

function pyReprKey(k: unknown): string {
    return typeof k === "string" ? pyReprStr(k) : pyRepr(k);
}

/** dict.get(k) / dict.get(k, default) with python present-but-null semantics. */
function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
    if (obj === null || obj === undefined || typeof obj !== "object" || Array.isArray(obj)) {
        throw new AttributeErrorP(
            `'${obj instanceof Map ? "dict" : pyTypeName(obj)}' object has no attribute 'get'`);
    }
    if (obj instanceof Map) return obj.has(key) ? obj.get(key) : dflt;
    return key in (obj as JsonDict) ? (obj as JsonDict)[key] : dflt;
}

function dictGetD(obj: JsonDict, key: string, dflt: unknown = null): unknown {
    return key in obj ? obj[key] : dflt;
}

/** python `isinstance(x, int)` — bool IS int in python. */
function isPyInt(v: unknown): boolean {
    return (typeof v === "number" && Number.isInteger(v)) || typeof v === "boolean";
}

const PY_WS = "\\t\\n\\v\\f\\r\\x1c\\x1d\\x1e\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

function pyStrip(s: string): string {
    return s.replace(new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g"), "");
}

/** int(x) for the values that reach set_viewport (probe-pinned 3.13 texts). */
function pyIntCoerce(v: unknown): number {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") {
        if (Number.isNaN(v)) throw new ValueErrorP("cannot convert float NaN to integer");
        if (!Number.isFinite(v)) throw new OverflowErrorP("cannot convert float infinity to integer");
        return Math.trunc(v);
    }
    if (typeof v === "string") {
        const t = pyStrip(v);
        if (/^[+-]?\d+(?:_\d+)*$/.test(t)) return Number(t.replace(/_/g, ""));
        throw new ValueErrorP(`invalid literal for int() with base 10: ${pyRepr(v)}`);
    }
    throw new TypeErrorP(
        `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

/** float(x) — used by restore_state on opened_at, where it is NOT caught. */
function pyFloatCoerce(v: unknown): number {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") return v;
    if (typeof v === "string") {
        const t = pyStrip(v);
        const lower = t.toLowerCase();
        if (lower === "nan" || lower === "+nan" || lower === "-nan") return NaN;
        if (lower === "inf" || lower === "infinity" || lower === "+inf" || lower === "+infinity") return Infinity;
        if (lower === "-inf" || lower === "-infinity") return -Infinity;
        if (/^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d(?:_\d+)*)?)?|\.(?:\d(?:_\d+)*))(?:[eE][+-]?\d+)?$/.test(t)) {
            return Number(t.replace(/_/g, ""));
        }
        throw new ValueErrorP(`could not convert string to float: ${pyRepr(v)}`);
    }
    throw new TypeErrorP(`float() argument must be a string or a real number, not '${pyTypeName(v)}'`);
}

/**
 * base64.b64decode(s) with validate=False, matching the 39-case differential
 * matrix tmp/py_matrix_b64.json pinned against CPython 3.13:
 *   - characters outside [A-Za-z0-9+/=] are dropped;
 *   - "=" counts as a quad slot; the check at end-of-input is on the count of
 *     DATA characters (d) and the run of trailing "=" after the last data
 *     char: d%4==1 -> the "1 more than a multiple of 4" error; d%4==3 needs
 *     >=1 trailing pad and d%4==2 needs >=2, else "Incorrect padding".
 *   - "QQ==QQ" decodes the same as "QQQQ"; "QQ=Q" raises. (Both matrix cases.)
 */
function pyB64decode(s: string): Buffer {
    let data = "";
    let trailingPad = 0;
    for (const ch of s) {
        if (ch === "=") { trailingPad += 1; continue; }
        if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") ||
            (ch >= "0" && ch <= "9") || ch === "+" || ch === "/") {
            data += ch;
            trailingPad = 0;
        }
        // any other character is silently dropped (non-strict)
    }
    const mod = data.length % 4;
    if (mod === 1) {
        throw new BinasciiErrorP(
            `Invalid base64-encoded string: number of data characters (${data.length}) ` +
            "cannot be 1 more than a multiple of 4");
    }
    if (mod === 3 && trailingPad < 1) throw new BinasciiErrorP("Incorrect padding");
    if (mod === 2 && trailingPad < 2) throw new BinasciiErrorP("Incorrect padding");
    const add = (4 - mod) % 4;
    const buf = Buffer.from(data + "A".repeat(add), "base64");
    return add ? buf.subarray(0, buf.length - add) : buf;
}

// ---------------------------------------------------------------------------
// resolve_task_id
// ---------------------------------------------------------------------------

/**
 * 从工具参数/上下文解析任务号: args.task_id > ctx.task_id > ctx.session_id > default.
 *
 * 会话按任务号隔离，所以任务号的来源必须稳定可解释；三者都缺时落回
 * "default"（交互式单任务场景），绝不静默串会话。
 */
export function resolve_task_id(args: unknown, ctx: unknown = null): string {
    const a = (pyTruth(args) ? args : {}) as JsonDict;
    const c = (pyTruth(ctx) ? ctx : {}) as JsonDict;
    for (const source of [dictGet(a, "task_id"), dictGet(c, "task_id"), dictGet(c, "session_id")]) {
        if (pyTruth(source)) return pyStr(source);
    }
    return DEFAULT_TASK_ID;
}

// ---------------------------------------------------------------------------
// TabRecord
// ---------------------------------------------------------------------------

/** 一个标签的会话内状态（TS 侧是生命周期状态的权威，Electron 是实体）。 */
export class TabRecord {
    tab_id: unknown;
    url: unknown;
    title: unknown;
    state: string;
    viewport: JsonDict | null;   // {"width": int, "height": int}；null = 填满窗口
    opened_at: number;
    last_active: number;

    constructor(init: {
        tab_id: unknown;
        url?: unknown;
        title?: unknown;
        state?: string;
        viewport?: JsonDict | null;
        opened_at?: number;
        last_active?: number;
    }) {
        this.tab_id = init.tab_id;
        this.url = init.url ?? "";
        this.title = init.title ?? "";
        this.state = init.state ?? TAB_ACTIVE;
        this.viewport = init.viewport ?? null;
        this.opened_at = init.opened_at ?? SESSION_SEAMS.now();
        this.last_active = init.last_active ?? SESSION_SEAMS.now();
    }

    to_dict(): JsonDict {
        return {
            "tab_id": this.tab_id,
            "url": this.url,
            "title": this.title,
            "state": this.state,
            "viewport": pyTruth(this.viewport) ? { ...(this.viewport as JsonDict) } : null,
            "opened_at": this.opened_at,
        };
    }
}

// ═══ 会话（纯状态机，不碰桥）═══

/**
 * 一个 AI 任务的浏览器会话：若干标签 + 焦点指针 + 生命周期状态机。
 *
 * 严格状态机:
 *   open    → active（新标签；默认夺焦点，与浏览器 UX 一致）
 *   activate: active/suspended → active（挂起标签被激活即唤醒）并夺焦点
 *   suspend : active → suspended（重复挂起/对挂起标签挂起 → 拒绝）
 *   resume  : suspended → active（不夺焦点——激活是 activate 的事）
 *   close   : active/suspended → closed（终态；此后一切操作拒绝）
 */
export class BrowserSession {
    session_id: string;
    task_id: string;
    /** dict 保插入序 = 打开序（Map 与 python dict 同构，含非字符串键） */
    tabs: Map<unknown, TabRecord>;
    active_tab_id: unknown;
    created_at: number;
    last_active: number;
    active_until: number;

    constructor(session_id: string, task_id: string) {
        this.session_id = session_id;
        this.task_id = task_id;
        this.tabs = new Map();
        this.active_tab_id = null;
        this.created_at = SESSION_SEAMS.now();
        this.last_active = this.created_at;
        this.active_until = 0.0;
    }

    /** 刷新活跃时间戳。 */
    touch(now: number | null = null): void {
        const ts = now !== null ? now : SESSION_SEAMS.now();
        this.last_active = ts;
        if (pyTruth(this.active_tab_id) && this.tabs.has(this.active_tab_id)) {
            (this.tabs.get(this.active_tab_id) as TabRecord).last_active = ts;
        }
    }

    /** 标记活跃 Run，防止被空闲收割。 */
    mark_run_active(duration_s = 300.0, now: number | null = null): void {
        const ts = now !== null ? now : SESSION_SEAMS.now();
        this.active_until = Math.max(this.active_until ?? 0.0, ts + duration_s);
    }

    // ── 查询 ──

    get_tab(tab_id: unknown): TabRecord | null {
        return this.tabs.get(tab_id) ?? null;
    }

    is_owned(tab_id: unknown): boolean {
        return this.tabs.has(tab_id);
    }

    live_tabs(): TabRecord[] {
        const out: TabRecord[] = [];
        for (const t of this.tabs.values()) {
            if (LIVE_STATES.includes(t.state)) out.push(t);
        }
        return out;
    }

    latest_live_tab_id(): unknown {
        const live = this.live_tabs();
        for (let i = live.length - 1; i >= 0; i -= 1) return live[i]!.tab_id;
        return null;
    }

    /** 最近一个"可立即成为焦点"的标签（active；挂起标签需先唤醒）。 */
    latest_focusable_tab_id(): unknown {
        let last: unknown = null;
        for (const tab of this.tabs.values()) {
            if (tab.state === TAB_ACTIVE) last = tab.tab_id;
        }
        return last;
    }

    _set_focus(tab_id: unknown): void {
        this.active_tab_id = tab_id;
    }

    /** 焦点标签退场（关闭/挂起）时，把焦点交给最近的其他 active 标签。 */
    _refocus_after_loss(lost_tab_id: unknown): unknown {
        if (this.active_tab_id !== lost_tab_id) return this.active_tab_id;
        const nxt = this.latest_focusable_tab_id();
        this._set_focus(nxt);
        return nxt;
    }

    // ── 状态机 ──

    open_tab(tab_id: unknown, url: unknown = "", title: unknown = "", focus = true): Result {
        if (this.tabs.has(tab_id)) {
            return Result.failure(`tab id already exists in this session: ${pyStr(tab_id)}`);
        }
        const record = new TabRecord({ tab_id, url: pyOr(url, ""), title: pyOr(title, "") });
        this.tabs.set(tab_id, record);
        if (focus) this._set_focus(tab_id);
        return Result.success(record.to_dict());
    }

    activate_tab(tab_id: unknown): Result {
        const record = this.tabs.get(tab_id) ?? null;
        if (record === null) {
            return Result.failure(`unknown tab '${pyStr(tab_id)}' in task '${this.task_id}'`);
        }
        if (record.state === TAB_CLOSED) {
            return Result.failure(`tab '${pyStr(tab_id)}' is closed and cannot be activated`);
        }
        record.state = TAB_ACTIVE;
        this._set_focus(tab_id);
        return Result.success(record.to_dict());
    }

    suspend_tab(tab_id: unknown): Result {
        const record = this.tabs.get(tab_id) ?? null;
        if (record === null) {
            return Result.failure(`unknown tab '${pyStr(tab_id)}' in task '${this.task_id}'`);
        }
        if (record.state === TAB_CLOSED) {
            return Result.failure(`tab '${pyStr(tab_id)}' is closed and cannot be suspended`);
        }
        if (record.state === TAB_SUSPENDED) {
            return Result.failure(`tab '${pyStr(tab_id)}' is already suspended`);
        }
        record.state = TAB_SUSPENDED;
        const new_focus = this._refocus_after_loss(tab_id);
        return Result.success({ ...record.to_dict(), "new_focus": new_focus });
    }

    resume_tab(tab_id: unknown): Result {
        const record = this.tabs.get(tab_id) ?? null;
        if (record === null) {
            return Result.failure(`unknown tab '${pyStr(tab_id)}' in task '${this.task_id}'`);
        }
        if (record.state === TAB_CLOSED) {
            return Result.failure(`tab '${pyStr(tab_id)}' is closed and cannot be resumed`);
        }
        if (record.state === TAB_ACTIVE) {
            return Result.failure(`tab '${pyStr(tab_id)}' is not suspended`);
        }
        record.state = TAB_ACTIVE;
        return Result.success(record.to_dict());
    }

    close_tab(tab_id: unknown): Result {
        const record = this.tabs.get(tab_id) ?? null;
        if (record === null) {
            return Result.failure(`unknown tab '${pyStr(tab_id)}' in task '${this.task_id}'`);
        }
        if (record.state === TAB_CLOSED) {
            return Result.failure(`tab '${pyStr(tab_id)}' is already closed`);
        }
        record.state = TAB_CLOSED;
        const new_focus = this._refocus_after_loss(tab_id);
        return Result.success({ ...record.to_dict(), "new_focus": new_focus });
    }

    set_viewport(tab_id: unknown, width: unknown, height: unknown): Result {
        const found = this._live_tab_for_viewport(tab_id);
        if (found instanceof Result) return found;
        let w: number, h: number;
        try {
            w = pyIntCoerce(width);
            h = pyIntCoerce(height);
        } catch (e) {
            const err = e as Error;
            // int(float("inf")) raises OverflowError — NOT caught by the
            // source's (TypeError, ValueError) either; it escapes.
            if (err instanceof TypeErrorP || err instanceof ValueErrorP) {
                return Result.failure(
                    `viewport needs numeric width/height, got ${pyRepr(width)}x${pyRepr(height)}`);
            }
            throw err;
        }
        if (w <= 0 || h <= 0 || w > 10000 || h > 10000) {
            return Result.failure(`viewport out of range (1..10000): ${w}x${h}`);
        }
        found.viewport = { "width": w, "height": h };
        return Result.success(found.to_dict());
    }

    reset_viewport(tab_id: unknown): Result {
        const found = this._live_tab_for_viewport(tab_id);
        if (found instanceof Result) return found;
        found.viewport = null;
        return Result.success(found.to_dict());
    }

    _live_tab_for_viewport(tab_id: unknown): TabRecord | Result {
        const record = this.tabs.get(tab_id) ?? null;
        if (record === null) {
            return Result.failure(`unknown tab '${pyStr(tab_id)}' in task '${this.task_id}'`);
        }
        if (record.state === TAB_CLOSED) {
            return Result.failure(`tab '${pyStr(tab_id)}' is closed and cannot be resized`);
        }
        return record;
    }

    /**
     * 导航落定后回写标签事实（url/标题/唤醒/夺焦点）。
     *
     * 导航即唤醒即展示：对挂起标签导航，Electron 侧会重新挂载并显示，
     * Python 侧同步把状态与焦点对齐，避免两侧各说各话。
     */
    note_navigation(tab_id: unknown, url: unknown, title: unknown = ""): Result {
        const record = this.tabs.get(tab_id) ?? null;
        if (record === null) {
            return Result.failure(`unknown tab '${pyStr(tab_id)}' in task '${this.task_id}'`);
        }
        if (record.state === TAB_CLOSED) {
            return Result.failure(`tab '${pyStr(tab_id)}' is closed and cannot be navigated`);
        }
        record.url = url;
        if (pyTruth(title)) record.title = title;
        if (record.state === TAB_SUSPENDED) record.state = TAB_ACTIVE;
        this._set_focus(tab_id);
        return Result.success(record.to_dict());
    }

    // ── 快照 / 恢复（任务切换时保存/恢复会话状态）──

    /** 可序列化快照：只存"事实"（在世标签 + 焦点），closed 不入快照。 */
    snapshot_state(): JsonDict {
        const liveIds = new Set<unknown>(this.live_tabs().map((t) => t.tab_id));
        return {
            "session_id": this.session_id,
            "task_id": this.task_id,
            "saved_at": SESSION_SEAMS.now(),
            "active_tab_id": pyTruth(this.active_tab_id) && liveIds.has(this.active_tab_id)
                ? this.active_tab_id : null,
            "tabs": this.live_tabs().map((t) => t.to_dict()),
        };
    }

    /**
     * 把快照覆盖回会话（TS 是状态权威；Electron 侧由编排层去收敛）。
     *
     * 快照里没有的本会话标签保持原样（不误杀快照后新开的东西）。
     */
    restore_state(state: unknown): Result {
        if (typeof state !== "object" || state === null || Array.isArray(state) ||
            !Array.isArray(dictGet(state, "tabs"))) {
            return Result.failure("malformed session snapshot (tabs list missing)");
        }
        const st = state as JsonDict;
        const snapTabs = st["tabs"] as unknown[];
        if (pyTruth(dictGet(st, "session_id")) && st["session_id"] !== this.session_id) {
            return Result.failure(
                `snapshot belongs to session ${pyRepr(st["session_id"])}, not ${pyRepr(this.session_id)}`);
        }
        for (const raw of snapTabs) {
            if (typeof raw !== "object" || raw === null || Array.isArray(raw) ||
                !pyTruth(dictGet(raw, "tab_id"))) {
                return Result.failure("malformed tab entry in session snapshot");
            }
            const r = raw as JsonDict;
            const tab_id = pyStr(r["tab_id"]);
            const state_name = dictGet(r, "state", TAB_ACTIVE);
            if (state_name !== TAB_ACTIVE && state_name !== TAB_SUSPENDED && state_name !== TAB_CLOSED) {
                return Result.failure(`unknown tab state in snapshot: ${pyRepr(state_name)}`);
            }
            let viewport = dictGet(r, "viewport") as JsonDict | null;
            if (viewport !== null && viewport !== undefined && (
                typeof viewport !== "object" || Array.isArray(viewport) ||
                !isPyInt(dictGet(viewport, "width")) || !isPyInt(dictGet(viewport, "height"))
            )) {
                viewport = null;
            }
            let existing = this.tabs.get(tab_id) ?? null;
            if (existing === null) {
                const oaRaw = dictGet(r, "opened_at");
                // lazy like python's `or`: time.time() is only consumed when
                // the snapshot carries a falsy opened_at.
                const oa = pyFloatCoerce(pyTruth(oaRaw) ? oaRaw : SESSION_SEAMS.now());
                existing = new TabRecord({
                    tab_id,
                    url: pyStr(pyOr(dictGet(r, "url"), "")),
                    title: pyStr(pyOr(dictGet(r, "title"), "")),
                    opened_at: oa,
                });
                this.tabs.set(tab_id, existing);
            }
            existing.url = pyStr(pyOr(dictGet(r, "url"), existing.url));
            existing.title = pyStr(pyOr(dictGet(r, "title"), existing.title));
            existing.viewport = pyTruth(viewport) ? { ...(viewport as JsonDict) } : null;
            existing.state = state_name as string;
        }
        const focus = dictGet(st, "active_tab_id");
        const focus_record = pyTruth(focus) ? (this.tabs.get(focus) ?? null) : null;
        if (focus_record !== null && LIVE_STATES.includes(focus_record.state)) {
            this._set_focus(focus);
        } else {
            this._set_focus(this.latest_live_tab_id());
        }
        return Result.success({
            "restored_tabs": snapTabs.length,
            "active_tab_id": this.active_tab_id,
        });
    }

    summary(): JsonDict {
        return {
            "session_id": this.session_id,
            "task_id": this.task_id,
            "active_tab_id": this.active_tab_id,
            "tabs": [...this.tabs.values()].map((t) => t.to_dict()),
            "live_count": this.live_tabs().length,
        };
    }

    /**
     * 认领一个既有标签——fail-closed 三查，全过才接管。（python 侧以模块级
     * 函数 monkey-patch 挂类；此处直接进类体，派发行为一致。）
     *
     * 1) 存在性: 标签必须在册且在世（closed 是终态，视同不存在）;
     * 2) 快照比对: (标题, url) 与凭据快照逐一原始全等；不全等即拒绝，且拒绝
     *    消息同时给出"引用时的快照"与"当前现状"，请用户重新引用后再认领;
     * 3) 接管: 复用 activate_tab 聚焦（挂起标签顺带唤醒），并回填 claimed_at_ms。
     *
     * 比对不过绝不触碰会话状态（不聚焦、不唤醒、不盖章）——fail-closed，
     * 不存在"相似也算过"的静默接管路径。
     */
    claim_tab(claim: unknown): Result {
        if (!(claim instanceof TabClaim) || claim.kind !== "tab") {
            return Result.failure("认领失败: 凭据类型不符（claim_tab 只接受 TabClaim）");
        }
        const record = this.tabs.get(claim.object_id) ?? null;
        if (record === null || record.state === TAB_CLOSED) {
            return Result.failure(`认领失败: 标签 ${pyStr(claim.object_id)} 不存在（可能已关闭）`);
        }
        if (claim.title_snapshot !== record.title || claim.url_snapshot !== record.url) {
            return Result.failure(
                `认领失败: 对象已变化（引用时: ${pyStr(claim.title_snapshot)} | ` +
                `${pyStr(claim.url_snapshot)} → 当前: ${pyStr(record.title)} | ${pyStr(record.url)}），` +
                "请重新引用后再认领");
        }
        const activated = this.activate_tab(claim.object_id);
        if (!activated.ok) return activated;
        claim.claimed_at_ms = Math.trunc(SESSION_SEAMS.now() * 1000);
        return Result.success({ "tab": activated.value, "claim": claim });
    }
}

// ═══ 编排层（会话状态 + 桥驱动）═══

export type ManagerOpts = {
    client?: BridgeClient | null;
    workspace?: string | null;
    id_factory?: (() => string) | null;
    session_id?: string;
};

/**
 * 会话编排：每个 AI 任务一个 BrowserSession，桥调用失败不提交状态。
 *
 * 桥客户端只需长着 ``call(endpoint, payload, {timeout}) -> Result`` 这张
 * 脸（生产环境注入 browser_agent.ElectronBrowserClient；测试注入假桥）。
 *
 * DIVERGENCE(port, async bridge): 所有可能打桥的方法返回 Promise<Result>，
 * 解析值与 python 同步版逐字段一致；纯查询/纯状态方法与 BrowserSession 一样
 * 保持同步。
 */
export class BrowserSessionManager {
    _client: BridgeClient | null;
    workspace: string | null;
    session_id: string;
    _id_factory: () => string;
    _sessions: Map<string, BrowserSession>;
    _snapshots: Map<string, JsonDict>;
    _seq: number;
    /** 有界事件流水（可观测性；不接异步 EventBus，避免同步编排层被拖进事件循环） */
    event_log: JsonDict[];

    constructor(opts: ManagerOpts = {}) {
        this._client = opts.client ?? null;
        this.workspace = opts.workspace ?? null;
        this.session_id = opts.session_id ?? "bs";
        this._id_factory = pyOr(opts.id_factory, null)
            ? (opts.id_factory as () => string)
            : (() => this._default_id_factory());
        this._sessions = new Map();
        this._snapshots = new Map();
        this._seq = 0;
        this.event_log = [];
    }

    // ── 基础设施 ──

    _default_id_factory(): string {
        this._seq += 1;
        return `tab-${String(this._seq).padStart(4, "0")}-${SESSION_SEAMS.uuid4Hex().slice(0, 6)}`;
    }

    _bridge(): BridgeClient {
        if (this._client === null) {
            // DIVERGENCE(port, lazy import seam): python 运行期 from browser_agent
            // import ElectronBrowserClient；TS 侧由 browser_agent.ts 注册工厂。
            const factory = SESSION_SEAMS.createBridgeClient;
            if (factory === null) {
                throw new ImportErrorP(
                    "cannot import name 'ElectronBrowserClient' from 'browser_agent' " +
                    "(SESSION_SEAMS.createBridgeClient is not registered)");
            }
            this._client = factory();
        }
        return this._client;
    }

    async _call(endpoint: string, payload: JsonDict, timeout = 35): Promise<Result> {
        return await this._bridge().call(endpoint, payload, { timeout });
    }

    _log(event: string, task_id: string, tab_id: unknown = null, detail = ""): void {
        this.event_log.push({
            "ts": SESSION_SEAMS.now(), "event": event, "task_id": task_id,
            "tab_id": tab_id === undefined ? null : tab_id, "detail": detail,
        });
        if (this.event_log.length > 200) this.event_log.shift();
    }

    _session_for(task_id: string, auto_begin = true): Result {
        const session = this._sessions.get(task_id) ?? null;
        if (session !== null) return Result.success(session);
        if (!auto_begin) {
            return Result.failure(`no active browser session for task '${task_id}'`);
        }
        const begun = this.begin_session(task_id);
        if (!begun.ok) return begun;
        return Result.success(this._sessions.get(task_id) as BrowserSession);
    }

    /** 把"可选标签号"解析成在世标签：缺省落在焦点标签上。 */
    _resolve_tab(session: BrowserSession, tab_id: unknown): Result {
        const target = pyOr(tab_id, session.active_tab_id);
        if (!pyTruth(target)) {
            return Result.failure(
                `no tab given and task '${session.task_id}' has no focused tab — open one first`);
        }
        const record = session.get_tab(target);
        if (record === null) {
            return Result.failure(
                `unknown tab '${pyStr(target)}' in task '${session.task_id}' ` +
                "(tabs are private to their task's session)");
        }
        if (record.state === TAB_CLOSED) {
            return Result.failure(`tab '${pyStr(target)}' is closed`);
        }
        return Result.success(record);
    }

    // ── 会话级生命周期 ──

    begin_session(task_id: string): Result {
        const existing = this._sessions.get(task_id) ?? null;
        if (existing !== null) {
            return Result.success({ ...existing.summary(), "created": false });
        }
        if (this._sessions.size >= MAX_SESSIONS) {
            return Result.failure(
                `too many live browser sessions (${MAX_SESSIONS}); end one before beginning another`);
        }
        const session = new BrowserSession(`${this.session_id}-${task_id}`, task_id);
        this._sessions.set(task_id, session);
        this._log("session_begin", task_id);
        return Result.success({ ...session.summary(), "created": true });
    }

    async end_session(task_id: string): Promise<Result> {
        const session = this._sessions.get(task_id) ?? null;
        if (session === null) {
            return Result.failure(`no active browser session for task '${task_id}'`);
        }
        let closed = 0;
        const errors: string[] = [];
        for (const record of session.live_tabs()) {
            const br = await this._call("tab_close", { "tab_id": record.tab_id });
            if (br.ok) {
                closed += 1;
            } else {
                errors.push(`${pyStr(record.tab_id)}: ${br.error}`);
            }
        }
        this._sessions.delete(task_id);
        this._snapshots.delete(task_id);
        this._log("session_end", task_id, null, `closed=${closed} errors=${errors.length}`);
        return Result.success({ "closed": closed, "bridge_errors": errors });
    }

    /** 刷新会话及当前焦点标签的活跃时间戳。 */
    touch(task_id: string, now: number | null = null): void {
        const session = this._sessions.get(task_id) ?? null;
        if (session !== null) session.touch(now);
    }

    /** 标记活跃 Run，防止被空闲收割。 */
    mark_run_active(task_id: string, duration_s = 300.0, now: number | null = null): void {
        const session = this._sessions.get(task_id) ?? null;
        if (session !== null) session.mark_run_active(duration_s, now);
    }

    /** 任务切换走人：先拍快照（纯事实），再把所有 active 标签挂起省内存。 */
    async suspend_session(task_id: string): Promise<Result> {
        const session = this._sessions.get(task_id) ?? null;
        if (session === null) {
            return Result.failure(`no active browser session for task '${task_id}'`);
        }
        const snap = session.snapshot_state();
        this._snapshots.set(task_id, snap);
        let suspended = 0;
        const errors: string[] = [];
        for (const record of [...session.live_tabs()]) {
            if (record.state !== TAB_ACTIVE) continue;
            const br = await this._call("tab_suspend", { "tab_id": record.tab_id });
            if (br.ok) {
                session.suspend_tab(record.tab_id);
                suspended += 1;
            } else {
                errors.push(`${pyStr(record.tab_id)}: ${br.error}`);
            }
        }
        this._log("session_suspend", task_id, null, `suspended=${suspended}`);
        return Result.success({
            "suspended": suspended,
            "snapshot_tabs": (snap["tabs"] as unknown[]).length,
            "active_tab_id": session.active_tab_id,
            "bridge_errors": errors,
        });
    }

    /** 任务切回来：TS 先恢复权威状态，再驱动 Electron 收敛到同一事实。 */
    async resume_session(task_id: string): Promise<Result> {
        const session = this._sessions.get(task_id) ?? null;
        if (session === null) {
            return Result.failure(`no active browser session for task '${task_id}'`);
        }
        const snap = this._snapshots.get(task_id) ?? null;
        this._snapshots.delete(task_id);
        if (!pyTruth(snap)) {
            return Result.failure(
                `no saved state to restore for task '${task_id}' (suspend it first)`);
        }
        const restored = session.restore_state(snap);
        if (!restored.ok) return restored;
        const errors: string[] = [];
        for (const raw of (snap as JsonDict)["tabs"] as JsonDict[]) {
            const endpoint = dictGet(raw, "state") === TAB_ACTIVE ? "tab_resume" : "tab_suspend";
            const br = await this._call(endpoint, { "tab_id": raw["tab_id"] });
            if (!br.ok) {
                errors.push(`${pyStr(raw["tab_id"])}: ${br.error}`);
            }
        }
        const focus = session.active_tab_id;
        if (pyTruth(focus)) {
            const br = await this._call("tab_activate", { "tab_id": focus });
            if (!br.ok) {
                errors.push(`focus ${pyStr(focus)}: ${br.error}`);
            }
        }
        const rv = restored.value as JsonDict;
        this._log("session_resume", task_id, null, `tabs=${pyStr(rv["restored_tabs"])}`);
        return Result.success({
            "restored_tabs": rv["restored_tabs"],
            "active_tab_id": focus,
            "bridge_errors": errors,
        });
    }

    /** 任务切换的一站式入口：挂起旧任务 → 恢复（或新建）新任务。 */
    async switch_task(from_task: string, to_task: string): Promise<Result> {
        const notes: JsonDict = {};
        if ((this._sessions.get(from_task) ?? null) !== null) {
            const r = await this.suspend_session(from_task);
            if (!r.ok) return r;
            notes["from"] = r.value;
        }
        if (to_task === from_task) {
            // 切回自己＝纯恢复
            if (this._snapshots.has(to_task)) {
                const r = await this.resume_session(to_task);
                if (!r.ok) return r;
                notes["to"] = r.value;
            }
            return Result.success(notes);
        }
        const begun = this.begin_session(to_task);
        if (!begun.ok) return begun;
        if (this._snapshots.has(to_task)) {
            const r = await this.resume_session(to_task);
            if (!r.ok) return r;
            notes["to"] = r.value;
        } else {
            notes["to"] = { "created": true, "active_tab_id": null };
        }
        return Result.success(notes);
    }

    // ── 标签级操作（校验 → 桥 → 提交）──

    async open_tab(task_id: string, url: unknown = "", focus = true, visible: unknown = true): Promise<Result> {
        const session_r = this._session_for(task_id);
        if (!session_r.ok) return session_r;
        const session = session_r.value as BrowserSession;
        const tab_id = this._id_factory();
        const br = await this._call("tab_open", {
            "tab_id": tab_id, "url": pyOr(url, ""), "visible": pyTruth(visible),
        });
        if (!br.ok) return br;
        const info: JsonDict = (br.value !== null && typeof br.value === "object" && !Array.isArray(br.value))
            ? (br.value as JsonDict) : {};
        const committed = session.open_tab(
            tab_id, pyStr(pyOr(dictGet(info, "url"), pyOr(url, ""))),
            pyStr(pyOr(dictGet(info, "title"), "")), focus);
        if (!committed.ok) return committed;
        this._log("tab_open", task_id, tab_id);
        return Result.success(committed.value);
    }

    /** 导航 = 会话内事实变更。会话还没有在世标签时顺手开第一个。 */
    async navigate_tab(task_id: string, url: unknown, tab_id: unknown = null,
                       visible: unknown = true): Promise<Result> {
        const session_r = this._session_for(task_id);
        if (!session_r.ok) return session_r;
        const session = session_r.value as BrowserSession;
        const target = pyOr(tab_id, session.active_tab_id);
        if (pyTruth(target)) {
            const record = session.get_tab(target);
            if (record === null) {
                return Result.failure(
                    `unknown tab '${pyStr(target)}' in task '${task_id}' ` +
                    "(tabs are private to their task's session)");
            }
            if (record.state === TAB_CLOSED) {
                return Result.failure(`tab '${pyStr(target)}' is closed`);
            }
            const br = await this._call("navigate", {
                "url": url, "visible": pyTruth(visible), "tab_id": target,
            });
            if (!br.ok) return br;
            const info: JsonDict = (br.value !== null && typeof br.value === "object" && !Array.isArray(br.value))
                ? (br.value as JsonDict) : {};
            const committed = session.note_navigation(target, url, pyStr(pyOr(dictGet(info, "title"), "")));
            if (!committed.ok) return committed;
            this._log("navigate", task_id, target);
            return Result.success({ ...(committed.value as JsonDict), "opened": false });
        }
        // 第一个标签：一次 tab_open 完成"建实体 + 加载"
        return await this.open_tab(task_id, url, true, visible);
    }

    async activate_tab(task_id: string, tab_id: unknown): Promise<Result> {
        const session_r = this._session_for(task_id, false);
        if (!session_r.ok) return session_r;
        const session = session_r.value as BrowserSession;
        // 只读预检（unknown/closed），避免对坏请求打桥；状态变更留给桥成功后的提交
        const record = session.get_tab(tab_id);
        if (record === null) {
            return Result.failure(
                `unknown tab '${pyStr(tab_id)}' in task '${task_id}' ` +
                "(tabs are private to their task's session)");
        }
        if (record.state === TAB_CLOSED) {
            return Result.failure(`tab '${pyStr(tab_id)}' is closed and cannot be activated`);
        }
        const br = await this._call("tab_activate", { "tab_id": tab_id });
        if (!br.ok) return br;
        const committed = session.activate_tab(tab_id);
        if (!committed.ok) return committed;
        this._log("tab_activate", task_id, tab_id);
        return committed;
    }

    async close_tab(task_id: string, tab_id: unknown): Promise<Result> {
        const session_r = this._session_for(task_id, false);
        if (!session_r.ok) return session_r;
        const session = session_r.value as BrowserSession;
        const record = session.get_tab(tab_id);
        if (record === null) {
            return Result.failure(
                `unknown tab '${pyStr(tab_id)}' in task '${task_id}' ` +
                "(tabs are private to their task's session)");
        }
        if (record.state === TAB_CLOSED) {
            return Result.failure(`tab '${pyStr(tab_id)}' is already closed`);
        }
        const br = await this._call("tab_close", { "tab_id": tab_id });
        if (!br.ok) return br;
        const committed = session.close_tab(tab_id);
        if (!committed.ok) return committed;
        this._log("tab_close", task_id, tab_id);
        return committed;
    }

    async suspend_tab(task_id: string, tab_id: unknown): Promise<Result> {
        const session_r = this._session_for(task_id, false);
        if (!session_r.ok) return session_r;
        const session = session_r.value as BrowserSession;
        const record = session.get_tab(tab_id);
        if (record === null) {
            return Result.failure(
                `unknown tab '${pyStr(tab_id)}' in task '${task_id}' ` +
                "(tabs are private to their task's session)");
        }
        if (record.state !== TAB_ACTIVE) {
            return Result.failure(
                `tab '${pyStr(tab_id)}' cannot be suspended from state '${pyStr(record.state)}'`);
        }
        const br = await this._call("tab_suspend", { "tab_id": tab_id });
        if (!br.ok) return br;
        const committed = session.suspend_tab(tab_id);
        if (!committed.ok) return committed;
        const new_focus = dictGet(committed.value, "new_focus");
        // 挂起的是焦点标签时，把窗口交给最近的其他在世标签（有就展示）
        if (pyTruth(new_focus)) {
            const fr = await this._call("tab_activate", { "tab_id": new_focus });
            if (fr.ok) session.activate_tab(new_focus);
        }
        this._log("tab_suspend", task_id, tab_id);
        return committed;
    }

    async resume_tab(task_id: string, tab_id: unknown): Promise<Result> {
        const session_r = this._session_for(task_id, false);
        if (!session_r.ok) return session_r;
        const session = session_r.value as BrowserSession;
        const record = session.get_tab(tab_id);
        if (record === null) {
            return Result.failure(
                `unknown tab '${pyStr(tab_id)}' in task '${task_id}' ` +
                "(tabs are private to their task's session)");
        }
        if (record.state !== TAB_SUSPENDED) {
            return Result.failure(
                `tab '${pyStr(tab_id)}' cannot be resumed from state '${pyStr(record.state)}'`);
        }
        const br = await this._call("tab_resume", { "tab_id": tab_id });
        if (!br.ok) return br;
        const committed = session.resume_tab(tab_id);
        if (!committed.ok) return committed;
        // 恢复后若会话没有有效焦点（窗口空着），顺手把舞台交给它
        const at = session.active_tab_id;
        if (at === null || at === undefined || session.get_tab(at) === null ||
            (session.get_tab(at) as TabRecord).state === TAB_SUSPENDED) {
            const fr = await this._call("tab_activate", { "tab_id": tab_id });
            if (fr.ok) session.activate_tab(tab_id);
        }
        this._log("tab_resume", task_id, tab_id);
        return committed;
    }

    // ── 视口（每标签独立，挂起/恢复后由 Electron 依据其标签记录重现）──

    async set_viewport(task_id: string, width: unknown, height: unknown,
                       tab_id: unknown = null): Promise<Result> {
        const session_r = this._session_for(task_id);
        if (!session_r.ok) return session_r;
        const session = session_r.value as BrowserSession;
        const target_r = this._resolve_tab(session, tab_id);
        if (!target_r.ok) return target_r;
        const target = (target_r.value as TabRecord).tab_id;
        const precheck = session.set_viewport(target, width, height);
        if (!precheck.ok) return precheck;
        const pv = dictGet(dictGet(precheck.value, "viewport"), "width");
        const ph = dictGet(dictGet(precheck.value, "viewport"), "height");
        const br = await this._call("viewport", {
            "tab_id": target,
            "width": pv,
            "height": ph,
        });
        if (!br.ok) {
            // 桥失败不提交：两侧不漂移
            session.reset_viewport(target);
            return br;
        }
        this._log("viewport_set", task_id, target, `${pyStr(pv)}x${pyStr(ph)}`);
        return precheck;
    }

    async reset_viewport(task_id: string, tab_id: unknown = null): Promise<Result> {
        const session_r = this._session_for(task_id);
        if (!session_r.ok) return session_r;
        const session = session_r.value as BrowserSession;
        const target_r = this._resolve_tab(session, tab_id);
        if (!target_r.ok) return target_r;
        const target = (target_r.value as TabRecord).tab_id;
        const br = await this._call("viewport", { "tab_id": target, "reset": true });
        if (!br.ok) return br;
        const committed = session.reset_viewport(target);
        if (!committed.ok) return committed;
        this._log("viewport_reset", task_id, target);
        return committed;
    }

    // ── 查询 / 截图 ──

    list_tabs(task_id: string): Result {
        const session_r = this._session_for(task_id, false);
        if (!session_r.ok) return session_r;
        return Result.success((session_r.value as BrowserSession).summary());
    }

    session_state(task_id: string): Result {
        const session_r = this._session_for(task_id, false);
        if (!session_r.ok) return session_r;
        const snap = this._snapshots.get(task_id) ?? null;
        return Result.success({ ...(session_r.value as BrowserSession).summary(),
                                "has_saved_snapshot": snap !== null });
    }

    /**
     * 截取一个标签的画面（截图就绪接口：供 CUA 动作层未来复用）。
     *
     * 返回 value 形状 {"path", "width", "height", "tab_id", "session_id"}，
     * 与 cua_actions 桌面后端的截图结果同族，方便那侧以后直接调用。
     * 挂起标签由 Electron 侧唤醒后拍摄（ detachment 期间不产像素）。
     */
    async capture_tab(task_id: string, tab_id: unknown = null,
                      save_path: string | null = null): Promise<Result> {
        const session_r = this._session_for(task_id, false);
        if (!session_r.ok) return session_r;
        const session = session_r.value as BrowserSession;
        const target_r = this._resolve_tab(session, tab_id);
        if (!target_r.ok) return target_r;
        const target = (target_r.value as TabRecord).tab_id;
        const br = await this._call("tab_snapshot", { "tab_id": target }, 60);
        if (!br.ok) return br;
        const info: JsonDict = (br.value !== null && typeof br.value === "object" && !Array.isArray(br.value))
            ? (br.value as JsonDict) : {};
        const data_uri = pyStr(pyOr(dictGet(info, "dataUri"), ""));
        if (!pyTruth(data_uri)) {
            return Result.failure(`tab '${pyStr(target)}' returned no image payload`);
        }
        if (!pyTruth(save_path)) {
            const base_dir = pyOr(this.workspace, SESSION_SEAMS.tempdir());
            save_path = path.join(base_dir as string, "screenshots",
                                  `tab_${pyStr(target)}_${Math.trunc(SESSION_SEAMS.now())}.png`);
        }
        const saved = saveDataUri(data_uri, save_path as string);
        if (!saved.ok) return saved;
        const shot = session.get_tab(target);
        if (shot !== null && shot.state === TAB_SUSPENDED) {
            // Electron 为拍摄唤醒了它——两侧对齐成 active + 焦点
            session.activate_tab(target);
        }
        this._log("tab_snapshot", task_id, target, pyStr(saved.value));
        return Result.success({
            "path": saved.value,
            "width": dictGet(info, "width"),
            "height": dictGet(info, "height"),
            "tab_id": target,
            "session_id": session.session_id,
        });
    }

    /**
     * 编排层认领: 门槛（会话存在 + 归属）在此，比对与接管下放会话。（python
     * 侧 monkey-patch 挂类；此处直接进类体。）
     *
     * - auto_begin=false: 认领不偷偷建会话——无会话的任务得到既有的
     *   "no active browser session" 失败，而不是凭空冒出一个空会话；
     * - is_owned: 标签私有于其任务会话，别家任务的标签（或幽灵 id）一律拒绝，
     *   且此路径不产生任何桥调用（对方会话零波及）；
     * - 认领只提交 TS 侧焦点/唤醒事实，桥零调用；Electron 侧的实际聚焦由
     *   编排层（browser_agent）随后用既有 tab_activate 收敛，分工与
     *   restore_state 同理。
     */
    claim_tab(task_id: string, claim: unknown): Result {
        const session_r = this._session_for(task_id, false);
        if (!session_r.ok) return session_r;
        const session = session_r.value as BrowserSession;
        if (!session.is_owned(getAttrOr(claim, "object_id"))) {
            return Result.failure("认领失败: 标签不属于当前任务会话");
        }
        const claimed = session.claim_tab(claim);
        if (claimed.ok) this._log("claim_tab", task_id, getAttrOr(claim, "object_id"));
        return claimed;
    }

    /** app 域认领桩: 接口已预留，实现随远程执行体系另行落地。 */
    claim_app_window(task_id: string, claim: unknown): Result {
        return Result.failure("认领失败: app 窗口认领接口已预留，实现随远程执行体系另行落地");
    }
}

/** getattr(claim, "object_id", None) — never raises, folds to None. */
function getAttrOr(obj: unknown, name: string): unknown {
    if (obj !== null && typeof obj === "object" && name in (obj as JsonDict)) {
        return (obj as JsonDict)[name];
    }
    return null;
}

// Exported for the parity probe, mirroring how the python probe reaches the
// module-private `bs._save_data_uri`.
export function saveDataUri(data_uri: string, savePath: string): Result {
    try {
        // str.partition(","): everything after the FIRST comma; absent -> ""
        const comma = data_uri.indexOf(",");
        const b64 = comma === -1 ? "" : data_uri.slice(comma + 1);
        if (!pyTruth(b64)) {
            return Result.failure("screenshot data uri has no payload");
        }
        const raw = pyB64decode(b64);
        const parent = path.dirname(savePath);
        if (pyTruth(parent)) {
            fs.mkdirSync(parent, { recursive: true });
        }
        fs.writeFileSync(savePath, raw);
        return Result.success(savePath);
    } catch (e) {
        // DIVERGENCE(port): str(e) texts of OS write failures differ between
        // CPython and Node (ENOENT formatting); the reachable pinned paths are
        // the payload/decode branches, exercised by the probe.
        const err = e as Error;
        return Result.failure(`failed to save screenshot: ${err.message ?? String(e)}`);
    }
}

// ═══ 认领协议（「提及即引用」，fail-closed）═══
//
// 用户话语里提到的既有对象不是一段描述，而是一张引用凭据: Agent 接管（聚焦/
// 操作）前必须出示提及当时记下的快照，与现状逐一全等比对，任一不符即拒绝——
// 绝不静默接管"长得差不多"的对象。比对是原始全等（==）: 无相似度、无 url
// 前缀豁免、不归一化空白与大小写；宁可请用户重新引用一次，也不替用户做主。

/**
 * 标签认领凭据——「提及即引用」的载体。
 *
 * 用户提及某个既有标签时，Agent 当场记下 (object_id, 标题, url) 快照；
 * 接管前用 claim_tab 把快照与标签现状逐一全等比对。claimed_at_ms 由认领
 * 成功时自动回填（失败绝不盖章），可当作"该引用仍然有效"的凭据。
 */
export class TabClaim {
    object_id: unknown;          // 提及的标签号（会话内私有 id）
    title_snapshot: unknown;     // 提及时的标题快照
    url_snapshot: unknown;       // 提及时的 url 快照
    kind: unknown;               // 对象类别；tab 域认领恒为 "tab"
    claimed_at_ms: unknown;      // 成功认领的毫秒时间戳；仅成功时盖章

    constructor(object_id: unknown, title_snapshot: unknown = "",
                url_snapshot: unknown = "", kind: unknown = "tab",
                claimed_at_ms: unknown = 0) {
        this.object_id = object_id;
        this.title_snapshot = title_snapshot;
        this.url_snapshot = url_snapshot;
        this.kind = kind;
        this.claimed_at_ms = claimed_at_ms;
    }
}

/**
 * 应用窗口认领凭据（app 域预留）: (窗口标题, 进程号, 启动时间) 三元组。
 *
 * 与 TabClaim 同一协议思想——提及即引用、快照比对、fail-closed；实现随
 * 远程执行体系另行落地，此处先固定凭据形状供工具层预留参数。
 */
export class AppClaim {
    window_title: unknown;
    process_id: unknown;
    started_at_ms: unknown;

    constructor(window_title: unknown = "", process_id: unknown = 0,
                started_at_ms: unknown = 0) {
        this.window_title = window_title;
        this.process_id = process_id;
        this.started_at_ms = started_at_ms;
    }
}

// ── 共享单例（无 agent 上下文时的兜底；BrowserAgent 自持实例并注入其桥客户端）──

let _sharedManager: BrowserSessionManager | null = null;

export function get_shared_session_manager(workspace: string | null = null,
                                           client: BridgeClient | null = null): BrowserSessionManager {
    if (_sharedManager === null) {
        _sharedManager = new BrowserSessionManager({ workspace, client });
    }
    return _sharedManager;
}
