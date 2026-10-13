/**
 * providers/feishu_provider.ts — Feishu (Lark) IMProvider。
 *
 * 源：app/backend/providers/feishu_provider.py（365 行 / 14163 字节，实测以探针为准）。
 * 单元 205 / wave-9，manifest.tsv target=TS。Providers 家族（Units 202–208）成员。
 *
 * ── 基座复用（红线5：不重复 common.ts 的 helper）──
 * feishu.py 的 import 面是 `providers.base.IMProvider` + `result.Result` +
 * `storage.get_storage`（与 telegram 同族），**不** import providers.common，
 * 因此本端口 `extends IMProvider`（providers/base.ts）而非 BaseProvider。
 * 但按任务要求静态 import 已落地基座 providers/common.ts（Unit 202）以复用其
 * **接缝**：HTTP / 持久化 / aiohttp 可用性开关全部走 `CP_SEAMS`（fetch /
 * getStorage / hasAiohttp），不再各自声明一份 fetch 假件——两侧探针通过
 * COMMON._set_seams_for_parity 注入记录型假件，传输层与真 storage 都被虚拟化。
 * FS_SEAMS 只补源里 CP_SEAMS 未覆盖的两个时钟宿主触点：
 *   - now:       time.time()（_ensure_token 的缓存有效判定与到期算术）。
 *   - monotonic: time.monotonic()（send_streaming_card 的 1.0s 更新节流）。
 * hashlib.sha256 → node:crypto（纯 CPU、无 I/O，按 RULEBOOK §1/§2 直接静态 import）。
 * json.dumps → 本文件 pyJsonDumpsAsciiTrue / pyJsonDumpsFalse（逐字复刻 CPython
 *   json.encoder.ESCAPE/ESCAPE_ASCII 语法：\b \f 命名字面、其余控制符 \u00xx、
 *   ensure_ascii=True 时把 >0x7f 转成 \ud83d\ude00 代理对）。
 * urllib.request → 复用 CP_SEAMS.fetch（urllib 回退臂）；asyncio.to_thread 直接 await
 *   （见 DIVERGENCE 2）。
 *
 * ── 可观测面（与源码逐行核对后的真实表面）──
 *  1. 事件回调验签：SHA256(timestamp+nonce+encrypt_key+body) 与 X-Lark-Signature
 *     的定长逐字符比较（源里注释写"constant-time"，实为 `zip` 短路——保留注释）。
 *  2. URL 验证 challenge 回显：payload 含 "challenge" 时原样回显 {"challenge": ...}。
 *  3. tenant_access_token 获取与缓存：auth=False POST，expire 缺省 7200、
 *     提前 TOKEN_EXPIRY_BUFFER=300s 续期；`_tenant_token and time.time() <
 *     _token_expires_at` 命中则跳过。
 *  4. im/v1 文本发送 / 互动卡片流式（create -> update）与交互式卡片消息 PATCH。
 *  5. 内置命令 /start /status /pause /resume（本文件自带，非基座 handle_builtin）。
 *  6. fail-closed allow-list（_user_allowed）。
 *  7. 双 HTTP 通道：aiohttp 主路径（status!=200 或 code!=0 → "Feishu {status}: {data}"）
 *     与 urllib 回退（HTTPError → "HTTP {code}: {reason}"；否则 code!=0 →
 *     "Feishu error: {result}"）。两臂错误文案不同，是源里刻意保留的双路径可观测差异。
 *
 * ── 源自带缺陷（bug-for-bug 原样保留，绝不修）──
 *  S1  模块 docstring 声称实现了 "event-callback decryption (AES)" 与
 *      "verification-token ... checks"，**源码里既无 AES 解密、也无任何
 *      verification_token 校验**：handle_webhook 只在 encrypt_key 非空时做 SHA256
 *      验签，从不解密 enc 字段、从不比对 verification_token。端口忠实实现"实际代码"，
 *      不臆造 docstring 描述的 AES/token 行为。
 *  S2  `self._verification_token` 在 __init__ 读取并保存，但整个模块**从未再引用**
 *      ——死配置，逐字保留（不删除、不使用）。
 *  S3  handle_webhook：`json.loads(body.decode())` 之后先做 `"challenge" in payload`。
 *      payload 为非映射 JSON 时崩溃面与源一致：int/float/bool → `in` 抛
 *      TypeError（'int' object is not iterable）；str/list → `in` 走成员/子串判定
 *      （通常 False）后紧接 `payload.get("header")` 抛 AttributeError。均未捕获。
 *  S4  handle_webhook：v2.0 分支 `header.get("event_type")` 假设 header 是 dict；
 *      若 payload["header"] 为真值非映射（list/str/int）→ AttributeError 未捕获。
 *  S5  _handle_message_event：`event.get(...)` / `sender.get("sender_id",{}).get(...)`
 *      链假设每个子对象都是映射；任一为真值非映射 → AttributeError。
 *      `content_json.get("text","").strip()`：content 内层 JSON 若解析出非 dict →
 *      .get AttributeError；text 若为真值非 str（数字/list）→ .strip AttributeError。
 *  S6  _user_allowed：`user_id in allowed` 当 allowed 为 str 时是**子串包含**
 *      （"ab" in "xaby" 为 True，非成员判定），当 allowed 为 int 等非可迭代 →
 *      TypeError；均为源行为，逐字保留。
 *  S7  _ensure_token：`int(data.get("expire", 7200))` 对不可 int() 的 expire
 *      （"abc"→ValueError、None→TypeError、inf→OverflowError、1.9→截断为 1）
 *      全部未捕获，异常从 send_message / start_listening 直冲出去。
 *  S8  _ensure_token 续期后**不看** data 是否为映射：r.ok 已保证 aiohttp 臂里
 *      data.get("code") 未崩，但 `data.get("tenant_access_token","")` 仍依赖 data
 *      是 dict（源里 code 判定已隐含，端口保持同一假设）。
 *  S9  send_streaming_card：`(r.value or {}).get("data", {}).get("message_id")`
 *      ——data 键 present-but-null（`{"data": null}`）时 `.get("message_id")` 抛
 *      AttributeError（`pyTruthy(r.value)` 为真、或 {} 走不到，直接对 null 调 .get）。
 *
 * ── DIVERGENCE(port) ──
 *  1. aiohttp → CP_SEAMS.fetch：与基座 Unit 202 D1 同源。等价性：探针只检验构建出的
 *     URL、Headers、Body JSON、以及解析后的 status/code，传输层（真 socket / 真
 *     HTTP）差异不可观测；两臂（aiohttp / urllib）各自的消息格式在端口里逐字保留。
 *  2. `asyncio.to_thread(self._post_urllib, ...)` → 直接 `await this._post_urllib(...)`：
 *     CPython 把阻塞的 urllib 调用丢进线程池，JS 无阻塞管道读故本就在异步栈里。
 *     线程边界对本模块不可观测——探针把 fetch 换成同步/立即 resolve 的记录假件，
 *     两侧账本行序由源码控制流唯一决定，不引入并发任务（at-most-one-task 不变式）。
 *  3. hashlib.sha256 → node:crypto createHash("sha256")：对相同输入字节序列产生
 *     相同十六进制摘要，逐字符相等（探针用固定夹具钉死）。
 *  4. time.time()/time.monotonic() → FS_SEAMS 接缝：默认 Date.now()/1000、
 *     performance.now()/1000；探针钉死为步进时钟，缓存/节流判定两侧一致。
 *  5. 裸 NaN/Infinity JSON 字面量：CPython json.loads 接受（返回 float，随后在
 *     `in`/`.get` 处按 S3 崩），V8 JSON.parse 拒绝（被 handle_webhook 的 except
 *     捕获 → 400 Invalid JSON）。该报文不是合法飞书事件，场景表不生成，差异不可达。
 *  6. int() 的 Unicode 数字（全角 '１２３'）：CPython 接受，本文件 pyInt 只认
 *     ASCII 语法。飞书 API 的 expire 字段恒为 ASCII 整数，可达行为完全一致。
 *  7. str(dict) 的键序：CPython 保插入序，JS 把"整数样字符串键"提前。本文件
 *     str()/f-string 落面的 dict 只来自 API 响应（code/msg/data/tenant_access_token
 *     等非数字键），差异不可达；场景表不向这些 dict 注入数字样键。
 *  8. Python int/float 类型标签（123 vs 123.0 → str() "123" vs "123.0"）：JS 同为
 *     number。经 str()/f-string 落到面值上的数字在场景表里恒为整数或字符串。
 *
 * PORT STATUS: confidence=high todos=0
 */

import { createHash } from "node:crypto";
import { IMProvider } from "./base.js";
import { Result } from "../result.js";
import { CP_SEAMS } from "./common.js";
import type { ProviderControllerLike } from "./common.js";

/* ════════════════════════════════════════════════════════════════════
 * Seams（红线5：时钟隔离；HTTP / 持久化 / aiohttp 开关复用基座 CP_SEAMS）
 * ════════════════════════════════════════════════════════════════════ */

export interface FeishuSeams {
  /** 取代 time.time()：epoch 秒（浮点）。 */
  now: () => number;
  /** 取代 time.monotonic()：单调秒。 */
  monotonic: () => number;
}

export const FS_SEAMS: FeishuSeams = {
  now: () => Date.now() / 1000,
  monotonic: () => performance.now() / 1000,
};

/** 探针注入入口（与 common.ts 的 _set_seams_for_parity 同模式）。 */
export function _set_seams_for_parity(overrides: Partial<FeishuSeams>): void {
  Object.assign(FS_SEAMS, overrides);
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

/** CPython bool(float('nan')) 为 True（NaN != 0），与 JS Boolean(NaN)===false 相反。 */
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
 * （`'str' object has no attribute 'get'`），复刻源缺陷 S3/S4/S5 的崩溃面。
 * present-but-null 返回 null，不是 default（S9）。
 */
function dictGet(obj: unknown, key: string, defaultValue: unknown = null): unknown {
  if (!isDict(obj)) {
    throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  return key in obj ? obj[key] : defaultValue;
}

/**
 * python `a == b`（JSON 域）：bool 是 int 子类（True==1、False==0），None 只等于
 * None，容器递归逐元素/逐键，跨类型（str vs 数字）恒 False。用于 `_user_allowed`
 * 的列表成员判定与 `in` 语义，杜绝把 123 与 "123" 误判为相等。
 */
function pyEq(a: unknown, b: unknown): boolean {
  const nullish = (x: unknown) => x === null || x === undefined;
  if (nullish(a) || nullish(b)) return nullish(a) && nullish(b);
  const numish = (x: unknown): number | null => {
    if (typeof x === "number") return x;
    if (typeof x === "boolean") return x ? 1 : 0;
    return null;
  };
  const na = numish(a);
  const nb = numish(b);
  if (na !== null && nb !== null) return na === nb;
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  }
  if (isDict(a) && isDict(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && pyEq(a[k], b[k]));
  }
  return false;
}

/**
 * python `needle in container`（严格 CPython 语义，逐字复刻源缺陷 S3/S6）：
 *   - dict  → 键成员：JSON 键恒为 str，故非 str needle 恒 False（不抛，123 in {}）。
 *   - list  → 逐元素 pyEq（含 bool<->int 交叠，但不做 str<->number 强转）。
 *   - str   → 子串；needle 非 str 抛 TypeError
 *             （`'in <string>' requires string as left operand, not X`）。
 *   - 其余（int/float/bool/None 等非可迭代）→ TypeError（`'int' object is not iterable`）。
 */
function pyIn(needle: unknown, container: unknown): boolean {
  if (isDict(container)) {
    return typeof needle === "string" && Object.prototype.hasOwnProperty.call(container, needle);
  }
  if (Array.isArray(container)) {
    return container.some((el) => pyEq(el, needle));
  }
  if (typeof container === "string") {
    if (typeof needle !== "string") {
      throw new TypeErrorP(
        `'in <string>' requires string as left operand, not ${pyTypeName(needle)}`,
      );
    }
    return container.includes(needle);
  }
  throw new TypeErrorP(`argument of type '${pyTypeName(container)}' is not iterable`);
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
  const a = Array.from(s);
  let lo = 0;
  let hi = a.length;
  while (lo < hi && pyIsSpace(a[lo] as string)) lo++;
  while (hi > lo && pyIsSpace(a[hi - 1] as string)) hi--;
  return a.slice(lo, hi).join("");
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
 * python int(x)（无 base）：bool 直转；float 截断向零；str 走 ASCII 语法；
 * NaN/Inf 分别 ValueError/OverflowError；其余类型 TypeError（源缺陷 S7 全保留）。
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

/** python json.dumps(v)：默认 ensure_ascii=True、separators (', ', ': ')。 */
function escAscii(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp === 0x08) out += "\\b";
    else if (cp === 0x0c) out += "\\f";
    else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
    else if (cp <= 0x7f) out += ch;
    else if (cp <= 0xffff) out += "\\u" + cp.toString(16).padStart(4, "0");
    else {
      const c = cp - 0x10000;
      const hi = 0xd800 + (c >> 10);
      const lo = 0xdc00 + (c & 0x3ff);
      out += "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0");
    }
  }
  return out + '"';
}

/** python json.dumps(v, ensure_ascii=False)：非 ASCII 原样保留，控制符仍转义。 */
function escFalse(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp === 0x08) out += "\\b";
    else if (cp === 0x0c) out += "\\f";
    else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

function dumpsValue(v: unknown, ascii: boolean): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new TypeErrorP("ValueError: Out of range float values are not JSON compliant");
    }
    return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  }
  if (typeof v === "string") return ascii ? escAscii(v) : escFalse(v);
  if (Array.isArray(v)) return "[" + v.map((x) => dumpsValue(x, ascii)).join(", ") + "]";
  if (isDict(v)) {
    return (
      "{" +
      Object.entries(v)
        .map(([k, val]) => `${ascii ? escAscii(k) : escFalse(k)}: ${dumpsValue(val, ascii)}`)
        .join(", ") +
      "}"
    );
  }
  return "null";
}

/** CPython json.dumps(v)（ensure_ascii=True）。用于发往 HTTP 的外层 body。 */
function pyJsonDumpsAsciiTrue(v: unknown): string {
  return dumpsValue(v, true);
}

/** CPython json.dumps(v, ensure_ascii=False)。用于 content 内层 JSON 串。 */
function pyJsonDumpsFalse(v: unknown): string {
  return dumpsValue(v, false);
}

/** 严格 UTF-8 解码（坏字节 → 抛错，对齐 Python bytes.decode("utf-8") 的 UnicodeDecodeError）。 */
function decodeUtf8Strict(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** python str(exc)：Error 取 message，其余取 String()。 */
function msgOf(exc: unknown): string {
  if (exc instanceof Error) return exc.message;
  return String(exc);
}

/** 把 body（dict）序列化成 aiohttp `json=` / urllib data 字节，逐字对齐 json.dumps。 */
function encodeBody(body: unknown): Uint8Array {
  return new TextEncoder().encode(pyJsonDumpsAsciiTrue(body));
}

/**
 * python `json.loads(s)` 的等价物：仅接受 str（其它类型抛 TypeError，与源一致——
 * aiohttp resp.json / urllib 的 json.loads(content) 都只喂 str；喂非 str 的
 * `message.get("content")` 触发源缺陷 S5 的 TypeError 逃逸）。str 非法 JSON →
 * 抛 name="JSONDecodeError" 的错误（对应 json.JSONDecodeError）。解码错误文案
 * 跨语言不同，但该消息在本模块不可观测（见文件头），端口只在成功路径使用结果。
 */
function pyLoads(s: unknown): unknown {
  if (typeof s !== "string") {
    throw new TypeErrorP(`the JSON object must be str, bytes or bytearray, not '${pyTypeName(s)}'`);
  }
  try {
    return JSON.parse(s);
  } catch {
    const e = new Error("Expecting value");
    e.name = "JSONDecodeError";
    throw e;
  }
}

/** python `x != 0`（x 为 JSON 标量/容器）：False==0、True!=0、其余类型 !=0 恒真。 */
function pyNeInt0(v: unknown): boolean {
  if (typeof v === "number") return v !== 0;
  if (typeof v === "boolean") return v === true;
  return true;
}

/* ════════════════════════════════════════════════════════════════════
 * FeishuProvider
 * ════════════════════════════════════════════════════════════════════ */

export class FeishuProvider extends IMProvider {
  static API_BASE: string = "https://open.feishu.cn/open-apis";
  /** Refresh 5min before expiry (token lasts 2h). */
  static TOKEN_EXPIRY_BUFFER: number = 300;

  protected storage: ReturnType<typeof CP_SEAMS.getStorage>;
  protected _config: Record<string, unknown>;
  // 源码 `self._app_id = self._config.get("app_id","")` 无 str() 强转：值原样存
  // （可能是 None/int/list 等），仅在 is_configured 的 bool() 真值判定、_ensure_token
  // 的 json.dumps body 里按原类型使用。端口逐字保持"原样存"，故类型为 unknown。
  protected _app_id: unknown;
  protected _app_secret: unknown;
  protected _encrypt_key: unknown;
  /** 源缺陷 S2：读取并保存但整个模块从未再引用（死配置，逐字保留）。 */
  protected _verification_token: unknown;
  // 源里 `self._tenant_token: str = ""` 之后 `_ensure_token` 赋 `data.get(...,"")`
  // （仍无 str()）；仅在 `if auth and self._tenant_token` 真值判定与
  // f"Bearer {...}" 的 str 落面上使用，故原样存 unknown。
  protected _tenant_token: unknown = "";
  protected _token_expires_at: number = 0.0;
  protected _running: boolean = false;
  protected _controller: ProviderControllerLike | null = null;
  protected _paused_users = new Set<string>();

  /** python `self.X` 的类属性视图（static 沿继承链查找 == cls.X）。 */
  private _cls(): typeof FeishuProvider {
    return this.constructor as typeof FeishuProvider;
  }

  constructor() {
    super();
    this.storage = CP_SEAMS.getStorage();
    this._config =
      (this.storage.get_bot_state("feishu:config", {}) as Record<string, unknown>) || {};
    // 原样取（无 pyStr）：与源 `self._config.get(k, "")` 逐字对齐（见字段注释）。
    this._app_id = dictGet(this._config, "app_id", "");
    this._app_secret = dictGet(this._config, "app_secret", "");
    this._encrypt_key = dictGet(this._config, "encrypt_key", "");
    this._verification_token = dictGet(this._config, "verification_token", "");
    this._tenant_token = "";
    this._token_expires_at = 0.0;
    this._running = false;
    this._controller = null;
    this._paused_users = new Set();
  }

  /* ------------------------------------------------------------------ */
  /* IMProvider contract                                                */
  /* ------------------------------------------------------------------ */

  get_platform_id(): string {
    return "feishu";
  }

  override is_configured(): boolean {
    return pyTruthy(this._app_id) && pyTruthy(this._app_secret);
  }

  /** Store the controller reference; actual listening is webhook-based. */
  override async start_listening(controller: unknown): Promise<void> {
    this._controller = (controller as ProviderControllerLike | null) ?? null;
    this._running = true;
    // Pre-fetch a tenant token so first message doesn't pay the latency.
    await this._ensure_token();
  }

  override async stop_listening(): Promise<void> {
    this._running = false;
    this._controller = null;
  }

  /** Send a text message to a Feishu user. True on success. */
  override async send_message(user_id: string, content: string): Promise<boolean> {
    await this._ensure_token();
    const body: Record<string, unknown> = {
      receive_id: user_id,
      msg_type: "text",
      content: pyJsonDumpsFalse({ text: content }),
    };
    const r = await this._post(
      `${this._cls().API_BASE}/im/v1/messages?receive_id_type=open_id`,
      body,
    );
    return r.ok;
  }

  /** Stream a reply as a Feishu interactive card (create then update). */
  override async send_streaming_card(
    user_id: string,
    content_stream: AsyncGenerator<string, void>,
  ): Promise<boolean> {
    await this._ensure_token();
    // Create initial card
    const card = this._cls()._build_card("…");
    const body: Record<string, unknown> = {
      receive_id: user_id,
      msg_type: "interactive",
      content: pyJsonDumpsFalse(card),
    };
    const r = await this._post(
      `${this._cls().API_BASE}/im/v1/messages?receive_id_type=open_id`,
      body,
    );
    if (!r.ok) {
      return false;
    }
    // 源缺陷 S9：`(r.value or {}).get("data", {}).get("message_id")` ——
    // data 键 present-but-null（{"data": null}）时对 null 调 .get 抛 AttributeError。
    const messageId = dictGet(dictGet(pyTruthy(r.value) ? r.value : {}, "data", {}), "message_id", null);
    if (!pyTruthy(messageId)) {
      return false;
    }
    const messageIdStr = pyStr(messageId);

    let buffer = "";
    let lastUpdate = 0.0;
    for await (const delta of content_stream) {
      buffer += String(delta);
      const now = FS_SEAMS.monotonic();
      if (now - lastUpdate >= 1.0) {
        await this._update_card(messageIdStr, buffer);
        lastUpdate = now;
      }
    }
    // Final flush
    return await this._update_card_ok(messageIdStr, buffer);
  }

  /* ------------------------------------------------------------------ */
  /* Webhook handling (called by HTTP framework)                        */
  /* ------------------------------------------------------------------ */

  /** Process an incoming Feishu event callback. Returns JSON-serializable dict. */
  async handle_webhook(body: Uint8Array, headers: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Signature verification
    if (this._encrypt_key) {
      if (!this._verify_signature(body, headers)) {
        return { code: 403, msg: "Invalid signature" };
      }
    }

    let payload: unknown;
    try {
      // python: json.loads(body.decode("utf-8"))，except (JSONDecodeError,
      // UnicodeDecodeError)。decodeUtf8Strict 对坏字节抛错（对应
      // UnicodeDecodeError），pyLoads 对非法 JSON 抛 name=JSONDecodeError；
      // 二者都被下方裸 catch 收（源 try 块内仅此两异常源，catch-all 等价）。
      payload = pyLoads(decodeUtf8Strict(body));
    } catch {
      return { code: 400, msg: "Invalid JSON" };
    }

    // URL verification challenge (initial setup)
    if (pyIn("challenge", payload)) {
      return { challenge: dictGet(payload, "challenge", null) };
    }

    // v2.0 event format
    const header = dictGet(payload, "header", {});
    const event = dictGet(payload, "event", {});
    const eventType = pyStr(dictGet(header, "event_type", ""));

    if (eventType === "im.message.receive_v1") {
      await this._handle_message_event(event);
    }

    return { code: 0, msg: "ok" };
  }

  /** Dispatch a message event to the controller. */
  async _handle_message_event(event: unknown): Promise<void> {
    // 源是 `if not self._controller`（真值判断，非 `is None`）：任何假值控制器
    // （0 / "" / False / None）都直接静默 return。故此处必须走 pyTruthy。
    if (!pyTruthy(this._controller)) {
      return;
    }
    const sender = dictGet(event, "sender", {});
    // 源里 sender_id 直接进 `_user_allowed` 与 `send_message`（json.dumps 原类型），
    // 全程无 str()，故原样取（unknown），str 只在最终 send 的 body 里由序列化决定。
    const senderId = dictGet(dictGet(sender, "sender_id", {}), "open_id", "");
    const message = dictGet(event, "message", {});
    const msgType = pyStr(dictGet(message, "message_type", ""));
    const _chatId = dictGet(message, "chat_id", ""); // 源里读取但从不使用（保留死变量）

    if (msgType !== "text") {
      return;
    }
    let contentJson: unknown;
    try {
      // python: content_json = json.loads(message.get("content", "{}"))
      // except json.JSONDecodeError: return
      contentJson = pyLoads(dictGet(message, "content", "{}"));
    } catch (e) {
      // 仅 JSONDecodeError 被源捕获并 return；content 非 str（dict/list/数字）
      // 时 pyLoads 抛 TypeErrorP（json.loads 对非 str 的 TypeError），以及
      // message 非映射时 dictGet 抛 AttributeErrorP —— 均逃逸（源缺陷 S5）。
      if (e && typeof e === "object" && (e as { name?: string }).name === "JSONDecodeError") {
        return;
      }
      throw e;
    }
    // python: text = content_json.get("text", "").strip()
    // .strip() 只对 str 有效；text 值为真值非 str（数字/list/dict/None）→
    // AttributeError 逃逸（源缺陷 S5）。故必须先取原值、判 str、再 strip。
    const rawText = dictGet(contentJson, "text", "");
    if (typeof rawText !== "string") {
      throw new AttributeErrorP(`'${pyTypeName(rawText)}' object has no attribute 'strip'`);
    }
    const text = pyStrip(rawText);
    if (!text) {
      return;
    }

    if (!this._user_allowed(senderId as string)) {
      await this.send_message(senderId as string, "Not authorized.");
      return;
    }

    // Built-in commands
    const handled = await this._handle_builtin(senderId as string, text);
    if (handled) {
      return;
    }
    if (this._paused_users.has(senderId as string)) {
      await this.send_message(senderId as string, "Paused. /resume to continue.");
      return;
    }

    // 守卫已确认真值；源里没有类型系统，这里只有一次纯类型断言（编译期擦除，
    // 运行时值与 `this._controller` 完全一致）。
    const result = await (this._controller as ProviderControllerLike).handleMessage("feishu", senderId as string, text);
    const reply = result.ok ? result.value : `Error: ${result.error}`;
    await this.send_message(senderId as string, pyStr(reply));
  }

  async _handle_builtin(userId: string, text: string): Promise<boolean> {
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    const cmd = (words[0] ?? "").toLowerCase();
    if (cmd === "/start") {
      await this.send_message(userId, "Ovolve connected via Feishu.\n/status /pause /resume");
    } else if (cmd === "/status") {
      const state = this._paused_users.has(userId) ? "paused" : "active";
      await this.send_message(userId, `Status: ${state}`);
    } else if (cmd === "/pause") {
      this._paused_users.add(userId);
      await this.send_message(userId, "Paused.");
    } else if (cmd === "/resume") {
      this._paused_users.delete(userId);
      await this.send_message(userId, "Resumed.");
    } else {
      return false;
    }
    return true;
  }

  /** Fail-closed: no allowed_users list = nobody gets in（源缺陷 S6 保留）。 */
  _user_allowed(userId: string): boolean {
    const allowed = this._config["allowed_users"];
    if (!pyTruthy(allowed)) return false;
    return pyIn(userId, allowed);
  }

  /* ------------------------------------------------------------------ */
  /* Signature verification (X-Lark-Request-Timestamp + Nonce + body)   */
  /* ------------------------------------------------------------------ */

  /**
   * Verify Feishu event signature using SHA256(timestamp+nonce+encrypt_key+body).
   * 源注释声称 constant-time，实际是 len 相等 + `zip` 逐字符短路比较——逐字保留。
   */
  _verify_signature(body: Uint8Array, headers: Record<string, unknown>): boolean {
    const timestamp = dictGet(headers, "x-lark-request-timestamp", "");
    const nonce = dictGet(headers, "x-lark-request-nonce", "");
    const expected = dictGet(headers, "x-lark-signature", "");
    if (!(pyTruthy(timestamp) && pyTruthy(nonce) && pyTruthy(expected))) {
      return false;
    }
    // 源里 timestamp/nonce 进 f-string（str 强转）；expected 进 len()/zip()，
    // 只对 str 有意义——真值非 str（数字/bool）在 `len(computed)==len(expected)`
    // 处抛 TypeError（逃逸 handle_webhook）。列表/映射签名非飞书契约，不覆盖。
    const ts = pyStr(timestamp);
    const nc = pyStr(nonce);
    if (typeof expected !== "string") {
      throw new TypeErrorP(`object of type '${pyTypeName(expected)}' has no len()`);
    }
    const exp = expected;
    const seedBuf = new Uint8Array([
      ...new TextEncoder().encode(`${ts}${nc}${pyStr(this._encrypt_key)}`),
      ...body,
    ]);
    const computed = createHash("sha256").update(seedBuf).digest("hex");
    if (computed.length !== exp.length) return false;
    for (let i = 0; i < computed.length; i++) {
      if (computed[i] !== exp[i]) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* tenant_access_token (2h validity, auto-refresh)                    */
  /* ------------------------------------------------------------------ */

  /** Ensure a valid tenant_access_token, refreshing if needed（源缺陷 S7 保留）。 */
  async _ensure_token(): Promise<void> {
    if (pyTruthy(this._tenant_token) && FS_SEAMS.now() < this._token_expires_at) {
      return;
    }
    const body: Record<string, unknown> = { app_id: this._app_id, app_secret: this._app_secret };
    const r = await this._post(
      `${this._cls().API_BASE}/auth/v3/tenant_access_token/internal`,
      body,
      false,
    );
    if (r.ok && pyTruthy(r.value)) {
      const data = r.value;
      // 源里 tenant_access_token 原样存（无 str()），仅真值判定 + f"Bearer" 落面上用。
      this._tenant_token = dictGet(data, "tenant_access_token", "");
      const expire = pyInt(dictGet(data, "expire", 7200));
      this._token_expires_at = FS_SEAMS.now() + expire - this._cls().TOKEN_EXPIRY_BUFFER;
    }
  }

  /* ------------------------------------------------------------------ */
  /* HTTP helpers                                                       */
  /* ------------------------------------------------------------------ */

  /** POST JSON to Feishu API, auto-adding Authorization header. */
  async _post(url: string, body: Record<string, unknown>, auth: boolean = true): Promise<Result<unknown>> {
    const headersDict: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
    if (auth && pyTruthy(this._tenant_token)) {
      headersDict["Authorization"] = `Bearer ${pyStr(this._tenant_token)}`;
    }

    if (CP_SEAMS.hasAiohttp()) {
      try {
        const resp = await CP_SEAMS.fetch(url, {
          method: "POST",
          body: encodeBody(body),
          headers: headersDict,
        });
        const text = await resp.text();
        // aiohttp: resp.json(content_type=None) 在坏 JSON 上抛错 → except 捕获。
        // 解析在状态判定之前（源顺序），故非 200 + 坏 body 仍报 "request failed"。
        const data = pyLoads(text);
        // 复刻短路 `if resp.status != 200 or data.get("code", -1) != 0:`：
        // status != 200 时 .get 求值被跳过（data 非映射也不抛），
        // 仅 status == 200 才对 data 求 .get（非映射 → AttributeError 逃逸到 except）。
        let bad: boolean;
        if (resp.status !== 200) {
          bad = true;
        } else {
          bad = pyNeInt0(dictGet(data, "code", -1));
        }
        if (bad) {
          return Result.failure(`Feishu ${resp.status}: ${pyStr(data)}`);
        }
        return Result.success(data);
      } catch (e) {
        return Result.failure(`Feishu request failed: ${msgOf(e)}`);
      }
    }
    // _post_urllib 是 @staticmethod（源经 asyncio.to_thread 派发；端口直接 await，
    // DIVERGENCE 2）。TS 禁止经 this 访问静态成员，按本文件 _cls() 惯例调用。
    return await this._cls()._post_urllib(url, body, headersDict);
  }

  /**
   * urllib 回退臂（aiohttp 不可用时；由 CP_SEAMS.hasAiohttp 切换）。
   * 源里经 asyncio.to_thread 派发；端口直接 await（DIVERGENCE 2）。
   */
  static async _post_urllib(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<Result<unknown>> {
    const data = encodeBody(body);
    try {
      const resp = await CP_SEAMS.fetch(url, { method: "POST", body: data, headers });
      if (resp.status >= 400) {
        // urllib.error.HTTPError（status>=400 由探针假件触发）:
        // f"HTTP {e.code}: {e.reason}"，无 "Feishu" 前缀（源刻意保留的双路径差异）。
        return Result.failure(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      const text = await resp.text();
      // python: result = json.loads(resp.read().decode("utf-8"))（读+解析先于 code 判定）。
      const result = pyLoads(text);
      // 无短路：result 非映射时 .get 抛 AttributeErrorP → except 捕获 → "request failed"。
      if (pyNeInt0(dictGet(result, "code", -1))) {
        return Result.failure(`Feishu error: ${pyStr(result)}`);
      }
      return Result.success(result);
    } catch (e) {
      return Result.failure(`Feishu request failed: ${msgOf(e)}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Card helpers                                                       */
  /* ------------------------------------------------------------------ */

  /** Build a minimal interactive card with markdown content. */
  static _build_card(content: string): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true },
      elements: [{ tag: "markdown", content }],
    };
  }

  /** Best-effort card content update. */
  async _update_card(messageId: string, content: string): Promise<void> {
    await this._update_card_ok(messageId, content);
  }

  /** Update card content, returning success state. */
  async _update_card_ok(messageId: string, content: string): Promise<boolean> {
    const card = this._cls()._build_card(content);
    const body: Record<string, unknown> = { content: pyJsonDumpsFalse(card) };
    const r = await this._post(`${this._cls().API_BASE}/im/v1/messages/${messageId}`, body);
    return r.ok;
  }
}

/**
 * python `message.get("content", "{}")` 之后 `json.loads(...)` 的入参规范化：
 * 源里对 content 的值直接 json.loads；若 content 不是 str（是 dict/list/数字），
 * CPython json.loads 会抛 TypeError（逃逸，见 S5），端口把非字符串交给 JSON.parse
 * 也抛错（SyntaxError/TypeError），保持"解析失败"这一可观测类别。此处仅在
 * content 已是字符串时透传；非字符串转成其 str 会掩盖 TypeError，故不做转换。
 */

// PORT STATUS: 本文件无 TODO(port)。
