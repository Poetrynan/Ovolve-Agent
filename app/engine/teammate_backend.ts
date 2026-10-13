/**
 * teammate_backend.ts — 源：app/backend/teammate_backend.py
 * （1027 物理行 / 约 513 有效行：源码是"每语句后空一行"的双行距排版）。
 * 单元 211 / wave-9，manifest.tsv target=SPLIT，scc=3 环（212 worker_prewarm_pool、213 worker_sidecar）。
 *
 * F5 队友执行后端：inprocess / subprocess 模式判定（resolve_exec_mode）+ 子进程 worker 的
 * 拉起（spawn_worker）、stdout JSON 行读取与心跳失联判定（read_worker_until_result）、
 * 以及持有子进程句柄的 SubprocessBackend（run / kill / is_alive / any_alive_for_parent）。
 *
 * ── 源码自带的死路 / 缺陷：逐字复制、只标注不修（RULEBOOK §2 BUG 规则）──
 *
 * B1 team-force 整块塌陷（源 237-265）：`if team_force is True:` 里先算出
 *    `persona_raw`（239）与 `env_raw`（241），随后 4 条 `return SubagentExecMode.SUBPROCESS`
 *    （245 / 249 / 253 / 261）与块末那条**无条件** return（265）返回的是**同一个值**。
 *    也就是说这一块对结果毫无影响：team_force 为真时函数**只能**给 SUBPROCESS。
 *    尤其 255-261 那条 `parent_ctx["subprocess_swarm"]` 判定是**空转**（真假的末态一样）。
 *    端口原样写完这些分支，探针用 `mode` 账本钉死"块内任何输入都不改变返回值"。
 *
 * B2 循环里 task_raw 的 inprocess 臂是死臂（源 275-291 + 225-227）：
 *    `task_raw in ("inprocess","in-process","in_process")` 在 225 就已经返回过了，
 *    所以 289-291 那条判定对**第一个** tuple 元素（task_raw）永远不可能命中，
 *    只有 persona / env 两个 raw 能让它命中。逐字保留。
 *
 * B3 `if handle.result:`（源 717）是**死分支**：`handle.result` 全模块只有一处赋值
 *    （675 `handle.result = msg`），而那一处紧接着就是 677 的 `return msg`，
 *    所以走到 717 时它必然是初值 None。端口原样保留这个"永远读不到"的兜底。
 *
 * B4 `SubprocessHandle.log_fh`（源 159）永远是 None：唯一的构造点显式传 `log_fh=None`（559），
 *    全模块也没有任何读取；`reader_task`（151）在全仓只出现在声明处（grep 见 w211 报告），
 *    即两个字段都是死字段。端口的 dataclass 镜像照抄，探针按字段表记账。
 *
 * B5 `WORKER_HEARTBEAT_INTERVAL_S = 5.0`（源 49）是**死常量**：
 *    `grep -rn WORKER_HEARTBEAT_INTERVAL_S app/backend` 只命中定义行本身（1 处），
 *    真正参与判定的是 `WORKER_HEARTBEAT_LOST_S`（591 / 619 / 699）。端口照样导出。
 *
 * B6 生产不可达的防御臂（源 487-497、499-509）：`stdin=PIPE, stdout=PIPE` 之下
 *    `proc.stdin is None or proc.stdout is None` 与 `proc.pid is None` 在真 asyncio 里
 *    都不可能成立，但它们是**行为**（抛 RuntimeError 的哪句话、日志/关句柄的先后）。
 *    探针用假 proc 两条都驱动（缺失 pipe / pid 为 None）。
 *
 * B7 尾部字节静默丢弃（源 583 / 647-677）：`buf` 只在遇到 b"\n" 时才切行，
 *    循环结束后**残留的最后一行**（worker 忘记写换行的 result 行）从不解析，
 *    又因为 B3 也救不回来，最终落到 727 的 `worker exited without result (code=%s)`。
 *
 * B8 `spec.leader_endpoint = spec.parent_session_id`（源 829-831）**原地改写调用方传进来的 spec**；
 *    写进去的值恰好就是 spec_to_worker_json（419）本来就会兜底的值，
 *    所以对 payload 是惰性的、只对调用方可见。端口原样改对象字段。
 *
 * B9 预热会话泄漏（源 837-893 + 955-971）：`except Exception`（889）把
 *    `pool_session` 复位成 None，于是"`acquire()` 成功、`run_turn()` 抛"的那条路上
 *    外层 finally 的 release 臂（`if pool_session is not None`，956）**永远进不去**——
 *    借来的预热 worker 不会被归还。端口逐字保留该复位与门控。
 *
 * B10 `kill_process` 的 `grace_s`（源 371，默认 `_KILL_GRACE_S` 47 行的 5.0）在本模块
 *    5 处调用（603 / 683 / 711 / 943 / 987）**全部省略**，所以 5.0 是唯一可能出现的值；
 *    参数是活的、但生产上永远取默认。探针把 5 处调用都记账，钉住 `grace_s=5.0`。
 *
 * B11 `class TeammateBackend(Protocol)`（源 165-185）运行期惰性：没有任何地方把它当基类，
 *    而且 `SubprocessBackend.run` 的真实签名（775-787，`log_path` 与 `timeout_s` 都是**必填**
 *    关键字）与协议里声明的 `async def run(self, spec)`（177）**不兼容**；
 *    `is_available`（751-753）恒返回 True。端口用 interface 镜像协议（纯文档），
 *    并原样保留那个不兼容与常量 True。
 *
 * ── 接缝（RULEBOOK §2 红线 5：探针把每一处外部触碰换成记录型假件）──
 *   now                     time.time()（581 / 599 / 601 / 631 / 669 / 681 / 153 的 default_factory）
 *   env_get                 os.environ.get(...)，调用期（241 / 281 / 799）
 *   env_items               dict(os.environ)（327）
 *   module_dir              os.path.dirname(os.path.abspath(__file__))（43，**import 期**）
 *   backend_dir             读模块全局 _BACKEND_DIR（329）；探针两侧都钉成同一字面量
 *   pathsep                 os.pathsep（333/335 的 rstrip 字符）
 *   sys_executable          sys.executable（453）
 *   log_debug / log_warning logging.getLogger(__name__) 的 515 / 823 / 891 三处调用
 *   mkdirs                  Path.mkdir(parents=True, exist_ok=True)（317，真文件系统）
 *   open_append             open(log_path, "a", encoding="utf-8")（445）+ 它的 close()
 *   create_subprocess_exec  asyncio.create_subprocess_exec（451-471，真子进程/stdin/stdout）
 *   wait_for                asyncio.wait_for（627 / 939）
 *   PIPE                    asyncio.subprocess.PIPE 哨兵（461/463）
 *   teamCollabModule        源 231 的函数级 `from team_collab import ...`（**已落地兄弟 210**，
 *                           但 python 的 import 在同步函数里，TS 只能静态装载 + 接缝间接化）
 *   permissionBridgeModule  源 809 的函数级 `from permission_bridge import LeaderBridgeHost`（207，同上）
 *   subprocessIsolationModule 源 353/363/373/437/479/493/505/517/947/991 的函数级 import：
 *                           该模块在 manifest 里是 **Native→Rust（单元 209）**，TS 侧没有同名文件，
 *                           缺省臂与 subagent_runtime.ts / permission_bridge.ts / worker_prewarm_pool.ts
 *                           的 mailbox 臂一字一致：抛 ModuleNotFoundErrorP。
 *   workerPrewarmPoolModule 源 839/959：**环内 sibling（211↔212↔213，scc=3）**，
 *                           按环规则**绝不静态 import**；接缝是注入式（bind_worker_prewarm_pool_module），
 *                           未绑定时的缺省臂抛 ModuleNotFoundErrorP，从而落进源里那条
 *                           `except Exception -> prewarm miss -> 冷启动 spawn` 活路。
 * 没有真的 SQLite、subprocess、端口、HTTP、stdin/stdout、文件系统。
 *
 * ── 本文件的确定性折叠（探针两侧同规则）──
 *   1. 时钟   : now() 由接缝提供，探针钉成"每次调用 +1"的整数计数器；调用次数/顺序本身就是账本。
 *   2. 环境变量: env_get / env_items 两侧同为假表；`_BACKEND_DIR` / `sys.executable` / `pathsep`
 *               两侧钉成同一字面量。
 *   3. 枚举   : `SubagentExecMode` 成员记 `(name, value)` 两元组；`asyncio.subprocess.PIPE`
 *               记成 token "PIPE"，缺失记 "None"。
 *   4. dataclass: python 的 positional-or-keyword `__init__` 在 TS 侧是**同名对象**（见 DIVERGENCE），
 *               `field(default_factory=list/dict)` 每实例新建、`default_factory=time.time` 每实例读时钟。
 *   5. bytes  : `b""` 拼接 / `in` / `split(b"\n",1)` / `.strip()` / `.decode("utf-8")` 用
 *               Uint8Array + 本文件的 pyBytes* 助手逐字实现；`payload.encode("utf-8")` 的字节数入账本。
 *   6. 日志   : `log.warning(fmt, pid)` / `log.debug(fmt, exc)` 的 `%` 渲染归宿主 logger，
 *               接缝只收 (level, fmt, args) 三段，不预渲染（与 permission_bridge.ts / moa.ts 同规则）。
 *   7. 数值   : CPython 的 int/float typing（5 与 5.0）在比较器里用 __i__/__f__ 标签折叠；
 *               端口侧 `timeout_s`/`grace_s`/`pid`/`subagent_depth`/`max_turns` 的标签由探针固定。
 *   8. 关键字 : `kill_process_tree(pid, job=, grace_s=)`、`release(session, healthy=)`、
 *               `run_turn(spec, timeout_s=)`、`LeaderBridgeHost(parent, auto_approve=)` 一律走
 *               尾随 options 对象，假件按 kwargs 记账。
 *
 * DIVERGENCE(port): python `async def` 协程体在第一次真正挂起之前与调用者同步执行；
 *   JS async 函数同样同步跑到第一个 await，所以本文件的账本顺序两侧一致。
 *   残余：同步前缀里的抛掷在 JS 侧是 rejected promise（多一个 microtask）。
 *   `resolve_exec_mode` 是**同步**函数，所以它对 team_collab 的函数级 import 必须静态落地
 *   （不能 await）；这与 permission_bridge.ts / team_collab.ts 对 storage 的处理同规则。
 * DIVERGENCE(port): dataclass 的 `__init__` 允许 positional-or-keyword，端口只收**同名对象**；
 *   两侧的缺参/多参 TypeError 文案（`__init__() missing 1 required positional argument: 'x'` /
 *   `__init__() got an unexpected keyword argument 'x'`）由 `dcInit` 逐字复现，
 *   多缺参时的 CPython 列举法（'a' and 'b' / 'a', 'b' and 'c'）一并复现。
 * DIVERGENCE(port): `f"{X:.0f}"` 用 `pyFmtFixed0` 复现 CPython 的 round-half-even
 *   （2.5 -> "2"、3.5 -> "4"、-2.5 -> "-2"），JS 的 toFixed 是 half-away-from-zero，不能直接用。
 * DIVERGENCE(port): `str(SubagentExecMode.INPROCESS)` 在 python 是
 *   "<SubagentExecMode.INPROCESS>"（mixin Enum 的 __str__），端口的 toString 同文；
 *   `(str, Enum)` 成员与字符串 `==` 的性质本模块无任何调用点依赖（grep：成员只在
 *   resolve_exec_mode 的 return 里出现，从不参与比较或 json.dumps），故不模拟。
 * DIVERGENCE(port): `**_popen_kwargs()` 的键位合并 —— 真子进程的关键字里出现与显式关键字
 *   同名的键时，CPython 的 CALL_FUNCTION_EX/DICT_MERGE 抛
 *   `asyncio.subprocess.create_subprocess_exec() got multiple values for keyword argument 'k'`
 *   （3.13 实测文案用「模块.__qualname__」前缀：py 探针把假件放进 `__main__` 时打出的是
 *   `__main__.create_subprocess_exec() ...`；真函数定义于 Lib/asyncio/subprocess.py:218，
 *   故生产文案前缀为 `asyncio.subprocess.`）；
 *   端口用 `dictMergeKw` 按显式顺序检测**第一个**冲突键后抛同一句。
 * DIVERGENCE(port): Native→Rust 的 subprocess_isolation 与未静态绑定的 worker_prewarm_pool，
 *   缺省臂都是 ModuleNotFoundErrorP。前者与仓内既有端口语义一致（真实现位于 Rust 层）；
 *   后者是环规则的代价：**未绑定 == 预热不命中 == 冷启动 spawn**（功能等价、只是不省时间），
 *   两侧探针对此各有假件驱动"命中/不命中/抛异常"三条臂，故不构成功能缺失。
 * DIVERGENCE(port): `Path(workspace_root or ".")` 的分隔符归一（Windows 下 `str()` 出反斜杠、
 *   去掉 "." 段与重复分隔符、保留 ".."、绝对路径重置）由 `pyPathStr`/`pyPathJoin` 复现；
 *   端口跑在 win32，与源同平台，故两侧 `str()` 结果逐字相同。
 */

import * as nodeChildProcess from "node:child_process";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import * as nodeUrl from "node:url";
import { SUBAGENT_ERRORS } from "./subagent_runtime.js";
import * as _team_collab_ns from "./team_collab.js";
import * as _permission_bridge_ns from "./permission_bridge.js";

type JsonDict = Record<string, unknown>;
type AnyMod = Record<string, any>;

/* ── CPython 语义小工具（本仓惯例：每个文件自带一份） ─────────────────────── */

/** python `bool(x)` / `if x` / `x or y`。 */
function pyTruth(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
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
    return Object.keys(v as JsonDict).length > 0;   // 已解码的 JSON dict：空则假
  }
  if (typeof v === "function") return true;
  return Boolean(v);
}

/** `a or b`：只在 a 为假时才算 b。 */
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
  if (v instanceof Uint8Array) return "bytes";
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

/** python `repr()`（只覆盖 json 值域 + 端口的异常镜像 + bytes）。 */
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
  if (v instanceof Uint8Array) return bytesRepr(v);
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

/** python `str(x)`。f-string 插布尔/None 走这里（渲染 `True`/`False`/`None`）。 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  return pyRepr(v);
}

/** `str.strip()` 的 python 语义（默认去掉全部空白类字符）。 */
function pyStrip(s: string): string { return s.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, ""); }

/** `str.rstrip(chars)`：只去尾部给定字符集。 */
function pyRstripChars(s: string, chars: string): string {
  if (chars === "") return s;
  let end = s.length;
  while (end > 0 && chars.includes(s.slice(end - 1, end))) end -= 1;
  return s.slice(0, end);
}

/** python `float(x)`：接受 inf/nan/下划线，非法输入抛 ValueError/TypeError（文案逐字）。 */
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

/** python `int(x)`：截断向零；非数值抛 TypeError（文案逐字）。 */
function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string") {
    const t = pyStrip(v).replace(/_/g, "");
    if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
    throw new ValueErrorP(`invalid literal for int() with base 10: ${pyRepr(v)}`);
  }
  throw new TypeErrorP(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

/** python `now + x`（`deadline = time.time() + timeout_s`）：非数值是 TypeError，不是隐式转。
 *  左操作数的类型名按值报（探针的整数计数钟让 CPython 实测 `'int' and 'str'`；
 *  JS 无法区分 1 与 1.0，pyTypeName 把整值映射为 int，与两侧假钟一字一致）。 */
function pyFloatPlus(a: number, b: unknown): number {
  if (typeof b === "number") return a + b;
  if (typeof b === "boolean") return a + (b ? 1 : 0);
  throw new TypeErrorP(`unsupported operand type(s) for +: '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** python `now - float(idle_since)` 之类的减法：两侧都必须是数，否则 TypeError（文案逐字）。 */
function pyFloatMinus(a: number, b: unknown): number {
  if (typeof b === "number") return a - b;
  if (typeof b === "boolean") return a - (b ? 1 : 0);
  throw new TypeErrorP(`unsupported operand type(s) for -: '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** python `f"{x:.0f}"`：round-half-even（JS 的 toFixed 是 half-away，不能直接用）。 */
function pyFmtFixed0(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const fl = Math.floor(x);
  const diff = x - fl;
  let n: number;
  if (diff > 0.5) n = fl + 1;
  else if (diff < 0.5) n = fl;
  else n = fl % 2 === 0 ? fl : fl + 1;
  return String(n);
}

/** python `d.get(key)` —— present-but-null 返回 null；非映射抛 AttributeError。 */
function dGet(d: unknown, key: string): unknown {
  if (d === null || d === undefined) throw noAttr("get", d);
  if (typeof d === "string" || Array.isArray(d) || d instanceof Uint8Array) throw noAttr("get", d);
  if (d instanceof Map) return d.has(key) ? d.get(key) : undefined;
  if (typeof d !== "object") throw noAttr("get", d);
  const o = d as JsonDict;
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

/** python 的 AttributeError 文案：`'list' object has no attribute 'get'`。 */
function noAttr(name: string, obj: unknown): Error {
  return new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute '${name}'`);
}

/** python `getattr(obj, name, default)`：非对象/缺属性都得到 default。 */
function pyGetAttr(obj: unknown, name: string, defaultValue: unknown = null): unknown {
  if (obj === null || obj === undefined) return defaultValue;
  if (typeof obj !== "object" && typeof obj !== "function") return defaultValue;
  const v = (obj as JsonDict)[name];
  if (v === undefined && !(name in (obj as object))) return defaultValue;
  return v === undefined ? defaultValue : v;
}

/** 只有 plain 对象 / Map 才算 python 的 dict。 */
function isPyDict(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (v instanceof Map) return true;
  if (Array.isArray(v) || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** json.dumps(v, ensure_ascii=False)：python 默认分隔符 `", "` / `": "`、键按插入序。 */
function pyJsonDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  }
  if (typeof v === "string") {
    return JSON.stringify(v)
      .split("\\u2028").join(String.fromCharCode(0x2028))
      .split("\\u2029").join(String.fromCharCode(0x2029));
  }
  if (v instanceof Uint8Array || typeof v === "function" || v instanceof Error
      || v instanceof Map || v instanceof Set) {
    throw new TypeErrorP(`Object of type ${pyTypeName(v)} is not JSON serializable`);
  }
  if (Array.isArray(v)) return "[" + v.map(pyJsonDumps).join(", ") + "]";
  if (isPyDict(v)) {
    return "{" + Object.keys(v as JsonDict)
      .map((k) => pyJsonDumps(k) + ": " + pyJsonDumps((v as JsonDict)[k])).join(", ") + "}";
  }
  throw new TypeErrorP(`Object of type ${pyTypeName(v)} is not JSON serializable`);
}

/** json.loads(s)：只解析 python 认的字面量；失败抛 JSONDecodeError（子类自 ValueError）。 */
function pyJsonLoads(s: unknown): unknown {
  if (typeof s !== "string") {
    throw new TypeErrorP(`the JSON object must be str, bytes or bytearray, not ${pyTypeName(s)}`);
  }
  try {
    return JSON.parse(s);
  } catch {
    // CPython 的 JSONDecodeError 文案里带行列号；源里这条异常必被
    // `except json.JSONDecodeError: continue`（663-665）就地吞掉，从不外逃，
    // 所以只有"是否抛 JSONDecodeError"这一件事是可观察的。行列号按第一个非空白字符定位。
    throw new JSONDecodeErrorP(s, jsonFirstTokenPos(s));
  }
}

function jsonFirstTokenPos(doc: string): number {
  for (let i = 0; i < doc.length; i += 1) {
    if (!" \t\n\r".includes(doc.slice(i, i + 1))) return i;
  }
  return doc.length;
}

/* ── python bytes 的对应物（Uint8Array） ─────────────────────────────────── */

const NL_BYTE = 0x0a;

function bytesRepr(b: Uint8Array): string {
  let out = "b'";
  for (const ch of b) {
    if (ch === 0x27) out += "\\'";
    else if (ch === 0x5c) out += "\\\\";
    else if (ch === 0x0a) out += "\\n";
    else if (ch === 0x0d) out += "\\r";
    else if (ch === 0x09) out += "\\t";
    else if (ch >= 0x20 && ch < 0x7f) out += String.fromCharCode(ch);
    else out += "\\x" + ch.toString(16).padStart(2, "0");
  }
  return out + "'";
}

/** `a + b`（bytes 拼接）。非 bytes 的一侧 -> CPython 的 `can't concat str to bytes`。 */
function bytesConcat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!(a instanceof Uint8Array)) throw new TypeErrorP(`can't concat ${pyTypeName(a)} to bytes`);
  if (!(b instanceof Uint8Array)) throw new TypeErrorP(`can't concat ${pyTypeName(b)} to bytes`);
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** `b"\n" in buf`。 */
function bytesContains(b: Uint8Array, needle: number): boolean {
  for (let i = 0; i < b.length; i += 1) if (b[i] === needle) return true;
  return false;
}

/** `head, tail = buf.split(b"\n", 1)`（buf 必含 needle 时才有意义）。 */
function bytesSplitAt(b: Uint8Array, needle: number): [Uint8Array, Uint8Array] {
  for (let i = 0; i < b.length; i += 1) {
    if (b[i] === needle) return [b.slice(0, i), b.slice(i + 1)];
  }
  return [b.slice(), new Uint8Array(0)];
}

/** bytes.strip()：python 的 bytes 空白集是 ASCII 空白（0x09-0x0d, 0x20）。 */
function bytesStrip(b: Uint8Array): Uint8Array {
  const WS = new Set<number>([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);
  let s = 0;
  let e = b.length;
  while (s < e && WS.has(b[s] as number)) s += 1;
  while (e > s && WS.has(b[e - 1] as number)) e -= 1;
  return b.slice(s, e);
}

/** `bytes.decode("utf-8")`：严格模式，非法序列抛 UnicodeDecodeError（CPython 文案）。 */
function bytesDecodeUtf8(b: Uint8Array): string {
  const at = (i: number): number => b[i] as number;
  const fail = (start: number, end: number, why: string): never => {
    const where = start === end - 1
      ? `byte 0x${at(start).toString(16).padStart(2, "0")} in position ${start}`
      : `bytes in position ${start}-${end - 1}`;
    throw new UnicodeDecodeErrorP(`'utf-8' codec can't decode ${where}: ${why}`);
  };
  let out = "";
  let i = 0;
  while (i < b.length) {
    const c = at(i);
    if (c < 0x80) { out += String.fromCharCode(c); i += 1; continue; }
    let need = 0;
    let lo = 0x80;
    let hi = 0xbf;
    if (c >= 0xc2 && c <= 0xdf) need = 1;
    else if (c >= 0xe0 && c <= 0xef) need = 2;
    else if (c >= 0xf0 && c <= 0xf4) need = 3;
    else fail(i, i + 1, "invalid start byte");
    if (c === 0xe0) lo = 0xa0;
    if (c === 0xed) hi = 0x9f;
    if (c === 0xf0) lo = 0x90;
    if (c === 0xf4) hi = 0x8f;
    for (let k = 1; k <= need; k += 1) {
      if (i + k >= b.length) fail(i, i + k, "unexpected end of data");
      const cc = at(i + k);
      const l = k === 1 ? lo : 0x80;
      const h = k === 1 ? hi : 0xbf;
      if (cc < l || cc > h) fail(i, i + k, "invalid continuation byte");
    }
    let cp = c & (0xff >> (need + 1));
    for (let k = 1; k <= need; k += 1) cp = (cp << 6) | (at(i + k) & 0x3f);
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

/** `str.encode("utf-8")`。 */
function strEncodeUtf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of Array.from(s)) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}

/* ── pathlib（win32 语义，与源同平台） ───────────────────────────────────── */

/** `Path(x)`：只接受 str / PathLike，否则 CPython 的 TypeError。 */
function pyPathCoerce(v: unknown): string {
  if (typeof v === "string") return v;
  if (v !== null && typeof v === "object" && typeof (v as { __fspath__?: () => string }).__fspath__ === "function") {
    return pyStr((v as { __fspath__: () => string }).__fspath__());
  }
  throw new TypeErrorP(
    `argument should be a str or an os.PathLike object where __fspath__ returns a str, not '${pyTypeName(v)}'`);
}

/** `open(path, ...)` 的路径转换：CPython 走 `os.fspath`，文案与 pathlib 不同。 */
function pyOpenCoerce(v: unknown): string {
  if (typeof v === "string") return v;
  if (v !== null && typeof v === "object" && typeof (v as { __fspath__?: () => string }).__fspath__ === "function") {
    return pyStr((v as { __fspath__: () => string }).__fspath__());
  }
  throw new TypeErrorP(`expected str, bytes or os.PathLike object, not ${pyTypeName(v)}`);
}

/**
 * PureWindowsPath 归一：分隔符转 "\\"、去空段与 "." 段、保留 ".."、无段时给 "."。
 *
 * root/UNC 规则不是推测，是**实测**（CPython 3.13.12 真 pathlib，探针
 * `tmp/w211_probe_unc.py`，跑法 `node tmp/dp_pyfile.mjs D:/ovolve-migration/tmp/w211_probe_unc.py`）：
 *   "/"        -> drive=''  root='\'           str='\'               （单反斜杠，**不是** UNC）
 *   "/a/b"     -> drive=''  root='\'           str='\a\b'
 *   "//a/b"    -> drive='\\a\b' root='\'       str='\\a\b\'          （恰好两个分隔符才是 UNC）
 *   "//a"      -> drive='\\a'   root=''        str='\\a'             （UNC 只有 server 一段）
 *   "//"       -> drive='\\'    root=''        str='\\'
 *   "///a/b"   -> drive='\\\a'  root='\'       str='\\\a\b'          （>=3 个：分隔符全留 + 第一段进 drive）
 *   "C:\\a\\b" -> drive='C:'  root='\'         str='C:\a\b'          （盘符后的重复分隔符折成一个）
 * 旧实现把「以**一个**分隔符开头」也当 UNC 处理（吃掉前两段当 server/share），
 * 于是 `Path("/") / ".ovolve" / "subprocess-logs"` 再 `/ "sa-7.log"` 时，第二次的
 * `pyPathStr` 把已经是 root 的 `\` 渲染成 `\\.ovolve\...`（双反斜杠）。
 * slp#abs_root 的实测差异就是这个端口 bug，不是探针、也不是陈旧事实文件。
 */
function pyPathStr(raw: string): string {
  let drive = "";
  let rest = raw;
  const dm = /^([A-Za-z]):/.exec(raw);
  if (dm) { drive = (dm[1] as string) + ":"; rest = raw.slice(drive.length); }
  let root = "";
  const lead = /^[\\/]+/.exec(rest);
  const nsep = lead ? lead[0].length : 0;
  if (nsep > 0) {
    const tail = rest.slice(nsep);
    const segs = tail.split(/[\\/]+/).filter((p) => p.length > 0);
    if (drive !== "") {
      // 实测：盘符之后的重复分隔符一律折成单个 root。
      root = "\\";
      rest = tail;
    } else if (nsep === 1) {
      // 实测：单反斜杠开头只是 root，绝不进 UNC 臂。
      root = "\\";
      rest = tail;
    } else if (nsep === 2) {
      // 实测：恰好两个分隔符 = UNC，server 与 share 两段都归 drive。
      if (segs.length >= 2) {
        drive = "\\\\" + (segs[0] as string) + "\\" + (segs[1] as string);
        root = "\\";
        rest = segs.slice(2).join("\\");
      } else if (segs.length === 1) {
        drive = "\\\\" + (segs[0] as string);
        root = "";
        rest = "";
      } else {
        drive = "\\\\";
        root = "";
        rest = "";
      }
    } else {
      // 实测：>=3 个前置分隔符时全部保留，并吃掉第一段。
      const pre = "\\".repeat(nsep);
      if (segs.length >= 1) {
        drive = pre + (segs[0] as string);
        root = segs.length >= 2 ? "\\" : "";
        rest = segs.slice(1).join("\\");
      } else {
        drive = pre;
        root = "";
        rest = "";
      }
    }
  }
  const parts = rest.split(/[\\/]+/).filter((p) => p.length > 0 && p !== ".");
  if (drive === "" && root === "") return parts.length === 0 ? "." : parts.join("\\");
  return drive + root + parts.join("\\");
}

/** `a / b`：b 绝对或带盘符则整体重置。a 已以分隔符结尾时不再补 "\\"
 *  （PureWindowsPath("\\") / ".ovolve" == "\\.ovolve"，单反斜杠）。 */
function pyPathJoin(a: string, b: string): string {
  const nb = pyPathStr(b);
  if (/^([A-Za-z]:)?[\\/]/.test(nb)) return nb;
  const na = pyPathStr(a);
  if (na === ".") return nb === "." ? "." : nb;
  // pathlib 的 `/` 是 **(drive, root, parts) 三元组重解析**，不是字符串拼接。
  // 实测（tmp/w211_probe_unc2.py，CPython 3.13.12 真 pathlib）：
  //   PureWindowsPath("//")                -> "\\\\"            （drive='\\\\', root=''）
  //   …/ ".ovolve"                          -> "\\.ovolve"       （server='.ovolve'，无 root）
  //   …/ "subprocess-logs"                  -> "\\.ovolve\\subprocess-logs\\"  ← **尾分隔符回来了**
  //   …/ "sa.log"                           -> "\\.ovolve\\subprocess-logs\\sa.log"
  //   PureWindowsPath("//srv") / ".ovolve"  -> "\\\\srv\\.ovolve\\"（这次 root 补上了）
  // 拼接串必须再走一次 pyPathStr，否则 server/share 的「吃掉两段」规则不会重算，
  // slp#unc_bare 的 mkdir 记账就会少掉那个尾分隔符。
  const joined = (/[\\/]$/.test(na) ? na + nb : na + "\\" + nb);
  return pyPathStr(joined);
}

/* ── python 异常镜像：复用单元 195 导出的那批类（异常类型也是行为） ───────── */
const ImportErrorP = SUBAGENT_ERRORS.ImportErrorP;
const ModuleNotFoundErrorP = SUBAGENT_ERRORS.ModuleNotFoundErrorP;
const ValueErrorP = SUBAGENT_ERRORS.ValueErrorP;
const TypeErrorP = SUBAGENT_ERRORS.TypeErrorP;
const AttributeErrorP = SUBAGENT_ERRORS.AttributeErrorP;
const KeyErrorP = SUBAGENT_ERRORS.KeyErrorP;
const TimeoutErrorP = SUBAGENT_ERRORS.TimeoutErrorP;
const RuntimeErrorP = SUBAGENT_ERRORS.RuntimeErrorP;

/** `json.JSONDecodeError` 是 `ValueError` 的子类，但 `type(e).__name__` 是它自己。 */
class JSONDecodeErrorP extends Error {
  constructor(doc: string, at: number) {
    const upTo = doc.slice(0, Math.max(0, Math.min(at, doc.length)));
    const line = upTo.split("\n").length;
    const col = upTo.length - (upTo.lastIndexOf("\n") + 1) + 1;
    const m = `Expecting value: line ${line} column ${col} (char ${at})`;
    super(m);
    (this as any).pyMsg = m;
    (this as any).name = "JSONDecodeError";
  }
}
/** `UnicodeDecodeError` 同为 ValueError 子类，但源里 `except json.JSONDecodeError` 接不住它。 */
class UnicodeDecodeErrorP extends Error {
  constructor(m: string) { super(m); (this as any).pyMsg = m; (this as any).name = "UnicodeDecodeError"; }
}
/** 源 579 的裸 `assert`：无消息，str(e) 是空串。 */
class AssertionErrorP extends Error {
  constructor(m = "") { super(m); (this as any).pyMsg = m; (this as any).name = "AssertionError"; }
}

/** 源里 `except Exception` 能抓到的那一族。 */
function isPyException(e: unknown): boolean { return e instanceof Error; }

/* ── python 函数局部 import 的对应物：名字表 + 缺名报错 ───────────────────── */

let _team_collab_ns_mod: AnyMod = _team_collab_ns as AnyMod;
let _permission_bridge_ns_mod: AnyMod = _permission_bridge_ns as AnyMod;
let _worker_prewarm_pool_mod: AnyMod | null = null;

/**
 * `from X import name` 的存在性检查。缺名 -> CPython 原文案，一次只报**书写顺序里
 * 第一个**缺的名字（IMPORT_FROM 逐名执行）。
 */
function needAttr(mod: AnyMod, name: string, from: string): unknown {
  if (!(name in mod)) {
    const origin = typeof mod.__origin__ === "string" ? mod.__origin__ : "(unknown location)";
    throw new ImportErrorP(`cannot import name '${name}' from '${from}' (${origin})`);
  }
  return mod[name];
}

/** `**extra` 合并进已有关键字袋：CPython DICT_MERGE 的重复键报错逐字复现。
 *  `**None` 在 CPython 也是 TypeError（`f() argument after ** must be a mapping, not NoneType`），
 *  不是空合并 —— 只有 undefined（JS 侧的"没有这个实参"）才直通。 */
function dictMergeKw(target: JsonDict, extra: unknown, funcName: string): JsonDict {
  if (extra === undefined) return target;
  if (extra === null || !isPyDict(extra)) {
    throw new TypeErrorP(`${funcName}() argument after ** must be a mapping, not ${pyTypeName(extra)}`);
  }
  const src = extra instanceof Map ? Object.fromEntries(extra as Map<string, unknown>) : extra as JsonDict;
  for (const k of Object.keys(src)) {
    if (Object.prototype.hasOwnProperty.call(target, k)) {
      throw new TypeErrorP(`${funcName}() got multiple values for keyword argument '${k}'`);
    }
    target[k] = src[k];
  }
  return target;
}

/** 调用一个 python 风格的可调用（假件可以是函数或构造器）。 */
function pyCallable(v: unknown, label: string): (...a: unknown[]) => unknown {
  if (typeof v !== "function") {
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not callable`);
  }
  return v as (...a: unknown[]) => unknown;
}

/** python `Cls(...)` 的构造调用：不可调用时的 TypeError 文案与 pyCallable 同源。 */
function pyCtor(v: unknown, label: string): new (a: unknown, kw: JsonDict) => AnyMod {
  if (typeof v !== "function") {
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not callable`);
  }
  return v as new (a: unknown, kw: JsonDict) => AnyMod;
}

/** `obj.name(...)`：方法不存在时同样是 AttributeError，不是 JS 的那句 TypeError。 */
function pyMethod(obj: unknown, name: string): (...a: unknown[]) => unknown {
  const v = pyAttr(obj, name);
  if (typeof v !== "function") {
    throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute '${name}'`);
  }
  return (...a: unknown[]) => (v as (...x: unknown[]) => unknown).apply(obj, a);
}

/** `obj.name` —— 直接属性读，缺名抛 CPython 的 AttributeError。 */
function pyAttr(obj: unknown, name: string): unknown {
  if (obj === null || obj === undefined) throw noAttr(name, obj);
  if (typeof obj !== "object" && typeof obj !== "function") throw noAttr(name, obj);
  if (!(name in (obj as object))) throw noAttr(name, obj);
  return (obj as AnyMod)[name];
}

/* ── 接缝 ─────────────────────────────────────────────────────────────────── */

export const TEAM_BACKEND_SEAMS = {
  /* python `time.time()` */
  now: (): number => Date.now() / 1000,
  /* python `os.environ.get(k, d)`（调用期） */
  env_get: (k: string, d: unknown = undefined): unknown =>
    Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : d,
  /* python `dict(os.environ)` */
  env_items: (): JsonDict => ({ ...process.env } as JsonDict),
  /* python `os.path.dirname(os.path.abspath(__file__))` —— **import 期**求值 */
  module_dir: (): string => nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url)),
  /* python 读模块全局 `_BACKEND_DIR`（329）；探针两侧钉成同一字面量 */
  backend_dir: (): string => _BACKEND_DIR,
  /* python `os.pathsep` */
  pathsep: (): string => ";",
  /* python `sys.executable` */
  sys_executable: (): string => process.execPath,
  /* python `asyncio.subprocess.PIPE` 哨兵 */
  PIPE: Object.freeze({ __py__: "subprocess.PIPE" }),

  /* python `logging.getLogger(__name__).warning(fmt, *args)`：`%` 渲染归宿主 logger，
   * 接缝只收 (fmt, args) 两部分，不预渲染。 */
  log_warning: (fmt: string, args: unknown[]): void => { /* host logger */ },
  log_debug: (fmt: string, args: unknown[]): void => { /* host logger */ },

  /* python `Path(...).mkdir(parents=True, exist_ok=True)`（真文件系统，接缝虚拟化） */
  mkdirs: (path: string): void => {
    nodeFs.mkdirSync(path, { recursive: true });
  },
  /* python `open(log_path, "a", encoding="utf-8")` —— 返回带 close() 的句柄。
   * 路径参数走 `os.fspath` 的文案（open() 的转换错误与 pathlib 的不是同一句）。 */
  open_append: (path: unknown): AnyMod => {
    const p = pyOpenCoerce(path);
    const fd = nodeFs.openSync(p, "a");
    let closed = false;
    return {
      __repr__: () => `<TextIOWrapper name=${pyRepr(p)} mode='a' encoding='utf-8'>`,
      close: () => { if (!closed) { closed = true; nodeFs.closeSync(fd); } },
    };
  },

  /* python `asyncio.create_subprocess_exec(*popenargs, **kwargs)` */
  create_subprocess_exec: async (argv: unknown[], kwargs: JsonDict): Promise<AnyMod> => {
    const cmd = argv.length > 0 ? pyStr(argv[0]) : "";
    const args = argv.slice(1).map((x) => pyStr(x));
    const proc = nodeChildProcess.spawn(cmd, args, {
      cwd: (kwargs.cwd === null || kwargs.cwd === undefined) ? undefined : pyStr(kwargs.cwd),
      env: kwargs.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe",
        kwargs.stderr === null || kwargs.stderr === undefined ? "ignore" : kwargs.stderr] as never,
      detached: false,
    });
    return {
      pid: proc.pid ?? null,
      stdin: {
        write: (b: Uint8Array) => { proc.stdin?.write(Buffer.from(b)); },
        drain: async () => { /* node buffers the write */ },
        close: () => { proc.stdin?.end(); },
      },
      stdout: {
        read: async (n: number) => {
          const chunk = proc.stdout?.read(n);
          return chunk ? Uint8Array.from(chunk as Buffer) : new Uint8Array(0);
        },
      },
      returncode: null,
      wait: async () => new Promise<number>((resolve) => {
        proc.once("close", (code: number | null) => resolve(code ?? 0));
      }),
    };
  },
  /* python `asyncio.wait_for(coro_factory, timeout=)` */
  wait_for: async (factory: () => Promise<unknown>, timeout: number): Promise<unknown> => {
    let timer: unknown;
    try {
      return await Promise.race([
        factory(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new TimeoutErrorP("")), Math.max(timeout, 0) * 1000);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer as never);
    }
  },

  /* ── 兄弟模块装载器：python 的函数局部 import 是同步语句，故同步臂 ── */
  // team_collab 已落地（单元 210，本模块的静态依赖，非环内成员）。
  teamCollabModule: (): AnyMod => _team_collab_ns_mod,
  // permission_bridge 已落地（单元 207，非环内成员）。
  permissionBridgeModule: (): AnyMod => _permission_bridge_ns_mod,
  // subprocess_isolation 是 Native→Rust（单元 209）：TS 侧无同名文件，缺省臂与
  // subagent_runtime.ts / permission_bridge.ts 的 mailboxModule 一字一致。
  subprocessIsolationModule: (): AnyMod => {
    throw new ModuleNotFoundErrorP("No module named 'subprocess_isolation'");
  },
  // worker_prewarm_pool 是 scc=3 的**环内 sibling（212）**：按环规则不静态 import，
  // 只经本接缝（bind_worker_prewarm_pool_module）可达。未绑定 -> ModuleNotFoundError，
  // 落进源里 `except Exception -> prewarm miss -> 冷启动 spawn` 的活路（见文件头 DIVERGENCE）。
  workerPrewarmPoolModule: (): AnyMod => {
    if (_worker_prewarm_pool_mod !== null) return _worker_prewarm_pool_mod;
    throw new ModuleNotFoundErrorP("No module named 'worker_prewarm_pool'");
  },
};

/** 环规则的显式接线点：生产装配时把 212 的模块表交进来，探针交记录型假件。 */
export function bind_worker_prewarm_pool_module(mod: AnyMod | null): void {
  _worker_prewarm_pool_mod = mod;
}

/** 供探针替换（python 侧 probe 直接改模块全局；TS 侧改这两格）。 */
export function set_sibling_namespace(name: string, mod: AnyMod): void {
  if (name === "team_collab") _team_collab_ns_mod = mod;
  else if (name === "permission_bridge") _permission_bridge_ns_mod = mod;
  else throw new KeyErrorP(name);
}

/* ── 模块顶层（源 39-51） ────────────────────────────────────────────────── */

/** 源 39：`log = logging.getLogger(__name__)` —— 日志全走接缝。 */
export const LOG_NAME = "teammate_backend";

/** 源 43：`_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))`。 */
let _BACKEND_DIR: string = TEAM_BACKEND_SEAMS.module_dir();

/** 供探针把 `_BACKEND_DIR` 钉成与 python 侧一致的字面量（等价于改模块全局）。 */
export function set_backend_dir(v: string): void { _BACKEND_DIR = v; }
export function get_backend_dir(): string { return _BACKEND_DIR; }

/** 源 45。 */
export const _WORKER_MODULE = "ovolve_subagent_worker";
/** 源 47。 */
export const _KILL_GRACE_S = 5.0;
/** 源 49：B5 —— 死常量，全模块零引用，照样导出。 */
export const WORKER_HEARTBEAT_INTERVAL_S = 5.0;
/**
 * 源 51：`float(os.environ.get("OVOLVE_WORKER_HEARTBEAT_LOST_S", "15"))` ——
 * **import 期**求值：环境变量放一个非数字会让整个模块装载失败。
 * DIVERGENCE(port): 见文件头折叠 2；python 完全一样，所以不做兜底。
 */
export const WORKER_HEARTBEAT_LOST_S: number = pyFloat(
  TEAM_BACKEND_SEAMS.env_get("OVOLVE_WORKER_HEARTBEAT_LOST_S", "15"),
);

/* ── 枚举（源 57-61） ────────────────────────────────────────────────────── */

/**
 * 源 57 `class SubagentExecMode(str, Enum)`。
 * DIVERGENCE(port): 见文件头 —— 成员记 (name, value)，`toString()` 复现 Enum.__str__。
 */
export class SubagentExecMode {
  static readonly INPROCESS = new SubagentExecMode("INPROCESS", "inprocess");
  static readonly SUBPROCESS = new SubagentExecMode("SUBPROCESS", "subprocess");
  readonly name: string;
  readonly value: string;
  private constructor(name: string, value: string) {
    this.name = name;
    this.value = value;
  }
  toString(): string { return `<SubagentExecMode.${this.name}>`; }
  /** python `repr(member)`。 */
  __repr__(): string { return `<SubagentExecMode.${this.name}: ${pyRepr(this.value)}>`; }
}

/* ── dataclass 镜像的公共小工具 ──────────────────────────────────────────── */

/** python dataclass `__init__` 的缺参/多参 TypeError 文案。 */
function dcInit(clsName: string, order: readonly string[], required: readonly string[], init: JsonDict): JsonDict {
  for (const k of Object.keys(init)) {
    if (!order.includes(k)) {
      throw new TypeErrorP(`${clsName}.__init__() got an unexpected keyword argument '${k}'`);
    }
  }
  const missing = required.filter((k) => init[k] === undefined);
  if (missing.length > 0) {
    // CPython 的枚举串在 n>=3 时用牛津逗号（`'a', 'b', and 'c'`）。
    const head = missing.slice(0, -1).map((m) => pyRepr(m)).join(", ");
    const listed = missing.length === 1
      ? pyRepr(missing[0])
      : head + (missing.length === 2 ? " and " : ", and ") + pyRepr(missing[missing.length - 1]);
    throw new TypeErrorP(
      `${clsName}.__init__() missing ${missing.length} required positional ${
        missing.length === 1 ? "argument" : "arguments"}: ${listed}`);
  }
  return init;
}

/** `init[k]` 的 python 默认值语义：显式传 None 就是 None，缺键才用默认。 */
function dcField(init: JsonDict, key: string, dflt: unknown): unknown {
  return init[key] === undefined ? dflt : init[key];
}

/* ── TeammateSpawnSpec（源 67-105） ──────────────────────────────────────── */

const _SPEC_ORDER: readonly string[] = [
  "subagent_id", "subagent_type", "label", "prompt", "child_session", "parent_session_id",
  "workspace_root", "system_prompt", "permission", "model", "model_role", "allowed_tools",
  "max_turns", "subagent_depth", "handoffs", "dry_run", "leader_endpoint",
];
const _SPEC_REQUIRED: readonly string[] = [
  "subagent_id", "subagent_type", "label", "prompt", "child_session", "parent_session_id",
  "workspace_root", "system_prompt",
];

export class TeammateSpawnSpec {
  subagent_id!: unknown;
  subagent_type!: unknown;
  label!: unknown;
  prompt!: unknown;
  child_session!: unknown;
  parent_session_id!: unknown;
  workspace_root!: unknown;
  system_prompt!: unknown;
  permission: unknown;
  model: unknown;
  model_role: unknown;
  allowed_tools: unknown;
  max_turns: unknown;
  subagent_depth: unknown;
  handoffs: unknown;
  dry_run: unknown;
  leader_endpoint: unknown;

  constructor(init: JsonDict = {}) {
    const v = dcInit("TeammateSpawnSpec", _SPEC_ORDER, _SPEC_REQUIRED, init);
    this.subagent_id = v.subagent_id;
    this.subagent_type = v.subagent_type;
    this.label = v.label;
    this.prompt = v.prompt;
    this.child_session = v.child_session;
    this.parent_session_id = v.parent_session_id;
    this.workspace_root = v.workspace_root;
    this.system_prompt = v.system_prompt;
    this.permission = dcField(v, "permission", "auto");
    this.model = dcField(v, "model", null);
    this.model_role = dcField(v, "model_role", "inherit");
    this.allowed_tools = dcField(v, "allowed_tools", null);
    this.max_turns = dcField(v, "max_turns", null);
    this.subagent_depth = dcField(v, "subagent_depth", 0);
    // field(default_factory=list)：每个实例一个新列表。
    this.handoffs = dcField(v, "handoffs", []);
    this.dry_run = dcField(v, "dry_run", false);
    this.leader_endpoint = dcField(v, "leader_endpoint", null);
  }
}

/* ── TeammateSpawnResult（源 111-131） ───────────────────────────────────── */

const _RESULT_ORDER: readonly string[] = [
  "ok", "backend_id", "backend_type", "pid", "log_path", "text", "error", "meta", "lost",
];
const _RESULT_REQUIRED: readonly string[] = ["ok", "backend_id", "backend_type"];

export class TeammateSpawnResult {
  ok!: unknown;
  backend_id!: unknown;
  backend_type!: unknown;
  pid: unknown;
  log_path: unknown;
  text: unknown;
  error: unknown;
  meta: unknown;
  lost: unknown;

  constructor(init: JsonDict = {}) {
    const v = dcInit("TeammateSpawnResult", _RESULT_ORDER, _RESULT_REQUIRED, init);
    this.ok = v.ok;
    this.backend_id = v.backend_id;
    this.backend_type = v.backend_type;
    this.pid = dcField(v, "pid", null);
    this.log_path = dcField(v, "log_path", null);
    this.text = dcField(v, "text", "");
    this.error = dcField(v, "error", "");
    // field(default_factory=dict)：每个实例一个新 dict。
    this.meta = dcField(v, "meta", {});
    this.lost = dcField(v, "lost", false);
  }

  /** 便于探针按字段表记账（python 侧用 dataclasses.fields 的同一顺序）。 */
  asDict(): JsonDict {
    return {
      ok: this.ok, backend_id: this.backend_id, backend_type: this.backend_type,
      pid: this.pid, log_path: this.log_path, text: this.text, error: this.error,
      meta: this.meta, lost: this.lost,
    };
  }
}

/* ── SubprocessHandle（源 137-159） ──────────────────────────────────────── */

const _HANDLE_ORDER: readonly string[] = [
  "subagent_id", "backend_id", "proc", "log_path", "pid", "reader_task",
  "last_heartbeat", "result", "job_handle", "log_fh",
];
const _HANDLE_REQUIRED: readonly string[] = ["subagent_id", "backend_id", "proc", "log_path", "pid"];

export class SubprocessHandle {
  subagent_id!: unknown;
  backend_id!: unknown;
  proc!: AnyMod;
  log_path!: unknown;
  pid!: unknown;
  /** B4：全模块从未赋值也从未读取的死字段（源 151）。 */
  reader_task: unknown;
  last_heartbeat: unknown;
  /** B3/B4：只在源 675 写、写点紧接着 return，故 717 永远读不到。 */
  result: unknown;
  job_handle: unknown;
  /** B4：唯一构造点显式传 None（源 559），且从未读取。 */
  log_fh: unknown;

  constructor(init: JsonDict = {}) {
    const v = dcInit("SubprocessHandle", _HANDLE_ORDER, _HANDLE_REQUIRED, init);
    this.subagent_id = v.subagent_id;
    this.backend_id = v.backend_id;
    this.proc = v.proc as AnyMod;
    this.log_path = v.log_path;
    this.pid = v.pid;
    this.reader_task = dcField(v, "reader_task", null);
    // field(default_factory=time.time)：只在缺参时读时钟（源 153）；显式传值绝不触发工厂。
    this.last_heartbeat = v.last_heartbeat === undefined ? TEAM_BACKEND_SEAMS.now() : v.last_heartbeat;
    this.result = dcField(v, "result", null);
    this.job_handle = dcField(v, "job_handle", null);
    this.log_fh = dcField(v, "log_fh", null);
  }
}

/* ── TeammateBackend 协议（源 165-185，B11） ─────────────────────────────── */

/**
 * B11：源里的 `Protocol` 运行期惰性，且 `SubprocessBackend.run` 的真实签名
 * （必填 `log_path` / `timeout_s`）与协议声明的 `run(self, spec)` 不兼容。逐字保留。
 */
export interface TeammateBackend {
  readonly backend_type: string;
  is_available(): Promise<boolean>;
  run(spec: TeammateSpawnSpec): Promise<TeammateSpawnResult>;
  kill(backend_id: string): Promise<boolean>;
  is_alive(backend_id: string): Promise<boolean>;
}

/* ── resolve_exec_mode（源 191-305） ─────────────────────────────────────── */

interface ResolveExecModeKw {
  task_exec_mode?: string;
  parent_ctx?: unknown;
}

/**
 * 源 191-305：inprocess / subprocess 优先级判定。
 *
 * BUG(port): B1（team-force 整块只能给 SUBPROCESS）、B2（循环里 task_raw 的 inprocess 臂是死臂）。
 *   两条都在这一段，端口原样写完。
 */
export function resolve_exec_mode(
  definition: unknown,
  kw: ResolveExecModeKw = {},
): SubagentExecMode {
  const task_exec_mode = kw.task_exec_mode === undefined ? "" : kw.task_exec_mode;
  const parent_ctx = kw.parent_ctx === undefined ? null : kw.parent_ctx;

  const task_raw = pyStrip(pyStr(pyOr(task_exec_mode, ""))).toLowerCase();
  if (["inprocess", "in-process", "in_process"].includes(task_raw)) {
    return SubagentExecMode.INPROCESS;
  }

  const tc = TEAM_BACKEND_SEAMS.teamCollabModule();
  // 绑定顺序 = 源码书写顺序（231）；缺名只报第一个。
  // IMPORT_FROM 不检查 callable（源注释），非可调用在**调用点**抛 CPython 文案，
  // 故经 pyCallable 统一走 `'str' object is not callable` 那条臂。
  const resolveAgentTeamsSubprocess = needAttr(tc, "resolve_agent_teams_subprocess", "team_collab");
  const subprocessGloballyDisabled = needAttr(tc, "subprocess_globally_disabled", "team_collab");

  const team_force = pyCallable(resolveAgentTeamsSubprocess, "resolve_agent_teams_subprocess")(parent_ctx);
  if (team_force === true) {
    // `is True`：身份判定，只认真布尔 True。
    // ---- B1 起点：以下四条 return 与块末的无条件 return 同值 ----
    const persona_raw = pyStrip(pyStr(pyOr(pyGetAttr(definition, "exec_mode", ""), ""))).toLowerCase();
    const env_raw = pyStrip(pyStr(TEAM_BACKEND_SEAMS.env_get("OVOLVE_SUBAGENT_EXEC_MODE", ""))).toLowerCase();
    if (["subprocess", "sub"].includes(task_raw)) {
      return SubagentExecMode.SUBPROCESS;
    }
    if (["subprocess", "sub"].includes(persona_raw)) {
      return SubagentExecMode.SUBPROCESS;
    }
    if (["subprocess", "sub"].includes(env_raw)) {
      return SubagentExecMode.SUBPROCESS;
    }
    if (pyTruth(parent_ctx) && ["1", "true", "yes"].includes(
      pyStr(pyOr(dGet(parent_ctx, "subprocess_swarm"), "")).toLowerCase())) {
      return SubagentExecMode.SUBPROCESS;
    }
    // Team workflow without explicit mode → subprocess for isolation
    return SubagentExecMode.SUBPROCESS;
    // ---- B1 终点：块内任何输入都不改变返回值 ----
  }

  if (pyTruth(pyCallable(subprocessGloballyDisabled, "subprocess_globally_disabled")())) {
    return SubagentExecMode.INPROCESS;
  }

  const raws = [
    task_raw,
    pyStrip(pyStr(pyOr(pyGetAttr(definition, "exec_mode", ""), ""))).toLowerCase(),
    pyStrip(pyStr(TEAM_BACKEND_SEAMS.env_get("OVOLVE_SUBAGENT_EXEC_MODE", ""))).toLowerCase(),
  ];
  for (const raw of raws) {
    if (["subprocess", "sub"].includes(raw)) {
      return SubagentExecMode.SUBPROCESS;
    }
    // B2：第一个元素（task_raw）永远不可能走到这条臂 —— 见文件头。
    if (["inprocess", "in-process", "in_process"].includes(raw)) {
      return SubagentExecMode.INPROCESS;
    }
  }

  if (pyTruth(parent_ctx) && ["1", "true", "yes"].includes(
    pyStr(pyOr(dGet(parent_ctx, "subprocess_swarm"), "")).toLowerCase())) {
    return SubagentExecMode.SUBPROCESS;
  }

  return SubagentExecMode.INPROCESS;
}

/* ── subprocess_log_path（源 311-319） ───────────────────────────────────── */

/** `<workspace>/.ovolve/subprocess-logs/<subagent_id>.log`，顺手 mkdir(parents,exist_ok)。 */
export function subprocess_log_path(workspace_root: unknown, subagent_id: unknown): string {
  const root = pyPathStr(pyPathCoerce(pyOr(workspace_root, ".")));
  let log_dir = pyPathJoin(root, ".ovolve");
  log_dir = pyPathJoin(log_dir, "subprocess-logs");
  TEAM_BACKEND_SEAMS.mkdirs(log_dir);
  return pyPathJoin(log_dir, pyStr(subagent_id) + ".log");
}

/* ── _worker_env（源 325-345） ───────────────────────────────────────────── */

/** 给子进程拼 PYTHONPATH / OVOLVE_WORKER_* 那一袋环境变量。 */
export function _worker_env(log_path: unknown, name: unknown): JsonDict {
  const env: JsonDict = { ...TEAM_BACKEND_SEAMS.env_items() };
  const backend_dir = TEAM_BACKEND_SEAMS.backend_dir();
  const sep = TEAM_BACKEND_SEAMS.pathsep();
  env["PYTHONPATH"] = pyRstripChars(
    pyStr(backend_dir) + sep + pyStr(env["PYTHONPATH"] === undefined ? "" : env["PYTHONPATH"]),
    sep,
  );
  // dict.setdefault：已有键（哪怕是空串）不动。
  if (!Object.prototype.hasOwnProperty.call(env, "PYTHONUNBUFFERED")) {
    env["PYTHONUNBUFFERED"] = "1";
  }
  env["OVOLVE_WORKER_KIND"] = "subprocess";
  env["OVOLVE_WORKER_NAME"] = name;
  env["OVOLVE_WORKER_LOG"] = log_path;
  return env;
}

/* ── 三个 subprocess_isolation 薄壳（源 351-375） ────────────────────────── */

/** 源 351-355。 */
export function _popen_kwargs(): JsonDict {
  const si = TEAM_BACKEND_SEAMS.subprocessIsolationModule();
  const f = pyCallable(needAttr(si, "popen_isolation_kwargs", "subprocess_isolation"),
    "popen_isolation_kwargs");
  return f() as JsonDict;
}

/** 源 361-365：原样返回 isolation 层的判定，不做 bool 折算。 */
export function is_process_running(pid: unknown): boolean {
  const si = TEAM_BACKEND_SEAMS.subprocessIsolationModule();
  const f = pyCallable(needAttr(si, "is_process_running", "subprocess_isolation"),
    "is_process_running");
  return f(pid) as boolean;
}

interface KillProcessKw {
  grace_s?: unknown;
  job?: unknown;
}

/** 源 371-375。B10：本模块 5 处调用全用默认 grace_s=5.0。 */
export function kill_process(pid: unknown, kw: KillProcessKw = {}): boolean {
  const grace_s = kw.grace_s === undefined ? _KILL_GRACE_S : kw.grace_s;
  const job = kw.job === undefined ? null : kw.job;
  const si = TEAM_BACKEND_SEAMS.subprocessIsolationModule();
  const f = pyCallable(needAttr(si, "kill_process_tree", "subprocess_isolation"),
    "kill_process_tree");
  return f(pid, { job, grace_s }) as boolean;
}

/* ── spec_to_worker_json（源 381-421） ───────────────────────────────────── */

/** 送进子进程 stdin 的那一坨 JSON 载荷（键序 = 源里的书写序）。 */
export function spec_to_worker_json(spec: TeammateSpawnSpec): JsonDict {
  return {
    v: 1,
    subagent_id: spec.subagent_id,
    subagent_type: spec.subagent_type,
    label: spec.label,
    prompt: spec.prompt,
    child_session: spec.child_session,
    parent_session_id: spec.parent_session_id,
    workspace_root: spec.workspace_root,
    system_prompt: spec.system_prompt,
    permission: spec.permission,
    model: spec.model,
    model_role: spec.model_role,
    allowed_tools: spec.allowed_tools,
    max_turns: spec.max_turns,
    subagent_depth: spec.subagent_depth,
    handoffs: spec.handoffs,
    dry_run: spec.dry_run,
    leader_endpoint: pyOr(spec.leader_endpoint, spec.parent_session_id),
  };
}

/* ── spawn_worker（源 427-561） ──────────────────────────────────────────── */

interface SpawnWorkerKw {
  log_path: unknown;
}

/**
 * 源 427-561：拉一个 `python -m ovolve_subagent_worker` 子进程、把 spec 写进它的 stdin。
 *
 * BUG(port): B6 的两条防御臂（缺 pipe / pid 为 None）与三条错误清理臂逐字保留；
 *   B4 的 `log_fh=None` 也照写。
 */
export async function spawn_worker(spec: TeammateSpawnSpec, kw: SpawnWorkerKw): Promise<SubprocessHandle> {
  const log_path = kw.log_path;
  const si = TEAM_BACKEND_SEAMS.subprocessIsolationModule();
  // 源 437 的 import 语句同时绑定两个名字，绑定序 = 书写序：缺名时 CPython 先报
  // assign_pid_to_job。两处 needAttr 逐字复现该顺序；可调用性判定留给调用点
  // （CPython 的 IMPORT_FROM 不检查 callable，'X' object is not callable 发生在调用时）。
  const assign_pid_to_job = needAttr(si, "assign_pid_to_job", "subprocess_isolation");
  const create_worker_job = needAttr(si, "create_worker_job", "subprocess_isolation");

  const name = `teammate-${pyStr(spec.parent_session_id)}-${pyStr(pyOr(spec.label, spec.subagent_type))}`;
  const env = _worker_env(log_path, name);
  const logFh = TEAM_BACKEND_SEAMS.open_append(log_path);
  const job = pyCallable(create_worker_job, "create_worker_job")() as AnyMod;

  let proc: AnyMod;
  try {
    const explicit: JsonDict = {
      stdin: TEAM_BACKEND_SEAMS.PIPE,
      stdout: TEAM_BACKEND_SEAMS.PIPE,
      stderr: logFh,
      cwd: pyOr(spec.workspace_root, null),
      env,
    };
    // 源 451-469 的实参求值序：位置参数（含 sys.executable）先于 `**_popen_kwargs()`。
    const argv = [TEAM_BACKEND_SEAMS.sys_executable(), "-m", _WORKER_MODULE];
    // 源 469 的 `**_popen_kwargs()` 是最后一个求值的实参 —— 顺序即账本顺序。
    const kwargs = dictMergeKw(explicit, _popen_kwargs(), "asyncio.subprocess.create_subprocess_exec");
    proc = await TEAM_BACKEND_SEAMS.create_subprocess_exec(argv, kwargs) as AnyMod;
  } catch (exc) {
    if (!isPyException(exc)) throw exc;
    pyMethod(logFh, "close")();
    if (pyTruth(job)) {
      const si2 = TEAM_BACKEND_SEAMS.subprocessIsolationModule();
      pyCallable(needAttr(si2, "close_job", "subprocess_isolation"), "close_job")(job);
    }
    throw exc;
  }

  const pstdin = pyAttr(proc, "stdin");
  const pstdout = pyAttr(proc, "stdout");
  if (pstdin === null || pstdout === null) {
    pyMethod(logFh, "close")();
    if (pyTruth(job)) {
      const si2 = TEAM_BACKEND_SEAMS.subprocessIsolationModule();
      pyCallable(needAttr(si2, "close_job", "subprocess_isolation"), "close_job")(job);
    }
    throw new RuntimeErrorP("worker subprocess missing stdio pipes");
  }
  if (pyAttr(proc, "pid") === null) {
    pyMethod(logFh, "close")();
    if (pyTruth(job)) {
      const si2 = TEAM_BACKEND_SEAMS.subprocessIsolationModule();
      pyCallable(needAttr(si2, "close_job", "subprocess_isolation"), "close_job")(job);
    }
    throw new RuntimeErrorP("worker subprocess has no PID");
  }

  let jobNow: unknown = job;
  if (pyTruth(jobNow)) {
    // 源 513：用的是 437 那次 import 绑定的同一个引用，不再走一次 import。
    const assign = pyCallable(assign_pid_to_job, "assign_pid_to_job");
    if (!pyTruth(assign(pyAttr(proc, "pid"), jobNow))) {
      TEAM_BACKEND_SEAMS.log_warning("[subprocess] AssignProcessToJobObject failed for pid=%s",
        [pyAttr(proc, "pid")]);
      const si2 = TEAM_BACKEND_SEAMS.subprocessIsolationModule();
      pyCallable(needAttr(si2, "close_job", "subprocess_isolation"), "close_job")(jobNow);
      jobNow = null;
    }
  }

  const payload = pyJsonDumps(spec_to_worker_json(spec));
  pyMethod(pstdin, "write")(strEncodeUtf8(payload));
  await pyMethod(pstdin, "drain")();
  pyMethod(pstdin, "close")();
  try {
    pyMethod(logFh, "close")();
  } catch (exc) {
    if (!isPyException(exc)) throw exc;
    // 源 537-539：except Exception: pass —— 逐字保留宽吞。
  }

  const backend_id = `${pyStr(pyOr(spec.label, spec.subagent_type))}@${pyStr(spec.parent_session_id)}`;
  return new SubprocessHandle({
    subagent_id: spec.subagent_id,
    backend_id,
    proc,
    log_path,
    pid: pyAttr(proc, "pid"),
    job_handle: jobNow,
    log_fh: null,
  });
}

/* ── read_worker_until_result（源 567-729） ──────────────────────────────── */

interface ReadWorkerKw {
  timeout_s: unknown;
}

/**
 * 源 567-729：读 stdout 的 JSON 行直到 result / fatal，中间判心跳失联。
 *
 * BUG(port): B3（`if handle.result` 永假）、B7（尾部残留字节静默丢弃）都在这一段。
 */
export async function read_worker_until_result(
  handle: SubprocessHandle,
  kw: ReadWorkerKw,
): Promise<JsonDict> {
  const timeout_s = kw.timeout_s;
  const proc = handle.proc;
  const stdout = pyAttr(proc, "stdout");
  if (stdout === null || stdout === undefined) {
    // 源 579：裸 assert，无消息。
    throw new AssertionErrorP("");
  }

  const deadline = pyFloatPlus(TEAM_BACKEND_SEAMS.now(), timeout_s);

  let buf: Uint8Array = new Uint8Array(0);

  const heartbeatLost = (): boolean => (
    pyFloatMinus(TEAM_BACKEND_SEAMS.now(), handle.last_heartbeat) > WORKER_HEARTBEAT_LOST_S
    && pyAttr(proc, "returncode") === null
  );

  const lostDict = (): JsonDict => ({
    type: "fatal",
    ok: false,
    lost: true,
    error: `contact lost: no worker heartbeat for ${pyFmtFixed0(WORKER_HEARTBEAT_LOST_S)}s`,
  });

  while (TEAM_BACKEND_SEAMS.now() < deadline) {
    if (heartbeatLost()) {
      kill_process(handle.pid, { job: handle.job_handle });
      await pyMethod(proc, "wait")();
      return lostDict();
    }
    let chunk: unknown;
    try {
      chunk = await TEAM_BACKEND_SEAMS.wait_for(
        async () => pyMethod(stdout, "read")(4096),
        Math.min(1.0, Math.max(0.1, deadline - TEAM_BACKEND_SEAMS.now())),
      );
    } catch (exc) {
      if (exc instanceof TimeoutErrorP) {
        if (pyAttr(proc, "returncode") !== null) {
          break;
        }
        continue;
      }
      throw exc;
    }
    if (!pyTruth(chunk)) {
      break;
    }
    buf = bytesConcat(buf, chunk as Uint8Array);
    while (bytesContains(buf, NL_BYTE)) {
      const split = bytesSplitAt(buf, NL_BYTE);
      const rawLine = split[0];
      buf = split[1];
      const line = bytesStrip(rawLine);
      if (!pyTruth(line)) {
        continue;
      }
      let msg: unknown;
      try {
        msg = pyJsonLoads(bytesDecodeUtf8(line));
      } catch (exc) {
        if (exc instanceof JSONDecodeErrorP) {
          continue;
        }
        throw exc;
      }
      if (dGet(msg, "type") === "heartbeat") {
        handle.last_heartbeat = TEAM_BACKEND_SEAMS.now();
        continue;
      }
      if (["result", "fatal"].includes(dGet(msg, "type") as string)) {
        handle.result = msg;
        return msg as JsonDict;
      }
    }
  }

  if (heartbeatLost()) {
    kill_process(handle.pid, { job: handle.job_handle });
    await pyMethod(proc, "wait")();
    return lostDict();
  }

  let rc = pyAttr(proc, "returncode");
  if (rc === null) {
    kill_process(handle.pid, { job: handle.job_handle });
    await pyMethod(proc, "wait")();
    rc = pyAttr(proc, "returncode");
  }
  // B3：handle.result 在这一行必然为假（唯一写点紧接着就 return 了）。
  if (pyTruth(handle.result)) {
    return handle.result as JsonDict;
  }
  return {
    type: "fatal",
    ok: false,
    error: `worker exited without result (code=${pyStr(rc)})`,
  };
}

/* ── SubprocessBackend（源 735-1025） ────────────────────────────────────── */

interface BackendRunKw {
  log_path: unknown;
  timeout_s: unknown;
}

export class SubprocessBackend {
  /** 源 741：类属性，实例读它。端口用原型 getter 复现（不占实例槽位）。 */
  get backend_type(): string { return "subprocess"; }

  /** 源 747：`self._handles: dict[str, SubprocessHandle]`（保序 = 插入序）。 */
  _handles: Map<string, SubprocessHandle> = new Map();

  /** 源 751-753：恒 True（B11）。 */
  async is_available(): Promise<boolean> { return true; }

  /** 源 757-759。 */
  get_handle(backend_id: string): SubprocessHandle | null {
    const h = this._handles.get(backend_id);
    return h === undefined ? null : h;
  }

  /** 源 763-771：第一个匹配的子代理句柄。 */
  get_handle_by_subagent(subagent_id: unknown): SubprocessHandle | null {
    for (const h of this._handles.values()) {
      if (h.subagent_id === subagent_id) return h;
    }
    return null;
  }

  /**
   * 源 775-976：一次队友回合。预热优先，冷启动兜底，桥主机与预热会话在 finally 里收尾。
   *
   * BUG(port): B8（原地改写 spec.leader_endpoint）、B9（run_turn 抛时 pool_session 被复位成
   *   None，于是 release 臂永远进不去）。两条都逐字保留。
   */
  async run(spec: TeammateSpawnSpec, kw: BackendRunKw): Promise<TeammateSpawnResult> {
    const log_path = kw.log_path;
    const timeout_s = kw.timeout_s;
    let bridgeHost: AnyMod | null = null;
    let poolSession: AnyMod | null = null;
    let msg: JsonDict = {};

    const useBridge = pyTruth(spec.parent_session_id) && !(["0", "false", "no"].includes(
      pyStrip(pyStr(TEAM_BACKEND_SEAMS.env_get("OVOLVE_PERMISSION_BRIDGE", "1"))).toLowerCase()));

    if (useBridge) {
      try {
        const pb = TEAM_BACKEND_SEAMS.permissionBridgeModule();
        const LBHost = pyCtor(needAttr(pb, "LeaderBridgeHost", "permission_bridge"),
          "LeaderBridgeHost");
        bridgeHost = new LBHost(spec.parent_session_id, {
          auto_approve: pyStr(pyOr(spec.permission, "")).toLowerCase() === "auto",
        });
        await pyMethod(bridgeHost, "start")();
      } catch (exc) {
        if (!isPyException(exc)) throw exc;
        TEAM_BACKEND_SEAMS.log_debug("[subprocess] bridge host skipped: %s", [exc]);
        bridgeHost = null;
      }
    }

    if (spec.leader_endpoint === null && useBridge) {
      // B8：原地改调用方的 spec。
      spec.leader_endpoint = spec.parent_session_id;
    }

    try {
      try {
        const wp = TEAM_BACKEND_SEAMS.workerPrewarmPoolModule();
        const gwpp = pyCallable(needAttr(wp, "get_worker_prewarm_pool", "worker_prewarm_pool"),
          "get_worker_prewarm_pool");
        const pool = gwpp() as AnyMod;
        if (pyTruth(pyAttr(pool, "enabled"))) {
          poolSession = await pyMethod(pool, "acquire")() as AnyMod | null;
          if (poolSession !== null && poolSession !== undefined) {
            msg = await pyMethod(poolSession, "run_turn")(
              spec_to_worker_json(spec), { timeout_s }) as JsonDict;
            const lost = pyTruth(dGet(msg, "lost"));
            const ok = pyTruth(dGet(msg, "ok")) && !lost;
            return new TeammateSpawnResult({
              ok,
              backend_id: `${pyStr(pyOr(spec.label, spec.subagent_type))}@${pyStr(spec.parent_session_id)}`,
              backend_type: this.backend_type,
              pid: pyAttr(poolSession, "pid"),
              log_path: pyAttr(poolSession, "log_path"),
              text: pyStr(pyOr(dGet(msg, "text"), "")),
              error: pyStr(pyOr(dGet(msg, "error"), "")),
              meta: { ...(pyOr(dGet(msg, "meta"), {}) as JsonDict), prewarm: true },
              lost,
            });
          }
        }
      } catch (exc) {
        if (!isPyException(exc)) throw exc;
        // B9：这里把 pool_session 复位，外层 finally 的 release 臂就此关门。
        TEAM_BACKEND_SEAMS.log_debug("[subprocess] prewarm miss: %s", [exc]);
        poolSession = null;
      }

      const handle = await spawn_worker(spec, { log_path });
      this._handles.set(pyStr(handle.backend_id), handle);
      try {
        msg = await read_worker_until_result(handle, { timeout_s });
        const lost = pyTruth(dGet(msg, "lost"));
        const ok = pyTruth(dGet(msg, "ok")) && !lost;
        return new TeammateSpawnResult({
          ok,
          backend_id: handle.backend_id,
          backend_type: this.backend_type,
          pid: handle.pid,
          log_path,
          text: pyStr(pyOr(dGet(msg, "text"), "")),
          error: pyStr(pyOr(dGet(msg, "error"), "")),
          meta: { ...(pyOr(dGet(msg, "meta"), {}) as JsonDict) },
          lost,
        });
      } finally {
        this._handles.delete(pyStr(handle.backend_id));
        if (pyAttr(handle.proc, "returncode") === null) {
          try {
            await TEAM_BACKEND_SEAMS.wait_for(async () => pyMethod(handle.proc, "wait")(), 2.0);
          } catch (exc) {
            if (exc instanceof TimeoutErrorP) {
              kill_process(handle.pid, { job: handle.job_handle });
            } else {
              throw exc;
            }
          }
        }
        if (pyTruth(handle.job_handle)) {
          const si = TEAM_BACKEND_SEAMS.subprocessIsolationModule();
          pyCallable(needAttr(si, "close_job", "subprocess_isolation"), "close_job")(handle.job_handle);
          handle.job_handle = null;
        }
      }
    } finally {
      if (poolSession !== null) {
        try {
          const wp2 = TEAM_BACKEND_SEAMS.workerPrewarmPoolModule();
          const gwpp2 = pyCallable(needAttr(wp2, "get_worker_prewarm_pool", "worker_prewarm_pool"),
            "get_worker_prewarm_pool");
          await pyMethod(gwpp2(), "release")(poolSession, { healthy: pyTruth(dGet(msg, "ok")) });
        } catch (exc) {
          if (!isPyException(exc)) throw exc;
          // 源 969-971：except Exception: pass —— 逐字保留宽吞。
        }
      }
      if (bridgeHost !== null) {
        await pyMethod(bridgeHost, "stop")();
      }
    }
  }

  /** 源 979-999。 */
  async kill(backend_id: string): Promise<boolean> {
    const handle = this._handles.get(backend_id);
    if (handle === undefined) {
      return false;
    }
    kill_process(handle.pid, { job: handle.job_handle });
    if (pyTruth(handle.job_handle)) {
      const si = TEAM_BACKEND_SEAMS.subprocessIsolationModule();
      pyCallable(needAttr(si, "close_job", "subprocess_isolation"), "close_job")(handle.job_handle);
      handle.job_handle = null;
    }
    this._handles.delete(backend_id);
    return true;
  }

  /** 源 1003-1011：原样返回 is_process_running 的结果。 */
  async is_alive(backend_id: string): Promise<boolean> {
    const handle = this._handles.get(backend_id);
    if (handle === undefined) {
      return false;
    }
    return is_process_running(handle.pid);
  }

  /** 源 1015-1025：任一属于该父会话的句柄还活着。 */
  any_alive_for_parent(parent_session_id: unknown): boolean {
    const prefix = `@${pyStr(parent_session_id)}`;
    for (const [bid, handle] of this._handles.entries()) {
      if (bid.endsWith(prefix) && pyTruth(is_process_running(handle.pid))) {
        return true;
      }
    }
    return false;
  }
}

// PORT STATUS: 本文件无 TODO(port)。
