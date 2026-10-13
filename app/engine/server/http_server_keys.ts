/**
 * http_server_keys.ts — 源：app/backend/server/http_server.py（8819 行）的 **公共面（S0）**。
 * 单元 218 / wave-10，manifest.tsv target=TS（SPLIT→TS，全工程最大单元，分段作战）。
 * 分段方案：D:/ovolve-migration/tmp/w218_SEGMENTS.md；契约表：tmp/w218_SURFACE.md。
 * 本文件对应源区间 **1–39**（imports + `ROUTER_KEY` / `SESSION_HOST_KEY`），
 * 外加两件只在"跨段共享"时才有意义的事：aiohttp 请求/响应面的类型镜像，
 * 以及 CPython 语义小工具（30 处 app 键读写之外，最容易各段自己重发明一遍的东西）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 头号陷阱（源 28–37 行原文，逐字抄录，不许"顺手统一"）：
 *
 *   #: ``app[...]`` 的键。aiohttp 推荐用 AppKey 而不是裸字符串：AppKey 带类型
 *   #: 信息，且两个不同用途的键撞名时会立刻报错，而不是悄悄互相覆盖。
 *   #: 此前这里是裸字符串键，aiohttp 每次用到就刷一条 NotAppKeyWarning——
 *   #: 测试套件里那 14 条警告 100% 出自这里。
 *   #:
 *   #: ⚠️ AppKey 与同名字符串在 dict 里是**两个不同的键**。所以下面 30 处读写
 *   #: 必须一次性改全：只改写、不改读（或反之），运行时就是 KeyError，
 *   #: 而且没被测试覆盖到的 handler 不会当场暴露。
 *   ROUTER_KEY = web.AppKey("router", Router)
 *   SESSION_HOST_KEY = web.AppKey("session_host", SessionHost)
 *
 * 源里实测 **31 处**读写（不含 36/37 两行定义与三行文档提及）：
 *   `request.app[ROUTER_KEY]`      23 处：2994 3225 4809 5226 5240 5264 5301 5316
 *                                  5432 5456 5558 5605 5628 5678 5703 5761 5789
 *                                  5812 5840 5925 6556 6702 7768
 *   `request.app.get(ROUTER_KEY)`   4 处：3569 6989 7007 7027
 *   `request.app[SESSION_HOST_KEY]` 2 处：4847 4888
 *   写（唯一两处）                   2 处：8184 8185（create_server 内）
 *
 * 端口侧的**硬约束**（S1–S10 每一段都必须遵守，违反即返工）：
 *   1. 读写 app 状态只能 `import { ROUTER_KEY, SESSION_HOST_KEY } from
 *      "./http_server_keys.js"`，然后走 `app_state_get(app, ROUTER_KEY)` /
 *      `app_state_require(app, ROUTER_KEY)` / `app_state_set(...)`。
 *   2. **绝不允许**自己 `new AppKey("router", "Router")` 现场造一个"同名键"。
 *      aiohttp 的 AppKey 相等性是**按对象身份**（不是按 name），所以源里
 *      再 new 一次就已经是第二个键了；端口把这个性质**原样保留**——
 *      `AppState` 的 Map 用对象身份做键，同名新实例同样是"查不到"。
 *      这就是为什么"必须一次改全"在 TS 侧仍然是真问题，而不是被类型系统消掉了。
 *   3. 字符串 `"router"` / `"session_host"` 在本端口里**不是** app 状态的键，
 *      `AppState` 的签名不收 string（编译期挡下"只改读不改写"这一半；
 *      python 那边是运行时 KeyError）。这是端口的**加强**，不是放松：
 *      等价性论证 = 源里不存在任何用裸字符串读写 app 的点（上面 31 处全是 AppKey），
 *      所以"屏蔽裸字符串键"不改变任何可观察行为。
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── 源码自带的死路：逐字复制、只标注不修（RULEBOOK §2 BUG 规则）──
 * 本文件（源 1–39）自身的缺陷面：见 tmp/w218_S0_NOTES.md 的 B 系列总表。此处直接
 * 落到代码里的两条：
 *
 * D1 源 16 行 `import json, asyncio, os, re, time, urllib.parse` 与 20 行
 *    `from result import Result`：`Result` 在本文件里**只出现在类型位置都没有**
 *    （全文件 `Result` 作为名字的唯一出现就是 20 行本身；回合结果走的是
 *    `turn.value/turn.ok` 鸭子字段）。端口保留这个"导入了但没_used_"的事实：
 *    keys.ts 不导出任何 Result 相关符号，S1–S10 谁要用谁自己走 seam。
 * D2 源 25 行 `from risk_control import init_risk_controller` 同样是**顶层导入、
 *    只在 8651 行（run_server 内）用过一次**，而 8625 行又在函数内**重新
 *    `from risk_control import init_risk_controller`** 了一遍——同一个名字被
 *    导两次，后者遮蔽前者。端口如实保留：见 create.ts 的 `runServer` 接缝清单，
 *    顶层那一次不计入任何接缝调用。
 *
 * ── 接缝（RULEBOOK §2 红线 5）──
 * 本文件不触碰任何外部系统：`node:crypto` 只在 `py_hash_seed` 之外**不使用**，
 * 全部导出都是纯计算 + 纯数据结构。真正需要接缝的东西（文件系统、WebSocket 升级、
 * 端口绑定、调度器启动）都在 util.ts / create.ts 里声明。
 * 没有真的 SQLite、没有真端口、没有真 HTTP、没有真子进程。
 *
 * ── 本文件的确定性折叠（探针两侧同规则）──
 *   1. 时钟  : 本文件零处读时钟（源 1–39 无 time 调用；36 行那两个 AppKey 是纯构造）。
 *   2. 键身份: `AppKey.toString()` 渲染成 `<AppKey name=router type='Router'>`，
 *              与 python `repr(AppKey)` 同形，KeyError 文案两侧可比。
 *   3. 数字  : `py_int` / `py_float` 复刻 CPython 的取值与抛错文案（源里 30+ 处
 *              `int(request.query.get(...))`），非整数小数字符串必须抛
 *              `invalid literal for int() with base 10: '9.5'` 而不是静默截断。
 *
 * DIVERGENCE(port): python 的 `@web.middleware` 装饰器只做**签名断言**（协程
 *   `(request, handler)`），不改变行为；TS 侧没有装饰器期检查，故 util.ts 里
 *   `cors_middleware` 就是普通 async 函数，注册顺序（8183 行
 *   `[cors_middleware, api_auth.auth_middleware]`）由 create.ts 的路由装配段承担。
 * DIVERGENCE(port): python `dict` 的 `app[KEY]` 缺键抛 `KeyError`，`app.get(KEY)`
 *   返回 None。端口把两者都保留（`app_state_require` / `app_state_get`），
 *   KeyError 的 repr 文案按 CPython 形状渲染，见上面折叠 2。
 * DIVERGENCE(port): `AppKey(name, type)` 的第二参数在 aiohttp 里**只用于类型提示
 *   与 repr**，运行时不参与任何判定；端口把它降级成 string 字面量 `typeName`，
 *   因此 "Router"/"SessionHost" 这两个类对象在这里不需要静态 import（源 22–23 行
 *   的 `from router import Router` / `from session_host import ...` 在端口里
 *   只以**类型名**出现，静态依赖归零，S1–S10 与 218 的 SCC 环不会因此收紧）。
 */

/* ── 基础类型面（aiohttp 的 `web` 命名空间在端口里的最小忠实镜像）─────────── */

/** python `dict` 解码后的公共形状（源里所有 handler 的 body/query 都落在这里）。 */
export type JsonDict = Record<string, unknown>;

/**
 * `bool(x)` / `if x` / `x or y` —— 与 team_collab.ts 的本地实现同规则（本处导出是为了 10 段共用）。
 *
 * 两处脸曾错过（值级差分 `tmp/lead_py_truth_ab.mjs` 当场抓到，CPython 为真值来源）：
 *   1) **空 dict**：`{}` 走“普通对象”支，旧代码注释写着“非 null 即真”⇒ 返回 true；
 *      CPython `bool({})` 是 **False**，于是 `cfg.get("x") or {}` / `if body:` 这一支在端口会
 *      多跑路径（S6b 实测：`{"compaction":{...}}` 一个请求里源只走 compaction，端口连走 5 支）。
 *      ⇒ 现在按 `Object.keys(...).length` 判（`Map` 支一直是这么判的，两脸对齐）。
 *   2) **NaN**：`float("nan")` 在 CPython 是 **真**（`bool(float('nan')) is True`），
 *      旧代码 `!Number.isNaN(v)` 把它判成假 ⇒ 与 JS `if (NaN)` 一致但与 Python 不一致，这里以 Python 为准。
 * 类实例（有非 Object 原型）默认恒真、`__bool__` 优先，这两条与 CPython 一致（差分表已钉）。
 */
export function py_truth(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;         // NaN 为真（CPython 口径）
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (v instanceof Uint8Array) return v.length > 0;
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v) as object | null;
    if (proto !== Object.prototype && proto !== null) {
      const b = (v as { __bool__?: () => unknown }).__bool__;
      if (typeof b === "function") return py_truth(b.call(v));
      return true;                     // 类实例默认恒真（= CPython object 无 __bool__/__len__）
    }
    return Object.keys(v as JsonDict).length > 0; // dict 脸：空 dict 为假
  }
  if (typeof v === "function") return true;
  return Boolean(v);
}

/** `a or b`：只在 a 为假时才算 b。 */
export function py_or(a: unknown, b: unknown): unknown {
  return py_truth(a) ? a : b;
}

/** CPython `float(x)` 的 repr（整数补 `.0`，inf/nan 拼写）。 */
export function py_float_repr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  // CPython str/repr(-0.0) == "-0.0"; JS String(-0) == "0" would drop the sign.
  // Evidence: tmp/asku_negzero_evidence.txt (pinned CPython 3.13.15, 2026-10-10).
  if (Object.is(x, -0)) return "-0.0";
  let s = String(x);
  if (!/[.eE]/.test(s)) s += ".0";
  return s;
}

/** python 类型名（错误文案用：`str(int)`、`is not JSON serializable`）。 */
export function py_type_name(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (v instanceof Set) return "set";
  if (v instanceof Map) return "dict";
  if (v instanceof Uint8Array) return "bytes";
  if (typeof v === "function") return "function";
  if (typeof v === "object") {
    const cls = (v as { __class__?: string; constructor?: { name?: string } }).__class__;
    if (typeof cls === "string") return cls;
    const n = v.constructor && v.constructor.name ? v.constructor.name : "object";
    return n === "Object" ? "dict" : n;
  }
  return typeof v;
}

/**
 * python `str(x)`。JSON 原生值走 CPython 文案；类实例走 `__str__`（探针假件提供），
 * 没有 `__str__` 时退化成 `__repr__`，再没有就是 `<X object at 0x...>` 形状。
 * 源 2818 `str(tool_name or "")`、2831 `value = str(value)`、
 * 以及 handler 里 200+ 处 `str(...)` 共用这一条语义。
 */
export function py_str(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) && !Object.is(v, -0) ? String(v) : py_float_repr(v);
  if (v instanceof Uint8Array) return `b'${Array.from(v, (b) => String.fromCharCode(b)).join("")}'`;
  if (typeof v === "object") {
    const o = v as { __str__?: () => unknown; __repr__?: () => unknown };
    if (typeof o.__str__ === "function") return String(o.__str__.call(v));
    if (typeof o.__repr__ === "function") return String(o.__repr__.call(v));
  }
  return py_repr(v);
}

/** python `repr(x)`：dict/list 用单引号，字符串按需切换引号。 */
export function py_repr(v: unknown): string {
  if (typeof v === "string") {
    const hasS = v.includes("'");
    const hasD = v.includes('"');
    const q = hasS && !hasD ? '"' : "'";
    const esc = v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    return q + esc.replace(new RegExp(q, "g"), "\\" + q) + q;
  }
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) && !Object.is(v, -0) ? String(v) : py_float_repr(v);
  if (Array.isArray(v)) return "[" + v.map(py_repr).join(", ") + "]";
  if (v instanceof Map) return "{" + [...v.entries()].map(([k, x]) => py_repr(k) + ": " + py_repr(x)).join(", ") + "}";
  if (v instanceof Set) return v.size === 0 ? "set()" : "{" + [...v].map(py_repr).join(", ") + "}";
  if (typeof v === "object") {
    const o = v as { __repr__?: () => unknown; __class__?: string };
    if (typeof o.__repr__ === "function") return String(o.__repr__.call(v));
    const cls = py_type_name(v);
    const inner = Object.entries(v as JsonDict).map(([k, x]) => py_repr(k) + ": " + py_repr(x)).join(", ");
    if (cls === "dict") return "{" + inner + "}";
    return `<${cls} object at 0x0>`;
  }
  return repr_of_fn(v);
}

function repr_of_fn(v: unknown): string {
  const name = (v as { name?: string }).name || "?";
  return `<function ${name}>`;
}

/**
 * python `json.dumps(value, ensure_ascii=False, default=str)`（源 2829 唯一一处）。
 * 不可序列化 → 走 `default=str`（所以**不会**抛 TypeError）；循环引用/BigInt 这类
 * python 也扛不住的东西抛 TypeError，文案与 CPython 同形。
 */
export function py_json_dumps(v: unknown): string {
  const seen = new WeakSet<object>();
  const enc = (x: unknown, key: string | null): string => {
    if (x === null) return "null";
    if (typeof x === "boolean") return x ? "true" : "false";
    if (typeof x === "number") {
      if (!Number.isFinite(x)) throw new TypeError(`ValueError: ${py_float_repr(x)} is not JSON serializable`);
      return Number.isInteger(x) && !Object.is(x, -0) ? String(x) : py_float_repr(x);
    }
    if (typeof x === "string") return quote_json_string(x);
    if (typeof x === "bigint") throw new TypeError(`${py_type_name(x)} is not JSON serializable`);
    if (typeof x === "object") {
      if (seen.has(x)) throw new TypeError("ValueError: Circular reference detected");
      if (x instanceof Uint8Array) throw new TypeError("TypeError: Object of type bytes is not JSON serializable");
      seen.add(x);
      let out: string;
      if (Array.isArray(x)) {
        out = "[" + x.map((e) => enc(e, null)).join(", ") + "]";
      } else {
        const m = x instanceof Map ? x : null;
        const entries: [string, unknown][] = m
          ? [...m.entries()].map(([k, val]) => [String(k), val] as [string, unknown])
          : Object.entries(x as JsonDict).filter(([, val]) => typeof val !== "function");
        out = "{" + entries.map(([k, val]) => quote_json_string(k) + ": " + enc(val, k)).join(", ") + "}";
      }
      seen.delete(x);
      return out;
    }
    // function / symbol → python 走 default=str
    return quote_json_string(py_str(x));
  };
  void key_unused();
  return enc(v, null);
}
function key_unused(): number { return 0; }

/** JSON 字符串字面量（ensure_ascii=False：非 ASCII 原样输出）。 */
function quote_json_string(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

/**
 * PEP 515（CPython 3.6+ 起 `int()`/`float()` 认下划线）。规则不是「接受下划线」，而是「下划线只能
 * 夹在两个数字之间」。边界实测表：`tmp/lead_keys_underscore2.txt`（本机钉住的 3.13.15，53 行，由
 * `tmp/lead_keys_underscore2_probe.py` 产出）：认可 `1_0`->10、`0_0`->0、`1.0_0`->1.0、`1_0.5_0`->10.5、
 * `1e1_0`->1e10、`1_0e1_0`->1e11、`+1_0`/`-1_0`、`"  1_0  "`->10；一律 ValueError 拒掉 `_10`/`10_`/`1_`/
 * `_1`/`1__0`/`1.0__0`/`1_.0`/`1._0`/`1.0_`/`1.0_e1`/`1_0inf`/`0x1_0`。
 * => 整数段、小数段、指数段的数字串一律 `\d+(?:_\d+)*`；过验证后删掉 `_` 再交给
 * `Number.parseFloat/parseInt`。错误文案引**原始**入参（`py_repr(x)`），CPython 也这么印。
 * 与旧串 `^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$` 的关系是**严格超集**：旧串放行的仍然放行，
 * 只是多出下划线形式（`1.`、`.5`、带符号、带指数照旧），所以这一改动只可能把红脸变成绿脸。
 */
const PY_INT_RE = /^[+-]?\d+(?:_\d+)*$/;
const PY_FLOAT_RE = /^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/;

/**
 * python `int(x)`（源里 30+ 处 `int(request.query.get(...))`）。
 * 忠实点：允许首尾空白、`+/-`、纯数字；小数串/空串/非数字串抛
 * `ValueError: invalid literal for int() with base 10: '<原文>'`（**带原文**），
 * float 入参走截断（`int(9.7) == 9`），str 入参绝不四舍五入。
 */
export function py_int(x: unknown): number {
  if (typeof x === "number") {
    if (Number.isNaN(x)) throw new TypeError("ValueError: cannot convert float NaN to integer");
    if (!Number.isFinite(x)) throw new RangeError("OverflowError: cannot convert float infinity to integer");
    return Math.trunc(x);
  }
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x !== "string") throw new TypeError(`int() argument must be a string, a bytes-like object or a real number, not '${py_type_name(x)}'`);
  const s = py_strip(x);  // 同上：CPython 的边界空白是 str.isspace()，不是 JS trim
  if (!PY_INT_RE.test(s)) {
    throw new TypeError(`ValueError: invalid literal for int() with base 10: ${py_repr(x)}`);
  }
  return Number.parseInt(s.replace(/_/g, ""), 10);
}

/** python `float(x)`：接受 `1e3`/`.5`/`inf`/`nan`（大小写不敏感），否则同样抛原文 ValueError。 */
export function py_float(x: unknown): number {
  if (typeof x === "number") return x;
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x !== "string") throw new TypeError(`float() argument must be a string or a real number, not '${py_type_name(x)}'`);
  const s = py_strip(x);  // CPython 裁边用 str.isspace()（29 码点 = PY_ISSPACE）；JS trim 吃 U+FEFF、却留 U+1C-1F/85，口径不同
  if (/^[+-]?(inf|infinity)$/i.test(s)) return /^-/.test(s) ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  if (/^[+-]?nan$/i.test(s)) return Number.NaN;
  if (!PY_FLOAT_RE.test(s)) {
    throw new TypeError(`ValueError: could not convert string to float: ${py_repr(x)}`);
  }
  return Number.parseFloat(s.replace(/_/g, ""));
}

/** CPython KeyError 的镜像：文案是 `repr(key)`，探针两侧按 text 比对。 */
export class PyKeyError extends Error {
  readonly keyText: string;
  constructor(keyText: string) {
    super(`KeyError: ${keyText}`);
    this.name = "KeyError";
    this.keyText = keyText;
  }
}

/* ── web.AppKey 镜像（源 36–37 行）────────────────────────────────────────── */

/**
 * `web.AppKey(name, type)` 的端口镜像。
 * 关键性质（与 aiohttp 一致，也是本文件存在的理由）：
 *   - 相等性 = **对象身份**，不是 name。`sameKey("router") !== sameKey("router")`。
 *   - `typeName` 只为 repr / 错误文案服务（源里的 `Router` / `SessionHost`
 *     在运行时不参与判定）→ 见文件头 DIVERGENCE(port) 第 3 条。
 */
export class AppKey<T> {
  readonly name: string;
  readonly typeName: string;
  /** 幻影字段：让 `AppKey<Router>` 与 `AppKey<SessionHost>` 在 TS 里不可互换。 */
  declare readonly __valueType__?: T;
  constructor(name: string, typeName: string) {
    this.name = name;
    this.typeName = typeName;
  }
  toString(): string {
    return `<AppKey name=${this.name} type='${this.typeName}'>`;
  }
}

/** 源 36 行。写：8184；读：23 处下标 + 4 处 `.get`。 */
export const ROUTER_KEY: AppKey<unknown> = new AppKey<unknown>("router", "Router");
/** 源 37 行。写：8185；读：4847 4888（都取 `._sessions.values()`）。 */
export const SESSION_HOST_KEY: AppKey<unknown> = new AppKey<unknown>("session_host", "SessionHost");

/** 全部导出的键对象；S1–S10 只允许从这里取键，不允许现场 new。 */
export const APP_KEYS = { ROUTER_KEY, SESSION_HOST_KEY } as const;

/**
 * `web.Application` 的 dict 面（`app[KEY] = ...` / `app[KEY]` / `app.get(KEY)`）。
 * 用 Map 建模：**只接受 AppKey**，裸 string 在编译期就是类型错误 ——
 * 这是把源注释里"只改写、不改读 → 运行时 KeyError"的那半条路堵死。
 */
export class AppState {
  private readonly map: Map<AppKey<never>, unknown> = new Map<AppKey<never>, unknown>();

  set<T>(key: AppKey<T>, value: T): void {
    this.map.set(key as AppKey<never>, value);
  }

  /** `app.get(KEY)` → 缺键返回 null（python 的 None）。源 3569 6989 7007 7027。 */
  get<T>(key: AppKey<T>): T | null {
    return this.map.has(key as AppKey<never>) ? (this.map.get(key as AppKey<never>) as T) : null;
  }

  /** `app[KEY]` → 缺键抛 KeyError(repr(key))。源里 23 + 2 处的读取语义。 */
  require<T>(key: AppKey<T>): T {
    if (!this.map.has(key as AppKey<never>)) throw new PyKeyError(key.toString());
    return this.map.get(key as AppKey<never>) as T;
  }

  has<T>(key: AppKey<T>): boolean {
    return this.map.has(key as AppKey<never>);
  }

  delete<T>(key: AppKey<T>): boolean {
    return this.map.delete(key as AppKey<never>);
  }

  /** 仅供探针做键身份/数量断言（不参与业务逻辑）。 */
  size(): number {
    return this.map.size;
  }
}

/* ── aiohttp 请求/响应面的类型镜像 ─────────────────────────────────────────
 * 这张表是**穷尽实测**出来的：S1–S10 的 handler 只允许触碰下面列出的成员
 * （源 40–8051 全量 grep 的结果），出现新成员就是新增接缝，必须先补本文件。
 *   request.method / path / headers.get / headers.items / query.get / dict(request.query)
 *   match_info.get / match_info[...] / app[KEY] / app.get(KEY) / can_read_body
 *   await request.json() / await request.read()
 * 源里没有出现过：request.text() / request.post() / request.rel_url（除 .query）
 * / request.remote / request.url / request.content / multipart。
 * ------------------------------------------------------------------------- */

/** `request.headers`（aiohttp 的 CIMultiDict：大小写不敏感）。 */
export interface HeaderView {
  /** `headers.get("Origin", "")` —— 源 8103/8104 用了默认值形式。 */
  get(name: string, fallback?: string): string;
  /** `{k: v for k, v in request.headers.items()}` —— 源 6452。 */
  items(): Array<[string, string]>;
}

/** `request.query` / `request.rel_url.query`（MultiDict，取值一律 str）。 */
export interface QueryView {
  get(name: string, fallback?: string): string;
  /** `dict(request.query)` —— 源 3851（wecom webhook 把整个 query 交给 provider）。 */
  toDict(): JsonDict;
}

/** `request.match_info`（路径变量）。 */
export interface MatchInfo {
  /** `.get("id", "")` —— 源里 60+ 处的默认写法。 */
  get(name: string, fallback?: string): string;
  /** `match_info["platform"]` —— 源 3753/3780/4325/4326/4684 五处**方括号取值**，缺键 KeyError。 */
  index(name: string): string;
}

/** `web.Application` 在 handler 眼里的样子。 */
export interface ServerApp {
  readonly state: AppState;
}

/** 端口统一的响应对象（`web.json_response` / `web.Response` / `web.FileResponse` 三兄弟的公共形状）。 */
export interface WebResponse {
  /** 200/400/403/404/409/413/421/429/500/503 之一——见 w218_SURFACE.md 各行的 status。 */
  status: number;
  /** "json" = web.json_response；"text" = web.Response(text=...)；"file" = web.FileResponse；"websocket" = 升级后的 socket。 */
  kind: "json" | "text" | "file" | "empty" | "websocket";
  /** kind==="json" 时的负载（尚未序列化）。 */
  body?: unknown;
  /** kind==="text" 时的正文（源里都是 str(...) 的直接产物）。 */
  text?: string;
  /** kind==="file" 时的磁盘路径；读文件本身是接缝（S3 负责接线）。 */
  path?: string;
  /** 响应头（cors_middleware 直接写 4 个键，见 util.ts）。 */
  headers: MutableHeaders;
  /** `content_type="text/plain"` / `charset="utf-8"`（源 3857 3864 5400）。 */
  contentType?: string;
  charset?: string;
}

export interface MutableHeaders {
  set(name: string, value: string): void;
  get(name: string, fallback?: string): string;
  items(): Array<[string, string]>;
}

/** 简易响应头实现（aiohttp 的 resp.headers 是可变 CIMultiDict，这里保持同名语义）。 */
export function make_headers(initial?: Array<[string, string]>): MutableHeaders {
  const store = new Map<string, string>();
  const key = (n: string): string => n.toLowerCase();
  for (const [k, v] of initial ?? []) store.set(key(k), v);
  return {
    set(name: string, value: string): void { store.set(key(name), value); },
    get(name: string, fallback?: string): string { return store.has(key(name)) ? (store.get(key(name)) as string) : (fallback ?? ""); },
    items(): Array<[string, string]> { return [...store.entries()]; },
  };
}

/** handler 的统一签名（源里 155 个 handler 全是 `async def x(request)`）。 */
export type HttpHandler = (request: WebRequest) => Promise<WebResponse>;
/** 中间件的统一签名（源 8097 `async def cors_middleware(request, handler)`）。 */
export type HttpMiddleware = (request: WebRequest, handler: HttpHandler) => Promise<WebResponse>;

/** 请求对象：端口只暴露源真正用过的成员。 */
export interface WebRequest {
  /** 大写方法名（源 8114 `request.method == "OPTIONS"`，3853 同）。 */
  method: string;
  /** 含路径变量的**原始**路径（源 7840 `request.path.endswith("/accept")`）。 */
  path: string;
  headers: HeaderView;
  query: QueryView;
  match_info: MatchInfo;
  app: ServerApp;
  /** 源 5811 6999 7019 用它决定"有没有 body"。 */
  can_read_body: boolean;
  /**
   * `await request.json()`。
   * **源内可证的部分**：本文件 9 处用 `except json.JSONDecodeError` 抓它
   * （4533 4734 4769 5930 5981 6111 6309 6427 6627 7879 —— 见 util/NOTES B4），
   * 所以解析失败的异常**必定落在 `json.JSONDecodeError` 的族里**（否则那 9 处兜不住）。
   * **源内不可证的部分（登记为待探针钉住，见 create.ts §C 的 `render_uncaught`）**：
   * aiohttp 各版本在这里抛的具体类不同（`json.JSONDecodeError` 本体，或
   * `JSONDecodeError` + `web.HTTPBadRequest` 的双继承子类），因此"未捕获时最终渲染成
   * 400 还是 500"**不能从源码推出**，也不允许端口自己编。
   * 三种已在源里出现的处理姿势（穷尽）：
   *   - `except json.JSONDecodeError` → handler 自己出 400 "invalid JSON"（9 处）
   *   - `except Exception` → 退化成 `{}`（17 处）
   *   - `if request.can_read_body else {}` → 无 body 直接 `{}`（3 处：5811 6999 7019）
   * **裸调用 10 处**（3279 3332 3665 3702 3737 3781 4314 4370 4420 4475）：异常冒出
   *   handler，handler 自己不产生任何响应 —— 这就是 B4，端口不许偷偷兜成 `{}`。
   */
  json(): Promise<JsonDict>;
  /** `await request.read()` → bytes（源 3808 3827 3859 6451 四处 webhook 原文）。 */
  read(): Promise<Uint8Array>;
}

/** 端口侧 `web.json_response(body, status=200)`。 */
export function json_response(body: unknown, status = 200): WebResponse {
  return { status, kind: "json", body, headers: make_headers() };
}

/** 端口侧 `web.Response(status=..., text=..., content_type=..., charset=...)`。 */
export function text_response(opts: { status?: number; text?: string; contentType?: string; charset?: string; headers?: MutableHeaders }): WebResponse {
  const resp: WebResponse = {
    status: opts.status ?? 200,
    kind: opts.text === undefined ? "empty" : "text",
    headers: opts.headers ?? make_headers(),
  };
  if (opts.text !== undefined) resp.text = opts.text;
  if (opts.contentType !== undefined) resp.contentType = opts.contentType;
  if (opts.charset !== undefined) resp.charset = opts.charset;
  return resp;
}

/** 端口侧 `web.FileResponse(path, headers=...)`（源 3000 3256 8435）。 */
export function file_response(path: string, headers?: MutableHeaders): WebResponse {
  return { status: 200, kind: "file", path, headers: headers ?? make_headers() };
}

/* ── 模块级可变状态（源 4573–4574）──────────────────────────────────────────
 * `_CONFIG` / `_CONFIG_PATH` 是**模块全局**：写点在 run_server（8611–8613，S10），
 * 读点横跨 S6（settings 全族 + _mcp_config_block 6248）、S7（network policy
 * 6602/6648）、S9（evolution mode 7889）与 S10（create_server 8174/8427/8484/8566）。
 * 源把它们放在 4570 行的 Settings 段中间，端口把它们提到这里，**唯一理由**是
 * 10 个段必须看到同一个对象（python 靠模块全局，TS 靠这一个导出）。
 * 行为等价：`_CONFIG` 就地 mutate（源里 20+ 处 `setdefault`），从不整体替换
 * （除 8612 行 run_server 那一次），所以引用共享是忠实建模。
 * ------------------------------------------------------------------------- */

export const SERVER_STATE: { _CONFIG: JsonDict; _CONFIG_PATH: string } = {
  _CONFIG: {},
  _CONFIG_PATH: "",
};

/** 只给探针：整体重置模块状态（python 侧对应重import模块）。 */
export function reset_server_state_for_probe(config?: JsonDict, configPath?: string): void {
  SERVER_STATE._CONFIG = config ?? {};
  SERVER_STATE._CONFIG_PATH = configPath ?? "";
}

// ── 源码自带死路（本文件相关条目）──
// B1 源 36/37：两个 AppKey 的类型实参是 `Router` / `SessionHost`（顶层 import 的
//    真类）。端口降级为类型名字符串，见文件头 DIVERGENCE(port) 第 3 条。
// B4（登记于此，因为它是 json() 面的一部分）：源里 10 处 `await request.json()`
//    **没有任何兜底**（3279 create_goal、3332 update_goal、3665 create_cron、
//    3702 update_cron、3737 bot_send、3781 bot_config_put、4314 candidate_create、
//    4370 import_skill、4420 install_skill、4475 vet_skill）。同一个"可选 body"
//    语义在别处（6383 mcp_toggle、6999/7019 shadow、5811 memory_prune）却写了
//    兜底——两套姿势并存，是源事实，端口**不统一**。证据在
//    tmp/w218_S0_NOTES.md，探针为这 10 处各留一条"坏 JSON → 400 冒出"用例。
//

/* ──────────────────────────────────────────────────────────────────────
 * §M CPython 镜像层（单元 218 的**跨段单一来源**，由主控从 S3 草稿上收）
 *
 * 为什么在这里，而不是各段各写一份：218 有 10 个段，`py_strip` / `ntpath.join` /
 * `urllib.parse.unquote` 这类东西一旦被"顺手重写"，就是**两个真值源**——实测代价：
 *   · S3 第一版（落盘过的那份）`py_strip` 少了 0x1c..0x1f 四个空白码位、
 *     ntpath.join 少了"不同盘符直接丢弃前一段"的 `continue`，42 例金标准里错 4 例；
 *   · S4 草稿的注释自己就登记了这条债（"py_dict_get/py_iter_list/py_getattr* 在 S3 是
 *     文件私有未导出，keys.ts 也没有这一层 ⇒ S4 只能自带一份"）。
 * 本段是**逐字搬运**（只在顶层声明前加 `export`），F1–F14 逐条论证与 CPython 出处
 * 仍在 S3 段落的文件头与 tmp/w218_S3_NOTE.md 里；金标准复测脚本 tmp/lead_s3_ab.mjs。
 * 消费规则：S1–S10 谁要用谁 `import`，**不许**再在段内复制一份。
 * ──────────────────────────────────────────────────────────────────── */

/* ──────────────────────────────────────────────────────────────────────────
 * §0 CPython 异常镜像（message == `str(exc)`，见 §DIVERGENCE 3）
 * ──────────────────────────────────────────────────────────────────────── */

/** 所有本文件异常的共同基类：`message` 存的是 CPython `str(exc)` 的原文（不带类名前缀）。 */
export abstract class PyExcP extends Error {
  /** 可变：`PyPermissionErrorP` 要在子类构造里把 `OSError` 改成 `PermissionError`。 */
  pyName: string;
  constructor(pyName: string, message: string) {
    super(message);
    this.pyName = pyName;
    this.name = pyName;
  }
}

/** `ModuleNotFoundError`：源里各处函数级 import 未接线时的缺省臂（文案 `No module named 'x'`）。 */
export class ModuleNotFoundErrorP extends PyExcP {
  readonly moduleName: string;
  constructor(moduleName: string) {
    super("ModuleNotFoundError", `No module named '${moduleName}'`);
    this.moduleName = moduleName;
  }
}

/** `RuntimeError` —— 源 2894 `except RuntimeError` **只兜这一类**（S3-B1）。 */
export class PyRuntimeErrorP extends PyExcP {
  constructor(message: string) {
    super("RuntimeError", message);
  }
}

/** `AttributeError`：`X.get(...)`（非 dict 的接收者）/ 缺属性 / `X.strip()`（非 str）。 */
export class PyAttributeErrorP extends PyExcP {
  constructor(obj: unknown, attr: string) {
    super("AttributeError", `'${py_type_name(obj)}' object has no attribute '${attr}'`);
  }
}

/** `OSError` 族（源 3189 `except OSError: return None, "not-found"`；子类同样被 `instanceof` 兜住）。 */
export class PyOSErrorP extends PyExcP {
  constructor(message: string) {
    super("OSError", message);
  }
}

/** `PermissionError`（OSError 子类；seam 假件可用它验证 S3 的族捕获）。 */
export class PyPermissionErrorP extends PyOSErrorP {
  constructor(message: string) {
    super(message);
    this.pyName = "PermissionError";
    this.name = "PermissionError";
  }
}

/** `TypeError`：`ntpath.join` 的 `_check_arg_types`、`os.fspath`、迭代非可迭代对象。 */
export class PyTypeErrorP extends PyExcP {
  constructor(message: string) {
    super("TypeError", message);
  }
}

/** `UnicodeEncodeError`：`urllib.parse.quote` 的 `encode('utf-8','strict')`（见 F4）。 */
export class PyUnicodeEncodeErrorP extends PyExcP {
  constructor(message: string) {
    super("UnicodeEncodeError", message);
  }
}

/** `str(exc)` —— 见 §DIVERGENCE 3。 */
export function exc_str(exc: unknown): string {
  if (exc instanceof PyExcP) return exc.message;
  if (exc instanceof Error) return exc.message;
  return py_str(exc);
}

/* ──────────────────────────────────────────────────────────────────────────
 * §1 CPython 语义小工具
 * ──────────────────────────────────────────────────────────────────────── */

/** `x is None`（端口的 None 建模为 `null` 或 `undefined`）。 */
export function py_is_none(v: unknown): boolean {
  return v === null || v === undefined;
}

/** `d.get(key)` / `d.get(key, default)`：接收者非 dict → AttributeError（S3-B4/S3-B5 的执行者）。 */
export function py_dict_get(target: unknown, key: string, dflt: unknown = null): unknown {
  if (target instanceof Map) return target.has(key) ? target.get(key) : dflt;
  if (py_is_none(target) || typeof target !== "object" || Array.isArray(target)) {
    throw new PyAttributeErrorP(target, "get");
  }
  const rec = target as JsonDict;
  return Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : dflt;
}

/** `for p in X` 的迭代面：list/tuple→元素，str→码点，dict→键，int/None→TypeError（F6：文案带真实类型名）。 */
export function py_iter(v: unknown): readonly unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return Array.from(v);
  if (v instanceof Map) return Array.from(v.keys());
  if (v instanceof Set) return Array.from(v);
  if (v instanceof Uint8Array) return Array.from(v);
  if (py_is_none(v) || typeof v !== "object") {
    throw new PyTypeErrorP(`'${py_type_name(v)}' object is not iterable`);
  }
  const it = (v as { __iter__?: () => unknown }).__iter__;
  if (typeof it === "function") {
    const got = it.call(v);
    if (Array.isArray(got)) return got;
    throw new PyTypeErrorP(`'${py_type_name(got)}' object is not iterable`);
  }
  return Object.keys(v as JsonDict);
}

/** `getattr(obj, name)`（**无默认**）：源 2872 `sched.active_count`、2898–2899 `result.ok/.error`、2992 `engine.store`、3005 `path.name`。 */
export function py_getattr(obj: unknown, name: string): unknown {
  if (py_is_none(obj) || (typeof obj !== "object" && typeof obj !== "function")) {
    throw new PyAttributeErrorP(obj, name);
  }
  if (!(name in (obj as object))) throw new PyAttributeErrorP(obj, name);
  return (obj as JsonDict)[name];
}

/** `getattr(obj, name, default)`：源 3226 `getattr(router, "workspace", "")`（**有默认**，与上面不同）。 */
export function py_getattr_or(obj: unknown, name: string, dflt: unknown): unknown {
  if (py_is_none(obj) || (typeof obj !== "object" && typeof obj !== "function")) return dflt;
  if (!(name in (obj as object))) return dflt;
  return (obj as JsonDict)[name];
}

/** `M[k]`（dict 下标）：缺键 KeyError(repr(k))。源 3183 已做成员检查，故 3244 这条在源里不可达，仅为语义完整（F11）。 */
export function py_map_index<M extends { readonly [k: string]: unknown }>(m: M, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(m, key)) throw new PyKeyError(py_repr(key));
  return m[key];
}

/** `x or ""` 之后立刻 `.strip()` 的组合（源 3118 `(raw or "").strip()`）：非 str 走 AttributeError。 */
export function py_strip_or(v: unknown): string {
  const s = py_or(v, "");
  if (typeof s !== "string") throw new PyAttributeErrorP(s, "strip");
  return py_strip(s);
}

/**
 * ntpath 的字符串面入参检查：`os.fspath` + `genericpath._check_arg_types('join', ...)`。
 * 端口只在**源真正把它当路径用**的那一步调用（源 3171 的 `os.path.join(workspace, path)`），
 * 这样非 str/PathLike 的 workspace 才会在**与源相同的位置**抛出**与源相同的文案**（F10）。
 */
export function py_path_str(v: unknown, funcname: string): string {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) {
    // join(bytes, str)：CPython 在 _check_arg_types 末尾拒混装
    throw new PyTypeErrorP("Can't mix strings and bytes in path components");
  }
  if (!py_is_none(v) && (typeof v === "object" || typeof v === "function")) {
    const f = (v as { __fspath__?: () => unknown }).__fspath__;
    if (typeof f === "function") {
      const got = f.call(v);
      if (typeof got === "string") return got;
      return py_path_str(got, funcname);
    }
  }
  throw new PyTypeErrorP(
    `${funcname}() argument must be str, bytes, or os.PathLike object, not '${py_type_name(v)}'`,
  );
}

/** `os.fspath(v)`（FileResponse 内部会做）：失败文案取 `os.fspath` 自己那条 TypeError（D8）。 */
export function py_fspath_str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return py_str(v);
  if (!py_is_none(v) && (typeof v === "object" || typeof v === "function")) {
    const f = (v as { __fspath__?: () => unknown }).__fspath__;
    if (typeof f === "function") return py_fspath_str(f.call(v));
    const p = (v as { path?: unknown }).path;
    if (typeof p === "string") return p;
  }
  throw new PyTypeErrorP(`expected str, bytes or os.PathLike object, not '${py_type_name(v)}'`);
}

/* ──────────────────────────────────────────────────────────────────────────
 * §2 ntpath / urllib.parse 逐字复刻（见 §DIVERGENCE 1、F1–F4）
 * ──────────────────────────────────────────────────────────────────────── */

/** `p.replace(altsep, sep)`（全部 `/`→`\`），对应 splitroot 里的 `normp`。 */
export function norm_seps(p: string): string {
  return p.split("/").join("\\");
}

/** ntpath.splitroot 的 str 分支（3.13 Lib/ntpath.py 逐字）。 */
export function ntp_splitroot(p: string): [string, string, string] {
  const sep = "\\";
  const unc_prefix = "\\\\?\\UNC\\";
  const normp = norm_seps(p);
  if (normp.slice(0, 1) === sep) {
    if (normp.slice(1, 2) === sep) {
      const start = normp.slice(0, 8).toUpperCase() === unc_prefix ? 8 : 2;
      const index = normp.indexOf(sep, start);
      if (index === -1) return [p, "", ""];
      const index2 = normp.indexOf(sep, index + 1);
      if (index2 === -1) return [p, "", ""];
      return [p.slice(0, index2), p.slice(index2, index2 + 1), p.slice(index2 + 1)];
    }
    return ["", p.slice(0, 1), p.slice(1)];
  } else if (normp.slice(1, 2) === ":") {
    if (normp.slice(2, 3) === sep) return [p.slice(0, 2), p.slice(2, 3), p.slice(3)];
    return [p.slice(0, 2), "", p.slice(2)];
  }
  return ["", "", p];
}

/**
 * ntpath.join 的**两段**形态（3.13 Lib/ntpath.py 99–137，逐字含两处 `continue`）。
 * 源里只有三个调用点，全是两段：`join(str(home), "cua_shots")`（3075）、`join(_user_home(), rest)`（3167）、
 * `join(workspace, path)`（3171）。`join(env HOMEDRIVE, HOMEPATH)`（expanduser 内部）也走这里。
 * F1：异盘分支 `continue` → **第一段整个被丢弃**（S3-B14 的成因），不补分隔符、不追加。
 */
export function os_path_join(path: string, p: string): string {
  const sep = "\\";
  const seps = "\\/";
  const colon_seps = ":\\/";
  let [result_drive, result_root, result_path] = ntp_splitroot(path);
  const [p_drive, p_root, p_path] = ntp_splitroot(p);
  if (p_root) {
    // Second path is absolute
    if (p_drive || !result_drive) result_drive = p_drive;
    result_root = p_root;
    result_path = p_path;
  } else if (p_drive && p_drive !== result_drive) {
    if (p_drive.toLowerCase() !== result_drive.toLowerCase()) {
      // Different drives => ignore the first path entirely   ← python 在这里 continue
      result_drive = p_drive;
      result_root = p_root;
      result_path = p_path;
    } else {
      // Same drive in different case                          ← python 落到"相对第一段"分支
      result_drive = p_drive;
      if (result_path.length > 0 && !seps.includes(result_path.charAt(result_path.length - 1))) {
        result_path = result_path + sep;
      }
      result_path = result_path + p_path;
    }
  } else {
    // Second path is relative to the first
    if (result_path.length > 0 && !seps.includes(result_path.charAt(result_path.length - 1))) {
      result_path = result_path + sep;
    }
    result_path = result_path + p_path;
  }
  // add separator between UNC and non-absolute path
  if (
    result_path.length > 0 &&
    result_root === "" &&
    result_drive.length > 0 &&
    !colon_seps.includes(result_drive.charAt(result_drive.length - 1))
  ) {
    return result_drive + sep + result_path;
  }
  return result_drive + result_root + result_path;
}

/** ntpath.isabs（3.13 逐字：只看前 3 字符；`a:foo` 与 `\\server` 都算 False/True 见源）。 */
export function os_path_isabs(s: string): boolean {
  const sep = "\\";
  const altsep = "/";
  const colon_sep = ":\\";
  const double_sep = "\\\\";
  s = s.slice(0, 3).split(altsep).join(sep);
  // s.startswith(colon_sep, 1) or s.startswith(double_sep)
  return s.slice(1).startsWith(colon_sep) || s.startsWith(double_sep);
}

/** genericpath._splitext(p, '\\', '/', '.')（3.13）：含"文件名首字符是点则不算扩展名"的规则。 */
export function os_path_splitext(p: string): [string, string] {
  const sep = "\\";
  const altsep = "/";
  const extsep = ".";
  const sepIndex = Math.max(p.lastIndexOf(sep), p.lastIndexOf(altsep));
  const dotIndex = p.lastIndexOf(extsep);
  if (dotIndex > sepIndex) {
    let filenameIndex = sepIndex + 1;
    while (filenameIndex < dotIndex) {
      if (p.charAt(filenameIndex) !== extsep) {
        return [p.slice(0, dotIndex), p.slice(dotIndex)];
      }
      filenameIndex += 1;
    }
  }
  return [p, ""];
}

/** ntpath.split（3.13）：`d + r + head.rstrip(seps), tail`。 */
export function os_path_split(p: string): [string, string] {
  const seps = "\\/";
  const [d, r, t] = ntp_splitroot(p);
  let i = t.length;
  while (i > 0 && !seps.includes(t.charAt(i - 1))) i--;
  return [d + r + rstrip_chars(t.slice(0, i), seps), t.slice(i)];
}

/** `s.rstrip(chars)`（字符集版）。 */
export function rstrip_chars(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s.charAt(end - 1))) end--;
  return s.slice(0, end);
}

/** ntpath.basename = split(p)[1]（源 3240）。 */
export function os_path_basename(p: string): string {
  return os_path_split(p)[1];
}

/**
 * `str.strip()`（无参）。字符集 = **CPython `str.isspace()` 的 29 码点全集**，
 * 由本机解释器实测枚举（`[hex(c) for c in range(0x110000) if chr(c).isspace()]`）：
 * 0x09 0x0a 0x0b 0x0c 0x0d 0x1c 0x1d 0x1e 0x1f 0x20 0x85 0xa0 0x1680
 * 0x2000..0x200a 0x2028 0x2029 0x202f 0x205f 0x3000。
 * **不含** 0x200b、**不含** 0xfeff（BOM 不裁）。F5：前一版缺 0x1c–0x1f 与 0x2000 段，
 * 而 strip（源 3118）跑在控制门（源 3138）**之前**，裁什么直接决定门的结果。
 */
export const PY_ISSPACE = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

export function py_strip(s: string): string {
  const cps = Array.from(s);
  let a = 0;
  let b = cps.length;
  while (a < b && PY_ISSPACE.has((cps[a] as string).codePointAt(0) as number)) a++;
  while (b > a && PY_ISSPACE.has((cps[b - 1] as string).codePointAt(0) as number)) b--;
  return cps.slice(a, b).join("");
}

/**
 * `str.lower()`：V8 的 `toLowerCase()` 与 CPython 3.13 的 UCD 版本不同，实测出
 * **27 个码点** V8 会折成小写而 CPython 原样返回（V8 认识、CPython 3.13 不认识的
 * 大小写对：U+1C89、U+A7CB/A7CC/A7DA/A7DC、U+10D50-U+10D65）。
 * 差分是全码点的（U+0000..U+10FFFF 逐个比 `chr(c).lower()` 与
 * `String.fromCodePoint(c).toLowerCase()`，本机钉住的解释器 CPython 3.13.14 vs
 * `C:/Program Files/nodejs/node.exe` v22.18.0，即门禁探针实际用的那两个运行时）：
 * 证据在 `tmp/brows_lower_py.json`（CPython 完整 lower 映射，1433 条非恒等）和
 * `tmp/lead_brows_lower_diff.txt`（27 条差分表 + 810 条上下文电池 differing=0）。
 * 上下文电池说明两个运行时的 final-sigma 规则一致，所以这里只需要**保护这 27 个码点**，
 * 不需要建上下文模型：按被保护码点切段、逐段用 V8 的 toLowerCase（保住 sigma 上下文）、
 * 被保护字符原样放回。
 */
export const PY_LOWER_PRESERVE = new Set<number>([
  0x1c89, 0xa7cb, 0xa7cc, 0xa7da, 0xa7dc,
  0x10d50, 0x10d51, 0x10d52, 0x10d53, 0x10d54, 0x10d55, 0x10d56, 0x10d57, 0x10d58,
  0x10d59, 0x10d5a, 0x10d5b, 0x10d5c, 0x10d5d, 0x10d5e, 0x10d5f, 0x10d60, 0x10d61,
  0x10d62, 0x10d63, 0x10d64, 0x10d65,
]);

export function py_lower(s: string): string {
  let out = "";
  let seg = "";
  for (const ch of s) {
    if (PY_LOWER_PRESERVE.has(ch.codePointAt(0) as number)) {
      out += seg.toLowerCase();
      seg = "";
      out += ch;
    } else {
      seg += ch;
    }
  }
  return out + seg.toLowerCase();
}

/** `s.lstrip(chars)`（字符集版）：源 3166 `lstrip("/")`、3182/3239 `lstrip(".")`。 */
export function py_lstrip_chars(s: string, chars: string): string {
  const cps = Array.from(s);
  let i = 0;
  while (i < cps.length && chars.includes(cps[i] as string)) i++;
  return cps.slice(i).join("");
}

/** `any(ord(ch) < 32 for ch in path)`（源 3138）：码点级，非 UTF-16 单元级。 */
export function py_any_control(s: string): boolean {
  for (const ch of Array.from(s)) {
    if ((ch.codePointAt(0) as number) < 32) return true;
  }
  return false;
}

/** `str` 的逐码点映射（源 3242 的 `"".join(genexpr)`）：代理对按一个字符处理。 */
export function py_join_map(s: string, f: (ch: string, cp: number) => string): string {
  let out = "";
  for (const ch of Array.from(s)) out += f(ch, ch.codePointAt(0) as number);
  return out;
}

/** CPython `unquote_to_bytes`（`_unquote_impl`）在**单个 ASCII 段**上的等价实现。 */
export function unquote_bytes_of_run(asciiRun: string): Uint8Array {
  const out: number[] = [];
  let i = 0;
  const bits = asciiRun.split("%");
  // python: res = bytearray(bits[0])；随后对 bits[1:] 逐个试 2 hex
  for (const byte of new TextEncoder().encode(bits[0] as string)) out.push(byte);
  for (let k = 1; k < bits.length; k++) {
    const item = bits[k] as string;
    const hex = item.slice(0, 2);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      out.push(Number.parseInt(hex, 16));
      for (const byte of new TextEncoder().encode(item.slice(2))) out.push(byte);
    } else {
      out.push(0x25);                                      // append(b'%')
      for (const byte of new TextEncoder().encode(item)) out.push(byte);
    }
  }
  return new Uint8Array(out);
}

/**
 * `urllib.parse.unquote(s)`（3.13 `_generate_unquoted_parts` 等价，F3）：
 *   · 串里没有 `%` → **原样返回**（源里连编码解码都不走）；
 *   · 有 `%` → 按 `_asciire = re.compile('([\x00-\x7f]+)')` 切段，
 *     **每个 ASCII 段独立**做 percent 解码 + `decode('utf-8','replace')`，非 ASCII 段原样透传。
 * 关键性质：str 输入**永不抛错**（S3-B17 那条 except 因此不可达），lone surrogate 也原样穿过。
 * `errors='replace'` 与 WHATWG 非 fatal TextDecoder 的等价性已用 12 例畸形字节实测对齐
 * （ff / c3 / c3 28 / e2 82 / e2 82 ac / f0 9f 92 / ed a0 80 / 80 / 41 ff 42 / f5 80 80 80 / c0 80 / e0 80 80）。
 */
export function py_unquote(s: string): string {
  if (!s.includes("%")) return s;
  const re = /[\x00-\x7f]+/g;
  const dec = new TextDecoder("utf-8");                   // 非 fatal == python errors='replace'
  let out = "";
  let prev = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out += s.slice(prev, m.index);                        // 非 ASCII 段：原样
    out += dec.decode(unquote_bytes_of_run(m[0] as string));
    prev = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;                // 防御零长（本模式不会零长）
  }
  out += s.slice(prev);                                   // 非 ASCII 尾段
  return out;
}

/**
 * `urllib.parse.quote(s)`（默认 `safe='/'`，F4）：
 * `s.encode('utf-8','strict')` → 逐字节，`A-Za-z0-9`、`_.-~`（`_ALWAYS_SAFE`）与 safe 里的 `/` 原样，
 * 其余 `'%{:02X}'`。lone surrogate 在 strict 编码阶段抛 UnicodeEncodeError（文案逐字复刻）。
 */
export function py_quote(s: string): string {
  if (s.length === 0) return s;
  const SAFE = new Set<number>([
    ...Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~/").map((c) =>
      c.codePointAt(0) as number,
    ),
  ]);
  const bytes = utf8_encode_strict(s);
  let out = "";
  for (const b of bytes) out += SAFE.has(b) ? String.fromCharCode(b) : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  return out;
}

/** `str.encode('utf-8','strict')`：unpaired surrogate → UnicodeEncodeError（CPython 文案含位置与单/复数形态）。 */
export function utf8_encode_strict(s: string): Uint8Array {
  const bad: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (u >= 0xd800 && u <= 0xdbff) {
      const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (lo >= 0xdc00 && lo <= 0xdfff) { i++; continue; }
      bad.push(i);
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      bad.push(i);
    }
  }
  if (bad.length > 0) {
    // CPython 把**连续**的 unpaired surrogate 并成一个错误区间
    let run_start = bad[0] as number;
    let run_end = run_start;
    for (const p of bad) { if (p === run_end + 1) run_end = p; else break; }
    const n = run_end - run_start + 1;
    if (n === 1) {
      const ch = s.charAt(run_start);
      throw new PyUnicodeEncodeErrorP(
        `'utf-8' codec can't encode character '\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}' in position ${run_start}: surrogates not allowed`,
      );
    }
    throw new PyUnicodeEncodeErrorP(
      `'utf-8' codec can't encode characters in position ${run_start}-${run_end}: surrogates not allowed`,
    );
  }
  return new TextEncoder().encode(s);
}


/**
 * 正则镜像：CPython 的 `\w \d \s \b \B` 与 JS 的**不是同一个集合**，逐字照抄
 * 一定会错。三个实测事实（本机钉住的解释器
 * `C:/Users/ZhuanZ1/AppData/Local/Programs/AutoClaw2/resources/vendor/python/python.exe`
 * = CPython 3.13.15，对照 `C:/Program Files/nodejs/node.exe` = v22.18.0，
 * 也就是门禁探针实际使用的两个运行时）：
 *
 * 1. CPython \w = 138558 码点（749 段）、\d = 680（64 段）、\s = 29（10 段，
 *    与上面的 PY_ISSPACE 全集一致）。全码点差分：JS 的 `[\p{L}\p{N}_]` 比
 *    CPython \w **多** 9039 码点（50 段），`\p{Nd}` 比 \d **多** 90 码点（8 段），
 *    缺失都是 0——V8 打包的 Unicode 版本比 CPython 3.13 新，和 PY_LOWER_PRESERVE
 *    那 27 个码点是同一类版本偏斜。所以属性转义是**严格超集**，不能当镜像用。
 * 2. JS 的 `\w` 不含汉字：`\b` 在 `端口5` 这种"CJK 标签 + 数字"旁边**永远不成立**，
 *    于是 CPython 命中的模式在端口上直接不命中（memory_guard 实测 16 条输入两侧相反）。
 *    反过来 JS 的 `\b` 又在 CPython 不成立的地方成立。两个方向都会错，必须换掉边界。
 * 3. `v` flag 下字符类里裸 `-`（首位或末位）不再表示字面量而是**语法错误**，
 *    Python 的 `[-_]`、`[\w.+-]` 照抄就编译不过——镜像翻译器要顺手把它写成 `\-`。
 *
 * 表示法选紧凑的 v-flag 集合差（`[[\p{L}\p{N}_]--[多出来的 50 段]]`），不选 749 段
 * 全列举：后者每条模式源码会膨胀到 ~96 KB，前者 834 字符。两种写法都做了全码点实测，
 * 与 CPython 集合**完全相等**——证据 `tmp/lead_z_mirror_census.txt`
 * （`tmp/lead_z_mirror_census.mjs` 对 U+0000..U+10FFFF 逐码点比，
 * 正反类都算：`MIRROR_w diff=0 extra=0 missing=0 neg_diff=0`，另 d/s 同；
 * 落单代理对不进去，那一行是 `EXCLUDED_LONE_SURROGATES=2048`）。
 * 代价说清楚：紧凑写法的正确性依赖"V8 这一版比 CPython 新"这个方向。Node 升级后
 * 若 V8 的 UCD 超过 CPython 3.13，减集就不够了——重跑 `tmp/lead_z_pyre_classes.py`
 * （CPython 侧普查，产出 `tmp/lead_z_pyre_classes.json`）和
 * `tmp/lead_z_mirror_census.mjs` 即可重算，接口不变。
 *
 * 差分电池（模式侧的端到端证明，不只是集合相等）：memory_guard 的 11 条 CPython
 * 正则（`tmp/lead_z_regex_patterns.json`，逐字抄自源文件）× 60 条输入
 * （`tmp/lead_z_regex_inputs.json`），两侧 `finditer` 逐行比 (start, end, group)，
 * CPython 侧 `tmp/lead_z_battery_py.json`（660 行，`tmp/lead_z_battery_py.py` 跑的）
 * 对端口侧 `tmp/lead_z_battery_js.json`（`tmp/lead_z_battery_js.mjs` 跑的）=
 * `JSBATTERY facts=660 oracle=660 DIFFS=0 COMPILE_ERR=0`。
 */
export const PY_W_CLASS = "[[\\p{L}\\p{N}_]--[\\u{88f}\\u{c5c}\\u{cdc}\\u{1c89}-\\u{1c8a}\\u{a7cb}-\\u{a7cf}\\u{a7d2}\\u{a7d4}\\u{a7da}-\\u{a7dc}\\u{a7f1}\\u{105c0}-\\u{105f3}\\u{10940}-\\u{10959}\\u{10d40}-\\u{10d65}\\u{10d6f}-\\u{10d85}\\u{10ec2}-\\u{10ec7}\\u{11380}-\\u{11389}\\u{1138b}\\u{1138e}\\u{11390}-\\u{113b5}\\u{113b7}\\u{113d1}\\u{113d3}\\u{116d0}-\\u{116e3}\\u{11bc0}-\\u{11be0}\\u{11bf0}-\\u{11bf9}\\u{11db0}-\\u{11ddb}\\u{11de0}-\\u{11de9}\\u{13460}-\\u{143fa}\\u{16100}-\\u{1611d}\\u{16130}-\\u{16139}\\u{16d40}-\\u{16d6c}\\u{16d70}-\\u{16d79}\\u{16ea0}-\\u{16eb8}\\u{16ebb}-\\u{16ed3}\\u{16ff2}-\\u{16ff6}\\u{187f8}-\\u{187ff}\\u{18cff}\\u{18d09}-\\u{18d1e}\\u{18d80}-\\u{18df2}\\u{1ccf0}-\\u{1ccf9}\\u{1e5d0}-\\u{1e5ed}\\u{1e5f0}-\\u{1e5fa}\\u{1e6c0}-\\u{1e6de}\\u{1e6e0}-\\u{1e6e2}\\u{1e6e4}-\\u{1e6e5}\\u{1e6e7}-\\u{1e6ed}\\u{1e6f0}-\\u{1e6f4}\\u{1e6fe}-\\u{1e6ff}\\u{2b73a}-\\u{2b73f}\\u{2cea2}-\\u{2cead}\\u{323b0}-\\u{33479}]]";
export const PY_D_CLASS = "[[\\p{Nd}]--[\\u{10d40}-\\u{10d49}\\u{116d0}-\\u{116e3}\\u{11bf0}-\\u{11bf9}\\u{11de0}-\\u{11de9}\\u{16130}-\\u{16139}\\u{16d70}-\\u{16d79}\\u{1ccf0}-\\u{1ccf9}\\u{1e5f1}-\\u{1e5fa}]]";
export const PY_S_CLASS = "[\\u{9}-\\u{d}\\u{1c}-\\u{20}\\u{85}\\u{a0}\\u{1680}\\u{2000}-\\u{200a}\\u{2028}-\\u{2029}\\u{202f}\\u{205f}\\u{3000}]";
export const PY_W_NOT_CLASS = "[^" + PY_W_CLASS.slice(1);
export const PY_D_NOT_CLASS = "[^" + PY_D_CLASS.slice(1);
export const PY_S_NOT_CLASS = "[^" + PY_S_CLASS.slice(1);

/** CPython `\b`：词字符边界的等价写法（前后看各一次，两个方向并起来）。 */
export const PY_BOUND = "(?:(?<=[[\\p{L}\\p{N}_]--[\\u{88f}\\u{c5c}\\u{cdc}\\u{1c89}-\\u{1c8a}\\u{a7cb}-\\u{a7cf}\\u{a7d2}\\u{a7d4}\\u{a7da}-\\u{a7dc}\\u{a7f1}\\u{105c0}-\\u{105f3}\\u{10940}-\\u{10959}\\u{10d40}-\\u{10d65}\\u{10d6f}-\\u{10d85}\\u{10ec2}-\\u{10ec7}\\u{11380}-\\u{11389}\\u{1138b}\\u{1138e}\\u{11390}-\\u{113b5}\\u{113b7}\\u{113d1}\\u{113d3}\\u{116d0}-\\u{116e3}\\u{11bc0}-\\u{11be0}\\u{11bf0}-\\u{11bf9}\\u{11db0}-\\u{11ddb}\\u{11de0}-\\u{11de9}\\u{13460}-\\u{143fa}\\u{16100}-\\u{1611d}\\u{16130}-\\u{16139}\\u{16d40}-\\u{16d6c}\\u{16d70}-\\u{16d79}\\u{16ea0}-\\u{16eb8}\\u{16ebb}-\\u{16ed3}\\u{16ff2}-\\u{16ff6}\\u{187f8}-\\u{187ff}\\u{18cff}\\u{18d09}-\\u{18d1e}\\u{18d80}-\\u{18df2}\\u{1ccf0}-\\u{1ccf9}\\u{1e5d0}-\\u{1e5ed}\\u{1e5f0}-\\u{1e5fa}\\u{1e6c0}-\\u{1e6de}\\u{1e6e0}-\\u{1e6e2}\\u{1e6e4}-\\u{1e6e5}\\u{1e6e7}-\\u{1e6ed}\\u{1e6f0}-\\u{1e6f4}\\u{1e6fe}-\\u{1e6ff}\\u{2b73a}-\\u{2b73f}\\u{2cea2}-\\u{2cead}\\u{323b0}-\\u{33479}]])(?![[\\p{L}\\p{N}_]--[\\u{88f}\\u{c5c}\\u{cdc}\\u{1c89}-\\u{1c8a}\\u{a7cb}-\\u{a7cf}\\u{a7d2}\\u{a7d4}\\u{a7da}-\\u{a7dc}\\u{a7f1}\\u{105c0}-\\u{105f3}\\u{10940}-\\u{10959}\\u{10d40}-\\u{10d65}\\u{10d6f}-\\u{10d85}\\u{10ec2}-\\u{10ec7}\\u{11380}-\\u{11389}\\u{1138b}\\u{1138e}\\u{11390}-\\u{113b5}\\u{113b7}\\u{113d1}\\u{113d3}\\u{116d0}-\\u{116e3}\\u{11bc0}-\\u{11be0}\\u{11bf0}-\\u{11bf9}\\u{11db0}-\\u{11ddb}\\u{11de0}-\\u{11de9}\\u{13460}-\\u{143fa}\\u{16100}-\\u{1611d}\\u{16130}-\\u{16139}\\u{16d40}-\\u{16d6c}\\u{16d70}-\\u{16d79}\\u{16ea0}-\\u{16eb8}\\u{16ebb}-\\u{16ed3}\\u{16ff2}-\\u{16ff6}\\u{187f8}-\\u{187ff}\\u{18cff}\\u{18d09}-\\u{18d1e}\\u{18d80}-\\u{18df2}\\u{1ccf0}-\\u{1ccf9}\\u{1e5d0}-\\u{1e5ed}\\u{1e5f0}-\\u{1e5fa}\\u{1e6c0}-\\u{1e6de}\\u{1e6e0}-\\u{1e6e2}\\u{1e6e4}-\\u{1e6e5}\\u{1e6e7}-\\u{1e6ed}\\u{1e6f0}-\\u{1e6f4}\\u{1e6fe}-\\u{1e6ff}\\u{2b73a}-\\u{2b73f}\\u{2cea2}-\\u{2cead}\\u{323b0}-\\u{33479}]])|(?<![[\\p{L}\\p{N}_]--[\\u{88f}\\u{c5c}\\u{cdc}\\u{1c89}-\\u{1c8a}\\u{a7cb}-\\u{a7cf}\\u{a7d2}\\u{a7d4}\\u{a7da}-\\u{a7dc}\\u{a7f1}\\u{105c0}-\\u{105f3}\\u{10940}-\\u{10959}\\u{10d40}-\\u{10d65}\\u{10d6f}-\\u{10d85}\\u{10ec2}-\\u{10ec7}\\u{11380}-\\u{11389}\\u{1138b}\\u{1138e}\\u{11390}-\\u{113b5}\\u{113b7}\\u{113d1}\\u{113d3}\\u{116d0}-\\u{116e3}\\u{11bc0}-\\u{11be0}\\u{11bf0}-\\u{11bf9}\\u{11db0}-\\u{11ddb}\\u{11de0}-\\u{11de9}\\u{13460}-\\u{143fa}\\u{16100}-\\u{1611d}\\u{16130}-\\u{16139}\\u{16d40}-\\u{16d6c}\\u{16d70}-\\u{16d79}\\u{16ea0}-\\u{16eb8}\\u{16ebb}-\\u{16ed3}\\u{16ff2}-\\u{16ff6}\\u{187f8}-\\u{187ff}\\u{18cff}\\u{18d09}-\\u{18d1e}\\u{18d80}-\\u{18df2}\\u{1ccf0}-\\u{1ccf9}\\u{1e5d0}-\\u{1e5ed}\\u{1e5f0}-\\u{1e5fa}\\u{1e6c0}-\\u{1e6de}\\u{1e6e0}-\\u{1e6e2}\\u{1e6e4}-\\u{1e6e5}\\u{1e6e7}-\\u{1e6ed}\\u{1e6f0}-\\u{1e6f4}\\u{1e6fe}-\\u{1e6ff}\\u{2b73a}-\\u{2b73f}\\u{2cea2}-\\u{2cead}\\u{323b0}-\\u{33479}]])(?=[[\\p{L}\\p{N}_]--[\\u{88f}\\u{c5c}\\u{cdc}\\u{1c89}-\\u{1c8a}\\u{a7cb}-\\u{a7cf}\\u{a7d2}\\u{a7d4}\\u{a7da}-\\u{a7dc}\\u{a7f1}\\u{105c0}-\\u{105f3}\\u{10940}-\\u{10959}\\u{10d40}-\\u{10d65}\\u{10d6f}-\\u{10d85}\\u{10ec2}-\\u{10ec7}\\u{11380}-\\u{11389}\\u{1138b}\\u{1138e}\\u{11390}-\\u{113b5}\\u{113b7}\\u{113d1}\\u{113d3}\\u{116d0}-\\u{116e3}\\u{11bc0}-\\u{11be0}\\u{11bf0}-\\u{11bf9}\\u{11db0}-\\u{11ddb}\\u{11de0}-\\u{11de9}\\u{13460}-\\u{143fa}\\u{16100}-\\u{1611d}\\u{16130}-\\u{16139}\\u{16d40}-\\u{16d6c}\\u{16d70}-\\u{16d79}\\u{16ea0}-\\u{16eb8}\\u{16ebb}-\\u{16ed3}\\u{16ff2}-\\u{16ff6}\\u{187f8}-\\u{187ff}\\u{18cff}\\u{18d09}-\\u{18d1e}\\u{18d80}-\\u{18df2}\\u{1ccf0}-\\u{1ccf9}\\u{1e5d0}-\\u{1e5ed}\\u{1e5f0}-\\u{1e5fa}\\u{1e6c0}-\\u{1e6de}\\u{1e6e0}-\\u{1e6e2}\\u{1e6e4}-\\u{1e6e5}\\u{1e6e7}-\\u{1e6ed}\\u{1e6f0}-\\u{1e6f4}\\u{1e6fe}-\\u{1e6ff}\\u{2b73a}-\\u{2b73f}\\u{2cea2}-\\u{2cead}\\u{323b0}-\\u{33479}]]))";
/** CPython `\B`：`\b` 的补。 */
export const PY_NON_BOUND = "(?:(?<=[[\\p{L}\\p{N}_]--[\\u{88f}\\u{c5c}\\u{cdc}\\u{1c89}-\\u{1c8a}\\u{a7cb}-\\u{a7cf}\\u{a7d2}\\u{a7d4}\\u{a7da}-\\u{a7dc}\\u{a7f1}\\u{105c0}-\\u{105f3}\\u{10940}-\\u{10959}\\u{10d40}-\\u{10d65}\\u{10d6f}-\\u{10d85}\\u{10ec2}-\\u{10ec7}\\u{11380}-\\u{11389}\\u{1138b}\\u{1138e}\\u{11390}-\\u{113b5}\\u{113b7}\\u{113d1}\\u{113d3}\\u{116d0}-\\u{116e3}\\u{11bc0}-\\u{11be0}\\u{11bf0}-\\u{11bf9}\\u{11db0}-\\u{11ddb}\\u{11de0}-\\u{11de9}\\u{13460}-\\u{143fa}\\u{16100}-\\u{1611d}\\u{16130}-\\u{16139}\\u{16d40}-\\u{16d6c}\\u{16d70}-\\u{16d79}\\u{16ea0}-\\u{16eb8}\\u{16ebb}-\\u{16ed3}\\u{16ff2}-\\u{16ff6}\\u{187f8}-\\u{187ff}\\u{18cff}\\u{18d09}-\\u{18d1e}\\u{18d80}-\\u{18df2}\\u{1ccf0}-\\u{1ccf9}\\u{1e5d0}-\\u{1e5ed}\\u{1e5f0}-\\u{1e5fa}\\u{1e6c0}-\\u{1e6de}\\u{1e6e0}-\\u{1e6e2}\\u{1e6e4}-\\u{1e6e5}\\u{1e6e7}-\\u{1e6ed}\\u{1e6f0}-\\u{1e6f4}\\u{1e6fe}-\\u{1e6ff}\\u{2b73a}-\\u{2b73f}\\u{2cea2}-\\u{2cead}\\u{323b0}-\\u{33479}]])(?=[[\\p{L}\\p{N}_]--[\\u{88f}\\u{c5c}\\u{cdc}\\u{1c89}-\\u{1c8a}\\u{a7cb}-\\u{a7cf}\\u{a7d2}\\u{a7d4}\\u{a7da}-\\u{a7dc}\\u{a7f1}\\u{105c0}-\\u{105f3}\\u{10940}-\\u{10959}\\u{10d40}-\\u{10d65}\\u{10d6f}-\\u{10d85}\\u{10ec2}-\\u{10ec7}\\u{11380}-\\u{11389}\\u{1138b}\\u{1138e}\\u{11390}-\\u{113b5}\\u{113b7}\\u{113d1}\\u{113d3}\\u{116d0}-\\u{116e3}\\u{11bc0}-\\u{11be0}\\u{11bf0}-\\u{11bf9}\\u{11db0}-\\u{11ddb}\\u{11de0}-\\u{11de9}\\u{13460}-\\u{143fa}\\u{16100}-\\u{1611d}\\u{16130}-\\u{16139}\\u{16d40}-\\u{16d6c}\\u{16d70}-\\u{16d79}\\u{16ea0}-\\u{16eb8}\\u{16ebb}-\\u{16ed3}\\u{16ff2}-\\u{16ff6}\\u{187f8}-\\u{187ff}\\u{18cff}\\u{18d09}-\\u{18d1e}\\u{18d80}-\\u{18df2}\\u{1ccf0}-\\u{1ccf9}\\u{1e5d0}-\\u{1e5ed}\\u{1e5f0}-\\u{1e5fa}\\u{1e6c0}-\\u{1e6de}\\u{1e6e0}-\\u{1e6e2}\\u{1e6e4}-\\u{1e6e5}\\u{1e6e7}-\\u{1e6ed}\\u{1e6f0}-\\u{1e6f4}\\u{1e6fe}-\\u{1e6ff}\\u{2b73a}-\\u{2b73f}\\u{2cea2}-\\u{2cead}\\u{323b0}-\\u{33479}]])|(?<![[\\p{L}\\p{N}_]--[\\u{88f}\\u{c5c}\\u{cdc}\\u{1c89}-\\u{1c8a}\\u{a7cb}-\\u{a7cf}\\u{a7d2}\\u{a7d4}\\u{a7da}-\\u{a7dc}\\u{a7f1}\\u{105c0}-\\u{105f3}\\u{10940}-\\u{10959}\\u{10d40}-\\u{10d65}\\u{10d6f}-\\u{10d85}\\u{10ec2}-\\u{10ec7}\\u{11380}-\\u{11389}\\u{1138b}\\u{1138e}\\u{11390}-\\u{113b5}\\u{113b7}\\u{113d1}\\u{113d3}\\u{116d0}-\\u{116e3}\\u{11bc0}-\\u{11be0}\\u{11bf0}-\\u{11bf9}\\u{11db0}-\\u{11ddb}\\u{11de0}-\\u{11de9}\\u{13460}-\\u{143fa}\\u{16100}-\\u{1611d}\\u{16130}-\\u{16139}\\u{16d40}-\\u{16d6c}\\u{16d70}-\\u{16d79}\\u{16ea0}-\\u{16eb8}\\u{16ebb}-\\u{16ed3}\\u{16ff2}-\\u{16ff6}\\u{187f8}-\\u{187ff}\\u{18cff}\\u{18d09}-\\u{18d1e}\\u{18d80}-\\u{18df2}\\u{1ccf0}-\\u{1ccf9}\\u{1e5d0}-\\u{1e5ed}\\u{1e5f0}-\\u{1e5fa}\\u{1e6c0}-\\u{1e6de}\\u{1e6e0}-\\u{1e6e2}\\u{1e6e4}-\\u{1e6e5}\\u{1e6e7}-\\u{1e6ed}\\u{1e6f0}-\\u{1e6f4}\\u{1e6fe}-\\u{1e6ff}\\u{2b73a}-\\u{2b73f}\\u{2cea2}-\\u{2cead}\\u{323b0}-\\u{33479}]])(?![[\\p{L}\\p{N}_]--[\\u{88f}\\u{c5c}\\u{cdc}\\u{1c89}-\\u{1c8a}\\u{a7cb}-\\u{a7cf}\\u{a7d2}\\u{a7d4}\\u{a7da}-\\u{a7dc}\\u{a7f1}\\u{105c0}-\\u{105f3}\\u{10940}-\\u{10959}\\u{10d40}-\\u{10d65}\\u{10d6f}-\\u{10d85}\\u{10ec2}-\\u{10ec7}\\u{11380}-\\u{11389}\\u{1138b}\\u{1138e}\\u{11390}-\\u{113b5}\\u{113b7}\\u{113d1}\\u{113d3}\\u{116d0}-\\u{116e3}\\u{11bc0}-\\u{11be0}\\u{11bf0}-\\u{11bf9}\\u{11db0}-\\u{11ddb}\\u{11de0}-\\u{11de9}\\u{13460}-\\u{143fa}\\u{16100}-\\u{1611d}\\u{16130}-\\u{16139}\\u{16d40}-\\u{16d6c}\\u{16d70}-\\u{16d79}\\u{16ea0}-\\u{16eb8}\\u{16ebb}-\\u{16ed3}\\u{16ff2}-\\u{16ff6}\\u{187f8}-\\u{187ff}\\u{18cff}\\u{18d09}-\\u{18d1e}\\u{18d80}-\\u{18df2}\\u{1ccf0}-\\u{1ccf9}\\u{1e5d0}-\\u{1e5ed}\\u{1e5f0}-\\u{1e5fa}\\u{1e6c0}-\\u{1e6de}\\u{1e6e0}-\\u{1e6e2}\\u{1e6e4}-\\u{1e6e5}\\u{1e6e7}-\\u{1e6ed}\\u{1e6f0}-\\u{1e6f4}\\u{1e6fe}-\\u{1e6ff}\\u{2b73a}-\\u{2b73f}\\u{2cea2}-\\u{2cead}\\u{323b0}-\\u{33479}]]))";

const PY_REGEX_CLASSES: Record<string, string> = {
  w: PY_W_CLASS, W: PY_W_NOT_CLASS, d: PY_D_CLASS, D: PY_D_NOT_CLASS, s: PY_S_CLASS, S: PY_S_NOT_CLASS,
};

/**
 * 把一条 CPython 正则源码**逐字**翻译成 `v` flag 的 JS 源码：只动字符类、
 * 转义类和边界，其他字节原样拷过去（所以 `app/engine` 里看到的模式文本仍然和
 * Python 那一行可以逐字对照）。类内的 `\w\d\s` 换成镜像类、`\b` 换成退格
 * （Python 在类内就是这个意思）、裸的字面量 `-` 写成 `\-`、裸的 `[` 写成 `\[`；
 * 类外的 `\w\d\s\b\B` 换成镜像类/边界。range 的判定跟 Python 一样：只有
 * "前一个原子是单字符且后一个字符不是 `]`" 时 `-` 才是 range 运算符。
 */
export function py_regex_source(pattern: string): string {
  let out = "";
  let inClass = false;
  let pending = false;
  let prevSingle = false;
  let rangeEnd = false;
  let i = 0;
  const mark = (s: boolean): void => {
    if (rangeEnd) { rangeEnd = false; prevSingle = false; return; }
    prevSingle = s;
  };
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === "\\") {
      const n = pattern[i + 1];
      if (n === undefined) { out += "\\"; break; }
      if ("wWdDsS".includes(n)) { out += PY_REGEX_CLASSES[n] as string; i += 2; pending = false; mark(false); continue; }
      if (n === "b") {
        if (inClass) { out += "\\u{8}"; i += 2; pending = false; mark(true); continue; }
        out += PY_BOUND; i += 2; mark(false); continue;
      }
      if (n === "B" && !inClass) { out += PY_NON_BOUND; i += 2; mark(false); continue; }
      if (n === "p" || n === "P" || n === "u") {
        let j = i + 2;
        if (pattern[j] === "{") { const k = pattern.indexOf("}", j); j = k < 0 ? pattern.length : k + 1; }
        else if (n === "u") j = Math.min(pattern.length, i + 6);
        out += pattern.slice(i, j); i = j; pending = false; mark(n !== "p" && n !== "P"); continue;
      }
      if (n === "x") { const j = Math.min(pattern.length, i + 4); out += pattern.slice(i, j); i = j; pending = false; mark(true); continue; }
      out += "\\" + n; i += 2; pending = false; mark(!/[a-zA-Z]/.test(n)); continue;
    }
    if (!inClass) {
      if (c === "[") { inClass = true; pending = true; prevSingle = false; out += "["; i++; continue; }
      out += c; i++; pending = false; mark(false); continue;
    }
    if (c === "]" && pending) { out += "\\]"; i++; pending = false; mark(true); continue; }
    if (c === "]") { inClass = false; prevSingle = false; out += "]"; i++; continue; }
    if (c === "^" && pending) { out += "^"; i++; continue; }
    if (c === "[") { out += "\\["; i++; mark(true); continue; }
    if (c === "-") {
      const next = pattern[i + 1];
      if (prevSingle && next !== undefined && next !== "]") { out += "-"; i++; rangeEnd = true; continue; }
      out += "\\-"; i++; mark(true); continue;
    }
    out += c; i++; pending = false; mark(true);
  }
  return out;
}

/** Python 的 flags → JS 的 flags：`u` 丢掉（`v` 已含），补 `v`。 */
export function py_regex_flags(flags = ""): string {
  const f = flags.replace(/u/g, "");
  return f.includes("v") ? f : f + "v";
}

/** 用 CPython 的正则源码建一条**语义等价**的 JS RegExp。 */
export function py_regex(pattern: string, flags = ""): RegExp {
  return new RegExp(py_regex_source(pattern), py_regex_flags(flags));
}

// PORT STATUS: 本文件无 TODO(port)。