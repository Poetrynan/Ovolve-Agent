/**
 * messaging.ts — port of app/backend/messaging.py (unit 165, wave 7).
 *
 * SOURCE: app/backend/messaging.py (346 lines / 14,084 bytes / sha256_16
 * 785b63d7a2605668) — the two-layer message queue: steer / followUp /
 * nextTurn buckets with a high/low watermark backpressure, steer TTL expiry,
 * an atomic close/reopen inbox, a notifier event for blocking waits, and a
 * separate UI pending-send queue (`_items`) with stable ids, promote/reorder,
 * pause/resume and a resync snapshot. Zero app-side imports: the only host
 * touchpoints are the wall clock and the asyncio primitives.
 *
 * SEAM CENSUS (every host touchpoint, all routed through MESSAGING_SEAMS)
 *   clock (module-level `import time` binding)  -> MESSAGING_SEAMS.timeNow
 *       read once per send_message (timestamp), once per poll_steer (`now`,
 *       captured BEFORE the lock), never by the UI queue methods.
 *   clock (ui_enqueue's FUNCTION-LEVEL `import time`) -> MESSAGING_SEAMS.uiTimeNow
 *       read twice per ui_enqueue (the id's int(time*1000) first, then
 *       queuedAt) — a binding INDEPENDENT of the module attribute in python
 *       (see QUIRKS §11); defaults to the same wall clock.
 *   asyncio.Lock() construction  -> MESSAGING_SEAMS.makeLock
 *   asyncio.Event() construction -> MESSAGING_SEAMS.makeEvent
 *       (the notifier: set() on every admitted send_message, clear() at the
 *       top of wait_for_message, awaited in wait_for_message only)
 *   asyncio.wait_for             -> MESSAGING_SEAMS.waitfor
 *   network / subprocess / files / env / uuid / storage: NOT TOUCHED by the
 *       source module — nothing to seam (probes assert this via _integrity).
 *
 * RULEBOOK CITATIONS (§ numbering as in HANDOFF_V4 / RULEBOOK)
 *   §4 naming: python spellings verbatim — MessageQueue, QueuedMessage,
 *     DeliverAs, get_message_queue, send_message, submit_steer,
 *     close_steer_inbox, reopen_steer_inbox, steer_inbox_closed,
 *     is_steer_closed, poll_steer, is_steer_saturated, expired_steers,
 *     poll_follow_up, poll_next_turn, drain_all, has_pending,
 *     wait_for_message, ui_enqueue, ui_remove, ui_clear, ui_update_text,
 *     ui_promote, ui_reorder, ui_take_next, ui_pause, ui_resume,
 *     ui_snapshot, ui_pending, and the private fields _steer/_follow_up/
 *     _next_turn/_lock/_notifier/_expired_steers/_steer_saturated/
 *     _steer_closing/_items/_paused/_pause_reason/_seq (steer_protocol.ts
 *     binds `_steer`/`_notifier` duck-typed — the field names ARE a contract).
 *   RULEBOOK §2 dataclass: QueuedMessage keeps python's field names and
 *     vars() order (content, deliver_as, sender, timestamp, metadata);
 *     constructor arity errors carry CPython's wording incl. the
 *     self-inclusive "takes from 3 to 6" interval.
 *   RULEBOOK §2 Enum: DeliverAs becomes a class with singleton statics;
 *     DeliverAs(value) is DeliverAs.of() and raises ValueError with python's
 *     "'x' is not a valid DeliverAs" (repr'd value) wording; str() renders
 *     "DeliverAs.STEER" via toString.
 *   RULEBOOK §2 async model: async/await only where the source was async;
 *     asyncio.Lock is a promise-queue mutex (uncontended equivalence, same
 *     shape as rate_limiter.ts); asyncio.Event is a flag+waiters primitive;
 *     asyncio.wait_for goes through MESSAGING_SEAMS.waitfor (see DIVERGENCE).
 *   RULEBOOK §2 module-level mutable state: the `_queue` singleton is a
 *     module-scoped let with the same lazy initialisation.
 *   RULEBOOK §1 / AMEND-07: zero dependencies — node builtins only.
 *
 * QUIRKS PINNED BY THE PARITY PROBE
 *   1. The watermark raise happens AFTER the msg is built (the clock was
 *      already read) and BEFORE notifier.set() — the raise leaves
 *      _steer_saturated=True behind and the lock released, no event.set.
 *   2. poll_steer reads `now` BEFORE acquiring the lock: exactly one clock
 *      read per call even when the queue is empty.
 *   3. The saturation reset inside poll_steer runs on the POST-POP length
 *      (<= STEER_LOW_WATERMARK) per popped message; drain_all clears the
 *      buckets but NEVER resets _steer_saturated (a drained queue can stay
 *      "saturated" until the next poll walks it below the low watermark).
 *   4. is_steer_saturated = flag OR len>=30: the len term alone lights it up
 *      at exactly 30 queued steers without any raise.
 *   5. Expiry needs ALL THREE of ttl_s > 0, msg.timestamp truthy, and
 *      (now - timestamp) > ttl_s: a message stamped 0.0 NEVER expires, a
 *      ttl of 0 or negative never expires, and age exactly == ttl is fresh.
 *   6. deliver_as that is neither a str nor a DeliverAs member (5, None)
 *      SKIPS the conversion, matches neither STEER nor FOLLOW_UP and falls
 *      into the else arm -> _next_turn with the raw value stored.
 *   7. An invalid string deliver_as raises ValueError from the DeliverAs
 *      conversion BEFORE the msg is constructed — no clock read, no event.
 *   8. wait_for_message clears the notifier FIRST (wiping any pre-existing
 *      set) and only then waits; asyncio.TimeoutError -> None, any other
 *      error propagates (the catch is narrow); the SUCCESS PATH IS DEAD:
 *      python's `return await self.drain_all()[0] if self.has_pending() ...`
 *      subscripts the drain_all() coroutine before awaiting it, so a pending
 *      message yields TypeError("'coroutine' object is not subscriptable")
 *      and the drain NEVER runs — reproduced bug-for-bug (BUG(port), QUIRK
 *      §8/f09); with nothing pending it returns None.
 *   9. wait_for_message's `if timeout:` is a TRUTHINESS test: None and 0
 *      both take the un-timed arm (asyncio.wait_for is never called).
 *  10. close_steer_inbox is close_if_empty semantics: a non-empty bucket
 *      returns False WITHOUT setting _steer_closing; once closed, an
 *      incoming steer is atomically downgraded into _follow_up (the
 *      returned msg's deliver_as is MUTATED to FOLLOW_UP).
 *  11. ui_enqueue re-imports time at function level: it reads
 *      sys.modules["time"], NOT the module attribute — patching
 *      messaging.time leaves ui_enqueue on the real clock. The port keeps
 *      the two bindings as independent seams (timeNow / uiTimeNow).
 *  12. ui_enqueue consumes the clock TWICE (id first, queuedAt second) and
 *      does NOT touch the notifier; the item key order is id, text,
 *      delivery, queuedAt, requested, fallbackReason.
 *  13. ui_reorder materialises duplicates: an id repeated in ordered_ids
 *      appears twice in _items (the SAME item object, aliased); unknown ids
 *      are skipped; untouched items keep their original relative order at
 *      the tail.
 *  14. ui_promote is a no-op for idx 0 (already front) and -1 (not found);
 *      ui_update_text rewrites only the FIRST match.
 *  15. ui_snapshot shallow-copies every item dict and preserves the
 *      items/paused/pauseReason key order.
 *  16. poll_steer/drain_all hand back the LIVE message objects (identity
 *      preserved), and drain_all returns steer+followUp+nextTurn in that
 *      fixed priority order.
 *  17. poll_steer's ttl default is bound at def time: patching the module
 *      constant STEER_TTL_S does not change the default of an existing run.
 *
 * MIGRATION DECISIONS / DIVERGENCES
 *   DIVERGENCE(port, **kwargs bag): python's send_message/submit_steer
 *       collect extra KEYWORD args into `metadata`; a 4th (5th for
 *       submit_steer) POSITIONAL arg would raise TypeError. The port's 4th
 *       parameter IS the metadata bag (keyword calls map 1:1); a caller
 *       passing a dict positionally would get it stored as metadata instead
 *       of TypeError. No production call site passes >=4 positionals
 *       (router.py/admission.py/http_server.py call keyword-style or with <=3
 *       positionals — grepped); the >=5-argument overflow IS still rejected
 *       with python's wording. Scenarios pin the keyword-call surface only.
 *   DIVERGENCE(port, asyncio.Lock): a promise-queue mutex with identical
 *       uncontended behaviour; the probes run single-task sequences, so
 *       contention ordering is never observable.
 *   DIVERGENCE(port, asyncio.Event microtask shape): python's Event.wait()
 *       on an already-set flag completes inline (no loop hop); the port's
 *       wait() returns a resolved Promise (one microtask). Ledger-visible
 *       facts (call order of set/clear/wait and their arguments) are
 *       identical; only interleaving with OTHER coroutines could observe
 *       the difference, and the probes script the event explicitly.
 *   DIVERGENCE(port, wait_for cancellation): python's asyncio.wait_for
 *       cancels the inner coroutine on timeout; MESSAGING_SEAMS.waitfor
 *       races a timer and leaves the loser pending. Unobservable here: the
 *       awaited wait() has no cleanup, and the timeout arm returns without
 *       inspecting the abandoned waiter (same disposition as moa.ts).
 *   DIVERGENCE(port, dataclass surface): QueuedMessage.__repr__/__eq__ are
 *       not reproduced — no consumer prints or ==-compares it (grepped
 *       router.py / router_modules/admission.py / server/http_server.py /
 *       steer_protocol.py); the probe compares field projections.
 *   DIVERGENCE(port, typed comparisons): `ttl_s > 0` and
 *       `now - timestamp > ttl_s` are modelled as numeric comparisons; a
 *       python caller passing a non-numeric ttl_s would get TypeError
 *       where JS yields false. No caller passes one (admission.py calls
 *       poll_steer() bare); the scripted probe covers int/float ttls.
 *   DIVERGENCE(port, id equality): the ui_* id comparisons use JS strict
 *       equality; python's == would equate 1 and True across types. Ids are
 *       strings by construction (ui_enqueue mints "q<seq>-<ms>").
 *   DIVERGENCE(port, import firewall): python-side probes guard the
 *       function-level `import time` via sys.modules; TS has no import
 *       machinery to firewall — the uiTimeNow seam IS the binding.
 *   DIVERGENCE(port, bool/int ids in set-membership): ui_reorder's
 *       `not in set(ordered_ids)` uses a JS Set (SameValueZero); python's
 *       set would equate 1 with True. Ids are strings by construction.
 */

// ── python-semantics helpers (house style: file-local) ───────────────────────

class TypeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "TypeError"; }
}
class ValueErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ValueError"; }
}
/** python asyncio.TimeoutError (== builtin TimeoutError on 3.11+): str() "". */
class TimeoutErrorP extends Error {
    constructor() { super(""); this.name = "TimeoutError"; }
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

/** python repr() of a value as used inside the enum ValueError. */
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

function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return String(v);
    if (typeof v === "string") return v;
    return String(v);
}

/** python int(): only the float-truncation path is reachable here (the clock
 *  milliseconds), but the full wording surface is kept for fidelity. */
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

/** python's "takes <takes> positional argument(s) but N was/were given". */
function pyTooMany(fname: string, takes: string, given: number): TypeErrorP {
    const noun = takes === "1" ? "positional argument" : "positional arguments";
    const verb = given === 1 ? "was" : "were";
    return new TypeErrorP(`${fname}() takes ${takes} ${noun} but ${given} ${verb} given`);
}

/** interval form CPython uses when some parameters have defaults (self counts). */
function pyTooManyRange(fname: string, min: number, max: number, given: number): TypeErrorP {
    const noun = max === 1 ? "positional argument" : "positional arguments";
    const verb = given === 1 ? "was" : "were";
    return new TypeErrorP(`${fname}() takes from ${min} to ${max} ${noun} but ${given} ${verb} given`);
}

// ── module constants ─────────────────────────────────────────────────────────

/** A steer message goes stale after this many seconds. */
export const STEER_TTL_S = 300.0;
/** def-time snapshot of poll_steer's default (python binds the default when
 *  the def runs — patching the module constant does not change it). */
const STEER_TTL_S_DEF = STEER_TTL_S;
/** Steer 队列高低水位背压：超过 30 条拒绝入队，排空至 15 条以下恢复。 */
export const STEER_HIGH_WATERMARK = 30;
export const STEER_LOW_WATERMARK = 15;
/** One drain may inject at most this many characters (consumed by router). */
export const MAX_STEER_MERGED_CHARS = 24_000;

// ── asyncio primitives (see DIVERGENCE) ──────────────────────────────────────

/** python asyncio.Lock stand-in: a no-contention promise mutex. */
class AsyncLock {
    private tail: Promise<void> = Promise.resolve();
    enter<T>(fn: () => T | Promise<T>): Promise<T> {
        const run = this.tail.then(() => fn());
        this.tail = run.then(() => undefined, () => undefined);
        return run;
    }
}

/** python asyncio.Event stand-in: flag + waiters, wait() resolves True. */
class AsyncEvent {
    private flag = false;
    private waiters: Array<() => void> = [];
    set(): void {
        this.flag = true;
        const ws = this.waiters.splice(0);
        for (const w of ws) w();
    }
    clear(): void { this.flag = false; }
    is_set(): boolean { return this.flag; }
    wait(): PromiseLike<boolean> {
        if (this.flag) return Promise.resolve(true);
        return new Promise<boolean>((res) => { this.waiters.push(() => res(true)); });
    }
}

interface LockLike {
    enter<T>(fn: () => T | Promise<T>): Promise<T>;
}
interface EventLike {
    set(): void;
    clear(): void;
    wait(): unknown;
}

export const MESSAGING_SEAMS = {
    /** python module-level `import time` binding — time.time(). */
    timeNow: (): number => Date.now() / 1000,
    /** python ui_enqueue's FUNCTION-LEVEL `import time` binding — an
     *  independent reference to the time module (QUIRK §11); defaults to the
     *  same wall clock. */
    uiTimeNow: (): number => Date.now() / 1000,
    /** python asyncio.Lock() constructor. */
    makeLock: (): LockLike => new AsyncLock(),
    /** python asyncio.Event() constructor. */
    makeEvent: (): EventLike => new AsyncEvent(),
    /** python asyncio.wait_for(aw, timeout) — a genuinely suspending aw races
     *  the timeout timer; a synchronous result passes through. */
    waitfor: (aw: unknown, timeout: unknown): unknown => {
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
};

// ── DeliverAs ────────────────────────────────────────────────────────────────

/** python `class DeliverAs(Enum)` — singleton members, value lookup by
 *  DeliverAs.of(), CPython's ValueError wording on a miss. */
export class DeliverAs {
    readonly name: string;
    readonly value: string;

    constructor(name: string, value: string) {
        this.name = name;
        this.value = value;
    }

    static readonly STEER = new DeliverAs("STEER", "steer");
    static readonly FOLLOW_UP = new DeliverAs("FOLLOW_UP", "followUp");
    static readonly NEXT_TURN = new DeliverAs("NEXT_TURN", "nextTurn");

    /** python DeliverAs(value): members pass through, strings match by VALUE
     *  (never by name), anything else raises the repr'd ValueError. */
    static of(v: unknown): DeliverAs {
        if (v instanceof DeliverAs) return v;
        if (typeof v === "string") {
            if (v === "steer") return DeliverAs.STEER;
            if (v === "followUp") return DeliverAs.FOLLOW_UP;
            if (v === "nextTurn") return DeliverAs.NEXT_TURN;
        }
        throw new ValueErrorP(`${pyRepr(v)} is not a valid DeliverAs`);
    }

    /** python str(member) -> "DeliverAs.STEER". */
    toString(): string { return `DeliverAs.${this.name}`; }
}

// ── QueuedMessage ────────────────────────────────────────────────────────────

/** 队列中的消息（python @dataclass；字段顺序即 vars() 顺序）。 */
export class QueuedMessage {
    content: unknown;
    deliver_as: unknown;
    sender: unknown;
    timestamp: unknown;
    metadata: unknown;

    constructor(content?: unknown, deliver_as?: unknown, sender?: unknown,
                timestamp?: unknown, metadata?: unknown) {
        // python dataclass __init__ arity: 2 required + 3 defaulted; CPython
        // counts SELF in the interval wording ("takes from 3 to 6").
        const n = arguments.length;
        if (n < 2) {
            throw pyMissing("QueuedMessage.__init__",
                n === 0 ? ["content", "deliver_as"] : ["deliver_as"]);
        }
        if (n > 5) throw pyTooManyRange("QueuedMessage.__init__", 3, 6, n + 1);
        this.content = content;
        this.deliver_as = deliver_as;
        this.sender = sender === undefined ? "user" : sender;
        this.timestamp = timestamp === undefined ? 0.0 : timestamp;
        // field(default_factory=dict): a FRESH dict per instance.
        this.metadata = metadata === undefined ? {} : metadata;
    }
}

// ── MessageQueue ─────────────────────────────────────────────────────────────

/** 双层消息队列：steer / followUp / nextTurn 三档 + UI 待发送队列。 */
export class MessageQueue {
    _steer: QueuedMessage[];
    _follow_up: QueuedMessage[];
    _next_turn: QueuedMessage[];
    _lock: LockLike;
    _notifier: EventLike;
    _expired_steers: number;
    _steer_saturated: boolean;
    _steer_closing: boolean;
    _items: Array<Record<string, unknown>>;
    _paused: boolean;
    _pause_reason: unknown;
    _seq: number;

    constructor() {
        if (arguments.length > 0) {
            throw pyTooMany("MessageQueue.__init__", "1", arguments.length + 1);
        }
        this._steer = [];
        this._follow_up = [];
        this._next_turn = [];
        this._lock = MESSAGING_SEAMS.makeLock();
        this._notifier = MESSAGING_SEAMS.makeEvent();
        this._expired_steers = 0;
        this._steer_saturated = false;
        this._steer_closing = false;
        this._items = [];
        this._paused = false;
        this._pause_reason = null;
        this._seq = 0;
    }

    /** 发送消息到指定队列。extra kwargs land in msg.metadata (see DIVERGENCE). */
    async send_message(content: unknown, deliver_as?: unknown, sender?: unknown,
                       metadata?: unknown): Promise<QueuedMessage> {
        if (arguments.length < 1) throw pyMissing("MessageQueue.send_message", ["content"]);
        if (arguments.length > 4) {
            throw pyTooManyRange("MessageQueue.send_message", 2, 4, arguments.length + 1);
        }
        let da = deliver_as === undefined ? DeliverAs.FOLLOW_UP : deliver_as;
        const snd = sender === undefined ? "user" : sender;
        const md = metadata === undefined ? {} : metadata;
        if (typeof da === "string") da = DeliverAs.of(da);

        const msg = new QueuedMessage(content, da, snd, MESSAGING_SEAMS.timeNow(), md);

        await this._lock.enter((): undefined => {
            if (da === DeliverAs.STEER) {
                if (this._steer_closing) {
                    // 收件箱正在收尾关闭：原子降级并入 followUp 桶
                    msg.deliver_as = DeliverAs.FOLLOW_UP;
                    this._follow_up.push(msg);
                } else {
                    if (this._steer.length >= STEER_HIGH_WATERMARK) {
                        this._steer_saturated = true;
                        throw new ValueErrorP(
                            `转向过多，请等待排空（当前已达高水位 ${this._steer.length}/${STEER_HIGH_WATERMARK} 条限制）`);
                    }
                    this._steer.push(msg);
                }
            } else if (da === DeliverAs.FOLLOW_UP) {
                this._follow_up.push(msg);
            } else {
                this._next_turn.push(msg);
            }
            this._notifier.set();
            return undefined;
        });
        return msg;
    }

    /** 发送转向/纠偏消息到 steer 队列（若收尾关闭则自动降级到 followUp）。 */
    async submit_steer(content: unknown, sender?: unknown,
                       metadata?: unknown): Promise<QueuedMessage> {
        if (arguments.length < 1) throw pyMissing("MessageQueue.submit_steer", ["content"]);
        if (arguments.length > 3) {
            throw pyTooManyRange("MessageQueue.submit_steer", 2, 3, arguments.length + 1);
        }
        const snd = sender === undefined ? "user" : sender;
        const md = metadata === undefined ? {} : metadata;
        return await this.send_message(content, DeliverAs.STEER, snd, md);
    }

    /** 原子关闭 steer 收件（close_if_empty 语义）。 */
    async close_steer_inbox(): Promise<boolean> {
        if (arguments.length > 0) {
            throw pyTooMany("MessageQueue.close_steer_inbox", "1", arguments.length + 1);
        }
        return await this._lock.enter((): boolean => {
            if (!pyTruth(this._steer)) {
                this._steer_closing = true;
                return true;
            }
            return false;
        });
    }

    /** 新一轮 run 开始时重置 steer 收件状态。 */
    async reopen_steer_inbox(): Promise<undefined> {
        if (arguments.length > 0) {
            throw pyTooMany("MessageQueue.reopen_steer_inbox", "1", arguments.length + 1);
        }
        await this._lock.enter((): undefined => {
            this._steer_closing = false;
            return undefined;
        });
        return undefined;
    }

    /** 查询 steer 收件箱是否已关闭。 */
    steer_inbox_closed(): boolean {
        if (arguments.length > 0) {
            throw pyTooMany("MessageQueue.steer_inbox_closed", "1", arguments.length + 1);
        }
        return this._steer_closing;
    }

    /** 属性访问支持：steer 收件箱是否处于关闭状态。 */
    get is_steer_closed(): boolean {
        return this._steer_closing;
    }

    /** 检查 steer 队列（Agent 循环每次迭代前调用）。 */
    async poll_steer(ttl_s?: unknown): Promise<QueuedMessage | null> {
        if (arguments.length > 1) {
            throw pyTooManyRange("MessageQueue.poll_steer", 1, 2, arguments.length + 1);
        }
        const ttl = ttl_s === undefined ? STEER_TTL_S_DEF : ttl_s;
        const now = MESSAGING_SEAMS.timeNow(); // read BEFORE the lock (QUIRK §2)
        return await this._lock.enter((): QueuedMessage | null => {
            while (this._steer.length > 0) {
                const msg = this._steer.shift() as QueuedMessage;
                if (this._steer.length <= STEER_LOW_WATERMARK) {
                    this._steer_saturated = false;
                }
                const expired = (ttl as number) > 0
                    && pyTruth(msg.timestamp)
                    && now - (msg.timestamp as number) > (ttl as number);
                if (expired) {
                    this._expired_steers += 1;
                    continue;
                }
                return msg;
            }
            this._steer_saturated = false;
            return null;
        });
    }

    /** 是否处于转向饱和状态（高于高水位触发，降至低水位以下复位）。 */
    get is_steer_saturated(): boolean {
        return this._steer_saturated || this._steer.length >= STEER_HIGH_WATERMARK;
    }

    /** TTL 丢弃过多少条 steer —— 给诊断面板看，也便于自测断言。 */
    get expired_steers(): number {
        return this._expired_steers;
    }

    /** 检查 followUp 队列（Agent 本轮结束后调用）。 */
    async poll_follow_up(): Promise<QueuedMessage | null> {
        if (arguments.length > 0) {
            throw pyTooMany("MessageQueue.poll_follow_up", "1", arguments.length + 1);
        }
        return await this._lock.enter((): QueuedMessage | null => {
            const m = this._follow_up.shift();
            return m === undefined ? null : m;
        });
    }

    /** 检查 nextTurn 队列。 */
    async poll_next_turn(): Promise<QueuedMessage | null> {
        if (arguments.length > 0) {
            throw pyTooMany("MessageQueue.poll_next_turn", "1", arguments.length + 1);
        }
        return await this._lock.enter((): QueuedMessage | null => {
            const m = this._next_turn.shift();
            return m === undefined ? null : m;
        });
    }

    /** 取出所有队列中的消息（按优先级 steer > followUp > nextTurn）。 */
    async drain_all(): Promise<QueuedMessage[]> {
        if (arguments.length > 0) {
            throw pyTooMany("MessageQueue.drain_all", "1", arguments.length + 1);
        }
        return await this._lock.enter((): QueuedMessage[] => {
            const msgs = [...this._steer, ...this._follow_up, ...this._next_turn];
            this._steer.length = 0;
            this._follow_up.length = 0;
            this._next_turn.length = 0;
            return msgs;
        });
    }

    /** 是否有待处理消息。 */
    has_pending(): boolean {
        if (arguments.length > 0) {
            throw pyTooMany("MessageQueue.has_pending", "1", arguments.length + 1);
        }
        return pyTruth(this._steer) || pyTruth(this._follow_up) || pyTruth(this._next_turn);
    }

    /** 阻塞等待新消息（用于 Bot 远程控制等场景）。 */
    async wait_for_message(timeout?: unknown): Promise<QueuedMessage | null> {
        if (arguments.length > 1) {
            throw pyTooManyRange("MessageQueue.wait_for_message", 1, 2, arguments.length + 1);
        }
        const t = timeout === undefined ? null : timeout;
        this._notifier.clear();
        try {
            if (pyTruth(t)) {
                const r = MESSAGING_SEAMS.waitfor(this._notifier.wait(), t);
                if (r instanceof Promise) await r;
            } else {
                await (this._notifier.wait() as PromiseLike<unknown>);
            }
        } catch (e) {
            // python catches asyncio.TimeoutError (== builtin TimeoutError on
            // 3.11+); JS has no builtin TimeoutError class, so the narrow
            // catch matches the port's own class AND any Error NAMED
            // TimeoutError (the probe raises the builtin stand-in shape).
            if (e instanceof TimeoutErrorP || (e instanceof Error && e.name === "TimeoutError")) return null;
            throw e;
        }
        if (this.has_pending()) {
            // BUG(port): reproduced upstream defect. python line 239 is
            // `return await self.drain_all()[0] if self.has_pending() else None`
            // where the subscript binds BEFORE the await: drain_all()'s
            // coroutine is created, immediately SUBSCRIPTED (TypeError
            // "'coroutine' object is not subscriptable") and never awaited —
            // its body never runs, the queues stay untouched, and the
            // coroutine leaks as a RuntimeWarning. wait_for_message can
            // therefore NEVER return a message; any caller relying on it
            // (bot remote control) hits this TypeError today. Repro:
            // await mq.send_message("s", "steer"); await
            // mq.wait_for_message(1.0) -> TypeError, has_pending() still True.
            throw new TypeErrorP("'coroutine' object is not subscriptable");
        }
        return null;
    }

    // ── UI 待发送队列（桌面端"待发送 N 条"面板的单一事实来源）────────────

    /** 入队一条待发送 prompt。``urgent`` 插到队首（插队）。 */
    async ui_enqueue(text: unknown, urgent?: unknown, requested?: unknown,
                     reason?: unknown): Promise<Record<string, unknown>> {
        if (arguments.length < 1) throw pyMissing("MessageQueue.ui_enqueue", ["text"]);
        if (arguments.length > 4) {
            throw pyTooManyRange("MessageQueue.ui_enqueue", 2, 5, arguments.length + 1);
        }
        const urg = urgent === undefined ? false : urgent;
        const req = requested === undefined ? "" : requested;
        const rsn = reason === undefined ? "" : reason;
        return await this._lock.enter((): Record<string, unknown> => {
            this._seq += 1;
            const admitted = pyTruth(urg) ? "steer" : "queue";
            const item: Record<string, unknown> = {};
            item["id"] = `q${this._seq}-${pyInt(MESSAGING_SEAMS.uiTimeNow() * 1000)}`;
            item["text"] = text;
            item["delivery"] = admitted;
            item["queuedAt"] = MESSAGING_SEAMS.uiTimeNow();
            // 用户要的那一档。没传就等于"就是要排队"，不算降级。
            item["requested"] = pyOr(req, admitted);
            // 空串 = 没什么要解释的，前端据此决定要不要显示那行小字。
            item["fallbackReason"] = pyOr(rsn, "");
            if (pyTruth(urg)) {
                this._items.unshift(item);
            } else {
                this._items.push(item);
            }
            return item;
        });
    }

    async ui_remove(item_id: unknown): Promise<undefined> {
        if (arguments.length < 1) throw pyMissing("MessageQueue.ui_remove", ["item_id"]);
        if (arguments.length > 1) {
            throw pyTooMany("MessageQueue.ui_remove", "1", arguments.length + 1);
        }
        await this._lock.enter((): undefined => {
            this._items = this._items.filter((i) => i["id"] !== item_id);
            return undefined;
        });
        return undefined;
    }

    async ui_clear(): Promise<undefined> {
        if (arguments.length > 0) {
            throw pyTooMany("MessageQueue.ui_clear", "1", arguments.length + 1);
        }
        await this._lock.enter((): undefined => {
            this._items.length = 0;
            return undefined;
        });
        return undefined;
    }

    async ui_update_text(item_id: unknown, text: unknown): Promise<undefined> {
        if (arguments.length < 2) {
            throw pyMissing("MessageQueue.ui_update_text",
                arguments.length === 0 ? ["item_id", "text"] : ["text"]);
        }
        if (arguments.length > 2) {
            throw pyTooMany("MessageQueue.ui_update_text", "2", arguments.length + 1);
        }
        await this._lock.enter((): undefined => {
            for (const i of this._items) {
                if (i["id"] === item_id) {
                    i["text"] = text;
                    break;
                }
            }
            return undefined;
        });
        return undefined;
    }

    /** 把某条移到队首，让它成为下一个要发的。 */
    async ui_promote(item_id: unknown): Promise<undefined> {
        if (arguments.length < 1) throw pyMissing("MessageQueue.ui_promote", ["item_id"]);
        if (arguments.length > 1) {
            throw pyTooMany("MessageQueue.ui_promote", "1", arguments.length + 1);
        }
        await this._lock.enter((): undefined => {
            const idx = this._items.findIndex((i) => i["id"] === item_id);
            if (idx > 0) {
                const it = this._items.splice(idx, 1)[0] as Record<string, unknown>;
                this._items.unshift(it);
            }
            return undefined;
        });
        return undefined;
    }

    /** 按客户端拖拽后的 id 顺序重排。未出现的项保持原相对次序追加在后。 */
    async ui_reorder(ordered_ids: unknown): Promise<undefined> {
        if (arguments.length < 1) throw pyMissing("MessageQueue.ui_reorder", ["ordered_ids"]);
        if (arguments.length > 1) {
            throw pyTooMany("MessageQueue.ui_reorder", "1", arguments.length + 1);
        }
        if (!Array.isArray(ordered_ids) && typeof ordered_ids !== "string") {
            throw new TypeErrorP(`'${pyTypeName(ordered_ids)}' object is not iterable`);
        }
        await this._lock.enter((): undefined => {
            const byId = new Map<unknown, Record<string, unknown>>();
            for (const i of this._items) byId.set(i["id"], i);
            const reordered: Array<Record<string, unknown>> = [];
            for (const x of ordered_ids as unknown[]) {
                if (byId.has(x)) reordered.push(byId.get(x) as Record<string, unknown>);
            }
            const wanted = new Set<unknown>(ordered_ids as unknown[]);
            const leftover = this._items.filter((i) => !wanted.has(i["id"]));
            this._items = reordered.concat(leftover);
            return undefined;
        });
        return undefined;
    }

    /** 取出队首（暂停时返回 None）。 */
    async ui_take_next(): Promise<Record<string, unknown> | null> {
        if (arguments.length > 0) {
            throw pyTooMany("MessageQueue.ui_take_next", "1", arguments.length + 1);
        }
        return await this._lock.enter((): Record<string, unknown> | null => {
            if (this._paused || this._items.length === 0) return null;
            return this._items.shift() as Record<string, unknown>;
        });
    }

    async ui_pause(reason?: unknown): Promise<undefined> {
        if (arguments.length > 1) {
            throw pyTooManyRange("MessageQueue.ui_pause", 1, 2, arguments.length + 1);
        }
        const rsn = reason === undefined ? "manual" : reason;
        await this._lock.enter((): undefined => {
            this._paused = true;
            this._pause_reason = rsn;
            return undefined;
        });
        return undefined;
    }

    async ui_resume(): Promise<undefined> {
        if (arguments.length > 0) {
            throw pyTooMany("MessageQueue.ui_resume", "1", arguments.length + 1);
        }
        await this._lock.enter((): undefined => {
            this._paused = false;
            this._pause_reason = null;
            return undefined;
        });
        return undefined;
    }

    /** 当前队列快照 —— 新连接/刷新后的客户端用它重建 UI。 */
    ui_snapshot(): Record<string, unknown> {
        if (arguments.length > 0) {
            throw pyTooMany("MessageQueue.ui_snapshot", "1", arguments.length + 1);
        }
        return {
            "items": this._items.map((i) => ({ ...i })),
            "paused": this._paused,
            "pauseReason": this._pause_reason,
        };
    }

    get ui_pending(): number {
        return this._items.length;
    }
}

// ── singleton ────────────────────────────────────────────────────────────────

let _queue: MessageQueue | null = null;

/** 全局消息队列（进程级单例，惰性创建）。 */
export function get_message_queue(): MessageQueue {
    if (arguments.length > 0) {
        throw pyTooMany("get_message_queue", "0", arguments.length);
    }
    if (_queue === null) {
        _queue = new MessageQueue();
    }
    return _queue;
}

// PORT STATUS: confidence=high todos=[0]
