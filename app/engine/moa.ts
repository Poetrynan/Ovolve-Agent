/**
 * moa.ts — port of app/backend/moa.py (unit 156, wave 7).
 *
 * SOURCE: app/backend/moa.py (199 lines) — on-demand Mixture-of-Agents
 * council: strip the /moa prefix, pick cross-provider advisors from the
 * scene-candidate list, ask each one in parallel with a hard timeout, and
 * build the "同行会诊" block injected into the main model's context. Every
 * failure path is fail-open: the council never throws once inside
 * _ask_one_advisor, but the TOP-LEVEL argument handling (len(None), non-
 * iterable advisors, non-str user_message) raises exactly as python does.
 *
 * RULEBOOK CITATIONS (§ numbering as in HANDOFF_V4 / RULEBOOK)
 *   RULEBOOK §2 dataclass: AdvisorOpinion/CouncilResult keep their python
 *     field names (snake_case) and vars() order — the parity probe projects
 *     both through the same field tuple, and the field order IS the contract.
 *   RULEBOOK §2 asyncio.gather → Promise.all: every advisor task is
 *     independent and fail-open (the source never uses return_exceptions
 *     because _ask_one_advisor cannot throw). The synchronous prefix of each
 *     coroutine (bind, prompt build) still runs in advisor order before the
 *     first await — same as Promise.all over an array of async calls.
 *   RULEBOOK §2 asyncio.wait_for → AbortSignal.timeout per the table; here
 *     modelled as MOA_SEAMS.waitFor (Promise.race) — see DIVERGENCE.
 *   §4 naming: python spellings verbatim — strip_moa_prefix, select_advisors,
 *     build_council_block, convene, _ask_one_advisor, MAX_ADVISORS,
 *     ADVISOR_MAX_TOKENS, COUNCIL_TIMEOUT_S, MOA_PREFIX, and fields
 *     model_id/provider_id/elapsed_s/council_block/advisors_asked.
 *   §2 module-level mutable state: the three constants python reads at CALL
 *     time (ADVISOR_MAX_TOKENS, COUNCIL_TIMEOUT_S, MOA_PREFIX) go through
 *     MOA_SEAMS getters so a probe patching the module global is mirrored;
 *     MAX_ADVISORS is only read as the DEF-TIME default of select_advisors'
 *     `limit`, so the port snapshots it (patching moa.MAX_ADVISORS in python
 *     does NOT change that default either — def-time binding is the point).
 *
 * QUIRKS PINNED BY THE PARITY PROBE
 *   1. strip_moa_prefix: (user_message or "").strip() raises AttributeError
 *      for a truthy non-str (5 → "'int' object has no attribute 'strip'");
 *      None falls through or to "" and returns (False, "") — the ORIGINAL
 *      argument (post-or) is returned on the negative arm, un-stripped.
 *   2. The advisor key chain (cand.get("providerId") or cand.get("provider_id")
 *      or "") evaluates the SECOND .get only when the first VALUE is falsy —
 *      with a recording candidate the ledger shows exactly which gets ran;
 *      str() wraps the WHOLE chain, so providerId=0 ends up "" (both gets ran).
 *   3. The current model's provider is blacklisted lazily: only when a
 *      candidate whose modelId equals current_model is SEEN (and only while
 *      current_pid is still "") does its provider stop occupying seats.
 *   4. seen_providers also stores the EMPTY string: a second candidate with
 *      no provider id is skipped because the membership test is `pid in
 *      seen_providers`, not a truthiness test.
 *   5. picked holds the ORIGINAL candidate objects, never copies.
 *   6. build_council_block iterates its argument directly: None raises
 *      TypeError("'NoneType' object is not iterable") — it does NOT return
 *      "" for None. The joined block is .strip()ed whole; each opinion text
 *      is stripped individually; missing .ok/.text on an element raises
 *      AttributeError (duck typing preserved via pyAttr).
 *   7. convene(None) raises TypeError("object of type 'NoneType' has no
 *      len()") BEFORE anything else — the len() happens outside the empty
 *      check. An empty list returns early WITHOUT touching the clock and
 *      with elapsed_s staying 0.0 and no log line.
 *   8. _ask_one_advisor never throws: bind() raising, chat() raising and a
 *      wait_for timeout all become ok=False opinions; the timeout arm's
 *      error text is composed by THIS module with python float repr
 *      (default 45.0 → "timeout after 45.0s"), not by the exception.
 *   9. error strings are str(exc)[:160]; the opinion text is (value or
 *      {}).get("content") or "" then .strip() then [:2400] — the `or ""`
 *      swallows a falsy content (0 → "") BEFORE str(); a non-dict truthy
 *      value dies with AttributeError caught by the fail-open arm.
 *  10. The council log line carries python's %-format ARGS unrendered
 *      ("[moa] council done: %d/%d advisor(s) replied in %.1fs, block=%d
 *      chars") — the probe records (fmt, args) on both sides.
 *
 * DIVERGENCE(port, wait_for cancellation): python's asyncio.wait_for cancels
 *     the inner coroutine on timeout; MOA_SEAMS.waitFor uses Promise.race and
 *     leaves the loser running. Unobservable here: _ask_one_advisor has no
 *     finally/cleanup after the await and the module never inspects the
 *     abandoned task (same disposition as context_compactor's f_timeout).
 * DIVERGENCE(port, logging render): python's logging renders %-format args
 *     lazily inside the logging module; the port hands (fmt, args) to
 *     MOA_SEAMS.logInfo verbatim. Rendering belongs to the host logger; the
 *     probe compares the unrendered call, which is the module's own behaviour.
 * DIVERGENCE(port, dataclass surface): __repr__/__eq__ of the two dataclasses
 *     are not reproduced — no consumer in this module prints or ==-compares
 *     them (the probe compares field projections). Constructor arity errors
 *     ARE reproduced with CPython's wording for AdvisorOpinion ("takes from
 *     3 to 6 positional arguments"); CouncilResult is only ever constructed
 *     keyword-style in this module, so the port takes a keyword bag.
 * DIVERGENCE(port, int/float repr): python can tell 45 (int) from 45.0
 *     (float) when the timeout text composes; JS has one number type. The
 *     port renders integral values with a trailing ".0" (the shipped default
 *     45.0 → "45.0" is exact); a probe patching an INTEGER timeout gets
 *     "5.0" where python prints "5" — the probe avoids patching an integral
 *     value in a timeout-text scenario (recorded in verified/moa.json).
 */

class TypeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "TypeError"; }
}
class AttributeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "AttributeError"; }
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
    if (v instanceof Uint8Array) return v.length > 0;
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

function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Map) {
        return "{" + Array.from(v.entries()).map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
    }
    if (typeof v === "object") {
        const o = v as Record<string, unknown>;
        return "{" + Object.keys(o).map((k) => pyRepr(k) + ": " + pyRepr(o[k])).join(", ") + "}";
    }
    return String(v);
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

/** python float repr for `str()`: integral values render int-style. */
function pyNumStr(v: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return String(v);
}

/** python str() of a value that the source knows is a float: integral values
 *  keep the trailing ".0" (45.0 → "45.0"). Used for the timeout text only. */
function pyFloatStr(v: number): string {
    if (Number.isInteger(v) && Number.isFinite(v)) return String(v) + ".0";
    return pyNumStr(v);
}

/** python str.strip() with no args: strips isspace() chars. */
function pyStrip(s: string): string {
    return s.replace(/^[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/, "")
        .replace(/[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/, "");
}

/** python `len()` with CPython's TypeError wording. */
function pyLen(v: unknown): number {
    if (v === null || v === undefined) {
        throw new TypeErrorP("object of type 'NoneType' has no len()");
    }
    if (typeof v === "string" || Array.isArray(v)) return v.length;
    if (v instanceof Set || v instanceof Map) return v.size;
    throw new TypeErrorP(`object of type '${pyTypeName(v)}' has no len()`);
}

/** python attribute access: a MISSING key on an object raises the same
 *  AttributeError as a python instance would; present-but-undefined reads
 *  as None only when the key exists. */
function pyAttr(o: unknown, name: string): unknown {
    if (o === null || o === undefined) {
        throw new AttributeErrorP(`'${pyTypeName(o)}' object has no attribute '${name}'`);
    }
    const has = typeof o === "object" && name in (o as object);
    if (!has) {
        throw new AttributeErrorP(`'${pyTypeName(o)}' object has no attribute '${name}'`);
    }
    return (o as Record<string, unknown>)[name];
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

/** interval form CPython uses when some parameters have defaults. */
function pyTooManyRange(fname: string, min: number, max: number, given: number): TypeErrorP {
    const noun = max === 1 ? "positional argument" : "positional arguments";
    const verb = given === 1 ? "was" : "were";
    return new TypeErrorP(`${fname}() takes from ${min} to ${max} ${noun} but ${given} ${verb} given`);
}

// ── module constants ─────────────────────────────────────────────────────────

/** 最多请几位会诊医生。3 个 advisor = 4 倍费用起步，收益曲线已经压平。 */
export const MAX_ADVISORS = 2;
/** def-time snapshot of MAX_ADVISORS: python binds select_advisors' `limit`
 *  default when the def runs, so patching the module global does not change
 *  the default — the snapshot is the equivalent binding time. */
const MAX_ADVISORS_DEF_SNAPSHOT = MAX_ADVISORS;

/** 单位 advisor 的回答上限（函数体内引用模块全局 → 调用期可 patch）。 */
export const ADVISOR_MAX_TOKENS = 700;
/** 全体会诊的墙钟预算（调用期可 patch）。 */
export const COUNCIL_TIMEOUT_S = 45.0;
/** 触发前缀（调用期可 patch）。 */
export const MOA_PREFIX = "/moa";

export interface MoaBaseLlm {
    /** python: base_llm.bind(cand) — returns a client with .chat(...). */
    bind(cand: unknown): unknown;
}

type ChatMsg = { role: string; content: string };

export const MOA_SEAMS = {
    /** python `time.monotonic()` — the probe scripts the values. */
    monotonic: (): number => 0,
    /** python `asyncio.wait_for(aw, timeout=t)` — CPython 3.13 awaits the
     *  coroutine INLINE (no task hop), so a chat body without a real
     *  suspension completes with zero yields and gather stays serial. The
     *  mirror: a synchronous chat result passes through with NO microtask; a
     *  Promise (a genuinely suspending chat) races against the timeout. */
    waitFor: (p: unknown, timeout: number): unknown => {
        if (p instanceof Promise) {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const loser = new Promise<never>((_, rej) => {
                timer = setTimeout(() => rej(new MoaTimeoutError()), timeout * 1000);
            });
            return Promise.race([p, loser]).finally(() => {
                if (timer !== null) clearTimeout(timer);
            });
        }
        return p;
    },
    /** python module-global reads that stay CALL-time patchable. */
    advisorMaxTokens: (): number => ADVISOR_MAX_TOKENS,
    councilTimeoutS: (): number => COUNCIL_TIMEOUT_S,
    moaPrefix: (): string => MOA_PREFIX,
    /** python `logger = logging.getLogger("moa")` — (fmt, args) unrendered. */
    logInfo: (fmt: string, args: unknown[]): void => { /* host logger */ },
};

/** python asyncio.TimeoutError stand-in — never escapes; the timeout arm
 *  composes its own message text. */
class MoaTimeoutError extends Error {
    constructor() { super(""); this.name = "TimeoutError"; }
}

/** python str.lower() for an ASCII-only decision point: the /moa prefix is
 *  ASCII, so folding only A-Z cannot diverge from CPython here and avoids
 *  importing the final-sigma rule onto user text. */
function asciiLower(s: string): string {
    return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// ── strip_moa_prefix ─────────────────────────────────────────────────────────

/** 识别并剥掉 ``/moa`` 触发前缀，返回 ``(启用?, 剩余请求)``。 */
export function strip_moa_prefix(user_message: unknown): [boolean, string] {
    if (arguments.length === 0) throw pyMissing("strip_moa_prefix", ["user_message"]);
    if (arguments.length > 1) throw pyTooMany("strip_moa_prefix", "1", arguments.length);
    // python: text = (user_message or "").strip() — a truthy non-str (5)
    // reaches .strip() and raises; None falls through or to "".
    const handed = pyOr(user_message, "");
    if (typeof handed !== "string") {
        throw new AttributeErrorP(`'${pyTypeName(handed)}' object has no attribute 'strip'`);
    }
    const text = pyStrip(handed);
    const prefix = MOA_SEAMS.moaPrefix();
    if (asciiLower(text).startsWith(prefix)) {
        return [true, pyStrip(text.slice(prefix.length))];
    }
    return [false, pyStr(pyOr(user_message, ""))];
}

// ── dataclasses ──────────────────────────────────────────────────────────────

/** 一位 advisor 的会诊意见（或失败记录）。 */
export class AdvisorOpinion {
    model_id: unknown;
    provider_id: unknown;
    ok: unknown;
    text: unknown;
    elapsed_s: unknown;
    error: unknown;

    constructor(model_id?: unknown, provider_id?: unknown, ok?: unknown,
                text?: unknown, elapsed_s?: unknown, error?: unknown) {
        // python dataclass __init__: 3 required + 3 defaulted. CPython counts
        // SELF in the interval wording — "takes from 4 to 7 positional
        // arguments but 8 were given" for 7 caller-supplied args (pinned z07).
        const n = arguments.length;
        if (n < 3) {
            const all = ["model_id", "provider_id", "ok"];
            throw pyMissing("AdvisorOpinion.__init__", all.slice(n));
        }
        if (n > 6) throw pyTooManyRange("AdvisorOpinion.__init__", 4, 7, n + 1);
        this.model_id = model_id;
        this.provider_id = provider_id;
        this.ok = ok;
        this.text = text === undefined ? "" : text;
        this.elapsed_s = elapsed_s === undefined ? 0.0 : elapsed_s;
        this.error = error === undefined ? "" : error;
    }
}

/** 一场会诊的完整回执：意见列表 + 注入用文本块。
 *  python 唯一构造点用关键字（CouncilResult(advisors_asked=N)），端口按
 *  关键字袋建模；opinions 是 field(default_factory=list)——每个实例新列表。 */
export class CouncilResult {
    opinions: unknown[];
    council_block: unknown;
    advisors_asked: unknown;
    elapsed_s: unknown;

    constructor(init?: { opinions?: unknown[]; council_block?: unknown;
                         advisors_asked?: unknown; elapsed_s?: unknown }) {
        this.opinions = (init && init.opinions !== undefined) ? init.opinions : [];
        this.council_block = (init && init.council_block !== undefined) ? init.council_block : "";
        this.advisors_asked = (init && init.advisors_asked !== undefined) ? init.advisors_asked : 0;
        this.elapsed_s = (init && init.elapsed_s !== undefined) ? init.elapsed_s : 0.0;
    }
}

// ── select_advisors ──────────────────────────────────────────────────────────

/** 从 scene 候选里挑会诊医生（每 provider 一席；排除主模型所在 provider）。 */
export function select_advisors(scene_candidates: unknown, current_model: unknown,
                                limit: number = MAX_ADVISORS_DEF_SNAPSHOT): unknown[] {
    if (arguments.length < 2) {
        throw pyMissing("select_advisors", ["scene_candidates", "current_model"].slice(arguments.length));
    }
    if (arguments.length > 3) throw pyTooMany("select_advisors", "3", arguments.length);
    const picked: unknown[] = [];
    const seen_providers = new Set<string>();
    // python: current = current_model or "" — a truthy non-str stays a
    // non-str and NEVER equals a str mid (python str == int is False).
    const current = pyOr(current_model, "");
    let current_pid = "";
    const cands = pyOr(scene_candidates, []) as unknown;
    if (!Array.isArray(cands)) {
        throw new TypeErrorP(`'${pyTypeName(cands)}' object is not iterable`);
    }
    for (const cand of cands as unknown[]) {
        // python: cand.get("providerId") or cand.get("provider_id") or "" —
        // get #1 always runs; get #2 runs only when #1's VALUE is falsy.
        const pid = pyStr(pyOr(getOrChain(cand, "providerId", "provider_id"), ""));
        const mid = pyStr(pyOr(getOrChain(cand, "modelId", "model_id"), ""));
        if (!current_pid && mid === current) {
            current_pid = pid;
            continue;
        }
        if (!mid || mid === current) continue;
        if (seen_providers.has(pid) || (pid && pid === current_pid)) continue;
        picked.push(cand);
        seen_providers.add(pid);
        if (picked.length >= limit) break;
    }
    return picked;
}

/** dict.get(key) for a recording-capable candidate: missing key → undefined
 *  (python None). Reads the key UNCONDITIONALLY so a recording Proxy fires
 *  its get trap even for absent keys, matching python's .get call ledger.
 *  Non-dict candidates raise python's AttributeError. */
function pyGet(cand: unknown, key: string): unknown {
    if (cand === null || cand === undefined || typeof cand !== "object") {
        throw new AttributeErrorP(`'${pyTypeName(cand)}' object has no attribute 'get'`);
    }
    return (cand as Record<string, unknown>)[key];
}

/** python `a or b` with LAZY b: JS function arguments are eager, so the
 *  candidate key chain cannot go through pyOr — the second .get must not
 *  even happen when the first value is truthy (ledger-visible). */
function getOrChain(cand: unknown, key1: string, key2: string): unknown {
    let v = pyGet(cand, key1);
    if (!pyTruth(v)) v = pyGet(cand, key2);
    return v;
}

// ── build_council_block ──────────────────────────────────────────────────────

/** 把成功意见拼成注入主模型上下文的「同行会诊」块。 */
export function build_council_block(opinions: unknown): string {
    if (arguments.length === 0) throw pyMissing("build_council_block", ["opinions"]);
    if (arguments.length > 1) throw pyTooMany("build_council_block", "1", arguments.length);
    if (!Array.isArray(opinions)) {
        // python iterates `opinions` directly — None is not special-cased.
        throw new TypeErrorP(`'${pyTypeName(opinions)}' object is not iterable`);
    }
    const good: unknown[] = [];
    for (const o of opinions as unknown[]) {
        // python: o.ok and o.text.strip() — missing attrs raise here, and a
        // non-str text raises '... has no attribute strip' (c14: 123).
        const okV = pyAttr(o, "ok");
        if (!pyTruth(okV)) continue;
        const textV = pyAttr(o, "text");
        if (typeof textV !== "string") {
            throw new AttributeErrorP(`'${pyTypeName(textV)}' object has no attribute 'strip'`);
        }
        if (!pyTruth(pyStrip(textV))) continue;
        good.push(o);
    }
    if (!good.length) return "";
    const lines: string[] = [
        "【同行会诊意见（供参考，非标准答案）】",
        "以下是其他模型的独立观点。请批判性采纳：与你的工具观察和推理冲突时，以你的判断为准；采纳时不需要声明。",
        "",
    ];
    for (const o of good) {
        const mid = pyAttr(o, "model_id");
        lines.push(`▍视角·${pyStr(mid)}`);
        const textV2 = pyAttr(o, "text");
        if (typeof textV2 !== "string") {
            throw new AttributeErrorP(`'${pyTypeName(textV2)}' object has no attribute 'strip'`);
        }
        lines.push(pyStrip(textV2));
        lines.push("");
    }
    return pyStrip(lines.join("\n"));
}

// ── _ask_one_advisor ─────────────────────────────────────────────────────────

/** 向一位 advisor 提问。失败返回 ok=False 的意见，绝不抛出。 */
async function _ask_one_advisor(base_llm: unknown, cand: unknown,
                                question: unknown, recent_tail: unknown): Promise<AdvisorOpinion> {
    const pid = pyStr(pyOr(getOrChain(cand, "providerId", "provider_id"), ""));
    const mid = pyStr(pyOr(getOrChain(cand, "modelId", "model_id"), ""));
    const t0 = MOA_SEAMS.monotonic();
    try {
        // python: base_llm.bind(cand) — a non-bindable base_llm raises inside
        // the try and lands in the fail-open arm.
        const client = pyAttr(base_llm, "bind") as unknown;
        if (typeof client !== "function") {
            throw new TypeErrorP(`'${pyTypeName(client)}' object is not callable`);
        }
        const bound = (client as (c: unknown) => unknown).call(base_llm, cand);
        let prompt =
            "你是另一位 AI 助手，受邀为下面这个任务提供独立 second opinion。" +
            "请给出：① 你会怎么做（步骤级）；② 主流做法容易踩的坑；" +
            "③ 如果信息不足，最有价值的追问是什么。直接说结论，不要客套。\n\n" +
            `【任务】\n${pyStr(question)}\n`;
        if (pyTruth(recent_tail)) {
            prompt += `\n【最近对话摘要（供上下文）】\n${pyStr(recent_tail)}\n`;
        }
        const chatFn = pyAttr(bound, "chat") as unknown;
        if (typeof chatFn !== "function") {
            throw new TypeErrorP(`'${pyTypeName(chatFn)}' object is not callable`);
        }
        const chatRes = (chatFn as (m: unknown, kw: unknown) => unknown).call(bound,
            [{ role: "user", content: prompt } as ChatMsg], {
                max_tokens: MOA_SEAMS.advisorMaxTokens(),
                temperature: 0.4,
                reasoning_effort: "low",
            });
        let res = MOA_SEAMS.waitFor(chatRes, MOA_SEAMS.councilTimeoutS());
        if (res instanceof Promise) res = await res;
        const elapsed = MOA_SEAMS.monotonic() - t0;
        if (!pyTruth(pyAttr(res, "ok"))) {
            const errRaw = pyAttr(res, "error");
            return new AdvisorOpinion(mid, pid, false, undefined, elapsed,
                pyStr(errRaw).slice(0, 160));
        }
        const valueDict = pyOr(pyAttr(res, "value"), {}) as unknown;
        let content: unknown;
        if (isPyDict(valueDict) || valueDict instanceof Map) {
            content = (valueDict as Record<string, unknown>)["content"];
        } else {
            throw new AttributeErrorP(`'${pyTypeName(valueDict)}' object has no attribute 'get'`);
        }
        const text = pyStrip(pyStr(pyOr(content, "")));
        return new AdvisorOpinion(mid, pid, pyTruth(text), text.slice(0, 2400), elapsed);
    } catch (e) {
        if (e instanceof MoaTimeoutError) {
            return new AdvisorOpinion(mid, pid, false, undefined,
                MOA_SEAMS.monotonic() - t0,
                `timeout after ${pyFloatStr(MOA_SEAMS.councilTimeoutS())}s`);
        }
        const msg = e instanceof Error ? e.message : pyStr(e);
        return new AdvisorOpinion(mid, pid, false, undefined,
            MOA_SEAMS.monotonic() - t0, msg.slice(0, 160));
    }
}

// ── convene ──────────────────────────────────────────────────────────────────

/** 并行召集所有 advisor，返回会诊回执。永不抛出、永不阻塞主流程。 */
export async function convene(base_llm: unknown, advisors: unknown,
                              question: unknown, recent_tail: unknown = ""): Promise<CouncilResult> {
    if (arguments.length < 3) {
        throw pyMissing("convene", ["base_llm", "advisors", "question"].slice(arguments.length));
    }
    if (arguments.length > 4) throw pyTooMany("convene", "4", arguments.length);
    // python: result = CouncilResult(advisors_asked=len(advisors)) — the len()
    // happens BEFORE the empty check, so None raises TypeError here.
    const result = new CouncilResult({ advisors_asked: pyLen(advisors) });
    if (!pyTruth(advisors)) return result;
    const t0 = MOA_SEAMS.monotonic();
    const opinions = await Promise.all(
        (advisors as unknown[]).map((cand) => _ask_one_advisor(base_llm, cand, question, recent_tail)),
    );
    result.opinions = opinions.slice();
    result.council_block = build_council_block(result.opinions);
    result.elapsed_s = MOA_SEAMS.monotonic() - t0;
    const ok_n = result.opinions.filter((o) => pyTruth(pyAttr(o, "ok"))).length;
    MOA_SEAMS.logInfo(
        "[moa] council done: %d/%d advisor(s) replied in %.1fs, block=%d chars",
        [ok_n, (advisors as unknown[]).length, result.elapsed_s, pyLen(result.council_block)],
    );
    return result;
}

// PORT STATUS: confidence=high todos=[0]
