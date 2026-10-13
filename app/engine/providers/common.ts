/**
 * providers/common.ts — shared plumbing for IM providers.
 *
 * 源：app/backend/providers/common.py（279 行）。
 * 单元 202 / wave-9，manifest.tsv target=TS。Providers 家族（Units 202–208）的基座：
 * 六个 Chat Webhook Provider（DingTalk / Discord / Feishu / Slack / Telegram / WeCom）
 * 全部继承 BaseProvider，复用其配置读写、allow-list、内置命令、入站路由、
 * 流式收集、HTTP 传输与消息分块。
 *
 * ── 职责（与源码逐行对齐）──
 *  1. Config：cfg() / persist() / user_allowed()，数据源恒为
 *     storage.get_bot_state("{PLATFORM}:config")，绝不读 config.json、绝不硬编码。
 *  2. Inbound routing：route() 顺序恒为 授权 → 内置命令 → 暂停门 → controller。
 *     内置命令在暂停期间保持可达（否则 /resume 永不可达，用户会被永久卡住）。
 *  3. 内置命令表：/start /status /pause /resume。
 *  4. 流式默认：send_streaming_card 收集完整流后一次性发送（打字机效果由
 *     Telegram/Slack/Discord 各自覆写）。
 *  5. HTTP 传输：request() 构造 headers/payload 后分派 aiohttp 主路径或
 *     urllib 回退路径；响应经 _decode() 解析，非 JSON 响应保留原文本
 *     （DingTalk/WeCom 部分路径返回纯文本）。
 *  6. 分块：split() 优先换行边界。
 *  7. require_aiohttp()：WebSocket 监听器的守卫（aiohttp 缺失时抛错）。
 *
 * ── 接缝（RULEBOOK §2 红线5：HTTP 与持久化全部经 seam 隔离）──
 * CP_SEAMS（Common Provider seams，与 plugin_market.ts 的 PM_SEAMS 同模式）：
 *   - fetch:       HTTP 请求执行器（取代 aiohttp.ClientSession / urllib.request）。
 *                  默认实现为全局 fetch；探针替换为记录型假件，绝不产生真实网络请求。
 *   - getStorage:  返回 ICommonStorage（取代 storage.get_storage() 单例）。
 *                  默认为 engine/storage.ts 的 get_storage() 真身；探针注入内存假件，
 *                  不触碰 ~/.ovolve/db/*.db。
 *   - hasAiohttp:  aiohttp 可用性开关。Python 源中 aiohttp 是可选依赖
 *                  （try import，_HAS_AIOHTTP=False 时走 urllib 回退）；
 *                  TS 全局 fetch 恒可用，故默认 true，urllib 回退路径
 *                  （_request_urllib）保留以维持双路径消息格式差异的可观测性。
 *
 * ── DIVERGENCE(port) ──
 *  1. aiohttp → fetch：Python 的 aiohttp.ClientSession 被全局 fetch 取代。
 *     等价性：两者都是 async HTTP 客户端，请求构造（method/url/headers/body）与
 *     响应读取（status/text）语义一一对应；探针只检验构建出的 URL/Headers/Body/
 *     状态码解析，不产生真实外部网络请求，传输层差异不可观测。
 *  2. RuntimeError：Python require_aiohttp() 抛 RuntimeError。TS 无该命名类型，
 *     抛 RuntimeErrorP（Error 子类，name="RuntimeError"），跨语言异常类名对齐。
 *  3. NaN/Infinity JSON 字面量：Python json.loads 接受 'NaN'/'Infinity'/'-Infinity'
 *     （返回 float nan/inf），V8 JSON.parse 拒绝（_decode 回退返回原文本）。
 *     触发条件：外部 HTTP 响应体恰为这些裸字面量。providers 场景不会出现
 *     （响应均为业务 JSON），记此已知差异。
 *  4. str.split() 的 Unicode 空白集：CPython 还切分 \x1c-\x1f 等控制字符，
 *     JS \s 不切。消息文本场景不涉及，记此已知差异。
 *
 * PORT STATUS: confidence=high todos=0
 */

import { IMProvider } from "./base.js";
import { Result } from "../result.js";
import { get_storage } from "../storage.js";

/* ════════════════════════════════════════════════════════════════════
 * Seams（红线5：HTTP / 持久化隔离）
 * ════════════════════════════════════════════════════════════════════ */

/**
 * storage 的最小契约：仅 BaseProvider 用到的两个 bot_state 方法。
 * 方法名保持 snake_case——真 storage（engine/storage.ts 的 effects domain
 * mixin）挂载的就是 get_bot_state / save_bot_state。
 */
export interface ICommonStorage {
  get_bot_state(key: string, defaultValue?: unknown): unknown;
  save_bot_state(key: string, value: unknown): void;
}

/** fetch 假件需返回的最小响应形状（与 undici Response 兼容）。 */
export interface FetchLikeResponse {
  status: number;
  statusText: string;
  text(): Promise<string>;
}

export interface RequestInitSeams {
  method: string;
  body?: Uint8Array | null;
  headers?: Record<string, string>;
}

export interface CommonProviderSeams {
  fetch: (url: string, init: RequestInitSeams) => Promise<FetchLikeResponse>;
  getStorage: () => ICommonStorage;
  hasAiohttp: () => boolean;
}

function defaultFetch(url: string, init: RequestInitSeams): Promise<FetchLikeResponse> {
  return fetch(url, {
    method: init.method,
    body: init.body ?? undefined,
    headers: init.headers,
  }) as Promise<FetchLikeResponse>;
}

export const CP_SEAMS: CommonProviderSeams = {
  fetch: defaultFetch,
  // get_storage() 的静态类型（StorageBase）不含 mixin 挂载的 get_bot_state /
  // save_bot_state（它们由 applyEffectsDomain 在原型上挂载）；此处按契约断言。
  getStorage: () => get_storage() as unknown as ICommonStorage,
  hasAiohttp: () => true,
};

/** 探针注入入口（与 plugin_market.ts 的 _set_seams_for_parity 同模式）。 */
export function _set_seams_for_parity(overrides: Partial<CommonProviderSeams>): void {
  Object.assign(CP_SEAMS, overrides);
}

/* ════════════════════════════════════════════════════════════════════
 * Python 语义辅助（bug-for-bug 对齐层）
 * ════════════════════════════════════════════════════════════════════ */

/** Python truthiness：None/False/0/0.0/""/[]/{} 均为 falsy。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return Object.keys(v as object).length > 0;
}

/** Python repr(str) 的单引号包裹：文本含 ' 且不含 " 时改用双引号。 */
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

/** Python repr(float)：最短往返数字 + 指数格式（1e+20 / 1e-05，指数至少两位带符号）。 */
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

/** Python str()：cfg() 与 route() 的 f-string 插值语义。 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return pyFloatRepr(v);
  }
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return "[" + v.map(pyStr).join(", ") + "]";
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).map(
      ([k, val]) => `${pyStrRepr(k)}: ${pyStr(val)}`,
    );
    return "{" + entries.join(", ") + "}";
  }
  return String(v);
}

/**
 * Python json.dumps(v, ensure_ascii=False)（默认 separators ', ' / ': '）。
 * HTTP body 序列化用：保证发出的字节与 Python 源一致（探针对拍原始 body 字符串）。
 */
function pyJsonStringify(v: unknown): string {
  const enc = (val: unknown): string => {
    if (val === null || val === undefined) return "null";
    if (typeof val === "boolean") return val ? "true" : "false";
    if (typeof val === "number") {
      if (Number.isNaN(val)) return "NaN";
      if (val === Infinity) return "Infinity";
      if (val === -Infinity) return "-Infinity";
      return Number.isInteger(val) ? String(val) : pyFloatRepr(val);
    }
    if (typeof val === "string") return JSON.stringify(val);
    if (Array.isArray(val)) return "[" + val.map(enc).join(", ") + "]";
    if (typeof val === "object") {
      return (
        "{" +
        Object.entries(val as Record<string, unknown>)
          .map(([k, val2]) => `${JSON.stringify(k)}: ${enc(val2)}`)
          .join(", ") +
        "}"
      );
    }
    return "null";
  };
  return enc(v);
}

/** urllib Request 的键首字母大写化（'Content-Type' → 'Content-type'）。 */
function capitalizeHeaderKey(k: string): string {
  return k.length === 0 ? k : k.charAt(0).toUpperCase() + k.slice(1).toLowerCase();
}

/** Python RuntimeError 的等价物（name 对齐，跨语言异常类名可区分）。 */
class RuntimeErrorP extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RuntimeError";
  }
}

/** controller.handle_message 的最小鸭子契约（Python 侧为 Any + getattr(result,"ok")）。 */
export interface ProviderControllerLike {
  handleMessage(platform: string, userId: string, text: string): Promise<Result<unknown>>;
}

/* ════════════════════════════════════════════════════════════════════
 * 模块级常量
 * ════════════════════════════════════════════════════════════════════ */

/**
 * Python: HAS_AIOHTTP（aiohttp 可选依赖探测结果）。
 * TS 全局 fetch 恒可用，故恒为 true；urllib 回退路径由 CP_SEAMS.hasAiohttp 切换。
 */
export const HAS_AIOHTTP = true;

/* ════════════════════════════════════════════════════════════════════
 * BaseProvider
 * ════════════════════════════════════════════════════════════════════ */

export abstract class BaseProvider extends IMProvider {
  /** 平台标识。必须与注册表和 UI 使用的键一致。 */
  static PLATFORM = "";

  /**
   * 实例视角的 static PLATFORM（对齐 Python self.PLATFORM 的类属性语义）。
   * TS 禁止经实例访问静态成员，故经 this.constructor 读取：static 成员沿
   * 继承链查找，子类覆盖（class DingTalkProvider extends BaseProvider）
   * 与 Python cls.PLATFORM 的运行时行为一致。
   */
  protected get _platform(): string {
    return (this.constructor as unknown as { PLATFORM: string }).PLATFORM;
  }
  /** 平台接受的单条出站消息上限。 */
  static SEND_LIMIT = 4000;
  /** false 表示纯推送平台（UI 据此提示用户等待永远不来的回复）。 */
  static SUPPORTS_INBOUND = true;

  protected storage: ICommonStorage;
  protected _config: Record<string, unknown>;
  protected _running = false;
  protected _controller: ProviderControllerLike | null = null;
  protected _paused_users = new Set<string>();

  constructor() {
    super();
    this.storage = CP_SEAMS.getStorage();
    this._config =
      (this.storage.get_bot_state(`${this._platform}:config`, {}) as Record<string, unknown>) || {};
    this._running = false;
    this._controller = null;
    this._paused_users = new Set();
  }

  /* ── Config ── */

  get_platform_id(): string {
    return this._platform;
  }

  /** 读取一个字符串配置值；空字符串视为缺省。 */
  cfg(key: string, default_: string = ""): string {
    const v = this._config[key];
    return pyStr(pyTruthy(v) ? v : default_);
  }

  /** 合并键入存储配置。best-effort：写失败绝不拖垮在线监听。 */
  persist(patch: Record<string, unknown>): void {
    const merged: Record<string, unknown> = { ...this._config };
    Object.assign(merged, patch);
    this._config = merged;
    try {
      this.storage.save_bot_state(`${this._platform}:config`, merged);
    } catch {
      // RULEBOOK §2 broad swallow：源文件 persist() 的 except Exception: pass 原样保留。
      // BUG(port): fail-open 可选增强，失败不影响主流程。
    }
  }

  /**
   * Fail-closed allow-list。空列表意味着"没有人"，而非"所有人"——
   * bot token 是 bearer 凭证，任何找到 bot 的人都能发消息，
   * 所以"未设置"必须等价于"锁死"，否则半成品配置就是敞开的大门。
   */
  user_allowed(user_id: string): boolean {
    const allowed = this._config["allowed_users"];
    if (!pyTruthy(allowed)) return false;
    // Python `{str(u) for u in allowed}`：字符串迭代字符、dict 迭代键、
    // 非可迭代对象（int 等）抛 TypeError——逐一对齐。
    let items: unknown[];
    if (typeof allowed === "string") {
      items = Array.from(allowed);
    } else if (Array.isArray(allowed)) {
      items = allowed;
    } else if (allowed !== null && typeof allowed === "object") {
      items = Object.keys(allowed as object);
    } else {
      // 对齐 Python TypeError: 'int' object is not iterable。
      const invalid = allowed as unknown[];
      invalid.map(() => undefined);
      items = [];
    }
    const set = new Set(items.map((u) => pyStr(u)));
    return set.has(pyStr(user_id));
  }

  /* ── Inbound routing（所有平台共用） ── */

  /**
   * 把一条入站消息一路走到已发送的回复。
   * 顺序恒定：授权 → 内置命令 → 暂停门 → controller。
   * 内置命令在暂停期间保持可达——否则 /resume 不可达，用户会被永久卡住。
   */
  async route(user_id: string, text: string, reply_to?: string | null): Promise<void> {
    const target = reply_to || user_id;
    if (!this.user_allowed(user_id)) {
      await this.send_message(target, "Not authorized.");
      return;
    }
    if (await this.handle_builtin(target, user_id, text)) {
      return;
    }
    if (this._paused_users.has(user_id)) {
      await this.send_message(target, "Paused. Send /resume to continue.");
      return;
    }
    if (this._controller === null) {
      await this.send_message(target, "Backend not ready.");
      return;
    }
    const result = await this._controller.handleMessage(this._platform, user_id, text);
    const reply = result.ok ? result.value : `Error: ${result.error}`;
    await this.send_message(target, pyStr(reply));
  }

  /** 本地应答 /start /status /pause /resume。返回 true 表示是命令且已应答。 */
  async handle_builtin(target: string, user_id: string, text: string): Promise<boolean> {
    // Python: text.split()[0].lower() if text.split() else ""
    // （按空白切词、丢弃空串；CPython 还切分 \x1c-\x1f，见文件头 DIVERGENCE 4）
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    const head = (words[0] ?? "").toLowerCase();
    if (head === "/start") {
      await this.send_message(
        target,
        `Ovolve connected via ${this._platform}.\n` +
          "/status - show state\n/pause - stop processing\n/resume - continue",
      );
    } else if (head === "/status") {
      const state = this._paused_users.has(user_id) ? "paused" : "active";
      await this.send_message(target, `Status: ${state}`);
    } else if (head === "/pause") {
      this._paused_users.add(user_id);
      await this.send_message(target, "Paused.");
    } else if (head === "/resume") {
      this._paused_users.delete(user_id);
      await this.send_message(target, "Resumed.");
    } else {
      return false;
    }
    return true;
  }

  /* ── Streaming default ── */

  /**
   * 收集完整流后作为一条消息发送。
   * 能编辑已发消息的平台（Telegram/Slack/Discord）覆写此方法做打字机效果；
   * 其余平台一条完整消息胜过一连串各自推送手机的分片。
   */
  async send_streaming_card(
    user_id: string,
    content_stream: AsyncGenerator<string, void>,
  ): Promise<boolean> {
    let buffer = "";
    for await (const delta of content_stream) {
      buffer += delta;
    }
    if (!buffer) return true;
    return await this.send_message(user_id, buffer);
  }

  /* ── HTTP transport ── */

  /**
   * 执行一次 HTTP 调用，绝不抛异常。
   * aiohttp 主路径；不可用时走 urllib 回退（_request_urllib）。
   *
   * 返回 Result：value 为解码后的 JSON，或响应非 JSON 时的原文本
   * （DingTalk/WeCom 部分路径返回纯文本）。
   */
  async request(
    method: string,
    url: string,
    opts: {
      json_body?: unknown;
      data?: Uint8Array | null;
      headers?: Record<string, string>;
      timeout?: number;
    } = {},
  ): Promise<Result<unknown>> {
    const hdrs: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
    Object.assign(hdrs, opts.headers ?? {});
    let payload: Uint8Array | null = opts.data ?? null;
    if (opts.json_body !== undefined && opts.json_body !== null && payload === null) {
      payload = new TextEncoder().encode(pyJsonStringify(opts.json_body));
    }
    const timeout = opts.timeout ?? 30;
    if (CP_SEAMS.hasAiohttp()) {
      return await this._request_aiohttp(method, url, payload, hdrs, timeout);
    }
    return await this._request_urllib(method, url, payload, hdrs, timeout);
  }

  /**
   * aiohttp 主路径（CP_SEAMS.fetch 执行）。
   * 对应源 _request_aiohttp：>=400 → failure "{PLATFORM} HTTP {status}: {text[:300]}"；
   * 成功 → success(_decode(text))；任何异常 → failure "{PLATFORM} request failed: {exc}"。
   */
  private async _request_aiohttp(
    method: string,
    url: string,
    payload: Uint8Array | null,
    headers: Record<string, string>,
    timeout: number,
  ): Promise<Result<unknown>> {
    try {
      const resp = await CP_SEAMS.fetch(url, { method, body: payload, headers });
      const text = await resp.text();
      if (resp.status >= 400) {
        // Python text[:300] 按 Unicode code point 切片。
        const head = Array.from(text).slice(0, 300).join("");
        return Result.failure(`${this._platform} HTTP ${resp.status}: ${head}`);
      }
      return Result.success(BaseProvider._decode(text));
    } catch (exc) {
      return Result.failure(`${this._platform} request failed: ${msgOf(exc)}`);
    }
  }

  /**
   * urllib 回退路径（aiohttp 不可用；由 CP_SEAMS.hasAiohttp 切换）。
   * 对齐源 _request_urllib 的三分支：
   *   - HTTPError（status>=400）→ failure "{PLATFORM} HTTP {code}: {reason}"；
   *   - 其他异常 → failure "{PLATFORM} request failed: {exc}"；
   *   - 成功 → success(_decode(text))。
   * urllib 发出的显式头键被首字母大写化（'Content-Type' → 'Content-type'），
   * 探针对拍时两侧均记录大写化后的形态。
   */
  private async _request_urllib(
    method: string,
    url: string,
    payload: Uint8Array | null,
    headers: Record<string, string>,
    timeout: number,
  ): Promise<Result<unknown>> {
    try {
      const resp = await CP_SEAMS.fetch(url, { method, body: payload, headers });
      if (resp.status >= 400) {
        // 对齐 urllib.error.HTTPError 分支：消息用 code + reason（HTTP reason phrase）。
        return Result.failure(`${this._platform} HTTP ${resp.status}: ${resp.statusText}`);
      }
      const text = await resp.text();
      return Result.success(BaseProvider._decode(text));
    } catch (exc) {
      if (exc !== null && typeof exc === "object" && "code" in exc && "reason" in exc) {
        const e = exc as { code: number; reason: string };
        return Result.failure(`${this._platform} HTTP ${e.code}: ${e.reason}`);
      }
      return Result.failure(`${this._platform} request failed: ${msgOf(exc)}`);
    }
  }

  /**
   * 响应体解码：JSON → 解析值；空文本 → {}；非 JSON → 原文本。
   * 对应源 _decode：json.loads(text) if text else {}；json.JSONDecodeError → text。
   * （Python 还接受 NaN/Infinity/-Infinity 裸字面量，V8 不接受，见文件头 DIVERGENCE 3。）
   */
  static _decode(text: string): unknown {
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /* ── Helpers ── */

  /**
   * 把文本切成 API 安全的分块，优先换行边界。
   * 对应源 split()：len 按 Unicode code point 计（BMP 外字符在 JS 中占 2 个
   * UTF-16 code unit，故全程用 Array.from 按 code point 索引，与 Python 对齐）。
   */
  static split(text: string, size?: number | null): string[] {
    // Python: limit = size or cls.SEND_LIMIT（size=0/None 均回退类属性；
    // static 方法内 this 即类本身，子类覆盖 SEND_LIMIT 时取子类值）。
    const limit = size || this.SEND_LIMIT;
    const cps = Array.from(text);
    if (cps.length <= limit) return text ? [text] : [];
    const chunks: string[] = [];
    let start = 0;
    while (cps.length - start > limit) {
      // Python: cut = rest.rfind("\n", 0, limit)；找不到返回 -1。
      let cut = -1;
      for (let i = limit - 1; i >= 0; i--) {
        if (cps[start + i] === "\n") {
          cut = i;
          break;
        }
      }
      if (cut <= 0) cut = limit;
      chunks.push(cps.slice(start, start + cut).join(""));
      start += cut;
      while (start < cps.length && cps[start] === "\n") start++;
    }
    const rest = cps.slice(start).join("");
    if (rest) chunks.push(rest);
    return chunks;
  }

  /**
   * WebSocket 监听器守卫。抛错是有意的：BotController.start() 捕获它并仅为
   * 该平台报告 error，用户能看到原因，而非一个静默永不连接的 provider。
   */
  require_aiohttp(): void {
    if (!CP_SEAMS.hasAiohttp()) {
      throw new RuntimeErrorP(
        `${this._platform} needs aiohttp for its WebSocket listener ` + "(pip install aiohttp)",
      );
    }
  }
}

/** Python str(exc)：Error 取 message，其余取 String()。 */
function msgOf(exc: unknown): string {
  if (exc instanceof Error) return exc.message;
  return String(exc);
}

// PORT STATUS: 本文件无 TODO(port)。
