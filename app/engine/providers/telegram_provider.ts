/**
 * providers/telegram_provider.ts — Telegram long-polling IMProvider.
 *
 * 源：app/backend/providers/telegram_provider.py（323 行）。
 * 单元 207 / wave-9，manifest.tsv target=TS。Providers 家族成员。
 *
 * 与其它 provider 不同：telegram **不继承** BaseProvider（providers/common.ts），
 * 而是直接继承 IMProvider（providers/base.ts），自带 HTTP 传输、offset 记账、
 * 内置命令表、入站分发与消息分块——正如 common.py 顶部 docstring 所明说：
 *   "Telegram and Feishu each hand-rolled their own HTTP transport, allow-list
 *    check, built-in command table and reply dispatch. ... Deliberately NOT
 *    retrofitted onto the existing two providers."
 * 因此本端口只从基座 common.ts 复用 getStorage 接缝（CP_SEAMS.getStorage），
 * 不重复其 request()/split()/cfg() 等实现——telegram 的传输语义与其不同。
 * 其余 Python 语义小工具按本仓惯例（HANDOFF_V10 §4.3）本文件自带。
 *
 * ── 可观测面（与源码逐行对齐）──
 *  1. __init__：storage.get_bot_state("telegram:config", {}) or {}；
 *     token 覆盖 config.bot_token；poll_timeout 默认 25；
 *     offset = int(config.get("offset", 0))（int 强转语义，坏值抛 ValueError）。
 *  2. is_configured：bool(self._token)。get_platform_id：恒 "telegram"。
 *  3. start_listening：未配置或已在跑 → 直接 return（不 require_aiohttp）；
 *     否则 _running=True 且 create_task(_poll_loop(controller))。
 *     注意：telegram 不在 self 上存 controller——controller 作为 _poll_loop 参数下传。
 *  4. stop_listening：_running=False；task 未完成则 cancel + await（吞 CancelledError）；
 *     最后 _persist_offset()。
 *  5. send_message：_split(content,4096) 逐块 sendMessage，ok 累积（任一失败即 False）。
 *  6. send_streaming_card：先占位 "…"，取 message_id，按 STREAM_EDIT_INTERVAL 节流
 *     editMessageText，最后无条件 flush；返回末次编辑是否成功。
 *  7. _poll_loop：getUpdates {offset,timeout} + socket timeout poll_timeout+10；
 *     失败退避（min(backoff*2,30.0)）；成功 offset=max(offset,int(update_id)+1)
 *     （**加一的 ack 语义**：下次不再取回已处理更新），逐条 _dispatch，末尾 _persist_offset。
 *  8. _dispatch：message = update["message"] or update["edited_message"]；text strip；
 *     chat_id/user_id 提取（present-but-null 的 chat/from 触发 AttributeError，源缺陷）；
 *     授权 → 内置命令 → 暂停门 → controller.handle_message。
 *  9. _handle_builtin：/start /status(含 Offset) /pause /resume。
 * 10. _user_allowed：fail-closed；空/缺省 → 无人放行。
 * 11. _persist_offset：浅拷贝 config、写入 offset、回存；except Exception pass（fail-open）。
 * 12. _call：无 token → Result.failure("Telegram token not configured")；
 *     url = API_BASE/bot{token}/{method}；aiohttp 主路径或 urllib 回退（双路径错误文案不同）。
 * 13. _split：len<=size 时 telegram 返回 [text] 或 **[""]**（与基座 split 的 [] 不同——源缺陷 D1）。
 *
 * ── 接缝（红线5：HTTP / 时钟-睡眠 / 任务调度 / to_thread 全部隔离）──
 * TG_SEAMS：
 *   - request:    Bot API 传输执行器（取代 aiohttp session.post 与 urllib.request.urlopen）。
 *                 记录并返回构建出的 URL / method / headers / body(JSON 字符串) 与解析后的
 *                 status/statusText/body；探针只观察这些，绝不产生真实网络请求。
 *   - hasAiohttp: aiohttp 可用性开关（对应 _HAS_AIOHTTP）。默认 true（等价 JS 恒有 fetch），
 *                 urllib 回退路径保留以维持双路径错误文案的可观测差异。
 *   - createTask: 取代 asyncio.create_task（接收 thunk，见 DIVERGENCE 2）。
 *   - sleep:      取代 asyncio.sleep（退避/取消等待）。默认 setTimeout；探针替换为立即
 *                 resolve 且把 _running 置 false 以收敛轮询循环——绝不真实挂起。
 *   - monotonic:  取代 time.monotonic（打字机节流时钟）。默认 performance.now()/1000；探针钉死。
 *   - toThread:   取代 asyncio.to_thread（urllib 阻塞传输搬到工作线程）。默认直接 await。
 *
 * ── 源自带缺陷（bug-for-bug 原样保留，不修）──
 *  D1  _split(text,size)：`if len(text) <= size: return [text] if text else [""]`——
 *      空串返回 [""]（而非基座 split 的 []），send_message 于是会对空内容发一次
 *      text="" 的 HTTP 调用。与基座语义分歧，是 telegram 自有行为，端口逐字复刻。
 *  D2  _dispatch：`message.get("chat", {}).get("id", "")`——"chat" 键 present 但值为
 *      null 时，`dict.get(k, {})` 返回 None（默认只在键缺失时生效），随后 None.get 抛
 *      AttributeError，_dispatch 无 try 捕获，异常冲出 _poll_loop（在真实运行中杀死轮询任务）。
 *      from 同理。端口用 dictGet 逐字复刻该崩溃面。
 *  D3  _dispatch：`text = (message.get("text") or "").strip()`——text 为非字符串真值
 *      （如 int/list）时 .strip() 抛 AttributeError；同理 `str(...)` 前对非映射的 .get。
 *  D4  _call_urllib 与 _call_aiohttp 的错误文案对同一后端故障并不一致：
 *      aiohttp 对 4xx/5xx 返回 `HTTP {status}: {body}`（读 body），urllib 抛 HTTPError
 *      后仅返回 `HTTP {code}: {reason}`（不读 body）；且 aiohttp 判 `status != 200`，
 *      urllib 忽略 3xx、仅对 >=400 抛错。双路径差异是源真实行为，端口分别复刻。
 *  D5  _call_aiohttp：`if resp.status != 200 or not body.get("ok", False)` 依赖 `or` 短路——
 *      status≠200 时不会触碰 body.get；status=200 且 body 非映射（list/int/str）时
 *      `body.get` 抛 AttributeError → 被 except 捕获成 `Telegram request failed: ...`。
 *      _call_urllib 无短路，body 恒被 .get。端口保持同样的短路/非短路。
 *  D6  send_streaming_card：`(first.value or {}).get("result", {}).get("message_id")`
 *      当 result 为 null（present-but-null）时 → None.get → AttributeError 冲出（源缺陷）；
 *      message_id 为 None 才 return False。
 *  D7  _poll_loop：`for update in (r.value or {}).get("result", [])` 若 result 为非可迭代
 *      （int/str 等）→ TypeError 冲出；result 为 dict → 迭代其键（str），随后
 *      `update.get` 对 str 抛 AttributeError。逐字保留。
 *
 * ── DIVERGENCE(port) ──
 *  1. aiohttp / urllib → TG_SEAMS.request：与基座 Unit 202 D1 同源。等价性：探针只
 *     检验构建出的 URL/headers/body JSON 与解析后的 status/body，两条传输路径的错误文案
 *     差异由端口自身逻辑（status 判断 + dictGet 短路）产出，传输层差异不可观测。
 *     响应 JSON 解码属传输职责（对应 aiohttp resp.json(content_type=None) /
 *     urllib json.loads），由 seam 完成；端口保持 body.get 的短路语义与 str(dict) 文案。
 *  2. asyncio.create_task(coro) → createTask(thunk)：Python 中 `self._poll_loop(controller)`
 *     只创建协程对象不运行，create_task 才排入事件循环；JS 直接调用 async 方法会同步跑到
 *     第一个 await。故端口把协程包成 thunk 交给 createTask，由它决定何时（是否）运行——
 *     start_listening 场景因此能干净地只观察 _running/_task 被置位、_poll_loop 体在
 *     快照前不执行（与 CPython 一致）。
 *  3. asyncio.CancelledError → CancelledErrorP（Error 子类，name="CancelledError"）：
 *     TS 无原生取消；stop_listening 的 except CancelledError 分支由 task.wait() 是否以
 *     CancelledErrorP 拒绝决定，跨语言异常类名对齐；源里该 except 只是静默吞取消，端口同义。
 *  4. asyncio.to_thread(self._call_urllib, ...) → TG_SEAMS.toThread(thunk)：Python 把阻塞
 *     urlopen 搬到工作线程以免卡住事件循环；端口的 seam 请求本已是异步，默认直接 await。
 *     等价性：每个调用点至多一条在途 HTTP 请求，线程/微任务的调度次序在本模块无可观测差异。
 *  5. 裸 NaN/Infinity/-Infinity JSON 字面量、CPython str.split() 的 \x1c-\x1f 空白集、
 *     int()/float() 的 Unicode 数字文法：与基座/Discord 同源。本模块对入站 update 与
 *     响应 body 均按 JSON 域处理，场景表不注入这些语法面，不可达，端口场景不生成。
 *  6. json.dumps(params)（ensure_ascii=True，默认分隔符 ', '/': '）：telegram 两条传输路径
 *     都以 ensure_ascii=True 序列化 body（aiohttp json= 与 urllib json.dumps 同默认），
 *     非 ASCII 转义为 \uXXXX（星平面字符拆为代理对）。端口 pyJsonDumps 逐字复刻该转义。
 *  7. 源文件不含以下常见 provider 面（本 323 行文件通读确认，端口不臆造）：
 *     webhook 回调解析 / secret_token 头比对、MarkdownV2/HTML 转义与 parse_mode 回退、
 *     inline-keyboard 构造、photo/document 媒体发送、callback_query 应答。telegram 这里
 *     只有 getUpdates 长轮询 + sendMessage/editMessageText + 内置命令，端口仅移植这些。
 *
 * PORT STATUS: confidence=high todos=0
 */

import { IMProvider } from "./base.js";
import { Result } from "../result.js";
import { CP_SEAMS } from "./common.js";
import type { ICommonStorage } from "./common.js";

/* ════════════════════════════════════════════════════════════════════
 * Seams（红线5：HTTP / 时钟-睡眠 / 任务调度 / to_thread 隔离）
 * ════════════════════════════════════════════════════════════════════ */

/** TG_SEAMS.request 的返回值：解析后的 HTTP 响应（body 已按 JSON 解码）。 */
export interface TelegramHttpResponse {
  status: number;
  statusText: string;
  /** aiohttp resp.json() / urllib json.loads() 的解码产物（传输职责）。 */
  body: unknown;
}

export interface TelegramRequestInit {
  method: string;
  body: string;
  headers: Record<string, string>;
  timeout: number;
}

/** asyncio.Task 的最小鸭子契约。 */
export interface TelegramTask {
  done(): boolean;
  cancel(): void;
  wait(): Promise<void>;
}

export interface TelegramSeams {
  request: (url: string, init: TelegramRequestInit) => Promise<TelegramHttpResponse>;
  hasAiohttp: () => boolean;
  createTask: (run: () => Promise<void>) => TelegramTask;
  sleep: (seconds: number) => Promise<void>;
  monotonic: () => number;
  toThread: (fn: () => Promise<Result<unknown>>) => Promise<Result<unknown>>;
}

/** 默认"未接线 HTTP 传输"占位：调用即抛（探针总会注入记录型假件）。 */
async function defaultRequest(url: string, _init: TelegramRequestInit): Promise<TelegramHttpResponse> {
  throw new Error(`TelegramProvider requires an HTTP transport (TG_SEAMS.request not wired): ${url}`);
}

export const TG_SEAMS: TelegramSeams = {
  request: defaultRequest,
  hasAiohttp: () => true,
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
  sleep: (seconds: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, seconds * 1000));
    }),
  monotonic: () => performance.now() / 1000,
  toThread: (fn: () => Promise<Result<unknown>>) => fn(),
};

/** 探针注入入口（与 common.ts / slack_provider.ts 的 _set_seams_for_parity 同模式）。 */
export function _set_seams_for_parity(overrides: Partial<TelegramSeams>): void {
  Object.assign(TG_SEAMS, overrides);
}

/* ════════════════════════════════════════════════════════════════════
 * Python 语义辅助（本文件自带；仓库惯例见 HANDOFF_V10 §4.3）
 * ════════════════════════════════════════════════════════════════════ */

class AttributeErrorP extends Error {
  constructor(m: string) {
    super(m);
    this.name = "AttributeError";
  }
}
class TypeErrorP extends Error {
  constructor(m: string) {
    super(m);
    this.name = "TypeError";
  }
}
class ValueErrorP extends Error {
  constructor(m: string) {
    super(m);
    this.name = "ValueError";
  }
}
class IndexErrorP extends Error {
  constructor(m = "list index out of range") {
    super(m);
    this.name = "IndexError";
  }
}
/** asyncio.CancelledError 的等价物（name 对齐）。 */
export class CancelledErrorP extends Error {
  constructor(m = "Task cancelled") {
    super(m);
    this.name = "CancelledError";
  }
}
/** urllib.error.HTTPError 的等价物（携带 code/reason）。 */
class HTTPErrorP extends Error {
  code: number;
  reason: string;
  constructor(code: number, reason: string) {
    super(`HTTP Error ${code}: ${reason}`);
    this.name = "HTTPError";
    this.code = code;
    this.reason = reason;
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
 * （`'str' object has no attribute 'get'`），复刻源缺陷 D2/D3/D5/D6/D7 的崩溃面。
 * default 只在**键缺失**时生效；present-but-null 返回 null（不是 default）。
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

/** python str.split()：按空白切词并丢弃空串（\x1c-\x1f 空白集差异见 DIVERGENCE 5）。 */
function pySplitWords(s: string): string[] {
  return s.split(/\s+/).filter((w) => w.length > 0);
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

/** python str(x) / f"{x}"：容器元素用 repr（与 CPython 一致）。 */
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

/**
 * python json.dumps(v)（ensure_ascii=True，默认分隔符 ', ' / ': '）。
 * 转义：反斜杠/引号/控制符（\b \f \n \r \t 走短转义，其余 <0x20 走 \u00xx），
 * 以及所有 ord>=0x7f 的字符（含代理对：JS 字符串本就是 UTF-16，星平面字符的两个
 * 代理码元各自 >=0x7f → 天然拆成 \udXXX\udXXX，与 CPython 一致）。十六进制小写。
 */
function pyJsonDumps(v: unknown): string {
  const encStr = (s: string): string => {
    let out = '"';
    // 逐 UTF-16 码元处理：星平面字符（如 😀）在 JS 中是两个代理码元，二者皆 >=0x7f，
    // 各自转义 → \ud83d\ude00，与 CPython json.dumps(ensure_ascii=True) 的代理对输出一致。
    for (let i = 0; i < s.length; i++) {
      const ch = s[i] as string;
      const cu = s.charCodeAt(i);
      if (ch === "\\") out += "\\\\";
      else if (ch === '"') out += '\\"';
      else if (ch === "\b") out += "\\b";
      else if (ch === "\f") out += "\\f";
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (cu < 0x20) out += "\\u" + cu.toString(16).padStart(4, "0");
      else if (cu >= 0x7f) out += "\\u" + cu.toString(16).padStart(4, "0");
      else out += ch;
    }
    return out + '"';
  };
  const enc = (val: unknown): string => {
    if (val === null || val === undefined) return "null";
    if (typeof val === "boolean") return val ? "true" : "false";
    if (typeof val === "number") {
      if (Number.isNaN(val)) return "NaN";
      if (val === Infinity) return "Infinity";
      if (val === -Infinity) return "-Infinity";
      return Number.isInteger(val) ? String(val) : pyFloatRepr(val);
    }
    if (typeof val === "string") return encStr(val);
    if (Array.isArray(val)) return "[" + val.map(enc).join(", ") + "]";
    if (isDict(val)) {
      return (
        "{" +
        Object.entries(val)
          .map(([k, v2]) => `${encStr(k)}: ${enc(v2)}`)
          .join(", ") +
        "}"
      );
    }
    return "null";
  };
  return enc(v);
}

/**
 * python int(x)（本端口用于 offset / update_id）：
 *  - bool -> 1/0；
 *  - number -> 向零截断（非有限抛 OverflowError/ValueError）；
 *  - str -> 十进制解析（可选符号 + 下划线分隔），非法抛 ValueError（文案逐字）；
 *  - None/其余 -> TypeError（文案逐字）。
 */
function pyInt(x: unknown): number {
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "number") {
    if (Number.isNaN(x)) throw new ValueErrorP("cannot convert float NaN to integer");
    if (!Number.isFinite(x)) throw new OverflowErrorP("cannot convert float infinity to integer");
    return Math.trunc(x);
  }
  if (typeof x === "string") {
    const stripped = pyStrip(x);
    const m = /^([+-]?)((?:[0-9]|_)+)$/.exec(stripped);
    if (!m) {
      throw new ValueErrorP(`invalid literal for int() with base 10: ${pyStrRepr(x)}`);
    }
    const digits = (m[2] ?? "").replace(/_/g, "");
    if (digits.length === 0) {
      throw new ValueErrorP(`invalid literal for int() with base 10: ${pyStrRepr(x)}`);
    }
    const n = parseInt(digits, 10);
    return m[1] === "-" ? -n : n;
  }
  throw new TypeErrorP(
    `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(x)}'`,
  );
}

class OverflowErrorP extends Error {
  constructor(m: string) {
    super(m);
    this.name = "OverflowError";
  }
}

/** python max(a, b)：并列返回先出现者；NaN 行为不涉及（这里均为 int）。 */
function pyMax2(a: number, b: number): number {
  return b > a ? b : a;
}
/** python min(a, b)：并列返回先出现者。 */
function pyMin2(a: number, b: number): number {
  return b < a ? b : a;
}

/** python str[:n] 的码点切片。 */
function pySliceHead(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}

/* ════════════════════════════════════════════════════════════════════
 * TelegramProvider
 * ════════════════════════════════════════════════════════════════════ */

export class TelegramProvider extends IMProvider {
  static API_BASE: string = "https://api.telegram.org";
  /** Telegram caps edits; throttle typewriter updates to stay well under it. */
  static STREAM_EDIT_INTERVAL: number = 0.8;

  storage: ICommonStorage;
  _config: Record<string, unknown>;
  /** python: `token or config.get("bot_token","")` —— 原样保存（可为非字符串），
   *  is_configured 取 bool()、URL 取 f-string(str()) 时才解释。 */
  _token: unknown;
  _poll_timeout: number;
  _offset: number;
  _running: boolean;
  _task: TelegramTask | null;
  _paused_users: Set<string>;

  constructor(token?: unknown, poll_timeout: number = 25) {
    super();
    this.storage = CP_SEAMS.getStorage();
    this._config =
      (this.storage.get_bot_state("telegram:config", {}) as Record<string, unknown>) || {};
    this._token = pyTruthy(token) ? token : dictGet(this._config, "bot_token", "");
    this._poll_timeout = poll_timeout;
    this._offset = pyInt(dictGet(this._config, "offset", 0));
    this._running = false;
    this._task = null;
    this._paused_users = new Set<string>();
  }

  /** python `self.API_BASE` / `self.STREAM_EDIT_INTERVAL` 的类属性视图。 */
  private _cls(): typeof TelegramProvider {
    return this.constructor as typeof TelegramProvider;
  }

  /* ------------------------------------------------------------------ */
  /* IMProvider contract                                                 */
  /* ------------------------------------------------------------------ */

  /** Return the platform identifier. */
  get_platform_id(): string {
    return "telegram";
  }

  /** Whether a bot token is available. */
  override is_configured(): boolean {
    return pyTruthy(this._token);
  }

  /**
   * Begin the long-poll loop, dispatching messages to the controller.
   * 未配置或已在跑时直接 return（源不在 self 上存 controller）。
   */
  override async start_listening(controller: unknown): Promise<void> {
    if (!this.is_configured()) {
      return;
    }
    if (this._running) {
      return;
    }
    this._running = true;
    this._task = TG_SEAMS.createTask(() => this._poll_loop(controller));
  }

  /** Stop the long-poll loop and persist the offset. */
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
    this._persist_offset();
  }

  /**
   * Send a plain text message (split automatically if over 4096 chars).
   * True 当且仅当每个分块都被 API 接受（ok 累积）。
   */
  override async send_message(user_id: string, content: string): Promise<boolean> {
    let ok = true;
    for (const chunk of TelegramProvider._split(content, 4096)) {
      const r = await this._call("sendMessage", { chat_id: user_id, text: chunk });
      ok = ok && r.ok;
    }
    return ok;
  }

  /**
   * Stream a reply with a typewriter effect via editMessageText.
   * Edits 按 STREAM_EDIT_INTERVAL 节流，最后无条件 flush。
   */
  override async send_streaming_card(
    user_id: string,
    content_stream: AsyncGenerator<string, void>,
  ): Promise<boolean> {
    const first = await this._call("sendMessage", { chat_id: user_id, text: "…" });
    if (!first.ok) {
      return false;
    }
    // (first.value or {}).get("result", {}).get("message_id")  —— result 为 null 时抛 AttributeError（D6）
    const valueObj = pyTruthy(first.value) ? first.value : {};
    const message_id = dictGet(dictGet(valueObj, "result", {}), "message_id");
    if (message_id === null || message_id === undefined) {
      return false;
    }

    let buffer = "";
    let last_edit = 0.0;
    let last_sent = "";
    for await (const delta of content_stream) {
      buffer += delta;
      const now = TG_SEAMS.monotonic();
      if (now - last_edit >= this._cls().STREAM_EDIT_INTERVAL && buffer !== last_sent) {
        await this._edit(user_id, message_id as number, buffer);
        last_edit = now;
        last_sent = buffer;
      }
    }
    if (pyTruthy(buffer) && buffer !== last_sent) {
      return await this._edit_ok(user_id, message_id as number, buffer);
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Polling                                                             */
  /* ------------------------------------------------------------------ */

  /** Long-poll getUpdates until stopped, dispatching each message once. */
  async _poll_loop(controller: unknown): Promise<void> {
    let backoff = 1.0;
    while (this._running) {
      const r = await this._call(
        "getUpdates",
        { offset: this._offset, timeout: this._poll_timeout },
        this._poll_timeout + 10,
      );
      if (!r.ok) {
        // Network hiccup: exponential backoff capped at 30s, keep looping.
        await TG_SEAMS.sleep(backoff);
        backoff = pyMin2(backoff * 2, 30.0);
        continue;
      }
      backoff = 1.0;
      // (r.value or {}).get("result", []) —— result 非可迭代/为 dict 时冲出（D7）
      const valueObj = pyTruthy(r.value) ? r.value : {};
      const result = dictGet(valueObj, "result", []);
      // Python `for update in obj`：list 迭代元素、str 迭代字符、dict 迭代键，
      // 其余（int/None/float）抛 TypeError。随后 update.get 对非映射抛 AttributeError。
      const items: unknown[] = Array.isArray(result)
        ? result
        : typeof result === "string"
          ? Array.from(result)
          : isDict(result)
            ? Object.keys(result)
            : this._iterate(result);
      for (const update of items) {
        this._offset = pyMax2(this._offset, pyInt(dictGet(update, "update_id", 0)) + 1);
        await this._dispatch(controller, update);
      }
      this._persist_offset();
    }
  }

  /** python 对不可迭代对象 `for x in obj` 抛 TypeError（复刻 D7 的 int/None 分支）。 */
  private _iterate(result: unknown): unknown[] {
    if (typeof result === "number") {
      throw new TypeErrorP(`'int' object is not iterable`);
    }
    if (result === null || result === undefined) {
      throw new TypeErrorP(`'NoneType' object is not iterable`);
    }
    return Array.from(result as Iterable<unknown>);
  }

  /** Route one Telegram update into the controller. */
  async _dispatch(controller: unknown, update: unknown): Promise<void> {
    // update.get("message") or update.get("edited_message") —— update 非映射时抛 AttributeError
    const messageRaw = pyTruthy(dictGet(update, "message"))
      ? dictGet(update, "message")
      : dictGet(update, "edited_message");
    if (!pyTruthy(messageRaw)) {
      return;
    }
    const message = messageRaw as Record<string, unknown>;
    // text = (message.get("text") or "").strip() —— text 为非字符串真值时 .strip() 抛错（D3）
    const textRaw = pyTruthy(dictGet(message, "text")) ? dictGet(message, "text") : "";
    const text = typeof textRaw === "string" ? pyStrip(textRaw) : this._nonStrStrip(textRaw);
    if (!pyTruthy(text)) {
      return;
    }
    // chat_id = str(message.get("chat", {}).get("id", "")) —— chat present-but-null 抛 AttributeError（D2）
    const chatId = pyStr(dictGet(dictGet(message, "chat", {}), "id", ""));
    // user_id = str(message.get("from", {}).get("id", chat_id))
    const userId = pyStr(dictGet(dictGet(message, "from", {}), "id", chatId));
    if (!this._user_allowed(userId)) {
      await this.send_message(chatId, "Not authorized.");
      return;
    }

    const handled = await this._handle_builtin(chatId, userId, text);
    if (handled) {
      return;
    }
    if (this._paused_users.has(userId)) {
      await this.send_message(chatId, "Paused. Send /resume to continue.");
      return;
    }

    const result = await this._handle_message(controller, "telegram", userId, text);
    const reply = result.ok ? result.value : `Error: ${result.error}`;
    await this.send_message(chatId, pyStr(reply));
  }

  /** python `str.get` 前对非字符串真值 .strip() 抛 AttributeError（D3）。 */
  private _nonStrStrip(v: unknown): string {
    throw new AttributeErrorP(`'${pyTypeName(v)}' object has no attribute 'strip'`);
  }

  /** controller.handle_message 的鸭子调用（Python 侧为 Any + getattr(result,"ok")）。 */
  private async _handle_message(
    controller: unknown,
    platform: string,
    user_id: string,
    text: string,
  ): Promise<Result<unknown>> {
    const c = controller as {
      handle_message?: (p: string, u: string, t: string) => Promise<Result<unknown>>;
      handleMessage?: (p: string, u: string, t: string) => Promise<Result<unknown>>;
    };
    if (typeof c.handle_message === "function") {
      return await c.handle_message(platform, user_id, text);
    }
    const fallback = c.handleMessage as (p: string, u: string, t: string) => Promise<Result<unknown>>;
    return await fallback(platform, user_id, text);
  }

  /**
   * Handle /start /status /pause /resume locally.
   * Returns True 当文本是内置命令并已应答。
   */
  async _handle_builtin(chat_id: string, user_id: string, text: string): Promise<boolean> {
    const words = pySplitWords(text);
    if (words.length === 0) {
      // python: text.split()[0] on empty list -> IndexError（D3 家族，_dispatch 里 text 非空，不可达）
      throw new IndexErrorP();
    }
    const cmd = (words[0] as string).toLowerCase();
    if (cmd === "/start") {
      await this.send_message(
        chat_id,
        "Ovolve is connected.\n/status - show state\n/pause - stop processing\n/resume - continue",
      );
    } else if (cmd === "/status") {
      const state = this._paused_users.has(user_id) ? "paused" : "active";
      await this.send_message(chat_id, `Status: ${state}\nOffset: ${this._offset}`);
    } else if (cmd === "/pause") {
      this._paused_users.add(user_id);
      await this.send_message(chat_id, "Paused.");
    } else if (cmd === "/resume") {
      this._paused_users.delete(user_id);
      await this.send_message(chat_id, "Resumed.");
    } else {
      return false;
    }
    return true;
  }

  /**
   * Whether this Telegram user is on the allow list.
   * Fail-closed：allowed_users 未设时无人放行（token 是 bearer 凭证）。
   */
  _user_allowed(user_id: string): boolean {
    const allowed = this._config["allowed_users"];
    if (!pyTruthy(allowed)) {
      return false;
    }
    // {str(u) for u in allowed}：字符串迭代字符、list 迭代元素、dict 迭代键、
    // 非可迭代对象（int 等）抛 TypeError（与基座 user_allowed 同语义）。
    let items: unknown[];
    if (typeof allowed === "string") {
      items = Array.from(allowed);
    } else if (Array.isArray(allowed)) {
      items = allowed;
    } else if (allowed !== null && typeof allowed === "object") {
      items = Object.keys(allowed as object);
    } else {
      throw new TypeErrorP(`'${pyTypeName(allowed)}' object is not iterable`);
    }
    const set = new Set(items.map((u) => pyStr(u)));
    return set.has(pyStr(user_id));
  }

  /** Persist the update offset so restarts do not replay messages. */
  _persist_offset(): void {
    const cfg: Record<string, unknown> = { ...this._config };
    cfg["offset"] = this._offset;
    this._config = cfg;
    try {
      this.storage.save_bot_state("telegram:config", cfg);
    } catch {
      // fail-open: 可选增强，失败不影响主流程（源 except Exception: pass）
    }
  }

  /* ------------------------------------------------------------------ */
  /* HTTP plumbing                                                       */
  /* ------------------------------------------------------------------ */

  /** Best-effort edit (ignores failures mid-stream). */
  async _edit(chat_id: string, message_id: number, text: string): Promise<void> {
    await this._edit_ok(chat_id, message_id, text);
  }

  /** Edit a message, reporting whether it succeeded. */
  async _edit_ok(chat_id: string, message_id: number, text: string): Promise<boolean> {
    const r = await this._call("editMessageText", {
      chat_id: chat_id,
      message_id: message_id,
      text: pySliceHead(text, 4096),
    });
    return r.ok;
  }

  /**
   * Call a Bot API method, returning a Result (never raising).
   * 无 token → failure("Telegram token not configured")；
   * 否则 aiohttp 主路径或 urllib 回退（asyncio.to_thread）。
   */
  async _call(method: string, params: Record<string, unknown>, timeout: number = 30): Promise<Result<unknown>> {
    if (!pyTruthy(this._token)) {
      return Result.failure("Telegram token not configured");
    }
    const url = `${this._cls().API_BASE}/bot${pyStr(this._token)}/${method}`;
    if (TG_SEAMS.hasAiohttp()) {
      return await this._call_aiohttp(url, params, timeout);
    }
    return await TG_SEAMS.toThread(() => this._cls()._call_urllib(url, params, timeout));
  }

  /** aiohttp transport（源 _call_aiohttp）。 */
  async _call_aiohttp(url: string, params: Record<string, unknown>, timeout: number): Promise<Result<unknown>> {
    try {
      const resp = await TG_SEAMS.request(url, {
        method: "POST",
        body: pyJsonDumps(params),
        headers: { "Content-Type": "application/json" },
        timeout,
      });
      // if resp.status != 200 or not body.get("ok", False) —— or 短路：status≠200 时不触碰 body.get（D5）
      if (resp.status !== 200 || !pyTruthy(dictGet(resp.body, "ok", false))) {
        return Result.failure(`HTTP ${resp.status}: ${pyStr(resp.body)}`);
      }
      return Result.success(resp.body);
    } catch (e) {
      return Result.failure(`Telegram request failed: ${pyExcStr(e)}`);
    }
  }

  /** Blocking stdlib transport, run in a worker thread（源 _call_urllib，staticmethod）。 */
  static async _call_urllib(
    url: string,
    params: Record<string, unknown>,
    timeout: number,
  ): Promise<Result<unknown>> {
    try {
      const resp = await TG_SEAMS.request(url, {
        method: "POST",
        body: pyJsonDumps(params),
        headers: { "Content-Type": "application/json" },
        timeout,
      });
      // urlopen 对 >=400 抛 HTTPError（不读 body）
      if (resp.status >= 400) {
        throw new HTTPErrorP(resp.status, resp.statusText);
      }
      if (!pyTruthy(dictGet(resp.body, "ok", false))) {
        return Result.failure(`Telegram error: ${pyStr(resp.body)}`);
      }
      return Result.success(resp.body);
    } catch (e) {
      if (e instanceof HTTPErrorP) {
        return Result.failure(`HTTP ${e.code}: ${e.reason}`);
      }
      return Result.failure(`Telegram request failed: ${pyExcStr(e)}`);
    }
  }

  /**
   * Split text into API-safe chunks, preferring newline boundaries.
   * 空串返回 [""]（telegram 自有语义 D1，与基座 split 的 [] 不同）。
   */
  static _split(text: string, size: number): string[] {
    const cps = Array.from(text);
    if (cps.length <= size) {
      return text ? [text] : [""];
    }
    const chunks: string[] = [];
    let remaining = cps;
    while (remaining.length > size) {
      // python remaining.rfind("\n", 0, size)：在 [0,size) 内找最后一个换行；找不到 -1
      let cut = -1;
      for (let i = size - 1; i >= 0; i--) {
        if (remaining[i] === "\n") {
          cut = i;
          break;
        }
      }
      if (cut <= 0) cut = size;
      chunks.push(remaining.slice(0, cut).join(""));
      let start = cut;
      while (start < remaining.length && remaining[start] === "\n") start++;
      remaining = remaining.slice(start);
    }
    const rest = remaining.join("");
    if (rest) chunks.push(rest);
    return chunks;
  }
}

// PORT STATUS: 本文件无 TODO(port)。
