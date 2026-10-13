/**
 * providers/wecom_provider.ts — WeCom (企业微信) IMProvider。
 *
 * 源：app/backend/providers/wecom_provider.py（276 行）。
 * 单元 208 / wave-9，manifest.tsv target=TS。Providers 家族成员，基座为
 * providers/common.ts（Unit 202，已落地，静态 import，不重复其 helper）。
 *
 * 与其它 provider 不同，WeCom 对每一个入站回调都加密：
 *  - URL 校验（GET echostr）与事件投递（POST XML）都用
 *    ``sha1(sorted([token, timestamp, nonce, payload]))`` 签名；
 *  - 载荷本身是 AES-256-CBC，密钥为 43 字符 ``encoding_aes_key``
 *    （base64，WeCom 侧已把填充位剥掉，源里补回一个 ``=``）。
 *
 * 出站有两条路，自动择优选：
 *  - 自建应用（corp_id + app_secret + agent_id）能对单个人发消息，这是回复的正解；
 *  - 群机器人 webhook_key 只能往群里广播，主动推送仍选它，应用凭证缺失时也是唯一选项。
 *
 * ── 接缝（红线5：HTTP / 时钟 / print / 加密 / cryptography 可用性全部隔离）──
 * HTTP 复用基座 CP_SEAMS.fetch（providers/common.ts），本文件不重复声明；
 * WC_SEAMS 补齐源里其余的宿主触点：
 *   - now:   time.time()（_ensure_token 的缓存判定与到期算术）。默认 Date.now()/1000；
 *            探针必须钉死。
 *   - print: print() 的三处用户可见输出（nothing to send / send failed /
 *            cryptography not installed / decrypt failed）。默认 console.log；
 *            探针替换为记录型假件。
 *   - hasCryptography: 取代 ``try: from cryptography... except ImportError``。
 *            函数级 import 按 RULEBOOK §2 归为接缝（对齐 discord 的 importAiohttp 惯例）；
 *            默认 true，探针翻转以驱动两条分支。
 *   - aesCbcDecrypt: 取代 ``Cipher(AES(key), CBC(key[:16])).decryptor().update+finalize``。
 *            第三方密码库调用按 RULEBOOK §2 归为接缝；默认用 node:crypto 真身
 *            （无自动 PKCS#7——源自己做去填充），探针注入定长假件，绝不产生真实加解密依赖。
 * sha1（hashlib）/ base64 为纯 CPU 计算，无 I/O，直接静态 import node:crypto / 本地实现，
 * 不走 seam（与 dingtalk 的 createHmac 同源惯例）。
 *
 * ── 源自带缺陷（bug-for-bug 原样保留，不修）──
 *  D1  _errcode_ok 的 ``f"...{result.error or data}"``：error 为空串时打的是 dict 的
 *      Python repr（单引号、True/False/None），端口用本文件 pyStr 逐字复刻。
 *  D2  _errcode_ok 的 ``int(data.get("errcode", 0) or 0)``：errcode 是不可 int() 的
 *      非数字真值（字符串 "abc" → ValueError、容器 → TypeError、inf → OverflowError）
 *      时抛错未捕获，一路冲出 send_message；int(1.9)=1、int("0")=0 等 CPython 语法全保留。
 *  D3  _ensure_token 的 ``int(data.get("expires_in", 7200) or 7200)`` 同 D2 的崩溃面。
 *      且刷新失败（access_token 为空）时返回的是旧的（可能已过期的）_access_token，
 *      从不清空缓存 —— 过期 token 会被继续用于发送。
 *      ``str(data.get("access_token") or "")``：access_token 为真值非 str（如 int 123）
 *      时 str(123)="123" 被当作 token。
 *  D4  verify_url / handle_webhook 用 ``query.get(key, "")`` 取 msg_signature/timestamp/
 *      nonce/echostr；query 非 dict 时 .get 抛 AttributeError 未捕获（verify_url/handle_webhook
 *      都不在 try 内）。present-but-null 返回 None，随后 ``if not (expected and ...)`` 判假。
 *      timestamp/nonce/msg_signature/payload 任一为非 str 真值时，``sorted([...])`` 比较
 *      str 与 int 抛 TypeError（"not supported between instances"）未捕获。
 *  D5  _verify_signature 的"constant-time"注释是假的：``all(a==b for a,b in zip(...))``
 *      是普通生成器，遇首个不等立即短路，正是注释声称要规避的逐字节时序侧信道。
 *      且 ``len(computed) == len(expected)`` 里 expected 若非 str（int/None）会
 *      len() 抛 TypeError（同样在 truthy 守卫之后、sorted 未提前抛的边角）。
 *  D6  _decrypt 的 ``msg_len < 0`` 恒假：``int.from_bytes(body[:4], "big")`` 无符号，
 *      永不小于 0 —— 死守卫。
 *  D7  _extract 的 docstring 声称"只在签名校验过的字节上调用"，但 handle_webhook 第一处
 *      ``self._extract(body, "Encrypt")`` 是在【未认证】的原始回调字节上跑 XML 解析器，
 *      只为取出待验签的 Encrypt 字段——文档与实现自相矛盾（先解析后验签）。
 *  D8  receive_id 从明文中解出（``_decrypt`` 返回 ``(message, receive_id)``），但
 *      verify_url/handle_webhook 两个消费方都只取 ``decrypted[0]``（message），
 *      receive_id 被解析却从不校验（不比对 corp_id/agent_id）——认证只覆盖了签名，
 *      没覆盖"这条消息确实是发给本应用的"。
 *  D9  _extract 用 ``xml_bytes.decode("utf-8", errors="replace")`` 预解码：坏 UTF-8 字节
 *      变成 U+FFFD 后仍可能被 ET 当作合法文本解析出（garbage-in，永不抛错）；而 _decrypt
 *      的 message 段用的是【严格】 ``.decode("utf-8")``（坏字节抛 UnicodeDecodeError，被
 *      broad-except 吞成 print）。两处解码点错误处理不对称 —— 本文件逐一复刻：_extract 走
 *      decodeUtf8Replace，_decrypt 的 message 走 decodeUtf8Strict。
 *
 * ── DIVERGENCE(port) ──
 *  1. aiohttp → CP_SEAMS.fetch：与基座 Unit 202 第 1 条同源——探针只检验构建出的
 *     URL/Headers/Body JSON/状态码解析，传输层差异不可观测。
 *  2. cryptography AES → WC_SEAMS.aesCbcDecrypt：第三方密码库函数级 import 归接缝。
 *     等价性：AES-CBC 解密本身是黑盒 I/O（密钥/IV/密文进、明文出），两侧接缝喂入
 *     【完全相同】的原始明文字节后，其后的去填充 / 布局解析 / UTF-8 解码全部是本文件
 *     逐行移植的纯逻辑，探针两侧跑同一份逻辑 —— 真实密码学正确性不在可观测面内。
 *  3. from-cryptography ImportError → WC_SEAMS.hasCryptography()：两分支都可观测，探针翻转。
 *  4. base64.b64decode（validate=False，静默丢弃非字母表字符）→ 本文件 pyB64Decode：
 *     场景只用良构 base64（字母表 + 正确 '=' 填充），良构输入两侧字节完全一致；
 *     非良构输入两侧错误消息文本（binascii vs Buffer）跨语言不可比，且源里该异常被
 *     外层 broad-except 吞成一条 "decrypt failed: {exc}" print，故场景【不】注入触发
 *     b64 抛错的密钥/密文；b64 长度/奇偶不符改由解出的字节数驱动 return-None 分支（可观测）。
 *  5. receive_id 的 ``.decode("utf-8", errors="replace")``：CPython 对每个坏字节产出
 *     一个 U+FFFD，WHATWG TextDecoder 对截断的多字节序列只产出一个 U+FFFD，计数会分歧。
 *     receive_id 只能经直接 _decrypt 探针入口观测（正常流程从不返回它），场景把 receive_id
 *     固定为合法 UTF-8，使 replace 分支不触发；差异记此存档。
 *  6. message 的 ``.decode("utf-8")``（严格）→ fatal TextDecoder：坏字节在 CPython 抛
 *     UnicodeDecodeError、在 V8 抛 TypeError，都被 broad-except 吞成 print；两侧消息文本
 *     不可比。场景保证 message 段恒为合法 UTF-8，此抛错分支不可达；差异记此存档。
 *  7. Python sorted 的码点序 vs JS 的 UTF-16 码元序：本文件 pySortStrings 按 Unicode
 *     码点比较，与 CPython 对齐；纯 ASCII 令牌下与 JS 默认一致。int()/float() 的 Unicode
 *     数字（全角）：CPython 接受、本文件 pyInt 只认 ASCII 语法（同基座 DIVERGENCE 3）。
 *  8. ET.ParseError 的具体消息文本在 _extract 里被丢弃（任何 ParseError 一律 return ""），
 *     故只需两侧对"良构 / 非良构"分类一致即可对齐；本文件 parseXml 实现的是 ET 良构子集
 *     （单根、可选 ``<?xml?>`` 声明/注释/PI/``<!DOCTYPE>`` misc、属性、实体引用、CDATA、
 *     自闭合、嵌套）。经本机 CPython 3.13 实测校准的关键点：已解码 str 上带合法 version 的
 *     ``<?xml ... encoding=...?>`` 声明被 ET 正常接受（并非抛 ValueError）；缺 version 的
 *     ``<?xml?>`` 才是 ParseError；``.text`` 只取起始标签到首个子元素之间的文本，tail 不计入。
 *     场景只取两侧判定一致的良构/明确非良构输入。
 *  9. NaN/Infinity 裸 JSON 字面量（HTTP 响应经基座 _decode）：继承基座 DIVERGENCE 3，
 *     providers 场景不出现。
 *
 * PORT STATUS: confidence=high todos=0
 */

import { createHash, createDecipheriv } from "node:crypto";
import { BaseProvider } from "./common.js";
import type { ProviderControllerLike } from "./common.js";

/* ════════════════════════════════════════════════════════════════════
 * Seams（红线5：时钟 / print / cryptography 可用性 / AES-CBC 隔离；HTTP 走基座 CP_SEAMS）
 * ════════════════════════════════════════════════════════════════════ */

export interface WeComSeams {
  /** 取代 time.time()：epoch 秒（浮点）。 */
  now: () => number;
  /** 取代 print()：一行用户可见输出。 */
  print: (line: string) => void;
  /** 取代 ``try: from cryptography... except ImportError`` 的可用性判定。 */
  hasCryptography: () => boolean;
  /** 取代 Cipher(AES(key), CBC(iv)).decryptor().update(data) + finalize()：
   *  返回【未去填充】的原始明文字节（与 CPython 一致，去填充是调用方的事）。 */
  aesCbcDecrypt: (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => Uint8Array;
}

export const WC_SEAMS: WeComSeams = {
  now: () => Date.now() / 1000,
  print: (line: string) => {
    console.log(line);
  },
  hasCryptography: () => true,
  aesCbcDecrypt: (key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array => {
    // 生产真身：AES-256-CBC，关自动填充（源自己按末字节去 PKCS#7）。
    const dec = createDecipheriv("aes-256-cbc", Buffer.from(key), Buffer.from(iv));
    dec.setAutoPadding(false);
    return new Uint8Array(Buffer.concat([dec.update(Buffer.from(data)), dec.final()]));
  },
};

/** 探针注入入口（与 common.ts 的 _set_seams_for_parity 同模式）。 */
export function _set_seams_for_parity(overrides: Partial<WeComSeams>): void {
  Object.assign(WC_SEAMS, overrides);
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
class IndexErrorP extends Error {
  constructor(m: string) {
    super(m);
    (this as { pyMsg?: string }).pyMsg = m;
    this.name = "IndexError";
  }
}
/** ET.ParseError（仅在 _extract 内部被吞成 ""，从不外泄；用 name 区分以便捕获）。 */
class ParseErrorP extends Error {
  constructor(m: string) {
    super(m);
    (this as { pyMsg?: string }).pyMsg = m;
    this.name = "ParseError";
  }
}

/** python str(exc) / f"{exc}"（Error 取 message，其余取 String()）。 */
function msgOf(exc: unknown): string {
  if (exc instanceof Error) return exc.message;
  return String(exc);
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
 * （`'str' object has no attribute 'get'`），复刻源缺陷 D4 的崩溃面。
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

/** python len(x)：str 按码点、bytes/列表按长度、dict 按键数；非 sized 抛 TypeError。 */
function pyLen(v: unknown): number {
  if (typeof v === "string") return Array.from(v).length;
  if (Array.isArray(v) || v instanceof Uint8Array) return v.length;
  if (isDict(v)) return Object.keys(v).length;
  throw new TypeErrorP(`object of type '${pyTypeName(v)}' has no len()`);
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
 * python sorted([a, b, c, d])（仅本文件用于四个签名字符串）：按 Unicode 码点升序。
 * 与 CPython 一致地，若元素混入不可与 str 比较的类型（int/float/None/list/dict/bool
 * 参与 str 比较）则抛 TypeError（"not supported between instances of ..."）；
 * 全部为 str 时返回码点序新数组（源里紧接 "".join，故元素必为 str 才能走到 sha1）。
 */
function pySortStrings(items: unknown[]): string[] {
  const cps = (s: string): number[] => Array.from(s).map((c) => c.codePointAt(0) as number);
  const cmpStr = (a: string, b: string): number => {
    const ca = cps(a);
    const cb = cps(b);
    const n = Math.min(ca.length, cb.length);
    for (let i = 0; i < n; i++) {
      if (ca[i] !== cb[i]) return (ca[i] as number) < (cb[i] as number) ? -1 : 1;
    }
    return ca.length - cb.length;
  };
  // CPython list.sort 会在第一次比较不可比元素时抛 TypeError；4 元素插入排序足够。
  const out: unknown[] = items.slice();
  for (let i = 1; i < out.length; i++) {
    const cur = out[i];
    if (typeof cur !== "string") {
      // cur 与已排好的一段里某个 str 比较：CPython 必抛 TypeError（bool 与 str 也不可比）。
      throw new TypeErrorP(
        `'<' not supported between instances of 'str' and '${pyTypeName(cur)}'`,
      );
    }
    let j = i - 1;
    while (j >= 0) {
      const other = out[j];
      if (typeof other !== "string") {
        throw new TypeErrorP(
          `'<' not supported between instances of '${pyTypeName(other)}' and 'str'`,
        );
      }
      if (cmpStr(other, cur) <= 0) break;
      out[j + 1] = other;
      j--;
    }
    out[j + 1] = cur;
  }
  return out as string[];
}

/**
 * python base64.b64decode(s)（validate=False）在【良构 base64】子集上的等价实现。
 * 见文件头 DIVERGENCE 4：场景只用良构输入（字母表 + 正确 '=' 填充），良构输入两侧字节
 * 一致；非良构输入的错误消息跨语言不可比且被外层 broad-except 吞掉，故场景不注入。
 */
function pyB64Decode(s: string): Uint8Array {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(s)) {
    throw new ValueErrorP("Invalid base64-encoded string");
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}

/** python int.from_bytes(b[:4], "big")（无符号，最多 4 字节 → 安全整数）。 */
function fromBytesBig(b: Uint8Array): number {
  let n = 0;
  for (const byte of b) n = n * 256 + byte;
  return n;
}

/** python bytes.decode("utf-8")（严格）；坏字节抛（TextDecoder fatal）。见 DIVERGENCE 6。 */
function decodeUtf8Strict(b: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(b);
}

/** python bytes.decode("utf-8", errors="replace")。见 DIVERGENCE 5。 */
function decodeUtf8Replace(b: Uint8Array): string {
  return new TextDecoder("utf-8").decode(b);
}

function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/* ── 极简良构 XML 解析器：与 xml.etree.ElementTree 的 .find(tag).text 语义对齐 ──
 * 只覆盖源实际用到的面：可选 ``<?xml?>`` 声明（含 encoding 声明时按 CPython 抛
 * ValueError，见 D9）、注释、PI、单根元素、嵌套、属性（解析但忽略）、实体引用、
 * CDATA、自闭合。任何非良构输入抛 ParseErrorP（_extract 吞成 ""）。
 * node.text == CPython Element.text：起始标签到首个子元素之间的文本（实体已解），
 * 无则 null（_extract 里 ``node.text or ""`` → ""）。 */

interface PyXmlElement {
  tag: string;
  /** 起始标签与首个子元素之间的文本；无则为 null（对齐 ET .text）。 */
  text: string | null;
  children: PyXmlElement[];
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function isNameStart(ch: string): boolean {
  return /[A-Za-z_]/u.test(ch);
}
function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_.:-]/u.test(ch);
}

function parseXml(input: string): PyXmlElement {
  let i = 0;
  const n = input.length;
  const fail = (): never => {
    throw new ParseErrorP("not well-formed (invalid token)");
  };

  const skipSpace = (): void => {
    while (i < n && (input[i] === " " || input[i] === "\t" || input[i] === "\n" || input[i] === "\r")) i++;
  };

  const consumeDeclOrMisc = (): void => {
    // 处理顶层 misc：`<?xml?>`/`<?pi?>` 声明、`<!--注释-->`、`<!DOCTYPE ...>`。
    // 与本机 CPython 3.13 的 ET 观测对齐：
    //   - 已解码 str 上带 encoding 声明且 version 合法的 ``<?xml ...?>`` 被正常接受
    //     （ET 并不抛 "Unicode strings with encoding declaration..." —— 见 D9）；
    //   - ``<?xml ...?>`` 若缺 version 则视为良构错误（expat: "XML declaration
    //     not well-formed"）→ ParseError；
    //   - DOCTYPE 及其它 ``<! ... >`` 声明按 misc 跳过（Python 场景里能继续解析出根）。
    for (;;) {
      skipSpace();
      if (input.startsWith("<?", i)) {
        const end = input.indexOf("?>", i);
        if (end === -1) fail();
        const body = input.slice(i + 2, end);
        if (/^[xX][mM][lL]/u.test(body) && !/\bversion\b/u.test(body)) fail();
        i = end + 2;
        continue;
      }
      if (input.startsWith("<!--", i)) {
        const end = input.indexOf("-->", i);
        if (end === -1) fail();
        i = end + 3;
        continue;
      }
      if (input.startsWith("<!", i)) {
        const end = input.indexOf(">", i);
        if (end === -1) fail();
        i = end + 1;
        continue;
      }
      return;
    }
  };

  const readName = (): string => {
    if (i >= n || !isNameStart(input[i] as string)) fail();
    const start = i;
    i++;
    while (i < n && isNameChar(input[i] as string)) i++;
    return input.slice(start, i);
  };

  const skipAttributes = (): boolean => {
    // 解析并忽略属性；返回该标签是否自闭合。
    for (;;) {
      skipSpace();
      if (i >= n) fail();
      if (input[i] === ">") {
        i++;
        return false;
      }
      if (input.startsWith("/>", i)) {
        i += 2;
        return true;
      }
      const an = readName();
      skipSpace();
      if (input[i] !== "=") fail();
      i++;
      skipSpace();
      const q = input[i];
      if (q !== '"' && q !== "'") fail();
      i++;
      const vStart = i;
      while (i < n && input[i] !== q) i++;
      if (i >= n) fail();
      void an;
      void vStart;
      i++; // 跳过收尾引号
    }
  };

  const parseElement = (): PyXmlElement => {
    if (input[i] !== "<") fail();
    i++;
    const tag = readName();
    const selfClosed = skipAttributes();
    const el: PyXmlElement = { tag, text: null, children: [] };
    if (selfClosed) return el;
    // 元素体：ET 的 .text == 起始标签到【首个子元素】之间的文本（实体/CDATA 已解），
    // 子元素之后的 tail 不计入本节点 .text。用 textSet 锁定首个子元素前的文本。
    let textBuf = "";
    let sawText = false;
    let textSet = false;
    for (;;) {
      if (i >= n) fail();
      if (input.startsWith("</", i)) {
        i += 2;
        const endTag = readName();
        if (endTag !== tag) fail();
        skipSpace();
        if (input[i] !== ">") fail();
        i++;
        if (!textSet) el.text = sawText ? textBuf : null;
        return el;
      }
      if (input.startsWith("<!--", i)) {
        const end = input.indexOf("-->", i);
        if (end === -1) fail();
        i = end + 3;
        continue;
      }
      if (input.startsWith("<![CDATA[", i)) {
        const end = input.indexOf("]]>", i);
        if (end === -1) fail();
        textBuf += input.slice(i + 9, end);
        sawText = true;
        i = end + 3;
        continue;
      }
      if (input[i] === "<") {
        if (!isNameStart(input[i + 1] as string ?? "")) fail();
        // 首个子元素：定格 .text（此后 tail 文本再不计入本节点 .text）。
        if (!textSet) {
          el.text = sawText ? textBuf : null;
          textSet = true;
        }
        const child = parseElement();
        el.children.push(child);
        continue;
      }
      // 普通文本（含实体引用）。
      const run = readTextRun();
      textBuf += run;
      sawText = true;
    }
  };

  const readTextRun = (): string => {
    let out = "";
    while (i < n && input[i] !== "<") {
      if (input[i] === "&") {
        const semi = input.indexOf(";", i);
        if (semi === -1) fail();
        const ref = input.slice(i + 1, semi);
        if (ref[0] === "#") {
          const cp = ref[1] === "x" || ref[1] === "X"
            ? parseInt(ref.slice(2), 16)
            : parseInt(ref.slice(1), 10);
          if (!Number.isFinite(cp)) fail();
          out += String.fromCodePoint(cp);
        } else if (XML_ENTITIES[ref] !== undefined) {
          out += XML_ENTITIES[ref];
        } else {
          fail();
        }
        i = semi + 1;
        continue;
      }
      out += input[i];
      i++;
    }
    return out;
  };

  consumeDeclOrMisc();
  if (i >= n || input[i] !== "<") fail();
  if (input.startsWith("</", i)) fail();
  const root = parseElement();
  // 根之后只允许 misc（PI/注释）与空白，否则 ParseError（junk after document element）。
  consumeDeclOrMisc();
  if (i < n) fail();
  return root;
}

/** root.find(tag)：文档序首个同名【直接子元素】；根自身不参与。 */
function findChild(root: PyXmlElement, tag: string): PyXmlElement | null {
  for (const child of root.children) {
    if (child.tag === tag) return child;
  }
  return null;
}

/* ════════════════════════════════════════════════════════════════════
 * WeComProvider
 * ════════════════════════════════════════════════════════════════════ */

export class WeComProvider extends BaseProvider {
  static override PLATFORM = "wecom";
  static API_BASE = "https://qyapi.weixin.qq.com/cgi-bin";
  static override SEND_LIMIT = 2000;
  /** 一个加密回调不该很大。更大的就不是聊天消息，交给 XML 只会扩大攻击面。 */
  static MAX_BODY = 256 * 1024;
  static TOKEN_EXPIRY_BUFFER = 300;

  protected _webhookKey: string;
  protected _corpId: string;
  protected _appSecret: string;
  protected _agentId: string;
  protected _callbackToken: string;
  protected _aesKey: string;
  protected _accessToken = "";
  protected _tokenExpiresAt = 0.0;

  /** python `self.X` 的类属性视图（static 沿继承链查找 == cls.X）。 */
  private _cls(): typeof WeComProvider {
    return this.constructor as typeof WeComProvider;
  }

  constructor() {
    super();
    this._webhookKey = this.cfg("webhook_key");
    this._corpId = this.cfg("corp_id");
    this._appSecret = this.cfg("app_secret");
    this._agentId = this.cfg("agent_id");
    this._callbackToken = this.cfg("callback_token");
    this._aesKey = this.cfg("encoding_aes_key");
    this._accessToken = "";
    this._tokenExpiresAt = 0.0;
  }

  /* ------------------------------------------------------------------ */
  /* Contract                                                            */
  /* ------------------------------------------------------------------ */

  override is_configured(): boolean {
    return pyTruthy(this._webhookKey) || (pyTruthy(this._corpId) && pyTruthy(this._appSecret));
  }

  /** Whether we can address one person instead of a whole group. */
  can_reply_to_user(): boolean {
    return pyTruthy(this._corpId) && pyTruthy(this._appSecret) && pyTruthy(this._agentId);
  }

  /** Inbound is push-based; just take the controller reference. */
  override async start_listening(controller: unknown): Promise<void> {
    this._controller = controller as ProviderControllerLike | null;
    this._running = true;
  }

  override async stop_listening(): Promise<void> {
    this._running = false;
    this._controller = null;
  }

  override async send_message(user_id: string, content: string): Promise<boolean> {
    if (!pyStrip(content)) return true;
    if (this.can_reply_to_user() && pyTruthy(user_id) && !user_id.startsWith("@")) {
      return await this._send_app(user_id, content);
    }
    return await this._send_robot(content);
  }

  /** Send via the self-built app, addressed to one member. */
  async _send_app(user_id: string, content: string): Promise<boolean> {
    const token = await this._ensure_token();
    if (!pyTruthy(token)) {
      // 凭证齐但交换失败；群机器人是次优但可用的兜底，好过丢掉这条回复。
      return await this._send_robot(content);
    }
    let ok = true;
    for (const chunk of this._cls().split(content)) {
      const r = await this.request(
        "POST",
        `${this._cls().API_BASE}/message/send?access_token=${token}`,
        {
          json_body: {
            touser: user_id,
            msgtype: "text",
            agentid: this._agentId,
            text: { content: chunk },
          },
        },
      );
      if (!WeComProvider._errcode_ok(r)) ok = false;
    }
    return ok;
  }

  /** Broadcast via the group robot webhook. */
  async _send_robot(content: string): Promise<boolean> {
    if (!this._webhookKey) {
      WC_SEAMS.print("[wecom] nothing to send with (set webhook_key or app credentials)");
      return false;
    }
    let ok = true;
    for (const chunk of this._cls().split(content)) {
      const r = await this.request(
        "POST",
        `${this._cls().API_BASE}/webhook/send?key=${this._webhookKey}`,
        { json_body: { msgtype: "text", text: { content: chunk } } },
      );
      if (!WeComProvider._errcode_ok(r)) ok = false;
    }
    return ok;
  }

  static _errcode_ok(result: { ok: boolean; value: unknown; error: string }): boolean {
    const data: Record<string, unknown> = isDict(result.value) ? result.value : {};
    const errRaw = dictGet(data, "errcode", 0);
    const errInt = pyInt(pyTruthy(errRaw) ? errRaw : 0);
    if (!result.ok || errInt !== 0) {
      WC_SEAMS.print(
        `[wecom] send failed: ${pyTruthy(result.error) ? pyStr(result.error) : pyStr(data)}`,
      );
      return false;
    }
    return true;
  }

  /** Fetch/refresh access_token (2h validity). */
  async _ensure_token(): Promise<string> {
    if (pyTruthy(this._accessToken) && WC_SEAMS.now() < this._tokenExpiresAt) {
      return this._accessToken;
    }
    const r = await this.request(
      "GET",
      `${this._cls().API_BASE}/gettoken?corpid=${this._corpId}&corpsecret=${this._appSecret}`,
    );
    const data: Record<string, unknown> = isDict(r.value) ? r.value : {};
    const tokRaw = dictGet(data, "access_token");
    const token = pyStr(pyTruthy(tokRaw) ? tokRaw : "");
    if (token) {
      this._accessToken = token;
      const expRaw = dictGet(data, "expires_in", 7200);
      const expires = pyInt(pyTruthy(expRaw) ? expRaw : 7200);
      this._tokenExpiresAt = WC_SEAMS.now() + expires - this._cls().TOKEN_EXPIRY_BUFFER;
    }
    return this._accessToken;
  }

  /* ------------------------------------------------------------------ */
  /* Callback: URL verification                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Answer WeCom's GET handshake.
   * @returns 解密后的 echostr（供回显），验签失败时返回 null（调用方应回 403）。
   */
  verify_url(query: unknown): string | null {
    if (!(pyTruthy(this._callbackToken) && pyTruthy(this._aesKey))) return null;
    const echostr = dictGet(query, "echostr", "");
    if (!pyTruthy(echostr)) return null;
    if (!this._verify_signature(query, echostr)) return null;
    const decrypted = this._decrypt(echostr);
    return decrypted ? decrypted[0] : null;
  }

  /* ------------------------------------------------------------------ */
  /* Callback: events                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Process one encrypted event callback.
   * @returns 应答体。WeCom 接受空串表示"收到"；真正的回复另行推送，因为一轮
   *   agent 远超 5s 的回调预算。
   */
  async handle_webhook(body: Uint8Array, query: unknown): Promise<string> {
    // Fail closed：无 token/key 就无法认证发送方，而该端点会在用户机器上启动真实工作。
    if (!(pyTruthy(this._callbackToken) && pyTruthy(this._aesKey))) return "";
    if (body.length > this._cls().MAX_BODY) return "";
    const encrypt = WeComProvider._extract(body, "Encrypt");
    if (!encrypt || !this._verify_signature(query, encrypt)) return "";

    const decrypted = this._decrypt(encrypt);
    if (!decrypted) return "";
    const plainXml = decrypted[0];
    if (WeComProvider._extract(utf8Encode(plainXml), "MsgType") !== "text") return "";
    const contentRaw = WeComProvider._extract(utf8Encode(plainXml), "Content");
    const text = pyStrip(contentRaw || "");
    const userId = WeComProvider._extract(utf8Encode(plainXml), "FromUserName") || "";
    if (!(pyTruthy(text) && pyTruthy(userId))) return "";

    await this.route(userId, text);
    return "";
  }

  /* ------------------------------------------------------------------ */
  /* Crypto                                                              */
  /* ------------------------------------------------------------------ */

  /** msg_signature = sha1 of the sorted [token, timestamp, nonce, payload]. */
  _verify_signature(query: unknown, payload: unknown): boolean {
    const expected = dictGet(query, "msg_signature", "");
    const timestamp = dictGet(query, "timestamp", "");
    const nonce = dictGet(query, "nonce", "");
    if (!(pyTruthy(expected) && pyTruthy(timestamp) && pyTruthy(nonce))) return false;
    const joined = pySortStrings([this._callbackToken, timestamp, nonce, payload]).join("");
    const computed = createHash("sha1")
      .update(Buffer.from(joined, "utf-8"))
      .digest("hex");
    // 源注释称 constant-time，实则 all(zip) 短路（缺陷 D5）：长度相等再逐字符码点比较。
    const ce = Array.from(computed);
    const ee = Array.from(String(expected));
    if (ce.length !== ee.length) return false;
    for (let k = 0; k < ce.length; k++) {
      if (ce[k] !== ee[k]) return false;
    }
    return true;
  }

  /**
   * AES-256-CBC decrypt one WeCom payload.
   * @returns ``(message_xml, receive_id)``，任何环节不对则返回 null。布局为
   *   16 随机字节 + 4 字节大端长度 + message + receive_id，PKCS#7 填充。
   */
  _decrypt(b64Cipher: unknown): [string, string] | null {
    const cipher = typeof b64Cipher === "string" ? b64Cipher : pyStr(b64Cipher);
    if (!WC_SEAMS.hasCryptography()) {
      WC_SEAMS.print("[wecom] cryptography not installed; cannot decrypt callbacks");
      return null;
    }
    try {
      const key = pyB64Decode(this._aesKey + "=");
      const raw = pyB64Decode(cipher);
      if (key.length !== 32 || raw.length === 0 || raw.length % 16 !== 0) return null;
      const iv = key.slice(0, 16);
      const plain = WC_SEAMS.aesCbcDecrypt(key, iv, raw);
      // python plain[-1] on empty bytes -> IndexError: index out of range（外层 broad-except 吞成 print）。
      if (plain.length === 0) throw new IndexErrorP("index out of range");
      const pad: number = plain[plain.length - 1] as number;
      if (!(1 <= pad && pad <= 32)) return null;
      const unpadded = pad >= plain.length ? new Uint8Array(0) : plain.slice(0, plain.length - pad);
      const body = unpadded.length <= 16 ? new Uint8Array(0) : unpadded.slice(16);
      const msgLen = fromBytesBig(body.slice(0, 4));
      if (msgLen < 0 || msgLen > body.length - 4) return null;
      const message = decodeUtf8Strict(body.slice(4, 4 + msgLen));
      const receiveId = decodeUtf8Replace(body.slice(4 + msgLen));
      return [message, receiveId];
    } catch (exc) {
      // noqa: BLE001 —— 畸形载荷是数据，不是崩溃。
      WC_SEAMS.print(`[wecom] decrypt failed: ${msgOf(exc)}`);
      return null;
    }
  }

  /**
   * Pull one tag's text out of a WeCom XML document.
   * 源 docstring 声称只在验签后的字节上调用（实则首处调用验签前，见缺陷 D7）。
   */
  static _extract(xmlBytes: Uint8Array, tag: string): string {
    let root: PyXmlElement;
    try {
      root = parseXml(decodeUtf8Replace(xmlBytes));
    } catch (e) {
      // python: except ET.ParseError —— 其余异常（如 D9 的 ValueError）原样上抛。
      if (e instanceof ParseErrorP) return "";
      throw e;
    }
    const node = findChild(root, tag);
    if (node === null) return "";
    return node.text ? node.text : "";
  }
}

// PORT STATUS: 本文件无 TODO(port)。
