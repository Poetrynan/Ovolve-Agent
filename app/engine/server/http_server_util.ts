/**
 * http_server_util.ts — 源：app/backend/server/http_server.py 的 **公共面（S0）**。
 * 单元 218 / wave-10 · 段 S0 · 分段方案 tmp/w218_SEGMENTS.md · 契约表 tmp/w218_SURFACE.md。
 *
 * 覆盖源区间：
 *   2796–2838  `_subagent_child_session` / `_tool_reversible` / `_short`（模块级小函数）
 *   8021–8050  `_ALLOWED_ORIGINS` / `_ALLOWED_HOSTNAMES` / `_DEFAULT_DEV_PORTS`（CORS 准入常量）
 *   8052–8131  `_origin_allowed` / `_host_allowed` / `cors_middleware`
 *
 * **本文件不含任何 handler 正文**（S0 的红线）。这里的六个导出是 S1–S10 全部段的
 * 共享底座：`cors_middleware` 罩住 160 条路由的每一条（含 `/ws` 的握手 GET），
 * 三个小函数是 WS 事件桥（S1/S2）与工具卡片渲染的公共依赖。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 源码自带的死路 / 不一致：逐字复制、只标注不修（RULEBOOK §2 BUG 规则）。
 * B 编号与 tmp/w218_S0_NOTES.md §2 的总表一致。
 *
 * B2 `_tool_reversible`（源 2812–2820）整条臂包在 `try/except Exception: return True`
 *    里，而 `try` 的第一句就是**函数级 import**（`from snapshot_store import is_reversible`，
 *    源 2817）。python 侧模块在，走真值；TS 侧 `snapshot_store` 是接缝，**默认未接线
 *    就是抛错 → 恒 `True`**。端口把这条缺省臂完整写出来（HTTP_UTIL_SEAMS.is_reversible
 *    默认抛 `ModuleNotFoundError: No module named 'snapshot_store'`，文案同 210 的
 *    mailbox 规则），探针注入假件去驱动"真值那一半"。docstring 自己承认这是故意的
 *    过度保守："an over-cautious 不可逆 badge on a harmless read is worse noise than a
 *    missing one"（源 2814–2815）。
 *
 * B3 `_subagent_child_session`（源 2796–2809）用 `str.partition` 切**第一个**
 *    `::sub::`：`"p::sub::a::sub::b"` → `("p", "a::sub::b")`，subagent_id 里带着第二个
 *    分隔符；`"::sub::x"` → parent 为空 → None；`"p::sub::"` → sub 为空 → None。
 *    端口**不许**用 `split("::sub::")` 全切，也不许"顺手校验一下子格式"。
 *
 * B4（`_short` 的一部分）源 2823–2834 的截断在**换行折叠之前**：先 `[:cap] + "…"`
 *    再 `replace("\n", " ")`。于是一条 500 字符、第 300 个字符处带换行的日志，
 *    预览里的换行**不会被折叠**（它被切掉了），而第 100 个字符处的换行会被折叠。
 *    顺序即行为，端口保持 `截断 → 折叠`。
 *
 * B5 `_origin_allowed`（源 8065–8084）的 `except Exception: pass` 把
 *    `parsed.port` 的 **ValueError 吞成"未命中 → return False"**：
 *    `http://localhost:99999`（越界）、`http://localhost:abc`（非数字）都不报错，
 *    静默走到最后的 `return False` → 403。端口必须保持"异常 → 拒绝"，
 *    绝不能"异常 → 放行"。
 *
 * B6 `_host_allowed`（源 8091–8093）：
 *    `hostname = host.rsplit(":", 1)[0] if not host.endswith("]") else host`
 *    然后 `hostname.strip("[]")`。`strip` 是**按字符集裁剪**，不是按括号配对：
 *    `"[[localhost]]"` → `"localhost"`（放行），`"]localhost["` → `"localhost"`（放行），
 *    `"localhost:"` → `rsplit` 得 `"localhost"`（放行），`"[::1]:8765"` →
 *    `rsplit` 得 `"[::1]"` → strip → `"::1"`（放行）。空 Host 直接 True（源 8089–8090
 *    注释：HTTP/1.0 或裸 socket 探测）。全部原样保留，不许换成正则。
 *
 * B9 `_origin_allowed` 的两条臂**判定强度不一致**：`origin in _ALLOWED_ORIGINS`
 *    （源 8062）是大小写敏感的集合成员判定，`http://LocalHost:5173` 不在集合里；
 *    但 dev-port 分支（8069–8080）把 hostname `.lower()` 后再比 `_ALLOWED_HOSTNAMES`，
 *    于是同一个 origin 最终**被第二条臂放行**。两条臂的结论都是 True，但**路径不同**，
 *    探针要能分辨（`file://` 与前缀判定同理：`startswith("file://")`，大小写敏感）。
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── 接缝（RULEBOOK §2 红线 5）──
 * `HTTP_UTIL_SEAMS` 是本文件唯一的对外触碰面，三项：
 *   `is_reversible`  ← 源 2817 函数级 import snapshot_store（默认：抛 ModuleNotFound）
 *   `environ_get`    ← 源 8072 `os.environ.get("OVOLVE_DEV_PORTS", "")`
 *   `json_dumps`     ← 源 2829 `json.dumps(..., ensure_ascii=False, default=str)`
 *                      （默认 = keys.ts 的 `py_json_dumps`，纯计算；列成接缝是为了
 *                        让探针能把"两侧同一个序列化器"这件事记账出来）
 * 时钟/随机/文件系统/网络/子进程：**本文件零触碰**。`cors_middleware` 不起真服务、
 * 不绑端口，它只是一个 `(request, handler) => WebResponse` 的纯决策函数。
 *
 * ── 本文件的确定性折叠（探针两侧同规则）──
 *   1. 环境变量：`OVOLVE_DEV_PORTS` 每次调用现读（源 8072 在函数体内），
 *      所以探针可以在同一进程里逐用例改写；`environ_get` 是记录型假件。
 *   2. urlparse：端口的 `py_urlparse` 是自己的实现（源 8066 用的是 stdlib），
 *      不是接缝——两侧必须是同一份语义，所以 python 侧也用 stdlib、TS 侧用本实现，
 *      用例表覆盖 stdlib 与本实现的等价域（见 §DIVERGENCE 第 2 条的论证）。
 *   3. 集合：`frozenset` → 只读 `Set<string>` / `Set<number>`，成员判定按值。
 *   4. 异常：`PyKeyError` / `ValueError`（port 里是带 python 文案的 `TypeError` 实例，
 *      与 keys.ts `py_int`/`py_float` 同一规则：文案进账本，类型身份不进）。
 *
 * DIVERGENCE(port) 1: `@web.middleware`（源 8096）在 aiohttp 里只做协程签名断言，
 *   不改变调用语义；TS 侧没有等价的装饰器期检查，`cors_middleware` 就是普通
 *   `async` 函数。**等价性**：装饰器的唯一可观察效果是"它必须排在
 *   `web.Application(middlewares=[...])` 的第一位"（源 8183），这条由
 *   create.ts 的 `MIDDLEWARE_ORDER` 常量原样声明，S10 装配时逐条 reduce。
 * DIVERGENCE(port) 2: `urllib.parse.urlparse` 是 stdlib，端口重实现了 `py_urlparse`。
 *   等价域 = origin 头允许的取值集合（`scheme://host[:port]`，含 `file://`、`null`、
 *   IPv6 字面量 `[::1]`、带 userinfo 的畸形值、带 path 的值）。这些形状上
 *   scheme 小写化、hostname 小写化、port 越界/非数字抛 ValueError 三条与 CPython
 *   逐字一致；超出该域（如 `http://[::1:not-a-port`、多级 `//`、IDN punycode 主机名）
 *   的差异**只影响 `return False` 的到达路径，不影响最终布尔值**（因为域外值
 *   一律落进 B5 的 `except Exception: pass` → False，而 CPython 同样落 False 或
 *   抛 ValueError 后同样被 B5 吞掉）。探针两侧各跑同一张 origin 表钉死这一点。
 * DIVERGENCE(port) 3: `str.isdigit()` / `str.strip()` 的 Unicode 语义。
 *   python `p.isdigit()` 对 `²`（Nd 之外的 Digit）也返回 True，随后 `int(p)` 抛
 *   ValueError → 被 B5 的 except 吞 → 该端口不加入白名单。端口用
 *   `py_isdigit`（Nd 或 NFKC 可分解为 Nd）+ `py_int_str`（只认 NFKC 后的 ASCII 数字，
 *   否则抛 ValueError 文案）复刻这条**两步**行为，而不是合并成"只认 [0-9]"。
 *   `strip()` 的空白集与 JS `trim()` 在 `\x1c–\x1f`、`\x85` 上有出入：这两个字符
 *   出现在 `OVOLVE_DEV_PORTS` 里时两侧都到不了 `int()`（isdigit False），
 *   故无可观察差。
 * DIVERGENCE(port) 4: `resp.headers[...] = ...`（源 8120–8126）在 aiohttp 里是
 *   **赋值即覆盖**；端口的 `MutableHeaders.set` 同为覆盖语义（大小写不敏感，
 *   与 CIMultiDict 的 `__setitem__` 一致）。源对 `Vary` 也是覆盖而不是追加——
 *   多值 `Vary` 在这里会互相吃掉，端口保持。
 */

import {
  json_response,
  py_int,
  py_json_dumps,
  py_strip,
  py_truth,
  text_response,
  type JsonDict,
  type HttpHandler,
  type WebRequest,
  type WebResponse,
} from "./http_server_keys.js";

/* ── 接缝表（探针在这里插假件）────────────────────────────────────────────── */

export interface HttpUtilSeams {
  /** 源 2817：`from snapshot_store import is_reversible` → `is_reversible(str(...))`。 */
  is_reversible: (toolName: string) => boolean;
  /** 源 8072：`os.environ.get("OVOLVE_DEV_PORTS", "")`。 */
  environ_get: (name: string, fallback?: string) => string;
  /** 源 2829：`json.dumps(value, ensure_ascii=False, default=str)`。 */
  json_dumps: (value: unknown) => string;
}

/** CPython `ModuleNotFoundError` 的文案镜像（同 210 mailbox 规则）。 */
export class ModuleNotFoundErrorP extends Error {
  readonly moduleName: string;
  constructor(message: string, moduleName: string) {
    super(message);
    this.name = "ModuleNotFoundError";
    this.moduleName = moduleName;
  }
}

export const HTTP_UTIL_SEAMS: HttpUtilSeams = {
  is_reversible(_toolName: string): boolean {
    // 源里这一句是 `from snapshot_store import is_reversible`：TS 侧模块尚未落地，
    // 缺省臂就是"模块不存在"，被源 2819 的 except Exception 吞掉 → _tool_reversible 恒 True。
    throw new ModuleNotFoundErrorP("No module named 'snapshot_store'", "snapshot_store");
  },
  environ_get(name: string, fallback = ""): string {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const v = env ? env[name] : undefined;
    return v === undefined ? fallback : v;
  },
  json_dumps(value: unknown): string {
    return py_json_dumps(value);
  },
};

/* ── 源 2796–2809 ────────────────────────────────────────────────────────── */

/**
 * `(parent_session, subagent_id) | null` —— 源 2796 的 docstring：
 * ``subagent_runtime`` mints child sessions as ``f"{parent}::sub::{sub_id}"``
 * (see ``spawn_one``), which makes the parent recoverable from the child id
 * without a lookup table and without a runtime import. Cheap enough to call on
 * every bus event.
 *
 * 语义要点（B3）：空串直接 None；不含 `::sub::` 直接 None；`partition` 只切第一个；
 * parent 或 sub 任一为空 → None（所以 `"::sub::x"` 与 `"p::sub::"` 都是 None）。
 */
export function subagent_child_session(session_id: unknown): [string, string] | null {
  const sid = session_id === null || session_id === undefined ? "" : String(session_id);
  if (!py_truth(sid) || !sid.includes("::sub::")) return null;
  const at = sid.indexOf("::sub::");
  const parent = sid.slice(0, at);
  const sub = sid.slice(at + "::sub::".length);
  if (!parent || !sub) return null;
  return [parent, sub];
}

/* ── 源 2812–2820 ────────────────────────────────────────────────────────── */

/**
 * 工具卡片的"可逆"标记。docstring（源 2813–2815）：
 * Reversibility flag for the tool card. Defaults to True on any failure —
 * an over-cautious "不可逆" badge on a harmless read is worse noise than a
 * missing one, and the rollback dialog surfaces the real list anyway.
 *
 * `str(tool_name or "")`（源 2818）：假值（`""`/`0`/`None`/`False`/空容器）全部先塌成
 * `""`，再 `str()`。端口两步都保留（B2 的缺省臂 + 这个 or）。
 */
export function tool_reversible(tool_name: unknown, seams: HttpUtilSeams = HTTP_UTIL_SEAMS): boolean {
  try {
    return seams.is_reversible(py_or_truthy_str(tool_name));
  } catch {
    // except Exception: return True —— 源 2819–2820，宽吞，连日志都不留
    return true;
  }
}

/** `str(tool_name or "")`：先 or 再 str（0/False/"" 都会变成 ""）。 */
function py_or_truthy_str(v: unknown): string {
  return py_truth(v) ? js_str(v) : "";
}

function js_str(v: unknown): string {
  return v === null || v === undefined ? "None" : String(v);
}

/* ── 源 2823–2834 ────────────────────────────────────────────────────────── */

/**
 * UI 用的一行式值预览。源 2823–2834：
 *   - `None` → `""`（注意：**不是** `"None"`）
 *   - 非 str → `json.dumps(v, ensure_ascii=False, default=str)`，
 *     只在 `(TypeError, ValueError)` 时退化成 `str(v)`
 *   - `len(value) > cap` → `value[:cap] + "…"`（**码点**计数，见 keys.ts §DIVERGENCE 6）
 *   - 最后 `value.replace("\n", " ")`
 * 截断在折叠之前（B4），顺序即行为。
 */
export function short(value: unknown, cap = 220, seams: HttpUtilSeams = HTTP_UTIL_SEAMS): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else {
    try {
      s = seams.json_dumps(value);
    } catch (exc) {
      if (!is_type_or_value_error(exc)) throw exc;
      s = js_str(value);
    }
  }
  const cps = Array.from(s);                       // python 的 len/切片按码点
  if (cps.length > cap) s = cps.slice(0, cap).join("") + "…";
  return split_replace_newline(s);
}

/** `str.replace("\n", " ")`：全部替换，不是只替第一个。 */
function split_replace_newline(s: string): string {
  return s.split("\n").join(" ");
}

/** `except (TypeError, ValueError)`：端口的 `py_json_dumps` 把这两类都抛成 Error 实例。 */
function is_type_or_value_error(exc: unknown): boolean {
  const msg = exc instanceof Error ? exc.name + ": " + exc.message : String(exc);
  return /TypeError/.test(msg) || /ValueError/.test(msg);
}

/* ── 源 8021–8050：CORS / Host 准入常量 ─────────────────────────────────────
 * 源 8023–8032 的注释是**安全语义的一部分**，逐字保留其结论：
 *   旧中间件把 `request.headers["Origin"]` 原样 echo 回去 +
 *   `Access-Control-Allow-Credentials: true`，等于没有策略——用户开着的任何页面
 *   都能打这里的全部 ~77 族路由（含写文件、跑 shell、发 provider key 的那些），
 *   而"只监听 127.0.0.1"挡不住页面：loopback 限制的是**机器**，不是**页面**。
 * -------------------------------------------------------------------------- */

/** 源 8033–8042 `_ALLOWED_ORIGINS`（frozenset，8 个成员，顺序无意义）。 */
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set<string>([
  "http://localhost:5173",      // vite dev server (dev)
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:8765",      // backend serving ui/dist itself
  "http://127.0.0.1:8765",
]);

/** 源 8048 `_ALLOWED_HOSTNAMES`：DNS-rebinding 的门（只认三个回环名）。 */
export const ALLOWED_HOSTNAMES: ReadonlySet<string> = new Set<string>(["127.0.0.1", "localhost", "::1"]);

/** 源 8049 `_DEFAULT_DEV_PORTS`。 */
export const DEFAULT_DEV_PORTS: ReadonlySet<number> = new Set<number>([5173, 3000, 8080, 8765]);

/* ── CPython urllib.parse.urlparse 的 origin 域子集（见 §DIVERGENCE 2）─────── */

export interface ParseResult {
  scheme: string;
  netloc: string;
  path: string;
  /** property-style：越界/非数字抛 ValueError 文案（源 8078 读它才会抛）。 */
  hostname(): string | null;
  port(): number | null;
}

export function py_urlparse(url: string): ParseResult {
  let rest = url;
  let scheme = "";
  const colon = rest.indexOf(":");
  if (colon > 0) {
    const head = rest.slice(0, colon);
    if (/^[A-Za-z][A-Za-z0-9+.-]*$/.test(head)) {
      scheme = head.toLowerCase();
      rest = rest.slice(colon + 1);
    }
  }
  let netloc = "";
  if (scheme !== "") {
    // 只有带 scheme 的、或以 // 开头的才有 authority 段（CPython 规则）
    if (rest.startsWith("//")) {
      const after = rest.slice(2);
      const end = firstOf(after, "/?#");
      netloc = end === -1 ? after : after.slice(0, end);
      rest = end === -1 ? "" : after.slice(end);
    }
  } else if (rest.startsWith("//")) {
    const after = rest.slice(2);
    const end = firstOf(after, "/?#");
    netloc = end === -1 ? after : after.slice(0, end);
    rest = end === -1 ? "" : after.slice(end);
  }
  const authority = netloc.includes("@") ? netloc.slice(netloc.lastIndexOf("@") + 1) : netloc;
  const splitHostPort = (): { host: string; portText: string | null } => {
    if (authority.startsWith("[")) {
      const close = authority.indexOf("]");
      if (close === -1) return { host: "", portText: null };        // 畸形 IPv6 → hostname 抛 ValueError
      const h = authority.slice(1, close);
      const tail = authority.slice(close + 1);
      if (tail === "") return { host: h, portText: null };
      if (!tail.startsWith(":")) return { host: "", portText: null };
      return { host: h, portText: tail.slice(1) };
    }
    const c = authority.indexOf(":");
    if (c === -1) return { host: authority, portText: null };
    if (authority.indexOf(":", c + 1) !== -1) return { host: "", portText: null }; // 多个 ':' → 非法 IPv6 without brackets
    return { host: authority.slice(0, c), portText: authority.slice(c + 1) };
  };
  return {
    scheme,
    netloc,
    path: rest.split("?")[0] as string,
    hostname(): string | null {
      const { host } = splitHostPort();
      if (scheme !== "" && !["http", "https", "ftp", "file"].includes(scheme) && host === "") return null;
      if (host === "") {
        if (scheme === "" || netloc === "") return null;
        throw new TypeError("ValueError: Invalid hostname " + JSON.stringify(netloc));
      }
      return host.toLowerCase();
    },
    port(): number | null {
      const { portText } = splitHostPort();
      if (portText === null || portText === "") return null;
      if (!py_isdigit(portText)) {
        throw new TypeError(`ValueError: Port could not be cast to integer value as ${JSON.stringify(portText)}`);
      }
      const n = py_int_str(portText);
      if (n < 0 || n > 65535) {
        throw new RangeError(`ValueError: Port out of range 0-65535`);
      }
      return n;
    },
  };
}

function firstOf(s: string, chars: string): number {
  for (let i = 0; i < s.length; i++) if (chars.includes(s.charAt(i))) return i;
  return -1;
}

/** python `str.isdigit()`：Nd，或 NFKC 后可分解为 Nd（`²` 也算，但 `½` 不算）。 */
export function py_isdigit(s: string): boolean {
  if (s.length === 0) return false;
  for (const ch of Array.from(s)) {
    if (/\p{Nd}/u.test(ch)) continue;
    const nfkc = ch.normalize("NFKC");
    if (nfkc !== ch && /^\p{Nd}+$/u.test(nfkc)) continue;
    return false;
  }
  return true;
}

/** python `int(s)`（十进制）：只认 NFKC 后的 ASCII 数字，否则抛原文 ValueError 文案。 */
export function py_int_str(s: string): number {
  const ascii = s.normalize("NFKC");
  if (!/^[+-]?\d+$/.test(ascii)) {
    throw new TypeError(`ValueError: invalid literal for int() with base 10: '${s}'`);
  }
  return py_int(ascii);
}

/* ── 源 8052–8084 ────────────────────────────────────────────────────────── */

/**
 * True when `origin` may talk to this API.（源 8052–8084）
 * 判定顺序**即语义**，四步一步不能挪：
 *   1. 空/`"null"` → True（原生客户端：自家 Python 工具、curl、Electron 健康探针。
 *      源 8055–8057 的论证：浏览器发跨域请求一定会带上真 origin，恶意页面到不了这里）
 *   2. `file://` 前缀 → True（打包后的桌面构建，renderer 从磁盘加载）
 *   3. 集合精确成员（**大小写敏感**，B9）→ True
 *   4. 回环 dev 端口：scheme ∈ {http,https} 且 hostname ∈ _ALLOWED_HOSTNAMES 时，
 *      白名单端口 = _DEFAULT_DEV_PORTS ∪ OVOLVE_DEV_PORTS（逗号分隔，逐段 strip +
 *      isdigit 才收）；命中 → True，**未命中 → 显式 False（不再往下走）**。
 *      任何异常（含 B5 的 port ValueError）→ 掉出 try → 最后 False。
 */
export function origin_allowed(origin: string, seams: HttpUtilSeams = HTTP_UTIL_SEAMS): boolean {
  const o = origin ?? "";
  if (!py_truth(o) || o === "null") return true;
  if (o.startsWith("file://")) return true;
  if (ALLOWED_ORIGINS.has(o)) return true;
  // Allow loopback dev origins only if within allowed ports or OVOLVE_DEV_PORTS
  try {
    const parsed = py_urlparse(o);
    if (parsed.scheme === "http" || parsed.scheme === "https") {
      const h = (parsed.hostname() ?? "").toLowerCase();
      if (ALLOWED_HOSTNAMES.has(h)) {
        const allowed = new Set<number>(DEFAULT_DEV_PORTS);
        const extra = seams.environ_get("OVOLVE_DEV_PORTS", "");
        if (extra) {
          for (let p of extra.split(",")) {
            p = py_strip(p);
            if (py_isdigit(p)) allowed.add(py_int_str(p));
          }
        }
        const port = parsed.port() ?? (parsed.scheme === "https" ? 443 : 80);
        if (allowed.has(port)) return true;
        return false;                    // 源 8081：显式 False，不是 fallthrough
      }
    }
  } catch {
    // except Exception: pass —— B5：坏端口号/坏主机字面量统统静默走到 False
  }
  return false;
}

/* `py_strip` 直接用 §M（文件头 import）。
 * 这里原本是本文件自带的第二份实现（正则字符类），对 CPython 实测漏裁 21 个码点：
 * U+1c..U+1f、U+1680、U+2000..U+200a、U+2028/9、U+202f、U+205f、U+3000（见 tmp/lead_strip_diff.txt）。
 */

/* ── 源 8087–8093 ────────────────────────────────────────────────────────── */

/**
 * True when the `Host` header names this loopback server.
 * 空 Host → True（源 8090 注释：HTTP/1.0 或裸 socket 探测）。B6 的两步裁剪原样保留。
 */
export function host_allowed(host: string): boolean {
  const h = host ?? "";
  if (!py_truth(h)) return true;
  const hostname = !h.endsWith("]") ? rsplit_once(h, ":") : h;
  return ALLOWED_HOSTNAMES.has(strip_chars(hostname, "[]").toLowerCase());
}

/** `s.rsplit(":", 1)[0]`（python：无分隔符时整串返回）。 */
function rsplit_once(s: string, sep: string): string {
  const at = s.lastIndexOf(sep);
  return at === -1 ? s : s.slice(0, at);
}

/** `str.strip("[]")`：按字符集两端裁剪，**不配对**。 */
function strip_chars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s.charAt(a))) a++;
  while (b > a && chars.includes(s.charAt(b - 1))) b--;
  return s.slice(a, b);
}

/* ── 源 8096–8127 ────────────────────────────────────────────────────────── */

/**
 * Gate every request on Origin + Host, then answer CORS for allowed ones.
 * （源 8096–8127；docstring：Applies to `/ws` as well —— WebSocket 握手就是一次
 * 普通 GET，在这里拒掉，socket 就永远升不了级。）
 *
 * 顺序**不可调换**（源 8104 先 Host、8108 后 Origin）：
 *   Host 不合法 → **421** `{"error": "Host not allowed (loopback names only)"}`
 *   Origin 不合法 → **403** `{"error": "Origin not allowed: <原文>"}`
 *     （源 8109–8111 的理由：只藏 CORS 头不算拒——浏览器**已经把请求发出去了**，
 *      而这里好几条路由的 POST 会改状态，不管回答能不能被读到。）
 *   OPTIONS → 204，**不调 handler**（preflight 不落业务副作用）
 *   其余 → `await handler(request)`
 * 然后无条件补 3 个 CORS 头；只有 `origin && origin != "null"` 时才补
 * `Allow-Origin/Allow-Credentials/Vary` 三个（源 8119–8122）。
 * 421/403 两条**早退分支不带任何 CORS 头**——浏览器侧看不到 Allow-Origin，
 * 这是有意的（早退发生在补头之前），端口保持。
 *
 * `resp.headers[...] = ...` 在 aiohttp 里是覆盖；见 §DIVERGENCE 4。
 */
export async function cors_middleware(request: WebRequest, handler: HttpHandler): Promise<WebResponse> {
  const origin = request.headers.get("Origin", "");
  if (!host_allowed(request.headers.get("Host", ""))) {
    return json_response({ error: "Host not allowed (loopback names only)" }, 421);
  }
  if (!origin_allowed(origin)) {
    // 403 rather than merely withholding the CORS header: without a body a
    // browser would still have *sent* the request, and several routes here
    // change state on POST regardless of whether the answer can be read.
    return json_response({ error: `Origin not allowed: ${origin}` }, 403);
  }

  let resp: WebResponse;
  if (request.method === "OPTIONS") {
    resp = text_response({ status: 204 });
  } else {
    resp = await handler(request);
  }

  if (py_truth(origin) && origin !== "null") {
    resp.headers.set("Access-Control-Allow-Origin", origin);
    resp.headers.set("Access-Control-Allow-Credentials", "true");
    resp.headers.set("Vary", "Origin");
  }
  resp.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  // X-Api-Token has to be listed or the browser blocks the preflight and the
  // request never arrives — the auth middleware would then never even see it.
  resp.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Token");
  return resp;
}

/** 源 8183 的中间件栈顺序常量（S10 装配时消费；CORS 最外层）。 */
export const MIDDLEWARE_ORDER = ["cors_middleware", "api_auth.auth_middleware"] as const;

/** 只给探针：把一次 `cors_middleware` 调用折叠成可比对的账本行。 */
export function cors_ledger(resp: WebResponse): JsonDict {
  const out: JsonDict = { status: resp.status, kind: resp.kind, headers: resp.headers.items() };
  if (resp.body !== undefined) out.body = resp.body;
  if (resp.text !== undefined) out.text = resp.text;
  return out;
}

// PORT STATUS: 本文件无 TODO(port)。
