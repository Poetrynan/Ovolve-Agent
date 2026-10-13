/**
 * team_collab.ts — 源：app/backend/team_collab.py（418 行）。
 * 单元 210 / wave-9，manifest.tsv target=TS。
 *
 * F5/F6 团队协作运行期助手：Agent-Teams 策略判定 + 两阶段优雅关停
 * （shutdown_request / 协作 cancel / 硬 kill）+ 队友空闲扫描。
 *
 * ── 源码自带的死路：逐字复制、只标注不修（RULEBOOK §2 BUG 规则）──
 *
 * B1 `_send_shutdown_request`（源 167 行）起手就是
 *    `from mailbox import KIND_CONTROL, ORIGIN_FRAMEWORK, send`。
 *    `ORIGIN_FRAMEWORK` 在全仓**零处定义**（只有三处引用：permission_bridge.py:41/71、
 *    ovolve_subagent_worker.py、本文件 167/289）。于是这条发送臂从头就抛 ImportError。
 *    graceful_shutdown_team 把对它的调用**包在 `try/except Exception`（源 265-285）里**，
 *    所以生产里的真实下场是：每条 active 子代理都发一次 shutdown_request、必抛、被吞，
 *    只在日志留一行 `log.warning("[team_collab] shutdown_request failed for %s: %s", sid, exc)`，
 *    然后照常走协作 kill。端口把这臂**完整写出来**：mailbox 是 Native→Rust（TS 侧无同名
 *    文件），缺省臂与 subagent_runtime.ts:565 / permission_bridge.ts 的 mailboxModule 一字
 *    一致——抛 `ModuleNotFoundErrorP("No module named 'mailbox'")`。探针注入一个**补齐
 *    ORIGIN_FRAMEWORK 的假 mailbox** 去驱动这条臂的后半段（send 真被调用、payload 进账本），
 *    并保留一个**没有这个名字**的假 mailbox 去复现源里那条 ImportError。不许"顺手补常量"。
 *
 * B2 即便把名字补上，两处 `send(...)` 都带着 `origin=` 关键字，而 mailbox.py:115 的签名
 *    是 `send(storage, box_id, sender, *, kind, payload, summary)`——没有 origin，
 *    于是 TypeError，落进 B1 的同一批臂。两条死路各自独立（探针各留一条用例钉死）。
 *
 * B3 父会话广播臂（源 287-323）`from mailbox import KIND_INFO, ORIGIN_FRAMEWORK, send` +
 *    `send(...)` 整个包在 `except Exception: pass` 里——B1 的同一批缺名在这里被**彻底吞掉**，
 *    连一行日志都不留。端口逐字保持这个宽吞。
 *
 * ── 接缝（RULEBOOK §2 红线 5：探针把每一处外部触碰换成记录型假件）──
 * mailbox / storage 是函数级 `from X import name`：TS 侧就是 `TEAM_SEAMS.XModule()` +
 * needAttr()，缺名抛 CPython 原文案，缺模块（mailbox）抛 ModuleNotFoundErrorP。
 * storage / subagent_runtime / permission_bridge 是已落地的 TS 兄弟模块（单元 195/197/198）——
 * 本模块对它们的触碰都发生在**函数体内**（get_storage）或**通过传入的 runtime 对象**
 * （list_active/kill/kill_all/list_sessions 是 runtime 的鸭子方法，端口不静态 import 它们），
 * 因此没有静态 import 兄弟模块的必要；异常类族则静态 import 单元 195 导出的 SUBAGENT_ERRORS
 * （异常类型也是行为，见 HANDOFF_V10 §10.1 第 2 条：CancelledError 只有一个类）。
 * 时钟 / uuid / os.environ / asyncio.sleep / logging 全部是接缝。
 * 没有真的 SQLite、subprocess、端口、HTTP、stdin/stdout。
 *
 * ── 本文件的确定性折叠（探针两侧同规则）──
 *   1. 时钟  : now() 由 seam 提供，探针钉成整数计数器（源里 339/341/399 三处 time.time()）。
 *   2. uuid  : uuid4Hex() seam，探针钉死；调用点自己切 [:12]。
 *   3. 关键字: python 的 kwargs 在 TS 侧是尾随 options 对象，假件当 kwargs 记账。
 *   4. 日志  : `log.warning(fmt, sid, exc)` 的 `%` 渲染发生在宿主 logger，接缝只收
 *              (fmt, args) 两部分，不预渲染（与 permission_bridge.ts / moa.ts 同规则）。
 *   5. runtime: 传入的鸭子对象；kill_all 的 `graceful=False` 关键字在 TS 侧是尾随
 *              {graceful:false}，假件当 kwargs 记账。
 *
 * DIVERGENCE(port): python `async def` 协程体在第一次真正挂起之前与调用者同步步执行；
 *   JS async 函数同样在调用点同步跑到第一个 await，所以本文件的账本顺序两侧一致。
 *   唯一残余差异是同步前缀里的抛掷在 JS 侧变成 rejected promise（多一个 microtask）。
 *   本模块的挂起点只有 `await asyncio.sleep(SHUTDOWN_POLL_S)`，且 graceful_shutdown_team
 *   不 create_task、不并发别的任务，探针里那条前缀没有可被插队的排队协程，故不拆
 *   "非 async 外壳 + 异步内层"（同 permission_bridge.ts 折叠 4 的结论，规则同 197）。
 * DIVERGENCE(port): ImportError 文案末尾括号里是"模块自己的源文件路径"，目标语言下天然是
 *   .js；路径由假模块的 __origin__ 提供，探针两侧钉成同一个字面量。
 * DIVERGENCE(port): `os.environ.get(...)` 出现在**模块顶层**（源 129 行的
 *   SHUTDOWN_DEFAULT_TIMEOUT_S），所以它是 import 期求值：环境变量放一个非数字会让
 *   `import team_collab` 整个抛 ValueError。TS 模块顶层同样在装载期求值，语义一致。
 */

import { SUBAGENT_ERRORS } from "./subagent_runtime.js";
import * as _storage_ns from "./storage.js";

type JsonDict = Record<string, unknown>;
type AnyMod = Record<string, any>;

/* ── CPython 语义小工具（本仓惯例：每个文件自带一份） ─────────────────────── */

/**
 * python `bool(x)` / `if x` / `x or y` —— 与 server/http_server_keys.ts 的 py_truth 同规则。
 *
 * 两处脸曾与 CPython 相反（全引擎扫描器 `tmp/lead_truth_faces_scan.mjs` 判 BAD-NaN + BAD-emptyDict，
 * 参照修法与值级差分见 `tmp/lead_py_truth_ab.mjs`：pristine diffs=0 / 注入旧脸 diffs=4）：
 *   1) **空 dict**：普通对象支旧代码 `return true`（“非 null 即真”）⇒ `bool({})` = True；
 *      CPython `bool({})` 是 **False**。⇒ 现按 `Object.keys(...).length > 0` 判（Map 支一直是这么判的）。
 *      本单元由消费点 `graceful_shutdown_team` 的 `child_sid = str(row.get("childSessionId") or "")`
 *      钉住：case `gst#child_empty_dict`（childSessionId = {}）。CPython/修好的端口都判 `{}` 为假 ⇒
 *      子发送跳过；旧脸会把 `{}` 当真 ⇒ 往 "mailbox:{}" 多发一条 send，与源不符。negctl 变异 `truth_object_face`。
 *   2) **NaN**：`float("nan")` 在 CPython 是 **真**，旧码 `v !== 0 && !Number.isNaN(v)` 把它判成假。
 *      ⇒ 现 `return v !== 0;`（NaN≠0 ⇒ 真）。本单元由消费点 `team_workflow_active` 的
 *      `if not parent_ctx`（case `twa#nan`，input = NaN）钉住：CPython/修好的端口都判 NaN 为真 ⇒
 *      不进早退、落到 `parent_ctx.get` 抛 AttributeError('float')；旧脸判假 ⇒ 早退 return False，与源不符。
 *      negctl 变异 `truth_nan_face`。
 * 类实例（有非 Object 原型）默认恒真、`__bool__` 优先，这两条与 CPython 一致（差分表已钉）。
 */
function pyTruth(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;   // NaN 为真（CPython bool(float('nan')) is True）
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
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

/** `a or b`：只在 a 为假时才算 b。 */
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

/** python `repr()`（只覆盖 json 值域 + 端口的异常镜像）。 */
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

/** python `str(x)`。f-string 插布尔/None 走这里（渲染 `True`/`False`/`None`）。 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  return pyRepr(v);
}

/** `str.strip()` 的 python 语义（默认去掉全部空白类字符）。 */
function pyStrip(s: string): string { return s.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, ""); }

/** python `float(x)`：接受 inf/nan/下划线，非法输入抛 ValueError/TypeError（文案逐字）。 */
function pyFloat(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = pyStrip(v).replace(/_/g, "");
    const low = t.toLowerCase();
    if (low === "inf" || low === "+inf" || low === "infinity" || low === "+infinity") return Infinity;
    if (low === "-inf" || low === "-infinity") return -Infinity;
    if (low === "nan" || low === "+nan" || low === "-nan") return NaN;
    if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
    throw new ValueErrorP(`could not convert string to float: ${pyRepr(v)}`);
  }
  throw new TypeErrorP(`float() argument must be a string or a real number, not '${pyTypeName(v)}'`);
}

/** python `int(x)`：截断向零；非数值抛 TypeError（文案逐字）。 */
function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string") {
    const t = pyStrip(v).replace(/_/g, "");
    if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
    throw new ValueErrorP(`invalid literal for int() with base 10: ${pyRepr(v)}`);
  }
  throw new TypeErrorP(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

/** python `float + x`（`deadline = time.time() + timeout_s`）：非数值是 TypeError，不是隐式转。 */
function pyFloatPlus(a: number, b: unknown): number {
  if (typeof b === "number") return a + b;
  if (typeof b === "boolean") return a + (b ? 1 : 0);
  throw new TypeErrorP(`unsupported operand type(s) for +: 'float' and '${pyTypeName(b)}'`);
}

/** python `now - float(idle_since)` / 减法两侧都得是数（本模块里恒成立，保留判定）。 */
function pyFloatMinus(a: number, b: number): number { return a - b; }

/** python `x >= y`（数值比较）。 */
function pyGe(a: number, b: number): boolean { return a >= b; }

/** `d.get(key)` —— python dict.get，present-but-null 返回 null；非映射抛 AttributeError。 */
function dGet(d: unknown, key: string): unknown {
  if (d === null || d === undefined) throw noAttr("get", d);
  if (typeof d === "string" || Array.isArray(d)) throw noAttr("get", d);
  if (d instanceof Map) return d.has(key) ? d.get(key) : undefined;
  if (typeof d !== "object") throw noAttr("get", d);
  const o = d as JsonDict;
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

/** python 的 AttributeError 文案：`'list' object has no attribute 'get'`。 */
function noAttr(name: string, obj: unknown): Error {
  return new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute '${name}'`);
}

/** python `{**row, k: v}`（scan 里对 plain 行做的展开）。 */
function pySplat(base: unknown, extra: JsonDict): JsonDict {
  if (base instanceof Map) return { ...(Object.fromEntries(base as Map<string, unknown>)), ...extra };
  if (base === null || base === undefined || typeof base !== "object" || Array.isArray(base)) {
    throw new TypeErrorP(`'${pyTypeName(base)}' object is not a mapping`);
  }
  return { ...(base as JsonDict), ...extra };
}

/* ── python 异常镜像：复用单元 195 导出的那批类（异常类型也是行为） ───────── */
const ImportErrorP = SUBAGENT_ERRORS.ImportErrorP;
const ModuleNotFoundErrorP = SUBAGENT_ERRORS.ModuleNotFoundErrorP;
const ValueErrorP = SUBAGENT_ERRORS.ValueErrorP;
const TypeErrorP = SUBAGENT_ERRORS.TypeErrorP;
const AttributeErrorP = SUBAGENT_ERRORS.AttributeErrorP;

/** 源里 `except Exception` 能抓到的那一族。 */
function isPyException(e: unknown): boolean { return e instanceof Error; }

/* ── python 函数局部 import 的对应物：名字表 + 缺名报错 ───────────────────── */

let _storage_ns_mod: AnyMod = _storage_ns as AnyMod;

/**
 * `from X import name` 的存在性检查。缺名 -> CPython 原文案，一次只报**书写顺序里
 * 第一个**缺的名字（IMPORT_FROM 逐名执行）。
 */
function needAttr(mod: AnyMod, name: string, from: string): unknown {
  if (!(name in mod)) {
    const origin = typeof mod.__origin__ === "string" ? mod.__origin__ : "(unknown location)";
    throw new ImportErrorP(`cannot import name '${name}' from '${from}' (${origin})`);
  }
  return mod[name];
}

/* ── 接缝 ─────────────────────────────────────────────────────────────────── */

export const TEAM_SEAMS = {
  /* python `time.time()` */
  now: (): number => Date.now() / 1000,
  /* python `os.environ.get(k, d)` */
  env_get: (k: string, d: unknown = undefined): unknown =>
    Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : d,
  /* python `uuid.uuid4().hex` —— 调用点自己切 [:12] */
  uuid4Hex: (): string => randomHex32(),
  /* python `asyncio.sleep` */
  sleep: async (s: number): Promise<void> => {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.max(s, 0) * 1000);
      (t as unknown as { unref?: () => void }).unref?.();
    });
  },

  /* ── 兄弟模块装载器：python 的函数局部 import 是同步语句，故同步臂 ── */
  storageModule: (): AnyMod => _storage_ns_mod,
  // mailbox 是 Native→Rust：TS 侧无同名文件，缺省臂与 subagent_runtime.ts:565 /
  // permission_bridge.ts 的 mailboxModule 一字一致。
  mailboxModule: (): AnyMod => { throw new ModuleNotFoundErrorP("No module named 'mailbox'"); },

  /* python `logging.getLogger(__name__).warning(fmt, *args)`：`%` 渲染归宿主 logger，
   * 接缝只收 (fmt, args) 两部分，不预渲染。 */
  log_warning: (fmt: string, args: unknown[]): void => { /* host logger */ },
};

function randomHex32(): string {
  let s = "";
  while (s.length < 32) s += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return s.slice(0, 32);
}

/* ── Agent Teams policy（源 37-119） ─────────────────────────────────────── */

export const _TEAM_WORKFLOW_KEYS: readonly string[] = [
  "team_mode",
  "agent_team",
  "multi_agent_workflow",
  "agent_teams",
];

export const _TEAM_WORKFLOW_VALUES: ReadonlySet<string> = new Set([
  "1", "true", "yes", "team", "expert_team", "agent_team", "agent_teams",
]);

/** 源 61-81 行：True 当用户显式选了多代理 / 专家团队工作流。 */
export function team_workflow_active(parent_ctx: unknown): boolean {
  if (!pyTruth(parent_ctx)) {
    return false;
  }
  for (const key of _TEAM_WORKFLOW_KEYS) {
    const val = pyStrip(pyStr(pyOr(dGet(parent_ctx, key), ""))).toLowerCase();
    if (_TEAM_WORKFLOW_VALUES.has(val)) {
      return true;
    }
  }
  // `parent_ctx.get("multi_agent_workflow") is True`：身份判定，只认真布尔 True。
  if (dGet(parent_ctx, "multi_agent_workflow") === true) {
    return true;
  }
  return false;
}

/** 源 87-93 行。 */
export function subprocess_globally_disabled(): boolean {
  const env = pyStrip(pyStr(TEAM_SEAMS.env_get("OVOLVE_DISABLE_SUBPROCESS", ""))).toLowerCase();
  return ["1", "true", "yes"].includes(env);
}

/**
 * 源 99-119 行。Agent Teams 工作流是否强制 subprocess 模式：
 *   True  — 团队工作流覆盖 OVOLVE_DISABLE_SUBPROCESS
 *   False — 永不（只有 task/persona 块里显式 inprocess 才给 False，本函数产不出 False）
 *   None  — 交回普通 resolve_exec_mode 优先级
 */
export function resolve_agent_teams_subprocess(parent_ctx: unknown): boolean | null {
  if (team_workflow_active(parent_ctx)) {
    return true;
  }
  return null;
}

/* ── Graceful shutdown（源 125-375） ─────────────────────────────────────── */

/**
 * DIVERGENCE(port): 见文件头折叠 5 —— 这一行在模块装载期执行，环境变量给一个非数字
 * 就是 `ValueError: could not convert string to float: 'abc'`，整个模块 import 失败。
 * python 完全一样，所以不做兜底。
 */
export const SHUTDOWN_DEFAULT_TIMEOUT_S: number = pyFloat(
  TEAM_SEAMS.env_get("OVOLVE_SHUTDOWN_TIMEOUT_S", "10"),
);

export const SHUTDOWN_POLL_S: number = 0.25;

/** 源 137-143 行。默认（未设环境变量）为 True。 */
export function _graceful_shutdown_enabled(): boolean {
  const env = pyStrip(pyStr(TEAM_SEAMS.env_get("OVOLVE_GRACEFUL_SHUTDOWN", "1"))).toLowerCase();
  return !["0", "false", "no"].includes(env);
}

interface SendShutdownKw {
  child_session_id: unknown;
  subagent_id: unknown;
  request_id: unknown;
  reason: unknown;
  deadline_s: unknown;
}

/**
 * 源 149-197 行。
 *
 * BUG(port): 见文件头 B1/B2 —— `ORIGIN_FRAMEWORK` 这个名字在 mailbox 里不存在，所以这条
 *   臂在产品里必抛 ImportError；补上名字之后 `origin=` 又不是 send 的参数，改抛 TypeError。
 *   两条死路都在这一段。调用点（graceful_shutdown_team）把它包在 try/except Exception 里，
 *   所以生产中的净效果是"发一次、抛一次、被吞、留一行 log.warning"。逐字保留。
 */
export function _send_shutdown_request(storage: unknown, kw: SendShutdownKw): void {
  const mb = TEAM_SEAMS.mailboxModule();
  // 绑定顺序 = 源码书写顺序；缺名只报第一个。
  const kindControl = needAttr(mb, "KIND_CONTROL", "mailbox");
  const originFramework = needAttr(mb, "ORIGIN_FRAMEWORK", "mailbox");
  const send = needAttr(mb, "send", "mailbox") as
    ((s: unknown, b: unknown, sender: unknown, opts: JsonDict) => unknown);

  send(
    storage,
    "mailbox:" + pyStr(kw.child_session_id),
    "team_collab",
    {
      kind: kindControl,
      origin: originFramework,
      payload: {
        type: "shutdown_request",
        request_id: kw.request_id,
        subagent_id: kw.subagent_id,
        reason: kw.reason,
        deadline_s: kw.deadline_s,
      },
    },
  );
}

interface GracefulShutdownKw {
  reason?: unknown;
  timeout_s?: unknown;
}

/**
 * 源 203-375 行。两阶段关停：控制信箱 → 协作 cancel → 硬 kill。
 *
 * BUG(port): `_send_shutdown_request` 的调用在 try/except 里（B1 被吞成一行的 log.warning），
 *   父会话广播臂在 `except Exception: pass` 里（B3 被彻底吞）。协作 kill 与硬 kill 是活的。
 */
export async function graceful_shutdown_team(
  runtime: AnyMod,
  parent_session_id: string,
  kw: GracefulShutdownKw = {},
): Promise<JsonDict> {
  const timeout_s = kw.timeout_s === null || kw.timeout_s === undefined
    ? SHUTDOWN_DEFAULT_TIMEOUT_S : pyFloat(kw.timeout_s);
  const reason = kw.reason === undefined ? "user_stop" : kw.reason;

  const request_id = TEAM_SEAMS.uuid4Hex().slice(0, 12);
  const activeBefore = pyMethod(runtime, "list_active")(parent_session_id) as JsonDict[];
  if (!pyTruth(activeBefore)) {
    return {
      ok: true,
      request_id,
      requested: 0,
      graceful: 0,
      killed: 0,
    };
  }

  let storage: unknown;
  try {
    const stMod = TEAM_SEAMS.storageModule();
    const getStorage = needAttr(stMod, "get_storage", "storage") as () => unknown;
    storage = getStorage();
  } catch (e) {
    if (!isPyException(e)) throw e;
    storage = null;
  }

  if (storage !== null) {
    for (const row of activeBefore) {
      const child_sid = pyStr(pyOr(dGet(row, "childSessionId"), ""));
      const sid = pyStr(pyOr(dGet(row, "subagentId"), ""));
      if (pyTruth(child_sid)) {
        try {
          _send_shutdown_request(storage, {
            child_session_id: child_sid,
            subagent_id: sid,
            request_id,
            reason,
            deadline_s: timeout_s,
          });
        } catch (exc) {
          if (!isPyException(exc)) throw exc;
          TEAM_SEAMS.log_warning(
            "[team_collab] shutdown_request failed for %s: %s", [sid, exc]);
        }
      }
    }
    try {
      const mb = TEAM_SEAMS.mailboxModule();
      const kindInfo = needAttr(mb, "KIND_INFO", "mailbox");
      const originFramework = needAttr(mb, "ORIGIN_FRAMEWORK", "mailbox");
      const send = needAttr(mb, "send", "mailbox") as
        ((s: unknown, b: unknown, sender: unknown, opts: JsonDict) => unknown);
      send(
        storage,
        "mailbox:" + pyStr(parent_session_id),
        "team_collab",
        {
          kind: kindInfo,
          origin: originFramework,
          payload: {
            event: "shutdown_requested",
            request_id,
            reason,
            count: activeBefore.length,
            deadline_s: timeout_s,
          },
        },
      );
    } catch (e) {
      if (!isPyException(e)) throw e;
      // 源 321-323：except Exception: pass —— 逐字保留宽吞。
    }
  }

  // 协作：router.cancel / subprocess SIGTERM 路径，走 kill()
  for (const row of activeBefore) {
    const sid = pyStr(pyOr(dGet(row, "subagentId"), ""));
    if (pyTruth(sid)) {
      pyMethod(runtime, "kill")(sid);
    }
  }

  const deadline = pyFloatPlus(TEAM_SEAMS.now(), timeout_s);
  while (TEAM_SEAMS.now() < deadline) {
    if (!pyTruth(pyMethod(runtime, "list_active")(parent_session_id))) {
      break;
    }
    await TEAM_SEAMS.sleep(SHUTDOWN_POLL_S);
  }

  const remaining = pyMethod(runtime, "list_active")(parent_session_id) as JsonDict[];
  let killed = 0;
  if (pyTruth(remaining)) {
    killed = pyInt(pyMethod(runtime, "kill_all")(parent_session_id, { graceful: false }));
  }

  return {
    ok: !pyTruth(remaining) || killed > 0,
    request_id,
    requested: activeBefore.length,
    graceful: activeBefore.length - remaining.length - killed,
    killed,
    remaining: pyTruth(remaining) ? remaining.length - killed : 0,
  };
}

/* ── TeammateIdleTracker（源 381-417） ───────────────────────────────────── */

/** 源 385-417 行：把 terminal-idle 超过阈值的队友挑出来。 */
export class TeammateIdleTracker {
  idle_threshold_s: number;

  constructor(idle_threshold_s: unknown = 60.0) {
    this.idle_threshold_s = pyFloat(idle_threshold_s);
  }

  scan(runtime: AnyMod, parent_session_id: string): JsonDict[] {
    const now = TEAM_SEAMS.now();
    const out: JsonDict[] = [];
    for (const row of pyMethod(runtime, "list_sessions")(parent_session_id) as JsonDict[]) {
      const idle_since = dGet(row, "idleSince");
      if (!pyTruth(idle_since)) {
        continue;
      }
      const elapsed = pyFloatMinus(now, pyFloat(idle_since));
      if (pyGe(elapsed, this.idle_threshold_s)) {
        out.push(pySplat(row, { idleElapsedS: pyInt(elapsed) }));
      }
    }
    return out;
  }
}

/** `obj.name(...)`：方法不存在时同样是 AttributeError，不是 JS 的那句 TypeError。 */
function pyMethod(obj: unknown, name: string): (...a: unknown[]) => unknown {
  const v = pyAttr(obj, name);
  if (typeof v !== "function") {
    throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute '${name}'`);
  }
  return (...a: unknown[]) => (v as (...x: unknown[]) => unknown).apply(obj, a);
}

/** `obj.name` —— 直接属性读，缺名抛 CPython 的 AttributeError。 */
function pyAttr(obj: unknown, name: string): unknown {
  if (obj === null || obj === undefined) throw noAttr(name, obj);
  if (typeof obj !== "object" && typeof obj !== "function") throw noAttr(name, obj);
  if (!(name in (obj as object))) throw noAttr(name, obj);
  return (obj as AnyMod)[name];
}

// PORT STATUS: 本文件无 TODO(port)。
