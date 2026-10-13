/**
 * red_team_patrol.ts — 学习产物红队巡逻（Phase 36）
 *
 * Ported bug-for-bug from `app/backend/red_team_patrol.py` (172 lines, wave-10,
 * unit 215). 命名、默认值、异常类型/文案、fail-open 纪律逐条对齐；源文件自身的
 * 缺陷原样保留（见下），本文件零 TODO(port)。
 *
 * BUG-FOR-BUG FACTS (pinned by the w215 parity probe)
 *   1. `_extract_learned_rules(path)`：`open(path, encoding="utf-8",
 *      errors="replace")` 只兜 **OSError**（FileNotFoundError / IsADirectoryError
 *      / PermissionError → 返回 []）；`path` 不是 str 时 CPython 的
 *      `TypeError: expected str, bytes or os.PathLike object, not int`
 *      **不被捕获**，一路上抛。小节判定是 `line.strip().startswith(...)`：任何以
 *      `## ` 开头的行都切换 `in_section`，且判定是 **startswith** 而非相等
 *      （`"## Learned Rules (evolution) 备注"` 也算命中）。取条目用
 *      `line.strip()[2:]`——**先 strip 再按码点切**。
 *   2. `_audit_targets(router)`：`ws = getattr(router,"workspace","") or ""`
 *      ——缺失/None/0/False/[] 一律退化成 ""（整段跳过）。三个引导文件名固定。
 *      **`os.path.join(ws, name)` 在 skills 的 try 之外**：`ws` 是非 str（例如
 *      int / list / bytes）时 TypeError 直接冲出 `_audit_targets`，技能分支根本没
 *      机会跑（源文件如此，不修）。技能分支里 `loader.list_skills()` 的返回值走
 *      `or []`——返回 str 会被 for-in **按字符迭代**、返回 dict 会迭代键；
 *      `desc = str(getattr(entry,"description","") or "")`：0/False/None/[]/{}
 *      退化成 ""，非空 list 变成 "['a']"；标签 f-string 用 `str()` 渲染 name，
 *      于是 `name=True` → `"skill:True"`、`name=None` → `"skill:None"`、
 *      缺键 → `"skill:?"`。任何异常 → `except Exception: pass`，**已收集的
 *      workspace 条目照样返回**。
 *   3. `_run_scan(router)`：`from red_team import get_red_team` 是**函数体内
 *      导入**（每次调用都走一遍导入路径），且在 try 之外——导入失败/`get_red_team()`
 *      本身抛错会直接冲出 `_run_scan`。`rt = get_red_team()` 同样在 try 之外。
 *      每条目标先 `if not sample.strip(): continue`（`\x1c` 之类 CPython 视为
 *      空白 → 整条跳过）。`hits = rt.scan(sample)` 与 `rt.is_injection(sample)`
 *      共享受保护 try：is_injection 抛错等于该目标整条丢弃并打
 *      `scan error on %s: %s` 日志后 continue。合成命中的形态固定为
 *      `{"category": "injection", "matched": "is_injection"}`（键序）。
 *      `for h in hits or []` —— scan 返回 None/0/[]/"" 走空，返回 str 按字符迭代、
 *      返回 dict 按键迭代（源文件如此）。finding 的 `sample[:160]` 是**码点**切片。
 *   4. `start_red_team_patrol(router, interval_s=6*3600.0)`：幂等判据
 *      `_task is not None and not _task.done()`——上一轮任务**带异常死掉后**
 *      done() 为真，于是可以被重启（源文件的自愈面）。`interval_s` 在启动时
 *      **不做任何类型转换**（与 evolution_review 不同）：垃圾值要等到第一轮
 *      `asyncio.sleep(interval_s)` 才炸，且炸在 try **之外** → 任务直接死亡，
 *      而 `started, interval=%.0fs` 这行日志在 create_task 之后、任务首句之前
 *      就已同步打出。
 *   5. 巡逻循环：`while True: await asyncio.sleep(interval_s)` 先睡后干；
 *      睡醒立刻 `started = time.monotonic()`（**在 try 之外**，monotonic 抛错
 *      同样杀死任务）。
 *   6. 每轮正文：两路函数内导入 `evolution_review._busy` / `storage.get_storage`
 *      （在 try 内 → 缺模块只打 `sweep failed` 日志，任务不死）；
 *      `st = get_storage()`；`if _busy(st): continue`——**跳过时没有任何日志**，
 *      而且**不写 cron 租约**。`_busy` 复用 evolution_review 的真实现：查不清就当忙。
 *   7. 租约：`int(time.time())`、`int(interval_s)`，参数
 *      `(now_ts + int(interval_s), now_ts)`；整段 `except Exception: pass`——
 *      `int('abc')` 的 ValueError 被静默吞掉（源文件如此），UPDATE 与 commit 各自
 *      **重新调一次** `_db("cron")`。
 *   8. `elapsed = time.monotonic() - started` 之后才分支：有 findings 打
 *      `warning %d finding(s) in %.1fs: %s`（第三个参数是 `findings[:5]` 的
 *      source 列表），随后 mailbox 通知（`payload={"findings": findings[:20]}`，
 *      键序；导入失败/发送失败都打 `mailbox notify failed: %s`）与
 *      `await router.bus.emit("red_team_alert", {...})`（**在 try 内**，
 *      session_id/count/sources(findings[:10])/findings(findings[:10]) 键序；任何
 *      异常 pass）；无 findings 打 `info sweep clean in %.1fs`。两条臂之后都走
 *      收尾 `UPDATE cron_jobs SET status='idle'…`（各自 try）。
 *   9. 最外层 `except Exception as exc` → `logger.warning("[red_team_patrol]
 *      sweep failed: %s", exc)`，循环继续。
 *  10. logging 全程 **惰性 % 格式**：fmt 与 args 分开交给 seam，未渲染的参数就是
 *      探针要钉的形态。`re` 被导入但从未使用（源文件缺陷，保留）。
 *
 * MIGRATION DECISIONS / DIVERGENCES
 *   DIVERGENCE(port, lazy import → seam): 五处函数体内导入按 RULEBOOK §2 处理。
 *     `red_team` / `evolution_review` 在 TS 侧**已落地**，直接静态复用现成端口
 *     （`get_red_team` / `_busy`），不重新打桩；`storage` 走
 *     `RTP_SEAMS.storageModule()`（默认 dynImport，探针注入内存假件——红线 5
 *     禁止真 SQLite）；`mailbox` 是 Native→Rust、TS 侧无落地件，默认装载器抛
 *     `ModuleNotFoundError: No module named 'mailbox'`，与 python 端缺模块走同一条
 *     except 臂（文案逐字相同）。`red_team`/`evolution_review` 用**同步** seam，
 *     以保持 `_run_scan` 是同步函数（python 同名函数也是同步的）；`storage`/
 *     `mailbox` 的装载发生在协程体内，多出的微任务边界不改变账本顺序（整个探针
 *     循环只有一个任务）。
 *   DIVERGENCE(port, asyncio bridge): `asyncio.get_event_loop().create_task(_patrol())`
 *     → `RTP_SEAMS.createTask` + `PyTask`（done()/exception()/join() 镜像
 *     asyncio.Task）。协程体推迟一个微任务启动，等价于"循环让出后任务才执行第一
 *     句"。python 任务异常无人 retrieve 会被 asyncio 打日志；端口把异常存进
 *     PyTask，探针用 `_probe_task_state()` 取回异常身份对拍。
 *   DIVERGENCE(port, await protocol): CPython 的 `await x`（x 非 awaitable）抛
 *     `TypeError: object <type> can't be used in 'await' expression`；JS 的
 *     `await` 会静默接受任意值。端口用 `awaitPy()` 复刻（router.bus.emit 返回
 *     普通值时两侧行为一致）。
 *   DIVERGENCE(port, ntpath): `os.path.join` 是 CPython 3.13 `ntpath.join` +
 *     `splitroot` 的逐行移植（盘符 / UNC / `C:` 驱动器相对路径不插分隔符、第二
 *     参数绝对路径整体替换、混用 str 与 bytes 报
 *     "Can't mix strings and bytes in path components"）。目标平台是 win32，
 *     分隔符按 ntpath 硬编码为 `\\`，不跟随宿主 `path.sep`。探针把
 *     `["file_read", <joined path>]` 记进账本钉死。
 *   DIVERGENCE(port, str 原语): `str.strip()` 用 CPython 码点空白集（含
 *     \x1c-\x1f \u0085 \u00a0 \u1680 \u2000-\u200a \u2028 \u2029 \u202f \u205f
 *     \u3000，**不含** \ufeff）；JS 的 `\s`/`trim()` 两条都不对。
 *     `str.splitlines()` 的断行集含 \x0b\x0c\x1c\x1d\x1e\u0085\u2028\u2029 且
 *     **\x1f 不断行**；`\r\n` 当**一个**断行。切片一律码点。
 *   DIVERGENCE(port, open → seam): `open(path, encoding="utf-8",
 *     errors="replace").read()` → `RTP_SEAMS.readFile`：默认实现做真文件读取 +
 *     CPython 兼容的 UTF-8 replace 解码（非法字节序列 → U+FFFD），错误只映射到
 *     OSError 家族；非 str 路径抛 TypeError（**不被捕获**，与 CPython 同）。
 *   DIVERGENCE(port, int vs float): JS 只有一种 number。`int()` 走 `pyInt()`
 *     （向零截断 + CPython 文案）。探针账本里 python int/float 身份可被源码观察
 *     到的位置（cron 参数）用**类型标记**编码；仅"整数值 float"（如默认间隔
 *     21600.0）用归一化编码——该值在本源码里只经过 `asyncio.sleep` / `int()` /
 *     `%.0f` 三条路径，三者对 int/float 身份均不敏感（已实测）。
 *   DIVERGENCE(port, attribute access): python 的 `router.bus` /
 *     `router.session_id` 是**普通属性访问**（缺名抛 AttributeError），端口用
 *     `attrPy()` 复刻；`getattr(x, n, default)` 走 `pyGetattr()`（缺名回退默认
 *     值）。两侧探针的假件都用**纯 dict / 纯对象**，使 pyTypeName 给出的类型名
 *     逐字相同。
 *   探针杠杆：python 侧 sys.modules 注入假 `storage` / 假 `red_team` / 假
 *     `mailbox`、`_Blocker` meta_path 拦截器复现"模块真缺失"、`builtins.open`
 *     包一层记账后转真读取（只读 tmp/w215_sandbox 下的沙箱文件）、`logger` /
 *     `asyncio` / `time` 换成记录型假件；端口侧对应 `RTP_SEAMS.*` 赋值 +
 *     `_reset_probe_state()`（ESM 绑定不可外改，测试专用）。全程无真 SQLite、无真
 *     子进程、无真端口、无真 HTTP、无真时钟；每轮跑完打印 DB_UNCHANGED=true。
 */

import * as fs from "node:fs";

import * as EVR_NS from "./evolution_review.js";
import * as RED_TEAM_NS from "./red_team.js";

// ── python-semantics helpers (house style: file-local) ───────────────────────

class TypeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "TypeError"; }
}
class ValueErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ValueError"; }
}
class AttributeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "AttributeError"; }
}
class ImportErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ImportError"; }
}
/** python ModuleNotFoundError（ImportError 子类；`import x` 缺模块抛的就是它）。 */
class ModuleNotFoundErrorP extends ImportErrorP {
    constructor(msg: string) { super(msg); this.name = "ModuleNotFoundError"; }
}
/** python OSError 家族：`except OSError` 只认这条臂。 */
class OSErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "OSError"; }
}
class FileNotFoundErrorP extends OSErrorP {
    constructor(msg: string) { super(msg); this.name = "FileNotFoundError"; }
}
class IsADirectoryErrorP extends OSErrorP {
    constructor(msg: string) { super(msg); this.name = "IsADirectoryError"; }
}
class PermissionErrorP extends OSErrorP {
    constructor(msg: string) { super(msg); this.name = "PermissionError"; }
}
class OverflowErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "OverflowError"; }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (typeof v === "string") return "str";
    if (Array.isArray(v)) return "list";
    if (v instanceof Set) return "set";
    if (typeof v === "function") return "function";
    if (v instanceof Error) return v.name;
    if (isPyDict(v) || v instanceof Map) return "dict";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        if (ctor && ctor.name && ctor.name !== "Object") return ctor.name;
        return "object";
    }
    return typeof v;
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined || v === false) return false;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Set || v instanceof Map) return v.size > 0;
    if (isPyDict(v)) return Object.keys(v).length > 0;
    return true;
}

function isPyDict(v: unknown): v is Record<string, unknown> {
    if (typeof v !== "object" || v === null || Array.isArray(v)
        || v instanceof Error || v instanceof Map || v instanceof Set) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

/** python `int(x)`：向零截断；str 走 CPython 语法与文案。 */
function pyInt(v: unknown): number {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") {
        if (Number.isNaN(v)) throw new ValueErrorP("cannot convert float NaN to integer");
        if (!Number.isFinite(v)) throw new OverflowErrorP("cannot convert float infinity to integer");
        return Math.trunc(v);
    }
    if (typeof v === "string") {
        const t = v.replace(/(?<=\d)_(?=\d)/g, "").trim();
        if (t.includes("_") || !/^[+-]?\d+$/.test(t)) {
            throw new ValueErrorP(`invalid literal for int() with base 10: '${v}'`);
        }
        return Number(t);
    }
    throw new TypeErrorP(
        "int() argument must be a string, a bytes-like object or a real number, "
        + `'${pyTypeName(v)}'`);
}

/** python `float.__repr__`（探针侧也复用同一套语义）。 */
function pyNumStr(v: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    if (Number.isInteger(v)) return `${v}.0`;
    return String(v);
}

function pyReprStr(s: string): string {
    const q = s.includes("'") && !s.includes("\"") ? "\"" : "'";
    const esc = s
        .replaceAll("\\", "\\\\")
        .replaceAll("\n", "\\n")
        .replaceAll("\r", "\\r")
        .replaceAll("\t", "\\t");
    return q + esc.replaceAll(q, "\\" + q) + q;
}

function pyRepr(v: unknown): string {
    if (typeof v === "string") return pyReprStr(v);
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Error) return `${pyTypeName(v)}(${pyReprStr(v.message)})`;
    if (v instanceof Map) {
        return "{" + Array.from(v.entries())
            .map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
    }
    if (isPyDict(v)) {
        return "{" + Object.keys(v)
            .map((k) => pyReprStr(k) + ": " + pyRepr(v[k])).join(", ") + "}";
    }
    return pyStr(v);
}

/** python `str(x)` 在本模块可能出现的值形态（f-string 与 %s 共用）。 */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyNumStr(v);
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.message;
    if (Array.isArray(v) || v instanceof Map || isPyDict(v)) return pyRepr(v);
    if (v instanceof Set) {
        if (v.size === 0) return "set()";
        return "{" + Array.from(v).map(pyRepr).join(", ") + "}";
    }
    if (typeof v === "object") return (v as { toString(): string }).toString();
    return String(v);
}

/** python `x or y`：or 返回操作数本身。 */
function pyOr(v: unknown, fallback: unknown): unknown {
    return pyTruth(v) ? v : fallback;
}

/** python `s[n:]` / `s[:n]`：一律码点。 */
function pySliceFrom(s: string, from: number): string {
    return Array.from(s).slice(from).join("");
}
function pySliceTo(s: string, to: number): string {
    const a = Array.from(s);
    return a.length <= to ? s : a.slice(0, to).join("");
}
function pyStartsWith(s: string, pre: string): boolean { return s.startsWith(pre); }

/** CPython str.strip() 的空白集（码点）；注意 **不含** U+FEFF。 */
const PY_WS = new Set<number>([
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
    0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
    0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);
function pyStrip(s: string): string {
    const a = Array.from(s);
    let i = 0;
    let j = a.length;
    while (i < j && PY_WS.has((a[i] as string).codePointAt(0) as number)) i++;
    while (j > i && PY_WS.has((a[j - 1] as string).codePointAt(0) as number)) j--;
    return a.slice(i, j).join("");
}

/** CPython str.splitlines()：\x1f **不是**断行；\r\n 当一个；末尾断行不产生空尾行。 */
const LINE_BOUNDARIES = new Set<string>([
    "\n", "\v", "\f", "\r", "\x1c", "\x1d", "\x1e", "\u0085", "\u2028", "\u2029",
]);
function pySplitlines(s: string): string[] {
    const out: string[] = [];
    let cur = "";
    const chars = Array.from(s);
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i] as string;
        if (ch === "\r" && chars[i + 1] === "\n") {
            out.push(cur); cur = ""; i++;
            continue;
        }
        if (LINE_BOUNDARIES.has(ch)) {
            out.push(cur); cur = "";
            continue;
        }
        cur += ch;
    }
    if (chars.length > 0) out.push(cur);
    return out;
}

/** python for-in 迭代协议。 */
function pyIter(v: unknown): unknown[] {
    if (Array.isArray(v)) return v.slice();
    if (typeof v === "string") return Array.from(v);
    if (v instanceof Map) return Array.from(v.keys());
    if (v instanceof Set) return Array.from(v);
    if (isPyDict(v)) return Object.keys(v);
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not iterable`);
}

/** python `getattr(o, name, default)` / 普通属性访问。 */
function hasPyAttr(o: unknown, name: string): boolean {
    if (o instanceof Map) return o.has(name);
    if (typeof o === "object" && o !== null) {
        return name in (o as Record<string, unknown>);
    }
    return false;
}
function pyGetattr(o: unknown, name: string, fallback: unknown): unknown {
    if (hasPyAttr(o, name)) {
        const v = (o instanceof Map) ? o.get(name) : (o as Record<string, unknown>)[name];
        return v === undefined ? fallback : v;
    }
    return fallback;
}
function attrPy(o: unknown, name: string): unknown {
    if (!hasPyAttr(o, name)) {
        throw new AttributeErrorP(
            `'${pyTypeName(o)}' object has no attribute '${name}'`);
    }
    const v = (o instanceof Map) ? o.get(name) : (o as Record<string, unknown>)[name];
    return v === undefined ? null : v;
}
/** python `o.m(...)`：先取属性（缺名 AttributeError），再调用（非可调用 TypeError）。 */
function callMethod(o: unknown, name: string, args: unknown[] = []): unknown {
    const fn = attrPy(o, name);
    if (typeof fn !== "function") {
        throw new TypeErrorP(`'${pyTypeName(fn)}' object is not callable`);
    }
    return (fn as (...a: unknown[]) => unknown)(...args);
}

/** CPython `await x`：非 awaitable 抛 TypeError。 */
function awaitPy(v: unknown): Promise<unknown> {
    if (v !== null && (typeof v === "object" || typeof v === "function")
        && typeof (v as { then?: unknown }).then === "function") {
        return v as Promise<unknown>;
    }
    throw new TypeErrorP(`object ${pyTypeName(v)} can't be used in 'await' expression`);
}

/** CPython `os.fspath(x)` 的 TypeError 文案（open() 与 os.path.join() 共用）。 */
function fspathMsg(v: unknown): string {
    return `expected str, bytes or os.PathLike object, not ${pyTypeName(v)}`;
}

// ── ntpath.join / splitroot（CPython 3.13 Lib/ntpath.py 的逐行移植）──────────

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
            // UNC drives (\\server\share, \\?\UNC\server\share) and device
            // drives (\\.\device, \\?\device)
            const start = normp.slice(0, 8).toUpperCase() === uncPrefix ? 8 : 2;
            const index = normp.indexOf(NTP_SEP, start);
            if (index === -1) return [p, empty, empty];
            const index2 = normp.indexOf(NTP_SEP, index + 1);
            if (index2 === -1) return [p, empty, empty];
            return [p.slice(0, index2), p.slice(index2, index2 + 1), p.slice(index2 + 1)];
        }
        // Relative path with root, e.g. \Windows
        return [empty, p.slice(0, 1), p.slice(1)];
    }
    if (normp.slice(1, 2) === ":") {
        if (normp.slice(2, 3) === NTP_SEP) {
            // Absolute drive-letter path, e.g. X:\Windows
            return [p.slice(0, 2), p.slice(2, 3), p.slice(3)];
        }
        // Relative path with drive, e.g. X:Windows
        return [p.slice(0, 2), empty, p.slice(2)];
    }
    return [empty, empty, p];
}

/** python `os.path.join(a, b)`（win32 ntpath；本模块只有二元调用）。 */
function ntpJoin(a: unknown, b: string): string {
    if (typeof a !== "string") {
        if (a instanceof Uint8Array) {
            throw new TypeErrorP("Can't mix strings and bytes in path components");
        }
        throw new TypeErrorP(fspathMsg(a));
    }
    let [resultDrive, resultRoot, resultPath] = ntpSplitroot(a);
    const [pDrive, pRoot, pPath] = ntpSplitroot(b);
    if (pRoot) {
        // Second path is absolute
        if (pDrive || !resultDrive) resultDrive = pDrive;
        resultRoot = pRoot;
        resultPath = pPath;
    } else if (pDrive && pDrive !== resultDrive) {
        if (pDrive.toLowerCase() !== resultDrive.toLowerCase()) {
            // Different drives => ignore the first path entirely
            resultDrive = pDrive;
            resultRoot = pRoot;
            resultPath = pPath;
        } else {
            // Same drive in different case
            resultDrive = pDrive;
        }
    } else {
        // Second path is relative to the first
        if (resultPath && !NTP_SEPS.includes(resultPath.slice(-1))) {
            resultPath = resultPath + NTP_SEP;
        }
        resultPath = resultPath + pPath;
    }
    // add separator between UNC and non-absolute path
    if (resultPath && !resultRoot && resultDrive
        && !NTP_COLON_SEPS.includes(resultDrive.slice(-1))) {
        return resultDrive + NTP_SEP + resultPath;
    }
    return resultDrive + resultRoot + resultPath;
}

// ── CPython errors="replace" UTF-8 解码 ─────────────────────────────────────

const FFFD = "\uFFFD";

/**
 * python `bytes.decode("utf-8", "replace")`：非法起始字节 / 非法续字节各替换
 * 一个 U+FFFD 并且**只前进一个字节**；串尾被截断的合法前缀整体替换一个
 * U+FFFD。代理区（ED A0..BF）与 >U+10FFFF 同样按非法处理。
 */
function pyUtf8Replace(buf: Uint8Array): string {
    let out = "";
    let i = 0;
    const n = buf.length;
    while (i < n) {
        const b0 = buf[i] as number;
        if (b0 < 0x80) { out += String.fromCodePoint(b0); i++; continue; }
        let need = 0;
        let lo = 0x80;
        let hi = 0xBF;
        let cp = 0;
        if (b0 >= 0xc2 && b0 <= 0xdf) { need = 1; cp = b0 & 0x1f; }
        else if (b0 === 0xe0) { need = 2; cp = 0; lo = 0xa0; hi = 0xbf; }
        else if (b0 >= 0xe1 && b0 <= 0xec) { need = 2; cp = b0 & 0x0f; }
        else if (b0 === 0xed) { need = 2; cp = 0; lo = 0x80; hi = 0x9f; }
        else if (b0 >= 0xee && b0 <= 0xef) { need = 2; cp = b0 & 0x0f; }
        else if (b0 === 0xf0) { need = 3; cp = 0; lo = 0x90; hi = 0xbf; }
        else if (b0 >= 0xf1 && b0 <= 0xf3) { need = 3; cp = b0 & 0x07; }
        else if (b0 === 0xf4) { need = 3; cp = 0; lo = 0x80; hi = 0x8f; }
        else { out += FFFD; i++; continue; }
        const start = i;
        let pos = i + 1;
        let truncated = false;
        let badByte = false;
        for (let k = 0; k < need; k++) {
            if (pos >= n) { truncated = true; break; }
            const cb = buf[pos] as number;
            const isLast = k === need - 1;
            const cLo = isLast ? lo : 0x80;
            const cHi = isLast ? hi : 0xbf;
            if (cb < cLo || cb > cHi) { badByte = true; break; }
            cp = (cp << 6) | (cb & 0x3f);
            pos++;
        }
        if (truncated) {
            out += FFFD;
            i = n;
            continue;
        }
        if (badByte) {
            out += FFFD;
            i = start + 1;
            continue;
        }
        out += String.fromCodePoint(cp);
        i = pos;
    }
    return out;
}

// ── module constants（与 py 同名同值）───────────────────────────────────────

/** 默认节奏：6 小时一轮（CPython 里是 float 21600.0）。 */
export const _PATROL_INTERVAL_S = 6 * 3600.0;
/** 单条审计样本长度上限。规则条目可能很长，截断后再扫——注入特征几乎总在条目头部。 */
export const _SAMPLE_CAP = 1200;
/** 引导文件里自进化产物的小节标题（与 evolution.EVOLUTION_HEADING 一致）。 */
export const _EVOLUTION_HEADING = "## Learned Rules (evolution)";

// ── seams（测试注入面；默认实现 = 生产行为）─────────────────────────────────

export type AnyMod = Record<string, unknown>;

type DbConn = {
    execute(sql: string, params?: unknown[]): unknown;
    commit(): void;
};

async function dynImport(name: string, hasPort: boolean): Promise<AnyMod> {
    if (!hasPort) {
        throw new ModuleNotFoundErrorP(`No module named '${name}'`);
    }
    const spec = `./${name}.js`;
    try {
        return (await import(spec)) as unknown as AnyMod;
    } catch (e: unknown) {
        if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
            throw new ModuleNotFoundErrorP(`No module named '${name}'`);
        }
        throw e;
    }
}

/** 把 `from X import y` 的命名检查搬进运行时（缺名 → ImportError 文案）。 */
function needName(mod: AnyMod, name: string, from: string): unknown {
    if (typeof mod[name] !== "function") {
        throw new ImportErrorP(
            `cannot import name '${name}' from '${from}' (unknown location)`);
    }
    return mod[name];
}

export const RTP_SEAMS = {
    /** python `time.time()` */
    now: (): number => Date.now() / 1000,
    /** python `time.monotonic()` */
    monotonic: (): number => Number(process.hrtime.bigint()) / 1e9,
    /** python `asyncio.sleep(interval_s)`：参数**不预转换**，垃圾值在这里炸 */
    sleep: (delay: unknown): Promise<void> => {
        const d = sleepDelay(delay);
        return new Promise<void>((resolve) => { setTimeout(resolve, d * 1000); });
    },
    /** python `asyncio.get_event_loop().create_task(coro)` */
    createTask: (fn: () => Promise<void>): PyTask => new PyTask(fn),
    /** python `open(path, encoding="utf-8", errors="replace").read()` */
    readFile: (path: unknown): string => {
        let p = path;
        if (typeof p !== "string") {
            const fsp = (p as { __fspath__?: () => unknown } | null) === null
                || p === undefined ? undefined
                    : (p as { __fspath__?: () => unknown }).__fspath__;
            if (typeof fsp === "function") {
                const s = fsp.call(p);
                p = s;
            }
        }
        if (typeof p !== "string") {
            // 非 str 路径在 CPython 里抛 TypeError——**不被 `except OSError` 捕获**
            throw new TypeErrorP(fspathMsg(p));
        }
        try {
            return pyUtf8Replace(new Uint8Array(fs.readFileSync(p)));
        } catch (e: unknown) {
            throw mapIoError(e, p);
        }
    },
    /** python logger（% 惰性格式：fmt 与 args 分开传递，不预渲染）*/
    log: (level: "info" | "warning", fmt: string, args: unknown[]): void => {
        if (level === "warning") {
            console.error(`red_team_patrol: ${fmt}`
                + (args.length ? ` ${pyRepr(args)}` : ""));
        }
    },
    /** `from red_team import get_red_team`（TS 端口已落地 → 同步复用，不打桩） */
    redTeamModule: (): AnyMod => RED_TEAM_NS as unknown as AnyMod,
    /** `from evolution_review import _busy`（TS 端口已落地 → 同步复用，不打桩） */
    evolutionReviewModule: (): AnyMod => EVR_NS as unknown as AnyMod,
    /** `from storage import get_storage` */
    storageModule: (): Promise<AnyMod> => dynImport("storage", true),
    /** `from mailbox import send`——mailbox 是 Native→Rust，TS 侧无落地件。 */
    mailboxModule: (): AnyMod => {
        throw new ModuleNotFoundErrorP("No module named 'mailbox'");
    },
};

/** CPython 把 sleep 的延迟交给 loop 与 `loop.time()` 相加：非数值在此炸 TypeError。 */
function sleepDelay(v: unknown): number {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    throw new TypeErrorP(
        `unsupported operand type(s) for +: 'float' and '${pyTypeName(v)}'`);
}

/** errno → python OSError 家族。 */
function mapIoError(e: unknown, path: string): Error {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT") {
        return new FileNotFoundErrorP(
            `[Errno 2] No such file or directory: '${pyReprStr(path)}'`);
    }
    if (code === "EISDIR") {
        return new IsADirectoryErrorP(
            `[Errno 21] Is a directory: '${pyReprStr(path)}'`);
    }
    if (code === "EACCES" || code === "EPERM") {
        return new PermissionErrorP(
            `[Errno 13] Permission denied: '${pyReprStr(path)}'`);
    }
    return new OSErrorP((e as { message?: string }).message ?? String(e));
}

// ── PyTask（asyncio.Task 的最小镜像：done()/exception()/join() 语义）────────

export class PyTask {
    private _finished = false;
    private _error: unknown = null;
    readonly promise: Promise<void>;
    constructor(fn: () => Promise<void>) {
        // DIVERGENCE(port, asyncio bridge): microtask 推迟，模拟"循环让出后任务
        // 第一句才执行"。python 端协程体同样不在 create_task 的同步段里跑。
        this.promise = Promise.resolve().then(fn).then(
            () => { this._finished = true; },
            (e: unknown) => { this._finished = true; this._error = e; },
        );
    }
    done(): boolean { return this._finished; }
    /** python `task.exception()`：未结束时探针不看（asyncio 会抛 InvalidStateError）。 */
    exception(): unknown { return this._error; }
    /** python `await task`：正常完成即返回；异常原样重抛。 */
    async join(): Promise<void> {
        await this.promise;
        if (this._error !== null && this._error !== undefined) throw this._error;
    }
}

// ── module state ─────────────────────────────────────────────────────────────

let _task: PyTask | null = null;

/** 探针专用：python 测试直接改模块全局 `_task`；ESM 绑定不可外改，这里给重置面。 */
export function _reset_probe_state(): void {
    _task = null;
}
/** 探针专用：镜像 `_task` 的可观察面（存在 / done() / 异常类型名）。 */
export function _probe_task_state(): { exists: boolean; done: boolean | null; exc: string | null } {
    if (_task === null) return { exists: false, done: null, exc: null };
    const err = _task.exception();
    return {
        exists: true,
        done: _task.done(),
        exc: _task.done() && err !== null && err !== undefined
            ? pyTypeName(err) : null,
    };
}

// ── _extract_learned_rules ───────────────────────────────────────────────────

/** 从引导文件里抽 Learned Rules 小节的逐条规则（每行一条）。 */
export function _extract_learned_rules(path: unknown): unknown[] {
    let text: string;
    try {
        text = RTP_SEAMS.readFile(path);
    } catch (exc: unknown) {
        // python: `except OSError` —— 只有 OSError 家族降级成 []，其余一路上抛
        if (exc instanceof OSErrorP) return [];
        throw exc;
    }
    const out: unknown[] = [];
    let in_section = false;
    for (const line of pySplitlines(text)) {
        if (pyStartsWith(pyStrip(line), "## ")) {
            in_section = pyStartsWith(pyStrip(line), _EVOLUTION_HEADING);
            continue;
        }
        if (in_section && pyStartsWith(pyStrip(line), "- ")) {
            out.push(pySliceFrom(pyStrip(line), 2));
        }
    }
    return out;
}

// ── _audit_targets ───────────────────────────────────────────────────────────

/** 收集本轮审计目标：[[来源标签, 样本文本], ...]。 */
export function _audit_targets(router: unknown): [string, string][] {
    const targets: [string, string][] = [];
    const ws = pyOr(pyGetattr(router, "workspace", ""), "");
    if (pyTruth(ws)) {
        for (const name of ["AGENTS.md", "MEMORY.md", "SOUL.md"]) {
            // join 在 skills 的 try **之外**：非 str workspace 直接上抛
            const p = ntpJoin(ws, name);
            for (const rule of pyIter(_extract_learned_rules(p))) {
                targets.push([`${name}#learned`, pySliceTo(pyStr(rule), _SAMPLE_CAP)]);
            }
        }
    }
    try {
        const loader = pyGetattr(router, "skills", null);
        const entries = pyTruth(loader) ? pyOr(callMethod(loader, "list_skills"), []) : [];
        for (const entry of pyIter(entries)) {
            const desc = pyStr(pyOr(pyGetattr(entry, "description", ""), ""));
            if (pyTruth(desc)) {
                targets.push([
                    `skill:${pyStr(pyGetattr(entry, "name", "?"))}`,
                    pySliceTo(desc, _SAMPLE_CAP),
                ]);
            }
        }
    } catch {
        /* python: except Exception: pass —— 技能清单不可用不阻塞巡逻 */
    }
    return targets;
}

// ── _run_scan ────────────────────────────────────────────────────────────────

/** 跑一轮扫描，返回 findings 列表。 */
export function _run_scan(router: unknown): Record<string, unknown>[] {
    const rtMod = RTP_SEAMS.redTeamModule();
    const getRedTeam = needName(rtMod, "get_red_team", "red_team") as () => unknown;
    const rt = getRedTeam() as { scan(t: unknown): unknown; is_injection(t: unknown): unknown };
    const findings: Record<string, unknown>[] = [];
    for (const [source, sample] of _audit_targets(router)) {
        if (!pyTruth(pyStrip(sample))) continue;
        let hits: unknown;
        try {
            hits = callMethod(rt, "scan", [sample]);
            if (pyTruth(callMethod(rt, "is_injection", [sample])) && !pyTruth(hits)) {
                hits = [{ category: "injection", matched: "is_injection" }];
            }
        } catch (exc: unknown) {
            // noqa: BLE001 — 单条失败不阻塞整轮
            RTP_SEAMS.log("warning", "[red_team_patrol] scan error on %s: %s",
                [source, pyStr(exc)]);
            continue;
        }
        for (const h of pyIter(pyOr(hits, []))) {
            findings.push({ source, sample: pySliceTo(sample, 160), hit: h });
        }
    }
    return findings;
}

// ── _patrol（python 里嵌套在 start_red_team_patrol 的协程；闭包只捕获
//    router / interval_s 两个名字，提为模块级参数化函数，行为不变）──────────

async function _patrol(router: unknown, intervalS: unknown): Promise<void> {
    for (;;) {
        await RTP_SEAMS.sleep(intervalS);
        const started = RTP_SEAMS.monotonic();
        try {
            // 前台优先：有目标在跑就不巡逻（与 evolution_review 同纪律）
            const evrMod = RTP_SEAMS.evolutionReviewModule();
            const busy = needName(evrMod, "_busy", "evolution_review") as (s: unknown) => boolean;
            const stoMod = await RTP_SEAMS.storageModule();
            const getStorage = needName(stoMod, "get_storage", "storage") as () => unknown;

            const st = getStorage();
            if (busy(st)) continue;
            // Durable lease in cron DB (mirrors evolution_review)
            try {
                const nowTs = pyInt(RTP_SEAMS.now());
                (callMethod(st, "_db", ["cron"]) as DbConn).execute(
                    "INSERT INTO cron_jobs (id, name, cron_expr, prompt, status, next_run_at, running_since, last_error) "
                    + "VALUES ('job_red_team_patrol', 'Red Team Learned Rules Patrol', '0 */6 * * *', "
                    + "'Scan learned rules and skill descriptions for injection patterns', 'running', ?, ?, '') "
                    + "ON CONFLICT(id) DO UPDATE SET running_since=excluded.running_since, status='running', next_run_at=excluded.next_run_at",
                    [nowTs + pyInt(intervalS), nowTs],
                );
                (callMethod(st, "_db", ["cron"]) as DbConn).commit();
            } catch {
                /* python: except Exception: pass */
            }
            const findings = _run_scan(router);
            const elapsed = RTP_SEAMS.monotonic() - started;
            if (pyTruth(findings)) {
                RTP_SEAMS.log("warning", "[red_team_patrol] %d finding(s) in %.1fs: %s",
                    [findings.length, elapsed, findings.slice(0, 5).map((f) => f["source"])]);
                try {
                    const mbMod = RTP_SEAMS.mailboxModule();
                    const msend = needName(mbMod, "send", "mailbox") as (
                        st0: unknown, to: string, sender: string,
                        opts: { kind: string; payload: Record<string, unknown> },
                    ) => unknown;
                    msend(st, "system:redteam", "red-team-patrol",
                        { kind: "warning", payload: { findings: findings.slice(0, 20) } });
                } catch (exc: unknown) {
                    RTP_SEAMS.log("warning", "[red_team_patrol] mailbox notify failed: %s",
                        [pyStr(exc)]);
                }
                try {
                    const bus = attrPy(router, "bus");
                    await awaitPy(callMethod(bus, "emit", [
                        "red_team_alert",
                        {
                            session_id: attrPy(router, "session_id"),
                            count: findings.length,
                            sources: findings.slice(0, 10).map((f) => f["source"]),
                            findings: findings.slice(0, 10),
                        },
                    ]));
                } catch {
                    /* python: except Exception: pass */
                }
            } else {
                RTP_SEAMS.log("info", "[red_team_patrol] sweep clean in %.1fs", [elapsed]);
            }
            try {
                (callMethod(st, "_db", ["cron"]) as DbConn).execute(
                    "UPDATE cron_jobs SET status='idle', running_since=0, last_error='' WHERE id='job_red_team_patrol'",
                );
                (callMethod(st, "_db", ["cron"]) as DbConn).commit();
            } catch {
                /* python: except Exception: pass */
            }
        } catch (exc: unknown) {
            // noqa: BLE001 — 巡逻绝不影响主流程
            RTP_SEAMS.log("warning", "[red_team_patrol] sweep failed: %s", [pyStr(exc)]);
        }
    }
}

// ── start_red_team_patrol ────────────────────────────────────────────────────

/** 启动周期巡逻。已在跑则幂等返回 False。 */
export function start_red_team_patrol(
    router: unknown,
    intervalS?: unknown,
): boolean {
    if (arguments.length < 1) {
        throw new TypeErrorP(
            "start_red_team_patrol() missing 1 required positional argument: 'router'");
    }
    if (arguments.length > 2) {
        throw new TypeErrorP(
            `start_red_team_patrol() takes from 1 to 2 positional arguments `
            + `but ${arguments.length} were given`);
    }
    if (_task !== null && !_task.done()) return false;
    const interval = arguments.length < 2 ? _PATROL_INTERVAL_S : intervalS as unknown;
    _task = RTP_SEAMS.createTask(() => _patrol(router, interval));
    RTP_SEAMS.log("info", "[red_team_patrol] started, interval=%.0fs", [interval]);
    return true;
}

// PORT STATUS: 本文件无 TODO(port)。
