/**
 * recommender.ts — capability recommendation ranking + TTL cache.
 *
 * Ported from `app/backend/recommender.py` (254 lines, unit 164, wave 7).
 *
 * The blueprint's recommendation link: for a user request, locally scan
 * available capabilities (skills + registered tools), score them against the
 * request, and return a ranked shortlist — cached so repeat asks are instant.
 * Scan -> score -> cache, all local. Two consumers: the `recommend` tool
 * (`_recommend_impl` / `register_tools`), and `mount(bus)` which rides
 * `user_prompt_submit` and drops a short shortlist into
 * `context["capability_hints"]` for the TOOLS prompt layer.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/recommender.py -> app/engine/recommender.ts.
 *       Public python spellings verbatim: _CACHE_NS, _CACHE_TTL,
 *       _HINT_MIN_SCORE, _HINT_MAX_ITEMS, _HINT_MIN_QUERY_LEN, _tokens,
 *       Recommender, _score, _scan_skills, _scan_tools, _cache_key,
 *       recommend, clear_cache, render_hints, mount, _on_user_prompt,
 *       _recommend_impl, register_tools, get_recommender.
 *   §2  re semantics: python's `\W+` is UNICODE-aware — \w == CPython's
 *       str-isalnum-or-underscore, which is NOT JS `\w` (ASCII) and drifts
 *       from V8's `\p{L}\p{N}` (ICU newer than this interpreter). The split
 *       runs against PY_WORD_CLASS (py_unidata.ts: the exact code-point class
 *       swept from the live CPython), lowered FIRST, exactly like
 *       `re.split(r"\W+", text.lower())`.
 *   §2  python lengths are code points: the `len(t) > 1` token filter, the
 *       `len(q) < 4` hint gate and the `description[:160]` cut all go through
 *       code-point counting/slicing (a non-BMP char is ONE python char, two
 *       JS units).
 *   §2  every truthiness gate is python truthiness: `if use_cache:`,
 *       `f or ""`, `if score > 0`, `if not query_tokens`, `if not picked` —
 *       pyTruth/pyOr, with a class instance always truthy.
 *   §2  `s.get(k, d)` / `t.attr` are METHOD calls / attribute reads on
 *       duck-typed collaborators: a non-dict item raises AttributeError 'get'
 *       OUT of the scan loop (the try covers only the import + list call); a
 *       missing tool attribute raises the same identity. Missing dict keys
 *       return the default (python None when omitted).
 *   §2  exception identity: TypeErrorP/AttributeErrorP/ValueErrorP carry the
 *       python class name in `.name` and python's str(exc) in `.message`,
 *       including bound-method arity wordings ("Recommender.recommend()
 *       missing 1 required positional argument: 'query'", self counted).
 *   §2  `except Exception:` swallows are preserved exactly: the two scan
 *       imports, and _on_user_prompt's render_hints guard.
 *   §2  `round(x, 4)` is CPython's correctly-rounded round of the double; the
 *       port formats through the exact-value nearest-4-decimal (toFixed) and
 *       parses back (see DIVERGENCE for the tie case).
 *   §2  md5 hexdigest over the utf-8 bytes of the f-string
 *       `f"{scope}|{query}|{','.join(sorted(kinds))}"` — node:crypto
 *       createHash("md5") produces the identical digest.
 *   §2  `results.sort(key=lambda r: -r["score"])` is a STABLE sort; JS sort
 *       is stable (ES2019+), ties keep scan order on both sides.
 *
 * QUIRKS PINNED BY THE PARITY PROBE
 *   §1  \W+ tokenization is Unicode-aware: "帮我写代码" is ONE token,
 *       "👍" separates, a combining accent separates (decomposed "cafe\u0301"
 *       yields "cafe"), and a non-BMP math letter counts as ONE character so
 *       "𝐀b" survives the len>1 filter. JS `\w` would split all of these.
 *   §2  tokens shorter than 2 chars are dropped BEFORE scoring: "a b c" has
 *       an empty token set → every score 0 → empty shortlist, and the kv
 *       entry is still written.
 *   §3  the freshness check short-circuits: a non-dict cached value never
 *       reaches time.time() (zero clock reads from the freshness arm); a dict
 *       without "ts" defaults to 0 → always stale; ts=None/str raises
 *       TypeError out of recommend AFTER the clock read.
 *   §4  cache TTL is strict `<`: now-ts == 300.0 exactly is STALE and
 *       rescans; the write happens with a SECOND clock read.
 *   §5  `kinds` goes through tuple(): a string becomes its CHARACTERS, so
 *       kinds="skill" matches neither "skill" nor "tool" and scans nothing;
 *       a non-iterable raises "'int' object is not iterable" before any kv
 *       call; sorted() is CPython's binary insertion sort — a mixed
 *       int/str pair raises "'<' not supported between instances of ..." with
 *       the comparison direction of pivot < a[mid].
 *   §6  trust/status/risk nudges apply BEFORE the score>0 gate, so a
 *       zero-overlap skill stays excluded even with the +0.05 own bump, and a
 *       disabled skill at 0.5 drops to 0.4 while a 0-hit one stays out.
 *   §7  `(s.get("description") or "")[:160]`: the slice only ever sees
 *       strings (falsy descriptions collapse to ""), because a truthy
 *       non-str field dies EARLIER inside _score's join — "sequence item 1:
 *       expected str instance, int found" (the index counts truthy items).
 *   §8  clear_cache reaches through the PRIVATE storage._db("kv"), executes
 *       the raw SQL with a 1-tuple param, commits, and on ANY failure PRINTS
 *       `[recommender] operation FAILED: {exc}` (stdout, not the log) and
 *       swallows — a missing _db prints the AttributeError text.
 *   §9  render_hints: `(query or "").strip()` — a truthy non-str query (5)
 *       raises AttributeError 'strip'; `float(r.get("score") or 0)` parses
 *       numeric STRINGS ("0.9" → 0.9) and raises ValueError "could not
 *       convert string to float: 'abc'" for junk; the status filter runs only
 *       for items that already passed the score gate (get-call order pinned);
 *       the two header lines are byte-exact.
 *   §10 mount passes priority=20 and the freshly bound _on_user_prompt; the
 *       event callback's payload.get on a non-dict payload raises OUT (the
 *       try covers only render_hints), while a non-dict context silently
 *       returns; a ranking miss must never cost the turn.
 *   §11 _recommend_impl resolves the singleton BEFORE touching args, so a
 *       None args still performs the get_storage() call first, then raises
 *       AttributeError 'get'.
 *   §12 get_recommender() is a module singleton: created on first call,
 *       memoized for the process lifetime; per-scenario order-dependence of
 *       that creation is pinned by the ledger.
 *
 * MIGRATION DECISIONS / DIVERGENCES (documented dispositions)
 *   DIVERGENCE(port, module-level import -> seam): python imports storage at
 *       module level and skill_loader/tools at FUNCTION level; the port
 *       statically imports the landed TS siblings and routes them through
 *       RECOMMENDER_SEAMS whose defaults ARE those real modules. A seam that
 *       throws ModuleNotFoundError reproduces the absent-module arms (the
 *       function-level import failures land in the scan's `except` → [], the
 *       register_tools import failure propagates, exactly as python).
 *   DIVERGENCE(port, float repr boundary): python's score/ts are floats
 *       whose repr leaks through the kv ledger ("1.0", "1700000000.0");
 *       JS numbers cannot tag int vs float, so produced floats carry
 *       PyFloatBox (plan_artifact precedent). A float `limit` (2.0) would
 *       slice here but raise "slice indices must be integers..." in python;
 *       JSON tool callers send ints, and the probe avoids that REPR-only
 *       boundary — recorded, not pinned.
 *   DIVERGENCE(port, round ties): toFixed rounds half-UP on an exact binary
 *       tie where CPython's round is half-even (round(0.03125, 4) → 0.0312
 *       there, 0.0313 here). Scores are hits/len ± {0.05, 0.1}; an exact
 *       4-decimal half needs a 32-token query — the probe avoids half values
 *       by design and no production caller produces one.
 *   DIVERGENCE(port, mount keyword): python's `bus.on(..., priority=20)` is a
 *       keyword call; any duck-typed bus observes the bound VALUE in the
 *       third slot, so the port passes it positionally third.
 *   DIVERGENCE(port, number repr): `str(int)`/`str(float)` in f-strings and
 *       cache keys go through pyStr with the house int-style rendering — only
 *       repr-participating equality would observe the difference and none of
 *       this module's comparisons do.
 *
 * 本文件无待移植项；端口状态行在文件末行。
 */

import { createHash } from "node:crypto";

import { Result } from "./result.js";
import { get_storage } from "./storage.js";
import { get_skill_loader } from "./skill_loader.js";
import { get_tool_registry, ToolDef } from "./tools.js";
import { PY_WORD_CLASS } from "./py_unidata.js";

// ── python-semantics helpers (house style: file-local) ───────────────────────

type JsonDict = Record<string, unknown>;

class TypeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "TypeError";
    }
}
class AttributeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "AttributeError";
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
    if (v instanceof Set) return "set";
    if (v instanceof Map) return "dict";
    if (typeof v === "function") return "function";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
    }
    return typeof v;
}

/** house predicate (memory_layer shape): a value that IS a python dict —
 *  a plain or prototype-less object, not a class instance. */
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
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    // A class instance is a python OBJECT: bool() is True whatever its own
    // fields are, so the empty-container rule only applies to dict shapes.
    if (isPyDict(v)) return Object.keys(v as Record<string, unknown>).length > 0;
    return true;
}

function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

/** python float repr for `str()`: integral values render int-style. */
function pyNumStr(v: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
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

/** python `str(x)` (containers render through repr). */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Set) return "{" + Array.from(v).map(pyRepr).join(", ") + "}";
    if (typeof v === "object") {
        const o = v as Record<string, unknown>;
        return "{" + Object.keys(o).map((k) => pyRepr(k) + ": " + pyRepr(o[k])).join(", ") + "}";
    }
    return String(v);
}

/** python str.strip() with no args: strips isspace() chars. */
function pyStrip(s: string): string {
    return s.replace(/^[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/, "")
        .replace(/[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/, "");
}

/** python len(str) — CODE POINTS, not UTF-16 units. */
function pyLen(s: string): number {
    let n = 0;
    for (const _c of s) n++;
    return n;
}

/** python `x.get(k)` / `x.get(k, d)` on a duck-typed dict: a plain object is
 *  the dict, anything else needs a real `.get` method or raises the
 *  AttributeError identity. Missing key → default (python None when
 *  omitted). */
function pyGetCall(v: unknown, key: string, ...rest: unknown[]): unknown {
    const hasDefault = rest.length >= 1;
    if (v === null || v === undefined || Array.isArray(v) ||
        (typeof v !== "object" && typeof v !== "function")) {
        throw new AttributeErrorP(`'${pyTypeName(v)}' object has no attribute 'get'`);
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
        // A class instance only has .get if it defines one (python dict subclass).
        const get = (v as Record<string, unknown>)["get"];
        if (typeof get !== "function") {
            throw new AttributeErrorP(`'${pyTypeName(v)}' object has no attribute 'get'`);
        }
        return (get as (...a: unknown[]) => unknown).apply(v, [key, ...rest]);
    }
    const o = v as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(o, key)) return o[key];
    return hasDefault ? rest[0] : null;
}

/** python `getattr(x, name)` / `getattr(x, name, default)`: primitives have
 *  no attributes (default or AttributeError), objects walk their prototype
 *  chain like python's MRO. */
function pyGetAttr(v: unknown, name: string, ...rest: unknown[]): unknown {
    const hasDefault = rest.length >= 1;
    if (v === null || v === undefined ||
        (typeof v !== "object" && typeof v !== "function")) {
        if (hasDefault) return rest[0];
        throw new AttributeErrorP(`'${pyTypeName(v)}' object has no attribute '${name}'`);
    }
    const o = v as Record<string, unknown>;
    if (name in o) return o[name];
    if (hasDefault) return rest[0];
    throw new AttributeErrorP(`'${pyTypeName(v)}' object has no attribute '${name}'`);
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
    return new TypeErrorP(
        `${fname}() takes ${takes} ${noun} but ${given} ${verb} given`);
}

/** python float marker: produced floats (time.time(), hit ratios) carry this
 *  box so the kv ledger's repr stays byte-identical with CPython
 *  (plan_artifact precedent). */
export class PyFloatBox {
    constructor(public readonly n: number) {}
}
export function pyFloat(n: number): PyFloatBox { return new PyFloatBox(n); }
function pyFloatRepr(n: number): string {
    return Number.isInteger(n) && Number.isFinite(n) ? `${n}.0` : pyNumStr(n);
}

/** unwrap a produced float for arithmetic. */
function pyFloatNum(v: unknown): number {
    if (v instanceof PyFloatBox) return v.n;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") return v;
    return NaN;
}

/** python round(x, 4) — the nearest 4-decimal value of the exact double,
 *  parsed back (see header DIVERGENCE for the exact-tie spelling). */
function pyRound4(n: number): number {
    return Number(n.toFixed(4));
}

/** python float(x) for the render_hints score read. */
function pyToFloat(v: unknown): number {
    if (v instanceof PyFloatBox) return v.n;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") return v;
    if (typeof v === "string") {
        const s = pyStrip(v);
        if (/^[+-]?(infinity|inf)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
        if (/^[+-]?nan$/i.test(s)) return NaN;
        if (/^[+-]?(\d(_?\d)*(\.(\d(_?\d)*)?)?|\.\d(_?\d)*)([eE][+-]?\d+)?$/.test(s)) {
            return Number(s);
        }
        throw new ValueErrorP(`could not convert string to float: ${pyRepr(v)}`);
    }
    throw new TypeErrorP(`float() argument must be a string or a real number, not '${pyTypeName(v)}'`);
}

/** python `time.time() - ts`: number/bool coerce, anything else raises the
 *  binop identity (left operand is the float clock). */
function pySubFloat(now: number, ts: unknown): number {
    if (ts instanceof PyFloatBox) return now - ts.n;
    if (typeof ts === "number") return now - ts;
    if (typeof ts === "boolean") return now - (ts ? 1 : 0);
    throw new TypeErrorP(`unsupported operand type(s) for -: 'float' and '${pyTypeName(ts)}'`);
}

/** python `float(x) >= min_score`. */
function pyGeFloat(left: number, right: unknown): boolean {
    if (right instanceof PyFloatBox) return left >= right.n;
    if (typeof right === "number" || typeof right === "boolean") return left >= Number(right);
    throw new TypeErrorP(`'>=' not supported between instances of 'float' and '${pyTypeName(right)}'`);
}

/** python max(limit, 1): compares `1 > limit`, so None/str raise with 'int'
 *  as the LEFT type; a bool stays a bool when it wins. */
function pyMaxLimit(limit: unknown): unknown {
    if (limit === null || limit === undefined) {
        throw new TypeErrorP("'>' not supported between instances of 'int' and 'NoneType'");
    }
    if (typeof limit === "boolean") return 1 > Number(limit) ? 1 : limit;
    if (typeof limit === "number") return 1 > limit ? 1 : limit;
    throw new TypeErrorP(`'>' not supported between instances of 'int' and '${pyTypeName(limit)}'`);
}

/** python tuple(x)/iterables: array copies, a string becomes its CODE
 *  POINTS, a dict yields its keys, a set its elements; anything else raises
 *  the not-iterable identity. */
function pyIterableToArray(v: unknown): unknown[] {
    if (Array.isArray(v)) return v.slice();
    if (typeof v === "string") return Array.from(v);
    if (isPyDict(v)) return Object.keys(v as Record<string, unknown>);
    if (v instanceof Set) return Array.from(v as Set<unknown>);
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not iterable`);
}

/** python string `<` — code-point lexicographic with prefix-shorter-first. */
function pyStrCmp(a: string, b: string): number {
    const A = Array.from(a);
    const B = Array.from(b);
    const n = Math.min(A.length, B.length);
    for (let i = 0; i < n; i++) {
        const ca = (A[i] as string).codePointAt(0) as number;
        const cb = (B[i] as string).codePointAt(0) as number;
        if (ca !== cb) return ca < cb ? -1 : 1;
    }
    return A.length === B.length ? 0 : A.length < B.length ? -1 : 1;
}

/** python `x < y` for the sorted() comparator: str/num/bool/None only; a
 *  mixed str/num/None pair raises the binop identity (comparison direction
 *  preserved). */
function pyLess(a: unknown, b: unknown): boolean {
    const aNum = typeof a === "number" || typeof a === "boolean";
    const bNum = typeof b === "number" || typeof b === "boolean";
    if (typeof a === "string" && typeof b === "string") return pyStrCmp(a, b) < 0;
    if (aNum && bNum) return Number(a) < Number(b);
    throw new TypeErrorP(
        `'<' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** CPython list.sort's binarysort for small lists — the comparison sequence
 *  (`pivot < a[mid]`) decides WHICH type pair names the TypeError, so the
 *  sort must be structurally the same, not just order-correct. */
function pySortedCopy(items: unknown[]): unknown[] {
    const a = items.slice();
    for (let i = 1; i < a.length; i++) {
        const pivot = a[i];
        let left = 0;
        let right = i;
        while (left < right) {
            const mid = (left + right) >> 1;
            if (pyLess(pivot, a[mid])) right = mid;
            else left = mid + 1;
        }
        for (let j = i; j > left; j--) a[j] = a[j - 1];
        a[left] = pivot;
    }
    return a;
}

/** python `','.join(sorted(kinds))`. */
function pySortedJoin(items: unknown[]): string {
    const a = pySortedCopy(items);
    let out = "";
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        if (typeof x !== "string") {
            throw new TypeErrorP(`sequence item ${i}: expected str instance, ${pyTypeName(x)} found`);
        }
        out += (i > 0 ? "," : "") + x;
    }
    return out;
}

/** python `results[:limit]`: int (incl. bool) or None end; a float/str end
 *  raises the slice identity. */
function pySliceEnd(list: unknown[], limit: unknown): unknown[] {
    if (limit === null || limit === undefined) return list.slice();
    if (typeof limit === "boolean") return list.slice(0, limit ? 1 : 0);
    if (typeof limit === "number" && Number.isInteger(limit)) return list.slice(0, limit);
    throw new TypeErrorP("slice indices must be integers or None or have an __index__ method");
}

/** python `x in container` for the kinds check: a STRING container is a
 *  SUBSTRING test, a tuple/list is element equality, a dict is KEY
 *  membership, a set its elements; a non-iterable raises the identity. */
function pyContains(member: string, container: unknown): boolean {
    if (typeof container === "string") return container.includes(member);
    if (Array.isArray(container)) return container.some((x) => x === member);
    if (isPyDict(container)) {
        return Object.prototype.hasOwnProperty.call(container, member);
    }
    if (container instanceof Set) return (container as Set<unknown>).has(member);
    throw new TypeErrorP(`argument of type '${pyTypeName(container)}' is not iterable`);
}

/** python str[:160] — code-point cut; a non-str raises subscript identity. */
function pySlice160(v: unknown): string {
    if (typeof v !== "string") {
        throw new TypeErrorP(`'${pyTypeName(v)}' object is not subscriptable`);
    }
    return Array.from(v).slice(0, 160).join("");
}

/** python str(exc) for the print line. */
function pyExcStr(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// ── module constants (verbatim from the source) ──────────────────────────────

export const _CACHE_NS = "recommender";
export const _CACHE_TTL = 300; // seconds

/** Prompt-injection thresholds. A keyword-overlap score is a weak signal, so
 *  the bar is set where a hit means the request literally shares vocabulary
 *  with the capability's name/description. */
export const _HINT_MIN_SCORE = 0.34;
export const _HINT_MAX_ITEMS = 3;
/** Below this, a message is too short for token overlap to mean anything. */
export const _HINT_MIN_QUERY_LEN = 4;

// ── \W+ tokenization (the unit's load-bearing quirk) ─────────────────────────

/** PY_WORD_CLASS is the full "[...]" class of CPython's `\w` (py_unidata.ts,
 *  swept code-point by code-point from the live interpreter); the complement
 *  is python's `\W`. */
const _PY_WORD_INNER = PY_WORD_CLASS.slice(1, -1);
const _NON_WORD_RE = new RegExp("[^" + _PY_WORD_INNER + "]+", "u");

/** {t for t in re.split(r"\W+", (text or "").lower()) if len(t) > 1} */
export function _tokens(text: unknown): Set<string> {
    if (arguments.length === 0) throw pyMissing("_tokens", ["text"]);
    if (arguments.length > 1) throw pyTooMany("_tokens", "1", arguments.length);
    const v = pyOr(text, "");
    if (typeof v !== "string") {
        throw new AttributeErrorP(`'${pyTypeName(v)}' object has no attribute 'lower'`);
    }
    const lowered = v.toLowerCase();
    return new Set(lowered.split(_NON_WORD_RE).filter((t) => pyLen(t) > 1));
}

// ── 测试缝（storage / skill_loader / tools / 时钟 / 打印） ────────────────────

/** storage 上本单元用到的方法（真实现为 storage 单例的同名方法）。 */
export type RecDb = {
    execute(sql: unknown, params?: unknown): unknown;
    commit(): unknown;
};

export type RecStorage = {
    kv_get(key: unknown, ns?: unknown): unknown;
    kv_set(key: unknown, value: unknown, ns?: unknown): unknown;
    _db?(name: unknown): RecDb;
};

/** python `from skill_loader import get_skill_loader` 的最小视图。 */
export type RecSkillLoaderModule = {
    get_skill_loader: () => { list_skills: (include_disabled?: unknown) => unknown };
};

/** python `from tools import ToolDef, get_tool_registry` 的最小视图。
 *  the port passes exactly the four python positional args plus the
 *  domain/risk_level keyword pair as the options bag. */
export type RecToolDefCtor = new (
    name: unknown, description: unknown, schema: unknown, execute: unknown,
    opts?: { domain?: unknown; risk_level?: unknown },
) => unknown;

export type RecToolsModule = {
    ToolDef: RecToolDefCtor;
    get_tool_registry: () => { list_tools: () => unknown; register: (t: unknown) => void };
};

export const RECOMMENDER_SEAMS = {
    /** python `from storage import get_storage` — import 与调用是两步，seam
     *  返回"取 storage 的函数"，调用点与 python 一一对应（web_outbound 形状）。 */
    import_storage: (): (() => RecStorage) =>
        get_storage as unknown as () => RecStorage,
    /** python `from skill_loader import get_skill_loader`（函数级惰性导入）。 */
    import_skill_loader: (): RecSkillLoaderModule => ({
        get_skill_loader: get_skill_loader as unknown as RecSkillLoaderModule["get_skill_loader"],
    }),
    /** python `from tools import ToolDef, get_tool_registry`（函数级惰性导入，
     *  _scan_tools 与 register_tools 共用同一模块对象）。 */
    import_tools: (): RecToolsModule => ({
        ToolDef: ToolDef as unknown as RecToolDefCtor,
        get_tool_registry: get_tool_registry as unknown as RecToolsModule["get_tool_registry"],
    }),
    /** python `time.time()` — 浮点秒（cron_manager 的 now 同款）。 */
    timeNow: (): number => Date.now() / 1000,
    /** python `print(...)` — 宿主能力缝（红线 5：探针逐场景替换记账）。 */
    print: (s: string): void => {
        process.stdout.write(s + "\n");
    },
};

// ── Recommender ──────────────────────────────────────────────────────────────

/** Rank local capabilities against a request, with a TTL cache. */
export class Recommender {
    storage: RecStorage;

    constructor() {
        // python __init__(self) — Recommender(1) reports the __init__ name:
        // "Recommender.__init__() takes 1 positional argument but 2 were given".
        if (arguments.length > 0) {
            throw pyTooMany("Recommender.__init__", "1", arguments.length + 1);
        }
        this.storage = RECOMMENDER_SEAMS.import_storage()();
    }

    /** Overlap score in [0,1]: fraction of query tokens hit in the fields. */
    _score(query_tokens: unknown, ...fields: unknown[]): PyFloatBox {
        if (arguments.length === 0) {
            throw pyMissing("Recommender._score", ["query_tokens"]);
        }
        if (!pyTruth(query_tokens)) return pyFloat(0);
        // " ".join(f for f in fields if f) — falsy fields skipped, the join
        // index counts only the yielded (truthy) items.
        const parts: string[] = [];
        let itemNo = 0;
        for (const f of fields) {
            if (!pyTruth(f)) continue;
            if (typeof f !== "string") {
                throw new TypeErrorP(
                    `sequence item ${itemNo}: expected str instance, ${pyTypeName(f)} found`);
            }
            parts.push(f);
            itemNo++;
        }
        const hay = _tokens(parts.join(" "));
        if (hay.size === 0) return pyFloat(0);
        const qset = query_tokens as Set<string>;
        let hits = 0;
        for (const t of qset) if (hay.has(t)) hits++;
        return pyFloat(hits / qset.size);
    }

    _scan_skills(query_tokens: unknown): JsonDict[] {
        let skills: unknown;
        try {
            const slMod = RECOMMENDER_SEAMS.import_skill_loader();
            skills = slMod.get_skill_loader().list_skills(true);
        } catch {
            return [];
        }
        const out: JsonDict[] = [];
        for (const s of pyIterableToArray(skills)) {
            let score = pyFloatNum(this._score(
                query_tokens, pyGetCall(s, "name", ""), pyGetCall(s, "description", "")));
            // Trust nudges enabled/own skills slightly ahead of untrusted ones.
            if (pyGetCall(s, "trust") === "own") score += 0.05;
            if (pyGetCall(s, "status") === "disabled") score -= 0.1;
            if (score > 0) {
                out.push({
                    kind: "skill",
                    name: pyGetCall(s, "name"),
                    score: pyFloat(pyRound4(score)),
                    description: pySlice160(pyOr(pyGetCall(s, "description"), "")),
                    status: pyGetCall(s, "status"),
                });
            }
        }
        return out;
    }

    _scan_tools(query_tokens: unknown): JsonDict[] {
        let tools: unknown;
        try {
            const toolsMod = RECOMMENDER_SEAMS.import_tools();
            tools = toolsMod.get_tool_registry().list_tools();
        } catch {
            return [];
        }
        const out: JsonDict[] = [];
        for (const t of pyIterableToArray(tools)) {
            let score = pyFloatNum(this._score(
                query_tokens, pyGetAttr(t, "name"), pyGetAttr(t, "description"),
                pyGetAttr(t, "domain")));
            // De-prioritize high-risk tools so recommendations lean safe-first.
            if (pyGetAttr(t, "risk_level", "low") === "high") score -= 0.05;
            if (score > 0) {
                out.push({
                    kind: "tool",
                    name: pyGetAttr(t, "name"),
                    score: pyFloat(pyRound4(score)),
                    description: pySlice160(pyOr(pyGetAttr(t, "description"), "")),
                    domain: pyGetAttr(t, "domain"),
                    risk_level: pyGetAttr(t, "risk_level"),
                });
            }
        }
        return out;
    }

    /** Hash the query *and its scope* into a kv key: skills are loaded per
     *  workspace, so the same question in two projects has two answers. */
    _cache_key(query: unknown, kinds: unknown, scope: unknown = ""): string {
        if (arguments.length < 2) {
            throw pyMissing("Recommender._cache_key", ["query", "kinds"].slice(arguments.length));
        }
        if (arguments.length > 3) {
            throw pyTooMany("Recommender._cache_key", "from 3 to 4", arguments.length + 1);
        }
        const raw = `${pyStr(scope)}|${pyStr(query)}|${pySortedJoin(pyIterableToArray(kinds))}`;
        return createHash("md5").update(raw, "utf8").digest("hex");
    }

    /** Return a ranked shortlist of capabilities for ``query``. */
    recommend(query?: unknown, limit?: unknown, kinds?: unknown,
              use_cache?: unknown, scope?: unknown): JsonDict {
        if (arguments.length === 0) throw pyMissing("Recommender.recommend", ["query"]);
        if (arguments.length > 5) {
            throw pyTooMany("Recommender.recommend", "from 2 to 6", arguments.length + 1);
        }
        const limitV = limit === undefined ? 5 : limit;
        const kindsV = kinds === undefined ? ["skill", "tool"] : kinds;
        const useCacheV = use_cache === undefined ? true : use_cache;
        const scopeV = scope === undefined ? "" : scope;

        const kindsTuple = pyIterableToArray(kindsV);
        const key = this._cache_key(query, kindsTuple, scopeV);
        if (pyTruth(useCacheV)) {
            const cached = this.storage.kv_get(key, _CACHE_NS);
            // short-circuit: a non-dict cached value never reads the clock
            if (isPyDict(cached)) {
                const ts = pyGetCall(cached, "ts", 0);
                if (pySubFloat(RECOMMENDER_SEAMS.timeNow(), ts) < _CACHE_TTL) {
                    return {
                        query: query,
                        results: pyGetCall(cached, "results", []) as unknown[],
                        cached: true,
                    };
                }
            }
        }

        const qtokens = _tokens(query);
        const results: JsonDict[] = [];
        // python tests membership on the ORIGINAL kinds — a string container
        // is a SUBSTRING test (kinds="skill" still scans skills), the tuple
        // copy is only the cache key's normalizer
        if (pyContains("skill", kindsV)) results.push(...this._scan_skills(qtokens));
        if (pyContains("tool", kindsV)) results.push(...this._scan_tools(qtokens));
        // stable sort by -score: ties keep scan order on both sides
        results.sort((a, b) => pyFloatNum(b.score) - pyFloatNum(a.score));
        const sliced = pySliceEnd(results, limitV);

        if (pyTruth(useCacheV)) {
            this.storage.kv_set(
                key, { ts: pyFloat(RECOMMENDER_SEAMS.timeNow()), results: sliced }, _CACHE_NS);
        }
        return { query: query, results: sliced, cached: false };
    }

    /** Drop cached recommendations (best-effort). */
    clear_cache(): void {
        if (arguments.length > 0) {
            throw pyTooMany("Recommender.clear_cache", "1", arguments.length + 1);
        }
        try {
            const dbFn = pyGetAttr(this.storage, "_db");
            if (typeof dbFn !== "function") {
                throw new TypeErrorP(`'${pyTypeName(dbFn)}' object is not callable`);
            }
            const c = (dbFn as (n: unknown) => unknown).call(this.storage, "kv");
            const exec = pyGetAttr(c, "execute");
            if (typeof exec !== "function") {
                throw new TypeErrorP(`'${pyTypeName(exec)}' object is not callable`);
            }
            exec.call(c, "DELETE FROM kv_store WHERE namespace=?", [_CACHE_NS]);
            const commit = pyGetAttr(c, "commit");
            if (typeof commit !== "function") {
                throw new TypeErrorP(`'${pyTypeName(commit)}' object is not callable`);
            }
            commit.call(c);
        } catch (e) {
            // `except Exception as _e: print(...)` — the swallow is behaviour
            RECOMMENDER_SEAMS.print(`[recommender] operation FAILED: ${pyExcStr(e)}`);
        }
    }

    // ------------------------------------------------------------------
    // Prompt injection (main loop)
    // ------------------------------------------------------------------

    /** Render a short capability shortlist for the TOOLS prompt layer.
     *  Returns "" whenever the signal is weak — an ordinary turn costs zero
     *  extra tokens. */
    render_hints(query?: unknown, scope?: unknown, limit?: unknown,
                 min_score?: unknown): string {
        if (arguments.length === 0) throw pyMissing("Recommender.render_hints", ["query"]);
        if (arguments.length > 4) {
            throw pyTooMany("Recommender.render_hints", "from 2 to 5", arguments.length + 1);
        }
        const scopeV = scope === undefined ? "" : scope;
        const limitV = limit === undefined ? _HINT_MAX_ITEMS : limit;
        const minScoreV = min_score === undefined ? _HINT_MIN_SCORE : min_score;

        const q0 = pyOr(query, "");
        if (typeof q0 !== "string") {
            throw new AttributeErrorP(`'${pyTypeName(q0)}' object has no attribute 'strip'`);
        }
        const q = pyStrip(q0);
        if (pyLen(q) < _HINT_MIN_QUERY_LEN) return "";
        const rec = this.recommend(q, pyMaxLimit(limitV), undefined, undefined, scopeV);
        const ranked = pyGetCall(rec, "results", []) as unknown;
        const picked: unknown[] = [];
        for (const r of pyIterableToArray(ranked)) {
            const sc = pyToFloat(pyOr(pyGetCall(r, "score"), 0));
            // the status read only happens for items that passed the gate
            if (pyGeFloat(sc, minScoreV) && pyGetCall(r, "status") !== "disabled") {
                picked.push(r);
            }
        }
        if (picked.length === 0) return "";

        const lines = [
            "## Possibly Relevant Capabilities",
            "本地按关键词重合度排出来的候选，仅供参考——不是「必须用这个」。" +
                "不相关就直接忽略，别为了用上它而绕路。",
        ];
        for (const r of picked) {
            const d0 = pyOr(pyGetCall(r, "description"), "");
            if (typeof d0 !== "string") {
                throw new AttributeErrorP(
                    `'${pyTypeName(d0)}' object has no attribute 'replace'`);
            }
            const desc = pyStrip(d0.split("\n").join(" "));
            lines.push(`- [${pyStr(pyGetCall(r, "kind"))}] ${pyStr(pyGetCall(r, "name"))} — ${desc}`);
        }
        return lines.join("\n");
    }

    /** Subscribe to ``user_prompt_submit`` to publish per-turn hints.
     *  Priority 20 puts this after memory_layer's own injector (priority 10). */
    mount(bus: unknown): void {
        if (arguments.length === 0) throw pyMissing("Recommender.mount", ["bus"]);
        if (arguments.length > 1) {
            throw pyTooMany("Recommender.mount", "2", arguments.length + 1);
        }
        const on = pyGetAttr(bus, "on");
        if (typeof on !== "function") {
            throw new TypeErrorP(`'${pyTypeName(on)}' object is not callable`);
        }
        (on as (...a: unknown[]) => unknown).call(
            bus, "user_prompt_submit", this._on_user_prompt.bind(this), 20);
    }

    /** Write ``context["capability_hints"]`` for this turn (best-effort). */
    _on_user_prompt(event: unknown): void {
        if (arguments.length === 0) throw pyMissing("Recommender._on_user_prompt", ["event"]);
        if (arguments.length > 1) {
            throw pyTooMany("Recommender._on_user_prompt", "2", arguments.length + 1);
        }
        const payloadAttr = pyGetAttr(event, "payload", null);
        const payload = pyTruth(payloadAttr) ? payloadAttr : {};
        const context = pyGetCall(payload, "context");
        if (!isPyDict(context)) return;
        try {
            const block = this.render_hints(
                pyGetCall(payload, "message", ""),
                pyStr(pyOr(pyGetCall(payload, "workspace"), "")),
            );
            if (pyTruth(block)) {
                (context as JsonDict)["capability_hints"] = block;
            }
        } catch {
            // a ranking miss must never cost the user a turn
            return;
        }
    }
}

// ── tool surface + module singleton ──────────────────────────────────────────

export function _recommend_impl(args?: unknown, ctx?: unknown): Result<unknown> {
    if (arguments.length < 2) {
        throw pyMissing("_recommend_impl", ["args", "ctx"].slice(arguments.length));
    }
    if (arguments.length > 2) {
        // module function — no self in the count
        throw pyTooMany("_recommend_impl", "2", arguments.length);
    }
    const rec = get_recommender();
    return Result.success((rec as Recommender).recommend(
        pyGetCall(args, "query", ""),
        pyGetCall(args, "limit", 5),
    ));
}

/** Register the ``recommend`` tool. */
export function register_tools(registry?: unknown): void {
    if (arguments.length > 1) {
        // module function, single defaulted parameter: "takes from 0 to 1"
        throw pyTooMany("register_tools", "from 0 to 1", arguments.length);
    }
    const toolsMod = RECOMMENDER_SEAMS.import_tools();
    const reg = pyTruth(registry) ? registry : toolsMod.get_tool_registry();
    // python evaluates the CALLEE expression `registry.register` before the
    // ToolDef argument — a non-registerable registry raises with an EMPTY
    // construction ledger
    const regFn = pyGetAttr(reg, "register");
    if (typeof regFn !== "function") {
        throw new TypeErrorP(`'${pyTypeName(regFn)}' object is not callable`);
    }
    const t = new toolsMod.ToolDef(
        "recommend",
        "Recommend the most relevant skills/tools for a request (scan -> score -> cache).",
        {
            type: "object",
            properties: {
                query: { type: "string" },
                limit: { type: "integer", default: 5 },
            },
            required: ["query"],
        },
        _recommend_impl,
        { domain: "general", risk_level: "low" },
    );
    (regFn as (...a: unknown[]) => unknown).call(reg, t);
}

let _recommender: Recommender | null = null;

export function get_recommender(): Recommender {
    if (arguments.length > 0) {
        throw pyTooMany("get_recommender", "0", arguments.length);
    }
    if (_recommender === null) {
        _recommender = new Recommender();
    }
    return _recommender;
}

// PORT STATUS: confidence=high todos=[0]
