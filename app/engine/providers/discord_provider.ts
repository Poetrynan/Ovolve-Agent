/**
 * providers/discord_provider.ts — Discord Gateway IMProvider。
 *
 * 源：app/backend/providers/discord_provider.py（216 行）。
 * 单元 204 / wave-9，manifest.tsv target=TS。Providers 家族成员，基座为
 * providers/common.ts（Unit 202，已落地，静态 import，不重复其 helper）。
 *
 * 与源 docstring 一致的定位：Discord 没有 long-polling 等价物，一个不想暴露公网
 * HTTPS 端点又要"收消息"的机器人只能常驻 Gateway WebSocket。本端口因此直说
 * Gateway 协议 —— HELLO / IDENTIFY / heartbeat / MESSAGE_CREATE —— 并用普通
 * REST 发送。文件里没有 webhook 验签、没有 embed 构造、没有平台专有 markdown
 * 包装：源的全部出站富化就是 BaseProvider.split() 的 2000 码点分块 +
 * `{"content": chunk}` 这个最小 body，入站全部是 Gateway 帧状态机。
 *
 * ── 接缝（红线5：HTTP / WebSocket / 事件循环 / print 全部隔离）──
 * REST 复用基座 CP_SEAMS.fetch（providers/common.ts），本文件不重复声明；
 * DC_SEAMS 补源里其余的五个宿主触点：
 *   - print:      `print(f"[discord] gateway error: {exc}")`（源的网关错误只打
 *                 stdout，没有 logger——原样保留）。默认 console.log。
 *   - sleep:      asyncio.sleep(seconds)（重连退避 + heartbeat 节拍）。
 *                 默认 setTimeout .promise；探针替换为"记录且立即返回"的假件。
 *   - createTask: asyncio.create_task(coro)（_gateway_loop / _heartbeat）。
 *                 默认立即启动 thunk 并返回 PromiseLike 句柄；探针替换为
 *                 *惰性* 句柄（见 DIVERGENCE 2/3），使 pump 场景恒为单任务。
 *   - newSession: aiohttp.ClientSession()（源在 _gateway_loop 里"函数级 import
 *                 aiohttp"后使用；TS 无对应物，注入点即接缝）。返回的假 session
 *                 提供 ws_connect(url, heartbeat=None)、closed、close()。
 *                 Python 侧对应在 sys.modules 里塞假 aiohttp（探针用 _Blocker
 *                 保证真 aiohttp 永不被解析）。
 *   - importAiohttp: `_gateway_loop` 函数体第一句 `import aiohttp`（在 try 之外，
 *                 见 D13）。默认空操作；探针把"真 aiohttp 不存在"这一事实表达为
 *                 该接缝抛 ModuleNotFoundError，两侧的假 aiohttp 场景由 newSession
 *                 的正常实现覆盖，两个维度可独立编排。
 * CPython 语义层（本文件自带，仓库惯例见 HANDOFF_V10 §5）：pyTruthy / dictGet /
 * pyAttr / pyStrip / pyStr / pyRepr / pyFloat / pyEq / pyJsonLoads /
 * pyDecodeUtf8Strict —— 与基座同名 helper 是 private 不可复用，逐字复刻。
 *
 * ── 源自带缺陷（bug-for-bug 原样保留，不修）──
 *  D1  _pump：`json.loads` 成功但结果不是 dict（`null` / `5` / `"str"` / `[1,2]`）
 *      时原样交给 _on_frame，`frame.get` 抛 AttributeError 冲出 _pump；
 *      在 _gateway_loop 里被 `except Exception` 吞成一行 print，随后断开重连——
 *      一条"毒帧"会让机器人无限重连，永远读不到后面的消息。
 *  D2  _pump：非 TEXT/BINARY 帧与 `self._running` 为假一样走 break（静默结束
 *      读取），不报错、不重连——CLOSE 帧只是让 _gateway_loop 的退避分支接手。
 *  D3  _on_frame：`frame.get("d", {}).get(...)` 只对"缺 d"宽容；
 *      `"d": null` / `"d": "s"` / `"d": [..]` 一律 AttributeError（冲出到 D1
 *      同一吞异常路径）。`heartbeat_interval` 显式为 null 时 float(None) 抛
 *      TypeError；不可 float 的字符串抛 ValueError——均未捕获。
 *  D4  _on_frame 用 `== 10` / `== 0` / `op in (7, 9)` 比较：JSON 里的 `"10"`
 *      （字符串 op）匹配不到任何分支，帧被静默丢弃；缺失 op 同理。
 *  D5  stop_listening 只 `except asyncio.CancelledError`：若被 await 的任务是
 *      以*其他*异常结束的，异常直接冲出 stop_listening，导致
 *      `self._hb_task = self._task = None`、`_close_ws()`、`_controller = None`
 *      全部没执行——socket/session 泄漏，监听句柄仍挂着。
 *  D6  _gateway_url：`str(r.value.get("url") or "")` 不做类型检查，
 *      `{"url": 123}` 会连到 `123/?v=10&encoding=json`；响应非 JSON / HTTP 失败
 *      静默回落文档默认主机，日志里没有任何提示。
 *  D7  send_message：`user_id` 原样插进 URL 路径，无 percent-encoding（含
 *      `/`、`?`、空格的 id 会改写请求目标）；`if not content.strip(): return True`
 *      把纯空白视为"已发送成功"；分块循环即使某块失败也继续 POST 剩余块。
 *  D8  _on_message：`str(data.get("content") or "")` 使 falsy 的非字符串 content
 *      （0 / False / [] / ""）变成空串而整条消息被丢弃；`{"a": 1}` 这类真值容器
 *      却会被 str() 成 Python repr 继续路由。
 *  D9  _close_ws：`getattr(obj, "closed", True)` ——没有 `closed` 属性的对象被
 *      当作"已关闭"而永不 close（静默泄漏），且 close() 抛错被 `except Exception`
 *      吞掉。
 *  D10 _heartbeat：`except Exception: pass` 吞掉一切（含 send 失败），心跳任务
 *      静默死亡，socket 既不关闭也不重连，只能等 Discord 自己超时踢。
 *  D11 _gateway_loop 每轮都新建 ClientSession，_close_ws 之后旧 session 才被关；
 *      `except CancelledError: raise` 之后 finally 仍会跑 _close_ws（顺序固定）。
 *  D12 _close_ws 的 `except Exception` 覆盖面：asyncio.CancelledError 自 3.8 起
 *      继承 BaseException，因此**不**被吞——取消异常会从 _close_ws 直冲出去，
 *      连带跳过末尾的 `self._ws = self._session = None`（句柄残留）。端口显式
 *      复刻这条逃逸（不是修 bug，是复刻源行为）。
 *  D13 `import aiohttp` 写在 `_gateway_loop` 函数体第一句、try 之外：本地导入
 *      失败（ModuleNotFoundError）不经过 `except Exception`，既不 print 也不
 *      退避重试，任务直接以未检索异常死掉；stop_listening 又因为
 *      `task.done() == True` 而不会 await 它，于是整个监听器静默消失。
 *  D14 `_heartbeat` 的 docstring 说"首个 beat 按 Discord 建议做了抖动(jitter)"，
 *      代码里却是固定的 `interval * 0.5`——没有任何随机数。一整批同时重启的
 *      机器人仍然会在同一个 tick 上敲打网关（Discord 文档明确反对的做法）。
 *
 * ── 基座（Unit 202 providers/common.ts，已冻结盖章）已知瑕疵，非本单元范围 ──
 *  B1 基座 cfg() 用 `this._config[key]` 而非 python 的 `self._config.get(key)`：
 *      存储侧返回非映射（str/list）的 config 时，python 在构造期抛
 *      AttributeError，基座端口静默回落 ""。
 *  B2 基座 pyStr() 渲染容器时对元素用 pyStr 而非 pyRepr：
 *      `cfg("bot_token")` 遇 list 值得到 "[a, b]" 而非 "['a', 'b']"。
 *  两条均位于基座实现内部、与本文件的 .py 源无关；修正需改动冻结单元，故
 *  本单元场景表不生成经由 Discord 构造器探测基座内部语义的用例（数值/布尔/
 *  null 型 bot_token 等两侧一致的用例保留），瑕疵已上报 lead。端口自身的
 *  pyStr/pyRepr（本文件私有实现）语义完全正确，D8 相关用例可见其牙。
 *
 * ── DIVERGENCE(port) ──
 *  1. aiohttp → 接缝：REST 走基座 CP_SEAMS.fetch（与 Unit 202 D1 同源），
 *     WebSocket 走 DC_SEAMS.newSession()/session.ws_connect()。等价性：探针只
 *     检验构建出的 URL、headers、body JSON、IDENTIFY/heartbeat 帧与状态解析，
 *     传输层（真 socket、真 HTTP）差异不可观测。
 *  2. `asyncio.create_task` → `DC_SEAMS.createTask(thunk)`：JS promise 不可
 *     中断，故 cancel() 只做"标记 + 置 done"，真正的停止靠源里已有的协作检查
 *     （`while self._running` 与 `not ws.closed`）。等价性：源 stop_listening
 *     的第一句就是 `self._running = False`，两侧运行时循环退出的*原因*相同；
 *     `task.done()` / `await task` 的可观测语义（完成/取消/异常上抛）由探针的
 *     脚本化句柄钉死，两侧逐行一致。
 *  3. 调度点：CPython 的 `await coro`（协程内无挂起）不会让出事件循环，而 JS 的
 *     `await` 恒让出一个微任务。为避免把"调度器微结构"当成被测行为，端口与
 *     探针统一约定：**任何时刻至多一个 unit 任务在跑**——_gateway_loop、_pump、
 *     _on_frame、_heartbeat 都由探针直接 await；createTask 接缝在 pump/loop
 *     场景里只登记不启动（heartbeat 体在专门的 heartbeat 场景里直接驱动）。
 *     因此两侧账本行序由源码控制流唯一决定，与语言运行时无关。
 *  4. `json.loads(msg.data)`：CPython 接受 bytes 与裸 NaN/Infinity/-Infinity
 *     字面量；V8 JSON.parse 只吃 JS 字符串。CPython 的 bytes 分支是
 *     `s.decode(detect_encoding(s), 'surrogatepass')`（json/__init__.py:347；
 *     detect_encoding 见同文件 248-275 行）：先按 BOM/零字节模式嗅探
 *     utf-32/utf-16/utf-8-sig/utf-8，再按嗅得编码以 surrogatepass 解码；
 *     解码所得字符串的非法 JSON（含 BOM-only 帧解出空串）抛
 *     JSONDecodeError——被 `except (json.JSONDecodeError, TypeError):
 *     continue` 吞掉；而解码本身的 UnicodeDecodeError 会逃逸（源行为，两侧
 *     一致）。端口逐字复刻 detect_encoding 与各编码的 surrogatepass 解码。
 *     utf-8 分支的 UnicodeDecodeError 消息语法按 3.13 实测逐字符对齐
 *     （见 tmp/w204_utf8_probe.txt）；utf-16/utf-32 分支的消息文本只有在
 *     "坏 bytes 帧进入 _gateway_loop 的 print" 时才进账本，场景表的 bytes
 *     夹具全部放在 pump 场景（异常只记类型名），该路径不可达；类型名在
 *     一切输入上严格一致。唯一残留差异：帧体恰为裸 NaN/Infinity 字面量时
 *     CPython 解析成功并崩在 D1/D3 路径，V8 则 continue；该报文不是
 *     Discord 会发的东西，场景表不生成，差异不可达。
 *  5. 数字 str()/f-string 渲染：CPython 区分 int 与 float（`str(5.0)`="5.0"），
 *     JS 只有一个 number。经由 `str(...)`/f-string 落到面值上的数字在场景表里
 *     恒为整数或字符串（Discord 的 id 在 API 里本来就是 JSON 字符串），
 *     差异不可达；同理 JSON 整数超过 2**53 的精度差异也不可达（id 用字符串）。
 *  6. float() 的 Unicode 数字（全角/`１２３`）：CPython 接受，本文件 pyFloat
 *     只认 ASCII 语法；Gateway JSON 的 heartbeat_interval 恒为 ASCII，场景表
 *     覆盖 ASCII 全集语法（符号/下划线/小数/指数/inf/nan/空白）。
 *  7. `msg.type.name` 的属性访问：端口用 pyAttr 复刻 CPython AttributeError
 *     的类型名与文案（假帧对象两侧同名 WSMessage）；dict/list/None 上的
 *     `.get` 由 dictGet 复刻。
 *  8. str(dict) 的键序：CPython 保插入序，JS 把"整数样字符串键"提前。本文件
 *     str() 到的 dict 只可能是 D8 场景里的 content 容器，场景表不注入数字样键。
 *
 * PORT STATUS: confidence=high todos=0
 */

import { BaseProvider } from "./common.js";
import type { ProviderControllerLike } from "./common.js";

/* ════════════════════════════════════════════════════════════════════
 * Seams（红线5：WebSocket / 事件循环 / print 隔离；REST 走基座 CP_SEAMS）
 * ════════════════════════════════════════════════════════════════════ */

/** aiohttp WSMessage 的鸭子契约（type 是 WSMsgType 枚举，type.name 为字符串）。 */
export interface GatewayFrameMessage {
  readonly type: unknown;
  readonly data: unknown;
}

/** aiohttp ClientWebSocketResponse 的鸭子契约（async with + async for）。 */
export interface GatewaySocketLike {
  send_json(payload: unknown): Promise<void>;
  close(): Promise<void>;
  readonly closed: boolean;
  [Symbol.asyncIterator](): AsyncIterator<GatewayFrameMessage>;
}

/** aiohttp ClientSession 的鸭子契约。 */
export interface GatewaySessionLike {
  ws_connect(url: string, opts: { heartbeat: null }): Promise<GatewaySocketLike>;
  close(): Promise<void>;
  readonly closed: boolean;
}

/**
 * python `asyncio.Task` 的鸭子契约：`await task` / `task.done()` / `task.cancel()`。
 * PromiseLike 让 JS 侧也能直接 `await task`（与源写法同形）。
 */
export interface TaskLike extends PromiseLike<void> {
  done(): boolean;
  cancel(): void;
}

export interface DiscordSeams {
  /** 取代 print()：一行用户可见输出（源的网关错误只进 stdout）。 */
  print: (line: string) => void;
  /** 取代 asyncio.sleep(seconds)。 */
  sleep: (seconds: number) => Promise<void>;
  /** 取代 asyncio.create_task(coro)。 */
  createTask: (thunk: () => Promise<unknown>) => TaskLike;
  /** 取代 aiohttp.ClientSession()。 */
  newSession: () => GatewaySessionLike;
  /**
   * 取代 `_gateway_loop` 函数体第一句的 `import aiohttp`（注意：它位于
   * try/except 之外，见文件头 D13）。默认实现是空操作 —— 能走到这里说明
   * `require_aiohttp()` 已经证明本运行时可导入 aiohttp。
   */
  importAiohttp: () => void;
}

function seamSleep(seconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, seconds) * 1000);
  });
}

/** 默认任务句柄：立即启动（JS 无协程中断，见文件头 DIVERGENCE 2）。 */
class EagerTask implements TaskLike {
  private _done = false;
  private _cancelled = false;
  private readonly _promise: Promise<void>;

  constructor(thunk: () => Promise<unknown>) {
    this._promise = (async () => {
      await thunk();
    })().then(
      () => {
        this._done = true;
      },
      (err: unknown) => {
        this._done = true;
        throw err;
      },
    );
    // 默认实现的 unhandled-rejection 抑制：句柄被 await 之前不要炸掉进程。
    this._promise.catch(() => undefined);
  }

  done(): boolean {
    return this._done;
  }

  cancel(): void {
    this._cancelled = true;
    this._done = true;
  }

  get cancelled(): boolean {
    return this._cancelled;
  }

  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this._promise.then(onfulfilled, onrejected);
  }
}

class DefaultSession implements GatewaySessionLike {
  closed = false;

  async ws_connect(url: string, _opts: { heartbeat: null }): Promise<GatewaySocketLike> {
    throw new RuntimeErrorP(`no aiohttp in this runtime: cannot open ${url}`);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export const DC_SEAMS: DiscordSeams = {
  print: (line: string) => {
    console.log(line);
  },
  sleep: seamSleep,
  createTask: (thunk: () => Promise<unknown>) => new EagerTask(thunk),
  newSession: () => new DefaultSession(),
  importAiohttp: () => {
    /* 默认无操作：走到这里意味着 require_aiohttp() 已判定可导入。 */
  },
};

/** 探针注入入口（与 common.ts 的 _set_seams_for_parity 同模式）。 */
export function _set_seams_for_parity(overrides: Partial<DiscordSeams>): void {
  Object.assign(DC_SEAMS, overrides);
}

/* ════════════════════════════════════════════════════════════════════
 * Python 语义辅助（本文件自带；基座同类 helper 是 private，不可复用）
 * ════════════════════════════════════════════════════════════════════ */

class ValueErrorP extends Error {
  constructor(m: string) {
    super(m);
    (this as { pyMsg?: string }).pyMsg = m;
    this.name = "ValueError";
  }
}
class TypeErrorP extends Error {
  constructor(m: string) {
    super(m);
    (this as { pyMsg?: string }).pyMsg = m;
    this.name = "TypeError";
  }
}
class AttributeErrorP extends Error {
  constructor(m: string) {
    super(m);
    (this as { pyMsg?: string }).pyMsg = m;
    this.name = "AttributeError";
  }
}
class RuntimeErrorP extends Error {
  constructor(m: string) {
    super(m);
    (this as { pyMsg?: string }).pyMsg = m;
    this.name = "RuntimeError";
  }
}
/** json.JSONDecodeError（CPython 里是 ValueError 子类；本文件只按类型名判定）。 */
class JSONDecodeErrorP extends Error {
  constructor(m: string) {
    super(m);
    (this as { pyMsg?: string }).pyMsg = m;
    this.name = "JSONDecodeError";
  }
}
class UnicodeDecodeErrorP extends Error {
  constructor(m: string) {
    super(m);
    (this as { pyMsg?: string }).pyMsg = m;
    this.name = "UnicodeDecodeError";
  }
}
/**
 * 导出原因：这是跨边界异常（取消）的判定类型，探针必须能从模块外构造它才能
 * 驱动 `except asyncio.CancelledError: raise` 这条真实路径；导出只扩大可见性，
 * 不改变任何运行时行为。
 */
export class CancelledErrorP extends Error {
  /** python `str(asyncio.CancelledError())` 是空串。 */
  constructor(m = "") {
    super(m);
    (this as { pyMsg?: string }).pyMsg = m;
    this.name = "CancelledError";
  }
}
export class ConnectionResetErrorP extends Error {
  constructor(m: string) {
    super(m);
    (this as { pyMsg?: string }).pyMsg = m;
    this.name = "ConnectionResetError";
  }
}

/** python type(x).__name__ 在本文件取值域内的等价物。 */
function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (typeof v === "object") {
    const ctor = (v as { constructor?: { name?: string } }).constructor;
    if (ctor && ctor.name && ctor.name !== "Object") return ctor.name;
    return "dict";
  }
  return typeof v;
}

/**
 * python truthiness。注意：CPython bool(float('nan')) 为 True（NaN != 0），
 * 与 JS 的 Boolean(NaN)===false 相反；±Infinity 同样为 True。本文件把 NaN
 * 判为真值以对齐 CPython（`if not text:` 之类在 NaN 上两侧一致）。
 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}

/** python `a is not None`。 */
function pyIsNotNone(v: unknown): boolean {
  return v !== null && v !== undefined;
}

/** isinstance(v, dict)：JSON 解析产物视角的"映射"。 */
function isDict(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * python `obj.get(key, default)`：obj 非映射时抛 AttributeError
 * （`'str' object has no attribute 'get'`），复刻源缺陷 D1/D3 的崩溃面。
 * present-but-null 返回 null，不是 default。
 */
function dictGet(obj: unknown, key: string, defaultValue: unknown = null): unknown {
  if (!isDict(obj)) {
    throw new AttributeErrorP(
      `'${pyTypeName(obj)}' object has no attribute 'get'`,
    );
  }
  return key in obj ? obj[key] : defaultValue;
}

/**
 * python `obj.<name>` / `getattr(obj, name)`：属性不存在（或宿主非对象）时抛
 * AttributeError，文案与 CPython 同形（`'WSMessage' object has no attribute
 * 'name'`）。用于 `msg.type.name` / `msg.data`。
 */
function pyAttr(obj: unknown, name: string): unknown {
  if (obj === null || obj === undefined) {
    throw new AttributeErrorP(`'NoneType' object has no attribute '${name}'`);
  }
  if (typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    if (name in rec && rec[name] !== undefined) return rec[name];
  }
  throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute '${name}'`);
}

/** python `getattr(obj, name, default)`：obj 为 None 时直接返回 default。 */
function pyGetAttr(obj: unknown, name: string, defaultValue: unknown): unknown {
  if (obj === null || obj === undefined) return defaultValue;
  if (typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    if (name in rec && rec[name] !== undefined) return rec[name];
  }
  return defaultValue;
}

/** CPython str.strip() 的空白集（含 \x1c-\x1f、\x85；不含 \u200b/\ufeff）。 */
function pyIsSpace(ch: string): boolean {
  switch (ch) {
    case "\t": case "\n": case "\v": case "\f": case "\r": case " ":
    case "\x1c": case "\x1d": case "\x1e": case "\x1f":
    case "\x85": case "\xa0": case "\u1680":
    case "\u2000": case "\u2001": case "\u2002": case "\u2003":
    case "\u2004": case "\u2005": case "\u2006": case "\u2007":
    case "\u2008": case "\u2009": case "\u200a":
    case "\u2028": case "\u2029": case "\u202f": case "\u3000":
      return true;
    default:
      return false;
  }
}

/** python str.strip()（码点安全）。 */
function pyStrip(s: string): string {
  const cps = Array.from(s);
  let a = 0;
  let b = cps.length;
  while (a < b && pyIsSpace(cps[a] as string)) a++;
  while (b > a && pyIsSpace(cps[b - 1] as string)) b--;
  return cps.slice(a, b).join("");
}

/** python repr(str) 的引号选择与转义。 */
function pyStrRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch === quote ? `\\${quote}` : ch;
  }
  return `${quote}${out}${quote}`;
}

/** Python float repr：最短往返 + 指数格式（1e+20 / 1e-05，指数两位带符号）。 */
function pyFloatRepr(f: number): string {
  if (Object.is(f, -0)) return "-0.0";
  const abs = Math.abs(f);
  if (abs !== 0 && (abs >= 1e16 || abs < 1e-4)) {
    const parts = f.toExponential().split("e");
    const exp = parseInt(parts[1] ?? "0", 10);
    const sign = exp < 0 ? "-" : "+";
    const digits = Math.abs(exp).toString().padStart(2, "0");
    return `${parts[0] ?? String(f)}e${sign}${digits}`;
  }
  return String(f);
}

/** python str(x) / f"{x}"。容器元素用 repr（与 CPython 一致）。 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  }
  if (typeof v === "string") return v;
  return pyRepr(v);
}

/** python repr(x)：容器递归用 repr；str 加引号。 */
function pyRepr(v: unknown): string {
  if (typeof v === "string") return pyStrRepr(v);
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (isDict(v)) {
    const parts = Object.entries(v).map(([k, val]) => `${pyStrRepr(k)}: ${pyRepr(val)}`);
    return "{" + parts.join(", ") + "}";
  }
  return pyStr(v);
}

/**
 * python float(x)：bool→0.0/1.0；number 直传；str 走 ASCII 语法
 * （空白、符号、小数、指数、inf/infinity/nan 大小写不敏感、下划线分隔）。
 * 其余类型 TypeError，文案对齐 CPython 3.13（`float() argument must be a
 * string or a real number, not 'NoneType'`）。
 */
function pyFloat(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = pyStrip(v);
    const sign = /^[+-]/u.test(t) ? (t.startsWith("-") ? -1 : 1) : 1;
    const body = /^[+-]/u.test(t) ? t.slice(1) : t;
    const lower = body.toLowerCase();
    if (lower === "inf" || lower === "infinity") return sign * Infinity;
    if (lower === "nan") return NaN;
    if (
      /^(?:0|[1-9](?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?(?:[eE][+-]?\d+)?$/u.test(body) ||
      /^\.(?:\d(?:_?\d)*)?(?:[eE][+-]?\d+)?$/u.test(body)
    ) {
      const cleaned = body.replace(/_/g, "");
      if (/\d/u.test(cleaned)) return sign * Number(cleaned);
    }
    throw new ValueErrorP(`could not convert string to float: ${pyStrRepr(v)}`);
  }
  throw new TypeErrorP(
    `float() argument must be a string or a real number, not '${pyTypeName(v)}'`,
  );
}

/** python `a == b`（JSON 取值域内）：bool 与 int 互通，容器深比较，NaN 自反为假。 */
function pyEq(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return a === null || a === undefined;
  const na = typeof a === "boolean" ? (a ? 1 : 0) : a;
  const nb = typeof b === "boolean" ? (b ? 1 : 0) : b;
  if (typeof na === "number" && typeof nb === "number") {
    if (Number.isNaN(na) || Number.isNaN(nb)) return false;
    return na === nb;
  }
  if (typeof na === "string" && typeof nb === "string") return na === nb;
  if (Array.isArray(na) && Array.isArray(nb)) {
    if (na.length !== nb.length) return false;
    return na.every((x, i) => pyEq(x, nb[i]));
  }
  if (isDict(na) && isDict(nb)) {
    const ka = Object.keys(na);
    const kb = Object.keys(nb);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in nb && pyEq(na[k], nb[k]));
  }
  return false;
}

/** python `x in (a, b, ...)` / `x not in (...)`。 */
function pyIn(x: unknown, items: unknown[]): boolean {
  return items.some((it) => pyEq(x, it));
}

/** python str(exc)：Error 取 message。 */
function pyExcStr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return pyStr(e);
}

/**
 * CPython UTF-8 解码（errors='surrogatepass'，即 json.loads(bytes) 实际使用的
 * 错误处理器）与 UnicodeDecodeError 文案复刻。报错语法取自 3.13 实测
 * （见 tmp/w204_utf8_probe.txt）：
 *   'utf-8' codec can't decode byte 0x?? in position N: invalid start byte
 *   'utf-8' codec can't decode byte 0x?? in position N: invalid continuation byte
 *   'utf-8' codec can't decode bytes in position N-M: unexpected end of data
 * surrogatepass 的唯一扩展域：ED A0-BF 80-BF（三字节编码的代理码点）按
 * CPython 解码为孤立代理项（JS 字符串天然可容纳），其余字节序列与严格
 * UTF-8 完全同判。start 为起始偏移（utf-8-sig 用它跳过 BOM）。
 */
function utf8Decode(b: number[], start: number, codecName = "utf-8"): string {
  const hex = (n: number) => "0x" + n.toString(16).padStart(2, "0");
  // CPython 的报错区间 = [序列起始, 第一个坏字节)：长度 1 用单数形式，
  // >1 用 `bytes in position N-M`；截断按已消费前缀长度报 unexpected end of data。
  const fail = (seqStart: number, consumed: number, kind: string): never => {
    if (consumed <= 1) {
      throw new UnicodeDecodeErrorP(
        `'${codecName}' codec can't decode byte ${hex(b[seqStart] as number)} in position ${seqStart}: ${kind}`,
      );
    }
    throw new UnicodeDecodeErrorP(
      `'${codecName}' codec can't decode bytes in position ${seqStart}-${seqStart + consumed - 1}: ${kind}`,
    );
  };
  let i = start;
  let out = "";
  while (i < b.length) {
    const c = b[i] as number;
    if (c < 0x80) {
      out += String.fromCharCode(c);
      i += 1;
      continue;
    }
    let need = 0;
    let lower = 0x80;
    let upper = 0xbf;
    const surrogatePass = c === 0xed && (b[i + 1] ?? 0) >= 0xa0 && (b[i + 1] ?? 0) <= 0xbf;
    if (c >= 0xc2 && c <= 0xdf) need = 1;
    else if (c >= 0xe0 && c <= 0xef) {
      need = 2;
      if (c === 0xe0) lower = 0xa0;
      if (c === 0xed && !surrogatePass) upper = 0x9f;
    } else if (c >= 0xf0 && c <= 0xf4) {
      need = 3;
      if (c === 0xf0) lower = 0x90;
      if (c === 0xf4) upper = 0x8f;
    } else {
      fail(i, 1, "invalid start byte");
    }
    for (let k = 1; k <= need; k++) {
      const j = i + k;
      if (j >= b.length) fail(i, k, "unexpected end of data");
      const cc = b[j] as number;
      const lo = k === 1 ? lower : 0x80;
      const hi = k === 1 ? upper : 0xbf;
      if (cc < lo || cc > hi) fail(i, k, "invalid continuation byte");
    }
    let cp = 0;
    if (need === 1) cp = ((c & 0x1f) << 6) | ((b[i + 1] as number) & 0x3f);
    else if (need === 2)
      cp = ((c & 0x0f) << 12) | (((b[i + 1] as number) & 0x3f) << 6) | ((b[i + 2] as number) & 0x3f);
    else
      cp =
        ((c & 0x07) << 18) |
        (((b[i + 1] as number) & 0x3f) << 12) |
        (((b[i + 2] as number) & 0x3f) << 6) |
        ((b[i + 3] as number) & 0x3f);
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

/**
 * CPython json/__init__.py:248-275 `detect_encoding` 的逐字复刻（BOM 常量取自
 * codecs：BOM_UTF32_BE=00 00 FE FF, BOM_UTF32_LE=FF FE 00 00,
 * BOM_UTF16_BE=FE FF, BOM_UTF16_LE=FF FE, BOM_UTF8=EF BB BF）。
 */
function detectJsonEncoding(b: number[]): string {
  const starts = (prefix: number[]) =>
    b.length >= prefix.length && prefix.every((x, i) => b[i] === x);
  if (starts([0x00, 0x00, 0xfe, 0xff]) || starts([0xff, 0xfe, 0x00, 0x00])) return "utf-32";
  if (starts([0xfe, 0xff]) || starts([0xff, 0xfe])) return "utf-16";
  if (starts([0xef, 0xbb, 0xbf])) return "utf-8-sig";
  if (b.length >= 4) {
    if (!b[0]) return b[1] ? "utf-16-be" : "utf-32-be";
    if (!b[1]) return b[2] || b[3] ? "utf-16-le" : "utf-32-le";
  } else if (b.length === 2) {
    if (!b[0]) return "utf-16-be";
    if (!b[1]) return "utf-16-le";
  }
  return "utf-8";
}

/**
 * utf-16 家族的 surrogatepass 解码（CPython 语义：'utf-16' 嗅 BOM 定端序并
 * 跳过 BOM；无 BOM 的 utf-16 恒小端——detect 只会带 BOM 才返回 'utf-16'）。
 * 孤立代理码元原样保留（surrogatepass 允许，JS string 天然容纳）；奇数字节
 * 尾巴抛 UnicodeDecodeError: truncated data（消息文本按 CPython 语法，类型名
 * 是账本上唯一可见的部分，见文件头 DIVERGENCE 4）。
 */
function utf16Decode(b: number[], mode: "bom" | "le" | "be", codecName: string): string {
  let i = 0;
  let le = mode === "le";
  if (mode === "bom") {
    le = true; // CPython 'utf-16' 无 BOM 时默认小端
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
      le = true;
      i = 2;
    } else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
      le = false;
      i = 2;
    }
  }
  let out = "";
  while (i < b.length) {
    if (i + 1 >= b.length) {
      throw new UnicodeDecodeErrorP(
        `'${codecName}' codec can't decode byte 0x${(b[i] as number)
          .toString(16)
          .padStart(2, "0")} in position ${i}: truncated data`,
      );
    }
    const u = le ? (b[i] as number) | ((b[i + 1] as number) << 8) : ((b[i] as number) << 8) | (b[i + 1] as number);
    i += 2;
    if (u >= 0xd800 && u <= 0xdbff) {
      if (i + 1 < b.length) {
        const v = le
          ? (b[i] as number) | ((b[i + 1] as number) << 8)
          : ((b[i] as number) << 8) | (b[i + 1] as number);
        if (v >= 0xdc00 && v <= 0xdfff) {
          out += String.fromCodePoint(0x10000 + ((u - 0xd800) << 10) + (v - 0xdc00));
          i += 2;
          continue;
        }
      }
      // surrogatepass：孤立高代理原样保留（CPython 3.13 实测 b'\xff\xfe\x00\xd8'
      // .decode('utf-16','surrogatepass') == '\ufeff\ud800' 无异常）。
    }
    out += String.fromCharCode(u);
  }
  return out;
}

/**
 * utf-32 家族的 surrogatepass 解码（'utf-32' 嗅 BOM，无 BOM 恒小端；
 * 非 4 倍数尾巴 / 越界码点均抛 UnicodeDecodeError）。
 */
function utf32Decode(b: number[], mode: "bom" | "le" | "be", codecName: string): string {
  let i = 0;
  let le = mode === "le";
  if (mode === "bom") {
    le = true;
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xfe && b[2] === 0x00 && b[3] === 0x00) {
      le = true;
      i = 4;
    } else if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0xfe && b[3] === 0xff) {
      le = false;
      i = 4;
    }
  }
  if ((b.length - i) % 4 !== 0) {
    const bad = b.length - 1;
    throw new UnicodeDecodeErrorP(
      `'${codecName}' codec can't decode bytes in position ${i + (Math.floor((b.length - i) / 4) * 4)}-${bad}: truncated data`,
    );
  }
  let out = "";
  for (; i < b.length; i += 4) {
    const cp = le
      ? (b[i] as number) | ((b[i + 1] as number) << 8) | ((b[i + 2] as number) << 16) | ((b[i + 3] as number) << 24)
      : ((b[i] as number) << 24) | ((b[i + 1] as number) << 16) | ((b[i + 2] as number) << 8) | (b[i + 3] as number);
    if (cp < 0 || cp > 0x10ffff) {
      // surrogatepass 允许代理码点（CPython 3.13 实测）；仅越界抛
      // code point not in range()。
      throw new UnicodeDecodeErrorP(
        `'${codecName}' codec can't decode bytes in position ${i}-${i + 3}: code point not in range()`,
      );
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}

/** CPython `bytes.decode(detect_encoding(b), 'surrogatepass')` 的完整复刻。 */
function decodeJsonBytes(b: Uint8Array): string {
  const arr = Array.from(b);
  const enc = detectJsonEncoding(arr);
  switch (enc) {
    case "utf-8":
      return utf8Decode(arr, 0, "utf-8");
    case "utf-8-sig":
      return utf8Decode(arr, 3, "utf-8-sig");
    case "utf-16":
      return utf16Decode(arr, "bom", "utf-16");
    case "utf-16-be":
      return utf16Decode(arr, "be", "utf-16-be");
    case "utf-16-le":
      return utf16Decode(arr, "le", "utf-16-le");
    case "utf-32":
      return utf32Decode(arr, "bom", "utf-32");
    case "utf-32-be":
      return utf32Decode(arr, "be", "utf-32-be");
    case "utf-32-le":
      return utf32Decode(arr, "le", "utf-32-le");
  }
  return utf8Decode(arr, 0, "utf-8");
}

/**
 * python json.loads(v)：str 直解（前导 U+FEFF 两侧同为语法错误 → 同类型）；
 * bytes 先 `decode(detect_encoding(b), 'surrogatepass')`（UnicodeDecodeError
 * 上抛，源里不捕获）；其余类型 TypeError。语法错误抛 JSONDecodeError
 * （消息文本两侧不可比，但源里恒被捕获，不进账本）。
 */
function pyJsonLoads(v: unknown): unknown {
  let text: string;
  if (typeof v === "string") text = v;
  else if (v instanceof Uint8Array) text = decodeJsonBytes(v);
  else
    throw new TypeErrorP(
      `the JSON object must be str, bytes or bytearray, not ${pyTypeName(v)}`,
    );
  try {
    return JSON.parse(text);
  } catch {
    throw new JSONDecodeErrorP("Expecting value: line 1 column 1 (char 0)");
  }
}

/* ════════════════════════════════════════════════════════════════════
 * DiscordProvider
 * ════════════════════════════════════════════════════════════════════ */

export class DiscordProvider extends BaseProvider {
  static override PLATFORM = "discord";
  static API_BASE = "https://discord.com/api/v10";
  /** Discord rejects anything longer in a single message. */
  static override SEND_LIMIT = 2000;

  /**
   * GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT.
   * MESSAGE_CONTENT is privileged — it must also be toggled on in the
   * Developer Portal, otherwise every `content` arrives as an empty string
   * and the bot looks broken while the connection looks perfectly healthy.
   */
  static readonly INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

  protected _token: string;
  protected _task: TaskLike | null;
  protected _ws: GatewaySocketLike | null;
  protected _session: GatewaySessionLike | null;
  protected _seq: unknown;
  protected _hb_task: TaskLike | null;

  /** python `self.X` 的类属性视图（static 沿继承链查找 == cls.X）。 */
  private _cls(): typeof DiscordProvider {
    return this.constructor as typeof DiscordProvider;
  }

  constructor() {
    super();
    this._token = this.cfg("bot_token");
    this._task = null;
    this._ws = null;
    this._session = null;
    this._seq = null;
    this._hb_task = null;
  }

  /* ------------------------------------------------------------------ */
  /* Contract                                                            */
  /* ------------------------------------------------------------------ */

  override is_configured(): boolean {
    return pyTruthy(this._token);
  }

  override async start_listening(controller: unknown): Promise<void> {
    if (!this.is_configured() || pyTruthy(this._running)) return;
    this.require_aiohttp();
    this._controller = controller as ProviderControllerLike | null;
    this._running = true;
    this._task = DC_SEAMS.createTask(() => this._gateway_loop());
  }

  override async stop_listening(): Promise<void> {
    this._running = false;
    for (const task of [this._hb_task, this._task]) {
      if (task !== null && !task.done()) {
        task.cancel();
        try {
          await task;
        } catch (e) {
          // python: except asyncio.CancelledError —— 其余异常原样上抛（源缺陷 D5）。
          if (e instanceof CancelledErrorP) continue; // fail-open: 取消语义即静默，正确
          throw e;
        }
      }
    }
    this._hb_task = null;
    this._task = null;
    await this._close_ws();
    this._controller = null;
  }

  /**
   * Post to a channel.
   * @param user_id a *channel* id here — inbound messages carry the channel
   *   they arrived on and that is where the answer belongs. Replying to the
   *   author id would need a DM channel lookup and would drag a public thread
   *   into private messages.
   */
  override async send_message(user_id: string, content: string): Promise<boolean> {
    if (!pyStrip(content)) return true;
    let ok = true;
    for (const chunk of this._cls().split(content)) {
      const r = await this.request(
        "POST",
        `${this._cls().API_BASE}/channels/${user_id}/messages`,
        {
          json_body: { content: chunk },
          // python f"Bot {self._token}" 走 str() 插值：None -> "Bot None"，
          // 而 JS 模板恒给出 "Bot null"，故显式 pyStr。
          headers: { Authorization: `Bot ${pyStr(this._token)}` },
        },
      );
      ok = ok && r.ok;
    }
    return ok;
  }

  /* ------------------------------------------------------------------ */
  /* Gateway                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Connect, identify, pump events; reconnect with backoff on drop.
   *
   * No session resume: after a drop we re-IDENTIFY from scratch. Resuming
   * would save a few replayed events but needs session_id + resume_gateway
   * bookkeeping, and a duplicated message here is harmless while a stuck
   * listener is not.
   */
  async _gateway_loop(): Promise<void> {
    // python 的函数级 `import aiohttp`（require_aiohttp 已证明可导入）在 TS
    // 侧对应 DC_SEAMS.importAiohttp() 注入点；它位于 try 之外（见 D13），
    // 失败时不 print、不退避，异常直接冲出协程使任务静默死亡。
    DC_SEAMS.importAiohttp();
    let backoff = 1.0;
    while (pyTruthy(this._running)) {
      try {
        this._session = DC_SEAMS.newSession();
        const url = await this._gateway_url();
        const ws = await (this._session as GatewaySessionLike).ws_connect(url, {
          heartbeat: null,
        });
        try {
          this._ws = ws;
          backoff = 1.0;
          await this._pump(ws);
        } finally {
          // python `async with` 的 __aexit__：退出即关闭 socket。
          await ws.close();
        }
      } catch (e) {
        if (e instanceof CancelledErrorP) throw e;
        // fail-open: 传输层错误是数据，不是崩溃
        DC_SEAMS.print(`[discord] gateway error: ${pyExcStr(e)}`);
      } finally {
        await this._close_ws();
      }
      if (pyTruthy(this._running)) {
        await DC_SEAMS.sleep(backoff);
        backoff = Math.min(backoff * 2, 60.0);
      }
    }
  }

  /** Ask Discord where to connect, falling back to the documented host. */
  async _gateway_url(): Promise<string> {
    const r = await this.request("GET", `${this._cls().API_BASE}/gateway`, {
      headers: { Authorization: `Bot ${pyStr(this._token)}` },
    });
    let base = "";
    if (pyTruthy(r.ok) && isDict(r.value)) {
      const u = dictGet(r.value, "url", null);
      base = pyStr(pyTruthy(u) ? u : "");
    }
    if (!base) base = "wss://gateway.discord.gg";
    return `${base}/?v=10&encoding=json`;
  }

  /** Read frames until the socket closes. */
  async _pump(ws: GatewaySocketLike): Promise<void> {
    for await (const msg of ws) {
      if (!pyTruthy(this._running)) break;
      const typeName = pyAttr(pyAttr(msg, "type"), "name");
      if (!pyIn(typeName, ["TEXT", "BINARY"])) break;
      let frame: unknown;
      try {
        frame = pyJsonLoads(pyAttr(msg, "data"));
      } catch (e) {
        // python: except (json.JSONDecodeError, TypeError): continue
        if (e instanceof JSONDecodeErrorP || e instanceof TypeErrorP) continue;
        throw e;
      }
      await this._on_frame(ws, frame);
    }
  }

  async _on_frame(ws: GatewaySocketLike, frame: unknown): Promise<void> {
    const op = dictGet(frame, "op", null);
    if (pyIsNotNone(dictGet(frame, "s", null))) {
      this._seq = dictGet(frame, "s", null);
    }

    if (pyEq(op, 10)) {
      // HELLO
      const interval =
        pyFloat(dictGet(dictGet(frame, "d", {}), "heartbeat_interval", 41250)) / 1000.0;
      this._hb_task = DC_SEAMS.createTask(() => this._heartbeat(ws, interval));
      await ws.send_json({
        op: 2,
        d: {
          token: this._token,
          intents: this._cls().INTENTS,
          properties: { os: "linux", browser: "ovolve", device: "ovolve" },
        },
      });
    } else if (pyEq(op, 0) && pyEq(dictGet(frame, "t", null), "MESSAGE_CREATE")) {
      const d = dictGet(frame, "d", null);
      await this._on_message(pyTruthy(d) ? d : {});
    } else if (pyIn(op, [7, 9])) {
      // reconnect / invalid session -> drop and let the loop retry
      await ws.close();
    }
  }

  /**
   * Send op 1 on Discord's schedule.
   *
   * The first beat is jittered per Discord's guidance so a fleet of bots
   * restarting together doesn't hammer the gateway on the same tick.
   */
  async _heartbeat(ws: GatewaySocketLike, interval: number): Promise<void> {
    try {
      await DC_SEAMS.sleep(interval * 0.5);
      while (pyTruthy(this._running) && !pyTruthy(pyAttr(ws, "closed"))) {
        await ws.send_json({ op: 1, d: this._seq });
        await DC_SEAMS.sleep(interval);
      }
    } catch (e) {
      // python: except (asyncio.CancelledError, ConnectionResetError): pass
      if (e instanceof CancelledErrorP || e instanceof ConnectionResetErrorP) return;
      // fail-open: 取消语义即静默，正确；心跳死了只是把 socket 丢给 Discord 超时
      return;
    }
  }

  /** Route one MESSAGE_CREATE, ignoring bots and empty text. */
  async _on_message(data: unknown): Promise<void> {
    const authorRaw = dictGet(data, "author", null);
    const author = pyTruthy(authorRaw) ? authorRaw : {};
    if (pyTruthy(dictGet(author, "bot", null))) {
      // Including ourselves. Without this a reply would re-trigger the
      // bot and two bots in one channel would talk forever.
      return;
    }
    const contentRaw = dictGet(data, "content", null);
    const text = pyStrip(pyStr(pyTruthy(contentRaw) ? contentRaw : ""));
    if (!text) return;
    const idRaw = dictGet(author, "id", null);
    const user_id = pyStr(pyTruthy(idRaw) ? idRaw : "");
    const chRaw = dictGet(data, "channel_id", null);
    const channel_id = pyStr(pyTruthy(chRaw) ? chRaw : "");
    if (!(pyTruthy(user_id) && pyTruthy(channel_id))) return;
    await this.route(user_id, text, channel_id);
  }

  async _close_ws(): Promise<void> {
    for (const obj of [this._ws, this._session]) {
      try {
        if (obj !== null && obj !== undefined && !pyTruthy(pyGetAttr(obj, "closed", true))) {
          const close = pyAttr(obj, "close") as () => Promise<unknown>;
          await close.call(obj);
        }
      } catch (e) {
        // D12: python 侧是 `except Exception`，而 asyncio.CancelledError 自 3.8
        // 起继承 BaseException —— 它**不会**被吞掉，会连 `self._ws =
        // self._session = None` 一起跳过。端口显式复刻该逃逸。
        if (e instanceof CancelledErrorP) throw e;
        // fail-open: 可选增强，失败不影响主流程
      }
    }
    this._ws = null;
    this._session = null;
  }
}

// PORT STATUS: 本文件无 TODO(port)。
