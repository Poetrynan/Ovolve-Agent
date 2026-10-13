/**
 * router_modules/dispatch.ts — Tool execution, dispatching, and audit mixin.
 *
 * Ported from `app/backend/router_modules/dispatch.py` (1738 lines, 91289 bytes,
 * wave-8, unit 186).
 *
 * This mixin owns the whole guardrail pipeline around a single model-requested
 * tool call (`_run_tool_call`): the catalogue the model sees (`_tool_specs_for`),
 * the loop/域规则/策略/执行模式 gates, the side-effect ledger and replay
 * interception, the live-output sink, the settle + emit chain, and the *keyword*
 * routing path (`_recognize_intent` → `_determine_dispatch` → `_execute`), plus
 * the presentation/audit tail (`_tool_output_for_llm`, `_audit`, `_present`,
 * `_harvest_images`, `_persist_turn_images`).
 *
 * RULEBOOK CITATIONS
 *   §2  `str, Enum` → the TS sibling already returns plain strings, so
 *       `self.risk.classify_risk(...).value` becomes `enumValue(...)`, a
 *       `getattr(v, "value", str(v))` that is the identity on a plain string and
 *       still reads `.value` off an object that carries one.
 *   §2  `dict.get(k, d)` → `dictGet` (present-but-null yields null, not `d`);
 *       `dict.setdefault` → `dictSetDefault` (eager default).
 *   §2  `x or y` → `pyOr` (python truthiness, not JS), `if x` → `pyTruth`.
 *   §2  `str(x)` → `pyStr` (bool → "True"/"False", None → "None"), `repr` inside
 *       the hand-off message → `pyStr` of a python list literal (see DIVERGENCE
 *       note at the call site: python interpolates `{illegal}` as a *list*).
 *   §2  `len()` / slicing are code-point based → `pyLen` / `pySlice`; the
 *       truncation marker in `_tool_output_for_llm` contains U+2702 U+FE0F, which
 *       is 2 code points / 3 UTF-16 units, so a naive `.length` would move the
 *       head/tail boundary.
 *   §2  `str.strip()` uses CPython's whitespace set → `pyStrip` (JS `.trim()`
 *       also eats U+FEFF, which CPython keeps).
 *   §2  `sorted()` over strings is code-point ordered → `pySortedStr`.
 *   §2  `json.dumps(..., sort_keys=True, ensure_ascii=False, default=str)` and
 *       the `indent=2` form → local `pyJsonDumpsFull`; the existing
 *       `storage_funcs.pyJsonDumps` has no `default=` hook and no `indent`, and
 *       this exact string feeds a sha256 that is written to the side-effect
 *       ledger, so it must be the real thing.
 *   §2  `time.time()` → `DISPATCH_SEAMS.now()`; `uuid.uuid4()` → `uuid4()` seam;
 *       `os.getcwd()` / `os.path.basename()` → seams; `print()` →
 *       `DISPATCH_SEAMS.print_()`; `logging.getLogger(x).info/exception` →
 *       `DISPATCH_SEAMS.log_line()`.
 *   §2  `getattr(self, "permission", None)` and
 *       `getattr(self.permission, "value", str(self.permission))` keep their
 *       EAGER default evaluation (`pyGetAttr`), so the `str()` call count matches.
 *   §2  `isinstance(v, dict)` → `isDict` (plain-prototype test);
 *       `isinstance(outcome, BaseException)` → `v instanceof Error`.
 *   §2  `fnmatch.fnmatch` with the Windows `normcase` pass python performs →
 *       local `pyFnmatch` (same implementation as the one inside tools.ts, which
 *       is module-private there).
 *   §2  module-level mutable state stays module-level, in source order.
 *   §1  `token_analytics` / `agent_logger` / `evolution_bridge` / `workflow_recorder`
 *       are observational mirrors reached through fail-open `try/except` — kept
 *       exactly as the source has them (AMEND-07 "功能一致 supreme"), each swallow
 *       marked `BUG(port)` with the source's own reason.
 *   §2 BUG rule  `_tool_output_for_llm` is missing its `@staticmethod` in the
 *      source (1637) while both call sites use `self.` — the mis-binding is
 *      reproduced verbatim (`this` passed explicitly at the call sites, every
 *      attribute read through `pyAttr`), not fixed. See the function's own note.
 *   §4  naming: app/backend/router_modules/dispatch.py ->
 *       app/engine/router_modules/dispatch.ts.
 *
 * DIVERGENCE(port) — async shape (forced by TS, no observable data change):
 *   1. `evolution_bridge.notify_tool_failure` / `notify_loop_fault` are `async`
 *      in TS (they were sync in python). Both call sites already sit inside
 *      `try/except Exception: pass`, so `await` there reproduces python exactly:
 *      a failure is swallowed, a success is silent.
 *   2. `_may_hand_off()` stays sync. `subagent_runtime` is an unported unit, so
 *      `MAX_HANDOFF_DEPTH = 1` is copied verbatim from
 *      `app/backend/subagent_runtime.py:83` and reachable through the
 *      `subagentRuntimeModule` seam, which unit 190's real import can replace.
 *   3. `effects` is routed to Rust (unit 136) and has no TS module. The source
 *      reached it with `import effects as _fx` inside
 *      `try/except Exception: <log + fail-open>`; the seam's default is an empty
 *      module, so attribute use throws `TypeError` and the same except branch
 *      runs — byte-identical fail-open behaviour, with the typed-effect feature
 *      dark until the native binding is wired. `GIT_KINDS` likewise comes from
 *      `getattr(_fx, "GIT_KINDS", ())`, i.e. the empty default here.
 *   4. `tool_catalog` is an unported unit (wave-8, Rust-routed). The source's
 *      `from tool_catalog import trim_exclude` is inside `try/except: pass`, so an
 *      empty seam module reproduces "catalogue is not trimmed" — which is what
 *      the source's own fail-open comment says it wants.
 *   5. `asyncio.CancelledError` has no JS equivalent: the port catches
 *      `CancelledErrorP` (same marker class goal_scheduler.ts:188 uses) plus any
 *      error whose `name` is `"CancelledError"`. Any *other* error propagates out
 *      of `_run_tool_call` exactly as python's non-BaseException errors do.
 *   6. `asyncio.run_coroutine_threadsafe(self.bus.emit(...), loop)` +
 *      `threading.Lock`: JS has one thread and the sink is called synchronously,
 *      so the port fires `bus.emit` and drops the returned promise. The lock is a
 *      no-op. The buffer contents, the ≥2048-char / >0.08s flush rule and the
 *      `tool_output` payload shape are unchanged.
 *   7. `asyncio.shield(fut)` / `asyncio.wait_for(..., ASK_WAIT_TIMEOUT_S)`: the
 *      waiter is already a `Promise` in ask_user.ts. The port races it against a
 *      timer and reproduces the three exits (value / timeout → None / cancel →
 *      drop + rethrow). `asyncio.shield` has no purpose once nothing can cancel
 *      the promise from the outside. `asyncio.TimeoutError` becomes the local
 *      `AskWaitTimeout` (name `"TimeoutError"`), and the `RuntimeError` arm of
 *      the source's except tuple is whatever the waiter rejects with.
 *   8. `Result` fields are `readonly` in result.ts, so the source's whole-object
 *      reassignments (`res.meta = {...}` in `_execute`, `result.value = ...` for
 *      the skill-guidance block) go through one cast at each site. The values
 *      assigned are byte-identical.
 *   9. `llm_client.chat()` is positional `(messages, max_tokens, temperature,
 *      system, extra)`; every `system=` / `max_tokens=` keyword call in the
 *      source is spread into that order with the untouched args left `null`.
 *
 * PORT STATUS: 本文件无 TODO(port)。
 */

import {
  ASK_WAIT_TIMEOUT_S,
  AUTO_RESOLVE_SYSTEM,
  PendingQuestion,
  build_auto_resolve_user_prompt,
  drop_waiter,
  get_ask_user_store,
  normalize_questions,
  parse_auto_resolution,
  register_waiter,
  render_answer,
} from "../ask_user.js";
import {
  MODE_DANGER_FULL,
  MODE_REFUSED,
  risk_to_rlevel,
  select_execution,
} from "../execution_provider.js";
import { cancelCall as cancel_call, registerOutputSink, unregisterOutputSink } from "../executors.js";
import { placeholder as _image_placeholder, save_ref as _save_image_ref } from "../image_store.js";
import { Result } from "../result.js";
import { RiskLevel, parse_consent } from "../risk_control.js";
import { HookStage, get_tool_hooks } from "../tool_hooks.js";
import { shorten_path, truncate } from "../tools.js";
import { EnvironmentSnapshot } from "./prompt.js";
import { createHash } from "node:crypto";

// The source's module-level import surface also pulls these in even though no
// line in this mixin reaches them (`cancel_call` is used by `router.py`,
// `_image_placeholder` by `loop.py`, `parse_consent` by `admission.py`,
// `threading`/`HookStage`/`shorten_path` by other mixins or not at all).
// Kept so the import contract matches; `void` keeps the compiler quiet.
void cancel_call;
void _image_placeholder;
void parse_consent;
void HookStage;
void shorten_path;

// ── python 语义小工具（本仓惯例：各文件自带局部实现） ─────────────────────────

/** CPython str.strip() whitespace set (probe-pinned; see bot_remote.ts). */
const PY_WS = "\\t\\n\\v\\f\\r\\x1c\\x1d\\x1e\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

function pyStrip(s: string): string {
  return s.replace(new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g"), "");
}

/** python `str(e)` (message only, no type prefix). */
function excStr(e: unknown): string {
  const m = (e as { pyMsg?: string })?.pyMsg;
  if (m !== undefined) {
    return m;
  }
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
  // python `bool(obj)` 对普通类实例永远是 True —— 只有 `__bool__`/`__len__` 能
  // 把它判假。JS 的对象没有这两个协议，`Object.keys(obj).length` 会把一个「字段
  // 全是方法」的协作者（工具的 def、守卫对象）当成假，而 python 那侧是真。
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

/** python `for x in v` — a list/set/dict/str iterable flattened once. */
function pyIter(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (v instanceof Map) return [...v.keys()];
  if (v instanceof Set) return [...v];
  if (typeof v === "string") return [...v];
  if (typeof v === "object") {
    if (typeof (v as any)[Symbol.iterator] === "function") return [...(v as Iterable<unknown>)];
    return Object.keys(v as object);
  }
  return [];
}

/** python `x in <list|set|dict|str>`. */
function pyIn(needle: unknown, haystack: unknown): boolean {
  if (haystack === null || haystack === undefined) return false;
  if (Array.isArray(haystack)) return haystack.some((v) => v === needle);
  if (haystack instanceof Set) return haystack.has(needle as never);
  if (haystack instanceof Map) return haystack.has(needle as never);
  if (typeof haystack === "string")
    return typeof needle === "string" && needle.length > 0 && haystack.includes(needle);
  if (typeof haystack === "object")
    return Object.prototype.hasOwnProperty.call(haystack as object, String(needle));
  return false;
}

/** python `str(x)`. */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return pyReprNumber(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (v instanceof Map) return `{${[...v.entries()].map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`).join(", ")}}`;
  if (v instanceof Set) return `{${[...v].map(pyRepr).join(", ")}}`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.repr === "function") return String((o.repr as () => unknown)());
    if (typeof o.__str__ === "string") return o.__str__;
    return `{${Object.keys(o).map((k) => `${pyRepr(k)}: ${pyRepr(o[k])}`).join(", ")}}`;
  }
  return String(v);
}

function pyReprNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(v);
}

/** python `repr(x)` — list-of-str interpolation (`f"{illegal}"`). */
function pyRepr(v: unknown): string {
  if (typeof v === "string") return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
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

/** python `a <= b` for the `len(text) <= cap` gate: a non-numeric right operand
 *  raises CPython's TypeError rather than coercing to NaN. */
function pyLe(a: number, b: unknown): boolean {
  if (typeof b === "number" || typeof b === "boolean") return a <= (b as number);
  throw new TypeError(
    `'<=' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** python arithmetic coercion of the `<=`-validated operand (`bool` is an `int`). */
function pyNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new TypeError(
    `unsupported operand type(s) for *: '${pyTypeName(v)}' and 'float'`);
}

/** python `dict.get(k, default)` — present-but-null returns null, not default. */
function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    throw new TypeError(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  if (obj instanceof Map) return obj.has(key) ? obj.get(key) : dflt;
  return key in (obj as object) ? (obj as Record<string, unknown>)[key] : dflt;
}

/** python `dict.setdefault(k, d)` — the caller evaluates `d` eagerly, as python does. */
function dictSetDefault(obj: Record<string, unknown>, key: string, dflt: unknown): unknown {
  if (!(key in obj)) {
    obj[key] = dflt;
  }
  return obj[key];
}

/** python `dict.pop(k, default)` — deletes and returns, or returns `default`. */
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

/** python `getattr(obj, name, default)` where `obj` may be a mapping.
 *  CPython 的字典**键不是属性**：`getattr({"meta": 1}, "meta", None)` 是 None，
 *  不是 1。JS 把 dict 和 object 合成了一种，所以凡是被 `getattr` 的对象有可能
 *  是个 dict（工具的返回值就是这种），都必须走这个包装。 */
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
  if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Map) {
    return false;
  }
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** python `sorted(<str iterable>)`, code-point ordered. */
function pySortedStr(vals: string[]): string[] {
  return [...vals].sort((a, b) => {
    const ca = [...a].map((c) => c.codePointAt(0) as number);
    const cb = [...b].map((c) => c.codePointAt(0) as number);
    const n = Math.min(ca.length, cb.length);
    for (let i = 0; i < n; i++) {
      if (ca[i] !== cb[i]) return (ca[i] as number) - (cb[i] as number);
    }
    return ca.length - cb.length;
  });
}

/** python `str.lower()` over code points (identity for the ASCII/CMC here). */
function pyLower(s: string): string {
  return s.toLowerCase();
}

/** python `str.startswith(prefix)` with a tuple of prefixes collapsed to the loop. */
function pyStartsWith(s: string, prefix: string): boolean {
  return s.slice(0, prefix.length) === prefix;
}

/** python `x.splitlines()` (splits on the CPython line-boundary set). */
function pySplitlines(s: string): string[] {
  const parts = s.split(/\r\n|\r|\n|\v|\f|\x1c|\x1d|\x1e|\u0085|\u2028|\u2029/);
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    // python does not emit a trailing empty field for a terminal newline
    const last = [...s].pop();
    if (last === "\n" || last === "\r" || last === "\f" || last === "\v") parts.pop();
  }
  return parts;
}

/** python `getattr(v, "value", str(v))` — reads a str-Enum's `.value`, else `str()`. */
function enumValue(v: unknown): string {
  // `v` 可能是个 dict（权限对象在某些调用方就是字典）：python 的 getattr 看不见
  // 字典键，所以那里必然落到 `str(v)` 分支。
  const raw = pyGetAttrOfObj(v, "value", pyStr(v));
  return pyStr(raw);
}

/**
 * python `json.dumps(v, sort_keys=True, ensure_ascii=False, default=str)`.
 *
 * `default=str` is what keeps a non-JSON-able value (a Set, a function, a
 * class instance) from throwing: it becomes `str(v)`. `indent` is python's,
 * where the item separator loses its trailing space. NaN/Infinity serialise
 * literally (python's `allow_nan=True`), which is NOT what JSON.stringify does.
 */
function pyJsonDumpsFull(value: unknown, opts: { sortKeys?: boolean; indent?: number } = {}): string {
  const sortKeys = opts.sortKeys === true;
  const indent = opts.indent;
  function enc(v: unknown, level: number): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") {
      if (Number.isNaN(v)) return "NaN";
      if (v === Infinity) return "Infinity";
      if (v === -Infinity) return "-Infinity";
      return pyReprNumber(v);
    }
    if (typeof v === "string") return jsonQuote(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      if (indent === undefined) return `[${v.map((x) => enc(x, level)).join(", ")}]`;
      const pad = " ".repeat(indent * (level + 1));
      const close = " ".repeat(indent * level);
      return `[\n${v.map((x) => `${pad}${enc(x, level + 1)}`).join(",\n")}\n${close}]`;
    }
    if (v instanceof Map || v instanceof Set || isDict(v)) {
      const entries: [string, unknown][] =
        v instanceof Map ? [...v.entries()].map(([k, val]) => [String(k), val])
        : v instanceof Set ? [...v].map((x) => [pyStr(x), true] as [string, unknown])
        : Object.keys(v as object).map((k) => [k, (v as Record<string, unknown>)[k]]);
      const dictLike = !(v instanceof Set);
      if (!dictLike) return enc(pyStr(v), level);
      let keys = entries.map(([k]) => k);
      if (sortKeys) keys = pySortedStr(keys);
      else keys = entries.map(([k]) => k);
      if (keys.length === 0) return "{}";
      const body = keys.map((k) => {
        const val = entries.find(([kk]) => kk === k)?.[1];
        return `${jsonQuote(k)}: ${enc(val, level + 1)}`;
      });
      if (indent === undefined) return `{${body.join(", ")}}`;
      const pad = " ".repeat(indent * (level + 1));
      const close = " ".repeat(indent * level);
      return `{\n${body.map((b) => `${pad}${b}`).join(",\n")}\n${close}}`;
    }
    // default=str
    return jsonQuote(pyStr(v));
  }
  return enc(value, 0);
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

/** python's `%d` for the one logging call site that uses it. */
function pyFmtD(v: unknown): string {
  try {
    return String(pyInt(typeof v === "number" ? Math.trunc(v) : v));
  } catch {
    return String(v);
  }
}

/** fnmatch.fnmatch with the Windows normcase pass Python performs. */
function pyNormcase(s: string): string {
  if (DISPATCH_SEAMS.platform() === "win32") return s.replaceAll("/", "\\").toLowerCase();
  return s;
}

const _fnmatchCache = new Map<string, RegExp>();

function pyFnmatch(name: string, pat: string): boolean {
  name = pyNormcase(name);
  pat = pyNormcase(pat);
  let rx = _fnmatchCache.get(pat);
  if (rx === undefined) {
    rx = _fnmatchTranslate(pat);
    _fnmatchCache.set(pat, rx);
  }
  return rx.test(name);
}

function _fnmatchTranslate(pat: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < pat.length) {
    const c = pat[i] ?? "";
    if (c === "*") {
      out += ".*";
    } else if (c === "?") {
      out += ".";
    } else if (c === "[") {
      let j = i + 1;
      let neg = "";
      if (pat[j] === "!" || pat[j] === "^") { neg = "^"; j++; }
      let cls = "";
      let k = j;
      if (pat[k] === "]") k++;
      while (k < pat.length && pat[k] !== "]") k++;
      if (k >= pat.length) {
        cls = "]" + pat.slice(j).replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
        out += "[" + neg + cls + "]";
        i = pat.length;
        continue;
      }
      const body = pat.slice(j, k);
      cls = body.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
      out += "[" + neg + cls + "]";
      i = k;
    } else {
      out += c.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
    }
    i++;
  }
  return new RegExp(out + "$", "s");
}

/** python `asyncio.CancelledError` (BaseException; str() is the empty string). */
export class CancelledErrorP extends Error {
  constructor() { super(""); this.name = "CancelledError"; }
}

/** python `except asyncio.CancelledError`. */
function isCancelledError(e: unknown): boolean {
  return e instanceof CancelledErrorP || (e as Error)?.name === "CancelledError";
}

/** python `asyncio.TimeoutError` — the marker `asyncio.wait_for` raises. */
class AskWaitTimeout extends Error {
  constructor() { super("TimeoutError"); this.name = "TimeoutError"; }
}

/** python `AttributeError` — the text after the colon is CPython's own. */
class AttributeErrorP extends Error {
  constructor(msg: string) { super(msg); this.name = "AttributeError"; }
}

/**
 * python `await asyncio.wait_for(asyncio.shield(fut), timeout)` (header note 7).
 * The three exits are preserved: value, `TimeoutError`, and a rejection that
 * propagates (which is what a real cancellation looks like in JS).
 */
function wait_for_ask<T>(fut: Promise<T>, timeout: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new AskWaitTimeout());
    }, Math.max(0, timeout) * 1000);
    fut.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** ntpath.basename: splits on BOTH separators, unlike node's posix path. */
function pyBasename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

function cryptoRandomUUID(): string {
  return globalThis.crypto.randomUUID();
}

// ── seams（python 的模块全局与函数内导入在这里可替换；默认值 = 真端口） ──────────

type AnyMod = Record<string, any>;

/** python `from subagent_runtime import MAX_HANDOFF_DEPTH`（unit 190 未落地）。 */
const _SUBAGENT_MAX_HANDOFF_DEPTH = 1;

// 已落地的真端口（静态 import；对应源里的模块级 import 或函数级 import 的成功分支）。
import * as _bot_remote_mod from "../bot_remote.js";
import * as _subagent_registry_mod from "../subagent_registry.js";
import * as _snapshot_store_mod from "../snapshot_store.js";
import * as _confirm_meta_mod from "../confirm_meta.js";
import * as _model_registry_mod from "../model_registry.js";
import * as _token_analytics_mod from "../token_analytics.js";
import * as _agent_logger_mod from "../agent_logger.js";
import * as _evolution_bridge_mod from "../evolution_bridge.js";
import * as _tool_output_spill_mod from "../tool_output_spill.js";
import * as _workflow_recorder_mod from "../workflow_recorder.js";
import * as _shadow_workspace_mod from "../shadow_workspace.js";
import * as _reflection_engine_mod from "../reflection_engine.js";
import * as _reconciliation_mod from "../reconciliation.js";

// 未落地单元：默认返回空模块，让调用点的 except 分支与源逐字等价
// （python 的 ModuleNotFoundError / AttributeError 都落进同一个 fail-open）。
const _tool_catalog_mod: AnyMod = {};
const _subagent_runtime_mod: AnyMod = {};
const _effects_mod: AnyMod = {};

export const DISPATCH_SEAMS = {
  /** python `time.time()`。 */
  now: (): number => Date.now() / 1000,
  /** python `uuid.uuid4().hex`（`[:8]` 由调用点切）。 */
  uuid4hex: (): string => cryptoRandomUUID().replaceAll("-", ""),
  /** python `sys.platform`（fnmatch 的 normcase 分支）。 */
  platform: (): string => "win32",
  /** python `os.getcwd()`。 */
  getcwd: (): string => "",
  /** python `os.path.basename()`。 */
  basename: (p: string): string => pyBasename(p),
  /** python `print(...)`。 */
  print_: (line: string): void => { console.log(line); },
  /** python `logging.getLogger(ch).info/exception(msg)`。 */
  log_line: (_level: string, _channel: string, _message: string): void => {},

  // ── 模块级 import（python 侧可通过替换 `dispatch.<name>` 打桩） ──
  truncate: (text: string, max_chars?: number, suffix?: string | null): string =>
    truncate(text, max_chars, suffix),
  register_output_sink: (call_id: string, sink: (text: string) => void): void =>
    registerOutputSink(call_id, sink),
  unregister_output_sink: (call_id: string): void => unregisterOutputSink(call_id),
  select_execution: (risk: string, opts: Record<string, unknown>): any =>
    select_execution(risk, opts as any),
  risk_to_rlevel: (v: unknown): string => risk_to_rlevel(v),
  invalidate_snapshot: (workspace: string | null): void => EnvironmentSnapshot.invalidate(workspace),
  save_image_ref: (item: unknown, workspace: unknown, name_hint: unknown): Promise<any> =>
    _save_image_ref(item, workspace, name_hint),
  get_tool_hooks: (): any => get_tool_hooks(),
  get_ask_user_store: (): any => get_ask_user_store(),
  normalize_questions: (raw: unknown): [Record<string, unknown>[], string] =>
    normalize_questions(raw),
  build_auto_resolve_user_prompt: (header: string, questions: Record<string, unknown>[]): string =>
    build_auto_resolve_user_prompt(header, questions),
  parse_auto_resolution: (text: string, questions: Record<string, unknown>[]): any =>
    parse_auto_resolution(text, questions),
  register_waiter: (call_id: string): Promise<{ answers: unknown; skipped: boolean }> =>
    register_waiter(call_id),
  drop_waiter: (call_id: string): void => drop_waiter(call_id),
  render_answer: (pending: any, answers: unknown): string => render_answer(pending, answers),
  new_pending_question: (call_id: string, session_id: string, header: string,
    questions: Record<string, unknown>[]): any =>
    new PendingQuestion(call_id, session_id, header, questions),
  /** python 在调用点读模块全局 `ASK_WAIT_TIMEOUT_S`，所以探针能改它；TS 的
   *  const import 是早绑定，这里晚绑定以保持同一处可打补丁。 */
  ask_wait_timeout: (): number => ASK_WAIT_TIMEOUT_S,

  // ── 函数级 import（python 的 `from X import y` 在调用点发生） ──
  botRemoteModule: (): AnyMod => _bot_remote_mod as AnyMod,
  toolCatalogModule: (): AnyMod => _tool_catalog_mod as AnyMod,
  subagentRuntimeModule: (): AnyMod => _subagent_runtime_mod as AnyMod,
  subagentRegistryModule: (): AnyMod => _subagent_registry_mod as AnyMod,
  snapshotStoreModule: (): AnyMod => _snapshot_store_mod as AnyMod,
  confirmMetaModule: (): AnyMod => _confirm_meta_mod as AnyMod,
  modelRegistryModule: (): AnyMod => _model_registry_mod as AnyMod,
  tokenAnalyticsModule: (): AnyMod => _token_analytics_mod as AnyMod,
  agentLoggerModule: (): AnyMod => _agent_logger_mod as AnyMod,
  evolutionBridgeModule: (): AnyMod => _evolution_bridge_mod as AnyMod,
  toolOutputSpillModule: (): AnyMod => _tool_output_spill_mod as AnyMod,
  workflowRecorderModule: (): AnyMod => _workflow_recorder_mod as AnyMod,
  shadowWorkspaceModule: (): AnyMod => _shadow_workspace_mod as AnyMod,
  reflectionEngineModule: (): AnyMod => _reflection_engine_mod as AnyMod,
  reconciliationModule: (): AnyMod => _reconciliation_mod as AnyMod,
  effectsModule: (): AnyMod => _effects_mod as AnyMod,
  /** python `from subagent_runtime import MAX_HANDOFF_DEPTH`。 */
  max_handoff_depth: (): number => _SUBAGENT_MAX_HANDOFF_DEPTH,
};

/** 探针用：整体替换 seams（对应 python 侧 monkeypatch 模块全局）。 */
export function _set_seams_for_parity(patch: Partial<typeof DISPATCH_SEAMS>): void {
  Object.assign(DISPATCH_SEAMS, patch);
}

/** 探针用：恢复默认实现（对应 python 侧 reload）。 */
export function _reset_seams_for_parity(): void {
  DISPATCH_SEAMS.now = (): number => Date.now() / 1000;
  DISPATCH_SEAMS.uuid4hex = (): string => cryptoRandomUUID().replaceAll("-", "");
  DISPATCH_SEAMS.platform = (): string => "win32";
  DISPATCH_SEAMS.getcwd = (): string => "";
  DISPATCH_SEAMS.basename = (p: string): string => pyBasename(p);
  DISPATCH_SEAMS.print_ = (line: string): void => { console.log(line); };
  DISPATCH_SEAMS.log_line = (): void => {};
  DISPATCH_SEAMS.truncate = (text: string, max_chars?: number, suffix?: string | null): string =>
    truncate(text, max_chars, suffix);
  DISPATCH_SEAMS.register_output_sink = (call_id: string, sink: (text: string) => void): void =>
    registerOutputSink(call_id, sink);
  DISPATCH_SEAMS.unregister_output_sink = (call_id: string): void => unregisterOutputSink(call_id);
  DISPATCH_SEAMS.select_execution = (risk: string, opts: Record<string, unknown>): any =>
    select_execution(risk, opts as any);
  DISPATCH_SEAMS.risk_to_rlevel = (v: unknown): string => risk_to_rlevel(v);
  DISPATCH_SEAMS.invalidate_snapshot = (workspace: string | null): void =>
    EnvironmentSnapshot.invalidate(workspace);
  DISPATCH_SEAMS.save_image_ref = (item: unknown, workspace: unknown, name_hint: unknown): Promise<any> =>
    _save_image_ref(item, workspace, name_hint);
  DISPATCH_SEAMS.get_tool_hooks = (): any => get_tool_hooks();
  DISPATCH_SEAMS.get_ask_user_store = (): any => get_ask_user_store();
  DISPATCH_SEAMS.normalize_questions = (raw: unknown): [Record<string, unknown>[], string] =>
    normalize_questions(raw);
  DISPATCH_SEAMS.build_auto_resolve_user_prompt =
    (header: string, questions: Record<string, unknown>[]): string =>
      build_auto_resolve_user_prompt(header, questions);
  DISPATCH_SEAMS.parse_auto_resolution = (text: string, questions: Record<string, unknown>[]): any =>
    parse_auto_resolution(text, questions);
  DISPATCH_SEAMS.register_waiter = (call_id: string): Promise<{ answers: unknown; skipped: boolean }> =>
    register_waiter(call_id);
  DISPATCH_SEAMS.drop_waiter = (call_id: string): void => drop_waiter(call_id);
  DISPATCH_SEAMS.render_answer = (pending: any, answers: unknown): string => render_answer(pending, answers);
  DISPATCH_SEAMS.new_pending_question = (call_id: string, session_id: string, header: string,
    questions: Record<string, unknown>[]): any =>
    new PendingQuestion(call_id, session_id, header, questions);
  DISPATCH_SEAMS.ask_wait_timeout = (): number => ASK_WAIT_TIMEOUT_S;
  DISPATCH_SEAMS.botRemoteModule = (): AnyMod => _bot_remote_mod as AnyMod;
  DISPATCH_SEAMS.toolCatalogModule = (): AnyMod => _tool_catalog_mod as AnyMod;
  DISPATCH_SEAMS.subagentRuntimeModule = (): AnyMod => _subagent_runtime_mod as AnyMod;
  DISPATCH_SEAMS.subagentRegistryModule = (): AnyMod => _subagent_registry_mod as AnyMod;
  DISPATCH_SEAMS.snapshotStoreModule = (): AnyMod => _snapshot_store_mod as AnyMod;
  DISPATCH_SEAMS.confirmMetaModule = (): AnyMod => _confirm_meta_mod as AnyMod;
  DISPATCH_SEAMS.modelRegistryModule = (): AnyMod => _model_registry_mod as AnyMod;
  DISPATCH_SEAMS.tokenAnalyticsModule = (): AnyMod => _token_analytics_mod as AnyMod;
  DISPATCH_SEAMS.agentLoggerModule = (): AnyMod => _agent_logger_mod as AnyMod;
  DISPATCH_SEAMS.evolutionBridgeModule = (): AnyMod => _evolution_bridge_mod as AnyMod;
  DISPATCH_SEAMS.toolOutputSpillModule = (): AnyMod => _tool_output_spill_mod as AnyMod;
  DISPATCH_SEAMS.workflowRecorderModule = (): AnyMod => _workflow_recorder_mod as AnyMod;
  DISPATCH_SEAMS.shadowWorkspaceModule = (): AnyMod => _shadow_workspace_mod as AnyMod;
  DISPATCH_SEAMS.reflectionEngineModule = (): AnyMod => _reflection_engine_mod as AnyMod;
  DISPATCH_SEAMS.reconciliationModule = (): AnyMod => _reconciliation_mod as AnyMod;
  DISPATCH_SEAMS.effectsModule = (): AnyMod => _effects_mod as AnyMod;
  DISPATCH_SEAMS.max_handoff_depth = (): number => _SUBAGENT_MAX_HANDOFF_DEPTH;
}

// ── 宿主提供的方法（其它 mixin / 单元；对应 python 的 Router 组合类） ─────────

/** 宿主未提供时抛出——与 admission.ts / goal.ts 的桩同一约定。 */
function hostMissing(name: string): never {
  throw new Error(`${name} must be implemented by host router`);
}

void hostMissing;

// ── 模块级常量 ────────────────────────────────────────────────────────────────

/** python `__name__` for this module — the logging channel of the fail-open sites. */
const _LOGGER_NAME = "router_modules.dispatch";

export const MUTATING_WORKSPACE_TOOLS = new Set([
  "write_file", "edit_file", "apply_patch", "delete_file", "move_file", "rename_file",
  "create_file", "append_file", "replace_file_content", "write_to_file", "file_write", "file_edit",
  "run_shell", "run_command", "git_commit", "git_checkout", "git_add", "git_reset",
  "git_merge", "git_rebase", "git_cherry_pick", "git_stash", "git_pull", "git_branch",
  "worktree_create", "worktree_switch", "worktree_delete",
]);

export const AGENT_ROLES: Record<string, { domain: string; tools: string[] }> = {
  file_agent: { domain: "file", tools: ["read_text","write_file","edit_file","search_code","find_files","list_dir","git_status","git_add","git_commit","git_push"] },
  computer_agent: { domain: "computer", tools: ["shell_executor","action_search","native_action_chain","cua_action"] },
  app_agent: { domain: "app", tools: ["computer_screenshot","computer_click","computer_move_cursor","computer_type","computer_press_key","computer_drag","computer_scroll","app_launch","app_close","app_focus","app_list","operate_app","ui_automation"] },
  browser_agent: { domain: "browser", tools: ["navigate","snapshot","click","fill","evaluate","web_fetch","tab_open","tab_switch","tab_close","tab_suspend","tab_resume","tab_list","viewport","tab_screenshot","session_suspend","session_resume"] },
  search_agent: { domain: "search", tools: ["academic_search","standard_search","web_search","credibility_check"] },
};

export const PARALLEL_SAFE_TOOLS = new Set([
  "read_text", "read_file", "search_code", "find_files", "list_dir",
  "web_fetch", "web_search", "semantic_search", "academic_search",
  "git_status", "git_log", "git_diff", "git_show", "system_info",
  "grep", "glob",
  "tool_search",
]);

export function _summarize_turn_outcome(trace: Record<string, any>[]): Record<string, unknown> {
  /** Analyze the execution trace of the current turn deterministically. */
  if (!pyTruth(trace)) {
    return { status: "empty", failed_tools: [], successful_tools: [], error_details: "" };
  }

  const successful: Record<string, any>[] = [];
  const failed: Record<string, any>[] = [];
  const errors: string[] = [];

  for (const t of trace) {
    const st = pyLower(pyStr(pyOr(dictGet(t, "status"), "")));
    const is_ok = dictGet(t, "ok");
    // An unknown status or error or explicit ok=False must NOT be considered successful
    if (
      pyIn(st, ["failed", "error", "unknown", "rejected", "blocked"])
      || is_ok === false
      || (pyTruth(dictGet(t, "error")) && !(pyIn(st, ["ok", "success"]) || is_ok === true))
      || (!pyIn(st, ["ok", "success"]) && is_ok !== true)
    ) {
      failed.push(t);
      const err = pyOr(pyOr(dictGet(t, "error"), dictGet(t, "output")), "");
      const tname = pyStr(pyOr(pyOr(dictGet(t, "tool"), dictGet(t, "name")), "tool"));
      if (pyTruth(err)) {
        // 源是 `.split("\n")[0]`，只按 \n 断，\r 留在串里——与 splitlines() 不同。
        const err_first = pyStrip(pyStr(err)).split("\n")[0] ?? "";
        errors.push(`${tname}: ${DISPATCH_SEAMS.truncate(err_first, 80)}`);
      } else {
        errors.push(`${tname} failed (status=${pyOr(st, "unconfirmed")})`);
      }
    } else {
      successful.push(t);
    }
  }

  if (!pyTruth(failed)) {
    return { status: "all_success", failed_tools: [], successful_tools: successful, error_details: "" };
  } else if (!pyTruth(successful)) {
    return {
      status: "all_failed",
      failed_tools: failed,
      successful_tools: [],
      error_details: errors.slice(0, 2).join("; "),
    };
  } else {
    return {
      status: "partial",
      failed_tools: failed,
      successful_tools: successful,
      error_details: errors.slice(0, 2).join("; "),
    };
  }
}

// ── mixin ────────────────────────────────────────────────────────────────────

export class RouterDispatchMixin {
  /** Mixin providing tool dispatching, execution, ask-user, and presentation. */
  [k: string]: any;

  _tool_specs_for(context: Record<string, unknown>): Record<string, any>[] {
    /** Build the tool catalogue exposed to the model for this turn.
     *
     * Remote (bot) sessions get the denylisted tools stripped from the
     * catalogue entirely — belt and braces alongside the runtime block, so the
     * model is not even tempted to propose them.
     */
    let exclude = new Set<string>();
    if (pyTruth(dictGet(context, "is_remote"))) {
      try {
        const mod = DISPATCH_SEAMS.botRemoteModule();
        exclude = new Set(pyIter(mod.get_bot_controller().load_tool_denylist(dictGet(context, "platform", ""))).map((x) => String(x)));
      } catch {
        // BUG(port): 源的 `except Exception: exclude = set()` —— 控制器坏了就
        // 当没有黑名单，宁可多发几个工具也不能让回合挂掉。
        exclude = new Set();
      }
    }
    // Sub-agent allowlist: invert it into the exclude set the registry
    // already understands, so a read-only sub-agent never even SEES a write
    // tool. `_run_tool_call` re-checks at dispatch — hiding a tool from the
    // catalogue is a hint, blocking it is the guarantee.
    if (this.allowed_tools !== null && this.allowed_tools !== undefined) {
      for (const tool of this.tools.list_tools()) {
        if (!pyIn(tool.name, this.allowed_tools)) {
          exclude.add(tool.name);
        }
      }
    }
    // A sub-agent may not spawn further sub-agents — except through an
    // explicit hand-off allowlist on its own persona, and only one level
    // deep. Without a cap a runaway prompt could fan out recursively and
    // exhaust the semaphore, which is why `handoffs` is data on the
    // definition rather than something the model can talk its way into.
    if (pyTruth(this.is_subagent) && !this._may_hand_off()) {
      exclude.add("task");
    }
    // `ask_user` needs a clickable card in front of a human. Two callers have
    // nobody to click it: a sub-agent (its parent is blocked waiting on a
    // final marker, and the question would render on nobody's screen), and a
    // remote/bot session (no card UI at all). Hiding it is better than
    // letting either one park a question that can never be answered.
    // P3-2: 子代理 MCP 工具数硬顶 (默认 24，SubagentDef.mcp_tool_cap 可覆写) 与 mcpRules 过滤
    if (pyTruth(this.is_subagent) || pyTruth(dictGet(context, "is_subagent"))) {
      let mcp_cap: unknown = pyGetAttr(this, "mcp_tool_cap", null);
      if (mcp_cap === null) {
        mcp_cap = dictGet(context, "mcp_tool_cap", 24);
      }
      const d_rules: any = pyOr(pyGetAttr(this, "domain_rules", {}), dictGet(context, "domain_rules", {}));
      const mcp_rules: any = isDict(d_rules) ? dictGet(d_rules, "mcpRules", {}) : {};
      const deny_mcp: string[] = pyIter(dictGet(mcp_rules, "deny", [])).map((x) => String(x));
      const allow_mcp: string[] = pyIter(dictGet(mcp_rules, "allow", [])).map((x) => String(x));

      const all_mcp_tools: string[] = [];
      for (const t of this.tools.list_tools()) {
        if (pyStartsWith(t.name, "mcp__")) all_mcp_tools.push(t.name);
      }
      const visible_mcp: string[] = [];
      for (const t_name of all_mcp_tools) {
        if (deny_mcp.some((pat) => pyFnmatch(t_name, pat))) {
          exclude.add(t_name);
          continue;
        }
        if (pyTruth(allow_mcp) && !(allow_mcp.length === 1 && allow_mcp[0] === "*")) {
          if (!allow_mcp.some((pat) => pyFnmatch(t_name, pat))) {
            exclude.add(t_name);
            continue;
          }
        }
        if (!exclude.has(t_name)) {
          visible_mcp.push(t_name);
        }
      }

      if (pyLen(visible_mcp) > (mcp_cap as number)) {
        const truncated = visible_mcp.slice(mcp_cap as number);
        for (const t_name of truncated) {
          exclude.add(t_name);
        }
        DISPATCH_SEAMS.log_line(
          "INFO", "router.subagent",
          `子代理 MCP 工具数超出硬顶 (${pyFmtD(pyLen(visible_mcp))} > ${pyFmtD(mcp_cap)})，已截断 ${pyFmtD(pyLen(truncated))} 个工具`
        );
      }
    }

    // 六·UC1 检索式目录裁剪。只对主会话生效：子代理已经有 allowlist、远程
    // 已经有 denylist，两者都是**按职责**收窄的，再叠一层**按相关性**收窄
    // 只会让「为什么这个工具不见了」变成两个原因的乘积。
    //
    // 这一步和上面三个来源共用同一个 exclude，所以它同样只是提示 ——
    // `_run_tool_call` 那边的校验一个字都没动。
    if (!pyTruth(this.is_subagent) && !pyTruth(dictGet(context, "is_remote"))) {
      try {
        const mod = DISPATCH_SEAMS.toolCatalogModule();
        for (const n of pyIter(mod.trim_exclude(
          this.tools,
          pyStr(pyOr(dictGet(context, "_turn_query"), "")),
          this._revealed_tools,
          pyStr(pyOr(this.workspace, "")),
        ))) {
          exclude.add(String(n));
        }
      } catch {
        // BUG(port): 裁剪失败就照全量发 —— 贵一点，但绝不能让回合挂掉。
      }
    }
    return this.tools.to_openai_tools(null, exclude);
  }

  _absorb_revealed(result: unknown): boolean {
    /** 把 `tool_search` 命中的工具收进本轮视图。
     *
     * 名字要拿全量注册表再核一遍：`revealed_tools` 走的是 `Result.meta`，
     * 而 meta 最终来自工具实现，核对之后视图里就不可能出现一个注册表里没有
     * 的名字。这不是安全边界（派发那侧本来就会拒），而是不让一个幽灵名字
     * 在目录里挂着、让模型反复去调一个不存在的东西。
     *
     * Returns:
     *   True 表示视图变宽了，调用方需要重建 tool_specs。
     */
    const names = dictGet(pyOr(pyGetAttrOfObj(result, "meta", null), {}), "revealed_tools");
    if (!pyTruth(names)) {
      return false;
    }
    const fresh = new Set<string>();
    for (const n of pyIter(names)) {
      if (typeof n === "string" && pyTruth(this.tools.get(n))) {
        fresh.add(n);
      }
    }
    const current: Set<string> = this._revealed_tools;
    let subset = true;
    for (const n of fresh) {
      if (!current.has(n)) { subset = false; break; }
    }
    if (subset) {
      return false;
    }
    for (const n of fresh) {
      current.add(n);
    }
    return true;
  }

  _may_hand_off(): boolean {
    /** True if this sub-agent is still allowed to delegate onward.
     *
     * A first-level sub-agent (spawned from the user's turn) is depth 1 and
     * may hand off once; its target is depth 2 and is a leaf. So the gate is
     * `depth <= MAX_HANDOFF_DEPTH`, not `<`.
     */
    const MAX_HANDOFF_DEPTH = DISPATCH_SEAMS.max_handoff_depth();
    return pyTruth(this.subagent_handoffs) && this.subagent_depth <= MAX_HANDOFF_DEPTH;
  }

  _outcome_ok(outcome: unknown): boolean {
    /** Did this tool call succeed? Read from the trace row, not the content.
     *
     * Four shapes reach here, which is why this is a function rather than an
     * inline check: a normal row (`status` is "ok"/"error"), an `ask_user` row
     * ("answered"/"needs_input" — both mean the mechanism worked), and the
     * gather-exception row, which has no `status` at all and only an `error`
     * key. Anything unrecognised counts as NOT ok: an observability signal that
     * over-reports success is worse than one that over-reports failure.
     *
     * `@staticmethod` in the source; it stays an instance method here because
     * the mixin composes on the prototype and every call site is `self._outcome_ok(...)`.
     */
    if (outcome instanceof Error || !isDict(outcome)) {
      return false;
    }
    const row = dictGet(outcome, "trace");
    if (!isDict(row)) {
      return false;
    }
    if (pyTruth(dictGet(row, "error"))) {
      return false;
    }
    return pyIn(dictGet(row, "status"), ["ok", "answered", "needs_input"]);
  }

  _is_parallel_safe(call: Record<string, any>): boolean {
    /** True if this tool call can safely run concurrently with others.
     *
     * Conditions:
     * 1. The tool name is in PARALLEL_SAFE_TOOLS (strictly read-only).
     * 2. The risk controller has NOT marked it as needing approval — even a
     *    low-risk tool could have been escalated by a RemoteSessionRiskDecorator
     *    or dynamic denylist.
     */
    const name = pyStr(pyOr(dictGet(call, "name"), ""));
    if (!PARALLEL_SAFE_TOOLS.has(name)) {
      return false;
    }
    // Double-check: the risk controller may have escalated it.
    const risk = this.risk.classify_risk(name, dictGet(call, "arguments") as any);
    return risk === RiskLevel.LOW;
  }

  async _run_tool_call(call: Record<string, any>, context: Record<string, any>): Promise<Record<string, any>> {
    /** Execute one model-requested tool call under full guardrails.
     *
     * Args:
     *   call: Normalized `{id, name, arguments}`.
     *   context: Per-turn context.
     *
     * Returns:
     *   `{content: str, trace: dict, halt: bool}` — `content` is what gets fed
     *   back to the model as the tool result.
     */
    const name = pyStr(pyOr(dictGet(call, "name"), ""));
    let args: Record<string, any> = pyOr(dictGet(call, "arguments"), {}) as Record<string, any>;
    const call_id: string = pyStr(pyOr(dictGet(call, "id"), `${name}-${pySlice(DISPATCH_SEAMS.uuid4hex(), 0, 8)}`));

    if (pyIn("__parse_error__", args)) {
      const msg = (
        `Arguments for \`${name}\` were not valid JSON. ` +
        "Re-issue the call with well-formed JSON arguments."
      );
      return { content: msg, trace: { tool: name, status: "bad_args" }, halt: false };
    }

    context["risk_level"] = enumValue(this.risk.classify_risk(name, args));

    // Sub-agent capability boundary. The tool was already hidden from the
    // catalogue in `_tool_specs_for`, but a model can still hallucinate a
    // name it never saw — this is the enforcement, not the hint.
    if (this.allowed_tools !== null && this.allowed_tools !== undefined
      && !pyIn(name, this.allowed_tools)) {
      const allowed = pySortedStr(pyIter(this.allowed_tools).map((x) => String(x)));
      const msg = (
        `Tool \`${name}\` is not available to this sub-agent. ` +
        `Allowed: ${allowed.length ? allowed.join(", ") : "(none)"}.`
      );
      return {
        content: msg,
        trace: { tool: name, status: "subagent_blocked" },
        halt: false,
      };
    }
    if (pyTruth(this.is_subagent) && name === "task") {
      if (!this._may_hand_off()) {
        return {
          content: (
            "Sub-agents cannot spawn further sub-agents. Finish the "
            + "task yourself and report back."
          ),
          trace: { tool: name, status: "subagent_blocked" },
          halt: false,
        };
      }
      // Hand-off is allowed, but only to the personas this one declares.
      // Checked here and not only in the schema because the enum is global
      // — the model can name any registered persona and we must not let a
      // read-only planner conjure a write-capable coder.
      const requested = new Set<string>();
      for (const spec of pyIter(pyOr(dictGet(args, "tasks"), []))) {
        requested.add(pyStr(pyOr(dictGet(pyOr(spec, {}), "subagent_type"), "")));
      }
      const handoffs: Set<string> = new Set(pyIter(this.subagent_handoffs).map((x) => String(x)));
      const illegalArr: string[] = [];
      for (const r of requested) {
        if (!handoffs.has(r)) illegalArr.push(r);
      }
      const illegal = pySortedStr(illegalArr);
      if (pyTruth(illegal)) {
        const allowed = pySortedStr([...handoffs]).join(", ");
        return {
          content: (
            `Hand-off to ${pyStr(illegal)} is not permitted for this `
            + `sub-agent. Allowed hand-offs: ${allowed}.`
          ),
          trace: { tool: name, status: "handoff_blocked" },
          halt: false,
        };
      }
    }

    // P3-2: 子代理五轴域规则判定 (filesystem, network, commandRules, mcpRules, onRestrict)
    if (pyTruth(this.is_subagent) || pyTruth(dictGet(context, "is_subagent"))) {
      const d_rules: any = pyOr(pyGetAttr(this, "domain_rules", {}), dictGet(context, "domain_rules", {}));
      if (pyTruth(d_rules)) {
        try {
          const mod = DISPATCH_SEAMS.subagentRegistryModule();
          const [dom_allowed, action_d, failure_kind, reason] = mod.evaluate_domain_rules(d_rules, name, args);
          if (!dom_allowed) {
            if (action_d === "block") {
              try {
                const eb = DISPATCH_SEAMS.evolutionBridgeModule();
                await eb.notify_tool_failure(
                  this.session_id,
                  `turn_${this._turn_seq}`,
                  name,
                  reason,
                  { failure_kind: failure_kind },
                );
              } catch {
                // BUG(port): 源的 `except Exception: pass` —— 演进镜像坏了不能
                // 影响拦截本身。
              }
              const msg = `子代理域规则拦截 (action=block): ${reason}`;
              await this._emit_tool_result(
                name, call_id, args, context,
                { ok: false, value: null, error: msg, status: "denied" },
              );
              return {
                content: msg,
                trace: { tool: name, status: "domain_rule_blocked", failure_kind: failure_kind },
                halt: false,
              };
            } else if (action_d === "fallback") {
              const msg = `子代理域规则受限提示 (action=fallback): ${reason}。请切换其他备选工具或向用户说明限制。`;
              await this._emit_tool_result(
                name, call_id, args, context,
                { ok: false, value: null, error: msg, status: "restricted_fallback" },
              );
              return {
                content: msg,
                trace: { tool: name, status: "domain_rule_fallback", failure_kind: failure_kind },
                halt: false,
              };
            }
          }
        } catch {
          // BUG(port): 源的 `except Exception: pass` —— 域规则判定器坏了按放行，
          // 与源一致（它是增强层，不是边界层）。
        }
      }
    }

    // ── Loop / no-progress gate ──────────────────────────────────────────────
    //
    // Placed here deliberately: before `pre_tool_use`, so a call we are going
    // to refuse never gets as far as asking the user to approve it. A stuck
    // model that has already failed this exact call four times should not be
    // generating permission prompts.
    //
    // A `critical` verdict blocks the ACTION, not the turn — the explanation
    // comes back as the tool result, so the model still has its remaining steps
    // to change approach or report the failure honestly. That is the whole
    // point: stopping the turn outright would leave the user with silence,
    // while letting it run leaves them with eight identical failures.
    // 源的 `self.tools.get(name) is not None` 只求值一次：注册表的 `get` 不是
    // 免费的（它会记账、可能被别的实现挂上副作用），所以这里也只取一次。
    const _tool_known_obj = this.tools.get(name);
    const _loop_verdict = this.loop_detector.check(name, args, {
      tool_known: _tool_known_obj !== undefined && _tool_known_obj !== null,
    });
    if (pyTruth(_loop_verdict.blocks)) {
      // Record the refusal too. Without it the no-progress streak freezes at
      // whatever tripped `critical`, the global breaker can never be reached,
      // and a model that keeps hammering the same call after being told to stop
      // gets the same gentle message forever instead of escalating.
      this.loop_detector.record_blocked(name, args);
      try {
        const eb = DISPATCH_SEAMS.evolutionBridgeModule();
        await eb.notify_loop_fault(this.session_id, `turn_${this._turn_seq}`, name, _loop_verdict.message);
      } catch {
        // BUG(port): 源的 `except Exception: pass`。
      }
      return {
        content: _loop_verdict.message,
        trace: {
          tool: name,
          status: "loop_blocked",
          detector: _loop_verdict.detector,
          count: _loop_verdict.count,
        },
        halt: false,
      };
    }

    // No permission pre-check here on purpose. The turn's permission rides on
    // `context["permission"]`, and risk_control's GLOBAL policy layer reads it
    // to decide allow/ask/deny. That layer is the hard guarantee behind
    // 计划模式/只读: a GLOBAL DENY short-circuits the pipeline walk, so neither
    // a granted permission nor the INHERITED layer can talk it back into
    // running. Keeping a second gate here is how the two systems drifted apart
    // in the first place.
    const event = await this.bus.emit(
      "pre_tool_use",
      { tool_name: name, call_id: call_id, args: args, context: context, session_id: this.session_id },
    );
    let action = enumValue(event.action);
    if (action === "ask") {
      // An approval the user already gave clears this exact call. Blocks are
      // untouched — only an *ask* is answerable, so a read-only permission
      // can't be unlocked by a stale grant.
      if (this.risk.has_grant(name, args, context)) {
        action = "continue";
      }
    }
    if (action === "ask") {
      // Give PermissionRequest hooks a chance to resolve the prompt without
      // bothering the user. A hook may return allow (proceed), deny (block)
      // or stay silent (fall through to asking the user).
      const perm = await this.bus.emit("permission_request", {
        tool_name: name,
        call_id: call_id,
        args: args,
        risk_level: dictGet(context, "risk_level"),
        reason: event.blockReason,
        context: context,
      });
      const decision = pyStr(pyOr(dictGet(pyOr(perm.payload, {}), "hook_decision"), ""));
      if (decision === "allow") {
        action = "continue";
      } else if (enumValue(perm.action) === "block" || decision === "deny") {
        action = "block";
        event.blockReason = pyOr(perm.blockReason, event.blockReason);
      }
    }

    if (action === "block" || action === "ask") {
      // The card is already on screen as "running" (pre_tool_use was
      // broadcast). Settle it explicitly, otherwise it spins forever.
      // Structured confirm semantics (U wave): the same guard verdict the
      // CUA registry would apply, recomputed from the same pure sources
      // (gui_action_classifier + ACTION_SPECS) — confirm_reason原文 /
      // scenario_tags / confirmation_class / allow_always / handoff.
      // Pure display payloads: enforcement paths above are untouched.
      const mod = DISPATCH_SEAMS.confirmMetaModule();
      const confirm_meta: Record<string, any> = mod.build_confirm_meta(
        name, args, { block_reason: pyStr(pyOr(event.blockReason, "")), context: context },
      );
      let status: string;
      let msg: string;
      if (action === "ask" && confirm_meta["handoff"] === true) {
        // HANDOFF 档不是"待确认"而是"不该由代理做"：停成 denied，
        // 不落 pending——移交类没有可批准的选项，问了也是白问。
        status = "denied";
        msg = pyStr(pyOr(dictGet(confirm_meta, "confirm_reason"), "这类动作需要用户亲手执行。"));
      } else if (action === "block") {
        status = "denied";
        msg = `已被策略拦截：${event.blockReason}`;
      } else {
        status = "needs_confirmation";
        // block_reason already carries the natural Chinese confirmation
        // prompt from RiskController._build_confirmation_prompt.
        msg = pyStr(pyOr(event.blockReason, (
          "接下来这一步会改动你的电脑状态。"
          + "回复「同意」我就继续；不想做的话直接告诉我换个做法。"
        )));
        // Record the question. The policy pipeline already does this for
        // its own asks, but a gate-level ask never went through it — and
        // an unrecorded ask cannot be answered by the next turn.
        this.risk.record_pending(call_id, name, args, msg, this.session_id);
      }
      await this._emit_tool_result(
        name, call_id, args, context,
        {
          ok: false, value: null, error: msg, status: status,
          meta: (status === "needs_confirmation"
            ? { needs_confirmation: true, ...confirm_meta }
            : confirm_meta),
        },
      );
      return {
        content: msg,
        trace: { tool: name, status: status, reason: event.blockReason },
        halt: true,
        confirm_meta: confirm_meta,
      };
    }

    if (!pyTruth(this.tools.get(name))) {
      const msg = `No such tool: \`${name}\`. Pick one from the provided tool list.`;
      await this._emit_tool_result(name, call_id, args, context,
        { ok: false, value: null, error: msg, status: "failed" });
      return { content: msg, trace: { tool: name, status: "unknown" }, halt: false };
    }

    // B5: Pre-hooks run AFTER policy authorization, BEFORE dispatch.
    // May veto (destructive guard) or rewrite args (sanitization).
    const hooks = DISPATCH_SEAMS.get_tool_hooks();
    const pre = hooks.run_pre(name, args, context);
    if (pyTruth(dictGet(pre, "blocked"))) {
      const msg = dictGet(pre, "reason");
      await this._emit_tool_result(name, call_id, args, context,
        { ok: false, value: null, error: msg, status: "denied" });
      return {
        content: msg, trace: { tool: name, status: "hook_blocked", hook_trail: dictGet(pre, "trail") },
        halt: true,
      };
    }
    // A pre-hook may sanitize / normalize args before dispatch.
    args = dictGet(pre, "args") as Record<string, any>;

    // File-mutating tool → snapshot pre-image so a later rollback can undo it.
    // Best-effort: capture never blocks dispatch, and the store swallows its
    // own errors so a broken snapshot degrades to "no undo for this step".
    //
    // The report is KEPT. It used to be discarded, which is how the
    // "reversible" badge came to be a lie: it was a lookup on the tool name,
    // so a write over a file bigger than the snapshot cap — nothing stored,
    // nothing restorable — still rendered as reversible.
    let snapshot_report: Record<string, any> | null = null;
    let paths: string[] = [];
    try {
      const mod = DISPATCH_SEAMS.snapshotStoreModule();
      paths = pyIter(mod.mutating_paths_for(name, args)).map((x) => String(x));
    } catch {
      // BUG(port): 源的 `except Exception: paths = []`。
      paths = [];
    }
    if (pyTruth(paths)) {
      // Resolving paths already proved this is a tracked mutating call, so
      // from here a failure means "we hold no pre-image", not "nothing to
      // undo" — the two must not collapse into the same None.
      try {
        // Use the newest user-turn seq as the checkpoint handle, matching
        // the chat-truncation contract on the frontend.
        const mod = DISPATCH_SEAMS.snapshotStoreModule();
        const turn_seq = this._current_turn_seq();
        snapshot_report = { ...(pyOr(mod.get_snapshot_store().capture(
          this.session_id, turn_seq, name, call_id, paths,
        ), {}) as Record<string, any>) };
        snapshot_report["seq"] = turn_seq;
      } catch {
        // BUG(port): 源的 `except Exception:` —— 快照坏了按"全部失败"记账，
        // 让 UI 显示不可回滚，而不是假装无事发生。
        snapshot_report = { captured: [], skipped: [], failed: [...paths], recoverable: false };
      }
    }

    try {
      this.risk.consume_grant(name, args, context);
    } catch (_e) {
      // 风险预算扣减失败若无声，等于预算管线被旁路（§3 不变量 8 邻域）
      DISPATCH_SEAMS.print_(`[risk] consume_grant FAILED for ${name}: ${excStr(_e)}`);
    }

    // ask_user auto-resolution: before we stop the turn to ask, check whether
    // the answer is already in the conversation. If a separate judgement call
    // says every question is settled by something the user already said (or a
    // fact already on the table), answer it ourselves and let the turn keep
    // going — no card, no interruption. Anything uncertain still asks. See the
    // three disciplines in ask_user.py. Best-effort: any failure falls through
    // to the normal ask.
    if (name === "ask_user" && pyTruth(this.ask_auto_resolve)) {
      const auto = await this._auto_resolve_ask(args);
      if (auto !== null && auto !== undefined) {
        await this._emit_tool_result(
          name, call_id, args, context,
          { ok: true, value: auto["content"], error: null, status: "completed", meta: { ask_auto_resolved: true } },
        );
        return {
          content: auto["content"],
          trace: { tool: name, status: "auto_resolved" },
          halt: false,
        };
      }
    }

    // Per-call context. `context` is shared by every call in the turn, so
    // writing call_id onto it would race: a parallel read batch runs through
    // asyncio.gather, and two calls stamping the same dict would attribute
    // one command's output to the other's card. Only the dispatch needs it.
    const call_ctx: Record<string, any> = { ...context };
    call_ctx["call_id"] = call_id;
    const _permission = pyGetAttr(this, "permission", null);
    const is_full_mode = pyTruth(_permission)
      ? pyIn(pyGetAttrOfObj(_permission, "value", pyStr(_permission)), ["full", "autonomous"])
      : _permission;
    if (action === "continue" || pyTruth(is_full_mode)) {
      call_ctx["confirmed"] = true;
    }
    if (pyTruth(is_full_mode)) {
      call_ctx["sandbox_mode"] = "danger-full-access";
    }

    // §7.4 执行模式选择——与关键词路径 `_execute` 同一道闸，放在策略门之后：
    // CRITICAL 工具的策略询问先走，批准授权本身就是 §7.4 要的人工确认，
    // 在询问之前拒绝会让 R4 永远不可达。worktree_available=False 如实传参：
    // LLM 分发路径同样没有副本机制，不假装隔离。
    let plan: any;
    try {
      plan = DISPATCH_SEAMS.select_execution(
        DISPATCH_SEAMS.risk_to_rlevel(pyStr(pyOr(dictGet(context, "risk_level"), ""))),
        {
          worktree_available: false,
          high_risk_confirmed: pyTruth(dictGet(call_ctx, "confirmed"))
            ? true : Boolean(this.risk.has_grant(name, args, context)),
        },
      );
    } catch (_e) {
      // 模式选择崩溃绝不默认放行——fail-closed 并把原因作为工具结果回给模型
      DISPATCH_SEAMS.print_(`[execution] select_execution FAILED, refusing ${name}: ${excStr(_e)}`);
      const msg = "[execution] 执行模式选择失败，已按最坏情况拒绝执行。";
      await this._emit_tool_result(name, call_id, args, context,
        { ok: false, value: null, error: msg, status: "denied" });
      return {
        content: msg,
        trace: { tool: name, status: "execution_refused" },
        halt: true,
      };
    }
    call_ctx["execution_mode"] = plan.mode;
    call_ctx["os_confinement"] = plan.os_confinement;
    if (plan.mode === MODE_REFUSED) {
      // 策略放行但 §7.4 不放行：未经显式人工确认的 R4 无论权限模式如何都拒绝
      const msg = `[execution] ${plan.reason}`;
      await this._emit_tool_result(name, call_id, args, context,
        { ok: false, value: null, error: msg, status: "denied" });
      return {
        content: msg,
        trace: { tool: name, status: "execution_refused" },
        halt: false,
      };
    }
    if (plan.mode === MODE_DANGER_FULL) {
      DISPATCH_SEAMS.print_(`[execution] DANGER-FULL-ACCESS granted for ${name} `
        + `(call=${call_id}, session=${this.session_id})`);
    }

    // Phase 2·R2: cross-process replay interception.
    //
    // The args hash is computed here rather than next to the ledger write
    // because the same value answers two questions: "what should the ledger
    // row say" and "has this exact call already landed". Hashing the args as
    // they will actually be used — pre-hooks have already run — is what makes
    // two identical effective calls hash the same.
    const _ledger = pyIn(dictGet(context, "risk_level"), ["medium", "high", "critical"]);
    let _args_hash = "";
    if (_ledger) {
      try {
        _args_hash = createHash("sha256").update(pyJsonDumpsFull(args, { sortKeys: true }), "utf8").digest("hex");
      } catch {
        // BUG(port): 源的 `except Exception: _lg.getLogger(__name__).exception(...)`
        // —— 哈希通道坏了就把本笔当无哈希记账，不拦执行。
        DISPATCH_SEAMS.log_line("ERROR", _LOGGER_NAME, "side-effect args hash failed");
      }
    }
    // Typed effect (Phase 2). `args_hash` can only say "same words"; this
    // says "this change, to this thing, expected to end in this state" — the
    // only form in which a resumed run can check the WORLD instead of the
    // transcript. Unmodelled tools return None and keep the advisory ledger.
    let _effect: Record<string, any> = {};
    let _op_id = "";
    let _pre_hash = "";
    let _planned_hash = "";
    if (_ledger) {
      try {
        const _fx = DISPATCH_SEAMS.effectsModule();
        _effect = pyOr(_fx.classify(name, args, pyStr(pyOr(pyGetAttr(this, "workspace", ""), ""))), {}) as Record<string, any>;
        if (pyTruth(_effect)) {
          _pre_hash = _fx.snapshot_hash(name, args, _effect);
          _planned_hash = _fx.planned_state_hash(name, args);
          _op_id = _fx.operation_id(
            pyStr(pyOr(dictGet(context, "goal_id"), this.session_id)),
            _effect["kind"], _effect["target"],
            _fx.intent_hash(name, args));
        }
      } catch {
        // BUG(port): 源的 `except Exception: log + 清空 _effect/_op_id`。
        // 注意源的 except 只重置 `_effect` 与 `_op_id`，`_pre_hash` /
        // `_planned_hash` 保留半路算出来的值 —— 逐字照搬。
        DISPATCH_SEAMS.log_line("ERROR", _LOGGER_NAME, "typed effect classify failed");
        _effect = {};
        _op_id = "";
      }
    }
    // Typed replay / conflict guard — the point of Phase 2.
    //
    // It only looks at attempts from a process that is no longer alive, and
    // it decides by comparing the TARGET's current state against that
    // attempt's before/expected states, not by comparing argument text:
    //
    //   landed      the file already is what this call would make it →
    //               running it would be the second time. Skip, with evidence.
    //   conflict    the file changed into something else → someone (the user,
    //               another tool, a half-finished write) is in the way. Skip
    //               and say so; a full-content write would clobber it.
    //   not_started the file is byte-identical to before → safe, run it.
    //   unknown     no proof either way → run it, and let the resume prompt's
    //               "verify before redoing" list carry the doubt (blocking
    //               every unprovable case would wall the agent).
    //
    // Either skip restamps the old row to this generation, so the guard fires
    // once per operation: a deliberate repeat gets through on the next call.
    if (pyTruth(_op_id) && pyTruth(_effect)) {
      let _prev: any = null;
      try {
        _prev = this.storage.find_effect_by_operation(_op_id);
      } catch {
        // BUG(port): 源的 `except Exception: log`，_prev 保持 None 即继续执行。
        DISPATCH_SEAMS.log_line("ERROR", _LOGGER_NAME, "typed effect lookup failed");
      }
      if (pyTruth(_prev)) {
        const _fx = DISPATCH_SEAMS.effectsModule();
        const _rec = _fx.reconcile(
          _effect["kind"], _effect["target"],
          pyOr(pyStr(pyOr(dictGet(_prev, "pre_hash"), "")), _pre_hash),
          pyOr(pyStr(pyOr(dictGet(_prev, "planned_hash"), "")), _planned_hash),
        );
        if (_rec["status"] === "landed" || _rec["status"] === "conflict") {
          try {
            this.storage.mark_effect_reconciled(
              pyStr(pyOr(dictGet(_prev, "call_id"), "")),
              _rec["status"] === "landed" ? "completed" : "conflict",
              _fx.snapshot_hash(name, args, _effect),
              _op_id);
          } catch {
            // BUG(port): 源的 `except Exception: log`。
            DISPATCH_SEAMS.log_line("ERROR", _LOGGER_NAME, "effect reconcile write failed");
          }
          const _short = pyOr(DISPATCH_SEAMS.basename(_effect["target"]), _effect["target"]);
          const _GIT_KINDS: unknown = pyGetAttr(_fx, "GIT_KINDS", []);
          const _is_git = pyIn(_effect["kind"], _GIT_KINDS);
          let msg: string;
          if (_is_git && _rec["status"] === "landed") {
            // The repo itself is the evidence: HEAD moved to our
            // commit, the branch is the one we asked for, the remote
            // ref contains our sha. Doing it again means a second
            // commit or a second push.
            msg = (
              `这一步跳过了：仓库 \`${_short}\` 里这次 ${name} **已经生效了**`
              + `（上一个进程的 call ${pySlice(pyStr(dictGet(_prev, "call_id", "")), 0, 8)}，`
              + `现场核对：${dictGet(_rec, "detail")}）。再执行一遍会多出一次`
              + `提交/推送。\n`
              + `如果你确认还要再做一次，请再发一次同样的调用，这次会真的执行。`
            );
          } else if (_is_git) {
            msg = (
              `这一步拦下了：仓库 \`${_short}\` 的状态既不是上次动手前的样子，`
              + `也不是这次 ${name} 要达成的样子——中间有别人动过`
              + `（上次尝试 call ${pySlice(pyStr(dictGet(_prev, "call_id", "")), 0, 8)}，`
              + `现场核对：${dictGet(_rec, "detail")}）。\n`
              + `请先看一遍 git log / git status，确认当前在哪个提交上，`
              + `再决定要不要继续。`
            );
          } else if (_rec["status"] === "landed") {
            msg = (
              `这一步跳过了：\`${_short}\` 现在的内容已经**正好是**这次 `
              + `${name} 想写成的样子——上一个进程里这次写入已经落地了`
              + `（call ${pySlice(pyStr(dictGet(_prev, "call_id", "")), 0, 8)}，状态 `
              + `${dictGet(_prev, "status")}）。再执行一遍就是写第二次。\n`
              + `如果你确认还需要写，请再发一次同样的调用，这次会真的执行。`
            );
          } else {
            msg = (
              `这一步拦下了：\`${_short}\` 既不是上次动手前的样子，也不是`
              + `这次 ${name} 想写成的样子——它在这中间被别人改过`
              + `（上次尝试 call ${pySlice(pyStr(dictGet(_prev, "call_id", "")), 0, 8)}，`
              + `状态 ${dictGet(_prev, "status")}）。直接写会覆盖掉那个改动。\n`
              + `请先读一遍这个文件，确认要保留什么，再决定怎么写。`
            );
          }
          DISPATCH_SEAMS.unregister_output_sink(call_id);
          await this._emit_tool_result(name, call_id, args, context,
            { ok: false, value: null, error: msg, status: "skipped" });
          return {
            content: msg,
            trace: { tool: name, call_id: call_id, status: `effect_${_rec["status"]}`, target: _effect["target"] },
            halt: false,
          };
        }
      }
    }
    // Only CRITICAL is intercepted, and only across a process boundary. A
    // resumed goal re-issuing a force-push that already succeeded before the
    // crash is the case this exists for; anything below critical stays
    // advisory (the resume prompt lists it) because blocking a legitimate
    // repeat is worse than doing an idempotent write twice.
    if (pyTruth(_args_hash) && dictGet(context, "risk_level") === "critical") {
      let _landed: any = null;
      try {
        _landed = this.storage.find_landed_side_effect(
          pyStr(pyOr(dictGet(context, "goal_id"), "")), name, _args_hash);
      } catch {
        // BUG(port): 源的 `except Exception: log`。
        DISPATCH_SEAMS.log_line("ERROR", _LOGGER_NAME, "replay lookup failed");
      }
      if (pyTruth(_landed)) {
        const msg = (
          `这次调用被拦下了：同一目标下、参数完全相同的 ${name} `
          + `在上一个进程里已经成功执行过（call `
          + `${pySlice(pyStr(dictGet(_landed, "call_id", "")), 0, 8)}），没有重新执行。\n`
          + `上次结果：${pyStr(pyOr(dictGet(_landed, "result_preview", ""), "（无预览）"))}\n`
          + `如果确实需要再做一次，请改变参数或先确认当前状态，不要原样重试。`
        );
        // 尚未注册也安全，保持清理对称
        DISPATCH_SEAMS.unregister_output_sink(call_id);
        await this._emit_tool_result(name, call_id, args, context,
          { ok: false, value: null, error: msg, status: "skipped" });
        return {
          content: msg,
          trace: { tool: name, call_id: call_id, status: "already_landed" },
          halt: false,
        };
      }
    }

    // Live output plumbing. The tool impl is a SYNC function running in a
    // worker thread (see ToolRegistry.dispatch), so it cannot touch the event
    // loop; it hands lines to this sink, which marshals them across.
    // DIVERGENCE(port): there is no worker thread and no second loop here, so
    // the marshalling collapses into a direct call (see header note 6).
    const pending: string[] = [];
    let last_flush = DISPATCH_SEAMS.now();

    const _flush_output = (): void => {
      if (!pyTruth(pending)) {
        return;
      }
      const chunk = pending.join("");
      pending.length = 0;
      last_flush = DISPATCH_SEAMS.now();
      try {
        void this.bus.emit("tool_output", {
          tool_name: name, call_id: call_id, chunk: chunk, session_id: this.session_id,
        });
      } catch {
        // BUG(port): 源的 `except Exception: pass` —— loop closing mid-command,
        // losing a chunk beats crashing.
      }
    };

    const _sink = (line: string): void => {
      pending.push(line);
      let size = 0;
      for (const p of pending) size += pyLen(p);
      const due = (DISPATCH_SEAMS.now() - last_flush) > 0.08;
      if (size >= 2048 || due) {
        _flush_output();
      }
    };

    DISPATCH_SEAMS.register_output_sink(call_id, _sink);
    // From here until the `finally` below, this call is killable by
    // `cancel_hard()` — Pause needs a handle on the child command, not just
    // on the coroutine awaiting it.
    this._live_calls[call_id] = name;
    // Analytics: track tool calls for the context window popover.
    try {
      const mod = DISPATCH_SEAMS.tokenAnalyticsModule();
      mod.get_token_analytics().on_tool_call(name);
    } catch {
      // BUG(port): 源的 `except Exception: pass` —— fail-open，可选增强。
    }

    const t0_dispatch = DISPATCH_SEAMS.now();
    try {
      const mod = DISPATCH_SEAMS.agentLoggerModule();
      const _p = pyAttr(this, "permission");
      mod.log_tool_dispatch(
        name,
        args,
        call_id,
        pyStr(pyGetAttrOfObj(_p, "value", pyStr(_p))),
        pyTruth(dictGet(call_ctx, "confirmed")),
        pyStr(dictGet(call_ctx, "sandbox_mode", "")),
      );
    } catch {
      // BUG(port): 源的 `except Exception: pass` —— fail-open，可选增强。
    }

    // Register the attempt now, with the args as they will actually be used —
    // pre-hooks may have rewritten them above, and hashing the pre-rewrite
    // version would make two identical effective calls look different.
    const _loop_slot = this.loop_detector.record(name, args);
    // Phase 2: side-effect ledger. Write-class calls (risk >= medium) are
    // recorded as PENDING before dispatch and settled after, so a goal
    // resumed after a crash can be told what already landed instead of
    // redoing it. Pure mirror — a ledger failure must never block the tool.
    // `_ledger` / `_args_hash` were decided above, next to the replay guard
    // that reads the same hash.
    if (_ledger && pyTruth(_args_hash)) {
      try {
        this.storage.record_side_effect(
          this.session_id, pyStr(pyOr(dictGet(context, "goal_id"), "")),
          call_id, name, _args_hash,
          {
            effect_kind: pyStr(pyOr(dictGet(_effect, "kind"), "")),
            target: pyStr(pyOr(dictGet(_effect, "target"), "")),
            operation_id: _op_id,
            pre_hash: _pre_hash,
            planned_hash: _planned_hash,
          },
        );
      } catch {
        // BUG(port): 源的 `except Exception: log` —— 账本坏了不拦执行。
        DISPATCH_SEAMS.log_line("ERROR", _LOGGER_NAME, "side-effect ledger record failed");
      }
    }
    let result: any;
    try {
      result = await this.tools.dispatch(name, args, call_ctx);
    } catch (exc) {
      if (!isCancelledError(exc)) {
        throw exc;
      }
      // B5: OnAbort — the call was stopped mid-flight. Record a terminal
      // state (otherwise the tool_use has no matching tool_result and the
      // transcript is invalid) plus whatever recovery notes hooks provide.
      if (_ledger) {
        try {
          // NOT ok=False: the call was already dispatched, so its
          // effect may well have landed. `failed` would tell a
          // resumed run "safe to redo" — for a write-class tool that
          // is how you get the same write twice. `unknown` is the
          // honest state and forces a check before redoing.
          this.storage.settle_side_effect(call_id, false, "aborted mid-flight", "unknown");
        } catch (_e) {
          // 中断结算失败会留下 pending——pending 本身是诚实状态，
          // 但结算通道坏了必须让人知道
          DISPATCH_SEAMS.print_(`[side_effects] abort-settle FAILED for ${call_id}: ${excStr(_e)}`);
        }
      }
      const aborted = hooks.run_abort(name, args, context);
      const notes = pyIter(dictGet(aborted, "notes")).map((x) => pyStr(x)).join("；");
      const msg = "这一步被中断了。" + (pyTruth(notes) ? notes : "工具可能只跑了一半，下一步前请先确认状态。");
      try {
        await this._emit_tool_result(name, call_id, args, context,
          { ok: false, value: null, error: msg, status: "failed" });
      } catch {
        // BUG(port): 源的 `except Exception: pass` —— 结算帧发不出去也不能
        // 把中断本身变成一个新的异常。
      }
      return {
        content: msg,
        trace: {
          tool: name,
          call_id: call_id,
          args: args,
          status: "failed",
          error: msg,
          interrupted: true,
        },
        halt: false,
      };
    } finally {
      // Push whatever is still buffered, THEN stop listening. Reversing
      // these two loses the tail of the output, which is usually the part
      // that says why the command failed.
      _flush_output();
      DISPATCH_SEAMS.unregister_output_sink(call_id);
      delete this._live_calls[call_id];
    }
    if (_ledger) {
      try {
        // A killed or timed-out subprocess reports effect_status=
        // "unknown" through its Result meta: the child is dead, so
        // "failed" would read as safe-to-redo for a write that may
        // well have landed. Same honesty rule as the abort branch.
        const _meta = pyOr(pyGetAttr(result, "meta", null), {}) as Record<string, any>;
        const _forced = (!pyTruth(pyGetAttr(result, "ok", true))
          && pyStr(pyOr(dictGet(_meta, "effect_status"), "")) === "unknown")
          ? "unknown" : "";
        // Observe the target now. This is what makes the ledger evidence
        // rather than testimony: a later reconcile compares the world
        // against this hash instead of believing "the tool said ok".
        let _post_hash = "";
        if (pyTruth(_effect)) {
          try {
            _post_hash = DISPATCH_SEAMS.effectsModule().snapshot_hash(name, args, _effect);
          } catch {
            // BUG(port): 源的 `except Exception: log`。
            DISPATCH_SEAMS.log_line("ERROR", _LOGGER_NAME, "postcondition observe failed");
          }
        }
        this.storage.settle_side_effect(
          call_id,
          pyTruth(pyGetAttr(result, "ok", true)),
          pyStr(pyOr(pyGetAttr(result, "value", ""), pyGetAttr(result, "error", ""))),
          _forced,
          _post_hash,
        );
      } catch {
        // BUG(port): 源的 `except Exception: log`。
        DISPATCH_SEAMS.log_line("ERROR", _LOGGER_NAME, "side-effect ledger settle failed");
      }
    }

    try {
      const mod = DISPATCH_SEAMS.agentLoggerModule();
      const _ok_log = pyTruth(pyGetAttr(result, "ok", true));
      mod.log_tool_result(
        name,
        call_id,
        _ok_log,
        _ok_log ? "completed" : "failed",
        (DISPATCH_SEAMS.now() - t0_dispatch) * 1000,
        pyOr(pyStr(pyGetAttr(result, "value", "")), ""),
        _ok_log ? undefined : pyStr(pyGetAttr(result, "error", "")),
      );
    } catch {
      // BUG(port): 源的 `except Exception: pass` —— fail-open，可选增强。
    }

    // Mutation Invalidation: ensure file/git mutations immediately invalidate snapshot cache
    if (pyTruth(pyGetAttr(result, "ok", true))) {
      if (MUTATING_WORKSPACE_TOOLS.has(name)
        || ["write", "edit", "patch", "command", "shell", "git", "delete", "move", "rename"]
          .some((k) => name.includes(k))) {
        try {
          DISPATCH_SEAMS.invalidate_snapshot(this.workspace);
        } catch {
          // BUG(port): 源的 `except Exception: pass`。
        }
      }
    }

    // B5: Post-hooks run on the result text BEFORE it enters the context, so
    // a leaked credential never makes it into the transcript (and therefore
    // never gets replayed to the provider on later turns).
    // BUG(port): 源为 `self._tool_output_for_llm(result)`，而该函数没有
    // `@staticmethod` —— python 的隐式 self 让 `tool_result` 收到的是 Router 本身
    // （此行如实抛 AttributeError）。TS 没有隐式 self，故按等价形式
    // `f(self, result)` 显式传 `this`。见 `_tool_output_for_llm` 的注释与 repro。
    let content = this._tool_output_for_llm(this, result);
    const post = hooks.run_post(name, content, context);
    content = pyStr(dictGet(post, "content"));

    // Close the loop on this attempt. The result hash is what separates "the
    // model keeps retrying and nothing changes" from "the model is polling
    // something that is legitimately still moving" — without it, a detector can
    // only see repetition, not the absence of progress.
    this.loop_detector.observe(_loop_slot, content);
    if (!pyTruth(pyGetAttr(result, "ok", true))) {
      try {
        const eb = DISPATCH_SEAMS.evolutionBridgeModule();
        await eb.notify_tool_failure(
          this.session_id,
          `turn_${this._turn_seq}`,
          name,
          pyStr(pyOr(pyGetAttr(result, "error", ""), content)),
        );
      } catch {
        // BUG(port): 源的 `except Exception: pass`。
      }
    }
    if (_loop_verdict.level === "warning") {
      // Warning rides along with the real result rather than replacing it: the
      // call was allowed and its output is still what the model asked for. The
      // nudge is appended so the model reads both — the answer, and the fact
      // that it has now asked the same thing several times.
      content = `${content}\n\n[loop-detector] ${_loop_verdict.message}`;
    }

    // 六·UC1：`tool_search` 命中的工具进入本轮视图。放在这里而不是工具内部，
    // 是因为视图是 router 的状态 —— 工具只负责回答「有什么」，要不要让它可见
    // 由 router 决定，而且名字会拿全量注册表再核一遍。
    if (this._absorb_revealed(result)) {
      this._catalogue_dirty = true;
    }

    // A halts_turn tool (ask_user) parks a question. Big-company shape (a `waiting`
    // status, a still-open tool call): the answer comes back as THIS
    // call's tool result, in the SAME turn, not as a new user message. So we
    // emit the card, then suspend the turn on a waiter for the answer.
    //
    // Only on success: a failed ask_user (bad args) feeds the error straight
    // back so the model fixes the call this same turn.
    const tool_def = this.tools.get(name);
    if (pyTruth(tool_def) && pyTruth(tool_def.halts_turn) && pyTruth(result.ok)) {
      await this._emit_tool_result(
        name, call_id, args, context,
        { ok: true, value: result.value, error: null, status: "needs_input", meta: result.meta },
      );
      const answer = await this._await_ask_answer(call_id);
      if (answer !== null && answer !== undefined) {
        // Answered in place → settle the card and hand the answer back as
        // this call's result. Turn CONTINUES; the model reads it and goes on.
        await this._emit_tool_result(
          name, call_id, args, context,
          { ok: true, value: answer, error: null, status: "completed", meta: { ask_answered: true } },
        );
        return {
          content: answer,
          trace: { tool: name, call_id: call_id, status: "answered" },
          halt: false,
        };
      }
      // No in-place answer (connection dropped, or the wait timed out). Fall
      // back to ending the turn: the ledger entry + card survive, and the
      // answer will arrive as a fresh turn via the persistent path.
      return {
        content: content,
        trace: { tool: name, call_id: call_id, status: "needs_input" },
        halt: true,
      };
    }

    // Authoritative reversibility, decided now that we know what the snapshot
    // actually stored — not from the tool-name table the pre-call badge used.
    // Rides in `meta` because that is the existing channel for per-call facts
    // (exit_code, ask_*), so the card gets corrected on the same frame that
    // settles it.
    const settle_meta: Record<string, any> = { ...(pyOr(result.meta, {}) as Record<string, any>) };
    // 执行决定随结算帧下发——UI/审计看"这次是怎么被放行的"不必重新推导，
    // 与关键词路径 `_execute` 的 result.meta 同形状。（plan 必已定义：
    // 未定义的路径都在上面提前返回了。）
    settle_meta["execution_mode"] = plan.mode;
    settle_meta["os_confinement"] = plan.os_confinement;
    try {
      const mod = DISPATCH_SEAMS.snapshotStoreModule();
      settle_meta["reversible"] = mod.reversible_after_capture(name, snapshot_report);
    } catch {
      // BUG(port): 源的 `except Exception: pass` —— fail-open，可选增强。
    }
    if (snapshot_report !== null && snapshot_report !== undefined) {
      settle_meta["snapshot"] = {
        seq: dictGet(snapshot_report, "seq"),
        captured: pyLen(pyOr(dictGet(snapshot_report, "captured"), [])),
        skipped: pyOr(dictGet(snapshot_report, "skipped"), []),
        failed: pyOr(dictGet(snapshot_report, "failed"), []),
      };
    }

    // ToolOutputSpill: 拦截超长工具输出（>16,000 字符），安全转储至磁盘并生成有界预览
    try {
      const mod = DISPATCH_SEAMS.toolOutputSpillModule();
      const spill_res = mod.get_spill_manager().process_output(
        content, name, this.session_id, this.effective_workspace,
      );
      if (pyTruth(spill_res.is_spilled)) {
        content = pyStr(spill_res.content);
        settle_meta["spill"] = {
          spill_id: spill_res.spill_id,
          spill_path: spill_res.spill_path,
          total_chars: spill_res.total_chars,
          total_lines: spill_res.total_lines,
        };
      }
    } catch {
      // BUG(port): 源的 `except Exception: pass`。
    }

    // RepeatToolGuard: 记录本次工具调用指纹
    if (pyHasAttr(this, "repeat_tool_guard") && pyTruth(this.repeat_tool_guard)) {
      try {
        this.repeat_tool_guard.record_call(
          name, args, pyTruth(result.ok), content,
        );
      } catch {
        // BUG(port): 源的 `except Exception: pass`。
      }
    }

    // Shadow workspace: validate staged overlay after file mutations.
    const _FILE_MUTATORS = new Set([
      "write_file", "edit_file", "apply_patch", "delete_file", "move_file", "copy_file",
    ]);
    if (pyTruth(result.ok) && _FILE_MUTATORS.has(name) && pyTruth(dictGet(context, "shadow_staged"))) {
      try {
        const mod = DISPATCH_SEAMS.shadowWorkspaceModule();
        await mod.validate_and_emit(this.bus, this.session_id, this.workspace, context);
      } catch {
        // BUG(port): 源的 `except Exception: pass`。
      }
    }

    await this._emit_tool_result(
      name, call_id, args, context,
      {
        ok: result.ok, value: result.value, error: result.error,
        status: pyTruth(result.ok) ? "completed" : "failed",
        meta: settle_meta,
      },
    );

    const trace_row: Record<string, any> = {
      tool: name,
      call_id: call_id,
      args: args,
      status: pyTruth(result.ok) ? "ok" : "error",
      preview: pySlice(content, 0, 200),
      timestamp: t0_dispatch,
      completedAt: DISPATCH_SEAMS.now(),
    };
    if (pyTruth(dictGet(post, "redactions"))) {
      // Surface redaction in the audit trail so the user can see that the
      // output was touched and why.
      trace_row["redactions"] = dictGet(post, "redactions");
      trace_row["hook_trail"] = dictGet(post, "trail");
    }

    if (pyTruth(result.ok)) {
      try {
        const mod = DISPATCH_SEAMS.workflowRecorderModule();
        const _w_rec = mod.get_workflow_recorder();
        if (_w_rec.is_recording() && !["workflow_record_start", "workflow_record_stop", "workflow_replay", "workflow_list"].includes(name)) {
          const _m_raw = pyGetAttr(result, "meta", {});
          const _meta2 = isDict(_m_raw) ? (_m_raw as Record<string, any>) : {};
          _w_rec.record_step(
            name,
            args,
            dictGet(_meta2, "ocr_hash") as any,
            dictGet(_meta2, "target") as any,
          );
        }
      } catch {
        // BUG(port): 源的 `except Exception: pass`。
      }
    }

    return { content: content, trace: trace_row, halt: false };
  }

  /**
   * Suspend the turn until the user answers this ``ask_user`` card.
   *
   * Returns the rendered answer text (to become the tool result), or None to
   * fall back to ending the turn — which happens on a real stop (cancelled),
   * a dropped connection, or the long safety timeout. The card and the ledger
   * entry outlive this either way, so a fallback loses nothing but the
   * in-place continuation.
   *
   * The waiter is registered BEFORE we start awaiting and the card is already
   * on screen, so a fast click can't slip through the gap: if the answer beats
   * the await it just resolves the future immediately.
   */
  async _await_ask_answer(call_id: string): Promise<string | null> {
    const fut = DISPATCH_SEAMS.register_waiter(call_id);
    let payload: Record<string, unknown>;
    try {
      payload = (await wait_for_ask(fut, DISPATCH_SEAMS.ask_wait_timeout())) as unknown as Record<string, unknown>;
    } catch (e) {
      if (isCancelledError(e)) {
        // Real stop / socket teardown. Let it propagate so the turn actually
        // stops, but don't leave a dangling waiter behind.
        DISPATCH_SEAMS.drop_waiter(call_id);
        throw e;
      }
      // 超时，或 future 已被别处消解（TimeoutError / RuntimeError）。两种都退回持久路径。
      // DIVERGENCE(port): 其他异常照常向上抛，与源里 except 元组只抓这两种一致。
      DISPATCH_SEAMS.drop_waiter(call_id);
      return null;
    }
    // Render through the store so an in-place answer reads identically to one
    // that came via the persistent path, and the ledger entry is consumed.
    // 源的 `resolve(...)` 是关键字调用（call_id= / answers= / skipped=），
    // ask_user.ts 里是位置参数，按顺序铺开。
    let text: string | null;
    try {
      text = DISPATCH_SEAMS.get_ask_user_store().resolve(
        this.session_id, call_id, dictGet(payload, "answers"),
        pyTruth(dictGet(payload, "skipped")),
      );
    } catch {
      return null;
    }
    if (pyTruth(text)) {
      // The ledger changed, so re-publish it: another open client still has
      // this card on screen with live buttons.
      try {
        await this.bus.emit("pending_questions", {
          session_id: this.session_id,
          items: DISPATCH_SEAMS.get_ask_user_store().snapshot(this.session_id),
        });
      } catch {
        // BUG(port): 源的 `except Exception: pass` —— fail-open，可选增强。
      }
    }
    return text;
  }

  /**
   * Try to answer an ``ask_user`` call from what the conversation already says.
   *
   * Returns the tool-result text to hand back to the model, or None to let the
   * question reach the user.
   *
   * The judgement is a SEPARATE model call with its own system prompt rather
   * than a line in the main prompt, and that separation is the point: the
   * agent that just decided to ask is the worst judge of whether it needed to.
   * A fresh call with no stake in the answer, one job, and a schema it has to
   * satisfy is what makes "no" the cheap outcome.
   *
   * Fails open toward asking: no model, an error, unparseable output, or a
   * single unsupported question all end up as None.
   */
  async _auto_resolve_ask(args: Record<string, unknown>): Promise<Record<string, any> | null> {
    // 源是 `self.llm and self.llm.api_key` —— 直接取属性，不是 getattr 带默认值：
    // 一个没有 `llm`、或者没有 `api_key` 的宿主在 python 里就是 AttributeError，
    // 它会穿出这个方法、由调用点的 fail-open 接住。用 pyGetAttr(…, null) 会把这个
    // 异常吃掉，行为就变了。
    const _ar_llm = pyAttr(this, "llm");
    if (!(pyTruth(_ar_llm) && pyTruth(pyAttr(_ar_llm, "api_key")))) {
      return null;
    }
    const [_qs, _err] = DISPATCH_SEAMS.normalize_questions(dictGet(args, "questions"));
    const questions = _qs;
    if (pyTruth(_err) || !pyTruth(questions)) {
      return null; // let the tool report the validation error properly
    }

    const header = pyStrip(pyStr(pyOr(dictGet(args, "header"), "")));
    let r: any;
    try {
      // 源的 `_build_history(limit=12)` 是关键字；loop.ts 落地后是位置参数。
      const messages = this._build_history(12);
      messages.push({
        role: "user",
        content: DISPATCH_SEAMS.build_auto_resolve_user_prompt(header, questions),
      });
      // Cheapest model that clears the bar (UD1), not the conversation
      // model: this is a schema-constrained lookup in history the user can
      // see and override on the card, not part of the reasoning the model
      // was picked for. Degrades to `self.llm` when routing finds nothing.
      const scene = pyAttr(DISPATCH_SEAMS.modelRegistryModule(), "SCENE_AUTO_RESOLVE");
      // 源的 `chat(messages, system=...)`：llm_client.ts:302 是位置参数，
      // max_tokens / temperature 留空。
      r = await this.llm.bind_scene(scene).chat(messages, null, null, AUTO_RESOLVE_SYSTEM);
    } catch {
      return null;
    }
    if (!pyTruth(r.ok)) {
      return null;
    }
    const verdict = DISPATCH_SEAMS.parse_auto_resolution(
      pyStr(pyOr(dictGet(r.value, "content"), "")), questions,
    );
    if (verdict === null || verdict === undefined) {
      return null;
    }

    // Reuse the same renderer the click path uses, so the model reads an
    // identical shape whether the human answered or we did.
    const pending = DISPATCH_SEAMS.new_pending_question("", this.session_id, header, questions);
    const answer = DISPATCH_SEAMS.render_answer(pending, dictGet(verdict, "answers"));
    return { content: (
      `${answer}\n\n`
      + "[系统] 以上答案是根据当前对话已经确定的信息自动判定的，没有打断用户。"
      + `判定依据：\n${dictGet(verdict, "reason")}\n`
      + "按这个答案继续做。如果你认为依据不成立，就说出来，不要重复提问。"
    ) };
  }

  /**
   * Emit ``tool_result`` for every terminal outcome of a tool call.
   *
   * Denials and unknown tools go through here too so subscribers (memory
   * extraction, the WebSocket bridge) see a settled state for every card
   * they were told about via ``pre_tool_use``.
   *
   * ``meta`` carries whatever the tool attached to its ``Result`` — for
   * shell that is ``exit_code`` / ``timed_out``. The terminal card needs the
   * real exit code: scraping it out of the text only works when the message
   * happens to spell it out, and "退出码 0" vs "退出码 1" is the difference
   * between a green and a red card.
   *
   * DIVERGENCE(port): 源的 `*` 之后的关键字参数在 TS 里收成一个选项对象。
   */
  async _emit_tool_result(
    name: string, call_id: string, args: Record<string, unknown>, context: Record<string, unknown>,
    opts: { ok: unknown; value: unknown; error: unknown; status: string; meta?: unknown },
  ): Promise<void> {
    await this.bus.emit("tool_result", {
      tool_name: name,
      call_id: call_id,
      args: args,
      status: opts.status,
      result: { ok: opts.ok, value: opts.value, error: opts.error },
      meta: pyOr(opts.meta, {}),
      context: context,
      session_id: this.session_id,
    });
  }

  /** Step 1: Recognize intent and identify primary tool. */
  _recognize_intent(message: string): Record<string, any> {
    let cleaned_msg = pyStrip(pyStr(pyOr(message, "")));
    if (pyIn("[系统]", cleaned_msg)) {
      cleaned_msg = pyStrip(cleaned_msg.split("[系统]")[0] ?? "");
    }
    const msg_lower = pyLower(cleaned_msg);
    const any_w = (words: string[]): boolean => words.some((w) => pyIn(w, msg_lower));
    if (!pyTruth(msg_lower)) {
      return { agent: null, primary_tool: null, args: {} };
    }

    // Explicit confirmation / conversational approval words should NOT route to arbitrary commands
    if (pyIn(msg_lower, [
      "同意", "approve", "yes", "y", "允许", "确认", "确定", "好", "好的", "ok",
      "继续", "收到", "不用了", "拒绝", "deny", "no", "n",
    ])) {
      return { agent: null, primary_tool: null, args: {} };
    }

    // Keyword-based intent recognition
    if (any_w(["搜索", "search", "查找", "find", "grep"])) {
      if (any_w(["代码", "code", "文件", "file"])) {
        return { agent: "file_agent", primary_tool: "search_code", args: { pattern: cleaned_msg } };
      }
    }
    // 浏览器与网址优先识别（防止 "打开百度" / "打开网址" 被通配的 "打开" 截胡到 read_text）
    const is_web_nav = any_w(["http://", "https://", "www.", ".com", ".cn", ".org", ".net"])
      || any_w(["浏览器", "browser", "网页", "网站", "web", "site", "百度", "谷歌", "google", "bing"]);
    if (is_web_nav && any_w(["打开", "open", "浏览", "访问", "查看", "进入", "跳转", "navigate"])) {
      let target = pyStrip(cleaned_msg);
      for (const prefix of ["打开", "open", "浏览", "访问", "查看", "进入", "跳转", "navigate"]) {
        if (pyStartsWith(pyLower(target), prefix)) {
          // 源用 `target[len(prefix):]`——长度按码点算，中文前缀占 2 个 UTF-16 单元。
          target = pyStrip(pySlice(target, pyLen(prefix)));
          break;
        }
      }
      if (!pyStartsWith(target, "http://") && !pyStartsWith(target, "https://")) {
        if (pyIn("百度", target) || pyLower(target) === "baidu") {
          target = "https://www.baidu.com";
        } else if (pyIn("bing", pyLower(target)) || pyIn("必应", target)) {
          target = "https://www.bing.com";
        } else if (pyIn("google", pyLower(target)) || pyIn("谷歌", target)) {
          target = "https://www.google.com";
        } else if (pyIn(".", target) && !pyIn(" ", target)) {
          target = `https://${target}`;
        } else if (pyTruth(target)) {
          target = `https://www.bing.com/search?q=${target}`;
        } else {
          target = "https://www.bing.com";
        }
      }
      return { agent: "browser_agent", primary_tool: "navigate", args: { url: target } };
    }

    if (any_w(["读", "read", "打开", "open", "查看", "view"])) {
      return { agent: "file_agent", primary_tool: "read_text", args: { path: cleaned_msg } };
    }
    if (any_w(["写", "write", "创建", "create", "保存", "save"])) {
      return { agent: "file_agent", primary_tool: "write_file", args: { content: cleaned_msg } };
    }
    if (any_w(["git", "提交", "commit", "push", "pull"])) {
      return { agent: "file_agent", primary_tool: "git_status", args: {} };
    }
    if (any_w(["系统", "system", "进程", "process", "服务", "service"])) {
      return { agent: "computer_agent", primary_tool: "shell_executor", args: { command: cleaned_msg } };
    }
    if (any_w(["浏览器", "browser", "网页", "web", "网站", "site"])) {
      return { agent: "browser_agent", primary_tool: "navigate", args: { url: cleaned_msg } };
    }
    if (any_w(["应用", "app", "安装", "install", "启动", "launch"])) {
      return { agent: "app_agent", primary_tool: "operate_app", args: { action: cleaned_msg } };
    }
    if (any_w(["list", "列出", "目录", "dir", "folder"])) {
      return { agent: null, primary_tool: "list_dir", args: { path: "." } };
    }
    if (any_w(["ls", "文件"])) {
      return { agent: null, primary_tool: "list_dir", args: { path: "." } };
    }
    return { agent: null, primary_tool: null, args: {} };
  }

  /** Step 2: Determine dispatch target. */
  _determine_dispatch(intent: Record<string, unknown>, message: string,
    context: Record<string, unknown>): Record<string, any> {
    void context;
    const agent = dictGet(intent, "agent");
    const primary_tool = dictGet(intent, "primary_tool");
    const args = dictGet(intent, "args", {});

    // If no agent but primary_tool is set, do direct tool execution
    if (pyTruth(primary_tool) && !pyTruth(agent)) {
      return { type: "direct", agent: null, primary_tool: primary_tool, args: args };
    }

    if (pyTruth(agent) && pyIn(agent, AGENT_ROLES)) {
      // Check if a skill matches
      const skill_matches = this.skills.find_by_trigger(message);
      return {
        type: "agent", agent: agent,
        tools: (AGENT_ROLES[pyStr(agent)] as Record<string, any>)["tools"],
        primary_tool: primary_tool, args: args,
        skill_matches: skill_matches,
      };
    }
    // Direct tool execution
    return { type: "direct", agent: null, primary_tool: primary_tool, args: args };
  }

  /** Step 3: Execute based on dispatch decision. */
  async _execute(dispatch: Record<string, any>, context: Record<string, any>): Promise<Result> {
    // 关键词路由产出的 primary_tool 在源里就是 str|None；None 已在上面早退，
    // 这里按 str 使用（args/kwargs 传给总线与工具时保持原值）。
    const tool_name = dictGet(dispatch, "primary_tool") as string;
    if (!pyTruth(tool_name)) {
      return Result.success("No action determined. Please clarify your request.");
    }

    // Sub-agent capability boundary on the keyword path too. The LLM
    // dispatch path enforces `allowed_tools` before anything runs; skipping
    // it here would make which tools a sub-agent may call depend on whether
    // an API key happens to be configured.
    if (this.allowed_tools !== null && this.allowed_tools !== undefined
      && !pyIn(tool_name, this.allowed_tools)) {
      return Result.failure(
        `[team] tool '${tool_name}' not in role allowlist `
        + `(${pyStr(pyOr(pySortedStr(pyIter(this.allowed_tools).map((x) => String(x))).join(", "), "(none)"))})`,
      );
    }

    const args = dictGet(dispatch, "args", {}) as Record<string, unknown>;
    // Phase 8: execution-mode selection (§7.4). Computed BEFORE the policy
    // gate so the chosen mode rides along in the audit payload, but the
    // refused verdict is enforced AFTER it: for CRITICAL tools the policy
    // layer asks first, and the resulting approval grant IS the explicit
    // human confirmation §7.4 requires — refusing before that ask would
    // make R4 unreachable instead of merely gated.
    //
    // worktree_available is False on purpose: the main-router dispatch path
    // has no worktree-copy mechanism (that lives in subagent_runtime), and
    // claiming isolation that never happens is how the "reversible" badge
    // became a lie once already. R2 therefore runs in-workspace with the
    // Git diff + validator + rollback backstop, as the plan reason says.
    let plan: any;
    try {
      plan = DISPATCH_SEAMS.select_execution(
        DISPATCH_SEAMS.risk_to_rlevel(pyStr(pyOr(dictGet(context, "risk_level"), ""))),
        {
          worktree_available: false,
          high_risk_confirmed: pyTruth(dictGet(context, "confirmed"))
            ? true : Boolean(this.risk.has_grant(tool_name, args, context)),
        },
      );
    } catch (_e) {
      // 模式选择崩溃绝不能默认放行——fail-closed 并响亮打印（§3 纪律）。
      DISPATCH_SEAMS.print_(`[execution] select_execution FAILED, refusing: ${excStr(_e)}`);
      return Result.failure("[execution] 执行模式选择失败，已按最坏情况拒绝执行。");
    }
    // `A or B` 只在 A 为假时求值 B：带着 call_id 的调用点不能顺手烧掉一次时钟。
    // （其余 `or`/`getattr` 处按头注 §2 保留急求值，因为那里的默认值不产生副作用。）
    const _cid_given = dictGet(context, "call_id");
    const call_id = pyTruth(_cid_given)
      ? pyStr(_cid_given)
      : pyStr(`${tool_name}-${String(Math.trunc(DISPATCH_SEAMS.now() * 1000))}`);
    context["call_id"] = call_id;
    // 执行模式决定必须落在 context 上：它是下游审计/回放引用这次
    // 放行或拒绝的唯一凭据。之前只在少数分支写（如 call_ctx），
    // 拒绝分支干脆没写——被拒的那次执行在记录里查不到原因。
    context["execution_mode"] = plan.mode;
    // Emit pre_tool_use event (risk control checks here)
    const event = await this.bus.emit("pre_tool_use", {
      tool_name: tool_name, args: args, context: context,
      call_id: call_id,
      execution_mode: plan.mode, execution_plan: plan.reason,
    });
    const action = enumValue(event.action);
    if (action === "block") {
      return Result.failure(`Blocked: ${event.blockReason}`);
    }
    if (action === "ask") {
      const msg = pyStr(pyOr(event.blockReason, (
        "接下来这一步会改动你的电脑状态。"
        + "回复「同意」我就继续；不想做的话直接告诉我换个做法。"
      )));
      this.risk.record_pending(call_id, tool_name, args, msg, this.session_id);
      const mod = DISPATCH_SEAMS.confirmMetaModule();
      const confirm_meta: Record<string, any> = mod.build_confirm_meta(
        tool_name, args, { block_reason: pyStr(pyOr(event.blockReason, "")), context: context },
      );
      await this._emit_tool_result(
        tool_name, call_id, args, context,
        {
          ok: false, value: null, error: msg, status: "needs_confirmation",
          meta: { needs_confirmation: true, ...confirm_meta },
        },
      );
      const res = Result.success("");
      // DIVERGENCE(port): result.ts 的 `meta` 是 readonly，源的 `res.meta = {...}`
      // 整包替换在此走一次强转，值本身不变。
      (res as unknown as { meta: Record<string, any> }).meta = {
        needs_confirmation: true, turn_outcome: "incomplete", ...confirm_meta,
      };
      return res;
    }
    if (plan.mode === MODE_REFUSED) {
      // Policy allowed it but §7.4 did not: R4 without explicit human
      // confirmation is refused no matter what the permission mode says.
      return Result.failure(`[execution] ${plan.reason}`);
    }
    if (plan.mode === MODE_DANGER_FULL) {
      // §7.4: the bypass mode must leave a loud audit mark on the record.
      DISPATCH_SEAMS.print_(`[execution] DANGER-FULL-ACCESS granted for ${tool_name} `
        + `(session=${this.session_id})`);
    }
    // Skill lifecycle (learning loop). find_by_trigger results used to be
    // computed in _determine_dispatch and then dropped on the floor: skills
    // were "discovered" every turn but never used, never measured. A match
    // that survives the risk gate is now a REAL use — its body rides along
    // with the reply, and the outcome lands in the experience ledger (0003).
    let _skill_used: Record<string, any> | null = null;
    const _skill_t0 = DISPATCH_SEAMS.now();
    try {
      const _matches = pyOr(dictGet(dispatch, "skill_matches"), []);
      if (pyTruth(_matches)) {
        const _first = pyIter(_matches)[0] as Record<string, unknown>;
        const _entry = this.skills.get_skill(pyStr(pyOr(dictGet(_first, "name"), "")));
        if (_entry !== null && _entry !== undefined) {
          _skill_used = {
            name: _entry.name,
            version: pyStr(pyOr(pyGetAttr(_entry, "version", ""), "")),
            score: pyInt(pyOr(dictGet(_first, "match_score"), 0)),
            body: "",
          };
          try {
            const _loaded = this.skills.load_skill_body(_entry.name);
            if (pyTruth(pyGetAttr(_loaded, "ok", false))) {
              const _val = pyGetAttr(_loaded, "value", null);
              // load_skill_body 的真实契约是 {body, frontmatter, path}
              // 字典——取正文本身，别把整个字典 repr 进回复。
              _skill_used["body"] = isDict(_val)
                ? pyStr(pyOr(dictGet(_val as Record<string, unknown>, "body"), ""))
                : pyStr(pyOr(_val, ""));
            }
          } catch {
            // BUG(port): 源的 `except Exception: pass` —— fail-open，可选增强。
          }
          this._trace_skill("skill.started", _skill_used, context,
            `trigger_match(score=${_skill_used["score"]})`);
        }
      }
    } catch (_e) {
      DISPATCH_SEAMS.print_(`[skills] lifecycle setup failed: ${excStr(_e)}`);
    }

    // Check if tool exists in registry
    const tool = this.tools.get(tool_name);
    let result: Result;
    if (tool) {
      result = await this.tools.dispatch(tool_name, args, context);
    } else {
      // Tool not in registry - would dispatch to sub-agent
      result = Result.success(
        `[${pyStr(dictGet(dispatch, "agent"))}] Would execute: ${tool_name} with ${pyStr(args)}`,
      );
    }

    // The execution decision travels with the result so UI/audit can show
    // "how was this allowed to run" without re-deriving it.
    if (isDict(result.meta)) {
      const _m = result.meta as Record<string, any>;
      _m["execution_mode"] = plan.mode;
      _m["os_confinement"] = plan.os_confinement;
    }

    if (pyTruth(pyGetAttr(result, "ok", true))) {
      if (MUTATING_WORKSPACE_TOOLS.has(pyStr(tool_name))
        || ["write", "edit", "patch", "command", "shell", "git", "delete", "move", "rename"]
          .some((k) => pyIn(k, tool_name))) {
        try {
          DISPATCH_SEAMS.invalidate_snapshot(this.workspace);
        } catch {
          // BUG(port): 源的 `except Exception: pass` —— fail-open，可选增强。
        }
      }
    }

    if (_skill_used !== null) {
      const _ok = pyTruth(pyGetAttr(result, "ok", false));
      try {
        this._trace_skill(_ok ? "skill.completed" : "skill.failed", _skill_used, context);
        const _exp_id = this.storage.record_skill_experience(_skill_used["name"], {
          skill_version: _skill_used["version"],
          goal_id: pyStr(pyOr(dictGet(context, "goal_id"), "")),
          run_id: pyStr(pyOr(dictGet(context, "run_id"), "")),
          session_id: this.session_id,
          selection_reason: `trigger_match(score=${_skill_used["score"]})`,
          preconditions_met: Boolean(tool),
          steps_attempted: 1,
          steps_succeeded: _ok ? 1 : 0,
          outcome: _ok ? "success" : "failure",
          failure_class: _ok ? "" : pySlice(pyStr(pyOr(pyGetAttr(result, "error", ""), "")), 0, 200),
          latency_ms: (DISPATCH_SEAMS.now() - _skill_t0) * 1000,
        });
        if (isDict(result.meta)) {
          (result.meta as Record<string, any>)["skill_experience_id"] = _exp_id;
        }
        // run USES skill：有 run 归因时把使用关系落到关系图（Step D 补全）。
        const _run_ref = pyStr(pyOr(dictGet(context, "run_id"), ""));
        if (pyTruth(_run_ref)) {
          try {
            this.storage.add_relation(
              "run", _run_ref, "USES", "skill", _skill_used["name"],
              `exp:${_exp_id}`,
            );
          } catch (_e) {
            DISPATCH_SEAMS.print_(`[skills] USES edge failed: ${excStr(_e)}`);
          }
        }
      } catch (_e) {
        DISPATCH_SEAMS.print_(`[skills] record experience failed: ${excStr(_e)}`);
      }
      const _guide = pyStrip(pyStr(pyOr(_skill_used["body"], "")));
      if (_ok && pyTruth(_guide)) {
        // This IS the use of the skill: its guidance travels with
        // the reply instead of dying inside the discovery list.
        (result as unknown as { value: unknown }).value = (
          `${pyStr(result.value)}\n\n[Skill guidance — ${_skill_used["name"]}`
          + ` v ${pySlice(pyStr(_skill_used["version"]), 0, 8)}]\n${pySlice(_guide, 0, 2000)}`
          + (pyLen(_guide) > 2000 ? "\n…[truncated]" : "")
        );
      }
    }
    // Reflexion (NeurIPS 2023): 如果工具执行失败，自动提炼反思并存入情景记忆
    if (!pyTruth(pyGetAttr(result, "ok", true))) {
      try {
        const mod = DISPATCH_SEAMS.reflectionEngineModule();
        const _ref_gen = mod.get_reflection_generator();
        const _ref = await _ref_gen.generate_from_tool_failure(
          tool_name, args,
          pyStr(pyOr(pyGetAttr(result, "error", ""), "")),
          "", this.session_id,
        );
        mod.get_reflection_store().save_reflection(_ref);
      } catch {
        // BUG(port): 源的 `except Exception: pass` —— fail-open，可选增强。
      }
    }

    // P0 fix (audit §10): emit tool_result AFTER execution.
    // This is the trigger source for memory_layer's debounced extraction.
    await this.bus.emit("tool_result", {
      tool_name: tool_name,
      args: args,
      result: { ok: result.ok, value: result.value, error: result.error },
      context: context,
      session_id: this.session_id,
    });
    return result;
  }

  /**
   * Skill lifecycle event into the canonical ledger via TraceGateway.
   *
   * Observational importance: the mirror must never break the user's
   * action; a lost mirror logs loudly and moves on.
   */
  _trace_skill(event_type: string, skill: Record<string, any>, context: Record<string, any>,
    selection: string | null = null): void {
    const payload: Record<string, any> = {
      skill_id: skill["name"], skill_version: dictGet(skill, "version", ""),
    };
    if (pyTruth(selection)) {
      payload["selection_reason"] = selection;
    }
    const _gid = pyStr(pyOr(dictGet(context, "goal_id"), ""));
    try {
      this.storage.trace_event({
        session_id: this.session_id,
        event_type: event_type,
        payload: payload,
        importance: "observational",
        goal_id: pyTruth(_gid) ? _gid : null,
      });
    } catch (_e) {
      DISPATCH_SEAMS.print_(`[skills] trace ${event_type} failed: ${excStr(_e)}`);
    }
  }

  /**
   * Generate the natural-language reply for this turn.
   *
   * Keyword routing only fires on explicit tool phrasings ("git status",
   * "read README.md"). Everything else — greetings, questions, explanations,
   * follow-ups — needs the model. When a tool did run, its output is handed
   * to the model so the reply can incorporate it instead of dumping raw text.
   *
   * Returns the reply string, or None when the LLM is unavailable/misconfigured
   * so the caller can keep the raw tool result.
   *
   * DIVERGENCE(port): `llm_client.ts:302` 的 `chat()` 是位置参数
   * (messages, max_tokens, temperature, system, extra)，源的关键字
   * `system=` / `max_tokens=` 在此按位铺开，取值不变。
   */
  async _llm_turn(user_message: string, dispatch: Record<string, any>,
    tool_result: Result, context: Record<string, any>): Promise<string | null> {
    if (!pyTruth(pyGetAttr(this, "llm", null)) || !pyTruth(this.llm.api_key)) {
      return null;
    }

    const system_prompt = this.get_system_prompt(context) + this._skill_guidance_block(context);
    this._sync_turn_cache_prefix(system_prompt);
    try {
      this._last_turn_system_prompt_tokens = this.compactor.estimate_tokens(system_prompt);
    } catch {
      this._last_turn_system_prompt_tokens = 0;
    }
    // 源的 `_build_history(limit=20)` 是关键字，loop.ts 的签名是位置参。
    const messages = this._build_history(20);

    let tool_ctx = "";
    if (pyTruth(dictGet(dispatch, "primary_tool")) && tool_result !== null && tool_result !== undefined) {
      // BUG(port): 同上——源的隐式 self 绑定，此行在源语义里抛 AttributeError。
      const snippet = this._tool_output_for_llm(this, tool_result);
      tool_ctx = (
        `\n\n[Tool \`${pyStr(dictGet(dispatch, "primary_tool"))}\` output]\n${snippet}\n`
        + "(Use this in your reply; summarize rather than repeating it verbatim.)"
      );
    }
    messages.push({ role: "user", content: user_message + tool_ctx });

    let r = await this.llm.chat(messages, null, null, system_prompt);
    if (!pyTruth(r.ok)) {
      return null;
    }
    let text = pyStrip(pyStr(pyOr(dictGet(r.value, "content"), "")));
    if (!pyTruth(text) && dictGet(r.value, "finish_reason") === "length") {
      // Reasoning models can burn the whole budget thinking. Retry once
      // with a larger ceiling before giving up.
      r = await this.llm.chat(
        messages, pyInt(Math.min(this.llm.max_tokens * 4, 16000)), null, system_prompt,
      );
      if (pyTruth(r.ok)) {
        text = pyStrip(pyStr(pyOr(dictGet(r.value, "content"), "")));
      }
    }
    return pyTruth(text) ? text : null;
  }

  /**
   * Render a tool result compactly for inclusion in the prompt.
   *
   * Uses intelligent Head-Tail preservation with explicit line count metadata:
   * preserves initial headers as well as terminal failures/exit codes while keeping
   * prompt context compact and fast for KV caching.
   *
   * BUG(port): 源 1637 行的 `def _tool_output_for_llm(tool_result, cap=3500)` 少了
   * `@staticmethod`（同文件的姊妹函数 `_outcome_ok` 有），而两个调用点(源 976/1614)
   * 都写成 `self._tool_output_for_llm(result)`。python 于是把 `self`(Router) 绑进
   * `tool_result`、把 Result 绑进 `cap`，`tool_result.ok` 在每条路径上如实抛
   * AttributeError: 'Router' object has no attribute 'ok'（repro:
   * `tmp/dp_repro_static_binding.py`；源仓 git 干净，非移植引入）。
   * TS 的 `this.m(a)` 不会隐式把 `this` 当第一参数，所以这里 (a) 保留 python 的
   * 形参表（`tool_result` 是 `unknown`，属性读取走 `pyAttr`），(b) 由调用点显式
   * 传入 `this` 还原错位绑定。修 bug 属于 parity 之后的独立评审提交（§2 BUG 规则）。
   * 截断按码点切片：分隔行里的 ✂️ 在 UTF-16 里占 2 个单元。
   */
  _tool_output_for_llm(tool_result: unknown, cap: unknown = 3500): string {
    if (!pyTruth(pyAttr(tool_result, "ok"))) {
      return `[error] ${pyStr(pyAttr(tool_result, "error"))}`;
    }
    const value = pyAttr(tool_result, "value");
    if (value === null || value === undefined) {
      return "(empty output)";
    }
    let text: string;
    if (typeof value === "string") {
      text = value;
    } else {
      try {
        text = pyJsonDumpsFull(value, { indent: 2 });
      } catch {
        text = pyStr(value);
      }
    }

    if (pyLe(pyLen(text), cap)) {
      return text;
    }
    // 到这里 cap 必须是数字：源里 `cap * 0.6` 对 Result 会抛 TypeError,
    // 上面 `len(text) <= cap` 先抛，故此行只在正常调用约定下可达。
    const capNum = pyNumber(cap);

    const head_len = pyInt(capNum * 0.6);
    const tail_len = pyInt(capNum * 0.35);
    const omitted = pyLen(text) - (head_len + tail_len);
    const total_lines = pyLen(pySplitlines(text));
    return (
      `${pySlice(text, 0, head_len)}\n\n`
      + `--- ✂️ [Output truncated: ${omitted} chars / ${total_lines} total lines; showing head & tail] ---\n\n`
      + `${pySlice(text, -tail_len)}`
    );
  }

  /** Step 4: Acceptance & artifact audit. */
  _audit(result: Result, dispatch: Record<string, any>, context: Record<string, any>): Record<string, any> {
    const audit_payload: Record<string, any> = {
      timestamp: DISPATCH_SEAMS.now(),
      agent: dictGet(dispatch, "agent"),
      tool: dictGet(dispatch, "primary_tool"),
      success: result.ok,
      session_id: dictGet(context, "session_id"),
    };
    // Phase 59 内化: 触发 5D 任务收口与文档对齐审计 (PostTurnReconciliationEngine)
    try {
      const mod = DISPATCH_SEAMS.reconciliationModule();
      // 源的 `or os.getcwd()` 是短路：workspace 有值时不碰 getcwd。
      const _ws = dictGet(context, "workspace");
      const ws = pyTruth(_ws) ? _ws : DISPATCH_SEAMS.getcwd();
      const reconcile_summary = mod.PostTurnReconciliationEngine.run_reconciliation(ws);
      audit_payload["reconciliation"] = mod.summary_to_dict(reconcile_summary);
    } catch {
      // BUG(port): 源的 `except Exception: pass` —— fail-open，可选增强。
    }
    return audit_payload;
  }

  // ------------------------------------------------------------------
  // Image persistence (generated by multi-modal models)
  // ------------------------------------------------------------------

  /**
   * Collect raw image items from a single LLM reply into the turn accumulator.
   *
   * Called after every step in the agent loop. Images are NOT persisted yet —
   * that happens once at the end of the turn in ``_persist_turn_images``. This
   * avoids writing half-finished images from a turn that gets cancelled.
   */
  _harvest_images(reply: Record<string, any>, context: Record<string, any>): void {
    const images = dictGet(reply, "images");
    if (!pyTruth(images)) {
      return;
    }
    const acc = dictSetDefault(context, "_raw_images", []) as Record<string, unknown>[];
    for (const item of pyIter(images)) {
      acc.push(item as Record<string, unknown>);
    }
  }

  /**
   * Write accumulated images to disk, return lightweight refs for the WS payload.
   *
   * Each image is saved via ``image_store.save_ref`` which handles both base64
   * and URL variants. Failed saves are silently dropped — a missing image is
   * better than a stuck turn.
   */
  async _persist_turn_images(context: Record<string, any>): Promise<Record<string, unknown>[]> {
    const raw = dictPop(context, "_raw_images", null);
    if (!pyTruth(raw)) {
      return [];
    }
    const refs: Record<string, unknown>[] = [];
    for (const item of pyIter(raw)) {
      const ref = await DISPATCH_SEAMS.save_image_ref(
        item, this.workspace, dictGet(item as Record<string, unknown>, "name", ""),
      );
      if (pyTruth(ref)) {
        refs.push(ref);
      }
    }
    return refs;
  }

  /** Step 5: Result presentation. Head-Tail truncation throughout. */
  _present(result: Result, dispatch: Record<string, any>, context: Record<string, any>): string {
    void dispatch;
    void context;
    if (!pyTruth(result.ok)) {
      // No English prefix. Whatever produced the failure has already phrased
      // it for a person; `Operation failed: ` in front of a Chinese sentence
      // just reads as a leaked internal label.
      return pyStr(pyOr(result.error, "这次请求没有完成"));
    }
    const value = result.value;
    if (typeof value === "string") {
      return DISPATCH_SEAMS.truncate(value, 10000);
    }
    if (isDict(value)) {
      return DISPATCH_SEAMS.truncate(pyJsonDumpsFull(value, { indent: 2 }), 10000);
    }
    return DISPATCH_SEAMS.truncate(pyStr(value), 10000);
  }
}

