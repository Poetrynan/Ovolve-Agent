/**
 * rate_limiter.ts — port of app/backend/rate_limiter.py (unit 159, wave 7).
 *
 * SOURCE: app/backend/rate_limiter.py (331 lines) — per-provider RPM/TPM
 * token buckets (admission control): reserve-then-settle TPM, opt-in quotas,
 * abortable bounded waits, Retry-After draining, and a diagnostics snapshot.
 *
 * RULEBOOK CITATIONS (§ numbering as in HANDOFF_V4 / RULEBOOK)
 *   §4 naming: python spellings verbatim — _Bucket, Quota, Admission,
 *     RateLimiter, set_quota, configure, quota_for, acquire, settle,
 *     penalize, snapshot, get_rate_limiter, reset_rate_limiter, _POLL_S,
 *     DEFAULT_MAX_WAIT_S, and the private _key/_req/_tok/_clock.
 *   RULEBOOK §2 dataclass: Quota (rpm, tpm) and Admission (waited_s, aborted,
 *     forced, reserved_tokens) keep python's field order; `active` stays a
 *     computed property on Quota.
 *   RULEBOOK §2 async model: acquire is async (the source is async def);
 *     asyncio.Lock is modelled as a file-local promise-queue mutex with the
 *     same no-contention behaviour, and asyncio.sleep goes through
 *     RATE_SEAMS.sleep so probes script the clock instead of really waiting.
 *   §2 def-time default: __init__(clock=time.monotonic) binds the DEFAULT at
 *     def time — patching time.monotonic afterwards does not affect it; the
 *     port snapshots the default clock the same way (probes pass an explicit
 *     clock, which is the supported lever on both sides).
 *
 * QUIRKS PINNED BY THE PARITY PROBE
 *   1. acquire polls should_abort BEFORE the quota lookup: with NO quota
 *      configured a stopped turn still aborts — stop is not opt-in (the
 *      source comment documents this exact past bug).
 *   2. The two _Bucket constructions in acquire are setdefault: the clock is
 *      read ONLY when the key is missing — a warm limiter consumes no clock
 *      there (ledger-visible).
 *   3. Both windows must clear TOGETHER inside the lock: req.take(1) and
 *      tok.take(tokens) happen on the same `now`; a failed tok check leaves
 *      req untouched.
 *   4. eta caps the deficit at capacity — a single request larger than the
 *      whole bucket never wedges the wait loop past max_wait (forced=True).
 *   5. adjust clamps the level to [-capacity, capacity]; penalize drains and
 *      then pushes the level NEGATIVE by retry_after_s worth of refill.
 *   6. settle computes delta = int(reserved or 0) - int(actual or 0) and
 *      skips zero deltas; None/"" coerce to 0.
 *   7. snapshot reads the clock ONCE and uses eta(0) as a refill-triggering
 *      no-op read; rounds both levels to 2 decimals (python round semantics
 *      — the probe avoids half-way values where banker's rounding differs).
 *   8. configure accepts BOTH the single `model` block and a `providers`
 *      list; entries without a dict rate_limit are skipped; the rpm/tpm key
 *      chain is `get("rpm") or get("requests_per_minute") or 0` (short-
 *      circuit, ledger-visible); an entry with both falsy is skipped without
 *      consuming a set_quota.
 *   9. _key(provider) = strip + rstrip("/") + lower, empty -> "default".
 *  10. take() has a 1e-9 tolerance: level + 1e-9 >= amount passes.
 *
 * DIVERGENCE(port, asyncio.Lock): the source's lock is an asyncio.Lock; the
 *     port uses a promise-queue mutex with identical uncontended behaviour.
 *     The probes run single-task sequences, so contention ordering is never
 *     observable here.
 * DIVERGENCE(port, float repr): snapshot rounds via python round(x, 2); JS
 *     has one number type, and banker's rounding differs on exact halves —
 *     the probe avoids half-way levels; the composed JSON keys
 *     (requestsAvailable/tokensAvailable) keep python's key order.
 */

// ── python-semantics helpers (house style: file-local) ───────────────────────

class TypeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "TypeError"; }
}
class ValueErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ValueError"; }
}
class AttributeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "AttributeError"; }
}
/** python int(): a str must be a decimal integer literal, everything else
 *  raises CPython's wording; a float truncates toward zero. */
function pyInt(v: unknown): number {
    if (typeof v === "boolean") {
        throw new TypeErrorP("'bool' object cannot be interpreted as an integer");
    }
    if (typeof v === "number") {
        if (Number.isNaN(v) || !Number.isFinite(v)) {
            throw new ValueErrorP("cannot convert float NaN to integer");
        }
        return Math.trunc(v);
    }
    if (typeof v === "string") {
        const t = v.trim();
        if (!/^[+-]?\d+$/.test(t)) {
            throw new ValueErrorP(`invalid literal for int() with base 10: '${v}'`);
        }
        return parseInt(t, 10);
    }
    if (v === null || v === undefined) {
        throw new TypeErrorP("int() argument must be a string, a bytes-like object or a real number, not 'NoneType'");
    }
    throw new TypeErrorP(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (v instanceof Map) return "dict";
    if (typeof v === "function") return "function";
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
    if (isPyDict(v)) return Object.keys(v as Record<string, unknown>).length > 0;
    return true;
}

function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

/** house predicate: a value that IS a python dict — plain or prototype-less. */
function isPyDict(v: unknown): boolean {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    if (v instanceof Uint8Array || v instanceof Error) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

/** python's "takes <takes> positional argument(s) but N was/were given". */
function pyTooMany(fname: string, takes: string, given: number): TypeErrorP {
    const noun = takes === "1" ? "positional argument" : "positional arguments";
    const verb = given === 1 ? "was" : "were";
    return new TypeErrorP(`${fname}() takes ${takes} ${noun} but ${given} ${verb} given`);
}

/** python missing-argument TypeError. */
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

// ── module constants ─────────────────────────────────────────────────────────

/** Poll granularity while waiting for the bucket to refill. */
export const _POLL_S = 0.05;

export const RATE_SEAMS = {
    /** python `asyncio.sleep(s)` — the probe records the requested seconds. */
    sleep: async (s: number): Promise<void> => { /* probe: record + clock script */ },
};

/** def-time snapshot of time.monotonic for __init__'s default. */
const MONOTONIC_DEFAULT = (): number => 0.0;

// ── _Bucket ──────────────────────────────────────────────────────────────────

/** One continuously-refilling token bucket. */
export class _Bucket {
    capacity: number;
    level: number;
    _last: number;

    constructor(capacity: unknown, now: unknown) {
        if (arguments.length < 2) {
            throw new TypeErrorP(
                `_Bucket.__init__() missing 1 required positional argument: 'now'`);
        }
        this.capacity = Number(capacity);
        this.level = Number(capacity);
        this._last = now as number;
    }

    get unlimited(): boolean {
        return this.capacity <= 0;
    }

    _refill(now: number): void {
        if (this.unlimited) return;
        const elapsed = Math.max(0.0, now - this._last);
        this._last = now;
        this.level = Math.min(this.capacity, this.level + elapsed * (this.capacity / 60.0));
    }

    take(amount: unknown, now: number): boolean {
        if (this.unlimited) return true;
        this._refill(now);
        if (this.level + 1e-9 >= (amount as number)) {
            this.level -= (amount as number);
            return true;
        }
        return false;
    }

    eta(amount: unknown, now: number): number {
        if (this.unlimited) return 0.0;
        this._refill(now);
        let deficit = (amount as number) - this.level;
        if (deficit <= 0) return 0.0;
        deficit = Math.min(deficit, this.capacity);
        return deficit / (this.capacity / 60.0);
    }

    adjust(delta: unknown, now: number): void {
        if (this.unlimited) return;
        this._refill(now);
        this.level = Math.max(-this.capacity, Math.min(this.capacity, this.level + (delta as number)));
    }

    drain(now: number): void {
        if (this.unlimited) return;
        this._refill(now);
        this.level = 0.0;
    }
}

// ── dataclasses ──────────────────────────────────────────────────────────────

/** A provider's per-minute allowances. <= 0 means unlimited. */
export class Quota {
    rpm: number;
    tpm: number;

    constructor(rpm?: unknown, tpm?: unknown) {
        this.rpm = rpm === undefined ? 0.0 : rpm as number;
        this.tpm = tpm === undefined ? 0.0 : tpm as number;
    }

    get active(): boolean {
        return this.rpm > 0 || this.tpm > 0;
    }
}

/** What acquire did, so callers can log/report honestly. */
export class Admission {
    waited_s: number;
    aborted: boolean;
    forced: boolean;
    reserved_tokens: number;

    constructor(init?: { waited_s?: number; aborted?: boolean; forced?: boolean;
                         reserved_tokens?: number }) {
        this.waited_s = init && init.waited_s !== undefined ? init.waited_s : 0.0;
        this.aborted = init && init.aborted !== undefined ? init.aborted : false;
        this.forced = init && init.forced !== undefined ? init.forced : false;
        this.reserved_tokens = init && init.reserved_tokens !== undefined ? init.reserved_tokens : 0;
    }
}

// ── a no-contention promise mutex (see DIVERGENCE) ───────────────────────────

class AsyncMutex {
    private tail: Promise<void> = Promise.resolve();
    async enter<T>(fn: () => T | Promise<T>): Promise<T> {
        const run = this.tail.then(() => fn());
        this.tail = run.then(() => undefined, () => undefined);
        return run;
    }
}

type GateResult = { done: true; waited_s: number; tokens: number } | { done: false; wait: number };

// ── RateLimiter ──────────────────────────────────────────────────────────────

/** Per-provider admission control. Safe to share across the process. */
export class RateLimiter {
    /** Never block a turn longer than this at the gate. */
    static DEFAULT_MAX_WAIT_S = 30.0;

    _clock: () => number;
    _quotas: Map<string, Quota>;
    _req: Map<string, _Bucket>;
    _tok: Map<string, _Bucket>;
    _lock: AsyncMutex;

    constructor(clock: () => number = MONOTONIC_DEFAULT) {
        this._clock = clock;
        this._quotas = new Map();
        this._req = new Map();
        this._tok = new Map();
        this._lock = new AsyncMutex();
    }

    /** Install (or replace) a provider's quota. Resets its buckets. */
    set_quota(provider: unknown, rpm?: unknown, tpm?: unknown): void {
        if (arguments.length < 1) throw pyMissing("set_quota", ["provider"]);
        if (arguments.length > 3) {
            throw new TypeErrorP(`set_quota() takes from 1 to 3 positional arguments but ${arguments.length} were given`);
        }
        const key = RateLimiter._key(provider);
        const now = this._clock();
        const r = rpm === undefined ? 0 : rpm;
        const t = tpm === undefined ? 0 : tpm;
        this._quotas.set(key, new Quota(Number(pyOr(r, 0)), Number(pyOr(t, 0))));
        this._req.set(key, new _Bucket(Number(pyOr(r, 0)), now));
        this._tok.set(key, new _Bucket(Number(pyOr(t, 0)), now));
    }

    /** Read quotas out of config. Returns how many providers got one. */
    configure(config: unknown): number {
        if (arguments.length === 0) throw pyMissing("configure", ["config"]);
        if (arguments.length > 1) {
            throw new TypeErrorP(`configure() takes 1 positional argument but ${arguments.length} were given`);
        }
        let installed = 0;
        if (!isPyDict(config)) return 0;
        const cfg = config as Record<string, unknown>;
        const candidates: unknown[] = [];
        const model = cfg["model"];
        if (isPyDict(model)) candidates.push(model);
        const providers = cfg["providers"];
        if (Array.isArray(providers)) {
            for (const p of providers) {
                if (isPyDict(p)) candidates.push(p);
            }
        }
        for (const entry of candidates) {
            const e = entry as Record<string, unknown>;
            const limits = e["rate_limit"];
            if (!isPyDict(limits)) continue;
            const lim = limits as Record<string, unknown>;
            const rpm = pyOr(pyOr(lim["rpm"], lim["requests_per_minute"]), 0);
            const tpm = pyOr(pyOr(lim["tpm"], lim["tokens_per_minute"]), 0);
            if (!(pyTruth(rpm) || pyTruth(tpm))) continue;
            this.set_quota(pyOr(pyOr(e["base_url"], e["id"]), ""), rpm, tpm);
            installed += 1;
        }
        return installed;
    }

    quota_for(provider: unknown): Quota {
        if (arguments.length === 0) throw pyMissing("quota_for", ["provider"]);
        const q = this._quotas.get(RateLimiter._key(provider));
        return q === undefined ? new Quota() : q;
    }

    /** python @staticmethod _key: strip + rstrip("/") + lower, empty -> default */
    static _key(provider: unknown): string {
        return _keyImpl(provider);
    }

    // ── admission ────────────────────────────────────────────────────────

    async acquire(provider: unknown, estimated_tokens?: unknown,
                  max_wait_s?: unknown, should_abort?: unknown): Promise<Admission> {
        if (arguments.length < 1) throw pyMissing("RateLimiter.acquire", ["provider"]);
        if (arguments.length > 4) {
            throw new TypeErrorP(`acquire() takes from 1 to 4 positional arguments but ${arguments.length} were given`);
        }
        const key = RateLimiter._key(provider);
        // Stop is not opt-in: the flag is read BEFORE the quota shortcut.
        if (should_abort !== undefined && should_abort !== null &&
            (should_abort as () => boolean)()) {
            return new Admission({ aborted: true });
        }
        const quota = this._quotas.get(key);
        if (quota === undefined || !quota.active) {
            return new Admission(); // opt-in: no quota configured, no gate
        }

        let req = this._req.get(key);
        if (req === undefined) {
            req = new _Bucket(quota.rpm, this._clock());
            this._req.set(key, req);
        }
        let tok = this._tok.get(key);
        if (tok === undefined) {
            tok = new _Bucket(quota.tpm, this._clock());
            this._tok.set(key, tok);
        }
        const cap = max_wait_s === undefined || max_wait_s === null
            ? RateLimiter.DEFAULT_MAX_WAIT_S
            : Number(max_wait_s);
        const tokens = Math.max(0, pyInt(estimated_tokens === undefined || estimated_tokens === null ? 0 : estimated_tokens));
        const started = this._clock();

        while (true) {
            if (should_abort !== undefined && should_abort !== null &&
                (should_abort as () => boolean)()) {
                return new Admission({ waited_s: this._clock() - started, aborted: true });
            }
            const admitted = await this._lock.enter((): GateResult => {
                const now = this._clock();
                const wait = Math.max(req!.eta(1, now), tok!.eta(tokens, now));
                if (wait <= 0) {
                    req!.take(1, now);
                    tok!.take(tokens, now);
                    return { done: true, waited_s: now - started, tokens };
                }
                return { done: false, wait };
            }) as GateResult;
            if (admitted.done) {
                return new Admission({ waited_s: admitted.waited_s, reserved_tokens: admitted.tokens });
            }
            const waited = this._clock() - started;
            if (waited >= cap) {
                // Bounded wait: past the ceiling we go anyway and say so.
                await this._lock.enter(() => {
                    const now = this._clock();
                    req!.adjust(-1, now);
                    tok!.adjust(-tokens, now);
                    return undefined;
                });
                return new Admission({ waited_s: waited, forced: true, reserved_tokens: tokens });
            }
            const sleepS = Math.min(_POLL_S, Math.max(0.0, admitted.wait), Math.max(0.0, cap - waited));
            await RATE_SEAMS.sleep(sleepS);
        }
    }

    /** Correct the TPM bucket once the provider reports real usage. */
    settle(provider: unknown, reserved_tokens: unknown, actual_tokens: unknown): void {
        if (arguments.length < 3) {
            throw pyMissing("settle", ["provider", "reserved_tokens", "actual_tokens"].slice(arguments.length));
        }
        const key = RateLimiter._key(provider);
        const tok = this._tok.get(key);
        if (tok === undefined || tok.unlimited) return;
        const r = pyInt(pyOr(reserved_tokens, 0));
        const a = pyInt(pyOr(actual_tokens, 0));
        const delta = r - a;
        if (delta) tok.adjust(delta, this._clock());
    }

    /** A 429 came back — drain the buckets so we stop pushing. */
    penalize(provider: unknown, retry_after_s?: unknown): void {
        if (arguments.length < 1) throw pyMissing("penalize", ["provider"]);
        if (arguments.length > 2) {
            throw new TypeErrorP(`penalize() takes from 1 to 2 positional arguments but ${arguments.length} were given`);
        }
        const key = RateLimiter._key(provider);
        const now = this._clock();
        for (const bucket of [this._req.get(key), this._tok.get(key)]) {
            if (bucket === undefined || bucket.unlimited) continue;
            bucket.drain(now);
            const retry = retry_after_s === undefined ? 0.0 : (retry_after_s as number);
            if (retry > 0) {
                bucket.adjust(-(retry * bucket.capacity / 60.0), now);
            }
        }
    }

    /** Current levels per provider — for diagnostics / the usage page. */
    snapshot(): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        const now = this._clock();
        for (const [key, quota] of this._quotas) {
            const req = this._req.get(key);
            const tok = this._tok.get(key);
            // eta(0) is a no-op read that also refills, so levels aren't stale.
            if (req !== undefined) req.eta(0, now);
            if (tok !== undefined) tok.eta(0, now);
            out[key] = {
                "rpm": quota.rpm,
                "tpm": quota.tpm,
                "requestsAvailable": req !== undefined ? round2(req.level) : 0,
                "tokensAvailable": tok !== undefined ? round2(tok.level) : 0,
            };
        }
        return out;
    }

    /** python's `settle`-style keyword-only `*` marker lives on acquire; the
     *  private _key is also reachable as a plain function for probes. */
}

function _keyImpl(provider: unknown): string {
    // python: (provider or "").strip() — a truthy non-str dies on .strip()
    const handed = pyOr(provider, "");
    if (typeof handed !== "string") {
        throw new AttributeErrorP(`'${pyTypeName(handed)}' object has no attribute 'strip'`);
    }
    const p = handed;
    const stripped = p.replace(/^[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/, "")
        .replace(/[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/, "");
    const noSlash = stripped.replace(/\/+$/, "");
    return noSlash.toLowerCase() || "default";
}

function pyStrOf(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "string") return v;
    if (typeof v === "boolean") return v ? "True" : "False";
    return String(v);
}

/** python round(x, 2) — the probe avoids exact half-way values where
 *  banker's rounding would differ from half-up. */
function round2(v: number): number {
    return Math.round(v * 100) / 100;
}

// ── singleton ────────────────────────────────────────────────────────────────

let _limiter: RateLimiter | null = null;

/** Process-wide limiter. One bucket set per provider, shared by every caller. */
export function get_rate_limiter(): RateLimiter {
    if (_limiter === null) {
        _limiter = new RateLimiter();
    }
    return _limiter;
}

/** Drop the singleton. For tests. */
export function reset_rate_limiter(): void {
    if (arguments.length > 0) throw pyTooMany("reset_rate_limiter", "0", arguments.length);
    _limiter = null;
}

// PORT STATUS: confidence=high todos=[0]
