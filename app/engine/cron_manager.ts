/**
 * cron_manager.ts — cron scheduler and periodic automation manager.
 *
 * Ported from `app/backend/cron_manager.py` (370 lines, wave-6, unit 145).
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/cron_manager.py -> app/engine/cron_manager.ts.
 *   §4  py kwargs calls become the trailing options object (CronJob's
 *       keyword-only block, CronManager.create's optional tail), matching the
 *       already-landed storage/domains and skill_lifecycle surfaces; the two
 *       positional args http_server passes to `create(...)` stay positional.
 *   §2  bug-for-bug: `list_crons(status=…)` filters into `filtered` and then
 *       returns ALL rows anyway — the dead store is the source behaviour and is
 *       kept verbatim (pinned by the parity probe).
 *   §2  `should_run()` returns the FALSY `next_run` operand itself (0.0), not
 *       False, when the job has no scheduled time; python `and` chains return
 *       the first falsy value. Reproduced, and observable in the loop and probe.
 *   §2  present-but-null: every `row.get(k, d)` keeps a stored NULL (it never
 *       folds into the default); the extra `or …` guards the source adds
 *       (`prompt`, `cron_expr`, `created_at`/`last_run_at`/`next_run_at`/
 *       `run_count`) are reproduced as pyOr, which likewise returns the raw
 *       operand, so a row whose `id`/`created_at` is NULL or an int keeps that
 *       raw value exactly like python.
 *   §2  `calculate_next_run()` catches ONLY ImportError around the croniter
 *       block: a bad expression raises CroniterBadCronError / CroniterBadDateError
 *       (a non-string expression raises AttributeError) straight through
 *       `create_cron` / `create` / `mark_run` / `resume_cron`, exactly as in
 *       python, so the fallback branch is reachable only when the import fails.
 *   §2  `_execute_job` keeps the whole `running_since` lease bookkeeping
 *       (§10 overlap lock, §14 restart ledger), the payload key order, and the
 *       `last_error` truncation to 400 chars. The handler payload has NO
 *       `session_id` key even though the server-side handler reads one —
 *       source asymmetry kept, so scheduled turns always land on the default
 *       router.
 *   §2  cache keys: `_jobs` and `_task_handlers` are python dicts keyed by the
 *       RAW row value (an int id stays an int), so the port keys them by
 *       pyMapKey() (type-tagged) — `7 in jobs` and `"7" in jobs` cannot alias,
 *       exactly like CPython.
 *
 * MIGRATION DECISIONS / DIVERGENCES (documented dispositions)
 *   telemetry: `get_telemetry()` / `SpanName.CRON_EXECUTE` start_span /
 *       set_error / end_span are deleted exactly per the HANDOFF §8.3
 *       disposition for the DELETE-flagged telemetry.py unit ("依赖方直接删
 *       调用") — purely observational; every surrounding statement, including
 *       the `_err` ledger that feeds storage.last_error, is byte-identical.
 *       Same precedent as memory_layer.ts / app_agent.ts / file_agent.ts /
 *       bot_remote.ts.
 *   croniter: resolved through `CRON_SEAMS.croniterNext`, whose default is the
 *       vendored `croniter.ts` port of the installed site-package (parity
 *       pinned at 106/106 against the live interpreter, error texts included).
 *       Setting the seam to null reproduces python's
 *       `ModuleNotFoundError: No module named 'croniter'` and drives the
 *       fallback branch.
 *   bot_remote: python imports `get_bot_controller` INSIDE `_deliver_to_bot`
 *       (first statement of the try) and only CALLS it after the platform /
 *       user_id guard. The port splits the same two steps across
 *       `CRON_SEAMS.botModule()` (dynamic import, whose ERR_MODULE_NOT_FOUND is
 *       re-thrown as `ImportError: No module named 'bot_remote'` so the loud
 *       one-line failure reads identically) and `mod.get_bot_controller()` at
 *       python's own call site, so an unconfigured-controller error surfaces
 *       only for jobs that would actually have sent something. A module that
 *       exists but lacks the name is reported with python's
 *       `cannot import name ...` ImportError too, before any target parsing —
 *       same order as CPython's `from x import y`.
 *   DIVERGENCE(port, async bridge): `await handler(payload)` on a
 *       non-awaitable raises TypeError in python ("object dict can't be used
 *       in 'await' expression", CPython 3.13 spelling) where JS `await` passes
 *       through, so awaitPy() reproduces the python error and the same text
 *       lands in `_err`/last_error.
 *   DIVERGENCE(port, float repr): `next_run` is a python float from
 *       croniter/time.time(); the port carries plain JS numbers, whose
 *       shortest round-trip repr equals CPython's for every value the probe
 *       exercises (epoch seconds).
 *   DIVERGENCE(port, sqlite row type): python rows are sqlite3.Row (mapping by
 *       name); the landed storage port returns plain objects, so `r["id"]` and
 *       `row.get(...)` map onto dictGet/[] with identical present-but-null
 *       semantics.
 *   DIVERGENCE(port, JSON key order of a re-serialised blob): `to_storage_dict`
 *       json.dumps task_data / bot_delivery_target, and python keeps insertion
 *       order while a JS object re-indexes CANONICAL-INTEGER keys first
 *       ({"2":..,"1":..} serialises as {"1":..,"2":..}). Nothing reads that
 *       string as ordered text — the cron_jobs row is re-parsed by
 *       `from_storage_row` on every load, and no consumer compares or sorts by
 *       it — so the only observable is the byte shape of a column value whose
 *       keys are integer-like strings. Alphabetic insertion order, which every
 *       real payload uses, is preserved and pinned by the roundtrip steps.
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import { randomUUID } from "node:crypto";

import { Result } from "./result.js";
import { get_storage } from "./storage.js";
import { Croniter } from "./croniter.js";

type JsonDict = Record<string, unknown>;

// ── python-semantics helpers (house style: bot_remote.ts / checkpoint.ts) ────

class ImportErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "ImportError";
    }
}
class AttributeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "AttributeError";
    }
}
class TypeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "TypeError";
    }
}
class ValueErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "ValueError";
    }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (typeof v === "function") return "function";
    return "dict";
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

/** python `a or b`: returns the first truthy OPERAND (not a boolean). */
function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

function isPyDict(v: unknown): v is JsonDict {
    return (
        v !== null &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        !(v instanceof Map) &&
        typeof v !== "function"
    );
}

/** `d.get(k, dflt)`: a PRESENT null returns null, never the default. */
function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
    if (obj instanceof Map) return obj.has(key) ? obj.get(key) : dflt;
    if (isPyDict(obj)) {
        return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as JsonDict)[key] : dflt;
    }
    throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute 'get'`);
}

/** python dict key identity across types (str "7" must not alias int 7). */
function pyMapKey(k: unknown): string {
    if (typeof k === "string") return "s:" + k;
    if (typeof k === "number") return "n:" + k;
    if (typeof k === "boolean") return "n:" + (k ? 1 : 0);
    if (k === null || k === undefined) return "None";
    return "o:" + pyRepr(k);
}

/** python repr() for the container/atom cases str() reaches in this module. */
function pyReprStr(s: string): string {
    const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
    let out = quote;
    for (const ch of s) {
        const cp = ch.codePointAt(0) as number;
        if (ch === "\\") out += "\\\\";
        else if (ch === quote) out += "\\" + ch;
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
        else out += ch;
    }
    return out + quote;
}

function pyRepr(v: unknown): string {
    if (typeof v === "string") return pyReprStr(v);
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Map) {
        const parts: string[] = [];
        for (const [k, val] of v) parts.push(`${pyRepr(k)}: ${pyRepr(val)}`);
        return "{" + parts.join(", ") + "}";
    }
    if (isPyDict(v)) {
        return (
            "{" +
            Object.keys(v)
                .map((k) => `${pyRepr(k)}: ${pyRepr((v as JsonDict)[k])}`)
                .join(", ") +
            "}"
        );
    }
    return pyStr(v);
}

/** python str(x): containers go through repr(), atoms print bare. */
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
    if (typeof v === "function") return `<function ${v.name || "?"}>`;
    if (v instanceof Error) return pyStrExc(v);
    if (Array.isArray(v) || isPyDict(v) || v instanceof Map) return pyRepr(v);
    return String(v);
}

/** str(exception) — message only, no type prefix, matching CPython. */
function pyStrExc(e: unknown): string {
    if (e instanceof Error) return e.message;
    return pyStr(e);
}

const ND_RE = /\p{Nd}/u;

/** CPython int() reads unicode decimal digits; V8 NFKD does not fold them. */
function decimalValueOf(ch: string): number {
    const cp = ch.codePointAt(0) as number;
    let start = cp;
    while (start > cp - 10 && ND_RE.test(String.fromCodePoint(start - 1))) start--;
    return cp - start;
}

/** python int(str): whitespace-stripped, optional sign, unicode digits, single
 *  underscores between digits ("1_0" is fine, "_1"/"1_"/"1__0" are not). */
function pyIntStr(raw: string): number {
    let s = "";
    for (const ch of raw.trim()) s += ND_RE.test(ch) ? String(decimalValueOf(ch)) : ch;
    const body = s.startsWith("+") || s.startsWith("-") ? s.slice(1) : s;
    if (
        body === "" ||
        !/^[0-9][0-9_]*$/.test(body) ||
        body.endsWith("_") ||
        body.includes("__")
    ) {
        throw new ValueErrorP(`invalid literal for int() with base 10: '${raw}'`);
    }
    const n = Number((s.startsWith("-") ? "-" : "") + body.replaceAll("_", ""));
    if (!Number.isSafeInteger(n)) {
        throw new ValueErrorP(`int too large to convert: '${raw}'`);
    }
    return n;
}

/** python int(x): bool/float truncate toward zero, str parse; ValueError else. */
function pyInt(v: unknown): number {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") {
        if (Number.isNaN(v)) throw new ValueErrorP("cannot convert float NaN to integer");
        if (!Number.isFinite(v)) {
            throw new RangeError("cannot convert float infinity to integer");
        }
        return Math.trunc(v);
    }
    if (typeof v === "string") return pyIntStr(v);
    throw new TypeErrorP(
        `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`
    );
}

/** str[:stop] by code points. */
function pySliceStr(s: string, stop: number): string {
    return Array.from(s).slice(0, Math.min(stop, Array.from(s).length)).join("");
}

/** python str.partition(sep) — code-point exact. */
function pyPartition(s: string, sep: string): [string, string, string] {
    const chars = Array.from(s);
    const seps = Array.from(sep);
    for (let i = 0; i + seps.length <= chars.length; i++) {
        let hit = true;
        for (let j = 0; j < seps.length; j++) {
            if (chars[i + j] !== seps[j]) {
                hit = false;
                break;
            }
        }
        if (hit) {
            return [
                chars.slice(0, i).join(""),
                sep,
                chars.slice(i + seps.length).join(""),
            ];
        }
    }
    return [s, "", ""];
}

/** python `str.split()` with no separator: whitespace runs, no empty members. */
function pySplitWhitespace(s: unknown): string[] {
    if (typeof s !== "string") {
        throw new AttributeErrorP(`'${pyTypeName(s)}' object has no attribute 'split'`);
    }
    return s.split(/[\s\u001c-\u001f\u0085]+/).filter((x) => x.length > 0);
}

/**
 * json.dumps(obj, ensure_ascii=False) with python's default `", "` / `": "`
 * separators and insertion-order keys. Unserializable values raise the same
 * TypeError python does (the source has no guard there).
 */
function pyJsonDumps(v: unknown): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") {
        if (Number.isNaN(v)) return "NaN";
        if (v === Infinity) return "Infinity";
        if (v === -Infinity) return "-Infinity";
        return String(v);
    }
    if (typeof v === "string") {
        // ensure_ascii=False keeps U+2028/U+2029 raw where JSON.stringify escapes
        return JSON.stringify(v)
            .split("\\u2028").join(String.fromCharCode(0x2028))
            .split("\\u2029").join(String.fromCharCode(0x2029));
    }
    if (typeof v === "function" || v instanceof Error || v instanceof Map || v instanceof Set) {
        throw new TypeErrorP(`Object of type ${pyTypeName(v)} is not JSON serializable`);
    }
    if (Array.isArray(v)) return "[" + v.map(pyJsonDumps).join(", ") + "]";
    if (isPyDict(v)) {
        return (
            "{" +
            Object.keys(v)
                .map((k) => pyJsonDumps(k) + ": " + pyJsonDumps((v as JsonDict)[k]))
                .join(", ") +
            "}"
        );
    }
    throw new TypeErrorP(`Object of type ${pyTypeName(v)} is not JSON serializable`);
}

/**
 * json.loads(s). Only the dict/non-dict/raises outcome is observable here
 * (`from_storage_row` swallows the error and keeps the raw string), so the
 * python-only literals NaN/Infinity/-Infinity are decoded instead of throwing;
 * the error TEXT itself never escapes.
 */
function pyJsonLoads(s: unknown): unknown {
    if (typeof s !== "string") {
        throw new TypeErrorP(
            `the JSON object must be str, bytes or bytearray, not ${pyTypeName(s)}`
        );
    }
    try {
        return JSON.parse(s);
    } catch {
        /* fall through to the python-literal handling below */
    }
    const revive = (x: unknown): unknown => {
        if (typeof x === "string") {
            if (x === "__NI__") return -Infinity;
            if (x === "__PI__") return Infinity;
            if (x === "__NA__") return NaN;
            return x;
        }
        if (Array.isArray(x)) return x.map(revive);
        if (isPyDict(x)) {
            const o: JsonDict = {};
            for (const k of Object.keys(x)) o[k] = revive((x as JsonDict)[k]);
            return o;
        }
        return x;
    };
    const t = s.trim();
    if (t === "NaN") return NaN;
    if (t === "Infinity") return Infinity;
    if (t === "-Infinity") return -Infinity;
    const patched = s
        .replace(/-Infinity/g, '"__NI__"')
        .replace(/\bInfinity\b/g, '"__PI__"')
        .replace(/\bNaN\b/g, '"__NA__"');
    try {
        return revive(JSON.parse(patched));
    } catch {
        throw new ValueErrorP("Expecting value: line 1 column 1 (char 0)");
    }
}

/** print(...) onto stdout, like CPython. */
function pyPrint(s: string): void {
    process.stdout.write(s + "\n");
}

function isThenable(v: unknown): v is Promise<unknown> {
    return (
        typeof v === "object" &&
        v !== null &&
        typeof (v as { then?: unknown }).then === "function"
    );
}

/** python `await x` on a non-awaitable raises TypeError (3.13 spelling). */
async function awaitPy(v: unknown): Promise<unknown> {
    if (isThenable(v)) return await v;
    throw new TypeErrorP(`object ${pyTypeName(v)} can't be used in 'await' expression`);
}

// ── 测试缝 ───────────────────────────────────────────────────────────────────

/** storage 上本单元用到的方法（运行时由 storage/domains 混入原型）。 */
export type CronStorage = {
    save_cron_job(job: JsonDict): void;
    get_cron_jobs(active?: boolean, include_stopped?: boolean): JsonDict[];
    update_cron_job(jid: string, fields: JsonDict): void;
    delete_cron_job(jid: string): void;
    _db(name: string): {
        execute(sql: string, params?: unknown[]): { fetchall(): JsonDict[] };
    };
};

/** what `_deliver_to_bot` needs from bot_remote's controller. */
export type CronBotController = {
    send_message(platform: string, user_id: string, text: string): unknown;
};

export const CRON_SEAMS = {
    /** python `time.time()` — 浮点秒。 */
    now: (): number => Date.now() / 1000,
    /** python `str(uuid.uuid4())`。 */
    uuid4: (): string => randomUUID(),
    /** python `from storage import get_storage`（构造期取值，源码 __init__ 语义）。 */
    get_storage: (): CronStorage => get_storage() as unknown as CronStorage,
    /**
     * python `from croniter import croniter; croniter(expr, now).get_next(float)`。
     * null ⇒ ModuleNotFoundError, driving the ImportError fallback branch.
     */
    croniterNext: ((expression: unknown, nowTs: number): number => {
        if (typeof expression !== "string") {
            throw new AttributeErrorP(
                `'${pyTypeName(expression)}' object has no attribute 'lower'`
            );
        }
        return new Croniter(expression, nowTs).get_next(Number);
    }) as ((expression: unknown, nowTs: number) => number) | null,
    /** python `from bot_remote import get_bot_controller` — the *import* only.
     *  The name is then called later, at python's own call site. A module that
     *  cannot be resolved is re-thrown as python's own error identity, exactly
     *  like `croniterNext` above does for croniter, so the loud delivery line
     *  carries the same text on both sides. */
    botModule: async (): Promise<{get_bot_controller: () => CronBotController}> => {
        try {
            return (await import("./bot_remote.js")) as unknown as {
                get_bot_controller: () => CronBotController;
            };
        } catch (e) {
            if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
                throw new ImportErrorP("No module named 'bot_remote'");
            }
            throw e;
        }
    },
    /** python `asyncio.sleep(seconds)`。 */
    sleep: (seconds: number): Promise<void> =>
        new Promise((resolve) => {
            setTimeout(resolve, seconds * 1000);
        }),
};

// ── CronStatus ───────────────────────────────────────────────────────────────

export class CronStatus {
    static readonly ACTIVE = "active";
    static readonly PAUSED = "paused";
    static readonly STOPPED = "stopped";
}

// ── CronJob ──────────────────────────────────────────────────────────────────

export interface CronJobOpts {
    prompt?: unknown;
    delay_minutes?: unknown;
    recurring?: unknown;
    max_runs?: unknown;
    bot_delivery_target?: unknown;
    session_id?: unknown;
}

/** python default-argument lookup: an omitted (or explicitly undefined) option
 *  takes the source's default, mirroring `cron_expr=None` == not passing it. */
function opt(opts: object, key: string, dflt: unknown): unknown {
    const v = (opts as JsonDict)[key];
    return v === undefined ? dflt : v;
}

export class CronJob {
    id: unknown;
    expression: unknown; // Cron expression: "*/5 * * * *"
    task_name: unknown;
    task_data: unknown;
    prompt: unknown;
    delay_minutes: unknown;
    recurring: unknown;
    max_runs: unknown;
    bot_delivery_target: unknown;
    session_id: unknown;
    status: unknown;
    created_at: unknown;
    last_run: unknown;
    next_run: unknown;
    run_count: number;

    constructor(
        expression: unknown = "",
        task_name: unknown = "",
        task_data: unknown = null,
        opts: CronJobOpts = {}
    ) {
        this.id = CRON_SEAMS.uuid4();
        this.expression = expression;
        this.task_name = task_name;
        this.task_data = pyOr(task_data, {});
        // Automation fields: cron OR delay, recurring, maxRuns, delivery.
        this.prompt = opt(opts, "prompt", null);
        this.delay_minutes = opt(opts, "delay_minutes", null);
        this.recurring = opt(opts, "recurring", true);
        this.max_runs = opt(opts, "max_runs", null);
        this.bot_delivery_target = opt(opts, "bot_delivery_target", null);
        this.session_id = opt(opts, "session_id", null);
        this.status = CronStatus.ACTIVE;
        this.created_at = CRON_SEAMS.now();
        this.last_run = 0.0;
        this.next_run = 0.0;
        this.run_count = 0;
    }

    /** Next run time from a cron expression OR a relative delay. */
    calculate_next_run(): number {
        if (
            !pyTruth(this.expression) &&
            this.delay_minutes !== null &&
            this.delay_minutes !== undefined
        ) {
            return CRON_SEAMS.now() + pyTimes60(this.delay_minutes);
        }
        let next: number;
        try {
            const fn = CRON_SEAMS.croniterNext;
            if (fn === null) throw new ImportErrorP("No module named 'croniter'");
            next = fn(this.expression, CRON_SEAMS.now());
        } catch (e) {
            if (e instanceof Error && e.name === "ImportError") {
                // Fallback: simplified calculation without croniter
                return this._fallbackNextRun();
            }
            throw e; // CroniterBad*/AttributeError propagate: the source catches ImportError only
        }
        return next;
    }

    private _fallbackNextRun(): number {
        const now = (): number => CRON_SEAMS.now();
        const parts = pySplitWhitespace(this.expression);
        if (parts.length !== 5) return now() + 3600; // Default: 1 hour
        // Check for */N step patterns in minute or hour
        for (let i = 0; i < Math.min(2, parts.length); i++) {
            const part = parts[i] as string;
            if (part.includes("/")) {
                try {
                    const step = pyIntStr(String(part.split("/")[1] ?? ""));
                    if (i === 0) return now() + step * 60; // minute field
                    else if (i === 1) return now() + step * 3600; // hour field
                } catch (e) {
                    if (!(e instanceof ValueErrorP)) throw e;
                    // pass — fail-open: 可选增强，失败不影响主流程
                }
            }
        }
        // No step pattern, default to next hour
        return now() + 3600;
    }

    should_run(): boolean | number {
        const now = CRON_SEAMS.now();
        // python `and` yields the first falsy operand: 0.0, not False.
        if (this.status !== CronStatus.ACTIVE) return false;
        if (!pyTruth(this.next_run)) return this.next_run as number;
        return now >= (this.next_run as number);
    }

    /** Record a run, reschedule, and auto-pause when maxRuns is reached. */
    mark_run(): void {
        this.last_run = CRON_SEAMS.now();
        this.run_count += 1;
        // maxRuns auto-pause.
        if (pyTruth(this.max_runs) && this.run_count >= Number(this.max_runs)) {
            this.status = CronStatus.PAUSED;
            this.next_run = 0.0;
            return;
        }
        // One-shot (delay-only, non-recurring) jobs stop after firing once.
        if (!pyTruth(this.recurring) && !pyTruth(this.expression)) {
            this.status = CronStatus.STOPPED;
            this.next_run = 0.0;
            return;
        }
        this.next_run = this.calculate_next_run();
    }

    to_dict(): JsonDict {
        return {
            id: this.id,
            expression: this.expression,
            task_name: this.task_name,
            task_data: this.task_data,
            prompt: this.prompt,
            delay_minutes: this.delay_minutes,
            recurring: this.recurring,
            max_runs: this.max_runs,
            bot_delivery_target: this.bot_delivery_target,
            status: this.status,
            created_at: this.created_at,
            last_run: this.last_run,
            next_run: this.next_run,
            run_count: this.run_count,
        };
    }

    /** Convert to storage.py field names (cron_jobs table schema). */
    to_storage_dict(): JsonDict {
        let bdt = this.bot_delivery_target;
        if (bdt !== null && bdt !== undefined && typeof bdt !== "string") {
            bdt = pyJsonDumps(bdt);
        }
        return {
            id: this.id,
            title: this.task_name,
            // prompt column carries the prompt string; when absent we fall
            // back to serialized task_data so nothing is lost.
            prompt:
                this.prompt !== null && this.prompt !== undefined
                    ? this.prompt
                    : pyJsonDumps(this.task_data),
            cron_expr: this.expression,
            delay_minutes: this.delay_minutes,
            recurring: pyTruth(this.recurring) ? 1 : 0,
            max_runs: this.max_runs,
            next_run_at: pyTruth(this.next_run) ? pyInt(this.next_run) : null,
            last_run_at: pyTruth(this.last_run) ? pyInt(this.last_run) : null,
            run_count: this.run_count,
            status: this.status,
            bot_delivery_target: bdt,
            session_id: this.session_id,
            created_at: pyInt(this.created_at),
        };
    }

    /** Create CronJob from storage.py row (cron_jobs table). */
    static from_storage_row(row: JsonDict): CronJob {
        const promptRaw = pyOr(dictGet(row, "prompt", ""), "");
        let prompt: unknown = null;
        let taskData: unknown = {};
        try {
            const parsed = pyTruth(promptRaw) ? pyJsonLoads(promptRaw) : {};
            if (isPyDict(parsed)) taskData = parsed;
            else prompt = promptRaw;
        } catch (e) {
            if (e instanceof ValueErrorP || e instanceof TypeErrorP) prompt = promptRaw;
            else throw e;
        }

        let bdt = dictGet(row, "bot_delivery_target");
        if (typeof bdt === "string" && pyTruth(bdt.trim().startsWith("{"))) {
            try {
                bdt = pyJsonLoads(bdt);
            } catch {
                // pass — fail-open: 可选增强，失败不影响主流程
            }
        }

        const job = new CronJob(
            pyOr(dictGet(row, "cron_expr", ""), ""),
            dictGet(row, "title", ""),
            taskData,
            {
                prompt,
                delay_minutes: dictGet(row, "delay_minutes"),
                recurring: pyTruth(dictGet(row, "recurring", 1)),
                max_runs: dictGet(row, "max_runs"),
                bot_delivery_target: bdt,
                session_id: dictGet(row, "session_id"),
            }
        );
        job.id = dictGet(row, "id", "");
        job.status = dictGet(row, "status", CronStatus.ACTIVE);
        job.created_at = pyOr(dictGet(row, "created_at", 0), 0);
        job.last_run = pyOr(dictGet(row, "last_run_at", 0), 0);
        job.next_run = pyOr(dictGet(row, "next_run_at", 0), 0);
        job.run_count = pyInt(pyOr(dictGet(row, "run_count", 0), 0));
        return job;
    }
}

function pyTimes60(delay: unknown): number {
    if (typeof delay === "boolean") return (delay ? 1 : 0) * 60;
    if (typeof delay === "number") return delay * 60;
    if (typeof delay === "string") {
        throw new TypeErrorP("unsupported operand type(s) for +: 'float' and 'str'");
    }
    throw new TypeErrorP(
        `unsupported operand type(s) for *: '${pyTypeName(delay)}' and 'int'`
    );
}

// ── CronManager ──────────────────────────────────────────────────────────────

export interface CreateCronOpts {
    cron_expr?: unknown;
    delay_minutes?: unknown;
    recurring?: unknown;
    max_runs?: unknown;
    bot_delivery_target?: unknown;
    task_name?: unknown;
    task_data?: unknown;
    session_id?: unknown;
}

export type CronHandler = (payload: JsonDict) => unknown;

/** Manage cron jobs with scheduling and execution. */
export class CronManager {
    storage: CronStorage;
    /** python `self._jobs: dict[str, CronJob]` (keyed by the raw id value). */
    _jobs = new Map<string, CronJob>();
    _running = false;
    /** python `self._task_handlers: dict[str, Callable]` */
    _task_handlers = new Map<string, CronHandler>();

    constructor() {
        this.storage = CRON_SEAMS.get_storage();
    }

    /** Register a task handler for a task type. */
    register_handler(task_name: unknown, handler: CronHandler): void {
        this._task_handlers.set(pyMapKey(task_name), handler);
    }

    /** python `handlers.get(name) or handlers.get("*")` */
    private _handlerFor(taskName: unknown): CronHandler | null {
        const direct = this._task_handlers.get(pyMapKey(taskName));
        if (pyTruth(direct)) return direct as CronHandler;
        const star = this._task_handlers.get(pyMapKey("*"));
        if (pyTruth(star)) return star as CronHandler;
        return null;
    }

    /** Create a new cron job (legacy positional API). */
    create_cron(expression: unknown, task_name: unknown, task_data: unknown = null): CronJob {
        const job = new CronJob(expression, task_name, task_data);
        job.next_run = job.calculate_next_run();
        // Use storage.py real API: save_cron_job
        this.storage.save_cron_job(job.to_storage_dict());
        this._jobs.set(pyMapKey(job.id), job);
        return job;
    }

    /**
     * Create a scheduled automation.
     *
     * Provide either `cron_expr` (5-field cron) or `delay_minutes` (relative
     * one-shot). `max_runs` auto-pauses after N fires; `bot_delivery_target`
     * routes the result to an IM chat. Returns a Result carrying the job dict,
     * or a failure when neither schedule is supplied.
     */
    create(title: unknown, prompt: unknown, opts: CreateCronOpts = {}): Result<JsonDict> {
        const cronExpr = opt(opts, "cron_expr", null);
        const delayMinutes = opt(opts, "delay_minutes", null);
        if (!pyTruth(cronExpr) && delayMinutes === null) {
            return Result.failure<JsonDict>("Provide either cron_expr or delay_minutes");
        }
        const job = new CronJob(pyOr(cronExpr, ""), pyOr(opt(opts, "task_name", null), title), opt(opts, "task_data", null), {
            prompt,
            delay_minutes: delayMinutes,
            recurring: opt(opts, "recurring", true),
            max_runs: opt(opts, "max_runs", null),
            bot_delivery_target: opt(opts, "bot_delivery_target", null),
            session_id: opt(opts, "session_id", null),
        });
        job.next_run = job.calculate_next_run();
        this.storage.save_cron_job(job.to_storage_dict());
        this._jobs.set(pyMapKey(job.id), job);
        return Result.success<JsonDict>(job.to_dict());
    }

    /** Get a single cron job by ID. */
    get_cron(cron_id: string): Result<JsonDict> {
        const allJobs = this.storage.get_cron_jobs(false);
        for (const row of allJobs) {
            if (dictGet(row, "id") === cron_id) {
                const job = CronJob.from_storage_row(row);
                return Result.success<JsonDict>(job.to_dict());
            }
        }
        return Result.failure<JsonDict>(`Cron job not found: ${cron_id}`);
    }

    /**
     * List all cron jobs, optionally filtered by status.
     *
     * §2 bug-for-bug: python computes `filtered` in the status branch and then
     * returns the UNFILTERED rows; the dead store is kept verbatim.
     */
    list_crons(status: unknown = null): JsonDict[] {
        let allRows: JsonDict[];
        if (pyTruth(status)) {
            allRows = this.storage.get_cron_jobs(false);
            const filtered = allRows.filter((r) => dictGet(r, "status") === status);
            void filtered; // python: assigned, never returned
        } else {
            allRows = this.storage.get_cron_jobs(false);
        }
        return allRows.map((r) => CronJob.from_storage_row(r).to_dict());
    }

    pause_cron(cron_id: string): Result<string> {
        return this._update_status(cron_id, CronStatus.PAUSED);
    }

    resume_cron(cron_id: string): Result<string> {
        const r = this._update_status(cron_id, CronStatus.ACTIVE);
        if (r.ok && this._jobs.has(pyMapKey(cron_id))) {
            const job = this._jobs.get(pyMapKey(cron_id)) as CronJob;
            job.next_run = job.calculate_next_run();
            this.storage.update_cron_job(cron_id, { next_run_at: pyInt(job.next_run) });
        }
        return r;
    }

    stop_cron(cron_id: string): Result<string> {
        return this._update_status(cron_id, CronStatus.STOPPED);
    }

    /** Delete cron job from storage and active manager cache. */
    delete_cron(cron_id: string): Result<string> {
        this.storage.delete_cron_job(cron_id);
        this._jobs.delete(pyMapKey(cron_id));
        return Result.success<string>(`Cron job ${cron_id} deleted`);
    }

    /** Update cron job status. */
    private _update_status(cron_id: string, status: string): Result<string> {
        this.storage.update_cron_job(cron_id, { status });
        if (this._jobs.has(pyMapKey(cron_id))) {
            (this._jobs.get(pyMapKey(cron_id)) as CronJob).status = status;
        }
        return Result.success<string>(`Status updated to ${status}`);
    }

    /** Start the scheduler loop. */
    async start_scheduler(): Promise<void> {
        this._running = true;
        await this._load_jobs();
        // §14 账本语义：上一进程死在任务执行中时，running_since 还挂着——
        // 开机如实标记"被打断"，而不是让账本沉默。
        try {
            const now = pyInt(CRON_SEAMS.now());
            const c = this.storage._db("cron");
            const rows = c.execute("SELECT id FROM cron_jobs WHERE running_since > 0").fetchall();
            for (const r of rows) {
                this.storage.update_cron_job(dictGet(r, "id") as string, {
                    running_since: 0,
                    last_error: `interrupted by restart (was running since ${now})`,
                });
            }
            if (pyTruth(rows)) {
                pyPrint(`[cron] marked ${rows.length} job(s) interrupted by restart`);
            }
        } catch (e) {
            pyPrint(`[cron] lease sweep skipped: ${pyStrExc(e)}`);
        }
        while (this._running) {
            for (const job of Array.from(this._jobs.values())) {
                if (pyTruth(job.should_run())) await this._execute_job(job);
            }
            await CRON_SEAMS.sleep(10);
        }
    }

    stop_scheduler(): void {
        this._running = false;
    }

    async _execute_job(job: CronJob): Promise<void> {
        // 执行租约（§10 overlap lock）：防双调度器重入，也让崩溃可判。
        this.storage.update_cron_job(job.id as string, {
            running_since: pyInt(CRON_SEAMS.now()),
        });
        let err = "";
        try {
            const handler = this._handlerFor(job.task_name);
            if (handler) {
                const payload: JsonDict = {
                    prompt: job.prompt,
                    task_data: job.task_data,
                    job_id: job.id,
                    bot_delivery_target: job.bot_delivery_target,
                };
                const result = await awaitPy(handler(payload));
                job.mark_run();
                // Persist run bookkeeping AND the (possibly auto-paused) status.
                this.storage.update_cron_job(job.id as string, {
                    last_run_at: pyInt(job.last_run),
                    next_run_at: pyTruth(job.next_run) ? pyInt(job.next_run) : 0,
                    run_count: job.run_count,
                    status: job.status,
                });
                if (pyTruth(job.bot_delivery_target)) await this._deliver_to_bot(job, result);
            } else {
                err = `no handler for task: ${pyStr(job.task_name)}`;
            }
        } catch (e) {
            err = pySliceStr(pyStrExc(e), 400);
        } finally {
            this.storage.update_cron_job(job.id as string, { running_since: 0, last_error: err });
        }
    }

    /** Route a cron result to an IM chat (best-effort delivery). */
    async _deliver_to_bot(job: CronJob, result: unknown): Promise<void> {
        try {
            // python's `from bot_remote import get_bot_controller` — the import
            // itself, BEFORE any target parsing, so a missing module is reported
            // even for a job with no usable delivery target.
            const mod = await CRON_SEAMS.botModule();
            if (typeof mod?.get_bot_controller !== "function") {
                throw new ImportErrorP(
                    "cannot import name 'get_bot_controller' from 'bot_remote'"
                );
            }
            const target = job.bot_delivery_target;
            let platform: unknown;
            let userId: unknown;
            if (isPyDict(target)) {
                platform = pyOr(dictGet(target, "provider"), dictGet(target, "platform", ""));
                userId = pyOr(dictGet(target, "providerUserId"), dictGet(target, "user_id", ""));
            } else {
                const [p, , u] = pyPartition(pyStr(target), ":");
                platform = p;
                userId = u;
            }
            if (pyTruth(platform) && pyTruth(userId)) {
                const text = `[Scheduled: ${pyStr(job.task_name)}]\n${pySliceStr(pyStr(result), 2000)}`;
                // python: `get_bot_controller().send_message(...)` at this point.
                const controller = mod.get_bot_controller();
                if (typeof controller?.send_message !== "function") {
                    throw new AttributeErrorP(
                        `'${pyTypeName(controller)}' object has no attribute 'send_message'`
                    );
                }
                await awaitPy(controller.send_message(pyStr(platform), pyStr(userId), text));
            }
        } catch (e) {
            // Delivery is best-effort; a missing/unconfigured bot must not crash
            // the scheduler loop. But a silent loss looks like "job ran, nothing
            // happened" — leave one loud line for whoever debugs it.
            pyPrint(
                `[cron] result delivery failed for job '${pyStr(job.task_name)}': ${pyStrExc(e)}`
            );
        }
    }

    /** Load active cron jobs from storage. */
    async _load_jobs(): Promise<void> {
        const activeRows = this.storage.get_cron_jobs(true);
        for (const row of activeRows) {
            const job = CronJob.from_storage_row(row);
            this._jobs.set(pyMapKey(job.id), job);
        }
    }
}

let _manager: CronManager | null = null;

export function get_cron_manager(): CronManager {
    if (_manager === null) _manager = new CronManager();
    return _manager;
}

/** 探针缝：rebinds python's module-level `_manager` singleton. */
export function _set_cron_manager_for_parity(v: CronManager | null): void {
    _manager = v;
}
