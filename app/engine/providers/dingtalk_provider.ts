/**
 * providers/dingtalk_provider.ts — DingTalk (钉钉) IMProvider。
 *
 * 源：app/backend/providers/dingtalk_provider.py（192 行）。
 * 单元 203 / wave-9，manifest.tsv target=TS。Providers 家族成员，基座为
 * providers/common.ts（Unit 202，已落地，静态 import，不重复其 helper）。
 *
 * 双通道（与源 docstring 一致）：
 *  - 出站 push 走自定义机器人 webhook，可选 加签 secret 签名；
 *  - 入站是 企业内部机器人 的 outgoing-webhook 回调（app secret 验签），
 *    回调携带短生命周期的 sessionWebhook，回答应落回该会话线程。
 *
 * ── 接缝（红线5：HTTP / 时钟 / print 全部隔离）──
 * HTTP 复用基座 CP_SEAMS.fetch（providers/common.ts），本文件不重复声明；
 * DT_SEAMS 只补源里其余的三个宿主触点：
 *   - now:   time.time()（_resolve_target 会话过期判定、_verify 防重放窗口、
 *            _signed_webhook 的毫秒时间戳、handle_webhook 的 1200s 兜底）。
 *            默认 Date.now()/1000；探针必须钉死。
 *   - print: print() 的三处用户可见输出（no webhook / send failed）。
 *            默认 console.log；探针替换为记录型假件。
 * Python 侧函数级 import（base64/hashlib/hmac → node:crypto，为纯 CPU 计算，
 * 无 I/O，按 RULEBOOK §1/§2 惯例直接静态 import，不走 seam；
 * urllib.parse.quote_plus → 本文件 pyQuotePlus，逐字实现 CPython 语法）。
 *
 * ── 源自带缺陷（bug-for-bug 原样保留，不修）──
 *  D1  handle_webhook：payload 不是 dict（如 `null`、`[1,2]`、`"str"`、`5`）时
 *      `payload.get(...)` 抛 AttributeError 直接冲出函数（不在 try 内）。
 *  D2  handle_webhook：payload["text"] 为真值但非 dict（字符串/列表/数字）时
 *      `(...).get("content")` 同样抛 AttributeError。
 *  D3  handle_webhook：sessionWebhookExpiredTime 是不可 float() 的字符串时
 *      float() 抛 ValueError 未捕获。
 *  D4  send_message：errcode 是非数字字符串/容器时 int() 抛 ValueError/TypeError，
 *      inf 时抛 OverflowError——均未捕获（int(True)=1、int(1.9)=1、int("0")=0 等等
 *      CPython 语法全部保留）。
 *  D5  _verify：timestamp 头是不可 int() 的非字符串真值（如 [..] / {}）时
 *      TypeError 未捕获（只有 ValueError 被 except）。
 *  D6  is_configured 只看 webhook/app_secret，secret-only 判为未配置（源注释
 *      明示这是特性）。
 *  D7  print 的 `f"...{r.error or data}"`：error 为空串时打的是 dict 的
 *      Python repr（单引号、True/False/None），端口用本文件 pyStr 逐字复刻。
 *
 * ── DIVERGENCE(port) ──
 *  1. aiohttp → CP_SEAMS.fetch：与基座 Unit 202 的第 1 条同源——providers 的
 *     探针只检验构建出的 URL/Headers/Body JSON/状态码解析，传输层差异不可观测。
 *  2. NaN/Infinity 裸 JSON 字面量：CPython json.loads 接受（得到 float，随后
 *     在 payload.get 处按 D1 崩 AttributeError）；V8 JSON.parse 拒绝（被
 *     handle_webhook 的 except 捕获 → 400 invalid JSON）。两侧对"外部恰好
 *     发来裸 NaN"的反应本就不一致，且该输入不是合法 DingTalk 报文，
 *     场景表不生成该输入，差异不可达；记此存档。
 *  3. int()/float() 的 Unicode 数字（'１２３'、全角）：CPython 接受，本文件
 *     pyInt/pyFloat 只认 ASCII 语法。HTTP 头与 JSON 数字在本协议里恒为 ASCII，
 *     探针场景覆盖 ASCII 全集语法（符号/下划线/空白/inf/nan/"1.5"），可达
 *     行为完全一致。
 *  4. str(dict) 的键序：CPython 保插入序；JS 对象把"整数样字符串键"排到前面。
 *     本文件打印的 dict 恒来自 DingTalk API 响应（errcode/errmsg 等非数字键），
 *     差异不可达；场景表不向这些 dict 注入数字样键。
 *  5. Python int/float 判别（123 vs 123.0 → str() "123" vs "123.0"）：JS 同为
 *     number。探针场景里所有经 str()/f-string 落面的数字要么整值要么两侧
 *     一致的 float 字面量；不做 int/float 类型标签区分。
 *
 * PORT STATUS: confidence=high todos=0
 */

import { createHmac } from "node:crypto";
import { BaseProvider } from "./common.js";
import type { ProviderControllerLike } from "./common.js";

/* ════════════════════════════════════════════════════════════════════
 * Seams（红线5：时钟 / print 隔离；HTTP 走基座 CP_SEAMS）
 * ════════════════════════════════════════════════════════════════════ */

export interface DingTalkSeams {
  /** 取代 time.time()：epoch 秒（浮点）。 */
  now: () => number;
  /** 取代 print()：一行用户可见输出。 */
  print: (line: string) => void;
}

export const DT_SEAMS: DingTalkSeams = {
  now: () => Date.now() / 1000,
  print: (line: string) => {
    console.log(line);
  },
};

/** 探针注入入口（与 common.ts 的 _set_seams_for_parity 同模式）。 */
export function _set_seams_for_parity(overrides: Partial<DingTalkSeams>): void {
  Object.assign(DT_SEAMS, overrides);
}

/* ════════════════════════════════════════════════════════════════════
 * Python 语义辅助（本文件自带，仓库惯例见 HANDOFF_V10 §4.3）
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
class OverflowErrorP extends Error {
  constructor(m: string) {
    super(m);
    (this as { pyMsg?: string }).pyMsg = m;
    this.name = "OverflowError";
  }
}
class AttributeErrorP extends Error {
  constructor(m: string) {
    super(m);
    (this as { pyMsg?: string }).pyMsg = m;
    this.name = "AttributeError";
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

/** Python truthiness。注意：CPython bool(float('nan')) 为 True（NaN != 0），
 *  与 JS 的 Boolean(NaN)===false 相反；±Infinity 同样为 True。 */
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
 * （`'str' object has no attribute 'get'`），复刻源缺陷 D1/D2 的崩溃面。
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

/**
 * python int(x)（无 base）：bool 直转；float 截断向零；str 走 ASCII 语法
 * （允许两端空白、单个符号、数字间下划线）；NaN/Inf 分别 ValueError/OverflowError；
 * 其余类型 TypeError。消息逐字对齐 CPython（比较器只比类型名，消息为文档性）。
 */
function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (Number.isNaN(v)) throw new ValueErrorP("cannot convert float NaN to integer");
    if (v === Infinity || v === -Infinity) {
      throw new OverflowErrorP("cannot convert float infinity to integer");
    }
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const t = pyStrip(v);
    const m = /^[+-]?(?:0|[1-9](?:_?\d)*)$/u.test(t) ? t : null;
    if (m === null) {
      throw new ValueErrorP(`invalid literal for int() with base 10: ${pyStrRepr(v)}`);
    }
    const digits = m.replace(/_/g, "");
    const n = Number(digits);
    if (!Number.isSafeInteger(n)) {
      throw new ValueErrorP(`invalid literal for int() with base 10: ${pyStrRepr(v)}`);
    }
    return n;
  }
  throw new TypeErrorP(
    `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`,
  );
}

/**
 * python float(x)：bool→0.0/1.0；number 直传；str 走 ASCII 语法
 * （空白、符号、小数、指数、inf/infinity/nan 大小写不敏感、下划线分隔）。
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
    if (/^(?:0|[1-9](?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?(?:[eE][+-]?\d+)?$/u.test(body) ||
        /^\.(?:\d(?:_?\d)*)?(?:[eE][+-]?\d+)?$/u.test(body)) {
      const cleaned = body.replace(/_/g, "");
      if (/\d/u.test(cleaned)) return sign * Number(cleaned);
    }
    throw new ValueErrorP(`could not convert string to float: ${pyStrRepr(v)}`);
  }
  throw new TypeErrorP(
    `float() argument must be a string or a number, not '${pyTypeName(v)}'`,
  );
}

/** python urllib.parse.quote_plus(s, safe='')：字母数字与 `_.-~` 保留，空格→+，其余 UTF-8 %XX 大写。 */
function pyQuotePlus(s: string): string {
  const unreserved = new Set(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~".split(""),
  );
  let out = "";
  for (const ch of s) {
    if (unreserved.has(ch)) out += ch;
    else if (ch === " ") out += "+";
    else {
      for (const b of new TextEncoder().encode(ch)) {
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

/**
 * python hmac.compare_digest(computed, expected)。
 * CPython（_operator._compare_digest，3.13 实测）：str 与非 str 比较抛
 * TypeError；两个 str 但含非 ASCII 字符同样抛 TypeError（"comparing strings
 * with non-ASCII characters is not supported"）。消息文本跨语言不可比，
 * 比较器只对齐类型名 TypeError。
 */
function pyCompareDigest(computed: string, expected: unknown): boolean {
  if (typeof expected !== "string") {
    throw new TypeErrorP(
      `value (${pyTypeName(expected)}) should be bytes, bytearray or str: it is <class '${pyTypeName(expected)}'>`,
    );
  }
  for (const ch of expected) {
    if (ch.codePointAt(0) as number > 127) {
      throw new TypeErrorP("comparing strings with non-ASCII characters is not supported");
    }
  }
  return computed === expected;
}

/* ════════════════════════════════════════════════════════════════════
 * DingTalkProvider
 * ════════════════════════════════════════════════════════════════════ */

export class DingTalkProvider extends BaseProvider {
  static override PLATFORM = "dingtalk";
  /** The robot API rejects longer bodies; split before it does. */
  static override SEND_LIMIT = 3500;
  /** Reject callbacks whose timestamp is older than this, so a captured
   *  request can't be replayed tomorrow. */
  static SIGN_WINDOW_S = 3600;

  protected _webhook: string;
  protected _secret: string;
  protected _app_secret: string;
  /** staffId -> [sessionWebhook, expires_at_epoch_seconds]（python dict → Map，保插入序） */
  protected _sessions = new Map<string, [string, number]>();

  /** python `self.X` 的类属性视图（static 沿继承链查找 == cls.X）。 */
  private _cls(): typeof DingTalkProvider {
    return this.constructor as typeof DingTalkProvider;
  }

  constructor() {
    super();
    this._webhook = this.cfg("webhook");
    this._secret = this.cfg("secret");
    this._app_secret = this.cfg("app_secret");
  }

  /* ------------------------------------------------------------------ */
  /* Contract                                                            */
  /* ------------------------------------------------------------------ */

  override is_configured(): boolean {
    // Either direction alone is useful: push-only with just a webhook,
    // listen-only with just an app secret.
    return pyTruthy(this._webhook) || pyTruthy(this._app_secret);
  }

  /** Nothing to dial — inbound is push. Just hold the controller. */
  override async start_listening(controller: unknown): Promise<void> {
    this._controller = controller as ProviderControllerLike | null;
    this._running = true;
  }

  override async stop_listening(): Promise<void> {
    this._running = false;
    this._controller = null;
    this._sessions.clear();
  }

  /**
   * Send text to a session webhook, a known staff id, or the group robot.
   * @param user_id a `https://…` session webhook, a staffId whose live session
   *   we may still hold, or anything else (falls back to the group robot).
   */
  override async send_message(user_id: string, content: string): Promise<boolean> {
    if (!pyStrip(content)) return true;
    const target = this._resolve_target(user_id);
    if (!target) {
      DT_SEAMS.print("[dingtalk] no webhook to send to (set `webhook` in config)");
      return false;
    }
    let ok = true;
    for (const chunk of this._cls().split(content)) {
      const body = { msgtype: "text", text: { content: chunk } };
      const r = await this.request("POST", target, { json_body: body });
      const data: Record<string, unknown> = isDict(r.value) ? r.value : {};
      const errRaw = dictGet(data, "errcode", 0);
      if (!r.ok || pyInt(pyTruthy(errRaw) ? errRaw : 0) !== 0) {
        DT_SEAMS.print(
          `[dingtalk] send failed: ${pyTruthy(r.error) ? r.error : pyStr(data)}`,
        );
        ok = false;
      }
    }
    return ok;
  }

  /** Pick the URL a reply should go to. */
  _resolve_target(user_id: string): string {
    if (user_id.startsWith("http")) return user_id;
    const cached = this._sessions.get(user_id);
    if (cached !== undefined && cached[1] > DT_SEAMS.now()) return cached[0];
    if (cached !== undefined) {
      // Expired: drop it so the map doesn't grow forever with dead URLs.
      this._sessions.delete(user_id);
    }
    return this._webhook ? this._signed_webhook() : "";
  }

  /* ------------------------------------------------------------------ */
  /* Inbound callback                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Process one outgoing-webhook callback.
   * @param body raw request body. @param headers lowercased-key headers.
   * @returns JSON-serializable response for DingTalk.
   */
  async handle_webhook(
    body: Uint8Array,
    headers: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Fail closed. Without an app secret we cannot tell DingTalk apart from
    // anyone who guessed the URL, and this endpoint drives a live agent.
    if (!this._app_secret) {
      return { errcode: 403, errmsg: "app_secret not configured" };
    }
    if (!this._verify(headers)) {
      return { errcode: 403, errmsg: "invalid signature" };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(this._decodeUtf8Strict(body));
    } catch {
      // python: except (json.JSONDecodeError, UnicodeDecodeError)
      return { errcode: 400, errmsg: "invalid JSON" };
    }

    if (dictGet(payload, "msgtype", null) !== "text") {
      return { errcode: 0, errmsg: "ignored" };
    }
    const textObj = dictGet(payload, "text", null);
    const contentV = dictGet(pyTruthy(textObj) ? textObj : {}, "content", null);
    const text = pyStrip(pyStr(pyTruthy(contentV) ? contentV : ""));
    const s1 = dictGet(payload, "senderStaffId", null);
    const s2 = dictGet(payload, "senderId", null);
    const staff_id = pyStr(pyTruthy(s1) ? s1 : pyTruthy(s2) ? s2 : "");
    if (!(text && staff_id)) {
      return { errcode: 0, errmsg: "ignored" };
    }

    const sw = dictGet(payload, "sessionWebhook", null);
    const session_url = pyStr(pyTruthy(sw) ? sw : "");
    if (session_url) {
      // The expiry arrives in milliseconds; keep it in seconds and shave a
      // little off so we never pick a URL that dies mid-request.
      const expRaw = dictGet(payload, "sessionWebhookExpiredTime", null);
      const expires_ms = pyFloat(pyTruthy(expRaw) ? expRaw : 0);
      const expires = pyTruthy(expires_ms)
        ? expires_ms / 1000.0 - 30
        : DT_SEAMS.now() + 1200;
      this._sessions.set(staff_id, [session_url, expires]);
    }

    await this.route(staff_id, text, session_url || staff_id);
    return { errcode: 0, errmsg: "ok" };
  }

  /** body.decode("utf-8")：严格模式（坏字节 → 抛错，对齐 UnicodeDecodeError）。 */
  private _decodeUtf8Strict(bytes: Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  /**
   * Verify `sign` = base64(HMAC-SHA256(timestamp + "\n" + secret)).
   * Also rejects stale timestamps — a valid signature on an hour-old request is
   * still a replay.
   */
  _verify(headers: Record<string, unknown>): boolean {
    const timestamp = dictGet(headers, "timestamp", "");
    const expected = dictGet(headers, "sign", "");
    if (!(pyTruthy(timestamp) && pyTruthy(expected))) return false;
    let sent_at: number;
    try {
      sent_at = pyInt(timestamp) / 1000.0;
    } catch (e) {
      // python: except ValueError —— 其余类型（TypeError 等）原样上抛（源缺陷 D5）。
      if (e instanceof ValueErrorP) return false;
      throw e;
    }
    if (Math.abs(DT_SEAMS.now() - sent_at) > this._cls().SIGN_WINDOW_S) return false;
    const computed = this._cls()._sign(
      `${pyStr(timestamp)}\n${this._app_secret}`,
      this._app_secret,
    );
    return pyCompareDigest(computed, expected);
  }

  /* ------------------------------------------------------------------ */
  /* Signing                                                             */
  /* ------------------------------------------------------------------ */

  /** base64(HMAC-SHA256(key=secret, msg=string_to_sign))，两侧 UTF-8 编码。 */
  static _sign(stringToSign: string, secret: string): string {
    return createHmac("sha256", Buffer.from(secret, "utf-8"))
      .update(Buffer.from(stringToSign, "utf-8"))
      .digest("base64");
  }

  /** Append `timestamp` + `sign` when the robot has 加签 enabled. */
  _signed_webhook(): string {
    if (!this._secret) return this._webhook;
    const ts = String(Math.trunc(DT_SEAMS.now() * 1000));
    const sign = pyQuotePlus(
      this._cls()._sign(`${ts}\n${this._secret}`, this._secret),
    );
    const joiner = this._webhook.includes("?") ? "&" : "?";
    return `${this._webhook}${joiner}timestamp=${ts}&sign=${sign}`;
  }
}

// PORT STATUS: 本文件无 TODO(port)。
