/**
 * providers/slack_provider.ts — Slack Socket Mode IMProvider。
 *
 * 源：app/backend/providers/slack_provider.py（194 行）。
 * 单元 206 / wave-9，manifest.tsv target=TS。Providers 家族成员，基座为
 * providers/common.ts（Unit 202，已落地，静态 import，不重复其 helper）。
 *
 * 为什么用 Socket Mode 而非 Events API（与源 docstring 一致）：Events API 需要
 * 公网可达的 HTTPS 回调，跑在 NAT 后的桌面应用没有；Socket Mode 主动 *dial out*
 * 到 Slack，笔记本无需隧道即可用。
 *
 * 两个 token，不可互换：
 *  - app_token（xapp-…）只用来打开 WebSocket；
 *  - bot_token（xoxb-…）授权 chat.postMessage。
 * 配置在 bot_state["slack:config"]。
 *
 * ── 接缝（红线5：HTTP / WebSocket / 时钟-睡眠 / print / 任务调度全部隔离）──
 * HTTP 复用基座 CP_SEAMS.fetch（providers/common.ts），本文件不重复声明；
 * SLACK_SEAMS 只补源里其余的宿主触点：
 *   - print:      print() 的三处用户可见输出（send failed / connections.open failed
 *                 / socket error / route failed）。默认 console.log；探针替换为记录假件。
 *   - newSession: 取代 aiohttp.ClientSession()（函数级 import aiohttp），返回一个
 *                 鸭子类型的 session：ws_connect(url, heartbeat) -> WebSocket 句柄。
 *                 默认实现是"未接线 WebSocket 传输"的安全占位（抛错，被 _socket_loop
 *                 的 except 捕获并打印 socket error）；生产由宿主注入真实现。
 *   - sleep:      取代 asyncio.sleep()。默认 setTimeout；探针替换为立即 resolve 且
 *                 驱动重连上界的假件——绝不真实挂起。
 *   - createTask: 取代 asyncio.create_task()。接收一个 *thunk*（见 DIVERGENCE 2），
 *                 返回带 done()/cancel()/wait() 的任务句柄。默认后台启动 thunk。
 * 探针只检验构建出的 URL/Headers/Body JSON/状态码解析与 WebSocket 帧处理，
 * 绝不产生真实网络、真实子进程、真实 SQLite、真实 stdin/stdout。
 *
 * ── 源自带缺陷（bug-for-bug 原样保留，不修）──
 *  D1  _pump：frame = json.loads(msg.data) 之后的 `frame.get(...)` 不在 try 内——
 *      合法 JSON 但非 dict 的帧（"null"/"[1,2]"/"5"/'"s"'）→ AttributeError 冲出
 *      _pump（在 _socket_loop 视角被 except 捕获打印 socket error；_pump 直调时抛出）。
 *  D2  _pump：events_api 分支 `payload.get("event")` 对非 dict 的真值 payload
 *      （如 frame.payload 是字符串/数字/列表）同样抛 AttributeError。
 *  D3  _pump：msg.data 若为非法 UTF-8 字节，json.loads(bytes) 抛 UnicodeDecodeError，
 *      不在 `(json.JSONDecodeError, TypeError)` 捕获集内 → 冲出 _pump。
 *  D4  send_message/connections.open：成功响应的 print 用 `r.error or body.get("error")`，
 *      当 error 键缺失时打印的是 None（Python str(None)="None"），端口用 pyStr 逐字复刻。
 *  D5  _on_event：event.get(...) 对非 dict event 抛 AttributeError（与 D1 同族）。
 *  D6  is_configured 需要两个 token 同时存在；只有 xoxb 判为未配置（源注释明示这是特性）。
 *  D7  start_listening：未配置或已在跑时直接 return，既不 require_aiohttp 也不置 _running。
 *
 * ── DIVERGENCE(port) ──
 *  1. aiohttp WebSocket → SLACK_SEAMS.newSession：与基座 Unit 202 第 1 条同源。
 *     探针用鸭子类型假 session/ws 替代真实 aiohttp，只观察 ws_connect 的入参、
 *     帧迭代、send_json 的 ack 报文与 close 次数；传输层差异不可观测。
 *     等价性论证：源里唯一被外部观察的 WebSocket 行为是 (a) 用 connections.open
 *     返回的 url 建连、(b) 对 TEXT/BINARY 帧解析并 ack、(c) disconnect 帧关连接、
 *     (d) 停止时 close()——四点在端口与探针假件间一一对应。
 *  2. asyncio.create_task(coro) → createTask(thunk)：Python 中 `self._socket_loop()`
 *     只 *创建* 协程对象而不运行，create_task 才把它排入事件循环；JS 里直接调用
 *     async 方法会同步跑到第一个 await。故端口把协程包成 thunk 传入 createTask，
 *     由 createTask 决定何时（是否）运行——与 create_task 的"调度而非立即运行"一致。
 *     start_listening 场景因此能干净地只观察 _running/_controller/_task 被置位，
 *     _socket_loop 体在快照前不会执行（与 CPython 同）。
 *  3. asyncio.CancelledError → CancelledErrorP（Error 子类，name="CancelledError"）：
 *     TS 无原生取消语义；stop_listening 的 try/except CancelledError 分支由任务句柄
 *     的 wait() 是否以 CancelledErrorP 拒绝来决定，跨语言异常类名对齐。真实事件循环
 *     的强杀不可移植，但源里该 except 只是"静默吞掉取消"，端口保持同样的静默语义。
 *  4. 裸 NaN/Infinity JSON 字面量、int()/float() 的 Unicode 数字、str(dict) 键序、
 *     Python int/float 类型标签：与基座/DingTalk 同源——本模块不经手这些语法面
 *     （无 int()/float() 强转，仅 str()/f-string），场景表不注入数字样键，不可达。
 *  5. msg.type.name：aiohttp 用 WSMsgType 枚举，其 .name 恒为大写字符串
 *     （TEXT/BINARY/CLOSING/CLOSED/…）。端口以鸭子契约读取 `msg.type.name`，
 *     探针假件构造同名字符串，两侧一致。
 *
 * PORT STATUS: confidence=high todos=0
 */

import { BaseProvider } from "./common.js";
import type { ProviderControllerLike } from "./common.js";

/* ════════════════════════════════════════════════════════════════════
 * Seams（红线5：WebSocket / 睡眠 / 任务调度 / print 隔离；HTTP 走基座 CP_SEAMS）
 * ════════════════════════════════════════════════════════════════════ */

/** 一条入站 WebSocket 帧的鸭子契约（对齐 aiohttp WSMessage）。 */
export interface SlackWsMessage {
  type: { name: string };
  data: unknown;
}

/** aiohttp WebSocketResponse 的鸭子契约（async 迭代 + send_json + close + closed）。 */
export interface SlackWsLike {
  [Symbol.asyncIterator](): AsyncIterator<SlackWsMessage>;
  send_json(obj: unknown): Promise<void>;
  close(): Promise<void>;
  closed: boolean;
}

/** aiohttp.ClientSession 的鸭子契约。 */
export interface SlackSessionLike {
  ws_connect(url: string, heartbeat: number): Promise<SlackWsLike>;
  close(): Promise<void>;
  closed: boolean;
}

/** asyncio.Task 的最小鸭子契约。 */
export interface SlackTask {
  done(): boolean;
  cancel(): void;
  wait(): Promise<void>;
}

export interface SlackSeams {
  print: (line: string) => void;
  newSession: () => SlackSessionLike;
  sleep: (seconds: number) => Promise<void>;
  createTask: (run: () => Promise<void>) => SlackTask;
}

/** 默认"未接线 WebSocket 传输"占位：调用即抛，被 _socket_loop 的 except 捕获。 */
function defaultNewSession(): SlackSessionLike {
  throw new Error("SlackProvider requires a WebSocket transport (SLACK_SEAMS.newSession not wired)");
}

export const SLACK_SEAMS: SlackSeams = {
  print: (line: string) => {
    console.log(line);
  },
  newSession: defaultNewSession,
  sleep: (seconds: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, seconds * 1000));
    }),
  createTask: (run: () => Promise<void>) => {
    let settled = false;
    let cancelled = false;
    const promise = Promise.resolve()
      .then(() => run())
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
    return {
      done: () => settled,
      cancel: () => {
        cancelled = true;
        settled = true;
      },
      wait: () => (cancelled ? Promise.reject(new CancelledErrorP()) : promise),
    };
  },
};

/** 探针注入入口（与 common.ts / dingtalk_provider.ts 的 _set_seams_for_parity 同模式）。 */
export function _set_seams_for_parity(overrides: Partial<SlackSeams>): void {
  Object.assign(SLACK_SEAMS, overrides);
}

/* ════════════════════════════════════════════════════════════════════
 * Python 语义辅助（本文件自带，仓库惯例见 HANDOFF_V10 §4.3；不复制 common.ts）
 * ════════════════════════════════════════════════════════════════════ */

class AttributeErrorP extends Error {
  constructor(m: string) {
    super(m);
    (this as { pyMsg?: string }).pyMsg = m;
    this.name = "AttributeError";
  }
}

/** asyncio.CancelledError 的等价物（name 对齐）。 */
export class CancelledErrorP extends Error {
  constructor(m = "Task cancelled") {
    super(m);
    this.name = "CancelledError";
  }
}

/**
 * UnicodeDecodeError 的等价物（name 对齐）。V8 的 fatal TextDecoder 抛的是原生
 * TypeError，会被 _pump 的 `except (JSONDecodeError, TypeError)` 误吞成 continue；
 * 这里把它改写成 name="UnicodeDecodeError" 的异常，使其冲出 _pump，对齐源 D3。
 */
export class UnicodeDecodeErrorP extends Error {
  constructor(m: string) {
    super(m);
    this.name = "UnicodeDecodeError";
  }
}

/** python type(x).__name__（JSON 域内）。 */
function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (typeof v === "object") return "dict";
  return typeof v;
}

/** Python truthiness：CPython bool(float('nan')) 为 True（NaN != 0）。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}

/** isinstance(v, dict)：JSON 解析产物视角的"映射"。 */
function isDict(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * python `obj.get(key, default)`：obj 非映射时抛 AttributeError
 * （`'str' object has no attribute 'get'`），复刻源缺陷 D1/D2/D5 的崩溃面。
 * present-but-null 返回 null，不是 default。
 */
function dictGet(obj: unknown, key: string, defaultValue: unknown = null): unknown {
  if (!isDict(obj)) {
    throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  return key in obj ? obj[key] : defaultValue;
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
    case "\u2028": case "\u2029": case "\u202f": case "\u205f": case "\u3000":
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

/** python str(exc)：Error 取 message（端口异常 message 逐字对齐 CPython），其余取 pyStr。 */
function pyExcStr(exc: unknown): string {
  if (exc instanceof Error) return exc.message;
  return pyStr(exc);
}

/* ════════════════════════════════════════════════════════════════════
 * SlackProvider
 * ════════════════════════════════════════════════════════════════════ */

export class SlackProvider extends BaseProvider {
  static override PLATFORM = "slack";
  static API_BASE = "https://slack.com/api";
  /** chat.postMessage tolerates more, but long single blocks get truncated in
   *  the client, so split well before the hard cap. */
  static override SEND_LIMIT = 3800;

  protected _bot_token: string;
  protected _app_token: string;
  protected _task: SlackTask | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected _ws: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected _session: any = null;

  /** python `self.X` 的类属性视图（static 沿继承链查找 == cls.X）。 */
  private _cls(): typeof SlackProvider {
    return this.constructor as typeof SlackProvider;
  }

  constructor() {
    super();
    this._bot_token = this.cfg("bot_token");
    this._app_token = this.cfg("app_token");
    this._task = null;
    this._ws = null;
    this._session = null;
  }

  /* ------------------------------------------------------------------ */
  /* Contract                                                            */
  /* ------------------------------------------------------------------ */

  override is_configured(): boolean {
    // Both tokens matter: with only xoxb the bot can talk but never hears,
    // which is the most confusing half-working state possible.
    return pyTruthy(this._bot_token && this._app_token);
  }

  override async start_listening(controller: unknown): Promise<void> {
    if (!this.is_configured() || this._running) {
      return;
    }
    this.require_aiohttp();
    this._controller = controller as ProviderControllerLike | null;
    this._running = true;
    this._task = SLACK_SEAMS.createTask(() => this._socket_loop());
  }

  override async stop_listening(): Promise<void> {
    this._running = false;
    if (this._task && !this._task.done()) {
      this._task.cancel();
      try {
        await this._task.wait();
      } catch (e) {
        // fail-open: 取消语义即静默，正确 —— 仅吞 CancelledError，其余原样上抛。
        if (!(e instanceof CancelledErrorP)) throw e;
      }
    }
    this._task = null;
    await this._close_ws();
    this._controller = null;
  }

  /** Post to a channel id (or a user id, which Slack opens as a DM). */
  override async send_message(user_id: string, content: string): Promise<boolean> {
    if (!pyStrip(content)) {
      return true;
    }
    let ok = true;
    for (const chunk of this._cls().split(content)) {
      const r = await this.request("POST", `${this._cls().API_BASE}/chat.postMessage`, {
        json_body: { channel: user_id, text: chunk },
        headers: { Authorization: `Bearer ${this._bot_token}` },
      });
      // Slack answers HTTP 200 with {"ok": false, "error": "..."} for
      // things like invalid_auth, so HTTP status alone is not success.
      const body: Record<string, unknown> = isDict(r.value) ? r.value : {};
      if (!r.ok || !pyTruthy(dictGet(body, "ok"))) {
        SLACK_SEAMS.print(
          `[slack] send failed: ${pyStr(pyTruthy(r.error) ? r.error : dictGet(body, "error"))}`,
        );
        ok = false;
      }
    }
    return ok;
  }

  /* ------------------------------------------------------------------ */
  /* Socket Mode                                                         */
  /* ------------------------------------------------------------------ */

  /** Open a socket, pump envelopes, reconnect with backoff. */
  async _socket_loop(): Promise<void> {
    let backoff = 1.0;
    while (this._running) {
      try {
        const url = await this._open_connection();
        if (!url) {
          await SLACK_SEAMS.sleep(backoff);
          backoff = Math.min(backoff * 2, 60.0);
          continue;
        }
        this._session = SLACK_SEAMS.newSession();
        const ws = await (this._session as SlackSessionLike).ws_connect(url, 30);
        try {
          this._ws = ws;
          backoff = 1.0;
          await this._pump(ws);
        } finally {
          // async with 的 __aexit__：无条件 await ws.close()。aiohttp 的 close() 幂等
          // （已关则空转），探针假件同样按"仅在 open->closed 跃迁时记录"复刻，
          // 故 disconnect 后再退出不会二次记录 close。
          await ws.close();
        }
      } catch (exc) {
        if (exc instanceof CancelledErrorP) {
          throw exc;
        }
        SLACK_SEAMS.print(`[slack] socket error: ${pyExcStr(exc)}`);
      } finally {
        await this._close_ws();
      }
      if (this._running) {
        await SLACK_SEAMS.sleep(backoff);
        backoff = Math.min(backoff * 2, 60.0);
      }
    }
  }

  /** Trade the app token for a single-use WebSocket URL. */
  async _open_connection(): Promise<string> {
    const r = await this.request("POST", `${this._cls().API_BASE}/apps.connections.open`, {
      data: new Uint8Array(0),
      headers: {
        Authorization: `Bearer ${this._app_token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    const body: Record<string, unknown> = isDict(r.value) ? r.value : {};
    if (!r.ok || !pyTruthy(dictGet(body, "ok"))) {
      SLACK_SEAMS.print(
        `[slack] connections.open failed: ${pyStr(pyTruthy(r.error) ? r.error : dictGet(body, "error"))}`,
      );
      return "";
    }
    const urlRaw = dictGet(body, "url");
    return pyStr(pyTruthy(urlRaw) ? urlRaw : "");
  }

  async _pump(ws: SlackWsLike): Promise<void> {
    for await (const msg of ws) {
      if (!this._running) {
        break;
      }
      const typeName = ((msg.type as { name?: string } | undefined)?.name ?? "") as string;
      if (typeName !== "TEXT" && typeName !== "BINARY") {
        break;
      }
      let frame: unknown;
      try {
        frame = this._jsonLoads(msg.data);
      } catch (e) {
        // python: except (json.JSONDecodeError, TypeError): continue
        if (e instanceof SyntaxError || (e as { name?: string })?.name === "TypeError") {
          continue;
        }
        throw e;
      }

      const envelopeId = dictGet(frame, "envelope_id");
      if (pyTruthy(envelopeId)) {
        // Ack immediately, before doing the work. Slack retries an un-acked
        // envelope, and an agent turn takes far longer than its patience —
        // the retry would run the same prompt twice.
        await ws.send_json({ envelope_id: envelopeId });
      }

      const kind = dictGet(frame, "type");
      if (kind === "events_api") {
        const payloadRaw = dictGet(frame, "payload");
        const payload = pyTruthy(payloadRaw) ? payloadRaw : {};
        const eventRaw = dictGet(payload, "event");
        const event = pyTruthy(eventRaw) ? eventRaw : {};
        SLACK_SEAMS.createTask(() => this._on_event(event as Record<string, unknown>));
      } else if (kind === "disconnect") {
        await ws.close();
      }
    }
  }

  /** Route a message event, ignoring bots, edits and joins. */
  async _on_event(event: Record<string, unknown>): Promise<void> {
    if (dictGet(event, "type") !== "message") {
      return;
    }
    // subtype covers bot_message / message_changed / channel_join etc.
    // Anything with a subtype is not a plain human message.
    const subtype = dictGet(event, "subtype");
    const botId = dictGet(event, "bot_id");
    if (pyTruthy(subtype) || pyTruthy(botId)) {
      return;
    }
    const textRaw = dictGet(event, "text");
    const text = pyStrip(pyStr(pyTruthy(textRaw) ? textRaw : ""));
    const userRaw = dictGet(event, "user");
    const user_id = pyStr(pyTruthy(userRaw) ? userRaw : "");
    const chanRaw = dictGet(event, "channel");
    const channel = pyStr(pyTruthy(chanRaw) ? chanRaw : "");
    if (!(text && user_id && channel)) {
      return;
    }
    try {
      await this.route(user_id, text, channel);
    } catch (exc) {
      // noqa: BLE001 - one bad turn must not kill the socket
      SLACK_SEAMS.print(`[slack] route failed: ${pyExcStr(exc)}`);
    }
  }

  async _close_ws(): Promise<void> {
    for (const obj of [this._ws, this._session]) {
      try {
        if (obj !== null && obj !== undefined && !this._getattrClosed(obj, true)) {
          await obj.close();
        }
      } catch {
        // fail-open: 可选增强，失败不影响主流程
      }
    }
    this._ws = null;
    this._session = null;
  }

  /**
   * python `getattr(obj, "closed", default)`：present-but-null 返回 null，
   * 属性缺失才返回 default。用于 D 家族的精确关闭判定（_close_ws / async-with）。
   */
  private _getattrClosed(obj: unknown, defaultValue: boolean): boolean {
    if (obj !== null && typeof obj === "object" && "closed" in (obj as object)) {
      return Boolean((obj as { closed: unknown }).closed);
    }
    return defaultValue;
  }

  /**
   * python json.loads：探针只喂合法 JSON 文本与坏文本。
   * 端口用 V8 JSON.parse；裸 NaN/Infinity 差异见文件头 DIVERGENCE 4（不可达）。
   * 非字符串输入（如已被上游解码的对象）按 TypeError 抛出以对齐源捕获集。
   */
  private _jsonLoads(data: unknown): unknown {
    if (typeof data === "string") {
      return JSON.parse(data); // SyntaxError on bad JSON -> mapped to JSONDecodeError path
    }
    if (data instanceof Uint8Array) {
      // python json.loads(bytes) 先 UTF-8 解码；坏字节抛 UnicodeDecodeError（D3）。
      // V8 fatal 解码抛的是原生 TypeError，会被 _pump 误吞；这里改写为
      // UnicodeDecodeErrorP（name 非 SyntaxError/TypeError）使其冲出 _pump，对齐源。
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
      } catch (e) {
        if (e instanceof SyntaxError) throw e; // 合法 UTF-8 但坏 JSON -> JSONDecodeError 路径
        throw new UnicodeDecodeErrorP(
          "'utf-8' codec can't decode byte sequence: " + ((e as Error)?.message ?? String(e)),
        );
      }
    }
    const err = new TypeError("the JSON object must be str, bytes or bytearray, not " + pyTypeName(data));
    throw err;
  }
}

// PORT STATUS: 本文件无 TODO(port)。
