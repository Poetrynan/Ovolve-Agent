/**
 * evolution_review.ts — 后台 EvolutionReviewRun 的最小实现（Phase 5 收口）。
 *
 * Ported from `app/backend/evolution_review.py` (205 lines, wave-8, unit 176).
 *
 * 总指令 §10：review 由 idle/turn-settled 触发、前台优先、有预算。刻意保守的
 * 语义逐条对拍钉死：
 *
 * BUG-FOR-BUG FACTS (pinned by the parity probe)
 *   1. `_busy`：任何异常 → 返回 True（"查不清就当忙"）；`bool(row and row["c"])`
 *      在 row 为 None 时 False，row["c"]==0 也 False。
 *   2. `_reconcile_boot_lease`：两段各自 try/except Exception → logger.warning，
 *      f-string 里是 `str(exc)`；boot lease 判定 `row["status"] == "running"` 或
 *      `running_since and now_ts - running_since > 1800`（running_since=0/None
 *      短路；str 参与减法 → CPython 的 unsupported operand TypeError 被吞成
 *      warning）。UPDATE 与 commit 各自**重新调一次** `_db("cron")`（原码如此；
 *      假 storage 若每次 _db 都发新连接，各条臂分开记账——探针钉住）。
 *   3. `start_background_review(router, interval_s=900.0)`：`router` 全程未用；
 *      幂等判据 `_task is not None and not _task.done()` **先于** float 转换——
 *      任务还活着时传垃圾 interval_s 也只会返回 False 而不报错。
 *      float()/int() 的 CPython 文案照搬（None → TypeError；'abc' → ValueError）。
 *   4. `_sweep` 协程第一句是四路延迟导入（evolution/storage/learning_service）：
 *      任何 ImportError **杀死整个后台任务**（没有 try 兜住），start 已返回
 *      True 且无人重试。探针把 task 的最终异常身份取回来对拍。
 *   5. 循环体：`while True: await asyncio.sleep(_interval_s)` 先睡后干；
 *      `_interval_s` 是模块全局，每轮**现读**（运行中改全局影响下一轮）。
 *   6. 租约记账：INSERT … ON CONFLICT(id) DO UPDATE 的参数是
 *      (now_ts + int(_interval_s), now_ts)，int() 向零截断；任何失败 pass。
 *   7. 静默片段封存：episode_manager 的导入在**本轮 try 内**（缺模块只 print
 *      fail-open，不像第 4 条那样杀任务）；`em.check_idle_episodes(idle_timeout_s=1800.0)`；
 *      print 的 f-string 里 `{sealed_ep_ids}` 是 **python list 的 str()**（单引号
 *      repr），空 list 假值不打。
 *   8. 扫描：`have = {o.get("goalId") for o in engine.store.list_observations(limit=200)}`
 *      —— dict.get 语义（缺键=None 进集合）；时间预算在 build 之前查（time 超限
 *      那条目标本轮根本不会被构建）；token 预算在 build **之后**、observe 之前查
 *      （超限那条 obs 已被构建、被记账、但本轮被丢弃——下轮重来的语义）。
 *      `r["id"]` 是 sqlite3.Row 的**下标**（缺列 IndexError "No item with that key"，
 *      CPython 3.13 实测文案，被外层 except 打印），与 o.get 的软语义不同。
 *   9. token 估算：`len(json.dumps(obs.to_dict(), ensure_ascii=False, default=str))`
 *      —— len 数**码点**；default=str 兜住不可序列化成员；to_dict 抛错 →
 *      pass（只跳过记账，不阻塞本轮）。`int(size / 2.5)` 向零截断。
 *  10. 预算收手日志：logger.info 是**惰性 % 格式**（fmt 与 args 分开传，未渲染的
 *      参数元组就是探针要钉的形态）。
 *  11. 外层 `except Exception as e`：先 print `[evolution] review sweep failed: {e}`，
 *      再进内层 try 更新 cron 状态——若本轮 `st` 还没绑定（异常发生在
 *      get_evolution_engine 阶段），python 在 `st._db` 求值处抛 NameError，
 *      **被同一个内层 except Exception: pass 吞掉**，循环继续。端口用显式
 *      NameErrorP 复刻这条臂（外部可见行为一致，探针把"内层炸过一次"记进账本）。
 *  12. mailbox 通知：`from mailbox import send as _msend` 在 try 内（每轮），
 *      payload 是 `{"observed_goals": n}`（键序）；失败 print
 *      `mailbox notify failed: {e}`。
 *  13. 收尾 UPDATE cron 置 idle；异常文案 `str(e)[:200]` —— python 切片按**码点**。
 *
 * MIGRATION DECISIONS / DIVERGENCES
 *   DIVERGENCE(port, asyncio bridge): `asyncio.get_event_loop().create_task(_sweep())`
 *     → EVR_SEAMS.createTask。差异点：python 协程体在循环让出**之后**才执行
 *     第一句；端口用 microtask 推迟到当前同步段结束，探针里两侧账本顺序一致。
 *     python 任务异常若无人 retrieve 会被 asyncio 打日志；端口把异常存进
 *     PyTask，join() 时原样重抛（探针两侧都 await 收尾，取回同一异常身份）。
 *   DIVERGENCE(port, lazy import → seam): 五路 `from X import …`（evolution /
 *     storage / learning_service / episode_manager / mailbox）走 EVR_SEAMS 的
 *     模块装载器。默认实现动态 import 对应的已落地端口；learning_service 在
 *     本清单更靠后（wave-8 #5）、mailbox 是 Native→Rust，未落地时默认装载器抛
 *     `ImportError: No module named 'X'` —— 与 python 端 ModuleNotFoundError
 *     走同一条 except 臂（fail-open 文案逐字相同）。探针两侧都注入假模块；
 *     假模块无 __file__，`cannot import name 'X' from 'Y' (unknown location)`
 *     的括注与 python 对无源文件模块的渲染一致。
 *   DIVERGENCE(port, str/list rendering): f-string 的 {sealed_ep_ids} 走
 *     pyStrValue（list → "['a', 'b']" 单引号 repr），不是 JSON 双引号；
 *     {exc} 走 str(e) → Error.message。
 *   DIVERGENCE(port, set membership): python set 里 True==1/1.0==1 互相顶替；
 *     goalId 实际是字符串/None/整数（探针覆盖前两种），JS Set 用 SameValueZero，
 *     端口把 undefined 归一成 null 对齐 dict.get 的 None。
 *   探针杠杆：python 侧 monkeypatch `evolution_review.time` / `.asyncio` /
 *     `.logger` / `.print` + sys.modules 假件；端口侧对应 `EVR_SEAMS.*` 赋值 +
 *     `_reset_probe_state()`（模块全局 _task/_interval_s 的重置面——ESM 绑定
 *     不可外改，测试专用）。
 *
 *   NOTE: 决策全部代码化——忙闲信号、预算闸（时间/token 双维）、封存触发、
 *     观察立项去重，都是可读的纯逻辑；没有任何一处把裁决交给模型判断。
 */

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
class NameErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "NameError"; }
}
class OverflowErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "OverflowError"; }
}
class IndexErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "IndexError"; }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (typeof v === "string") return "str";
    if (Array.isArray(v)) return "list";
    if (v instanceof Error) return v.name;
    if (typeof v === "object") return (v as object).constructor?.name ?? "object";
    return typeof v;
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined || v === false) return false;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Set || v instanceof Map) return v.size > 0;
    return true;
}

/** python `int(x)`（本模块只吃 number 位——除 float 截断外无字符串路径）。 */
function pyInt(v: unknown): number {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") {
        if (Number.isNaN(v)) throw new ValueErrorP("cannot convert float NaN to integer");
        if (!Number.isFinite(v)) {
            throw new OverflowErrorP("cannot convert float infinity to integer");
        }
        return Math.trunc(v);
    }
    if (typeof v === "string") {
        let t = v.replace(/(?<=\d)_(?=\d)/g, "").trim();
        if (t.includes("_") || !/^[+-]?\d+$/.test(t)) {
            throw new ValueErrorP(`invalid literal for int() with base 10: '${v}'`);
        }
        return Number(t);
    }
    throw new TypeErrorP(
        `int() argument must be a string, a bytes-like object or a real number, ` +
        `not '${pyTypeName(v)}'`);
}

/** python `float(x)`：number 直通；str 走 CPython 文案（含数字间下划线规则：
 *  每个下划线两侧必须都是数字，"1__2"/"1_" 在 python 同样是 ValueError）。 */
function pyFloat(v: unknown): number {
    if (typeof v === "boolean") return v ? 1.0 : 0.0;
    if (typeof v === "number") return v;
    if (typeof v === "string") {
        let t = v.trim();
        t = t.replace(/(?<=\d)_(?=\d)/g, "");
        if (t.includes("_")) {
            throw new ValueErrorP(`could not convert string to float: '${v}'`);
        }
        if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
        if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
        if (/^nan$/i.test(t)) return NaN;
        throw new ValueErrorP(`could not convert string to float: '${v}'`);
    }
    throw new TypeErrorP(
        `float() argument must be a string or a real number, not '${pyTypeName(v)}'`);
}

/** python `now - row[k] > 1800`：非数参与减法 → CPython TypeError 文案。
 *  bool 在 python 里是 int 子类（now - True == now-1）；NaN/inf 直通算术。 */
function pySubFromInt(left: number, right: unknown): number {
    if (typeof right === "number") return left - right;
    if (typeof right === "boolean") return left - (right ? 1 : 0);
    throw new TypeErrorP(
        `unsupported operand type(s) for -: 'int' and '${pyTypeName(right)}'`);
}

/** python `str(x)` 对本模块可能出现的值形态。 */
function pyReprStr(s: string): string {
    const q = s.includes("'") && !s.includes("\"") ? "\"" : "'";
    const esc = s
        .replaceAll("\\", "\\\\")
        .replaceAll("\n", "\\n")
        .replaceAll("\r", "\\r")
        .replaceAll("\t", "\\t");
    return q + esc.replaceAll(q, "\\" + q) + q;
}

function pyNumStr(v: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return String(v);
}

function pyStrValue(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.message;
    if (Array.isArray(v)) return "[" + v.map(pyReprValue).join(", ") + "]";
    if (v instanceof Set) {
        if (v.size === 0) return "set()";
        return "{" + Array.from(v).map(pyReprValue).join(", ") + "}";
    }
    if (typeof v === "object") {
        const t = v as { toString(): string };
        return t.toString();
    }
    return String(v);
}

function pyReprValue(v: unknown): string {
    if (typeof v === "string") return pyReprStr(v);
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (Array.isArray(v)) return "[" + v.map(pyReprValue).join(", ") + "]";
    if (v instanceof Error) return `${pyTypeName(v)}(${pyReprStr(v.message)})`;
    if (isPlainObj(v)) {
        return "{" + Object.entries(v).map(([k, x]) =>
            pyReprStr(k) + ": " + pyReprValue(x)).join(", ") + "}";
    }
    return pyStrValue(v);
}

/** python `len(s)` 对 str 数码点。 */
function pyStrLen(s: string): number {
    return Array.from(s).length;
}

/** python `s[:200]`（码点截断）。 */
function pyStrTrunc(s: string, n: number): string {
    const a = Array.from(s);
    return a.length <= n ? s : a.slice(0, n).join("");
}

function isPlainObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v)
        && !(v instanceof Error) && !(v instanceof Map) && !(v instanceof Set);
}

/** python `dict.get(k)`（缺键 → undefined；Map 也可）。 */
function dictGet(o: unknown, k: string): unknown {
    if (o instanceof Map) return o.get(k);
    if (isPlainObj(o)) return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
    throw new AttributeErrorP(
        `'${pyTypeName(o)}' object has no attribute 'get'`);
}

/** python sqlite3.Row 的下标：缺列 → IndexError("No item with that key")
 *  （CPython 3.13 实测文案；生产 storage 的 row_factory 就是 sqlite3.Row）。 */
function rowSub(o: unknown, k: string): unknown {
    if (o instanceof Map) {
        if (!o.has(k)) throw new IndexErrorP("No item with that key");
        return o.get(k);
    }
    if (isPlainObj(o)) {
        if (!Object.prototype.hasOwnProperty.call(o, k)) {
            throw new IndexErrorP("No item with that key");
        }
        return o[k];
    }
    throw new TypeErrorP(`'${pyTypeName(o)}' object is not subscriptable`);
}

/** python 的 for-in 迭代协议（list/tuple/str 可迭代；其他炸文案）。 */
function pyIter(v: unknown): unknown[] {
    if (Array.isArray(v)) return v.slice();
    if (typeof v === "string") return Array.from(v);
    if (v instanceof Map) return Array.from(v.keys());
    if (v instanceof Set) return Array.from(v);
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not iterable`);
}

/** python json.dumps(..., ensure_ascii=False, default=str)。 */
function pyJsonDumpsDefaultStr(v: unknown): string {
    return jsonSer(v);
}
function jsonSer(v: unknown): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") {
        if (Number.isNaN(v)) return "NaN";
        if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
        return String(v);
    }
    if (typeof v === "string") return jsonStrLit(v);
    if (Array.isArray(v)) return "[" + v.map(jsonSer).join(", ") + "]";
    if (isPlainObj(v)) {
        // python 分得清 dict 和"别的对象"：dict 走序列化，其余走 default=str。
        // JS 里唯一的痕迹是原型：plain-literal/null 原型 = dict；类实例 = 对象。
        const proto = Object.getPrototypeOf(v);
        if (proto !== null && proto !== Object.prototype) {
            return jsonStrLit(pyStrValue(v));
        }
        return "{" + Object.keys(v)
            .map((k) => jsonStrLit(k) + ": " + jsonSer(v[k])).join(", ") + "}";
    }
    // python: default=str 兜住一切不可序列化成员（set/类实例/函数 → str()）
    return jsonStrLit(pyStrValue(v));
}
function jsonStrLit(s: string): string {
    let out = "\"";
    for (const ch of s) {
        const cp = ch.codePointAt(0) as number;
        if (ch === "\"") out += "\\\"";
        else if (ch === "\\") out += "\\\\";
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (ch === "\b") out += "\\b";
        else if (ch === "\f") out += "\\f";
        else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
        else out += ch; // ensure_ascii=False
    }
    return out + "\"";
}

/** python 缺参/多参 TypeError 文案。 */
function pyMissing(fname: string, names: readonly string[]): TypeErrorP {
    const q = names.map((s) => `'${s}'`);
    const list = q.length === 1 ? (q[0] as string)
        : q.length === 2 ? `${q[0]} and ${q[1]}`
            : q.slice(0, -1).join(", ") + ", and " + q[q.length - 1];
    const plural = names.length === 1 ? "positional argument" : "positional arguments";
    return new TypeErrorP(`${fname}() missing ${names.length} required ${plural}: ${list}`);
}

// ── module constants（与 py 同名同值）───────────────────────────────────────

export const _SCAN_LIMIT = 20;
export const _SWEEP_TIME_BUDGET_S = 120.0;
export const _SWEEP_TOKEN_BUDGET = 60_000;
export const _CHARS_PER_TOKEN_EST = 2.5;

// ── seams（测试注入面；默认实现 = 生产行为）─────────────────────────────────

export type AnyMod = Record<string, unknown>;

async function dynImport(name: string, hasPort: boolean): Promise<AnyMod> {
    if (!hasPort) {
        throw new ModuleNotFoundErrorP(`No module named '${name}'`);
    }
    const spec = `./${name}.js`;
    try {
        return (await import(spec)) as unknown as AnyMod;
    } catch (e) {
        if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
            throw new ModuleNotFoundErrorP(`No module named '${name}'`);
        }
        throw e;
    }
}

export const EVR_SEAMS = {
    /** python `time.time()` */
    now: (): number => Date.now() / 1000,
    /** python `time.monotonic()` */
    monotonic: (): number => Number(process.hrtime.bigint()) / 1e9,
    /** python `asyncio.sleep(seconds)` */
    sleep: (seconds: number): Promise<void> =>
        new Promise<void>((resolve) => { setTimeout(resolve, seconds * 1000); }),
    /** python `asyncio.get_event_loop().create_task(coro)` */
    createTask: (fn: () => Promise<void>): PyTask => new PyTask(fn),
    /** python `print(...)` */
    print: (text: string): void => { console.log(text); },
    /** python logger（% 惰性格式：fmt 与 args 分开传递，不预渲染）*/
    log: (level: "info" | "warning", fmt: string, args: unknown[]): void => {
        if (level === "warning") {
            console.error(`evolution_review: ${fmt}`
                + (args.length ? ` ${pyReprValue(args)}` : ""));
        }
    },
    evolutionModule: async (): Promise<AnyMod> => dynImport("evolution", true),
    storageModule: async (): Promise<AnyMod> => dynImport("storage", true),
    episodeManagerModule: async (): Promise<AnyMod> => dynImport("episode_manager", true),
    // learning_service.ts 在 wave-8 #5 落地；mailbox 是 Native→Rust。
    // 落地前默认走 python 同一条 ImportError 臂（fail-open）。
    learningServiceModule: async (): Promise<AnyMod> => dynImport("learning_service", false),
    mailboxModule: async (): Promise<AnyMod> => dynImport("mailbox", false),
};

/** 把 `from X import (a, b)` 的命名检查搬进运行时（缺名 → ImportError 文案）。 */
function needName(mod: AnyMod, name: string, from: string): unknown {
    if (typeof mod[name] !== "function") {
        throw new ImportErrorP(
            `cannot import name '${name}' from '${from}' (unknown location)`);
    }
    return mod[name];
}

// ── PyTask（asyncio.Task 的最小镜像：done()/join() 语义）────────────────────

export class PyTask {
    private _finished = false;
    private _error: unknown = null;
    readonly promise: Promise<void>;
    constructor(fn: () => Promise<void>) {
        // DIVERGENCE(port, asyncio bridge): microtask 推迟，模拟"循环让出后
        // 任务第一句才执行"。python 端协程体同样不在 create_task 的同步段里跑。
        this.promise = Promise.resolve().then(fn).then(
            () => { this._finished = true; },
            (e: unknown) => { this._finished = true; this._error = e; },
        );
    }
    done(): boolean { return this._finished; }
    /** python `await task`：正常完成即返回；异常原样重抛。 */
    async join(): Promise<void> {
        await this.promise;
        if (this._error !== null && this._error !== undefined) throw this._error;
    }
}

// ── module state ─────────────────────────────────────────────────────────────

let _task: PyTask | null = null;
let _interval_s = 900.0;

/** 探针专用：python 测试直接改模块全局；ESM 绑定不可外改，这里给重置面。 */
export function _reset_probe_state(): void {
    _task = null;
    _interval_s = 900.0;
}
/** 探针专用：镜像 python 测试里 `evolution_review._interval_s = x`（每轮现读）。 */
export function _set_interval_for_parity(v: number): void {
    _interval_s = v;
}
/** 探针专用：读取模块全局 `_interval_s` 当前值（ESM 绑定不可外读）。 */
export function _get_interval_for_parity(): number {
    return _interval_s;
}
export function _probe_task_state(): { exists: boolean; done: boolean | null } {
    return { exists: _task !== null, done: _task === null ? null : _task.done() };
}

// ── _busy ────────────────────────────────────────────────────────────────────

type DbCur = {
    fetchone(): unknown;
    fetchall(): unknown[];
    rowcount?: number;
};
type DbConn = {
    execute(sql: string, params?: unknown[]): DbCur;
    commit(): void;
};
type StorageLike = { _db(name: string): DbConn };

export function _busy(storage: unknown): boolean {
    /** 前台优先的代理信号：还有目标在跑/排队，就不占后台预算。 */
    try {
        const conn = (storage as StorageLike)._db("goals");
        const row = conn.execute(
            "SELECT COUNT(*) AS c FROM goals WHERE status IN ('running','queued')",
        ).fetchone();
        return pyTruth(row) && pyTruth(rowSub(row, "c"));
    } catch {
        return true; // 查不清就当忙——宁可不跑后台
    }
}

// ── _reconcile_boot_lease ────────────────────────────────────────────────────

export async function _reconcile_boot_lease(storage: unknown): Promise<void> {
    /** Boot-time reconciliation (P1-3 & P1-8). */
    try {
        const nowTs = pyInt(EVR_SEAMS.now());
        const row = (storage as StorageLike)._db("cron").execute(
            "SELECT status, running_since FROM cron_jobs WHERE id='job_evolution_review'",
        ).fetchone();
        let stale = false;
        if (pyTruth(row)) {
            if (rowSub(row, "status") === "running") {
                stale = true;
            } else {
                const rs = rowSub(row, "running_since");
                if (pyTruth(rs)) stale = pySubFromInt(nowTs, rs) > 1800;
            }
        }
        if (stale) {
            (storage as StorageLike)._db("cron").execute(
                "UPDATE cron_jobs SET status='idle', running_since=0, "
                + "last_error='Recovered from previous process restart/stale lease' "
                + "WHERE id='job_evolution_review'",
            );
            (storage as StorageLike)._db("cron").commit();
            EVR_SEAMS.log("info",
                "[evolution_review] reconciled orphaned background review lease on boot", []);
        }
    } catch (exc: unknown) {
        EVR_SEAMS.log("warning",
            `[evolution_review] boot lease reconciliation ignored: ${pyStrValue(exc)}`, []);
    }

    // Reconcile any in-flight mutation operations
    try {
        const mod = await EVR_SEAMS.learningServiceModule();
        const fn = needName(mod, "reconcile_learning_item_operations", "learning_service");
        (fn as (s: unknown) => void)(storage);
    } catch (opExc: unknown) {
        EVR_SEAMS.log("warning",
            `[evolution_review] boot operation reconciliation failed: ${pyStrValue(opExc)}`, []);
    }
}

// ── _sweep（python 里嵌套在 start_background_review 的协程；提为模块级，
//    闭包不捕获任何东西，行为不变——见头部 DIVERGENCE 说明）─────────────────

async function _sweepBody(): Promise<void> {
    const evoMod = await EVR_SEAMS.evolutionModule();
    const buildGoalObservation = needName(evoMod, "build_goal_observation", "evolution") as
        (gid: unknown, st: unknown) => unknown;
    const getEvolutionEngine = needName(evoMod, "get_evolution_engine", "evolution") as
        () => unknown;
    const recordGoalValidationEdges = needName(evoMod, "record_goal_validation_edges", "evolution") as
        (obs: unknown, st: unknown) => unknown;
    const stoMod = await EVR_SEAMS.storageModule();
    const getStorage = needName(stoMod, "get_storage", "storage") as
        () => unknown;
    const lsMod = await EVR_SEAMS.learningServiceModule();
    const reconcile = needName(lsMod, "reconcile_learning_item_operations", "learning_service") as
        (s: unknown) => void;

    // Boot reconciliation
    try {
        const stInit = getStorage();
        await _reconcile_boot_lease(stInit);
    } catch {
        /* python: except Exception: pass */
    }

    // python 的 `st` 是协程帧上的局部名，**跨 while 迭代持续**：第一轮绑定后，
    // 后续轮次若在 `st = get_storage()` 之前抛错，外层 except 里的 `st._db`
    // 用的是**上一轮的旧绑定**（不会 NameError）。探针 d10 钉死这条臂。
    let stAssigned = false;
    let st: unknown = undefined;
    for (;;) {
        await EVR_SEAMS.sleep(_interval_s);
        try {
            const engine = getEvolutionEngine() as {
                enabled(): unknown;
                store: { list_observations(opts: { limit: number }): unknown };
                observe(obs: unknown): unknown;
            };
            if (!pyTruth(engine.enabled())) continue;
            st = getStorage();
            stAssigned = true;
            if (_busy(st)) continue;

            // Durable lease and status record keeping in cron db
            try {
                const nowTs = pyInt(EVR_SEAMS.now());
                (st as StorageLike)._db("cron").execute(
                    "INSERT INTO cron_jobs (id, name, cron_expr, prompt, status, "
                    + "next_run_at, running_since, last_error) "
                    + "VALUES ('job_evolution_review', 'Evolution Background Review', "
                    + "'*/15 * * * *', 'Review completed goals and idle episodes', "
                    + "'running', ?, ?, '') "
                    + "ON CONFLICT(id) DO UPDATE SET running_since=excluded.running_since, "
                    + "status='running', next_run_at=excluded.next_run_at",
                    [nowTs + pyInt(_interval_s), nowTs],
                );
                (st as StorageLike)._db("cron").commit();
            } catch {
                /* python: except Exception: pass */
            }

            // Reconcile any hanging operations (P1-3)
            try {
                reconcile(st);
            } catch (rE: unknown) {
                EVR_SEAMS.log("warning",
                    `[evolution_review] periodic operation reconcile failed: ${pyStrValue(rE)}`, []);
            }

            // 自动检查并封存静默超过 30 分钟的无 Goal 普通对话片段（Phase 4 & 24）
            try {
                const epMod = await EVR_SEAMS.episodeManagerModule();
                const getEp = needName(epMod, "get_episode_manager", "episode_manager") as
                    (s: unknown) => {
                        check_idle_episodes(opts: { idle_timeout_s: number }): unknown;
                    };
                const em = getEp(st);
                const sealed = em.check_idle_episodes({ idle_timeout_s: 1800.0 });
                if (pyTruth(sealed)) {
                    EVR_SEAMS.print(
                        `[evolution] background review sealed ${pyIter(sealed).length}`
                        + ` idle episode(s): ${pyStrValue(sealed)}`);
                }
            } catch (epE: unknown) {
                EVR_SEAMS.print(`[evolution] idle episode sweep failed: ${pyStrValue(epE)}`);
            }

            const rows = (st as StorageLike)._db("goals").execute(
                "SELECT id FROM goals WHERE status = 'completed'"
                + " ORDER BY updated_at DESC LIMIT ?",
                [_SCAN_LIMIT],
            ).fetchall();
            const have = new Set<unknown>();
            for (const o of pyIter(engine.store.list_observations({ limit: 200 }))) {
                const g = dictGet(o, "goalId");
                have.add(g === undefined ? null : g);
            }
            let n = 0;
            const t0 = EVR_SEAMS.monotonic();
            let tokensSpent = 0;
            let budgetHit = "";
            for (const r of pyIter(rows)) {
                const gid = rowSub(r, "id");
                if (have.has(gid === undefined ? null : gid)) continue;
                // 时间预算帽：超了就收手，剩余目标下轮再处理。
                if (EVR_SEAMS.monotonic() - t0 > _SWEEP_TIME_BUDGET_S) {
                    budgetHit = "time";
                    break;
                }
                const obs = buildGoalObservation(gid, st);
                if (obs === null) continue; // python `is None`
                // token 账本（估算失败只跳过记账，不阻塞本轮）
                try {
                    const obsSize = pyStrLen(
                        pyJsonDumpsDefaultStr(
                            (obs as { to_dict(): unknown }).to_dict()));
                    tokensSpent += pyInt(obsSize / _CHARS_PER_TOKEN_EST);
                } catch {
                    /* python: except Exception: pass */
                }
                if (tokensSpent > _SWEEP_TOKEN_BUDGET) {
                    budgetHit = "tokens";
                    break;
                }
                engine.observe(obs);
                try {
                    recordGoalValidationEdges(obs, st);
                } catch {
                    /* fail-open: 可选增强，失败不影响主流程 */
                }
                n += 1;
            }
            if (budgetHit) {
                EVR_SEAMS.log("info",
                    "[evolution_review] sweep %s budget hit after %d goal(s) "
                    + "(~%d est. tokens); remaining targets deferred to next cycle",
                    [budgetHit, n, tokensSpent]);
            }
            if (pyTruth(n)) {
                EVR_SEAMS.print(`[evolution] background review observed ${n} goal(s)`);
                try {
                    const mbMod = await EVR_SEAMS.mailboxModule();
                    const msend = needName(mbMod, "send", "mailbox") as
                        (
                            st0: unknown, to: string, sender: string,
                            opts: { kind: string; payload: Record<string, unknown> },
                        ) => void;
                    msend(st, "system:evolution", "evolution-review",
                        { kind: "info", payload: { "observed_goals": n } });
                } catch (e: unknown) {
                    EVR_SEAMS.print(`[evolution] mailbox notify failed: ${pyStrValue(e)}`);
                }
            }

            try {
                (st as StorageLike)._db("cron").execute(
                    "UPDATE cron_jobs SET status='idle', running_since=0, last_error='' "
                    + "WHERE id='job_evolution_review'",
                );
                (st as StorageLike)._db("cron").commit();
            } catch {
                /* python: except Exception: pass */
            }
        } catch (e: unknown) {
            EVR_SEAMS.print(`[evolution] review sweep failed: ${pyStrValue(e)}`);
            try {
                if (!stAssigned) {
                    throw new NameErrorP(
                        "cannot access local variable 'st' where it is not associated "
                        + "with a value");
                }
                (st as StorageLike)._db("cron").execute(
                    "UPDATE cron_jobs SET status='idle', running_since=0, last_error=? "
                    + "WHERE id='job_evolution_review'",
                    [pyStrTrunc(pyStrValue(e), 200)],
                );
                (st as StorageLike)._db("cron").commit();
            } catch {
                /* python: except Exception: pass —— NameError 也走这条臂 */
            }
        }
    }
}

// ── start_background_review ──────────────────────────────────────────────────

export function start_background_review(
    _router: unknown,
    intervalS?: unknown,
): boolean {
    /** 启动周期扫描任务。已在跑则幂等返回 False。 */
    if (arguments.length < 1) throw pyMissing("start_background_review", ["router"]);
    if (arguments.length > 2) {
        throw new TypeErrorP(
            `start_background_review() takes from 1 to 2 positional arguments `
            + `but ${arguments.length} were given`);
    }
    if (_task !== null && !_task.done()) return false;
    _interval_s = intervalS === undefined ? 900.0 : pyFloat(intervalS);
    _task = EVR_SEAMS.createTask(_sweepBody);
    return true;
}

// PORT STATUS: 本文件无 TODO(port)。
