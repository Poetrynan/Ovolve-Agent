/**
 * worker_prewarm_pool.ts — 源：app/backend/worker_prewarm_pool.py（395 行 / 7565 字节）。
 * 单元 212 / wave-9，manifest target=TS。F5 M4c：sidecar 子进程预热池。
 *
 * 保持 N 个空闲的 ``ovolve_subagent_worker --sidecar`` 进程“热”，避免每次 spawn
 * 1–3s 冷启动；池 miss 时回退一次性 spawn（M4a 行为）。
 *
 * ── 源码自带缺陷：逐字复制、只标注不修（RULEBOOK §2 BUG 规则；w212 探针逐条钉死）──
 *  F1 acquire() 的回退 spawn 用 `entry.uses = 1`（**赋值**，不是 +=1），且无条件
 *     append —— 池长可以无界超过 pool_size（只有 health loop / release 的失败臂会删）。
 *  F2 acquire() 对 `_closed` 条目只 `continue` 跳过，**从不删除**；死条目一直躺在
 *     _entries 里，直到健康循环或某次 release 把它筛掉。
 *  F3 release() 先查一次 `next(...)`，缺了才 append，然后**再查一次** `next(...)`，
 *     并用 `if entry:`（实例真值，dataclass 实例恒真）而不是 `is not None`。
 *  F4 ensure_started() 在 `_fill_to_target()` **之前**就置 `_started = True`：即使
 *     全部 spawn 失败，池也“已启动”，health task 照样创建，后续 acquire 每次都走
 *     回退 spawn。二次进入的 double-check 是活的（锁内再判一次）。
 *  F5 shutdown() **不清空 _health_task**：第二次 shutdown 会对同一个已取消任务再
 *     cancel + await 一遍；`entry.session.close(kill=True)` 在 try **外面**——close
 *     抛异常会中断循环、_entries 不被 clear、_started 不被复位。
 *  F6 _health_loop 没有任何顶层 try：一次 ping/close 抛异常就让循环任务悄然死亡
 *     （CPython 只把未取用的 task 异常打条日志），池从此不再自愈。
 *  F7 stderr 日志文件每次 _spawn_idle 都以 append 打开且**从不关闭**（源码
 *     `# noqa: SIM115` 就是作者自认）；spawn 失败臂里同样泄漏。
 *  F8 env 构造：PYTHONPATH 用 `(_BACKEND_DIR + pathsep + old).rstrip(pathsep)`
 *     ——只剔右侧分号；PYTHONUNBUFFERED 走 **setdefault**（已有 "0" 会保留！），
 *     而 OVOLVE_WORKER_SIDECAR / OVOLVE_WORKER_KIND 是强制覆盖。
 *  F9 句柄守卫只查 `stdin / stdout / pid is None`，**不查 stderr**（stderr 是自己
 *     open 的文件句柄）；该臂 close 了 job 但 F7 的文件句柄照旧泄漏。
 * F10 `create_worker_job()` 可以返回 None/0（非 nt 或创建失败）——所有 close_job /
 *     assign 分支都过 `if job:`（真值）；`assign_pid_to_job` 返回假时 close_job 并把
 *     job **置 None**，session 以 job_handle=None 继续跑（无 job 护栏的子进程）。
 * F11 release(session=None) 在拿锁之前就 return；但 session 非 None 时 release **从不
 *     检查 enabled**：禁用池（size=0）里 `len(entries) >= 0*2` 恒真，每次 release 都
 *     走“杀掉+出池”臂。
 * F12 DEFAULT_POOL_SIZE / PREWARM_HEALTH_S 在 **import 期**读一次环境变量；
 *     get_worker_prewarm_pool() 的 `_pool` 全局缓存永不重置。
 * F13 import 期 `int(os.environ.get("OVOLVE_WORKER_POOL_SIZE","0"))`：非数字直接让
 *     模块 import 抛 ValueError；HEALTH_S 的 float() 同理（文案逐字，w212_env 钉）。
 * F14 _fill_to_target 首次 spawn 失败即 break（同一轮不重试）。
 * F15 enabled 严格 `pool_size > 0`；构造器 `max(0, int(pool_size))`：负数截 0、
 *     2.7 截 2、"4" 转 4（int() 的截断/字符串语义全保留）。
 *
 * ── 接缝（红线 5：探针把每一处外部触碰换成记录型假件，spawn/clock/queue/file 全虚拟）──
 * WPP_SEAMS：now / env_get / environ / backendDir / sysExecutable / subprocessPipe /
 * pathsep / makedirs / openAppend / create_subprocess_exec / sleep / createTask /
 * subprocessIsolationModule / workerSidecarModule / createPool / log_warning。
 * 生产默认 = 真行为（spawn/fs/logger），探针一律替换；**没有任何真实子进程、真实
 * 端口、真实文件、真实 sleep 在探针里发生**。create_subprocess_exec 的 argv 与**完整
 * opts 字典**（stdin/stdout/stderr/env + 源文件 `**popen_isolation_kwargs()` 展开的
 * creationflags，逐键）都进账本，guardctl 对每一行 spawn 记录断言端口与源文件同型。
 *
 * 兄弟模块（3 文件 import 环的成员）全部走**函数级装载 seam**，与 team_collab.ts 对
 * mailbox/storage/subagent_runtime 的处理一字一意：
 *   - worker_sidecar（单元 213，Native→Rust，未落地）：`workerSidecarModule()` 缺省臂
 *     抛 `ModuleNotFoundError("No module named 'worker_sidecar'")`——与 ovolve_subagent_worker.ts:693
 *     的既有约定完全一致（那边也是 throw 这条臂）。探针两侧注入记录型假 SidecarSession。
 *   - subprocess_isolation（单元 209，Native→Rust，TS 侧无同名文件）：
 *     `subprocessIsolationModule()` 缺省臂同 team_collab.ts 对 mailbox 的缺省臂。
 *     探针注入假模块（create_worker_job / popen_isolation_kwargs / assign_pid_to_job /
 *     close_job），python 侧走 sys.modules 假件 + _Blocker meta_path finder。
 *   - teammate_backend / ovolve_subagent_worker：本模块只以 `"-m",
 *     "ovolve_subagent_worker"` 的 argv 形式触碰（进 spawn 账本），没有静态 import。
 *
 * ── 本文件的确定性折叠（探针两侧同规则，w212 文档见 verified/worker_prewarm_pool.json）──
 *   1. 时钟   : `time.time()` 全部过 now() seam。源里 `field(default_factory=time.time)`
 *              在**类定义期**就绑定了函数对象——python 探针因此在 import 前把假 time 模块
 *              装进 sys.modules，绑定的就是假函数；TS 侧构造期动态调 seam，观测等价。
 *   2. spawn  : `asyncio.create_subprocess_exec(*argv, **kw)` → seam，argv+opts 全记账。
 *   3. 队列/池: _entries 是内存数组，两侧同源；锁是进程内 promise-mutex，不外触。
 *   4. 任务   : `asyncio.create_task` → createTask seam（生产默认 SubagentTask，单元 195）；
 *              `task.cancel()` 记账；`await task` → `task.join()`（fold D4）。
 *   5. 睡眠   : `asyncio.sleep(PREWARM_HEALTH_S)` → sleep seam；探针在第 N 次抛出
 *              RuntimeError("probe unroll stop") 来展开 while True（两侧同一脚本）。
 *   6. 文件   : `open(log_path,"a",encoding="utf-8")` / `os.makedirs(...,exist_ok=True)`
 *              → seam，(path, mode, opts) 逐字记账（含源文件的关键字与值）。
 *   7. kwargs : python 关键字参数在 TS 侧是尾随 options 对象，假件按 __kw__ 记账（house D3）。
 *   8. int/float: CPython 类型标签由 codec 强制（idle_since→__f__、uses→__i__、
 *              ping 的 timeout_s→__f__），JS 无 int/float 之分不外溢。
 *   9. 日志   : `log.warning(fmt, exc)` 的 %s 惰性渲染归宿主 logger，seam 只收
 *              (fmt, args) 不预渲染（house 规则，同 permission_bridge / moa / team_collab）。
 *
 * DIVERGENCE(port, 模块目录): 源在 **import 期**算 `_BACKEND_DIR =
 *   dirname(abspath(__file__))`；端口把同一条“模块自身目录”规则放进 backendDir seam，
 *   生产值天然是 app/engine（目标语言目录），python 侧是 app/backend。该字符串本身
 *   是平台/语言相关量，探针两侧钉成同一字面量，join/makedirs/open 的逐字节行为仍全比对。
 * DIVERGENCE(port, ntpath): os.path.join / os.path.dirname 是 CPython ntpath 的逐行移植
 *   （沿用 worktree_manager.ts / red_team_patrol.ts 已验证实现：盘符/UNC/`C:` 驱动器
 *   相对不插分隔符、绝对第二段整体替换；dirname=split(p)[0]），分隔符硬编码 `\\`、
 *   pathsep 硬编码 ";"（目标平台 win32）。python 探针用**真 ntpath** 跑同一表达式，
 *   join 结果写进 open/SidecarSession 账本行，两侧必须逐字节一致。
 * DIVERGENCE(port, except Exception): `except Exception` 建模为
 *   `e instanceof Error && !(e instanceof CancelledErrorP)` —— CPython 3.8+ 里
 *   CancelledError 继承 BaseException，**不被** except Exception 捕获；探针专门钉
 *   这一条边界（spawn 抛 CancelledError 不吞、shutdown 的 session.shutdown 抛
 *   CancelledError 直接穿出）。
 * DIVERGENCE(port, 单例可观察性): get_worker_prewarm_pool 的构造走 createPool seam
 *   （生产默认 `new WorkerPrewarmPool()`，与源同型）；python 探针重绑模块全局
 *   WorkerPrewarmPool 记一行 pool_ctor，TS 探针替换 seam——账本行两侧同一形状。
 * DIVERGENCE(port, import 期 env): DEFAULT_POOL_SIZE/PREWARM_HEALTH_S 在模块装载期
 *   读 env（源 39/41 行），TS 顶层同规则；一个值一个**全新受保护进程**的双侧对齐由
 *   tmp/w212_env.mjs 覆盖。int()/float() 的拒绝文案（ValueError/TypeError）逐字保留。
 *
 * 本文件零 TODO(port)。
 */

import * as fs from "node:fs";
import * as fspath from "node:path";
import * as cp from "node:child_process";
import { fileURLToPath } from "node:url";
import { SUBAGENT_ERRORS, SubagentTask } from "./subagent_runtime.js";

type JsonDict = Record<string, unknown>;
type AnyMod = Record<string, any>;

/* ── CPython 语义小工具（本仓惯例：每个文件自带一份） ─────────────────────── */

const ImportErrorP = SUBAGENT_ERRORS.ImportErrorP;
const ModuleNotFoundErrorP = SUBAGENT_ERRORS.ModuleNotFoundErrorP;
const ValueErrorP = SUBAGENT_ERRORS.ValueErrorP;
const TypeErrorP = SUBAGENT_ERRORS.TypeErrorP;
const CancelledErrorP = SUBAGENT_ERRORS.CancelledErrorP;
const RuntimeErrorP = SUBAGENT_ERRORS.RuntimeErrorP;

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
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

function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  let s = String(x);
  if (!/[.eE]/.test(s)) s += ".0";
  return s;
}

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
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (typeof v === "object") {
    const r = (v as { __repr__?: () => string }).__repr__;
    if (typeof r === "function") return r.call(v);
    return "{" + Object.entries(v as JsonDict).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ") + "}";
  }
  return String(v);
}

/** python `str(x)`（f-string 插值走这里）。 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  return pyRepr(v);
}

/** python `bool(x)`。 */
function pyTruth(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (typeof v === "object" || typeof v === "function") return true; // 类实例恒真（F3）
  return Boolean(v);
}

/** python `str.strip()` 的 ASCII 空白子集（env 值域内与 CPython 一致；见 env harness 取值域）。 */
function pyStrip(s: string): string { return s.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, ""); }

/** python `s.rstrip(chars)`：按字符集从右剥。 */
function pyRstrip(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s.charAt(end - 1))) end -= 1;
  return s.slice(0, end);
}

/** python `float(x)`（import 期 HEALTH_S 与探针构造面；拒绝文案逐字）。 */
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

/** python `int(x)`：字符串按 base-10（拒绝文案逐字），浮点向零截断。 */
function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (Number.isNaN(v)) throw new ValueErrorP("cannot convert float NaN to integer");
    if (!Number.isFinite(v)) {
      const e = new Error("cannot convert float infinity to integer");
      e.name = "OverflowError";
      throw e;
    }
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const t = pyStrip(v).replace(/_/g, "");
    if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
    throw new ValueErrorP(`invalid literal for int() with base 10: ${pyRepr(v)}`);
  }
  throw new TypeErrorP(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

/** python `max(0, x)`（两操作数；平手取先，数值上等价 Math.max）。 */
function pyMax0(x: number): number { return Math.max(0, x); }

/** python `dict.setdefault(k, d)`。 */
function pySetdefault(obj: JsonDict, k: string, d: unknown): unknown {
  if (!Object.prototype.hasOwnProperty.call(obj, k)) obj[k] = d;
  return obj[k];
}

/** python `dict.get(k, d)`（env 值域为字符串/未设）。 */
function pyDictGet(obj: JsonDict, k: string, d: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : d;
}

/** python `next((e for e in xs if pred(e)), None)` 的定点用法（release 的双查）。 */
function pyNextEntry(entries: _PoolEntry[], session: unknown): _PoolEntry | null {
  for (const e of entries) if (e.session === session) return e;
  return null;
}

/* ── python 函数局部 import 的存在性检查（缺名 -> CPython 原文案，逐名按书写顺序） ── */

function needAttr(mod: AnyMod, name: string, from: string): unknown {
  if (!(name in mod)) {
    const origin = typeof mod.__origin__ === "string" ? mod.__origin__ : "(unknown location)";
    throw new ImportErrorP(`cannot import name '${name}' from '${from}' (${origin})`);
  }
  return mod[name];
}

/** 源里 `except Exception` 能抓到的那一族（CancelledError 属 BaseException，不抓）。 */
function isPyException(e: unknown): boolean {
  return e instanceof Error && !(e instanceof CancelledErrorP);
}

/* ── CPython 3.13 ntpath：join / splitroot / split / dirname 的逐行移植 ────── */

const NTP_SEP = "\\";
const NTP_SEPS = "\\/";
const NTP_COLON_SEPS = ":\\/";

type SplitRoot = [string, string, string];

function ntpSplitroot(p: string): SplitRoot {
  const uncPrefix = "\\\\?\\UNC\\";
  const empty = "";
  const normp = p.split("/").join(NTP_SEP);
  if (normp.slice(0, 1) === NTP_SEP) {
    if (normp.slice(1, 2) === NTP_SEP) {
      const start = normp.slice(0, 8).toUpperCase() === uncPrefix ? 8 : 2;
      const index = normp.indexOf(NTP_SEP, start);
      if (index === -1) return [p, empty, empty];
      const index2 = normp.indexOf(NTP_SEP, index + 1);
      if (index2 === -1) return [p, empty, empty];
      return [p.slice(0, index2), p.slice(index2, index2 + 1), p.slice(index2 + 1)];
    }
    return [empty, p.slice(0, 1), p.slice(1)];
  }
  if (normp.slice(1, 2) === ":") {
    if (normp.slice(2, 3) === NTP_SEP) {
      return [p.slice(0, 2), p.slice(2, 3), p.slice(3)];
    }
    return [p.slice(0, 2), empty, p.slice(2)];
  }
  return [empty, empty, p];
}

function ntpJoinRaw(a: string, b: string): string {
  let [resultDrive, resultRoot, resultPath] = ntpSplitroot(a);
  const [pDrive, pRoot, pPath] = ntpSplitroot(b);
  if (pRoot) {
    if (pDrive || !resultDrive) resultDrive = pDrive;
    resultRoot = pRoot;
    resultPath = pPath;
  } else if (pDrive && pDrive !== resultDrive) {
    if (pDrive.toLowerCase() !== resultDrive.toLowerCase()) {
      resultDrive = pDrive;
      resultRoot = pRoot;
      resultPath = pPath;
    } else {
      resultDrive = pDrive;
    }
  } else {
    if (resultPath && !NTP_SEPS.includes(resultPath.slice(-1))) {
      resultPath = resultPath + NTP_SEP;
    }
    resultPath = resultPath + pPath;
  }
  if (resultPath && !resultRoot && resultDrive
    && !NTP_COLON_SEPS.includes(resultDrive.slice(-1))) {
    return resultDrive + NTP_SEP + resultPath;
  }
  return resultDrive + resultRoot + resultPath;
}

/** python `os.path.join(a, b, c, ...)`：ntpath.join 的内循环就是左折叠二元 join。 */
function ntpJoin(...parts: string[]): string {
  const head = parts[0] as string;
  return parts.slice(1).reduce((acc: string, p: string) => ntpJoinRaw(acc, p), head);
}

/** python ntpath.split(p) -> [head, tail]（3.13 逐行）。 */
function ntpSplit(p: string): [string, string] {
  const [d, r, rest] = ntpSplitroot(p);
  let i = rest.length;
  while (i > 0 && !NTP_SEPS.includes(rest.charAt(i - 1) as string)) i -= 1;
  const headRaw = rest.slice(0, i);
  const tail = rest.slice(i);
  let head = headRaw;
  while (head.length > 0 && NTP_SEPS.includes(head.charAt(head.length - 1) as string)) {
    head = head.slice(0, head.length - 1);
  }
  return [d + r + head, tail];
}

/** python `os.path.dirname(p)` == ntpath.split(p)[0]。 */
function ntpDirname(p: string): string { return ntpSplit(p)[0]; }

/* ── python asyncio.Lock 的镜像：promise-queue mutex（house 先例 messaging.ts） ── */

class AsyncLock {
  private _locked = false;
  private _waiters: Array<() => void> = [];
  async acquire(): Promise<void> {
    if (!this._locked) { this._locked = true; return; }
    await new Promise<void>((resolve) => { this._waiters.push(resolve); });
  }
  release(): void {
    const w = this._waiters.shift();
    if (w) { w(); return; }
    this._locked = false;
  }
}

/* ── 接缝 ─────────────────────────────────────────────────────────────────── */

/** 目标语言的“模块自身目录”（生产值天然是 app/engine，见头部 DIVERGENCE 模块目录）。 */
const MODULE_DIR = fspath.dirname(fileURLToPath(import.meta.url));

/** create_subprocess_exec 的账本可见返回面（源只用 proc.stdin / proc.stdout / proc.pid）。 */
export type SpawnProc = { stdin: unknown; stdout: unknown; pid: number | null };
/** 账本可见的任务面（cancel + join；join 即 python 的 `await task`，fold D4）。 */
export type TaskLike = { cancel(): unknown; join(): Promise<unknown> };

export const WPP_SEAMS = {
  /** python `time.time()`。 */
  now: (): number => Date.now() / 1000,
  /** python `os.environ.get(k, d)`（import 期两常量用）。 */
  env_get: (k: string, d: unknown = undefined): unknown =>
    Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : d,
  /** python `dict(os.environ)`。 */
  environ: (): JsonDict => ({ ...process.env } as JsonDict),
  /** python `_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))`。 */
  backendDir: (): string => MODULE_DIR,
  /** python `sys.executable`。 */
  sysExecutable: (): string => process.execPath,
  /** python `asyncio.subprocess.PIPE` 的端口语义词（生产 spawn 用它映射 stdio）。 */
  subprocessPipe: (): unknown => "pipe",
  /** python `os.pathsep`（目标平台 win32 = ";"，见头部 DIVERGENCE ntpath）。 */
  pathsep: ";",
  /** python `os.makedirs(p, exist_ok=True)`；opts 逐字携带源关键字进账本。 */
  makedirs: (p: string, opts: JsonDict): void => {
    void opts; // exist_ok=True 的幂等语义 == fs.mkdirSync(recursive) 吞 EEXIST
    fs.mkdirSync(p, { recursive: true });
  },
  /** python `open(log_path, "a", encoding="utf-8")` —— 返回**泄漏**的句柄（F7）。 */
  openAppend: (p: string, mode: string, opts: JsonDict): unknown => {
    void mode; void opts;
    return fs.openSync(p, "a");
  },
  /**
   * python `asyncio.create_subprocess_exec(exe, "-m", _WORKER_MODULE, "--sidecar",
   * stdin=PIPE, stdout=PIPE, stderr=open(...), env=env, **popen_isolation_kwargs())`。
   * 默认实现走**真 spawn（仅生产路径）**；探针必替换（红线 5：零真子进程）。
   */
  create_subprocess_exec: async (argv: string[], opts: JsonDict): Promise<SpawnProc> => {
    const pipe = WPP_SEAMS.subprocessPipe();
    const stderr = typeof opts.stderr === "number" ? (opts.stderr as number) : "ignore";
    const child = cp.spawn(argv[0] as string, argv.slice(1), {
      stdio: [opts.stdin === pipe ? "pipe" : "ignore", opts.stdout === pipe ? "pipe" : "ignore", stderr],
      env: (opts.env ?? undefined) as NodeJS.ProcessEnv | undefined,
      windowsHide: Number(opts.creationflags ?? 0) !== 0,
    });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      pid: child.pid === undefined ? null : child.pid,
    };
  },
  /** python `asyncio.sleep(s)`。 */
  sleep: async (s: number): Promise<void> => {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.max(s, 0) * 1000);
      (t as unknown as { unref?: () => void }).unref?.();
    });
  },
  /** python `asyncio.create_task(coro)` —— 生产默认镜像单元 195 的 SubagentTask。 */
  createTask: (fn: () => Promise<unknown>): TaskLike => {
    const t = new SubagentTask(fn);
    return { cancel: () => t.cancel(), join: () => t.join() };
  },
  /**
   * python 函数级 `from subprocess_isolation import ...` —— 该模块是 Native→Rust
   * （ovolve_core.subprocess_isolation，单元 209），TS 侧无同名文件；缺省臂与
   * team_collab.ts 对 mailbox 的缺省臂一字一致。
   */
  subprocessIsolationModule: (): AnyMod => {
    throw new ModuleNotFoundErrorP("No module named 'subprocess_isolation'");
  },
  /**
   * python 函数级 `from worker_sidecar import SidecarSession` —— 单元 213
   * （Native→Rust）尚未落地；缺省臂与 ovolve_subagent_worker.ts:693 一字一致。
   */
  workerSidecarModule: (): AnyMod => {
    throw new ModuleNotFoundErrorP("No module named 'worker_sidecar'");
  },
  /** python 源里 `WorkerPrewarmPool()` 的构造位（单例可观察性折叠，见头部）。 */
  createPool: (): WorkerPrewarmPool => new WorkerPrewarmPool(),
  /** python `log.warning(fmt, *args)`：`%s` 渲染归宿主 logger，不预渲染。 */
  log_warning: (fmt: string, args: unknown[]): void => {
    console.error(`[prewarm] ${fmt} ${args.map((a) => (a instanceof Error ? a.message : pyStr(a))).join(" ")}`);
  },
};

/* ── import 期常量（源 39/41 行：F12/F13 的读取时机原样保留） ─────────────── */

export const _WORKER_MODULE = "ovolve_subagent_worker";

/** DIVERGENCE(port, import env)：装载期求值 + 非数字直接砸 import —— 与源同规则。 */
export const DEFAULT_POOL_SIZE: number = pyInt(WPP_SEAMS.env_get("OVOLVE_WORKER_POOL_SIZE", "0"));

export const PREWARM_HEALTH_S: number = pyFloat(WPP_SEAMS.env_get("OVOLVE_WORKER_POOL_HEALTH_S", "30"));

/* ── _PoolEntry（源 47-55 行的 dataclass） ────────────────────────────────── */

export class _PoolEntry {
  session: unknown;
  idle_since: number;
  uses: number;
  constructor(session: unknown, idle_since?: number, uses: number = 0) {
    this.session = session;
    // 源: field(default_factory=time.time) —— 类定义期绑定；探针在 import 前装假
    // time 模块，两侧构造时刻都记 ["time.time", __f__] 行（折叠 1）。
    this.idle_since = idle_since === undefined ? WPP_SEAMS.now() : idle_since;
    this.uses = uses;
  }
}

/* ── WorkerPrewarmPool（源 61-373 行） ────────────────────────────────────── */

/** 源: `class WorkerPrewarmPool: """Process pool of warm sidecar workers."""` */
export class WorkerPrewarmPool {
  pool_size: number;
  _entries: _PoolEntry[];
  _lock: AsyncLock;
  _started: boolean;
  _health_task: TaskLike | null;

  constructor(pool_size: unknown = DEFAULT_POOL_SIZE) {
    // F15: max(0, int(pool_size)) —— 截断/字符串/异常文案全保留。
    this.pool_size = pyMax0(pyInt(pool_size));
    this._entries = [];
    this._lock = new AsyncLock();
    this._started = false;
    this._health_task = null;
  }

  get enabled(): boolean {
    return this.pool_size > 0;
  }

  /** 源 89-105 行。F4: `_started` 在 fill **之前**置位。 */
  async ensure_started(): Promise<void> {
    if (this._started || !this.enabled) {
      return;
    }
    await this._lock.acquire();
    try {
      if (this._started) {
        return;
      }
      this._started = true;
      await this._fill_to_target();
      this._health_task = WPP_SEAMS.createTask(() => this._health_loop());
    } finally {
      this._lock.release();
    }
  }

  /** 源 109-119 行。F14: 首次 spawn 失败即 break。 */
  async _fill_to_target(): Promise<void> {
    while (this._entries.length < this.pool_size) {
      const entry = await this._spawn_idle();
      if (entry === null) {
        break;
      }
      this._entries.push(entry);
    }
  }

  /**
   * 源 123-229 行。F7/F9/F10 全在这一段；spawn 的 argv+opts 逐键进账本（红线 5）。
   */
  async _spawn_idle(): Promise<_PoolEntry | null> {
    // 源 125 行的函数级 import（书写顺序即缺名报错顺序）。
    const si = WPP_SEAMS.subprocessIsolationModule();
    const assign_pid_to_job = needAttr(si, "assign_pid_to_job", "subprocess_isolation") as
      ((pid: number, job: unknown) => unknown);
    const create_worker_job = needAttr(si, "create_worker_job", "subprocess_isolation") as
      (() => unknown);
    const popen_isolation_kwargs = needAttr(si, "popen_isolation_kwargs", "subprocess_isolation") as
      (() => JsonDict);
    // 源 127 行 `from worker_sidecar import SidecarSession`：CPython 在函数体**任何其它
    // 语句之前**就把两条 import 全部解析完（缺名/缺模块在此立刻砸），故装载点紧跟 si 之后、
    // backendDir/join/makedirs 之前——与源 125-127 行的书写顺序逐字对齐。
    const ws = WPP_SEAMS.workerSidecarModule();
    const SidecarSessionCtor = needAttr(ws, "SidecarSession", "worker_sidecar") as
      (new (kw: JsonDict) => AnyMod);
    const backend_dir = WPP_SEAMS.backendDir();

    const log_path = ntpJoin(
      backend_dir, ".ovolve", "prewarm-logs",
      `prewarm-${pyStr(pyInt(WPP_SEAMS.now() * 1000))}.log`,
    );
    WPP_SEAMS.makedirs(ntpDirname(log_path), { exist_ok: true });
    const env: JsonDict = WPP_SEAMS.environ();
    env["PYTHONPATH"] = pyRstrip(
      backend_dir + WPP_SEAMS.pathsep + pyStr(pyDictGet(env, "PYTHONPATH", "")),
      WPP_SEAMS.pathsep,
    );
    pySetdefault(env, "PYTHONUNBUFFERED", "1");
    env["OVOLVE_WORKER_SIDECAR"] = "1";
    env["OVOLVE_WORKER_KIND"] = "sidecar";

    let job: unknown = create_worker_job();
    let proc: SpawnProc;
    try {
      // F7 泄漏点：源在 try 内求值 stderr=open(...)（open 失败也砸进 except 臂），
      // 且 argv+kwargs 先于 open 求值——这里保持 open 在 opts 对象字面量之前构造。
      const logFile = WPP_SEAMS.openAppend(log_path, "a", { encoding: "utf-8" });
      proc = await WPP_SEAMS.create_subprocess_exec(
        [WPP_SEAMS.sysExecutable(), "-m", _WORKER_MODULE, "--sidecar"],
        {
          stdin: WPP_SEAMS.subprocessPipe(),
          stdout: WPP_SEAMS.subprocessPipe(),
          stderr: logFile,
          env,
          ...popen_isolation_kwargs(),
        },
      );
    } catch (exc: unknown) {
      if (!isPyException(exc)) throw exc; // CancelledError 不吞（见头部 DIVERGENCE）
      WPP_SEAMS.log_warning("[prewarm] spawn failed: %s", [exc]);
      if (pyTruth(job)) {
        const si2 = WPP_SEAMS.subprocessIsolationModule();
        const close_job = needAttr(si2, "close_job", "subprocess_isolation") as
          ((job: unknown) => unknown);
        close_job(job);
      }
      return null;
    }

    // F9: 只查 stdin/stdout/pid，不查 stderr。
    if (proc.stdin === null || proc.stdout === null || proc.pid === null) {
      if (pyTruth(job)) {
        const si2 = WPP_SEAMS.subprocessIsolationModule();
        const close_job = needAttr(si2, "close_job", "subprocess_isolation") as
          ((job: unknown) => unknown);
        close_job(job);
      }
      return null;
    }

    // F10: 挂不上 job 就弃 job（close_job + job=None），session 裸奔继续。
    if (pyTruth(job) && !pyTruth(assign_pid_to_job(proc.pid, job))) {
      const si2 = WPP_SEAMS.subprocessIsolationModule();
      const close_job = needAttr(si2, "close_job", "subprocess_isolation") as
        ((job: unknown) => unknown);
      close_job(job);
      job = null;
    }

    const session = new SidecarSessionCtor({
      proc, pid: proc.pid, log_path, job_handle: job,
    });
    await (session as AnyMod).start_reader();
    if (!pyTruth(await (session as AnyMod).ping({ timeout_s: 5.0 }))) {
      await (session as AnyMod).close({ kill: true });
      return null;
    }
    return new _PoolEntry(session);
  }

  /** 源 233-267 行。F1/F2/F4 的回退臂。 */
  async acquire(): Promise<unknown> {
    if (!this.enabled) {
      return null;
    }
    await this.ensure_started();
    await this._lock.acquire();
    try {
      for (const entry of this._entries) {
        if (pyTruth((entry.session as AnyMod)._closed)) {
          continue; // F2: 跳过但**不删**
        }
        entry.uses = entry.uses + 1;
        entry.idle_since = 0.0; // 哨兵 0.0（falsy 但保留，见账本）
        return entry.session;
      }
      const entry = await this._spawn_idle();
      if (entry === null) {
        return null;
      }
      entry.uses = 1; // F1: 赋值不是自增
      this._entries.push(entry); // F1: 无条件 append，池可超限
      return entry.session;
    } finally {
      this._lock.release();
    }
  }

  /** 源 271-309 行。F3/F11。 */
  async release(session: unknown, kw: JsonDict = {}): Promise<void> {
    const healthy = kw.healthy === undefined ? true : kw.healthy;
    if (session === null) {
      return; // F11: 拿锁之前就 return
    }
    await this._lock.acquire();
    try {
      if (!pyTruth(healthy) || this._entries.length >= this.pool_size * 2) {
        await (session as AnyMod).close({ kill: true });
        this._entries = this._entries.filter((e) => e.session !== session);
        return;
      }
      let entry = pyNextEntry(this._entries, session);
      if (entry === null) {
        this._entries.push(new _PoolEntry(session));
      }
      entry = pyNextEntry(this._entries, session); // F3: 第二次 next（append 后必命中，仍按源用真值判定）
      if (pyTruth(entry)) {                        // F3: 实例真值判定（dataclass 实例恒真）
        (entry as _PoolEntry).idle_since = WPP_SEAMS.now();
      }
      const alive = await (session as AnyMod).ping({ timeout_s: 2.0 });
      if (!pyTruth(alive)) {
        await (session as AnyMod).close({ kill: true });
        this._entries = this._entries.filter((e) => e.session !== session);
        await this._fill_to_target();
      }
    } finally {
      this._lock.release();
    }
  }

  /** 源 313-339 行。F6: 无顶层 try；探针用 sleep seam 第 N 次抛出展开 while True。 */
  async _health_loop(): Promise<void> {
    for (;;) {
      await WPP_SEAMS.sleep(PREWARM_HEALTH_S);
      await this._lock.acquire();
      try {
        const survivors: _PoolEntry[] = [];
        for (const entry of this._entries) {
          if (pyTruth((entry.session as AnyMod)._closed)) {
            continue;
          }
          if (!pyTruth(await (entry.session as AnyMod).ping({ timeout_s: 2.0 }))) {
            await (entry.session as AnyMod).close({ kill: true });
            continue;
          }
          survivors.push(entry);
        }
        this._entries = survivors;
        await this._fill_to_target();
      } finally {
        this._lock.release();
      }
    }
  }

  /** 源 343-373 行。F5。 */
  async shutdown(): Promise<void> {
    if (pyTruth(this._health_task)) {
      (this._health_task as TaskLike).cancel();
      try {
        await (this._health_task as TaskLike).join(); // fold D4（await task）
      } catch (e: unknown) {
        if (e instanceof CancelledErrorP) {
          /* pass */
        } else {
          throw e;
        }
      }
    }
    await this._lock.acquire();
    try {
      for (const entry of this._entries) {
        try {
          await (entry.session as AnyMod).shutdown({ reason: "pool_shutdown" });
        } catch (e: unknown) {
          if (!isPyException(e)) throw e;
        }
        await (entry.session as AnyMod).close({ kill: true }); // F5: 在 try 外
      }
      this._entries.length = 0; // list.clear() —— 原地清（别名可见）
    } finally {
      this._lock.release();
    }
    this._started = false;
  }
}

/* ── 模块级单例（源 379-393 行；F12） ─────────────────────────────────────── */

let _pool: WorkerPrewarmPool | null = null;

export function get_worker_prewarm_pool(): WorkerPrewarmPool {
  if (_pool === null) {
    _pool = WPP_SEAMS.createPool();
  }
  return _pool;
}

// 供探针/生产替换 RuntimeError 镜像引用的最小导出面（单元 195 类族复用）。
export const _WPP_ERRORS = { RuntimeErrorP };

// PORT STATUS: 本文件无 TODO(port)。
