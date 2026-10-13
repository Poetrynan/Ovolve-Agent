/**
 * post_edit_verifier.ts — Post-Edit Verification Loop (PEVL). (unit 167, wave 7)
 *
 * Ported from `app/backend/post_edit_verifier.py` (260 lines / 10,802 bytes /
 * sha256_16 ebd6be3a8db32a94). The module closes the "edit → verify → report"
 * cycle: it subscribes to `tool_result` on the event bus, filters for
 * successful file edits, debounces bursts, then runs the workspace's own
 * verify commands (probed by verify_gate, permission-reused, sandbox-executed)
 * and emits one `post_edit_verification` event per command. It adds only the
 * trigger/debounce/report loop — no new execution engine.
 *
 * SEAM CENSUS (every host touchpoint, all routed through POST_EDIT_SEAMS)
 *   time.time() — the METHOD-LEVEL binding (`pev.time`, read inside
 *       _on_tool_result twice and _execute_verify twice) -> timeNow
 *   time.time() — the DEFTIME binding: `field(default_factory=time.time)` on
 *       VerificationResult.timestamp captures the function object at class
 *       creation and can never be re-aimed afterwards (QUIRK §1). The port
 *       captures the factory reference at module evaluation; the import
 *       environment may pre-install a factory clock on
 *       `globalThis.__PEV_FACTORY_CLOCK__` (the analogue of a fake `time`
 *       module pre-installed in sys.modules) — production leaves it unset.
 *   os.path.isdir -> osIsdir (python patches the module attribute `pev.os`)
 *   verify_gate.probe / is_allowed / truncate_output -> probe / is_allowed /
 *       truncate_output (defaults ARE the real verify_gate.ts functions)
 *   `from sandbox import run_confined_capture` (function-level import, the
 *       first statement of _execute_verify's try) -> importSandbox, fed by
 *       set_sandbox_provider(); unbound = the ModuleNotFoundError-position
 *       throw, a provider module without the name = the ImportError position
 *   asyncio.sleep -> sleep
 *   asyncio.wait_for -> waitfor
 *   asyncio.create_task -> createTask
 *   asyncio.get_running_loop().run_in_executor -> getRunningLoop + the loop
 *       object's run_in_executor method
 *   `except asyncio.TimeoutError` -> the timeout catch (name "TimeoutError")
 *   event_bus.get_event_bus -> getEventBus (default IS the real event_bus.ts
 *       singleton accessor); the bus itself is structural (BusLike)
 *   files / network / subprocess / env / uuid / storage: NOT touched directly
 *       by the source module — command execution only happens through the
 *       sandbox seam (probes assert this via _integrity).
 *
 * RULEBOOK CITATIONS (§ numbering as in HANDOFF_V4 / RULEBOOK)
 *   §4  naming: app/backend/post_edit_verifier.py -> app/engine/post_edit_verifier.ts
 *   §4  import specifiers: extensionless-style relative imports as the engine
 *       uses ("./event_bus.js", "./verify_gate.js")
 *   §2  dataclass: VerificationResult keeps python's field names and vars()
 *       order; constructor arity errors carry CPython's wording including the
 *       qualname prefix and the self-inclusive "takes from 11 to 13" interval
 *   §2  `raise X(...)` / `except SpecificError:`: python exception identities
 *       survive as distinguishable values (name-carrying Error subclasses)
 *   §2  `except Exception:` broad swallow: the two failure arms of
 *       _execute_verify reproduce the swallow exactly (they CONVERT the
 *       exception into a failed VerificationResult — that conversion is the
 *       behaviour)
 *   §2  dict as ordered structure: to_dict()/emit payloads keep insertion
 *       order (plain object literals, field order)
 *   §2  asyncio model: async/await only where the source was async; the
 *       create_task scheduling goes through the seam with a next-tick
 *       deferral (see DIVERGENCE port asyncio primitives)
 *   §2  module-level mutable state: the `_instance` singleton is a module-
 *       scoped let with the same lazy initialisation
 *   §1 / AMEND-07: zero dependencies — node builtins only
 *
 * QUIRKS PINNED BY THE PARITY PROBE
 *   1. VerificationResult.timestamp's default_factory is bound at CLASS
 *      CREATION (the function object is captured when the module body runs):
 *      patching the module attribute afterwards never changes it. The module
 *      therefore has TWO independent clock bindings — the method-level
 *      time.time() and the factory — which the probe scripts separately
 *      (clock seq vs factory seq).
 *   2. The debounce "cancel" arm almost never cancels an in-flight
 *      verification: _pending is only assigned AFTER the debounce sleep, so a
 *      second event arriving while the first handler is still sleeping sees
 *      _pending=None. Cancellation only fires when a previous _on_tool_result
 *      COMPLETED (its task exists) and the new event lands within
 *      DEBOUNCE_S of the last trigger.
 *   3. The post-sleep bail check is `time.time() - self._last_trigger <
 *      self._debounce_s - 0.1` — a 0.1s grace: a second clock read exactly
 *      4.9s after the trigger still proceeds; 4.899999 bails.
 *   4. result.get("returncode", -1) is evaluated TWICE (once for the success
 *      kwarg, once for exit_code) — a recording dict sees two entries.
 *   5. success is `rc == 0` with python == semantics: False == 0 is True and
 *      0.0 == 0 is True, so a returncode of the bool False reports SUCCESS;
 *      the string "0" does not. The stored exit_code is the RAW value.
 *   6. A missing returncode falls back to -1 on both reads (success=False).
 *   7. error/output/exit_code fields are stored RAW — result.get("error", "")
 *      may hand back a non-string and it flows into the emit payload as-is.
 *   8. The sandbox import is the FIRST statement of the try: an import
 *      failure produces a failure result with NO run_in_executor/waitfor
 *      trail and NO sandbox call.
 *   9. The timeout message embeds str(verify_wall_s) with python float repr:
 *      "验证超时（>30.0s）".
 *  10. Stop-on-first-failure: the emit happens BEFORE the failure check — a
 *      failed verification IS emitted, then the loop returns without probing
 *      permissions for later commands.
 *  11. A disallowed command `continue`s silently — no skip record, no emit.
 *  12. An empty probe list degrades silently (no result, no emit).
 *  13. mount() never rebinds the bus: re-mounting an existing singleton with
 *      a different bus kwarg leaves the ORIGINAL bus subscribed (the bus is
 *      chosen once, in the constructor).
 *  14. `bus or get_event_bus()` is a TRUTHINESS test — a falsy bus (0, "")
 *      falls through to the process singleton; any object is truthy.
 *  15. get_post_edit_verifier mounts only when BOTH workspace and session_id
 *      are truthy; the singleton is constructed with the FIRST call's bus
 *      only (workspace/session_id never reach the constructor).
 *  16. to_dict() key order == field declaration order (12 keys, timestamp
 *      between duration_ms and error).
 *  17. The emit payload is the live to_dict dict — its key order is
 *      observable on the bus ledger.
 *  18. Task.cancel() on an already-done task returns False and does nothing.
 *  19. duration_ms = int((t1 - t0) * 1000) truncates toward zero.
 *  20. `args.get("path") or args.get("file_path") or ""` short-circuits: a
 *      truthy path means file_path is NEVER read, and the surviving value is
 *      stored RAW (an int 5 stays 5 all the way into the emit payload).
 *  21. `payload = event.payload or {}` — a falsy payload becomes a fresh
 *      plain dict whose .get calls are (necessarily) unrecorded.
 *  22. `result.get("ok") is False` is an IDENTITY test with the False
 *      singleton: 0, None and "" all pass the filter and proceed.
 *  23. Every VerificationResult construction (success, timeout, generic
 *      failure arms — timestamp is never passed) consumes the factory clock
 *      exactly once, AFTER all kwarg expressions (including the error get)
 *      have been evaluated.
 *
 * MIGRATION DECISIONS / DIVERGENCES
 *   DIVERGENCE(port, number repr): the timeout message and the scripted
 *       waitfor/sleep arguments render verify_wall_s/debounce_s with float
 *       semantics ("30.0", "5.0"). A python caller passing the int 30 would
 *       see "30" where the port renders "30.0" — JS numbers cannot carry
 *       int/float identity. Unreachable in production: the only consumer
 *       (router.py:492) passes neither; the constructor defaults are the
 *       float literals VERIFY_WALL_S/DEBOUNCE_S.
 *   DIVERGENCE(port, kwargs surface): constructors and methods take
 *       positionals; python's keyword-only call errors (unexpected keyword /
 *       got multiple values) are unreachable through the TS surface and the
 *       probe maps keyword calls to positionals. Arity errors (missing N /
 *       takes from M to K) ARE reproduced with CPython wording.
 *   DIVERGENCE(port, dataclass surface): VerificationResult.__repr__/__eq__
 *       are not reproduced — no consumer prints or ==-compares it (grepped:
 *       router.py is the sole importer; it only constructs, mounts and
 *       unmounts the verifier).
 *   DIVERGENCE(port, asyncio primitives): asyncio.sleep / wait_for /
 *       create_task / get_running_loop are seams. The production default
 *       waitfor races a timer against the awaited promise (the wall-clock
 *       cap); the production default run_in_executor runs the thunk on the
 *       microtask queue instead of a thread pool (Node has no executor) and
 *       the default createTask defers the thunk to the next event-loop tick —
 *       the same single-scheduler event loop, not a second one. The scripted
 *       probes pin call ordering; thread interleaving was never deterministic
 *       in the source either (the executor thread races the wait_for timeout).
 *   DIVERGENCE(port, CancelledError surface): python's asyncio.CancelledError
 *       is a BaseException; the port models a cancelled task's awaitable as
 *       rejecting with an Error named "CancelledError" whose str() is "".
 *   DIVERGENCE(port, import environment): python resolves the function-level
 *       `from sandbox import ...` through sys.modules at call time; the port
 *       resolves it through set_sandbox_provider() / the importSandbox seam —
 *       unbound throws the ModuleNotFoundError-position error, a module
 *       without the attribute throws the ImportError-position error (both
 *       with CPython's 3.13 wording, "(unknown location)" included). The
 *       factory clock's import-time binding is mirrored by the module-eval
 *       capture described in the seam census.
 *   DIVERGENCE(port, except Exception scope): the generic failure arm catches
 *       what a JS catch can catch; python's `except Exception` already
 *       excludes KeyboardInterrupt/SystemExit, so the observable scope is the
 *       same for every scripted and production error.
 */

import * as nodeFs from "node:fs";

import { EventBus, Event, getEventBus } from "./event_bus.js";
import { VerifyCommand, probe as _probe_workspace, is_allowed, truncate_output } from "./verify_gate.js";

// ── python-semantics helpers (house style: file-local) ───────────────────────

class TypeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "TypeError"; }
}
class ModuleNotFoundErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ModuleNotFoundError"; }
}
class ImportErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ImportError"; }
}
/** python asyncio.CancelledError (a BaseException; str() is ""). */
class CancelledErrorP extends Error {
    constructor() { super(""); this.name = "CancelledError"; }
}

type PyDict = Record<string, unknown>;

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (typeof v === "function") return "function";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
    }
    return typeof v;
}

function isPyDict(v: unknown): boolean {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    if (v instanceof Uint8Array || v instanceof Error) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "function") return true;
    if (Array.isArray(v)) return v.length > 0;
    if (isPyDict(v)) return Object.keys(v as PyDict).length > 0;
    return true;
}

function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

/** python str(float): integral floats keep their ".0". */
function fmtFloat(n: number): string {
    return Number.isInteger(n) && Number.isFinite(n) ? n + ".0" : String(n);
}

/** python int() on the duration expression (float truncation; the NaN/inf
 *  wording surface is kept for fidelity, the scripted clocks are finite). */
function pyInt(v: number): number {
    if (Number.isNaN(v)) throw new ValueErrorP("cannot convert float NaN to integer");
    if (!Number.isFinite(v)) throw new OverflowErrorP("cannot convert float infinity to integer");
    return Math.trunc(v);
}
class ValueErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ValueError"; }
}
class OverflowErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "OverflowError"; }
}

/** python's "missing N required positional argument(s)" TypeError text. */
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

/** interval form CPython uses when some parameters have defaults (self counts). */
function pyTooManyRange(fname: string, min: number, max: number, given: number): TypeErrorP {
    const noun = max === 1 ? "positional argument" : "positional arguments";
    const verb = given === 1 ? "was" : "were";
    return new TypeErrorP(`${fname}() takes from ${min} to ${max} ${noun} but ${given} ${verb} given`);
}

/** exact-count form CPython uses when no parameter has a default (self counts). */
function pyTooManyExact(fname: string, takes: number, given: number): TypeErrorP {
    const noun = takes === 1 ? "positional argument" : "positional arguments";
    const verb = given === 1 ? "was" : "were";
    return new TypeErrorP(`${fname}() takes ${takes} ${noun} but ${given} ${verb} given`);
}

/** python `x == 0` for the scripted value surface (bool/int/float/other). */
function pyEq0(v: unknown): boolean {
    if (typeof v === "boolean") return !v; // False == 0 is True, True == 0 is False
    if (typeof v === "number") return v === 0; // 0.0 == 0 is True
    return false; // "0", None, lists... all != 0
}

/**
 * python `payload.get(key, ...)` as a METHOD call: a dict-like object's own
 * .get is invoked (a probe's recording dict sees the call), a plain object
 * behaves like a dict, anything else raises python's AttributeError wording.
 */
function pyDictGet(obj: unknown, key: string, ...rest: unknown[]): unknown {
    if (obj !== null && obj !== undefined && typeof obj === "object" &&
        typeof (obj as { get?: unknown }).get === "function") {
        return (obj as { get: (k: string, ...r: unknown[]) => unknown }).get(key, ...rest);
    }
    if (isPyDict(obj)) {
        const d = obj as PyDict;
        if (Object.prototype.hasOwnProperty.call(d, key)) return d[key];
        return rest.length > 0 ? rest[0] : null;
    }
    throw new PyAttributeErrorP(`'${pyTypeName(obj)}' object has no attribute 'get'`);
}
class PyAttributeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "AttributeError"; }
}

// ── module constants (verbatim) ──────────────────────────────────────────────

/** Verification does not block the agent's next turn. But it SHOULD finish
 *  before the model has written and edited another ten files, or the result
 *  lands on a stale workspace. 30s is enough for a lint + typecheck on a
 *  normal project; a full test suite is the next turn's problem. */
export const VERIFY_WALL_S = 30.0;

/** Cooldown between verification triggers. A burst of write_file calls (agent
 *  scaffolding a project) coalesces into one pass instead of N. */
export const DEBOUNCE_S = 5.0;

/** Max chars of verification output fed back to the model / frontend. */
export const MAX_OUTPUT_CHARS = 2000;

/** Tools that trigger verification on success. */
export const TRIGGER_TOOLS: ReadonlySet<string> = new Set([
    "write_file", "edit_file", "apply_patch", "replace_file_content",
]);

// ── host seams ───────────────────────────────────────────────────────────────

/** Structural view of the bus (the real EventBus satisfies it; the probe
 *  installs a recording fake). */
export interface BusLike {
    on(eventName: string, handler: (event: Event) => unknown, priority?: number): void;
    off(eventName: string, handler: (event: Event) => unknown): void;
    emit(eventName: string, payload?: PyDict): unknown;
}

/** Structural view of a scheduled task (python asyncio.Task surface). */
export interface TaskLike {
    done(): boolean;
    cancel(): boolean;
    /** awaitable surface (python: tasks are awaitable). */
    then?(
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
    ): unknown;
}

/** Structural view of the executor loop (python loop.run_in_executor). */
interface LoopLike {
    run_in_executor(executor: unknown, fn: () => unknown): unknown;
}

export const POST_EDIT_SEAMS = {
    /** python method-level `time.time()` (the `pev.time` module attribute). */
    timeNow: (): number => Date.now() / 1000,
    /** python os.path.isdir — False on any stat failure, like the source. */
    osIsdir: (p: string): boolean => {
        try {
            return nodeFs.statSync(p).isDirectory();
        } catch {
            return false;
        }
    },
    /** python verify_gate.probe (imported as _probe_workspace). */
    probe: (workspace: string): VerifyCommand[] => _probe_workspace(workspace),
    /** python verify_gate.is_allowed. */
    is_allowed: (command: string, workspace: string): [boolean, string] =>
        is_allowed(command, workspace),
    /** python verify_gate.truncate_output. */
    truncate_output: (text: string, limit: number): string => truncate_output(text, limit),
    /** python event_bus.get_event_bus (the `bus or get_event_bus()` fallback). */
    getEventBus: (): BusLike => getEventBus() as unknown as BusLike,
    /** python asyncio.sleep — production default really waits. */
    sleep: (seconds: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, Number(seconds) * 1000)),
    /** python asyncio.get_running_loop() — the executor loop surface. */
    getRunningLoop: (): LoopLike => ({
        run_in_executor: (_executor: unknown, fn: () => unknown): unknown =>
            Promise.resolve().then(fn),
    }),
    /** python asyncio.wait_for — production default: a genuinely suspending
     *  promise races the timeout timer (the wall-clock cap). */
    waitfor: (aw: unknown, timeout: number): unknown => {
        if (aw instanceof Promise) {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const loser = new Promise<never>((_, rej) => {
                timer = setTimeout(() => rej(new TimeoutErrorP()), Number(timeout) * 1000);
            });
            return Promise.race([aw, loser]).finally(() => {
                if (timer !== null) clearTimeout(timer);
            });
        }
        return aw;
    },
    /** python asyncio.create_task — production default: defer the thunk to the
     *  next event-loop tick (the loop.create_task scheduling), expose the
     *  Task surface (done/cancel/thenable). */
    createTask: (thunk: () => Promise<unknown>): TaskLike => {
        let settled = false;
        let cancelled = false;
        let resolveP!: (v: unknown) => void;
        let rejectP!: (e: unknown) => void;
        const awaited = new Promise<unknown>((res, rej) => { resolveP = res; rejectP = rej; });
        // a task nobody awaits must not crash the process on rejection
        // (python: an unretrieved cancelled task is silent); a later await
        // still receives the rejection.
        awaited.catch(() => { /* handled above; awaiters still see it */ });
        void Promise.resolve().then(() => {
            // the next event-loop tick: a cancelled-before-start task never
            // runs its body, exactly like loop.create_task + cancel().
            if (cancelled) throw new CancelledErrorP();
            return thunk();
        }).then(
            (v) => { settled = true; resolveP(v); },
            (e) => { settled = true; rejectP(e); },
        );
        return {
            done: () => settled,
            cancel: () => {
                if (settled) return false;
                cancelled = true;
                return true;
            },
            then: (onFulfilled?: (value: unknown) => unknown,
                   onRejected?: (reason: unknown) => unknown) =>
                awaited.then(onFulfilled, onRejected),
        };
    },
    /** python `import sandbox` — an unbound provider throws the
     *  ModuleNotFoundError-position error; the from-import NAME check happens
     *  at the call site (python's `from sandbox import run_confined_capture`
     *  is a module lookup followed by an attribute fetch). */
    importSandbox: (): SandboxModule => {
        if (_sandbox_provider === null) {
            throw new ModuleNotFoundErrorP("No module named 'sandbox'");
        }
        return _sandbox_provider() as SandboxModule;
    },
};

class TimeoutErrorP extends Error {
    constructor() { super(""); this.name = "TimeoutError"; }
}

// ── sandbox 惰性导入缝（execution_provider.ts / confirm_meta.ts 同款） ────────

/** python `from sandbox import run_confined_capture` 的最小视图。 */
export interface SandboxModule {
    run_confined_capture?: unknown;
}

export type SandboxProvider = () => SandboxModule;

let _sandbox_provider: SandboxProvider | null = null;

/** 注入 sandbox 模块提供者（宿主接线与 parity 探针用）；null 恢复"模块不存在"。 */
export function set_sandbox_provider(provider: SandboxProvider | null): void {
    _sandbox_provider = provider;
}

// ── VerificationResult ───────────────────────────────────────────────────────

const _VR_FIELDS = [
    "session_id", "workspace", "trigger_tool", "trigger_path", "success",
    "command", "kind", "exit_code", "output", "duration_ms", "timestamp", "error",
] as const;

/**
 * The dataclass default_factory is bound at CLASS CREATION in python — the
 * function object captured when this module body runs is final. The import
 * environment may pre-install the factory clock on globalThis (the analogue
 * of a fake `time` module pre-installed in sys.modules before the import);
 * production falls back to the real wall clock. The captured reference can
 * never be re-aimed (QUIRK §1).
 */
const _TS_FACTORY: () => number =
    (globalThis as { __PEV_FACTORY_CLOCK__?: () => number }).__PEV_FACTORY_CLOCK__
    ?? ((): number => Date.now() / 1000);

/** Outcome of one post-edit verification pass. */
export class VerificationResult {
    session_id: unknown;
    workspace: unknown;
    trigger_tool: unknown;
    trigger_path: unknown;
    success: unknown;
    command: unknown;
    kind: unknown;
    exit_code: unknown;
    output: unknown;
    duration_ms: unknown;
    timestamp: unknown;
    error: unknown;

    constructor(
        session_id?: unknown,
        workspace?: unknown,
        trigger_tool?: unknown,
        trigger_path?: unknown,
        success?: unknown,
        command?: unknown,
        kind?: unknown,
        exit_code?: unknown,
        output?: unknown,
        duration_ms?: unknown,
        timestamp?: unknown,
        error?: unknown,
    ) {
        const given = arguments.length;
        if (given < 10) {
            throw pyMissing("VerificationResult.__init__", _VR_FIELDS.slice(given, 10));
        }
        if (given > 12) {
            throw pyTooManyRange("VerificationResult.__init__", 11, 13, given + 1);
        }
        this.session_id = session_id;
        this.workspace = workspace;
        this.trigger_tool = trigger_tool;
        this.trigger_path = trigger_path;
        this.success = success;
        this.command = command;
        this.kind = kind;
        this.exit_code = exit_code;
        this.output = output;
        this.duration_ms = duration_ms;
        // house convention: a dataclass default fires on === undefined (python
        // omitted argument); an explicit null is stored as None. The factory
        // read happens here — after every kwarg expression was evaluated.
        this.timestamp = timestamp === undefined ? _TS_FACTORY() : timestamp;
        this.error = error === undefined ? "" : error;
    }

    to_dict(): PyDict {
        return {
            session_id: this.session_id,
            workspace: this.workspace,
            trigger_tool: this.trigger_tool,
            trigger_path: this.trigger_path,
            success: this.success,
            command: this.command,
            kind: this.kind,
            exit_code: this.exit_code,
            output: this.output,
            duration_ms: this.duration_ms,
            timestamp: this.timestamp,
            error: this.error,
        };
    }
}

// ── PostEditVerifier ─────────────────────────────────────────────────────────

export class PostEditVerifier {
    _bus: BusLike;
    _verify_wall_s: number;
    _debounce_s: number;
    _enabled: unknown;
    _pending: TaskLike | null = null;
    _last_trigger = 0.0;
    _workspace = "";
    _session_id = "";

    /** The subscription handler is a per-instance arrow so `on` and `off`
     *  always see the SAME reference (python's bound methods compare equal;
     *  JS needs identity). */
    readonly _on_tool_result = async (event: Event): Promise<void> => {
        if (!pyTruth(this._enabled)) {
            return;
        }
        let payload = pyOr(event.payload, {} as PyDict);
        const tool_name = pyDictGet(payload, "tool_name", "") as string;
        if (!TRIGGER_TOOLS.has(tool_name)) {
            return;
        }
        // Only verify on success.
        const result = pyOr(pyDictGet(payload, "result"), {} as PyDict);
        if (isPyDict(result) && pyDictGet(result, "ok") === false) {
            return;
        }
        // Debounce: cancel the pending verification and schedule a new one.
        const now = POST_EDIT_SEAMS.timeNow();
        if (now - this._last_trigger < this._debounce_s) {
            const pending = this._pending as TaskLike | null;
            if (pending !== null && pyTruth(pending) && !pending.done()) {
                pending.cancel();
            }
        }
        this._last_trigger = now;
        // Capture the path that triggered this verification.
        const args = pyOr(pyDictGet(payload, "args"), {} as PyDict);
        const p1 = pyDictGet(args, "path");
        const trigger_path = pyTruth(p1)
            ? p1
            : (() => {
                const p2 = pyDictGet(args, "file_path");
                return pyTruth(p2) ? p2 : "";
            })();
        // Schedule verification after the debounce window.
        await POST_EDIT_SEAMS.sleep(this._debounce_s);
        // If a newer trigger arrived while we were sleeping, bail.
        if (POST_EDIT_SEAMS.timeNow() - this._last_trigger < this._debounce_s - 0.1) {
            return;
        }
        this._pending = POST_EDIT_SEAMS.createTask(() =>
            this._run_verification(tool_name, trigger_path));
    };

    constructor(bus?: unknown, verify_wall_s?: unknown, debounce_s?: unknown, enabled?: unknown) {
        const given = arguments.length;
        if (given > 4) {
            throw pyTooManyRange("PostEditVerifier.__init__", 1, 5, given + 1);
        }
        // house convention: omitted argument (=== undefined) fires the python
        // default; an explicit null is stored as None (and `bus or ...` then
        // falls through to the singleton, as in python).
        const b = bus === undefined ? null : bus;
        const ws = verify_wall_s === undefined ? VERIFY_WALL_S : verify_wall_s;
        const ds = debounce_s === undefined ? DEBOUNCE_S : debounce_s;
        const en = enabled === undefined ? true : enabled;
        this._bus = (pyTruth(b) ? b : POST_EDIT_SEAMS.getEventBus()) as BusLike;
        this._verify_wall_s = ws as number;
        this._debounce_s = ds as number;
        this._enabled = en;
    }

    /** Bind to a workspace + session and subscribe to the bus. */
    mount(workspace: string, session_id: string): void {
        const given = arguments.length;
        if (given < 2) {
            throw pyMissing("PostEditVerifier.mount", ["workspace", "session_id"].slice(given));
        }
        if (given > 2) {
            throw pyTooManyExact("PostEditVerifier.mount", 3, given + 1);
        }
        this._workspace = workspace;
        this._session_id = session_id;
        this._bus.on("tool_result", this._on_tool_result, 5);
    }

    /** Unsubscribe from the bus. */
    unmount(): void {
        const given = arguments.length;
        if (given > 0) {
            throw pyTooManyExact("PostEditVerifier.unmount", 1, given + 1);
        }
        this._bus.off("tool_result", this._on_tool_result);
        const pending = this._pending as TaskLike | null;
        if (pending !== null && pyTruth(pending) && !pending.done()) {
            pending.cancel();
        }
    }

    /** Run the verification chain for the workspace. */
    private async _run_verification(trigger_tool: unknown, trigger_path: unknown): Promise<void> {
        if (!pyTruth(this._workspace) || !POST_EDIT_SEAMS.osIsdir(this._workspace)) {
            return;
        }
        const commands = POST_EDIT_SEAMS.probe(this._workspace);
        if (!pyTruth(commands)) {
            return; // No verify commands detected — degrade silently.
        }
        for (const cmd of commands as VerifyCommand[]) {
            // Permission check: only run if an existing ALLOW rule covers it.
            const [allowed, _reason] = POST_EDIT_SEAMS.is_allowed(cmd.command, this._workspace);
            if (!pyTruth(allowed)) {
                continue;
            }
            const result = await this._execute_verify(cmd, trigger_tool, trigger_path);
            if (result !== null) {
                await this._bus.emit("post_edit_verification", result.to_dict());
            }
            // Stop on first failure — no point running tests if typecheck fails.
            if (result !== null && !pyTruth(result.success)) {
                return;
            }
        }
    }

    /** Run one verification command in the sandbox. */
    private async _execute_verify(
        cmd: VerifyCommand,
        trigger_tool: unknown,
        trigger_path: unknown,
    ): Promise<VerificationResult | null> {
        const t0 = POST_EDIT_SEAMS.timeNow();
        try {
            // python `from sandbox import run_confined_capture`: module lookup
            // (ModuleNotFoundError position) + attribute fetch (ImportError
            // position, CPython 3.13 wording with the file-less "(unknown
            // location)").
            const sandboxMod = POST_EDIT_SEAMS.importSandbox() as PyDict | null;
            if (sandboxMod === null || sandboxMod === undefined
                || !("run_confined_capture" in sandboxMod)) {
                throw new ImportErrorP(
                    "cannot import name 'run_confined_capture' from 'sandbox' (unknown location)");
            }
            const run_confined_capture = sandboxMod["run_confined_capture"];
            const loop = POST_EDIT_SEAMS.getRunningLoop();
            // run_confined_capture is sync (subprocess.run); run in executor to avoid blocking.
            const result = await POST_EDIT_SEAMS.waitfor(
                loop.run_in_executor(null, () =>
                    (run_confined_capture as (...a: unknown[]) => unknown)(
                        cmd.command,
                        { cwd: this._workspace, timeout: this._verify_wall_s, mode: "workspace-write", strict: false },
                    )),
                this._verify_wall_s + 5.0,
            ) as PyDict;
            const output = POST_EDIT_SEAMS.truncate_output(
                pyDictGet(result, "output", "") as string,
                MAX_OUTPUT_CHARS,
            );
            const duration_ms = pyInt((POST_EDIT_SEAMS.timeNow() - t0) * 1000);
            return new VerificationResult(
                this._session_id,
                this._workspace,
                trigger_tool,
                trigger_path,
                pyEq0(pyDictGet(result, "returncode", -1)),
                cmd.command,
                cmd.kind,
                pyDictGet(result, "returncode", -1),
                output,
                duration_ms,
                undefined,
                pyDictGet(result, "error", ""),
            );
        } catch (exc) {
            if (exc instanceof TimeoutErrorP || (exc as Error).name === "TimeoutError") {
                const duration_ms = pyInt((POST_EDIT_SEAMS.timeNow() - t0) * 1000);
                return new VerificationResult(
                    this._session_id,
                    this._workspace,
                    trigger_tool,
                    trigger_path,
                    false,
                    cmd.command,
                    cmd.kind,
                    -1,
                    "",
                    duration_ms,
                    undefined,
                    `验证超时（>${fmtFloat(this._verify_wall_s)}s）`,
                );
            }
            const duration_ms = pyInt((POST_EDIT_SEAMS.timeNow() - t0) * 1000);
            return new VerificationResult(
                this._session_id,
                this._workspace,
                trigger_tool,
                trigger_path,
                false,
                cmd.command,
                cmd.kind,
                -1,
                "",
                duration_ms,
                undefined,
                (exc as Error).message !== undefined ? (exc as Error).message : String(exc),
            );
        }
    }
}

// ── Singleton accessor ───────────────────────────────────────────────────────

let _instance: PostEditVerifier | null = null;

/** Process-wide singleton. Mounts on first call with workspace + session. */
export function get_post_edit_verifier(
    bus?: unknown,
    workspace?: unknown,
    session_id?: unknown,
): PostEditVerifier {
    const given = arguments.length;
    if (given > 3) {
        throw pyTooManyRange("get_post_edit_verifier", 0, 3, given);
    }
    const b = bus === undefined ? null : bus;
    const ws = workspace === undefined ? "" : workspace;
    const sid = session_id === undefined ? "" : session_id;
    if (_instance === null) {
        _instance = new PostEditVerifier(b);
    }
    if (pyTruth(ws) && pyTruth(sid)) {
        _instance.mount(ws as string, sid as string);
    }
    return _instance;
}

// 本文件无 TODO(port)。
// PORT STATUS: confidence=high todos=[0]
