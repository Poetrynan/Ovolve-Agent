/**
 * goal_manager.ts — long-term goal and sub-goal lifecycle manager.
 *
 * Ported from `app/backend/goal_manager.py` (969 lines, wave-6, unit 163).
 * Manages long-running goals with iterations, sub-tasks, state tracking, and
 * automatic continuation when LLM verification fails.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/goal_manager.py -> app/engine/goal_manager.ts.
 *       Public python names stay snake_case, verbatim: GoalStatus,
 *       ACTIVE_STATES, GoalType, Goal, GoalManager, get_goal_manager, and the
 *       imported goal_brief surface (GoalBrief, GoalCategory,
 *       derive_goal_category, build_brief_from_prompt, CATEGORY_DEFAULTS).
 *   §2  async model: only the two source-async functions (verify_completion /
 *       continue_goal) return promises; every other method stays synchronous —
 *       the concurrency shape is part of the behaviour.
 *   §2  `json.dumps` appears at 7 sites with python's default `", "`/`": "`
 *       separators and insertion-order keys; THREE of them pass
 *       ensure_ascii=False (the brief_json blobs and the machine-gate
 *       verification blob — Chinese stays raw) while the other FOUR use the
 *       DEFAULT ensure_ascii=True (Chinese escapes to lowercase \uXXXX).
 *       pyJsonDumps carries the flag; the parity probe compares the exact
 *       stored strings byte-for-byte.
 *   §2  dicts are ordered structures: metadata / to_dict / prompt_data /
 *       update_goal_fields kwargs / verify results all keep the source's key
 *       insertion order (plain objects, probed).
 *   §2  `GoalType` is a REGULAR Enum: the isinstance branch stores `.value`,
 *       the non-member branch stores `str(x)` — both render as the plain value
 *       string through this module's observable surface (DIVERGENCE below).
 *   §2  module-level mutable state: `_manager` singleton with the same lazy
 *       initialisation order (get_goal_manager binds llm_callback once).
 *   §2  `x.get(k, d)` keeps a PRESENT null (dictGet); `r.get("iteration", 0)+1`
 *       and friends reproduce python's operand errors verbatim.
 *   §1  telemetry BANNED in the new codebase: `get_telemetry()` /
 *       `SpanName.GOAL_ITERATION` start_span/set_error/end_span call sites are
 *       DELETED, not translated (cron_manager.ts / browser_agent.ts precedent
 *       for the DELETE-flagged telemetry.py unit; every site is observational
 *       and none gates a decision).
 *   §3  every host capability this module touches (time / uuid / storage /
 *       three Rust-routed lazy imports) sits behind GOAL_MANAGER_SEAMS or a
 *       settable provider so the parity probe never touches a real resource.
 *   §23 architecture red line: the arbitration census (code-decided vs
 *       model-decided) is recorded under MIGRATION DECISIONS below and the
 *       code-decided outcomes are first-class probe facts.
 *
 * QUIRKS PINNED BY THE PARITY PROBE
 *   §1  Goal.from_dict consumes 1 uuid4 + 2 time.time() inside Goal.__init__
 *       AND another 1 uuid4 + 2 time.time() through its d.get default
 *       arguments — ALWAYS, even when every key is present in the dict
 *       (python evaluates `d.get("id", str(uuid.uuid4()))` eagerly).
 *   §2  Goal.__init__ consumes 1 uuid4 + 2 SEPARATE time.time() calls, so
 *       created_at and updated_at can differ.
 *   §3  GoalManager.add_iteration computes `r.get("iteration", 0) + 1`; a
 *       string iteration raises `can only concatenate str (not "int") to str`,
 *       caught by the method's own `except Exception` and re-wrapped as
 *       Result.failure("Failed to add iteration: …").
 *   §4  a non-dict, non-GoalBrief brief (create_goal / _resolve_brief /
 *       set_brief) raises AttributeError "'str' object has no attribute
 *       'get'" from GoalBrief.from_dict — create_goal has no try around it.
 *   §5  continue_goal parses verification_result: "[1,2]" yields a list whose
 *       .get explodes → outer except "Continue goal failed: 'list' object has
 *       no attribute 'get'"; "0" yields int → same shape.
 *   §6  a string `suggestions` in the stored verdict renders one bullet per
 *       CHARACTER ("  - d", "  - o", …) — python iterates the string.
 *   §7  _plan_block's try only covers the import + load_plan: a plan item
 *       missing `status` raises KeyError ('status') OUT of _plan_block, which
 *       verify_completion's inner try turns into result=None → heuristic.
 *   §8  with acceptance_contract ABSENT, verify_completion fails closed:
 *       {"passed": false, "reason": "No module named 'acceptance_contract'",
 *       "suggestions": []} — the LLM is never consulted (the import is
 *       unconditional and sits inside the big try).
 *   §9  _coerce_verification: `isinstance(completed, (str, int))` wraps True
 *       (a bool) as ["True"], keeps 1.5 → [] (dropped), dict → []; a
 *       non-iterable `suggestions` (int) raises "'int' object is not
 *       iterable" which escapes _coerce (it sits OUTSIDE the inner try) into
 *       verify_completion's outer except.
 *   §10 the machine-gate failure blob is dumped with ensure_ascii=False
 *       (Chinese raw) while the LLM and heuristic blobs use the DEFAULT
 *       ensure_ascii=True — same method, two encodings.
 *   §11 the goal_plan import arm in _plan_block and continue_goal catches
 *       EVERYTHING → "": a load_plan failure simply omits the SUB-TASKS
 *       block from the prompt/reminder.
 *   §12 recovery render failures inject two DIFFERENT literal Chinese
 *       warnings (已落地副作用清单读取失败… / 未结算副作用清单读取失败…).
 *   §13 row reads keep present-but-NULL values (dictGet) and only fold into
 *       the default when the key is MISSING (r.get("status", "active") etc).
 *   §14 heuristic markers are substring checks against the LOWERED evidence —
 *       "TODOIST" lowers to "todoist" which CONTAINS "todo".
 *   §15 ACTIVE_STATES = {started, active, running, queued}; continue_goal
 *       refuses everything else with "Goal is not active: <status>".
 *   §16 the continuation budget reads r.get("iteration", 0) — NOT the Goal
 *       object's continuation_count field (the scheduler's counter is the
 *       storage row's iteration column).
 *   §17 join failures are typed: "sequence item 2: expected str instance,
 *       int found" — both the machine-gate reason join and the reminder join.
 *   §18 from_dict aliases the row's iterations/metadata lists (no copy);
 *       sub_goals recurse through Goal.from_dict.
 *   §19 create_goal always attaches a derived-or-given brief and derives the
 *       category whenever it is missing/unknown — code tables, never the LLM.
 *   §20 `list_goals(status)` forwards the raw status (None included); the
 *       storage fake's return is passed through untouched.
 *
 * MIGRATION DECISIONS / DIVERGENCES (documented dispositions)
 *   telemetry (DELETE unit): start_span / set_error / end_span and the
 *       SpanName.GOAL_ITERATION constant import are deleted per the RULEBOOK
 *       §1 telemetry ban and HANDOFF §4.12 ("依赖方直接删调用"). The `except`
 *       arms that only did span bookkeeping keep their swallow semantics;
 *       every other statement is byte-identical.
 *   §23.2 ARBITRATION CENSUS — code-decided (preserved as code, probed as
 *       first-class facts):
 *       * goal classification: create_goal ALWAYS attaches a brief (derived
 *         from the description when none is given); the category comes from
 *         derive_goal_category's keyword/pattern tables (goal_brief) — pure
 *         code, never the LLM.
 *       * category defaults: max_continuations / cost_cap_micros come from
 *         CATEGORY_DEFAULTS — a table lookup.
 *       * state transitions: update_goal_status / pause / resume / complete /
 *         fail / delete are direct storage writes; ACTIVE_STATES membership
 *         gates continue_goal and get_active_goal_context — code.
 *       * continuation budget: `iteration >= max_iterations` refusal — code.
 *       * machine verification gate: get_goal_contract + check_completion run
 *         BEFORE any LLM; unmet criteria → fail-closed, LLM never consulted.
 *       * verdict normalisation: _coerce_verification (fence stripping, first
 *         {...} block extraction, "true"/"yes"/"1" coercion, suggestions[:10],
 *         completed[:50]) — code.
 *       * heuristic fallback (no LLM, callback raised, or unparseable reply):
 *         the incomplete_markers table over lowered evidence — code.
 *       MODEL-DECIDED (copied verbatim per §23.2③; recorded as a §23.4 todo):
 *       * verify_completion's final pass/fail WHEN an llm_callback is wired
 *         AND the machine gate is green AND the reply parses: the model's
 *         {"passed": …} verdict decides. The port reproduces the injection
 *         shape exactly (prompt_data key order, iscoroutinefunction branch,
 *         await-vs-sync call, storage persistence of the verdict) — but the
 *         decision itself is the model's. Reported to the operator in
 *         verified/goal_manager.json; converting it to a code gate is a
 *         post-parity design change and is deliberately NOT done here.
 *   lazy imports: acceptance_contract / goal_plan / recovery are Rust-routed
 *       units with no TS siblings, imported INSIDE functions in the source.
 *       The port resolves them through set_acceptance_contract_provider /
 *       set_goal_plan_provider / set_recovery_provider (the execution_provider
 *       set_sandbox_provider precedent). An unbound provider reproduces
 *       python's "No module named 'x'"; a bound module missing a name
 *       reproduces "cannot import name 'y' from 'x' (unknown location)".
 *   DIVERGENCE(port, enum identity): GoalType is a const object of value
 *       strings. python's str(GoalType.X) == "GoalType.X" is not reproducible
 *       and never observable here: the isinstance branch stores .value on the
 *       python side and the TS side stores the same value string, so
 *       goal.goal_type is identical for every member and plain-string input.
 *   DIVERGENCE(port, coroutine detection): asyncio.iscoroutinefunction is
 *       approximated by the AsyncFunction constructor check. A sync callback
 *       returning a Promise falls through exactly like python's
 *       coroutine-object result does (coerce → None → heuristic).
 *   DIVERGENCE(port, number repr): JS has one number type; integral values
 *       render int-style (house convention). The blobs this module dumps
 *       carry bools/strings/lists and the fake rows use ints, so no float
 *       repr is observable.
 *   DIVERGENCE(port, string comparison): `>=` on two strings uses UTF-16
 *       code-unit order (python uses code points) — differs only on astral
 *       characters; max_iterations is numeric in every product path.
 *   Result.__bool__ divergence inherited from result.ts (documented there);
 *       this module only reads `.ok`.
 *
 *   本文件无待移植项；端口状态行在文件末行。
 */

import { randomUUID } from "node:crypto";

import { Result } from "./result.js";
import {
    GoalBrief,
    GoalCategory,
    CATEGORY_DEFAULTS,
    deriveGoalCategory,
    buildBriefFromPrompt,
} from "./goal_brief.js";
import { get_storage } from "./storage.js";

// Re-export the goal_brief surface this module imports (python's module
// namespace exposes the same names after `from goal_brief import …`).
export { GoalBrief, GoalCategory, CATEGORY_DEFAULTS };
export const derive_goal_category = deriveGoalCategory;
export const build_brief_from_prompt = buildBriefFromPrompt;

type JsonDict = Record<string, unknown>;

// ── python-semantics helpers (house style: execution_provider.ts) ────────────

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
class AttributeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "AttributeError";
    }
}
class ImportErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "ImportError";
    }
}
class ModuleNotFoundErrorP extends ImportErrorP {
    constructor(msg: string) {
        super(msg);
        this.name = "ModuleNotFoundError";
    }
}
class KeyErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "KeyError";
    }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (v instanceof Set) return "set";
    if (v instanceof Map) return "dict";
    if (typeof v === "function") return "function";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
    }
    return typeof v;
}

/** house predicate (memory_layer shape): a python dict, not a class instance. */
function isPyDict(v: unknown): v is JsonDict {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    if (Buffer.isBuffer(v) || v instanceof Error) return false;
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
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    // a class instance is a python OBJECT: bool() is True whatever its fields
    // are — the empty-container rule applies only to dict-shaped values.
    if (isPyDict(v)) return Object.keys(v).length > 0;
    return true;
}

/** python `a or b`: returns the first truthy OPERAND. */
function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

/** `d.get(k, dflt)`: a PRESENT null returns null, never the default. */
function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
    if (isPyDict(obj)) {
        return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : dflt;
    }
    throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute 'get'`);
}

/** python repr() for a string leaf (single/double quote choice). */
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
                .map((k) => `${pyRepr(k)}: ${pyRepr(v[k])}`)
                .join(", ") +
            "}"
        );
    }
    return pyStr(v);
}

/** python str(x): containers render through repr, atoms print bare. */
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

/** str(exception) — message only, no type prefix. */
function pyStrExc(e: unknown): string {
    if (e instanceof Error) return e.message;
    return pyStr(e);
}

/** python `str.strip()` with no args: strips isspace() chars. */
function pyStrip(s: string): string {
    return s
        .replace(/^[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/, "")
        .replace(/[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/, "");
}

/** python `'X'.strip()` where the receiver may not be a str. */
function pyStripAttr(v: unknown): string {
    if (typeof v === "string") return pyStrip(v);
    throw new AttributeErrorP(`'${pyTypeName(v)}' object has no attribute 'strip'`);
}

/** python `'X'.lower()` where the receiver may not be a str. */
function pyLowerAttr(v: unknown): string {
    if (typeof v === "string") return v.toLowerCase();
    throw new AttributeErrorP(`'${pyTypeName(v)}' object has no attribute 'lower'`);
}

/** python `x in y` substring containment (y must be a str). */
function pyContains(needle: string, haystack: unknown): boolean {
    if (typeof haystack === "string") return haystack.includes(needle);
    throw new TypeErrorP(`argument of type '${pyTypeName(haystack)}' is not iterable`);
}

/**
 * python iteration: list/tuple → elements, str → CODE POINTS, dict → keys,
 * set → elements; anything else raises "'X' object is not iterable".
 */
function pyIterate(v: unknown): unknown[] {
    if (Array.isArray(v)) return v;
    if (typeof v === "string") return Array.from(v);
    if (isPyDict(v)) return Object.keys(v);
    if (v instanceof Set) return Array.from(v);
    if (v instanceof Map) return Array.from(v.keys());
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not iterable`);
}

/** python `"; ".join(seq)`: every element must be a str. */
function pyJoin(seq: readonly unknown[], sep: string): string {
    for (let i = 0; i < seq.length; i++) {
        if (typeof seq[i] !== "string") {
            throw new TypeErrorP(
                `sequence item ${i}: expected str instance, ${pyTypeName(seq[i])} found`);
        }
    }
    return (seq as string[]).join(sep);
}

/** python `x + 1` where x may be any operand type. */
function pyAddOne(v: unknown): unknown {
    if (typeof v === "boolean") return (v ? 1 : 0) + 1;
    if (typeof v === "number") return v + 1;
    if (typeof v === "string") throw new TypeErrorP('can only concatenate str (not "int") to str');
    if (Array.isArray(v)) throw new TypeErrorP('can only concatenate list (not "int") to list');
    if (v === null || v === undefined) {
        throw new TypeErrorP("unsupported operand type(s) for +: 'NoneType' and 'int'");
    }
    if (isPyDict(v)) {
        throw new TypeErrorP("unsupported operand type(s) for +: 'dict' and 'int'");
    }
    throw new TypeErrorP(
        `unsupported operand type(s) for +: '${pyTypeName(v)}' and 'int'`);
}

/** python `a >= b` across the operand kinds this module can see. */
function pyGe(a: unknown, b: unknown): boolean {
    const num = (v: unknown): number | null => {
        if (typeof v === "boolean") return v ? 1 : 0;
        if (typeof v === "number") return v;
        return null;
    };
    const an = num(a);
    const bn = num(b);
    if (an !== null && bn !== null) return an >= bn;
    if (typeof a === "string" && typeof b === "string") return a >= b;
    throw new TypeErrorP(
        `'>=' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** python `a, b, c = iterable` (expected 3). */
function pyUnpack3(v: unknown): [unknown, unknown, unknown] {
    if (Array.isArray(v)) {
        if (v.length < 3) throw new ValueErrorP(`not enough values to unpack (expected 3, got ${v.length})`);
        if (v.length > 3) throw new ValueErrorP("too many values to unpack (expected 3)");
        return [v[0], v[1], v[2]];
    }
    if (typeof v === "string") {
        const chars = Array.from(v);
        if (chars.length !== 3) {
            throw chars.length < 3
                ? new ValueErrorP(`not enough values to unpack (expected 3, got ${chars.length})`)
                : new ValueErrorP("too many values to unpack (expected 3)");
        }
        return [chars[0], chars[1], chars[2]];
    }
    if (isPyDict(v)) {
        const keys = Object.keys(v);
        if (keys.length < 3) throw new ValueErrorP(`not enough values to unpack (expected 3, got ${keys.length})`);
        if (keys.length > 3) throw new ValueErrorP("too many values to unpack (expected 3)");
        return [v[keys[0] as string], v[keys[1] as string], v[keys[2] as string]];
    }
    throw new TypeErrorP(`cannot unpack non-iterable ${pyTypeName(v)} object`);
}

/** python `d[k]`: a missing key raises KeyError with the repr'd key. */
function pyGetitem(obj: unknown, key: string): unknown {
    if (isPyDict(obj)) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) {
            throw new KeyErrorP(pyReprStr(key));
        }
        return obj[key];
    }
    if (typeof obj === "string" || Array.isArray(obj)) {
        throw new TypeErrorP("string indices must be integers");
    }
    throw new TypeErrorP(`'${pyTypeName(obj)}' object is not subscriptable`);
}

/** python `seq[:stop]`: code-point slices for str, list slices, dicts reject
 *  the slice as an unhashable key, anything else is not subscriptable. */
function pySliceTop(v: unknown, stop: number): unknown {
    if (typeof v === "string") return Array.from(v).slice(0, stop).join("");
    if (Array.isArray(v)) return v.slice(0, stop);
    if (isPyDict(v)) throw new TypeErrorP("unhashable type: 'slice'");
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not subscriptable`);
}

/** python `module.attr` on a faked module object. */
function pyGetAttr(mod: unknown, name: string, modName: string): unknown {
    if (isPyDict(mod) && Object.prototype.hasOwnProperty.call(mod, name)) return mod[name];
    throw new AttributeErrorP(`module '${modName}' has no attribute '${name}'`);
}

/**
 * json.dumps(v, ensure_ascii=…): python's default `", "`/`": "` separators,
 * insertion-order keys, NaN/Infinity literals, and CPython's exact ASCII
 * escaping (\uXXXX lowercase; 0x7f escaped; short forms for \b\f\n\r\t).
 */
function pyJsonDumps(v: unknown, ensureAscii: boolean): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") {
        if (Number.isNaN(v)) return "NaN";
        if (v === Infinity) return "Infinity";
        if (v === -Infinity) return "-Infinity";
        return String(v);
    }
    if (typeof v === "string") return pyJsonStr(v, ensureAscii);
    if (typeof v === "function" || v instanceof Error || v instanceof Map || v instanceof Set) {
        throw new TypeErrorP(`Object of type ${pyTypeName(v)} is not JSON serializable`);
    }
    if (Array.isArray(v)) return "[" + v.map((x) => pyJsonDumps(x, ensureAscii)).join(", ") + "]";
    if (isPyDict(v)) {
        return (
            "{" +
            Object.keys(v)
                .map((k) => pyJsonStr(k, ensureAscii) + ": " + pyJsonDumps(v[k], ensureAscii))
                .join(", ") +
            "}"
        );
    }
    throw new TypeErrorP(`Object of type ${pyTypeName(v)} is not JSON serializable`);
}

function pyJsonStr(s: string, ensureAscii: boolean): string {
    let out = '"';
    for (const ch of s) {
        const cp = ch.codePointAt(0) as number;
        if (ch === '"') out += '\\"';
        else if (ch === "\\") out += "\\\\";
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (ch === "\b") out += "\\b";
        else if (ch === "\f") out += "\\f";
        else if (cp < 0x20 || cp === 0x7f) out += "\\u" + cp.toString(16).padStart(4, "0");
        else if (ensureAscii && cp > 0x7e) {
            if (cp > 0xffff) {
                const c = cp - 0x10000;
                const hi = 0xd800 + (c >> 10);
                const lo = 0xdc00 + (c & 0x3ff);
                out += "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0");
            } else {
                out += "\\u" + cp.toString(16).padStart(4, "0");
            }
        } else out += ch;
    }
    return out + '"';
}

/**
 * json.loads(s). Only the parse outcome is observable in this module (every
 * error message is swallowed by an except arm), so python-only literals
 * NaN/Infinity/-Infinity decode instead of failing and the error text is the
 * house placeholder — the catching arms key on the TYPE, not the message.
 */
function pyJsonLoads(s: unknown): unknown {
    if (typeof s !== "string") {
        throw new TypeErrorP(
            `the JSON object must be str, bytes or bytearray, not ${pyTypeName(s)}`);
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
            for (const k of Object.keys(x)) o[k] = revive(x[k]);
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

/** python's missing-argument TypeError (CPython join, positional wording). */
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

// ── 测试缝 ───────────────────────────────────────────────────────────────────

/** storage 上本单元用到的方法（goals domain mixin 的子集）。 */
export type GoalManagerStorage = {
    save_goal(gid: unknown, desc: unknown, status: unknown, it: unknown, sid: unknown, ver: unknown): unknown;
    get_goal(gid: unknown): unknown;
    list_goals(status?: unknown): unknown;
    update_goal_fields(gid: unknown, fields: JsonDict): unknown;
    set_goal_state(sid: unknown, gs: JsonDict | null): unknown;
    get_goal_state(sid: unknown): unknown;
};

export const GOAL_MANAGER_SEAMS = {
    /** python `time.time()` — 浮点秒。 */
    now: (): number => Date.now() / 1000,
    /** python `str(uuid.uuid4())`。 */
    uuid4: (): string => randomUUID(),
    /** python `from storage import get_storage`（模块级绑定，构造期调用）。 */
    get_storage: (): GoalManagerStorage => get_storage() as unknown as GoalManagerStorage,
};

/** python `from acceptance_contract import …` 的最小模块视图。 */
export interface AcceptanceContractModule {
    normalize_contract?: unknown;
    set_goal_contract?: unknown;
    get_goal_contract?: unknown;
    check_completion?: unknown;
}

/** python `import goal_plan` 的最小模块视图。 */
export interface GoalPlanModule {
    load_plan?: unknown;
    render_unfinished?: unknown;
}

/** python `from recovery import …` 的最小模块视图。 */
export interface RecoveryModule {
    render_completed_side_effects?: unknown;
    render_unknown_side_effects?: unknown;
}

let _acceptance_provider: (() => AcceptanceContractModule) | null = null;
let _goal_plan_provider: (() => GoalPlanModule) | null = null;
let _recovery_provider: (() => RecoveryModule) | null = null;

/** 注入 acceptance_contract 模块提供者（宿主接线与 parity 探针用）；null = 模块不存在。 */
export function set_acceptance_contract_provider(p: (() => AcceptanceContractModule) | null): void {
    _acceptance_provider = p;
}
/** 注入 goal_plan 模块提供者；null = 模块不存在。 */
export function set_goal_plan_provider(p: (() => GoalPlanModule) | null): void {
    _goal_plan_provider = p;
}
/** 注入 recovery 模块提供者；null = 模块不存在。 */
export function set_recovery_provider(p: (() => RecoveryModule) | null): void {
    _recovery_provider = p;
}

/** python `from acceptance_contract import n1, n2`：模块缺失抛 ModuleNotFoundError
 *  同位异常，名字缺失抛 ImportError 同位异常（假模块无 __file__ → "(unknown location)"）。 */
function _importAcceptanceContract(names: readonly string[]): AcceptanceContractModule {
    if (_acceptance_provider === null) {
        throw new ModuleNotFoundErrorP("No module named 'acceptance_contract'");
    }
    const mod = _acceptance_provider();
    for (const n of names) {
        if (!isPyDict(mod) || !Object.prototype.hasOwnProperty.call(mod, n)) {
            throw new ImportErrorP(
                `cannot import name '${n}' from 'acceptance_contract' (unknown location)`);
        }
    }
    return mod;
}

/** python `import goal_plan`：模块缺失抛 ModuleNotFoundError 同位异常。 */
function _importGoalPlan(): GoalPlanModule {
    if (_goal_plan_provider === null) {
        throw new ModuleNotFoundErrorP("No module named 'goal_plan'");
    }
    return _goal_plan_provider();
}

/** python `from recovery import …`：模块缺失抛 ModuleNotFoundError 同位异常。 */
function _importRecovery(names: readonly string[]): RecoveryModule {
    if (_recovery_provider === null) {
        throw new ModuleNotFoundErrorP("No module named 'recovery'");
    }
    const mod = _recovery_provider();
    for (const n of names) {
        if (!isPyDict(mod) || !Object.prototype.hasOwnProperty.call(mod, n)) {
            throw new ImportErrorP(
                `cannot import name '${n}' from 'recovery' (unknown location)`);
        }
    }
    return mod;
}

// ── GoalStatus / ACTIVE_STATES / GoalType ────────────────────────────────────

/** Goal lifecycle states. ``STARTED``/``ACTIVE`` are equivalent running
 *  states; the stop path is a real state machine (running → stopping →
 *  paused, with stop_timeout deliberately distinct from paused). */
export class GoalStatus {
    static readonly STARTED = "started";
    static readonly ACTIVE = "active";
    /** Handed to the scheduler but waiting for a free worker slot. */
    static readonly QUEUED = "queued";
    /** A scheduler worker is currently driving this goal. */
    static readonly RUNNING = "running";
    /** A stop has been requested; confirmation not yet received. */
    static readonly STOPPING = "stopping";
    /** The confirmed resting state. */
    static readonly PAUSED = "paused";
    /** Grace window elapsed and the goal could NOT be confirmed stopped. */
    static readonly STOP_TIMEOUT = "stop_timeout";
    static readonly COMPLETED = "completed";
    static readonly FAILED = "failed";
    /** terminal failure, not retried */
    static readonly FAILED_FINAL = "ovolve_failed_final";
    static readonly CANCELLED = "cancelled";
}

/** States that mean the goal is still running. RUNNING has to be in here:
 *  the scheduler marks a claimed goal running, and continue_goal refuses to
 *  continue anything outside this set. */
export const ACTIVE_STATES: ReadonlySet<string> = new Set<string>([
    GoalStatus.STARTED, GoalStatus.ACTIVE, GoalStatus.RUNNING, GoalStatus.QUEUED,
]);

/** Goal provenance/type classification (python: regular Enum). */
export const GoalType = {
    BACKGROUND_TASK: "ovolve_background_task",
    FORK: "ovolve_fork",
    GOAL_STATE_CHANGE: "ovolve_goal_state_change",
    GOAL_CONTINUATION: "ovolve_auto_resume", // the auto-resume type
    REWIND: "ovolve_rewind",
    SUBAGENT: "ovolve_sub_agent",
    TODO_REMINDER: "ovolve_reminder",
} as const;

export type GoalTypeValue = (typeof GoalType)[keyof typeof GoalType];

// ── Goal ─────────────────────────────────────────────────────────────────────

/** A long-running goal with iterations and sub-goals. */
export class Goal {
    id: string;
    description: unknown;
    priority: unknown;
    status: string;
    goal_type: string;
    created_at: number;
    updated_at: number;
    iterations: unknown[];
    sub_goals: Goal[];
    metadata: JsonDict;
    continuation_count: number;
    max_continuations: number;

    constructor(description?: unknown, priority: unknown = 0, goal_type: unknown = GoalType.BACKGROUND_TASK) {
        // python 把 self 也计入位置参数（探针 a01/a20 钉住）。
        const given = arguments.length + 1;
        if (given < 2) {
            throw pyMissing("Goal.__init__", (["description"] as const).slice(arguments.length));
        }
        if (given > 4) throw pyTooMany("Goal.__init__", "from 2 to 4", given);
        this.id = GOAL_MANAGER_SEAMS.uuid4();
        this.description = description;
        this.priority = priority;
        this.status = GoalStatus.STARTED;
        // python: goal_type.value if isinstance(goal_type, GoalType) else str(goal_type)
        // — the TS member IS the value string, so pyStr covers both arms.
        this.goal_type = pyStr(goal_type);
        this.created_at = GOAL_MANAGER_SEAMS.now();
        this.updated_at = GOAL_MANAGER_SEAMS.now();
        this.iterations = [];
        this.sub_goals = [];
        this.metadata = {};
        this.continuation_count = 0;
        this.max_continuations = 10;
    }

    /** Add an iteration record to this goal. */
    add_iteration(result: unknown, status: unknown = "progress"): void {
        if (arguments.length === 0) {
            throw pyMissing("Goal.add_iteration", ["result"]);
        }
        if (arguments.length > 2) throw pyTooMany("Goal.add_iteration", "from 1 to 2", arguments.length);
        this.iterations.push({
            "timestamp": GOAL_MANAGER_SEAMS.now(),
            "result": result,
            "status": status,
        });
        this.updated_at = GOAL_MANAGER_SEAMS.now();
    }

    /** Add a sub-goal; returns the created sub-goal. */
    add_sub_goal(description?: unknown): Goal {
        if (arguments.length === 0) {
            throw pyMissing("Goal.add_sub_goal", ["description"]);
        }
        if (arguments.length > 1) throw pyTooMany("Goal.add_sub_goal", "1", arguments.length);
        const sub = new Goal(description);
        this.sub_goals.push(sub);
        return sub;
    }

    /** Sub-goals that are still active (ACTIVE_STATES, not a bare == ACTIVE). */
    get remaining_sub_goals(): Goal[] {
        return this.sub_goals.filter((g) => ACTIVE_STATES.has(g.status));
    }

    /** Serialize to dictionary for storage. */
    to_dict(): JsonDict {
        return {
            "id": this.id,
            "description": this.description,
            "priority": this.priority,
            "status": this.status,
            "goal_type": this.goal_type,
            "created_at": this.created_at,
            "updated_at": this.updated_at,
            "iterations": this.iterations,
            "sub_goals": this.sub_goals.map((g) => g.to_dict()),
            "metadata": this.metadata,
            "continuation_count": this.continuation_count,
            "max_continuations": this.max_continuations,
        };
    }

    /** Deserialize from storage dict.
     *  QUIRK §1: the constructor's uuid/time consumption happens FIRST, then
     *  the d.get default arguments consume another uuid4 + two time.time()
     *  even when every key is present. */
    static from_dict(d: unknown): Goal {
        const g = new Goal(
            dictGet(d, "description", ""),
            dictGet(d, "priority", 0),
            dictGet(d, "goal_type", GoalType.BACKGROUND_TASK),
        );
        g.id = dictGet(d, "id", GOAL_MANAGER_SEAMS.uuid4()) as string;
        g.status = dictGet(d, "status", GoalStatus.STARTED) as string;
        g.created_at = dictGet(d, "created_at", GOAL_MANAGER_SEAMS.now()) as number;
        g.updated_at = dictGet(d, "updated_at", GOAL_MANAGER_SEAMS.now()) as number;
        g.iterations = dictGet(d, "iterations", []) as unknown[];
        g.metadata = dictGet(d, "metadata", {}) as JsonDict;
        g.continuation_count = dictGet(d, "continuation_count", 0) as number;
        g.max_continuations = dictGet(d, "max_continuations", 10) as number;
        for (const sg of pyIterate(dictGet(d, "sub_goals", []))) {
            g.sub_goals.push(Goal.from_dict(sg));
        }
        return g;
    }
}

// ── GoalManager ──────────────────────────────────────────────────────────────

export type LlmCallback = (prompt_data: JsonDict) => unknown;

/** Manage long-term goals with persistence, iteration tracking, and
 *  auto-continuation. */
export class GoalManager {
    storage: GoalManagerStorage;
    _llm: LlmCallback | null;
    _active_goal: string | null;
    _session_id: string | null;
    _workspace: string;

    constructor(llm_callback: LlmCallback | null = null) {
        const given = arguments.length + 1;
        if (given > 2) throw pyTooMany("GoalManager.__init__", "from 1 to 2", given);
        this.storage = GOAL_MANAGER_SEAMS.get_storage();
        // python `self.telemetry = get_telemetry()` — DELETED (telemetry is a
        // DELETE unit; no successor module exists by design).
        this._llm = llm_callback;
        this._active_goal = null;
        this._session_id = null;
        this._workspace = "";
    }

    /** Bind the goal manager to a session. */
    set_session(session_id: unknown): void {
        if (arguments.length === 0) {
            throw pyMissing("GoalManager.set_session", ["session_id"]);
        }
        if (arguments.length > 1) throw pyTooMany("GoalManager.set_session", "1", arguments.length);
        this._session_id = session_id as string;
    }

    /** Bind the goal manager to a workspace directory. */
    set_workspace(workspace: unknown): void {
        if (arguments.length === 0) {
            throw pyMissing("GoalManager.set_workspace", ["workspace"]);
        }
        if (arguments.length > 1) throw pyTooMany("GoalManager.set_workspace", "1", arguments.length);
        this._workspace = pyStr(pyOr(workspace, ""));
    }

    /** Create a new goal, always with a structured brief attached (D1). */
    create_goal(description?: unknown, priority: unknown = 0, brief: unknown = null): Goal {
        const given = arguments.length + 1;
        if (given < 2) {
            throw pyMissing("GoalManager.create_goal", (["description"] as const).slice(arguments.length));
        }
        if (given > 4) throw pyTooMany("GoalManager.create_goal", "from 2 to 4", given);
        const goal = new Goal(description, priority);

        const resolved = this._resolve_brief(description, brief);
        goal.metadata["brief"] = resolved.toDict();
        goal.metadata["category"] = resolved.category;

        // Category-derived defaults. An explicit brief that carries its own
        // ceiling wins; otherwise the category picks a sane cap.
        const defaults = resolved.getDefaults();
        goal.max_continuations = defaults.maxIter as number;

        this.storage.save_goal(
            goal.id, goal.description, goal.status,
            0, pyOr(this._session_id, ""), "",
        );
        // brief_json / category / caps live outside save_goal's five core fields.
        this.storage.update_goal_fields(goal.id, {
            "brief_json": pyJsonDumps(resolved.toDict(), false),
            "category": resolved.category,
            "max_iterations": defaults.maxIter,
            "cost_cap_micros": defaults.costCapMicros,
        });

        // 契约先行 (Contract-First / ProgramBench)：初始化可执行验收契约
        const ac = _importAcceptanceContract(["normalize_contract", "set_goal_contract"]);
        const contract = (ac.normalize_contract as (payload: JsonDict, gid: string) => unknown)({
            "summary": description,
            "deliverables": resolved.deliverables,
            "acceptance_criteria": resolved.acceptanceCriteria,
            "required_artifacts": this._requiredArtifacts(resolved.deliverables),
            "verification_plan": [],
        }, goal.id);
        (ac.set_goal_contract as (storage: GoalManagerStorage, gid: string, contract: unknown) => unknown)(
            this.storage, goal.id, contract);

        this._active_goal = goal.id;
        this._persist_goal_state();
        return goal;
    }

    /** python `[d for d in deliverables if "." in d or "/" in d]`. */
    private _requiredArtifacts(deliverables: unknown): unknown[] {
        const out: unknown[] = [];
        for (const d of pyIterate(deliverables)) {
            if (pyContains(".", d) || pyContains("/", d)) out.push(d);
        }
        return out;
    }

    /** Normalize whatever the caller passed into a valid GoalBrief. */
    _resolve_brief(description: unknown, brief: unknown): GoalBrief {
        if (arguments.length < 2) {
            throw pyMissing("GoalManager._resolve_brief",
                (["description", "brief"] as const).slice(arguments.length));
        }
        if (arguments.length > 2) throw pyTooMany("GoalManager._resolve_brief", "2", arguments.length);
        if (brief === null) {
            return pyBuildBriefFromPrompt(description);
        }

        const resolved = brief instanceof GoalBrief ? brief : pyGoalBriefFromDict(brief);

        // Patch the two required fields rather than rejecting the brief.
        if (!pyStripAttr(resolved.summary)) {
            resolved.summary = pyBuildBriefFromPrompt(description).summary;
        }
        if (!pyTruth(resolved.deliverables)) {
            resolved.deliverables = ["完成用户请求的任务"];
        }
        if (!pyTruth(resolved.rawPrompt)) {
            resolved.rawPrompt = description as string;
        }
        if (resolved.category === GoalCategory.UNKNOWN) {
            resolved.category = deriveGoalCategory(
                resolved.summary, resolved.deliverables, resolved.rawPrompt,
            );
        }
        return resolved;
    }

    /** Load a goal's structured brief. */
    get_brief(goal_id: unknown): GoalBrief | null {
        if (arguments.length === 0) {
            throw pyMissing("GoalManager.get_brief", ["goal_id"]);
        }
        if (arguments.length > 1) throw pyTooMany("GoalManager.get_brief", "1", arguments.length);
        const r = this.storage.get_goal(goal_id);
        if (r === null || r === undefined) return null;
        const raw = pyOr(dictGet(r, "brief_json"), "");
        if (!pyTruth(raw) || raw === "{}") {
            // Backfill on read: an old goal still gets a usable contract.
            const derived = pyBuildBriefFromPrompt(dictGet(r, "description", ""));
            this.storage.update_goal_fields(goal_id, {
                "brief_json": pyJsonDumps(derived.toDict(), false),
                "category": derived.category,
            });
            return derived;
        }
        try {
            return pyGoalBriefFromDict(pyJsonLoads(raw));
        } catch (e) {
            // python catches (json.JSONDecodeError, TypeError, ValueError);
            // AttributeError (brief_json parsed to a list) propagates.
            if (e instanceof ValueErrorP || e instanceof TypeErrorP) return null;
            throw e;
        }
    }

    /** Replace a goal's brief (e.g. after the user edits it in review). */
    set_brief(goal_id?: unknown, brief?: unknown): Result<unknown> {
        if (arguments.length < 2) {
            throw pyMissing("GoalManager.set_brief",
                (["goal_id", "brief"] as const).slice(arguments.length));
        }
        if (arguments.length > 2) throw pyTooMany("GoalManager.set_brief", "2", arguments.length);
        const r = this.storage.get_goal(goal_id);
        if (r === null || r === undefined) {
            return Result.failure(`Goal not found: ${pyStr(goal_id)}`);
        }
        const resolved = brief instanceof GoalBrief ? brief : pyGoalBriefFromDict(brief);
        const [ok, why] = resolved.isValid();
        if (!ok) {
            return Result.failure(`Invalid goal brief: ${why}`);
        }
        if (resolved.category === GoalCategory.UNKNOWN) {
            resolved.category = deriveGoalCategory(
                resolved.summary, resolved.deliverables, resolved.rawPrompt,
            );
        }
        this.storage.update_goal_fields(goal_id, {
            "brief_json": pyJsonDumps(resolved.toDict(), false),
            "category": resolved.category,
        });
        return Result.success(resolved.toDict());
    }

    /** Get goal by ID. */
    get_goal(goal_id: unknown): Result<unknown> {
        if (arguments.length === 0) {
            throw pyMissing("GoalManager.get_goal", ["goal_id"]);
        }
        if (arguments.length > 1) throw pyTooMany("GoalManager.get_goal", "1", arguments.length);
        const r = this.storage.get_goal(goal_id);
        if (r === null || r === undefined) {
            return Result.failure(`Goal not found: ${pyStr(goal_id)}`);
        }
        return Result.success(r);
    }

    /** List all goals, optionally filtered by status. */
    list_goals(status: unknown = null): unknown {
        if (arguments.length > 1) throw pyTooMany("GoalManager.list_goals", "from 1 to 2", arguments.length + 1);
        return this.storage.list_goals(status);
    }

    /** Update goal status. */
    update_goal_status(goal_id?: unknown, status?: unknown): Result<string> {
        if (arguments.length < 2) {
            throw pyMissing("GoalManager.update_goal_status",
                (["goal_id", "status"] as const).slice(arguments.length));
        }
        if (arguments.length > 2) throw pyTooMany("GoalManager.update_goal_status", "2", arguments.length);
        const r = this.storage.get_goal(goal_id);
        if (r === null || r === undefined) {
            return Result.failure(`Goal not found: ${pyStr(goal_id)}`);
        }
        this.storage.save_goal(
            goal_id, dictGet(r, "description", ""), status,
            dictGet(r, "iteration", 0), dictGet(r, "session_id", ""),
            dictGet(r, "verification_result", ""),
        );
        return Result.success(`Status updated to: ${pyStr(status)}`);
    }

    /** Add an iteration to a goal. */
    add_iteration(goal_id?: unknown, result?: unknown, status: unknown = "progress"): Result<unknown> {
        const given = arguments.length;
        if (given < 2) {
            throw pyMissing("GoalManager.add_iteration",
                (["goal_id", "result"] as const).slice(given));
        }
        if (given > 3) throw pyTooMany("GoalManager.add_iteration", "from 2 to 3", given);
        try {
            const r = this.storage.get_goal(goal_id);
            if (r === null || r === undefined) {
                return Result.failure(`Goal not found: ${pyStr(goal_id)}`);
            }
            const iteration = pyAddOne(dictGet(r, "iteration", 0));
            this.storage.save_goal(
                goal_id, dictGet(r, "description", ""), dictGet(r, "status", "active"),
                iteration, dictGet(r, "session_id", ""),
                dictGet(r, "verification_result", ""),
            );
            return Result.success({ "iteration": iteration, "result": result });
        } catch (e) {
            return Result.failure(`Failed to add iteration: ${pyStrExc(e)}`);
        }
    }

    /** Set the currently active goal. */
    set_active_goal(goal_id?: unknown): Result<string> {
        if (arguments.length === 0) {
            throw pyMissing("GoalManager.set_active_goal", ["goal_id"]);
        }
        if (arguments.length > 1) throw pyTooMany("GoalManager.set_active_goal", "1", arguments.length);
        const r = this.storage.get_goal(goal_id);
        if (r === null || r === undefined) {
            return Result.failure(`Goal not found: ${pyStr(goal_id)}`);
        }
        this._active_goal = goal_id as string;
        this._persist_goal_state();
        return Result.success(`Active goal set to: ${pyStr(dictGet(r, "description"))}`);
    }

    /** Get the active goal ID. */
    get_active_goal(): string | null {
        if (arguments.length > 0) throw pyTooMany("GoalManager.get_active_goal", "0", arguments.length);
        return this._active_goal;
    }

    /** Build a system reminder for the active goal. */
    get_active_goal_context(): string | null {
        if (arguments.length > 0) {
            throw pyTooMany("GoalManager.get_active_goal_context", "0", arguments.length);
        }
        if (!this._active_goal) return null;
        const r = this.storage.get_goal(this._active_goal);
        if (r === null || r === undefined) return null;
        if (!ACTIVE_STATES.has(dictGet(r, "status") as string)) return null;
        const iteration = dictGet(r, "iteration", 0);
        const verRaw = dictGet(r, "verification_result", "");

        const brief = this.get_brief(this._active_goal);
        const parts: unknown[] = [];
        if (brief !== null) {
            parts.push(brief.systemContext());
            parts.push(`(iteration ${pyStr(iteration)})`);
        } else {
            parts.push(`Goal "${pyStr(dictGet(r, "description", ""))}" is active (iteration ${pyStr(iteration)}).`);
        }

        let ver: unknown = {};
        if (pyTruth(verRaw)) {
            try {
                ver = typeof verRaw === "string" ? pyJsonLoads(verRaw) : verRaw;
            } catch {
                ver = {};
            }
        }

        if (isPyDict(ver) && pyTruth(dictGet(ver, "unmet"))) {
            parts.push("\n[CRITICAL - ANTI-EARLY-QUIT GATE FAILED]");
            parts.push("The machine verification gate detected unfulfilled criteria:");
            for (const u of pySliceTop(dictGet(ver, "unmet"), 5) as unknown[]) {
                parts.push(`  - ${pyStr(u)}`);
            }
            parts.push("You MUST resolve these specific failures before attempting to complete the task.");
        } else if (pyTruth(verRaw)) {
            parts.push(`Last verification: ${pyStr(verRaw)}`);
        }

        parts.push("Please continue working on this goal.");
        return pyJoin(parts, "\n");
    }

    /** Persist goal state to the sessions table. */
    _persist_goal_state(): void {
        if (!pyTruth(this._session_id)) return;
        const state = {
            "current_goal_id": this._active_goal,
            "status": this._active_goal ? "active" : "idle",
        };
        this.storage.set_goal_state(this._session_id, state);
    }

    /** Load goal state from sessions table. */
    load_goal_state(session_id: unknown): JsonDict | null {
        if (arguments.length === 0) {
            throw pyMissing("GoalManager.load_goal_state", ["session_id"]);
        }
        if (arguments.length > 1) throw pyTooMany("GoalManager.load_goal_state", "1", arguments.length);
        this._session_id = session_id as string;
        const state = this.storage.get_goal_state(session_id);
        if (pyTruth(state)) {
            this._active_goal = dictGet(state, "current_goal_id") as string | null;
        }
        return state as JsonDict | null;
    }

    /** Pause a goal. */
    pause_goal(goal_id?: unknown): Result<string> {
        if (arguments.length === 0) {
            throw pyMissing("GoalManager.pause_goal", ["goal_id"]);
        }
        if (arguments.length > 1) throw pyTooMany("GoalManager.pause_goal", "1", arguments.length);
        return this.update_goal_status(goal_id, GoalStatus.PAUSED);
    }

    /** Resume a paused goal. */
    resume_goal(goal_id?: unknown): Result<string> {
        if (arguments.length === 0) {
            throw pyMissing("GoalManager.resume_goal", ["goal_id"]);
        }
        if (arguments.length > 1) throw pyTooMany("GoalManager.resume_goal", "1", arguments.length);
        return this.update_goal_status(goal_id, GoalStatus.ACTIVE);
    }

    /** Mark a goal as completed. */
    complete_goal(goal_id?: unknown): Result<string> {
        if (arguments.length === 0) {
            throw pyMissing("GoalManager.complete_goal", ["goal_id"]);
        }
        if (arguments.length > 1) throw pyTooMany("GoalManager.complete_goal", "1", arguments.length);
        const r = this.update_goal_status(goal_id, GoalStatus.COMPLETED);
        if (r.ok && this._active_goal === goal_id) {
            this._active_goal = null;
            this._persist_goal_state();
        }
        return r;
    }

    /** Mark a goal as failed. */
    fail_goal(goal_id?: unknown, reason?: unknown, terminal: unknown = false): Result<string> {
        const given = arguments.length;
        if (given < 2) {
            throw pyMissing("GoalManager.fail_goal", (["goal_id", "reason"] as const).slice(given));
        }
        if (given > 3) throw pyTooMany("GoalManager.fail_goal", "from 2 to 3", given);
        const r = this.storage.get_goal(goal_id);
        if (r === null || r === undefined) {
            return Result.failure(`Goal not found: ${pyStr(goal_id)}`);
        }
        const status = pyTruth(terminal) ? GoalStatus.FAILED_FINAL : GoalStatus.FAILED;
        this.storage.save_goal(
            goal_id, dictGet(r, "description", ""), status,
            dictGet(r, "iteration", 0), dictGet(r, "session_id", ""),
            pyJsonDumps({ "failed": true, "closed": terminal, "reason": reason }, true),
        );
        if (this._active_goal === goal_id) {
            this._active_goal = null;
            this._persist_goal_state();
        }
        return Result.success(`Goal failed: ${pyStr(reason)}`);
    }

    /** Delete a goal (mark as cancelled). */
    delete_goal(goal_id?: unknown): Result<string> {
        if (arguments.length === 0) {
            throw pyMissing("GoalManager.delete_goal", ["goal_id"]);
        }
        if (arguments.length > 1) throw pyTooMany("GoalManager.delete_goal", "1", arguments.length);
        const r = this.storage.get_goal(goal_id);
        if (r === null || r === undefined) {
            return Result.failure(`Goal not found: ${pyStr(goal_id)}`);
        }
        this.storage.save_goal(
            goal_id, dictGet(r, "description", ""), GoalStatus.CANCELLED,
            dictGet(r, "iteration", 0), dictGet(r, "session_id", ""), "",
        );
        if (this._active_goal === goal_id) {
            this._active_goal = null;
            this._persist_goal_state();
        }
        return Result.success(`Goal cancelled: ${pyStr(goal_id)}`);
    }

    /** Verify if a goal is truly complete (Machine Verification Gate first). */
    async verify_completion(goal_id?: unknown, evidence: unknown = "", workspace: unknown = ""): Promise<JsonDict> {
        const given = arguments.length;
        if (given < 1) {
            throw pyMissing("GoalManager.verify_completion", (["goal_id"] as const).slice(given));
        }
        if (given > 3) throw pyTooMany("GoalManager.verify_completion", "from 1 to 3", given);
        try {
            const r = this.storage.get_goal(goal_id);
            if (r === null || r === undefined) {
                return { "passed": false, "reason": "Goal not found", "suggestions": [] };
            }

            const description = dictGet(r, "description", "");
            const iterations = dictGet(r, "iteration", 0);

            // ── 1. 机器硬门禁校验 (Machine Verification Gate) ──
            const ac = _importAcceptanceContract(["get_goal_contract", "check_completion"]);
            const contract = (ac.get_goal_contract as (s: GoalManagerStorage, gid: unknown) => unknown)(
                this.storage, goal_id);
            if (pyTruth(contract)) {
                const ws = pyOr(pyOr(workspace, this._workspace), ".");
                const [machOk, unmet, results] = pyUnpack3(
                    (ac.check_completion as (c: unknown, ws: unknown) => unknown)(contract, ws));
                if (!pyTruth(machOk)) {
                    const reason = `Machine verification gate failed: ${pyJoin(pySliceTop(unmet, 3) as unknown[], "; ")}`;
                    const result: JsonDict = {
                        "passed": false,
                        "reason": reason,
                        "completed": [],
                        "unmet": unmet,
                        "validator_results": results,
                        "suggestions": (pySliceTop(unmet, 5) as unknown[])
                            .map((u) => `Fix failing verification item: ${pyStr(u)}`),
                    };
                    this.storage.save_goal(
                        goal_id, description, dictGet(r, "status", "active"),
                        iterations, dictGet(r, "session_id", ""),
                        pyJsonDumps(result, false),
                    );
                    return result;
                }
            }

            // Prefer the structured brief when one is attached.
            const brief = this.get_brief(goal_id);
            let briefBlock = "";
            if (brief !== null) {
                briefBlock = "\n" + brief.systemContext();
            }

            if (this._llm) {
                let result: unknown = null;
                try {
                    const planBlock = GoalManager._plan_block(goal_id);
                    const promptData: JsonDict = {
                        "task": "goal_verification",
                        "instruction":
                            "You are verifying whether a long-running goal is complete.\n" +
                            `GOAL: ${pyStr(description)}` +
                            `${briefBlock}\n` +
                            `${planBlock}` +
                            `ITERATIONS SO FAR: ${pyStr(iterations)}\n` +
                            `EVIDENCE FROM THE LAST ITERATION:\n${pyStr(evidence)}\n\n` +
                            "Decide whether every acceptance criterion is fully met. " +
                            "Be strict: partial progress is NOT completion.\n" +
                            "Respond with ONLY a JSON object, no prose, no code fences:\n" +
                            '{"passed": true|false, "reason": "<one sentence>", ' +
                            '"completed": [<1-based numbers of the sub-tasks above that are ' +
                            "now fully done, [] if none>], " +
                            '"suggestions": ["<next concrete step>", "..."]}',
                        "goal": description,
                        "brief": brief !== null ? brief.toDict() : null,
                        "iterations": iterations,
                        "evidence": evidence,
                    };
                    if (_isCoroutineFunction(this._llm)) {
                        result = await this._llm(promptData);
                    } else {
                        result = this._llm(promptData);
                    }
                } catch {
                    result = null;
                }

                const coerced = GoalManager._coerce_verification(result);
                if (coerced !== null) {
                    this.storage.save_goal(
                        goal_id, description, dictGet(r, "status", "active"),
                        iterations, dictGet(r, "session_id", ""),
                        pyJsonDumps(coerced, true),
                    );
                    return coerced;
                }
            }

            // Fallback: heuristic verification (no LLM available).
            // P0 fix (audit §2): we can only claim completion when there IS
            // evidence and it shows no signs of incomplete/failed work.
            const incompleteMarkers = [
                "todo", "not yet", "incomplete", "failed", "error",
                "pending", "还没", "未完成", "失败", "待办",
            ];
            const ev = pyLowerAttr(pyOr(evidence, ""));
            const hasEvidence = pyStripAttr(ev).length > 0;
            const looksIncomplete = incompleteMarkers.some((m) => ev.includes(m));
            const passed = hasEvidence && !looksIncomplete;
            let reason: string;
            if (passed) {
                reason = "Heuristic: evidence present with no incomplete markers";
            } else if (!hasEvidence) {
                reason = "Heuristic: no evidence supplied, cannot confirm completion";
            } else {
                reason = "Heuristic: evidence contains incomplete/error markers";
            }
            const result: JsonDict = {
                "passed": passed,
                "reason": reason,
                "suggestions": [],
                // No plan judgement without an LLM.
                "completed": [],
            };
            this.storage.save_goal(
                goal_id, description, dictGet(r, "status", "active"),
                iterations, dictGet(r, "session_id", ""),
                pyJsonDumps(result, true),
            );
            return result;
        } catch (e) {
            return { "passed": false, "reason": pyStrExc(e), "suggestions": [] };
        }
    }

    /** The goal's sub-task list, numbered, for the verifier prompt. */
    static _plan_block(goal_id: unknown): string {
        if (arguments.length === 0) {
            throw pyMissing("GoalManager._plan_block", ["goal_id"]);
        }
        if (arguments.length > 1) throw pyTooMany("GoalManager._plan_block", "1", arguments.length);
        let items: unknown;
        try {
            const gp = _importGoalPlan();
            items = (pyGetAttr(gp, "load_plan", "goal_plan") as (gid: unknown) => unknown)(goal_id);
        } catch {
            return "";
        }
        if (!pyTruth(items)) return "";
        const lines = ["SUB-TASKS (1-based, current status in brackets):"];
        let i = 1;
        for (const item of pyIterate(items)) {
            lines.push(`  ${i}. [${pyStr(pyGetitem(item, "status"))}] ${pyStr(pyGetitem(item, "title"))}`);
            i += 1;
        }
        return pyJoin(lines, "\n") + "\n";
    }

    /** Normalize an LLM verification reply into {passed, reason, suggestions}. */
    static _coerce_verification(raw?: unknown): JsonDict | null {
        if (arguments.length === 0) {
            throw pyMissing("GoalManager._coerce_verification", ["raw"]);
        }
        if (arguments.length > 1) throw pyTooMany("GoalManager._coerce_verification", "1", arguments.length);
        let data: unknown = raw;
        if (typeof raw === "string") {
            let text = pyStrip(raw);
            text = text.replace(/^```[a-zA-Z]*\n?/, "");
            text = pyStrip(text.replace(/\n?```$/, ""));
            try {
                data = pyJsonLoads(text);
            } catch (e) {
                if (!(e instanceof ValueErrorP) && !(e instanceof TypeErrorP)) throw e;
                // Last resort: find the first {...} block in the prose.
                const match = /\{[\s\S]*\}/.exec(text);
                if (match === null) return null;
                try {
                    data = pyJsonLoads(match[0] as string);
                } catch (e2) {
                    if (e2 instanceof ValueErrorP || e2 instanceof TypeErrorP) return null;
                    throw e2;
                }
            }
        }
        if (!isPyDict(data) || !Object.prototype.hasOwnProperty.call(data, "passed")) return null;
        let passed: unknown = dictGet(data, "passed");
        if (typeof passed === "string") {
            passed = ["true", "yes", "1"].includes(pyStripAttr(passed).toLowerCase());
        }
        const suggestionsRaw = pyOr(dictGet(data, "suggestions"), []);
        let suggestions: unknown[];
        if (typeof suggestionsRaw === "string") {
            suggestions = [suggestionsRaw];
        } else {
            // python: [str(s) for s in suggestions] — non-iterable raises.
            suggestions = pyIterate(suggestionsRaw);
        }
        // Which sub-tasks the verifier says are now done. python wraps
        // isinstance(completed, (str, int)) — True (a bool) counts as an int;
        // floats and dicts are NOT wrapped, and a non-(list|tuple) drops to [].
        const completedRaw = pyOr(dictGet(data, "completed"), []);
        let completed: unknown[];
        if (typeof completedRaw === "string" || (typeof completedRaw === "number" && Number.isInteger(completedRaw)) || typeof completedRaw === "boolean") {
            completed = [completedRaw];
        } else if (Array.isArray(completedRaw)) {
            completed = completedRaw;
        } else {
            completed = [];
        }
        return {
            "passed": pyTruth(passed),
            "reason": pyStr(dictGet(data, "reason", "")),
            "suggestions": suggestions.map((s) => pyStr(s)).slice(0, 10),
            "completed": completed.map((c) => pyStr(c)).slice(0, 50),
        };
    }

    /** Auto-continue a goal that failed verification. */
    async continue_goal(goal_id?: unknown, max_iterations: unknown = 10): Promise<Result<unknown>> {
        const given = arguments.length;
        if (given < 1) {
            throw pyMissing("GoalManager.continue_goal", (["goal_id"] as const).slice(given));
        }
        if (given > 2) throw pyTooMany("GoalManager.continue_goal", "from 1 to 2", given);
        try {
            const r = this.storage.get_goal(goal_id);
            if (r === null || r === undefined) {
                return Result.failure(`Goal not found: ${pyStr(goal_id)}`);
            }

            if (!ACTIVE_STATES.has(dictGet(r, "status") as string)) {
                return Result.failure(`Goal is not active: ${pyStr(dictGet(r, "status"))}`);
            }

            const continuationCount = dictGet(r, "iteration", 0);
            if (pyGe(continuationCount, max_iterations)) {
                return Result.failure(
                    `Max iterations (${pyStr(max_iterations)}) exceeded for goal: ${pyStr(goal_id)}`);
            }

            const description = dictGet(r, "description", "");
            const verRaw = dictGet(r, "verification_result", "");
            let ver: unknown = {};
            if (pyTruth(verRaw)) {
                try {
                    ver = pyJsonLoads(verRaw);
                } catch (e) {
                    if (e instanceof ValueErrorP || e instanceof TypeErrorP) ver = {};
                    else throw e;
                }
            }

            const reason = dictGet(ver, "reason", "unknown");
            const suggestions = dictGet(ver, "suggestions", []);

            const reminderParts: unknown[] = [
                `Goal "${pyStr(description)}" is not yet complete.`,
                `Reason: ${pyStr(reason)}`,
            ];
            if (pyTruth(suggestions)) {
                reminderParts.push("Suggestions:");
                for (const s of pyIterate(suggestions)) {
                    reminderParts.push(`  - ${pyStr(s)}`);
                }
            }
            // What is still open, from the goal's own plan.
            let remaining = "";
            try {
                const gp = _importGoalPlan();
                const loaded = (pyGetAttr(gp, "load_plan", "goal_plan") as (gid: unknown) => unknown)(goal_id);
                remaining = (pyGetAttr(gp, "render_unfinished", "goal_plan") as (items: unknown) => unknown)(loaded) as string;
            } catch {
                remaining = "";
            }
            if (pyTruth(remaining)) {
                reminderParts.push(remaining);
            }
            // Phase 2: what already LANDED, not just what remains.
            try {
                const rec = _importRecovery(["render_completed_side_effects"]);
                const landed = (pyGetAttr(rec, "render_completed_side_effects", "recovery") as
                    (gid: unknown, s: GoalManagerStorage) => unknown)(goal_id, this.storage);
                if (pyTruth(landed)) {
                    reminderParts.push(landed);
                }
            } catch {
                // 读不到已落地清单,续跑就无法回答"哪些操作不该重做"。说出来。
                reminderParts.push(
                    "[warning] 已落地副作用清单读取失败：本次续跑无法确认哪些操作" +
                    "已经生效，动手前请先核对当前状态。");
            }
            // ...and what nobody can vouch for.
            try {
                const rec = _importRecovery(["render_unknown_side_effects"]);
                const unresolved = (pyGetAttr(rec, "render_unknown_side_effects", "recovery") as
                    (gid: unknown, s: GoalManagerStorage) => unknown)(goal_id, this.storage);
                if (pyTruth(unresolved)) {
                    reminderParts.push(unresolved);
                }
            } catch {
                reminderParts.push(
                    "[warning] 未结算副作用清单读取失败：可能有操作已派发但结果未知，" +
                    "动手前请先核对当前状态。");
            }
            reminderParts.push(
                `Please continue working on this goal. ` +
                `(Continuation ${pyStr(pyAddOne(continuationCount))}/${pyStr(max_iterations)})`);

            const systemReminder = pyJoin(reminderParts, "\n");
            // NOTE: deliberately does NOT call add_iteration. The scheduler
            // loop already increments the counter exactly once per round.
            return Result.success({
                "system_reminder": systemReminder,
                "iteration": pyAddOne(continuationCount),
                "max_iterations": max_iterations,
            });
        } catch (e) {
            return Result.failure(`Continue goal failed: ${pyStrExc(e)}`);
        }
    }

    /** Get a summary of goal progress. */
    get_progress_summary(goal_id?: unknown): Result<JsonDict> {
        if (arguments.length === 0) {
            throw pyMissing("GoalManager.get_progress_summary", ["goal_id"]);
        }
        if (arguments.length > 1) throw pyTooMany("GoalManager.get_progress_summary", "1", arguments.length);
        const r = this.storage.get_goal(goal_id);
        if (r === null || r === undefined) {
            return Result.failure(`Goal not found: ${pyStr(goal_id)}`);
        }
        const iterations = dictGet(r, "iteration", 0);
        return Result.success({
            "goal_id": goal_id,
            "description": dictGet(r, "description"),
            "status": dictGet(r, "status"),
            "total_iterations": iterations,
            "progress": `${pyStr(iterations)} iterations`,
            "verification_result": dictGet(r, "verification_result", ""),
        });
    }
}

// ── 模块级帮手 ───────────────────────────────────────────────────────────────

function _isCoroutineFunction(fn: unknown): boolean {
    return (
        typeof fn === "function" &&
        (fn as unknown as { constructor: { name: string } }).constructor.name === "AsyncFunction"
    );
}

/** python `build_brief_from_prompt(prompt)`：非 str 实参在
 *  goal_brief._SENTENCE_END.search 处抛 TypeError，这里在缝口复刻同一身份。 */
function pyBuildBriefFromPrompt(prompt: unknown): GoalBrief {
    if (typeof prompt !== "string") {
        throw new TypeErrorP(`expected string or bytes-like object, got '${pyTypeName(prompt)}'`);
    }
    return buildBriefFromPrompt(prompt);
}

/** python `GoalBrief.from_dict(d)`：非 dict 实参在 d.get 处抛 AttributeError。 */
function pyGoalBriefFromDict(d: unknown): GoalBrief {
    if (!isPyDict(d)) {
        throw new AttributeErrorP(`'${pyTypeName(d)}' object has no attribute 'get'`);
    }
    return GoalBrief.fromDict(d as JsonDict);
}

// ── 单例 ─────────────────────────────────────────────────────────────────────

let _manager: GoalManager | null = null;

/** Get the global GoalManager singleton. */
export function get_goal_manager(llm_callback: LlmCallback | null = null): GoalManager {
    if (arguments.length > 1) throw pyTooMany("get_goal_manager", "from 0 to 1", arguments.length);
    if (_manager === null) {
        _manager = new GoalManager(llm_callback);
    }
    return _manager;
}

/** 探针缝：rebinds python's module-level `_manager` singleton. */
export function _set_goal_manager_for_parity(v: GoalManager | null): void {
    _manager = v;
}

// PORT STATUS: confidence=high todos=[0]
