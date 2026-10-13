/**
 * memory_domain.ts — 统一的 Memory domain adapter —— 让"记忆"只有一种形状。
 *
 * Ported from `app/backend/memory_domain.py` (1078 lines), wave-4 SPLIT unit.
 *
 * 长期知识存在两张表里（memory_entries 五态 / wiki_claims 三态+墓碑），这一层
 * 不新建存储：把两种行读成同一个 MemoryItem，把状态变更翻回各自的原生调用。
 * 模块头注释与源逐段对应，行为细节全部由 parity harness 钉死。
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/memory_domain.py -> app/engine/memory_domain.ts；
 *       模块级函数与方法名保持源侧 snake_case（file_agent.ts 先例）；
 *       item_from_entry / item_from_claim / compute_time_decay_score /
 *       maximal_marginal_relevance / get_memory_domain 全部导出。
 *   §2  bug-for-bug kept source quirks（parity 钉死）：
 *       - reject_merge 没有 kind==entry 检查（approve_merge 有）：一条带
 *         supersedes 的断言也能被"驳回"——归档走 claim→deleted 映射。
 *       - set_status 对断言的 candidate/rejected 拒绝并说明原因，不做近似映射。
 *       - _retire_claim_sources 递归走 set_status（同一套转移规则）。
 *       - adjust_confidence 的失败哨兵是 -1.0（不是 null）。
 *       - confirm 对断言返回"断言没有'最后确认时间'，只提高了置信度"。
 *       - 只有原生 disputed 被收档才连带退役来源（was 读的是断言库原生列）。
 *       - duplicates 的 limit=0 走 falsy 分支返回全部组。
 *       - conflicts 视图不按 live 过滤（candidate 最需要裁决）。
 *       - approve_merge 先候选生效再归档旧的（顺序注释在源里，逐字保留）。
 *       - 断言写失败/库拒绝的两种消息分开（"库拒绝了"/"断言库拒绝了"）。
 *       - trace 里 fetchone() None → dict(None) 的 TypeError 文本原样保留。
 *   §1  no new deps：json→JSON.parse 薄壳、re→RegExp、math.log1p→Math.log1p。
 *
 * DIVERGENCE(port) —— 每一条都有等价论证，fixtures 全部双向核对：
 *   1) async surface：源里 `from evolution import get_evolution_engine` 是函数内
 *      懒加载 import；TS 里未移植模块只能动态 import（evolution_bridge.ts、
 *      memory_layer.ts `_import_unported` 先例），所以 `_mark_bundle_verdict`、
 *      `approve_merge`、`reject_merge`、`_dream_trace`、`trace` 返回 Promise。
 *      evolution 未落地时 import reject → 走 catch，与 Python 侧 ImportError 走
 *      except 完全同形（evolution_bridge 同款论证）。
 *   2) item_from_claim 读的是 wiki_store.ts 落地的 camelCase 面（rootDir/
 *      createdAt/statusReason…），等价于 Python 侧 getattr 读 wiki_store.py 的
 *      snake_case 属性——两张面各自被自己的语言测试钉住。
 *   3) storage/wiki 调用的 kwargs → 落地签名的位置参/opts 对象
 *      （set_memory_status(eid, want, {reason, superseded_by})、
 *      confirm_memory(eid, {delta})、listClaims(root, {limit, includeDeleted})），
 *      与 storage.ts / wiki_store.ts 已验证单元逐字对齐。
 *   4) json.loads 对 NaN/Infinity 裸记号与 int/float 的 str 形态差异
 *      （'[2.0]' py→"2.0" JS→"2"）：JSON.parse 不认裸记号，落进 except 分支
 *      返回 [str(v)]。tags/conflict_set/supersedes 列全部由产品侧
 *      json.dumps([...str]) 写入，不可能含裸记号或非字符串元素；等价论证同
 *      wiki_store.parseJsonArray 落地时的取舍。
 *   5) 正则 Unicode 类：Python \w/\W 按 Unicode 字母数字判定，JS \W 是 ASCII。
 *      duplicates 的 [\s\W_]+ → /[^\p{L}\p{N}]+/gu（两者都只留字母数字），
 *      _tokenize 的 [\w]+ → /[\p{L}\p{N}_]+/gu。CJK 内容的归一键与切词由
 *      parity fixtures 钉死（中文/ß/连字）。
 *   6) casefold：JS 没有 str.casefold()，复制 wiki_store.ts 的 CASEFOLD_EXTRA
 *      全折叠表（AMEND-07 决议），与已落地检索面保持同一份语义。
 *   7) logging：log.warning 走 console.error（预格式化的 "%s" 渲染结果），
 *      print 走 console.log；消息模板逐字一致。
 *   8) _now：Math.floor(Date.now()/1000)；parity 侧用 _set_now_for_parity 测试
 *      缝固定时钟（Python 侧 monkeypatch _now，两语言的 live/expiring 用例同
 *      一时钟）。
 *   9) pyFloatCoerce 不认 "1_000" 下划线字面量（house helper，同 file_agent）：
 *      confidence 列由产品侧 float 写入，只会是数字/None。
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import { get_storage } from "./storage.js";
import { get_memory_layer } from "./memory_layer.js";
import { WikiStore } from "./wiki_store.js";

type Row = Record<string, unknown>;
type JsonDict = Record<string, unknown>;

// ── house Python-semantics helpers（per-file，项目约定，抄 file_agent.ts）──

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

/** round(x, 4) —— 对二进制 double 的真十进制展开做银行家舍入（file_agent 同款）。 */
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

/** Python 的两参 min/max：并列取第一个、NaN 只可能赢在"比较为假则保留"一侧。 */
function pyMin2(a: number, b: number): number {
  return b < a ? b : a;
}
function pyMax2(a: number, b: number): number {
  return b > a ? b : a;
}

/** casefold：wiki_store.ts AMEND-07 表逐字复制（两语言检索面同一份语义）。 */
const CASEFOLD_EXTRA: Readonly<Record<string, string>> = Object.freeze({
  "ß": "ss", "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl",
  "ﬅ": "st", "ﬆ": "st", "ς": "σ", "ϐ": "β", "ϑ": "θ", "ϕ": "φ",
  "ϖ": "π", "ϰ": "κ", "ϱ": "ρ", "ϵ": "ε", "µ": "μ", "ſ": "s",
  "ǳ": "dz", "ẖ": "h", "ẗ": "t", "ẘ": "w", "ẙ": "y",
});
const CASEFOLD_RX = /[ßﬀﬁﬂﬃﬄﬅﬆςϐϑϕϖϰϱϵµſǳẖẗẘẙ]/gu;
function casefold(text: string): string {
  return text
    .replace(CASEFOLD_RX, (ch) => CASEFOLD_EXTRA[ch] ?? ch)
    .toLowerCase();
}

/** python `s[:8]` 按码点切。 */
function pySlice8(s: string): string {
  const chars = Array.from(s);
  return chars.length > 8 ? chars.slice(0, 8).join("") : s;
}

function pyList(items: unknown[]): string[] {
  return items.map((x) => pyStr(x));
}

// ─────────────────────────────────────────────────────────────────────────────

let _NOW_OVERRIDE: number | null = null;
/** parity/测试缝：固定时钟。产品路径永不调用，等价于 Python 侧 monkeypatch _now。 */
export function _set_now_for_parity(v: number | null): void {
  _NOW_OVERRIDE = v;
}

export function _now(): number {
  if (_NOW_OVERRIDE !== null) return _NOW_OVERRIDE;
  return Math.floor(Date.now() / 1000);
}

/** 两种知识的种类标签。``entry`` 是 episodic 记忆，``claim`` 是 wiki 断言。 */
export const KIND_ENTRY = "entry";
export const KIND_CLAIM = "claim";
export const KINDS: readonly string[] = [KIND_ENTRY, KIND_CLAIM];

/** 统一状态词汇 —— 取记忆那边的五态。 */
export const STATUSES: readonly string[] = ["candidate", "active", "stale", "rejected", "archived"];

/** 只有这些状态能进 prompt。 */
export const LIVE_STATUSES: readonly string[] = ["active"];

/** 设置页默认列出的状态（含 stale 与老行的空串）。 */
export const UI_DEFAULT_STATUSES: readonly string[] = ["candidate", "active", "stale", ""];

/** wiki 状态 → 统一状态。disputed→active 是有意的（冲突走 conflicts 字段）。 */
const _CLAIM_TO_UNIFIED: ReadonlyMap<string, string> = new Map([
  ["active", "active"],
  ["disputed", "active"],
  ["superseded", "stale"],
  ["deleted", "archived"],
  ["", "active"],
]);

/** 统一状态 → wiki 侧的写入意图。不在表里的状态断言表达不了，会被拒绝。 */
const _UNIFIED_TO_CLAIM: ReadonlyMap<string, string> = new Map([
  ["active", "active"],
  ["stale", "superseded"],
  ["archived", "deleted"],
]);

export interface MemoryItemOpts {
  kind: string;
  id: string;
  root: string;
  content: string;
  status: string;
  confidence: number;
  importance?: number;
  tier?: string;
  type?: string;
  tags?: string[];
  source?: string;
  conflicts?: string[];
  superseded_by?: string;
  status_reason?: string;
  valid_until?: number;
  last_confirmed_at?: number;
  created_at?: number;
  updated_at?: number;
  hits?: number;
  last_accessed_at?: number;
  subject?: string;
  predicate?: string;
  object?: string;
  sensitivity?: string;
  source_goal_id?: string;
  source_event_ids?: string[];
  valid_from?: number;
  supersedes?: string[];
}

/**
 * 一条长期知识，不管它底下躺在哪张表里。
 * 字段取两边的并集；对某一种不适用的字段留在默认值上，由 kind 说明为什么。
 */
export class MemoryItem {
  kind: string;
  id: string;
  root: string;
  content: string;
  status: string;
  confidence: number;
  importance: number;
  tier: string;
  type: string;
  tags: string[];
  source: string;
  conflicts: string[];
  superseded_by: string;
  status_reason: string;
  valid_until: number;
  last_confirmed_at: number;
  created_at: number;
  updated_at: number;
  hits: number;
  last_accessed_at: number;
  subject: string;
  predicate: string;
  object: string;
  sensitivity: string;
  source_goal_id: string;
  source_event_ids: string[];
  valid_from: number;
  supersedes: string[];

  constructor(o: MemoryItemOpts) {
    this.kind = o.kind;
    this.id = o.id;
    this.root = o.root;
    this.content = o.content;
    this.status = o.status;
    this.confidence = o.confidence;
    this.importance = o.importance ?? 0.5;
    this.tier = o.tier ?? "";
    this.type = o.type ?? "fact";
    this.tags = o.tags ?? [];
    this.source = o.source ?? "";
    this.conflicts = o.conflicts ?? [];
    this.superseded_by = o.superseded_by ?? "";
    this.status_reason = o.status_reason ?? "";
    this.valid_until = o.valid_until ?? 0;
    this.last_confirmed_at = o.last_confirmed_at ?? 0;
    this.created_at = o.created_at ?? 0;
    this.updated_at = o.updated_at ?? 0;
    this.hits = o.hits ?? 0;
    this.last_accessed_at = o.last_accessed_at ?? 0;
    this.subject = o.subject ?? "";
    this.predicate = o.predicate ?? "";
    this.object = o.object ?? "";
    this.sensitivity = o.sensitivity ?? "public";
    this.source_goal_id = o.source_goal_id ?? "";
    this.source_event_ids = o.source_event_ids ?? [];
    this.valid_from = o.valid_from ?? 0;
    this.supersedes = o.supersedes ?? [];
  }

  /**
   * 这一条现在还会进 prompt 吗。惰性过期在这里也算：状态列写着 active 但
   * valid_until 过了的行，界面必须和召回口径一致。
   */
  get live(): boolean {
    if (!LIVE_STATUSES.includes(this.status)) return false;
    const now = _now();
    if (this.valid_until && this.valid_until <= now) return false;
    if (this.valid_from && this.valid_from > now) return false;
    return true;
  }

  /** 用户能不能改内容。WORKING 层每轮清空，给编辑框等于骗人。 */
  get editable(): boolean {
    return this.tier !== "working";
  }

  /** 给 HTTP / UI 用的 camelCase 形状（status 和 live 都给，界面才能显示矛盾态）。 */
  to_api(): JsonDict {
    return {
      kind: this.kind,
      id: this.id,
      root: this.root,
      content: this.content,
      status: this.status,
      live: this.live,
      confidence: pyRound(Number(this.confidence), 4),
      importance: pyRound(Number(this.importance), 4),
      tier: this.tier,
      type: this.type,
      tags: [...this.tags],
      source: this.source,
      conflicts: [...this.conflicts],
      supersededBy: this.superseded_by,
      statusReason: this.status_reason,
      validUntil: pyIntCoerce(this.valid_until),
      lastConfirmedAt: pyIntCoerce(this.last_confirmed_at),
      createdAt: pyIntCoerce(this.created_at),
      updatedAt: pyIntCoerce(this.updated_at),
      hits: pyIntCoerce(this.hits),
      lastAccessedAt: pyIntCoerce(this.last_accessed_at),
      editable: this.editable,
      subject: this.subject,
      predicate: this.predicate,
      object: this.object,
      sensitivity: this.sensitivity,
      sourceGoalId: this.source_goal_id,
      sourceEventIds: [...this.source_event_ids],
      validFrom: pyIntCoerce(this.valid_from),
      supersedes: [...this.supersedes],
    };
  }
}

export function _as_float(v: unknown, dflt: number): number {
  try {
    return pyFloatCoerce(v);
  } catch {
    // (TypeError, ValueError) -> default
    return dflt;
  }
}

/** tags 列存的是 JSON 数组的字符串，但历史行里也见过裸字符串和 NULL。 */
export function _as_tags(v: unknown): string[] {
  if (Array.isArray(v)) return pyList(v);
  if (!pyTruth(v)) return [];
  if (typeof v !== "string") return [pyStr(v)]; // json.loads TypeError -> [str(v)]
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    // ValueError -> [str(v)]
    return [pyStr(v)];
  }
  return Array.isArray(parsed) ? pyList(parsed) : [];
}

/**
 * ``memory_entries`` 的一行 → MemoryItem。status 为空是 0013 之前的老行，
 * 按 archived 列兜底。
 */
export function item_from_entry(row: unknown): MemoryItem {
  const r: JsonDict = { ...((row ?? {}) as JsonDict) };
  let status = pyStrOr(r["status"], "");
  if (!status) {
    status = pyIntCoerce(pyOr(r["archived"], 0)) ? "archived" : "active";
  }
  return new MemoryItem({
    kind: KIND_ENTRY,
    id: pyStrOr(r["id"], ""),
    root: pyStrOr(r["root_dir"], ""),
    content: pyStrOr(r["content"], ""),
    status,
    confidence: _as_float(r["confidence"], 0.5),
    importance: _as_float(r["importance"], 0.5),
    tier: pyStrOr(r["tier"], ""),
    type: pyStrOr(pyOr(r["type"], "fact"), ""),
    tags: _as_tags(r["tags"]),
    source: pyStrOr(r["created_by"], ""),
    superseded_by: pyStrOr(r["superseded_by"], ""),
    status_reason: pyStrOr(r["status_reason"], ""),
    valid_until: pyIntCoerce(pyOr(r["valid_until"], 0)),
    last_confirmed_at: pyIntCoerce(pyOr(r["last_confirmed_at"], 0)),
    created_at: pyIntCoerce(pyOr(r["created_at"], 0)),
    updated_at: pyIntCoerce(pyOr(r["updated_at"], 0)),
    hits: pyIntCoerce(pyOr(r["hits"], 0)),
    last_accessed_at: pyIntCoerce(pyOr(r["accessed_at"], pyOr(r["last_accessed_at"], 0))),
    sensitivity: pyStrOr(r["sensitivity"], "") || "public",
    source_goal_id: pyStrOr(r["source_goal_id"], ""),
    source_event_ids: _as_tags(r["source_event_ids"]),
    valid_from: pyIntCoerce(pyOr(r["valid_from"], 0)),
    conflicts: _as_tags(r["conflict_set"]),
    supersedes: _as_tags(r["supersedes"]),
  });
}

/** wiki_store.ts 落地面（camelCase）的结构性视图。见 DIVERGENCE(port)(2)。 */
export interface ClaimLike {
  id?: unknown;
  rootDir?: unknown;
  statement?: unknown;
  status?: unknown;
  confidence?: unknown;
  source?: unknown;
  contradicts?: unknown;
  statusReason?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  subject?: unknown;
  predicate?: unknown;
  object?: unknown;
  evidence?: unknown;
}

/**
 * ``WikiClaim`` → MemoryItem。断言没有 tier/importance/valid_until，留在默认值
 * 上；conflicts 是唯一由结构（而不是文本）算出来的东西。
 */
export function item_from_claim(claim: ClaimLike): MemoryItem {
  const st = pyStrOr(claim.status, "");
  const contradicts = Array.isArray(claim.contradicts) ? (claim.contradicts as unknown[]).map((x) => pyStr(x)) : [];
  const evidence = Array.isArray(claim.evidence) ? (claim.evidence as unknown[]).map((x) => pyStr(x)) : [];
  return new MemoryItem({
    kind: KIND_CLAIM,
    id: pyStrOr(claim.id, ""),
    root: pyStrOr(claim.rootDir, ""),
    content: pyStrOr(claim.statement, ""),
    status: _CLAIM_TO_UNIFIED.get(st) ?? "active",
    // py: getattr(claim, "confidence", None)——原样传，float(0.0)=0.0 不是默认值。
    confidence: _as_float(claim.confidence === undefined ? null : claim.confidence, 0.5),
    type: "claim",
    source: pyStrOr(claim.source, ""),
    conflicts: contradicts,
    status_reason: pyStrOr(claim.statusReason, ""),
    created_at: pyIntCoerce(pyOr(claim.createdAt, 0)),
    updated_at: pyIntCoerce(pyOr(claim.updatedAt, 0)),
    subject: pyStrOr(claim.subject, ""),
    predicate: pyStrOr(claim.predicate, ""),
    object: pyStrOr(claim.object, ""),
    // 断言的 evidence 就是它的来源事件/记忆 id，名字不同意思相同。
    source_event_ids: evidence,
  });
}

// ── 依赖的落地面（结构性接口；harness 注入 fake，见 parity 文件）─────────────

interface SqlCursorLike {
  fetchone(): Row | null;
  fetchall(): Row[];
}
interface SqlDbLike {
  execute(sql: string, params?: readonly unknown[]): SqlCursorLike;
}

export interface DomainStorage {
  get_memory_entries(
    root?: string | null, mem_type?: string | null,
    include_archived?: boolean, limit?: number | null, since?: number | null,
  ): JsonDict[];
  set_memory_status(eid: string, status: string, opts?: { reason?: string; superseded_by?: string }): boolean;
  adjust_memory_confidence(eid: string, delta: number, opts?: { reason?: string }): number;
  confirm_memory(eid: string, opts?: { delta?: number }): boolean;
  clear_memory_supersedes(eid: string): boolean;
  sweep_expired_memories(root?: string | null): number;
  _db(name: string): SqlDbLike;
  MEMORY_CONFIDENCE_FLOOR?: number;
  MEMORY_CONFIDENCE_CEIL?: number;
}

export interface DomainWiki {
  listClaims(root: string, opts?: { status?: string | null; subject?: string | null; limit?: number; includeDeleted?: boolean }): ClaimLike[];
  get(id: string): ClaimLike | null;
  setStatus(id: string, status: string, reason?: string): boolean;
  softDelete(id: string, reason?: string): boolean;
  setConfidence(id: string, value: number, reason?: string): number;
  delete(id: string): void;
  supersede(oldId: string, newId: string): void;
  disputed(root: string, limit?: number): ClaimLike[];
}

function _logWarning(msg: string): void {
  // py: log.warning("[memory_domain] ...") —— logging 渲染 "%s" 后落 stderr
  console.error(msg);
}

/** 未移植模块的计算式动态 import（memory_layer.ts `_import_unported` 同款）。 */
async function _import_unported(name: string): Promise<any> {
  return await import("./" + name + ".js");
}

/**
 * 两张表之上的唯一入口。自己不建表、不写 SQL——所有写入翻译成 storage /
 * WikiStore 上已有的调用；这一层只负责翻译词汇和路由。
 */
export class MemoryDomain {
  _storage: DomainStorage | null;
  _wiki: DomainWiki | null;

  constructor(storage: DomainStorage | null = null, wiki: DomainWiki | null = null) {
    this._storage = storage;
    this._wiki = wiki;
  }

  // ── 依赖懒加载 ────────────────────────────────────────────────────────
  get storage(): DomainStorage {
    if (this._storage === null) {
      this._storage = get_storage() as unknown as DomainStorage;
    }
    return this._storage;
  }

  /**
   * 复用 MemoryLayer 持有的那一个 WikiStore。拿不到（比如脚本里直接用）时才
   * 退回自己构造。
   */
  get wiki(): DomainWiki {
    if (this._wiki === null) {
      try {
        this._wiki = get_memory_layer().wiki as unknown as DomainWiki;
      } catch {
        this._wiki = new WikiStore(this.storage as unknown as { _db(name: string): never }) as unknown as DomainWiki;
      }
    }
    return this._wiki;
  }

  // ── 读 ────────────────────────────────────────────────────────────────
  list_items(
    root: string,
    opts: {
      kinds?: readonly string[];
      statuses?: readonly string[] | null;
      live_only?: boolean;
      query?: string;
      limit?: number | null;
      offset?: number | null;
    } = {},
  ): [MemoryItem[], number] {
    /** 返回 ``(这一页, 总数)``。总数在分页之前。 */
    const kinds = opts.kinds ?? KINDS;
    const statuses = opts.statuses ?? null;
    const live_only = opts.live_only ?? false;
    const query = opts.query ?? "";
    const limit = opts.limit === undefined ? 100 : opts.limit;
    const offset = opts.offset === undefined ? 0 : opts.offset;

    const want = kinds.filter((k) => KINDS.includes(k));
    const want_kinds: readonly string[] = want.length ? want : KINDS;
    let items: MemoryItem[] = [];

    if (want_kinds.includes(KIND_ENTRY)) {
      // include_archived=True 之后在语言层按 statuses 过滤：storage 只有
      // archived 的二元开关。
      const rows = pyOr(this.storage.get_memory_entries(root, null, true, null), []) as JsonDict[];
      for (const r of rows) items.push(item_from_entry(r));
    }
    if (want_kinds.includes(KIND_CLAIM)) {
      const claims = pyOr(this.wiki.listClaims(root, { limit: 100000, includeDeleted: true }), []) as ClaimLike[];
      for (const c of claims) items.push(item_from_claim(c));
    }

    if (pyTruth(statuses)) {
      const allow = new Set((statuses as readonly string[]).map((s) => pyStr(s)));
      items = items.filter((it) => allow.has(it.status));
    }
    if (live_only) {
      items = items.filter((it) => it.live);
    }
    if (pyTruth(query)) {
      const needle = casefold(pyStrip(pyStr(query)));
      if (needle) {
        const candidates = items.filter(
          (it) => casefold(it.content).includes(needle) || casefold(pyStrOr(it.subject, "")).includes(needle),
        );
        items = this.rank_and_deduplicate(needle, candidates, candidates.length);
      }
      // 源侧的 else 挂在 `if query` 上：query 全空白 → **不排序**，保持
      // "entries 后接 claims" 的原生顺序。bug-for-bug，parity 钉死。
    } else {
      // 统一排序键：最近动过的在前。两张表的时间列语义一致（秒级 epoch）。
      this._sortDefault(items);
    }
    const total = items.length;
    const off = Math.max(0, pyIntCoerce(pyOr(offset, 0)));
    if (limit === null || pyIntCoerce(limit) <= 0) {
      return [items.slice(off), total];
    }
    return [items.slice(off, off + pyIntCoerce(limit)), total];
  }

  private _sortDefault(items: MemoryItem[]): void {
    // Python sort key (-updated_at, -created_at, id)，稳定。
    items.sort((a, b) => {
      if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
      if (a.created_at !== b.created_at) return b.created_at - a.created_at;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  /** 按 id 找一条，不用调用方先知道它是记忆还是断言。真撞了是记忆优先。 */
  get(item_id: unknown): MemoryItem | null {
    const eid = pyStrOr(item_id, "");
    if (!eid) return null;
    const row = this.storage._db("memory")
      .execute("SELECT * FROM memory_entries WHERE id=?", [eid]).fetchone();
    if (row !== null && row !== undefined) return item_from_entry({ ...row });
    const claim = this.wiki.get(eid);
    return claim !== null && claim !== undefined ? item_from_claim(claim) : null;
  }

  // ── 写 ────────────────────────────────────────────────────────────────
  /**
   * 改状态。返回 ``(成功, 原因)``。两种失败必须分得开——"这个状态断言表达
   * 不了"是设计使然，"这个转移非法"是库那一层的规则。
   */
  set_status(
    item_id: string, status: string,
    opts: { reason?: string; superseded_by?: string } = {},
  ): [boolean, string] {
    const reason = opts.reason ?? "";
    const superseded_by = opts.superseded_by ?? "";
    const want = pyStrOr(status, "");
    if (!STATUSES.includes(want)) return [false, `未知状态 ${pyReprStr(want)}`];
    const item = this.get(item_id);
    if (item === null) return [false, "找不到这一条"];
    if (item.status === want) return [true, "已经是这个状态"];

    if (item.kind === KIND_ENTRY) {
      const ok = this.storage.set_memory_status(item.id, want, { reason, superseded_by });
      return ok ? [true, ""] : [false, `库拒绝了 ${item.status} → ${want}`];
    }

    const native = _UNIFIED_TO_CLAIM.get(want);
    if (native === undefined) {
      return [false, `断言没有 ${pyReprStr(want)} 这个状态——它既没有'待批准'，也没有一个` +
        "和归档区分开的'这是错的'。不做近似映射，否则读回来的" +
        "状态会和写进去的不一样。"];
    }
    // 写之前先记下**原生**状态：统一词汇里 disputed 映射成 active，
    // 判"这是不是一次裁决"只能问断言库本身。
    const rawClaim = this.wiki.get(item.id);
    const was = pyStrOr(rawClaim === null || rawClaim === undefined ? null : rawClaim.status, "");
    let ok: boolean;
    if (native === "deleted") {
      ok = this.wiki.softDelete(item.id, pyStrOr(reason, "") || "archived");
    } else {
      ok = this.wiki.setStatus(item.id, native, reason);
    }
    if (!ok) return [false, `断言库拒绝了 ${item.status} → ${want}`];
    // 裁决要连带退役来源记忆——条件收得很紧：只有原本处于 disputed 的断言
    // 被收掉才连带。用户单纯整理一条不再需要的断言不该顺手动他的记忆。
    if (was === "disputed" && want === "archived") {
      this._retire_claim_sources(item.id, { reason: `claim_${want}` });
    }
    return [true, ""];
  }

  /** 把一个断言的 evidence 指向的记忆标成 stale。返回改动条数。 */
  _retire_claim_sources(claim_id: string, opts: { reason: string }): number {
    const claim = this.wiki.get(pyStrOr(claim_id, ""));
    if (claim === null || claim === undefined) return 0;
    const evidence = Array.isArray(claim.evidence) ? (claim.evidence as unknown[]).map((x) => pyStr(x)) : [];
    let n = 0;
    for (const eid of evidence) {
      const [ok] = this.set_status(eid, "stale", { reason: opts.reason });
      if (ok) n += 1;
    }
    return n;
  }

  /**
   * 把人的裁决回写到这条提案所属的 LearningBundle。回写不成不是错误：档位 off
   * 时提案照落，那趟本来就没有 bundle。
   * DIVERGENCE(port)(1)：懒加载 import 在 TS 只能异步。
   */
  async _mark_bundle_verdict(proposal_id: string, verdict: string): Promise<void> {
    if (!pyTruth(proposal_id)) return;
    try {
      const mod = await _import_unported("evolution");
      const engine = mod.get_evolution_engine();
      engine.store.mark_bundle_verdict_for_proposal(pyStr(proposal_id), verdict);
    } catch (e) {
      console.log(`[memory] bundle 裁决没回写：${pyStrExc(e)}`);
    }
  }

  /** 把置信度挪 delta，返回 ``(新值, 原因)``；新值 -1.0 表示没改成。 */
  adjust_confidence(item_id: string, delta: number, opts: { reason?: string } = {}): [number, string] {
    const reason = opts.reason ?? "";
    const item = this.get(item_id);
    if (item === null) return [-1.0, "找不到这一条"];
    if (item.kind === KIND_ENTRY) {
      return [this.storage.adjust_memory_confidence(item.id, delta, { reason }), ""];
    }
    const floor = Number(pyOr(this.storage.MEMORY_CONFIDENCE_FLOOR, 0.05));
    const ceil = Number(pyOr(this.storage.MEMORY_CONFIDENCE_CEIL, 0.95));
    const target = pyMax2(floor, pyMin2(ceil, item.confidence + pyFloatCoerce(pyOr(delta, 0.0))));
    return [this.wiki.setConfidence(item.id, target, reason), ""];
  }

  /** "这条现在还成立"。断言没有 last_confirmed_at，只动置信度并如实说明。 */
  confirm(item_id: string, opts: { delta?: number } = {}): [boolean, string] {
    const delta = opts.delta === undefined ? 0.05 : opts.delta;
    const item = this.get(item_id);
    if (item === null) return [false, "找不到这一条"];
    if (item.kind === KIND_ENTRY) {
      const ok = this.storage.confirm_memory(item.id, { delta });
      return ok ? [true, ""] : [false, "确认失败"];
    }
    const [newV] = this.adjust_confidence(item.id, delta, { reason: "confirmed" });
    if (newV < 0) return [false, "确认失败"];
    return [true, "断言没有'最后确认时间'，只提高了置信度"];
  }

  /** 删除 = 留墓碑。hard=True 才真的抹掉，而且只有断言支持。 */
  delete(item_id: string, opts: { reason?: string; hard?: boolean } = {}): [boolean, string] {
    const reason = opts.reason === undefined ? "user_deleted" : opts.reason;
    const hard = opts.hard ?? false;
    const item = this.get(item_id);
    if (item === null) return [false, "找不到这一条"];
    if (hard) {
      if (item.kind !== KIND_CLAIM) {
        return [false, "记忆没有硬删除；它的删除就是归档，可以再拿回来"];
      }
      this.wiki.delete(item.id);
      return [true, "已彻底删除，不可恢复"];
    }
    return this.set_status(item.id, "archived", { reason });
  }

  /**
   * 裁决两条互相矛盾的断言，并把输的那条的来源记忆一起退役（stale 不是
   * archived：可翻回、进 review、Dream 看得见）。
   */
  resolve_claim(loser_id: string, winner_id: string): [boolean, string] {
    const loser = this.wiki.get(pyStrOr(loser_id, ""));
    const winner = this.wiki.get(pyStrOr(winner_id, ""));
    if (loser === null || loser === undefined || winner === null || winner === undefined) {
      return [false, "找不到这条断言"];
    }
    if (loser.id === winner.id) return [false, "保留和退役不能是同一条"];

    this.wiki.supersede(pyStr(loser.id), pyStr(winner.id));

    // 赢的那条指向哪条记忆——superseded_by 必须是记忆 id；找不到就留空。
    const winnerEvidence = Array.isArray(winner.evidence) ? (winner.evidence as unknown[]).map((x) => pyStr(x)) : [];
    let keep = "";
    for (const e of winnerEvidence) {
      const row = this.storage._db("memory")
        .execute("SELECT 1 FROM memory_entries WHERE id=?", [e]).fetchone();
      if (row !== null && row !== undefined) { keep = e; break; }
    }
    const loserEvidence = Array.isArray(loser.evidence) ? (loser.evidence as unknown[]).map((x) => pyStr(x)) : [];
    let retired = 0;
    for (const eid of loserEvidence) {
      const [ok] = this.set_status(eid, "stale", {
        reason: `claim_superseded_by:${pyStr(winner.id)}`, superseded_by: keep,
      });
      if (ok) retired += 1;
    }
    if (retired) return [true, `已保留你选的那条，顺带把 ${retired} 条来源记忆标成过时`];
    return [true, "已保留你选的那条"];
  }

  /**
   * 一条长期知识的来龙去脉。拿不到可靠时间的事件一律 ts=0 且 dated=false，
   * 垫在时间线后面。任何一个来源查不到都跳过。
   */
  async trace(item_id: string): Promise<JsonDict> {
    const item = this.get(item_id);
    if (item === null) return {};
    const events: JsonDict[] = [];

    const ev = (ts: unknown, kind: string, text: string, extra: JsonDict = {}): void => {
      events.push({ ts: pyIntCoerce(pyOr(ts, 0)), dated: pyTruth(ts), kind, text, ...extra });
    };

    if (item.kind === KIND_CLAIM) {
      const claim = this.wiki.get(item.id);
      if (claim !== null && claim !== undefined) {
        ev(claim.createdAt, "created",
          `断言写下：${pyStr(claim.subject)} / ${pyStr(claim.predicate)} = ${pyStr(claim.object)}`,
          { source: claim.source });
        const evidence = Array.isArray(claim.evidence) ? (claim.evidence as unknown[]).map((x) => pyStr(x)) : [];
        for (const e of evidence) ev(0, "evidence", `证据来自记忆 ${e}`, { ref: e });
        const contradicts = Array.isArray(claim.contradicts) ? (claim.contradicts as unknown[]).map((x) => pyStr(x)) : [];
        for (const c of contradicts) ev(0, "conflict", `与断言 ${c} 互相矛盾`, { ref: c });
        if (claim.status !== "active") {
          const sr = pyStrOr(pyOr(claim.statusReason, ""), "");
          ev(claim.updatedAt, "status",
            `当前状态 ${pyStr(claim.status)}` + (sr ? `：${sr}` : ""));
        }
      }
      return { item: item.to_api(), events: MemoryDomain._sorted(events) };
    }

    const raw = this.storage._db("memory")
      .execute("SELECT * FROM memory_entries WHERE id=?", [item.id]).fetchone();
    if (raw === null || raw === undefined) {
      // py: dict(None) —— TypeError 文本逐字保留
      throw new Error("TypeError: 'NoneType' object is not iterable");
    }
    const row: JsonDict = { ...raw };

    const whoMap: Record<string, string> = {
      user: "你亲手写的", agent: "对话里自动提取的",
      evolution: "演化环提出的", import: "导入的",
    };
    const createdBy = pyStrOr(pyOr(row["created_by"], ""), "");
    const who = createdBy in whoMap ? whoMap[createdBy] : "来源未记录";
    ev(row["created_at"], "created", `写入：${who}`, { createdBy: pyOr(row["created_by"], "") });
    if (pyTruth(row["source_goal_id"])) {
      ev(0, "source", `来自目标 ${pyStr(row["source_goal_id"])}`, { ref: row["source_goal_id"] });
    }
    for (const eid of _as_tags(row["source_event_ids"])) {
      ev(0, "source", `依据事件 ${eid}`, { ref: eid });
    }

    events.push(...(await this._dream_trace(item.id)));

    for (const peer of _as_tags(row["conflict_set"])) {
      ev(0, "conflict", `与记忆 ${peer} 互相矛盾（等你裁决）`, { ref: peer });
    }
    for (const src of _as_tags(row["supersedes"])) {
      ev(0, "proposal", `若批准，将取代记忆 ${src}`, { ref: src });
    }
    if (pyTruth(row["superseded_by"])) {
      ev(0, "superseded", `已被记忆 ${pyStr(row["superseded_by"])} 取代`, { ref: row["superseded_by"] });
    }

    const confirmed = pyIntCoerce(pyOr(row["last_confirmed_at"], 0));
    if (confirmed && confirmed !== pyIntCoerce(pyOr(row["created_at"], 0))) {
      ev(confirmed, "confirmed", "又被证实了一次（新鲜度按这个时间算）");
    }

    const status = pyStrOr(pyOr(row["status"], "active"), "active");
    if (status !== "active") {
      const sr = pyTruth(row["status_reason"]) ? `：${pyStr(row["status_reason"])}` : "";
      ev(row["updated_at"], "status", `当前状态 ${status}${sr}`);
    }

    const mirror = this.wiki.get(`m-${item.id}`);
    if (mirror !== null && mirror !== undefined) {
      ev(mirror.createdAt, "wiki",
        `结构化镜像：${pyStr(mirror.subject)} / ${pyStr(mirror.predicate)} = ${pyStr(mirror.object)}` +
        `（${pyStr(mirror.status)}）`,
        { ref: mirror.id });
    }

    return { item: item.to_api(), events: MemoryDomain._sorted(events) };
  }

  /** 有时间的按时间升序排在前，没时间的（"现状"类）按原顺序垫在后面。 */
  static _sorted(events: JsonDict[]): JsonDict[] {
    const dated = events.filter((e) => e["dated"]);
    dated.sort((a, b) => (a["ts"] as number) - (b["ts"] as number));
    const undated = events.filter((e) => !e["dated"]);
    return [...dated, ...undated];
  }

  /** 这条记忆是哪一趟 Dream 提出来的，那一趟凭什么这么判。演化库不可用就只报 Dream 那半边。 */
  async _dream_trace(eid: string): Promise<JsonDict[]> {
    const out: JsonDict[] = [];
    let run: Row | null = null;
    try {
      run = this.storage._db("memory")
        .execute("SELECT * FROM dream_runs WHERE proposal_id=?", [eid]).fetchone();
    } catch {
      run = null;
    }
    if (run === null || run === undefined) return out;
    const r: JsonDict = { ...run };
    out.push({
      ts: pyIntCoerce(pyOr(r["started_at"], 0)),
      dated: pyTruth(r["started_at"]),
      kind: "dream",
      text: `由整合任务 ${pySlice8(pyStr(r["job_id"]))} 提出：${pyStrOr(r["outcome"], "")}`,
      ref: pyOr(r["job_id"], ""),
      inputCount: pyIntCoerce(pyOr(r["input_count"], 0)),
      tokensUsed: pyIntCoerce(pyOr(r["tokens_used"], 0)),
    });
    try {
      const mod = await _import_unported("evolution");
      const engine = mod.get_evolution_engine();
      // kwargs→opts 契约（evolution_bridge 同款）：未来的 evolution.ts 必须
      // 接受 list_observations({limit}) 这个形状。
      const obsList = (pyOr(engine.store.list_observations({ limit: 200 }), []) as JsonDict[]);
      for (const o of obsList) {
        if (pyStr(pyOr(o["runId"], "")) !== pyStr(pyOr(r["job_id"], ""))) continue;
        out.push({
          ts: pyIntCoerce(pyFloatCoerce(pyOr(o["createdAt"], 0))),
          dated: pyTruth(o["createdAt"]),
          kind: "observation",
          text: `演化观察判定 ${pyStr(o["decision"])}：${pyStrOr(pyOr(o["reason"], ""), "")}`,
          ref: pyOr(o["id"], ""),
        });
      }
    } catch (e) {
      console.log(`[memory] 观察台账没读到：${pyStrExc(e)}`);
    }
    return out;
  }

  // ── 冲突与重复 ──────────────────────────────────────────────────────────
  /**
   * 需要人裁决的分歧。只报已经记录下来的矛盾关系，不在读的时候再猜一遍——
   * 一个偶尔虚报矛盾的冲突视图比没有更糟。
   */
  conflicts(root: string, limit: number = 50): JsonDict[] {
    const out: JsonDict[] = [];
    // 记忆侧。冲突里的新行是 candidate（不算活），所以不能按 live 过滤。
    let items: MemoryItem[];
    try {
      [items] = this.list_items(root, {
        kinds: [KIND_ENTRY], statuses: ["candidate", "active", "stale"], limit: null,
      });
    } catch (exc) {
      _logWarning(`[memory_domain] conflicts: memory unavailable: ${pyStrExc(exc)}`);
      items = [];
    }
    const seen = new Set<string>();
    // 已裁决的那一边不再算分歧：用户把 candidate 归档掉，就是他已经选了老的。
    const unsettled = ["candidate", "active", "stale"];
    for (const it of items) {
      if (!it.conflicts.length || seen.has(it.id)) continue;
      const mem_peers: MemoryItem[] = [];
      for (const pid of it.conflicts) {
        const peer = this.get(String(pid));
        if (peer === null || !unsettled.includes(peer.status)) continue;
        mem_peers.push(peer);
        seen.add(peer.id); // 关系是对称的，同一组别报两遍
      }
      if (!mem_peers.length) continue;
      seen.add(it.id);
      out.push({ claim: it, peers: mem_peers });
      if (out.length >= pyIntCoerce(limit)) return out;
    }

    let disputed: ClaimLike[];
    try {
      disputed = pyOr(this.wiki.disputed(root, pyIntCoerce(limit)), []) as ClaimLike[];
    } catch (exc) {
      _logWarning(`[memory_domain] conflicts: wiki unavailable: ${pyStrExc(exc)}`);
      return out;
    }
    for (const claim of disputed) {
      const peers: MemoryItem[] = [];
      const contra = Array.isArray(claim.contradicts) ? (claim.contradicts as unknown[]) : [];
      for (const pid of contra) {
        const peer = this.wiki.get(pyStr(pid));
        if (peer === null || peer === undefined) continue;
        const peer_item = item_from_claim(peer);
        if (peer_item.live) peers.push(peer_item);
      }
      out.push({ claim: item_from_claim(claim), peers });
      if (out.length >= pyIntCoerce(limit)) break;
    }
    return out;
  }

  /**
   * 待批的合并：candidate + 非空 supersedes 就是提案。批准之前，被指向的行
   * 一条都不动。只看 candidate——active 行还留着 supersedes 是历史记录。
   */
  pending_merges(root: string, opts: { limit?: number } = {}): JsonDict[] {
    const limit = opts.limit === undefined ? 50 : opts.limit;
    const out: JsonDict[] = [];
    let items: MemoryItem[];
    try {
      [items] = this.list_items(root, { kinds: [KIND_ENTRY], statuses: ["candidate"], limit: null });
    } catch (exc) {
      _logWarning(`[memory_domain] pending_merges unavailable: ${pyStrExc(exc)}`);
      return out;
    }
    for (const it of items) {
      if (!it.supersedes.length) continue;
      // 只算还没被处置的素材；已经归档/驳回的不再列出来重复陈述。
      const sources: MemoryItem[] = [];
      for (const sid of it.supersedes) {
        const s = this.get(String(sid));
        if (s === null || s.status === "archived" || s.status === "rejected") continue;
        sources.push(s);
      }
      // 要替掉的那几条全都不在了：提案失去意义，但这里只读不写。
      if (!sources.length) continue;
      out.push({ proposal: it, sources });
      if (out.length >= pyIntCoerce(limit)) break;
    }
    return out;
  }

  /**
   * 批准一份合并提案。顺序有意：先候选生效、再归档旧的——宁可短暂两边都在，
   * 也不要短暂两边都没有。
   */
  async approve_merge(item_id: string, opts: { reason?: string } = {}): Promise<[boolean, string]> {
    const reason = opts.reason === undefined ? "user_approved" : opts.reason;
    const item = this.get(item_id);
    if (item === null) return [false, "找不到这一条"];
    if (item.kind !== KIND_ENTRY) return [false, "断言没有合并提案这个概念"];
    if (!item.supersedes.length) return [false, "这一条不是待批的合并"];
    const [ok, why] = this.set_status(item.id, "active", { reason });
    if (!ok) return [false, why];
    let archived = 0;
    const failed: string[] = [];
    for (const sid of item.supersedes) {
      const [done, msg] = this.set_status(pyStr(sid), "archived", {
        reason: `merged_into:${item.id}`, superseded_by: item.id,
      });
      if (done) archived += 1;
      else failed.push(`${pyStr(sid)}: ${msg}`);
    }
    // 提案已落地，supersedes 从"待办"变成历史，清空才不会再出现在待批列表。
    this.storage.clear_memory_supersedes(item.id);
    await this._mark_bundle_verdict(item.id, "approved");
    if (failed.length) {
      return [true, `已生效，但有 ${failed.length} 条没归档：` + failed.join("; ")];
    }
    return [true, `已生效，归档了 ${archived} 条`];
  }

  /**
   * 驳回一份合并提案：候选归档（不是 rejected 墓碑——用户过一阵可能想回头
   * 看 Dream 当时想说什么），被它指向的那几条一个都不动。
   */
  async reject_merge(item_id: string, opts: { reason?: string } = {}): Promise<[boolean, string]> {
    const reason = opts.reason === undefined ? "user_rejected" : opts.reason;
    const item = this.get(item_id);
    if (item === null) return [false, "找不到这一条"];
    if (!item.supersedes.length) return [false, "这一条不是待批的合并"];
    const [ok, why] = this.set_status(item.id, "archived", { reason });
    if (!ok) return [false, why];
    this.storage.clear_memory_supersedes(item.id);
    await this._mark_bundle_verdict(item.id, "rejected");
    return [true, "已驳回，原来那几条保持不变"];
  }

  /**
   * 内容等价的活记忆，按组返回（每组 2 条以上）。归一化口径和
   * storage.find_memories_by_content 一致；刻意只认等价，模糊是有害的。
   */
  duplicates(root: string, opts: { limit?: number } = {}): MemoryItem[][] {
    const limit = opts.limit === undefined ? 50 : opts.limit;
    const buckets = new Map<string, MemoryItem[]>();
    const [items] = this.list_items(root, { kinds: [KIND_ENTRY], live_only: true, limit: null });
    for (const it of items) {
      // py: re.sub(r"[\s\W_]+", "", content.lower())——只留 Unicode 字母数字
      const key = it.content.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
      if (!key) continue;
      const g = buckets.get(key);
      if (g) g.push(it);
      else buckets.set(key, [it]);
    }
    const groups = [...buckets.values()].filter((g) => g.length > 1);
    // 组内最近动过的在前；组间按组大小、再按最新修改。
    for (const g of groups) g.sort((a, b) => b.updated_at - a.updated_at);
    groups.sort((a, b) => {
      if (a.length !== b.length) return b.length - a.length;
      return b[0]!.updated_at - a[0]!.updated_at;
    });
    return pyTruth(limit) ? groups.slice(0, Math.max(0, pyIntCoerce(limit))) : groups;
  }

  /** 一个 workspace 的长期知识概况，两张表用同一套状态名汇总。 */
  stats(root: string): JsonDict {
    const [items, total] = this.list_items(root, { limit: null });
    const by_status: Record<string, number> = {};
    for (const s of STATUSES) by_status[s] = 0;
    const by_kind: Record<string, number> = {};
    for (const k of KINDS) by_kind[k] = 0;
    let live = 0;
    let expiring = 0;
    const now = _now();
    for (const it of items) {
      by_status[it.status] = (by_status[it.status] ?? 0) + 1;
      by_kind[it.kind] = (by_kind[it.kind] ?? 0) + 1;
      if (it.live) live += 1;
      // "快过期了"取 7 天，纯粹是给界面一个提醒窗口。
      if (it.valid_until && now < it.valid_until && it.valid_until <= now + 7 * 86400) expiring += 1;
    }
    return {
      root,
      total,
      live,
      expiringSoon: expiring,
      byStatus: by_status,
      byKind: by_kind,
      conflicts: this.conflicts(root, 1000).length,
    };
  }

  /** 把过期的记忆落成 stale，返回条数。断言没有过期时间，所以只扫记忆。 */
  sweep(root: string | null = null): number {
    return pyIntCoerce(pyOr(this.storage.sweep_expired_memories(root), 0));
  }

  /** 对候选记忆执行时间半衰期衰减与 MMR 多样性重排序。 */
  rank_and_deduplicate(
    query: string, items: MemoryItem[], limit: number = 5,
    lambda_param: number = 0.7, halflife_days: number = 30.0,
  ): MemoryItem[] {
    return maximal_marginal_relevance(query, items, limit, lambda_param, halflife_days);
  }

  /** 检测主体与谓词相同、客体矛盾的现有活跃断言/记忆。 */
  detect_spo_conflicts(root: string, subject: string, predicate: string, object_: string): MemoryItem[] {
    if (!subject || !predicate || !object_) return [];
    const [items] = this.list_items(root, { live_only: true, limit: 500 });
    const conflicts: MemoryItem[] = [];
    const norm_s = pyStrip(subject).toLowerCase();
    const norm_p = pyStrip(predicate).toLowerCase();
    const norm_o = pyStrip(object_).toLowerCase();
    for (const it of items) {
      const it_s = pyStrip(it.subject || "").toLowerCase();
      const it_p = pyStrip(it.predicate || "").toLowerCase();
      const it_o = pyStrip(it.object || "").toLowerCase();
      if (it_s === norm_s && it_p === norm_p && it_o && it_o !== norm_o) conflicts.push(it);
    }
    return conflicts;
  }
}

/**
 * time-decay weighted score：w(t)=2^(-Δt/halflife)，与置信度/重要性/访问热度/
 * 引用加成混合。max(0.05, min(1.0, conf)) 的两端钳制用 Python 两参语义
 * （NaN 时 min 保留 1.0、max 保留 0.05——见 pyMin2/pyMax2 注释）。
 */
export function compute_time_decay_score(
  item: MemoryItem, halflife_days: number = 30.0, now: number | null = null,
): number {
  const current_ts = now !== null ? now : _now();
  const created_ts = pyOr(item.created_at, current_ts) as number;
  const created_delta_days = pyMax2(0.0, (current_ts - created_ts) / 86400.0);

  let effective_delta_days: number;
  if (item.last_accessed_at && item.last_accessed_at > 0) {
    const access_delta_days = pyMax2(0.0, (current_ts - item.last_accessed_at) / 86400.0);
    effective_delta_days = 0.2 * created_delta_days + 0.8 * access_delta_days;
  } else {
    effective_delta_days = created_delta_days;
  }

  const decay = Math.pow(0.5, effective_delta_days / pyMax2(1.0, halflife_days));
  const citation_bonus = pyMin2(1.5, 1.0 + 0.1 * Math.log1p(pyMax2(0, item.hits)));
  const conf = pyMax2(0.05, pyMin2(1.0, item.confidence));
  const imp = pyMax2(0.05, pyMin2(1.0, item.importance));
  return conf * (0.6 + 0.4 * imp) * decay * citation_bonus;
}

function _tokenize(text: string): Set<string> {
  // py: set(re.findall(r'[\w]+', text.lower()))——Unicode 词类，见 DIVERGENCE(5)
  const m = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  return new Set(m ?? []);
}

function _sim(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0.0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? inter / union : 0.0;
}

/** MMR：从候选里选一组多样且相关的条目（limit 条以内）。 */
export function maximal_marginal_relevance(
  query: string, candidates: MemoryItem[], limit: number = 5,
  lambda_param: number = 0.7, halflife_days: number = 30.0,
): MemoryItem[] {
  if (!candidates.length || limit <= 0) return [];
  if (candidates.length <= limit) {
    const sorted = [...candidates];
    sorted.sort((a, b) =>
      compute_time_decay_score(b, halflife_days) - compute_time_decay_score(a, halflife_days));
    return sorted;
  }

  const q_tokens = _tokenize(pyStrOr(query, ""));

  const cand_tokens = candidates.map((c) => _tokenize(c.content));
  const relevance_scores: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const query_sim = q_tokens.size ? _sim(q_tokens, cand_tokens[i]!) : 0.5;
    const decay_score = compute_time_decay_score(candidates[i]!, halflife_days);
    relevance_scores.push(0.5 * query_sim + 0.5 * decay_score);
  }

  const selected_indices: number[] = [];
  const remaining_indices: number[] = candidates.map((_, i) => i);

  for (let _ = 0; _ < Math.min(limit, candidates.length); _++) {
    let best_idx = -1;
    let best_score = -Infinity;

    for (const idx of remaining_indices) {
      const rel = relevance_scores[idx]!;
      let redundancy = 0.0;
      if (selected_indices.length) {
        redundancy = -Infinity;
        for (const s of selected_indices) {
          const v = _sim(cand_tokens[idx]!, cand_tokens[s]!);
          if (v > redundancy) redundancy = v;
        }
      }
      const mmr_score = lambda_param * rel - (1.0 - lambda_param) * redundancy;
      if (mmr_score > best_score) {
        best_score = mmr_score;
        best_idx = idx;
      }
    }

    if (best_idx >= 0) {
      selected_indices.push(best_idx);
      remaining_indices.splice(remaining_indices.indexOf(best_idx), 1);
    } else {
      break;
    }
  }

  return selected_indices.map((i) => candidates[i]!);
}

let _domain: MemoryDomain | null = null;

/** 进程内单例。依赖是懒加载的，所以拿它本身不会碰数据库。 */
export function get_memory_domain(): MemoryDomain {
  if (_domain === null) _domain = new MemoryDomain();
  return _domain;
}

// PORT STATUS: confidence=high todos=[0]
