/**
 * goal_scheduler.ts — 自主目标的后台调度器（plan → execute → verify）。
 *
 * Ported from `app/backend/goal_scheduler.py` (1429 lines, wave-8, unit 177, SPLIT).
 * 目标级并发帽 2、成本帽 $5、心跳租约、卡死熔断、机器验证门、每轮明细行、
 * 实时 WS 事件——全部按原语义逐字移植。
 *
 * BUG-FOR-BUG FACTS (pinned by the parity probe)
 *   1. 触发语义：**手动**。只有 `enqueue()` 会把目标放进队列；调度器不会自己
 *      启动任何目标（`_tick_loop` 只做补位与收割）。
 *   2. `enqueue` 的拒绝次序：不存在 → 已 running/queued → stopping →
 *      stop_timeout → 并发帽。并发满时**入队**并返回
 *      `{"status": "queued", "position": queue.qsize()}`——qsize 是 put 之后
 *      的值（含刚放进去的这个）；有空位则直接 spawn 并返回 `{"status": "running"}`
 *      （没有 position 键，两条臂的形态不同）。
 *   3. `active_count` 只数 `self._workers` 里 `not t.done()` 的；心跳任务不算。
 *   4. 租约三件套全部**按身份**：`claim_goal(gid, STALE_CLAIM_SEC, owner=, lease_seconds=)`
 *      → `renew_goal_claim(gid, owner, CLAIM_LEASE_SEC)` → `release_goal(gid, owner)`。
 *      owner 形如 `f"{PROCESS_GENERATION}:{uuid4().hex[:8]}"`。release 被拒
 *      （别人合法持有）→ 只记 `goal.claim_release_rejected`，绝不改别人的锁。
 *   5. `_spawn_worker` 的双闸：worker 还活着 **或** 心跳还活着都直接 return——
 *      注册表是 pause()/stop() 唯一的把手，覆盖它等于把目标变成"停不掉"。
 *   6. 暂停是**状态机**：running → stopping →（宽限内确认）paused；确认不了落
 *      `stop_timeout`，DB/账本/返回值三处都如实说 stop_timeout。
 *      `confirm_stopped` 只在 worker 确实没了的时候才放行，且顺序是先看 worker
 *      再看状态（worker 还活着时哪怕状态被人改成 paused 也照样拒绝）。
 *   7. `PAUSE_GRACE_SEC:g` —— python 的 `:g` 把 5.0 渲染成 "5"（不是 "5.0"），
 *      端口必须走 pyFormatG；`live` 列表拼进文案时取 `[:3]`、账本取 `[:8]`。
 *   8. `stop()`：先对**每个** worker `_hard_cancel_router`，再统一 `cancel()`，
 *      再 `await asyncio.wait({全部}, timeout=宽限)`；没停下来的只 print
 *      `did not stop within 5s at shutdown` 一句，随后一律 `_finish_worker`。
 *   9. 成本记账：`Result.meta["usage"]` 的 `cost_micros`/`tokens` 走 `int()`
 *      （向零截断；TypeError/ValueError → **两个都归 0**）；`micros <= 0` 时
 *      改成 `FALLBACK_ROUND_MICROS = 2000` 且 `cost_source` 改写为 "fallback"。
 *      `over_cap` 判据是 **`>=`**（等于帽顶即超）。失败文案里的上限用的是
 *      **行上的 cost_cap**，不是本次 spend 返回的 cap。
 *  10. 卡死检测两条臂都要：同签名连续 `MAX_SAME_ACTION_REPEATS(3)` 轮；或最近
 *      `STUCK_WINDOW(4)` 轮不同签名 ≤ `STUCK_DISTINCT_MAX(2)`（A-B-A-B 抖动）。
 *      签名窗口是 `sig_window = max(4, 3) = 4`，且 `len > sig_window` 才 `pop(0)`。
 *  11. 签名来自**做了什么**：`round_signature` 用 tool_trace 的
 *      `工具名:md5(json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)[:400])[:8]`，
 *      最多取前 `MAX_SIGNATURE_CALLS(6)` 个；没有工具调用时退回
 *      `"text:" + md5(规范化文本)[:12]`，规范化＝小写 → `_VOLATILE_RE` 把十六进制
 *      串和数字整体换成 `#` → 空白折叠 → 码点截 400。
 *  12. `_plan_progress` 只认 `status == "completed"` 的 dict 项；ratio 是
 *      **浮点除法**（2/2 = 1.0），无计划时 None（UI 显示状态而不是进度条）。
 *      `goal_view` 里 `plan` 那一路 json.loads 是**不兜异常**的（另四路兜）。
 *  13. 成本显示：`round(cost_micros / 1_000_000, 4)` / `round(cap / 1_000_000, 2)`
 *      —— CPython 的 round 是**精确二进制值上的 half-to-even**，端口用 pyRound。
 *      `verification_result` 空串 → None；`brief_json` 为 `"{}"` → None
 *      （区分"没有合同"和"空合同"）。
 *  14. 轮次是**累计**的：`rounds_done = int(row["iteration"] or 0)`，续跑不再
 *      从 1 开始编号（`goal_iterations` 对 (goal_id, ordinal) 是 UPDATE 幂等，
 *      重新数会把断电前那轮的证据覆盖掉）。开局 `iteration >= limit` → 直接
 *      失败并说明"累计已跑 N 轮"。
 *  15. 合同预算覆盖是 fail-open：`max_repair_attempts > 0` 才顶掉默认；
 *      `max_iterations > 0` 才 `limit = min(limit, 合同值)`。修复轮**逐次 `limit += 1`**，
 *      不是 `max_iter + repairs_used`（后者会把合同压低过的上限又顶回全局默认）。
 *  16. U5 交付提示铁律：**提示只能佐证，物理门禁永远终裁**。
 *      `evidence_with_hints` 在原始证据为空/全空白时**一个字都不加**——否则
 *      纯提示就把 heuristic 的"有证据才算过"判据翻转了。
 *      `collect_delivery_hints` 只认 payload 里键恰为 `delivery_hint`、值恰为
 *      `deliverable|handoff`；空串/缺键/大小写不符/非 dict 一律当无提示，
 *      且对任何脏输入都不抛异常。`_iter_hint_payloads` 里**列表层透明穿过不耗
 *      深度**，dict 嵌套才 +1（封顶 `_HINT_MAX_DEPTH = 2`），用 id 集合挡自引用。
 *  17. handoff 接管信号**按轮去重**：`handoff_count` 比上次发出去的大才发，
 *      detail 取最新一条非空。
 *  18. `_note_failure` 复用 `system.error_logged`（trace_gateway 拒未知事件类型），
 *      payload 键序是 `kind, goal_id, **detail`——detail 里若带 `goal_id`
 *      会**覆盖**前一个；session 路由取 `_session_of_goal(gid) or gid`。
 *  19. `_record_round` 永不抛：写失败先 print 再补一条
 *      `goal.round_record_failed` 账（否则轮次列表只会凭空少一个号）。
 *  20. 机器验证只在**模型自称完成**时跑（`if passed`）：被拒绝的目标本来就要
 *      再来一轮，跑全套测试换不来任何信息。`_machine_verify` 崩了退化成
 *      `{"ran": False, "passed": False, "skipped": True, "skipReason": "验证没能执行：…"}`
 *      —— 闸门坏了不能把目标判死。
 *  21. verdict 三态：`passed` / `verify_failed`（门禁跑过且没过）/
 *      `rejected`；reason 只有"门禁跑过且 passed=False"时取 gate.summary，
 *      否则取 verdict.reason。合同门把 passed 翻回 False 时，**verdict 已经写完了**
 *      （写的是 passed）——原码如此。
 *  22. 合同门的 validator 事件：`{"passed":…,"skipped":…}.get(status, "validator.failed")`、
 *      `evidence[:4]`（**码点**切片）、importance  observational/critical 二选一、
 *      `verification_result` 写的是 `json.dumps(...)`（**ensure_ascii 默认 True**，
 *      非 ASCII 会变成 \uXXXX）+ `reason[:400]`。
 *  23. 检查点是**延迟导入 + 各自 try/except print**：每轮、完成、外部停止、
 *      CancelledError 四条臂都写；文案前缀分别是
 *      `[goals] round checkpoint failed:` / `completion checkpoint failed:` /
 *      `external-stop checkpoint failed:` / `pause checkpoint failed:`。
 *  24. `except asyncio.CancelledError` 臂：写 paused 快照 → `_finish_worker` →
 *      **re-raise**。吞掉它会让 `task.cancelled()` 变 False，pause 就没法区分
 *      "停了"和"没停"，只能报"已暂停"这种假话。
 *  25. 预检失败**拒绝进入 running**：`resume_from_checkpoint` 崩溃 →
 *      "checkpoint 预检崩溃…"；`ok` 为假 → "checkpoint 预检未通过：{problems
 *      用中文分号 '；' 连接}"，没有 problems 时说"未知原因"。没有检查点的全新
 *      目标直接放行、不带账本块。
 *  26. `_emit_change` 是**分离派发**：`get_event_loop().call_soon(lambda:
 *      ensure_future(bus.emit(...)))`，没有运行中的循环时 RuntimeError → pass
 *      （单测场景）。payload 键序 `goal_id, status, session_id, **extra`。
 *  27. `_emit_stage` 双层 fail-open：`extra` 非 dict 当空；任何异常自吞并 print
 *      `stage event failed for {gid}: {exc}`。终态事件一律不带 stage。
 *  28. 单例：`get_goal_scheduler()` 首次调用必须给 router+bus，否则
 *      `RuntimeError("GoalScheduler must be initialized with router and bus on first call")`。
 *
 * MIGRATION DECISIONS / DIVERGENCES
 *   DIVERGENCE(port, asyncio bridge): `asyncio.create_task / sleep / wait / Queue /
 *     get_event_loop().call_soon` 全部走 `GS_SEAMS`。端口的 PyTask 是真 promise
 *     链：`done()/cancelled()/exception()` 对齐 python 观察面；`cancel()` 在
 *     python 是"下一个 await 点抛 CancelledError"，端口只能落在**自己的**下一个
 *     让出点（foreign await 内部注入做不到）——探针里 fake router 的挂起同样
 *     经过 `GS_SEAMS.sleep`，因此两侧注入点一致；生产里停用的真手段是
 *     `_hard_cancel_router`（杀在跑的 + 置 cancel token），不是靠 task.cancel。
 *     `asyncio.wait(tasks, timeout)` 的生产默认实现是轮询（python 是事件驱动），
 *     行为差异只在 tick 粒度。`asyncio.ensure_future` 的异常在 python 由
 *     asyncio 打日志；端口挂 `.catch` 吞掉（探针两侧都不产生用户可见差异）。
 *     python 的协程对象是惰性的（`ensure_future` 只排队，函数体下一次循环迭代才
 *     跑），JS 的 async 函数一调用就跑到第一个 await——所以 `ensureFuture` 收的是
 *     **thunk**，在下一个宏任务上启动，排程次序与 python 一致。
 *     python 的 `await` 遇到非 awaitable 会抛 `TypeError: object X can't be
 *     used in 'await' expression`；JS 的 `await` 对同值直接放行。桩件的
 *     `handle`/`emit`/`continue_goal` 因此**必须**返回 Promise，探针在装配处
 *     用 `Promise.resolve` 归一，两侧观察面一致。
 *   DIVERGENCE(port, lazy import → provider): `recovery` / `acceptance_contract` /
 *     `goal_plan` 在本清单里是 Native→Rust（`verified/` 有记录，engine 下没有
 *     对应 .ts），端口沿用 `goal_manager.ts` 的**注入面**约定：
 *     `set_*_provider(p)`，未注入时抛与 python 同位的
 *     `ModuleNotFoundError("No module named 'X'")`，文案逐字相同，走的也是同一条
 *     except 臂。差异点：python 的 `import goal_plan` 在**模块导入期**就会炸；
 *     端口推到首次使用 —— `_ensure_plan` 有自己的 try（只 print 播种失败），
 *     `_opening_prompt` 在 `_run_worker` 的 try **之外**，异常直接终结 worker
 *     （不写失败态，任务带着该错误结束，与 python 里任务异常无人取走同形），
 *     `apply_completion` 才落到 `Unhandled exception: No module named 'goal_plan'`
 *     那条臂。`checkpoint` 已落地，
 *     默认装载器直接给它真模块，探针仍可换成抛错的假件来钉 ImportError 臂。
 *   DIVERGENCE(port, tuple≡list): `_preflight_checkpoint` 的三元组、
 *     `check_completion` 的三元组、`apply_completion` 的二元组在端口都是数组，
 *     python 的 tuple 标签在这一层不可观察（两端比较时由探针按位置对齐）。
 *   DIVERGENCE(port, str() of a class instance): `str(evidence)` 若拿到类的实例，
 *     python 打 `<module.Cls object at 0x…>`，地址不可复现，端口打
 *     `<Cls object>`（与 team.ts 同一处置）。
 *   DIVERGENCE(port, json.loads error text): 五个 json.loads 点里四个吞异常，
 *     唯一不吞的是 `goal_view.plan`；端口复刻 CPython 的
 *     `Expecting value: line 1 column 1 (char 0)` 形态而不复刻任意位置的
 *     行列号（该臂在本模块内没有调用方兜异常，生产入参恒为合法 JSON 或假值）。
 *   DIVERGENCE(port, str.lower / re.\b): `_text_signature` 的小写折叠用 JS
 *     toLowerCase、`\b` 用 JS 的 ASCII 词边界；python 两者都是 Unicode 感知。
 *     签名只用来**比较**，两侧各自稳定即可，不影响判定；探针不喂非 ASCII 大写。
 *
 *   NOTE: 决策全部代码化——并发帽、租约归属、成本熔断、卡死判定、验证门、
 *     合同闸、检查点预检都是纯逻辑；模型只提方案，拍板的永远是代码。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import { Result } from "./result.js";
import { get_storage, PROCESS_GENERATION } from "./storage.js";
import { GoalStatus, get_goal_manager } from "./goal_manager.js";
import { EventType } from "./event_types.js";
import * as verify_gate from "./verify_gate.js";

// ── python-semantics helpers (house style: file-local) ───────────────────────

type JsonDict = Record<string, unknown>;

class TypeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "TypeError"; }
}
class ValueErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ValueError"; }
}
/** python json.JSONDecodeError（ValueError 子类；name 用叶子类名）。 */
class JSONDecodeErrorP extends ValueErrorP {
    constructor(msg: string) { super(msg); this.name = "JSONDecodeError"; }
}
class AttributeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "AttributeError"; }
}
class ImportErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ImportError"; }
}
class ModuleNotFoundErrorP extends ImportErrorP {
    constructor(msg: string) { super(msg); this.name = "ModuleNotFoundError"; }
}
class OverflowErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "OverflowError"; }
}
/** python `asyncio.CancelledError`（BaseException；str() 为空串）。 */
export class CancelledErrorP extends Error {
    constructor() { super(""); this.name = "CancelledError"; }
}
/** python `asyncio.TimeoutError` == 内置 TimeoutError（3.11+）。 */
class TimeoutErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "TimeoutError"; }
}
/** python `asyncio.QueueEmpty(Exception)`：str() 为空串（raise 时无参）。 */
class QueueEmptyP extends Error {
    constructor() { super(""); this.name = "QueueEmpty"; }
}
/** python `RuntimeError`（_emit_change 只兜这一类）。 */
export class RuntimeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "RuntimeError"; }
}

function isFunction(v: unknown): boolean {
    return typeof v === "function";
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (v instanceof Set) return "set";
    if (v instanceof Map) return "dict";
    if (typeof v === "function") return "function";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
    }
    return typeof v;
}

/** house predicate: a value that IS a python dict — plain or prototype-less. */
function isPyDict(v: unknown): boolean {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    if (v instanceof Error) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "function") return true;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    if (v instanceof Error) return true;
    if (isPyDict(v)) return Object.keys(v as JsonDict).length > 0;
    return true;
}

function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

function pyNumStr(v: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return String(v);
}

function pyReprStr(s: string): string {
    const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
    const esc = s.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")
        .replaceAll("\r", "\\r").replaceAll("\t", "\\t");
    if (quote === "'") return "'" + esc.replaceAll("'", "\\'") + "'";
    return '"' + esc.replaceAll('"', '\\"') + '"';
}

function pyRepr(v: unknown): string {
    if (typeof v === "string") return pyReprStr(v);
    return pyStr(v);
}

/** python `str(x)`（容器走 repr；异常走 message；类实例见 DIVERGENCE）。 */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.message;
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Set) {
        if (v.size === 0) return "set()";
        return "{" + Array.from(v).map(pyRepr).join(", ") + "}";
    }
    if (v instanceof Map) {
        return "{" + Array.from(v.entries())
            .map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
    }
    if (typeof v === "object") {
        const o = v as JsonDict;
        const ctorName = (v as { constructor?: { name?: string } }).constructor?.name;
        if (ctorName && ctorName !== "Object") return `<${ctorName} object>`;
        return "{" + Object.keys(o).map((k) => pyRepr(k) + ": " + pyRepr(o[k])).join(", ") + "}";
    }
    return String(v);
}

/** python `str.strip()`（无参＝isspace() 集）。 */
const PY_SPACE_ONE =
    /[\x09\x0a\x0b\x0c\x0d\x1c\x1d\x1e\x1f\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
function pyStrip(s: string): string {
    let a = 0;
    let b = s.length;
    while (a < b && PY_SPACE_ONE.test(s[a] as string)) a++;
    while (b > a && PY_SPACE_ONE.test(s[b - 1] as string)) b--;
    return s.slice(a, b);
}

/** python `str.lower()`（端口用全量折叠，见 DIVERGENCE 说明）。 */
function pyLower(s: string): string {
    return s.toLowerCase();
}

/** python `s.split()` 无参：按 isspace() 成段切，丢掉空段。 */
function pySplitWhitespace(s: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inRun = false;
    for (const ch of s) {
        if (PY_SPACE_ONE.test(ch)) {
            if (inRun) { out.push(cur); cur = ""; inRun = false; }
            continue;
        }
        cur += ch;
        inRun = true;
    }
    if (inRun) out.push(cur);
    return out;
}

function pyIter(v: unknown): unknown[] {
    if (typeof v === "string") return Array.from(v);
    if (Array.isArray(v)) return v.slice();
    if (v instanceof Map) return Array.from(v.keys());
    if (v instanceof Set) return Array.from(v);
    if (isPyDict(v)) return Object.keys(v as JsonDict);
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not iterable`);
}

/** python `len(x)`（str 数码点）。 */
function pyLen(v: unknown): number {
    if (typeof v === "string") return Array.from(v).length;
    if (Array.isArray(v)) return v.length;
    if (v instanceof Map || v instanceof Set) return v.size;
    if (isPyDict(v)) return Object.keys(v as JsonDict).length;
    throw new TypeErrorP(`object of type '${pyTypeName(v)}' has no len()`);
}

/** python `s[:n]` —— 码点截断。 */
function pyStrTrunc(s: string, n: number): string {
    const a = Array.from(s);
    return a.length <= n ? s : a.slice(0, n).join("");
}

/** python `int(x)` 的三条 CPython 文案。 */
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
        const t = pyStrip(v);
        const m = /^([+-]?)((?:\d_?)*\d)?$/.exec(t);
        if (!m || !m[2] || /__/.test(t)) {
            throw new ValueErrorP(`invalid literal for int() with base 10: ${pyReprStr(v)}`);
        }
        const n = Number(t.replace(/_/g, ""));
        return m[1] === "-" ? -n : n;
    }
    throw new TypeErrorP(
        `int() argument must be a string, a bytes-like object or a real number, ` +
        `not '${pyTypeName(v)}'`);
}

/** 把 double 拆成精确有理数 m·2^e（pyRound/pyFormatF/pyFormatG 共用）。 */
function exactRational(a: number): { m: bigint; e: number } {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setFloat64(0, a);
    const bits = buf.getBigUint64(0);
    const rawExp = Number((bits >> 52n) & 0x7ffn);
    const frac = bits & ((1n << 52n) - 1n);
    if (rawExp === 0) return { m: frac, e: -1074 };
    return { m: frac | (1n << 52n), e: rawExp - 1075 };
}

/** CPython 的 round(x, nd)：精确二进制值上的 half-to-even。 */
function pyRound(v: number, nd: number): number {
    if (!Number.isFinite(v)) return v;
    const neg = v < 0;
    const a = Math.abs(v);
    const scale = 10n ** BigInt(nd);
    const { m, e } = exactRational(a);
    let num = m * scale;
    let den = 1n;
    if (e < 0) den = 1n << BigInt(-e);
    else num <<= BigInt(e);
    const q = num / den;
    const r = num % den;
    const twice = r * 2n;
    let rounded = q;
    if (twice > den || (twice === den && (q & 1n) === 1n)) rounded = q + 1n;
    const out = Number(rounded) / Number(scale);
    return neg ? -out : out;
}

/** python `f"{v:.4f}"` / `:.2f`：定点、half-to-even、永远带小数点。 */
function pyFormatF(v: number, nd: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    const neg = v < 0 || Object.is(v, -0);
    const { m, e } = exactRational(Math.abs(v));
    let num = m * 10n ** BigInt(nd);
    let den = 1n;
    if (e < 0) den = 1n << BigInt(-e);
    else num <<= BigInt(e);
    let q = num / den;
    const r = num % den;
    const twice = r * 2n;
    if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
    const digits = q.toString(10).padStart(nd + 1, "0");
    const cut = digits.length - nd;
    const out = nd > 0 ? digits.slice(0, cut) + "." + digits.slice(cut) : digits;
    return (neg ? "-" : "") + out;
}

/** python `f"{v:g}"`：6 位有效数字，指数区间 [-4, 6)，尾零抹掉。 */
function pyFormatG(v: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    if (v === 0) return "0";
    const neg = v < 0;
    const a = Math.abs(v);
    // 精确十进制展开（足够判定第 7 位是否 >5 / ==5 后还有非零）
    const { m, e } = exactRational(a);
    let num: bigint;                 // value = num · 10^pointExp
    let pointExp: number;
    if (e >= 0) {
        num = m << BigInt(e);
        pointExp = 0;
    } else {
        num = m * 5n ** BigInt(-e);
        pointExp = e;
    }
    const s = num.toString(10);
    // 从**最高位有效数字**起写的完整数字串：整数补末尾零，小数的前置零不算
    // 有效位（值到这一串就结束了，再往后全是零）。
    const flat = pointExp >= 0 ? s + "0".repeat(pointExp) : s;
    let exp10 = flat.length - 1 + Math.min(pointExp, 0);   // 最高位的十进制指数
    // 6 位有效数字舍入（half-to-even 判在**精确值**上）
    const head = flat.padEnd(7, "0").slice(0, 7);
    const sig = Array.from(head.slice(0, 6));
    const roundDigit = Number(head[6]);
    const restNonZero = /[1-9]/.test(flat.slice(7));
    if (roundDigit > 5 || (roundDigit === 5
        && (restNonZero || Number(sig[5] as string) % 2 === 1))) {
        for (let i = sig.length - 1; i >= 0; i--) {
            const d = Number(sig[i] as string) + 1;
            if (d === 10) { sig[i] = "0"; if (i === 0) { sig.unshift("1"); exp10 += 1; break; } }
            else { sig[i] = String(d); break; }
        }
    }
    let mant = sig.join("").replace(/0+$/, "");
    if (mant === "") mant = "0";
    let out: string;
    if (exp10 < -4 || exp10 >= 6) {
        out = mant.length === 1 ? mant : mant.slice(0, 1) + "." + mant.slice(1);
        const sign = exp10 < 0 ? "-" : "+";
        out += "e" + sign + String(Math.abs(exp10)).padStart(2, "0");
    } else if (exp10 < 0) {
        out = "0." + "0".repeat(-exp10 - 1) + mant;
    } else if (exp10 >= mant.length - 1) {
        out = mant + "0".repeat(exp10 - (mant.length - 1));
    } else {
        out = mant.slice(0, exp10 + 1) + "." + mant.slice(exp10 + 1);
    }
    return (neg ? "-" : "") + out;
}

function pyMax(a: number, b: number): number {
    return a >= b ? a : b;
}

/** python's missing-argument TypeError. */
function pyMissing(fname: string, names: readonly string[]): TypeErrorP {
    const q = names.map((s) => `'${s}'`);
    const list = q.length === 1
        ? (q[0] as string)
        : q.length === 2
            ? `${q[0]} and ${q[1]}`
            : q.slice(0, -1).join(", ") + ", and " + q[q.length - 1];
    const plural = names.length === 1 ? "positional argument" : "positional arguments";
    return new TypeErrorP(`${fname}() missing ${names.length} required ${plural}: ${list}`);
}

/** python `hasattr` / `getattr(obj, name, default)`（dict 不是属性来源）。 */
function pyHasAttr(obj: unknown, name: string): boolean {
    if (obj === null || obj === undefined) return false;
    if (isPyDict(obj)) return false;
    return (obj as Record<string, unknown>)[name] !== undefined;
}
function pyGetAttr(obj: unknown, name: string, dflt?: unknown): unknown {
    if (obj === null || obj === undefined) {
        if (dflt !== undefined) return dflt;
        throw new AttributeErrorP(
            `'${pyTypeName(obj)}' object has no attribute '${name}'`);
    }
    if (isPyDict(obj)) {
        if (dflt !== undefined) return dflt;
        throw new AttributeErrorP(
            `'${pyTypeName(obj)}' object has no attribute '${name}'`);
    }
    const v = (obj as Record<string, unknown>)[name];
    if (v === undefined) {
        if (dflt !== undefined) return dflt;
        throw new AttributeErrorP(
            `'${(obj as { constructor?: { name?: string } }).constructor?.name ?? pyTypeName(obj)}' ` +
            `object has no attribute '${name}'`);
    }
    return v;
}

/** python `dict.get(k)`（缺键 → undefined；对非 dict 抛 AttributeError 同位文案）。 */
function dictGet(o: unknown, k: string): unknown {
    if (o instanceof Map) return o.get(k);
    if (isPyDict(o) || (typeof o === "object" && o !== null && !Array.isArray(o))) {
        return Object.prototype.hasOwnProperty.call(o, k)
            ? (o as JsonDict)[k] : undefined;
    }
    throw new AttributeErrorP(`'${pyTypeName(o)}' object has no attribute 'get'`);
}

/** python json.dumps 家族（ensure_ascii 可关；键序=插入序）。 */
function pyJsonDumps(v: unknown, ensureAscii: boolean): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") {
        if (Number.isNaN(v)) return "NaN";
        if (v === Infinity) return "Infinity";
        if (v === -Infinity) return "-Infinity";
        return String(v);
    }
    if (typeof v === "string") return pyJsonStr(v, ensureAscii);
    if (typeof v === "function" || v instanceof Error) {
        throw new TypeErrorP(`Object of type ${pyTypeName(v)} is not JSON serializable`);
    }
    if (Array.isArray(v)) return "[" + v.map((x) => pyJsonDumps(x, ensureAscii)).join(", ") + "]";
    if (isPyDict(v)) {
        const o = v as JsonDict;
        return "{" + Object.keys(o)
            .map((k) => pyJsonStr(k, ensureAscii) + ": " + pyJsonDumps(o[k], ensureAscii))
            .join(", ") + "}";
    }
    throw new TypeErrorP(`Object of type ${pyTypeName(v)} is not JSON serializable`);
}

function pyJsonStr(s: string, ensureAscii: boolean): string {
    let out = '"';
    for (const ch of s) {
        const cp = ch.codePointAt(0) as number;
        if (ch === '"') out += '\\"';
        else if (ch === "\\") out += "\\\\";
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (ch === "\b") out += "\\b";
        else if (ch === "\f") out += "\\f";
        else if (cp < 0x20 || cp === 0x7f) out += "\\u" + cp.toString(16).padStart(4, "0");
        else if (ensureAscii && cp > 0x7e) {
            if (cp > 0xffff) {
                const c = cp - 0x10000;
                const hi = 0xd800 + (c >> 10);
                const lo = 0xdc00 + (c & 0x3ff);
                out += "\\u" + hi.toString(16).padStart(4, "0")
                    + "\\u" + lo.toString(16).padStart(4, "0");
            } else {
                out += "\\u" + cp.toString(16).padStart(4, "0");
            }
        } else out += ch;
    }
    return out + '"';
}

/** json.dumps(args, sort_keys=True, ensure_ascii=False, default=str) —— 签名用。 */
function pyJsonDumpsSortedDefaultStr(v: unknown): string {
    return serSorted(v);
}
function serSorted(v: unknown): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") {
        if (Number.isNaN(v)) return "NaN";
        if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
        return String(v);
    }
    if (typeof v === "string") return pyJsonStr(v, false);
    if (Array.isArray(v)) return "[" + v.map(serSorted).join(", ") + "]";
    if (v instanceof Map) {
        const keys = Array.from(v.keys()).map((k) => pyStr(k)).sort();
        const pairs: [string, unknown][] = Array.from(v.entries())
            .map(([k, x]) => [pyStr(k), x] as [string, unknown]);
        return "{" + keys.map((k) => {
            const hit = pairs.find(([kk]) => kk === k);
            return pyJsonStr(k, false) + ": " + serSorted(hit ? hit[1] : undefined);
        }).join(", ") + "}";
    }
    if (isPyDict(v)) {
        const o = v as JsonDict;
        return "{" + Object.keys(o).sort()
            .map((k) => pyJsonStr(k, false) + ": " + serSorted(o[k])).join(", ") + "}";
    }
    // default=str：类实例、函数、Error 都由 str() 兜住
    return pyJsonStr(pyStr(v), false);
}

/** python `json.loads(s)`（NaN/Infinity 字面量兼容；缺位行列号见 DIVERGENCE）。 */
function pyJsonLoads(s: unknown): unknown {
    if (typeof s !== "string") {
        throw new TypeErrorP(
            `the JSON object must be str, bytes or bytearray, not ${pyTypeName(s)}`);
    }
    try {
        return JSON.parse(s);
    } catch {
        /* fall through to the python-literal handling below */
    }
    const revive = (x: unknown): unknown => {
        if (typeof x === "string") {
            if (x === "__NI__") return -Infinity;
            if (x === "__PI__") return Infinity;
            if (x === "__NA__") return NaN;
            return x;
        }
        if (Array.isArray(x)) return x.map(revive);
        if (isPyDict(x)) {
            const o: JsonDict = {};
            for (const k of Object.keys(x as JsonDict)) o[k] = revive((x as JsonDict)[k]);
            return o;
        }
        return x;
    };
    const t = pyStrip(s);
    if (t === "NaN") return NaN;
    if (t === "Infinity") return Infinity;
    if (t === "-Infinity") return -Infinity;
    const patched = s
        .replace(/-Infinity/g, '"__NI__"')
        .replace(/\bInfinity\b/g, '"__PI__"')
        .replace(/\bNaN\b/g, '"__NA__"');
    try {
        return revive(JSON.parse(patched));
    } catch {
        throw new JSONDecodeErrorP("Expecting value: line 1 column 1 (char 0)");
    }
}

function md5Hex(s: string): string {
    return createHash("md5").update(Buffer.from(s, "utf8")).digest("hex");
}

/** python `list(x)` / `dict(x)` 的浅拷贝。 */
function pyListCopy(v: unknown): unknown[] {
    return Array.isArray(v) ? v.slice() : pyIter(v);
}
function pyDictCopy(v: unknown): JsonDict {
    if (v instanceof Map) return Object.fromEntries(v.entries());
    return { ...(v as JsonDict) };
}

/** 把 `from X import name` 的命名检查搬进运行时。 */
function needName(mod: unknown, name: string, from: string): unknown {
    const v = (mod as Record<string, unknown>)[name];
    if (typeof v !== "function") {
        throw new ImportErrorP(
            `cannot import name '${name}' from '${from}' (unknown location)`);
    }
    return v;
}

// ── asyncio bridge（GS_SEAMS 的默认实现；探针整体替换）─────────────────────

/** 一次挂起的登记句柄：端口自己的每个让出点都在这里可被 cancel 命中。 */
type ParkHandle = {
    /**
     * python `Task.cancel()` 的同步面：它直接调 `Future.cancel()`，状态当场落下
     * （探针在这一刻记账），把 CancelledError 抛回协程则是事件循环的下一步。
     */
    cancel: () => void;
};

/**
 * 任务身份跟随**异步链**，不跟随同步段：python 的 current_task() 在任意一次
 * await 之后仍然是同一个任务，而端口一旦 await 一个外来 promise（router.handle、
 * bus.emit）就掉出了同步段。用 AsyncLocalStorage 把身份挂到异步链上才和 python
 * 的观察面一致——否则睡点登记会落到"最后一个跑起来的任务"上，pause/stop 就
 * 取消不到真正 parked 的那个。
 */
const _TASK_ALS = new AsyncLocalStorage<PyTask | null>();

function _resumeIn(task: PyTask | null, fn: () => void): void {
    _TASK_ALS.run(task, fn);
}

/** 探针用：当前正在执行的任务（`GS_SEAMS.sleep` 的挂起登记目标）。 */
export function gs_current_task(): PyTask | null {
    const store = _TASK_ALS.getStore();
    return store === undefined ? null : store;
}

/**
 * python 协程 `await asyncio.sleep(...)` 的等价物：await 一个 thenable。
 * `then()` 在**任务自己的异步链上**被调用，所以此刻 `gs_current_task()` 就是它
 * 自己，挂起句柄能登记到正确的 PyTask 上；恢复时 `_resumeIn` 再把身份装回去。
 */
class Suspension {
    private _settled = false;
    constructor(
        private readonly _task: PyTask | null,
        private readonly _arm: (ok: () => void, err: (e: unknown) => void) => void,
    ) { }
    then(onFul: (v: unknown) => void, onRej?: ((e: unknown) => void) | null): void {
        const ok = (): void => {
            if (this._settled) return;
            this._settled = true;
            if (this._task) this._task._unpark();
            _resumeIn(this._task, () => { onFul(undefined); });
        };
        const err = (e: unknown): void => {
            if (this._settled) return;
            this._settled = true;
            if (this._task) this._task._unpark();
            _resumeIn(this._task, () => {
                if (onRej) onRej(e);
            });
        };
        if (this._task && this._task._cancelRequested()) {
            Promise.resolve().then(() => err(new CancelledErrorP()));
            return;
        }
        if (this._task) {
            this._task._park({
                // 状态落下在调用栈里（和 Future.cancel 同位），唤醒排在下一微任务；
                // 同步抛出等于把 CancelledError 塞回正在 cancel 的那个循环里。
                cancel: () => {
                    Promise.resolve().then(() => err(new CancelledErrorP()));
                },
            });
        }
        this._arm(ok, err);
    }
}

/**
 * `asyncio.Task` 的最小镜像：done()/cancel()/cancelled()/exception()。
 * 完成状态在协程体结束时才落下（cancel 只有在 CancelledError 真的逃出协程时
 * 才算 cancelled——吞掉它的协程在 python 里同样不是 cancelled 任务）。
 */
export class PyTask {
    private _finished = false;
    private _cancelled = false;
    private _error: unknown = null;
    private _cancel = false;
    private _parked: ParkHandle | null = null;
    readonly promise: Promise<void>;
    /** 探针用：创建序（python 侧 fake task 也带 seq，集合迭代序靠它定序）。 */
    readonly seq: number;
    private static _nextSeq = 1;

    constructor(fn: () => Promise<unknown>) {
        this.seq = PyTask._nextSeq++;
        this.promise = Promise.resolve().then(() => {
            if (this._cancel) throw new CancelledErrorP();
            return _runIn(this, fn);
        }).then(
            () => this._finish(false, null),
            // python：协程体以 CancelledError 收场，任务就是 cancelled，
            // 不管这个错误是谁抛的（`task.cancel()` 也好、睡点被直接取消也好）。
            (e: unknown) => this._finish(e instanceof CancelledErrorP, e),
        );
    }
    private _finish(cancelled: boolean, err: unknown): void {
        this._finished = true;
        this._parked = null;
        if (cancelled) this._cancelled = true;
        else if (err !== null && err !== undefined) this._error = err;
    }
    done(): boolean { return this._finished; }
    cancelled(): boolean { return this._cancelled; }
    /** python `task.exception()`：未结束/被取消时是 None。 */
    exception(): unknown { return this._cancelled ? null : this._error; }
    _park(h: ParkHandle): void { this._parked = h; }
    _unpark(): void { this._parked = null; }
    _cancelRequested(): boolean { return this._cancel; }
    /** python `task.cancel()`：返回是否"提出了取消请求"。 */
    cancel(): boolean {
        if (this._finished) return false;
        this._cancel = true;
        const h = this._parked;
        if (h !== null) {
            this._parked = null;
            h.cancel();
        }
        return true;
    }
    /** python `await task`。 */
    async join(): Promise<void> {
        await this.promise;
        if (this._cancelled) throw new CancelledErrorP();
        if (this._error !== null && this._error !== undefined) throw this._error;
    }
}

function _runIn(task: PyTask, fn: () => Promise<unknown>): Promise<unknown> {
    return _TASK_ALS.run(task, fn);
}

/** python `asyncio.Queue`：本模块只用非阻塞四件套，一个数组就是完备语义。 */
export class PyQueue {
    private _items: unknown[] = [];
    put_nowait(x: unknown): void { this._items.push(x); }
    get_nowait(): unknown {
        if (this._items.length === 0) throw new QueueEmptyP();
        return this._items.shift();
    }
    qsize(): number { return this._items.length; }
    empty(): boolean { return this._items.length === 0; }
}

// ── seams（测试注入面；默认实现 = 生产行为）─────────────────────────────────

export type AnyMod = Record<string, unknown>;

/** python `import goal_plan`（Rust 路由，注入面）。 */
export interface GoalPlanModule {
    seed_plan_from_brief?: unknown;
    render_unfinished?: unknown;
    load_plan?: unknown;
    save_plan?: unknown;
    apply_completion?: unknown;
}
/** python `from recovery import recover_interrupted_goals`（Rust 路由，注入面）。 */
export interface RecoveryModule {
    recover_interrupted_goals?: unknown;
}
/** python `from acceptance_contract import …`（Rust 路由，注入面）。 */
export interface AcceptanceContractModule {
    get_goal_contract?: unknown;
    check_completion?: unknown;
}
/** python `from checkpoint import …`（已落地，默认给真模块）。 */
export interface CheckpointModule {
    build_checkpoint?: unknown;
    load_latest_checkpoint?: unknown;
    resume_from_checkpoint?: unknown;
}

let _goal_plan_provider: (() => GoalPlanModule) | null = null;
let _recovery_provider: (() => RecoveryModule) | null = null;
let _acceptance_provider: (() => AcceptanceContractModule) | null = null;

/** 注入 goal_plan 模块提供者；null = 模块不存在（同 python 缺模块）。 */
export function set_goal_plan_provider(p: (() => GoalPlanModule) | null): void {
    _goal_plan_provider = p;
}
/** 注入 recovery 模块提供者；null = 模块不存在。 */
export function set_recovery_provider(p: (() => RecoveryModule) | null): void {
    _recovery_provider = p;
}
/** 注入 acceptance_contract 模块提供者；null = 模块不存在。 */
export function set_acceptance_contract_provider(p: (() => AcceptanceContractModule) | null): void {
    _acceptance_provider = p;
}

function importGoalPlan(): GoalPlanModule {
    if (_goal_plan_provider === null) {
        throw new ModuleNotFoundErrorP("No module named 'goal_plan'");
    }
    return _goal_plan_provider();
}
function importRecovery(names: readonly string[]): RecoveryModule {
    if (_recovery_provider === null) {
        throw new ModuleNotFoundErrorP("No module named 'recovery'");
    }
    const mod = _recovery_provider();
    for (const n of names) {
        if (typeof (mod as Record<string, unknown>)[n] !== "function") {
            throw new ImportErrorP(
                `cannot import name '${n}' from 'recovery' (unknown location)`);
        }
    }
    return mod;
}
function importAcceptanceContract(names: readonly string[]): AcceptanceContractModule {
    if (_acceptance_provider === null) {
        throw new ModuleNotFoundErrorP("No module named 'acceptance_contract'");
    }
    const mod = _acceptance_provider();
    for (const n of names) {
        if (typeof (mod as Record<string, unknown>)[n] !== "function") {
            throw new ImportErrorP(
                `cannot import name '${n}' from 'acceptance_contract' (unknown location)`);
        }
    }
    return mod;
}

/** python `_load(...)` 的三态入口：探针可换成抛错的假件。 */
async function defaultCheckpointModule(): Promise<CheckpointModule> {
    const m = await import("./checkpoint.js");
    return m as unknown as CheckpointModule;
}

export const GS_SEAMS = {
    /** python `get_storage()`（构造期兜底；探针给假 storage）。 */
    storage: (): unknown => get_storage(),
    /** python `get_goal_manager()`。 */
    goalManager: (): unknown => get_goal_manager(),
    /** python `storage.PROCESS_GENERATION`（归属令牌的前缀）。 */
    procGen: (): string => PROCESS_GENERATION,
    /** python `verify_gate` 的两个入口（常量 REPAIR_BUDGET 走模块导入，不注入）。 */
    verifyGate: {
        verify: (workspace: string): Promise<Record<string, unknown>> =>
            verify_gate.verify(workspace),
        repairPrompt: (report: Record<string, unknown>): string =>
            verify_gate.repair_prompt(report),
    },
    /** python `time.time()` —— 浮点秒。 */
    now: (): number => Date.now() / 1000,
    /** python `uuid.uuid4().hex` —— 32 位小写十六进制。 */
    uuid4Hex: (): string => createHash("md5").update(String(Math.random())).digest("hex")
        + createHash("md5").update(String(Math.random() + 1)).digest("hex"),
    /** python `os.environ.get(name, "")`。 */
    env: (name: string): string => process.env[name] ?? "",
    /** python `print(...)`。 */
    print: (text: string): void => { console.log(text); },
    /** python `asyncio.sleep(seconds)` —— 返回可 await 的挂起点。 */
    sleep: (seconds: number): Suspension =>
        new Suspension(gs_current_task(), (ok) => { setTimeout(ok, seconds * 1000); }),
    /** python `asyncio.create_task(coro)`。 */
    createTask: (fn: () => Promise<unknown>): PyTask => new PyTask(fn),
    /** python `asyncio.Queue()`。 */
    queue: (): PyQueue => new PyQueue(),
    /**
     * python `asyncio.wait({tasks}, timeout=t)` → (done, pending)。
     * 生产默认：1ms 轮询到全停或超时（DIVERGENCE：python 是事件驱动）。
     */
    wait: async (
        tasks: readonly PyTask[], timeoutSec: number | null,
    ): Promise<[PyTask[], PyTask[]]> => {
        const deadline = timeoutSec === null ? Infinity : _nowMs() + timeoutSec * 1000;
        for (;;) {
            const done = tasks.filter((t) => t.done());
            if (done.length === tasks.length || _nowMs() >= deadline) {
                return [done, tasks.filter((t) => !t.done())];
            }
            await new Promise<void>((r) => setTimeout(r, 1));
        }
    },
    /**
     * python `asyncio.get_event_loop().call_soon(cb)`；无运行中循环 →
     * RuntimeError（_emit_change 正是兜这一类）。
     */
    callSoon: (cb: () => void): void => { setTimeout(cb, 0); },
    /**
     * python `asyncio.ensure_future(coro)`：协程对象是**惰性**的——ensure_future 只
     * 把任务排进事件循环，函数体要等下一次循环迭代才开跑。JS 没有惰性协程（async
     * 函数一调用就把体跑到第一个 await），所以调用方交出一个 thunk，由这里在下一个
     * 宏任务上启动，排程语义才和 python 对齐。异常在 python 由 asyncio 打日志。
     */
    ensureFuture: (thunk: () => unknown): void => {
        setTimeout(() => {
            Promise.resolve().then(thunk)
                .catch(() => { /* python: Task exception was never retrieved */ });
        }, 0);
    },
    /** python `time.monotonic()`（本模块不直接用，探针保留同一形状）。 */
    monotonic: (): number => Number(process.hrtime.bigint()) / 1e9,
    /** python `from checkpoint import …`（惰性、可注入）。 */
    checkpointModule: defaultCheckpointModule,
    /** python `import goal_plan`（惰性使用点，见 DIVERGENCE）。 */
    goalPlanModule: (): GoalPlanModule => importGoalPlan(),
    /** python `from recovery import …`。 */
    recoveryModule: (names: readonly string[]): RecoveryModule => importRecovery(names),
    /** python `from acceptance_contract import …`。 */
    acceptanceModule: (names: readonly string[]): AcceptanceContractModule =>
        importAcceptanceContract(names),
};

function _nowMs(): number {
    return Number(process.hrtime.bigint() / 1000000n);
}

// ── module constants（与 py 同名同值）───────────────────────────────────────

export const MAX_WORKERS = 2;
export const DEFAULT_COST_CAP_MICROS = 5_000_000;
export const DEFAULT_MAX_ITERATIONS = 10;
export const TICK_INTERVAL = 2.0;
export const STALE_CLAIM_SEC = 900;
export const HEARTBEAT_INTERVAL_SEC = 10.0;
export const CLAIM_LEASE_SEC = 45;
export const PAUSE_GRACE_SEC = 5.0;
export const MAX_SAME_ACTION_REPEATS = 3;
export const STUCK_WINDOW = 4;
export const STUCK_DISTINCT_MAX = 2;
export const MAX_SIGNATURE_CALLS = 6;
export const FALLBACK_ROUND_MICROS = 2_000;
export const VERIFY_REPAIR_BUDGET = verify_gate.REPAIR_BUDGET;

export const QUEUED: string = GoalStatus.QUEUED;
export const RUNNING: string = GoalStatus.RUNNING;

// ── 进度 / 签名 / 卡死判定 ───────────────────────────────────────────────────

export function _plan_progress(plan_json: unknown): JsonDict {
    let plan: unknown;
    try {
        plan = pyJsonLoads(pyOr(plan_json, "[]"));
    } catch (e: unknown) {
        if (e instanceof JSONDecodeErrorP || e instanceof TypeErrorP) plan = [];
        else throw e;
    }
    if (!Array.isArray(plan) || plan.length === 0) {
        return { completed: 0, total: 0, ratio: null };
    }
    const total = plan.length;
    let done = 0;
    for (const s of plan) {
        if (isPyDict(s) && dictGet(s, "status") === "completed") done += 1;
    }
    return { completed: done, total, ratio: done / total };
}

/**
 * 每轮回复里"每次都变但工作没变"的部分：时间戳、耗时、十六进制 id、行/字节数。
 * python `\b(?:0x)?[0-9a-f]{6,}\b|\d+` + re.IGNORECASE。
 */
const _VOLATILE_RE = /\b(?:0x)?[0-9a-f]{6,}\b|\d+/gi;

export function _text_signature(text: unknown): string {
    const norm = pyStripKeepSingleSpaces(
        pyStr(pyOr(text, "")).toLowerCase().replace(_VOLATILE_RE, "#"));
    return "text:" + md5Hex(pyStrTrunc(norm, 400)).slice(0, 12);
}

/** python `" ".join(s.split())`（空白折叠成单个空格）。 */
function pyStripKeepSingleSpaces(s: string): string {
    return pySplitWhitespace(s).join(" ");
}

export function _call_signature(row: unknown): string {
    const tool = pyStr(pyOr(dictGet(row, "tool"), "?"));
    const args = dictGet(row, "args");
    let key: string;
    try {
        key = pyJsonDumpsSortedDefaultStr(args);
    } catch (e: unknown) {
        if (e instanceof TypeErrorP || e instanceof ValueErrorP) key = pyStr(args);
        else throw e;
    }
    return `${tool}:${md5Hex(pyStrTrunc(key, 400)).slice(0, 8)}`;
}

/** 这一轮**做了什么**的可比较键（工具调用优先，纯文本兜底）。 */
export function round_signature(trace: unknown, evidence?: unknown): string {
    if (arguments.length < 1) throw pyMissing("round_signature", ["trace"]);
    const rows = pyTruth(trace) ? pyIter(trace) : [];
    const calls: string[] = [];
    for (const r of rows) {
        if (isPyDict(r) || (r instanceof Map)) calls.push(_call_signature(r));
    }
    if (calls.length > 0) {
        return calls.slice(0, MAX_SIGNATURE_CALLS).join("|");
    }
    return _text_signature(evidence === undefined ? "" : evidence);
}

/** 看起来卡死的理由；不卡死返回空串。 */
export function is_stuck(signatures: unknown): string {
    const sigs = pyIter(signatures);
    if (sigs.length >= MAX_SAME_ACTION_REPEATS) {
        const tail = sigs.slice(-MAX_SAME_ACTION_REPEATS);
        if (new Set(tail.map((x) => pyStr(x))).size === 1) {
            return `同一个动作连续重复了 ${MAX_SAME_ACTION_REPEATS} 轮`;
        }
    }
    if (sigs.length >= STUCK_WINDOW) {
        const window = sigs.slice(-STUCK_WINDOW);
        const distinct = new Set(window.map((x) => pyStr(x))).size;
        if (distinct <= STUCK_DISTINCT_MAX) {
            return `最近 ${STUCK_WINDOW} 轮只在 ${distinct} 个动作之间来回，没有新进展`;
        }
    }
    return "";
}

// ── U5 交付语义提示（动作层 → 验收链路的佐证通道）──────────────────────────

export const DELIVERY_HINT_KEY = "delivery_hint";
export const DELIVERABLE_HINT = "deliverable";
export const HANDOFF_HINT = "handoff";
const _HINT_DETAIL_KEYS = [
    "reason", "error", "summary", "feedback_note", "note", "ocr_summary",
] as const;
const _HINT_DETAIL_LIMIT = 200;
const _HINT_NESTED_KEYS = ["result", "value", "output", "details"] as const;
const _HINT_MAX_DEPTH = 2;

/** 零值形态。每次新建，绝不共享可变默认。 */
export function empty_delivery_hints(): JsonDict {
    return { deliverable_count: 0, handoff_count: 0, latest_handoff_detail: "" };
}

function _hint_detail_of(payload: JsonDict): string {
    for (const key of _HINT_DETAIL_KEYS) {
        const value = payload[key];
        if (typeof value === "string" && pyStrip(value) !== "") {
            return pyStrTrunc(pyStripKeepSingleSpaces(value), _HINT_DETAIL_LIMIT);
        }
    }
    return "";
}

/** 摊平轨迹里可能的 payload 挂载点（列表透明穿过不耗深度）。 */
function* _iter_hint_payloads(obj: unknown, depth = 0, seen?: Set<unknown>): Generator<JsonDict> {
    const _seen = seen ?? new Set<unknown>();
    if (depth > _HINT_MAX_DEPTH) return;
    if (Array.isArray(obj)) {
        if (_seen.has(obj)) return;
        _seen.add(obj);
        for (const item of obj) yield* _iter_hint_payloads(item, depth, _seen);
        return;
    }
    if (typeof obj !== "object" || obj === null || _seen.has(obj)) return;
    _seen.add(obj);
    yield obj as JsonDict;
    for (const key of _HINT_NESTED_KEYS) {
        const child = (obj as JsonDict)[key];
        if (Array.isArray(child) || (typeof child === "object" && child !== null)) {
            yield* _iter_hint_payloads(child, depth + 1, _seen);
        }
    }
}

/** 扫描一轮 tool_trace，聚合动作层的交付语义提示（脏输入不抛）。 */
export function collect_delivery_hints(trace: unknown): JsonDict {
    const hints = empty_delivery_hints();
    const rows = Array.isArray(trace) ? trace : [trace];
    for (const row of rows) {
        for (const payload of _iter_hint_payloads(row)) {
            const raw = payload[DELIVERY_HINT_KEY];
            if (raw !== DELIVERABLE_HINT && raw !== HANDOFF_HINT) continue;
            if (raw === DELIVERABLE_HINT) {
                hints["deliverable_count"] = (hints["deliverable_count"] as number) + 1;
            } else {
                hints["handoff_count"] = (hints["handoff_count"] as number) + 1;
                const detail = _hint_detail_of(payload);
                if (detail !== "") hints["latest_handoff_detail"] = detail;
            }
        }
    }
    return hints;
}

/** 跨轮累计；latest_handoff_detail 取最新一条非空。 */
export function merge_delivery_hints(base: unknown, addend: unknown): JsonDict {
    const merged: JsonDict = isPyDict(base) ? pyDictCopy(base) : empty_delivery_hints();
    const add: JsonDict = isPyDict(addend) ? addend as JsonDict : empty_delivery_hints();
    merged["deliverable_count"] = pyInt(pyOr(dictGet(merged, "deliverable_count"), 0))
        + pyInt(pyOr(dictGet(add, "deliverable_count"), 0));
    merged["handoff_count"] = pyInt(pyOr(dictGet(merged, "handoff_count"), 0))
        + pyInt(pyOr(dictGet(add, "handoff_count"), 0));
    if (pyStrip(pyStr(pyOr(dictGet(add, "latest_handoff_detail"), ""))) !== "") {
        merged["latest_handoff_detail"] = pyStr(dictGet(add, "latest_handoff_detail"));
    }
    return merged;
}

/** 佐证包渲染（免责声明写死在文案里）。 */
export function delivery_evidence_note(hints: unknown): string {
    const h: JsonDict = isPyDict(hints) ? hints as JsonDict : empty_delivery_hints();
    const deliverable = pyInt(pyOr(dictGet(h, "deliverable_count"), 0));
    const handoff = pyInt(pyOr(dictGet(h, "handoff_count"), 0));
    if (!(deliverable || handoff)) return "";
    const detail = pyStrip(pyStr(pyOr(dictGet(h, "latest_handoff_detail"), "")));
    let note = `[delivery-hints] 动作层语义提示（仅佐证，不构成验收依据）：`
        + `deliverable×${deliverable}, handoff×${handoff}`;
    if (detail !== "") note += `；latest_handoff: ${detail}`;
    return note;
}

/** 把佐证包拼进门禁证据——**空证据不拼接**（U5 铁律）。 */
export function evidence_with_hints(evidence: unknown, hints: unknown): string {
    const text = pyStr(pyOr(evidence, ""));
    const note = delivery_evidence_note(hints);
    if (note === "" || pyStrip(text) === "") return text;
    return text + "\n" + note;
}

// ── goal_view ────────────────────────────────────────────────────────────────

/** 把 goals 原始行整形给 API/UI（钱以美元显示，权威整数 micros 保留）。 */
export function goal_view(row: unknown): JsonDict {
    const progress = _plan_progress(pyOr(dictGet(row, "plan_json"), "[]"));
    const cost_micros = pyOr(dictGet(row, "cost_micros"), 0);
    const cap_micros = pyOr(dictGet(row, "cost_cap_micros"), DEFAULT_COST_CAP_MICROS);
    const verification = pyOr(dictGet(row, "verification_result"), "");
    let verification_obj: unknown;
    try {
        verification_obj = pyTruth(verification) ? pyJsonLoads(verification) : null;
    } catch (e: unknown) {
        if (e instanceof JSONDecodeErrorP || e instanceof TypeErrorP) verification_obj = null;
        else throw e;
    }
    const brief_raw = pyOr(dictGet(row, "brief_json"), "");
    let brief_obj: unknown;
    try {
        brief_obj = (pyTruth(brief_raw) && brief_raw !== "{}") ? pyJsonLoads(brief_raw) : null;
    } catch (e: unknown) {
        if (e instanceof JSONDecodeErrorP || e instanceof TypeErrorP) brief_obj = null;
        else throw e;
    }
    return {
        "id": dictGet(row, "id"),
        "description": dictGetOr(row, "description", ""),
        "status": dictGetOr(row, "status", GoalStatus.STARTED),
        "iteration": pyOr(dictGet(row, "iteration"), 0),
        "maxIterations": pyOr(dictGet(row, "max_iterations"), DEFAULT_MAX_ITERATIONS),
        "subtasksCompleted": (progress as JsonDict)["completed"],
        "subtasksTotal": (progress as JsonDict)["total"],
        "progressRatio": (progress as JsonDict)["ratio"],
        "plan": pyTruth(dictGet(row, "plan_json"))
            ? pyJsonLoads(pyOr(dictGet(row, "plan_json"), "[]")) : [],
        "costUsd": pyRound(pyInt(cost_micros) / 1_000_000, 4),
        "costCapUsd": pyRound(pyInt(cap_micros) / 1_000_000, 2),
        "tokensUsed": pyOr(dictGet(row, "tokens_used"), 0),
        "lastError": pyOr(dictGet(row, "last_error"), ""),
        "verification": verification_obj,
        "brief": brief_obj,
        "category": pyOr(dictGet(row, "category"), "unknown"),
        "sessionId": pyOr(dictGet(row, "session_id"), ""),
        "createdAt": pyOr(dictGet(row, "created_at"), 0),
        "updatedAt": pyOr(dictGet(row, "updated_at"), 0),
        "startedAt": pyOr(dictGet(row, "started_at"), 0),
    };
}

// ── 协作面对象的最小形状（storage 的域方法是运行时 mixin 挂上去的）──────────

type StorageLike = {
    get_goal(gid: string): JsonDict | null;
    update_goal_fields(gid: string, fields: JsonDict): unknown;
    claim_goal(gid: string, stale_after: number, owner: string, lease_seconds: number): unknown;
    renew_goal_claim(gid: string, owner: string, lease_seconds: number): unknown;
    release_goal(gid: string, owner: string): unknown;
    add_goal_spend(gid: string, cost_micros: number, tokens: number): JsonDict;
    add_goal_iteration(
        gid: string, ordinal: number, started_at: number, ended_at: number,
        evidence: string, verdict: string, verdict_reason: string,
        cost_micros: number, tokens: number,
    ): unknown;
    trace_event(kwargs: JsonDict): unknown;
};

type RouterLike = {
    handle(prompt: unknown, ctx: JsonDict): Promise<Result<unknown>> | Result<unknown>;
    workspace?: unknown;
    live_call_names?: () => Iterable<unknown>;
    cancel_hard?: () => unknown;
    cancel?: () => unknown;
};

type HostLike = { get_or_create(sid: string): RouterLike };

type BusLike = { emit(name: string, payload: JsonDict): Promise<unknown> | unknown };

type ManagerLike = {
    get_brief(gid: unknown): unknown;
    add_iteration(gid: unknown, result: unknown): Result<unknown>;
    verify_completion(gid: unknown, evidence: unknown): Promise<JsonDict>;
    continue_goal(gid: unknown, max_iterations: unknown): Promise<Result<unknown>>;
};

/** python 除法/比较在混合类型上的 CPython 文案。 */
function pyDiv(a: unknown, b: number): number {
    if (typeof a === "number") return a / b;
    if (typeof a === "boolean") return (a ? 1 : 0) / b;
    throw new TypeErrorP(
        `unsupported operand type(s) for /: '${pyTypeName(a)}' and 'int'`);
}
function pyGe(a: unknown, b: unknown): boolean {
    if (typeof a === "number" && typeof b === "number") return a >= b;
    if (typeof a === "number" && typeof b === "boolean") return a >= (b ? 1 : 0);
    if (typeof a === "boolean" && typeof b === "number") return (a ? 1 : 0) >= b;
    throw new TypeErrorP(
        `'>=' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** `a, b = f()` —— CPython 的解包文案。 */
function pyUnpack2(outcome: unknown): [unknown, unknown] {
    const items = pyIter(outcome);
    if (items.length < 2) {
        throw new ValueErrorP(`not enough values to unpack (expected 2, got ${items.length})`);
    }
    if (items.length > 2) {
        throw new ValueErrorP("too many values to unpack (expected 2)");
    }
    return [items[0], items[1]];
}
function pyUnpack3(outcome: unknown): [unknown, unknown, unknown] {
    const items = pyIter(outcome);
    if (items.length < 3) {
        throw new ValueErrorP(`not enough values to unpack (expected 3, got ${items.length})`);
    }
    if (items.length > 3) {
        throw new ValueErrorP("too many values to unpack (expected 3)");
    }
    return [items[0], items[1], items[2]];
}

/** python `dict.get(k, default)`：缺键用默认，存在即取值（哪怕是 0）。 */
function dictGetOr(o: unknown, k: string, dflt: unknown): unknown {
    const v = dictGet(o, k);
    return v === undefined ? dflt : v;
}

// ---------------------------------------------------------------------------
// GoalScheduler
// ---------------------------------------------------------------------------

/**
 * 后台调度器：把用户点了"执行"的目标跑成 plan → execute → verify 循环。
 *
 * 它**不是**自动扫开的守护线程：只有 `enqueue()` 显式提交的目标才会进入队列，
 * 这与产品约定一致（手动触发）。并发帽 2、成本帽、卡死熔断、验证门、租约归属
 * 全在这里，逐条与 python 对拍。
 */
export class GoalScheduler {
    /** 兜底 router：没有 host（CLI/单测）或目标行没有 session_id 时用它。 */
    _router: RouterLike | null;
    /** SessionHost：让目标在它**出生**的那个会话里干活。 */
    _host: HostLike | null;
    _bus: BusLike | null;
    _storage: StorageLike;
    _goal_manager: ManagerLike;
    _queue: PyQueue;
    /** goal_id → 执行任务 */
    _workers: Map<string, PyTask> = new Map();
    /** 每个在跑目标的租约归属令牌。 */
    _owners: Map<string, string> = new Map();
    /** 心跳任务：不断把 claim 的 lease_until 往前推。 */
    _heartbeats: Map<string, PyTask> = new Map();
    _running = false;
    _tick_task: PyTask | null = null;

    constructor(
        router: RouterLike | null = null,
        bus: BusLike | null = null,
        host: HostLike | null = null,
        storage?: StorageLike | null,
    ) {
        this._router = router;
        this._host = host;
        this._bus = bus;
        this._storage = (storage !== undefined && storage !== null
            ? storage
            : GS_SEAMS.storage() as unknown as StorageLike);
        this._goal_manager = GS_SEAMS.goalManager() as unknown as ManagerLike;
        this._queue = GS_SEAMS.queue();
    }

    /**
     * 解析一个目标必须在哪个 Router 里执行。没有 host 或目标早于 session 打标时
     * 退回默认 router——跑在某个地方比拒绝跑好，且这条退路和旧行为逐字一致。
     */
    _router_for_goal(row: unknown): RouterLike | null {
        if (this._host === null) return this._router;
        const sid = dictGet(pyOr(row, {}), "session_id");
        if (!pyTruth(sid)) return this._router;
        try {
            return this._host.get_or_create(sid as string);
        } catch (exc: unknown) {
            GS_SEAMS.print(
                `[goal_scheduler] session resolve failed for ${pyStr(sid)}: ${pyStr(exc)}`);
            return this._router;
        }
    }

    /** 正在执行的目标数。 */
    get active_count(): number {
        let n = 0;
        for (const t of this._workers.values()) if (!t.done()) n += 1;
        return n;
    }

    /** 启动后台 tick 循环，并把上次崩掉的目标做恢复。 */
    start(auto_resume: unknown = null): void {
        this._running = true;
        if (this._tick_task === null || this._tick_task.done()) {
            this._tick_task = GS_SEAMS.createTask(() => this._tick_loop());
        }
        this.rehydrate_interrupted_goals(auto_resume);
    }

    /**
     * 扫描并恢复上一次崩溃/暂停的目标；`OVOLVE_AUTO_RESUME_GOALS` 打开时自动入队。
     */
    rehydrate_interrupted_goals(auto_resume: unknown = null): string[] {
        const shouldResume = auto_resume !== null && auto_resume !== undefined
            ? auto_resume
            : ["1", "true", "yes"].includes(
                pyLower(GS_SEAMS.env("OVOLVE_AUTO_RESUME_GOALS")));
        const recoveredIds: string[] = [];
        try {
            const mod = GS_SEAMS.recoveryModule(["recover_interrupted_goals"]);
            const fn = needName(mod, "recover_interrupted_goals", "recovery") as
                (st: unknown) => unknown;
            const demoted = fn(this._storage);
            for (const g of pyIter(demoted)) {
                const gid = pyStr(pyOr(dictGet(g, "id"), ""));
                if (gid !== "") {
                    recoveredIds.push(gid);
                    if (pyTruth(shouldResume) && pyTruth(dictGet(g, "can_auto_resume"))) {
                        GS_SEAMS.print(
                            `[goal_scheduler] auto-resuming interrupted goal ${gid}`);
                        this.enqueue(gid);
                    }
                }
            }
        } catch (e: unknown) {
            GS_SEAMS.print(
                `[goal_scheduler] rehydrate interrupted goals error: ${pyStr(e)}`);
        }
        return recoveredIds;
    }

    /**
     * 优雅停掉所有 worker 和 tick 循环。
     *
     * 以前是"发完就不管"：取消任务、清空注册表、返回。循环于是在还在收尾的
     * worker 底下关掉，而它们退出路上写的暂停快照正好是重启最需要的那份信息。
     * 现在每个 worker 都走 Pause 的同一套流程（杀在跑的，再有界地等）。
     */
    async stop(): Promise<void> {
        this._running = false;
        const tasks: [string, PyTask][] = Array.from(this._workers.entries());
        for (const [gid] of tasks) this._hard_cancel_router(gid);
        for (const [, task] of tasks) task.cancel();
        if (tasks.length > 0) {
            await GS_SEAMS.wait(tasks.map(([, t]) => t), PAUSE_GRACE_SEC);
        }
        for (const [gid, task] of tasks) {
            if (!task.done()) {
                GS_SEAMS.print(`[goal_scheduler] worker for ${gid} did not stop within `
                    + `${pyFormatG(PAUSE_GRACE_SEC)}s at shutdown`);
            }
            this._finish_worker(gid);
        }
        this._workers.clear();
        if (this._tick_task !== null) {
            this._tick_task.cancel();
            this._tick_task = null;
        }
    }

    /**
     * 提交执行。拒绝的四种理由依次是：不存在 / 已在跑或排队 / 正在停止 /
     * 停止未确认。stopping 与 stop_timeout 和 RUNNING 一样重要——在停止还没
     * 确认时再起一个 worker，正是这套状态机要防的双重执行。
     */
    enqueue(goal_id: unknown): Result<JsonDict> {
        const row = this._storage.get_goal(goal_id as string);
        if (row === null || row === undefined) {
            return Result.failure(`Goal not found: ${pyStr(goal_id)}`);
        }
        const status = dictGet(row, "status");
        if (status === RUNNING || status === QUEUED) {
            return Result.failure(`Goal is already ${pyStr(status)}`);
        }
        if (status === GoalStatus.STOPPING) {
            return Result.failure("目标正在停止中（stopping），等停止确认后再继续");
        }
        if (status === GoalStatus.STOP_TIMEOUT) {
            return Result.failure(
                "上次停止未能确认（stop_timeout）：可能有工具仍在后台运行。"
                + "请先确认停止（confirm-stopped）再继续");
        }
        if (this.active_count >= MAX_WORKERS) {
            // 入队——tick 循环会在有槽位时取走。
            this._storage.update_goal_fields(goal_id as string, { status: QUEUED });
            this._queue.put_nowait(goal_id);
            this._emit_change(goal_id as string, QUEUED);
            return Result.success({ status: QUEUED, position: this._queue.qsize() });
        }
        this._spawn_worker(goal_id as string);
        return Result.success({ status: RUNNING });
    }

    /**
     * 现实核对之后解决 `stop_timeout`。
     *
     * 这是回到可认领空间的唯一合法出口。只有 worker 任务确实没了才算成功；
     * 还留着活把手时拒绝，正是这条方法的全部意义——把没发生的停止确认掉，
     * 目标就会长出两个 worker。
     */
    async confirm_stopped(goal_id: string): Promise<Result<JsonDict>> {
        const task = this._workers.get(goal_id);
        if (task !== undefined && !task.done()) {
            return Result.failure("worker 还在运行，不能确认已停止；可以再点一次暂停");
        }
        const row = pyOr(this._storage.get_goal(goal_id), {}) as JsonDict;
        if (dictGet(row, "status") !== GoalStatus.STOP_TIMEOUT) {
            return Result.failure(
                `目标不在等待停止确认的状态（当前 ${pyStr(dictGet(row, "status"))}）`);
        }
        this._workers.delete(goal_id);
        this._finish_worker(goal_id);
        this._storage.update_goal_fields(goal_id, { status: GoalStatus.PAUSED });
        try {
            this._note_failure(goal_id, "goal.stop_confirmed", {
                "from_status": GoalStatus.STOP_TIMEOUT,
                "confirmed_at": pyInt(GS_SEAMS.now()),
            });
        } catch {
            /* 记账失败不影响确认本身 */
        }
        this._emit_change(goal_id, GoalStatus.PAUSED);
        return Result.success({ status: GoalStatus.PAUSED });
    }

    /**
     * 立刻停，并且如实报告到底停了没有。
     *
     * 状态机：running → stopping → paused；宽限窗内确认不了的落 stop_timeout，
     * **不是** paused。数据库状态、账本、返回值三处说同一件事——以前在这里写
     * paused，就是 UI 上"已暂停"盖着还在跑的活的那个来源。
     */
    async pause(goal_id: string): Promise<Result<JsonDict>> {
        const task = this._workers.get(goal_id);
        if (task === undefined || task.done()) {
            return Result.failure("Goal is not running");
        }
        // 先落状态：worker 自己的复查也读它，所以撑过宽限窗的 worker 不会再开一轮。
        this._storage.update_goal_fields(goal_id, { status: GoalStatus.STOPPING });
        this._emit_change(goal_id, GoalStatus.STOPPING);
        const hard = this._hard_cancel_router(goal_id);
        task.cancel();
        await GS_SEAMS.wait([task], PAUSE_GRACE_SEC);

        if (!task.done()) {
            this._storage.update_goal_fields(goal_id, { status: GoalStatus.STOP_TIMEOUT });
            this._note_failure(goal_id, "goal.pause_timeout", {
                "grace_sec": PAUSE_GRACE_SEC,
                "killed_calls": hard["killed"],
                "live_calls": (hard["live"] as unknown[]).slice(0, 8),
                "to_status": GoalStatus.STOP_TIMEOUT,
            });
            this._emit_change(goal_id, GoalStatus.STOP_TIMEOUT);
            const live = hard["live"] as unknown[];
            return Result.failure(
                `已请求停止并终止了 ${pyStr(hard["killed"])} 个在跑的命令，但 worker 在 `
                + `${pyFormatG(PAUSE_GRACE_SEC)} 秒内还没停下`
                + (live.length > 0
                    ? `（仍在等：${pyJoin(live.slice(0, 3), ", ")}）` : "")
                + `。目标已标记为 ${GoalStatus.STOP_TIMEOUT}：不会再开新一轮，`
                + "恢复前需先确认停止（confirm-stopped）。可以再点一次暂停。"
            );
        }

        this._workers.delete(goal_id);
        this._finish_worker(goal_id);
        this._storage.update_goal_fields(goal_id, { status: GoalStatus.PAUSED });
        this._emit_change(goal_id, GoalStatus.PAUSED);
        return Result.success({
            status: GoalStatus.PAUSED,
            killedCalls: hard["killed"],
        });
    }

    // ------------------------------------------------------------------
    // 租约 / 归属
    // ------------------------------------------------------------------

    /**
     * 造出"在跑期间一直续租"的协程。
     *
     * 续租失败意味着我们不再持有这个目标——本进程漏掉了每一次心跳（被冻结/
     * 挂起到租约过期），别人接管了。唯一安全的反应是取消**自己的** worker：
     * 继续跑就是给同一个目标配两个 worker，而这里每一道闸都把那当成最坏结果。
     */
    _heartbeat_loop_factory(goal_id: string, owner: string): Promise<unknown> {
        return (async (): Promise<void> => {
            for (;;) {
                await GS_SEAMS.sleep(HEARTBEAT_INTERVAL_SEC);
                const ok = this._storage.renew_goal_claim(goal_id, owner, CLAIM_LEASE_SEC);
                if (!pyTruth(ok)) {
                    GS_SEAMS.print(`[goal_scheduler] claim lost for ${goal_id} `
                        + "(lease expired or taken over) — cancelling worker");
                    try {
                        this._note_failure(goal_id, "goal.claim_lost", {
                            "owner": owner,
                            "lease_sec": CLAIM_LEASE_SEC,
                        });
                    } catch {
                        /* 记账失败不改变「必须停」这个结论 */
                    }
                    const t = this._workers.get(goal_id);
                    if (t !== undefined && !t.done()) t.cancel();
                    return;
                }
            }
        })();
    }

    /**
     * 停心跳、以**自己的身份**放锁。
     *
     * worker 结束的所有出口（完成/失败/取消/暂停/关停）都走这里。放锁带归属
     * 条件，被拒（别人合法持有）时只记账，绝不悄悄抹掉别人——旧版那句
     * 无条件 `claimed_at=0` 正是这种抹法。
     */
    _finish_worker(goal_id: string): void {
        const hb = this._heartbeats.get(goal_id);
        this._heartbeats.delete(goal_id);
        if (hb !== undefined && !hb.done()) hb.cancel();
        const ownerRaw = this._owners.get(goal_id);
        this._owners.delete(goal_id);
        const owner = ownerRaw === undefined ? "" : ownerRaw;
        const released = pyTruth(this._storage.release_goal(goal_id, owner));
        if (owner !== "" && !released) {
            this._note_failure(goal_id, "goal.claim_release_rejected", {
                "owner": owner,
                "detail": "claim held by someone else; left untouched",
            });
        }
    }

    /**
     * 让停止真的立刻发生：cancel token + 杀掉在跑的命令。
     *
     * 只 cancel worker 任务不等于停止。工具是派发进工作线程的，协程 unwind 完
     * 子命令还在跑——build 继续 build，脚本继续写。只有 executors.cancel_call
     * （经 Router.cancel_hard）真的结束它。
     */
    _hard_cancel_router(goal_id: string): JsonDict {
        const info: JsonDict = { killed: 0, live: [] };
        try {
            const row = pyOr(this._storage.get_goal(goal_id), {}) as JsonDict;
            const router = this._router_for_goal(row);
            const liveFn = pyGetAttr(router, "live_call_names", (): unknown[] => []);
            info["live"] = pyIter((liveFn as () => Iterable<unknown>)());
            const hard = pyGetAttr(router, "cancel_hard", null);
            if (isFunction(hard)) {
                info["killed"] = pyInt(pyOr((hard as () => unknown)(), 0));
            } else {
                // 测试里的桩 router
                const cancel = pyGetAttr(router, "cancel", null);
                if (isFunction(cancel)) (cancel as () => unknown)();
            }
        } catch (exc: unknown) {
            GS_SEAMS.print(
                `[goal_scheduler] hard cancel failed for ${goal_id}: ${pyStr(exc)}`);
        }
        return info;
    }

    // ------------------------------------------------------------------
    // 内部
    // ------------------------------------------------------------------

    /** 周期循环：把队列灌进空出来的 worker 槽位。 */
    async _tick_loop(): Promise<void> {
        while (pyTruth(this._running)) {
            await GS_SEAMS.sleep(TICK_INTERVAL);
            // 收割结束的任务。没走 _finish_worker 就结束的 worker（异常抢在清理
            // 前面、任务被从外面干掉）会让它的心跳永远续着这把锁——安全网在这里
            // 停掉它并丢掉锁。
            const doneIds: string[] = [];
            for (const [gid, t] of this._workers.entries()) {
                if (t.done()) doneIds.push(gid);
            }
            for (const gid of doneIds) {
                this._workers.delete(gid);
                const hb = this._heartbeats.get(gid);
                if (hb !== undefined && !hb.done()) {
                    this._finish_worker(gid);
                } else {
                    this._heartbeats.delete(gid);
                    this._owners.delete(gid);
                }
            }
            while (this.active_count < MAX_WORKERS && !this._queue.empty()) {
                const gid = this._queue.get_nowait() as string;
                const row = this._storage.get_goal(gid);
                if (pyTruth(row) && dictGet(row, "status") === QUEUED) {
                    this._spawn_worker(gid);
                }
            }
        }
    }

    /** 认领目标并起一个执行任务。 */
    _spawn_worker(goal_id: string): void {
        // 一个目标一个活任务，在这里强制，不信任上游。
        // 下面 `this._workers.set` 会**覆盖**旧条目，而注册表是 pause()/stop()
        // 唯一的把手。于是第二次 spawn 不只是双份干活——它让第一个任务变成
        // 停不掉：Pause 返回成功，那个任务还在跑、还在花钱、还在写文件，
        // 用户除了退出应用没有任何办法碰到它。
        // 今天就能走到：PATCH /api/goals/{id} {"status":"active"} 落在盲写分支，
        // 不取消任何东西，`active` 仍过 worker 自己的状态复查，
        // 而 enqueue() 只拒 RUNNING/QUEUED。
        const old = this._workers.get(goal_id);
        if (old !== undefined && !old.done()) return;
        const hbExisting = this._heartbeats.get(goal_id);
        if (hbExisting !== undefined && !hbExisting.done()) {
            // 心跳还活着说明锁还在被续——上一个 worker 没收干净，或者注册表丢了
            // 把手。总之不能在上面重复认领。
            return;
        }
        // 有主租约：身份 + 截止时刻，而不是一把 15 分钟的静态窗。心跳任务不断
        // 把 lease_until 往前推；**这一列**过期才让被丢掉的目标重新可认领。
        const owner = `${GS_SEAMS.procGen()}:${GS_SEAMS.uuid4Hex().slice(0, 8)}`;
        if (!pyTruth(this._storage.claim_goal(
            goal_id, STALE_CLAIM_SEC, owner, CLAIM_LEASE_SEC))) {
            return;  // 别的进程拿到了，或它的租约还活着——跳过。
        }
        this._owners.set(goal_id, owner);
        this._storage.update_goal_fields(goal_id, {
            status: RUNNING, started_at: pyInt(GS_SEAMS.now()),
        });
        this._emit_change(goal_id, RUNNING);
        const task = GS_SEAMS.createTask(() => this._run_worker(goal_id));
        this._workers.set(goal_id, task);
        this._heartbeats.set(goal_id, GS_SEAMS.createTask(
            () => this._heartbeat_loop_factory(goal_id, owner)));
    }

    /**
     * 首轮之前保证目标有子任务列表（从 brief 的交付物派生）。
     * 绝不覆盖已有计划，所以重启续跑保住它记下的状态。
     */
    _ensure_plan(goal_id: string): unknown {
        try {
            const brief = this._goal_manager.get_brief(goal_id);
            const gp = GS_SEAMS.goalPlanModule();
            const fn = modAttr(gp, "seed_plan_from_brief", "goal_plan") as
                (gid: string, b: unknown) => unknown;
            return fn(goal_id, brief);
        } catch (exc: unknown) {
            GS_SEAMS.print(
                `[goal_scheduler] plan seed failed for ${goal_id}: ${pyStr(exc)}`);
            return [];
        }
    }

    /** 首轮提示词：目标本身，加上还没做完的那些。 */
    static _opening_prompt(description: unknown, plan: unknown): string {
        const gp = GS_SEAMS.goalPlanModule();
        const render = modAttr(gp, "render_unfinished", "goal_plan") as
            (p: unknown) => unknown;
        const block = pyStr(render(plan));
        if (block === "") return pyStr(description);
        return `${pyStr(description)}\n\n${block}`;
    }

    /**
     * 把一轮的真实花费记进目标账本。
     *
     * 数字来自 `Result.meta["usage"]`（router 在登记时刻按价目表算出来的）。
     * 旧代码不分模型不分尺寸一律收 3000 micros，于是 $0.50 的帽在 15 轮里
     * 永远到不了——上限存在但从不触发。
     */
    _charge_round(goal_id: string, turn: Result<unknown>): JsonDict {
        const meta = pyOr(pyGetAttr(turn, "meta", null), {}) as JsonDict;
        const usage = pyOr(dictGet(meta, "usage"), {}) as JsonDict;
        let micros: number;
        let tokens: number;
        try {
            micros = pyInt(pyOr(dictGet(usage, "cost_micros"), 0));
            tokens = pyInt(pyOr(dictGet(usage, "tokens"), 0));
        } catch (e: unknown) {
            if (e instanceof TypeErrorP || e instanceof ValueErrorP) { micros = 0; tokens = 0; }
            else throw e;
        }
        let source = pyStr(pyOr(dictGet(usage, "cost_source"), ""));
        if (micros <= 0) { micros = FALLBACK_ROUND_MICROS; source = "fallback"; }
        const spend = this._storage.add_goal_spend(goal_id, micros, tokens);
        const cap = pyOr(dictGet(spend, "cost_cap_micros"), DEFAULT_COST_CAP_MICROS);
        const total = dictGetOr(spend, "cost_micros", 0);
        return {
            "cost_micros": micros,
            "tokens": tokens,
            "source": source,
            "cost_micros_total": total,
            "cost_cap_micros": cap,
            "over_cap": pyGe(total, cap),
        };
    }

    /**
     * 把记账失败写进账本，而不只是打到 stdout。
     *
     * 这些失败让后续证据不可信（锚点没推进、明细行没落地）。print 进的是没人
     * 保留的终端；账本才是这条目标轨迹被读出来的地方，缺口必须在那里看得见。
     * 复用 `system.error_logged` 而不是新造事件类型（trace_gateway 拒未知类型），
     * 区别由 payload 里的 `kind` 承载。
     */
    _note_failure(goal_id: string, kind: string, detail: JsonDict): void {
        try {
            const payload: JsonDict = {
                "kind": kind,
                "goal_id": goal_id,
                ...detail,
            };
            this._storage.trace_event({
                "session_id": pyOr(this._session_of_goal(goal_id), goal_id),
                "event_type": EventType.SYSTEM_ERROR_LOGGED,
                "payload": payload,
                "importance": "critical",
                "goal_id": goal_id,
            });
        } catch (exc: unknown) {
            // 丢掉一条笔记不能把这一轮一起带走。
            GS_SEAMS.print(
                `[goal_scheduler] could not record ${kind} for ${goal_id}: ${pyStr(exc)}`);
        }
    }

    /**
     * 写这一轮的明细行。永不抛。
     *
     * goals 行只有一个轮次计数器，答不出"第 4 轮干了什么/为什么被拒"，重启之后
     * 内存列表没了就更答不出。
     */
    _record_round(
        goal_id: string, ordinal: number, started_at: number, evidence: unknown,
        verdict: string, reason: string, cost_micros: number, tokens: number,
    ): void {
        try {
            this._storage.add_goal_iteration(
                goal_id, ordinal, started_at, pyInt(GS_SEAMS.now()),
                pyStr(evidence), verdict, reason, cost_micros, tokens,
            );
        } catch (exc: unknown) {
            GS_SEAMS.print(
                `[goal_scheduler] iteration row failed for ${goal_id}#${ordinal}: ${pyStr(exc)}`);
            // 证据没落地的轮次是轨迹上的一个洞。要说出来，否则轮次列表只是凭空
            // 跳掉一个号。
            this._note_failure(goal_id, "goal.round_record_failed", {
                "ordinal": ordinal, "error": pyStr(exc),
            });
        }
    }

    /** 跑项目自己的检查。永不抛，也永不阻塞循环。 */
    async _machine_verify(workspace: unknown): Promise<JsonDict> {
        try {
            return await GS_SEAMS.verifyGate.verify(pyStr(workspace));
        } catch (exc: unknown) {
            GS_SEAMS.print(`[goal_scheduler] verify gate failed: ${pyStr(exc)}`);
            return {
                "ran": false, "passed": false, "skipped": true,
                "skipReason": `验证没能执行：${pyStr(exc)}`,
                "results": [], "summary": "",
            };
        }
    }
    // ------------------------------------------------------------------
    // 核心执行循环
    // ------------------------------------------------------------------

    /**
     * 一个目标的执行循环。
     *
     * 与 `Router.run_goal()` 同形，但多了：每轮真实成本对帽、熔断（成本帽 /
     * 卡死动作 / 轮次上限）、模型自称完成时的机器验证闸（UA4）、每轮明细行
     * 与落盘的行动计划、实时 WS 事件。
     */
    async _run_worker(goal_id: string): Promise<void> {
        const storage = this._storage;
        const manager = this._goal_manager;
        const row = storage.get_goal(goal_id);
        if (row === null || row === undefined) return;

        const description = dictGetOr(row, "description", "");
        const max_iter = pyOr(dictGet(row, "max_iterations"), DEFAULT_MAX_ITERATIONS);
        const cost_cap = pyOr(dictGet(row, "cost_cap_micros"), DEFAULT_COST_CAP_MICROS);
        // 目标的归属会话只解析一次：整个循环用同一个 Router，workspace 与
        // session_id 才不会一轮一个样。
        const router = this._router_for_goal(row);

        // 强制的检查点预检（Continue-As-New 的含义保持不变：绝不把旧消息重放进
        // 模型调用——但续跑必须先证明地基完好、并读出账本说哪些已经落地/哪些
        // 结果未知）。预检失败**拒绝进入 running**，而不是靠猜续跑。
        const pre = await this._preflight_checkpoint(goal_id, row);
        const preOk = pre[0];
        const preWhy = pre[1];
        const ledgerBlock = pre[2];
        if (!pyTruth(preOk)) {
            await this._fail(goal_id, pyStr(preWhy));
            return;
        }

        // 流水阶段 1/3：规划。在行动项（重）播种之前发，UI 的"规划"灯因此能
        // 亮上这一小会儿。
        this._emit_stage(goal_id, "plan",
            pyInt(pyOr(dictGet(row, "iteration"), 0)), max_iter);
        let plan: unknown = this._ensure_plan(goal_id);
        let prompt = GoalScheduler._opening_prompt(description, plan);
        if (pyTruth(ledgerBlock)) prompt = `${prompt}\n\n${pyStr(ledgerBlock)}`;
        const signatures: string[] = [];
        const sigWindow = pyMax(STUCK_WINDOW, MAX_SAME_ACTION_REPEATS);
        // U5：跨轮累计的动作层交付语义提示（只佐证，不裁决）。
        let hintsTotal = empty_delivery_hints();
        let handoffSignaled = 0;
        // UA4：修失败机器验证所花的轮次单独记账，不吃真正干活的那份预算。
        let repairsUsed = 0;
        const workspace = pyStr(pyOr(pyGetAttr(router, "workspace", ""), ""));

        // python 的这些局部量在 try 内绑定，而绑定之前没有 await 点（该差异不可
        // 达）；JS 的块作用域要求它们在 catch 臂里可见，故提前声明。
        let roundsDone = 0;
        let iteration = 0;
        let limit: unknown = 0;
        let runId = "";

        try {
            // 轮次是**累计**的，不是每次启动重新数。以前这里是 iteration = 0：
            // 断电重启后续跑的第一轮又拿 ordinal=1 去写 goal_iterations，而那张表
            // 对 (goal_id, ordinal) 是 UPDATE 幂等——断电前第 1 轮的证据就被无声
            // 覆盖掉了。同时轮次预算也跟着满血复活：goals.iteration 一直涨，
            // 每次续跑却又能再跑满 max_iter 轮，上限形同虚设（成本上限没这问题，
            // 它本来就按累计额判断）。
            roundsDone = pyInt(pyOr(dictGet(row, "iteration"), 0));
            iteration = roundsDone;
            limit = max_iter;
            // 本轮 worker 调用 = 一个 run：技能经验与 USES 关系边都按它归因。
            // 重启续跑会铸新 run_id——恢复后的工作和断电前的工作不会混账。
            runId = GS_SEAMS.uuid4Hex().slice(0, 12);
            // 合同预算覆盖（Phase 3）：合同声明优先于全局常量；0 表示沿用默认。
            let repairBudget = VERIFY_REPAIR_BUDGET;
            try {
                const ac = GS_SEAMS.acceptanceModule(["get_goal_contract"]);
                const getContract = needName(ac, "get_goal_contract", "acceptance_contract") as (st: unknown, gid: string) => unknown;
                const c0 = getContract(storage, goal_id);
                if (pyTruth(c0)) {
                    const b = pyOr(dictGet(c0, "budget"), {}) as JsonDict;
                    if (pyInt(pyOr(dictGet(b, "max_repair_attempts"), 0)) > 0) {
                        repairBudget = pyInt(pySub(b, "max_repair_attempts"));
                    }
                    if (pyInt(pyOr(dictGet(b, "max_iterations"), 0)) > 0) {
                        const contractMax = pyInt(pySub(b, "max_iterations"));
                        // min(limit, 合同值)：CPython 先保留 limit，再逐个比较。
                        if (pyLt(contractMax, limit)) limit = contractMax;
                    }
                }
            } catch {
                /* fail-open: 可选增强，失败不影响主流程 */
            }
            if (pyGe(iteration, limit)) {
                // 预算在上一次运行里就花完了。静默退出会让目标停在 running 却
                // 什么都不做；如实说清"已经跑了几轮"，用户才知道该调 max_iterations
                // 还是放弃。
                await this._fail(
                    goal_id,
                    `轮次预算已用尽：累计已跑 ${pyStr(roundsDone)} 轮，上限 ${pyStr(limit)} 轮。`
                    + "要继续请提高 max_iterations。",
                );
                return;
            }
            let stoppedExternally = false;
            while (pyLt(iteration, limit)) {
                iteration += 1;
                // --- 是否已被外部暂停/取消 ---
                const fresh = storage.get_goal(goal_id);
                if (!pyTruth(fresh)
                    || !pyIn(dictGet(fresh, "status"),
                        [RUNNING, GoalStatus.ACTIVE, GoalStatus.STARTED])) {
                    stoppedExternally = true;
                    break;
                }

                // --- 执行一轮 ---
                const startedAt = pyInt(GS_SEAMS.now());
                // 流水阶段 2/3：执行本轮的回合。
                this._emit_stage(goal_id, "execute", iteration, max_iter);
                // 这个 context 字典与 router 共享，它在跑的过程中往里填
                // `tool_trace`。循环于是知道一轮**做了哪些动作**；反方向传过去
                // 的 `goal_id` 则让模型的 plan_write 落到这一行目标上。
                const turnCtx: JsonDict = { goal_id, run_id: runId };
                // python 的 `router.handle(...)` 在 router 为 None 时抛
                // AttributeError，端口用同一处 getattr 复刻，不做非空断言。
                const handle = pyGetAttr(router, "handle") as (p: unknown, c: JsonDict) => Promise<Result<unknown>>;
                const turn = await handle.call(router, prompt, turnCtx);
                const evidence = turn.ok
                    ? turn.value : "[failed] " + pyStr(turn.error);
                // 锚点（`goals.iteration`）和轮次明细行由**两个不同的调用**推进。
                // 若这一个失败而下面的 _record_round 成功，下次续跑读到的还是
                // 旧锚点（上面的 rounds_done），重发**同一个** ordinal，而
                // add_goal_iteration 的 UPDATE 分支就把那一轮的证据覆盖掉了。
                // 以前把这个 Result 丢掉，让这种错位变得无声——那是单进程内
                // 丢证据的唯一路径。
                const it = manager.add_iteration(goal_id, pyStr(evidence));
                if (!pyTruth(pyGetAttr(it, "ok", true))) {
                    this._note_failure(goal_id, "goal.anchor_desync", {
                        "ordinal": iteration,
                        "error": pyStr(pyOr(pyGetAttr(it, "error", ""), "")),
                    });
                }

                // --- 成本记账（真实 token，登记时刻定价）---
                const charge = this._charge_round(goal_id, turn);
                if (pyTruth(charge["over_cap"])) {
                    this._record_round(goal_id, iteration, startedAt, pyStr(evidence),
                        "cost_cap", "cost cap reached",
                        charge["cost_micros"] as number, charge["tokens"] as number);
                    await this._fail(
                        goal_id,
                        "Cost cap exceeded: $"
                        + pyFormatF(pyDiv(charge["cost_micros_total"], 1_000_000), 4)
                        + " >= $" + pyFormatF(pyDiv(cost_cap, 1_000_000), 2),
                    );
                    return;
                }

                // --- 卡死熔断 ---
                signatures.push(
                    round_signature(dictGet(turnCtx, "tool_trace"), pyStr(evidence)));
                if (signatures.length > sigWindow) signatures.shift();
                const stuck = is_stuck(signatures);
                if (pyTruth(stuck)) {
                    this._record_round(goal_id, iteration, startedAt, pyStr(evidence),
                        "stuck", stuck,
                        charge["cost_micros"] as number, charge["tokens"] as number);
                    await this._fail(goal_id, "Stuck loop detected: " + stuck);
                    return;
                }

                // --- U5：收集本轮交付语义提示并跨轮累计 --------------------
                // 提示来自 tool_trace 里动作结果 payload 的 delivery_hint 键；
                // handoff 计数上升才发接管信号（按轮去重，detail 取最新）。
                const roundHints = collect_delivery_hints(dictGet(turnCtx, "tool_trace"));
                hintsTotal = merge_delivery_hints(hintsTotal, roundHints);
                if (pyInt(pyOr(dictGet(hintsTotal, "handoff_count"), 0)) > handoffSignaled) {
                    handoffSignaled = pyInt(pySub(hintsTotal, "handoff_count"));
                    this._emit_change(goal_id, RUNNING, {
                        "handoff_required": true,
                        "handoff_detail":
                            pyStr(pyOr(dictGet(hintsTotal, "latest_handoff_detail"), "")),
                        "delivery_hints": pyDictCopy(hintsTotal),
                    });
                }

                // --- 进度事件 + 流水阶段 3/3：验证 ---
                // 本轮的活干完了、下一步是验证器，所以这个存在已久的进度事件
                // **就是** execute→verify 的分界；现在它还报出阶段名给流水 UI，
                // 并带上 delivery_hints 的佐证聚合，让前端 verify 气泡有数可显。
                this._emit_stage(goal_id, "verify", iteration, max_iter,
                    { "delivery_hints": pyDictCopy(hintsTotal) });

                // --- 验证完成 ---
                // U5：语义提示只能随既有证据通道佐证（evidence_with_hints 的
                // 空证据护栏保证提示翻不转 heuristic 判据）；物理门禁在下面
                // 独立裁决，判据一行未动。
                const verdict = await manager.verify_completion(goal_id,
                    evidence_with_hints(pyStr(evidence), hintsTotal));
                let passed = pyTruth(dictGet(verdict, "passed"));

                // UA4：模型的"做完了"是一个**声称**，不是一个结果。在收下之前
                // 先跑项目自己的检查。只在通过时设闸——被拒绝的目标本来就要
                // 再来一轮，跑全套测试去确认"没做完的东西确实没做完"，代价是
                // 一整套测试，换来的是零信息。
                let gate: JsonDict = {};
                if (passed) {
                    gate = await this._machine_verify(workspace);
                    if (pyTruth(dictGet(gate, "ran")) && !pyTruth(dictGet(gate, "passed"))) {
                        passed = false;
                    }
                }
                const gateRan = pyTruth(dictGet(gate, "ran"));

                this._record_round(
                    goal_id, iteration, startedAt, pyStr(evidence),
                    passed ? "passed" : (gateRan ? "verify_failed" : "rejected"),
                    gateRan && !passed
                        ? pyStr(pyOr(dictGet(gate, "summary"), ""))
                        : pyStr(pyOr(dictGet(verdict, "reason"), "")),
                    charge["cost_micros"] as number, charge["tokens"] as number,
                );

                // Phase 2 checkpoint：每轮结束落一份自包含快照，断电后可答
                // "做到哪一步、哪些副作用不能重做"。
                try {
                    const cp = await GS_SEAMS.checkpointModule();
                    const build = needName(cp, "build_checkpoint", "checkpoint") as (st: unknown, opts: JsonDict) => unknown;
                    build(storage, {
                        "session_id": this._session_of_goal(goal_id),
                        "goal_id": goal_id, "run_id": runId,
                        "turn_state": "running",
                        "current_phase": `iter:${pyStr(iteration)}`,
                        "scope": `${goal_id}:${pyStr(iteration)}`,
                    });
                } catch (exc: unknown) {
                    GS_SEAMS.print(`[goals] round checkpoint failed: ${pyStr(exc)}`);
                }

                // 把验证器的判断折进行动计划。通过时每一项按定义都完成了；被
                // 拒绝时只翻转它明确点名的那些项，所以进度永远跑不到"确实验证过
                // 的东西"前面。
                const gp = GS_SEAMS.goalPlanModule();
                const loadPlan = modAttr(gp, "load_plan", "goal_plan") as (gid: string) => unknown;
                const applyCompletion = modAttr(gp, "apply_completion", "goal_plan") as (p: unknown, completed: unknown, allDone: unknown) => unknown;
                const savePlan = modAttr(gp, "save_plan", "goal_plan") as (gid: string, p: unknown) => unknown;
                const folded = pyUnpack2(applyCompletion(
                    loadPlan(goal_id), dictGet(verdict, "completed"), passed));
                plan = folded[0];
                if (pyTruth(folded[1])) savePlan(goal_id, plan);

                if (passed) {
                    // Phase 3 合同门：机器验证通过 ≠ 可以宣布完成。合同里的
                    // 必交付物与验证计划还要全绿；人工确认要求如实记 skipped
                    // 并单独上抛，绝不伪装成自动证据。
                    try {
                        const ac = GS_SEAMS.acceptanceModule(
                            ["check_completion", "get_goal_contract"]);
                        const getContract = needName(ac, "get_goal_contract",
                            "acceptance_contract") as (st: unknown, gid: string) => unknown;
                        const checkCompletion = needName(ac, "check_completion",
                            "acceptance_contract") as (c: unknown, ws: unknown) => unknown;
                        const contract = getContract(storage, goal_id);
                        if (pyTruth(contract)) {
                            const cc = pyUnpack3(
                                checkCompletion(contract, pyOr(workspace, ".")));
                            const okC = cc[0];
                            const unmet = cc[1];
                            const vres = cc[2];
                            const sid = pyOr(this._session_of_goal(goal_id), goal_id);
                            for (const r of pyIter(vres)) {
                                const status = pySub(r, "status");
                                this._storage.trace_event({
                                    "session_id": sid,
                                    "event_type": status === "passed" ? "validator.passed"
                                        : status === "skipped" ? "validator.skipped"
                                            : "validator.failed",
                                    "payload": {
                                        "validator_id": pySub(r, "validator_id"),
                                        "status": status,
                                        "evidence": pySlice4(pySub(r, "evidence")),
                                    },
                                    "importance": pyIn(status, ["passed", "skipped"])
                                        ? "observational" : "critical",
                                    "goal_id": goal_id,
                                });
                            }
                            if (!pyTruth(okC)) {
                                storage.update_goal_fields(
                                    goal_id,
                                    {
                                        "verification_result": pyJsonDumps({
                                            "reason": pyStrTrunc(
                                                "acceptance contract unmet: "
                                                + pyJoin(unmet, "; "), 400),
                                            "contract_version": dictGet(contract, "version"),
                                        }, true),
                                    },
                                );
                                passed = false;
                            }
                        }
                    } catch (exc: unknown) {
                        GS_SEAMS.print(`[goals] contract gate error: ${pyStr(exc)}`);
                    }
                }

                if (passed) {
                    // Phase 2 checkpoint：完成时刻的自包含快照入账
                    try {
                        const cp = await GS_SEAMS.checkpointModule();
                        const build = needName(cp, "build_checkpoint", "checkpoint") as (st: unknown, opts: JsonDict) => unknown;
                        build(storage, {
                            "session_id": this._session_of_goal(goal_id),
                            "goal_id": goal_id, "run_id": runId,
                            "turn_state": "completed", "scope": `${goal_id}:done`,
                        });
                    } catch (exc: unknown) {
                        GS_SEAMS.print(
                            `[goals] completion checkpoint failed: ${pyStr(exc)}`);
                    }
                    storage.update_goal_fields(goal_id, { status: GoalStatus.COMPLETED });
                    this._finish_worker(goal_id);
                    this._emit_change(goal_id, GoalStatus.COMPLETED,
                        { "iteration": iteration, "delivery_hints": pyDictCopy(hintsTotal) });
                    await this._busEmit({
                        "goal_id": goal_id, "status": "completed", "iteration": iteration,
                        "session_id": pyOr(dictGet(row, "session_id"), ""),
                        "verified": gateRan,
                        "verifySummary": pyStr(pyOr(dictGet(gate, "summary"),
                            pyOr(dictGet(gate, "skipReason"), ""))),
                        "delivery_hints": pyDictCopy(hintsTotal),
                    });
                    return;
                }

                // --- 机器验证否掉了一个自称完成的目标 ---
                if (gateRan && !pyTruth(dictGet(gate, "passed"))) {
                    repairsUsed += 1;
                    if (repairsUsed > repairBudget) {
                        await this._fail(
                            goal_id,
                            `验证命令连续 ${pyStr(repairBudget)} 次没通过，已停下：`
                            + pyStr(pyOr(dictGet(gate, "summary"), "")),
                        );
                        return;
                    }
                    // 修复轮有自己的额度，而不是吃掉真正干活那份。逐次 +1 而不是
                    // 重算 max_iter + repairs_used：后者会把合同压低过的 limit 又顶回
                    // 全局默认，也会在续跑（iteration 累计）时把上限算错。
                    limit = pyAddOne(limit);
                    prompt = GS_SEAMS.verifyGate.repairPrompt(gate);
                    continue;
                }

                // --- 继续 ---
                const cont = await manager.continue_goal(goal_id, max_iter);
                if (!cont.ok) {
                    await this._fail(goal_id, cont.error);
                    return;
                }
                prompt = pyStr(pySub(cont.value, "system_reminder"));
            }

            if (stoppedExternally) {
                // 外部落下来的停止/取消：行上现在写着 stopping、stop_timeout、
                // paused 或 queued。这里报"没收敛"是在撒谎——目标不是把预算跑
                // 完的，是被人叫停的（而且停可能还没确认）。留一份快照、丢掉
                // 自己的认领，把最终状态的名字交给 pause()/confirm_stopped。
                try {
                    const cp = await GS_SEAMS.checkpointModule();
                    const build = needName(cp, "build_checkpoint", "checkpoint") as (st: unknown, opts: JsonDict) => unknown;
                    build(storage, {
                        "session_id": this._session_of_goal(goal_id),
                        "goal_id": goal_id, "run_id": runId,
                        "turn_state": "paused",
                        "current_phase": `iter:${pyStr(iteration)}`,
                        "scope": `${goal_id}:stopped`,
                    });
                } catch (exc: unknown) {
                    GS_SEAMS.print(
                        `[goals] external-stop checkpoint failed: ${pyStr(exc)}`);
                }
                this._finish_worker(goal_id);
                const freshAfter = pyOr(storage.get_goal(goal_id), {}) as JsonDict;
                this._emit_change(goal_id,
                    pyOr(dictGet(freshAfter, "status"), GoalStatus.PAUSED),
                    { "iteration": iteration });
                return;
            }

            // 轮次用尽。
            await this._fail(
                goal_id,
                pyTruth(roundsDone)
                    ? `Did not converge within ${pyStr(limit)} iterations `
                        + `(cumulative; ${pyStr(roundsDone)} were already spent before this run)`
                    : `Did not converge within ${pyStr(limit)} iterations`,
            );

        } catch (exc: unknown) {
            if (exc instanceof CancelledErrorP) {
                // 暂停或关停——别标成失败。
                //
                // 但一定要留一份快照。暂停是**常规**操作（用户点一下就发生），
                // 而它恰好是最容易留下"派发了、结果未知"的副作用的时刻；以前这条
                // 路径一行都不写，续跑现场就得靠猜。
                try {
                    const cp = await GS_SEAMS.checkpointModule();
                    const build = needName(cp, "build_checkpoint", "checkpoint") as (st: unknown, opts: JsonDict) => unknown;
                    build(storage, {
                        "session_id": this._session_of_goal(goal_id),
                        "goal_id": goal_id, "run_id": runId,
                        "turn_state": "paused",
                        "current_phase": `iter:${pyStr(iteration)}`,
                        "scope": `${goal_id}:paused`,
                    });
                } catch (e2: unknown) {
                    GS_SEAMS.print(`[goals] pause checkpoint failed: ${pyStr(e2)}`);
                }
                this._finish_worker(goal_id);
                // 重新抛出，任务才真的是被取消的。吞掉它会让任务"正常"结束：
                // `task.cancelled()` 变 False，pause 就没法区分"停了"的 worker 和
                // "没停"的 worker——于是它只能报一句没有凭据的成功。
                throw exc;
            }
            await this._fail(goal_id, "Unhandled exception: " + pyStr(exc));
        }
    }

    // ------------------------------------------------------------------
    // 事件 / 会话 / 预检 / 终态
    // ------------------------------------------------------------------

    /**
     * 目标归属的会话，用于事件路由。
     *
     * 目标事件走进程级总线广播，所以没有这个标签，WS 桥就分不出哪个窗口
     * 拥有这个目标，于是每个窗口都会为别人工作区里的目标亮起来。
     */
    _session_of_goal(goal_id: string): unknown {
        let row: JsonDict;
        try {
            row = pyOr(this._storage.get_goal(goal_id), {}) as JsonDict;
        } catch {
            return "";
        }
        return pyOr(dictGet(row, "session_id"), "");
    }

    /**
     * 跑起来之前加载并核对最新的检查点。返回 `[ok, why, ledger_block]`。
     *
     * `ok=False` 会拦住这次运行：检查点说流被截断了、分支挪了、或者保留的
     * 消息没了——照样续跑就是在猜，而猜正是"已完成的事被做第二遍"的来路。
     *
     * 成功时把检查点里的副作用判定作为一个提示词块返回（dont_redo /
     * verify_before_redo），并发一条 `goal.resumed_from_checkpoint` 事件，
     * 点名这次新运行究竟是从哪个检查点重建的。完全没有检查点的全新目标直接
     * 放行、不带块——还没有可核对的东西。
     */
    async _preflight_checkpoint(goal_id: string, row: JsonDict): Promise<unknown[]> {
        const sid = pyOr(dictGet(row, "session_id"), "");
        let cp: unknown;
        try {
            const m = await GS_SEAMS.checkpointModule();
            const load = needName(m, "load_latest_checkpoint", "checkpoint") as (st: unknown, opts: JsonDict) => unknown;
            cp = load(this._storage, { "goal_id": goal_id, "session_id": sid });
        } catch (exc: unknown) {
            GS_SEAMS.print(
                `[goals] checkpoint load failed for ${goal_id}: ${pyStr(exc)}`);
            cp = null;
        }
        if (cp === null || cp === undefined) return [true, "", ""];
        let res: JsonDict;
        try {
            const m = await GS_SEAMS.checkpointModule();
            const resume = needName(m, "resume_from_checkpoint", "checkpoint") as (st: unknown, c: unknown) => unknown;
            res = resume(this._storage, cp) as JsonDict;
        } catch (exc: unknown) {
            return [false,
                `checkpoint 预检崩溃，目标不得进入 running：${pyStr(exc)}`, ""];
        }
        if (!pyTruth(dictGet(res, "ok"))) {
            const problems = pyJoin(
                pyIter(pyOr(dictGet(res, "problems"), [])).map(pyStr), "；");
            return [false,
                "checkpoint 预检未通过，目标不得进入 running："
                + pyOr(problems, "未知原因"), ""];
        }

        const dontRedo = pyOr(dictGet(res, "dont_redo"), []);
        const verifyFirst = pyOr(dictGet(res, "verify_before_redo"), []);
        let ledgerBlock = "";
        if (pyTruth(dontRedo) || pyTruth(verifyFirst)) {
            ledgerBlock = `[checkpoint 预检 ${pyStr(pyOr(dictGet(cp, "last_event_id"), ""))}] `
                + `账本记录：已确认落地的副作用 ${pyStr(pyLen(dontRedo))} 项——不要原样重做；`
                + `结果未知的副作用 ${pyStr(pyLen(verifyFirst))} 项——动手前先核对当前状态。`;
        }
        try {
            this._storage.trace_event({
                "session_id": pyOr(sid, goal_id),
                "event_type": EventType.GOAL_RESUMED_FROM_CHECKPOINT,
                "payload": {
                    "goal_id": goal_id,
                    "checkpoint_event_seq": dictGet(cp, "checkpoint_event_seq"),
                    "checkpoint_last_event_id":
                        pyStr(pyOr(dictGet(cp, "last_event_id"), "")),
                    "dont_redo_count": pyLen(dontRedo),
                    "verify_before_redo_count": pyLen(verifyFirst),
                    "context_snapshot_id":
                        pyStr(pyOr(dictGet(cp, "context_snapshot_id"), "")),
                },
                "importance": "critical",
                "goal_id": goal_id,
            });
        } catch (exc: unknown) {
            // 续跑本身已经核过；丢掉它的公告不能拦住续跑，但也不能无声无息。
            GS_SEAMS.print(
                `[goals] resumed_from_checkpoint event failed: ${pyStr(exc)}`);
        }
        return [true, "", ledgerBlock];
    }

    /** 终态失败：落库、放锁、通知。 */
    async _fail(goal_id: string, reason: string): Promise<void> {
        this._storage.update_goal_fields(goal_id,
            { status: GoalStatus.FAILED_FINAL, last_error: reason });
        this._finish_worker(goal_id);
        this._emit_change(goal_id, GoalStatus.FAILED_FINAL, { "error": reason });
        await this._busEmit({
            "goal_id": goal_id, "status": "ovolve_failed_final", "reason": reason,
            "session_id": this._session_of_goal(goal_id),
        });
    }

    /** python `await self._bus.emit("goal_state_change", payload)`。 */
    async _busEmit(payload: JsonDict): Promise<unknown> {
        const emit = pyGetAttr(this._bus, "emit") as (n: string, p: JsonDict) => unknown;
        return await emit.call(this._bus, "goal_state_change", payload);
    }

    /** 经事件总线 fire-and-forget 广播。 */
    _emit_change(goal_id: string, status: unknown, extra: JsonDict = {}): void {
        const payload: JsonDict = {
            "goal_id": goal_id,
            "status": status,
            "session_id": this._session_of_goal(goal_id),
            ...extra,
        };
        try {
            GS_SEAMS.callSoon(() => {
                GS_SEAMS.ensureFuture(() => this._busEmit(payload));
            });
        } catch (exc: unknown) {
            if (exc instanceof RuntimeErrorP) return;  // 没有运行中的循环（单测）
            throw exc;
        }
    }

    /**
     * 广播细粒度流水阶段（plan / execute / verify）。
     *
     * 搭前端**已经在消费**的同一条 `goal_state_change` 通道——WS 桥原样转发
     * payload，所以新的 `stage` 字段零桥改改动就流过去了，而老消费者（进化只
     * 对终态有反应）忽略它。`extra`（U5）把附加字段（如 delivery_hints 佐证
     * 聚合）平铺进同一枚事件；非 dict 一律当空，fail-open 与本方法其余部分
     * 一致。
     *
     * fail-open 双层：本方法自吞同步异常；_emit_change 分离派发的 emit 任务
     * 失败也绝不波及 worker 状态机。终态（completed / ovolve_failed_final）与
     * spawn/pause 的既有事件一律不带 stage——stage 只是 running 的细分，不是
     * 新状态。
     *
     * 纯告知性：任何失败都不许打扰 worker 循环，上面那套分离派发已经保证了。
     */
    _emit_stage(
        goal_id: string, stage: string, iteration: unknown = 0,
        maxIterations: unknown = 0, extra: unknown = null,
    ): void {
        try {
            const payloadExtra = isPyDict(extra) ? pyDictCopy(extra) : {};
            this._emit_change(goal_id, RUNNING, {
                "stage": stage,
                "iteration": pyInt(pyOr(iteration, 0)),
                "max_iterations": pyInt(pyOr(maxIterations, 0)),
                "ts": pyInt(GS_SEAMS.now()),
                ...payloadExtra,
            });
        } catch (exc: unknown) {
            GS_SEAMS.print(
                `[goal_scheduler] stage event failed for ${goal_id}: ${pyStr(exc)}`);
        }
    }
}

// ---------------------------------------------------------------------------
// 局部 python 语义补充（本文件的调用点用得到）
// ---------------------------------------------------------------------------

/** python `d["k"]`：缺键是 KeyError（repr 形态的消息），与 `.get()` 分家。 */
class KeyErrorP extends Error {
    constructor(k: unknown) {
        super(pyReprStr(pyStr(k)));
        this.name = "KeyError";
    }
}
function pySub(o: unknown, k: string): unknown {
    if (o instanceof Map) {
        if (!o.has(k)) throw new KeyErrorP(k);
        return o.get(k);
    }
    if (isPyDict(o)) {
        if (!Object.prototype.hasOwnProperty.call(o, k)) throw new KeyErrorP(k);
        return (o as JsonDict)[k];
    }
    throw new TypeErrorP(`'${pyTypeName(o)}' object is not subscriptable`);
}

/**
 * python `import X` 之后的 `X.name` 取用：属性缺失是 AttributeError，
 * 与 `from X import name` 的 ImportError（needName）分家。
 */
function modAttr(mod: unknown, name: string, moduleName: string): unknown {
    const v = (mod as Record<string, unknown>)[name];
    if (v === undefined) {
        throw new AttributeErrorP(
            `module '${moduleName}' has no attribute '${name}'`);
    }
    return v;
}

/** python `x + 1`（str/list 的操作数文案各不同）。 */
function pyAddOne(v: unknown): unknown {
    if (typeof v === "boolean") return (v ? 1 : 0) + 1;
    if (typeof v === "number") return v + 1;
    if (typeof v === "string") {
        throw new TypeErrorP('can only concatenate str (not "int") to str');
    }
    if (Array.isArray(v)) {
        throw new TypeErrorP('can only concatenate list (not "int") to list');
    }
    if (v === null || v === undefined) {
        throw new TypeErrorP("unsupported operand type(s) for +: 'NoneType' and 'int'");
    }
    throw new TypeErrorP(
        `unsupported operand type(s) for +: '${pyTypeName(v)}' and 'int'`);
}

/** python `a < b` 在混合类型上的 CPython 文案。 */
function pyLt(a: unknown, b: unknown): boolean {
    const an = typeof a === "boolean" ? (a ? 1 : 0) : a;
    const bn = typeof b === "boolean" ? (b ? 1 : 0) : b;
    if (typeof an === "number" && typeof bn === "number") return an < bn;
    if (typeof an === "string" && typeof bn === "string") return an < bn;
    throw new TypeErrorP(
        `'<' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** python `x in (a, b, …)`：按值的相等比较，非容器成员判定。 */
function pyIn(x: unknown, items: readonly unknown[]): boolean {
    for (const it of items) if (pyEq(x, it)) return true;
    return false;
}
function pyEq(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    // python 的 `1 == True`；端口两侧都按原始值进出，故只补这一条常见跨型等值。
    if (typeof a === "number" && typeof b === "boolean") return a === (b ? 1 : 0);
    if (typeof a === "boolean" && typeof b === "number") return (a ? 1 : 0) === b;
    return false;
}

/** python `seq[:4]`：列表切元素、字符串切码点，其余按 CPython 文案炸。 */
function pySlice4(v: unknown): unknown {
    if (Array.isArray(v)) return v.slice(0, 4);
    if (typeof v === "string") return pyStrTrunc(v, 4);
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
        return Array.from(v).slice(0, 4);
    }
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not subscriptable`);
}

/** python `sep.join(seq)`：元素必须都是 str，非可迭代是另一种文案。 */
function pyJoin(seq: unknown, sep: string): string {
    let items: unknown[];
    try {
        items = pyIter(seq);
    } catch (exc: unknown) {
        if (exc instanceof TypeErrorP) throw new TypeErrorP("can only join an iterable");
        throw exc;
    }
    for (let i = 0; i < items.length; i++) {
        if (typeof items[i] !== "string") {
            throw new TypeErrorP(
                `sequence item ${i}: expected str instance, ${pyTypeName(items[i])} found`);
        }
    }
    return (items as string[]).join(sep);
}

// ---------------------------------------------------------------------------
// 单例
// ---------------------------------------------------------------------------

let _scheduler: GoalScheduler | null = null;

/**
 * 取（或建）全局 GoalScheduler 单例。
 *
 * `host` 是 SessionHost；传了它，每个目标就在**拥有它的那个会话**的 Router 里
 * 执行，而不是全应用共用一个 router。
 */
export function get_goal_scheduler(
    router: RouterLike | null = null, bus: BusLike | null = null,
    host: HostLike | null = null,
): GoalScheduler {
    if (_scheduler === null) {
        if (router === null || bus === null) {
            throw new RuntimeErrorP(
                "GoalScheduler must be initialized with router and bus on first call");
        }
        _scheduler = new GoalScheduler(router, bus, host);
    }
    return _scheduler;
}

// PORT STATUS: 本文件无 TODO(port)。
