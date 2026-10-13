/**
 * ovolve_subagent_worker.ts — 源：app/backend/ovolve_subagent_worker.py（362 行）。
 * 单元 197 / wave-9 #1/17，manifest.tsv 第 206 行 target=TS。
 *
 * F5：跑一轮子代理的轻量 subprocess worker。两种模式——
 *   默认      : stdin 读一份 JSON spec，跑一轮，退出
 *   --sidecar : JSON-RPC 会话循环（prewarm 池复用同一个进程）
 *
 * ── 源码自带的三条死路：逐字复制、只标注不修（RULEBOOK §2 BUG 规则）──
 *
 * D1 mailbox_shutdown_poll 里 `from mailbox import KIND_CONTROL, ORIGIN_FRAMEWORK,
 *    drain, send`：`ORIGIN_FRAMEWORK` 在 mailbox.py 里不存在（全仓 grep 只有本文件
 *    与 team_collab.py / permission_bridge.py 三处**引用**它，没有任何一处定义）。
 *    于是这条 import 每 1s 抛一次 ImportError，又被同一段 `except Exception: pass`
 *    吞掉：worker 永远不会应答 mailbox 里的 shutdown_request，`stop.set()` 那一行
 *    也永远走不到。证据：tmp/w197_import_check.py（纯 AST，不执行）。
 *
 * D2 就算 D1 补上名字，`send(...)` 调用还带着 `origin=` 关键字，而
 *    mailbox.py:115 的签名是 `send(storage, box_id, sender, *, kind, payload, summary)`
 *    —— 没有 origin → TypeError，同样被同一段宽吞吃掉。
 *
 * D3 run_turn 的真跑分支（非 dry_run）从 `from subagent_runtime import
 *    (_CTX_DIGEST_CONTRACT, _read_workspace_rules, extract_context_digest,
 *    render_context_digest, strip_final_marker)` 起就抛 ImportError：这四个名字在
 *    整个产品仓里**只出现在本文件**。所以每一份真 spec 的 stdout 都是
 *    `{"type": "fatal", "ok": false, "error": "worker crashed: cannot import name
 *    '_CTX_DIGEST_CONTRACT' from 'subagent_runtime' (…)"}`、退出码 1；只有 dry_run
 *    分支和 sidecar 的 JSON-RPC 错误回包是活的。
 *    端口仍然把这半条臂**完整写出来**（run_turn 第 2 段），探针注入一个补齐五个
 *    名字的假 subagent_runtime 去驱动它 —— 否则端口的这一半连被编译进任何路径的
 *    机会都没有，更别说被测。
 *
 * ── 接缝（探针把每一处外部触碰换成记录型假件；RULEBOOK §2 红线5）──
 * 三个未落地的兄弟模块走 WORKER_SEAMS 的同步模块装载器，缺省臂和
 * subagent_runtime.ts 的 `mailboxModuleSync` 完全一致：抛 ModuleNotFoundErrorP。
 * 四个已落地的（storage / risk_control / router / subagent_registry /
 * subagent_runtime）是静态 import，同步取名字与 python 的函数局部 import 语义一致。
 *
 * ── 本文件的确定性折叠（探针两侧同规则）──
 *   1. 时钟  : now() 由 seam 提供，探针钉成整数计数器 -> ts 字段两侧同为 "N.0"。
 *   2. stdio : stdout_write/stdout_flush/stdin_read/read1/argv/environ 全是 seam。
 *   3. 调度  : event()/create_task()/sleep()/waitFor() 走 seam；create_task 复用
 *              subagent_runtime.ts 的 SubagentTask（python asyncio.Task 的既有镜像），
 *              所以 cancel()/join() 语义和单元 195 一字不差。
 *   4. 关键字: python 的 kwargs 在 TS 侧是尾随 options 对象，假件把它当 kwargs 记账，
 *              一次调用两侧各留一行。
 *
 * DIVERGENCE(port): `python -m ovolve_subagent_worker` 的 `raise SystemExit(...)`
 *   在 TS 侧是抛 SystemExitP 交给真正的 CLI 入口去设 process.exitCode；JS 没有
 *   解释器级的 SystemExit。等价性：控制流同样是"终止 main、带上退出码"。
 * DIVERGENCE(port): run_in_executor(None, sys.stdin.buffer.read1, 4096) —— python 把
 *   这个阻塞读丢给线程池以便别的协程继续跑；TS 侧 read1 是一个 await 的 seam，
 *   事件循环同样不被阻塞。可观察行为（谁在等待期间拿到 CPU）一致，机制不同。
 * DIVERGENCE(port): ImportError 文案末尾括号里是"模块自己的源文件路径"，目标语言
 *   下它天然是 .js 而不是 .py（RULEBOOK §4 的输出路径规定）。语义不变，字符串里
 *   的路径由 seam 的 __origin 提供，探针两侧钉成同一个字面量。
 * DIVERGENCE(port): 整数样式的对象键（"2"/"1"/"0"）在 JS 里被引擎重排成升序，
 *   CPython 的 dict 保留插入序。只有当 spec/meta 里出现"数字样式的键"时可见，
 *   内容集合本身不变（json.dumps 的键序差异）。原因：JS 的 plain object 无法
 *   保留 integer-like 键的插入序，而端口收到的 spec 正是 JSON.parse 的产物。
 */

import * as fs from "node:fs";

import { SubagentTask, SUBAGENT_ERRORS } from "./subagent_runtime.js";

type JsonDict = Record<string, unknown>;
/** 任意"模块对象"：python 模块在 TS 侧就是一个名字表。 */
type AnyMod = Record<string, any>;

/* ── CPython 语义小工具（本仓惯例：每个文件自带一份） ─────────────────────── */

/**
 * python `bool(x)` / `if x` / `x or y` —— 与 server/http_server_keys.ts 的 py_truth 同规则。
 *
 * 两处脸曾与 CPython 相反（全引擎扫描器 `tmp/lead_truth_faces_scan.mjs` 判 BAD-NaN + BAD-emptyDict，
 * 参照修法与值级差分见 `tmp/lead_py_truth_ab.mjs`：pristine diffs=0 / 注入旧脸 diffs=4）：
 *   1) **空 dict**：普通对象支旧代码 `return true`（“非 null 即真”）⇒ `bool({})` = True；
 *      CPython `bool({})` 是 **False**。⇒ 现按 `Object.keys(...).length > 0` 判（Map 支一直是这么判的）。
 *      本单元由消费点 `str(spec.get("prompt") or "")` 等 `or ""` 支钉住（case `rt#face_emptydict_prompt`，
 *      prompt = {}）：CPython/修好的端口都判 `{}` 为假 ⇒ prompt 退化成 ""；旧脸会把 `{}` 当真 ⇒
 *      pyStr({}) = "{}" 混进可见字段，与源不符。negctl `truth_object_face`。
 *   2) **NaN**：`float("nan")` 在 CPython 是 **真**，旧码 `v !== 0 && !Number.isNaN(v)` 把它判成假。
 *      ⇒ 现 `return v !== 0;`（NaN≠0 ⇒ 真）。同一消费点（case `rt#face_nan_prompt`，prompt = NaN）钉住：
 *      CPython `str(float('nan') or "")` = "nan" 进 prompt；旧脸判 NaN 为假 ⇒ 退化成 ""。negctl `truth_nan_face`。
 * 类实例（有非 Object 原型）默认恒真、`__bool__` 优先，这两条与 CPython 一致（差分表已钉）。
 */
function pyTruth(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;   // NaN 为真（CPython bool(float('nan')) is True）
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  // python `bool(b"")` 是 False：bytes 臂必须在"类实例恒真"那条之前单独判长度，
  // 否则 sidecar 的 EOF（空 chunk）会被当成有数据，读循环永不退出。
  if (v instanceof Uint8Array) return v.length > 0;
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      const b = (v as { __bool__?: () => unknown }).__bool__;
      if (typeof b === "function") return pyTruth(b.call(v));
      return true;                     // 类实例默认恒真
    }
    return Object.keys(v as JsonDict).length > 0; // dict 脸：空 dict 为假（CPython bool({}) is False）
  }
  if (typeof v === "function") return true;
  return Boolean(v);
}

/** `a or b`：只在 a 为假时才算 b，与 python 一致（不求值顺序会影响探针账本）。 */
function pyOr(a: unknown, b: unknown): unknown { return pyTruth(a) ? a : b; }

function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  let s = String(x);
  if (!/[.eE]/.test(s)) s += ".0";
  return s;
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (v instanceof Set) return "set";
  if (v instanceof Map) return "dict";
  if (typeof v === "function") return "function";
  if (typeof v === "object") {
    const c = (v as { constructor?: { name?: string } }).constructor;
    const n = c && c.name ? c.name : "object";
    return n === "Object" ? "dict" : n;
  }
  return typeof v;
}

/** python `repr()`（只覆盖 json.loads 能产出的那几种值 + 端口的异常镜像）。 */
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") {
    const hasSingle = v.includes("'");
    const hasDouble = v.includes('"');
    const body = v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    if (hasSingle && !hasDouble) return `"${body}"`;
    return `'${body.replace(/'/g, "\\'")}'`;
  }
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (v instanceof Set) {
    return v.size === 0 ? "set()" : "{" + [...v].map(pyRepr).join(", ") + "}";
  }
  if (v instanceof Map) {
    const parts = [...v.entries()].map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`);
    return "{" + parts.join(", ") + "}";
  }
  if (typeof v === "object") {
    const r = (v as { __repr__?: () => string }).__repr__;
    if (typeof r === "function") return r.call(v);
    const parts = Object.entries(v as JsonDict).map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`);
    return "{" + parts.join(", ") + "}";
  }
  return String(v);
}

/** python `str(x)`。 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  return pyRepr(v);
}

/** python `int(x)`（JSON 里可能出现的类型全覆盖）。 */
function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (Number.isNaN(v)) throw new ValueErrorP("cannot convert float NaN to integer");
    if (!Number.isFinite(v)) {
      throw new OverflowErrorP("cannot convert float infinity to integer");
    }
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const t = v.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
    if (!/^[+-]?[0-9]+$/.test(t)) {
      throw new ValueErrorP(`invalid literal for int() with base 10: ${pyRepr(v)}`);
    }
    return parseInt(t, 10);
  }
  throw new TypeErrorP(
    `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

/** python 的 AttributeError 文案：`'list' object has no attribute 'get'`。 */
function noAttr(name: string, obj: unknown): AttributeErrorP {
  return new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute '${name}'`);
}

/** python 的迭代协议在 json 值域内的对应物：str 逐字符、dict 逐键。 */
function pyIter(v: unknown): unknown[] {
  if (typeof v === "string") return [...v];
  if (Array.isArray(v)) return [...v];
  if (v instanceof Set) return [...v];
  if (v instanceof Map) return [...v.keys()];
  if (v !== null && typeof v === "object") return Object.keys(v as JsonDict);
  throw new TypeErrorP(`'${pyTypeName(v)}' object is not iterable`);
}

/** `dict.get(key)` —— 源里的 spec 一定是 json.loads 的结果；非 dict 时 python 抛 AttributeError。 */
function specGet(spec: unknown, key: string): unknown {
  if (spec === null || spec === undefined || Array.isArray(spec) || typeof spec !== "object") {
    throw noAttr("get", spec);
  }
  if (spec instanceof Map) return spec.has(key) ? spec.get(key) : undefined;
  const o = spec as JsonDict;
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

/** `dict.get(key)` 用于"确定是 dict"的行内取值（payload/meta）。 */
function dGet(d: unknown, key: string): unknown {
  if (d === null || d === undefined || typeof d !== "object" || Array.isArray(d)) {
    throw noAttr("get", d);
  }
  if (d instanceof Map) return d.has(key) ? d.get(key) : undefined;
  const o = d as JsonDict;
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

/** `spec["key"]`（python 的下标：缺键抛 KeyError，repr 带引号）。 */
function specIdx(spec: unknown, key: string): unknown {
  const v = specGet(spec, key);
  if (v === undefined && (spec === null || typeof spec !== "object"
    || (!Array.isArray(spec) && !(spec instanceof Map)
      && !Object.prototype.hasOwnProperty.call(spec as JsonDict, key)))) {
    throw new KeyErrorP(`'${key}'`);
  }
  return v;
}

/** python `getattr(obj, name, default)`。 */
function pyGetattr(obj: unknown, name: string, dflt: unknown): unknown {
  if (obj === null || obj === undefined) return dflt;
  if (typeof obj !== "object" && typeof obj !== "function") return dflt;
  const v = (obj as AnyMod)[name];
  return v === undefined ? dflt : v;
}

/** python `hasattr(obj, name)`。 */
function pyHasattr(obj: unknown, name: string): boolean {
  return pyGetattr(obj, name, undefined) !== undefined;
}

const _MISS = Symbol("missing attribute");

/**
 * python `obj.name(*args)`：属性**不存在** -> AttributeError（文案用类型名）；
 * 属性存在但**不可调用** -> TypeError `'NoneType' object is not callable`。
 * 这两条臂在 python 里是两个异常，不能折叠成一个。
 */
function pyCall(obj: unknown, name: string, args: unknown[]): unknown {
  const v = pyGetattr(obj, name, _MISS);
  if (v === _MISS) throw noAttr(name, obj);
  if (typeof v !== "function") throw new TypeErrorP(`'${pyTypeName(v)}' object is not callable`);
  return (v as (...a: unknown[]) => unknown).call(obj, ...args);
}

/** python `dict(x)` 的浅拷贝（源用它隔离 meta）。 */
function pyDictCopy(x: unknown): JsonDict {
  if (x instanceof Map) return Object.fromEntries(x as Map<string, unknown>);
  if (Array.isArray(x)) {
    // python `dict([elem, ...])`：每项按迭代协议展开成长度 2 的序列；
    // 迭代 dict 得到的是**键**，所以 [{'a':1,'b':2}] -> {'a': 'b'}。
    const out: JsonDict = {};
    for (let i = 0; i < x.length; i++) {
      const el = x[i];
      let seq: unknown[] | null;
      if (Array.isArray(el)) seq = el;
      else if (typeof el === "string") seq = [...el];
      else if (el !== null && typeof el === "object") seq = Object.keys(el as JsonDict);
      else seq = null;
      if (seq === null) {
        throw new TypeErrorP(
          `cannot convert dictionary update sequence element #${i} to a sequence`);
      }
      if (seq.length !== 2) {
        throw new ValueErrorP(
          `dictionary update sequence element #${i} has length ${seq.length}; 2 is required`);
      }
      out[pyStr(seq[0])] = seq[1];
    }
    return out;
  }
  if (x === null || x === undefined || typeof x !== "object") {
    throw new TypeErrorP(`'${pyTypeName(x)}' object is not iterable`);
  }
  return { ...(x as JsonDict) };
}

/** python `sorted(iterable)` —— 字符串按**码位**序（JS 默认按 UTF-16 码元，代理对会翻）。 */
function pySorted(xs: Iterable<unknown>): unknown[] {
  return [...xs].sort((a, b) => {
    if (typeof a === "string" && typeof b === "string") {
      const ca = [...a].map((c) => c.codePointAt(0) as number);
      const cb = [...b].map((c) => c.codePointAt(0) as number);
      const n = Math.min(ca.length, cb.length);
      for (let i = 0; i < n; i++) { if (ca[i] !== cb[i]) return (ca[i] as number) - (cb[i] as number); }
      return ca.length - cb.length;
    }
    const sa = pyStr(a), sb = pyStr(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}

/* ── python 异常镜像（名字 = python 类名，.pyMsg = str(exc)） ──────────────── */

class ImportErrorP extends Error {
  pyMsg: string;
  constructor(m: string) { super(m); this.name = "ImportError"; this.pyMsg = m; }
}
class ModuleNotFoundErrorP extends ImportErrorP {
  constructor(m: string) { super(m); this.name = "ModuleNotFoundError"; }
}
class TimeoutErrorP extends Error {
  pyMsg: string;
  constructor(m: string) { super(m); this.name = "TimeoutError"; this.pyMsg = m; }
}
/** python 侧只有**一个** `asyncio.CancelledError`：`Task.cancel()` 抛的就是它，
 *  `except asyncio.CancelledError` 判的也是它。端口如果自带一个同名类，JS 的
 *  `instanceof` 是按对象身份比，跨文件的两个同名类永远不等——回收臂就会漏。
 *  所以复用单元 195 为这件事专门导出的那一个类（RULEBOOK §2：异常类型也是行为）。 */
const CancelledErrorP = SUBAGENT_ERRORS.CancelledErrorP;
class ValueErrorP extends Error {
  pyMsg: string;
  constructor(m: string) { super(m); this.name = "ValueError"; this.pyMsg = m; }
}
class TypeErrorP extends Error {
  pyMsg: string;
  constructor(m: string) { super(m); this.name = "TypeError"; this.pyMsg = m; }
}
class OverflowErrorP extends Error {
  pyMsg: string;
  constructor(m: string) { super(m); this.name = "OverflowError"; this.pyMsg = m; }
}
class KeyErrorP extends Error {
  pyMsg: string;
  /** python `str(KeyError('k'))` 是键的 **repr**，引号 included。 */
  constructor(m: string) { super(m); this.name = "KeyError"; this.pyMsg = m; }
}
class AttributeErrorP extends Error {
  pyMsg: string;
  constructor(m: string) { super(m); this.name = "AttributeError"; this.pyMsg = m; }
}
class JSONDecodeErrorP extends ValueErrorP {
  constructor(m: string) { super(m); this.name = "JSONDecodeError"; }
}
/** `raise SystemExit(n)`。DIVERGENCE(port): 见文件头。 */
class SystemExitP extends Error {
  readonly code: number;
  constructor(code: number) { super(`SystemExit(${code})`); this.name = "SystemExit"; this.code = code; }
}
/** 源里 `except Exception` 能抓到的那一族（不含 CancelledError / SystemExit）。 */
function isPyException(e: unknown): boolean {
  if (e instanceof CancelledErrorP || e instanceof SystemExitP) return false;
  return e instanceof Error;
}

/** `str(exc)` —— 镜像异常取 pyMsg，其余按 python 的 str(Exception) 习惯。 */
function pyExcStr(e: unknown): string {
  if (e instanceof ImportErrorP || e instanceof TimeoutErrorP || e instanceof ValueErrorP
    || e instanceof TypeErrorP || e instanceof OverflowErrorP || e instanceof KeyErrorP
    || e instanceof AttributeErrorP) {
    return (e as { pyMsg: string }).pyMsg;
  }
  return String((e as { message?: string })?.message ?? e);
}

/** `f"{type(e).__name__}: {e}"` 里的名字部分。 */
function pyExcName(e: unknown): string {
  const n = (e as { name?: string })?.name;
  return n && n !== "Error" ? n : "Exception";
}

export const WORKER_ERRORS = {
  ImportErrorP, ModuleNotFoundErrorP, TimeoutErrorP, CancelledErrorP, ValueErrorP,
  TypeErrorP, KeyErrorP, AttributeErrorP, JSONDecodeErrorP, SystemExitP,
  OverflowErrorP,
};

/* ── json.dumps(obj, ensure_ascii=False) / json.loads 的 CPython 语义 ──────── */

const _ESCAPES: Record<string, string> = {
  '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f",
  "\n": "\\n", "\r": "\\r", "\t": "\\t",
};

function dumpString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const esc = _ESCAPES[ch];
    if (esc !== undefined) out += esc;
    else if (ch.codePointAt(0)! < 0x20) {
      out += "\\u" + ch.codePointAt(0)!.toString(16).padStart(4, "0");
    } else out += ch;                        // ensure_ascii=False：原样输出
  }
  return out + '"';
}

function dumpValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
    return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  }
  if (typeof v === "string") return dumpString(v);
  if (Array.isArray(v)) return "[" + v.map(dumpValue).join(", ") + "]";
  if (v instanceof Map) {
    const parts = [...v.entries()].map(([k, x]) => `${dumpKey(k)}: ${dumpValue(x)}`);
    return "{" + parts.join(", ") + "}";
  }
  if (typeof v === "object" && !(v instanceof Set)) {
    const parts = Object.entries(v as JsonDict).map(([k, x]) => `${dumpString(k)}: ${dumpValue(x)}`);
    return "{" + parts.join(", ") + "}";
  }
  throw new TypeErrorP(`Object of type ${pyTypeName(v)} is not JSON serializable`);
}

/** CPython 的键强制策略：非 str 的键先变成**JSON 文本**再当字符串写出去，
 *  所以 True/None 出来是带引号的 `"true"`/`"null"`，不是裸字面量。 */
function dumpKey(k: unknown): string {
  if (typeof k === "string") return dumpString(k);
  if (typeof k === "boolean") return k ? '"true"' : '"false"';
  if (k === null || k === undefined) return '"null"';
  if (typeof k === "number") {
    return Number.isInteger(k) ? dumpString(String(k)) : '"' + pyFloatRepr(k) + '"';
  }
  throw new TypeErrorP(`keys must be str, int, float, bool or None, not ${pyTypeName(k)}`);
}

/** python `json.dumps(obj, ensure_ascii=False)`（默认分隔符 ", " / ": "）。 */
export function pyJsonDumps(v: unknown): string { return dumpValue(v); }

/** CPython 的 `line L column C (char P)` 定位。 */
function jdErr(msg: string, s: string, pos: number): JSONDecodeErrorP {
  let lines = 0;
  for (let i = 0; i < pos && i < s.length; i++) if (s[i] === "\n") lines++;
  const rfind = s.lastIndexOf("\n", pos - 1);
  const colno = pos - rfind;
  return new JSONDecodeErrorP(`${msg}: line ${lines + 1} column ${colno} (char ${pos})`);
}

const _WS = " \t\n\r";

/** python `json.loads(text)` —— 连报错文案一起搬（源把它拼进 fatal 的 error 字段）。 */
export function pyJsonLoads(text: string): unknown {
  let i = 0;
  const skipWs = () => { while (i < text.length && _WS.includes(text.charAt(i))) i++; };
  const parseString = (): string => {
    const start = i;
    i++;
    let out = "";
    for (;;) {
      if (i >= text.length) throw jdErr("Unterminated string starting at", text, start);
      const c = text.charAt(i);
      if (c === '"') { i++; return out; }
      if (c === "\\") {
        const escPos = i;
        i++;
        if (i >= text.length) throw jdErr("Unterminated string starting at", text, start);
        const e = text.charAt(i);
        if (e === '"') { out += '"'; i++; }
        else if (e === "\\") { out += "\\"; i++; }
        else if (e === "/") { out += "/"; i++; }
        else if (e === "b") { out += "\b"; i++; }
        else if (e === "f") { out += "\f"; i++; }
        else if (e === "n") { out += "\n"; i++; }
        else if (e === "r") { out += "\r"; i++; }
        else if (e === "t") { out += "\t"; i++; }
        else if (e === "u") {
          let hex = "";
          for (let k = 0; k < 4; k++) {
            i++;
            const h = i < text.length ? text.charAt(i) : "";
            if (!/^[0-9a-fA-F]$/.test(h)) throw jdErr("Invalid \\uXXXX escape", text, i - 1);
            hex += h;
          }
          i++;
          out += String.fromCharCode(parseInt(hex, 16));
        } else {
          throw jdErr("Invalid \\escape", text, escPos);
        }
        continue;
      }
      const cp = text.codePointAt(i) as number;
      if (cp <= 0x1f) throw jdErr("Invalid control character at", text, i);
      out += String.fromCodePoint(cp);
      i += cp > 0xffff ? 2 : 1;
    }
  };
  const parseNumber = (): number => {
    const start = i;
    if (text.charAt(i) === "-") i++;
    if (text.charAt(i) === "0") i++;
    else if (/^[1-9]$/.test(text.charAt(i) || "")) { while (i < text.length && /^[0-9]$/.test(text.charAt(i))) i++; }
    else throw jdErr("Expecting value", text, start);
    let isFloat = false;
    if (text.charAt(i) === "." && /^[0-9]$/.test(text.charAt(i + 1) || "")) {
      isFloat = true; i++;
      while (i < text.length && /^[0-9]$/.test(text.charAt(i))) i++;
    }
    if ((text.charAt(i) === "e" || text.charAt(i) === "E")) {
      let j = i + 1;
      if (text.charAt(j) === "+" || text.charAt(j) === "-") j++;
      if (/^[0-9]$/.test(text.charAt(j) || "")) {
        isFloat = true; i = j;
        while (i < text.length && /^[0-9]$/.test(text.charAt(i))) i++;
      }
    }
    return parseFloat(text.slice(start, i));
  };
  const parseValue = (): unknown => {
    skipWs();
    if (i >= text.length) throw jdErr("Expecting value", text, i);
    const c = text.charAt(i);
    if (c === "{") {
      i++;
      const obj: JsonDict = {};
      skipWs();
      if (text.charAt(i) === "}") { i++; return obj; }
      let comma = -1;
      for (;;) {
        skipWs();
        if (text.charAt(i) !== '"') {
          // JSONObject: 逗号后直接看到 '}' 才是 trailing comma，报在**逗号**的位置。
          if (comma >= 0 && text.charAt(i) === "}") {
            throw jdErr("Illegal trailing comma before end of object", text, comma);
          }
          throw jdErr("Expecting property name enclosed in double quotes", text, i);
        }
        const key = parseString();
        skipWs();
        if (text.charAt(i) !== ":") throw jdErr("Expecting ':' delimiter", text, i);
        i++;
        obj[key] = parseValue();
        skipWs();
        const d = text.charAt(i);
        if (d === ",") { comma = i; i++; continue; }
        if (d === "}") { i++; return obj; }
        throw jdErr("Expecting ',' delimiter", text, i);
      }
    }
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      skipWs();
      if (text.charAt(i) === "]") { i++; return arr; }
      let comma = -1;
      for (;;) {
        arr.push(parseValue());
        skipWs();
        const d = text.charAt(i);
        if (d === "]") { i++; return arr; }
        if (d !== ",") throw jdErr("Expecting ',' delimiter", text, i);
        comma = i;
        i++;
        skipWs();
        // JSONArray: 逗号后（跳过空白）看到 ']' -> trailing comma，报在逗号位置。
        if (text.charAt(i) === "]") {
          throw jdErr("Illegal trailing comma before end of array", text, comma);
        }
      }
    }
    if (c === '"') return parseString();
    if (text.startsWith("NaN", i)) { i += 3; return Number.NaN; }
    if (text.startsWith("Infinity", i)) { i += 8; return Infinity; }
    if (c === "-" && text.startsWith("-Infinity", i)) { i += 9; return -Infinity; }
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    if (c === "-" || /^[0-9]$/.test(c)) return parseNumber();
    throw jdErr("Expecting value", text, i);
  };
  const v = parseValue();
  skipWs();
  if (i < text.length) throw jdErr("Extra data", text, i);
  return v;
}

/* ── asyncio 原语的最小镜像 ───────────────────────────────────────────────── */

/** python `asyncio.Event`。 */
export class PyEvent {
  private _flag = false;
  private _waiters: Array<() => void> = [];
  is_set(): boolean { return this._flag; }
  set(): void {
    if (this._flag) return;
    this._flag = true;
    const ws = this._waiters;
    this._waiters = [];
    for (const w of ws) w();
  }
  clear(): void { this._flag = false; }
  async wait(): Promise<boolean> {
    if (this._flag) return true;
    await new Promise<void>((resolve) => { this._waiters.push(resolve); });
    return true;
  }
}

/** python `asyncio.wait_for(coro, timeout=n)` —— 超时抛 TimeoutError（空消息）。 */
async function defaultWaitFor<T>(fn: () => Promise<T>, timeoutS: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new TimeoutErrorP(""));
    }, Math.max(timeoutS, 0) * 1000);
    (timer as unknown as { unref?: () => void }).unref?.();
    Promise.resolve().then(fn).then(
      (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
      (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); },
    );
  });
}

/* ── python 函数局部 import 的对应物：名字表 + 缺名报错 ───────────────────── */

let _storage_mod: AnyMod;
let _risk_control_mod: AnyMod;
let _router_mod: AnyMod;
let _subagent_runtime_mod: AnyMod;
let _subagent_registry_mod: AnyMod;
let _permission_bridge_mod: AnyMod;

/** `from X import name` 的存在性检查。缺名 -> CPython 原文案，一次只报第一个。 */
function needAttr(mod: AnyMod, name: string, from: string): unknown {
  if (!(name in mod)) {
    const origin = typeof mod.__origin__ === "string" ? mod.__origin__ : "(unknown location)";
    throw new ImportErrorP(`cannot import name '${name}' from '${from}' (${origin})`);
  }
  return mod[name];
}

/* ── 接缝 ─────────────────────────────────────────────────────────────────── */

export const WORKER_SEAMS = {
  /* python `time.time()` */
  now: (): number => Date.now() / 1000,

  /* python `sys.stdout.write` / `sys.stdout.flush` —— 两条，探针各记一行 */
  stdout_write: (s: string): void => { process.stdout.write(s); },
  stdout_flush: (): void => { (process.stdout as unknown as AnyMod).flush?.(); },

  /* python `sys.argv`（成员判定只看 --sidecar 那一项） */
  argv: (): string[] => process.argv.slice(1),
  /* python `os.environ.get(k, d)` / `os.environ.setdefault(k, v)` */
  env_get: (k: string, d: unknown = undefined): unknown =>
    Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : d,
  env_setdefault: (k: string, v: string): void => {
    if (!Object.prototype.hasOwnProperty.call(process.env, k)) process.env[k] = v;
  },

  /* python `sys.stdin.read()` / `run_in_executor(None, sys.stdin.buffer.read1, n)` */
  stdin_read: (): string => fs.readFileSync(0, "utf8"),
  read1: async (n: number): Promise<Buffer> => {
    const b = Buffer.alloc(n);
    try {
      const got = fs.readSync(0, b, 0, n, null);
      return b.subarray(0, got);
    } catch {
      return Buffer.alloc(0);      // EOF / 非管道：与 python 的空 chunk 同臂
    }
  },

  /* python `asyncio.sleep` / `Event()` / `create_task` / `wait_for` / `asyncio.run` */
  sleep: async (s: number): Promise<void> => {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.max(s, 0) * 1000);
      (t as unknown as { unref?: () => void }).unref?.();
    });
  },
  event: (): PyEvent => new PyEvent(),
  createTask: (fn: () => Promise<unknown>): SubagentTask => new SubagentTask(fn),
  waitFor: defaultWaitFor,
  asyncio_run: async <T>(fn: () => Promise<T>): Promise<T> => await fn(),

  /* ── 兄弟模块装载器：python 的函数局部 import 是同步语句，故同步臂 ── */
  storageModule: (): AnyMod => _storage_mod,
  riskControlModule: (): AnyMod => _risk_control_mod,
  routerModule: (): AnyMod => _router_mod,
  subagentRuntimeModule: (): AnyMod => _subagent_runtime_mod,
  subagentRegistryModule: (): AnyMod => _subagent_registry_mod,
  // mailbox / worker_sidecar 尚未落地：mailbox 是 Native→Rust（TS 侧无同名文件），
  // worker_sidecar 是本波次 #17。缺省臂与 subagent_runtime.ts:548 的 mailboxModuleSync
  // 一字一致。permission_bridge 已在 #2 落地，所以这里交给**真模块**——python 侧
  // `from permission_bridge import ...` 装载的就是它，缺省臂必须是同一个东西。
  mailboxModule: (): AnyMod => { throw new ModuleNotFoundErrorP("No module named 'mailbox'"); },
  permissionBridgeModule: (): AnyMod => _permission_bridge_mod,
  workerSidecarModule: (): AnyMod => {
    throw new ModuleNotFoundErrorP("No module named 'worker_sidecar'");
  },

  /** python `frozenset(...)` —— 端口只把它当集合用（成员 + sorted）。 */
  frozenSet: (xs: Iterable<unknown>): Set<unknown> => new Set(xs),
  /** python `dict(**meta, k=v)` 的展开顺序由调用方保证；这里只做拷贝合并。 */
  mergeDict: (base: JsonDict, extra: JsonDict): JsonDict => ({ ...base, ...extra }),

  /* ── 自模块的三个协程入口：python 侧是模块全局名（探针直接改 sys.modules 上
   *    的那个 module 字典），TS 侧的函数绑定改不动，所以过一层 seam。调用点、
   *    次数、参数与 python 完全一致。 */
  heartbeat_loop: (stop: PyEvent, interval?: number): Promise<void> =>
    _heartbeat_loop(stop, interval),
  mailbox_shutdown_poll: (childSession: string, stop: PyEvent,
    opts?: { interval?: number }): Promise<void> =>
    _mailbox_shutdown_poll(childSession, stop, opts),
  run_turn: (spec: JsonDict): Promise<JsonDict> => _run_turn(spec),
};

/* ── _emit ────────────────────────────────────────────────────────────────── */

/** `sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")` 然后 flush。 */
export function _emit(msg: JsonDict): void {
  WORKER_SEAMS.stdout_write(pyJsonDumps(msg) + "\n");
  WORKER_SEAMS.stdout_flush();
}

/* ── _heartbeat_loop ──────────────────────────────────────────────────────── */

export async function _heartbeat_loop(stop: PyEvent, interval: number = 5.0): Promise<void> {
  while (!stop.is_set()) {
    _emit({ type: "heartbeat", ts: WORKER_SEAMS.now() });
    try {
      await WORKER_SEAMS.waitFor(() => stop.wait(), interval);
    } catch (e) {
      // 源: except asyncio.TimeoutError: pass —— 窄捕获，别的异常照抛。
      if (e instanceof TimeoutErrorP) { /* pass */ } else throw e;
    }
  }
}

/* ── _mailbox_shutdown_poll ───────────────────────────────────────────────── */

/**
 * 轮询子信箱里的 shutdown_request，应答后置 stop。
 *
 * BUG(port): 这条臂在产品里从来没有工作过。`from mailbox import ...
 *   ORIGIN_FRAMEWORK ...`（源 45 行）每圈都抛 ImportError，被同一个
 *   `except Exception: pass` 吞掉；即便补上名字，源 55-63 行给 `send` 传的
 *   `origin=` 关键字在 mailbox.py:115 的签名里也不存在 -> TypeError，同样被吞。
 *   后果：worker 永不应答、永不到达 stop.set()，只能靠 sidecar RPC 或父进程
 *   自杀守护退出。repro: tmp/w197_import_check.py（AST，不执行）。逐字保留。
 */
export async function _mailbox_shutdown_poll(
  childSession: string,
  stop: PyEvent,
  opts: { interval?: number } = {},
): Promise<void> {
  const interval = opts.interval === undefined ? 1.0 : opts.interval;
  if (!pyTruth(childSession)) return;
  const box = `mailbox:${childSession}`;
  while (!stop.is_set()) {
    try {
      const storageMod = WORKER_SEAMS.storageModule();
      const getStorage = needAttr(storageMod, "get_storage", "storage") as () => unknown;
      const mb = WORKER_SEAMS.mailboxModule();
      // 绑定顺序 = 源码书写顺序；缺名只报第一个。
      const kindControl = needAttr(mb, "KIND_CONTROL", "mailbox");
      const originFramework = needAttr(mb, "ORIGIN_FRAMEWORK", "mailbox");
      const drain = needAttr(mb, "drain", "mailbox") as (
        s: unknown, b: string, kw: { limit: number }) => Iterable<JsonDict>;
      const send = needAttr(mb, "send", "mailbox") as (
        s: unknown, b: string, sender: string, kw: JsonDict) => unknown;
      const storage = getStorage();
      for (const msg of drain(storage, box, { limit: 10 })) {
        const payload = pyOr(dGet(msg, "payload"), {}) as JsonDict;
        if (dGet(payload, "type") !== "shutdown_request") continue;
        const requestId = pyStr(pyOr(dGet(payload, "request_id"), ""));
        send(storage, box, "ovolve_subagent_worker", {
          kind: kindControl,
          origin: originFramework,
          payload: {
            type: "shutdown_response",
            request_id: requestId,
            ok: true,
            reason: pyStr(dGet(payload, "reason") ?? ""),
          },
        });
        _emit({ type: "shutdown_response", request_id: requestId, ok: true });
        stop.set();
        return;
      }
    } catch (e) {
      // 源: except Exception: pass。BUG(port): 见上。
      if (!isPyException(e)) throw e;
    }
    try {
      await WORKER_SEAMS.waitFor(() => stop.wait(), interval);
    } catch (e) {
      if (e instanceof TimeoutErrorP) { /* pass */ } else throw e;
    }
  }
}

/* ── _install_permission_bridge ───────────────────────────────────────────── */

/**
 * BUG(port): 这里**没有** try/except，所以 permission_bridge 缺名/缺模块会一路
 *   冒到 _main_async 的宽吞，变成 "worker crashed: No module named
 *   'permission_bridge'"。TS 侧同样不做兜底。
 */
export function _install_permission_bridge(spec: unknown): void {
  // python `a or b or ""` 的短路：第二个 get 只在第一个为假时求值。
  const first = specGet(spec, "leader_endpoint");
  const second = pyTruth(first) ? undefined : specGet(spec, "parent_session_id");
  const leader = pyStr(pyOr(pyOr(first, second), ""));
  // python `if leader and os.environ.get(...) not in (...)`：leader 为假时**整条**
  // 短路，environ 一次都不读（读了就会留下可观测的一行账）。
  if (!pyTruth(leader)) return;
  const flag = WORKER_SEAMS.env_get("OVOLVE_PERMISSION_BRIDGE", "1");
  if (!["0", "false"].includes(flag as string)) {
    const pb = WORKER_SEAMS.permissionBridgeModule();
    const hook = needAttr(pb, "install_worker_bridge_hook", "permission_bridge") as
      ((leader: string) => unknown);
    hook(leader);
  }
}

/* ── _run_turn ────────────────────────────────────────────────────────────── */

/** 把源里 `finally` 段的"取消 + 回收"原样搬过来（只吞 CancelledError）。 */
async function _cancelAndJoin(tasks: SubagentTask[]): Promise<void> {
  for (const t of tasks) {
    try {
      await t.join();
    } catch (e) {
      if (e instanceof CancelledErrorP) { /* pass */ } else throw e;
    }
  }
}

/** 源 123-133 的 import 臂解析出来的名字表（python 在协程体第一次挂起之前拿到它们）。 */
interface RealNames {
  coercePermission: (v: unknown) => unknown;
  RouterCls: new (kw: JsonDict) => unknown;
  ctxDigestContract: unknown;
  readWorkspaceRules: (w: string) => string;
  extractContextDigest: (t: string) => [string, unknown];
  renderContextDigest: (d: unknown) => string;
  stripFinalMarker: (t: string) => [string, boolean];
  resolveChildAllowlist: (stub: unknown, role: string) => unknown;
  SubagentDefCls: new (kw: JsonDict) => unknown;
}

/**
 * python 的 `_run_turn`。
 * DIVERGENCE 镜像规则（不是可选项）：CPython 里协程体在**第一次真正挂起之前**与
 * 调用者同步步执行，所以 `main#rc1` 那种"import 臂立刻抛"的分支里，except 臂先跑完、
 * `cancel()` 把还没起跑的 heartbeat task 直接取消，stdout 上不会有心跳行。
 * JS 的 async 函数会把同步前缀里的抛掷改写成 rejected promise，`await` 必然让出一个
 * microtask —— 那一圈 CPU 正好交给 heartbeat，多出一行可观测输出。因此这里把名字解析
 * 留在**非 async** 的外壳里，异步部分单独成函数。
 */
export function _run_turn(spec: JsonDict): Promise<JsonDict> {
  if (pyTruth(specGet(spec, "dry_run"))) return _run_turn_dry(spec);
  return _run_turn_real(spec, _resolve_real_names());
}

async function _run_turn_dry(spec: JsonDict): Promise<JsonDict> {
  const stop = WORKER_SEAMS.event();
  const hb = WORKER_SEAMS.createTask(() => WORKER_SEAMS.heartbeat_loop(stop));
  const childSession = pyStr(pyOr(specGet(spec, "child_session"), ""));
  const shutdownPoll = WORKER_SEAMS.createTask(
    () => WORKER_SEAMS.mailbox_shutdown_poll(childSession, stop));
  try {
    await WORKER_SEAMS.sleep(0.15);
    if (stop.is_set()) {
      return {
        type: "result",
        ok: false,
        text: "",
        error: "shutdown requested",
        meta: { shutdown: true },
      };
    }
    return {
      type: "result",
      ok: true,
      text: "dry-run ok",
      error: "",
      meta: { dry_run: true },
    };
  } finally {
    stop.set();
    hb.cancel();
    shutdownPoll.cancel();
    await _cancelAndJoin([hb, shutdownPoll]);
  }
}

function _resolve_real_names(): RealNames {
  const rcMod = WORKER_SEAMS.riskControlModule();
  const coercePermission = needAttr(rcMod, "coerce_permission", "risk_control") as
    ((v: unknown) => unknown);
  const routerMod = WORKER_SEAMS.routerModule();
  const RouterCls = needAttr(routerMod, "Router", "router") as new (kw: JsonDict) => unknown;
  const srMod = WORKER_SEAMS.subagentRuntimeModule();
  // D3：这四个名字在产品里根本不存在 -> 这一行就是真跑分支的死点。
  const ctxDigestContract = needAttr(srMod, "_CTX_DIGEST_CONTRACT", "subagent_runtime");
  const readWorkspaceRules = needAttr(srMod, "_read_workspace_rules", "subagent_runtime") as
    ((w: string) => string);
  const extractContextDigest = needAttr(srMod, "extract_context_digest", "subagent_runtime") as
    ((t: string) => [string, unknown]);
  const renderContextDigest = needAttr(srMod, "render_context_digest", "subagent_runtime") as
    ((d: unknown) => string);
  const stripFinalMarker = needAttr(srMod, "strip_final_marker", "subagent_runtime") as
    ((t: string) => [string, boolean]);
  const resolveChildAllowlist = needAttr(
    srMod, "resolve_child_allowlist", "subagent_runtime") as
    ((stub: unknown, role: string) => unknown);
  const regMod = WORKER_SEAMS.subagentRegistryModule();
  const SubagentDefCls = needAttr(regMod, "SubagentDef", "subagent_registry") as
    new (kw: JsonDict) => unknown;
  return {
    coercePermission, RouterCls, ctxDigestContract, readWorkspaceRules,
    extractContextDigest, renderContextDigest, stripFinalMarker, resolveChildAllowlist,
    SubagentDefCls,
  };
}

async function _run_turn_real(spec: JsonDict, names: RealNames): Promise<JsonDict> {
  const {
    coercePermission, RouterCls, ctxDigestContract, readWorkspaceRules,
    extractContextDigest, renderContextDigest, stripFinalMarker, resolveChildAllowlist,
    SubagentDefCls,
  } = names;

  _install_permission_bridge(spec);

  const prompt = pyStr(pyOr(specGet(spec, "prompt"), ""));
  const childSession = pyStr(pyOr(specGet(spec, "child_session"), ""));
  const workspace = pyOr(pyStr(pyOr(specGet(spec, "workspace_root"), "")), null);
  const parentSession = pyStr(pyOr(specGet(spec, "parent_session_id"), ""));
  const depth = pyInt(pyOr(specGet(spec, "subagent_depth"), 0));
  const rawHandoffs = pyOr(specGet(spec, "handoffs"), []);
  // python `frozenset(str(h) for h in (...))` —— 先按迭代协议展开（str 逐字符、
  // dict 逐键），再逐个 str()，最后去重。
  const handoffs = WORKER_SEAMS.frozenSet(pyIter(rawHandoffs).map((h) => pyStr(h))) as Set<string>;

  let systemPrompt = pyStr(pyOr(specGet(spec, "system_prompt"), ""));
  if (handoffs.size) {
    const targets = [...handoffs].map(pyStr);
    systemPrompt += `\nHand-off: you may delegate ONCE, via the \`task\` tool, to: ${
      pySorted(targets).join(", ")}.\n`;
  }
  systemPrompt += pyStr(ctxDigestContract);
  const rules = readWorkspaceRules(pyStr(workspace ?? ""));
  if (pyTruth(rules)) {
    systemPrompt += `\n<parent-context>\nWorkspace rules that apply to this task (follow them whenever they touch your work):\n${
      rules}\n</parent-context>\n`;
  }

  const allowedRaw = specGet(spec, "allowed_tools");
  const stub = new SubagentDefCls({
    name: pyStr(pyOr(specGet(spec, "subagent_type"), "worker")),
    description: "",
    system_prompt: systemPrompt,
    allowed_tools: pyTruth(allowedRaw)
      ? WORKER_SEAMS.frozenSet(pyIter(specIdx(spec, "allowed_tools"))) : null,
    permission: pyStr(pyOr(specGet(spec, "permission"), "auto")),
    handoffs,
  });

  const router = new RouterCls({
    workspace,
    system_prompt: systemPrompt,
    session_id: childSession,
    mount_shared: false,
  }) as AnyMod;
  router.is_subagent = true;
  router.allowed_tools = resolveChildAllowlist(stub, "");
  router.subagent_handoffs = handoffs;
  router.subagent_depth = depth + 1;
  const maxTurns = specGet(spec, "max_turns");
  // python `max_turns is not None and int(max_turns) > 0` —— 右半边只在左半边
  // 成立时求值，否则 int(None) 会先抛 TypeError。
  if (maxTurns !== null && maxTurns !== undefined) {
    if (pyInt(maxTurns) > 0) router.max_agent_steps = pyInt(maxTurns);
    else router.max_agent_steps = 0;   // 0 = 不设上限（源注释）
  } else {
    router.max_agent_steps = 0;
  }
  router.permission = coercePermission((stub as { permission?: unknown }).permission);
  const model = specGet(spec, "model");
  if (pyTruth(model)) {
    try {
      // 源: router._bind_turn_model(str(model)) —— 缺属性 AttributeError、
      // 属性非可调用 TypeError，两条臂都在同一个 except Exception 里被吞。
      pyCall(router, "_bind_turn_model", [pyStr(model)]);
    } catch (e) {
      // 源: except Exception: pass
      if (!isPyException(e)) throw e;
    }
  }

  const leaderRaw = specGet(spec, "leader_endpoint");
  const leader = pyStr(pyOr(pyTruth(leaderRaw) ? leaderRaw : parentSession, ""));
  const childCtx: JsonDict = {
    session_id: childSession,
    workspace_root: workspace,
    is_subagent: true,
    parent_session_id: parentSession,
    leader_endpoint: leader,
    permission: (stub as { permission?: unknown }).permission,
    subagent_depth: depth + 1,
  };

  const stop = WORKER_SEAMS.event();
  const hb = WORKER_SEAMS.createTask(() => WORKER_SEAMS.heartbeat_loop(stop));
  const shutdownPoll = WORKER_SEAMS.createTask(
    () => WORKER_SEAMS.mailbox_shutdown_poll(childSession, stop));

  try {
    const result = await (pyCall(router, "handle", [prompt, childCtx]) as Promise<unknown>);
    if (stop.is_set()) {
      return {
        type: "result",
        ok: false,
        text: "",
        error: "shutdown requested",
        meta: { shutdown: true },
      };
    }
    const okFlag = pyTruth(pyGetattr(result, "ok", false));
    const rawText = pyOr(okFlag ? pyGetattr(result, "value", "") : "", "");
    const ok = okFlag;
    let err: unknown = ok ? "" : pyOr(pyGetattr(result, "error", ""), "sub-agent failed");
    const meta = pyDictCopy(pyOr(pyGetattr(result, "meta", null), {}));
    let [text, markerSeen] = stripFinalMarker(pyStr(rawText));
    let ctxDigest: unknown;
    [text, ctxDigest] = extractContextDigest(text);
    if (pyTruth(ctxDigest)) {
      const rendered = renderContextDigest(ctxDigest);
      if (pyTruth(rendered)) text = rendered + "\n\n" + text;
    }
    const stoppedIncomplete = ok && pyTruth(dGet(meta, "incomplete"));
    if (stoppedIncomplete) {
      text = "[STALE — sub-agent ran out of steps without declaring done]\n\n" + text;
      // 源没有 str() 这一步：stop_reason 是什么类型就往外传什么类型。
      err = Object.prototype.hasOwnProperty.call(meta, "stop_reason")
        ? meta["stop_reason"] : "step_cap";
    }
    return {
      type: "result",
      ok: ok && !stoppedIncomplete,
      text,
      error: err,
      meta: WORKER_SEAMS.mergeDict(meta, {
        final_marker: markerSeen,
        context_digest: ctxDigest,
        stale: stoppedIncomplete,
        model_role: pyOr(specGet(spec, "model_role"), "inherit"),
      }),
    };
  } finally {
    stop.set();
    hb.cancel();
    shutdownPoll.cancel();
    await _cancelAndJoin([hb, shutdownPoll]);
    try {
      if (pyHasattr(router, "teardown")) pyCall(router, "teardown", []);
    } catch (e) {
      // 源: except Exception: pass
      if (!isPyException(e)) throw e;
    }
  }
}

/* ── _sidecar_loop ────────────────────────────────────────────────────────── */

/**
 * JSON-RPC 会话循环。
 * BUG(port): 源在 271 行绑定了 `make_response` 却从未使用（worker 侧只发
 *   dispatch_rpc_request 产出的回包）。端口同样绑定、同样不用 —— 绑定的意义在于
 *   它会参与"缺名就抛 ImportError"这件事，所以是行为，不是死代码。
 */
export async function _sidecar_loop(): Promise<number> {
  const ws = WORKER_SEAMS.workerSidecarModule();
  const dispatchRpcRequest = needAttr(ws, "dispatch_rpc_request", "worker_sidecar") as (
    req: JsonDict, kw: JsonDict) => Promise<JsonDict | null>;
  needAttr(ws, "make_response", "worker_sidecar");
  const parseRpcLine = needAttr(ws, "parse_rpc_line", "worker_sidecar") as (
    line: Buffer) => JsonDict | null;

  const shuttingDown = WORKER_SEAMS.event();

  const shutdownFn = async (reason: string): Promise<JsonDict> => {
    shuttingDown.set();
    _emit({ type: "shutdown_response", ok: true, reason });
    return { ok: true, reason };
  };

  let buf = Buffer.alloc(0);
  while (!shuttingDown.is_set()) {
    const chunk = await WORKER_SEAMS.read1(4096);
    if (!pyTruth(chunk)) break;
    buf = Buffer.concat([buf, chunk as Buffer]);
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) break;
      const line = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
      const req = parseRpcLine(line);
      if (req === null || req === undefined) continue;
      const resp = await dispatchRpcRequest(req, {
        run_turn_fn: WORKER_SEAMS.run_turn, shutdown_fn: shutdownFn,
      });
      if (resp !== null && resp !== undefined) _emit(resp);
      if (shuttingDown.is_set()) return 0;
    }
  }
  return 0;
}

/* ── _main_async ──────────────────────────────────────────────────────────── */

export async function _main_async(): Promise<number> {
  try {
    const ws = WORKER_SEAMS.workerSidecarModule();
    const watchdog = needAttr(ws, "start_parent_death_watchdog", "worker_sidecar") as
      (() => unknown);
    watchdog();
  } catch (e) {
    // 源: except Exception: pass
    if (!isPyException(e)) throw e;
  }

  const sidecarFlag = WORKER_SEAMS.env_get("OVOLVE_WORKER_SIDECAR");
  if (sidecarFlag === "1" || WORKER_SEAMS.argv().includes("--sidecar")) {
    return await _sidecar_loop();
  }

  const raw = WORKER_SEAMS.stdin_read();
  if (!pyStr(raw).replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "")) {
    _emit({ type: "fatal", ok: false, error: "empty worker spec" });
    return 1;
  }
  let spec: unknown;
  try {
    spec = pyJsonLoads(pyStr(raw));
  } catch (e) {
    if (e instanceof JSONDecodeErrorP) {
      _emit({ type: "fatal", ok: false, error: `invalid spec json: ${pyExcStr(e)}` });
      return 1;
    }
    throw e;
  }

  if (WORKER_SEAMS.env_get("OVOLVE_WORKER_HANG") === "1") {
    await WORKER_SEAMS.sleep(3600);
    _emit({ type: "fatal", ok: false, error: "worker hang test mode" });
    return 1;
  }

  const stop = WORKER_SEAMS.event();
  const childSession = pyStr(pyOr(specGet(spec, "child_session"), ""));
  const hb = WORKER_SEAMS.createTask(() => WORKER_SEAMS.heartbeat_loop(stop));
  const shutdownPoll = WORKER_SEAMS.createTask(() => WORKER_SEAMS.mailbox_shutdown_poll(childSession, stop));
  try {
    const out = await WORKER_SEAMS.run_turn(spec as JsonDict);
    _emit(out);
    return pyTruth(dGet(out, "ok")) ? 0 : 1;
  } catch (e) {
    // 源: except Exception as exc -> _emit({"type":"fatal", ... f"worker crashed: {exc}"})
    if (!isPyException(e)) throw e;
    _emit({ type: "fatal", ok: false, error: `worker crashed: ${pyExcStr(e)}` });
    return 1;
  } finally {
    stop.set();
    hb.cancel();
    shutdownPoll.cancel();
    await _cancelAndJoin([hb, shutdownPoll]);
  }
}

/* ── main ─────────────────────────────────────────────────────────────────── */

export async function main(): Promise<never> {
  if (WORKER_SEAMS.argv().includes("--sidecar")) {
    WORKER_SEAMS.env_setdefault("OVOLVE_WORKER_SIDECAR", "1");
  }
  const code = await WORKER_SEAMS.asyncio_run(() => _main_async());
  throw new SystemExitP(code);
}

/* ── 静态 import 的名字表句柄 ─────────────────────────────────────────────── */
// 放在文件末尾是因为 `import * as` 会被提升到顶部；这里只是把它们交给接缝，
// 让探针能整表替换（python 侧对应 sys.modules 打补丁）。
import * as _storage_ns from "./storage.js";
import * as _risk_control_ns from "./risk_control.js";
import * as _router_ns from "./router.js";
import * as _subagent_runtime_ns from "./subagent_runtime.js";
import * as _subagent_registry_ns from "./subagent_registry.js";
import * as _permission_bridge_ns from "./permission_bridge.js";

_storage_mod = _storage_ns as AnyMod;
_risk_control_mod = _risk_control_ns as AnyMod;
_router_mod = _router_ns as AnyMod;
_subagent_runtime_mod = _subagent_runtime_ns as AnyMod;
_subagent_registry_mod = _subagent_registry_ns as AnyMod;
_permission_bridge_mod = _permission_bridge_ns as AnyMod;

// PORT STATUS: confidence=high todos=[0]
