/**
 * bot_remote.ts — Bot remote control architecture.
 *
 * Ported from `app/backend/bot_remote.py` (515 lines, wave-5 TS).
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/bot_remote.py -> app/engine/bot_remote.ts.
 *   §2  present-but-null: every `state.get(k, d)` is dictGet (a key present
 *       with a null value yields null, not the default); a non-dict state
 *       raises AttributeErrorP with the exact CPython text. `load_allowed_users`
 *       keeps the source's `or {}` falsy gate (get_bot_state may return
 *       None/""/0 — all fold to a fresh {}); the other two loaders do NOT and
 *       crash on a falsy stored value exactly where the source does.
 *   §2  `if not session_id:` gates on TRUTHINESS, not nullness — a stored
 *       empty-string session is regenerated (pyTruth, never `??`).
 *       `elif self._llm_callback` likewise (a set-but-falsy callback falls to
 *       the no-handler branch).
 *   §2  `cmd = content.strip().split()[0].lower() if content.strip() else ""`:
 *       pyStrip/pySplitWhitespace mirror the CPython whitespace set
 *       (incl. \x1c-\x1f/\x85/\xa0/Unicode spaces) and the drop-empty-fields
 *       behaviour of arg-less split; the guard makes [0] IndexError
 *       unreachable, mirrored by the empty-stripped branch.
 *   §2  `tool_name not in denylist` / membership: pyIn works on lists
 *       (identity-by-value) AND strings (substring) — a stored
 *       tool_denylist that is a str makes "b" in "abc" succeed; kept.
 *   §2  `state.get("tool_denylist", self.DEFAULT_DENYLIST)` hands out the
 *       SHARED class list (a caller mutating it mutates the default) —
 *       bug-for-bug the same reference is returned.
 *   §2  `[str(u) for u in state.get("allowed_users", [])]` iterates whatever
 *       is stored: list -> items, str -> characters, dict -> keys, anything
 *       else raises "'int' object is not iterable" (pyIter/pyLen pyTypeName
 *       spellings).
 *   §2  audit ordering in send_message: the outbound DB row is written on ALL
 *       three failure paths (no provider / transport raise / falsy delivered)
 *       and the raise path reports `{platform} delivery failed: {exc}` with
 *       str(exc) semantics (message only, no type prefix).
 *   §2  is_workspace_allowed: realpath(abspath(...)) with the CPython error
 *       contract — TypeError (non-str) ESCAPES the (OSError, ValueError)
 *       catch, embedded nul bytes become ValueError -> deny/false, and
 *       `base.rstrip(os.sep) + os.sep` re-strips ALL trailing separators
 *       (a bare "C:\\root\\" allow-root matching "C:\\root\\x" while
 *       "/allowed" never matches "/allowed-other").
 *   §2  start() one-provider-fails-never-blocks; stop() discards from
 *       _listening even when stop_listening raises; provider_status builds a
 *       throwaway get_provider() instance for unregistered platforms and
 *       swallows ANY provider-construction exception into None (is_configured
 *       failures fold to False, and a raise from load_allowed_users escapes —
 *       the source has no guard there either).
 *   §2  BotRemote.register_handler stores the RAW command in its own shadow
 *       dict while the controller lower-cases — the source's asymmetry, kept
 *       (the shadow dict is never read by any enforcement path; the facade
 *       itself is documented "read-only message-log" surface).
 *
 * MIGRATION DECISIONS / DIVERGENCES (documented dispositions)
 *   telemetry: `get_telemetry`/`SpanName` start_span/add_event/set_error/
 *       end_span are deleted here exactly per the HANDOFF §8.3 disposition
 *       for the DELETE-flagged telemetry.py unit ("依赖方直接删调用") — they
 *       were purely observational; every surrounding statement (audit rows,
 *       Result texts, the deny branch) is byte-identical. Same precedent as
 *       memory_layer.ts / app_agent.ts / file_agent.ts.
 *   DIVERGENCE(port, async bridge): providers/index.ts get_provider is async
 *       (dynamic import cannot be sync, precedent logged there), so
 *       provider_status becomes `async provider_status()` returning the same
 *       list the sync python builds. Call sites are gateway/UI code that
 *       already lives in async land; field values and order are identical.
 *       provider_status reads the registry through PROVIDER_SEAMS so the
 *       parity probe can fake both sides identically (python fakes
 *       sys.modules['providers']; production defaults are the real fns).
 *   DIVERGENCE(port, await emulation): python `await x` on a non-awaitable
 *       raises "TypeError: object T can't be used in 'await' expression"
 *       (3.13 spelling, probe-pinned) while JS `await x` passes through.
 *       awaitPy() reproduces the python
 *       error for handler / llm_callback / provider-method results, so the
 *       catch-all branches report the same failure texts as the source.
 *   DIVERGENCE(port, dict key order): start()'s report object is a JS object;
 *       a platform id that is a canonical-numeric string would sort first
 *       instead of keeping insertion order. Unreachable: _REGISTRY holds six
 *       alphabetic ids and add_provider keys come from get_platform_id() of
 *       those providers. Pinned by probe with insertion order exercised.
 *   DIVERGENCE(port): str.lower() full-Unicode mapping matches CPython for
 *       every BMP input exercised by the probe; exotic sigma/İ behaviour is
 *       the same engine-agnostic table on both platforms in practice.
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { Result } from "./result.js";
import { get_storage } from "./storage.js";
import { osPathAbspath } from "./app_agent.js";
import { available_providers, get_provider, IMProvider } from "./providers/index.js";

type JsonDict = Record<string, unknown>;

// Test seam (same pattern as native_desktop's _set_os_recorder): the probe
// pins uuid4/time so the two sides see identical message ids and timestamps.
export const BOT_SEAMS = {
    uuid4: (): string => randomUUID(),
    now: (): number => Date.now() / 1000,
};

// Second seam: provider_status() consults these instead of importing the
// providers package directly, so the parity probe can drive both sides with
// identical fake registries (python fakes sys.modules['providers']). Defaults
// are the real implementations.
export const PROVIDER_SEAMS: {
    available_providers: () => string[];
    get_provider: (platform: unknown) => Promise<unknown>;
} = {
    available_providers,
    get_provider: (p: unknown) => get_provider(p),
};

// ---------------------------------------------------------------------------
// python-semantics helpers (house style: file_agent.ts / app_agent.ts)
// ---------------------------------------------------------------------------

class AttributeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "AttributeError"; }
}
class TypeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "TypeError"; }
}
class ValueErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ValueError"; }
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

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (v instanceof Map) return "dict";
    return "dict";
}

function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") {
        if (Number.isNaN(v)) return "nan";
        if (v === Infinity) return "inf";
        if (v === -Infinity) return "-inf";
        return String(v);
    }
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return "[" + v.map(pyStrRepr).join(", ") + "]";
    return "{}";
}

/** repr() inside list str() — strings quote, numbers do not. */
function pyStrRepr(v: unknown): string {
    if (typeof v === "string") return "'" + v.replace(/'/g, "\\'") + "'";
    return pyStr(v);
}

/** str(exception) — message only, no type prefix, matching CPython. */
function pyStrExc(e: unknown): string {
    if (e instanceof Error) return e.message;
    return pyStr(e);
}

function isPyDict(v: unknown): v is JsonDict {
    return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Map);
}

/** `d.get(k, dflt)` with CPython semantics: non-dict raises AttributeError;
 *  a PRESENT null returns null (never folds to the default). */
function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
    if (obj instanceof Map) {
        return obj.has(key) ? obj.get(key) : dflt;
    }
    if (isPyDict(obj)) {
        return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as JsonDict)[key] : dflt;
    }
    throw new AttributeErrorP(
        `'${pyTypeName(obj)}' object has no attribute 'get'`);
}

/** `x or y` with python truthiness (returns the ORIGINAL object when truthy). */
function pyOr(v: unknown, dflt: unknown): unknown {
    return pyTruth(v) ? v : dflt;
}

/** `for u in x:` — list items / str characters / dict keys; else TypeError. */
function pyIter(x: unknown): unknown[] {
    if (Array.isArray(x)) return x;
    if (typeof x === "string") return [...x];
    if (x instanceof Map) return [...x.keys()];
    if (isPyDict(x)) return Object.keys(x);
    throw new TypeErrorP(`'${pyTypeName(x)}' object is not iterable`);
}

/** `item in seq` for list (value equality) and str (substring). */
function pyIn(seq: unknown, item: unknown): boolean {
    if (typeof seq === "string") {
        if (typeof item !== "string") {
            throw new TypeErrorP(
                `'in <string>' requires string as left operand, not ${pyTypeName(item)}`);
        }
        return seq.includes(item);
    }
    if (Array.isArray(seq)) return seq.some((v) => pyEq(v, item));
    if (seq instanceof Map) return seq.has(item as string);
    if (isPyDict(seq)) return Object.prototype.hasOwnProperty.call(seq, item as string);
    throw new TypeErrorP(`argument of type '${pyTypeName(seq)}' is not iterable`);
}

function pyEq(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
    }
    return false;
}

// CPython str.strip()/split() whitespace set (probe-pinned on this machine:
// \x1c-\x1f IN, \u200b OUT).
const PY_WS = "\\t\\n\\v\\f\\r\\x1c\\x1d\\x1e\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_WS_RE = new RegExp(`[${PY_WS}]`, "g");
const PY_WS_RUN_RE = new RegExp(`[${PY_WS}]+`);

function pyStrip(s: string): string {
    return s.replace(new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g"), "");
}

/** `str.rstrip(chars)` for the single-char sep case. */
function pyRstripChars(s: string, chars: string): string {
    let end = s.length;
    while (end > 0 && chars.includes(s[end - 1] ?? "")) end -= 1;
    return s.slice(0, end);
}

/** `s.split()` — arg-less whitespace split, no empty fields. */
function pySplitWs(s: string): string[] {
    const t = pyStrip(s);
    if (t === "") return [];
    return t.split(PY_WS_RUN_RE);
}

/** python `await value` on a non-awaitable raises the CPython TypeError. */
function isThenable(v: unknown): v is PromiseLike<unknown> {
    return v !== null && (typeof v === "object" || typeof v === "function")
        && typeof (v as { then?: unknown }).then === "function";
}

async function awaitPy(v: unknown): Promise<unknown> {
    if (isThenable(v)) return await v;
    // CPython 3.13 spelling, probe-pinned: "object dict can't be used in
    // 'await' expression" (older CPython said "can not"; canonical is 3.13).
    throw new TypeErrorP(`object ${pyTypeName(v)} can't be used in 'await' expression`);
}

/** `obj.cls_name` for CPython AttributeError texts. */
function pyClassName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    const ctor = (v as { constructor?: { name?: string } }).constructor;
    if (v === true || v === false) return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (typeof v === "string") return "str";
    return (ctor && ctor.name) ? ctor.name : pyTypeName(v);
}

/** `obj.name` attribute access: a miss raises the CPython AttributeError. */
function pyGetAttr(obj: unknown, name: string): unknown {
    const v = (obj as Record<string, unknown>)[name];
    if (v === undefined) {
        throw new AttributeErrorP(
            `'${pyClassName(obj)}' object has no attribute '${name}'`);
    }
    return v;
}

/** `f(...)` with the CPython not-callable TypeError. */
function pyCall(f: unknown, args: unknown[]): unknown {
    if (typeof f !== "function") {
        throw new TypeErrorP(`'${pyTypeName(f)}' object is not callable`);
    }
    return (f as (...a: unknown[]) => unknown)(...args);
}

/** `obj.f(...)` with `this` bound to obj — python hands out BOUND methods, so
 *  `provider.get_platform_id()` runs with provider as self. Detaching the
 *  function first (pyCall(pyGetAttr(...))) loses that and crashes class
 *  methods on `this` — probe-pinned (s02). A non-callable attribute still
 *  raises the not-callable TypeError through pyCall. */
function pyCallMethod(obj: unknown, name: string, args: unknown[]): unknown {
    const v = pyGetAttr(obj, name);
    if (typeof v !== "function") {
        return pyCall(v, args);
    }
    return (v as (...a: unknown[]) => unknown).apply(obj as object, args);
}

/** `obj.m(...)` then python-`await` the result (providers/handlers). */
async function pyCallAwait(obj: unknown, name: string, args: unknown[]): Promise<unknown> {
    return await awaitPy(pyCallMethod(obj, name, args));
}

const OS_SEP = path.sep; // "\\" on this (win32) host, same as ntpath.sep

/** Non-strict os.path.realpath for paths that may not exist: resolve the
 *  longest existing prefix, append the remainder (path_guard.ts precedent).
 *  nul bytes raise ValueError("embedded null byte") like CPython's win32
 *  call surface; other os errors propagate as OSError-shaped errors. */
function osPathRealpath(p: unknown): string {
    if (typeof p !== "string") {
        throw new TypeErrorP(
            "expected str, bytes or os.PathLike object, not " + pyTypeName(p));
    }
    if (p.includes("\0")) {
        throw new ValueErrorP("embedded null byte");
    }
    let cur = p;
    const tail: string[] = [];
    for (;;) {
        try {
            // Existing prefix resolved by the OS (probe-pinned: components
            // are supplied in on-disk case, so the recase is a no-op here);
            // the missing remainder is appended verbatim like CPython does.
            const base = fs.realpathSync.native(cur);
            return tail.length ? path.join(base, ...tail) : base;
        } catch (e) {
            const code = (e as { code?: string }).code;
            if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EPERM") {
                throw e; // surfaces as an OSError-equivalent below
            }
            const parent = path.dirname(cur);
            if (parent === cur) {
                // Nothing exists at all (root missing): CPython falls back
                // to a normalized join against cwd.
                return osPathAbspath(tail.length ? path.join(cur, ...tail) : cur);
            }
            tail.unshift(path.basename(cur));
            cur = parent;
        }
    }
}

/** `os.path.realpath(os.path.abspath(x))` — errors mapped to python names. */
function realpathAbspath(p: unknown): string {
    if (typeof p !== "string") {
        // Canonical text (3.13-probe-pinned): ntpath.abspath raises this
        // TypeError BEFORE realpath ever runs, and it escapes the
        // (OSError, ValueError) catch arms of is_workspace_allowed.
        throw new TypeErrorP(
            "_path_normpath: path should be string, bytes or os.PathLike, not "
            + pyTypeName(p));
    }
    return osPathRealpath(osPathAbspath(p));
}

// ---------------------------------------------------------------------------
// platform / message data classes
// ---------------------------------------------------------------------------

export class BotPlatform {
    static readonly TELEGRAM = "telegram";
    static readonly FEISHU = "feishu";
    static readonly WECHAT = "wechat";
}

export class BotMessage {
    id: string;
    platform: string;
    user_id: string;
    content: string;
    timestamp: number;

    constructor(platform: string, user_id: string, content: string) {
        this.id = BOT_SEAMS.uuid4();
        this.platform = platform;
        this.user_id = user_id;
        this.content = content;
        this.timestamp = BOT_SEAMS.now();
    }

    /** Serialize to dict for storage; direction is 'inbound' or 'outbound'. */
    to_dict(direction = "inbound"): JsonDict {
        return {
            "id": this.id,
            "platform": this.platform,
            "user_id": this.user_id,
            "content": this.content,
            "direction": direction,
            "timestamp": this.timestamp,
        };
    }
}

// ---------------------------------------------------------------------------
// storage surface used by this module
// ---------------------------------------------------------------------------

interface BotStorage {
    create_session(session_id: string, title: string): unknown;
    add_bot_message(msg: JsonDict): void;
    get_bot_state(key: string, defaultValue?: unknown): unknown;
    add_bot_audit(
        platform: string, user_id: string, session_id: string, tool_name: string,
        action: string, blocked: boolean, reason: string): void;
    get_bot_messages(platform: string, user_id: string, limit: number): JsonDict[];
}

// ---------------------------------------------------------------------------
// BotController
// ---------------------------------------------------------------------------

export class BotController {
    static DEFAULT_DENYLIST: unknown[] = [
        "shell_executor",
        "process_kill",
        "app_install",
        "git_push",
        "bash",
    ];

    storage: BotStorage;
    private _handlers = new Map<string, (...args: unknown[]) => unknown>();
    private _sessions = new Map<string, string>();
    /** platform id -> IMProvider. Keyed so send/webhook can look one up. */
    private _providers = new Map<string, IMProvider>();
    /** platforms whose listener started successfully, for the status UI. */
    private _listening = new Set<string>();
    private _llm_callback: ((...args: unknown[]) => unknown) | null = null;

    constructor() {
        this.storage = get_storage() as unknown as BotStorage;
    }

    register_handler(command: string, handler: (...args: unknown[]) => unknown): void {
        this._handlers.set(command.toLowerCase(), handler);
    }

    set_llm_callback(callback: (...args: unknown[]) => unknown): void {
        this._llm_callback = callback;
    }

    /** Handle an incoming message from a remote platform.
     *
     *  Fail-closed user allow-list check first: without it any user who
     *  discovers the bot token could drive the machine. */
    async handle_message(platform: string, user_id: string, content: string): Promise<Result> {
        try {
            if (!this.is_user_allowed(platform, user_id)) {
                this.audit_operation(
                    platform, user_id, "", "handle_message",
                    "deny_user", true,
                    "user not in allowed_users",
                );
                return Result.failure(
                    "Not authorized. Ask the workstation owner to add your ID to allowed_users."
                );
            }

            const sessionKey = `${platform}:${user_id}`;
            let sessionId = this._sessions.get(sessionKey);
            if (!pyTruth(sessionId)) {
                sessionId = BOT_SEAMS.uuid4();
                this._sessions.set(sessionKey, sessionId);
                this.storage.create_session(sessionId, `Remote: ${platform}:${user_id}`);
            }

            const msg = new BotMessage(platform, user_id, content);
            this.storage.add_bot_message(msg.to_dict("inbound"));

            // py: content.strip().split()[0].lower() if content.strip() else ""
            // — the strip-guard makes the split non-empty, [0] always exists.
            const strippedCmds = pySplitWs(content);
            const cmd = pyStrip(content) !== "" && strippedCmds.length > 0
                ? (strippedCmds[0] as string).toLowerCase()
                : "";

            let result: unknown;
            if (this._handlers.has(cmd)) {
                result = await awaitPy(
                    pyCall(this._handlers.get(cmd), [content, sessionId, user_id]));
            } else if (pyTruth(this._llm_callback)) {
                const context: JsonDict = {
                    "session_id": sessionId,
                    "user_id": user_id,
                    "platform": platform,
                    "is_remote": true,
                };
                result = await awaitPy(pyCall(this._llm_callback, [content, context]));
            } else {
                result = Result.success("No handler for this message");
            }
            return result as Result;
        } catch (e) {
            return Result.failure(`Error handling message: ${pyStrExc(e)}`);
        }
    }

    /** Deliver a message to a user on `platform` and log it.
     *
     *  Delivery is attempted first so a transport failure is reported
     *  instead of being masked by a successful log write; the DB row is the
     *  audit trail, not the delivery mechanism. */
    async send_message(platform: string, user_id: string, content: string): Promise<Result> {
        const provider = this._providers.has(platform) ? this._providers.get(platform)! : null;
        const msg = new BotMessage(platform, user_id, content);

        if (provider === null) {
            this.storage.add_bot_message(msg.to_dict("outbound"));
            return Result.failure(
                `No ${platform} provider is running. Save its credentials in ` +
                `Settings → Bot, then restart the gateway.`
            );
        }

        let delivered: unknown;
        try {
            delivered = await pyCallAwait(
                provider, "send_message", [user_id, content]);
        } catch (exc) { // noqa: transport errors are expected
            this.storage.add_bot_message(msg.to_dict("outbound"));
            return Result.failure(`${platform} delivery failed: ${pyStrExc(exc)}`);
        }

        this.storage.add_bot_message(msg.to_dict("outbound"));
        if (!pyTruth(delivered)) {
            return Result.failure(`${platform} rejected the message (check the receiver id)`);
        }
        return Result.success(`Delivered to ${platform}:${user_id}`);
    }

    /** Register an IM provider instance, keyed by its platform id.
     *  Re-registering a platform replaces the old instance. */
    add_provider(provider: IMProvider): void {
        this._providers.set(
            pyCallMethod(provider, "get_platform_id", []) as string, provider);
    }

    /** Return the registered provider for `platform`, or null. */
    get_provider(platform: string): IMProvider | null {
        return this._providers.has(platform) ? this._providers.get(platform)! : null;
    }

    /** Start listeners for every registered provider; one failing provider
     *  never blocks the others. Returns {platform: "listening"|"error: …"}. */
    async start(): Promise<JsonDict> {
        const report: JsonDict = {};
        for (const [platform, provider] of this._providers) {
            try {
                await pyCallAwait(provider, "start_listening", [this]);
                this._listening.add(platform);
                report[platform] = "listening";
            } catch (exc) { // noqa: per-provider isolation
                report[platform] = `error: ${pyStrExc(exc)}`;
            }
        }
        return report;
    }

    /** Stop every running listener. Safe to call when nothing is running. */
    async stop(): Promise<void> {
        for (const [platform, provider] of this._providers) {
            try {
                await pyCallAwait(provider, "stop_listening", []);
            } catch {
                // fail-open: 可选增强，失败不影响主流程
            }
            this._listening.delete(platform);
        }
    }

    /** Per-platform state for the settings UI (nothing touches the network).
     *  DIVERGENCE(port, async bridge): async here — see header. */
    async provider_status(): Promise<JsonDict[]> {
        const out: JsonDict[] = [];
        for (const platform of PROVIDER_SEAMS.available_providers()) {
            let provider: IMProvider | null =
                this._providers.has(platform) ? this._providers.get(platform)! : null;
            let configured = false;
            if (provider === null) {
                // Not registered at boot → build a throwaway instance so the
                // UI reflects credentials saved since startup.
                try {
                    provider = await PROVIDER_SEAMS.get_provider(platform) as IMProvider;
                } catch {
                    provider = null;
                }
            }
            if (provider !== null) {
                try {
                    configured = pyTruth(pyCallMethod(provider, "is_configured", []));
                } catch {
                    configured = false;
                }
            }
            out.push({
                "platform": platform,
                "configured": configured,
                "listening": this._listening.has(platform),
                "allowedUsers": pyIter(this.load_allowed_users(platform)).length,
            });
        }
        return out;
    }

    /** Session ID for a platform:user_id pair, or null. */
    get_session_id(platform: string, user_id: string): string | null {
        const v = this._sessions.get(`${platform}:${user_id}`);
        return v === undefined ? null : v;
    }

    load_allowed_workspaces(platform: string): unknown {
        const state = this.storage.get_bot_state(`${platform}:config`, {});
        return dictGet(state, "allowed_workspaces", []);
    }

    load_tool_denylist(platform: string): unknown {
        const state = this.storage.get_bot_state(`${platform}:config`, {});
        return dictGet(state, "tool_denylist", BotController.DEFAULT_DENYLIST);
    }

    /** Allowed user ids for a platform (empty means "nobody"). */
    load_allowed_users(platform: string): string[] {
        const state = pyOr(this.storage.get_bot_state(`${platform}:config`, {}), {});
        return pyIter(dictGet(state, "allowed_users", [])).map((u) => pyStr(u));
    }

    /** Whether a remote user may drive this Agent. Fail-closed on purpose. */
    is_user_allowed(platform: string, user_id: string): boolean {
        const allowed = this.load_allowed_users(platform);
        if (!pyTruth(allowed)) return false;
        return pyIn(allowed, pyStr(user_id));
    }

    /** Whether a workspace path is inside the allow list.
     *  realpath-confinement, boundary-aware prefix, empty list denies. */
    is_workspace_allowed(platform: string, workspace_path: string): boolean {
        const allowed = this.load_allowed_workspaces(platform);
        if (!pyTruth(allowed)) return false;
        let target: string;
        try {
            target = realpathAbspath(workspace_path);
        } catch (e) {
            if (isOSErrorOrValueError(e)) return false;
            throw e; // TypeError on non-str escapes exactly like the source
        }
        for (const root of pyIter(allowed)) {
            let base: string;
            try {
                base = realpathAbspath(root);
            } catch (e) {
                if (isOSErrorOrValueError(e)) continue;
                throw e;
            }
            if (target === base) return true;
            if (target.startsWith(pyRstripChars(base, OS_SEP) + OS_SEP)) return true;
        }
        return false;
    }

    /** Check if a tool is not in the denylist. */
    is_tool_allowed(platform: string, tool_name: string): boolean {
        const denylist = this.load_tool_denylist(platform);
        return !pyIn(denylist, tool_name);
    }

    /** Log a remote operation to the audit table. */
    audit_operation(
        platform: string, user_id: string, session_id: string, tool_name: string,
        action: string, blocked: boolean, reason = "",
    ): void {
        this.storage.add_bot_audit(
            platform, user_id, session_id, tool_name, action, blocked, reason);
    }
}

// ---------------------------------------------------------------------------
// legacy facade
// ---------------------------------------------------------------------------

/** Legacy facade kept only for the read-only message-log endpoint. The
 *  mutating paths delegate to BotController — the single enforcement point;
 *  nothing here re-implements security. */
export class BotRemote {
    storage: BotStorage;
    private _handlers = new Map<string, (...args: unknown[]) => unknown>();
    private _state: JsonDict = {};

    constructor() {
        this.storage = get_storage() as unknown as BotStorage;
    }

    register_handler(command: string, handler: (...args: unknown[]) => unknown): void {
        // shadow registry keeps the raw key; the controller lower-cases —
        // the source's asymmetry, kept verbatim (never read back).
        this._handlers.set(command, handler);
        get_bot_controller().register_handler(command, handler);
    }

    async send_message(platform: string, user_id: string, content: string): Promise<Result> {
        return await get_bot_controller().send_message(platform, user_id, content);
    }

    async receive_message(platform: string, user_id: string, content: string): Promise<Result> {
        return await get_bot_controller().handle_message(platform, user_id, content);
    }

    set_state(key: string, value: unknown): void {
        this._state[key] = value;
    }

    get_state(key: string): unknown {
        const v = this._state[key];
        return Object.prototype.hasOwnProperty.call(this._state, key) ? v : null;
    }

    get_recent_messages(platform: string, user_id: string, limit = 20): JsonDict[] {
        return this.storage.get_bot_messages(platform, user_id, limit);
    }
}

// ---------------------------------------------------------------------------
// singletons
// ---------------------------------------------------------------------------

let _bot: BotRemote | null = null;

/** Get the global BotRemote singleton. */
export function get_bot_remote(): BotRemote {
    if (_bot === null) _bot = new BotRemote();
    return _bot;
}

let _controller: BotController | null = null;

/** Get the global BotController singleton. */
export function get_bot_controller(): BotController {
    if (_controller === null) _controller = new BotController();
    return _controller;
}

/** Error-classification for the (OSError, ValueError) catch arms. */
function isOSErrorOrValueError(e: unknown): boolean {
    if (e instanceof ValueErrorP) return true;
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^(ENOENT|ENOTDIR|EPERM|EACCES|ELOOP|ENAMETOOLONG|EBADF|EINVAL|UNKNOWN)$/.test(code)) {
        return true;
    }
    return e instanceof Error && e.name === "OSError";
}
