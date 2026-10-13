/**
 * turn_state.ts — 回合状态：从二值升级为持久化枚举（2.1）。
 *
 * Ported from `app/backend/turn_state.py` (258 lines).
 *
 * ## 为什么需要它
 *
 * 在这之前，「回合在不在跑」是一个**活性探测**而不是状态：
 * `http_server._turn_running()` 问的是「那个 asyncio task 还在吗」，前端只有一个
 * `isWorking: boolean`。这带来三个具体的坏后果：
 *
 * 1. **「在等用户」表达不出来。** 前端只能从 `toolCalls` 里反推
 *    （`agentStore.isAwaitingUser`）——用工具调用的形状去猜回合的状态，猜错了
 *    界面就骗人。
 * 2. **「暂停」根本不存在。** 点停止之后回合就没了，没有「回来接着跑」这回事。
 * 3. **重启后回合本身丢失。** `ask_user` 有 kv 账本、问题卡片能恢复，但**回合**
 *    恢复不了；`risk_control._pending_confirmations` 连账本都没有，重启后待确认
 *    的工具调用彻底消失。`http_server.py` 里那句「这组问题已经不在等待中了
 *    （可能已回答或后端重启过）」就是缺状态打出来的补丁。
 *
 * ## 两条轴，别混在一起
 *
 * - **status**（这一层）：`idle / running / waiting_user / paused / completed /
 *   error`。少而稳，是前端和恢复逻辑真正要判断的东西。
 * - **substatus**：直接从现成的 `agent_phases.TurnPhase` **折叠**出来，不新造词。
 *   phase 有 12 个值、每回合会跳很多次，一比一存进去等于把状态表当日志写。折叠
 *   成 5 个桶之后它就是「现在大致在干什么」，够前端叙述用，也不会一秒写十次库。
 *
 * ## 非法迁移只记日志，不抛
 *
 * 沿用全仓既有基调——可观测性绝不弄死回合。状态机写错了最坏是界面显示得不准，
 * 而抛异常会让一个**本来能跑完**的回合挂在状态更新上。这个取舍在这个模块里是
 * 单向的：宁可状态不准，不可回合中断。
 *
 * RULEBOOK CITATIONS
 *   §2  `class TurnStatus(str, Enum)` → 冻结的 const 对象 + 联合类型（与
 *       event_types.ts / task_states.ts 同一映射）。字符串值同时是落库与接口
 *       契约，逐字保留，绝不重命名。
 *   §2  `print(...)` → `console.log(...)`（纯可观测，不参与任何判定）。
 *   §2  `except Exception`（宽吞）→ 逐字保留吞掉的行为，站点标 `BUG(port):`。
 *   §2  `int(time.time())` → 本地 `pyInt()`（截断向零；非法输入抛错，由调用点
 *       的 except 兜住，与源一致）。
 *   §4  naming: app/backend/turn_state.py -> app/engine/turn_state.ts。
 *   §4  函数内 `from storage import get_storage` → 静态 import（storage.ts 无
 *       导入期副作用；单例仍是惰性构造），经 `TURN_STATE_SEAMS` 可替换。
 *
 * DIVERGENCE(port): 源里 `to.value` / `frm.value` 要求 `to` 是枚举成员；TS 侧
 * TurnStatus 的值就是字符串本身，因此 `.value` 退化为恒等。传「裸字符串」在源里
 * 会在 `_write` 抛 AttributeError 被吞成 False，在 TS 里会直接写成。本仓所有调用点
 * 都传枚举成员（http_server.py:961/1000/1167/1258/1337/1373），行为完全一致；
 * 该差异只在类型契约被违反时可见，与 event_types.ts 的既有映射同源。
 *
 * PORT STATUS: confidence=high todos=0
 */

import { get_storage as _real_get_storage } from "./storage.js";

// ── python 语义小工具（本仓惯例：各文件自带局部实现） ─────────────────────────

/** python `str(exc)`：优先取异常自带的 pyMsg，否则取 message。 */
function excStr(e: unknown): string {
  const m = (e as { pyMsg?: string })?.pyMsg;
  if (m !== undefined) {
    return m;
  }
  return String((e as Error)?.message ?? e);
}

/** python `type(x).__name__`（`int()` 报错文本与 AttributeError 文本共用）。 */
function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (Array.isArray(v)) return "list";
  return "dict";
}

/**
 * python `str.isspace()` 的空白集合（`str.strip()` 无参形式所用）。
 *
 * 证据 tmp/tstn_oracle_facts.json F1_fold：`'\x1cturn_entered'` → "preparing"
 * （\x1c-\x1f 是 Python 空白），`'\ufeffturn_entered'` → ""（U+FEFF **不是** Python
 * 空白）。JS `trim()` 正好相反（吞 BOM、不吞 \x1c-\x1f），所以不能直接用。
 */
const PY_WS: ReadonlySet<number> = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
  0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029,
  0x202f, 0x205f, 0x3000,
]);

/** python `int()` 接受的前后空白 = Unicode White_Space（**无** \x1c-\x1f）。
 *  证据 F8_int_str：`int('\xa03')` == 3 而 `int('\x1c3')` 抛 ValueError。 */
const PY_WS_INT: ReadonlySet<number> = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20,
  0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029,
  0x202f, 0x205f, 0x3000,
]);

function stripWs(s: string, ws: ReadonlySet<number>): string {
  let i = 0;
  let j = s.length;
  while (i < j && ws.has(s.charCodeAt(i))) {
    i += 1;
  }
  while (j > i && ws.has(s.charCodeAt(j - 1))) {
    j -= 1;
  }
  return s.slice(i, j);
}

/** python `s.strip()`（无参）。 */
function pyStrip(s: string): string {
  return stripWs(s, PY_WS);
}

/** python 真值语义：空 str/list/dict 为假（JS 里 `[]`/`{}` 是**真**）。
 *  证据 F3_current list_empty/[] → idle（`row or {}` 走了默认分支，不抛）。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.length > 0;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.length > 0;
  return Object.keys(v as object).length > 0;
}

/** python AttributeError（§M 同款约定：pyMsg 承载 CPython 原文，探针按此序列化）。 */
class PyAttributeError extends Error {
  pyMsg: string;

  constructor(obj: unknown, attr: string) {
    const msg = `'${pyTypeName(obj)}' object has no attribute '${attr}'`;
    super(msg);
    this.name = "AttributeError";
    this.pyMsg = msg;
  }
}

/** python `d.get(key)`：真值非 dict 接收者 → CPython AttributeError。
 *  证据 F3_current/F4_snapshot：list/str/int/bool 行抛 `'...' object has no
 *  attribute 'get'`；空 list/空 dict 行因 `or {}` 走默认值、**不**抛。 */
function pyGetOf(receiver: unknown, key: string): unknown {
  if (receiver === null || typeof receiver !== "object" || Array.isArray(receiver)) {
    throw new PyAttributeError(receiver, "get");
  }
  return (receiver as Record<string, unknown>)[key];
}

/** python `int(x)`：截断向零，非法输入抛错（调用点的 except 负责兜住）。
 *  字符串面按 CPython 语法：White_Space 前后缀 + 符号 + 数字（允许单个下划线
 *  分隔，证据 F8：`int('5_0')` == 50）。 */
function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (Number.isNaN(v)) throw new RangeError("cannot convert float NaN to integer");
    if (!Number.isFinite(v)) throw new RangeError("cannot convert float infinity to integer");
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const s = stripWs(v, PY_WS_INT);
    if (/^[-+]?[0-9]+(?:_[0-9]+)*$/u.test(s)) return Number(s.replace(/_/gu, ""));
    throw new RangeError(`invalid literal for int() with base 10: '${s}'`);
  }
  throw new TypeError(
    `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

// ── 枚举 ──────────────────────────────────────────────────────────────────────

/**
 * 一个会话当前处在哪个回合状态。
 *
 * 值就是落库和上线的字符串，**不要重命名**——前端按字符串判断，库里也存着
 * 历史行。新增状态往后加。
 */
export const TurnStatus = {
  /** 没有回合在跑，也没有任何东西等着人。全新会话和正常收工都是这个。 */
  IDLE: "idle",
  /** 回合正在跑。`substatus` 说明具体在哪一段。 */
  RUNNING: "running",
  /**
   * 回合停在「必须等人」上——ask_user 的问题卡片，或者一个待确认的工具调用。
   * 关键点：这**不是** idle。回合还在，只是球在用户那边。
   */
  WAITING_USER: "waiting_user",
  /** 用户点了停止。和 error 的区别是它**可以继续**（`resume_turn`）。 */
  PAUSED: "paused",
  /** 回合正常跑完了。 */
  COMPLETED: "completed",
  /** 回合失败收场。 */
  ERROR: "error",
} as const;

export type TurnStatus = (typeof TurnStatus)[keyof typeof TurnStatus];

/** 合法成员集合（python `TurnStatus(str(raw))` 的 ValueError 判定的等价物）。 */
const _MEMBERS: ReadonlySet<string> = new Set<string>(Object.values(TurnStatus));

/**
 * python `TurnStatus(str(raw))`，ValueError → IDLE。
 *
 * **非字符串一律 IDLE**：CPython `str(非字符串)`（"True"/"5"/"['running']"/"{'a': 1}"…）
 * 永远不是合法成员，而 JS `String(['running'])` 会塌成 "running" 误判成成员。
 * 证据 F3_current list_filled / dict_true / dict_int → 全部 idle。
 */
function coerceStatus(raw: unknown): TurnStatus {
  if (typeof raw !== "string") {
    return TurnStatus.IDLE;
  }
  return _MEMBERS.has(raw) ? (raw as TurnStatus) : TurnStatus.IDLE;
}

// ── 迁移白名单 ────────────────────────────────────────────────────────────────

/**
 * 允许的迁移。白名单而不是黑名单：漏掉一条合法迁移会在日志里立刻现形，
 * 而漏掉一条**非法**迁移会静默地让状态图变成一团乱麻。
 */
export const _ALLOWED: Record<TurnStatus, ReadonlySet<TurnStatus>> = {
  [TurnStatus.IDLE]: new Set<TurnStatus>([TurnStatus.RUNNING]),
  [TurnStatus.RUNNING]: new Set<TurnStatus>([
    TurnStatus.WAITING_USER, TurnStatus.PAUSED,
    TurnStatus.COMPLETED, TurnStatus.ERROR,
  ]),
  // 等人之后：人回答了就继续跑，人点了停止就暂停，等超时/放弃就收尾。
  [TurnStatus.WAITING_USER]: new Set<TurnStatus>([
    TurnStatus.RUNNING, TurnStatus.PAUSED,
    TurnStatus.COMPLETED, TurnStatus.ERROR,
  ]),
  // 暂停之后：resume 回到 running，或者用户干脆丢掉这个回合（→ idle）。
  [TurnStatus.PAUSED]: new Set<TurnStatus>([TurnStatus.RUNNING, TurnStatus.IDLE]),
  // 终态回到 idle 是「翻页」，也是下一个回合的起点。
  [TurnStatus.COMPLETED]: new Set<TurnStatus>([TurnStatus.IDLE, TurnStatus.RUNNING]),
  [TurnStatus.ERROR]: new Set<TurnStatus>([TurnStatus.IDLE, TurnStatus.RUNNING]),
};

/** python `_ALLOWED.get(frm, frozenset())` 的缺省值。 */
const _EMPTY_SET: ReadonlySet<TurnStatus> = new Set<TurnStatus>();

/**
 * 重启后哪些状态能活下来。
 *
 * `running` **不能**——那个 asyncio task 已经随进程一起没了，留着它前端会永远
 * 转圈等一个不会回来的回合。开机时把它改写成 `error`，用户看到的是「上次那轮
 * 没跑完」，这是真话。
 *
 * `waiting_user` 和 `paused` 能活：前者有 ask_user 的持久账本把卡片恢复出来，
 * 后者本来就是「停在这儿等你决定」，进程重启不改变这个事实。
 */
export const SURVIVES_RESTART: ReadonlySet<TurnStatus> = new Set<TurnStatus>([
  TurnStatus.IDLE, TurnStatus.WAITING_USER, TurnStatus.PAUSED,
  TurnStatus.COMPLETED, TurnStatus.ERROR,
]);

/**
 * `TurnPhase` → substatus 的折叠表。
 *
 * 键是 `agent_phases.TurnPhase` 的 wire 字符串（那个枚举的契约是值永不重命名，
 * 所以按字符串索引是安全的）。刻意**不 import** agent_phases：状态机不该为了
 * 一张查表去依赖发事件的那一侧，字符串是这里唯一需要的契约。
 */
export const _PHASE_FOLD: Record<string, string> = {
  turn_entered: "preparing",
  permission_resolved: "preparing",
  workspace_ready: "preparing",
  context_engine: "preparing",
  context_assembled: "preparing",
  model_call_started: "thinking",
  assistant_output_started: "thinking",
  tool_execution_started: "tooling",
  tool_execution_finished: "tooling",
  step_boundary: "stepping",
  assistant_reply_finalized: "finishing",
  post_turn_hooks: "finishing",
  turn_completed: "",
};

/**
 * 把一个 `TurnPhase` 值折成 substatus。
 *
 * 认不出的 phase 返回空串而不是原值：新加的 phase 在这张表补全之前，让
 * substatus 空着比让它显示一个 `foo_bar` 更诚实——空着是「不知道」，原值是
 * 「假装知道」。
 *
 * 逐字对齐 `_PHASE_FOLD.get(str(phase or "").strip(), "")`：
 *  - 非字符串 → ""（CPython `str(容器/数字/布尔)` 与 JS `String()` 不同塌成键，
 *    而 py 的字符串化结果永远不是这张表的键；证据 F1：`['turn_entered']` → ""）。
 *  - 字符串 → `pyStrip`（Python 空白集合，不是 JS `trim()`；证据 F1：
 *    `'\x1cturn_entered'` → "preparing"，`'\ufeffturn_entered'` → ""）。
 *  - 表查找用 hasOwnProperty：防 `constructor`/`__proto__` 撞原型链（py 侧它们
 *    只是普通未命中键）。
 */
export function fold_phase(phase: unknown): string {
  if (typeof phase !== "string") {
    return "";
  }
  const key = pyStrip(phase);
  const folded = Object.prototype.hasOwnProperty.call(_PHASE_FOLD, key)
    ? _PHASE_FOLD[key]
    : undefined;
  return folded !== undefined ? folded : "";
}

// ── seams（python 的模块全局与函数内导入在这里可替换；默认值 = 真端口） ──────────

/** 被调方形状（python 的 duck typing；真实实现是已落地的 storage 端口）。 */
interface TurnStateStorage {
  get_session(session_id: string): Record<string, unknown> | null;
  set_turn_status(
    session_id: string, status: string, substatus?: string, updated_at?: number,
  ): unknown;
  reset_stale_turn_status(stale?: string, to?: string): unknown;
}

export const TURN_STATE_SEAMS = {
  /** python 函数内 `from storage import get_storage`。 */
  get_storage: (): unknown => _real_get_storage(),
  /** python `time.time()`（`int(time.time())` 落库时间戳）。 */
  now: (): number => Date.now() / 1000,
};

/** 探针用：整体替换 seams（对应 python 侧 monkeypatch 模块全局）。 */
export function _set_seams_for_parity(patch: Partial<typeof TURN_STATE_SEAMS>): void {
  Object.assign(TURN_STATE_SEAMS, patch);
}

/** 探针用：恢复默认实现（对应 python 侧 reload）。 */
export function _reset_seams_for_parity(): void {
  TURN_STATE_SEAMS.get_storage = (): unknown => _real_get_storage();
  TURN_STATE_SEAMS.now = (): number => Date.now() / 1000;
}

/** 探针用：清掉进程内单例（对应 python 侧 `reload(turn_state)`）。 */
export function _reset_singleton_for_parity(): void {
  _machine = null;
}

// ── 状态机 ────────────────────────────────────────────────────────────────────

/**
 * 迁移的唯一入口。
 *
 * 独占的意义：全仓只有这一个地方能改 `turn_status`，所以「状态怎么变的」是
 * 可以只读这一个文件回答的问题。绕过它直接 UPDATE 就等于把状态图散回原来
 * 那种到处是 `isWorking = true` 的形态。
 */
export class TurnStateMachine {
  storage: TurnStateStorage;

  constructor(storage: TurnStateStorage) {
    this.storage = storage;
  }

  // ── 读 ────────────────────────────────────────────────────────────────

  /** 当前状态。读不到（会话不存在 / 列还没迁移）一律当 idle。 */
  current(session_id: string): TurnStatus {
    let row: unknown = null;
    try {
      row = this.storage.get_session(session_id);
    } catch {
      // fail-open: 可选增强，失败不影响主流程
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留（读状态失败不该
      // 弄死回合；上面的注释即源注释）。
    }
    // 源:`raw = (row or {}).get("turn_status") or ""`——真值非 dict 行在这里抛
    // CPython AttributeError（F3 list_filled/str_filled/int5/true）。
    const raw = pyGetOf(pyTruthy(row) ? row : {}, "turn_status");
    return coerceStatus(pyTruthy(raw) ? raw : "");
  }

  /** 给前端的一份状态快照。连接时拉一次就能恢复。 */
  snapshot(session_id: string): Record<string, unknown> {
    let row: unknown = {};
    try {
      row = this.storage.get_session(session_id) || {};
    } catch {
      // fail-open: 可选增强，失败不影响主流程
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }
    // 源：先 `self.current(session_id)`（第二次读库）再建 dict（F4 calls 2×get_session）。
    const status = this.current(session_id);
    const rowObj = pyTruthy(row) ? row : {};
    const subRaw = pyGetOf(rowObj, "turn_substatus");
    const updRaw = pyGetOf(rowObj, "status_updated_at");
    return {
      sessionId: session_id,
      status,
      substatus: pyTruthy(subRaw) ? subRaw : "",
      updatedAt: pyTruthy(updRaw) ? updRaw : 0,
      // 前端的 isWorking 从此是这个的派生值，而不是一个独立的真相来源。
      working: status === TurnStatus.RUNNING,
    };
  }

  // ── 写 ────────────────────────────────────────────────────────────────

  /**
   * 迁移到 `to`。返回是否真的写了。
   *
   * Args:
   *   session_id: 目标会话。
   *   to: 目标状态。
   *   substatus: 可选子态（用 `fold_phase` 折出来的那种）。
   *   opts.force: 跳过白名单校验。只给两个地方用——开机时的陈旧态清理，和
   *     「无论如何都要落到 idle」的兜底。业务代码不该传它。
   *
   * Returns:
   *   True 写入成功；False 表示被白名单拦下或写库失败。**两种情况都不抛**。
   */
  transition(
    session_id: string,
    to: TurnStatus,
    substatus = "",
    opts: { force?: boolean } = {},
  ): boolean {
    // 源 `if not session_id:`——python 真值，空 list/dict 也算「没有」。
    // 证据 F5 sidelist/`sid_list_empty` → false 且 **零调用**。
    if (!pyTruthy(session_id)) {
      return false;
    }
    const frm = this.current(session_id);
    if (to === frm) {
      // 同态迁移不是错误，但也不该刷 status_updated_at —— 那个时间戳的
      // 意思是「状态什么时候变的」，不是「什么时候被写过」。substatus
      // 变了才值得落一次。
      if (pyTruthy(substatus)) {
        return this._write(session_id, to, substatus);
      }
      return false;
    }
    const force = pyTruthy(opts.force);
    if (!force && !(_ALLOWED[frm] ?? _EMPTY_SET).has(to)) {
      console.log(`[turn_state] illegal transition ${frm} -> ${to} `
        + `(session=${session_id}); ignored`);
      return false;
    }
    return this._write(session_id, to, substatus);
  }

  /**
   * 回合内的 phase 推进，只更新 substatus。
   *
   * 刻意不碰 status：phase 每回合跳很多次，如果它能改 status，那
   * `waiting_user` 会在下一个 phase 到达时被悄悄冲掉，而「在等人」恰恰是
   * 最不能丢的那个状态。
   */
  note_phase(session_id: string, phase: string): void {
    const folded = fold_phase(phase);
    if (!folded) {
      return;
    }
    if (this.current(session_id) !== TurnStatus.RUNNING) {
      return;
    }
    this._write(session_id, TurnStatus.RUNNING, folded);
  }

  /**
   * 开机清理：把上一条命留下的 `running` 改写成 `error`。
   *
   * 必须在服务起来之前跑一次。不跑的话前端一连上就会看到一个永远转圈的
   * 回合——它等的那个 task 在上一个进程里，不会回来了。
   *
   * Returns:
   *   改写了几行。
   */
  reset_stale(): number {
    try {
      return pyInt(this.storage.reset_stale_turn_status(TurnStatus.RUNNING, TurnStatus.ERROR));
    } catch (exc) {
      // BUG(port): 源为 `except Exception`，宽吞逐字保留——开机清理失败不该
      // 拦住服务启动。
      console.log(`[turn_state] stale reset skipped: ${excStr(exc)}`);
      return 0;
    }
  }

  _write(session_id: string, to: TurnStatus, substatus: string): boolean {
    try {
      this.storage.set_turn_status(session_id, to, substatus, pyInt(TURN_STATE_SEAMS.now()));
      return true;
    } catch (exc) {
      // BUG(port): 源为 `except Exception`，宽吞逐字保留——写库失败只记日志，
      // 返回值 False 让调用方自己决定（业务代码都不看它）。
      console.log(`[turn_state] write failed (session=${session_id}): ${excStr(exc)}`);
      return false;
    }
  }
}

let _machine: TurnStateMachine | null = null;

/** 进程内单例。状态的权威在库里，这个对象只是通往库的那扇门。 */
export function get_turn_state(): TurnStateMachine {
  if (_machine === null) {
    _machine = new TurnStateMachine(
      TURN_STATE_SEAMS.get_storage() as unknown as TurnStateStorage,
    );
  }
  return _machine;
}
