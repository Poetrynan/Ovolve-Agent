/**
 * router_modules/loop.ts — Agent loop core, LLM streaming, and MoA council mixin.
 *
 * Ported from `app/backend/router_modules/loop.py` (1153 lines, 61982 bytes,
 * sha256_16 of the source recorded in verified/router_modules_loop.json).
 * Bug-for-bug, per RULEBOOK §2 and HANDOFF §5: every fail-open `except`, every
 * falsy-vs-None distinction, and every dead import in the source is reproduced
 * at the same call site, not "improved" away.
 *
 * Naming (§4): `app/backend/router_modules/loop.py` ->
 * `app/engine/router_modules/loop.ts`.
 *
 * DIVERGENCE(port) — async shape (forced by TS, no observable data change):
 *   1. `_check_context_pressure` is sync in python (`probe_context_pressure` is a
 *      blocking call) and async here, because `evolution_pressure.ts` exports the
 *      async form. Both call sites sit inside the async `_agent_loop`, so the
 *      await keeps the ordering identical.
 *   2. Same for the two `from evolution_bridge import notify_turn_interrupted`
 *      arms: python blocks, TS awaits. The swallow-everything `except` is intact.
 *   3. `asyncio.create_task` / `task.cancel()` / `task.done()` and
 *      `asyncio.gather(..., return_exceptions=True)` are reproduced by
 *      `WatchdogTask` and `LOOP_SEAMS.gather` — the watchdog still only fires if
 *      the stream goes quiet, and a gather slot still holds the exception object.
 *   4. `asyncio.sleep(delay)` inside `_image_hint_watchdog` is threaded in as a
 *      third parameter by `create_task`, because python's cancel() reaches into
 *      the ambient library call while TS has to cancel a specific promise.
 *      The signature grew one defaulted parameter; behaviour is unchanged.
 *   5. `from evolution import record_user_correction` is DEAD in the source:
 *      `record_user_correction` is a method on the evolution engine, not a module
 *      function, so that line raises ImportError and the `except Exception: pass`
 *      next to it eats it. Nothing is ever recorded there. TS cannot even name
 *      the export, so the call resolves to `undefined` at the call site and
 *      throws TypeError into the same swallow. Same ledger (empty) either way.
 *   6. python `**kwargs` at a collaborator call site became the callee's own
 *      positional/option shape: `chat_stream(messages, max_tokens, temperature,
 *      system, extra)` and `probe_context_pressure(messages, max_context_tokens,
 *      threshold, session_id, turn_id)` are spread into the order the port
 *      declares; `classify(error=...)` becomes `classify("", error)`.
 *   7. `Result` fields are `readonly` in result.ts, so `res.meta = {...}`
 *      (the needs_confirmation arm) goes through one cast at each site. The
 *      assigned values are byte-identical.
 *   8. `Result.failure(err, ...)` accepts whatever python put in `.error` — a
 *      dict included — so the value is passed through with a type cast instead
 *      of being stringified here (stringifying would change the data).
 *
 * Host contract: this mixin runs on the Router object (unit 188). Methods it
 * calls but does not define live in the other mixins:
 *   dispatch.ts  — `_tool_specs_for`, `_outcome_ok`, `_harvest_images`,
 *                  `_recognize_intent`, `_determine_dispatch`, `_run_tool_call`,
 *                  `_execute`, `_summarize_turn_outcome` (module fn)
 *   admission.ts — `_drain_steer_into`, `_inject_context_refs`,
 *                  `_compose_user_content`, `_accumulate_usage`,
 *                  `_request_overhead_tokens`, `_sync_fold_budget`,
 *                  `_cancel_requested`, `_clear_cancel`, `_skill_guidance_block`,
 *                  `_sync_turn_cache_prefix`
 *   prompt.ts    — `get_system_prompt`, `_strip_leading_junk`,
 *                  `_approved_plan_context`
 *   the host     — bus, llm, models, risk, storage, compactor, tools,
 *                  repeat_tool_guard, max_agent_steps, soft_landing_step,
 *                  session_id, _turn_seq, _turn_model, _base_llm, _turn_effort,
 *                  _sys_cache_prefix, _revealed_tools, _catalogue_dirty
 *
 * PORT STATUS: 本文件无 TODO(port)。
 */

type AnyMod = Record<string, any>;

import * as _moa_mod from "../moa.js";
import * as _agent_phases_mod from "../agent_phases.js";
import * as _evolution_bridge_mod from "../evolution_bridge.js";
import * as _llm_errors_mod from "../llm_errors.js";
import * as _stream_scrubber_mod from "../stream_scrubber.js";
import * as _evolution_mod from "../evolution.js";
import * as _evolution_pressure_mod from "../evolution_pressure.js";

import { Result } from "../result.js";
import { truncate } from "../tools.js";
import { _strip_leading_junk, _approved_plan_context } from "./prompt.js";
import { _summarize_turn_outcome } from "./dispatch.js";
import { MAX_ADVISORS } from "../moa.js";

/* ── CPython 语义小工具（本仓惯例：每个文件自带一份） ─────────────────────── */

const PY_WS = "\\t\\n\\v\\f\\r\\x1c\\x1d\\x1e\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

function pyStrip(s: string): string {
  return s.replace(new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g"), "");
}

function pyRstrip(s: string): string {
  return s.replace(new RegExp(`[${PY_WS}]+$`, "g"), "");
}

/** python `str(e)`（只取消息，不带类型前缀）。 */
function excStr(e: unknown): string {
  const m = (e as { pyMsg?: string })?.pyMsg;
  if (m !== undefined) return m;
  return String((e as Error)?.message ?? e);
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (Array.isArray(v)) return "list";
  if (v instanceof Map) return "dict";
  if (v instanceof Set) return "set";
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) return "dict";
    return (v as object).constructor?.name ?? "object";
  }
  return "object";
}

/** python truthiness (`if x`, `x or y`, `bool(x)`). */
function pyTruth(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  // CPython 的 `bool(obj)` 对普通类实例永远是 True，只有 `__bool__`/`__len__`
  // 能判假。按 `Object.keys().length` 折叠会把一个「字段全是方法」的协作者
  // （任务句柄、守卫对象）当成假。
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      const b = (v as { __bool__?: () => unknown }).__bool__;
      if (typeof b === "function") return pyTruth(b.call(v));
      const ln = (v as { __len__?: () => unknown }).__len__;
      if (typeof ln === "function") return pyTruth(ln.call(v));
      return true;
    }
    const asMap = v as Map<unknown, unknown> & Record<string, unknown>;
    if (typeof asMap.__bool__ === "function") return pyTruth(asMap.__bool__());
    if (typeof asMap.__len__ === "function") return pyTruth(asMap.__len__());
    return Object.keys(v as object).length > 0;
  }
  return true;
}

/** python `a or b` — returns the *value*, not a boolean. */
function pyOr(a: unknown, b: unknown): unknown {
  return pyTruth(a) ? a : b;
}

/** `bool(context and context.get(...))` 之类的 and 链——值语义，不是布尔。 */
function pyAnd(a: unknown, b: unknown): unknown {
  return pyTruth(a) ? b : a;
}

/** python `not a`. */
function pyNot(a: unknown): boolean {
  return !pyTruth(a);
}

/** python `str(x)`. */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (v instanceof Map) {
    return `{${[...v.entries()].map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`).join(", ")}}`;
  }
  if (v instanceof Set) return `{${[...v].map(pyRepr).join(", ")}}`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.repr === "function") return String((o.repr as () => unknown)());
    if (typeof o.__str__ === "string") return o.__str__;
    return `{${Object.keys(o).map((k) => `${pyRepr(k)}: ${pyRepr(o[k])}`).join(", ")}}`;
  }
  return String(v);
}

/** python `repr(x)`. */
function pyRepr(v: unknown): string {
  if (typeof v === "string") {
    const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
    let out = "";
    for (const ch of v) {
      if (ch === "\\") out += "\\\\";
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else out += ch === quote ? `\\${quote}` : ch;
    }
    return `${quote}${out}${quote}`;
  }
  return pyStr(v);
}

/** python `len(x)` — code points for strings. */
function pyLen(v: unknown): number {
  if (typeof v === "string") return [...v].length;
  if (Array.isArray(v)) return v.length;
  if (v instanceof Map || v instanceof Set) return v.size;
  if (v !== null && typeof v === "object") return Object.keys(v as object).length;
  throw new TypeError(`object of type '${pyTypeName(v)}' has no len()`);
}

/** python `x[start:stop]` over code points; `stop` may be negative. */
function pySlice(s: string, start: number, stop?: number): string {
  const cps = [...s];
  const n = cps.length;
  let a = start;
  if (a < 0) a = Math.max(0, n + a);
  let b = stop === undefined ? n : stop;
  if (b < 0) b = Math.max(0, n + b);
  if (a > n) a = n;
  if (b > n) b = n;
  if (b < a) b = a;
  return cps.slice(a, b).join("");
}

/** python `int(x)`: truncate toward zero, CPython error texts. */
function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (Number.isNaN(v)) throw new RangeError("cannot convert float NaN to integer");
    if (!Number.isFinite(v)) throw new RangeError("cannot convert float infinity to integer");
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const s = pyStrip(v);
    if (/^[-+]?[0-9]+$/u.test(s)) return Number(s);
    throw new RangeError(`invalid literal for int() with base 10: '${s}'`);
  }
  throw new TypeError(
    `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

/** python `dict.get(k, default)` — present-but-null returns null, not default. */
function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    throw new TypeError(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  if (obj instanceof Map) return obj.has(key) ? obj.get(key) : dflt;
  return key in (obj as object) ? (obj as Record<string, unknown>)[key] : dflt;
}

/** python `dict.setdefault(k, d)`. */
function dictSetDefault(obj: Record<string, unknown>, key: string, dflt: unknown): unknown {
  if (!(key in obj)) obj[key] = dflt;
  return obj[key];
}

/** python `dict.pop(k, default)`. */
function dictPop(obj: Record<string, unknown>, key: string, dflt: unknown = null): unknown {
  if (key in obj) {
    const v = obj[key];
    delete obj[key];
    return v;
  }
  return dflt;
}

/** python `getattr(obj, name, default)` — default evaluated eagerly by the caller. */
function pyGetAttr(obj: unknown, name: string, dflt: unknown = null): unknown {
  if (obj === null || obj === undefined) return dflt;
  const v = (obj as Record<string, unknown>)[name];
  return v === undefined ? dflt : v;
}

/** python `hasattr(obj, name)`. */
function pyHasAttr(obj: unknown, name: string): boolean {
  return obj !== null && obj !== undefined && (obj as Record<string, unknown>)[name] !== undefined;
}

/** `getattr` where the object may be a mapping: CPython 的字典键不是属性。 */
function pyGetAttrOfObj(obj: unknown, name: string, dflt: unknown): unknown {
  return isDict(obj) ? dflt : pyGetAttr(obj, name, dflt);
}

/** python `obj.name` — a missing name raises CPython's `AttributeError`. */
function pyAttr(obj: unknown, name: string): unknown {
  if (obj === null || obj === undefined) {
    throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute '${name}'`);
  }
  const v = (obj as Record<string, unknown>)[name];
  if (v === undefined) {
    throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute '${name}'`);
  }
  return v;
}

/** python `isinstance(v, dict)` — plain-prototype test (a class instance is not a dict). */
function isDict(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Map) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** python `isinstance(v, (list, tuple, set))`. */
function isSeqLike(v: unknown): boolean {
  return Array.isArray(v) || v instanceof Set;
}

/** python 的 sqlite `Row`：`row["k"] if "k" in row.keys() else None`。
 *  本仓 storage.ts 的 `get_*_messages` 已把 Row 摊平成 plain dict（见
 *  storage/domains/sessions.ts 里的 `.map((x) => ({...x}))`），所以这里
 *  等价地取自有键；缺键返回 null，而不是抛 KeyError。
 *  DIVERGENCE(port): 键集合的来源不同，取值行为逐字一致。 */
function pyRowGet(row: unknown, key: string): unknown {
  if (row instanceof Map) return row.has(key) ? row.get(key) : null;
  if (row === null || typeof row !== "object") return null;
  return Object.prototype.hasOwnProperty.call(row, key)
    ? (row as Record<string, unknown>)[key] : null;
}

/** python `"image" in out` for the modalities payload. */
function pyIn(needle: unknown, haystack: unknown): boolean {
  if (haystack === null || haystack === undefined) return false;
  if (Array.isArray(haystack)) return haystack.some((v) => v === needle);
  if (haystack instanceof Set) return haystack.has(needle as never);
  if (haystack instanceof Map) return haystack.has(needle as never);
  if (typeof haystack === "string") {
    return typeof needle === "string" && needle.length > 0 && haystack.includes(needle);
  }
  if (typeof haystack === "object") {
    return Object.prototype.hasOwnProperty.call(haystack as object, String(needle));
  }
  return false;
}

/** python `round(x, n)` — banker's rounding on the decimal expansion. */
function pyRound(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x;
  const neg = x < 0;
  const s = Math.abs(x).toFixed(digits + 20);
  const keep = s.slice(0, s.length - 20);
  const rest = s.slice(s.length - 20).replace(/0+$/, "");
  let v = Number(keep);
  let dir: "up" | "tie" | "down";
  if (rest === "") dir = "tie";
  else if (rest.charAt(0) < "5") dir = "down";
  else if (rest.charAt(0) > "5" || rest.length > 1) dir = "up";
  else dir = "tie";
  const odd = Math.round(Math.abs(v) * Math.pow(10, digits)) % 2 === 1;
  if (dir === "up" || (dir === "tie" && odd)) v += Math.pow(10, -digits);
  return Number((neg ? -v : v).toFixed(digits));
}

/** python `min(a, b)` for numbers (first-max wins on ties, like CPython). */
function pyMin2(a: number, b: number): number {
  return a <= b ? a : b;
}

/** python `x[-1]` / `x[n:]` on a list, with the IndexError the source raises. */
function pyIndex(arr: unknown[], i: number): unknown {
  const n = Array.isArray(arr) ? arr.length : 0;
  const k = i < 0 ? n + i : i;
  if (k < 0 || k >= n) throw new IndexErrorP("list index out of range");
  return arr[k];
}

/** python `json.dumps(v, ensure_ascii=False)` for the tool-call argument frames. */
function pyJsonDumps(v: unknown): string {
  function enc(x: unknown): string {
    if (x === null || x === undefined) return "null";
    if (typeof x === "boolean") return x ? "true" : "false";
    if (typeof x === "number") {
      if (Number.isNaN(x)) return "NaN";
      if (x === Infinity) return "Infinity";
      if (x === -Infinity) return "-Infinity";
      return String(x);
    }
    if (typeof x === "string") return jsonQuote(x);
    if (Array.isArray(x)) return `[${x.map(enc).join(", ")}]`;
    if (x instanceof Map) {
      return `{${[...x.entries()].map(([k, val]) => `${jsonQuote(String(k))}: ${enc(val)}`).join(", ")}}`;
    }
    if (x instanceof Set) throw new TypeError(`Object of type set is not JSON serializable`);
    if (typeof x === "object") {
      const o = x as Record<string, unknown>;
      return `{${Object.keys(o).map((k) => `${jsonQuote(k)}: ${enc(o[k])}`).join(", ")}}`;
    }
    throw new TypeError(`Object of type ${pyTypeName(x)} is not JSON serializable`);
  }
  return enc(v);
}

/** python's `ensure_ascii=False` string escaping. */
function jsonQuote(s: string): string {
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
    else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

class CancelledErrorP extends Error {
  constructor() { super(""); this.name = "CancelledError"; }
}
class AttributeErrorP extends Error {
  constructor(m: string) { super(m); this.name = "AttributeError"; }
}
class IndexErrorP extends Error {
  constructor(m: string) { super(m); this.name = "IndexError"; }
}
class ImportErrorP extends Error {
  constructor(m: string) { super(m); this.name = "ImportError"; }
}
class KeyErrorP extends Error {
  constructor(m: string) { super(m); this.name = "KeyError"; }
}
class TypeErrorP extends Error {
  constructor(m: string) { super(m); this.name = "TypeError"; }
}

/** python `obj[key]` 下标：dict 缺键是 KeyError(repr(key))，非容器是 TypeError。
 *  与 dictGet(.get) 严格分家——源里两种写法observable 行为不同。 */
function pySub(obj: unknown, key: string): any {
  if (Array.isArray(obj)) {
    const idx = Number(key);
    if (!Number.isInteger(idx)) {
      throw new TypeErrorP("list indices must be integers or slices, not str");
    }
    if (!(idx >= 0 && idx < obj.length)) throw new IndexErrorP("list index out of range");
    return obj[idx];
  }
  if (obj !== null && typeof obj === "object") {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) throw new KeyErrorP(`'${key}'`);
    return (obj as Record<string, unknown>)[key];
  }
  throw new TypeErrorP(`'${pyTypeName(obj)}' object is not subscriptable`);
}

/** python `str(e)` inside an f-string: `f"LLM stream failed: {e}"`. */
function pyExcStr(e: unknown): string {
  if (e instanceof Error) return e.name !== "Error" && !e.message
    ? e.name : e.message;
  return pyStr(e);
}

/* ── seams：所有宿主触点与函数级 import 都从这里走 ───────────────────────── */

export type LoopTaskHandle = {
  done(): boolean;
  cancel(): void;
};

export const LOOP_SEAMS = {
  /** python `time.time()`。 */
  now: (): number => Date.now() / 1000,
  /** python `print(...)`。 */
  print_: (line: string): void => { console.log(line); },
  /** python `asyncio.sleep(delay)`（看门狗用；见 DIVERGENCE 4）。 */
  sleep: (delay: number): Promise<void> =>
    new Promise((resolve) => { setTimeout(resolve, delay * 1000); }),
  /** python `asyncio.create_task(coro)`。 */
  create_task: (
    make: (sleep: (s: number) => Promise<void>) => Promise<void>): LoopTaskHandle =>
    new WatchdogTask(make),
  /** python `asyncio.gather(*coros, return_exceptions=True)` — 顺序保留，异常进槽。 */
  gather: (promises: Promise<unknown>[]): Promise<unknown[]> =>
    Promise.all(promises.map((p) => Promise.resolve(p).catch((e) => e))),
  /** python `range(n)` / `itertools.count(0)` 的步序号来源。 */
  range: (n: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(i);
    return out;
  },

  // ── 模块级 import（python 侧可通过替换模块全局打桩） ──
  truncate: (text: unknown, max_chars?: number): string =>
    truncate(String(text === undefined || text === null ? "" : text), max_chars ?? 5000, null),
  stripLeadingJunk: (text: string): string => _strip_leading_junk(text),
  approvedPlanContext: (messages: any[], context: Record<string, any>): [any[], Record<string, any>] =>
    _approved_plan_context(messages, context),
  summarizeTurnOutcome: (trace: Record<string, any>[]): Record<string, unknown> =>
    _summarize_turn_outcome(trace),

  // ── 函数级 import（python 的 `from X import y` 发生在调用点） ──
  moaModule: (): AnyMod => _moa_mod as AnyMod,
  strip_moa_prefix: (msg: unknown): [boolean, string] => _moa_mod.strip_moa_prefix(msg),
  max_advisors: (): number => MAX_ADVISORS,
  select_advisors: (candidates: unknown, current: unknown, limit: number): unknown[] =>
    _moa_mod.select_advisors(candidates, current, limit),
  convene: (base_llm: unknown, advisors: unknown, question: unknown, tail: unknown): Promise<any> =>
    _moa_mod.convene(base_llm, advisors, question, tail),

  agentPhasesModule: (): AnyMod => _agent_phases_mod as AnyMod,
  turn_phase: (name: string): string => (_agent_phases_mod.TurnPhase as AnyMod)[name],
  emit_phase: (bus: unknown, phase: string, opts: Record<string, unknown>): Promise<void> =>
    (_agent_phases_mod.emit_phase as any)(bus, phase as any, opts),

  evolutionBridgeModule: (): AnyMod => _evolution_bridge_mod as AnyMod,
  // 源里 `notify_turn_interrupted(sid, tid, reason="user_cancelled")` 的关键字
  // 实参落成端口的第三个位置参（名字就叫 reason）。值原样传，不做加工。
  // DIVERGENCE(port): 该函数在端口是 async，调用点必须 await（见文件头 2）。
  notify_turn_interrupted: (session_id: unknown, turn_id: unknown,
    reason: unknown = ""): Promise<any> =>
    (_evolution_bridge_mod.notify_turn_interrupted as any)(session_id, turn_id, reason),

  llmErrorsModule: (): AnyMod => _llm_errors_mod as AnyMod,
  classify: (code: unknown, error: unknown): string =>
    (_llm_errors_mod.classify as any)(code, error),
  describe: (failure: unknown): string => (_llm_errors_mod.describe as any)(failure),
  recovery_for: (failure: unknown): string => (_llm_errors_mod.recovery_for as any)(failure),
  is_permanent: (failure: unknown): boolean => (_llm_errors_mod.is_permanent as any)(failure),
  recover_none: (): string => _llm_errors_mod.RECOVER_NONE,

  streamScrubberModule: (): AnyMod => _stream_scrubber_mod as AnyMod,
  strip_protocol_tags: (text: unknown): string =>
    (_stream_scrubber_mod.strip_protocol_tags as any)(text),

  /** 源里这条 import 是死的（evolution 没有这个模块级函数），见 DIVERGENCE 5。
   *  找不到这个名字就抛 ImportErrorP，和 python 的 `from evolution import ...` 一样
   *  落进同一处 `except Exception: pass`，而不是静默地少记一条。 */
  evolutionModule: (): AnyMod => _evolution_mod as AnyMod,
  record_user_correction: (...args: unknown[]): unknown => {
    const fn = (_evolution_mod as AnyMod)["record_user_correction"];
    if (typeof fn !== "function") {
      throw new ImportErrorP(
        "cannot import name 'record_user_correction' from 'evolution' (unknown location)");
    }
    return (fn as (...a: unknown[]) => unknown)(...args);
  },

  evolutionPressureModule: (): AnyMod => _evolution_pressure_mod as AnyMod,
  probe_context_pressure: (messages: unknown[], max_context_tokens: number,
    threshold: number, session_id: unknown, turn_id: unknown): Promise<[boolean, number, string | null]> =>
    (_evolution_pressure_mod.probe_context_pressure as any)(messages, max_context_tokens,
      threshold, session_id, turn_id),
};

/** 探针用：整体替换 seams（对应 python 侧 monkeypatch 模块全局）。 */
export function _set_seams_for_parity(patch: Partial<typeof LOOP_SEAMS>): void {
  Object.assign(LOOP_SEAMS, patch);
}

/** 探针用：恢复默认实现（对应 python 侧 reload）。 */
export function _reset_seams_for_parity(): void {
  LOOP_SEAMS.now = (): number => Date.now() / 1000;
  LOOP_SEAMS.print_ = (line: string): void => { console.log(line); };
  LOOP_SEAMS.sleep = (delay: number): Promise<void> =>
    new Promise((resolve) => { setTimeout(resolve, delay * 1000); });
  LOOP_SEAMS.create_task = (make): LoopTaskHandle => new WatchdogTask(make);
  LOOP_SEAMS.gather = (promises: Promise<unknown>[]): Promise<unknown[]> =>
    Promise.all(promises.map((p) => Promise.resolve(p).catch((e) => e)));
  LOOP_SEAMS.range = (n: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(i);
    return out;
  };
  LOOP_SEAMS.truncate = (text: unknown, max_chars?: number): string =>
    truncate(String(text === undefined || text === null ? "" : text), max_chars ?? 5000, null);
  LOOP_SEAMS.stripLeadingJunk = (text: string): string => _strip_leading_junk(text);
  LOOP_SEAMS.approvedPlanContext = (messages: any[], context: Record<string, any>) =>
    _approved_plan_context(messages, context);
  LOOP_SEAMS.summarizeTurnOutcome = (trace: Record<string, any>[]) => _summarize_turn_outcome(trace);
  LOOP_SEAMS.moaModule = (): AnyMod => _moa_mod as AnyMod;
  LOOP_SEAMS.strip_moa_prefix = (msg: unknown) => _moa_mod.strip_moa_prefix(msg);
  LOOP_SEAMS.max_advisors = (): number => MAX_ADVISORS;
  LOOP_SEAMS.select_advisors = (c: unknown, cur: unknown, limit: number) =>
    _moa_mod.select_advisors(c, cur, limit);
  LOOP_SEAMS.convene = (b: unknown, a: unknown, q: unknown, t: unknown) =>
    _moa_mod.convene(b, a, q, t);
  LOOP_SEAMS.agentPhasesModule = (): AnyMod => _agent_phases_mod as AnyMod;
  LOOP_SEAMS.turn_phase = (name: string): string => (_agent_phases_mod.TurnPhase as AnyMod)[name];
  LOOP_SEAMS.emit_phase = (bus: unknown, phase: string, opts: Record<string, unknown>) =>
    (_agent_phases_mod.emit_phase as any)(bus, phase as any, opts);
  LOOP_SEAMS.evolutionBridgeModule = (): AnyMod => _evolution_bridge_mod as AnyMod;
  LOOP_SEAMS.notify_turn_interrupted = (s: unknown, t: unknown, r: unknown) =>
    (_evolution_bridge_mod.notify_turn_interrupted as any)(s, t, r);
  LOOP_SEAMS.llmErrorsModule = (): AnyMod => _llm_errors_mod as AnyMod;
  LOOP_SEAMS.classify = (code: unknown, error: unknown) => (_llm_errors_mod.classify as any)(code, error);
  LOOP_SEAMS.describe = (failure: unknown) => (_llm_errors_mod.describe as any)(failure);
  LOOP_SEAMS.recovery_for = (failure: unknown) => (_llm_errors_mod.recovery_for as any)(failure);
  LOOP_SEAMS.is_permanent = (failure: unknown) => (_llm_errors_mod.is_permanent as any)(failure);
  LOOP_SEAMS.recover_none = (): string => _llm_errors_mod.RECOVER_NONE;
  LOOP_SEAMS.streamScrubberModule = (): AnyMod => _stream_scrubber_mod as AnyMod;
  LOOP_SEAMS.strip_protocol_tags = (text: unknown) =>
    (_stream_scrubber_mod.strip_protocol_tags as any)(text);
  LOOP_SEAMS.evolutionModule = (): AnyMod => _evolution_mod as AnyMod;
  LOOP_SEAMS.record_user_correction = (...args: unknown[]) => {
    const fn = (_evolution_mod as AnyMod)["record_user_correction"];
    if (typeof fn !== "function") {
      throw new ImportErrorP(
        "cannot import name 'record_user_correction' from 'evolution' (unknown location)");
    }
    return (fn as (...a: unknown[]) => unknown)(...args);
  };
  LOOP_SEAMS.evolutionPressureModule = (): AnyMod => _evolution_pressure_mod as AnyMod;
  LOOP_SEAMS.probe_context_pressure = (m: unknown[], mt: number, th: number, s: unknown, t: unknown) =>
    (_evolution_pressure_mod.probe_context_pressure as any)(m, mt, th, s, t);
}


// 宿主提供的方法（其它 mixin / 单元；对应 python 的 Router 组合类）
function hostMissing(name: string): never {
  throw new Error(`${name} must be implemented by host router`);
}
void hostMissing;

/** python `pass` —— 让每一处 `except Exception: pass` 的吞掉动作显式可见。 */
function pass(): void { /* noop */ }

/* ── 模块常量（wire/UI 契约，逐字保留） ───────────────────────────────────── */

export const IMAGE_HINT_DELAY = 2.5;
export const TOOL_ARG_FRAME_INTERVAL = 0.08;

export const INTERRUPT_NOTE_TYPE = "interrupt_note";
export const INTERRUPT_NUDGE =
  "[系统提示] 上一回合是被用户主动中止的，不是正常完成——工具可能只跑了一半。"
  + "接下来回答前：先说明当时进行到哪一步、哪些改动已经落盘，再等用户指示要继续还是换做法。"
  + "不要假设上一个任务已经做完。";

export const SOFT_LANDING_NOTICE =
  "[系统提示] 这一回合的工具步数快用完了（还剩两步）。现在别再开新的活儿，"
  + "把手上的收尾并交接：\n"
  + "1. 已经做完并落盘的改动（文件 + 具体改了什么）；\n"
  + "2. 还没做完的部分，以及当前卡在哪；\n"
  + "3. 下一步具体该做什么（一句话，能直接照着做）。\n"
  + "如果剩下的活儿本来就长，说清楚建议到「目标」面板建目标跑——那条路有独立的迭代预算。";

/**
 * `asyncio.Task` 的最小可用替身：`cancel()` 必须打断正在进行的那一次
 * `sleep`，并让 body 以 CancelledError 结束——源里看门狗就靠这个静默。
 */
class WatchdogTask implements LoopTaskHandle {
  private _done = false;
  private _cancelled = false;
  private _reject: ((e: unknown) => void) | null = null;
  readonly promise: Promise<void>;

  constructor(make: (sleep: (s: number) => Promise<void>) => Promise<void>) {
    const sleep = (s: number): Promise<void> => new Promise<void>((resolve, reject) => {
      this._reject = reject;
      LOOP_SEAMS.sleep(s).then(() => { this._reject = null; resolve(); },
        (e) => { this._reject = null; reject(e); });
    });
    this.promise = make(sleep).then(
      () => { this._done = true; },
      (e) => {
        this._done = true;
        // python：任务里未捕获的异常默认被静默吞掉（除了 CancelledError）。
        void e;
      });
  }

  done(): boolean { return this._done; }

  cancel(): void {
    if (this._done) return;
    this._cancelled = true;
    if (this._reject) {
      const rej = this._reject;
      this._reject = null;
      rej(new CancelledErrorP());
    }
  }

  get cancelled(): boolean { return this._cancelled; }
}

/* ── mixin ─────────────────────────────────────────────────────────────────── */

export class RouterLoopMixin {
  /** Mixin providing _agent_loop, streaming LLM chat, and MoA council. */
  [k: string]: any;

  _bind_turn_model(requested: string): Record<string, any> {
    /** Point this turn at the model the composer picked.
     *
     * ``requested`` is the UI's ``"providerId:modelId"`` composite (or a bare
     * model id). It used to be dropped on the floor — the picker changed a
     * label and nothing else, because the backend only ever read config.json.
     *
     * Every failure path lands on the config client, so the worst case is the
     * behaviour we had before this existed rather than a broken turn.
     *
     * Returns:
     *     The resolved descriptor, or ``{}`` when nothing was requested.
     */
    let req = pyStrip(pyStr(requested === null || requested === undefined ? "" : requested));
    if (!pyTruth(req)) {
      const fallback = pyStrip(pyStr(pyOr(
        pyOr(this._turn_model, pyGetAttr(this, "workspace_model", "")), "")));
      if (pyTruth(fallback)) req = fallback;
    }
    if (!pyTruth(req)) {
      this._turn_model = "";
      this.llm = this._base_llm;
      return {};
    }
    let info: any;
    try {
      info = this.models.resolve(req);
    } catch {
      this._turn_model = "";
      this.llm = this._base_llm;
      return {};
    }
    if (!info.ok || !isDict(info.value)) {
      this._turn_model = "";
      this.llm = this._base_llm;
      return {};
    }
    const resolved = info.value as Record<string, any>;
    this._turn_model = req;
    this.llm = this._base_llm === null || this._base_llm === undefined
      ? null : this._base_llm.bind(resolved);
    return resolved;
  }

  async _agent_loop(user_message: string, context: Record<string, any>): Promise<[Result, any[]]> {
    /** Run the plan -> call tools -> observe -> repeat loop.
     *
     * Args:
     *     user_message: The user's message for this turn.
     *     context: Per-turn context (mutated with risk level per call).
     *
     * Returns:
     *     ``(result, trace)`` where trace lists每 executed tool call for
     *     auditing and UI rendering.
     */
    // /moa 会诊触发：剥掉前缀，剩余文本才是本轮真正的用户请求。
    // 触发意图挂进 context（steer 重建走同一条路时不重复触发——只有
    // 首次进入带原始 user_message 的这一步能置位）。
    let msg = user_message;
    const [_moa_pair0, _moa_pair1] = LOOP_SEAMS.strip_moa_prefix(msg);
    const _moa_requested = _moa_pair0;
    msg = _moa_pair1;
    context["_moa_requested"] = _moa_requested;
    this._benchmark_mode = pyTruth(dictGet(context, "benchmark"));

    const system_prompt = pyStr(this.get_system_prompt(context))
      + pyStr(this._skill_guidance_block(context));
    this._sync_turn_cache_prefix(system_prompt);
    try {
      this._last_turn_system_prompt_tokens = this.compactor.estimate_tokens(system_prompt);
    } catch {
      this._last_turn_system_prompt_tokens = 0;
    }
    const is_silent = pyTruth(context) && pyTruth(dictGet(context, "silent_consent"));
    const messages: any[] = this._build_history(20, !is_silent);
    await this._inject_context_refs(messages, context);
    if (!(is_silent && messages.length > 0
      && dictGet(messages[messages.length - 1], "role") === "user")) {
      messages.push({ role: "user", content: this._compose_user_content(msg, context) });
    }

    // Plan 档执行轮：已批准方案的合同注入（缺口 B）。必须在 messages
    // 构建之后、MoA/工具目录之前——合同是本轮的根指令，优先级高于
    // 一切会诊与目录裁剪；meta_extra 经 context 落到终态 meta。
    if (isDict(context) && pyTruth(dictGet(context, "approved_plan"))) {
      const [_pm, _pa_meta] = LOOP_SEAMS.approvedPlanContext(messages, context);
      messages.length = 0;
      for (const m of _pm) messages.push(m);
      if (pyTruth(_pa_meta)) {
        Object.assign(dictSetDefault(context, "_plan_meta", {}) as object, _pa_meta);
      }
    }

    // MoA 会诊：在首轮模型调用前并行征求advisor意见，把「同行会诊」
    // 块并入本轮末尾的 user 消息。fail-open——没配第二个模型、advisor
    // 全挂、超时，都只退回单模型，一轮对话绝不因会诊缺席而失败。
    if (pyTruth(_moa_requested)) {
      try {
        await this._run_moa_council(messages, msg, context);
      } catch (raw) {
        const _moa_e = raw instanceof Error ? excStr(raw) : pyStr(raw);
        LOOP_SEAMS.print_(`[moa] council failed (fail-open): ${pyStr(_moa_e)}`);
      }
    }

    // 六·UC1：本轮的目录视图从零开始重算 —— 相关性来自这一轮的请求，上一轮
    // 浮出来的工具不再自动可见。`_turn_query` 是 `_tool_specs_for` 打分用的
    // 唯一输入，放进 context 而不是当参数传，是为了让 steer 之后的重建走
    // 同一条路、不需要把 user_message 一路带下去。
    this._revealed_tools = new Set();
    this._catalogue_dirty = false;
    context["_turn_query"] = msg;

    let tool_specs = this._tool_specs_for(context);
    const trace: Record<string, any>[] = [];
    const turn_reasonings: Record<string, any>[] = [];
    context["turn_reasonings"] = turn_reasonings;

    // `range(self.max_agent_steps) if ... > 0 else itertools.count(0)`
    const _cap = Number(this.max_agent_steps);
    const _steps: number[] | null = _cap > 0 ? LOOP_SEAMS.range(_cap) : null;
    let _si = 0;
    for (;;) {
      if (_steps !== null && _si >= _steps.length) break;
      const step: number = _steps === null ? _si : (_steps[_si] as number);
      _si += 1;

      // The step boundary is the observable checkpoint of the agent loop:
      // cancellation, steering and cost caps are all enforced here, so it
      // is also the phase a stuck turn will be sitting in.
      await LOOP_SEAMS.emit_phase(this.bus, LOOP_SEAMS.turn_phase("STEP_BOUNDARY"),
        { session_id: this.session_id, extra: { step } });

      if (step === 0) {
        const approved = dictPop(context, "approved_pending", null);
        if (approved !== null && approved !== undefined) {
          const call_id = pyOr(
            pyOr(
              pyOr(pyGetAttrOfObj(approved, "call_id", null),
                isDict(approved) ? dictGet(approved, "call_id") : ""),
              pyOr(dictGet(context, "consent_call_id"), "")),
            "");
          const tool_name = pyOr(pyGetAttrOfObj(approved, "tool_name", null),
            isDict(approved) ? dictGet(approved, "tool_name") : "");
          const tool_args = isDict(approved)
            ? dictGet(approved, "args", {})
            : pyGetAttr(approved, "args", null);
          const call = { id: call_id, name: tool_name, arguments: tool_args };
          context["confirmed"] = true;
          await LOOP_SEAMS.emit_phase(this.bus,
            LOOP_SEAMS.turn_phase("TOOL_EXECUTION_STARTED"), {
              session_id: this.session_id,
              extra: { step, tools: [tool_name] },
            });
          let outcome = await this._run_tool_call(call, context);
          await LOOP_SEAMS.emit_phase(this.bus,
            LOOP_SEAMS.turn_phase("TOOL_EXECUTION_FINISHED"), {
              session_id: this.session_id,
              extra: { step, tools: [tool_name], ok: this._outcome_ok(outcome) },
            });
          trace.push(pySub(outcome, "trace"));
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [{
              id: call_id,
              type: "function",
              function: {
                name: tool_name,
                arguments: (isDict(tool_args) || Array.isArray(tool_args))
                  ? pyJsonDumps(tool_args) : pyStr(tool_args),
              },
            }],
          });
          messages.push({ role: "tool", tool_call_id: call_id, content: pySub(outcome, "content") });
          if (pyTruth(dictGet(outcome, "halt"))) {
            const is_confirm = pyStr(pyGetAttr(dictGet(outcome, "trace", {}) ?? {},
              "status", "")) === "needs_confirmation";
            const res = Result.success(pyTruth(is_confirm) ? "" : pySub(outcome, "content"));
            if (is_confirm) {
              // DIVERGENCE(port): result.ts 的 `meta` 是 readonly，源的整包替换
              // 在此走一次强转，值本身不变。
              (res as unknown as { meta: Record<string, any> }).meta = {
                needs_confirmation: true,
                ...((dictGet(outcome, "confirm_meta") || {}) as object),
              };
            }
            return [res, trace];
          }
          continue;
        }
      }

      // 真Steer — mid-flight course correction.
      //
      // The step boundary is the ONLY safe injection point: the provider
      // requires every assistant tool_calls message to be followed by its
      // matching tool results, so slipping a user message between them
      // would produce an invalid conversation. Here the previous step is
      // fully settled and the next model call hasn't been made yet, so an
      // extra user turn is legal and the model sees it immediately.
      //
      // Drains the whole queue: if the user fired three corrections while
      // a slow tool ran, all three land, in order, rather than one per step.
      const steered = await this._drain_steer_into(messages, step);
      if (pyTruth(steered)) {
        // If cancellation was triggered by a hard preempt for this steer,
        // clear the cancel flag so the turn continues with the new prompt.
        this._clear_cancel();
        // New instructions change what the model may legitimately need,
        // so re-read the tool specs (mode/permission may also have moved).
        tool_specs = this._tool_specs_for(context);
        this._catalogue_dirty = false;
        context["steered"] = true;
      } else if (pyTruth(this._cancel_requested())) {
        // Pure cancellation without steer: user clicked Stop.
        try {
          await LOOP_SEAMS.notify_turn_interrupted(this.session_id,
            `turn_${pyStr(this._turn_seq)}`, "user_cancelled");
        } catch {
          pass();
        }
        return [Result.failure("已中断（用户点击了停止）", null,
          { cancelled: true, turn_outcome: "cancelled" }), trace];
      } else if (pyTruth(this._catalogue_dirty)) {
        // 六·UC1：上一步 `tool_search` 浮出了新工具。步边界是唯一能安全
        // 换目录的时机 —— 请求一旦发出，那一次调用的目录就定了，所以命中
        // 的工具从**下一次**模型调用开始可见，而不是当场生效。
        tool_specs = this._tool_specs_for(context);
        this._catalogue_dirty = false;
      }

      // Soft landing. Two steps before the hard cap, tell the model that
      // room is running out and ask it to write a handover instead of
      // starting something new. Without this the cap arrives mid-action and
      // everything the turn discovered — files read, causes ruled out, the
      // half-applied edit — dies with the in-memory message list, and the
      // user gets a canned "ran out of steps" with nothing to resume from.
      // The hard cap below is unchanged: this only changes what the model
      // spends its last two steps on.
      if (Number(this.soft_landing_step) > 0 && step === Number(this.soft_landing_step)
        && !pyTruth(dictGet(context, "_soft_landed"))) {
        context["_soft_landed"] = true;
        messages.push({ role: "user", content: SOFT_LANDING_NOTICE });
      }

      // 模型调用前 overflow 预检 —— 折叠只在回合开始时跑一次，而且它只看
      // 落库历史：既不含系统提示，也不含工具定义 JSON，那两块常有一两万
      // token。第 0 步过去被 ``step > 0`` 整个跳过，等于最容易超的那一步
      // （历史 + 系统提示 + 全量工具定义，还没有任何工具结果可剪）反而
      // 没有任何保护。现在每一步都跑，且把 overhead 算进去：能剪就就地
      // 剪掉超额的旧工具输出（确定性、无需额外 LLM 往返、不动落库原文），
      // 剪不动就把 fits=False 如实播出去，而不是发一个必死的请求。
      try {
        this._sync_fold_budget();
        const overhead = this._request_overhead_tokens(system_prompt, tool_specs);
        const pre = this.compactor.precheck_inline(messages, { overhead_tokens: overhead });
        if (pyTruth(dictGet(pre, "pruned")) || !pyTruth(dictGet(pre, "fits", true))) {
          await this.bus.emit("context_precheck", {
            session_id: this.session_id, step, ...pre,
          });
        }
      } catch {
        pass(); // 预检失败绝不能让整个回合挂掉——大不了照原样发出去
      }

      await LOOP_SEAMS.emit_phase(this.bus, LOOP_SEAMS.turn_phase("MODEL_CALL_STARTED"),
        { session_id: this.session_id, extra: { step } });
      let r: Result = await this._llm_chat_streamed(messages, system_prompt, tool_specs, step);
      if (!r.ok) {
        // Before giving up: would a DIFFERENT model have worked? A quota
        // wall, a dead provider or a prompt that overflowed the window
        // are all recoverable by switching, and each wants a different
        // kind of switch (UD2).
        const retried = await this._downgrade_and_retry(r, messages, system_prompt,
          tool_specs, step);
        if (retried !== null && retried !== undefined) r = retried;
      }
      if (!r.ok) {
        // LLM unreachable mid-loop: fall back so the turn still answers.
        if (step === 0) {
          return [await this._keyword_turn(msg, context), trace];
        }
        // Lead with WHY in the product's language. This string is what
        // ends up in the assistant's row, so `LLM error after 3 steps:
        // HTTP 400: {"error":{...}}` was the wrong thing to show a user:
        // it names a step count they don't care about and buries the one
        // fact they can act on. The provider's raw text is kept after the
        // dash because it is what makes a bug report useful.
        const meta = (pyOr(r.meta, {}) ?? {}) as Record<string, any>;
        const failure = pyOr(dictGet(meta, "failure"),
          LOOP_SEAMS.classify("", pyStr(pyOr(r.error, ""))));
        const reason = LOOP_SEAMS.describe(failure);
        const detail = pyStrip(pyStr(pyOr(r.error, "")));
        let m = `${pyStr(reason)}，重试与备用模型都没能完成这次请求`;
        if (pyTruth(detail)) m = `${pyStr(m)}（${LOOP_SEAMS.truncate(detail, 400)}）`;
        return [Result.failure(m), trace];
      }

      let reply = r.value as Record<string, any>;
      // Accumulate this step's provider-reported token usage into the turn
      // total. The agent loop can make many LLM calls per user turn, so we
      // can't record per-step or the dashboard's turn count triples.
      this._accumulate_usage(context, pyOr(dictGet(reply, "usage"), {}) as Record<string, any>);
      const calls: any[] = (pyOr(dictGet(reply, "tool_calls"), []) ?? []) as any[];
      let content = LOOP_SEAMS.strip_protocol_tags(pyOr(dictGet(reply, "content"), ""));

      await LOOP_SEAMS.emit_phase(this.bus,
        LOOP_SEAMS.turn_phase("ASSISTANT_OUTPUT_STARTED"),
        { session_id: this.session_id, extra: { step, has_tools: calls.length > 0 } });

      // Generated images can arrive on ANY step of the loop, not just the
      // final one. Collect raw refs now; they get written to disk once at
      // the end of the turn (see _persist_turn_images).
      this._harvest_images(reply, context);

      // Doc: TOOL_UI_UX §2 — surface the reasoning stream so the UI can
      // render a collapsible "Thinking…" panel next to the answer. Empty
      // payloads are dropped so the frontend never opens an empty card.
      const reasoning = pyStrip(pyStr(pyOr(dictGet(reply, "reasoning"), "")));
      // If the step called tools AND had content text, that content is intermediate step narration/rationale
      let full_thought: string;
      if (calls.length > 0 && pyTruth(content)) {
        full_thought = pyTruth(reasoning)
          ? pyStrip(`${reasoning}\n\n${content}`) : content;
      } else {
        full_thought = reasoning;
      }

      if (pyTruth(full_thought)) {
        turn_reasonings.push({
          id: `reasoning-${step}`,
          step,
          text: full_thought,
          final: calls.length === 0,
          timestamp: LOOP_SEAMS.now(),
        });
        await this.bus.emit("agent_reasoning", {
          session_id: this.session_id,
          step,
          text: full_thought,
          final: calls.length === 0,
        });
      }

      if (calls.length === 0) {
        if (!pyTruth(content) && dictGet(reply, "finish_reason") === "length") {
          // Reasoning model spent the whole budget thinking — retry
          // once with more room before declaring an empty answer.
          r = await this._llm_chat_streamed(messages, system_prompt, tool_specs, step,
            pyMin2(Number(pyAttr(this.llm, "max_tokens")) * 4, 16000));
          if (r.ok) {
            reply = r.value as Record<string, any>;
            content = LOOP_SEAMS.strip_protocol_tags(pyOr(dictGet(reply, "content"), ""));
            (calls as any[]).length = 0;
            for (const c of (pyOr(dictGet(reply, "tool_calls"), []) ?? []) as any[]) calls.push(c);
          }
        }
        if (calls.length === 0) {
          const outcome = LOOP_SEAMS.summarizeTurnOutcome(trace) as Record<string, any>;
          if (!pyTruth(content)) {
            if (trace.length > 0) {
              // 业界顶尖 Agent (Modern Autonomous Agents):
              // 当模型完成多轮工具调用后返回空正文，不要立刻粗暴降级为固定模板，
              // 而是进行一次轻量级的强制总结轮（Synthesis Turn, tools=None）：
              // 此时关闭工具能力，模型会将注意力 100% 聚焦在生成人性化最终正文上！
              const synth_messages = [...messages];
              synth_messages.push({
                role: "user",
                content: "请对刚才执行的所有操作和最终结果向用户进行简明扼要、人性化的总结汇报，如实说明成功与遇到的问题，禁止再调用任何工具。",
              });
              const synth_r = await this._llm_chat_streamed(synth_messages, system_prompt,
                null, step);
              // DIVERGENCE(port): 源里 `synth_r.ok and (synth_r.value.get(...) or "")`
              // 靠 and 短路，所以 .value 为 None 的失败分支不会去碰它。这里同样把
              // 取值放在 ok 判定之后，否则 dictGet 会在 python 不会抛错的地方抛。
              if (synth_r.ok && pyTruth(pyStrip(pyStr(
                pyOr(dictGet(synth_r.value as any, "content"), ""))))) {
                content = pyStrip(pyStr(dictGet(synth_r.value as any, "content")));
                this._accumulate_usage(context,
                  pyOr(dictGet(synth_r.value as any, "usage"), {}) as Record<string, any>);
              } else {
                if (pySub(outcome, "status") === "all_failed") {
                  content = `操作未能成功完成：${pyStr(pyOr(pySub(outcome, "error_details"), "工具执行遇到异常"))}`;
                } else if (pySub(outcome, "status") === "partial") {
                  content = `部分操作已完成，但部分步骤遇到问题：${pyStr(pySub(outcome, "error_details"))}`;
                } else if (pySub(outcome, "status") === "all_success") {
                  content = "已为你执行完毕对应操作。";
                } else {
                  content = `操作执行完毕，但部分状态未确认：${pyStr(dictGet(outcome, "error_details", ""))}`;
                }
              }
            } else {
              content = "已收到，已准备处理。";
            }
          }

          if (pySub(outcome, "status") === "all_failed") {
            return [Result.failure(pyStr(pyOr(pyOr(content, dictGet(outcome, "error_details")),
              "工具执行失败")), null, { outcome }), trace];
          }
          if (pySub(outcome, "status") === "partial") {
            return [Result.success(content, null, { outcome, partial: true }), trace];
          }
          return [Result.success(content, null, { outcome }), trace];
        }
      }

      // Record the assistant's tool-call turn verbatim; the provider
      // requires it to precede the matching tool results.
      messages.push({
        role: "assistant",
        content: pyTruth(content) ? content : null,
        tool_calls: calls.map((c) => ({
          id: pySub(c, "id"),
          type: "function",
          function: { name: pySub(c, "name"), arguments: pyJsonDumps(pySub(c, "arguments")) },
        })),
      });

      // Execute this step's tool calls. Consecutive side-effect-free reads
      // run concurrently; everything else stays strictly serial so writes,
      // shell commands and confirmation prompts keep their ordering.
      let i = 0;
      while (i < pyLen(calls)) {
        if (pyTruth(this._cancel_requested())) {
          try {
            await LOOP_SEAMS.notify_turn_interrupted(this.session_id,
              `turn_${pyStr(this._turn_seq)}`, "user_cancelled");
          } catch {
            pass();
          }
          return [Result.failure("已中断（用户点击了停止）", null,
            { cancelled: true, turn_outcome: "cancelled" }), trace];
        }

        // Greedily take the longest run of parallel-safe calls from here.
        let j = i;
        while (j < pyLen(calls) && pyTruth(this._is_parallel_safe(calls[j]))) j += 1;
        const batch = calls.slice(i, j);

        await LOOP_SEAMS.emit_phase(this.bus,
          LOOP_SEAMS.turn_phase("TOOL_EXECUTION_STARTED"), {
            session_id: this.session_id,
            extra: {
              step,
              tools: (batch.length > 0 ? batch : [calls[i]]).map((c) => dictGet(c, "name")),
            },
          });

        if (batch.length > 1) {
          // asyncio.gather preserves input order in its results, so the
          // tool-result rows still line up with the assistant's
          // tool_calls array even though execution interleaved.
          const outcomes = await LOOP_SEAMS.gather(
            batch.map((c) => Promise.resolve(this._run_tool_call(c, context))));
          let paired = 0;
          for (const c of batch) {
            let outcome = outcomes[paired];
            paired += 1;
            if (outcome instanceof Error) {
              // One reader blowing up must not lose the others.
              const errText = excStr(outcome);
              outcome = {
                content: `[error] ${pyStr(errText)}`,
                trace: { tool: dictGet(c, "name"), error: pyStr(errText) },
              };
            }
            const od = outcome as Record<string, any>;
            trace.push(pySub(od, "trace"));
            messages.push({ role: "tool", tool_call_id: pySub(c, "id"), content: pySub(od, "content") });
          }
          // Close the bracket TOOL_EXECUTION_STARTED opened. The phase
          // was declared in `agent_phases.py` with a documented payload
          // (`tool` + `ok`) but had zero emit sites anywhere in the repo
          // — so anyone reading the enum believed there was a completion
          // signal that never fired. Per-tool latency and "which tool
          // was the turn sitting in" are both derivable from the phase
          // stream only if starts have matching finishes.
          let allOk = true;
          for (const o of outcomes) {
            if (!pyTruth(this._outcome_ok(o))) { allOk = false; break; }
          }
          await LOOP_SEAMS.emit_phase(this.bus,
            LOOP_SEAMS.turn_phase("TOOL_EXECUTION_FINISHED"), {
              session_id: this.session_id,
              extra: {
                step,
                tools: batch.map((c) => dictGet(c, "name")),
                ok: allOk,
              },
            });
          // A halt inside a parallel batch should be impossible:

          // `_is_parallel_safe` only ever batches LOW-risk reads from
          // PARALLEL_SAFE_TOOLS, and neither a confirmation nor
          // `ask_user` can come out of one. But "impossible because of
          // a whitelist somewhere else" is exactly the kind of implicit
          // dependency that breaks the day the whitelist grows, and the
          // failure mode is silent: the turn would keep calling the
          // model while a question sits unanswered on screen. Every
          // result is already appended above, so honouring it here
          // costs nothing.
          let halted: Record<string, any> | null = null;
          for (const o of outcomes) {
            if (isDict(o) && pyTruth(dictGet(o, "halt"))) { halted = o as Record<string, any>; break; }
          }
          if (halted !== null) {
            const is_confirm = pyStr(pyGetAttr(dictGet(halted, "trace", {}) ?? {},
              "status", "")) === "needs_confirmation";
            const res = Result.success(pyTruth(is_confirm) ? "" : pySub(halted, "content"));
            if (is_confirm) {
              (res as unknown as { meta: Record<string, any> }).meta = {
                needs_confirmation: true,
                ...((dictGet(halted, "confirm_meta") || {}) as object),
              };
            }
            return [res, trace];
          }
          i = j;
          continue;
        }

        // Single call (either not parallel-safe, or a lone read).
        const call = calls[i];
        const outcome = await this._run_tool_call(call, context);
        trace.push(pySub(outcome, "trace"));
        messages.push({
          role: "tool", tool_call_id: pySub(call, "id"), content: pySub(outcome, "content"),
        });
        await LOOP_SEAMS.emit_phase(this.bus,
          LOOP_SEAMS.turn_phase("TOOL_EXECUTION_FINISHED"), {
            session_id: this.session_id,
            extra: { step, tools: [dictGet(call, "name")], ok: this._outcome_ok(outcome) },
          });
        if (pyTruth(dictGet(outcome, "halt"))) {
          // Confirmation required / blocked: stop and surface it now
          // rather than letting the model narrate around the block.
          // When halting for needs_confirmation, the interactive prompt is already
          // attached to the tool card in the ActivityFeed (Trace UI). Returning empty
          // text avoids double-rendering a duplicate chat bubble at the bottom.
          const is_confirm = pyStr(pyGetAttr(dictGet(outcome, "trace", {}) ?? {},
            "status", "")) === "needs_confirmation";
          const res = Result.success(pyTruth(is_confirm) ? "" : pySub(outcome, "content"));
          if (is_confirm) {
            (res as unknown as { meta: Record<string, any> }).meta = {
              needs_confirmation: true,
              ...((dictGet(outcome, "confirm_meta") || {}) as object),
            };
          }
          return [res, trace];
        }

        // RepeatToolGuard: 检查循环死锁并在下一轮注入建议提示
        if (pyHasAttr(this, "repeat_tool_guard") && pyTruth(this.repeat_tool_guard)) {
          const loop_alert = this.repeat_tool_guard.check_loop();
          if (pyTruth(loop_alert)) {
            messages.push({
              role: "user",
              content: pySub(loop_alert, "advisory_message"),
            });
            try {
              await Promise.resolve(LOOP_SEAMS.record_user_correction(this.storage,
                this.session_id, {
                  user_message: pySub(loop_alert, "advisory_message"),
                  correction: pySub(loop_alert, "failure_signature"),
                  category: "tool_repeat_loop",
                }));
            } catch {
              pass();
            }
          }
        }
        i += 1;
      }
    }

    // Step cap hit. This is NOT a successful answer — the loop was cut off.
    // It still returns ``success`` because the caller needs the text to show
    // the user, but ``incomplete`` in the meta is what lets a caller (notably
    // subagent_runtime) tell "finished" apart from "ran out of room". Without
    // it a truncated sub-task reports COMPLETED and the parent believes the
    // work is done.
    // The text points at the Goals panel, which is the only real entry point
    // for a long-running task (frontend POSTs /api/goals then
    // /api/goals/{id}/run, handled by the scheduler). It used to say
    // "run it as a goal (`run_goal`)" — `run_goal` is not a registered tool
    // and `Router.run_goal` has no call sites, so that was pointing the user
    // at something that does not exist.
    // Step cap hit (only reachable if a positive max_agent_steps ceiling was configured).
    if (Number(this.max_agent_steps) > 0) {
      await this._check_context_pressure(messages, context);
      return [Result.success(
        `连续用了 ${pyStr(this.max_agent_steps)} 步工具还没得出结论，先停下来了。`
        + "可以把要求拆小一点再说一次，或到「设置 → 智能体行为」调高或解除每轮步数上限；"
        + "如果本来就是个长任务，"
        + "到「目标」面板建一个目标再执行，那条路有独立的迭代预算和进度记录。",
        null, { incomplete: true, stop_reason: "step_cap" }), trace];
    }

    await this._check_context_pressure(messages, context);
    const outcome = LOOP_SEAMS.summarizeTurnOutcome(trace);
    return [Result.success("已完成全部操作。", null, { outcome }), trace];
  }

  async _check_context_pressure(messages: any[], context: Record<string, any>): Promise<void> {
    /** Probe context pressure and trigger evolution if threshold breached. */
    try {
      const comp = pyGetAttr(this, "compactor", null);
      const budget = pyTruth(comp) ? pyGetAttr(comp, "max_tokens", 80000) : 80000;
      const th = pyTruth(comp) ? pyGetAttr(comp, "threshold", 0.8) : 0.8;
      const _tid = pyOr(dictGet(context, "turn_id"),
        `turn_${pyStr(pyGetAttr(this, "_turn_seq", 1))}`);
      const [triggered, ratio] = await LOOP_SEAMS.probe_context_pressure(
        messages, Number(budget), Number(th),
        pyGetAttr(this, "session_id", ""), pyStr(_tid));
      if (pyTruth(triggered)) {
        context["context_pressure_triggered"] = true;
        context["context_pressure_ratio"] = ratio;
      }
    } catch {
      pass(); // fail-open
    }
  }

  _model_can_output_images(): boolean {
    /** Does the active model emit images? Read from the model registry.
     *
     * Gates the image-generation hint below. Without this check a slow text
     * model (or a reasoning model pausing mid-answer) would claim to be drawing
     * a picture — a wrong progress message is worse than none.
     */
    const info = this.models.resolve(pyTruth(this._turn_model) ? this._turn_model : null);
    if (!info.ok || !isDict(info.value)) return false;
    const modalities = pyOr(dictGet(info.value as object, "modalities"), {});
    // Two shapes in the wild: the registry's per-model list (["text","image"])
    // and the provider-catalogue dict ({"input": [...], "output": [...]}).
    // Only the dict form can promise OUTPUT images; a flat list says nothing
    // about direction, so treat it as input-only and stay quiet.
    let out: unknown;
    if (isDict(modalities)) out = pyOr(dictGet(modalities, "output"), []);
    else out = [];
    return isSeqLike(out) ? pyIn("image", out) : false;
  }

  _model_can_read_images(): boolean {
    /** Can the active model SEE an attached image? (UB3)
     *
     * Reads `supports_vision` off the resolve payload, which is the registry's
     * already-settled answer: an explicit provider declaration when the user
     * made one, the modality list otherwise (#151). Deliberately not re-derived
     * here — two places inferring vision is how they end up disagreeing, and
     * the disagreement surfaces as a 400 from the provider.
     *
     * Fails CLOSED: an unresolvable model is treated as text-only, so the
     * images turn into an explicit note instead of a request the provider
     * rejects. Being told "this model can't see it" is recoverable; a failed
     * turn is not.
     */
    const info = this.models.resolve(pyTruth(this._turn_model) ? this._turn_model : null);
    if (!info.ok || !isDict(info.value)) return false;
    return pyTruth(dictGet(info.value as object, "supports_vision"));
  }

  /**
   * `_image_hint_watchdog(step, delay)` —— python 的协程本体。`sleep` 由
   * `WatchdogTask` 注入（DIVERGENCE 4）：`cancel()` 只能打断这一个 promise，
   * 而 python 的 `cancel()` 打断的正是协程里正在等待的 `asyncio.sleep`。
   */
  async _image_hint_watchdog(step: number, delay: number,
    sleep: (s: number) => Promise<void> = LOOP_SEAMS.sleep): Promise<void> {
    /** Announce likely image generation after the token stream goes quiet.
     *
     * # Why a watchdog instead of reading it off the API
     *
     * Native image generation (Gemini 2.x image, gpt-image) is not a separate
     * call we can observe starting — it happens *inside* one chat-completions
     * request. The model streams a little text ("好的，我来画…"), then goes
     * silent for 5-30s while it renders, then the image arrives with the final
     * response. No provider event marks the start of that silence.
     *
     * So we infer it: silence + an image-capable model ≈ drawing. The timer is
     * independent of the socket on purpose — a provider that sends no SSE
     * keepalives would never wake a data-driven check, and those are exactly
     * the requests that look frozen.
     *
     * # Why it can't mislead
     *
     * Cancelled by any content or reasoning delta, so ordinary slow typing
     * never triggers it. Gated on `_model_can_output_images`, so text-only
     * models never trigger it. Worst case on a false positive: the hint shows
     * for a moment and disappears the instant real tokens resume.
     */
    try {
      await sleep(delay);
      await this.bus.emit("agent_image_generating", { step, session_id: this.session_id });
    } catch (e) {
      if (e instanceof CancelledErrorP) {
        pass(); // fail-open: 取消语义即静默，正确
      } else {
        throw e;
      }
    }
  }

  async _llm_chat_streamed(messages: any[], system: string, tools: any[] | null,
    step: number, max_tokens: number | null = null): Promise<Result> {
    /** Call the LLM with token streaming; push content deltas to the bus.
     *
     * Emits ``agent_delta`` for each visible content piece so the WebSocket
     * bridge can grow the assistant bubble live. Assembles the same reply
     * shape as ``llm.chat`` for the rest of the agent loop.
     */
    let reply: any = null;
    // Only armed for image-capable models; see _image_hint_watchdog.
    let watchdog: LoopTaskHandle | null = null;
    if (pyTruth(this._model_can_output_images())) {
      const self = this;
      watchdog = LOOP_SEAMS.create_task(async (sleep) => {
        await self._image_hint_watchdog(step, IMAGE_HINT_DELAY, sleep);
      });
    }

    const _disarm = (): void => {
      if (pyTruth(watchdog) && !watchdog!.done()) watchdog!.cancel();
    };

    // Tool-call argument fragments arrive a few characters at a time. One WS
    // frame per fragment would be hundreds of frames for a single long
    // `write_file`, so coalesce on the same budget `_flush_output` already
    // uses for tool stdout: emit the first frame for a slot immediately (so
    // the card appears the moment the model names the tool) and then at most
    // one every TOOL_ARG_FRAME_INTERVAL.
    const arg_seen = new Map<number, number>();
    const arg_last = new Map<number, Record<string, any>>();
    let answer_content_started = false;
    let reasoning_started = false;

    const _emit_tool_arg = async (ev: Record<string, any>, force = false): Promise<void> => {
      const idx = pyInt(pyOr(dictGet(ev, "index"), 0));
      arg_last.set(idx, ev);
      const now = LOOP_SEAMS.now();
      const last = arg_seen.has(idx) ? arg_seen.get(idx) : undefined;
      if (last !== undefined && !force && (now - Number(last)) < TOOL_ARG_FRAME_INTERVAL) {
        return;
      }
      arg_seen.set(idx, now);
      await this.bus.emit("tool_call_delta", {
        session_id: this.session_id,
        step,
        index: idx,
        call_id: pyOr(dictGet(ev, "call_id"), ""),
        name: pyOr(dictGet(ev, "name"), ""),
        arguments: pyOr(dictGet(ev, "arguments"), ""),
        final: pyTruth(force),
      });
    };

    const _flush_tool_args = async (): Promise<void> => {
      /** Force out the last fragment of every slot.
       *
       * Without this the throttle can swallow the final delta, and the UI's
       * preview stops a few characters short of what the model actually sent
       * — a preview that quietly disagrees with the call being executed is
       * worse than no preview.
       */
      for (const ev of [...arg_last.values()]) {
        try {
          await _emit_tool_arg(ev, true);
        } catch {
          pass(); // fail-open: 可选增强，失败不影响主流程
        }
      }
    };

    try {
      const temp_override = pyTruth(pyGetAttr(this, "_benchmark_mode", false)) ? 0.0 : null;
      // DIVERGENCE(port): python 的关键字实参按 llm_client.ts 自己的形参顺序落成
      // 位置参 + 一个 extra 包；键名与值都不变。
      for await (const ev of this.llm.chat_stream(messages, max_tokens, temp_override, system, {
        tools,
        // Per-turn thinking budget (UD4). Translated to the provider's own
        // field inside llm_client, and dropped entirely for models that
        // have no such dial.
        reasoning_effort: this._turn_effort,
        // 3.3: where the unchanging head of the system prompt ends, so
        // the provider can cache it instead of re-billing identical
        // bytes every turn. Verified against `system` inside llm_client
        // and ignored unless it really is a prefix, so a drift between
        // the two just means no caching — never a mangled prompt.
        cache_prefix: this._sys_cache_prefix,
        // The rate limiter can hold a request at the gate. Hand it this
        // turn's cancel flag so pressing stop actually stops instead of
        // waiting out a queue the user can't see. Popped inside
        // llm_client before the body is built, so it never ships.
        abort_check: () => this._cancel_requested(),
      })) {
        const kind = dictGet(ev, "type");
        if (kind === "content") {
          let text = pyOr(dictGet(ev, "text"), "");
          if (pyTruth(text)) {
            // LongCat and similar gateways may emit "0" / punct on the
            // content channel before OR during CoT. Two leak shapes:
            // whole-frame junk ("0") and junk glued to real text
            // ("0你好") — the latter slipped past the old frame-level
            // check and the bubble started with a stray "0" that
            // vanished when agent_response replaced it. Strip a short
            // junk prefix instead of dropping the frame.
            if (!answer_content_started) {
              const stripped = LOOP_SEAMS.stripLeadingJunk(pyStr(text));
              if (!pyTruth(stripped)) continue;
              text = stripped;
              answer_content_started = true;
            }
            // Real tokens are arriving — this is not a render pause.
            _disarm();
            await this.bus.emit("agent_delta", {
              session_id: this.session_id, step, text,
            });
          }
        } else if (kind === "reasoning") {
          // Reasoning models (DeepSeek-R1, o1, …) can think for 15-30s
          // before emitting a single visible token. llm_client already
          // streams the CoT deltas; dropping them here is what made
          // long thinking look like the app had frozen. Forward each
          // piece so the UI can type it out live. The consolidated
          // `agent_reasoning` still fires at the end of the step for
          // anything that only wants the final block.
          let text = pyOr(dictGet(ev, "text"), "");
          if (pyTruth(text)) {
            // The same gateway junk leaks onto the reasoning channel
            // (leading "0"/punct before CoT starts). Strip a short
            // junk prefix once at reasoning start; CoT's own numeric
            // content ("1. 先…") has prefixes >2 chars and survives.
            if (!reasoning_started) {
              const stripped = LOOP_SEAMS.stripLeadingJunk(pyStr(text));
              if (!pyTruth(stripped)) continue;
              text = stripped;
              reasoning_started = true;
            }
            // Thinking is its own visible state; don't also claim
            // we're drawing.
            _disarm();
            await this.bus.emit("agent_reasoning_delta", {
              session_id: this.session_id, step, text,
            });
          }
        } else if (kind === "tool_call_delta") {
          // The model is writing out a tool call. Not a render pause,
          // and not silence either — this is the gap that used to look
          // like a hang on any call with a large argument.
          _disarm();
          await _emit_tool_arg(ev as Record<string, any>);
        } else if (kind === "done") {
          _disarm();
          await _flush_tool_args();
          reply = dictGet(ev, "reply");
        } else if (kind === "error") {
          _disarm();
          // Carry the provider's error code so the caller can classify
          // the failure and decide whether a different model would help
          // (UD2). Without this the stream collapses every failure to a
          // bare string and downgrade can't tell quota from overflow.
          return this._stream_failure(ev as Record<string, any>);
        }
      }
    } catch (e) {
      return Result.failure(`LLM stream failed: ${pyStr(excStr(e))}`, null, { code: "Transport" });
    } finally {
      // A leaked watchdog would fire mid-way through the NEXT step and
      // announce a phantom image generation.
      _disarm();
    }

    if (reply === null || reply === undefined) {
      return Result.failure("LLM stream ended without a reply", null,
        { code: "EmptyResponse" });
    }
    return Result.success(reply);
  }

  _stream_failure(ev: Record<string, any>): Result {
    /** Turn a stream ``error`` event into a Result carrying failure semantics. */
    const code = pyStr(pyOr(dictGet(ev, "code"), ""));
    const err = pyOr(dictGet(ev, "error"), "LLM stream error");
    const failure = LOOP_SEAMS.classify(code, err);
    const r = Result.failure(err as string, null, { code });
    r.meta["failure"] = failure;
    r.meta["recovery"] = LOOP_SEAMS.recovery_for(failure);
    return r;
  }

  async _run_moa_council(messages: any[], user_message: string,
    context: Record<string, any>): Promise<void> {
    /** 执行一轮 MoA 会诊并把意见块并入 messages（Phase 35）。
     *
     * advisor 池来自 model_registry.scene_candidates("main")——只从用户
     * 已配置、已带凭证、清过能力门槛的模型里挑，跨 provider 优先；客户端
     * 走 LLMClient.bind（与降级重试同一套绑定机制）。意见作为「同行会诊」
     * 块并进本轮末尾的 user 消息内容（不新增消息行，历史形状保持稳定，
     * 缓存断点与 compactor 的轮次视角都不受影响），并通过 bus 事件让
     * 前端实时展示「正在征询哪些模型、各自说了什么」。
     */
    let candidates: any[] = [];
    try {
      candidates = pyOr(this.models.scene_candidates("main"), []) as any[];
    } catch {
      pass(); // 注册表不可用就单干
    }
    const advisors = LOOP_SEAMS.select_advisors(candidates,
      pyAttr(this.llm, "model_id"), LOOP_SEAMS.max_advisors()) as any[];
    await this.bus.emit("moa_advisors", {
      session_id: this.session_id,
      step: 0,
      advisors: advisors.map((a) => ({
        model: dictGet(a, "model_id"), provider: dictGet(a, "provider_id"),
      })),
      phase: "asking",
    });
    if (!pyTruth(advisors)) {
      return; // 没有第二个模型：静默降级为单模型，不打扰用户
    }

    // 会诊问题就是本轮用户请求；最近对话只给一小段摘要，控制 advisor 成本
    let recent_tail = "";
    try {
      const tail_msgs = messages.slice(Math.max(0, pyLen(messages) - 4))
        .filter((m) => dictGet(m, "role") !== "system");
      const parts: string[] = [];
      for (const m of tail_msgs) {
        const c = dictGet(m, "content");
        if (typeof c === "string" && pyTruth(c)) {
          parts.push(`[${pyStr(pySub(m, "role"))}] ${pySlice(c, 0, 220)}`);
        }
      }
      recent_tail = pySlice(parts.join("\n"), 0, 1200);
    } catch {
      pass();
    }

    const council = await LOOP_SEAMS.convene(this.llm, advisors, user_message, recent_tail);

    await this.bus.emit("moa_advisors", {
      session_id: this.session_id,
      step: 0,
      phase: "answered",
      elapsed_s: pyRound(Number(pyAttr(council, "elapsed_s")), 2),
      opinions: (pyAttr(council, "opinions") as any[]).map((o) => ({
        model: pyAttr(o, "model_id"), ok: pyAttr(o, "ok"),
        elapsed_s: pyRound(Number(pyAttr(o, "elapsed_s")), 2),
        error: pyAttr(o, "error"),
        text: pyTruth(pyAttr(o, "ok")) ? pySlice(pyStr(pyAttr(o, "text")), 0, 2000) : "",
      })),
    });

    if (pyTruth(pyAttr(council, "council_block"))) {
      // 并进本轮 user 消息：块以附加段形式存在，历史行数不变——
      // 对 compactor 的轮次视角和缓存断点都零扰动。
      const last = pyIndex(messages, -1) as Record<string, any>;
      if (dictGet(last, "role") === "user") {
        const c = dictGet(last, "content");
        const sep = (!isDict(c) && typeof c !== "string") || !pyTruth(pyStrip(pyStr(c)))
          ? "" : "\n\n";
        last["content"] = (typeof c === "string" ? c : pyStr(pyOr(c, "")))
          + sep + pyStr(pyAttr(council, "council_block"));
      }
    }
  }

  async _downgrade_and_retry(failed: Result, messages: any[], system: string,
    tools: any[] | null, step: number): Promise<Result | null> {
    /** After an LLM failure, try a better-suited model — if one exists (UD2).
     *
     * The failed Result carries ``meta["recovery"]`` (from ``llm_errors``),
     * which says what "better" means for THIS failure: a bigger context window
     * for an overflow, a different provider for an exhausted quota, anything
     * healthy for a bad model id. We ask the registry for candidates in that
     * direction and try them cheapest-first, emitting a user-visible
     * ``model_downgraded`` event on each hop so the change is never silent.
     *
     * Returns the first successful Result, or None to let the caller report the
     * original failure. Never raises — a downgrade that itself fails must not
     * turn a recoverable error into a crash. ``self.llm`` is always restored.
     */
    const meta = (pyOr(failed.meta, {}) ?? {}) as Record<string, any>;
    const recovery = pyOr(dictGet(meta, "recovery"), LOOP_SEAMS.recover_none());
    const failure = pyOr(dictGet(meta, "failure"), "");
    if (!pyTruth(recovery)) return null;

    const origin: any = pyAttr(this, "llm");
    const cur_pid = pyStr(pyOr(pyGetAttr(origin, "provider_id", ""), ""));
    const cur_model = pyAttr(origin, "model_id");
    const current = pyTruth(cur_pid) ? `${pyStr(cur_pid)}:${pyStr(cur_model)}` : cur_model;

    // A provider that hard-failed gets a strike, so a persistent outage stops
    // costing a full timeout every turn. Rate limits are NOT hard failures —
    // the provider is alive, we were just too fast — so they never count here.
    if (pyTruth(cur_pid) && pyTruth(failure) && pyTruth(LOOP_SEAMS.is_permanent(failure))) {
      try {
        this.models.note_provider_failure(cur_pid, failure);
      } catch {
        pass(); // fail-open: 可选增强，失败不影响主流程
      }
    }

    let candidates: any[];
    try {
      candidates = this.models.downgrade_candidates(current, recovery,
        this.llm.estimate_request_tokens({ messages }));
    } catch {
      candidates = [];
    }
    if (!pyTruth(candidates)) return null;

    let succeeded = false;
    try {
      for (const cand of candidates) {
        try {
          this.llm = origin.bind(cand);
        } catch {
          continue;
        }
        if (this.llm === origin) { // nothing actually changed; not a hop
          continue;
        }
        if (pyStr(cur_model) !== pyStr(pyAttr(this.llm, "model_id"))) {
          await this.bus.emit("model_downgraded", {
            session_id: this.session_id,
            step,
            reason: recovery,
            failure,
            // The PRECISE cause, phrased for a person. `reason` is only the
            // recovery direction, and four different failures share
            // "other_provider" — quota, a rejected key, a provider 5xx and
            // a rate limit. The banner used to name quota for all four,
            // which sends the user to top up credits when the real problem
            // is a bad key. `describe` is the same vocabulary the rest of
            // the app uses, so there is one source of truth for the wording.
            failureText: pyTruth(failure) ? LOOP_SEAMS.describe(failure) : "",
            fromModel: cur_model,
            toModel: pyAttr(this.llm, "model_id"),
            toProvider: dictGet(cand, "provider_name", ""),
          });
        }
        const rr = await this._llm_chat_streamed(messages, system, tools, step);
        if (rr.ok) {
          const pid = pyOr(dictGet(cand, "provider_id"), "") || "";
          if (pyTruth(pid)) {
            try {
              this.models.note_provider_success(pid);
            } catch {
              pass(); // fail-open: 可选增强，失败不影响主流程
            }
          }
          succeeded = true;
          return rr;
        }
      }
      return null;
    } finally {
      // Only roll back when nothing worked. Restoring `origin` after a
      // SUCCESSFUL hop was a real bug: the turn continues for up to
      // MAX_AGENT_STEPS iterations, each one starting a fresh LLM call, so
      // putting the just-failed model back meant step n+1 failed exactly
      // like step n, re-ran this whole function, re-picked the same
      // candidate (the selection is stateless) and emitted a byte-identical
      // "switched provider" banner. That is why one message could paper the
      // transcript with the same notice over and over. A hop that worked is
      // now kept for the rest of the turn — one switch, one notice.
      if (!succeeded) this.llm = origin;
    }
  }

  async _keyword_turn(user_message: string, context: Record<string, any>): Promise<Result> {
    /** Deterministic fallback used when no LLM is configured. */
    const approved = dictGet(context, "approved_pending");
    if (approved !== null && approved !== undefined) {
      const tool_name = pyOr(
        pyOr(pyGetAttrOfObj(approved, "tool_name", null),
          isDict(approved) ? dictGet(approved, "tool_name") : ""),
        "");
      const tool_args = isDict(approved)
        ? dictGet(approved, "args", {})
        : pyGetAttr(approved, "args", null);
      const call_id = pyOr(
        pyOr(
          pyOr(pyGetAttrOfObj(approved, "call_id", null),
            isDict(approved) ? dictGet(approved, "call_id") : ""),
          pyOr(dictGet(context, "consent_call_id"), "")),
        "");
      if (pyTruth(call_id)) context["call_id"] = call_id;
      const dispatch = {
        type: "direct",
        agent: null,
        primary_tool: tool_name,
        args: tool_args,
      };
      // DIVERGENCE(port): python `RiskLevel` is an Enum and loop.py:1032 reads `.value`
      // off the member; the port's RiskLevel (risk_control.ts:83) is a plain string
      // constant map, so the classifier already returns the string "low" and taking
      // `.value` would store `undefined`. The stored value is identical on both sides.
      context["risk_level"] = this.risk.classify_risk(tool_name, tool_args);
      context["confirmed"] = true;
      return await this._execute(dispatch, context);
    }

    const intent = this._recognize_intent(user_message);
    if (!pyTruth(dictGet(intent, "primary_tool"))) {
      // Nothing in the keyword table matched, which is the normal case for
      // anything conversational ("你好", a question, a follow-up). The old
      // reply here was a bare English "No action determined. Please clarify
      // your request." — it told the user their phrasing was at fault when
      // the real situation is that there is no model to talk to. A greeting
      // is not an unclear request; it is a request this mode structurally
      // cannot serve. Say that instead.
      return Result.success(this._degraded_reply());
    }
    context["risk_level"] = this.risk.classify_risk(
      pyOr(dictGet(intent, "primary_tool"), ""), pyOr(dictGet(intent, "args"), {}));
    const dispatch = this._determine_dispatch(intent, user_message, context);
    return await this._execute(dispatch, context);
  }

  _degraded_reply(): string {
    /** What to say when keyword routing has nothing to route.
     *
     * Two different situations reach here and they need different answers:
     * no model configured at all (the common one — fix it in Settings), versus
     * a configured model that this turn fell back away from. Reporting the
     * first as the second sends the user hunting for a phrasing problem that
     * does not exist.
     *
     * Bilingual on purpose: this string is produced deep in the backend, which
     * has no access to the UI's active locale, and it is the one reply a
     * brand-new user is most likely to see.
     */
    if (!(pyAttr(this, "llm") && pyTruth(pyAttr(this.llm, "api_key")))) {
      return (
        "尚未配置模型，当前运行在关键词降级模式，无法进行对话。\n"
        + "请到「设置 → 服务商」填入 API Key 后重试。\n"
        + "（降级模式下仅能识别少量显式指令，例如「git status」「读 README.md」。）\n\n"
        + "No model is configured. Running in keyword-only fallback mode, "
        + "so conversation is unavailable. Add an API key under "
        + "Settings → Providers and try again."
      );
    }
    return (
      "这一轮没有走模型，关键词模式也没有匹配到可执行的操作。请换一种说法，"
      + "或直接说明要操作的文件 / 命令。\n\n"
      + "This turn did not reach the model and no keyword rule matched. "
      + "Try rephrasing, or name the file / command directly."
    );
  }

  _build_history(limit = 20, drop_trailing_user = true): Record<string, any>[] {
    /** Build LLM message history from stored turns.
     *
     * The current user message was already persisted by ``handle``, so the
     * trailing user row is dropped to avoid sending it twice.
     *
     * ``limit`` selects the **newest** rows, not the oldest. That distinction is
     * the whole ballgame: ``get_messages(sid, limit=20)`` reads
     * ``ORDER BY seq LIMIT 20``, and since ``seq`` ascends from zero that hands
     * back the twenty rows from the very start of the conversation. Any session
     * longer than the limit would then replay its own opening forever while the
     * model never saw a word of what was just said.
     *
     * Fold-aware: if the window contains a compaction (fold) marker, replay
     * starts from the NEWEST one — the summary stands in for every raw turn
     * before it, which is the whole point of folding. The summary is injected as
     * a ``system`` message so the model treats it as context, not as something
     * the user said. This only works on a tail window; on a head window the
     * marker sits past the end and is never found.
     *
     * Args:
     *     limit: How many of the most recent stored rows to consider.
     *     drop_trailing_user: Whether to drop the trailing user message. Defaults
     *         to True (since handle normally persists the user message first).
     *         False when silent_consent is True because the turn was not persisted.
     *
     * Returns:
     *     List of ``{role, content}`` dicts in chronological order.
     */
    const rows = pyOr(this.storage.get_recent_messages(this.session_id, limit), []) as any[];

    // Find the newest fold marker; everything before it is represented by it.
    let fold_idx = -1;
    for (let i = pyLen(rows) - 1; i >= 0; i--) {
      if (pyRowGet(rows[i], "msg_type") === "compaction") { fold_idx = i; break; }
    }

    const history: Record<string, any>[] = [];
    let window: any[];
    if (fold_idx >= 0) {
      const summary = pyRowGet(rows[fold_idx], "content");
      if (pyTruth(summary)) {
        history.push({
          role: "system",
          content: this.compactor._unseal(summary),
        });
      }
      window = rows.slice(fold_idx + 1);
    } else {
      window = rows;
    }

    for (const row of window) {
      const role = pyRowGet(row, "role");
      const content = pyRowGet(row, "content");
      const mt = pyRowGet(row, "msg_type");
      if (mt === INTERRUPT_NOTE_TYPE && pyTruth(content)) {
        // The hidden nudge. Injected as `system` for the same reason the
        // fold summary is: it's context ABOUT the conversation, not a
        // thing the user said. Replayed so the next turn knows the last
        // one was cut off mid-work — without it the model reads its own
        // truncated reply as a finished answer and moves on, silently
        // abandoning whatever was half-done.
        history.push({ role: "system", content });
        continue;
      }
      if ((role === "user" || role === "assistant") && pyTruth(content)) {
        history.push({ role, content });
      }
    }
    if (drop_trailing_user && pyTruth(history)
      && dictGet(history[history.length - 1], "role") === "user") {
      history.pop();
    }
    return history;
  }

  // ── 宿主提供的方法（其它 mixin；未落地时抛出） ────────────────────────────

  _tool_specs_for(_context: Record<string, any>): any[] { return hostMissing("_tool_specs_for"); }
  _outcome_ok(_outcome: unknown): boolean { return hostMissing("_outcome_ok"); }
  _is_parallel_safe(_call: Record<string, any>): boolean {
    return hostMissing("_is_parallel_safe");
  }
  async _run_tool_call(_call: Record<string, any>,
    _context: Record<string, any>): Promise<Record<string, any>> {
    return hostMissing("_run_tool_call");
  }
  _harvest_images(_reply: Record<string, any>, _context: Record<string, any>): void {
    return hostMissing("_harvest_images");
  }
  _recognize_intent(_message: string): Record<string, any> {
    return hostMissing("_recognize_intent");
  }
  _determine_dispatch(_intent: Record<string, any>, _message: string,
    _context: Record<string, any>): Record<string, any> {
    return hostMissing("_determine_dispatch");
  }
  async _execute(_dispatch: Record<string, any>,
    _context: Record<string, any>): Promise<Result> {
    return hostMissing("_execute");
  }
  get_system_prompt(_context: Record<string, any> = {}): string {
    return hostMissing("get_system_prompt");
  }
  _skill_guidance_block(_context: Record<string, any>): string {
    return hostMissing("_skill_guidance_block");
  }
  _sync_turn_cache_prefix(_full_system: string): void {
    return hostMissing("_sync_turn_cache_prefix");
  }
  async _inject_context_refs(_messages: any[],
    _context: Record<string, any>): Promise<Record<string, any>> {
    return hostMissing("_inject_context_refs");
  }
  _compose_user_content(_user_message: string, _context: Record<string, any>): any {
    return hostMissing("_compose_user_content");
  }
  _accumulate_usage(_context: Record<string, any>, _raw_usage: Record<string, any>): void {
    return hostMissing("_accumulate_usage");
  }
  _request_overhead_tokens(_system_prompt: string, _tool_specs: any[]): number {
    return hostMissing("_request_overhead_tokens");
  }
  _sync_fold_budget(): void { return hostMissing("_sync_fold_budget"); }
  _cancel_requested(): boolean { return hostMissing("_cancel_requested"); }
  _clear_cancel(): void { return hostMissing("_clear_cancel"); }
  async _drain_steer_into(_messages: any[], _step: number): Promise<boolean> {
    return hostMissing("_drain_steer_into");
  }
}



