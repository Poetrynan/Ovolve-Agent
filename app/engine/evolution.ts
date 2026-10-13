/**
 * evolution.ts — 自演化系统：从复发失败里挖出规则，做成提案交给用户审。
 *
 * Ported from `app/backend/evolution.py` (3201 lines), wave-4 SPLIT unit.
 *
 * Agent 会把同一个错犯很多遍。本模块把复发的错挖成引导文件（AGENTS.md /
 * MEMORY.md / SOUL.md）里的一条规则提案——挖掘 → 生成草稿 → **用户显式接受**
 * → 由系统侧写盘。系统侧写盘走直接文件 IO，刻意绕过 PathGuard：PathGuard
 * 关的是**模型**的门，不是系统的门；这条路径上有人点了"接受"。
 * 三条纪律照源逐字兑现：档位缺省、宁可不提不可骚扰（签名去重 + 冷却 +
 * max_open 上限）、绝不谎报（decide() 返回真实的 applied 结果）。
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/evolution.py -> app/engine/evolution.ts；
 *       模块级函数与顶层 API 名保持源侧 snake_case（file_agent/memory_domain
 *       先例）：normalize_error / signature_for / classify_observation /
 *       build_goal_observation / record_goal_validation_edges / materialize_
 *       observation / parse_rule_line / format_rule_line / consolidate_rules /
 *       find_matching_rule_index / find_conflicting_line / demote_ineffective_
 *       rules / get_evolution_engine / reset_for_tests / configure_from_config /
 *       attach_to_bus 全部导出；类名原样（Proposal / EvolutionStore /
 *       EvolutionEngine / EvolutionObservation / SemanticReflection /
 *       ReflectionGenerator）。
 *   §2  bug-for-bug kept source quirks（parity 钉死）：
 *       - 模块头写"默认关"，常量却是 DEFAULT_MODE = MODE_CAUTIOUS——逐字保留。
 *       - EvolutionEngine.__init__ 的 storage 快捷路径查的是 `_db_dir` 属性，
 *         storage.py 实际只有 `db_dir` —— hasattr 永远 False，storage 参数在
 *         这条分支上从不生效。原样保留（连 ?? db_dir 兜底都不写）。
 *         materialize_observation 里读 `_root_dir` 同理，root_dir 恒为 ""。
 *       - mine() 的 user_correction/workflow/preference 强信号 1 次即达标
 *         （SQL HAVING 里的 OR 分支）——阈值只对别的 kind 起作用。
 *       - hot/信号 SQL 用 MAX(tool_name)/MAX(kind)/MAX(detail) 折叠签名行。
 *       - list_observations 过滤 bench-% 与 tool-test-% 会话。
 *       - insert_bundle：给了 key 且已存在 → 原样返回旧 id（不覆盖）；并发撞
 *         唯一索引 → 再查一次旧件为准；老库没新列 → 降级写旧列集合。
 *       - decide() 四种返回形状（missing/already-decided/rejected/accepted）
 *         字段集各不相同，原样。
 *       - _infer_human_meta 的分支顺序与关键词集是产品行为的一部分，逐字照搬
 *         （含 "403" 在**未 lower** 的 detail 上查、"confirmation" 在 lowered 上查）。
 *       - record_signal 数到 MAX_SIGNALS_PER_SIGNATURE 即静默丢弃；count==0 时
 *         顺手 DELETE 过期信号（均摊清理）。
 *       - maybe_mine 只在真挖出东西后才更新 _last_mine_at（空跑不算跑）。
 *   §1  no new deps：node:sqlite（经已落地的 sqlite_connection.ts 适配层）、
 *       node:crypto、node:fs、node:path、node:os。
 *
 * DIVERGENCE(port) —— 每一条都有等价论证，fixtures 双向核对：
 *   1) sqlite3 异常分类：Python 用 except sqlite3.OperationalError /
 *      IntegrityError 类型区分；node:sqlite 统一抛 Error，带 errstr
 *      （SQLITE_CONSTRAINT_* / SQLITE_ERROR）。_sqliteErrKind 按 errstr/消息
 *      归类 "integrity"（constraint failed）vs "operational"（含 duplicate
 *      column、no such column/table）。两分支的判断条件（"duplicate column"
 *      子串、IntegrityError-再查、OperationalError-旧列降级）与源逐字一致。
 *      源里 IntegrityError 分支的 rollback() 在 node:sqlite 下是空操作
 *      （失败语句从未提交），省略该调用等价。
 *   2) 时钟/uuid/日期的测试缝：源里 time.time()、uuid.uuid4()、
 *      time.strftime("%Y-%m-%d") 遍布全模块，harness 靠 monkeypatch 钉死；
 *      TS 侧给 _set_now_for_parity / _set_uuid_seq_for_parity（确定性伪 hex，
 *      与 py 侧 FakeUUID 同序）；strftimeDate 由 _now() 推本地日期，固定
 *      时钟自然流动，与 py 侧 patch time.time 后 strftime 跟着变完全同构。
 *      产品路径永不调用这些缝。
 *   3) asyncio 依赖的三个挂点：
 *      - `_on_tool_result` 是 async 订阅者 → TS async 函数，逐字对应。
 *      - `_publish_insight` / `_publish_proposal_count` 用
 *        `asyncio.get_running_loop()` 探测"是否处于事件循环中"，纯同步调用
 *        （测试）里 RuntimeError → 静默跳过。Node 事件循环恒在，该探测不可
 *        从运行时恢复 → 显式缝 _set_running_loop_probe_for_parity(fn)（缺省
 *        () => true = 有循环 = 产品语义；harness 置 false 复现 py 纯同步路径）。
 *      - `asyncio.create_task(bus.emit(...))` 火后不管 → `void Promise.resolve(
 *        bus.emit(...)).catch(静默)`：py 里未 await task 的异常只在 loop 关闭
 *        时进 stderr，不向上冒；JS 不接 reject 会炸进程，故 catch 掉。
 *   4) getattr 与属性面：AgentEvent 的 `goal_id/id/event_id/chain_hash` 在
 *      落地 TS 面上是 goalId/id?/eventId?/chainHash。三连
 *      `getattr(ev,"id","") or getattr(ev,"event_id","")` 两侧都落 ""——两侧
 *      AgentEvent 都没有这两个字段，quirk 同构保留。chain_hash 读
 *      (ev as any).chainHash ?? (ev as any).chain_hash，与 memory_domain D2
 *      同一论证（两张面各被自己的语言测试钉住）。
 *   5) kwargs→落地签名：storage.list_skill_experiences(goal_id=, limit=,
 *      include_task_level=) → ({goal_id, limit, include_task_level})；
 *      list_skill_candidates(limit=200) → (null, 200)；list_goal_iterations
 *      (goal_id, limit=) 位置参；get_memory_entries(root=, mem_type=,
 *      include_archived=, limit=) 位置参；save_memory_entry(eid=, sid=, root=,
 *      scope=, content=, mem_type=, ...) → (eid, sid, root, scope, content,
 *      opts)；add_relation(..., evidence=) → 第 7 位置参；insert_learning_item
 *      (kwargs 袋) → 同键 snake_case 袋；event_store.append(..., branch_id=,
 *      goal_id=, run_id=, idempotency_key=, actor=, visibility=) → opts 对象。
 *      与 storage.ts / skills.ts / memory.ts / recall.ts / event_store.ts 已
 *      验证单元逐字对齐。
 *   6) 正则 Unicode 类与词边界：Python 的 \b/\w/\d/\W 按 Unicode 判定，JS 是
 *      ASCII。所有含边界的凭证/数字模式改写成 lookaround
 *      (?<![\p{L}\p{N}\p{M}_]) / (?![\p{L}\p{N}\p{M}_])，\d→[\p{Nd}]，
 *      \w→[\p{L}\p{N}_\p{M}]（memory_domain D5 同款）。CJK 相邻数字/字母的
 *      边界行为由 fixtures 钉死（"第3轮"、"2024年"）。`$` 的"末尾换行前也可
 *      匹配"差异在所有实际输入（strip 过的文本）上不可达，未做补偿。
 *   7) float→字符串：f"{weight}" 用 pyFloatStr（整数值补 ".0"，同 CPython
 *      repr）；int→str 用 pyStr。
 *   8) print/logging：`print(...)` → console.log；`logger.warning(f"...")` →
 *      console.error（py logging lastResort 落 stderr）。消息模板逐字一致。
 *   9) 字符串切片 [:400]/[:160]/[:200]/[:2000] 按 Python 码点切（pcSlice），
 *      len() 同样按码点（pcLen）。
 *  10) json.loads 的 NaN/Infinity 裸记号：JSON.parse 不认 → 落进源的
 *      except 分支（verdict={}、payload={} 等）。这些列全部由产品侧
 *      json.dumps 写入，不可能含裸记号（wiki_store 落地时的同一论证）。
 *  11) time.time() 是浮点秒：_now() 返回 Date.now()/1000，created_at /
 *      decided_at 列都是 REAL，两侧同形。
 *  12) PrivacySanitizer：源里 try-import-否则 None；sanitizer.ts 已落地，
 *      静态 import；`if PrivacySanitizer` 的分支仍照源保留（干净等价）。
 *  13) 单例与全局：_engine/_attached_buses/_bus_ref 为模块级可变绑定，
 *      WeakSet 顶替按 id(bus) 去重的 set（Node 没有 id()，对象身份等价；
 *      reset_for_tests 重建 WeakSet，同 py 置空 set）。
 *  14) 源里函数体内的 `from storage import get_storage` 等懒 import，落地
 *      模块全部已就位 → 顶层静态 import；try/except 结构原样保留（保护的是
 *      调用期的异常，不是 import 期），行为等价由 harness 的抛错用例钉。
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { openSqlite, type SqliteConnection } from "./sqlite_connection.js";
import { dbDir } from "./user_dirs.js";
import { PrivacySanitizer } from "./sanitizer.js";
import { get_storage } from "./storage.js";
import { get_event_store } from "./event_store.js";
import { EventType } from "./event_types.js";
import { create_candidate } from "./skill_lifecycle.js";
import { EvolutionDraftManager } from "./evolution_tools.js";
import { create_evolution_snapshot } from "./evolution_undo.js";
import { GEPAEvolutionOptimizer } from "./gepa_evolution.js";
import { MemoryTier } from "./memory_tiers.js";
import { get_graph_memory_engine } from "./memory_layer.js";
import { atomic_write } from "./file_agent.js";
import { pyJsonDumps } from "./storage/storage_funcs.js";

type Row = Record<string, unknown>;
type JsonDict = Record<string, unknown>;

// ── house Python-semantics helpers（per-file，项目约定，抄 memory_domain.ts）──

function pyTruth(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return String(v);
}

/** str(exc)：我们构造的 Error 都带 Python 形状的消息。 */
function pyStrExc(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (Array.isArray(v)) return "list";
  return "dict";
}

/** `str(a or b)` —— falsy or-gate 再 str()。 */
function pyStrOr(v: unknown, dflt: unknown): string {
  return pyStr(pyTruth(v) ? v : dflt);
}

/** `a or b` —— 只 gate 真假，不做 str()。 */
function pyOr(v: unknown, dflt: unknown): unknown {
  return pyTruth(v) ? v : dflt;
}

/** dict.get(k, dflt)：键在但值是 None 时默认值不生效（与 pyOr 相区分）。 */
function pyGetDefault(d: JsonDict | null | undefined, k: string, dflt: unknown): unknown {
  if (!d || !(k in d)) return dflt;
  return d[k];
}

/** Python 的 str.strip() 空白集（比 JS \s 宽）。 */
const PY_WS = "\\t\\n\\v\\f\\r\\x1c\\x1d\\x1e\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
function pyStrip(s: string): string {
  const cls = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "gu");
  return s.replace(cls, "");
}

/** f-string 里 `{v!r}` 的 repr(str)。 */
function pyReprStr(s: string): string {
  let q = "'";
  if (s.includes("'") && !s.includes('"')) q = '"';
  const esc = s
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return q + (q === "'" ? esc.replaceAll("'", "\\'") : esc.replaceAll('"', '\\"')) + q;
}

/** tuple 的 repr：('off', 'cautious', 'active')。 */
function pyReprTuple(items: readonly string[]): string {
  return "(" + items.map((x) => pyReprStr(x)).join(", ") + ")";
}

/** Python int(raw)：int 原样、float 截断、字符串严格解析，其余 TypeError。 */
function pyIntCoerce(raw: unknown): number {
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "number") {
    if (Number.isNaN(raw) || !Number.isFinite(raw)) {
      throw new Error(`ValueError: cannot convert float NaN to integer`);
    }
    return Math.trunc(raw);
  }
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "string") {
    const m = /^[ \t\n\r\f\v]*([+-]?)(0|[1-9]\d*)[ \t\n\r\f\v]*$/.exec(raw);
    if (!m) throw new Error(`ValueError: invalid literal for int() with base 10: ${pyReprStr(raw)}`);
    return Number((m[1] ?? "") + (m[2] ?? ""));
  }
  throw new Error(`TypeError: int() argument must be a string, a bytes-like object or a number, not '${pyTypeName(raw)}'`);
}

/** Python float()（str/num，inf/nan 记号可用）。 */
function pyFloatCoerce(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "string") {
    const v = pyStrip(raw);
    if (/^[+-]?(inf|infinity)$/i.test(v)) return v.startsWith("-") ? -Infinity : Infinity;
    if (/^nan$/i.test(v)) return NaN;
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(v)) {
      throw new Error(`could not convert string to float: ${pyReprStr(raw)}`);
    }
    return Number(v);
  }
  throw new Error(`float() argument must be a string or a number, not '${pyTypeName(raw)}'`);
}

/** round(x, n) —— 对二进制 double 的真十进制展开做银行家舍入（memory_domain 同款）。 */
function pyRound(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x;
  const neg = x < 0;
  const s = Math.abs(x).toFixed(digits + 20);
  const keep = s.slice(0, s.length - 20);
  const rest = s.slice(s.length - 20).replace(/0+$/, "");
  let v = Number(keep);
  let dir: "up" | "tie" | "down";
  if (rest === "") dir = "tie";
  else if (rest.charAt(0) < "5") dir = "down";
  else if (rest.charAt(0) > "5" || rest.length > 1) dir = "up";
  else dir = "tie";
  const odd = Math.round(Math.abs(v) * Math.pow(10, digits)) % 2 === 1;
  if (dir === "up" || (dir === "tie" && odd)) v += Math.pow(10, -digits);
  return Number((neg ? -v : v).toFixed(digits));
}

/** Python str.split()（无参）：任意空白串切分，去首尾空项。 */
function pySplitWs(s: string): string[] {
  return s
    .split(/[ \t\n\r\f\v\x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/)
    .filter((x) => x.length > 0);
}

/** python `s[:n]` / `len(s)` 按码点（DIVERGENCE(port)(9)）。 */
function pcSlice(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length > n ? chars.slice(0, n).join("") : s;
}
function pcLen(s: string): number {
  return Array.from(s).length;
}

/** float 的 str()/f-string 形态：整数值补 ".0"（同 CPython repr）。 */
function pyFloatStr(v: number): string {
  if (Number.isNaN(v)) return "nan";
  if (v === Infinity) return "inf";
  if (v === -Infinity) return "-inf";
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

/** sorted()：码点序、稳定。 */
function pySorted(items: readonly string[]): string[] {
  return [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 标量 min/max（Python 双参形态）。 */
function pyMin2(a: number, b: number): number {
  return b < a ? b : a;
}
function pyMax2(a: number, b: number): number {
  return b > a ? b : a;
}

// ── sqlite 错误分类（DIVERGENCE(port)(1)）─────────────────────────────────

function sqliteErrMsg(e: unknown): string {
  if (typeof e === "string") return e;
  const err = e as { message?: string; errstr?: string };
  return String(err?.errstr ?? "") + " " + String(err?.message ?? "");
}

function isIntegrityError(e: unknown): boolean {
  return /CONSTRAINT|constraint failed/i.test(sqliteErrMsg(e));
}

function isOperationalError(e: unknown): boolean {
  return !isIntegrityError(e);
}

function isDuplicateColumn(e: unknown): boolean {
  return /duplicate column/i.test(sqliteErrMsg(e));
}

/** node:sqlite 不接受 undefined 绑定参数；源的 None 直传。 */
function bindParams(params: readonly unknown[]): unknown[] {
  return params.map((p) => (p === undefined ? null : p));
}

/**
 * 给 harness/测试的薄壳：把 openSqlite 包一层，绑定参数做 undefined→null。
 * 产品路径与 Python sqlite3.connect 一一对应。
 */
function connectSqlite(file: string): SqliteConnection {
  const inner = openSqlite(file);
  return {
    execute(sql: string, params: readonly unknown[] = []): ReturnType<SqliteConnection["execute"]> {
      return inner.execute(sql, bindParams(params));
    },
    commit(): void {
      inner.commit();
    },
    close(): void {
      inner.close();
    },
  };
}

// ── logger（py: logging.getLogger(__name__)；WARNING → stderr）──────────────

function logWarning(msg: string): void {
  console.error(msg);
}

// ── 时钟 / uuid / 日期 测试缝（DIVERGENCE(port)(2)；产品路径永不调用）───────

let _NOW_OVERRIDE: number | null = null;
export function _set_now_for_parity(v: number | null): void {
  _NOW_OVERRIDE = v;
}

/** py: time.time() —— 浮点秒。 */
export function _now(): number {
  if (_NOW_OVERRIDE !== null) return _NOW_OVERRIDE;
  return Date.now() / 1000;
}

let _UUID_SEQ: number | null = null;
export function _set_uuid_seq_for_parity(start: number | null): void {
  _UUID_SEQ = start;
}
/** harness 只读缝：镜像 py 侧 USEQ[0]（py 探针会读它钉死消耗序）。 */
export function _get_uuid_seq_for_parity(): number {
  return _UUID_SEQ ?? -1;
}

/** py: uuid.uuid4().hex —— 产品走 crypto；harness 下确定性计数器出 hex 前缀。
 *  计数器必须**左对齐**（padEnd）：py 消费方取 hex 的前 8/12 位，左补零会让
 *  小计数器全部撞车成 "000000000000"。与 py 侧 FakeUUID(ljust) 同序。 */
function uuidHex(n: number): string {
  if (_UUID_SEQ !== null) {
    const id = _UUID_SEQ;
    _UUID_SEQ = _UUID_SEQ + 1;
    return id.toString(16).padEnd(32, "0").slice(0, n);
  }
  return crypto.randomUUID().replaceAll("-", "").slice(0, n);
}

/** py: time.strftime("%Y-%m-%d") —— 本地日期，由 _now() 推导（固定时钟自然流动）。 */
function strftimeDate(): string {
  const d = new Date(_now() * 1000);
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** asyncio.get_running_loop() 探测缝（DIVERGENCE(port)(3)）：缺省 true=产品语义。 */
let _LOOP_PROBE: () => boolean = () => true;
export function _set_running_loop_probe_for_parity(fn: (() => boolean) | null): void {
  _LOOP_PROBE = fn ?? (() => true);
}

// ── FailureKind ─────────────────────────────────────────────────────────────

/** P3-2/Task 2.3: 结构化失败类型枚举。（py StrEnum → const 对象，值逐字） */
export const FailureKind = {
  TOOL_UNAVAILABLE: "tool_unavailable",
  SANDBOX_FAIL_IMMEDIATELY: "sandbox_fail_immediately",
  COMMAND_RULE_DENY: "command_rule_deny",
  MCP_RULE_DENY: "mcp_rule_deny",
  LOOP_FAULT: "loop_fault",
  USER_CORRECTION: "user_correction",
  SCHEMA_MISMATCH: "schema_mismatch",
  CONTEXT_PRESSURE: "context_pressure",
} as const;
export type FailureKind = (typeof FailureKind)[keyof typeof FailureKind];

// ── 频率档位 ────────────────────────────────────────────────────────────────

export const MODE_OFF = "off";
export const MODE_CAUTIOUS = "cautious";
export const MODE_ACTIVE = "active";

export const VALID_MODES: readonly string[] = [MODE_OFF, MODE_CAUTIOUS, MODE_ACTIVE];

/** 缺省档位。设为谨慎模式 (prudent 50% intensity)。 */
export const DEFAULT_MODE = MODE_CAUTIOUS;

export interface ModePolicy {
  min_hits: number;
  max_open: number;
  reject_cooldown_s: number;
}

/**
 * cautious 要求复发 5 次、最多 2 条未决、被拒后 30 天不再提；
 * active 放宽到 3 次 / 5 条 / 7 天。两档的差别是"多久才算够确定"，
 * 不是"要不要经用户同意"——后者两档都要。
 */
export const MODE_POLICIES: Record<string, ModePolicy> = {
  [MODE_CAUTIOUS]: { min_hits: 5, max_open: 2, reject_cooldown_s: 30 * 86400 },
  [MODE_ACTIVE]: { min_hits: 3, max_open: 5, reject_cooldown_s: 7 * 86400 },
};

/** 自动挖掘的冷却间隔。失败往往成串（重试风暴），每条都跑 GROUP BY 是浪费。 */
export const MINE_THROTTLE_S: number = 60.0;

// ── 允许被提案修改的目标 ────────────────────────────────────────────────────

/**
 * 提案只能落到这几个文件。与 path_guard.READONLY_BASENAMES 故意保持一致：
 * 两份清单合起来的意思是——这些文件只能通过"用户点了接受"这一条路被改。
 * 白名单而不是黑名单：一个能往任意文件追加内容的提案系统，就是一个绕过所有
 * 写入防护的通道。
 */
export const ALLOWED_TARGETS: ReadonlySet<string> = new Set(["AGENTS.md", "MEMORY.md", "SOUL.md"]);

/** 信号类别 → 默认落到哪个引导文件。工具用法教训进 AGENTS.md，用户偏好进 MEMORY.md。 */
export const KIND_TARGET: Record<string, string> = {
  tool_failure: "AGENTS.md",
  tool_denied: "AGENTS.md",
  interrupted: "AGENTS.md",
  user_correction: "MEMORY.md",
  // 观察层产物（Step C 落地）：任务里抽出来的事实是"用户/项目事实"，
  // 与 user_correction 同归 MEMORY.md。有了这一行，观察层的记忆提案和
  // 信号挖掘的提案共用同一条审批-写盘管线，不另开一个写入口。
  learned_fact: "MEMORY.md",
  // 同样是一条事实，但盘上已经有一行"说同一件事、结论不同"的旧规则。批准它
  // 意味着**替换**而不是追加，所以给它单独一个 kind：UI 要能把"新增"和"改写"
  // 说清楚，用户裁决的正是"留哪一条"。
  fact_conflict: "MEMORY.md",
  // 记忆层从"用户刚编辑的文件"里抽出的项目上下文。以前这条走裸 open(...,"w")
  // 直写 AGENTS.md、默认开启、无审批。现在并入同一条提案管线，写入口只剩一个。
  extracted_context: "AGENTS.md",
  // 上下文压力（超限/折叠风险）沉淀的操作守则归 AGENTS.md（工程与行为约定）。
  context_pressure: "AGENTS.md",
};

/** 写进引导文件时用的小节标题。所有演化产物集中在一节里。 */
export const EVOLUTION_HEADING = "## Learned Rules (evolution)";

/** 规则行权重标记格式：`<!-- evo:weight=0.6 -->`；没有标记 = 权重 1.0。 */
export const WEIGHT_MARK_RE = /<!--\s*evo:weight=([0-9]*\.?[0-9]+)\s*-->/;

/** 权重下限——再降也不能低于它，避免规则权重归零、彻底失去任何约束力。 */
export const MIN_RULE_WEIGHT = 0.15;

/** 退役阈值——权重降到此值以下、且仍是 ineffective 时，才生成一条"退役提案"。 */
export const RETIRE_PROPOSAL_THRESHOLD = 0.3;

/** 每回效果回访判 ineffective 时权重的衰减系数：1.0 → 0.6 → 0.36 → 0.216(触发退役)。 */
export const DEMOTE_FACTOR = 0.6;

// ── 错误签名归一化 ──────────────────────────────────────────────────────────

// Python \b / \d 的 Unicode 语义等价翻译（DIVERGENCE(port)(6)）。
const L = "[\\p{L}\\p{N}\\p{M}_]"; // 词字符
const NB = `(?<!${L})`; // \b 在字母开头 token 左侧
const NA = `(?!${L})`; // \b 右侧
const ND = "[\\p{Nd}]"; // Python \d（Unicode Nd）

/**
 * 归一化替换表。目标是让「同一个错」折叠成同一个签名：错误文本里的行号、
 * 路径、耗时、引号内容每次都不同，不抹掉它们的话同一个错会散成 20 个签名，
 * 复发计数永远到不了阈值，整个挖掘就是空转。
 *
 * 凭证那几条必须排在最前面。归一化的产物不只进签名——_compose_rule 会把它
 * 写进草稿，用户一点"接受"就永久落到 AGENTS.md，而那个文件每回合都注入模型。
 * 一条 ``token=sk-xxx failed`` 的报错，若不先抹密钥会变成一条把密钥写进提示词
 * 的永久规则。
 */
const _NORMALIZERS: ReadonlyArray<readonly [RegExp, string]> = [
  // 带标签的赋值：token= / api_key: / password= …（值到空白或引号为止）
  [
    new RegExp(
      NB +
        "(?:" +
        "api[-_]?key|secret|token|password|passwd|pwd|auth(?:orization)?" +
        "|access[-_]?key|private[-_]?key|session[-_]?id|cookie" +
        ")" +
        NA +
        "\\s*[:=]\\s*[^\\s'\\u0022,;]+",
      "giu",
    ),
    "<SECRET>",
  ],
  // Authorization: Bearer xxx
  [new RegExp(NB + "bearer\\s+[A-Za-z0-9._\\-]+", "giu"), "<SECRET>"],
  // 常见服务商的令牌前缀，即使没有标签也要抹
  [new RegExp(NB + "(?:sk|pk|rk)-[A-Za-z0-9_\\-]{8,}", "giu"), "<SECRET>"],
  [new RegExp(NB + "gh[pousr]_[A-Za-z0-9]{16,}", "giu"), "<SECRET>"],
  [new RegExp(NB + "xox[baprs]-[A-Za-z0-9\\-]{8,}", "giu"), "<SECRET>"],
  [new RegExp(NB + "AIza[A-Za-z0-9_\\-]{16,}", "giu"), "<SECRET>"],
  // Windows 与 POSIX 绝对路径
  [/[A-Za-z]:\\[^\s'"]+/gu, "<PATH>"],
  [/\/(?:[\p{L}\p{N}_.\-]+\/)+[\p{L}\p{N}_.\-]+/gu, "<PATH>"],
  // 引号里的内容（文件名、参数值）
  [/'[^']*'/g, "<Q>"],
  [/"[^"]*"/g, "<Q>"],
  // 十六进制 id / hash
  [new RegExp(NB + "[0-9a-f]{8,}" + NA, "giu"), "<HEX>"],
  // 纯数字（行号、耗时、字节数）
  [new RegExp(NB + ND + "+(?:\\." + ND + "+)?" + NA, "gu"), "<N>"],
  // 连续空白
  [/\s+/g, " "],
];

/**
 * 把一条错误文本抹成可比较的形状。
 *
 * 只做替换，不做截断到很短——保留结构（哪个动词、哪种失败）才能让不同类别的
 * 失败仍然区分得开。抹得太狠会让"文件不存在"和"权限不足"撞成同一个签名，
 * 那时提案会给出一条对两者都不对的规则。
 */
export function normalize_error(text: unknown): string {
  if (!pyTruth(text)) return "";
  let out = pyStr(text);
  for (const [pattern, repl] of _NORMALIZERS) {
    out = out.replace(pattern, repl);
  }
  return pcSlice(pyStrip(out).toLowerCase(), 400);
}

/**
 * 一条信号的稳定指纹。
 *
 * 包含 kind 和 tool_name 是刻意的：同一段错误文本出现在不同工具上，教训不一样，
 * 不该合并计数。
 */
export function signature_for(kind: string, tool_name: string, detail: string): string {
  const basis = `${kind}\x1f${tool_name || ""}\x1f${normalize_error(detail)}`;
  return crypto.createHash("sha256").update(basis, "utf8").digest("hex").slice(0, 16);
}

// ── 存储 ────────────────────────────────────────────────────────────────────

export function _db_path(): string {
  const root = dbDir();
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, "evolution.db");
}

/** signals 表的保留期。留太久会让一年前的一次失败还在给今天的计数投票。 */
export const SIGNAL_RETENTION_S: number = 30 * 86400;

/** 单个签名最多记这么多条信号。到顶后不再插入——计数已远超任何阈值。 */
export const MAX_SIGNALS_PER_SIGNATURE: number = 50;

// ── Proposal ────────────────────────────────────────────────────────────────

export interface ProposalOpts {
  id: string;
  signature: string;
  kind: string;
  tool_name: string;
  target_file: string;
  draft: string;
  rationale: string;
  hits: number;
  status: string;
  created_at: number;
  decided_at?: number;
  applied?: number;
  supersedes?: string;
  effect?: string;
  effect_reviewed_at?: number;
  effect_baseline?: number;
  user_title?: string;
  user_advice?: string;
  user_reason?: string;
  category?: string;
}

/** 一条待审提案。 */
export class Proposal {
  id: string;
  signature: string;
  kind: string;
  tool_name: string;
  target_file: string;
  draft: string;
  rationale: string;
  hits: number;
  status: string; // pending | accepted | rejected
  created_at: number;
  decided_at: number;
  applied: number;
  /** 被这条提案取代的旧行原文（含 "- " 前缀）。空 = 纯新增。 */
  supersedes: string;
  /** 效果回访三态（effective/improving/ineffective）。空 = 未到回访年龄。 */
  effect: string;
  effect_reviewed_at: number;
  /** 生效前 14 天基线窗口内的复发次数；回访结论的数字依据。 */
  effect_baseline: number;
  user_title: string;
  user_advice: string;
  user_reason: string;
  category: string;

  constructor(o: ProposalOpts) {
    this.id = o.id;
    this.signature = o.signature;
    this.kind = o.kind;
    this.tool_name = o.tool_name;
    this.target_file = o.target_file;
    this.draft = o.draft;
    this.rationale = o.rationale;
    this.hits = o.hits;
    this.status = o.status;
    this.created_at = o.created_at;
    this.decided_at = o.decided_at ?? 0.0;
    this.applied = o.applied ?? 0;
    this.supersedes = o.supersedes ?? "";
    this.effect = o.effect ?? "";
    this.effect_reviewed_at = o.effect_reviewed_at ?? 0.0;
    this.effect_baseline = o.effect_baseline ?? 0;
    this.user_title = o.user_title ?? "";
    this.user_advice = o.user_advice ?? "";
    this.user_reason = o.user_reason ?? "";
    this.category = o.category ?? "";
  }

  /** 为提案生成自然语言的用户标题、行为建议、业务原因与分类标签。 */
  _infer_human_meta(): [string, string, string, string] {
    let draftClean = (this.draft || "").replace(/^[-*]\s*(?:\[[^\]]+\]\s*)*/, "").trim();
    draftClean = draftClean.replace(/^\[fact\]\s*/i, "").trim();
    // 清除 <n> 占位符
    draftClean = draftClean.replace(/<n>/g, "").trim();

    const detail = (this.rationale || "") + " " + (this.draft || "");
    const detailL = detail.toLowerCase();
    const tool = (this.tool_name || "").toLowerCase();
    const kind = (this.kind || "").toLowerCase();

    // 1. 安全确认与高危命令拦截
    if (detailL.includes("confirmation") || detailL.includes("high risk") || detailL.includes("permission") || kind === "tool_denied") {
      const title = "敏感命令前置确认";
      const advice = "执行敏感或高风险系统命令前，先向您简要说明操作意图并等待确认";
      const reason = `近期在执行 \`${this.tool_name || "终端命令"}\` 时触发了安全策略拦截。记住该规则后将主动请示，避免命令直接受阻。`;
      const cat = "safety";
      return [title, advice, reason, cat];
    }

    // 2. 网络网页 403 Forbidden
    if (detailL.includes("forbidden") || detail.includes("403")) {
      const title = "网页访问权限受限处理";
      const advice = "抓取网页遭遇权限拒绝 (403) 时，优先提示用户登录或改用浏览器模式";
      const reason = "目标网站存在反爬防护或需要登录凭据。采纳后，Agent 将自动切换为浏览器协助，不再盲目重试。";
      const cat = "browser";
      return [title, advice, reason, cat];
    }

    // 3. 网络网页 404 Not Found
    if (detailL.includes("not found") || detail.includes("404")) {
      const title = "网络死链与资源未找到处理";
      const advice = "遇到目标页面不存在 (404) 时，自动通过搜索引擎寻找备用有效链接";
      const reason = "历史抓取的部分页面链接已失效。采纳后，遇到死链将自动执行搜索引擎检索补救。";
      const cat = "network";
      return [title, advice, reason, cat];
    }

    // 4. 项目事实与上下文抽取
    if (kind === "extracted_context" || kind === "learned_fact" || draftClean.toLowerCase().includes("saved to") || draftClean.toLowerCase().includes("directory")) {
      // 路径脱敏与相对化（防止绝对路径硬编码与日志感）
      let sanitized = draftClean.replace(/[A-Za-z]:\\[^\\s']+[\\/]([A-Za-z0-9_\-]+)[\\/]?/g, "项目 $1/ 目录");
      sanitized = sanitized.replace(/\/[^\s']+\/([A-Za-z0-9_\-]+)\/?/g, "项目 $1/ 目录");
      const lowerS = sanitized.toLowerCase();

      let title: string;
      let advice: string;
      let reason: string;
      if (lowerS.includes("screenshots are saved to")) {
        const m = /saved to (?:the\s+)?(.+?)(?:\s+directory)?\.?$/i.exec(sanitized);
        const targetDest = m && m[1] ? pyStrip(m[1]) : "项目 output/ 目录";
        title = "截图输出路径约定";
        advice = `自动化任务与操作产生的屏幕快照统一保存至 ${targetDest}`;
        reason = "确保所有任务截图与执行产物集中保存在指定目录，方便您统一查阅与归档。";
      } else if (lowerS.includes("output directory") && (lowerS.includes("created") || lowerS.includes("exist"))) {
        title = "产物输出目录自动初始化";
        advice = "当截图或产物输出目录不存在时，由系统自动创建对应文件夹";
        reason = "防止因目标文件夹缺失导致保存异常，保障自动化执行流程平稳闭环。";
      } else if (lowerS.includes("saved to")) {
        const m = /saved to (?:the\s+)?(.+?)(?:\s+directory)?\.?$/i.exec(sanitized);
        const dest = m && m[1] ? pyStrip(m[1]) : "指定目录";
        title = "文件生成与归档约定";
        advice = `相关生成文件将统一保存至 ${dest}`;
        reason = "规范生成物存储位置，避免文件散落在工作区各处。";
      } else {
        title = "项目文件与目录约定";
        advice = sanitized;
        reason = "从项目代码与配置文件中识别出的固定约定，后续任务中持续生效。";
      }
      const cat = "project_context";
      return [title, advice, reason, cat];
    }

    // 5. 用户纠正
    if (kind === "user_correction") {
      const title = "用户偏好与操作习惯";
      const advice = draftClean;
      const reason = "根据您在对话中的明确纠正所总结的操作偏好。";
      const cat = "preference";
      return [title, advice, reason, cat];
    }

    // 6. 中断
    if (kind === "interrupted") {
      const title = "耗时操作前置确认";
      const advice = `在开始 \`${this.tool_name || "批量操作"}\` 前先向您摘要计划并等待确认`;
      const reason = "近期该类操作多次在执行期间被手动中断。提前报备计划可减少无意义消耗。";
      const cat = "safety";
      return [title, advice, reason, cat];
    }

    // 7. 通用工具失败
    const title = this.tool_name ? `${this.tool_name || "工具"}调用优化` : "操作执行优化";
    const advice = draftClean;
    const reason = `近期同类操作遇到异常（${this.hits} 次）。采纳后将优化调用参数或选用备用工具。`;
    const cat = "general";
    return [title, advice, reason, cat];
  }

  to_dict(): JsonDict {
    const [title, advice, reason, cat] = this._infer_human_meta();
    return {
      id: this.id,
      signature: this.signature,
      kind: this.kind,
      toolName: this.tool_name,
      targetFile: this.target_file,
      draft: this.draft,
      rationale: this.rationale,
      hits: this.hits,
      status: this.status,
      createdAt: this.created_at,
      decidedAt: this.decided_at,
      applied: pyTruth(this.applied),
      supersedes: this.supersedes,
      effect: this.effect,
      effectReviewedAt: this.effect_reviewed_at,
      effectBaseline: this.effect_baseline,
      userTitle: pyStrOr(this.user_title, title),
      userAdvice: pyStrOr(this.user_advice, advice),
      userReason: pyStrOr(this.user_reason, reason),
      category: pyStrOr(this.category, cat),
    };
  }
}

// ── 观察层（Step C）：任务终态 → 结构化证据 → 四路学习决策 ────────────────────

export const DECISION_MEMORY_ONLY = "MEMORY_ONLY";
export const DECISION_SKILL_ONLY = "SKILL_ONLY";
export const DECISION_BOTH = "BOTH";
export const DECISION_NO_OP = "NO_OP";
export const DECISIONS: readonly string[] = [DECISION_MEMORY_ONLY, DECISION_SKILL_ONLY, DECISION_BOTH, DECISION_NO_OP];

export interface EvolutionObservationOpts {
  goal_id?: string;
  run_id?: string;
  session_id?: string;
  branch_id?: string;
  episode_id?: string;
  turn_ids?: unknown[];
  source_event_ids?: unknown[];
  used_memory?: unknown[];
  used_skills?: unknown[];
  skill_experiences?: unknown[];
  validator_result?: JsonDict;
  user_feedback?: string | null;
  new_facts?: unknown[];
  reusable_steps?: unknown[];
  validated_skills?: unknown[];
  failed_experiences?: unknown[];
  failure_class?: string | null;
  decision?: string;
  reason?: string;
  created_at?: number;
}

/**
 * 一次任务结束后的结构化证据包。
 *
 * 只装**已经发生的证据**（经验行、验证结果、用户反馈、抽取出的事实），
 * 不装模型的自我评价——"我学会了"不是证据。decision 由 classify_observation
 * 基于证据判定，判定规则是确定性表格，不是又一次模型调用。
 */
export class EvolutionObservation {
  goal_id: string;
  run_id: string;
  session_id: string;
  branch_id: string;
  episode_id: string;
  turn_ids: unknown[]; // 来源轮次 turn_id 列表
  source_event_ids: unknown[]; // 来源 EventStore event_id 真实事件列表 (P1-5)
  used_memory: unknown[]; // 引用到的记忆 id/摘要
  used_skills: unknown[]; // 实际用过的技能名
  skill_experiences: unknown[]; // experience_id 列表
  validator_result: JsonDict; // 目标验证的机器结论
  user_feedback: string | null;
  new_facts: unknown[]; // 本次新出现的事实候选
  reusable_steps: unknown[]; // 成功走通的技能流程
  validated_skills: unknown[]; // 验证通过的技能 id（落 VALIDATES 边）
  failed_experiences: unknown[]; // 失败经验的 failure_class
  failure_class: string | null;
  decision: string; // 四路之一，observe() 时填
  reason: string; // 为什么这么判，给 UI 和审计
  created_at: number;

  constructor(o: EvolutionObservationOpts = {}) {
    this.goal_id = o.goal_id ?? "";
    this.run_id = o.run_id ?? "";
    this.session_id = o.session_id ?? "";
    this.branch_id = o.branch_id ?? "";
    this.episode_id = o.episode_id ?? "";
    this.turn_ids = o.turn_ids ?? [];
    this.source_event_ids = o.source_event_ids ?? [];
    this.used_memory = o.used_memory ?? [];
    this.used_skills = o.used_skills ?? [];
    this.skill_experiences = o.skill_experiences ?? [];
    this.validator_result = o.validator_result ?? {};
    this.user_feedback = o.user_feedback ?? null;
    this.new_facts = o.new_facts ?? [];
    this.reusable_steps = o.reusable_steps ?? [];
    this.validated_skills = o.validated_skills ?? [];
    this.failed_experiences = o.failed_experiences ?? [];
    this.failure_class = o.failure_class ?? null;
    this.decision = o.decision ?? "";
    this.reason = o.reason ?? "";
    this.created_at = o.created_at ?? 0.0;
  }

  to_dict(): JsonDict {
    return {
      goalId: this.goal_id, runId: this.run_id,
      sessionId: this.session_id, branchId: this.branch_id,
      episodeId: this.episode_id,
      turnIds: this.turn_ids,
      sourceEventIds: this.source_event_ids,
      usedMemory: this.used_memory, usedSkills: this.used_skills,
      skillExperiences: this.skill_experiences,
      validatorResult: this.validator_result,
      userFeedback: this.user_feedback,
      newFacts: this.new_facts, reusableSteps: this.reusable_steps,
      validatedSkills: this.validated_skills,
      failedExperiences: this.failed_experiences,
      failureClass: this.failure_class,
      decision: this.decision, reason: this.reason,
      createdAt: this.created_at,
    };
  }
}

export interface SemanticReflectionOpts {
  reflection_id: string;
  goal_id: string;
  root_cause: string;
  alternative_strategy: string;
  preventative_rule: string;
  boundary: string;
  outcome?: string;
  confidence?: number;
  created_at?: number;
}

/** Reflexion 风格结构化语义反思。 */
export class SemanticReflection {
  reflection_id: string;
  goal_id: string;
  root_cause: string;
  alternative_strategy: string;
  preventative_rule: string;
  boundary: string;
  outcome: string; // failure | success
  confidence: number;
  created_at: number;

  constructor(o: SemanticReflectionOpts) {
    this.reflection_id = o.reflection_id;
    this.goal_id = o.goal_id;
    this.root_cause = o.root_cause;
    this.alternative_strategy = o.alternative_strategy;
    this.preventative_rule = o.preventative_rule;
    this.boundary = o.boundary;
    this.outcome = o.outcome ?? "failure";
    this.confidence = o.confidence ?? 0.85;
    this.created_at = o.created_at ?? _now();
  }

  to_dict(): JsonDict {
    return {
      reflectionId: this.reflection_id,
      goalId: this.goal_id,
      rootCause: this.root_cause,
      alternativeStrategy: this.alternative_strategy,
      preventativeRule: this.preventative_rule,
      boundary: this.boundary,
      outcome: this.outcome,
      confidence: this.confidence,
      createdAt: this.created_at,
    };
  }
}

/** 证据里出现这些形状就拒绝学习——把秘密固化进 MEMORY.md/Skill 等于永久泄露。 */
const _SECRET_HINT = new RegExp(
  NB + "(?:" +
  "api[-_]?key|secret|token|password|passwd|credential|private[-_]?key" +
  ")" + NA +
  "|" + NB + "(?:sk|pk|rk)-[A-Za-z0-9_\\-]{8,}" +
  "|" + NB + "bearer\\s+[A-Za-z0-9._\\-]+",
  "iu",
);

/**
 * 四路决策。确定性规则表，只看证据，不看模型自述。
 *
 * | 决策 | 判据 |
 * |---|---|
 * | BOTH | 新事实与可复用技能流程同时出现 |
 * | MEMORY_ONLY | 只有新事实（偏好/环境/约束），没有可复用流程 |
 * | SKILL_ONLY | 技能流程成功走通，但没有沉淀出新事实 |
 * | NO_OP | 秘密嫌疑、偶发失败、复发失败（归信号管线）、纯口头反馈、证据不足 |
 */
export function classify_observation(obs: EvolutionObservation): [string, string] {
  const blob = [
    ...((obs.new_facts || []) as unknown[]).map((x) => pyStr(x)),
    ...((obs.failed_experiences || []) as unknown[]).map((x) => pyStr(x)),
    pyStr(pyOr(obs.failure_class, "")),
    pyStr(pyOr(obs.user_feedback, "")),
  ].join(" | ");
  if (_SECRET_HINT.test(blob)) {
    return [DECISION_NO_OP, "证据疑似包含秘密/凭证：禁止固化为任何学习产物"];
  }

  const hasFacts = pyTruth(obs.new_facts);
  const hasSkill = pyTruth(obs.reusable_steps);
  if (hasFacts && hasSkill) {
    return [DECISION_BOTH,
      `新事实 ${(obs.new_facts || []).length} 条且技能流程成功 ${(obs.reusable_steps || []).length} 个：两层需同步更新`];
  }
  if (hasFacts) {
    return [DECISION_MEMORY_ONLY, `新增 ${(obs.new_facts || []).length} 条事实，无可复用流程`];
  }
  if (hasSkill) {
    return [DECISION_SKILL_ONLY, `${(obs.reusable_steps || []).length} 个技能流程成功可复用，无新事实`];
  }

  const failures = ((obs.failed_experiences || []) as unknown[]).filter((f) => pyTruth(f));
  if (failures.length > 0) {
    const uniq = Array.from(new Set(failures));
    const repeated = uniq.some((c) => failures.filter((f) => f === c).length >= 2);
    if (repeated) {
      return [DECISION_NO_OP,
        "同类失败已复发：由信号挖掘管线按 min_hits 立案，观察层不重复立项"];
    }
    return [DECISION_NO_OP, "偶发失败：一次失败不配固化成任何长期改变"];
  }
  if (pyTruth(obs.user_feedback)) {
    return [DECISION_NO_OP, "仅口头反馈、无可落地证据：低复用价值"];
  }
  return [DECISION_NO_OP, "证据不足：没有成功经验也没有新事实"];
}

/** dict.get(k) 的忠实镜像：对 list 调用如实抛 AttributeError。 */
function pyDictGet(v: unknown, k: string): unknown {
  if (Array.isArray(v)) {
    throw new Error("AttributeError: 'list' object has no attribute 'get'");
  }
  if (v === null || v === undefined) {
    throw new Error(`AttributeError: 'NoneType' object has no attribute 'get'`);
  }
  if (typeof v === "object") return (v as JsonDict)[k] ?? null;
  throw new Error(`AttributeError: '${pyTypeName(v)}' object has no attribute 'get'`);
}

/** `a.get(k)`——源里 dict 场景（None→null 由调用点的 or-gate 处理）。 */
function getK(d: JsonDict | null | undefined, k: string): unknown {
  if (!d) return null;
  return k in d ? d[k] : null;
}

/** 从真实数据源拼一个观察：经验台账 + 目标验证结论 + 会话流里的记忆事件。
 *
 * 这是"消费刚落地的经验数据"的那根管子——observation 不是凭空构造的测试
 * 腔，每一项都来自落盘的事实。取不到目标行返回 None（观察无从谈起）。
 */
export function build_goal_observation(
  goal_id: string,
  storage: any,
  opts: { run_id?: string; new_facts?: unknown[] } = {},
): EvolutionObservation | null {
  const run_id = opts.run_id ?? "";
  const newFactsArg = opts.new_facts ?? null;
  let row: JsonDict;
  try {
    row = (pyOr(storage.get_goal(goal_id), {}) as JsonDict);
  } catch {
    row = {};
  }
  if (!pyTruth(row)) return null;

  let exps: JsonDict[];
  try {
    // include_task_level=True on purpose: a task that no skill covered is
    // the single strongest signal that a skill is MISSING. Filtering those
    // rows out here is how the loop used to go blind to its own gaps.
    exps = storage.list_skill_experiences({
      goal_id, limit: 50, include_task_level: true,
    }) as JsonDict[];
  } catch {
    exps = [];
  }

  const ok_exps = exps.filter((e) => getK(e, "outcome") === "success");
  const failed = exps.filter((e) => getK(e, "outcome") === "failure");

  let verdict: JsonDict;
  try {
    const parsed = JSON.parse(pyStr(pyOr(getK(row, "verification_result"), "")));
    verdict = (pyTruth(parsed) ? parsed : {}) as JsonDict;
  } catch {
    // (json.JSONDecodeError, TypeError) -> {}
    verdict = {};
  }

  const facts: unknown[] = [...(newFactsArg || [])] as unknown[];
  const sid = pyStr(pyOr(getK(row, "session_id"), ""));
  const goal_event_ids: string[] = [];
  try {
    for (const ev of storage.get_event_store().read_stream(sid) as any[]) {
      const payload = pyOr((ev as any).payload, null) as JsonDict | null;
      const evGid = pyStr(pyOr(pyOr((ev as any).goal_id ?? (ev as any).goalId,
        payload ? getK(payload, "goal_id") : ""), ""));
      const evIdStr = pyStr(pyOr(pyOr((ev as any).id ?? "", (ev as any).event_id ?? (ev as any).eventId ?? ""), ""));
      if (evGid === goal_id && evIdStr) {
        goal_event_ids.push(evIdStr);
      }
      const evType = (ev as any).event_type ?? (ev as any).eventType;
      if (evType === EventType.MEMORY_EXTRACTED) {
        const p = (pyOr((ev as any).payload, {}) as JsonDict) || {};
        const batch = (pyOr(getK(p, "facts"), []) as unknown[]) || [];
        if (pyTruth(batch)) {
          // memory_layer 现在按批发射：facts 是字符串列表
          for (const f of batch) {
            if (pyStrip(pyStr(f))) facts.push(pcSlice(pyStr(f), 200));
          }
        } else {
          const fact = pyStrip(pyStr(pyOr(pyOr(pyOr(getK(p, "text"), getK(p, "fact")), getK(p, "content")), "")));
          if (fact) facts.push(pcSlice(fact, 200));
        }
      }
    }
  } catch {
    // 记忆事件缺失降级为空清单——分类会如实给出 NO_OP 而不是编造
  }

  let feedback: unknown = null;
  for (const e of [...exps].reverse()) {
    const v = getK(e, "user_feedback");
    if (pyTruth(v)) { feedback = v; break; }
  }
  const taskLevel = storage.TASK_LEVEL_SKILL_ID;
  return new EvolutionObservation({
    goal_id, run_id, session_id: sid,
    source_event_ids: goal_event_ids,
    used_skills: pySorted(Array.from(new Set(
      exps.map((e) => getK(e, "skill_id")).filter((s) => pyTruth(s) && s !== taskLevel) as string[]))),

    skill_experiences: exps.map((e) => getK(e, "experience_id")),
    validator_result: {
      status: getK(row, "status"),
      reason: pyDictGet(verdict, "reason"),
      machineVerified: pyTruth(verdict),
    },
    user_feedback: (feedback as string) ?? null,
    new_facts: facts,
    reusable_steps: ok_exps.map((e) => {
      const sid2 = getK(e, "skill_id");
      const steps = pyIntCoerce(pyOr(getK(e, "steps_succeeded"), 0));
      return sid2 !== taskLevel
        ? `${pyStr(sid2)}（成功 ${steps} 步）`
        : `（本次任务无技能覆盖，自主完成 ${steps} 步）`;
    }),
    validated_skills: pySorted(Array.from(new Set(
      ok_exps.map((e) => getK(e, "skill_id")).filter((s) => pyTruth(s) && s !== taskLevel) as string[]))),

    failed_experiences: failed.map((e) => pyStrOr(getK(e, "failure_class"), "unspecified")),
    failure_class: failed.length ? (getK(failed[0], "failure_class") as string | null) : null,
    created_at: _now(),
  });
}

/** 把观察里的验证证据落到关系图：goal VALIDATES skill（Step D 挂点）。
 *
 * 幂等由 add_relation 的 UNIQUE 保证——同一目标反复验证同一技能只留一条
 * 边。失败的经验不建边：没通过验证不算 VALIDATES，这是纪律不是疏忽。
 */
export function record_goal_validation_edges(obs: EvolutionObservation, storage: any): number {
  let n = 0;
  if (!pyTruth(obs.goal_id)) return 0;
  for (const skill_id of (obs.validated_skills || []) as unknown[]) {
    storage.add_relation(
      "goal", obs.goal_id, "VALIDATES", "skill", skill_id,
      `validator status=${pyStr(pyDictGet(obs.validator_result, "status"))}`,
    );
    n += 1;
  }
  return n;
}

// ── 观察层出口（Step C 收口）：决策 → 真实待审产物 ───────────────────────────
//
// 在这段代码之前，observe() 是一个终点水槽：它把 BOTH / MEMORY_ONLY /
// SKILL_ONLY 判得很认真，然后**什么也不产生**。整条自进化链因此在这里断成
// 两半——前半段（轨迹、经验、分类）真实存在，后半段（候选、门禁、审批）也
// 真实存在，中间没有管子。用户看到的就是"AI 说它学到了，但下次还是从零开始"。
//
// 这里补的就是那根管子。三条纪律：
// 1. 只产**待审**物：MemoryProposal → pending，SkillCandidate → candidate。
//    没有任何一条路径能从这里直接写 MEMORY.md 或上线技能。
// 2. 复用既有闸门，不新开写入口：记忆走 EvolutionStore 的提案表（同一套
//    签名去重、冷却、max_open 上限），技能走 skill_lifecycle.create_candidate
//    （同一套 experience_ref 必须是成功经验的硬约束）。
// 3. 宁少不滥。一次观察最多产 MAX_FACT_PROPOSALS 条记忆提案；技能候选只在
//    "本次任务确实没有任何技能覆盖"时产一个——已有技能跑通不需要再造一个。

/** 一次观察最多产出多少条记忆提案。宁可漏，不可刷。 */
export const MAX_FACT_PROPOSALS = 3;

/** 自动生成的技能候选名前缀，带前缀让用户一眼分辨"这是机器起草的"。 */
export const AUTO_SKILL_PREFIX = "auto-";

/**
 * 把一句自然语言压成可当目录名的 slug。
 *
 * 非 ASCII 直接丢会让中文目标退化成空串，所以中日韩字符保留——技能目录名
 * 允许 Unicode，SkillLoader 按目录名读取，不做 ASCII 假设。
 */
export function _slugify(text: unknown, opts: { limit?: number } = {}): string {
  const limit = opts.limit ?? 40;
  const cleaned = pyStr(pyOr(text, "")).trim().toLowerCase()
    .replace(/[^\p{L}\p{N}_\u4e00-\u9fff]+/gu, "-");
  const trimmed = cleaned.replace(/^-+|-+$/g, "");
  return pcSlice(trimmed, limit) || "task";
}

/**
 * 判定"疑似冲突"的字符二元组相似度下限。0.55 是有意偏保守的一档：
 * 宁可把一条真冲突当成新增（用户还能自己在 MEMORY.md 里删旧行），也不要把
 * 两条无关事实说成冲突——那会让裁决界面开始说谎，而用户是照着它删记忆的。
 */
export const CONFLICT_MIN_SIMILARITY: number = 0.55;

/**
 * 字符二元组集合。
 *
 * 刻意不做分词：中文没有空格，英文按词切，两套逻辑就有两种阈值行为。字符
 * 二元组对两种语言都给出稳定的相似度，且不引入任何依赖。
 * （[\s\W_]+ 的 Unicode 翻译：两侧都只留字母数字，memory_domain D5 同款。）
 */
export function _bigrams(text: unknown): Set<string> {
  const s = pyStr(pyOr(text, "")).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const out = new Set<string>();
  if (Array.from(s).length > 1) {
    const chars = Array.from(s);
    for (let i = 0; i < chars.length - 1; i++) out.add((chars[i] ?? "") + (chars[i + 1] ?? ""));
    return out;
  }
  out.add(s);
  return out;
}

/** Jaccard 相似度，0..1。 */
export function _similarity(a: string, b: string): number {
  const x = _bigrams(a);
  const y = _bigrams(b);
  if (x.size === 0 || y.size === 0) return 0.0;
  let inter = 0;
  for (const item of x) if (y.has(item)) inter++;
  const union = x.size + y.size - inter;
  return union === 0 ? 0.0 : inter / union;
}

export interface RuleDict {
  id: string;
  hits: number;
  last: string;
  content: string;
  raw: unknown;
}

/** 解析一条规则行，提取 [id] [hits:n] [last:date] 与主体内容。兼容无元数据的旧规则。 */
export function parse_rule_line(line: unknown): RuleDict {
  let s = pyStrip(pyStr(pyOr(line, "")));
  if (s.startsWith("-")) s = pyStrip(s.slice(1));
  let ruleId = "";
  let hits = 1;
  let lastDate = "";

  while (s.startsWith("[")) {
    const closeIdx = s.indexOf("]");
    if (closeIdx === -1) break;
    const tag = pyStrip(s.slice(1, closeIdx));
    s = pyStrip(s.slice(closeIdx + 1));
    if (tag.startsWith("hits:")) {
      try {
        // py: int(tag.split(":", 1)[1]) —— 只按第一个冒号切
        hits = pyIntCoerce(tag.slice(tag.indexOf(":") + 1));
      } catch {
        // ValueError -> pass
      }
    } else if (tag.startsWith("last:")) {
      lastDate = pyStrip(tag.slice(tag.indexOf(":") + 1));
    } else {
      ruleId = tag;
    }
  }

  const content = pyStrip(s);
  return {
    id: ruleId,
    hits: pyMax2(1, hits),
    last: lastDate,
    content,
    raw: line,
  };
}

// ── 规则行工具 + 观察层出口：事实提案 / 技能候选孵化 ─────────────────────────

/** python str.splitlines()（含 \v \f \x1c-\x1f \x85 \u2028 \u2029；行尾换行不产生空尾项）。 */
function pySplitlines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x1f\x85\u2028\u2029]/);
  // 末尾换行不产生尾空项（py: "a\n".splitlines() == ["a"]）
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** 把内容与元数据组装为结构化规则 bullet: - [rule_id] [hits:n] [last:YYYY-MM-DD] 内容。 */
export function format_rule_line(
  content: unknown,
  opts: { rule_id?: string; hits?: number; last_date?: string } = {},
): string {
  const rule_id0 = opts.rule_id ?? "";
  const hits0 = opts.hits ?? 1;
  const last_date0 = opts.last_date ?? "";
  let clean_content = pyStrip(pyStr(pyOr(content, "")).replace(/^-+/, ""));
  // py: content.lstrip("-").strip()
  const parsed = parse_rule_line(clean_content);
  if (pyTruth(parsed.content)) {
    clean_content = parsed.content;
    let rule_id = rule_id0;
    let hits = hits0;
    let last_date = last_date0;
    if (!rule_id) rule_id = parsed.id;
    if (hits <= 1 && parsed.hits > 1) hits = parsed.hits;
    if (!last_date && parsed.last) last_date = parsed.last;
    const rid = rule_id || `rule-${uuidHex(8)}`;
    const h = pyMax2(1, hits);
    const d = last_date || strftimeDate();
    return `- [${rid}] [hits:${h}] [last:${d}] ${clean_content}`;
  }
  const rid2 = rule_id0 || `rule-${uuidHex(8)}`;
  const h2 = pyMax2(1, hits0);
  const d2 = last_date0 || strftimeDate();
  return `- [${rid2}] [hits:${h2}] [last:${d2}] ${clean_content}`;
}

/** 在现有规则列表中查找同主题规则行索引。未找到返回 -1。 */
export function find_matching_rule_index(
  content: unknown,
  section_lines: readonly unknown[],
  opts: { rule_id?: string; threshold?: number } = {},
): number {
  const rule_id = opts.rule_id ?? "";
  const threshold = opts.threshold ?? 0.65;
  if (!pyTruth(content) && !pyTruth(rule_id)) return -1;
  for (let i = 0; i < section_lines.length; i++) {
    const parsed = parse_rule_line(section_lines[i]);
    if (pyTruth(rule_id) && pyTruth(parsed.id) && parsed.id === rule_id) return i;
    if (pyTruth(content) && pyTruth(parsed.content)) {
      const sim = _similarity(pyStr(content), parsed.content);
      if (sim >= threshold) return i;
    }
  }
  return -1;
}

/** 按命中率与新鲜度排序并去重规则，控制规则库规模（Bounded Growth）。 */
export function consolidate_rules(section_text: string, max_rules = 50): string {
  const lines = pySplitlines(section_text).map((ln) => pyStrip(ln)).filter((ln) => pyTruth(ln));
  const parsed_rules: RuleDict[] = [];
  for (const ln of lines) {
    if (ln.startsWith("-")) parsed_rules.push(parse_rule_line(ln));
  }

  const deduped: RuleDict[] = [];
  for (const r of parsed_rules) {
    let matched = false;
    for (const existing of deduped) {
      if (_similarity(r.content, existing.content) >= 0.70) {
        existing.hits += r.hits;
        if (pyTruth(r.last) && (!pyTruth(existing.last) || pyStr(r.last) > pyStr(existing.last))) {
          existing.last = r.last;
        }
        matched = true;
        break;
      }
    }
    if (!matched) deduped.push(r);
  }

  // py: sort(key=lambda x: (x["hits"], x["last"]), reverse=True) —— 稳定降序，
  // 键相等的保持原序；TS sort 稳定，比较器键相等返回 0 即等价。
  deduped.sort((a, b) => {
    if (a.hits !== b.hits) return b.hits - a.hits;
    return a.last > b.last ? -1 : a.last < b.last ? 1 : 0;
  });
  const capped = deduped.slice(0, max_rules);

  const out_lines = capped.map((r) =>
    format_rule_line(r.content, { rule_id: r.id, hits: r.hits, last_date: r.last }));
  return out_lines.join("\n");
}

/** 在已落盘的规则行里找"说的是同一件事但结论不同"的那一行。
 *
 * 返回命中的原行（含 "- " 前缀），没有就返回空串。完全相同的行不算冲突——
 * 那是"已经知道了"，由调用方另行跳过。
 */
export function find_conflicting_line(text: unknown, existing: unknown): string {
  const target = pyStrip(pyStr(pyOr(text, "")));
  if (!pyTruth(target)) return "";
  let best = "";
  let best_score = 0.0;
  const list = (existing || []) as unknown[];
  for (const line of list) {
    const raw = pyStrip(pyStr(pyOr(line, "")));
    const body = pyStrip(raw.replace(/^-+/, "")); // py: raw.lstrip("-").strip()
    if (!pyTruth(body) || body === target) continue;
    const score = _similarity(target, body);
    if (score >= CONFLICT_MIN_SIMILARITY && score > best_score) {
      best = raw;
      best_score = score;
    }
  }
  return best;
}

/** 目标文件里已落盘的 Learned Rules 行。读不到就当空。 */
/** py: `open(path, "r", encoding="utf-8").read()` —— universal newlines 读。
 *
 * DIVERGENCE(port): readFileSync 不做换行翻译，而 py 文本模式会把 \r\n 与孤立
 * \r 折成 \n。产品写盘（atomic_write 复刻 CPython os.linesep）在 Windows 上落
 * CRLF，读回若不折算，第二轮 union/替换就会在字节上漂移。折算是 CPython 语义
 * 的一部分，不是新行为。 */
function _readTextPy(p: string): string {
  return fs.readFileSync(p, "utf-8").replace(/\r\n?/g, "\n");
}

export function _existing_rules(engine: { workspace_root: string }, target_file: string): string[] {
  try {
    const p = path.join(engine.workspace_root, target_file);
    const st = fs.existsSync(p) ? fs.statSync(p) : null;
    if (!st || !st.isFile()) return [];
    const text = _readTextPy(p);
    const [, lines] = _split_evolution_section(text);
    return lines;
  } catch {
    // py: except OSError。Node readFileSync 对非法 utf-8 不抛（U+FFFD 替换），
    // py 的 UnicodeDecodeError 分支不可达且本就不在 except 内——等价。
    return [];
  }
}

/** 把被裁决掉的旧事实从记忆库里归档。返回归档条数。
 *
 * 只在"写盘成功 + 确实替换了某一行"之后调用。失败绝不上抛：记忆库退役是这次
 * 裁决的后续动作，它出问题不该让已经落盘的批准看起来像失败。
 *
 * 归档而不是删除——用户可能改主意，而 archived 行仍能被审计到。
 */
export function _retire_superseded_memory(p: Proposal, workspace_root = ""): number {
  const body = pyStrip((p.supersedes || "").replace(/^-+/, "")); // lstrip("-").strip()
  if (!pyTruth(body)) return 0;
  try {
    const st: any = get_storage();
    const ids = st.find_memories_by_content(workspace_root || process.cwd(), body) as string[];
    for (const mid of ids) st.archive_memory(mid);
    if (pyTruth(ids)) {
      console.log(`[evolution] retired ${ids.length} superseded memory row(s)`);
    }
    return ids.length;
  } catch (exc) {
    console.log(`[evolution] retire superseded memory failed: ${pyStrExc(exc)}`);
    return 0;
  }
}

/** 把观察里的新事实做成待审记忆提案，返回新建的 proposal id。
 *
 * 去重、冷却、总量上限全部复用信号管线那套判据——一条事实的提案和一条
 * 复发失败的提案在用户眼里是同一种东西（"要不要把这句话写进引导文件"），
 * 没有理由用两套规则。
 */
export function _propose_facts(
  obs: EvolutionObservation,
  engine: any,
  opts: { storage?: any; bundle_id?: string } = {},
): string[] {
  const storage = opts.storage ?? null;
  const bundle_id = opts.bundle_id ?? "";
  const made: string[] = [];
  const policy = pyGetDefault(MODE_POLICIES, engine.mode, null) as ModePolicy | null;
  if (policy === null) return made; // off 档没有策略条目；查表会 KeyError，不伪造阈值

  // 已落盘的规则行读一次就够：同一次观察里最多三条事实，逐条重读文件没意义。
  const existing = _existing_rules(engine, KIND_TARGET["learned_fact"] as string);

  for (const fact of pcTake((obs.new_facts || []) as unknown[], MAX_FACT_PROPOSALS)) {
    const text = pyStrip(pyStr(pyOr(fact, "")));
    if (pcLen(text) < 8) continue; // 太短的"事实"没有信息量，只会污染每轮注入的上下文
    if (_SECRET_HINT.test(text)) continue; // 二道防线：classify 已拦过整包，这里按条再拦一次

    // 盘上已经有一模一样的一行 → 已经知道了
    if (existing.some((l) => pyStrip(pyStr(pyOr(l, "")).replace(/^-+/, "")) === text)) continue;
    const sig = signature_for("learned_fact", "", text);
    if (engine.store.has_open_for_signature(sig)) continue;
    const last_rej = engine.store.last_rejected_at(sig);
    if (pyTruth(last_rej) && (_now() - (last_rej as number)) < policy.reject_cooldown_s) continue;

    const clash = find_conflicting_line(text, existing);
    const is_over_quota = engine.store.count_open() >= policy.max_open;

    let p: Proposal | null = null;
    if (!is_over_quota) {
      p = new Proposal({
        id: uuidHex(12),
        signature: sig,
        kind: clash ? "fact_conflict" : "learned_fact",
        tool_name: "",
        target_file: KIND_TARGET["learned_fact"] as string,
        draft: `- ${text}`,
        rationale:
          (clash ? `疑似与已有记忆冲突，批准即替换：${clash}｜` : "") +
          `任务 ${obs.goal_id || "-"} 结束时抽出的事实` +
          `（决策 ${obs.decision}：${obs.reason}）`,
        hits: 1,
        status: "pending",
        created_at: _now(),
        supersedes: clash,
      });
      engine.store.insert_proposal(p);
      made.push(p.id);
    }

    // 写入一等 LearningItem 账本（§11.2 & §13.5 & Phase 24）
    try {
      const st = storage || get_storage();
      const pid = p ? p.id : uuidHex(12);
      const item_id = `li_${pid}`;
      const item_status = !is_over_quota ? "proposed" : "deferred";
      const item_notif = !is_over_quota ? "actionable" : "silent";
      const defer_reason = !is_over_quota ? "" : "待审配额已满，进入暂缓队列";
      const branch_id = pyStrOr((obs as any).branch_id ?? "", "");
      const turn_list = [...((obs.turn_ids || []) as unknown[])];
      const src_turn = turn_list.length ? turn_list[turn_list.length - 1] : "";
      const ev_list = (((obs.source_event_ids || []) as unknown[])
        .map((e) => pyStr(e)) as string[]).filter((e) => pyTruth(pyStrip(e)));

      st.insert_learning_item({
        learning_item_id: item_id,
        bundle_id: bundle_id || "",
        session_id: obs.session_id || "",
        branch_id,
        episode_id: pyStrOr((obs as any).episode_id ?? "", ""),
        kind: !clash ? "memory_fact" : "preference",
        scope: "workspace",
        content: text,
        why: p ? p.rationale : `提取事实（暂缓待审）：${pcSlice(text, 60)}`,
        status: item_status,
        notification_policy: item_notif,
        target_ref: p ? p.id : "",
        deferred_reason: defer_reason,
        source_goal_id: obs.goal_id || "",
        source_run_id: obs.run_id || "",
        source_session_id: obs.session_id || "",
        source_event_ids: ev_list,
        source_turn_id: src_turn,
        confidence: 0.9,
        evidence_summary: `从任务 ${obs.goal_id || "-"} 终态提取`,
        future_effect: "将在后续对话与任务中作为项目事实召回",
        idempotency_key: `prop:${obs.session_id}:${branch_id}:${sig}`,
      });

      // 发射事件
      try {
        const ev_type = !is_over_quota ? EventType.LEARNING_ITEM_PROPOSED : EventType.LEARNING_ITEM_DEFERRED;
        st.get_event_store().append(
          obs.session_id || "default",
          ev_type,
          {
            learning_item_id: item_id,
            proposal_id: p ? p.id : "",
            kind: "memory_fact",
            scope: "workspace",
            content: text,
            why: p ? p.rationale : "待审配额已满，进入暂缓队列",
            future_effect: "将在后续对话与任务中作为项目事实召回",
          },
          { branch_id: branch_id || null, goal_id: obs.goal_id || null, run_id: obs.run_id || null },
        );
      } catch {
        // py: except Exception: pass
      }
    } catch (_li_e) {
      console.log(`[evolution] learning item insert failed: ${pyStrExc(_li_e)}`);
    }
  }
  return made;
}

/** 任务成功但无技能覆盖 → 起草一个技能候选。返回候选 id 或 None。
 *
 * 这是全系统第一个**自动**候选生产者。在它之前 create_candidate 只有
 * HTTP handler 一个调用者，也就是"只有人手动 POST 才会有候选"——所谓
 * 自进化的入口从来没接上。
 *
 * 刻意的保守之处：
 * * 只在 TASK_LEVEL 那条成功经验存在时产出。已有技能跑通了，不需要再造
 *   一个同义技能；那是重复，不是学习。
 * * 名字带 ``auto-`` 前缀并检查重名。撞名候选一定过不了 collision 门禁，
 *   与其产一个注定失败的候选去污染队列，不如不产。
 * * 状态停在 ``candidate``。门禁与审批仍在下游，这里一步都不越过。
 */
export function _propose_skill_candidate(
  obs: EvolutionObservation,
  storage: any,
  opts: { bundle_id?: string } = {},
): string | null {
  const bundle_id = opts.bundle_id ?? "";
  const goal_id = pyStr(pyOr(obs.goal_id, ""));
  if (!pyTruth(goal_id)) return null;
  let rows: JsonDict[];
  try {
    rows = storage.list_skill_experiences({
      goal_id, skill_id: storage.TASK_LEVEL_SKILL_ID, limit: 10,
    }) as JsonDict[];
  } catch {
    return null;
  }
  let exp: JsonDict | null = null;
  for (const r of rows) {
    if (getK(r, "outcome") === "success") { exp = r; break; }
  }
  if (!exp) return null; // 没有"无技能覆盖且成功"的证据 → 无从孵化

  let goal: JsonDict = {};
  try {
    goal = (pyOr(storage.get_goal(goal_id), {}) as JsonDict);
  } catch {
    goal = {};
  }
  const desc = pyStrip(pyStr(pyOr(getK(goal, "description"), "")));
  if (pcLen(desc) < 8) return null; // 目标描述太短，起草出来的技能没人看得懂它干什么

  const name = AUTO_SKILL_PREFIX + _slugify(desc);
  try {
    const cands = storage.list_skill_candidates(null, 200) as JsonDict[];
    if (cands.some((c) => getK(c, "name") === name)) return null; // 同名候选已在队列里等着，不重复立项
  } catch {
    // py: except Exception: pass —— 查重失败不拦，继续孵化
  }
  const cand_id = _incubate(storage, exp, goal_id, desc, name);
  if (cand_id) {
    // 写入一等 LearningItem 账本
    try {
      const item_id = `li_cand_${cand_id}`;
      const branch_id = pyStrOr((obs as any).branch_id ?? "", "");
      const turn_list = [...((obs.turn_ids || []) as unknown[])];
      const src_turn = turn_list.length ? turn_list[turn_list.length - 1] : "";
      const ev_list = (((obs.source_event_ids || []) as unknown[])
        .map((e) => pyStr(e)) as string[]).filter((e) => pyTruth(pyStrip(e)));
      storage.insert_learning_item({
        learning_item_id: item_id,
        bundle_id: bundle_id || "",
        session_id: obs.session_id || "",
        branch_id,
        episode_id: pyStrOr((obs as any).episode_id ?? "", ""),
        kind: "skill_step",
        scope: "workspace",
        content: `技能候选：${name}`,
        why: `目标「${pcSlice(desc, 60)}」自主执行成功，沉淀为流程候选`,
        status: "staged",
        notification_policy: "actionable",
        target_ref: cand_id,
        source_goal_id: goal_id,
        source_run_id: obs.run_id || "",
        source_session_id: obs.session_id || "",
        source_event_ids: ev_list,
        source_turn_id: src_turn,
        confidence: 0.85,
        evidence_summary: `基于 goal=${goal_id} 成功运行孵化`,
        future_effect: "经审批并验证后可在类似任务中作为 Skill 调用",
        idempotency_key: `skill:${obs.session_id}:${branch_id}:${cand_id}`,
      });

      try {
        storage.get_event_store().append(
          obs.session_id || "default",
          EventType.LEARNING_ITEM_PROPOSED,
          {
            learning_item_id: item_id,
            candidate_id: cand_id,
            kind: "skill_step",
            scope: "workspace",
            content: `技能候选：${name}`,
            why: `目标「${pcSlice(desc, 60)}」自主执行成功`,
            future_effect: "经审批并验证后可在类似任务中作为 Skill 调用",
          },
          { branch_id: branch_id || null, goal_id: goal_id || null, run_id: obs.run_id || null },
        );
      } catch {
        // py: except Exception: pass
      }
    } catch (_li_e) {
      console.log(`[evolution] skill candidate learning item insert failed: ${pyStrExc(_li_e)}`);
    }
  }
  return cand_id;
}

/** 真正落一条候选。步骤来自 goal_iterations——真实跑过的轮次，不是编的。 */
export function _incubate(
  storage: any,
  exp: JsonDict,
  goal_id: string,
  desc: string,
  name: string,
): string | null {
  let steps: string[] = [];
  try {
    for (const it of storage.list_goal_iterations(goal_id, 20) as JsonDict[]) {
      const summary = pyStrip(
        pyStr(pyOr(getK(it, "verdict_reason"), pyOr(getK(it, "evidence_digest"), ""))));
      if (pyTruth(summary)) {
        steps.push(`第 ${pyStr(getK(it, "ordinal"))} 轮：${pcSlice(normalize_error(summary), 160)}`);
      }
    }
  } catch {
    steps = [];
  }
  if (!pyTruth(steps)) {
    // 没有轮次记录时给一条如实的占位步骤，而不是留空让结构门禁去挡。
    // 写"待补全"是诚实的：这条候选确实需要人补步骤才配上线。
    steps = [`待补全：本次任务成功完成，但没有留下分轮记录（goal=${goal_id}）`];
  }

  const fields: JsonDict = {
    name,
    description: pcSlice(desc, 200),
    when_to_use: `遇到与「${pcSlice(desc, 80)}」同类的任务时`,
    // verification 是必填门禁字段。这里如实写"人工确认"而不是塞一条
    // 假命令——假命令会让 verification_run 门禁跑出一个无意义的绿灯。
    verification: "人工确认产出与目标描述一致（自动起草，未附机器验证命令）",
    steps,
    risk_level: "medium",
    known_failures: `来源：goal ${goal_id} 的一次成功执行，样本量 1——尚未在第二个场景验证过`,
    experience_ref: pyOr(getK(exp, "experience_id"), ""),
  };
  let res: any;
  try {
    res = create_candidate(storage, fields);
  } catch (exc) {
    console.log(`[evolution] candidate incubation failed: ${pyStrExc(exc)}`);
    return null;
  }
  if (!res.ok) {
    console.log(`[evolution] candidate rejected at creation: ${pyStr(res.error)}`);
    return null;
  }
  const cand = (pyOr(res.value, {}) as JsonDict) || {};
  return pyTruth(pyStr(pyOr(getK(cand, "id"), ""))) ? pyStr(pyOr(getK(cand, "id"), "")) : null;
}

// py: (obs.new_facts or [])[:MAX_FACT_PROPOSALS] —— 码点无关，数组截断
function pcTake<T>(arr: T[], n: number): T[] {
  return arr.length > n ? arr.slice(0, n) : arr;
}

// ── 显式自我反思生成器 (Reflexion Generator) + materialize 出口 ──────────────

/** 显式自我反思生成器与记忆检索层（Reflexion 启发）。 */
export class ReflectionGenerator {
  /** 从终态观察中提炼语义反思（根因、替代策略、预防规则与适用边界）。 */
  static generate_reflection(obs: EvolutionObservation | null): SemanticReflection | null {
    if (!pyTruth(obs)) return null;

    const has_failures = pyTruth(obs!.failed_experiences) || pyTruth(obs!.failure_class);
    const has_success = pyTruth(obs!.reusable_steps)
      || pyTruth(obs!.validator_result && getK(obs!.validator_result, "passed"));

    if (!has_failures && !has_success) return null;

    // 秘密/凭证防线拦截
    const blob = `${pyStr(pyOr(obs!.failure_class, ""))} ${pyStr(pyOr(obs!.user_feedback, ""))} ${(
      (obs!.failed_experiences || []) as unknown[]).map((x) => pyStr(x)).join(" ")}`;
    if (_SECRET_HINT.test(blob)) return null;

    const rid = `ref_${uuidHex(8)}`;
    const goal_id = pyStr(pyOr(obs!.goal_id, ""));

    if (has_failures) {
      const fc = pyStr(pyOr(obs!.failure_class,
        (obs!.failed_experiences && (obs!.failed_experiences as unknown[]).length)
          ? (obs!.failed_experiences as unknown[])[0] : "unknown_failure"));

      let rc: string, alt: string, rule: string, boundary: string;
      if (fc.toLowerCase().includes("permission") || fc.toLowerCase().includes("auth")) {
        rc = "权限与只读策略拦截 (Permission Denied / Readonly Path)";
        alt = "预先检查目标路径的写权限与只读清单，切换为临时目录或请求用户审批";
        rule = "严禁对受保护目录或未知凭证路径进行盲目重试写入";
        boundary = "涉及系统核心配置或引导文件时强制走提案审批";
      } else if (fc.toLowerCase().includes("timeout") || fc.toLowerCase().includes("latency")) {
        rc = "子任务处理超时与算力耗尽 (Timeout / Exhaustion)";
        alt = "将长流水线拆分为具备中间 Checkpoint 的短原子步骤，并增加增量分页处理";
        rule = "单次命令与大文件读取必须设置有界超时时间与进度心跳";
        boundary = "适用于大型工程构建、全量索引扫描与网络重试";
      } else if (fc.toLowerCase().includes("schema") || fc.toLowerCase().includes("invalid_tool")) {
        rc = "工具入参格式错误或合约 Schema 不匹配 (Schema Validation Mismatch)";
        alt = "在工具调用前严格核对必填字段与类型定义，对复杂参数进行预校验";
        rule = "工具参数必须按照 JSON Schema 格式精确输出，禁止输出非法多余键";
        boundary = "适用于所有 Backend Tool 与 MCP 工具调用";
      } else if (fc.toLowerCase().includes("not_found") || fc.toLowerCase().includes("enoent")) {
        rc = "目标文件或环境依赖不存在 (Resource Not Found)";
        alt = "在操作目标资源前，先调用 find_by_name / list_dir 校验其存在性";
        rule = "假定路径存在即操作是危险的，必须先做存在性探针检查";
        boundary = "适用于工作区文件与虚拟环境依赖定位";
      } else {
        rc = `任务执行遇到异常 (${fc})`;
        alt = "保留现场日志，分析异常调用栈并优先尝试最小可重现代码";
        rule = "遇到未归类异常时限制重试次数为 1，避免雪崩式重试风暴";
        boundary = "通用任务执行与未预期错误处理";
      }

      return new SemanticReflection({
        reflection_id: rid,
        goal_id,
        root_cause: rc,
        alternative_strategy: alt,
        preventative_rule: rule,
        boundary,
        outcome: "failure",
        confidence: 0.85,
      });
    } else {
      // 成功经验的正面沉淀
      const steps2 = pcTake(((obs!.reusable_steps || []) as unknown[]), 2).map((s) => pyStr(s));
      return new SemanticReflection({
        reflection_id: rid,
        goal_id,
        root_cause: "流程正常执行无异常",
        alternative_strategy: "保持当前工作流的高效参数与分步验证方式",
        preventative_rule: `在相似目标中复用此验证链: ${steps2.join(", ")}`,
        boundary: `适用于 goal=${goal_id} 同类任务`,
        outcome: "success",
        confidence: 0.90,
      });
    }
  }

  /** 将反思安全存入 SEMANTIC 向量层或 DREAMING 池（杜绝写入短期快速衰减层）。 */
  static store_reflection_as_memory(
    reflection: SemanticReflection | null,
    storage: any,
    opts: { root_dir?: string } = {},
  ): string | null {
    const root_dir = opts.root_dir ?? "";
    if (!pyTruth(reflection) || !pyTruth(storage)) return null;
    let tier_val: string;
    try {
      tier_val = MemoryTier.SEMANTIC;
    } catch {
      tier_val = "semantic";
    }

    const content =
      `【经验反思 | ${reflection!.outcome.toUpperCase()}】\n` +
      `- 根因分析: ${reflection!.root_cause}\n` +
      `- 替代策略: ${reflection!.alternative_strategy}\n` +
      `- 预防规则: ${reflection!.preventative_rule}\n` +
      `- 适用边界: ${reflection!.boundary}`;

    try {
      storage.save_memory_entry(
        reflection!.reflection_id,
        "evolution_reflection",
        root_dir || ".",
        "project",
        content,
        {
          mem_type: "reflection",
          importance: 0.75,
          tags: ["reflection", reflection!.outcome, pcSlice(reflection!.root_cause, 20)],
          tier: tier_val,
          confidence: reflection!.confidence,
          source_goal_id: reflection!.goal_id,
          status: "active",
        },
      );
      return reflection!.reflection_id;
    } catch (exc) {
      logWarning(`[evolution] save reflection memory failed: ${pyStrExc(exc)}`);
      return null;
    }
  }

  /** 按相关性召回适用的历史反思经验。 */
  static retrieve_reflections(
    storage: any,
    opts: { query?: string; root_dir?: string; limit?: number } = {},
  ): JsonDict[] {
    const query = opts.query ?? "";
    const root_dir = opts.root_dir ?? "";
    const limit = opts.limit ?? 3;
    if (!pyTruth(storage)) return [];
    try {
      const entries = storage.get_memory_entries(
        root_dir || null, "reflection", false, limit * 2,
      ) as JsonDict[];
      if (!pyTruth(query)) return entries.slice(0, limit);

      const q_lower = query.toLowerCase();
      const terms = pySplitWs(q_lower);
      const scored: [number, JsonDict, number][] = [];
      entries.forEach((e, idx) => {
        const text = pyStr(pyOr(getK(e, "content"), "")).toLowerCase();
        let matches = 0;
        for (const term of terms) if (text.includes(term)) matches += 1;
        scored.push([matches, e, idx]);
      });
      // py: sort(key=matches, reverse=True) 稳定——键等原序；带 idx tiebreak 镜像
      scored.sort((a, b) => (b[0] !== a[0] ? b[0] - a[0] : a[2] - b[2]));
      return scored.slice(0, limit).map((item) => item[1]);
    } catch (exc) {
      logWarning(`[evolution] retrieve reflections failed: ${pyStrExc(exc)}`);
      return [];
    }
  }
}

/** 观察决策 → 待审产物。这是 observe() 之后唯一的产出口。
 *
 * Returns:
 *   ``{"memoryProposals": [id…], "skillCandidate": id|"", "learningItems": [id…], "reason": str}``。
 *   什么都没产时 ``reason`` 说明为什么——"没产出"和"产出失败"必须分得开，
 *   否则这条链下次再断，日志里依旧看不出断在哪。
 */
export function materialize_observation(
  obs: EvolutionObservation | null,
  storage: any,
  engine: any,
  opts: { bundle_id?: string } = {},
): JsonDict {
  const bundle_id = opts.bundle_id ?? "";
  const bid = pyTruth(bundle_id) ? bundle_id : `bundle_${uuidHex(12)}`;
  const out: JsonDict = {
    memoryProposals: [] as string[], skillCandidate: "",
    learningItems: [] as string[], reason: "", bundle_id: bid,
  };
  if (obs === null || obs === undefined || obs.decision === DECISION_NO_OP) {
    // py: f"决策 {getattr(obs, 'decision', '-')}：按判据不产出" —— obs 为 None 时取 '-'
    const dec = obs === null || obs === undefined ? "-" : obs.decision;
    out["reason"] = `决策 ${dec}：按判据不产出`;
    return out;
  }
  if (!engine.enabled()) {
    out["reason"] = "evolution off：不产出任何待审物";
    return out;
  }

  if (obs.decision === DECISION_MEMORY_ONLY || obs.decision === DECISION_BOTH) {
    try {
      out["memoryProposals"] = _propose_facts(obs, engine, { storage, bundle_id: bid });
      out["learningItems"] = (out["learningItems"] as string[])
        .concat((out["memoryProposals"] as string[]).map((pid) => `li_${pid}`));
    } catch (exc) {
      console.log(`[evolution] fact proposals failed: ${pyStrExc(exc)}`);
    }
  }
  if (obs.decision === DECISION_SKILL_ONLY || obs.decision === DECISION_BOTH) {
    try {
      const cand_id = pyStrOr(_propose_skill_candidate(obs, storage, { bundle_id: bid }), "");
      out["skillCandidate"] = cand_id;
      if (pyTruth(cand_id)) {
        (out["learningItems"] as string[]).push(`li_cand_${cand_id}`);
      }
    } catch (exc) {
      console.log(`[evolution] skill candidate failed: ${pyStrExc(exc)}`);
    }
  }

  // 处理失败防护 (Failure Guard)
  if (pyTruth(obs.failure_class)) {
    try {
      const fg_id = `li_guard_${uuidHex(8)}`;
      const turn_list = [...((obs.turn_ids || []) as unknown[])];
      const src_turn = turn_list.length ? turn_list[turn_list.length - 1] : "";
      const ev_list = (((obs.source_event_ids || []) as unknown[])
        .map((e) => pyStr(e)) as string[]).filter((e) => pyTruth(pyStrip(e)));
      storage.insert_learning_item({
        learning_item_id: fg_id,
        bundle_id: bid,
        session_id: obs.session_id || "",
        kind: "failure_guard",
        scope: "workspace",
        content: `失败防护：${obs.failure_class}`,
        why: `任务遇到失败（${obs.failure_class}），记录负向经验防线`,
        status: "discovered",
        notification_policy: "receipt",
        source_goal_id: obs.goal_id || "",
        source_run_id: obs.run_id || "",
        source_session_id: obs.session_id || "",
        source_event_ids: ev_list,
        source_turn_id: src_turn,
        confidence: 0.8,
        evidence_summary: `来自 goal=${obs.goal_id} 失败记录`,
        future_effect: "在相似场景中作为前置检查规则避免重复踩坑",
      });
      (out["learningItems"] as string[]).push(fg_id);
    } catch (_fg_e) {
      console.log(`[evolution] failure guard insert failed: ${pyStrExc(_fg_e)}`);
    }
  }

  // 显式语义反思 (Reflexion Generator)
  try {
    const reflection = ReflectionGenerator.generate_reflection(obs);
    if (reflection) {
      let root_dir = "";
      try {
        // py: hasattr(storage, "_root_dir") 恒 False（storage 只有 db_dir/root 概念的
        // 其它名字）——忠实读属性，不加兜底映射；quirk 由 parity 钉住。
        if (pyTruth(storage) && "_root_dir" in storage) {
          root_dir = (storage as any)._root_dir;
        }
      } catch {
        // pass
      }
      const ref_eid = ReflectionGenerator.store_reflection_as_memory(reflection, storage, { root_dir });
      if (ref_eid) {
        (out["learningItems"] as string[]).push(`li_ref_${ref_eid}`);
        out["reflection"] = reflection.to_dict();
      }
    }
  } catch (_ref_e) {
    console.log(`[evolution] reflection generation/store failed: ${pyStrExc(_ref_e)}`);
  }

  // Populate rich item details with individual versions for Chat & Panel (P1-2)
  const item_details: JsonDict[] = [];
  for (const lid of (pyOr(out["learningItems"], []) as string[]) || []) {
    try {
      const it = storage.get_learning_item(lid) as JsonDict | null;
      if (it) {
        item_details.push({
          id: lid,
          version: pyGetDefault(it, "version", 1),
          kind: pyGetDefault(it, "kind", ""),
          content: pyGetDefault(it, "content", ""),
          status: pyGetDefault(it, "status", "discovered"),
          why: pyGetDefault(it, "why", ""),
          scope: pyGetDefault(it, "scope", "workspace"),
        });
      }
    } catch {
      // pass
    }
  }
  out["learningItemDetails"] = item_details;

  if (!pyTruth(out["memoryProposals"]) && !pyTruth(out["skillCandidate"]) && !pyTruth(out["learningItems"])) {
    out["reason"] = "判据成立但去重/冷却/上限/证据不足，本次无新增待审物";
  } else {
    out["reason"] = `新增 ${(out["memoryProposals"] as string[]).length} 条记忆提案`
      + (pyTruth(out["skillCandidate"]) ? "、1 个技能候选" : "");
  }
  return out;
}

// ── 持久层：EvolutionStore（信号 + 提案 + 观察 + 学习证据束）──────────────────

/** 信号 + 提案的持久层。自带独立 SQLite，不挤 storage.py 的表集合。
 *
 * 独立 DB 是刻意的：这是一个默认关闭的可选子系统，它的表不该出现在主库的
 * schema 里。用户从没开过这个功能，主库就该干干净净——而且整个功能想撤掉时，
 * 删一个文件就够了。
 */
export class EvolutionStore {
  _conn: SqliteConnection;

  constructor(db_path: string | null = null) {
    this._conn = connectSqlite(pyStr(db_path || _db_path()));
    this._conn.execute(`
            CREATE TABLE IF NOT EXISTS signals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,
                kind TEXT NOT NULL,
                signature TEXT NOT NULL,
                tool_name TEXT,
                detail TEXT,
                created_at REAL NOT NULL
            )
        `);
    this._conn.execute("CREATE INDEX IF NOT EXISTS idx_sig ON signals(signature, created_at)");
    try {
      this._conn.execute("ALTER TABLE signals ADD COLUMN failure_kind TEXT DEFAULT ''");
    } catch (exc) {
      if (!isOperationalError(exc)) throw exc; // py: except sqlite3.OperationalError
      if (!isDuplicateColumn(pyStrExc(exc))) throw exc;
    }
    this._conn.execute(`
            CREATE TABLE IF NOT EXISTS proposals (
                id TEXT PRIMARY KEY,
                signature TEXT NOT NULL,
                kind TEXT,
                tool_name TEXT,
                target_file TEXT NOT NULL,
                draft TEXT NOT NULL,
                rationale TEXT,
                hits INTEGER DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at REAL NOT NULL,
                decided_at REAL DEFAULT 0,
                applied INTEGER DEFAULT 0
            )
        `);
    this._conn.execute("CREATE INDEX IF NOT EXISTS idx_prop_sig ON proposals(signature, status)");
    // 被这条提案取代的那一行原文。空串 = 纯新增。
    // 冲突裁决需要它：接受一条"更新版事实"时必须**替换**旧行而不是追加，
    // 否则 MEMORY.md 里会同时留着"项目用 npm"和"项目用 pnpm"，而每轮都注入
    // 模型的正是这两行——自相矛盾的上下文比没有上下文更坏。
    try {
      this._conn.execute("ALTER TABLE proposals ADD COLUMN supersedes TEXT DEFAULT ''");
    } catch (exc) {
      if (!isOperationalError(exc)) throw exc;
      if (!isDuplicateColumn(pyStrExc(exc))) throw exc;
    }
    // 效果回访三列：verdict（effective/improving/ineffective）、回访时间、
    // 生效前基线（同签名在 decided_at 前一窗口的复发次数）。effect='' 表示
    // 尚未回访。
    for (const _ddl of [
      "ALTER TABLE proposals ADD COLUMN effect TEXT DEFAULT ''",
      "ALTER TABLE proposals ADD COLUMN effect_reviewed_at REAL DEFAULT 0",
      "ALTER TABLE proposals ADD COLUMN effect_baseline INTEGER DEFAULT -1",
    ]) {
      try {
        this._conn.execute(_ddl);
      } catch (exc) {
        if (!isOperationalError(exc)) throw exc;
        if (!isDuplicateColumn(pyStrExc(exc))) throw exc;
      }
    }
    this._conn.execute(`
            CREATE TABLE IF NOT EXISTS observations (
                id TEXT PRIMARY KEY,
                decision TEXT NOT NULL,
                goal_id TEXT DEFAULT '',
                session_id TEXT DEFAULT '',
                reason TEXT DEFAULT '',
                payload TEXT NOT NULL,
                created_at REAL NOT NULL
            )
        `);
    this._conn.execute("CREATE INDEX IF NOT EXISTS idx_obs_time ON observations(created_at)");
    // ── LearningBundle（统一学习证据束）───────────────────────────────────
    //
    // Memory proposal 和 Skill candidate 是同一条经验的两个投影——这句话
    // 之前只是口号：提案在 proposals 表、候选在 skill_candidates 表、经验
    // 在 skill_experiences 表，三者之间没有一行数据能证明"它们来自同一次
    // 任务"。每个终态目标在这里固定落一条 bundle：四路决策（含 NO_OP 的
    // "为什么没学"）、全部产物 id、共享的经验/轮次证据。审批联动由
    // decide() 回写 user_verdict，闭环到"人最终怎么看这条学习"。
    this._conn.execute(`
            CREATE TABLE IF NOT EXISTS learning_bundles (
                learning_id TEXT PRIMARY KEY,
                goal_id TEXT DEFAULT '',
                run_id TEXT DEFAULT '',
                session_id TEXT DEFAULT '',
                decision TEXT NOT NULL DEFAULT '',
                rationale TEXT DEFAULT '',
                turn_ids TEXT DEFAULT '[]',
                experience_ids TEXT DEFAULT '[]',
                memory_proposal_ids TEXT DEFAULT '[]',
                skill_candidate_id TEXT DEFAULT '',
                validator_result TEXT DEFAULT '{}',
                user_verdict TEXT DEFAULT 'pending',
                created_at REAL NOT NULL
            )
        `);
    this._conn.execute(
      "CREATE INDEX IF NOT EXISTS idx_bundle_goal" +
      " ON learning_bundles(goal_id, created_at)");
    // 幂等（§11.3）。同一个目标的同一次运行到达同一个终态，只能有一条
    // bundle——这件事必须由数据库保证，Python 里的"我记得刚才落过了"在
    // 进程重启、双窗口、事件重播面前一文不值。而这不是假想的风险：
    // completed 会先走 _emit_change 再走一次直接 emit，同一次完成本来
    // 就会把订阅者调用两遍。
    //
    // 加列而不是重建表：evolution.db 里已有的行没有 key，用**部分**唯一
    // 索引（WHERE bundle_key != ''）把它们排除在约束之外，老库照样能开。
    for (const _col of ["bundle_key", "outcome", "terminal_event_id", "learning_item_ids", "skill_candidate_ids"]) {
      try {
        this._conn.execute(`ALTER TABLE learning_bundles ADD COLUMN ${_col} TEXT DEFAULT ''`);
      } catch (exc) {
        if (!isOperationalError(exc)) throw exc;
        // py: pass  # 列已存在（此处不区分 duplicate/其它 OperationalError，忠实照抄）
      }
    }
    this._conn.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_bundle_key" +
      " ON learning_bundles(bundle_key) WHERE bundle_key != ''");
    this._conn.commit();
  }

  // ── 观察（Step C）────────────────────────────────────────────────────

  /** 观察只增不改——它是对已发生事实的归档，改写历史等于伪造证据。 */
  insert_observation(o: EvolutionObservation): string {
    const obs_id = uuidHex(12);
    const d = o.to_dict();
    this._conn.execute(
      "INSERT INTO observations (id, decision, goal_id, session_id, reason," +
      " payload, created_at) VALUES (?,?,?,?,?,?,?)",
      [obs_id, pyOr(d["decision"], "UNCLASSIFIED"), pyOr(o.goal_id, ""),
        pyOr(o.session_id, ""), d["reason"], pyJsonDumps(d),
        pyFloatCoerce(pyOr(o.created_at, 0) || _now())],
    );
    this._conn.commit();
    return obs_id;
  }

  /** py: list_observations(limit=50)。DIVERGENCE(5)：memory_domain.ts 的既成
   *  契约以 opts 形态传 {limit}，此处双形态收口（positional / opts 等价）。 */
  list_observations(limitOrOpts: number | { limit?: number } = 50): JsonDict[] {
    const raw = (typeof limitOrOpts === "object" && limitOrOpts !== null)
      ? (limitOrOpts.limit ?? 50) : limitOrOpts;
    const limit = pyIntCoerce(raw);
    const rows = this._conn.execute(
      "SELECT id, decision, goal_id, session_id, reason, payload, created_at" +
      " FROM observations WHERE session_id NOT LIKE 'bench-%' AND session_id NOT LIKE 'tool-test-%' ORDER BY created_at DESC LIMIT ?",
      [limit],
    ).fetchall();
    const out: JsonDict[] = [];
    for (const r of rows) {
      let payload: JsonDict;
      try {
        payload = JSON.parse(pyStr(r["payload"]));
      } catch {
        // (json.JSONDecodeError, TypeError) -> {}
        payload = {};
      }
      out.push({
        id: r["id"], decision: r["decision"],
        goalId: r["goal_id"], sessionId: r["session_id"],
        reason: r["reason"], createdAt: r["created_at"],
        ...payload,
      });
    }
    return out;
  }

  // ── LearningBundle ──────────────────────────────────────────────────

  /** JSON 列与 dict 键的对应，读写共用一份，避免两处漂移。 */
  static readonly _BUNDLE_JSON_FIELDS: Record<string, string> = {
    turn_ids: "turnIds",
    experience_ids: "experienceIds",
    memory_proposal_ids: "memoryProposalIds",
  };

  /** 已经落过的那条 bundle，没有就是 None。重复 materialize 靠它返回原件。 */
  find_bundle_by_key(bundle_key: unknown): JsonDict | null {
    if (!pyTruth(bundle_key)) return null;
    let r: Row | null;
    try {
      r = this._conn.execute(
        "SELECT * FROM learning_bundles WHERE bundle_key=?",
        [pyStr(bundle_key)],
      ).fetchone();
    } catch (exc) {
      if (isOperationalError(exc)) return null; // 老库还没有 bundle_key 列
      throw exc;
    }
    return r ? this._bundle_row_to_dict(r) : null;
  }

  /** 落一条学习证据束，给了 ``bundle_key`` 就是幂等的。
   *
   * 幂等在这里有三层，而且**都不靠内存**：
   *
   * 1. ``learning_id`` 由 key 派生（sha256 前 16 位），所以同一次终态永远
   *    叫同一个名字——UI 里的链接、关系图里的边、日志里的 id 不会因为重放
   *    而分叉。
   * 2. 写之前先查：查到就原样返回旧 id，不覆盖、不追加。旧的那条才是真正
   *    发生过的记录，第二次调用没有任何新证据可言。
   * 3. 真撞上并发（两个进程同时处理同一个终态），唯一索引会抛
   *    IntegrityError，这里接住再查一次——数据库赢，代码认。
   *
   * 不给 key 就退回旧行为（随机 id、每次一条），因为没有 key 就没有"同一
   * 件事"的定义，硬编一个反而会把两次真实的不同学习合成一条。
   */
  insert_bundle(opts: {
    goal_id?: string; run_id?: string; session_id?: string;
    decision?: string; rationale?: string; turn_ids?: unknown;
    experience_ids?: unknown; memory_proposal_ids?: unknown;
    skill_candidate_id?: string; skill_candidate_ids?: unknown;
    learning_item_ids?: unknown; validator_result?: unknown;
    bundle_key?: string; outcome?: string; terminal_event_id?: string;
    bundle_id?: string;
  } = {}): string {
    const {
      goal_id = "", run_id = "", session_id = "", decision = "",
      rationale = "", turn_ids = null, experience_ids = null,
      memory_proposal_ids = null, skill_candidate_id = "",
      skill_candidate_ids = null, learning_item_ids = null,
      validator_result = null, bundle_key = "", outcome = "",
      terminal_event_id = "", bundle_id = "",
    } = opts;

    const key = pyStr(pyOr(bundle_key, ""));
    let learning_id: string;
    if (pyTruth(key)) {
      const prev = this.find_bundle_by_key(key);
      if (prev) return pyStr(pyOr(prev["learningId"], ""));
      learning_id = crypto.createHash("sha256").update(Buffer.from(key, "utf-8")).digest("hex").slice(0, 16);
    } else {
      learning_id = pyStrOr(bundle_id, "") || uuidHex(12);
    }
    const cols = "learning_id, goal_id, run_id, session_id, decision, rationale," +
      " turn_ids, experience_ids, memory_proposal_ids," +
      " skill_candidate_id, validator_result, user_verdict, created_at";
    const vals: unknown[] = [
      learning_id, pyStr(pyOr(goal_id, "")), pyStr(pyOr(run_id, "")),
      pyStr(pyOr(session_id, "")), pyStr(pyOr(decision, "")),
      pyStr(pyOr(rationale, "")),
      pyJsonDumps(pcToArray(turn_ids)),
      pyJsonDumps(pcToArray(experience_ids)),
      pyJsonDumps(pcToArray(memory_proposal_ids)),
      pyStr(pyOr(skill_candidate_id, "")),
      pyJsonDumps(pyOr(validator_result, {}) as JsonDict),
      "pending", _now(),
    ];
    const skill_ids_json = pyJsonDumps(
      pyTruth(skill_candidate_ids)
        ? pcToArray(skill_candidate_ids)
        : (pyTruth(skill_candidate_id) ? [skill_candidate_id] : []));
    try {
      this._conn.execute(
        `INSERT INTO learning_bundles (${cols}, bundle_key, outcome,` +
        ` terminal_event_id, learning_item_ids, skill_candidate_ids)` +
        ` VALUES (${Array(vals.length + 5).fill("?").join(",")})`,
        [
          ...vals,
          key,
          pyStr(pyOr(outcome, "")),
          pyStr(pyOr(terminal_event_id, "")),
          pyJsonDumps(pcToArray(learning_item_ids)),
          skill_ids_json,
        ],
      );
    } catch (exc) {
      if (isIntegrityError(exc)) {
        // 并发或重放：唯一索引拦住了第二条。旧件为准。
        // py: self._conn.rollback() —— node:sqlite 逐语句自动提交，语句被
        // 拒绝即未生效，rollback 在此语义下是 no-op（RULEBOOK §2，同 commit）。
        const prev = this.find_bundle_by_key(key);
        return pyStr(pyOr(prev ? prev["learningId"] : null, "") || learning_id);
      } else if (isOperationalError(exc)) {
        // 老库没有新列：照旧写一条，幂等降级为"至少不崩"。
        this._conn.execute(
          `INSERT INTO learning_bundles (${cols})` +
          ` VALUES (${Array(vals.length).fill("?").join(",")})`, vals);
      } else {
        throw exc;
      }
    }
    this._conn.commit();
    return learning_id;
  }

  _bundle_row_to_dict(r: Row): JsonDict {
    const d: JsonDict = {
      learningId: r["learning_id"],
      goalId: r["goal_id"],
      runId: r["run_id"],
      sessionId: r["session_id"],
      decision: r["decision"],
      rationale: r["rationale"],
      skillCandidateId: r["skill_candidate_id"],
      userVerdict: r["user_verdict"],
      createdAt: r["created_at"],
    };
    // 老库（加列之前写下的行）读不到这两列，缺就当空——读路径不该因为
    // 一次没跑成的 ALTER 就整表报错。
    const have = new Set(Object.keys(r));
    d["bundleKey"] = have.has("bundle_key") ? r["bundle_key"] : "";
    d["outcome"] = have.has("outcome") ? r["outcome"] : "";
    d["terminalEventId"] = have.has("terminal_event_id") ? r["terminal_event_id"] : "";
    try {
      d["learningItemIds"] = have.has("learning_item_ids") && pyTruth(r["learning_item_ids"])
        ? JSON.parse(pyStr(r["learning_item_ids"])) : [];
    } catch {
      d["learningItemIds"] = [];
    }
    try {
      d["skillCandidateIds"] = have.has("skill_candidate_ids") && pyTruth(r["skill_candidate_ids"])
        ? JSON.parse(pyStr(r["skill_candidate_ids"])) : [];
    } catch {
      d["skillCandidateIds"] = [];
    }

    for (const [col, key] of Object.entries(EvolutionStore._BUNDLE_JSON_FIELDS)) {
      try {
        d[key] = JSON.parse(pyOr(r[col], "") ? pyStr(r[col]) : "[]");
      } catch {
        // (json.JSONDecodeError, TypeError, KeyError, IndexError) -> []
        d[key] = [];
      }
    }
    try {
      d["validatorResult"] = JSON.parse(pyOr(r["validator_result"], "") ? pyStr(r["validator_result"]) : "{}");
    } catch {
      d["validatorResult"] = {};
    }
    return d;
  }

  list_bundles(limit: number = 50): JsonDict[] {
    const rows = this._conn.execute(
      "SELECT * FROM learning_bundles ORDER BY created_at DESC LIMIT ?",
      [pyIntCoerce(limit)],
    ).fetchall();
    return rows.map((r) => this._bundle_row_to_dict(r));
  }

  bundles_for_goal(goal_id: string, limit: number = 20): JsonDict[] {
    const rows = this._conn.execute(
      "SELECT * FROM learning_bundles WHERE goal_id=?" +
      " ORDER BY created_at DESC LIMIT ?",
      [pyStr(pyOr(goal_id, "")), pyIntCoerce(limit)],
    ).fetchall();
    return rows.map((r) => this._bundle_row_to_dict(r));
  }

  /** 提案被裁决后回写所属 bundle 的 user_verdict。
   *
   * 一条 bundle 可能挂多条提案：第一条的裁决先到，记它；后续裁决覆盖为
   * 最新的人意。找不到所属 bundle 返回 False——提案可能早于 bundle 存在，
   * 这不是错误。
   */
  mark_bundle_verdict_for_proposal(proposal_id: string, verdict: string): boolean {
    if (!pyTruth(proposal_id)) return false;
    const rows = this._conn.execute(
      "SELECT learning_id, memory_proposal_ids FROM learning_bundles" +
      " ORDER BY created_at DESC LIMIT 200",
    ).fetchall();
    for (const r of rows) {
      let ids: unknown[];
      try {
        ids = JSON.parse(pyOr(r["memory_proposal_ids"], "") ? pyStr(r["memory_proposal_ids"]) : "[]");
      } catch {
        // (json.JSONDecodeError, TypeError) -> continue
        continue;
      }
      if ((ids as unknown[]).some((x) => x === proposal_id)) {
        const cur = this._conn.execute(
          "UPDATE learning_bundles SET user_verdict=? WHERE learning_id=?",
          [pyStr(verdict), r["learning_id"]],
        );
        this._conn.commit();
        return cur.rowcount > 0;
      }
    }
    return false;
  }

  // ── 信号 ────────────────────────────────────────────────────────────

  /** 记录一条信号，返回它的签名。
   *
   * 为什么先算签名再看限流：短路要在做 IO 之前发生。同一签名一天里能收到
   * 上千次同错，如果每一次都写盘 + 删旧，磁盘 IO 会大到影响正常回合。
   */
  record_signal(kind: string, tool_name: string, detail: string,
    session_id: string = "", failure_kind: string = ""): string {
    const sig = signature_for(kind, tool_name, detail);
    const now = _now();

    // 限流：同签名已经超上限就不再插入。计数已经够高了，多一条对挖掘没用，
    // 却会拖慢 index。
    const count = Number(this._conn.execute(
      "SELECT COUNT(*) as c FROM signals WHERE signature=?", [sig],
    ).fetchone()!["c"]);
    if (count >= MAX_SIGNALS_PER_SIGNATURE) return sig;

    try {
      this._conn.execute(
        "INSERT INTO signals (session_id, kind, signature, tool_name, detail, created_at, failure_kind) " +
        "VALUES (?,?,?,?,?,?,?)",
        [session_id, kind, sig, pyOr(tool_name, ""), pcSlice(pyOr(detail, "") as string, 2000), now, pyOr(failure_kind, "")],
      );
    } catch (exc) {
      if (!isOperationalError(exc)) throw exc;
      this._conn.execute(
        "INSERT INTO signals (session_id, kind, signature, tool_name, detail, created_at) " +
        "VALUES (?,?,?,?,?,?)",
        [session_id, kind, sig, pyOr(tool_name, ""), pcSlice(pyOr(detail, "") as string, 2000), now],
      );
    }
    // 顺便过期一下老信号；不是每次都跑全表清理——概率触发 + 用索引，
    // 均摊到 O(1)。
    if (count === 0) {
      this._conn.execute(
        "DELETE FROM signals WHERE created_at < ?", [now - SIGNAL_RETENTION_S],
      );
    }
    this._conn.commit();
    return sig;
  }

  /** 给一个签名的复发情况：命中次数、首次和最近一次时间。 */
  signal_stats(signature: string): JsonDict {
    const r = this._conn.execute(
      "SELECT COUNT(*) as c, MIN(created_at) as first, MAX(created_at) as last, " +
      "       MAX(tool_name) as tool, MAX(kind) as kind, MAX(detail) as detail " +
      "FROM signals WHERE signature=?", [signature],
    ).fetchone();
    if (!r || !pyTruth(r["c"])) {
      return { hits: 0, first: 0.0, last: 0.0, tool_name: "", kind: "", detail: "" };
    }
    return {
      hits: pyIntCoerce(r["c"]),
      first: pyFloatCoerce(pyOr(r["first"], 0)),
      last: pyFloatCoerce(pyOr(r["last"], 0)),
      tool_name: pyOr(r["tool"], ""),
      kind: pyOr(r["kind"], ""),
      detail: pyOr(r["detail"], ""),
    };
  }

  /** 当前复发达标的签名列表，按热度倒序。
   *
   * 强信号（user_correction, workflow, preference）1 次即达标。
   */
  hot_signatures(min_hits: number, limit: number = 20): JsonDict[] {
    const rows = this._conn.execute(
      "SELECT signature, COUNT(*) as hits, MAX(tool_name) as tool, " +
      "       MAX(kind) as kind, MAX(detail) as detail, MAX(created_at) as last " +
      "FROM signals GROUP BY signature " +
      "HAVING hits >= ? OR (MAX(kind) IN ('user_correction', 'workflow', 'preference') AND hits >= 1) " +
      "ORDER BY hits DESC LIMIT ?",
      [pyIntCoerce(min_hits), pyIntCoerce(limit)],
    ).fetchall();
    return rows.map((r) => ({ ...r }));
  }

  /** 按时间倒序获取最近的信号列表。 */
  recent_signals(limit: number = 20): JsonDict[] {
    const rows = this._conn.execute(
      "SELECT * FROM signals ORDER BY created_at DESC LIMIT ?",
      [pyIntCoerce(limit)],
    ).fetchall();
    return rows.map((r) => ({ ...r }));
  }

  // ── 提案 ────────────────────────────────────────────────────────────

  open_proposals(): Proposal[] {
    const rows = this._conn.execute(
      "SELECT * FROM proposals WHERE status='pending' ORDER BY hits DESC, created_at ASC"
    ).fetchall();
    return rows.map((r) => this._row_to_proposal(r));
  }

  all_proposals(limit: number = 50): Proposal[] {
    const rows = this._conn.execute(
      "SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?", [pyIntCoerce(limit)],
    ).fetchall();
    return rows.map((r) => this._row_to_proposal(r));
  }

  get_proposal(proposal_id: string): Proposal | null {
    const r = this._conn.execute(
      "SELECT * FROM proposals WHERE id=?", [proposal_id],
    ).fetchone();
    return r ? this._row_to_proposal(r) : null;
  }

  has_open_for_signature(signature: string): boolean {
    const r = this._conn.execute(
      "SELECT 1 FROM proposals WHERE signature=? AND status='pending' LIMIT 1",
      [signature],
    ).fetchone();
    return pyTruth(r);
  }

  last_rejected_at(signature: string): number {
    const r = this._conn.execute(
      "SELECT MAX(decided_at) as t FROM proposals " +
      "WHERE signature=? AND status='rejected'", [signature],
    ).fetchone();
    return r && pyTruth(r["t"]) ? pyFloatCoerce(r["t"]) : 0.0;
  }

  count_open(): number {
    const r = this._conn.execute(
      "SELECT COUNT(*) as c FROM proposals WHERE status='pending'"
    ).fetchone();
    return r ? pyIntCoerce(r["c"]) : 0;
  }

  /** 全量按状态计数——不受 all_proposals 的 LIMIT 影响。
   *
   * 审计页的"已接受/已拒绝"计数必须是终身总数，可 all_proposals 只取最近
   * 50 条，用它去过滤统计会随记录增多而越报越低。这里直接在库里 GROUP BY，
   * 让计数与"最近 N 条"列表脱钩。
   */
  count_by_status(): Record<string, number> {
    const rows = this._conn.execute(
      "SELECT status, COUNT(*) as c FROM proposals GROUP BY status"
    ).fetchall();
    const out: Record<string, number> = { pending: 0, accepted: 0, rejected: 0, total: 0 };
    for (const r of rows) {
      const status = pyStr(pyOr(r["status"], ""));
      const n = pyIntCoerce(pyOr(r["c"], 0));
      out["total"] = (out["total"] as number) + n;
      if (status in out) out[status] = n;
    }
    return out;
  }

  insert_proposal(p: Proposal): void {
    const clean_draft = PrivacySanitizer ? PrivacySanitizer.clean(pyOr(p.draft, "") as string) : pyOr(p.draft, "");
    const clean_rat = PrivacySanitizer ? PrivacySanitizer.clean(pyOr(p.rationale, "") as string) : pyOr(p.rationale, "");
    this._conn.execute(
      "INSERT INTO proposals (id, signature, kind, tool_name, target_file, " +
      "draft, rationale, hits, status, created_at, supersedes) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [p.id, p.signature, p.kind, p.tool_name, p.target_file,
        clean_draft, clean_rat, p.hits, p.status, p.created_at,
        pyOr(p.supersedes, "")],
    );
    this._conn.commit();
  }

  mark_decided(proposal_id: string, status: string, applied: boolean): void {
    this._conn.execute(
      "UPDATE proposals SET status=?, decided_at=?, applied=? WHERE id=?",
      [status, _now(), applied ? 1 : 0, proposal_id],
    );
    this._conn.commit();
  }

  /** 改写一条待审提案的 draft。
   *
   * 用户在接受前编辑草案时走这里。**先落库再写盘**是刻意的顺序：历史记录必须
   * 显示真正被写进引导文件的那行字，而不是模型原本起草的那行。否则审计轨迹会
   * 和磁盘上的内容不一致，而这条轨迹是用户回头查"这规则谁批的"的唯一凭据。
   */
  update_draft(proposal_id: string, draft: string): void {
    this._conn.execute(
      "UPDATE proposals SET draft=? WHERE id=? AND status='pending'",
      [draft, proposal_id],
    );
    this._conn.commit();
  }

  // ── 效果回访 ─────────────────────────────────────────────────────────

  /** 已生效且到了回访年龄、还没写过 effect 的提案。 */
  proposals_for_effect_review(min_age_s: number, limit: number = 20): Proposal[] {
    const cutoff = _now() - min_age_s;
    const rows = this._conn.execute(
      "SELECT * FROM proposals WHERE applied=1 AND status='accepted' " +
      "AND decided_at > 0 AND decided_at <= ? AND effect='' " +
      "ORDER BY decided_at ASC LIMIT ?",
      [cutoff, pyIntCoerce(limit)],
    ).fetchall();
    return rows.map((r) => this._row_to_proposal(r));
  }

  /** 某签名在 (start, end] 窗口内的信号条数。 */
  signal_hits_between(signature: string, start: number, end: number): number {
    const r = this._conn.execute(
      "SELECT COUNT(*) as c FROM signals " +
      "WHERE signature=? AND created_at > ? AND created_at <= ?",
      [signature, Number(start), Number(end)],
    ).fetchone();
    return r ? pyIntCoerce(r["c"]) : 0;
  }

  record_effect_review(proposal_id: string, verdict: string,
    baseline: number, post: number): void {
    this._conn.execute(
      "UPDATE proposals SET effect=?, effect_reviewed_at=?, effect_baseline=? " +
      "WHERE id=?",
      [verdict, _now(), pyIntCoerce(baseline), proposal_id],
    );
    this._conn.commit();
  }

  /** 返回已判定某效果 verdict（effective/improving/ineffective）的提案。
   *
   * ineffective 提案是降权/退役逻辑的入口；effective/improving 不会被打扰。
   */
  proposals_with_verdict(verdict: string, limit: number = 200): Proposal[] {
    const rows = this._conn.execute(
      "SELECT * FROM proposals WHERE effect=? " +
      "ORDER BY effect_reviewed_at DESC LIMIT ?",
      [pyStr(verdict), pyIntCoerce(limit)],
    ).fetchall();
    return rows.map((r) => this._row_to_proposal(r));
  }

  /** 无条件改写一条提案的 draft（含被接受规则的权重标记）。
   *
   * 与 update_draft 不同：这里不要求 status='pending'——已接受的规则行在
   * 降权时也要能改。只作废不删除：从不物理移除任何一行，只更新其权重标记。
   */
  set_proposal_draft(proposal_id: string, draft: string): void {
    const clean = PrivacySanitizer ? PrivacySanitizer.clean(draft) : draft;
    this._conn.execute(
      "UPDATE proposals SET draft=? WHERE id=?",
      [clean, proposal_id],
    );
    this._conn.commit();
  }

  /** 释放连接。长驻进程里用不到，但测试和"撤掉这个功能"的路径需要——
   * Windows 上不关连接就删不掉库文件。 */
  close(): void {
    try {
      this._conn.close();
    } catch {
      // fail-open: 已无后续动作可做；连接对象交由 GC 兜底
    }
  }

  _row_to_proposal(r: Row): Proposal {
    // supersedes 是后加的列：老库里的行没有它，直接下标会 IndexError。
    const cols = Object.keys(r);
    return new Proposal({
      id: r["id"] as string, signature: r["signature"] as string,
      kind: pyOr(r["kind"], "") as string,
      tool_name: pyOr(r["tool_name"], "") as string, target_file: r["target_file"] as string,
      draft: r["draft"] as string, rationale: pyOr(r["rationale"], "") as string,
      hits: pyIntCoerce(pyOr(r["hits"], 0)), status: r["status"] as string,
      created_at: pyFloatCoerce(pyOr(r["created_at"], 0)),
      decided_at: pyFloatCoerce(pyOr(r["decided_at"], 0)),
      applied: pyIntCoerce(pyOr(r["applied"], 0)),
      supersedes: cols.includes("supersedes") ? pyOr(r["supersedes"], "") as string : "",
      effect: cols.includes("effect") ? pyOr(r["effect"], "") as string : "",
      effect_reviewed_at: cols.includes("effect_reviewed_at") ? pyFloatCoerce(pyOr(r["effect_reviewed_at"], 0)) : 0.0,
      effect_baseline: cols.includes("effect_baseline") ? pyIntCoerce(pyOr(r["effect_baseline"], 0)) : 0,
    });
  }
}

/** py: list(x or []) —— None→[]，list/tuple→浅拷贝。 */
function pcToArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return [...v];
  return [];
}

// ── 引擎 + 降权退役 + 分节工具 + 进程内单例 + 事件总线挂接 ────────────────────

/** 把文件切成 (before, existing rule lines, after)。
 *
 * 找不到小节时返回 (text, [], '')——调用方会追加新小节到末尾。
 */
export function _split_evolution_section(text: string): [string, string[], string] {
  if (!pyTruth(text) || !text.includes(EVOLUTION_HEADING)) {
    return [pyOr(text, "") as string, [], ""];
  }
  const idx = text.indexOf(EVOLUTION_HEADING);
  const before = text.slice(0, idx);
  const rest = text.slice(idx + EVOLUTION_HEADING.length);
  // 下一个二级标题是小节的边界
  const m = new RegExp("\\n##[" + PY_WS + "]").exec(rest);
  let section_body: string, after: string;
  if (m) {
    section_body = rest.slice(0, m.index);
    after = rest.slice(m.index);
  } else {
    section_body = rest;
    after = "";
  }
  const lines: string[] = [];
  for (const ln of pySplitlines(section_body)) {
    const t = pyStrip(ln);
    if (t && !t.startsWith("<!--")) lines.push(t);
  }
  return [before, lines, after];
}

// ── 无效规则降权与退役 ────────────────────────────────────────────────────────

/** 从一条规则行读出权重。
 *
 * 没有标记就是 1.0（向后兼容所有已落盘、未带标记的历史规则行）；标记解析失败
 * 也退回 1.0，绝不让一条坏标记把规则静默升到零权重。
 */
export function _rule_weight(line: string): number {
  if (!pyTruth(line)) return 1.0;
  const m = WEIGHT_MARK_RE.exec(line);
  if (!m) return 1.0;
  try {
    return pyFloatCoerce(m[1]);
  } catch {
    // ValueError
    return 1.0;
  }
}

/** 把规则行的权重标记设成 weight；没有就追加到末尾，有就原地替换。
 *
 * 只动末尾的标记，不动规则正文——保证同一行规则的含义不变，只是权重变了。
 */
export function _set_weight_mark(line: string, weight: number): string {
  const base = pyStrip(line.replace(new RegExp(WEIGHT_MARK_RE.source, "g"), ""));
  return `${base} <!-- evo:weight=${pyFloatStr(weight)} -->`;
}

/** 构造一条用于写盘（替换原行）的提案镜像，supersedes 指向旧的未标记行。 */
export function _demote_proposal_for(p: Proposal, new_draft: string): Proposal {
  return new Proposal({
    id: p.id, signature: p.signature, kind: p.kind, tool_name: p.tool_name,
    target_file: p.target_file, draft: new_draft, rationale: p.rationale,
    hits: p.hits, status: p.status, created_at: p.created_at,
    decided_at: p.decided_at, applied: p.applied, supersedes: p.draft,
  });
}

/** 为一条已降到退役阈值以下、仍 ineffective 的规则生成退役提案，交人裁决。 */
export function _build_retire_proposal(old: Proposal, demoted_draft: string): Proposal {
  return new Proposal({
    id: uuidHex(12),
    signature: old.signature,
    kind: "rule_retire",
    tool_name: old.tool_name,
    target_file: old.target_file,
    draft: demoted_draft,
    rationale: `规则权重已降至退役阈值以下且效果仍无效，提议退役：${old.draft}`,
    hits: old.hits,
    status: "pending",
    created_at: _now(),
    supersedes: old.draft,
  });
}

/** 对被判 ineffective 的规则做降权，而不是重新塞回用户队列（纪律 2：宁可不提，不可骚扰）。
 *
 * 每条 ineffective 规则把权重乘以 DEMOTE_FACTOR（1.0 → 0.6 → 0.36 → …），
 * 权重不跌破 MIN_RULE_WEIGHT。权重降到 RETIRE_PROPOSAL_THRESHOLD(0.3) 以下、
 * 且仍是 ineffective 时，才生成一条“退役提案”交给人裁决——只作废不删除，绝不
 * 在本任务里物理移除任何规则行或数据库行。
 *
 * 返回每条被降权规则的 {"id", "from", "to", "retire_proposal"}，供调用方知悉
 * 本次动作；没有任何 ineffective 规则时返回空列表。
 */
export function demote_ineffective_rules(engine: EvolutionEngine): JsonDict[] {
  const out: JsonDict[] = [];
  for (const p of engine.store.proposals_with_verdict("ineffective")) {
    const old_w = _rule_weight(p.draft);
    let new_w = pyRound(old_w * DEMOTE_FACTOR, 4);
    if (new_w < MIN_RULE_WEIGHT) new_w = MIN_RULE_WEIGHT;
    const new_draft = _set_weight_mark(p.draft, new_w);

    // 1) 落盘权重标记到提案 draft
    engine.store.set_proposal_draft(p.id, new_draft);
    // 2) 把权重标记写进引导文件里那一行（替换而非追加，复用既有写盘路径）
    engine._apply_to_guidance(_demote_proposal_for(p, new_draft));

    // 3) 降到退役阈值以下且仍无效，才生成退役提案交给人裁决
    const retire = new_w < RETIRE_PROPOSAL_THRESHOLD;
    if (retire) {
      engine.store.insert_proposal(_build_retire_proposal(p, new_draft));
    }
    out.push({
      id: p.id,
      from: old_w,
      to: new_w,
      retire_proposal: retire,
    });
  }
  return out;
}

// ── 引擎 ────────────────────────────────────────────────────────────────────

/** 把 store 里的信号变成提案，并在用户接受后落盘。
 *
 * 对外只暴露四个动词：
 * * ``record`` —— 记一条信号（下游订阅 tool_result 时调用）；
 * * ``mine`` —— 扫一次热签名，产出新提案；
 * * ``list_open`` / ``list_all`` —— 读；
 * * ``decide`` —— 接受或拒绝一条提案。
 *
 * 这个引擎自己不会主动调 ``mine``。什么时候挖由外层决定（例如每回合结束时、
 * 或 dreaming loop 的空闲周期）。默认关闭档位下 mine 会直接返回空列表，
 * 从而保证"用户没开就一行不跑"。
 */
export class EvolutionEngine {
  store: EvolutionStore;
  _mode: string;
  workspace_root: string;
  _last_mine_at: number;

  constructor(opts: {
    store?: EvolutionStore | null; mode?: string;
    workspace_root?: string | null; storage?: any;
  } = {}) {
    const { store = null, mode = DEFAULT_MODE, workspace_root = null, storage = null } = opts;
    // py: hasattr(storage, "_db_dir") —— 真 storage 只有 db_dir，这个探针在两侧
    // 都恒 False，storage 参数实际永不生效。忠实读属性，不加兜底映射；quirk 由 parity 钉住。
    if (store === null && storage !== null && storage !== undefined && "_db_dir" in storage) {
      this.store = new EvolutionStore(path.join((storage as any)._db_dir, "evolution.db"));
    } else {
      this.store = store ?? new EvolutionStore();
    }
    this._mode = VALID_MODES.includes(mode) ? mode : DEFAULT_MODE;
    this.workspace_root = pyStrOr(workspace_root, "") || process.cwd();
    this._last_mine_at = 0.0;
  }

  // ── 档位 ─────────────────────────────────────────────────────────────

  get mode(): string {
    return this._mode;
  }

  set_mode(mode: string): string {
    if (!VALID_MODES.includes(mode)) {
      throw new Error(`ValueError: unknown mode ${pyReprStr(mode)}; expected one of ${pyReprTuple(VALID_MODES)}`);
    }
    this._mode = mode;
    return this._mode;
  }

  enabled(): boolean {
    return this._mode !== MODE_OFF;
  }

  /** 当前档位的实际阈值，给前端如实显示用。
   *
   * 存在的理由很实际：这些数字（几次算复发、最多挂几条、拒绝后冷却多久）本来
   * 只活在 ``MODE_POLICIES`` 里，前端只能把它们硬编码进文案。一旦这里调参，
   * 界面上的说明就开始撒谎，而用户是照着那句说明做决定的。所以由后端吐出真值。
   *
   * off 档没有策略条目（查表会 KeyError），返回空 dict 而不是伪造一组阈值。
   */
  policy_view(): JsonDict {
    const policy = pyGetDefault(MODE_POLICIES, this._mode, null) as ModePolicy | null;
    if (policy === null) return {};
    return {
      minHits: policy.min_hits,
      maxOpen: policy.max_open,
      rejectCooldownDays: pyRound(policy.reject_cooldown_s / 86400, 1),
    };
  }

  // ── 记录 ─────────────────────────────────────────────────────────────

  /** 记一条信号，返回签名；档位为 off 时静默丢弃。
   *
   * 丢弃前不写盘——纪律 1 的落地：off 状态下这个模块**不产生任何 IO**。
   */
  record(kind: string, tool_name: string, detail: string,
    session_id: string = "", failure_kind: string | null = null): string | null {
    if (!this.enabled()) return null;
    if (!pyTruth(kind)) return null;
    return this.store.record_signal(kind, pyOr(tool_name, "") as string, pyOr(detail, "") as string, session_id, pyStrOr(failure_kind, ""));
  }

  /** 给一个观察定决策并归档。观察层的全部出口就这一个。
   *
   * 纪律与 record() 相同：off 档零 IO。NO_OP 也照记——"为什么不学"和
   * "学了什么"同样是审计要回答的问题。这里**只记录、不写入**：任何对
   * Memory/Skill 的实际改动仍必须走提案-审批管线，模型说"我学会了"
   * 到不了 active。
   */
  observe(obs: EvolutionObservation): EvolutionObservation {
    if (!this.enabled()) {
      obs.decision = DECISION_NO_OP;
      obs.reason = "evolution off：未评估";
      return obs;
    }
    const [dec, rea] = classify_observation(obs);
    obs.decision = dec;
    obs.reason = rea;
    this.store.insert_observation(obs);
    return obs;
  }

  /** 将用户的实时打断、纠正与负反馈记录为第一等进化证据。 */
  record_user_correction(turn_id: string, correction_text: string, session_id: string = ""): string | null {
    if (!this.enabled()) return null;
    return this.record(
      "user_correction",
      "user_intervention",
      `user correction: ${correction_text}`,
      session_id,
    );
  }

  /** 运行 GEPA 遗传帕累托进化算法优化 Prompt / SOP 规则。 */
  gepa_optimize_prompt(
    seed_prompt: string,
    seed_name: string,
    opts: {
      eval_cases?: JsonDict[]; failure_traces?: JsonDict[];
      max_generations?: number;
    } = {},
  ): JsonDict {
    const { eval_cases = [], failure_traces = [], max_generations = 3 } = opts;
    const optimizer = new GEPAEvolutionOptimizer();
    return optimizer.run_evolution_cycle(
      seed_prompt, seed_name, eval_cases, failure_traces, max_generations,
    ) as JsonDict;
  }

  /** 每个终态目标固定产出一条 LearningBundle（含 NO_OP）。
   *
   * 四路决策是 bundle 的**路由**，不是终点：MEMORY_ONLY 只有事实提案、
   * SKILL_ONLY 只有候选、BOTH 的两类产物共享同一组 experience/turn 证据、
   * NO_OP 也要留下"为什么没有学习"。这样 Memory 和 Skill 才能被证明是
   * 同一条经验的两个投影，而不是两个相邻功能。
   *
   * ``materialized`` 是 :func:`materialize_observation` 的返回
   * （``memoryProposals`` / ``skillCandidate``）；NO_OP 传空 dict。
   *
   * ``bundle_key`` 是幂等键（见 :meth:`EvolutionStore.insert_bundle`）：给了
   * 就是"同一次终态只有一条"，重复调用返回原件的 id；不给就退回每次一条。
   * ``outcome`` 记的是这次运行本身怎么结束的（success/failure/cancelled/
   * unknown），和"学到了什么"分开——失败也要有学习记录，但不能被读成成功。
   */
  emit_learning_bundle(
    obs: EvolutionObservation,
    materialized: JsonDict | null,
    opts: {
      turn_ids?: unknown; bundle_key?: string;
      outcome?: string; terminal_event_id?: string;
    } = {},
  ): string {
    const { bundle_key = "", outcome = "", terminal_event_id = "" } = opts;
    const turn_ids = opts.turn_ids ?? null;
    const made = (pyOr(materialized, {}) as JsonDict) || {};
    const items_list = [...(pyOr(made["learningItems"], []) as unknown[])];
    const cand_list = pyTruth(made["skillCandidate"])
      ? [pyStr(pyOr(made["skillCandidate"], ""))] : [];
    const pre_bid = pyStr(pyOr(made["bundle_id"], ""));
    const learning_id = this.store.insert_bundle({
      bundle_id: pre_bid,
      goal_id: obs.goal_id || "",
      run_id: obs.run_id || "",
      session_id: obs.session_id || "",
      decision: obs.decision || "UNCLASSIFIED",
      rationale: obs.reason || "",
      turn_ids: pcToArray(turn_ids),
      experience_ids: ((obs.skill_experiences || []) as unknown[]).filter((e) => pyTruth(e)),
      memory_proposal_ids: ((pyOr(made["memoryProposals"], []) as unknown[]) || []).filter((x) => pyTruth(x)),
      skill_candidate_id: pyStr(pyOr(made["skillCandidate"], "")),
      skill_candidate_ids: cand_list,
      learning_item_ids: items_list,
      validator_result: pyOr(obs.validator_result, {}) as JsonDict,
      bundle_key,
      outcome,
      terminal_event_id,
    });
    try {
      const st = get_storage();
      for (const li_id of items_list) {
        st._db("memory").execute(
          "UPDATE learning_items SET bundle_id=? WHERE learning_item_id=?",
          [learning_id, li_id],
        );
      }
      st._db("memory").commit();
    } catch {
      // py: except Exception: pass
    }
    return learning_id;
  }

  /** 会话主题片段封存时触发的学习观察（§13.4/13.5）。
   *
   * 硬隔离保证：只读取当前 session_id 内在 episode.turn_ids 范围内的事件和事实。
   */
  observe_episode_completion(episode: JsonDict): string | null {
    if (!this.enabled()) return null;
    const sid = pyStr(pyOr(episode["session_id"], ""));
    const eid = pyStr(pyOr(episode["episode_id"], ""));
    if (!pyTruth(sid)) return null;

    try {
      const st = get_storage();
      const facts: unknown[] = [];
      const matched_event_ids: string[] = [];
      let bid: string | undefined; // py: 内层抛在赋值前 → 后续访问 NameError（外层兜住）
      try {
        const es = (st as any).get_event_store();
        const turn_ids_set = new Set(
          ((pyOr(episode["turn_ids"], []) as unknown[]) || [])
            .map((t) => pyStr(t)).filter((x) => pyTruth(pyStrip(x))));
        bid = pyStrip(pyStr(pyOr(episode["branch_id"], "")));
        for (const ev of es.read_stream(sid) as any[]) {
          // Hard session check: event must match session_id
          if (pyStr(pyOr(ev.session_id ?? "", "")) !== sid) continue;
          // P1-6: Strict branch match for all events
          const ev_bid = pyStrip(pyStr(pyOr(ev.branch_id ?? "",
            ev.payload ? getK(ev.payload as JsonDict, "branch_id") : "")));
          if (ev_bid !== bid) continue;
          if (turn_ids_set.size) {
            // P0-5: Strict turn_id match when episode has turns
            const ev_turn = pyStr(pyOr(ev.turn_id ?? "",
              ev.payload ? getK(ev.payload as JsonDict, "turn_id") : ""));
            if (!pyTruth(ev_turn) || !turn_ids_set.has(ev_turn)) continue;
          }
          const ev_id_str = pyStr(pyOr(ev.id ?? "", ev.event_id ?? ""));
          if (pyTruth(ev_id_str)) matched_event_ids.push(ev_id_str);
          if (ev.event_type === EventType.MEMORY_EXTRACTED) {
            const p = (pyOr(ev.payload, {}) as JsonDict) || {};
            const batch = (pyOr(getK(p, "facts"), []) as unknown[]) || [];
            if (pyTruth(batch)) {
              for (const f of batch) {
                if (pyStrip(pyStr(f))) facts.push(pcSlice(pyStr(f), 200));
              }
            } else {
              const fact = pyStrip(pyStr(pyOr(pyOr(getK(p, "text"), getK(p, "fact")),
                pyOr(getK(p, "content"), ""))));
              if (pyTruth(fact)) facts.push(pcSlice(fact, 200));
            }
          }
        }
      } catch (_e) {
        console.log(`[evolution] episode read events failed: ${pyStrExc(_e)}`);
      }
      // py: NameError 语义复现——内层 try 在 bid 赋值前抛出时，这里必须炸出去
      // （由外层 except 打 observe_episode_completion failed），不能静默当空串。
      if (bid === undefined) {
        throw new Error("NameError: name 'bid' is not defined");
      }

      const obs = new EvolutionObservation({
        goal_id: "",
        run_id: "",
        session_id: sid,
        branch_id: bid,
        episode_id: eid,
        turn_ids: [...((episode["turn_ids"] as unknown[]) || [])],
        source_event_ids: matched_event_ids,
        used_skills: [],
        skill_experiences: [],
        validator_result: { status: "sealed", machineVerified: false },
        user_feedback: null,
        new_facts: facts,
        reusable_steps: [],
        validated_skills: [],
        failed_experiences: [],
        failure_class: null,
        created_at: _now(),
      });

      this.observe(obs);
      let made: JsonDict = {};
      if (obs.decision !== DECISION_NO_OP) {
        made = materialize_observation(obs, st, this);
        if (pyTruth(made["memoryProposals"])) {
          _publish_proposal_count(this);
        }
        _publish_insight(
          "learned",
          obs.reason,
          {
            decision: obs.decision,
            sessionId: sid,
            episodeId: eid,
            memoryProposals: pyOr(made["memoryProposals"], []),
            skillCandidate: pyOr(made["skillCandidate"], ""),
            learningItems: pyOr(made["learningItems"], []),
            learningItemDetails: pyOr(made["learningItemDetails"], []),
            materialized: pyTruth(pyOr(made["memoryProposals"], []))
              || pyTruth(pyOr(made["skillCandidate"], ""))
              || pyTruth(pyOr(made["learningItems"], [])),
            materializeReason: pyOr(made["reason"], ""),
          },
        );
      }

      bid = pyStr(pyOr(episode["branch_id"], ""));
      const gen = pyGetDefault(episode, "generation", 1);
      const bundle_key = `episode:${sid}:${bid}:${eid}:sealed:${pyStr(gen)}`;
      const bundle_id = this.emit_learning_bundle(
        obs, made,
        {
          turn_ids: pyGetDefault(episode, "turn_ids", []),
          bundle_key,
          outcome: "sealed",
        },
      );
      return bundle_id;
    } catch (exc) {
      console.log(`[evolution] observe_episode_completion failed: ${pyStrExc(exc)}`);
      return null;
    }
  }

  // ── 挖掘 ─────────────────────────────────────────────────────────────

  /** 节流版 ``mine``。给信号订阅者用。
   *
   * 节流的目的是让重试风暴不重复跑挖掘；但**只在真正跑完一次挖掘之后**才更新
   * 时间戳——否则第一次失败（此时命中还不够 min_hits，mine 会空返回）就锁住
   * 整个窗口，后续复发到达阈值时反而挖不出来了。这个错我第一版真犯过。
   */
  maybe_mine(): Proposal[] {
    if (!this.enabled()) return [];
    const now = _now();
    if ((now - this._last_mine_at) < MINE_THROTTLE_S) return [];
    const made = this.mine();
    // 只有真的挖出东西才让下次冷却生效。空返回不算"跑过"。
    if (pyTruth(made)) this._last_mine_at = now;
    return made;
  }

  /** 扫一次，返回**这次调用新产生的**提案列表。
   *
   * 资格判据是保守的合取：
   * - min_hits：偶发不立规则；
   * - 已有未决提案就跳过：同一签名同时只能有一条待审；
   * - 冷却期内跳过：被拒过的签名一段时间不再骚扰；
   * - max_open 触顶就停：让用户先清完。
   */
  mine(): Proposal[] {
    if (!this.enabled()) return [];
    const policy = (MODE_POLICIES as Record<string, ModePolicy>)[this._mode] as ModePolicy;
    if (this.store.count_open() >= policy.max_open) return [];

    const now = _now();
    const made: Proposal[] = [];
    const hot = this.store.hot_signatures(policy.min_hits, 20);
    for (const row of hot) {
      const sig = row["signature"];
      if (this.store.has_open_for_signature(sig as string)) continue;
      const last_rej = this.store.last_rejected_at(sig as string);
      if (pyTruth(last_rej) && (now - last_rej) < policy.reject_cooldown_s) continue;
      const proposal = this._draft(row);
      if (proposal === null) continue;
      this.store.insert_proposal(proposal);
      try {
        const draft_mgr = new EvolutionDraftManager(this.workspace_root);
        const trig = proposal.kind === "user_correction" ? "correction" : "preference";
        draft_mgr.save_pending_draft(proposal as any, trig);
      } catch (_dm_err) {
        // py: except Exception: pass
      }
      made.push(proposal);
      if (this.store.count_open() >= policy.max_open) break;
    }
    return made;
  }

  /** 把一个热签名做成一条草稿。目标文件依 kind 决定并对照白名单。 */
  _draft(row: JsonDict): Proposal | null {
    const kind = pyStrip(pyStr(pyOr(row["kind"], "")));
    const target = pyGetDefault(KIND_TARGET, kind, null) as string | null;
    if (target === null || !ALLOWED_TARGETS.has(target)) {
      return null; // 未映射的 kind 不产出——白名单是硬约束
    }
    const tool_name = pyStrOr(pyOr(row["tool"], pyOr(row["tool_name"], "")), "");
    const hits = pyIntCoerce(pyOr(row["hits"], 0));
    const detail = pyStrip(pyStr(pyOr(row["detail"], "")));
    const rule = EvolutionEngine._compose_rule(kind, tool_name, detail);
    const prop_id = uuidHex(12);
    const today = strftimeDate();
    const structured_rule = format_rule_line(rule, { rule_id: prop_id, hits, last_date: today });
    let clean_sum = pcSlice(normalize_error(detail), 160);
    clean_sum = pyStrip(clean_sum.replaceAll("<n>", ""));
    const rationale =
      `触发依据：近 14 天内遇到 ${hits} 次同类场景 · ` +
      `来源工具: ${tool_name || "系统操作"} · 摘要: ${clean_sum}`;
    return new Proposal({
      id: prop_id,
      signature: row["signature"] as string,
      kind,
      tool_name,
      target_file: target,
      draft: structured_rule,
      rationale,
      hits,
      status: "pending",
      created_at: _now(),
    });
  }

  /** 把签名和形状转成一条可读的引导条目。
   *
   * 不塞入原文——原文可能包含具体路径、错误堆栈、甚至泄露的凭证。我们只
   * 写「什么形状的事发生过」和「下次注意什么」，让用户自己决定要不要落。
   */
  static _compose_rule(kind: string, tool_name: string, detail: string): string {
    let summary = pcSlice(normalize_error(detail), 160) || "(no detail)";
    summary = pyStrip(summary.replaceAll("<n>", ""));

    const detailL = detail.toLowerCase();
    if (kind === "tool_failure") {
      if (detailL.includes("confirmation") || detailL.includes("high risk")) {
        return `- 执行 \`${tool_name}\` 等高风险或敏感命令前，先向用户简要说明意图并等待确认。`;
      }
      if (detailL.includes("forbidden") || detail.includes("403")) {
        return `- 抓取网页遭遇权限拒绝 (403) 时，优先提示用户登录或改用浏览器模式协助抓取。`;
      }
      if (detailL.includes("not found") || detail.includes("404")) {
        return `- 遇到目标页面不存在 (404) 时，自动通过搜索引擎寻找备用有效链接，不再反复尝试死链。`;
      }
      return `- 遇到 \`${tool_name}\` 执行异常时（${summary}），` +
        "先检查参数有效性与前置条件，或改用等价工具。";
    }
    if (kind === "tool_denied") {
      return `- 反复被策略拦截：\`${tool_name}\` — ${summary}。 ` +
        "不要重复尝试同一形式；换目标或先请示用户。";
    }
    if (kind === "interrupted") {
      return `- 用户在 \`${tool_name}\` 期间频繁中断（${summary}）。 ` +
        "开始该类操作前先摘要计划、等待确认。";
    }
    if (kind === "user_correction") {
      return `- 用户偏好：${summary}`;
    }
    if (kind === "context_pressure") {
      return `- 上下文压力较高时（${summary}）：` +
        "优先分步精简输出、主动折叠上下文，避免单回合超出预算。";
    }
    return `- ${summary}`;
  }

  // ── 读接口 ───────────────────────────────────────────────────────────

  list_open(): JsonDict[] {
    return this.store.open_proposals().map((p) => p.to_dict());
  }

  list_all(limit: number = 50): JsonDict[] {
    return this.store.all_proposals(limit).map((p) => p.to_dict());
  }

  /** 终身状态计数。与 ``list_all`` 的 limit 无关，供 UI 显示总数。 */
  counts(): Record<string, number> {
    return this.store.count_by_status();
  }

  // ── 决策 ─────────────────────────────────────────────────────────────

  /** 接受或拒绝一条提案。
   *
   * Args:
   *   draft_override: 用户在接受前编辑过的草案。非空且与原文不同时，先落库
   *   再写盘——用户批的是他们眼睛看到的那行字，不是模型起草的原句。拒绝
   *   路径忽略它（拒绝就是不写，没有"写什么"可言）。
   *
   * Returns:
   *   ``{"ok": bool, "status": "accepted"|"rejected"|"missing",
   *      "applied": bool, "error": str}``。
   *   ``applied`` 严格反映**盘上是不是真的写进去了**——写盘失败时是 False，
   *   不吞不掩盖（纪律 3）。
   */
  decide(proposal_id: string, accept: boolean,
    draft_override: string | null = null): JsonDict {
    const p = this.store.get_proposal(proposal_id);
    if (p === null) {
      return { ok: false, status: "missing", applied: false, error: "proposal not found" };
    }
    if (p.status !== "pending") {
      return { ok: false, status: p.status, applied: pyTruth(p.applied), error: "already decided" };
    }

    if (!accept) {
      this.store.mark_decided(proposal_id, "rejected", false);
      try {
        new EvolutionDraftManager(this.workspace_root).mark_rejected(proposal_id);
      } catch {
        // pass
      }
      // 裁决回写所属 LearningBundle：bundle 的 user_verdict 记录的是
      // "人最终怎么看这条学习"，不是提案自身的状态字段。
      try {
        this.store.mark_bundle_verdict_for_proposal(proposal_id, "rejected");
      } catch (exc) {
        console.log(`[evolution] bundle verdict write failed: ${pyStrExc(exc)}`);
      }
      return { ok: true, status: "rejected", applied: false, error: "" };
    }

    // 接受前若带了编辑，先把它落库，让审计轨迹与磁盘一致。
    const edited = pyStrip(pyStr(pyOr(draft_override, "")));
    if (edited && edited !== pyStrip(p.draft)) {
      this.store.update_draft(proposal_id, edited);
      p.draft = edited;
    }

    // 接受路径 —— 写盘前原子快照备份，支持回滚
    try {
      create_evolution_snapshot(this.workspace_root, p.target_file, p.id);
    } catch (snap_exc) {
      console.log(`[evolution] snapshot before apply failed (fail-open): ${pyStrExc(snap_exc)}`);
    }

    // 接受路径 —— 写盘
    let applied: boolean;
    let err: string;
    try {
      applied = this._apply_to_guidance(p);
      err = applied ? "" : "write skipped";
    } catch (exc) {
      applied = false;
      err = `apply failed: ${pyStrExc(exc)}`;
    }

    this.store.mark_decided(proposal_id, "accepted", applied);
    try {
      this.store.mark_bundle_verdict_for_proposal(proposal_id, "approved");
    } catch (exc) {
      console.log(`[evolution] bundle verdict write failed: ${pyStrExc(exc)}`);
    }

    // 审批通过流转草稿至 approved/
    if (applied) {
      try {
        new EvolutionDraftManager(this.workspace_root).mark_approved(proposal_id);
      } catch {
        // pass
      }
      try {
        this._extract_and_ingest_graph_triplets(p);
      } catch (exc) {
        console.log(`[evolution] graph triplet ingestion failed: ${pyStrExc(exc)}`);
      }
    }

    // 裁决掉的旧结论也要从记忆库里退役。只改文件是不够的：召回走的是
    // memory_entries，那条"用 npm"还躺在库里，下一轮照样被注入——文件说 pnpm、
    // 记忆说 npm，而模型两边都读。
    const retired = (applied && pyTruth(p.supersedes))
      ? _retire_superseded_memory(p, this.workspace_root) : 0;
    // targetFile 一起回：写盘失败时 UI 要能指名道姓说"哪个文件没被改动"，
    // 而提案此刻已从待审列表消失，前端再也查不到它写向哪里。
    // 效果回访顺手跑：接受/拒绝是低频动作，此刻清扫"到期未回访"的
    // 已生效提案只是几条 SQL 计数，保证回访不无限积压。回访失败
    // 不影响本次裁决本身。
    try {
      this.review_applied_effects();
    } catch {
      // pass
    }

    return { ok: applied, status: "accepted", applied, error: err, targetFile: p.target_file, retiredMemories: retired };
  }

  /** 从被批准的自进化提案中提取结构化实体三元组并写入图谱记忆 (Phase 60 联动)。 */
  _extract_and_ingest_graph_triplets(p: Proposal): number {
    let graph_engine: any;
    try {
      graph_engine = get_graph_memory_engine();
    } catch {
      return 0;
    }

    const draft = pyStrip(pyStr(pyOr(p.draft, "")));
    const tool = pyStrip(pyStr(pyOr(p.tool_name, "")));
    const root = pyStrOr(this.workspace_root, "") || "";
    let ingested = 0;

    // 1. 截图/文件生成路径约定
    if (draft.toLowerCase().includes("screenshot") || draft.includes("截图") || draft.toLowerCase().includes("saved to")) {
      const m = /(?:saved to|保存至)\s*([^\s,，。]+)/i.exec(draft);
      const dest = m ? pyStrip(m[1] as string) : "output/";
      graph_engine.ingest_triplet(
        root, "ScreenCapture", "SAVED_TO", dest, "Operation", "Path", 0.98,
      );
      ingested += 1;
    }

    // 2. 权限受限 403 处理
    if (draft.includes("403") || draft.toLowerCase().includes("forbidden") || draft.includes("权限拒绝")) {
      graph_engine.ingest_triplet(
        root, "WebFetch_403", "FALLBACK_TO", "BrowserMode", "ErrorEvent", "ActionProtocol", 0.95,
      );
      ingested += 1;
    }

    // 3. 404 资源未找到处理
    if (draft.includes("404") || draft.toLowerCase().includes("not found") || draft.includes("死链")) {
      graph_engine.ingest_triplet(
        root, "WebFetch_404", "FALLBACK_TO", "SearchEngine", "ErrorEvent", "ActionProtocol", 0.95,
      );
      ingested += 1;
    }

    // 4. 通用工具与约束关系
    if (pyTruth(tool)) {
      const subj_name = `Tool_${tool}`;
      graph_engine.ingest_triplet(
        root, subj_name, "CONSTRAINED_BY",
        pyOr(p.user_title, pyOr(p.signature, "GeneralRule")),
        "Tool", "Rule", 0.90,
      );
      ingested += 1;
    }

    return ingested;
  }

  /** 已生效提案的效果回访：同签名失败在生效后的复发 vs 生效前基线。
   *
   * 三态判定：
   *   effective   生效后同签名零复发——规则在起作用
   *   improving   有复发但显著低于生效前基线——在起作用，还需要观察
   *   ineffective 复发未降（或生效前无基线可比且仍在复发）——规则没解决
   *               它目标解决的问题，评审队列里应该被人看到这一点
   *
   * 回访是纯 SQL 计数，成本可忽略；判定写回 proposals.effect，评审队列
   * 与审计页据此展示"这条规则到底管不管用"。
   */
  review_applied_effects(): JsonDict[] {
    const now = _now();
    const min_age_s = 7 * 86400; // 生效满 7 天才回访——太早看不出趋势
    const baseline_window_s = 14 * 86400;
    const out: JsonDict[] = [];
    for (const p of this.store.proposals_for_effect_review(min_age_s)) {
      const decided = pyTruth(p.decided_at) ? p.decided_at : now;
      const baseline = this.store.signal_hits_between(
        p.signature, decided - baseline_window_s, decided);
      const post = this.store.signal_hits_between(p.signature, decided, now);
      let verdict: string;
      if (post <= 0) {
        verdict = "effective";
      } else if (baseline > 0 && post < baseline) {
        verdict = "improving";
      } else {
        verdict = "ineffective";
      }
      this.store.record_effect_review(p.id, verdict, baseline, post);
      out.push({ id: p.id, signature: p.signature, verdict, baseline, post });
    }
    return out;
  }

  // ── 写盘 ─────────────────────────────────────────────────────────────

  /** 把已接受的 draft 写进目标文件的 Learned Rules 小节。
   *
   * 绕过 PathGuard 是刻意的——PathGuard 关的是模型的门，不是系统的门。
   * 这条路径上有一个人点了"接受"，所以走系统写。union+dedup 保证
   * 同一条规则不会被反复追加；``p.supersedes`` 非空时是**替换**那一行，
   * 因为一条改写过的事实和它的旧版本不能同时留在每轮注入的上下文里。
   */
  _apply_to_guidance(p: Proposal): boolean {
    if (!ALLOWED_TARGETS.has(p.target_file)) return false;
    const target_path = path.join(this.workspace_root, p.target_file);
    let existing = "";
    try {
      if (fs.existsSync(target_path) && fs.statSync(target_path).isFile()) {
        existing = _readTextPy(target_path);
      }
    } catch {
      // py: except OSError —— readFileSync 抛出的 IO 错误在这里同样落网
      existing = "";
    }

    const [head, section_lines, tail] = _split_evolution_section(existing);
    const rule = pyStrip(p.draft);
    const today = strftimeDate();

    // 1. 冲突提案 / 显式替换：把旧行**原地换掉**，不是追加。位置保留是有意的——用户在
    // MEMORY.md 里按顺序读这些规则，把改写过的一条挪到末尾会打乱他的心智模型。
    const old = pyStrip(pyStr(pyOr(p.supersedes, "")));
    let replaced = false;
    if (pyTruth(old)) {
      for (let i = 0; i < section_lines.length; i++) {
        if (pyStrip(section_lines[i] as string) === old) {
          section_lines[i] = rule;
          replaced = true;
          break;
        }
      }
    }

    // 2. 同主题增量合并：新提案与已有规则属于同主题时合并更新，更新命中次数与时间，避免重复堆叠
    if (!replaced) {
      const parsed_draft = parse_rule_line(rule);
      const matched_idx = find_matching_rule_index(
        parsed_draft.content,
        section_lines,
        { rule_id: parsed_draft.id || p.id, threshold: 0.65 },
      );
      if (matched_idx >= 0) {
        const matched_line = section_lines[matched_idx];
        const existing_meta = parse_rule_line(matched_line);
        const new_hits = existing_meta.hits + pyMax2(1, pyMax2(p.hits, parsed_draft.hits));
        const new_id = existing_meta.id || parsed_draft.id || p.id || `rule-${uuidHex(8)}`;
        const new_content = parsed_draft.content || existing_meta.content;
        section_lines[matched_idx] = format_rule_line(new_content, { rule_id: new_id, hits: new_hits, last_date: today });
        replaced = true;
      }
    }

    // 3. 全新规则追加
    if (!replaced && pyTruth(rule) && !section_lines.includes(rule)) {
      section_lines.push(rule);
    }

    const rebuilt_section =
      `${EVOLUTION_HEADING}\n` +
      `<!-- auto-maintained by evolution engine; ` +
      `only expanded after explicit user approval -->\n` +
      section_lines.join("\n");
    const parts = [pyRstrip(head), rebuilt_section, pyLstrip(tail)];
    const rebuilt = parts.filter((x) => pyTruth(x)).join("\n\n") + "\n";

    try {
      const r = atomic_write(target_path, rebuilt);
      if (!r.ok) return false;
    } catch {
      return false;
    }
    return true;
  }
}

// py str.rstrip()/lstrip()（Unicode 空白集）
function pyRstrip(s: string): string {
  return s.replace(new RegExp(`[${PY_WS}]+$`), "");
}
function pyLstrip(s: string): string {
  return s.replace(new RegExp(`^[${PY_WS}]+`), "");
}

// ── 进程内单例 ─────────────────────────────────────────────────────────────

let _engine: EvolutionEngine | null = null;

/** 进程共享引擎。第一次读会用当前 workspace 建库。 */
export function get_evolution_engine(workspace_root: string | null = null): EvolutionEngine {
  if (_engine === null) {
    _engine = new EvolutionEngine({ workspace_root });
  } else if (pyTruth(workspace_root) && workspace_root !== _engine.workspace_root) {
    _engine.workspace_root = workspace_root as string;
  }
  return _engine;
}

/** 自测用：给一个干净的临时 DB 和 workspace。 */
export function reset_for_tests(opts: {
  db_path?: string | null; mode?: string; workspace_root?: string | null;
} = {}): EvolutionEngine {
  const { db_path = null, mode = DEFAULT_MODE, workspace_root = null } = opts;
  _engine = new EvolutionEngine({
    store: new EvolutionStore(db_path),
    mode,
    workspace_root,
  });
  _attached_buses = new Set();
  _bus_ref = null;
  return _engine;
}

/** 从 config.json 的 ``evolution.mode`` 读档位。返回生效的档位。
 *
 * 读不到就是 off——缺省关，见纪律 1。非法值也是 off 而不是抛：一个坏掉的配置
 * 字段不该拦住整个服务启动，静默降到最安全的一档才对。
 */
export function configure_from_config(cfg: JsonDict | null, workspace_root: string | null = null): string {
  const engine = get_evolution_engine(workspace_root);
  let mode = pyStr(
    pyOr(pyDictGet(pyOr(pyDictGet(pyOr(cfg, {}), "evolution"), {}), "mode"), DEFAULT_MODE));
  if (!VALID_MODES.includes(mode)) mode = DEFAULT_MODE;
  engine.set_mode(mode);
  return mode;
}

// ── 信号采集：挂到 event bus ────────────────────────────────────────────────

/** tool_result 的 status → 信号 kind。只收 failed / denied：
 * ``completed`` 没有教训可学，``needs_confirmation`` 还没有结果。
 */
const _STATUS_TO_KIND: Record<string, string> = {
  failed: "tool_failure",
  denied: "tool_denied",
};

/** 已挂过的 bus（按 id）。同一个 bus 重复挂会让一次失败被记成两条，
 * 直接把复发计数翻倍、提前触发阈值。
 * DIVERGENCE(port): py 用 id(bus) 整数组（对象可被 GC、id 可复用），TS 持强引用
 * Set——产品里 bus 是进程级单例，两者行为一致。
 */
let _attached_buses: Set<unknown> = new Set();

/** 记住每个 bus 的引用，好在挖出新提案时主动广播。挂载时填，
 * ``_on_tool_result`` 用它 emit ``evolution_proposal``。
 */
let _bus_ref: any = null;

/** 把一次失败/被拒的工具调用记成信号，并在挖出新提案时广播。
 *
 * 这个订阅者必须是完全无害的：档位 off 时立即返回（不写盘），任何异常都吞掉。
 * 演化是可选的附加功能，它绝不该有能力弄坏一个正常的回合。
 *
 * 广播 ``evolution_proposal`` 是为了让 UI 不必轮询——提案是在对话过程中被动挖
 * 出来的，没有推送的话用户永远不知道有东西要审，这个审核队列就等于不存在。
 */
export async function _on_tool_result(event: any): Promise<void> {
  try {
    const engine = get_evolution_engine();
    if (!engine.enabled()) return;
    const payload = (pyOr(event.payload, {}) as JsonDict) || {};
    const st_key = pyStr(pyOr(pyDictGet(payload, "status"), ""));
    const kind = st_key in _STATUS_TO_KIND ? _STATUS_TO_KIND[st_key] : null;
    if (!pyTruth(kind)) return;
    const result = pyOr(pyDictGet(payload, "result"), {}) as JsonDict;
    const detail = pyOr(pyDictGet(result, "error"), pyOr(pyDictGet(result, "value"), ""));
    if (!pyTruth(detail)) return;
    engine.record(
      kind as string,
      pyStr(pyOr(pyDictGet(payload, "tool_name"), "")),
      pyStr(detail),
      pyStr(pyOr(pyDictGet(payload, "session_id"), "")),
    );
    const made = engine.maybe_mine();
    if (pyTruth(made) && _bus_ref !== null && _bus_ref !== undefined) {
      // 只发"有新的了 + 现在待审几条"，卡片内容让前端拉一次 /proposals。
      // 提案里含归一化后的 draft（可能仍有 <PATH> 之类），走已建立的 WS
      // 通道即可，但没必要把整包塞进事件负载。
      try {
        await _bus_ref.emit("evolution_proposal", {
          created: made.length,
          openCount: engine.store.count_open(),
        });
      } catch (_e) {
        // 观察镜像：WS 推送失败不拖垮挖掘本身，但必须留痕——
        // 静默丢掉会让"有待审提案"这件事凭空消失。
        console.log(`[evolution] proposal bus emit failed: ${pyStrExc(_e)}`);
      }
    }
  } catch (_e) {
    // 这是后台挖掘循环的总闸：无声吞掉等于信号采集永久死亡且无人知。
    console.log(`[evolution] tool_result observation loop failed: ${pyStrExc(_e)}`);
  }
}

/** 把一次进化时刻推上总线（WS 桥转发为聊天界面里的轻量感知芯片）。
 *
 * 学习是后台账目：只在实际学到了东西时才打扰用户——NO_OP 不发。
 * 没有运行中的事件循环（纯同步测试）就跳过，面板轮询仍可见。
 */
export function _publish_insight(kind: string, detail: string, extra: JsonDict = {}): void {
  const bus = _bus_ref;
  if (bus === null || bus === undefined) return;
  if (!_LOOP_PROBE()) return; // py: asyncio.get_running_loop() RuntimeError → return
  const payload: JsonDict = { kind, detail, ts: _now(), ...extra };
  // py: asyncio.create_task(bus.emit(...)) —— fire-and-forget。
  // DIVERGENCE(port): Node 的 floating rejection 会升级为进程级告警，catch 掉
  // 是运行环境要求；py 侧未处理的 task 异常同样只进 loop handler 不上抛，等价。
  void Promise.resolve(bus.emit("evolution_insight", payload)).catch(() => undefined);
}

/** 广播"现在待审几条"。
 *
 * 观察层产出的提案必须和挖掘产出的提案走同一帧，否则侧栏那个计数只在
 * "工具反复失败"时才动——用户刚跑完的任务产生了三条待确认记忆，界面上
 * 却一点动静都没有，等于这些提案不存在。
 */
export function _publish_proposal_count(engine: EvolutionEngine): void {
  const bus = _bus_ref;
  if (bus === null || bus === undefined) return;
  if (!_LOOP_PROBE()) return; // 纯同步环境（测试）：面板轮询仍会看到
  let count: number;
  try {
    count = engine.store.count_open();
  } catch (exc) {
    console.log(`[evolution] open count failed: ${pyStrExc(exc)}`);
    return;
  }
  void Promise.resolve(bus.emit("evolution_proposal", {
    openCount: count, ts: _now(),
  })).catch(() => undefined);
}

/** Goal 终态 → 这次运行"怎么结束的"。键就是 bus 上的 status，值进 bundle 的
 * outcome 列。只有这四个是终态：stopping / paused / running 还会再变，
 * 它们不该产生学习记录，否则一次暂停就会被读成一次结论。
 */
const _TERMINAL_OUTCOME: Record<string, string> = {
  completed: "success",
  ovolve_failed_final: "failure",
  cancelled: "cancelled",
  stop_timeout: "unknown",
};

/** 有终态、但不该据此学习的那两个。取消是用户改了主意，停止超时是我们根本
 * 不知道现场停在哪一步——两者都没有"这么做是对的"这种证据，落 bundle 是为了
 * 审计（这次运行结束了、没学到东西、原因在此），不是为了产出提案。
 */
const _EVIDENCE_ONLY_OUTCOMES = new Set(["cancelled", "unknown"]);

/** 同一次运行、同一个终态的稳定标识。
 *
 * 用 ``claim_epoch``（goals 表，0011 迁移）做运行代次：它每被认领一次 +1，
 * 是库里唯一持久、跨进程仍然成立的"第几次跑"。内存里的 run_id 不行——重启
 * 续跑会铸一个新的，正好在最需要幂等的那个场景下失效。
 */
export function _bundle_key_for(goal_id: string, status: string, storage: any): string {
  let epoch = 0;
  try {
    const row = (pyOr(storage.get_goal(goal_id), {}) as JsonDict) || {};
    epoch = pyIntCoerce(pyOr(getK(row, "claim_epoch"), 0));
  } catch {
    // noqa: BLE001 — 拿不到就退化成"每个终态一条"
    epoch = 0;
  }
  return `goal:${goal_id}|epoch:${epoch}|terminal:${status}`;
}

/** 把"这个目标结束了"写进 append-only 事件链，返回事件的 chain_hash。
 *
 * 在此之前，"目标结束"只存在于 goals.status 这一个**可变**列里：跑完的一次
 * 运行没有留下任何不可篡改的痕迹，历史 Trace 无从查询，幂等也没有可锚定的
 * 事实。事件类型分四种（completed / failed / cancelled / stop_timeout），
 * payload 里带上 outcome 和这次运行的 key。
 *
 * 幂等键与 bundle 用同一个：同一次终态重复触发只会有一条事件，
 * ``append`` 会把已存在的那条原样返回。
 *
 * 失败返回 ""——记账不能拦住状态流转，但 bundle 里的 terminal_event_id 会
 * 因此为空，那是"没记上"的诚实表示，不是"没发生"。
 */
export function _append_terminal_event(
  goal_id: string, status: string, outcome: string,
  payload: JsonDict, bundle_key: string, storage: any,
): string {
  // py: try: from event_store/event_types import … —— DIVERGENCE(14) 静态导入后
  // 该 try 只可能罩住调用期异常；导入守卫如实保留为 void 引用。
  void get_event_store;
  const etype = ({
    completed: EventType.GOAL_COMPLETED,
    ovolve_failed_final: EventType.GOAL_FAILED,
    cancelled: EventType.GOAL_CANCELLED,
    stop_timeout: EventType.GOAL_STOP_TIMEOUT,
  } as Record<string, string>)[status];
  if (etype === undefined) return "";
  let row: JsonDict = {};
  try {
    row = (pyOr(storage.get_goal(goal_id), {}) as JsonDict) || {};
  } catch {
    row = {};
  }
  // 事件链按 session 分链；目标没有 session 时用一条以目标命名的链，也比把
  // 它塞进别人的链里、或者因为 NOT NULL 写不进去要好。
  const session_id = pyStr(
    pyOr(pyDictGet(payload, "session_id"),
      pyOr(pyDictGet(row, "session_id"), `goal-${goal_id}`)),
  );
  const body: JsonDict = {
    goal_id, status, outcome,
    run_key: bundle_key,
    claim_epoch: pyIntCoerce(pyOr(pyDictGet(row, "claim_epoch"), 0)),
    iteration: "iteration" in payload
      ? payload["iteration"]
      : ("iteration" in row ? row["iteration"] : 0),
    source: pyStr(pyOr(pyDictGet(payload, "source"), "scheduler")),
  };
  for (const k of ["reason", "error", "verified"]) {
    if (pyDictGet(payload, k) != null) body[k] = payload[k];
  }
  try {
    const rid = pyStr(pyOr(pyDictGet(payload, "run_id"), "")) || null;
    const ev = get_event_store().append(
      session_id, etype, body,
      {
        idempotency_key: `goal_terminal:${bundle_key}`,
        goal_id, run_id: rid,
        actor: "system", visibility: "user",
      },
    );
    return pyStr(pyOr((ev as any).chain_hash ?? "", ""));
  } catch (exc) {
    console.log(`[evolution] terminal event append failed: ${pyStrExc(exc)}`);
    return "";
  }
}

/** Goal 终态 → 自动观察一条（Step C 的运行时挂点）。
 *
 * 四个终态都要留记录：成功、最终失败、取消、停止超时。失败同样是证据，取消和
 * 停止超时至少要留下"这次没学到东西，因为……"。后台账目，任何失败都只打
 * 日志——绝不能让记账问题惊动正在跑目标的 worker。
 */
export function _on_goal_state_change(payload: unknown): void {
  try {
    const p = (pyOr(payload, {}) as JsonDict) || {};
    const status = pyStr(pyOr(pyDictGet(p, "status"), ""));
    const outcome = status in _TERMINAL_OUTCOME ? _TERMINAL_OUTCOME[status] : null;
    if (outcome === null) return;
    const goal_id = pyStr(pyOr(pyDictGet(p, "goal_id"), ""));
    if (!pyTruth(goal_id)) return;
    // 终态事件先写。它是审计事实，不是演化功能：evolution 关掉的时候
    // "这个目标结束了"照样要留在事件链里。
    const bundle_key = _bundle_key_for(goal_id, status, get_storage());
    const terminal_event_id = _append_terminal_event(
      goal_id, status, outcome as string, p, bundle_key, get_storage());
    const engine = get_evolution_engine();
    if (!engine.enabled()) return;
    const obs = build_goal_observation(goal_id, get_storage(), {
      run_id: pyStr(pyOr(pyDictGet(p, "run_id"), "")),
    });

    if (obs !== null) {
      let made: JsonDict = {};
      if (_EVIDENCE_ONLY_OUTCOMES.has(outcome as string)) {
        // 不 observe、不 materialize：这条运行不该进挖掘池，也不该
        // 生出提案。只把"为什么没学"写进 bundle。
        obs.decision = DECISION_NO_OP;
        obs.reason = outcome === "cancelled"
          ? "目标被取消，没有可复用的证据"
          : "停止超时：现场停在哪一步无法确定，不据此学习";
      } else {
        engine.observe(obs);
        try {
          record_goal_validation_edges(obs, get_storage());
        } catch (exc) {
          console.log(`[evolution] validation edges failed: ${pyStrExc(exc)}`);
        }
        if (obs.decision !== DECISION_NO_OP) {
          // 先产物，再广播。顺序有意义：insight 里带上真实的产物数量，
          // 前端那句"学到了新东西"才不是空话——没产出就如实说没产出。
          try {
            made = materialize_observation(obs, get_storage(), engine);
          } catch (exc) {
            console.log(`[evolution] materialize failed: ${pyStrExc(exc)}`);
          }
          if (pyTruth(pyOr(made["memoryProposals"], []))) {
            _publish_proposal_count(engine);
          }

          _publish_insight(
            "learned",
            obs.reason,
            {
              decision: obs.decision,
              sessionId: pyOr(obs.session_id, ""),
              goalId: obs.goal_id,
              skills: obs.used_skills,
              memoryProposals: pyOr(made["memoryProposals"], []),
              skillCandidate: pyOr(made["skillCandidate"], ""),
              learningItems: pyOr(made["learningItems"], []),
              learningItemDetails: pyOr(made["learningItemDetails"], []),
              materialized: pyTruth(pyOr(made["memoryProposals"], []))
                || pyTruth(pyOr(made["skillCandidate"], []))
                || pyTruth(pyOr(made["learningItems"], [])),
              materializeReason: pyOr(made["reason"], ""),
            },
          );
        }
      }
      // LearningBundle：无论四路判成什么都要落一条。BOTH 的记忆提案与
      // 技能候选在这里共享同一组 experience/turn 证据；NO_OP 的"为什么
      // 没学"也是审计要回答的问题。失败只打日志——记账不能惊动 worker。
      //
      // 幂等键让重复调用变成无害：completed 这条路径本身就会把订阅者
      // 调用两次（_emit_change 一次、直接 emit 一次），事件重播和双窗口
      // 也会。第二次拿到的是同一条 bundle 的 id，不是第二条 bundle。
      try {
        const iters = (get_storage() as any).list_goal_iterations(goal_id, 50) as unknown[];
        const turn_ids: unknown[] = [];
        for (const it of iters) {
          if (it !== null && typeof it === "object" && !Array.isArray(it)
            && pyTruth(getK(it as JsonDict, "id"))) {
            turn_ids.push(getK(it as JsonDict, "id"));
          }
        }
        engine.emit_learning_bundle(
          obs, made, { turn_ids, bundle_key, outcome: outcome as string, terminal_event_id });

        // bundle 归档是后台账目，不弹 insight 打扰用户；面板轮询可见。
      } catch (exc) {
        console.log(`[evolution] learning bundle failed: ${pyStrExc(exc)}`);
      }
    }
  } catch (exc) {
    console.log(`[evolution] goal observation failed: ${pyStrExc(exc)}`);
  }
}

/** 订阅 ``tool_result`` 与 ``goal_state_change``。返回是否真的新挂上了。
 *
 * priority 用 -200，排在 WS 广播（-100）之后：UI 的实时性优先，演化记录是
 * 后台账目，晚一点毫无影响。
 */
export function attach_to_bus(bus: any): boolean {
  if (bus === null || bus === undefined) return false;
  _bus_ref = bus;
  if (_attached_buses.has(bus)) return false;
  bus.on("tool_result", _on_tool_result, -200);
  bus.on("goal_state_change", _on_goal_state_change, -200);
  _attached_buses.add(bus);
  return true;
}

// PORT STATUS: confidence=high todos=[0]
