/**
 * permission_bridge.ts — 源：app/backend/permission_bridge.py（284 行）。
 * 单元 198 / wave-9 #2/17，manifest.tsv 第 207 行 target=TS。
 *
 * F5 M4c：子代理进程（孩子）没法自己弹授权框，于是把它要授权的这一次
 * 通过 SQLite 信箱转给父会话（leader）：
 *   孩子 -> `mailbox:bridge:{parent_session_id}`   (approval_request)
 *   父亲 -> `mailbox:{child_session_id}`            (approval_response)
 * 孩子侧的入口是 event_bus 上 `permission_request` 的一个 priority=100 钩子
 * （install_worker_bridge_hook 装的），父亲侧的入口是 LeaderBridgeHost 这个轮询器。
 *
 * ── 源码自带的死路：逐字复制、只标注不修（RULEBOOK §2 BUG 规则）──
 *
 * B1 `send_approval_request` / `send_approval_response` 起手就是
 *    `from mailbox import KIND_CONTROL, ORIGIN_FRAMEWORK, send`。
 *    `ORIGIN_FRAMEWORK` 在 mailbox.py 里**不存在**——全仓只有三处**引用**
 *    （本文件 41/71、ovolve_subagent_worker.py、team_collab.py:167/289），
 *    零处定义。于是这两条发送臂从头就抛 ImportError，后果两侧不一样：
 *      * 孩子侧：`bridge_permission_event` 在源 145 行调 send_approval_request，
 *        那里**没有** try/except（138-143 的 try 只包 get_storage），所以异常一路
 *        冒到 event_bus.emit —— 授权事件每发一次就炸一次。
 *      * 父亲侧：`LeaderBridgeHost._loop` 把 `await self._handle_request(...)`
 *        整个包在 `except Exception` 里（193-197），所以**请求被 drain 掉（消费！）、
 *        record_pending 记进父会话的待答队列、回包这一下抛了**，只在日志里留一条
 *        debug。用户看到的是父 UI 多了一条永远答不上的问答，而孩子等
 *        DEFAULT_APPROVAL_TIMEOUT_S（默认 120s）之后拿到 deny。
 *    证据：tmp/w198_import_check.py（纯 AST，不执行）。
 *
 * B2 即便把名字补上，两处 `send(...)` 都带着 `origin=` 关键字，而 mailbox.py:115
 *    的签名是 `send(storage, box_id, sender, *, kind, payload, summary)` ——
 *    没有 origin -> TypeError，落进 B1 的同一批臂。两条死路各自独立。
 *
 * B3 `LeaderBridgeHost.resolve_pending`（父 UI 答完之后该回填的那一条）
 *    调的也是 send_approval_response，所以它同样必抛，`return True` 永不可达。
 *
 * 端口把这四条臂**全部完整写出来**，探针注入一个补齐 ORIGIN_FRAMEWORK 的假
 * mailbox 去驱动它们的后半段（并保留一个严格签名的 `send` 假件去撞 B2）——
 * 否则这半边文件连被编译进任何路径的机会都没有，更别说被测。
 *
 * ── 接缝（RULEBOOK §2 红线5：探针把每一处外部触碰换成记录型假件）──
 * mailbox 是 Native→Rust（TS 侧无同名文件），走同步模块装载器，缺省臂与
 * subagent_runtime.ts:565 的 `mailboxModuleSync` 一字一致：抛 ModuleNotFoundErrorP。
 * storage / risk_control / event_bus 是已落地的 TS 兄弟模块，静态 import 后
 * 整表交给接缝；python 的函数局部 `from X import name` 在 TS 侧就是
 * `PB_SEAMS.XModule()` + `needAttr(...)`，缺名时抛 CPython 原文案。
 * 时钟 / uuid / os.environ / asyncio(sleep,Event,create_task,wait_for) / logging
 * 全部是接缝。没有真的 SQLite、socket、subprocess、注册表、COM 或 stdio I/O。
 *
 * ── 本文件的确定性折叠（探针两侧同规则）──
 *   1. 时钟  : now() 由 seam 提供，探针钉成整数计数器。
 *   2. 调度  : create_task 复用 subagent_runtime.ts 的 SubagentTask（单元 195 已
 *              按 python asyncio.Task 验证过），wait_for 的超时抛 TimeoutError("")。
 *   3. 关键字: python 的 kwargs 在 TS 侧是尾随 options 对象，假件把它当 kwargs 记账。
 *   4. 日志  : `log.debug(fmt, exc)` 的 `%` 渲染发生在宿主的 logger 里，接缝只收
 *              (fmt, args) 两个部分，不预渲染（与 moa.ts / evolution_review.ts 同规则）。
 *
 * DIVERGENCE(port): python 的 `async def` 协程体在**第一次真正挂起之前**与调用者
 *   同步步执行；JS 的 async 函数同样在调用点同步跑到第一个 await，所以本文件的
 *   账本顺序（谁先读时钟、谁先调 send）两侧一致。唯一残余差异是同步前缀里的抛掷
 *   在 JS 侧变成 rejected promise（要多一个 microtask 才落到调用者的 catch）。
 *   单元 197 的 `_run_turn` 为此拆成了"非 async 外壳 + 异步内层"，因为那里刚好有
 *   一个刚 create_task、正在排队的心跳任务会被这一步插队。本文件不拆：会抛的两个
 *   点（B1 的 send、find_approval_response 的模块装载）都在孩子进程一侧，而本文件
 *   唯一会排队的任务（LeaderBridgeHost._loop）跑在父亲进程一侧，两者不在同一个
 *   事件循环里。若探针以后在同一条用例里同时驱动两侧并发现插队，按 197 的规则拆。
 * DIVERGENCE(port): `asyncio.wait_for(self._task, timeout=2.0)` 在超时时会**顺手
 *   cancel 那个 task**（CPython 语义），源 182-183 行的 `except` 里再 cancel 一次
 *   是第二次。接缝因此接受 SubagentTask 而不只是 thunk：只有拿到 task 句柄才可能
 *   复现"超时即取消"。thunk 形式用于协程（`self._stop.wait()`）——python 里创建
 *   协程对象是惰性的（函数体一行都没跑），TS 侧把调用推迟到接缝真正 await 的那一刻。
 * DIVERGENCE(port): ImportError 文案末尾括号里是"模块自己的源文件路径"，目标语言
 *   下它天然是 .js；路径由假模块的 `__origin__` 提供，探针两侧钉成同一个字面量。
 * DIVERGENCE(port): `os.environ.get(...)` 出现在**模块顶层**（源 22-24 行的
 *   `DEFAULT_APPROVAL_TIMEOUT_S`），所以它是 import 期求值：环境变量里放一个
 *   `abc` 会让 `import permission_bridge` 整个抛 ValueError。TS 的模块顶层同样在
 *   装载期求值，语义一致（也同样是"炸在装载那一刻"）。
 */

import { SubagentTask, SUBAGENT_ERRORS } from "./subagent_runtime.js";

type JsonDict = Record<string, unknown>;
/** 任意"模块对象"：python 模块在 TS 侧就是一个名字表。 */
type AnyMod = Record<string, any>;
/** python `event.payload` 的取值域：json 解出来的映射，或者接缝塞进来的任何对象。 */
type Row = JsonDict;

/* ── CPython 语义小工具（本仓惯例：每个文件自带一份） ─────────────────────── */

/**
 * python `bool(x)` / `if x` / `x or y` —— 与 server/http_server_keys.ts 的 py_truth 同规则。
 *
 * 两处脸曾与 CPython 相反（全引擎扫描器 `tmp/lead_truth_faces_scan.mjs` 判 BAD-NaN + BAD-emptyDict，
 * 参照修法与值级差分见 `tmp/lead_py_truth_ab.mjs`：pristine diffs=0 / 注入旧脸 diffs=4）：
 *   1) **空 dict**：普通对象支旧代码 `return true`（“非 null 即真”）⇒ `bool({})` = True；
 *      CPython `bool({})` 是 **False**。⇒ 现按 `Object.keys(...).length > 0` 判（Map 支一直是这么判的）。
 *      本单元由消费点 `bridge_box_id` 的 `str(parent_session_id or "")`（entry `bx`，case
 *      `bx#face_emptydict`，arg = {}）钉住：CPython/修好的端口都判 `{}` 为假 ⇒ 盒子地址退化成
 *      "mailbox:bridge:"；旧脸会把 `{}` 当真 ⇒ 拼出 "mailbox:bridge:{}"，与源不符。negctl `truth_object_face`。
 *   2) **NaN**：`float("nan")` 在 CPython 是 **真**，旧码 `v !== 0 && !Number.isNaN(v)` 把它判成假。
 *      ⇒ 现 `return v !== 0;`（NaN≠0 ⇒ 真）。同一消费点（case `bx#face_nan`，arg = NaN）钉住：
 *      CPython `str(float('nan') or "")` = "nan" ⇒ 盒子 "mailbox:bridge:nan"；旧脸判 NaN 为假 ⇒ 退化成
 *      空后缀。negctl `truth_nan_face`。
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

/** `a or b`：只在 a 为假时才算 b（求值顺序会影响探针账本）。 */
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

/** python `str(x)`。 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  return pyRepr(v);
}

/** `str.strip()` 的 python 语义（默认去掉全部空白类字符）。 */
function pyStrip(s: string): string { return s.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, ""); }

/**
 * python `float(x)`。源里只用于 import 期那一次环境变量读取，
 * 但错误类型/文案同样是行为：`float("abc")` 是 ValueError，`float(None)` 是
 * TypeError，`float("inf")` 是 Infinity。
 */
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

/**
 * python `float + x`（`deadline = time.time() + timeout_s`）。
 * 端口不能顺手把字符串当数字：CPython 在这里是 TypeError，不是隐式转换。
 */
function pyFloatPlus(a: number, b: unknown): number {
  if (typeof b === "number") return a + b;
  if (typeof b === "boolean") return a + (b ? 1 : 0);
  throw new TypeErrorP(`unsupported operand type(s) for +: 'float' and '${pyTypeName(b)}'`);
}

/** python 的 AttributeError 文案：`'list' object has no attribute 'get'`。 */
function noAttr(name: string, obj: unknown): Error {
  return new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute '${name}'`);
}

/**
 * `d.get(key)` —— python 的 dict.get。非映射（str/list/int）抛 AttributeError，
 * 与 `"...".get("k")` 一致；这一条是探针账本里的真行为，不是防御代码。
 */
function dGet(d: unknown, key: string): unknown {
  if (d === null || d === undefined) throw noAttr("get", d);
  if (typeof d === "string" || Array.isArray(d)) throw noAttr("get", d);
  if (d instanceof Map) return d.has(key) ? d.get(key) : undefined;
  if (typeof d !== "object") throw noAttr("get", d);
  const o = d as JsonDict;
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

/** `getattr(obj, name, default)`（python：任何非异常路径都返回值，包括数字）。 */
function pyGetattr(obj: unknown, name: string, dflt: unknown): unknown {
  if (obj === null || obj === undefined) return dflt;
  if (typeof obj !== "object" && typeof obj !== "function") return dflt;
  const v = (obj as AnyMod)[name];
  return v === undefined ? dflt : v;
}

/**
 * `obj.name` —— 直接属性读。缺名字（或 obj 根本不是对象）在 python 里是
 * AttributeError，JS 里默认是 undefined 或一条英文长句 TypeError；两者都靠这里
 * 归一到 CPython 的文案。
 */
function pyAttr(obj: unknown, name: string): unknown {
  if (obj === null || obj === undefined) throw noAttr(name, obj);
  if (typeof obj !== "object" && typeof obj !== "function") throw noAttr(name, obj);
  if (!(name in (obj as object))) throw noAttr(name, obj);
  return (obj as AnyMod)[name];
}

/** `obj.name(...)`：方法不存在时同样是 AttributeError，不是 JS 的那句 TypeError。 */
function pyMethod(obj: unknown, name: string): (...a: unknown[]) => unknown {
  const v = pyAttr(obj, name);
  if (typeof v !== "function") {
    throw new AttributeErrorP(
      `'${pyTypeName(obj)}' object has no attribute '${name}'`);
  }
  return (...a: unknown[]) => (v as (...x: unknown[]) => unknown).apply(obj, a);
}

/**
 * python `dict(x)`：映射浅拷贝、键值对序列建表，其余是"不可迭代"或"元素长度不对"。
 * 源里用于 `dict(payload.get("args") or {})`，所以 None/{} 已经被 `or` 挡掉了。
 */
function pyDictCopy(x: unknown): JsonDict {
  if (x instanceof Map) return Object.fromEntries(x as Map<string, unknown>);
  if (Array.isArray(x)) {
    const out: JsonDict = {};
    x.forEach((e, i) => {
      const pair = typeof e === "string" ? [...e] : Array.isArray(e) ? e : null;
      if (pair === null) {
        // CPython 区分两种失败：元素**根本不是序列**（int/None/bool）是 TypeError，
        // 是序列但长度不对才是 ValueError。`dict([1])` -> 前者。
        throw new TypeErrorP(
          `cannot convert dictionary update sequence element #${i} to a sequence`);
      }
      if (pair.length !== 2) {
        throw new ValueErrorP(
          `dictionary update sequence element #${i} has length ${pair.length}; 2 is required`);
      }
      out[pyStr(pair[0])] = pair[1];
    });
    return out;
  }
  if (x !== null && typeof x === "object") {
    const proto = Object.getPrototypeOf(x);
    if (proto === Object.prototype || proto === null) return { ...(x as JsonDict) };
    // python 的类实例：只有实现 keys() 或迭代出键值对才建得起来。端口的值域里
    // 到这里的只有假件，交给它自己暴露 plain object。
    return { ...(x as JsonDict) };
  }
  if (typeof x === "string") {
    // python 迭代字符串得到**单字符**，所以非空串永远在第一元素上失败。
    if (x.length === 0) return {};
    throw new ValueErrorP(
      "dictionary update sequence element #0 has length 1; 2 is required");
  }
  throw new TypeErrorP(`'${pyTypeName(x)}' object is not iterable`);
}

/** python `{**base, k: v}`：base 不是映射时 CPython 抛 `'list' object is not a mapping`。 */
function pySplat(base: unknown, extra: JsonDict): JsonDict {
  if (base instanceof Map) return { ...(Object.fromEntries(base as Map<string, unknown>)), ...extra };
  if (base === null || base === undefined || typeof base !== "object" || Array.isArray(base)) {
    throw new TypeErrorP(`'${pyTypeName(base)}' object is not a mapping`);
  }
  return { ...(base as JsonDict), ...extra };
}

/* ── python 异常镜像：一律复用单元 195 导出的那批类（异常类型也是行为） ────── */
const ImportErrorP = SUBAGENT_ERRORS.ImportErrorP;
const ModuleNotFoundErrorP = SUBAGENT_ERRORS.ModuleNotFoundErrorP;
const TimeoutErrorP = SUBAGENT_ERRORS.TimeoutErrorP;
const CancelledErrorP = SUBAGENT_ERRORS.CancelledErrorP;
const ValueErrorP = SUBAGENT_ERRORS.ValueErrorP;
const TypeErrorP = SUBAGENT_ERRORS.TypeErrorP;
const KeyErrorP = SUBAGENT_ERRORS.KeyErrorP;
const AttributeErrorP = SUBAGENT_ERRORS.AttributeErrorP;
const RuntimeErrorP = SUBAGENT_ERRORS.RuntimeErrorP;

/** 源里 `except Exception` 能抓到的那一族（不含 CancelledError）。 */
function isPyException(e: unknown): boolean {
  if (e instanceof CancelledErrorP) return false;
  return e instanceof Error;
}

export const BRIDGE_ERRORS = {
  ImportErrorP, ModuleNotFoundErrorP, TimeoutErrorP, CancelledErrorP, ValueErrorP,
  TypeErrorP, KeyErrorP, AttributeErrorP, RuntimeErrorP,
};

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

/** wait_for 的目标：协程（惰性 thunk）或 task（超时时要被顺手 cancel）。 */
type WaitTarget = (() => unknown) | SubagentTask;

function isTask(t: WaitTarget): t is SubagentTask {
  return typeof t !== "function";
}

/**
 * python `asyncio.wait_for(x, timeout=n)`。两条源里都用到：
 *   * `wait_for(stop.wait(), BRIDGE_POLL_S)` —— 协程形式
 *   * `wait_for(self._task, timeout=2.0)`   —— task 形式，**超时必须 cancel 它**
 * 超时抛 TimeoutError（空消息）。
 */
async function defaultWaitFor(target: WaitTarget, timeoutS: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let done = false;
    const settle = (fn: () => void): void => { if (!done) { done = true; fn(); } };
    const timer = setTimeout(() => {
      settle(() => {
        // CPython: wait_for 超时先取消内层 awaitable，再抛 TimeoutError。
        if (isTask(target)) target.cancel();
        reject(new TimeoutErrorP(""));
      });
    }, Math.max(timeoutS, 0) * 1000);
    (timer as unknown as { unref?: () => void }).unref?.();
    Promise.resolve().then(() => (isTask(target) ? target.join() : (target as () => unknown)())).then(
      (v) => { clearTimeout(timer); settle(() => resolve(v)); },
      (e) => { clearTimeout(timer); settle(() => reject(e)); },
    );
  });
}

/* ── python 函数局部 import 的对应物：名字表 + 缺名报错 ───────────────────── */

let _storage_ns_mod: AnyMod;
let _risk_control_ns_mod: AnyMod;
let _event_bus_ns_mod: AnyMod;

/**
 * `from X import name` 的存在性检查。缺名 -> CPython 原文案，一次只报**书写顺序里
 * 第一个**缺的名字（IMPORT_FROM 是逐名执行的）。
 */
function needAttr(mod: AnyMod, name: string, from: string): unknown {
  if (!(name in mod)) {
    const origin = typeof mod.__origin__ === "string" ? mod.__origin__ : "(unknown location)";
    throw new ImportErrorP(`cannot import name '${name}' from '${from}' (${origin})`);
  }
  return mod[name];
}

/* ── 接缝 ─────────────────────────────────────────────────────────────────── */

export const PB_SEAMS = {
  /* python `time.time()` */
  now: (): number => Date.now() / 1000,
  /* python `__import__("os").environ.get(k, d)`（只在 import 期用一次） */
  env_get: (k: string, d: unknown = undefined): unknown =>
    Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : d,
  /* python `uuid.uuid4().hex` —— 调用点自己切 [:12] */
  uuid4Hex: (): string => randomHex32(),
  /* python `asyncio.sleep` / `Event()` / `create_task` / `wait_for` */
  sleep: async (s: number): Promise<void> => {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.max(s, 0) * 1000);
      (t as unknown as { unref?: () => void }).unref?.();
    });
  },
  event: (): PyEvent => new PyEvent(),
  createTask: (fn: () => Promise<unknown>): SubagentTask => new SubagentTask(fn),
  waitFor: (target: WaitTarget, timeoutS: number): Promise<unknown> => defaultWaitFor(target, timeoutS),

  /* ── 兄弟模块装载器：python 的函数局部 import 是同步语句，故同步臂 ── */
  storageModule: (): AnyMod => _storage_ns_mod,
  riskControlModule: (): AnyMod => _risk_control_ns_mod,
  eventBusModule: (): AnyMod => _event_bus_ns_mod,
  // mailbox 是 Native→Rust：TS 侧无同名文件，缺省臂与 subagent_runtime.ts:565 一字一致。
  mailboxModule: (): AnyMod => { throw new ModuleNotFoundErrorP("No module named 'mailbox'"); },

  /* python `logging.getLogger(__name__).debug(fmt, *args)`：`%` 渲染归宿主 logger，
   * 接缝只收 (fmt, args) 两部分，不预渲染。 */
  log_debug: (fmt: string, args: unknown[]): void => { /* host logger */ },

  /* ── 本模块的可调用全局：python 侧这些名字在模块字典里，探针直接改那张表；
   *    TS 的函数绑定改不动，所以调用点过一层同名接缝（调用次数、顺序、参数一致）。 */
  bridge_box_id: (parent: unknown): string => bridge_box_id(parent),
  send_approval_request: (storage: unknown, kw: RequestKw): string =>
    send_approval_request(storage, kw),
  send_approval_response: (storage: unknown, kw: ResponseKw): unknown =>
    send_approval_response(storage, kw),
  drain_approval_requests: (storage: unknown, parent: unknown, opts?: { limit?: number }): JsonDict[] =>
    drain_approval_requests(storage, parent, opts),
  find_approval_response: (storage: unknown, child: string, req: string): Row | null =>
    find_approval_response(storage, child, req),
  wait_approval_response: (storage: unknown, child: string, req: string, timeoutS?: unknown): Promise<Row | null> =>
    wait_approval_response(storage, child, req, { timeout_s: timeoutS }),
  bridge_permission_event: (event: BridgeEvent): Promise<void> =>
    bridge_permission_event(event),
};

function randomHex32(): string {
  let s = "";
  while (s.length < 32) s += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return s.slice(0, 32);
}

/* ── 模块常量（源 20-24 行；DEFAULT_APPROVAL_TIMEOUT_S 是 import 期读环境变量） ── */

export const BRIDGE_BOX_FMT = "mailbox:bridge:{parent_session_id}";
export const BRIDGE_POLL_S: number = 0.25;
/**
 * DIVERGENCE(port): 见文件头折叠 4 —— 这一行在模块装载期执行，环境变量给一个非数字
 * 就是 `ValueError: could not convert string to float: 'abc'`，整个模块 import 失败。
 * python 完全一样，所以不做兜底。
 */
export const DEFAULT_APPROVAL_TIMEOUT_S: number = pyFloat(
  PB_SEAMS.env_get("OVOLVE_BRIDGE_APPROVAL_TIMEOUT_S", "120"),
);

/* ── bridge_box_id ────────────────────────────────────────────────────────── */

/** `BRIDGE_BOX_FMT.format(parent_session_id=str(parent_session_id or ""))`。 */
export function bridge_box_id(parent_session_id: unknown): string {
  return "mailbox:bridge:" + pyStr(pyOr(parent_session_id, ""));
}

/* ── 两条发送臂（B1/B2 的现场） ───────────────────────────────────────────── */

interface RequestKw {
  parent_session_id: unknown;
  child_session_id: unknown;
  call_id: unknown;
  tool_name: unknown;
  args: unknown;
  prompt: unknown;
}

/**
 * 源 31-60 行。
 *
 * BUG(port): 见文件头 B1/B2 —— `ORIGIN_FRAMEWORK` 这个名字在 mailbox.py 里不存在，
 *   所以这条臂在产品里必抛 ImportError；补上名字之后 `origin=` 又不是 send 的参数，
 *   改抛 TypeError。两条死路都在这一段。repro: tmp/w198_import_check.py。
 */
export function send_approval_request(storage: unknown, kw: RequestKw): string {
  const mb = PB_SEAMS.mailboxModule();
  // 绑定顺序 = 源码书写顺序；缺名只报第一个。
  const kindControl = needAttr(mb, "KIND_CONTROL", "mailbox");
  const originFramework = needAttr(mb, "ORIGIN_FRAMEWORK", "mailbox");
  const send = needAttr(mb, "send", "mailbox") as
    ((s: unknown, b: unknown, sender: unknown, opts: JsonDict) => unknown);

  const request_id = PB_SEAMS.uuid4Hex().slice(0, 12);
  send(
    storage,
    PB_SEAMS.bridge_box_id(kw.parent_session_id),
    // 源里 `child_session_id` 是 send 的第三个**位置**参数，原样递过去，不做 str()。
    kw.child_session_id,
    {
      kind: kindControl,
      origin: originFramework,
      payload: {
        type: "approval_request",
        request_id,
        call_id: kw.call_id,
        tool_name: kw.tool_name,
        args: pyOr(kw.args, {}),
        prompt: pyStr(pyOr(kw.prompt, "")).slice(0, 2000),
        child_session: kw.child_session_id,
      },
    },
  );
  return request_id;
}

interface ResponseKw {
  child_session_id: unknown;
  request_id: unknown;
  decision: unknown;
  reason?: unknown;
}

/**
 * 源 63-85 行。返回值是 mailbox 的消息 id（`return send(...)`）。
 *
 * BUG(port): 同 B1/B2 —— 与 send_approval_request 共用那条 import 语句，产品里必抛。
 */
export function send_approval_response(storage: unknown, kw: ResponseKw): unknown {
  const mb = PB_SEAMS.mailboxModule();
  const kindControl = needAttr(mb, "KIND_CONTROL", "mailbox");
  const originFramework = needAttr(mb, "ORIGIN_FRAMEWORK", "mailbox");
  const send = needAttr(mb, "send", "mailbox") as
    ((s: unknown, b: unknown, sender: unknown, opts: JsonDict) => unknown);

  return send(
    storage,
    `mailbox:${pyStr(kw.child_session_id)}`,
    "permission_bridge",
    {
      kind: kindControl,
      origin: originFramework,
      payload: {
        type: "approval_response",
        request_id: kw.request_id,
        decision: kw.decision,
        // python 的默认参数只在**没传**时生效：显式传 None 会原样进 payload。
        reason: kw.reason === undefined ? "" : kw.reason,
      },
    },
  );
}

/* ── 取件臂（这两条在产品里是**活的**：只 import 存在的名字） ──────────────── */

/** 源 88-91 行。`limit` 默认 20（注意与 mailbox.drain 自己的默认 50 不同）。 */
export function drain_approval_requests(
  storage: unknown,
  parent_session_id: unknown,
  opts: { limit?: number } = {},
): JsonDict[] {
  const mb = PB_SEAMS.mailboxModule();
  const drain = needAttr(mb, "drain", "mailbox") as
    ((s: unknown, b: unknown, o: JsonDict) => JsonDict[]);
  const limit = opts.limit === undefined ? 20 : opts.limit;
  // 源里 `return drain(...)`：原样把 mailbox 的返回交出去，不做二次物化。
  return drain(storage, PB_SEAMS.bridge_box_id(parent_session_id), { limit });
}

/** 源 94-110 行：在孩子自己的信箱里找这条 request_id 的回包，找到就 consume。 */
export function find_approval_response(
  storage: unknown,
  child_session_id: string,
  request_id: string,
): Row | null {
  const mb = PB_SEAMS.mailboxModule();
  const unread = needAttr(mb, "unread", "mailbox") as
    ((s: unknown, b: string, o: JsonDict) => Iterable<JsonDict>);
  for (const msg of unread(storage, `mailbox:${pyStr(child_session_id)}`, { limit: 50 })) {
    const payload = pyOr(dGet(msg, "payload"), {}) as Row;
    if (dGet(payload, "type") === "approval_response"
      && pyStr(pyOr(dGet(payload, "request_id"), "")) === request_id) {
      // python 把 import 写在循环体**里面**：每找一条就重新装载一次 consume。
      const mbc = PB_SEAMS.mailboxModule();
      const consume = needAttr(mbc, "consume", "mailbox") as (s: unknown, id: string) => unknown;
      consume(storage, pyStr(pyOr(dGet(msg, "id"), "")));
      return payload;
    }
  }
  return null;
}

/* ── wait_approval_response ───────────────────────────────────────────────── */

/**
 * 源 113-126 行。轮询到 deadline 为止；`timeout_s` 的默认值在**函数定义时**就固定了
 * （python 的默认参数求值一次），也就是模块常量 DEFAULT_APPROVAL_TIMEOUT_S。
 */
export async function wait_approval_response(
  storage: unknown,
  child_session_id: string,
  request_id: string,
  opts: { timeout_s?: unknown } = {},
): Promise<Row | null> {
  const timeout_s = opts.timeout_s === undefined
    ? DEFAULT_APPROVAL_TIMEOUT_S : opts.timeout_s;
  const deadline = pyFloatPlus(PB_SEAMS.now(), timeout_s);
  while (PB_SEAMS.now() < deadline) {
    const resp = PB_SEAMS.find_approval_response(storage, child_session_id, request_id);
    if (resp !== null) return resp;
    await PB_SEAMS.sleep(BRIDGE_POLL_S);
  }
  return null;
}

/* ── bridge_permission_event ──────────────────────────────────────────────── */

/** python `Event` 在本模块用到的那一面（接缝可以换成任何鸭子类型的假件）。 */
export interface BridgeEvent {
  payload: JsonDict;
  modify(newPayload: JsonDict): void;
}

const _APPROVE_WORDS: readonly string[] = ["approve", "approve_always", "allow"];

/**
 * 源 129-160 行：event_bus 的 `permission_request` 钩子真正干活的地方。
 *
 * BUG(port): `send_approval_request`（源 145 行）**不在** try 里 —— 138-143 的
 *   `try/except Exception` 只包住 `from storage import get_storage`。所以 B1 那条
 *   ImportError 会原样冒出这个协程，把 `bus.emit("permission_request", ...)` 炸掉。
 *   逐字保留：端口同样不在这里兜。
 */
export async function bridge_permission_event(event: BridgeEvent): Promise<void> {
  const payload = pyOr(pyAttr(event, "payload"), {}) as Row;
  const context = pyOr(dGet(payload, "context"), {}) as Row;
  // python `a or b or ""`：第二个 get 只在第一个为假时求值。
  const first = dGet(context, "leader_endpoint");
  const second = pyTruth(first) ? undefined : dGet(context, "parent_session_id");
  const leader = pyStr(pyOr(pyOr(first, second), ""));
  const childSession = pyStr(pyOr(dGet(context, "session_id"), ""));
  if (!pyTruth(leader) || !pyTruth(childSession)) return;

  let storage: unknown;
  try {
    const stMod = PB_SEAMS.storageModule();
    const getStorage = needAttr(stMod, "get_storage", "storage") as () => unknown;
    storage = getStorage();
  } catch (e) {
    if (!isPyException(e)) throw e;
    // 源: except Exception: event.modify({**payload, "hook_decision": "deny"}); return
    pyMethod(event, "modify")(pySplat(payload, { hook_decision: "deny" }));
    return;
  }

  const request_id = PB_SEAMS.send_approval_request(storage, {
    parent_session_id: leader,
    child_session_id: childSession,
    call_id: pyStr(pyOr(dGet(payload, "call_id"), "")),
    tool_name: pyStr(pyOr(dGet(payload, "tool_name"), "")),
    args: pyDictCopy(pyOr(dGet(payload, "args"), {})),
    prompt: pyStr(pyOr(dGet(payload, "reason"), "")),
  });
  const resp = await PB_SEAMS.wait_approval_response(storage, childSession, request_id);
  if (resp === null) {
    pyMethod(event, "modify")(pySplat(payload, { hook_decision: "deny" }));
    return;
  }
  const decision = pyStr(pyOr(dGet(resp, "decision"), "deny")).toLowerCase();
  const hook = _APPROVE_WORDS.includes(decision) ? "allow" : "deny";
  pyMethod(event, "modify")(pySplat(payload, { hook_decision: hook }));
}

/* ── LeaderBridgeHost ─────────────────────────────────────────────────────── */

/**
 * 源 163-258 行：父亲侧的轮询器，把桥里的 approval_request 转给 risk_control
 * （有既有授权就直接 approve，没有就记进父会话的待答队列等 UI 回答）。
 *
 * BUG(port): `_handle_request` 末尾那句 send_approval_response 必抛（B1），而它在
 *   `_loop` 的宽吞**之内** —— 于是每条请求的真实下场是"被消费 + 被记成 pending +
 *   回包抛错 + 一行 debug 日志"，孩子只能等超时 deny。repro: tmp/w198_import_check.py。
 */
export class LeaderBridgeHost {
  parent_session_id: unknown;
  auto_approve: unknown;
  _task: SubagentTask | null;
  _stop: PyEvent;

  constructor(parent_session_id: unknown, opts: { auto_approve?: unknown } = {}) {
    this.parent_session_id = parent_session_id;
    this.auto_approve = opts.auto_approve === undefined ? false : opts.auto_approve;
    this._task = null;
    this._stop = PB_SEAMS.event();
  }

  /**
   * 源 172-175 行。python 里 `self._loop()` 只是**创建协程**，函数体一行都没跑；
   * `create_task` 也只是排期。DIVERGENCE(port): 所以这里传 thunk 给接缝，由它
   * 在真正起跑的那一刻调用（SubagentTask 的镜像已经在单元 195 验过）。
   */
  async start(): Promise<void> {
    if (this._task === null) {
      this._stop.clear();
      this._task = PB_SEAMS.createTask(() => this._loop());
    }
  }

  /** 源 177-184 行。`if self._task:` 判的是 task 对象的真值（永远为真），不是 done()。 */
  async stop(): Promise<void> {
    this._stop.set();
    if (pyTruth(this._task)) {
      const t = this._task as SubagentTask;
      try {
        await PB_SEAMS.waitFor(t, 2.0);
      } catch (e) {
        if (e instanceof TimeoutErrorP || e instanceof CancelledErrorP) {
          t.cancel();
        } else throw e;
      }
      this._task = null;
    }
  }

  /** 源 186-201 行。 */
  async _loop(): Promise<void> {
    let storage: unknown;
    try {
      const stMod = PB_SEAMS.storageModule();
      const getStorage = needAttr(stMod, "get_storage", "storage") as () => unknown;
      storage = getStorage();
    } catch (e) {
      if (!isPyException(e)) throw e;
      return;                       // 源: except Exception: return（不打日志）
    }
    while (!this._stop.is_set()) {
      try {
        for (const msg of PB_SEAMS.drain_approval_requests(storage, this.parent_session_id)) {
          await this._handle_request(storage, msg);
        }
      } catch (e) {
        if (!isPyException(e)) throw e;
        PB_SEAMS.log_debug("[permission_bridge] poll error: %s", [e]);
      }
      try {
        await PB_SEAMS.waitFor(() => this._stop.wait(), BRIDGE_POLL_S);
      } catch (e) {
        if (e instanceof TimeoutErrorP) { /* pass */ } else throw e;
      }
    }
  }

  /** 源 203-240 行。 */
  async _handle_request(storage: unknown, msg: JsonDict): Promise<void> {
    const payload = pyOr(dGet(msg, "payload"), {}) as Row;
    if (dGet(payload, "type") !== "approval_request") return;
    // 源 207 行 `payload.get("child_session") or msg.get("sender") or ""`：
    // 后一个 get 只在前一个为假时求值。
    const cs = dGet(payload, "child_session");
    const sender = pyTruth(cs) ? undefined : dGet(msg, "sender");
    const childSession = pyStr(pyOr(pyOr(cs, sender), ""));
    const requestId = pyStr(pyOr(dGet(payload, "request_id"), ""));
    const toolName = pyStr(pyOr(dGet(payload, "tool_name"), ""));
    const args = pyDictCopy(pyOr(dGet(payload, "args"), {}));
    const callId = pyStr(pyOr(dGet(payload, "call_id"), ""));

    let decision = "deny";
    if (pyTruth(this.auto_approve)) {
      decision = "approve";
    } else {
      try {
        const rc = PB_SEAMS.riskControlModule();
        const getRisk = needAttr(rc, "get_risk_controller", "risk_control") as () => unknown;
        const risk = getRisk() as unknown;
        const hasGrant = pyMethod(risk, "has_grant");
        if (pyTruth(hasGrant(toolName, args, { session_id: this.parent_session_id }))) {
          decision = "approve";
        } else {
          // 转进父会话的待答队列 —— 用户在父 UI 上答。
          pyMethod(risk, "record_pending")(
            pyOr(callId, requestId) as string,
            toolName,
            args,
            // python 的 `or`：prompt 为假时才构造这句默认文案（f-string 里的中文逐字搬）。
            pyStr(pyOr(dGet(payload, "prompt"), `子代理请求: ${toolName}`)),
            this.parent_session_id,
          );
          return;                   // 等 resolve_pending 显式回答，这里不回包
        }
      } catch (e) {
        if (!isPyException(e)) throw e;
        decision = "deny";
      }
    }

    PB_SEAMS.send_approval_response(storage, {
      child_session_id: childSession,
      request_id: requestId,
      decision,
    });
  }

  /**
   * 源 242-258 行：父 UI 答完之后回填。
   *
   * BUG(port): B3 —— send_approval_response 必抛，`return True` 在产品里永不可达。
   *   `request_id or call_id`：没给 request_id 时拿 call_id 当回包 id。
   */
  resolve_pending(
    storage: unknown,
    kw: { call_id: unknown; decision: unknown; child_session_id?: unknown; request_id?: unknown },
  ): boolean {
    PB_SEAMS.send_approval_response(storage, {
      // python 的默认参数 `child_session_id: str = ""` 只在没传时生效。
      child_session_id: kw.child_session_id === undefined ? "" : kw.child_session_id,
      request_id: pyOr(kw.request_id, kw.call_id),
      decision: kw.decision,
    });
    return true;
  }
}

/* ── install_worker_bridge_hook ───────────────────────────────────────────── */

/**
 * 源 261-283 行：在孩子进程里挂 `permission_request` 钩子（幂等：靠 bus 上的
 * `_ovolve_bridge_hook_installed` 标记）。
 *
 * python 把整个函数体（除了最前面那句 `if not leader_endpoint: return`）包在
 * `try/except Exception` 里，所以 permission_bridge 缺 event_bus 只会留一行 debug。
 * 单元 197 的 `_install_permission_bridge` 没有这层保护，抛出去就是 worker 整死 ——
 * 两侧的差异都在端口里逐字保留。
 */
export function install_worker_bridge_hook(leader_endpoint: unknown): void {
  if (!pyTruth(leader_endpoint)) return;
  try {
    const ebMod = PB_SEAMS.eventBusModule();
    const getBus = needAttr(ebMod, "get_event_bus", "event_bus") as () => unknown;
    const bus = getBus() as AnyMod;
    if (pyTruth(pyGetattr(bus, "_ovolve_bridge_hook_installed", false))) return;

    // python 的闭包 `async def _hook(event)`：源 272-278 行的**三步**都在这一个函数里
    // —— 补 context.leader_endpoint、把 payload 整个换掉、再走模块全局查表的
    // bridge_permission_event（探针正是改那张表来驱动它，TS 侧过一层同名接缝）。
    const hook = function _hook(event: BridgeEvent): Promise<unknown> {
      return (async (): Promise<void> => {
        const ctx = pyOr(dGet(pyOr(pyAttr(event, "payload"), {}), "context"), {}) as JsonDict;
        if (!pyTruth(dGet(ctx, "leader_endpoint"))) {
          // 外层 dict 先建，再算内层 —— CPython 按字面量从左到右求值，
          // 两个 splat 各自都可能抛 `'list' object is not a mapping`。
          const outer = pySplat(pyOr(pyAttr(event, "payload"), {}), {}) as JsonDict;
          outer["context"] = pySplat(ctx, { leader_endpoint });
          (event as AnyMod)["payload"] = outer;
        }
        await PB_SEAMS.bridge_permission_event(event);
      })();
    };

    // DIVERGENCE(port): python 的 `priority=100` 关键字在这里是形参位置
    // （RULEBOOK §2：kwargs -> 被调方的位置序）；假件两边都按 kwargs 记一行。
    pyMethod(bus, "on")("permission_request", hook, 100);
    bus["_ovolve_bridge_hook_installed"] = true;
  } catch (e) {
    if (!isPyException(e)) throw e;
    PB_SEAMS.log_debug("[permission_bridge] hook install failed: %s", [e]);
  }
}

/* ── 静态 import 的名字表句柄 ─────────────────────────────────────────────── */
// 放在文件末尾是因为 `import * as` 会被提升到顶部；这里只是把它们交给接缝，
// 让探针能整表替换（python 侧对应 sys.modules 打补丁）。
import * as _storage_ns from "./storage.js";
import * as _risk_control_ns from "./risk_control.js";
import * as _event_bus_ns from "./event_bus.js";

_storage_ns_mod = _storage_ns as AnyMod;
_risk_control_ns_mod = _risk_control_ns as AnyMod;
_event_bus_ns_mod = _event_bus_ns as AnyMod;

// PORT STATUS: confidence=high todos=[0]
