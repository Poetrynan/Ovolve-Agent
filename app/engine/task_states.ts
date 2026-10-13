/**
 * task_states.ts — 3-Tier Task Hierarchy & State Transition Engine.
 *
 * Ported from `app/backend/task_states.py` (112 lines, sha256_16 46411f75779090f4).
 *
 * Three-tier hierarchy (Goal / Subagent / Todo) plus an explicit WaitConfirm
 * state.
 *
 * RULEBOOK CITATIONS
 *   §1  零依赖（event_bus 已移植 → 静态 import；源的 try/except ImportError
 *       双形状 import 在 TS 单一布局下不需要）。CPython 语义 helper 一律
 *       import 共享 §M 镜像 `./server/http_server_keys.js`（py_truth/py_or/
 *       py_str/py_type_name/py_getattr_or/PyTypeErrorP），端口内**不留**任何
 *       私有的 truthiness / str() / 异常文案镜像。
 *   §2  Python str-Enum → const 对象 + 字符串字面量联合（值逐字对应）。
 *       `class GoalStatus(str, enum.Enum)` 的成员 MRO 把 mixin `str` 排在
 *       `Enum` **之前**，于是 `__hash__`/`__eq__` 走 **值**（`Enum.__hash__`
 *       的 name-hash 被 mixin 遮蔽）。实测脸：oracle
 *       `tmp/tst3_oracle_facts.json` 的 `F1_enum_identity` /
 *       `F2_membership_reachability`（`hash_eq_value_hash`、
 *       `dict_get_raw_value`、`raw_value_in_allowed`）。因此本端口把成员与
 *       同值裸串当作**同一张脸**是忠实翻译，而不是便利简化。
 *   §2  CPython `dict` 没有原型链：`_VALID_TRANSITIONS.get("toString")` 是
 *       None。裸下标 `table["toString"]` 在 JS 会命中 `Object.prototype` 的
 *       继承成员。所有表读写走 `hasOwnProperty` 面（见 `py_own_get`）。
 *       证据：oracle `F2_membership_reachability.dict_get_prototype_key` /
 *       `in_raw_prototype_key`，以及 `F4_validate_matrix` 的
 *       `layer:toString` / `raw:toString` 行。
 *   §2  Python 容器 list/dict/set **不可哈希**：把它们当 dict 键或放进 `in`
 *       会立刻 `TypeError: unhashable type: 'list'`（oracle
 *       `F4_validate_matrix` 的 list/dict/set 行 + `F6_str_repr_faces`）。
 *       端口按同样的**短路顺序**抛同形文案：layer 先于 old_state 先于
 *       new_state；未知 layer 直接 return True，后面的脸根本不会被求值。
 *   §2  `record_task_state_transition` 的鸭子类型（hasattr .value）→ 走 §M
 *       `py_getattr_or`：**有** `.value` 就原样取（可能是 int/None，源并不
 *       强转），没有才落 §M `py_str`（不是 JS `String()`：`None`→`"None"`、
 *       `True`→`"True"`、`[1,2]`→`"[1, 2]"`、`nan`→`"nan"`）。证据：oracle
 *       `F6_str_repr_faces`、`F8_hasattr_value`、`F12_record_rows`
 *       （t5..t13 各脸发布的 old_state/new_state 值与类型）。
 *   §2  `meta or {}` 是 **Python 真值**，不是空值检查：`None`/`{}`/`[]`/`0`/
 *       `""`/`False` 都换成**新** dict（`ev.meta is meta` 为 False），truthy
 *       才原样别名透传；`float("nan")` 在 CPython 为**真**（§M py_truth 口径）。
 *       证据：oracle `F10_meta_or`（逐脸的 ev_meta_is_input / 类型脸）与
 *       `F19_truthiness`。端口用 §M `py_or`，不用 `??`。
 *   §2  `@dataclass` 默认值：`field(default_factory=…)` 只在**省略**实参时
 *       代入，显式传入的 `None`/`{}` 原样存（不做 `or {}` 折叠），每个实例
 *       拿到**各自新**的 dict。证据：oracle `F15_default_factory`
 *       （meta_not_shared=true）与 `F14_dataclass_ctor`。
 *   §2  arity 脸是**可观察行为**：CPython 对缺参/多参抛
 *       `TypeError("f() missing N required positional arguments: …")` /
 *       多参有两种拼写，由有没有默认参数决定——全必选
 *       `("validate_transition() takes 3 positional arguments but 4 were given")`，
 *       带默认 `("record_task_state_transition() takes from 4 to 6 positional
 *       arguments but 7 were given")`；dataclass 构造器文案前缀是
 *       `TaskStateEvent.__init__()` 且把 `self` 计入（`takes from 5 to 8 ...`）。
 *       端口按 §2 口径**自数 self**（`arguments.length + 1`），文案逐字对齐。
 *       证据：oracle `F17_arity`（两种拼写 + `was/were given` 单复数）、
 *       `F14_dataclass_ctor`（`__init__` 前缀与 5..8 上界）。
 *   §4  naming: task_states.py → task_states.ts
 *
 * 已登记口径之外的脸（**排除并记录**，不是 pin、不是整行忽略）：
 *   Python 的关键字实参面（`layer="goal"`）与 dataclass `repr()` 脸在 JS 没有
 *   对应形状（JS 无 kwargs；dataclass repr 是 Python 对象身份文案）。两者都
 *   不进 parity 表，事实与 oracle 脸名记录在 `tmp/tst3_STATE.md`。
 *
 * PORT STATUS: confidence=high todos=0
 */

import { getEventBus } from "./event_bus.js";
import {
  PyTypeErrorP,
  py_getattr_or,
  py_or,
  py_str,
  py_truth,
  py_type_name,
} from "./server/http_server_keys.js";

export const GoalStatus = {
  PENDING: "pending",
  ACTIVE: "active",
  PAUSED: "paused",
  WAITING_USER: "waiting_user",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;
export type GoalStatus = (typeof GoalStatus)[keyof typeof GoalStatus];

export const TurnStatus = {
  QUEUED: "queued",
  PRE_CHECK: "pre_check",
  RUNNING: "running",
  WAITING_CONFIRMATION: "waiting_confirmation",
  STEER_PENDING: "steer_pending",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;
export type TurnStatus = (typeof TurnStatus)[keyof typeof TurnStatus];

export const PlanStepStatus = {
  TODO: "todo",
  IN_PROGRESS: "in_progress",
  DONE: "done",
  FAILED: "failed",
  SKIPPED: "skipped",
} as const;
export type PlanStepStatus = (typeof PlanStepStatus)[keyof typeof PlanStepStatus];

/** Python `set-of-Enum` 转移表 → string 值集合（成员脸 == 值脸，见头部 §2 证明）。
 *  导出 = 对齐源的模块属性面（`task_states._VALID_TRANSITIONS` 在 CPython 里可
 *  访问，oracle `F21_surface.transition_layers` / `goal_key_order` 实测），
 *  `table_surface` 行直接观测它。 */
export const _VALID_TRANSITIONS: Record<string, Record<string, ReadonlySet<string>>> = {
  goal: {
    [GoalStatus.PENDING]: new Set([GoalStatus.ACTIVE, GoalStatus.CANCELLED]),
    [GoalStatus.ACTIVE]: new Set([
      GoalStatus.PAUSED,
      GoalStatus.WAITING_USER,
      GoalStatus.COMPLETED,
      GoalStatus.FAILED,
      GoalStatus.CANCELLED,
    ]),
    [GoalStatus.PAUSED]: new Set([GoalStatus.ACTIVE, GoalStatus.CANCELLED]),
    [GoalStatus.WAITING_USER]: new Set([GoalStatus.ACTIVE, GoalStatus.CANCELLED]),
    [GoalStatus.COMPLETED]: new Set(),
    [GoalStatus.FAILED]: new Set([GoalStatus.ACTIVE]),
    [GoalStatus.CANCELLED]: new Set(),
  },
  turn: {
    [TurnStatus.QUEUED]: new Set([TurnStatus.PRE_CHECK, TurnStatus.CANCELLED]),
    [TurnStatus.PRE_CHECK]: new Set([
      TurnStatus.RUNNING,
      TurnStatus.WAITING_CONFIRMATION,
      TurnStatus.FAILED,
      TurnStatus.CANCELLED,
    ]),
    [TurnStatus.RUNNING]: new Set([
      TurnStatus.WAITING_CONFIRMATION,
      TurnStatus.STEER_PENDING,
      TurnStatus.COMPLETED,
      TurnStatus.FAILED,
      TurnStatus.CANCELLED,
    ]),
    [TurnStatus.WAITING_CONFIRMATION]: new Set([
      TurnStatus.RUNNING,
      TurnStatus.FAILED,
      TurnStatus.CANCELLED,
    ]),
    [TurnStatus.STEER_PENDING]: new Set([TurnStatus.RUNNING, TurnStatus.CANCELLED]),
    [TurnStatus.COMPLETED]: new Set(),
    [TurnStatus.FAILED]: new Set(),
    [TurnStatus.CANCELLED]: new Set(),
  },
};

/* ── CPython 查找面（全部建在共享 §M 之上，端口内无私有镜像）──────────────── */

/** 源表的键全是 str-Enum 成员 ⇒ 只有**字符串面**可能命中；`hasOwnProperty` 挡掉原型键。 */
function py_own_get<V>(m: Record<string, V>, key: unknown): V | undefined {
  if (typeof key !== "string") return undefined;
  if (!Object.prototype.hasOwnProperty.call(m, key)) return undefined;
  return m[key];
}

/** CPython 里 list/dict/set 三个容器不可哈希（§M `py_type_name` 给脸名，端口只做判定）。 */
const PY_UNHASHABLE_NAMES = new Set(["list", "dict", "set"]);

function py_is_unhashable(v: unknown): boolean {
  return PY_UNHASHABLE_NAMES.has(py_type_name(v));
}

function py_unhashable_exc(v: unknown): PyTypeErrorP {
  return new PyTypeErrorP(`unhashable type: '${py_type_name(v)}'`);
}

/** `d.get(key)`：不可哈希键先抛 TypeError（顺序 = 源里表达式求值顺序）。 */
function py_dict_get_face<V>(m: Record<string, V>, key: unknown): V | undefined {
  if (py_is_unhashable(key)) throw py_unhashable_exc(key);
  return py_own_get(m, key);
}

/**
 * `x in set_of_members`：不可哈希键先算 hash（list/dict 立刻 TypeError），再做值相等。
 * CPython 的 `set.__contains__` 对 **set** 实参不抛异常而是返回 False（实测证据
 * `tmp/tsts_rawtest.txt`：`{1} in {2,3}` == False、`set() in {2,3}` == False，而
 * `[1] in {2,3}` / `{} in {2,3}` 抛 `unhashable type`）。这与 `dict.get(k)` 面
 * （`py_dict_get_face`：list/dict/set 三种**都**抛）不同，所以这里**只**对 list/dict
 * 抛、set/frozenset 落 False。证据：oracle `F4_validate_matrix` set/empty_set 的
 * `_new` 行（`{ok: false}`）与 `_old`/`_layer` 行（`unhashable type: 'set'`）。
 */
function py_set_contains(members: ReadonlySet<string>, key: unknown): boolean {
  const tn = py_type_name(key);
  if (tn === "list" || tn === "dict") throw py_unhashable_exc(key);
  if (tn === "set") return false; // CPython：set 实参进 `in` → False（不 hash、不抛）
  return typeof key === "string" && members.has(key);
}

/** §2 self-counted arity：缺参文案（`f() missing N required positional argument(s): …`）。 */
const ARITY_MISS = Symbol("arity_miss");

function pyMissingPositions(fnName: string, required: readonly string[], given: number): PyTypeErrorP {
  const missing = required.slice(Math.max(0, Math.min(given, required.length)));
  const n = missing.length;
  const quoted = missing.map((name) => `'${name}'`);
  const list =
    n === 1 ? quoted[0] :
    n === 2 ? quoted[0] + " and " + quoted[1] :
    quoted.slice(0, -1).join(", ") + ", and " + quoted[n - 1];
  return new PyTypeErrorP(
    `${fnName}() missing ${n} required positional argument${n === 1 ? "" : "s"}: ${list}`,
  );
}

/**
 * §2 self-counted arity：多参文案。CPython 有两种拼写（oracle `F17_arity` /
 * `F14_dataclass_ctor`）：
 *   全必选 → `f() takes 3 positional arguments but 4 were given`
 *   有默认 → `f() takes from 4 to 6 positional arguments but 7 were given`
 *   单数   → `was given`；其余 `were given`。计数面把 `self` 计入（源 73 行
 *   dataclass 的文案是 `TaskStateEvent.__init__() takes from 5 to 8 ...`）。
 */
function pyTooManyPositions(fnName: string, minCounted: number, maxCounted: number, givenCounted: number): PyTypeErrorP {
  const given = `${givenCounted} ${givenCounted === 1 ? "was" : "were"} given`;
  const span =
    minCounted === maxCounted
      ? `takes ${maxCounted} positional argument${maxCounted === 1 ? "" : "s"}`
      : `takes from ${minCounted} to ${maxCounted} positional arguments`;
  return new PyTypeErrorP(`${fnName}() ${span} but ${given}`);
}

/**
 * 源 64-71 行，逐句对应；短路顺序与求值顺序都是行为的一部分：
 *   table = _VALID_TRANSITIONS.get(layer)   -> 不可哈希 layer 立刻 TypeError
 *   if not table: return True               -> 未知 layer 时 old/new 脸**不被求值**
 *   allowed = table.get(old_state)          -> 不可哈希 old_state 在这里抛
 *   if allowed is None: return True         -> `is None`，不是 falsy（空 set 要继续走）
 *   return new_state in allowed             -> 不可哈希 new_state 在这里抛
 */
export function validate_transition(
  layer?: unknown,
  old_state?: unknown,
  new_state?: unknown,
): boolean {
  const n = arguments.length;
  if (n < 3) throw pyMissingPositions("validate_transition", ["layer", "old_state", "new_state"], n);
  if (n > 3) throw pyTooManyPositions("validate_transition", 3, 3, n);
  const table = py_dict_get_face(_VALID_TRANSITIONS, layer);
  if (!py_truth(table ?? null)) {
    return true;
  }
  const allowed = py_dict_get_face(table as Record<string, ReadonlySet<string>>, old_state);
  if (allowed === undefined) {
    return true;
  }
  return py_set_contains(allowed, new_state);
}

/** 源 91-92 行的 `x.value if hasattr(x, "value") else str(x)`（§M py_getattr_or / py_str）。 */
function state_value(s: unknown): unknown {
  const got = py_getattr_or(s, "value", ARITY_MISS);
  if (got !== ARITY_MISS) return got;
  return py_str(s);
}

/**
 * 源 73-81 行 `@dataclass class TaskStateEvent`。
 * 字段类型按源注解保留（`old_state: str`），源自己在运行时存非 str（见
 * `state_value`），注解不"顺手修好"——修它是 improvement，不是保真。
 *
 * CPython 里一个 class 就是**可调用对象**：`TaskStateEvent(*args)`（无 `new`）
 * 直接构造实例。JS 的 `class` 无 `new` 会先抛
 * `Class constructor ... cannot be invoked without 'new'`，**根本到不了**源那
 * self-counted arity 文案，于是 parity 探针 `dc_face` 组（按源形状**不加 `new`**
 * 调用构造器）与 CPython 分叉。忠实端口因此把 `TaskStateEvent` 实现成一个
 * **`new` 与不加 `new` 都能构造**的函数（Python 类面），字段/默认/arity 逻辑逐句
 * 不变：实例走 `Object.create(TaskStateEvent.prototype)`，`constructor.name`
 * 仍是 `"TaskStateEvent"`（§M `py_type_name` 读 `constructor.name`，见
 * http_server_keys.ts），`record_task_state_transition` 里的 `new TaskStateEvent(…)`
 * 与探针的两种调用形状同时成立。证据：oracle `F14_dataclass_ctor`。
 */
export interface TaskStateEvent {
  layer: string;
  task_id: string;
  old_state: string;
  new_state: string;
  session_id: string;
  timestamp: number;
  meta: Record<string, unknown>;
}

export function TaskStateEvent(
  layer?: unknown,
  task_id?: unknown,
  old_state?: unknown,
  new_state?: unknown,
  session_id: unknown = "",
  timestamp?: unknown,
  meta?: unknown,
): TaskStateEvent {
  const n = arguments.length;
  const required = ["layer", "task_id", "old_state", "new_state"] as const;
  if (n < 4) throw pyMissingPositions("TaskStateEvent.__init__", required, n);
  // dataclass 生成的 __init__ 把 self 计入：最多 8 个 self-counted 槽（= 7 个用户实参）。
  if (n > 7) throw pyTooManyPositions("TaskStateEvent.__init__", 5, 8, n + 1);
  // default_factory=time.time / default_factory=dict 只在**省略**时代入，且逐实例新建。
  const ts = n >= 6 && timestamp !== ARITY_MISS ? timestamp : Date.now() / 1000;
  const mt = n >= 7 && meta !== undefined ? meta : {};
  const self = Object.create(TaskStateEvent.prototype) as TaskStateEvent;
  self.layer = layer as string;
  self.task_id = task_id as string;
  self.old_state = old_state as string;
  self.new_state = new_state as string;
  self.session_id = session_id as string;
  self.timestamp = ts as number;
  self.meta = mt as Record<string, unknown>;
  return self;
}

/** 源 83-111 行。发布面（返回值 + 总线 payload）逐字对齐。 */
export function record_task_state_transition(
  layer?: unknown,
  task_id?: unknown,
  old_state?: unknown,
  new_state?: unknown,
  session_id: unknown = "",
  meta: unknown = null,
): TaskStateEvent {
  const n = arguments.length;
  const required = ["layer", "task_id", "old_state", "new_state"] as const;
  if (n < 4) throw pyMissingPositions("record_task_state_transition", required, n);
  if (n > 6) throw pyTooManyPositions("record_task_state_transition", 4, 6, n);
  const old_val = state_value(old_state);
  const new_val = state_value(new_state);
  // 源 93-100 行用**关键字**实参构造：session_id 永远传（省略时取形参默认 ""），
  // timestamp 永远省略（default_factory），meta 传 `meta or {}` 的结果。
  // 端口对应：6 个位置实参 + timestamp 位传 ARITY_MISS 哨兵（= 省略 ⇒ 逐实例新
  // time），meta 在构造后按 §M py_or 落值（对象身份与源一致，见 F10_meta_or）。
  // TaskStateEvent 是可 `new` 也可**直接调用**的 Python 类面（见其定义处注释），
  // 端口这里按源形状直接调用（不加 `new`），得到的仍是同一 prototype 上的实例。
  const ev = TaskStateEvent(
    layer,
    task_id,
    old_val,
    new_val,
    session_id,
    ARITY_MISS,
  );
  // 源把 meta 交给 dataclass 的 `meta=meta or {}`（这里等价地在构造后落值，
  // 因为 TaskStateEvent 的 meta 默认只在**省略**时代入，见上面注释）。
  ev.meta = py_or(meta === ARITY_MISS ? null : meta, {}) as Record<string, unknown>;
  const bus = getEventBus();
  const payload: Record<string, unknown> = {
    layer,
    task_id,
    old_state: old_val,
    new_state: new_val,
    session_id,
    timestamp: ev.timestamp,
    meta: ev.meta,
  };
  bus.emitSync("task_state_changed", payload);
  return ev;
}
