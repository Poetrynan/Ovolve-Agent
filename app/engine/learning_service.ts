/**
 * learning_service.ts — LearningItem 统一操作服务（Canonical Mutation Saga）。
 *
 * Ported from `app/backend/learning_service.py` (776 行, wave-8, unit 179)。
 *
 * 完整臂清单 / bug-for-bug 事实 F00–F55（逐条与探针场景对应）：
 * `D:/ovolve-migration/tmp/ls_branches.md`；对拍记录：`verified/learning_service.json`。
 *
 * 本文件只保留"读代码时会踩到"的几条硬事实，其余按 §编号在原地注释：
 *   F00 模块级 `from scope_guard import validate_scope` 是导入期硬依赖但符号未用
 *       → 端口用副作用 import 复刻（TS 会擦除未使用的具名导入）。
 *   F01 `user_id="local_user"` 形参在 `decide` 里一次都没用到。
 *   F02 `storage or get_storage()`：假值（0/""/False/None）都退回单例，不是 `is None`。
 *   F05/F06/F09/F17 `str(item.get(...) or 默认)` 的 `or` 链 + `str()` 强转。
 *   F07 作用域闸只在 `scope != "global"` 时生效；四条文案逐字。
 *   F13 幂等复入命中终态时**就地改**缓存 result 对象再返回。
 *   F16 未知 op_status 直接向下执行且用新 operation_id（原码漏洞，保留）。
 *   F19 approve 白名单外返回体的 `status` 是**当前状态本身**。
 *   F22/F42 `failure_guard/strategy/optimization`（及 revoke 的未知 kind）零底层动作直接 landed。
 *   F26/F31/F37/F45 多处"返回体用兜底文案、台账用原始空串"的不对称，逐处钉住。
 *   F27 失败事件包在 `try/except Exception: pass` 且结果不检查。
 *   F28 reject 的底层调用带 `and ref`：memory_fact 空 ref 静默跳过（与 approve 相反）。
 *   F35 `hasattr(engine.store,"update_draft")`：`engine.store` 求值本身可抛 AttributeError。
 *   F36 skill edit 就地改 dict + 两次 `_db("skills")`（execute 与 commit 各取一次）。
 *   F40 revoke/memory 回读验证：`md.get()` 返回 None 视为成功。
 *   F44 revoke 的 CAS 失败 status **恒为 unknown**（approve 会出 version_conflict）。
 *   F49 `float(op.get("created_at") or 0)` 的 ValueError 冒泡出整个 reconcile；
 *       `age = now - created_at if created_at else 0`（三元绑整个表达式；NaN 是真值）。
 *   F52 reconcile 的事件 append 是**位置参数**（decide 里是三关键字）。
 *   F53 age ≤ 300 且实物不在 → 本轮静默跳过，什么都不记。
 *   F54 skill_step 没有 revoke 实物核对（恒 False，只能等超时）。
 *   F55 收尾日志整段是 python list/dict repr（单引号、True/False/None）。
 *
 * DIVERGENCE(port, import-time edge): 见 F00，副作用 import 保留加载依赖。
 * DIVERGENCE(port, late import → seam): 六处函数内导入（evolution / skill_lifecycle /
 *   skill_loader / memory_domain / storage / event_types）走 `LS_SEAMS` 模块装载器，
 *   默认值 = 静态 import 的已落地端口命名空间，与 python"调用时才解析、ImportError
 *   按各自 except 臂冒泡"同形。
 * DIVERGENCE(port, str/repr): f-string 与 list repr 走 pyStr/pyRepr，不用 JSON。
 * DIVERGENCE(port, kwargs): python 关键字实参按被调方形参顺序位置化；被调方形参具名，
 *   顺序无语义，两侧假件都按签名序记账。
 * DIVERGENCE(port, missing attr): hasattr/getattr 用 hasAttrPy/getattrPy 复刻，
 *   AttributeError 文案与 CPython 一致。
 *
 * NOTE: 状态机白名单、幂等复入、CAS、实物回读验证、超时判定全部是代码裁决，
 *   没有任何一处把判断交给模型。
 *
 * PORT STATUS: 本文件无 TODO(port)。
 */

import { get_storage as _real_get_storage } from "./storage.js";
import { EventType as _real_EventType } from "./event_types.js";
import * as _evolution_mod from "./evolution.js";
import * as _skill_lifecycle_mod from "./skill_lifecycle.js";
import * as _skill_loader_mod from "./skill_loader.js";
import * as _memory_domain_mod from "./memory_domain.js";
// python: from scope_guard import validate_scope（符号未用，但导入期依赖真实存在）
import "./scope_guard.js";

// ── python-semantics helpers (house style: file-local) ───────────────────────

type JsonDict = Record<string, unknown>;
type AnyMod = JsonDict;

class AttributeErrorP extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AttributeError";
  }
}
class TypeErrorP extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "TypeError";
  }
}
class ValueErrorP extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ValueError";
  }
}

/** python truthiness。 */
function pyTruth(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") {
    const withLen = v as { __len?: () => number };
    if (typeof withLen.__len === "function") return withLen.__len() !== 0;
    return true;
  }
  return Boolean(v);
}

/** python `a or b`。 */
function pyOr<T, U>(a: T, b: U): T | U {
  return pyTruth(a) ? a : b;
}

function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  let s = String(x);
  if (!/[.eE]/.test(s)) s += ".0";
  return s;
}

/** python `repr(str)`：单引号优先，含单引号不含双引号时改双引号。 */
function pyStrRepr(s: string): string {
  let body = "";
  for (const ch of s) {
    if (ch === "\\") body += "\\\\";
    else if (ch === "\n") body += "\\n";
    else if (ch === "\r") body += "\\r";
    else if (ch === "\t") body += "\\t";
    else {
      const c = ch.codePointAt(0) ?? 0;
      if (c < 0x20 || (c >= 0x7f && c <= 0xa0)) body += "\\x" + c.toString(16).padStart(2, "0");
      else body += ch;
    }
  }
  if (body.includes("'") && !body.includes('"')) return '"' + body + '"';
  return "'" + body.replace(/'/g, "\\'") + "'";
}

/** python `repr(x)`（dict/list 单引号、True/False/None）。 */
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") {
    return Number.isInteger(v) && Math.abs(v) < 1e21 ? String(v) : pyFloatRepr(v);
  }
  if (typeof v === "string") return pyStrRepr(v);
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (v instanceof Error) return `${v.name}(${pyStrRepr(v.message)})`;
  if (typeof v === "object") {
    if (v instanceof Map) {
      const parts: string[] = [];
      for (const [k, val] of v) parts.push(`${pyRepr(k)}: ${pyRepr(val)}`);
      return "{" + parts.join(", ") + "}";
    }
    const parts: string[] = [];
    for (const k of Object.keys(v as JsonDict)) {
      parts.push(`${pyStrRepr(k)}: ${pyRepr((v as JsonDict)[k])}`);
    }
    return "{" + parts.join(", ") + "}";
  }
  return String(v);
}

/** python `str(x)`。 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") {
    return Number.isInteger(v) && Math.abs(v) < 1e21 ? String(v) : pyFloatRepr(v);
  }
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.message;
  return pyRepr(v);
}

/** python `str(exc)`：单参异常就是 message。 */
function pyStrExc(e: unknown): string {
  if (e instanceof Error) return e.message;
  return pyStr(e);
}

/** python `bool(x)`。 */
function pyBool(v: unknown): boolean {
  return pyTruth(v);
}

/** CPython 的 Unicode 空白集（含 \x85、\x1c–\x1f；不含 \ufeff）。 */
const PY_WS =
  /[\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

function pyStrip(s: unknown): string {
  if (typeof s !== "string") {
    throw new AttributeErrorP(`'${pyTypeName(s)}' object has no attribute 'strip'`);
  }
  let a = 0;
  let b = s.length;
  while (a < b && PY_WS.test(s[a] as string)) a++;
  while (b > a && PY_WS.test(s[b - 1] as string)) b--;
  return s.slice(a, b);
}

/** python `dict.get(k)` / `dict.get(k, dflt)`：键存在即取，值为 None 不回退。 */
function dictGet(d: unknown, k: string, dflt: unknown = undefined): unknown {
  if (d === null || d === undefined || typeof d !== "object") {
    throw new AttributeErrorP(`'${pyTypeName(d)}' object has no attribute 'get'`);
  }
  if (typeof (d as { get?: unknown }).get === "function" && !isPlainDict(d)) {
    return (d as { get: (key: string, fallback?: unknown) => unknown }).get(k, dflt);
  }
  if (isPlainDict(d) || d instanceof Map) {
    if (d instanceof Map) return d.has(k) ? d.get(k) : dflt;
    const rec = d as JsonDict;
    if (Object.prototype.hasOwnProperty.call(rec, k)) return rec[k];
    return dflt;
  }
  throw new AttributeErrorP(`'${pyTypeName(d)}' object has no attribute 'get'`);
}

function isPlainDict(d: unknown): boolean {
  return !!(d && typeof d === "object" && !Array.isArray(d) && !(d instanceof Map));
}

/** python `type(x).__name__`（探针两侧同名类对齐）。 */
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

/** python `hasattr(obj, name)`：属性不存在只返回 False，不抛。 */
function hasAttrPy(obj: unknown, name: string): boolean {
  if (obj === null || obj === undefined) return false;
  if (obj instanceof Map) return (obj as Map<string, unknown>).has(name);
  return (obj as JsonDict)[name] !== undefined ||
    Object.prototype.hasOwnProperty.call(obj as JsonDict, name);
}

/** python `getattr(obj, name, dflt)`：属性缺失走默认值。 */
function getattrPy(obj: unknown, name: string, dflt: unknown): unknown {
  if (obj === null || obj === undefined) return dflt;
  if (obj instanceof Map) {
    const m = obj as Map<string, unknown>;
    return m.has(name) ? m.get(name) : dflt;
  }
  const rec = obj as JsonDict;
  return Object.prototype.hasOwnProperty.call(rec, name) ? rec[name] : dflt;
}

/** python `obj.name`：缺失属性抛 AttributeError（文案同 CPython 3.13）。 */
function getAttrThrow(obj: unknown, name: string): unknown {
  if (obj === null || obj === undefined) {
    throw new AttributeErrorP(
      `'${obj === null ? "NoneType" : "undefined"}' object has no attribute '${name}'`
    );
  }
  const rec = obj as JsonDict;
  if (Object.prototype.hasOwnProperty.call(rec, name) || name in (obj as object)) return rec[name];
  throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute '${name}'`);
}

/** python `float(x)`：假值 0；str 解析规则与 ValueError 文案照搬。 */
function pyFloat(x: unknown): number {
  if (typeof x === "number") return x;
  if (typeof x === "boolean") return x ? 1 : 0;
  if (x === null || x === undefined) {
    throw new TypeErrorP("float() argument must be a string or a real number, not 'NoneType'");
  }
  if (typeof x === "string") {
    const t = pyStrip(x);
    if (/^[+-]?(inf|infinity|nan)$/i.test(t)) {
      if (/nan$/i.test(t)) return NaN;
      return t.startsWith("-") ? -Infinity : Infinity;
    }
    if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(t) && t.search(/[0-9]/) >= 0) {
      return Number(t.replace(/_/g, ""));
    }
    throw new ValueErrorP(`could not convert string to float: ${pyStrRepr(x)}`);
  }
  throw new TypeErrorP(`float() argument must be a string or a real number, not '${pyTypeName(x)}'`);
}

/** python `==`（bool 与 int 互通，str 与 int 不互通）。 */
function pyEq(a: unknown, b: unknown): boolean {
  if (typeof a === "boolean") a = a ? 1 : 0;
  if (typeof b === "boolean") b = b ? 1 : 0;
  if (a === null) a = undefined;
  if (b === null) b = undefined;
  return a === b;
}

/** python `json.dumps(value, ensure_ascii=False)`（只覆盖端口用到的标量/数组/字典）。 */
function jsonDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return jsonNum(v);
  if (typeof v === "string") return jsonStr(v);
  if (Array.isArray(v)) return "[" + v.map(jsonDumps).join(", ") + "]";
  if (v instanceof Map) {
    const parts: string[] = [];
    for (const [k, val] of v) parts.push(`${jsonStr(String(k))}: ${jsonDumps(val)}`);
    return "{" + parts.join(", ") + "}";
  }
  const parts: string[] = [];
  for (const k of Object.keys(v as JsonDict)) {
    parts.push(`${jsonStr(k)}: ${jsonDumps((v as JsonDict)[k])}`);
  }
  return "{" + parts.join(", ") + "}";
}

function jsonNum(v: number): string {
  if (Number.isInteger(v)) return String(v);
  let s = String(v);
  if (!/[.eE]/.test(s)) s += ".0";
  return s;
}

function jsonStr(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch; // ensure_ascii=False：非 ASCII 原样输出（含 \u2028/\u2029）
  }
  return out + '"';
}

// ── seams（python 的模块全局与函数内导入在这里可替换；默认值 = 真端口） ──────────

export interface LoggerLike {
  warning(msg: string): void;
  info(msg: string): void;
  exception(msg: string): void;
}

export const LS_SEAMS = {
  /** python 模块全局 `get_storage`。 */
  get_storage: (): unknown => _real_get_storage(),
  /** python 模块全局 `EventType`（enum 对象的镜像：取值即字符串）。 */
  EventType: _real_EventType as unknown as JsonDict,
  /** python `import evolution`（调用时现查）。 */
  evolutionModule: (): AnyMod => _evolution_mod as unknown as AnyMod,
  /** python `import skill_lifecycle`。 */
  skillLifecycleModule: (): AnyMod => _skill_lifecycle_mod as unknown as AnyMod,
  /** python `from skill_loader import get_skill_loader`。 */
  skillLoaderModule: (): AnyMod => _skill_loader_mod as unknown as AnyMod,
  /** python `from memory_domain import MemoryDomain`。 */
  memoryDomainModule: (): AnyMod => _memory_domain_mod as unknown as AnyMod,
  /** reconcile 内 `from storage import get_storage`（与模块全局是两次解析）。 */
  get_storage_local: (): unknown => _real_get_storage(),
  /** python `time.time()`（reconcile 用）。 */
  now: (): number => Date.now() / 1000,
  /** python `uuid.uuid4().hex[:12]`。 */
  uuid_hex12: (): string => {
    let s = "";
    while (s.length < 12) s += Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
    return s.slice(0, 12);
  },
  /** python `logger`（logging.getLogger("learning_service")）。 */
  logger: {
    warning: (m: string) => console.warn(`WARNING:learning_service:${m}`),
    info: (m: string) => console.info(`INFO:learning_service:${m}`),
    exception: (m: string) => console.error(`ERROR:learning_service:${m}`),
  } as LoggerLike,
};

/** 探针用：整体替换 seams（对应 python 侧 monkeypatch 模块全局）。 */
export function _set_seams_for_parity(patch: Partial<typeof LS_SEAMS>): void {
  Object.assign(LS_SEAMS, patch);
}

/** 探针用：恢复默认实现（对应 python 侧 reload）。 */
export function _reset_seams_for_parity(): void {
  LS_SEAMS.get_storage = (): unknown => _real_get_storage();
  LS_SEAMS.EventType = _real_EventType as unknown as JsonDict;
  LS_SEAMS.evolutionModule = (): AnyMod => _evolution_mod as unknown as AnyMod;
  LS_SEAMS.skillLifecycleModule = (): AnyMod => _skill_lifecycle_mod as unknown as AnyMod;
  LS_SEAMS.skillLoaderModule = (): AnyMod => _skill_loader_mod as unknown as AnyMod;
  LS_SEAMS.memoryDomainModule = (): AnyMod => _memory_domain_mod as unknown as AnyMod;
  LS_SEAMS.get_storage_local = (): unknown => _real_get_storage();
  LS_SEAMS.now = (): number => Date.now() / 1000;
  LS_SEAMS.logger = DEFAULT_LOGGER;
}

const DEFAULT_LOGGER: LoggerLike = LS_SEAMS.logger;

// ── 被调方形状（python 的 duck typing；真实实现是已落地的 storage 端口） ─────────

interface EventStoreLike {
  append(session_id: string, event_type: string, payload: JsonDict, opts?: JsonDict): unknown;
}
interface DbLike {
  execute(sql: string, params?: unknown[]): unknown;
  commit(): unknown;
}
interface LearningStorage {
  get_learning_item(item_id: string): JsonDict | null;
  update_learning_item(
    item_id: string, status?: string | null, user_verdict?: string | null,
    deferred_reason?: string | null, content?: string | null, operation_id?: string | null,
    idempotency_key?: string | null, expected_version?: number | null
  ): boolean;
  claim_learning_item_operation(
    operation_id: string, item_id: string, action: string, idempotency_key?: string,
    payload?: JsonDict | null
  ): [boolean, JsonDict];
  update_learning_item_operation(
    operation_id: string, status?: string | null, result?: JsonDict | null,
    error?: string | null
  ): boolean;
  get_event_store(): EventStoreLike;
  get_skill_candidate(cid: string): JsonDict | null;
  list_skill_candidates(status?: string | null, limit?: number): JsonDict[];
  list_hanging_learning_item_operations(limit?: number): JsonDict[];
  _db(name: string): DbLike;
}

export interface DecideOpts {
  session_id?: string;
  branch_id?: string;
  expected_version?: number | null;
  idempotency_key?: string;
  edited_content?: string | null;
  reason?: string;
  user_id?: string;
}

const APPROVE_WHITELIST: readonly string[] = [
  "proposed", "staged", "deferred", "discovered", "validating",
];
const CLAIM_TERMINAL: readonly string[] = [
  "verified", "landed", "published", "rejected", "deferred", "rolled_back",
];

export class LearningItemService {
  storage: LearningStorage;

  /** F02: `storage or get_storage()` —— 假值也退回单例。 */
  constructor(storage: unknown = null) {
    this.storage = (pyOr(storage, LS_SEAMS.get_storage()) as LearningStorage);
  }

  decide(item_id: string, action: string, opts: DecideOpts = {}): JsonDict {
    const session_id = opts.session_id ?? "";
    const branch_id = opts.branch_id ?? "";
    const expected_version = opts.expected_version === undefined ? null : opts.expected_version;
    const idempotency_key = opts.idempotency_key ?? "";
    const edited_content = opts.edited_content === undefined ? null : opts.edited_content;
    const reason = opts.reason ?? "";
    // F01: `user_id` 形参在原码里从未被读取，这里同样只是收下不用。
    void (opts.user_id ?? "local_user");

    if (!item_id || !action) {
      return { ok: false, error: "item_id and action are required", status: "invalid_request" };
    }

    const item = this.storage.get_learning_item(item_id);
    if (!item) return { ok: false, error: "Learning item not found", status: "not_found" };

    const actual_session = pyStr(pyOr(dictGet(item, "session_id"), pyOr(dictGet(item, "source_session_id"), "")));
    const actual_branch = pyStr(pyOr(dictGet(item, "branch_id"), ""));
    const item_scope = pyStr(pyOr(dictGet(item, "scope"), "workspace"));

    // 1. 严格作用域校验（F07）
    if (item_scope !== "global") {
      if (!actual_session) {
        return {
          ok: false,
          error: "Non-global learning item missing canonical session scope",
          status: "scope_mismatch",
        };
      }
      if (!session_id) {
        return {
          ok: false,
          error: "sessionId is required for non-global learning item",
          status: "scope_required",
        };
      }
      if (session_id !== actual_session) {
        return {
          ok: false,
          error: `sessionId mismatch: expected '${actual_session}', got '${session_id}'`,
          status: "scope_mismatch",
        };
      }
      if (pyStrip(pyOr(branch_id, "")) !== pyStrip(actual_branch)) {
        return {
          ok: false,
          error: `branchId mismatch: expected '${actual_branch}', got '${branch_id}'`,
          status: "scope_mismatch",
        };
      }
    }

    // 2. 幂等原子声明（F08–F16）
    if (!idempotency_key) {
      return {
        ok: false,
        error: "idempotencyKey is required for mutation actions",
        status: "idempotency_required",
      };
    }

    const cur_status = pyStr(pyOr(dictGet(item, "status"), "discovered"));
    const effective_key = idempotency_key;
    let operation_id = `op_${LS_SEAMS.uuid_hex12()}`;

    const [claimed, op_info] = this.storage.claim_learning_item_operation(
      operation_id, item_id, action, effective_key,
      // F11: payload 键序固定
      {
        action,
        content: edited_content,
        reason,
        version: expected_version,
        session_id,
        branch_id,
      }
    );

    if (!claimed) {
      const op_status = dictGet(op_info, "status");
      if (op_status === "idempotency_conflict") {
        return {
          ok: false,
          status: "idempotency_conflict",
          error: pyOr(dictGet(op_info, "error"),
            `Idempotency key '${effective_key}' is already used for another action/item`),
          idempotent: true,
        };
      }
      if (typeof op_status === "string" && CLAIM_TERMINAL.includes(op_status)) {
        // F13: 就地改缓存 result 再返回（原码如此）
        const cached_res = (pyOr(dictGet(op_info, "result"), {}) as JsonDict);
        cached_res["idempotent"] = true;
        cached_res["operation_id"] = dictGet(op_info, "operation_id");
        return cached_res;
      }
      if (op_status === "started") {
        return {
          ok: false,
          status: "running",
          error: `Operation '${action}' for item ${item_id} is already in progress`,
          operation_id: dictGet(op_info, "operation_id"),
          idempotent: true,
        };
      }
      if (op_status === "failed" || op_status === "unknown") {
        operation_id = pyStr(pyOr(dictGet(op_info, "operation_id"), operation_id));
        this.storage.update_learning_item_operation(operation_id, "started", null, "");
      }
      // F16: 其他 op_status 直接向下执行，用新 operation_id、不补记 started。
    }

    const kind = pyStr(pyOr(dictGet(item, "kind"), "memory_fact"));
    const ref = pyStr(pyOr(dictGet(item, "target_ref"), ""));
    const sid = pyStr(pyOr(actual_session, "default"));
    const bid = pyStr(pyOr(actual_branch, ""));
    const ET = LS_SEAMS.EventType;

    // ── 1. APPROVE / ACCEPT SAGA ────────────────────────────────────────────
    if (action === "approve" || action === "accept") {
      if (cur_status === "unknown") {
        const err_res: JsonDict = {
          ok: false,
          error: "Item is in 'unknown' state and requires reconcile before approval",
          status: "unknown",
        };
        this.storage.update_learning_item_operation(operation_id, "unknown", err_res, err_res["error"] as string);
        return err_res;
      }
      if (!APPROVE_WHITELIST.includes(cur_status)) {
        const err_res: JsonDict = {
          ok: false,
          error: `Cannot approve item in status '${cur_status}'`,
          status: cur_status,
        };
        this.storage.update_learning_item_operation(operation_id, "failed", err_res, err_res["error"] as string);
        return err_res;
      }

      let applied = false;
      let error_msg = "";
      let landed = false;

      if (kind === "memory_fact" || kind === "preference") {
        if (!ref) {
          // F20: 缺 target_ref 绝不假装成功
          error_msg = "Missing target proposal ref for memory mutation";
          landed = false;
        } else {
          try {
            const engine = (LS_SEAMS.evolutionModule()["get_evolution_engine"] as () => unknown)();
            if (engine) {
              const dec_res = (engine as {
                decide(id: string, accept: boolean, draft_override: string | null): JsonDict;
              }).decide(ref, true, edited_content as string | null);
              landed = pyBool(dictGet(dec_res, "applied"));
              applied = landed;
              if (!landed) {
                error_msg = pyStr(pyOr(dictGet(dec_res, "error"), "Memory write not applied to disk"));
              }
            } else {
              landed = false;
              error_msg = "Evolution engine unavailable";
            }
          } catch (exc) {
            landed = false;
            error_msg = pyStrExc(exc);
            LS_SEAMS.logger.exception(`[learning_service] memory mutation failed for item ${item_id}`);
          }
        }
      } else if (kind === "skill_step") {
        if (!ref) {
          error_msg = "Missing skill candidate target_ref";
          landed = false;
        } else {
          try {
            const sl = LS_SEAMS.skillLifecycleModule();
            const loaderMod = LS_SEAMS.skillLoaderModule();
            const loader = (loaderMod["get_skill_loader"] as () => unknown)();
            const app_res = (sl["approve"] as (s: unknown, l: unknown, r: string) => {
              ok: boolean; error: string;
            })(this.storage, loader, ref);
            landed = pyBool(app_res.ok);
            applied = landed;
            if (!app_res.ok) error_msg = pyStr(pyOr(app_res.error, "Skill verification/promotion failed"));
          } catch (exc) {
            landed = false;
            error_msg = pyStrExc(exc);
            LS_SEAMS.logger.exception(`[learning_service] skill candidate mutation failed for item ${item_id}`);
          }
        }
      } else if (kind === "failure_guard" || kind === "strategy" || kind === "optimization") {
        // F22: 零底层动作
        landed = true;
        applied = true;
      } else {
        error_msg = `Unknown learning item kind '${kind}'`;
        landed = false;
      }

      if (landed) {
        const ok = this.storage.update_learning_item(
          item_id, "published", "approved", null, null, operation_id, idempotency_key, expected_version
        );
        if (ok) {
          let event_ok = true;
          try {
            this.storage.get_event_store().append(sid, ET["LEARNING_ITEM_PUBLISHED"] as string, {
              // F24: 11 键有序
              learning_item_id: item_id,
              bundle_id: dictGet(item, "bundle_id", ""),
              episode_id: dictGet(item, "episode_id", ""),
              kind,
              scope: dictGet(item, "scope", "session"),
              content: dictGet(item, "content", ""),
              why: dictGet(item, "why", ""),
              future_effect: dictGet(item, "future_effect", ""),
              operation_id,
              idempotency_key,
              applied: true,
            }, { branch_id: pyOr(bid, null) });
          } catch (_ev_e) {
            LS_SEAMS.logger.warning(`[learning_service] event append failed: ${pyStrExc(_ev_e)}`);
            event_ok = false;
          }
          if (event_ok) {
            const updated = this.storage.get_learning_item(item_id);
            const res_val: JsonDict = { ok: true, status: "published", applied: true, item: updated };
            this.storage.update_learning_item_operation(operation_id, "verified", res_val, null);
            return res_val;
          }
          this.storage.update_learning_item(
            item_id, "unknown", null,
            "Audit event append failed; item marked unknown/needs_reconcile", null, operation_id
          );
          const updated = this.storage.get_learning_item(item_id);
          const res_val: JsonDict = {
            ok: false,
            status: "unknown",
            applied: true,
            needs_reconcile: true,
            error: "Audit event append failed; marked for reconciliation (status unknown)",
            item: updated,
          };
          this.storage.update_learning_item_operation(operation_id, "unknown", res_val, res_val["error"] as string);
          return res_val;
        }
        // F26
        this.storage.update_learning_item(
          item_id, "unknown", null,
          "Physical mutation landed but learning item update failed (version conflict)", null, operation_id
        );
        const res_val: JsonDict = {
          ok: false,
          status: expected_version !== null && expected_version !== undefined ? "version_conflict" : "failed",
          error: "Concurrent modification detected (expected_version mismatch); physical state may require reconcile",
        };
        this.storage.update_learning_item_operation(operation_id, "unknown", res_val, res_val["error"] as string);
        return res_val;
      } else {
        this.storage.update_learning_item(
          item_id, "failed", "failed", error_msg, null, operation_id, idempotency_key
        );
        try {
          // F27: 事件结果不检查、异常被 pass 吞掉
          this.storage.get_event_store().append(sid, ET["LEARNING_ITEM_FAILED"] as string, {
            learning_item_id: item_id, error: error_msg, operation_id,
          }, { branch_id: pyOr(bid, null) });
        } catch {
          /* python: except Exception: pass */
        }
        const res_val: JsonDict = { ok: false, status: "failed", applied: false, error: error_msg };
        this.storage.update_learning_item_operation(operation_id, "failed", res_val, error_msg);
        return res_val;
      }
    }

    // ── 2. REJECT / DENY SAGA ───────────────────────────────────────────────
    if (action === "reject" || action === "deny") {
      let reject_ok = true;
      let reject_err = "";
      if ((kind === "memory_fact" || kind === "preference") && ref) {
        try {
          const engine = (LS_SEAMS.evolutionModule()["get_evolution_engine"] as () => unknown)();
          if (engine) {
            (engine as { decide(id: string, accept: boolean): unknown }).decide(ref, false);
          }
        } catch (exc) {
          reject_ok = false;
          reject_err = pyStrExc(exc);
        }
      } else if (kind === "skill_step" && ref) {
        try {
          const sl = LS_SEAMS.skillLifecycleModule();
          const res = (sl["reject"] as (s: unknown, id: string, reason?: string) => {
            ok: boolean; error: string;
          })(this.storage, ref, pyOr(reason, "user rejected"));
          if (!res.ok) {
            reject_ok = false;
            reject_err = pyStr(pyOr(res.error, "Skill candidate reject failed"));
          }
        } catch (exc) {
          reject_ok = false;
          reject_err = pyStrExc(exc);
        }
      }

      if (!reject_ok) {
        LS_SEAMS.logger.warning(`[learning_service] reject failed on ref ${ref}: ${reject_err}`);
        this.storage.update_learning_item(
          item_id, "unknown", null, `Underlying reject failed: ${reject_err}`, null,
          operation_id, idempotency_key
        );
        const res_val: JsonDict = {
          ok: false, status: "unknown", applied: false,
          error: pyOr(reject_err, "Underlying reject failed"),
        };
        this.storage.update_learning_item_operation(operation_id, "unknown", res_val, reject_err);
        return res_val;
      }

      const ok = this.storage.update_learning_item(
        item_id, "rejected", "rejected", null, null, operation_id, idempotency_key, expected_version
      );
      if (!ok) {
        const res_val: JsonDict = {
          ok: false,
          status: expected_version !== null && expected_version !== undefined ? "version_conflict" : "failed",
          error: "Concurrent modification detected on reject",
        };
        this.storage.update_learning_item_operation(operation_id, "failed", res_val, res_val["error"] as string);
        return res_val;
      }

      let event_ok = true;
      try {
        this.storage.get_event_store().append(sid, ET["LEARNING_ITEM_REJECTED"] as string, {
          learning_item_id: item_id, reason: pyOr(reason, "user rejected"), operation_id,
        }, { branch_id: pyOr(bid, null) });
      } catch (_ev_e) {
        LS_SEAMS.logger.warning(`[learning_service] reject event append failed: ${pyStrExc(_ev_e)}`);
        event_ok = false;
      }
      if (event_ok) {
        const updated = this.storage.get_learning_item(item_id);
        const res_val: JsonDict = { ok: true, status: "rejected", applied: false, item: updated };
        this.storage.update_learning_item_operation(operation_id, "verified", res_val, null);
        return res_val;
      }
      this.storage.update_learning_item(
        item_id, "unknown", null, "Audit event append failed; item marked unknown/needs_reconcile",
        null, operation_id
      );
      const updated = this.storage.get_learning_item(item_id);
      const res_val: JsonDict = {
        ok: false, status: "unknown", applied: false, needs_reconcile: true,
        error: "Audit event append failed; marked for reconciliation (status unknown)",
        item: updated,
      };
      this.storage.update_learning_item_operation(operation_id, "unknown", res_val, res_val["error"] as string);
      return res_val;
    }

    // ── 3. DEFER SAGA ───────────────────────────────────────────────────────
    if (action === "defer") {
      const defer_reason = pyStr(pyOr(reason, "user deferred"));
      const ok = this.storage.update_learning_item(
        item_id, "deferred", "deferred", defer_reason, null, operation_id, idempotency_key, expected_version
      );
      if (!ok) {
        const res_val: JsonDict = {
          ok: false,
          status: expected_version !== null && expected_version !== undefined ? "version_conflict" : "failed",
          error: "Concurrent modification detected on defer",
        };
        this.storage.update_learning_item_operation(operation_id, "failed", res_val, res_val["error"] as string);
        return res_val;
      }
      let event_ok = true;
      try {
        this.storage.get_event_store().append(sid, ET["LEARNING_ITEM_DEFERRED"] as string, {
          learning_item_id: item_id, reason: defer_reason, operation_id,
        }, { branch_id: pyOr(bid, null) });
      } catch (_ev_e) {
        LS_SEAMS.logger.warning(`[learning_service] defer event append failed: ${pyStrExc(_ev_e)}`);
        event_ok = false;
      }
      if (event_ok) {
        const updated = this.storage.get_learning_item(item_id);
        const res_val: JsonDict = { ok: true, status: "deferred", applied: false, item: updated };
        this.storage.update_learning_item_operation(operation_id, "verified", res_val, null);
        return res_val;
      }
      this.storage.update_learning_item(
        item_id, "unknown", null, "Audit event append failed; item marked unknown/needs_reconcile",
        null, operation_id
      );
      const updated = this.storage.get_learning_item(item_id);
      const res_val: JsonDict = {
        ok: false, status: "unknown", applied: false, needs_reconcile: true,
        error: "Audit event append failed; marked for reconciliation (status unknown)",
        item: updated,
      };
      this.storage.update_learning_item_operation(operation_id, "unknown", res_val, res_val["error"] as string);
      return res_val;
    }

    // ── 4. EDIT SAGA ────────────────────────────────────────────────────────
    if (action === "edit") {
      // F33: `is not None`（传 "" 得 ""）+ python Unicode strip
      const raw = edited_content !== null ? edited_content : dictGet(item, "content", "");
      const new_content = pyStrip(pyStr(raw));
      if (!new_content) {
        const res_val: JsonDict = { ok: false, error: "Content cannot be empty on edit", status: "invalid_content" };
        this.storage.update_learning_item_operation(operation_id, "failed", res_val, res_val["error"] as string);
        return res_val;
      }

      let edit_ok = true;
      let edit_err = "";

      if ((kind === "memory_fact" || kind === "preference") && ref) {
        try {
          const engine = (LS_SEAMS.evolutionModule()["get_evolution_engine"] as () => unknown)();
          if (engine) {
            // F35: `engine.store` 求值本身可抛 AttributeError；store 为 None 则 hasattr False → 静默
            const store = getAttrThrow(engine, "store");
            if (hasAttrPy(store, "update_draft")) {
              (store as { update_draft(id: string, draft: string): unknown })
                .update_draft(ref, `- ${new_content}`);
            }
          }
        } catch (exc) {
          edit_ok = false;
          edit_err = pyStrExc(exc);
        }
      } else if (kind === "skill_step" && ref) {
        try {
          const cand = this.storage.get_skill_candidate(ref);
          if (cand) {
            // F36: 先就地改 dict
            (cand as JsonDict)["steps"] = [new_content];
            (cand as JsonDict)["status"] = "candidate";
            this.storage._db("skills").execute(
              "UPDATE skill_candidates SET steps=?, status=?, gate_report=NULL WHERE id=?",
              [jsonDumps([new_content]), "candidate", ref]
            );
            this.storage._db("skills").commit();
          }
        } catch (exc) {
          edit_ok = false;
          edit_err = pyStrExc(exc);
        }
      }

      if (!edit_ok) {
        LS_SEAMS.logger.warning(`[learning_service] edit failed on ref ${ref}: ${edit_err}`);
        const res_val: JsonDict = {
          ok: false, status: "failed", applied: false,
          error: pyOr(edit_err, "Underlying draft update failed"),
        };
        this.storage.update_learning_item_operation(operation_id, "failed", res_val, edit_err);
        return res_val;
      }

      const ok = this.storage.update_learning_item(
        item_id, "proposed", "pending", null, new_content, operation_id, idempotency_key, expected_version
      );
      if (!ok) {
        const res_val: JsonDict = {
          ok: false,
          status: expected_version !== null && expected_version !== undefined ? "version_conflict" : "failed",
          error: "Concurrent modification detected on edit",
        };
        this.storage.update_learning_item_operation(operation_id, "failed", res_val, res_val["error"] as string);
        return res_val;
      }
      let event_ok = true;
      try {
        this.storage.get_event_store().append(sid, ET["LEARNING_ITEM_PROPOSED"] as string, {
          learning_item_id: item_id, content: new_content, revision: true, operation_id,
        }, { branch_id: pyOr(bid, null) });
      } catch (_ev_e) {
        LS_SEAMS.logger.warning(`[learning_service] edit event append failed: ${pyStrExc(_ev_e)}`);
        event_ok = false;
      }
      if (event_ok) {
        const updated = this.storage.get_learning_item(item_id);
        const res_val: JsonDict = { ok: true, status: "proposed", applied: false, item: updated };
        this.storage.update_learning_item_operation(operation_id, "verified", res_val, null);
        return res_val;
      }
      this.storage.update_learning_item(
        item_id, "unknown", null, "Audit event append failed; item marked unknown/needs_reconcile",
        null, operation_id
      );
      const updated = this.storage.get_learning_item(item_id);
      const res_val: JsonDict = {
        ok: false, status: "unknown", applied: false, needs_reconcile: true,
        error: "Audit event append failed; marked for reconciliation (status unknown)",
        item: updated,
      };
      this.storage.update_learning_item_operation(operation_id, "unknown", res_val, res_val["error"] as string);
      return res_val;
    }

    // ── 5. REVOKE / ROLLBACK SAGA ───────────────────────────────────────────
    if (action === "revoke") {
      if (cur_status !== "published") {
        const res_val: JsonDict = {
          ok: false, error: `Cannot revoke item in status '${cur_status}'`, status: "not_published",
        };
        this.storage.update_learning_item_operation(operation_id, "failed", res_val, res_val["error"] as string);
        return res_val;
      }

      let landed = false;
      let error_msg = "";

      if (kind === "memory_fact" || kind === "preference") {
        if (!ref) {
          landed = false;
          error_msg = "Missing target proposal ref for published memory revocation";
        } else {
          try {
            const MD = LS_SEAMS.memoryDomainModule()["MemoryDomain"] as new (s: unknown) => {
              set_status(id: string, st: string, reason?: string): [boolean, string];
              get(id: unknown): unknown;
            };
            const md = new MD(this.storage);
            const [ok_stat, stat_err] = md.set_status(ref, "archived", "user revoked learning item");
            landed = ok_stat;
            if (ok_stat) {
              // F40: 回读验证；md.get() 返回 None 视为成功
              const verified_item = md.get(ref);
              const st = getattrPy(verified_item, "status", "");
              if (pyTruth(verified_item) && st !== "archived" && st !== "deleted") {
                landed = false;
                error_msg = "Memory status verification failed after archive";
              }
            } else {
              error_msg = pyStr(pyOr(stat_err, "Failed to archive memory in domain"));
            }
          } catch (exc) {
            landed = false;
            error_msg = pyStrExc(exc);
            LS_SEAMS.logger.exception(`[learning_service] memory revoke failed for item ${item_id}`);
          }
        }
      } else if (kind === "skill_step") {
        if (!ref) {
          landed = false;
          error_msg = "Missing skill candidate ref for published skill rollback";
        } else {
          try {
            const sl = LS_SEAMS.skillLifecycleModule();
            const loader = (LS_SEAMS.skillLoaderModule()["get_skill_loader"] as () => unknown)();
            const res = (sl["rollback"] as (s: unknown, l: unknown, r: string) => {
              ok: boolean; error: string;
            })(this.storage, loader, ref);
            landed = pyBool(res.ok);
            if (!res.ok) error_msg = pyStr(pyOr(res.error, "Skill rollback failed"));
          } catch (exc) {
            landed = false;
            error_msg = pyStrExc(exc);
            LS_SEAMS.logger.exception(`[learning_service] skill rollback failed for item ${item_id}`);
          }
        }
      } else {
        // F42
        landed = true;
      }

      if (landed) {
        const ok = this.storage.update_learning_item(
          item_id, "rolled_back", "revoked", null, null, operation_id, idempotency_key, expected_version
        );
        if (!ok) {
          // F44: CAS 失败 status 恒为 unknown
          this.storage.update_learning_item(
            item_id, "unknown", null,
            "Physical revoke succeeded but learning item update failed (version conflict)", null, operation_id
          );
          const res_val: JsonDict = {
            ok: false, status: "unknown",
            error: "Revoke physical asset succeeded but learning item update failed (marked unknown/needs_reconcile)",
          };
          this.storage.update_learning_item_operation(operation_id, "unknown", res_val, res_val["error"] as string);
          return res_val;
        }
        let event_ok = true;
        try {
          this.storage.get_event_store().append(sid, ET["LEARNING_ITEM_ROLLED_BACK"] as string, {
            learning_item_id: item_id, operation_id, verified: true,
          }, { branch_id: pyOr(bid, null) });
        } catch (_ev_e) {
          LS_SEAMS.logger.warning(`[learning_service] revoke event append failed: ${pyStrExc(_ev_e)}`);
          event_ok = false;
        }
        if (event_ok) {
          const updated = this.storage.get_learning_item(item_id);
          const res_val: JsonDict = { ok: true, status: "rolled_back", applied: true, item: updated };
          this.storage.update_learning_item_operation(operation_id, "verified", res_val, null);
          return res_val;
        }
        this.storage.update_learning_item(
          item_id, "unknown", null, "Audit event append failed; item marked unknown/needs_reconcile",
          null, operation_id
        );
        const updated = this.storage.get_learning_item(item_id);
        const res_val: JsonDict = {
          ok: false, status: "unknown", applied: true, needs_reconcile: true,
          error: "Audit event append failed; marked for reconciliation (status unknown)",
          item: updated,
        };
        this.storage.update_learning_item_operation(operation_id, "unknown", res_val, res_val["error"] as string);
        return res_val;
      } else {
        this.storage.update_learning_item(
          item_id, "unknown", null, `Revoke failed: ${error_msg}`, null, operation_id
        );
        const res_val: JsonDict = {
          ok: false, status: "unknown",
          error: pyOr(error_msg, "Revoke failed on storage layer (marked unknown/needs_reconcile)"),
        };
        this.storage.update_learning_item_operation(operation_id, "unknown", res_val, error_msg);
        return res_val;
      }
    }

    // ── 兜底（F46） ─────────────────────────────────────────────────────────
    const res_val: JsonDict = {
      ok: false, error: `Unsupported action: ${action}`, status: "unsupported_action",
    };
    this.storage.update_learning_item_operation(operation_id, "failed", res_val, res_val["error"] as string);
    return res_val;
  }
}

// ── 模块级单例（F47：第一次调用的 storage 永久生效） ────────────────────────────

let _learning_service: LearningItemService | null = null;

export function get_learning_service(storage: unknown = null): LearningItemService {
  if (_learning_service === null) {
    _learning_service = new LearningItemService(storage);
  }
  return _learning_service;
}

/** 探针用：重置单例（对应 python 侧 `learning_service._learning_service = None`）。 */
export function _reset_learning_service_for_parity(): void {
  _learning_service = null;
}

// ── reconcile（P1-3 / BUG-1 / BUG-2） ─────────────────────────────────────────

export function reconcile_learning_item_operations(storage: unknown = null): JsonDict[] {
  const st = pyOr(storage, LS_SEAMS.get_storage_local()) as LearningStorage;
  const hanging = st.list_hanging_learning_item_operations(100);
  const reconciled: JsonDict[] = [];
  const now = LS_SEAMS.now();
  const ET = LS_SEAMS.EventType;

  for (const op of hanging) {
    // python 直接取 `op.get(...)`，缺失即 None 原样传给被调方（被调方 `if not operation_id` 兜住）。
    const op_id = dictGet(op, "operation_id") as string;
    const item_id = dictGet(op, "item_id") as string;
    const action = dictGet(op, "action");
    const created_at = pyFloat(pyOr(dictGet(op, "created_at"), 0));
    // F49: 三元绑整个表达式；created_at 为 0 → age=0
    const age = pyTruth(created_at) ? now - created_at : 0;
    const item = st.get_learning_item(item_id);

    if (!item) {
      st.update_learning_item_operation(op_id, "failed", null, "Learning item not found");
      reconciled.push({ operation_id: op_id, decision: "failed", reason: "item_missing" });
      continue;
    }

    const kind = pyStr(pyOr(dictGet(item, "kind"), "memory_fact"));
    const ref = pyStr(pyOr(dictGet(item, "target_ref"), ""));

    if (action === "approve" || action === "accept") {
      let physical_ok = false;
      if (kind === "memory_fact" || kind === "preference") {
        try {
          const MD = LS_SEAMS.memoryDomainModule()["MemoryDomain"] as new (s: unknown) => {
            get(id: unknown): unknown;
          };
          const m_item = new MD(st).get(ref);
          if (m_item && getattrPy(m_item, "status", "") === "active") physical_ok = true;
        } catch {
          /* python: except Exception: pass */
        }
      } else if (kind === "skill_step") {
        try {
          const cands = st.list_skill_candidates(null, 50);
          let c: JsonDict | null = null;
          for (const x of cands) {
            if (pyEq(dictGet(x, "id"), ref)) { c = x; break; }
          }
          const cstat = c === null ? undefined : dictGet(c, "status");
          if (c && (cstat === "candidate" || cstat === "staged" || cstat === "active")) physical_ok = true;
        } catch {
          /* python: except Exception: pass */
        }
      }

      if (physical_ok) {
        const ok = st.update_learning_item(item_id, "published", "approved", null, null, op_id);
        if (!ok) {
          st.update_learning_item_operation(op_id, "unknown", null, "Item update failed during reconcile");
          reconciled.push({ operation_id: op_id, decision: "unknown", reason: "item_cas_update_failed" });
        } else {
          let event_ok = true;
          try {
            // F52: 位置参数 + branch_id 关键字
            st.get_event_store().append(
              pyOr(dictGet(item, "session_id"), "default") as string,
              ET["LEARNING_ITEM_PUBLISHED"] as string,
              { learning_item_id: item_id, operation_id: op_id, reconciled: true, verified: true, target_ref: ref },
              { branch_id: pyOr(dictGet(item, "branch_id"), null) }
            );
          } catch (_ev_e) {
            LS_SEAMS.logger.warning(`[learning_service] reconcile event append failed: ${pyStrExc(_ev_e)}`);
            event_ok = false;
          }
          if (event_ok) {
            const res_val: JsonDict = { ok: true, status: "published", applied: true, reconciled: true };
            st.update_learning_item_operation(op_id, "verified", res_val, null);
            reconciled.push({ operation_id: op_id, decision: "verified", reason: "physical_asset_confirmed" });
          } else {
            st.update_learning_item(item_id, "unknown", null, "Audit event append failed during reconcile",
              null, op_id);
            const res_val: JsonDict = {
              ok: false, status: "unknown", applied: true, reconciled: true, needs_reconcile: true,
              error: "Audit event append failed during reconcile",
            };
            st.update_learning_item_operation(op_id, "unknown", res_val, res_val["error"] as string);
            reconciled.push({ operation_id: op_id, decision: "unknown", reason: "event_append_failed" });
          }
        }
      } else if (age > 300) {
        // F53: age ≤ 300 且实物不在 → 本轮静默跳过
        st.update_learning_item_operation(op_id, "failed", null, "Operation timed out without physical asset");
        reconciled.push({ operation_id: op_id, decision: "failed", reason: "timeout" });
      }
    } else if (action === "revoke") {
      let is_revoked = false;
      if (kind === "memory_fact" || kind === "preference") {
        try {
          const MD = LS_SEAMS.memoryDomainModule()["MemoryDomain"] as new (s: unknown) => {
            get(id: unknown): unknown;
          };
          const m_item = new MD(st).get(ref);
          const stt = getattrPy(m_item, "status", "");
          if (!m_item || stt === "archived" || stt === "deleted") is_revoked = true;
        } catch {
          /* python: except Exception: pass */
        }
      }
      // F54: skill_step 没有 revoke 实物核对，只能等超时
      if (is_revoked) {
        const ok = st.update_learning_item(item_id, "rolled_back", "revoked", null, null, op_id);
        if (!ok) {
          st.update_learning_item_operation(op_id, "unknown", null, "Item rollback update failed during reconcile");
          reconciled.push({ operation_id: op_id, decision: "unknown", reason: "item_cas_update_failed" });
        } else {
          let event_ok = true;
          try {
            st.get_event_store().append(
              pyOr(dictGet(item, "session_id"), "default") as string,
              ET["LEARNING_ITEM_ROLLED_BACK"] as string,
              { learning_item_id: item_id, operation_id: op_id, reconciled: true, verified: true, target_ref: ref },
              { branch_id: pyOr(dictGet(item, "branch_id"), null) }
            );
          } catch (_ev_e) {
            LS_SEAMS.logger.warning(
              `[learning_service] reconcile revoke event append failed: ${pyStrExc(_ev_e)}`);
            event_ok = false;
          }
          if (event_ok) {
            st.update_learning_item_operation(op_id, "verified",
              { ok: true, status: "rolled_back", reconciled: true }, null);
            reconciled.push({ operation_id: op_id, decision: "verified", reason: "physical_revoke_confirmed" });
          } else {
            st.update_learning_item(item_id, "unknown", null, "Audit event append failed during reconcile",
              null, op_id);
            const res_val: JsonDict = {
              ok: false, status: "unknown", applied: true, reconciled: true, needs_reconcile: true,
              error: "Audit event append failed during reconcile",
            };
            st.update_learning_item_operation(op_id, "unknown", res_val, res_val["error"] as string);
            reconciled.push({ operation_id: op_id, decision: "unknown", reason: "event_append_failed" });
          }
        }
      } else if (age > 300) {
        st.update_learning_item_operation(op_id, "failed", null, "Revoke operation timed out");
        reconciled.push({ operation_id: op_id, decision: "failed", reason: "timeout" });
      }
    }
  }

  if (reconciled.length > 0) {
    // F55: python list/dict repr（单引号、True/False/None）
    LS_SEAMS.logger.info(
      `[learning_service] reconciled ${reconciled.length} hanging operations: ${pyRepr(reconciled)}`);
  }
  return reconciled;
}


