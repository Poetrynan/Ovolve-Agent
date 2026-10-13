/**
 * router_modules/admission.ts — Session admission, workspace, cancellation, and
 * handle entrypoint mixin.
 *
 * Ported from `app/backend/router_modules/admission.py` (1578 lines, wave-8,
 * unit 185).
 *
 * This mixin owns the front door of a turn (`handle`), the session/workspace
 * lifecycle (`switch_session` / `new_session` / `switch_workspace`), cooperative
 * and hard cancellation, the steer inbox drain, `@`-reference injection, and the
 * whole usage-accounting chain (`_normalize_usage` → `_accumulate_usage` →
 * `_record_turn_usage` → `_emit_usage_frame`).
 *
 * RULEBOOK CITATIONS
 *   §2  `str, Enum` → frozen const object + union type (risk_control/messaging
 *       already did this); values are wire/DB contracts, preserved byte for byte.
 *   §2  `print(...)` → `console.log(...)`; `logger`-style calls stay observational.
 *   §2  `except Exception` (broad swallow) → preserved verbatim and marked
 *       `BUG(port):` at every site, with the source's own reason copied over.
 *   §2  `except (KeyError, TypeError)` stays narrow (narrow catch stays narrow).
 *   §2  `dict.get(k, default)` evaluates `default` EAGERLY in python; the same
 *       call sites below therefore call `ADMISSION_SEAMS.now()` before the lookup
 *       (see `_record_turn_usage`), so the clock-call count matches the source.
 *   §2  `dict.setdefault` → `dictSetDefault` (returns the existing value when the
 *       key is present; the default expression is still evaluated eagerly).
 *   §2  `len()` is code-point based → `pyLen`; `sorted()` is code-point ordered →
 *       `pySortedStr`; `str.strip()` uses CPython's whitespace set → `pyStrip`.
 *   §2  `time.time()` → `ADMISSION_SEAMS.now()`; `uuid.uuid4()` → node:crypto
 *       `randomUUID()`; `os.path.expanduser` / `os.path.isdir` → seams (the only
 *       host touchpoints in `switch_workspace`).
 *   §2  `importlib.import_module(<computed>)` → `await import(<vite-ignore>)`
 *       (same mapping as `_activity_child.ts`). This makes
 *       `_register_analysis_tools` async — see DIVERGENCE(port) below.
 *   §1  telemetry ban: `token_analytics` was explicitly re-sanctioned as a TS unit
 *       (unit 167, operator instruction recorded in that file's header), so
 *       `_emit_usage_frame` keeps its analytics update instead of dropping it
 *       (AMEND-07 "功能一致 supreme"). It is loaded through a seam, exactly as
 *       the source's function-local `from token_analytics import ...` was.
 *   §4  naming: app/backend/router_modules/admission.py ->
 *       app/engine/router_modules/admission.ts.
 *
 * DIVERGENCE(port) — async where the source was sync (all of them forced by a
 * dependency that is already async in TS, none of them change observable data):
 *   1. `_register_analysis_tools()` — ESM `import()` is async, `importlib` is not.
 *      The only caller is `router.py:426` inside `__init__` (unit 188, unported);
 *      the ported router must await it from an async initialiser.
 *   2. `_skill_tokens()` — `skill_loader.render_available_skills_prompt` is async
 *      in TS (documented in skill_loader.ts:1419, context_refs is Rust-routed).
 *      Source callers: `_emit_usage_frame` (already async) and http_server
 *      (`router._skill_tokens()`, unit 32, unported).
 *   3. `_inject_context_refs` / `_flush_memory_for_fold` keep their source async
 *      shape; only the module loads inside them became `await import()`.
 *
 * DIVERGENCE(port) — `INTERRUPT_NOTE_TYPE` / `INTERRUPT_NUDGE` are the real
 * imports from `router_modules/loop.ts:618-619` now that unit 187 has landed;
 * the source's module-level `from router_modules.loop import ...` is the same
 * static edge. The `loopModule` seam stays so a probe can swap them.
 *
 * PORT STATUS: 本文件无 TODO(port)。
 */

import { DeliverAs, MAX_STEER_MERGED_CHARS, MessageQueue, get_message_queue } from "../messaging.js";
import { Result } from "../result.js";
import {
  PermissionMode,
  RiskController,
  RiskLevel,
  coerce_permission,
  parse_consent,
} from "../risk_control.js";
import { shorten_path, truncate } from "../tools.js";
import { _merge_plan_meta } from "./prompt.js";
import { Event } from "../event_bus.js";
import { cancelCall as cancel_call } from "../executors.js";
import { placeholder as _image_placeholder } from "../image_store.js";
import { get_ask_user_store } from "../ask_user.js";
import { get_rule_engine } from "../rule_engine.js";
import * as token_estimate from "../token_estimate.js";
import { pyJsonDumps } from "../storage/storage_funcs.js";
import { INTERRUPT_NOTE_TYPE, INTERRUPT_NUDGE } from "./loop.js";

// The source's module-level import surface also pulls `MessageQueue` /
// `get_message_queue` in, even though the mixin only reaches them through
// `self.queue`. Kept so the import contract matches.
void MessageQueue;
void get_message_queue;
void RiskController;
void RiskLevel;
void PermissionMode;
void shorten_path;
void truncate;

// ── python 语义小工具（本仓惯例：各文件自带局部实现） ─────────────────────────

/** CPython str.strip() whitespace set (probe-pinned; see bot_remote.ts). */
const PY_WS = "\\t\\n\\v\\f\\r\\x1c\\x1d\\x1e\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

function pyStrip(s: string): string {
  return s.replace(new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g"), "");
}

/** python `str(e)` (message only, no type prefix). */
function excStr(e: unknown): string {
  const m = (e as { pyMsg?: string })?.pyMsg;
  if (m !== undefined) {
    return m;
  }
  return String((e as Error)?.message ?? e);
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (Array.isArray(v)) return "list";
  return "dict";
}

/** python truthiness (`if x`, `x or y`). */
function pyTruth(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** python `str(x)`。 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return pyReprNumber(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (v instanceof Map) return `{${[...v.entries()].map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`).join(", ")}}`;
  if (v instanceof Set) return `{${[...v].map(pyRepr).join(", ")}}`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.repr === "function") return String((o.repr as () => unknown)());
    return `{${Object.keys(o).map((k) => `${pyRepr(k)}: ${pyRepr(o[k])}`).join(", ")}}`;
  }
  return String(v);
}

function pyReprNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(v);
}

/** python `repr(x)` — only used for the multi-part image message shapes. */
function pyRepr(v: unknown): string {
  if (typeof v === "string") return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return pyStr(v);
}

/** python `len(x)`. */
function pyLen(v: unknown): number {
  if (typeof v === "string") return [...v].length;
  if (Array.isArray(v)) return v.length;
  if (v instanceof Map || v instanceof Set) return v.size;
  if (v !== null && typeof v === "object") return Object.keys(v as object).length;
  throw new TypeError(`object of type '${pyTypeName(v)}' has no len()`);
}

/** python `int(x)`：截断向零，非法输入抛错（调用点的 except 负责兜住）。 */
function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (Number.isNaN(v)) throw new RangeError("cannot convert float NaN to integer");
    if (!Number.isFinite(v)) throw new RangeError("cannot convert float infinity to integer");
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const s = pyStrip(v);
    if (/^[-+]?[0-9]+$/u.test(s)) return Number(s);
    throw new RangeError(`invalid literal for int() with base 10: '${s}'`);
  }
  throw new TypeError(
    `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

/** python `int(a / b)` with `//` floor semantics (source uses `//` on a ratio). */
function pyFloorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** python `dict.get(k, default)` — present-but-null returns null, not default. */
function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    throw new TypeError(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  return key in (obj as object) ? (obj as Record<string, unknown>)[key] : dflt;
}

/** python `dict.setdefault(k, d)` — the caller evaluates `d` eagerly, as python does. */
function dictSetDefault(obj: Record<string, unknown>, key: string, dflt: unknown): unknown {
  if (!(key in obj)) {
    obj[key] = dflt;
  }
  return obj[key];
}

/** python `getattr(obj, name, default)`. */
function pyGetAttr(obj: unknown, name: string, dflt: unknown = null): unknown {
  if (obj === null || obj === undefined) return dflt;
  const v = (obj as Record<string, unknown>)[name];
  return v === undefined ? dflt : v;
}

/** python `hasattr(obj, name)` — a callable-or-value presence test. */
function pyHasAttr(obj: unknown, name: string): boolean {
  return obj !== null && obj !== undefined && (obj as Record<string, unknown>)[name] !== undefined;
}

/**
 * python `isinstance(v, dict)`.
 *
 * A class instance is NOT a dict in python, so the plain-prototype test is the
 * faithful analogue: a `Row`-shaped row object must take the `else` branch
 * (iterate its own `.keys()`), not be treated as an already-plain mapping.
 * (Same helper shape as the ls probe's `isPlainObject`.)
 */
function isDict(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Map) {
    return false;
  }
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** python `sorted(<str iterable>)`, code-point ordered (not UTF-16 code-unit). */
function pySortedStr(vals: string[]): string[] {
  return [...vals].sort((a, b) => {
    const ca = [...a].map((c) => c.codePointAt(0) as number);
    const cb = [...b].map((c) => c.codePointAt(0) as number);
    const n = Math.min(ca.length, cb.length);
    for (let i = 0; i < n; i++) {
      if (ca[i] !== cb[i]) return (ca[i] as number) - (cb[i] as number);
    }
    return ca.length - cb.length;
  });
}

/** `for k in mapping` — python iterates keys, whether dict or ordered Map. */
function dictKeys(reg: unknown): string[] {
  if (reg instanceof Map) return [...reg.keys()].map((k) => String(k));
  if (reg !== null && typeof reg === "object") return Object.keys(reg as object);
  return [];
}

function dictValues(reg: unknown): string[] {
  if (reg instanceof Map) return [...reg.values()].map((v) => String(v));
  if (reg !== null && typeof reg === "object") {
    return Object.values(reg as Record<string, unknown>).map((v) => String(v));
  }
  return [];
}

/** python `os.path.expanduser` for the `~` prefix (mirrors ntpath.expanduser). */
function pyExpanduser(p: string): string {
  if (!p.startsWith("~")) return p;
  let i = 1;
  while (i < p.length && p[i] !== "\\" && p[i] !== "/") i++;
  const env = ADMISSION_SEAMS.environ();
  let userhome: string | null = null;
  if ("USERPROFILE" in env) userhome = env["USERPROFILE"] ?? null;
  else if (!("HOMEPATH" in env)) return p;
  else userhome = `${env["HOMEDRIVE"] ?? ""}${env["HOMEPATH"] ?? ""}`;
  if (userhome === null) return p;
  if (i !== 1) {
    const targetUser = p.slice(1, i);
    if (targetUser !== (env["USERNAME"] ?? null)) return p;
  }
  return userhome + p.slice(i);
}

// ── seams（python 的模块全局与函数内导入在这里可替换；默认值 = 真端口） ──────────

type AnyMod = Record<string, any>;

export const ADMISSION_SEAMS = {
  /** python `time.time()`。 */
  now: (): number => Date.now() / 1000,
  /** python `uuid.uuid4()`（`str()` 形态由调用点补）。 */
  uuid4: (): string => {
    // RULEBOOK §1: node:crypto randomUUID() — hyphenated lowercase, same shape
    // as str(uuid.uuid4()).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return cryptoRandomUUID();
  },
  /** python `os.path.expanduser`（home 查找是唯一宿主触点）。 */
  expanduser: (p: string): string => pyExpanduser(p),
  /** python `os.path.abspath`。 */
  abspath: (p: string): string => p,
  /** python `os.path.isdir`。 */
  isdir: (_p: string): boolean => false,
  /** python `os.environ`。 */
  environ: (): Record<string, string | undefined> => process.env as Record<string, string | undefined>,
  /** python 模块级 `from router_modules.loop import INTERRUPT_NOTE_TYPE, INTERRUPT_NUDGE`。 */
  loopModule: (): { INTERRUPT_NOTE_TYPE: string; INTERRUPT_NUDGE: string } => ({
    INTERRUPT_NOTE_TYPE,
    INTERRUPT_NUDGE,
  }),
  /** python `from memory_layer import MemoryScope`（函数级，在 try 之外）。 */
  memoryLayerModule: (): AnyMod => _memory_layer_mod as AnyMod,
  /** python `from evolution import get_evolution_engine, _propose_facts, EvolutionObservation`。 */
  evolutionModule: (): AnyMod => _evolution_mod as AnyMod,
  /** python `from subagent_runtime import register_task_tool`。 */
  subagentRuntimeModule: (): AnyMod => _subagent_runtime_mod as AnyMod,
  /** python `from context_refs import (...)`（Rust wave，未移植）。 */
  contextRefsModule: (): AnyMod => _context_refs_mod as AnyMod,
  /** python `from episode_manager import get_episode_manager`。 */
  episodeManagerModule: (): AnyMod => _episode_manager_mod as AnyMod,
  /** python `from task_states import record_task_state_transition, TurnStatus`。 */
  taskStatesModule: (): AnyMod => _task_states_mod as AnyMod,
  /** python `from model_registry import normalize_effort, supports_effort`。 */
  modelRegistryModule: (): AnyMod => _model_registry_mod as AnyMod,
  /** python `from loop_detector import LoopDetector`。 */
  loopDetectorModule: (): AnyMod => _loop_detector_mod as AnyMod,
  /** python `from repeat_tool_guard import RepeatToolGuard`。 */
  repeatToolGuardModule: (): AnyMod => _repeat_tool_guard_mod as AnyMod,
  /** python `from token_analytics import get_token_analytics`（unit 167，已落地）。 */
  tokenAnalyticsModule: (): AnyMod => _token_analytics_mod as AnyMod,
  /** python `from shadow_session import inject_context, shadow_enabled`。 */
  shadowSessionModule: (): AnyMod => _shadow_session_mod as AnyMod,
  /** python `from shadow_workspace import maybe_auto_apply`。 */
  shadowWorkspaceModule: (): AnyMod => _shadow_workspace_mod as AnyMod,
  /** python `from review_prefix_cache import lineage_for_fork`。 */
  reviewPrefixCacheModule: (): AnyMod => _review_prefix_cache_mod as AnyMod,
  /** python `from hook_runner import init_hooks`。 */
  hookRunnerModule: (): AnyMod => _hook_runner_mod as AnyMod,
  /** python `from evolution_bridge import notify_user_correction`。 */
  evolutionBridgeModule: (): AnyMod => _evolution_bridge_mod as AnyMod,
  /** python `from evolution_pressure import probe_context_pressure`。 */
  evolutionPressureModule: (): AnyMod => _evolution_pressure_mod as AnyMod,
  /** python `sys.modules.get("router")`。 */
  routerModule: (): AnyMod | null => _router_mod as AnyMod | null,
  /** python 模块级 `from executors import cancel_call`（cancel_hard 的兜底）。 */
  cancel_call: (call_id: string): boolean => cancel_call(call_id),
  /** python 模块级 `from ask_user import get_ask_user_store`。 */
  get_ask_user_store: (): any => get_ask_user_store(),
  /** python 模块级 `from rule_engine import get_rule_engine`。 */
  get_rule_engine: (workspace_dir: string): any => get_rule_engine(workspace_dir),
  /** python `importlib.import_module(name)`。 */
  importModule: (name: string): AnyMod => ({ __missing__: name }) as AnyMod,
};

/** 探针用：整体替换 seams（对应 python 侧 monkeypatch 模块全局）。 */
export function _set_seams_for_parity(patch: Partial<typeof ADMISSION_SEAMS>): void {
  Object.assign(ADMISSION_SEAMS, patch);
}

/** 探针用：恢复默认实现（对应 python 侧 reload）。 */
export function _reset_seams_for_parity(): void {
  ADMISSION_SEAMS.now = (): number => Date.now() / 1000;
  ADMISSION_SEAMS.uuid4 = (): string => cryptoRandomUUID();
  ADMISSION_SEAMS.expanduser = (p: string): string => pyExpanduser(p);
  ADMISSION_SEAMS.abspath = (p: string): string => p;
  ADMISSION_SEAMS.isdir = (): boolean => false;
  ADMISSION_SEAMS.environ = (): Record<string, string | undefined> =>
    process.env as Record<string, string | undefined>;
  ADMISSION_SEAMS.loopModule = (): { INTERRUPT_NOTE_TYPE: string; INTERRUPT_NUDGE: string } => ({
    INTERRUPT_NOTE_TYPE,
    INTERRUPT_NUDGE,
  });
  ADMISSION_SEAMS.memoryLayerModule = (): AnyMod => _memory_layer_mod as AnyMod;
  ADMISSION_SEAMS.evolutionModule = (): AnyMod => _evolution_mod as AnyMod;
  ADMISSION_SEAMS.subagentRuntimeModule = (): AnyMod => _subagent_runtime_mod as AnyMod;
  ADMISSION_SEAMS.contextRefsModule = (): AnyMod => _context_refs_mod as AnyMod;
  ADMISSION_SEAMS.episodeManagerModule = (): AnyMod => _episode_manager_mod as AnyMod;
  ADMISSION_SEAMS.taskStatesModule = (): AnyMod => _task_states_mod as AnyMod;
  ADMISSION_SEAMS.modelRegistryModule = (): AnyMod => _model_registry_mod as AnyMod;
  ADMISSION_SEAMS.loopDetectorModule = (): AnyMod => _loop_detector_mod as AnyMod;
  ADMISSION_SEAMS.repeatToolGuardModule = (): AnyMod => _repeat_tool_guard_mod as AnyMod;
  ADMISSION_SEAMS.tokenAnalyticsModule = (): AnyMod => _token_analytics_mod as AnyMod;
  ADMISSION_SEAMS.shadowSessionModule = (): AnyMod => _shadow_session_mod as AnyMod;
  ADMISSION_SEAMS.shadowWorkspaceModule = (): AnyMod => _shadow_workspace_mod as AnyMod;
  ADMISSION_SEAMS.reviewPrefixCacheModule = (): AnyMod => _review_prefix_cache_mod as AnyMod;
  ADMISSION_SEAMS.hookRunnerModule = (): AnyMod => _hook_runner_mod as AnyMod;
  ADMISSION_SEAMS.evolutionBridgeModule = (): AnyMod => _evolution_bridge_mod as AnyMod;
  ADMISSION_SEAMS.evolutionPressureModule = (): AnyMod => _evolution_pressure_mod as AnyMod;
  ADMISSION_SEAMS.routerModule = (): AnyMod | null => _router_mod as AnyMod | null;
  ADMISSION_SEAMS.cancel_call = (call_id: string): boolean => cancel_call(call_id);
  ADMISSION_SEAMS.get_ask_user_store = (): any => get_ask_user_store();
  ADMISSION_SEAMS.get_rule_engine = (workspace_dir: string): any => get_rule_engine(workspace_dir);
  ADMISSION_SEAMS.importModule = (name: string): AnyMod => ({ __missing__: name }) as AnyMod;
}

// 已落地的真端口（静态 import；对应源里的模块级 import 或函数级 import 的成功分支）。
import * as _memory_layer_mod from "../memory_layer.js";
import * as _evolution_mod from "../evolution.js";
import * as _episode_manager_mod from "../episode_manager.js";
import * as _task_states_mod from "../task_states.js";
import * as _model_registry_mod from "../model_registry.js";
import * as _loop_detector_mod from "../loop_detector.js";
import * as _repeat_tool_guard_mod from "../repeat_tool_guard.js";
import * as _token_analytics_mod from "../token_analytics.js";
import * as _shadow_session_mod from "../shadow_session.js";
import * as _shadow_workspace_mod from "../shadow_workspace.js";
import * as _review_prefix_cache_mod from "../review_prefix_cache.js";
import * as _hook_runner_mod from "../hook_runner.js";
import * as _evolution_bridge_mod from "../evolution_bridge.js";
import * as _evolution_pressure_mod from "../evolution_pressure.js";

// 未落地单元（module 级缺失 = python 的 ImportError）：默认返回一个空模块，
// 让调用点的 except 分支与源逐字等价。unit 187/190 落地后由真 import 取代。
const _subagent_runtime_mod: AnyMod = {};
const _context_refs_mod: AnyMod = {};
let _router_mod: AnyMod | null = null;

function cryptoRandomUUID(): string {
  return globalThis.crypto.randomUUID();
}

// ── 宿主提供的方法（其它 mixin / 单元；对应 python 的 Router 组合类） ─────────

/** 宿主未提供时抛出——与 goal.ts 的 `handle` 桩同一约定。 */
function hostMissing(name: string): never {
  throw new Error(`${name} must be implemented by host router`);
}

// ── mixin ────────────────────────────────────────────────────────────────────

export class RouterAdmissionMixin {
  /** Mixin providing session/workspace lifecycle, usage tracking, cancellation,
   *  and handle entrypoint. */
  [k: string]: any;

  //: How many stored rows the fold path reads.
  //:
  //: `should_fold` compares ``len(messages)`` against ``_folded_upto`` — "how long
  //: was the history the last time we folded" — to decide whether anything new has
  //: happened. Reading a small page makes that count top out at the page size, and
  //: once the watermark reaches the ceiling every later auto-fold answers
  //: `no-new-content` and folding quietly stops for the rest of the session. The
  //: default page was 100, so that happened on any reasonably long conversation.
  //:
  //: Generous rather than unbounded: the summariser has to read whatever this
  //: returns, so an uncapped select would eventually be its own problem.
  static readonly FOLD_SCAN_LIMIT: number = 2000;

  get FOLD_SCAN_LIMIT(): number {
    return RouterAdmissionMixin.FOLD_SCAN_LIMIT;
  }

  //: 工业级自主运行循环：默认无步数截断（0 代表无限制，持续执行直至模型收敛或用户中断）
  static readonly MAX_AGENT_STEPS: number = 0;

  get MAX_AGENT_STEPS(): number {
    return RouterAdmissionMixin.MAX_AGENT_STEPS;
  }

  //: 软着陆步数判定（仅在显式设置了正数上限时生效）
  static readonly SOFT_LANDING_STEP: number = -1;

  get SOFT_LANDING_STEP(): number {
    return RouterAdmissionMixin.SOFT_LANDING_STEP;
  }

  // ── 折叠预算 ─────────────────────────────────────────────────────────────

  _sync_fold_budget(): void {
    /**
     * Point the compactor's budget at the ACTIVE model's context window.
     *
     * The compactor defaults to 80K, but the real budget depends on which model
     * is selected — a 1M-context model should fold far later than a 32K one.
     * Resolved lazily each fold rather than cached, since the user can switch
     * models mid-session. Silent no-op if the registry reports no limit.
     */
    try {
      const info: any = this.models.resolve(this._turn_model || null);
      if (!info.ok) {
        return;
      }
      const v: any = info.value || {};
      const limit = v["context_limit"] || v["context"] || v["max_input_tokens"];
      // python `isinstance(limit, (int, float))` — bool IS an int in python.
      if ((typeof limit === "number" || typeof limit === "boolean") && (limit as number) > 0) {
        this.compactor.max_tokens = pyInt(limit);
        this.compactor.reserved_tokens = Math.min(20000, pyInt((limit as number) * 0.15));
      }
    } catch {
      // fail-open: 可选增强，失败不影响主流程
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }
  }

  async _synthesize_for_fold(messages: any[]): Promise<Record<string, any> | null> {
    /**
     * LLM layer of the fold chain: {Goal, Progress, Decisions, Open Issues}.
     * Returns None when there is no usable model or the call fails, which makes
     * the compactor fall through to its heuristic layer.
     */
    if (!(this.llm && this.llm.api_key)) {
      return null;
    }
    // sqlite3.Row is not JSON-serializable; normalize to plain dicts.
    const norm: any[] = [];
    for (const m of messages) {
      if (isDict(m)) {
        norm.push(m);
      } else {
        try {
          const o: Record<string, any> = {};
          const ks: any[] = typeof (m as any).keys === "function"
            ? [...(m as any).keys()]
            : Object.keys(m as object);
          for (const k of ks) {
            o[k] = (m as any)[k];
          }
          norm.push(o);
        } catch {
          continue;
        }
      }
    }
    const r: any = await this.memory.synthesize_session(this.session_id, norm);
    if (r && r.ok && isDict(r.value)) {
      return r.value;
    }
    return null;
  }

  async _flush_memory_for_fold(messages: any[]): Promise<number> {
    /**
     * Pre-compaction memory extraction: pull decisions/preferences from the
     * about-to-be-folded segment and persist them to the memory store.
     *
     * Called by the compactor before it generates a summary. Extracts from
     * both user instructions and assistant conclusions, strictly bound to
     * current session_id and scope=session to prevent cross-session leaks (P1-5).
     *
     * Returns the number of memories extracted.
     */
    let count = 0;
    // 源里这一行在 try 之外：memory_layer 缺失会向上抛，不是被吞。
    const MemoryScope: any = (ADMISSION_SEAMS.memoryLayerModule() as AnyMod)["MemoryScope"];
    for (const m of messages) {
      let content: any = "";
      if (isDict(m)) {
        content = dictGet(m, "content", "");
      } else {
        try {
          if (m === null || m === undefined) {
            throw new TypeError(`'${pyTypeName(m)}' object is not subscriptable`);
          }
          content = (m as any)["content"] || "";
        } catch (e) {
          // 源为 `except (KeyError, TypeError): continue` —— 窄吞保持窄。
          if (e instanceof TypeError) {
            continue;
          }
          throw e;
        }
      }
      if (!pyTruth(content) || pyLen(content) < 10) {
        continue;
      }
      try {
        const extracted: any[] = this.memory.extract(content, this.session_id);
        for (const mem of extracted) {
          mem.session_id = this.session_id;
          mem.scope = MemoryScope.SESSION;
          this.memory.store(mem);
        }
        count += pyLen(extracted);

        if (pyTruth(extracted)) {
          try {
            const evoMod: AnyMod = ADMISSION_SEAMS.evolutionModule();
            const get_evolution_engine = evoMod["get_evolution_engine"] as (ws: unknown) => any;
            const _propose_facts = evoMod["_propose_facts"] as (...a: any[]) => any;
            const EvolutionObservation = evoMod["EvolutionObservation"] as new (o: any) => any;
            const evo: any = get_evolution_engine(pyGetAttr(this, "workspace", null));
            if (evo && evo.enabled()) {
              const fact_texts = extracted
                .map((mm) => pyGetAttr(mm, "content", ""))
                .filter((t) => pyTruth(t));
              if (pyTruth(fact_texts)) {
                const obs = new EvolutionObservation({
                  decision: "LEARN_FACTS",
                  session_id: this.session_id,
                  new_facts: fact_texts,
                });
                _propose_facts(obs, evo, pyGetAttr(this, "storage", null));
              }
            }
          } catch {
            // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留——演化提议
            // 是可选增强，失败不该影响记忆抽取本身。
          }
        }
      } catch {
        // fail-open: 可选增强，失败不影响主流程
        // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
      }
    }
    return count;
  }

  async _register_analysis_tools(): Promise<void> {
    /**
     * Register asset-derived analysis tools (best-effort, once).
     *
     * Each module exposes ``register_tools(registry)``; a missing data file or
     * import error for one must not block the others.
     *
     * DIVERGENCE(port): `importlib.import_module` is synchronous, ESM `import()`
     * is not, so this method is async. Behaviour per module is unchanged
     * (loaded → `register_tools` called when present → otherwise skipped).
     */
    for (const mod_name of [
      "diagnostics", "security_audit", "red_team", "recommender",
      "goal_plan", "tool_catalog", "memory_tools", "skill_tools",
    ]) {
      try {
        const mod: any = await ADMISSION_SEAMS.importModule(mod_name);
        if (pyHasAttr(mod, "register_tools")) {
          mod.register_tools(this.tools);
        }
      } catch {
        continue;
      }
    }
    // The `task` tool (sub-agent delegation). Registered here rather than in
    // the loop above because its schema enumerates the sub-agent registry at
    // import time, so it needs its own try/except — a broken user-authored
    // sub-agent YAML must not take the analysis tools down with it.
    try {
      const m: AnyMod = ADMISSION_SEAMS.subagentRuntimeModule();
      const register_task_tool = m["register_task_tool"] as (t: unknown) => unknown;
      register_task_tool(this.tools);
    } catch {
      // fail-open: 可选增强，失败不影响主流程
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }
  }

  async _on_before_compact(event: Event): Promise<void> {
    /** Synthesize the session into structured memory before history is compacted.
     *
     * Compaction throws away raw turns; the synthesis (Goal / Progress /
     * Decisions / Open Issues) is what survives into the next session.
     */
    const sid = (dictGet(event.payload, "session_id", null) || this.session_id) as string;
    // Prefer the list the emitter already read — re-reading here would both
    // duplicate the query and risk synthesising a different window than the one
    // about to be folded.
    let messages: any = dictGet(event.payload, "messages", null);
    if (!pyTruth(messages)) {
      messages = this.storage.get_messages(sid, this.FOLD_SCAN_LIMIT) || [];
    }
    await this.memory.synthesize_session(sid, messages);
  }

  async start_background(): Promise<void> {
    /** Start background loops (memory dream consolidation).
     *
     * Call once from an async entrypoint. Safe to call more than once.
     */
    await this.memory.start_background();
  }

  async stop_background(): Promise<void> {
    /** Stop background loops and cancel pending debounced extractions. */
    await this.memory.stop_background();
  }

  async fold_context(manual = true): Promise<Result> {
    /** Fold (compact) the current session's history into a summary.
     *
     * This is the single entry point for both paths:
     *   * manual  — user ran ``/fold`` or clicked the button; bypasses the
     *     cooldown and the "no new content" check.
     *   * auto    — called from ``handle`` when the budget threshold is crossed.
     *
     * Emits ``session_before_compact`` first so memory_layer can persist the
     * cross-session synthesis before raw turns stop being replayed.
     *
     * Returns:
     *     Result carrying the fold report, or a failure whose ``error`` is a
     *     reason code (``cooldown`` / ``under-threshold`` / ``max-consecutive``
     *     / ``no-new-content`` / ``too-short`` / ``already-folding``).
     */
    const messages: any[] = this.storage.get_messages(this.session_id, this.FOLD_SCAN_LIMIT) || [];
    this._sync_fold_budget();
    const [ok, reason] = this.compactor.should_fold(messages, manual) as [boolean, string];
    if (!ok) {
      return Result.failure(reason);
    }

    // Let subscribers (memory_layer synthesis) run before we fold.
    //
    // `folds_itself` claims ownership of the fold. The compactor subscribes to
    // this same event and folds when it fires, so without the claim one request
    // ran the summariser twice — two model calls, two `_consecutive` bumps, two
    // compaction rows in the transcript.
    try {
      await this.bus.emit("session_before_compact", {
        session_id: this.session_id,
        messages,
        manual,
        folds_itself: true,
      });
    } catch {
      // a failing subscriber must not block the fold itself
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }

    const report: any = await this.compactor.fold(this.session_id, messages, manual);
    if (report.ok) {
      // Tighten loop detection for the next few steps. Compaction just removed
      // the model's short-term record of what it already tried, which is
      // exactly when it is most likely to walk back into a dead end it had
      // already found — and least able to notice by itself.
      this.loop_detector.note_compaction();
    }
    return report;
  }

  async _auto_fold_if_needed(): Promise<Record<string, any> | null> {
    /** Fold before a turn if the budget is nearly spent. Returns the report. */
    const r: any = await this.fold_context(false);
    return r.ok ? r.value : null;
  }

  async _maybe_fold_on_pressure(context: Record<string, any>): Promise<void> {
    /** Probe context pressure at async turn completion, dispatch signal and fold if needed. */
    try {
      const probe_context_pressure = ADMISSION_SEAMS.evolutionPressureModule()[
        "probe_context_pressure"] as (...a: any[]) => any;
      const comp = pyGetAttr(this, "compactor", null);
      const budget = comp ? pyGetAttr(comp, "max_tokens", 80000) : 80000;
      const th = comp ? pyGetAttr(comp, "threshold", 0.8) : 0.8;
      const turn_id = String(context["turn_id"] || `turn_${pyGetAttr(this, "_turn_seq", 1)}`);
      const msgs = pyHasAttr(this, "storage")
        ? this.storage.get_messages(this.session_id, pyGetAttr(this, "FOLD_SCAN_LIMIT", 50))
        : [];

      let triggered = Boolean(context["context_pressure_triggered"]);
      if (!triggered && pyTruth(msgs)) {
        const res = probe_context_pressure(msgs, {
          max_context_tokens: budget,
          threshold: th,
          session_id: this.session_id,
          turn_id,
        });
        triggered = Boolean(res[0]);
      }

      if (triggered) {
        const now = ADMISSION_SEAMS.now();
        const last_fold = pyGetAttr(this, "_last_pressure_fold_at", 0.0) as number;
        if (now - last_fold >= 600.0) { // 10 分钟防抖
          this._last_pressure_fold_at = now;
          if (pyHasAttr(this, "fold_context")) {
            await this.fold_context(true);
          }
        }
      }
    } catch {
      // fail-open
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }
  }

  // ── 取消 ────────────────────────────────────────────────────────────────

  cancel(): void {
    /** Request cancellation of the in-flight turn.
     *
     * Cooperative, not preemptive: the agent loop checks the flag between
     * steps and before each tool call, so a turn stops at the next safe
     * boundary rather than being killed mid-write. A tool that is already
     * running finishes — interrupting a half-written file would be worse than
     * waiting for it.
     */
    this._cancelled.set();
  }

  cancel_hard(): number {
    /** Request cancellation **and** kill whatever is running right now.
     *
     * ``cancel()`` alone is cooperative: it is checked at step boundaries and
     * before a tool batch, so a turn sitting inside a 10-minute build keeps
     * going until that build ends. For a user-facing Pause that is the wrong
     * contract — "stop" has to mean stop, the way SIGTERM+grace→SIGKILL does
     * in a container runtime: ask nicely, then make it true.
     *
     * Returns how many live commands were actually killed. The killed calls
     * settle as ``unknown`` in the side-effect ledger (see the ``CancelledError``
     * branch of ``_execute_tool_call``), never as ``failed`` — a write that was
     * already dispatched may well have landed.
     */
    this._cancelled.set();
    let killed = 0;
    const routerMod = ADMISSION_SEAMS.routerModule();
    const _cancel = (routerMod && (routerMod as AnyMod)["cancel_call"] !== undefined
      ? (routerMod as AnyMod)["cancel_call"]
      : ADMISSION_SEAMS.cancel_call) as (id: string) => boolean;
    for (const call_id of dictKeys(this._live_calls)) {
      try {
        if (_cancel(call_id)) {
          killed += 1;
        }
      } catch (exc) {
        // BUG(port): 源为 `except Exception as exc`，宽吞逐字保留——一条杀不掉
        // 的调用不该中断对其余调用的清理。
        console.log(`[router] hard-cancel of ${call_id} failed: ${excStr(exc)}`);
      }
    }
    return killed;
  }

  live_call_names(): string[] {
    /** Tool names of the calls currently in flight. For honest reporting. */
    return pySortedStr(dictValues(this._live_calls));
  }

  _cancel_requested(): boolean {
    return this._cancelled.is_set();
  }

  _clear_cancel(): void {
    this._cancelled.clear();
  }

  _current_turn_seq(): number {
    /** The seq of the message that started this turn. Used as the snapshot
     * checkpoint handle — file snapshots and chat truncation both reference
     * this number. */
    return this._turn_seq;
  }

  // ── steer 收件箱 ────────────────────────────────────────────────────────

  async _drain_steer_into(messages: any[], step: number): Promise<boolean> {
    /** Inject every pending steer message onto the conversation as a user
     * turn, in arrival order. Returns True when at least one was injected.
     *
     * Called at the step boundary — the only point where slipping a user
     * message in is legal (no half-open assistant tool_calls awaiting their
     * results). The whole steer queue is drained, not one per step, so three
     * corrections fired during one slow tool all land on the next model call
     * rather than trickling in over three steps.
     *
     * Two limits keep a hammering user from wrecking the next model call:
     * * ``poll_steer`` drops messages past ``STEER_TTL_S`` — a correction the
     *   user queued five minutes ago and has since forgotten about would drag
     *   a converged conversation back onto an abandoned branch.
     * * ``MAX_STEER_MERGED_CHARS`` caps the total injected text. Past the cap
     *   we stop injecting and leave a one-line note, so the model knows more
     *   was said rather than silently receiving a truncated instruction.
     *
     * Best-effort: a missing queue or an empty message is skipped, never
     * raised, because a steering hiccup must not kill the turn.
     */
    const queue: any = pyGetAttr(this, "queue", null);
    const steer_q: any = pyGetAttr(this, "steer_queue", null);
    if (queue === null && (steer_q === null || !steer_q.has_pending())) {
      return false;
    }
    let injected = 0;
    let budget = MAX_STEER_MERGED_CHARS;
    let dropped = 0;

    // Drain standalone SteerQueue first (only if not bridged to queue to avoid double draining)
    if (steer_q !== null && pyGetAttr(steer_q, "_msg_queue", null) === null && steer_q.has_pending()) {
      for (const s_item of steer_q.drain_all()) {
        const s_text = pyStrip((s_item.text || "") as string);
        if (!s_text) {
          continue;
        }
        if (pyLen(s_text) > budget) {
          dropped += 1;
          continue;
        }
        budget -= pyLen(s_text);
        messages.push({ role: "user", content: s_text });
        injected += 1;
        try {
          const notify_user_correction = ADMISSION_SEAMS.evolutionBridgeModule()[
            "notify_user_correction"] as (...a: any[]) => unknown;
          notify_user_correction(this.session_id, `turn_${this._turn_seq}`, s_text);
        } catch {
          // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
        }
      }
    }

    // Guard the loop with a hard cap: a runaway producer must not spin here
    // forever holding the step boundary open.
    if (queue !== null) {
      for (let _i = 0; _i < 64; _i++) {
        const msg = await queue.poll_steer();
        if (msg === null || msg === undefined) {
          break;
        }
        const text = pyStrip((pyGetAttr(msg, "content", "") || "") as string);
        if (!text) {
          continue;
        }
        if (pyLen(text) > budget) {
          // Out of room. Keep draining so the queue doesn't stay full and
          // replay on the next boundary, but count what we're discarding.
          dropped += 1;
          continue;
        }
        budget -= pyLen(text);
        messages.push({ role: "user", content: text });
        injected += 1;
        try {
          const notify_user_correction = ADMISSION_SEAMS.evolutionBridgeModule()[
            "notify_user_correction"] as (...a: any[]) => unknown;
          notify_user_correction(this.session_id, `turn_${this._turn_seq}`, text);
        } catch {
          // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
        }
      }
    }

    if (dropped) {
      messages.push({
        role: "user",
        content: `（另有 ${dropped} 条纠偏消息因超出本轮注入上限被丢弃，`
          + "如果仍然需要请重说一次。）",
      });
    }
    if (injected) {
      this._clear_cancel();
    }
    if (injected || dropped) {
      // Tell the UI the steer actually landed. The frontend already
      // declares this event type; without an emitter the optimistic
      // bubble was the only feedback the user ever got.
      try {
        await this.bus.emit("steer_applied", {
          session_id: this.session_id,
          step,
          injected,
          dropped,
        });
      } catch {
        // fail-open: 可选增强，失败不影响主流程
        // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
      }
    }
    return Boolean(injected || dropped);
  }

  // ── @ references (六·UB2) ─────────────────────────────────────────────

  async _inject_context_refs(messages: any[], context: Record<string, any>): Promise<Record<string, any>> {
    /** Resolve this turn's @-refs and prepend them as their own message.
     *
     * Returns the summary dict (also emitted on the bus), or ``{}`` when the
     * turn carried no refs.
     *
     * A SEPARATE message rather than text glued onto the user's sentence. Three
     * reasons, in order of how much they bit us:
     *
     * * The model could not tell the difference between "the user typed a path"
     *   and "the system attached a file", so it kept calling ``read_file`` on
     *   something it had already been given.
     * * A file whose content happens to contain the closing marker could end the
     *   block early and have the rest of itself read as the user's own words.
     * * Compaction folds messages, and a fold that summarizes away the user's
     *   request while keeping 20k tokens of attached file is the wrong trade.
     *   Separate messages let the compactor make that choice per message.
     *
     * Placed BEFORE the user's message so the request is the last thing the
     * model reads. Attachments are context for the question; the question comes
     * last, where instruction-following is strongest.
     */
    const raw = context["context_refs"];
    if (!Array.isArray(raw) || !raw.length) {
      return {};
    }
    const CR: AnyMod = ADMISSION_SEAMS.contextRefsModule();
    const DEFAULT_REF_BUDGET = CR["DEFAULT_REF_BUDGET"] as number;
    const split_by_modality = CR["split_by_modality"] as (r: any) => [any[], any[]];
    const resolve_refs = CR["resolve_refs"] as (...a: any[]) => any[];
    const resolve_images = CR["resolve_images"] as (...a: any[]) => any[];
    const render_refs = CR["render_refs"] as (rows: any[]) => string;
    const image_blocks = CR["image_blocks"] as (rows: any[]) => any[];
    const render_vision_unavailable = CR["render_vision_unavailable"] as (rows: any[]) => string;
    const refs_summary = CR["refs_summary"] as (rows: any[]) => Record<string, any>;

    const [text_refs, image_refs] = split_by_modality(raw);
    // Never let attachments claim more than a quarter of the window: the
    // history, the system prompt and the reply all still have to fit, and a
    // small-context model would otherwise be handed a request it must reject.
    const ceiling = pyFloorDiv(pyInt(pyGetAttr(this.llm, "context_limit", 0) || 0), 4);
    const budget = ceiling ? Math.min(DEFAULT_REF_BUDGET, ceiling) : DEFAULT_REF_BUDGET;
    let rows: any[];
    let img_rows: any[];
    try {
      rows = resolve_refs(text_refs, this.workspace, budget) as any[];
      img_rows = resolve_images(image_refs, this.workspace) as any[];
    } catch (exc) {
      // A failed attachment must not lose the user's turn. Tell the model
      // the attachment is missing rather than silently answering as if the
      // user had sent nothing — a confident answer about a file nobody read
      // is worse than an admission.
      messages.push({
        role: "user",
        content: `（用户附加了 ${pyLen(raw)} 项引用内容，但系统读取失败：${excStr(exc)}。`
          + "请据此说明，或用工具自行读取。）",
      });
      return {};
    }
    const body = render_refs(rows);
    if (body) {
      messages.push({ role: "user", content: body });
    }

    // Images. The blocks ride on the USER message (composed by the caller),
    // not on a message of their own: a provider expects the image to sit in
    // the same turn as the question about it, and splitting them costs the
    // model the association.
    if (pyTruth(img_rows)) {
      if (this._model_can_read_images()) {
        context["_image_blocks"] = image_blocks(img_rows);
      } else {
        // 一·A3's lesson, enforced: an image this model cannot process is
        // announced, never dropped. Silently discarding it produces a
        // reply that confidently answers a question about a picture it
        // never received.
        context["_vision_note"] = render_vision_unavailable(img_rows);
      }
      const failed = img_rows.filter((r) => !pyTruth(dictGet(r, "ok", null)));
      if (pyTruth(failed)) {
        const names = failed
          .map((r) => `${dictGet(r, "label", null)}（${dictGet(r, "error", null)}）`)
          .join("、");
        messages.push({
          role: "user",
          content: `（有 ${pyLen(failed)} 张图片未能读取：${names}）`,
        });
      }
    }

    const summary = refs_summary([...rows, ...img_rows]);
    context["context_refs_summary"] = summary;
    try {
      await this.bus.emit("context_refs_resolved", {
        session_id: this.session_id,
        ...summary,
      });
    } catch {
      // fail-open: 可选增强，失败不影响主流程
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }
    return summary;
  }

  _compose_user_content(user_message: string, context: Record<string, any>): any {
    /** The user turn's content: a plain string, or multi-part with images.
     *
     * DIVERGENCE(port): the source declares this `@staticmethod`; TS mixins are
     * composed by prototype, so it is an instance method here — every
     * `self._compose_user_content(...)` call site (loop.py:106) stays verbatim.
     * The body never reads `this`.
     *
     * Multi-part ONLY when there are images to carry. Every provider accepts a
     * bare string and some older gateways choke on a one-element part array, so
     * wrapping unconditionally would trade a working request for a cosmetic
     * consistency.
     *
     * The image blocks are consumed (`pop`) rather than read: the agent loop can
     * call the model many times per turn, and re-sending the images on every
     * step would multiply the image bill by the step count while telling the
     * model nothing it hasn't already seen in the history.
     */
    const blocks = (context["_image_blocks"] !== undefined ? context["_image_blocks"] : null) || [];
    delete context["_image_blocks"];
    const note = (context["_vision_note"] !== undefined ? context["_vision_note"] : "") || "";
    delete context["_vision_note"];
    const text = note ? `${pyStr(user_message)}\n\n${pyStr(note)}` : user_message;
    if (!pyTruth(blocks)) {
      return text;
    }
    // Text first: the question frames what to look for in the images.
    return [{ type: "text", text }, ...blocks];
  }

  // ── Usage accounting ─────────────────────────────────────────────────
  //
  // Providers each invented their own name for the same six numbers. Rather
  // than teach every consumer all the dialects, everything is normalised once,
  // here, into one flat shape. Unknown providers degrade to input/output only
  // instead of erroring — a missing cache stat is a blank cell in the
  // dashboard, not a broken turn.

  _normalize_usage(u: Record<string, any>): Record<string, any> {
    /** Map any provider's `usage` blob onto our canonical counters.
     *
     * DIVERGENCE(port): source declares `@staticmethod`; instance method here for
     * the same prototype-composition reason as `_compose_user_content` (the
     * source calls it as `self._normalize_usage(...)`). Never reads `this`.
     */
    if (!isDict(u)) {
      return {};
    }
    const det_in: any = u["prompt_tokens_details"] || {};
    const det_out: any = u["completion_tokens_details"] || {};

    // Input: OpenAI says prompt_tokens, Anthropic says input_tokens.
    const inp = pyInt(u["prompt_tokens"] || u["input_tokens"] || 0);
    // Output: completion_tokens vs output_tokens.
    const outp = pyInt(u["completion_tokens"] || u["output_tokens"] || 0);
    // Reasoning tokens hide in completion_tokens_details on OpenAI-likes.
    const reasoning = pyInt(
      dictGet(det_out, "reasoning_tokens", null)
      || u["reasoning_tokens"]
      || 0,
    );

    // Cache telemetry normalization:
    // 1. DeepSeek: prompt_cache_hit_tokens & prompt_cache_miss_tokens
    // 2. Anthropic: cache_read_input_tokens (read) & input_tokens (miss) & cache_creation_input_tokens (write)
    // 3. OpenAI: det_in.cached_tokens (read) & (prompt_tokens - cached_tokens) (miss)
    let has_cache_info = false;
    let cache_read = 0;
    let cache_miss = 0;
    const cache_creation = pyInt(
      u["cache_creation_input_tokens"]
      || u["cache_write_input_tokens"]
      || 0,
    );
    let input_is_exclusive = false;

    if ("prompt_cache_hit_tokens" in u || "prompt_cache_miss_tokens" in u) {
      has_cache_info = true;
      cache_read = pyInt(u["prompt_cache_hit_tokens"] || 0);
      cache_miss = pyInt(u["prompt_cache_miss_tokens"] || Math.max(0, inp - cache_read));
    } else if ("cache_read_input_tokens" in u || "cache_creation_input_tokens" in u) {
      has_cache_info = true;
      cache_read = pyInt(u["cache_read_input_tokens"] || 0);
      cache_miss = inp; // Anthropic input_tokens is non-cached input
      input_is_exclusive = true;
    } else if (dictGet(det_in, "cached_tokens", null) !== null || u["cached_tokens"] !== null && u["cached_tokens"] !== undefined) {
      has_cache_info = true;
      cache_read = pyInt(dictGet(det_in, "cached_tokens", null) || u["cached_tokens"] || 0);
      cache_miss = Math.max(0, inp - cache_read);
    } else if (cache_creation > 0) {
      has_cache_info = true;
      cache_read = 0;
      cache_miss = inp;
    }

    const provider_total = pyInt(u["total_tokens"] || 0);
    return {
      input: inp,
      output: outp,
      reasoning,
      cache_read,
      cache_miss,
      cache_creation,
      has_cache_info,
      input_is_exclusive,
      provider_total,
    };
  }

  _accumulate_usage(context: Record<string, any>, raw_usage: Record<string, any>): void {
    /** Fold one LLM call's usage into this turn's running total. */
    const norm = this._normalize_usage(raw_usage);
    if (!pyTruth(norm)) {
      return;
    }
    const acc: Record<string, any> = dictSetDefault(context, "_usage_accum", {
      input: 0, output: 0, reasoning: 0,
      cache_read: 0, cache_miss: 0, cache_creation: 0, provider_total: 0, calls: 0,
      has_cache_info: false,
      input_is_exclusive: false,
      last_step_context: 0,
    }) as Record<string, any>;
    for (const [k, v] of Object.entries(norm)) {
      if (k === "has_cache_info" || k === "input_is_exclusive") {
        acc[k] = Boolean(acc[k] === undefined ? false : acc[k]) || Boolean(v);
      } else {
        acc[k] = (acc[k] === undefined ? 0 : acc[k]) + (v as number);
      }
    }
    acc["calls"] = (acc["calls"] === undefined ? 0 : acc["calls"]) + 1;
    const _inp = norm["input"] === undefined ? 0 : norm["input"];
    const _cr = norm["cache_read"] === undefined ? 0 : norm["cache_read"];
    acc["last_step_context"] = (0 < _cr && _cr <= _inp && !pyTruth(norm["input_is_exclusive"]))
      ? _inp
      : _inp + _cr;
  }

  _active_model_id(): string {
    /** `provider:model` for the model that ACTUALLY served this turn.
     *
     * Resolution order matters. The composer pick rebinds ``self.llm`` in
     * :meth:`_bind_turn_model`, and a downgrade hop swaps it again mid-turn —
     * but ``self.models.resolve()`` with no argument answers from config.json.
     * Resolving config first therefore booked every switched or downgraded
     * turn under the WRONG model, and priced it at that wrong model's rate.
     * The bound client is the source of truth; config is only the fallback.
     */
    const llm = pyGetAttr(this, "llm", null);
    if (llm !== null) {
      const mid = pyStrip(pyStr(pyGetAttr(llm, "model_id", "") || ""));
      const pid = pyStrip(pyStr(pyGetAttr(llm, "provider_id", "") || ""));
      if (mid) {
        return pid ? `${pid}:${mid}` : mid;
      }
    }
    const tm = pyStrip(pyStr(pyGetAttr(this, "_turn_model", "") || ""));
    if (tm) {
      return tm;
    }
    try {
      const info: any = this.models.resolve();
      if (info.ok && isDict(info.value)) {
        const pid = info.value["provider_id"] || info.value["provider"] || "";
        let mid = info.value["model_id"] || info.value["model"] || info.value["id"] || "";
        if (!mid && this.config && isDict(dictGet(this.config, "model", null))) {
          mid = dictGet(dictGet(this.config, "model", null), "model_id", "");
        }
        if (pid && mid) {
          return `${pid}:${mid}`;
        }
        return pyStr(mid || pid || "");
      }
    } catch {
      // fail-open: 可选增强，失败不影响主流程
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }
    return "";
  }

  _record_turn_usage(context: Record<string, any>): Record<string, any> {
    /** Persist this turn's accumulated usage and return what it cost.
     *
     * Best-effort persistence by design: losing an analytics row must never
     * surface as a failed turn. The returned dict is what ``handle`` hands back
     * in ``Result.meta['usage']`` — the goal worker needs this turn's real
     * tokens and money, and re-querying the usage table for "the row I just
     * wrote" would be both racy and slower.
     *
     * Returns:
     *     ``{tokens, input, output, cache_read, cache_creation, cost_micros,
     *     cache_saved_micros, cost_source, model_id, calls}``, or ``{}`` when
     *     no LLM call happened.
     *
     * ``cache_creation`` is in here for a reason worth stating: it used to be
     * accumulated in ``_usage_accum`` and written to SQLite, but **left out of
     * this dict**. ``_emit_usage_frame`` then did
     * ``summary.get("cache_creation", 0)`` and always got 0, so the analytics
     * engine computed its hit rate as ``read / (read + 0)`` — a flat 100% for
     * every turn that read any cache at all. A key missing from a dict is a
     * silent 0, not an error.
     */
    const acc: any = context["_usage_accum"];
    if (!pyTruth(acc) || (acc["calls"] === undefined ? 0 : acc["calls"]) === 0) {
      return {};
    }
    const model_id = this._active_model_id();
    const total = (acc["input"] === undefined ? 0 : acc["input"])
      + (acc["output"] === undefined ? 0 : acc["output"])
      + (acc["reasoning"] === undefined ? 0 : acc["reasoning"]);
    // Price it here, once. Anything downstream that needs money reads this
    // figure instead of re-deriving it from tokens at a later date's rates.
    let priced: any;
    try {
      priced = this.models.cost_of(model_id, acc);
    } catch {
      // BUG(port): 源为 `except Exception`，宽吞逐字保留——定价失败退化为零成本
      // 行，绝不因此让回合失败。
      priced = { cost_micros: 0, cache_saved_micros: 0, cost_source: "" };
    }
    const summary: Record<string, any> = {
      tokens: total,
      input: acc["input"] === undefined ? 0 : acc["input"],
      output: acc["output"] === undefined ? 0 : acc["output"],
      cache_read: acc["cache_read"] === undefined ? 0 : acc["cache_read"],
      cache_miss: acc["cache_miss"] === undefined ? 0 : acc["cache_miss"],
      cache_creation: acc["cache_creation"] === undefined ? 0 : acc["cache_creation"],
      has_cache_info: acc["has_cache_info"] === undefined ? false : acc["has_cache_info"],
      cost_micros: dictGet(priced, "cost_micros", 0),
      cache_saved_micros: dictGet(priced, "cache_saved_micros", 0),
      cost_source: dictGet(priced, "cost_source", ""),
      model_id,
      calls: acc["calls"] === undefined ? 0 : acc["calls"],
      last_step_context: acc["last_step_context"] === undefined ? 0 : acc["last_step_context"],
    };
    try {
      // RULEBOOK §2: python evaluates the `dict.get` default EAGERLY, so
      // `time.time()` runs twice here (left operand + default argument) even
      // when `_turn_start` is present. Reproduced, and probe-pinned.
      const t1 = ADMISSION_SEAMS.now();
      const t2 = ADMISSION_SEAMS.now();
      const turnStart = ("_turn_start" in context ? context["_turn_start"] : t2) as number;
      const latency_ms = pyInt((t1 - turnStart) * 1000);
      this.storage.record_usage({
        sid: this.session_id,
        tid: `turn-${this._turn_seq}`,
        inp: acc["input"] === undefined ? 0 : acc["input"],
        outp: acc["output"] === undefined ? 0 : acc["output"],
        reason: acc["reasoning"] === undefined ? 0 : acc["reasoning"],
        cc: acc["cache_creation"] === undefined ? 0 : acc["cache_creation"],
        cr: acc["cache_read"] === undefined ? 0 : acc["cache_read"],
        pt: acc["provider_total"] === undefined ? 0 : acc["provider_total"],
        ct: total,
        model_id,
        latency_ms,
        cost_micros: summary["cost_micros"],
        cache_saved_micros: summary["cache_saved_micros"],
        cost_source: summary["cost_source"],
      });
    } catch (_e) {
      // 用量落库失败若无声，Usage 页与成本归因就开始撒谎（§12 纪律）
      // BUG(port): 源为 `except Exception as _e`，宽吞逐字保留。
      console.log(`[router] record_usage FAILED: ${excStr(_e)}`);
    }
    return summary;
  }

  async _emit_usage_frame(summary: Record<string, any>): Promise<void> {
    /** Push this turn's real token/cost figures out on the bus.
     *
     * Until now the numbers only went into SQLite, so the context meter the
     * user watches during a turn was a client-side estimate from message text
     * (``contextUsageStore`` says as much in its header comment) and
     * ``isEstimated`` never went false. Everything needed was already
     * computed — it just had no channel out.
     *
     * ``tokenCount`` is deliberately the CONTEXT-WINDOW occupancy
     * (``last_step_context`` or ``input + cache_read``, via :meth:`Storage.last_turn_context_tokens`),
     * not this turn's input+output total: the frontend divides it by the
     * window limit to draw the meter, and adding output tokens to that
     * numerator would overstate how full the window is.
     *
     * Best-effort: a broadcast failure must not fail the turn.
     */
    if (!pyTruth(summary)) {
      return;
    }
    let context_tokens = summary["last_step_context"] || 0;
    if (!context_tokens) {
      try {
        context_tokens = this.storage.last_turn_context_tokens(this.session_id);
      } catch {
        // BUG(port): 源为 `except Exception`，宽吞逐字保留——读不到就退化为 0，
        // 后面还有 summary 里的 token 兜底。
        context_tokens = 0;
      }
    }
    if (!context_tokens) {
      context_tokens = summary["tokens"] || 0;
    }

    // system_prompt / tool_def / skill token counts are best-effort:
    // if we can't compute them cheaply, analytics falls back to attributing
    // the remainder to 'messages'. Computed BEFORE the emit so the same
    // numbers ride the WS frame — the frontend's between-turn estimate
    // needs them, and its only other source was a mount-time fetch.
    let sp_tokens = pyGetAttr(this, "_last_turn_system_prompt_tokens", 0) as number;
    let tool_tokens = 0;
    let skill_tokens = 0;
    if (!sp_tokens) {
      try {
        sp_tokens = this.compactor.estimate_tokens(this.get_system_prompt());
      } catch {
        // fail-open: 可选增强，失败不影响主流程
        // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
      }
    }
    try {
      tool_tokens = this._tool_def_tokens();
    } catch {
      // fail-open: 可选增强，失败不影响主流程
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }
    try {
      // DIVERGENCE(port): skill_loader.render_available_skills_prompt is async
      // in TS, so `_skill_tokens` had to become async (see the file header).
      skill_tokens = await this._skill_tokens();
    } catch {
      // fail-open: 可选增强，失败不影响主流程
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }
    // Real model window for an honest denominator (0 => unknown; the
    // analytics engine keeps whatever it already had rather than
    // inventing a "typical" 200k).
    let context_window = 0;
    try {
      context_window = pyInt(pyGetAttr(this.llm, "context_limit", 0) || 0);
    } catch {
      // BUG(port): 源为 `except Exception`，宽吞逐字保留。
      context_window = 0;
    }

    try {
      await this.bus.emit("usage", {
        session_id: this.session_id,
        // Consumed by the frontend's applyUsage(); it reads `tokenCount`
        // first and falls back to usage.total_tokens.
        tokenCount: context_tokens,
        // The overhead breakdown so the client-side estimate between
        // turns can include what the provider counts but the message
        // list doesn't show (system prompt + tool schemas + skills
        // routinely add up to five figures).
        breakdown: {
          systemPrompt: sp_tokens,
          tools: tool_tokens,
          skills: skill_tokens,
        },
        contextWindow: context_window,
        usage: {
          total_tokens: summary["tokens"] || 0,
          input_tokens: summary["input"] || 0,
          output_tokens: summary["output"] || 0,
          cache_read: summary["cache_read"] || 0,
          cache_miss: summary["cache_miss"] || 0,
          cache_creation: summary["cache_creation"] || 0,
          cost_micros: summary["cost_micros"] || 0,
          cache_saved_micros: summary["cache_saved_micros"] || 0,
          cost_source: summary["cost_source"] || "",
          model_id: summary["model_id"] || "",
          calls: summary["calls"] || 0,
        },
      });
    } catch {
      // fail-open: 可选增强，失败不影响主流程
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }

    // Update the analytics engine with per-turn real numbers.
    try {
      const get_token_analytics = ADMISSION_SEAMS.tokenAnalyticsModule()[
        "get_token_analytics"] as () => any;
      get_token_analytics().update_from_usage({
        context_tokens,
        cache_read: summary["cache_read"] || 0,
        cache_miss: summary["cache_miss"] || 0,
        cache_creation: summary["cache_creation"] || 0,
        has_cache_info: summary["has_cache_info"] || false,
        // Money comes pre-priced by model_registry (per-model rate /
        // user override / provider-reported bill). This module never
        // prices anything itself.
        savings_micros: summary["cache_saved_micros"] || 0,
        cost_source: summary["cost_source"] || "",
        // A real summary means the numbers came from the provider's
        // usage blob, not a client-side estimate.
        used_is_exact: Boolean(summary["calls"] || 0),
        model_id: summary["model_id"] || "",
        context_window,
        system_prompt_tokens: sp_tokens,
        tool_def_tokens: tool_tokens,
        skill_tokens,
      });
    } catch {
      // fail-open: 可选增强，失败不影响主流程
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }
  }

  _tool_def_tokens(): number {
    /** Estimate the token cost of all registered tool definitions. */
    try {
      let specs: any[] = [];
      if (pyHasAttr(this.tools, "to_openai_tools")) {
        specs = this.tools.to_openai_tools();
      } else if (pyHasAttr(this.tools, "to_llm_schemas")) {
        specs = this.tools.to_llm_schemas();
      } else if (pyHasAttr(this.tools, "tool_specs")) {
        specs = this.tools.tool_specs();
      }
      let total = 0;
      for (const spec of specs) {
        total += this.compactor.estimate_tokens(pyJsonDumps(spec));
      }
      return total;
    } catch {
      // BUG(port): 源为 `except Exception`，宽吞逐字保留——工具定义估算失败退化
      // 为 0，分析面板少一行而不是回合失败。
      return 0;
    }
  }

  _request_overhead_tokens(system_prompt: string, tool_specs: any[]): number {
    /** Tokens this request will spend on things that aren't in ``messages``.
     *
     * The system prompt and the tool-definition JSON ride along on every single
     * call and routinely add up to five figures, yet neither is visible to
     * ``should_fold`` (which only measures stored history) — so "we're at 60% of
     * the window" and "the provider rejected this for length" could both be true
     * at once. Feeding this into ``precheck_inline`` closes that gap.
     *
     * Unlike :meth:`_tool_def_tokens`, this counts the **trimmed** spec list
     * actually being sent, not the whole registry. The registry total is the
     * right number for the analytics breakdown; it is the wrong number for a
     * fit check, because ``tool_catalog`` may have hidden two thirds of it.
     */
    try {
      let total = token_estimate.estimateTokens(system_prompt || "");
      for (const spec of (tool_specs || [])) {
        total += token_estimate.estimateTokensOf(spec);
      }
      return total;
    } catch {
      // BUG(port): 源为 `except Exception`，宽吞逐字保留。
      return 0;
    }
  }

  async _skill_tokens(): Promise<number> {
    /** Estimate the token cost of all loaded/available skill content.
     *
     * DIVERGENCE(port): async because the TS skill loader's renderer is async.
     */
    try {
      const prompt = await this.skills.render_available_skills_prompt();
      if (prompt) {
        return this.compactor.estimate_tokens(prompt);
      }
      return 0;
    } catch {
      // BUG(port): 源为 `except Exception`，宽吞逐字保留。
      return 0;
    }
  }

  // ── 会话 / 工作区 ───────────────────────────────────────────────────────

  switch_session(sid: string): Result {
    /** Point the Router at an existing session.
     *
     * Not a session *creation* — the caller loads history separately (via
     * ``storage.get_messages``) and pushes it into the frontend. Here we only
     * re-anchor the server-side identity so subsequent turns write to and
     * read from the right rows.
     *
     * Only safe on an IDLE router. The per-session state below (goal, cancel
     * token, ``_turn_seq``) belongs to the turn in progress, so re-anchoring a
     * router that is mid-turn renumbers that turn under itself and throws away
     * the cancel token Stop depends on. An earlier note claimed the WS layer
     * refused mid-flight switches; it did not, and the drift was live.
     * ``_switch_and_reply`` now skips this call for a session whose turn is
     * still running — that router is already anchored where it needs to be.
     */
    if (!sid || !this.storage.get_session(sid)) {
      return Result.failure(`Unknown session: ${sid}`);
    }
    this.session_id = sid;
    this.goals.set_session(sid);
    this.goals.load_goal_state(sid);
    // Keep the fold-card tag in sync with the session we now serve.
    try {
      this.compactor.session_id = sid;
      const row: any = this.storage.get_session(sid);
      const parent = row ? dictGet(row, "parent_id", null) : null;
      if (parent) {
        const lineage_for_fork = ADMISSION_SEAMS.reviewPrefixCacheModule()[
          "lineage_for_fork"] as (p: string) => unknown;
        this.compactor._lineage_root = lineage_for_fork(pyStr(parent));
      }
    } catch {
      // fail-open: 可选增强，失败不影响主流程
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }
    this._session_started = false; // session_start will re-fire on next handle()
    this._turn_seq = this.storage.seq_of_last_message(sid);
    try {
      this._cancelled.clear();
    } catch {
      // fail-open: 可选增强，失败不影响主流程
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }
    return Result.success(sid);
  }

  new_session(title = "", workspace: string | null = null): Result {
    /** Create a fresh session and switch to it.
     *
     * The session is tagged with the workspace it belongs to (defaults to the
     * active one), which is what lets the sidebar group history by folder.
     * The default is ``effective_workspace``, not ``self.workspace``: with no
     * folder picked the latter is the launch cwd, and tagging a session with
     * it invents a workspace group out of Ovolve's own directory.
     */
    const new_sid = pyStr(ADMISSION_SEAMS.uuid4());
    const ws = workspace === null ? this.effective_workspace : workspace;
    this.storage.create_session(new_sid, title || "New chat", null, null, ws || "");
    return this.switch_session(new_sid);
  }

  get effective_workspace(): string {
    /** The workspace as the USER understands it — `''` when they never picked.
     *
     * `self.workspace` always holds a real absolute path because the
     * constructor falls back to `os.getcwd()`. That fallback is fine for the
     * sandbox root (the agent has to be somewhere) but it must never be shown
     * or persisted as a workspace the user owns: launched from source, cwd is
     * Ovolve's own `app/` folder, so the sidebar invented a workspace called
     * "app" out of the backend's launch directory and highlighted it as
     * active. Every user-facing surface — the sidebar list, the memory scope
     * picker — should ask for this instead of `workspace`, matching the
     * `''` = 默认工作区 convention the sessions table already uses.
     */
    return pyTruth(pyGetAttr(this, "workspace_selected", false)) ? this.workspace : "";
  }

  switch_workspace(path: string): Result {
    /** Re-point the agent at a different working folder.
     *
     * The workspace is the agent's world boundary: `path_guard` computes the
     * sandbox from ``context["workspace_root"]``, which `handle()` re-derives
     * from `self.workspace` on EVERY turn. So the file tools, the sandbox and
     * the git routes all follow this one assignment.
     *
     * Two things do NOT follow automatically, because they were bound to the
     * old path at construction, so they are rebuilt here:
     *   - the rule engine (reads `<workspace>/.ovolve/rules`)
     *   - the hook system (reads `<workspace>` hook definitions)
     *
     * A fresh session is created afterwards on purpose. Carrying the old
     * conversation across a workspace change would leave the model reasoning
     * about file paths from the previous project while acting on this one —
     * which is how you get real, wrong edits.
     */
    if (!path) {
      return Result.failure("workspace path is required");
    }
    const resolved = ADMISSION_SEAMS.abspath(ADMISSION_SEAMS.expanduser(path));
    if (!ADMISSION_SEAMS.isdir(resolved)) {
      return Result.failure(`Not a directory: ${resolved}`);
    }

    this.workspace = resolved;
    // The user just explicitly opened this folder — the git panel and any
    // other workspace-gated feature should now treat it as a real workspace.
    this.workspace_selected = true;
    // Repoint memory too, or recall keeps serving the previous workspace's
    // entries after the switch — the most confusing possible carry-over,
    // because the folder changed but the agent's "what I know" did not.
    // `rescope`, not a fresh `for_root`: `mount()` already registered THIS
    // handle's bound `_on_user_prompt` on the bus, so swapping in a new
    // object would leave the bus driving recall through a handle nobody reads
    // while the visible one moved. Moving this handle in place keeps the two
    // in sync.
    try {
      this.memory.rescope(resolved, this.session_id);
    } catch (exc) {
      // BUG(port): 源为 `except Exception as exc`，宽吞逐字保留。
      console.log(`[Router] memory root repoint failed for ${resolved}: ${excStr(exc)}`);
    }
    try {
      this.rules = ADMISSION_SEAMS.get_rule_engine(resolved);
    } catch (exc) {
      // BUG(port): 源为 `except Exception as exc`，宽吞逐字保留。
      console.log(`[Router] rule engine rebuild failed for ${resolved}: ${excStr(exc)}`);
    }
    try {
      const init_hooks = ADMISSION_SEAMS.hookRunnerModule()["init_hooks"] as (...a: any[]) => unknown;
      init_hooks(resolved, this.session_id);
    } catch (exc) {
      // BUG(port): 源为 `except Exception as exc`，宽吞逐字保留。
      console.log(`[Router] hook re-init failed for ${resolved}: ${excStr(exc)}`);
    }

    // Remember the choice so the next launch opens the same folder.
    try {
      this.storage.set_config("active_workspace", resolved);
    } catch (_e) {
      // 用户的选择存不下来，下次启动就回到旧工作区——这是要告诉人的事
      // BUG(port): 源为 `except Exception as _e`，宽吞逐字保留。
      console.log(`[router] persist active_workspace FAILED: ${excStr(_e)}`);
    }

    return this.new_session("", resolved);
  }

  async _teardown_steer_inbox(): Promise<void> {
    /** Teardown steer inbox: atomically close if empty, or drain leftover into follow-up. */
    const q: any = pyGetAttr(this, "queue", null);
    if (q === null) {
      return;
    }
    try {
      if (pyHasAttr(q, "close_steer_inbox")) {
        if (!(await q.close_steer_inbox())) {
          for (;;) {
            const rem = await q.poll_steer();
            if (!rem) {
              break;
            }
            await q.send_message(rem.content, DeliverAs.FOLLOW_UP, rem.sender);
          }
          await q.close_steer_inbox();
        }
      }
    } catch {
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }
  }

  // ── 回合入口 ────────────────────────────────────────────────────────────

  async handle(user_message: string, context: Record<string, any> | null = null): Promise<Result> {
    /** Handle one user turn.
     *
     * Two execution paths:
     *
     * * **Agent loop (default)** — the model sees the whole tool catalogue and
     *   decides what to call, in what order, how many times. Each call still
     *   passes through ``pre_tool_use`` (risk control / remote denylist) and
     *   emits ``tool_result`` (memory extraction), so every guardrail written
     *   for the keyword path keeps working.
     * * **Keyword fallback** — used only when no LLM is configured, so the
     *   agent degrades to the previous deterministic behavior instead of
     *   becoming a no-op.
     *
     * Args:
     *     user_message: Raw user input.
     *     context: Optional per-turn context; ``session_id`` and
     *         ``workspace_root`` are filled in automatically.
     *
     * Returns:
     *     Result carrying the final reply text.
     */
    const { TurnPhase, emit_phase } = await import("../agent_phases.js");

    // Steer 收件箱进入本轮：重置开放接收 (reopen_steer_inbox)
    if (pyGetAttr(this, "queue", null) !== null && pyHasAttr(this.queue, "reopen_steer_inbox")) {
      try {
        await this.queue.reopen_steer_inbox();
      } catch {
        // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
      }
    }

    context = context || {};
    context["session_id"] = this.session_id;
    context["workspace_root"] = this.workspace;
    // Wall-clock start for this turn. Used to compute end-to-end latency at
    // usage-record time; kept in context so a nested call (compaction,
    // steer) can't accidentally reset it by re-entering handle().
    dictSetDefault(context, "_turn_start", ADMISSION_SEAMS.now());

    // Step E 补全：LLM 主环路的技能归因。触发匹配在这里算一次（尊重 B3
    // 可见性），命中的技能正文随后由 _skill_guidance_block 作为不可信参考
    // 材料注入系统提示；回合终态据此记录真实使用经验——没注入就不记账。
    try {
      context["skill_candidates"] = this.skills.find_by_trigger(user_message);
    } catch {
      // BUG(port): 源为 `except Exception`，宽吞逐字保留。
      context["skill_candidates"] = [];
    }

    // ConversationEpisode 主题片段追踪（Phase 4 & 24）
    try {
      const get_episode_manager = ADMISSION_SEAMS.episodeManagerModule()[
        "get_episode_manager"] as (s: unknown) => any;
      const em: any = get_episode_manager(this.storage);
      const turn_id = String(context["turn_id"] || `turn_${this._turn_seq}`);
      const branch_id = String(pyGetAttr(this, "branch_id", "") || context["branch_id"] || "");
      context["episode_id"] = em.record_turn({
        session_id: this.session_id,
        turn_id,
        topic: "", // 保守沿用当前活跃 Episode，避免每条消息前50字切分
        goal_id: String(context["goal_id"] || ""),
        branch_id,
        prompt: user_message,
      });
    } catch {
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }

    try {
      const TS: AnyMod = ADMISSION_SEAMS.taskStatesModule();
      const record_task_state_transition = TS["record_task_state_transition"] as (o: any) => unknown;
      const TStatus: any = TS["TurnStatus"];
      record_task_state_transition({
        layer: "turn",
        task_id: String(context["turn_id"] || `turn_${this._turn_seq}`),
        old_state: TStatus.QUEUED,
        new_state: TStatus.RUNNING,
        session_id: this.session_id,
      });
    } catch {
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }

    // --- Phase: TURN_ENTERED ---
    // goal_id/run_id ride along from the very first frame. Without them the
    // trace ledger recorded a goal's turns as anonymous session traffic, so
    // "show me what this goal did" had nothing to filter on — the scheduler
    // knew both values (goal_scheduler builds `turn_ctx` with them) and the
    // information was simply dropped on the way to the store.
    await emit_phase(this.bus, TurnPhase.TURN_ENTERED, {
      session_id: this.session_id,
      extra: {
        goal_id: String(context["goal_id"] || ""),
        run_id: String(context["run_id"] || ""),
      },
    });

    // The permission level is a per-turn decision made by the USER in the UI,
    // not by the model. Resolved once here so every downstream gate and the
    // system prompt agree on what this turn is allowed to do. A payload that
    // carries no level (queued turns, replays, bot traffic) must NOT widen
    // back to auto — it runs under whatever is standing: the last UI pick or
    // the workspace/config default.
    const _perm_requested = context["permission"];
    if (_perm_requested) {
      this.permission = coerce_permission(_perm_requested);
    }
    context["permission"] = this.permission;
    // Same story for the model: the composer's pick is a per-request
    // parameter, resolved once here so the whole turn — streaming, fold
    // budget, modality gates — agrees on which model is answering. A turn
    // that sends no pick falls to the workspace default before config.json.
    const _resolved: any = this._bind_turn_model(context["model"] || this.workspace_model);
    context["model"] = this.llm.model_id;
    if (_resolved) {
      context["model_provider"] = _resolved["provider_name"] || "";
    }
    // Thinking budget (UD4), same per-request treatment. Normalized here so an
    // unrecognised value degrades to "don't send the parameter" instead of
    // reaching the provider and earning a permanent 400.
    const MR: AnyMod = ADMISSION_SEAMS.modelRegistryModule();
    const normalize_effort = MR["normalize_effort"] as (v: unknown) => unknown;
    const supports_effort = MR["supports_effort"] as (...a: any[]) => unknown;
    this._turn_effort = normalize_effort(
      context["thought_level"] || this.workspace_thought_level);
    context["thought_level"] = this._turn_effort;
    // Whether the dial even applies to the model that ended up answering.
    // Recorded rather than enforced: the request is still valid, the knob just
    // goes nowhere, and the UI needs to be able to say so.
    context["thought_supported"] = supports_effort(
      this.llm.model_id, pyGetAttr(this.llm, "kind", ""),
      pyGetAttr(this.llm, "effort_supported", null),
    );
    // A cancel belongs to the turn that was running when it arrived. Clearing
    // here stops a stale flag from killing the NEXT turn before it starts.
    this._clear_cancel();

    // Fresh loop detector per turn, for the same reason the cancel token is
    // cleared here: the repetition picture belongs to the request being worked
    // on. A new question that happens to open with the same `read_file` call as
    // the last one is not a loop, and inheriting the old history would make it
    // look like one.
    const LoopDetector = ADMISSION_SEAMS.loopDetectorModule()["LoopDetector"] as new (c: unknown) => any;
    this.loop_detector = new LoopDetector(this._loop_config);
    const RepeatToolGuard = ADMISSION_SEAMS.repeatToolGuardModule()["RepeatToolGuard"] as new () => any;
    this.repeat_tool_guard = new RepeatToolGuard();

    // Same reasoning for the per-turn action counters the context meter
    // shows. They live in a popover titled "this turn", but `reset_turn` had
    // no callers at all, so the tool count on display was the process-wide
    // running total — it crossed sessions and windows and only ever went up.
    try {
      const get_token_analytics = ADMISSION_SEAMS.tokenAnalyticsModule()[
        "get_token_analytics"] as () => any;
      get_token_analytics().reset_turn();
    } catch {
      // fail-open: 可选增强，失败不影响主流程
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }

    // --- Phase: PERMISSION_RESOLVED ---
    await emit_phase(this.bus, TurnPhase.PERMISSION_RESOLVED, {
      session_id: this.session_id,
      extra: { permission: this.permission },
    });

    // Emit session_start once, on the first turn (guaranteed running loop —
    // __init__ has none). SessionStart hooks and any future session-scoped
    // subscribers fire here rather than being hardcoded in __init__.
    if (!this._session_started) {
      this._session_started = true;
      await this.bus.emit("session_start", {
        session_id: this.session_id,
        reason: "startup",
        workspace_root: this.workspace,
        context,
      });
    }

    // --- Phase: WORKSPACE_READY ---
    await emit_phase(this.bus, TurnPhase.WORKSPACE_READY, {
      session_id: this.session_id,
      extra: { workspace: this.workspace },
    });

    // Check for steer messages (user interrupted)
    const steer = await this.queue.poll_steer();
    if (steer) {
      user_message = steer.content;
      context["steered"] = true;
    }

    // The turn's raw input, recorded AFTER the steer swap so it matches what
    // actually drives this turn. This is the provenance anchor the
    // confused-deputy check reads: the one string in `context` that the model
    // cannot author, so "the user asked for this path" can be distinguished
    // from "a file I just read asked for it". Kept out of the prompt path —
    // nothing downstream may treat it as an instruction.
    context["user_message"] = user_message;
    dictSetDefault(context, "workspace_root", this.workspace);
    dictSetDefault(context, "workspace", this.workspace);

    // Shadow workspace: staged overlay for main-agent file mutations.
    if (!this.is_subagent) {
      try {
        const SS: AnyMod = ADMISSION_SEAMS.shadowSessionModule();
        const shadow_enabled = SS["shadow_enabled"] as () => unknown;
        const inject_context = SS["inject_context"] as (...a: any[]) => unknown;
        if (shadow_enabled()) {
          inject_context(this.session_id, this.workspace, context);
        }
      } catch {
        // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
      }
    }

    if (!context["silent_consent"]) {
      this.storage.add_message(this.session_id, "user", user_message);
      // First user turn of a new session → name the session after it. Idempotent
      // once the title is real (the storage helper won't overwrite a rename).
      try {
        this.storage.autotitle_session(this.session_id, user_message);
      } catch {
        // fail-open: 可选增强，失败不影响主流程
        // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
      }
    }
    // The seq this user turn landed on doubles as the rollback checkpoint:
    // "undo this message" (chat truncation) and "undo what it changed on disk"
    // (snapshot rollback) both address seq >= this number.
    this._turn_seq = this.storage.seq_of_last_message(this.session_id);
    this.memory.touch();

    // ── 两阶段确认的第二阶段 ──────────────────────────────────────────────
    // 上一回合可能停在一句「回复「同意」我就继续」上。那么这一句短回复是对那个
    // 问题的**回答**，不是新需求 —— 在这里对上号，确认流程才第一次真的闭环：
    // 在此之前 grant_permission 全代码库无人调用，INHERITED 许可层永远不可能
    // 生效，用户同意多少次都会被原地再问一次。
    if (this.risk.pending_for(this.session_id)) {
      // A click on the card's 同意/以后都允许/不用了 button arrives as a
      // `respond_permission` frame and lands here as an explicit decision +
      // the call_id it belongs to. Typing the words still works and falls
      // back to parsing. Both funnel into ONE resolve path — the button was
      // not worth a second copy of the re-issue logic, and the call_id is
      // the only real difference: text can only answer the newest ask,
      // a click answers the card it was on.
      const decision = context["consent_decision"] || parse_consent(user_message);
      const consent_call_id = String(context["consent_call_id"] || "");
      if (decision === "deny") {
        // 作废那个提问。不提前返回：让模型正常读到「不用了」并自己接话，
        // 比我们硬塞一句模板回复自然。关键是许可绝不能留着。
        this.risk.resolve_pending("deny", this.session_id, consent_call_id);
      } else if (decision === "approve" || decision === "approve_always") {
        // approve_always 除了放行这一次，还落一条持久规则：同类调用以后
        // 不再打断。这就是「能做完 30 个文件的重构」和「被打断 30 次」的
        // 区别 —— resolve_pending 内部按风险兜底，CRITICAL 一步不会因为
        // 一句「以后都允许」被永久放行。
        const approved = this.risk.resolve_pending(
          decision, this.session_id, consent_call_id,
        );
        if (approved !== null && approved !== undefined) {
          context["approved_pending"] = approved;
          if (!context["silent_consent"]) {
            user_message = `${user_message}\n\n`
              + "[系统] 用户已确认上一步操作，该操作已自动执行。请根据执行结果继续完成任务。";
          }
        }
      }
    }

    // 用户不点问题卡片、直接打字往下说 —— 那句话就是他的答复方式。留着那组
    // 问题只会让卡片上的按钮变成陷阱：点下去后端会答「已经不在等待中了」。
    // 所以在这里作废，并把最新快照推给前端让它把卡片结掉。
    //
    // `question_answer` 标记的回合要跳过：那是点击卡片走 respond_question 进来
    // 的，被答的那一组已经在 WS 层消费掉了，此时若把整个会话清空，并存的第二
    // 张问题卡会被无辜连坐。
    if (!context["question_answer"]) {
      const store = ADMISSION_SEAMS.get_ask_user_store();
      if (store.discard_session(this.session_id)) {
        await this.bus.emit("pending_questions", {
          session_id: this.session_id,
          items: store.snapshot(this.session_id),
        });
      }
    }

    // Auto-fold: if the budget is nearly spent, summarize before we build the
    // history for this turn. `_build_history` then replays from the newest
    // fold marker forward, so the model sees the summary instead of the raw
    // turns it replaces. Cooldown + consecutive caps live in the compactor.
    await emit_phase(this.bus, TurnPhase.CONTEXT_ENGINE, { session_id: this.session_id });
    const fold_report = await this._auto_fold_if_needed();
    if (fold_report) {
      context["fold"] = fold_report;
    }

    // user_prompt_submit lets memory_layer inject <memory> into the context.
    // `workspace` rides along so subscribers that cache per project (the
    // capability recommender) can scope their key — the same question in two
    // workspaces has two different right answers.
    const prompt_event: any = await this.bus.emit(
      "user_prompt_submit",
      { message: user_message, context, workspace: this.workspace },
    );
    const merged_ctx = dictGet(prompt_event.payload, "context", null);
    if (isDict(merged_ctx)) {
      Object.assign(context, merged_ctx);
    }
    await emit_phase(this.bus, TurnPhase.CONTEXT_ASSEMBLED, { session_id: this.session_id });

    if (this._cancel_requested()) {
      await this._teardown_steer_inbox();
      return Result.failure("Cancelled before model loop");
    }

    let trace: Record<string, any>[] = [];
    let result: Result;
    if (this.llm && this.llm.api_key) {
      const r = await this._agent_loop(user_message, context);
      result = r[0];
      trace = r[1];
      context["tool_trace"] = trace;
    } else {
      result = await this._keyword_turn(user_message, context);
    }

    await emit_phase(this.bus, TurnPhase.ASSISTANT_REPLY_FINALIZED, {
      session_id: this.session_id,
      extra: { ok: Boolean(result.ok) },
    });

    if (result.ok) {
      context["audit"] = this._audit(result, { agent: null, primary_tool: null }, context);
    }

    let output = this._present(result, {}, context);

    const output_event: any = await this.bus.emit("output", {
      text: output,
      user_intent: user_message,
    });
    if (output_event.action === "modify") {
      output = dictGet(output_event.payload, "text", output) as string;
    }

    // Persist any images the model generated this turn, ONCE, at the end.
    // This appends a compact placeholder to output (~10 tokens/image) so the
    // model on the next turn knows "I made a picture" without seeing 25万
    // tokens of base64, and stores the real refs in message metadata where
    // _build_history won't replay them.
    const image_refs: any[] = await this._persist_turn_images(context);
    if (pyTruth(image_refs)) {
      const placeholders = image_refs.map((r) => _image_placeholder(r)).join("\n");
      output = output ? `${output}\n${placeholders}` : placeholders;
    }
    const metadata: Record<string, any> = {};
    if (pyTruth(image_refs)) {
      metadata["images"] = image_refs;
    }
    if (pyTruth(trace)) {
      metadata["tool_calls"] = trace.map((t, idx) => ({
        id: t["call_id"] || t["id"] || `call_${idx}`,
        toolName: t["tool"] || t["name"] || t["toolName"] || "",
        args: t["args"] || {},
        result: t["output"] || t["result"] || t["preview"] || "",
        output: t["output"] || t["preview"] || "",
        status: (t["status"] === "ok" || t["status"] === "success" || (t["ok"] === undefined ? true : t["ok"]))
          ? "completed"
          : "failed",
        timestamp: (t["timestamp"] || ADMISSION_SEAMS.now()) * 1000 < 10000000000
          ? (t["timestamp"] || ADMISSION_SEAMS.now()) * 1000
          : (t["timestamp"] || ADMISSION_SEAMS.now()),
        completedAt: (t["completedAt"] || ADMISSION_SEAMS.now()) * 1000 < 10000000000
          ? (t["completedAt"] || ADMISSION_SEAMS.now()) * 1000
          : (t["completedAt"] || ADMISSION_SEAMS.now()),
      }));
    }
    const turn_reasonings: any[] = context["turn_reasonings"] || [];
    if (pyTruth(turn_reasonings)) {
      metadata["reasoning"] = turn_reasonings.map((r, idx) => ({
        id: r["id"] || `reasoning_${idx}`,
        step: r["step"] === undefined ? 0 : r["step"],
        text: r["text"] || "",
        final: r["final"] === undefined ? false : r["final"],
        timestamp: (r["timestamp"] || ADMISSION_SEAMS.now()) * 1000 < 10000000000
          ? (r["timestamp"] || ADMISSION_SEAMS.now()) * 1000
          : (r["timestamp"] || ADMISSION_SEAMS.now()),
      }));
    }

    if (output.trim() || !((pyGetAttr(result, "meta", null) || {}) as any)["needs_confirmation"]) {
      this.storage.add_message(
        this.session_id, "assistant", output,
        undefined, pyTruth(metadata) ? metadata : null,
      );
    }

    // Hidden nudge — only when the user actually stopped this turn. Written
    // AFTER the assistant row so replay order is "reply, then the note about
    // it", which is how the model reads it as commentary on what just
    // happened rather than as a new instruction.
    if (((result.meta || {}) as any)["cancelled"]) {
      try {
        const LC = ADMISSION_SEAMS.loopModule();
        this.storage.add_message(
          this.session_id, "system", LC.INTERRUPT_NUDGE,
          LC.INTERRUPT_NOTE_TYPE, null,
        );
      } catch {
        // losing the nudge degrades recovery quality, never the turn
        // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
      }
    }

    // A real reply landed, so the agent is making progress — clear the
    // consecutive-fold counter. The cap exists to stop fold→fold→fold loops,
    // not to limit folds over a long healthy session.
    this.compactor.note_new_turn();

    await emit_phase(this.bus, TurnPhase.POST_TURN_HOOKS, { session_id: this.session_id });

    // Shadow workspace: auto-merge staged overlay when permission allows.
    if (!this.is_subagent && context["shadow_staged"]) {
      try {
        const maybe_auto_apply = ADMISSION_SEAMS.shadowWorkspaceModule()[
          "maybe_auto_apply"] as (...a: any[]) => Promise<unknown>;
        await maybe_auto_apply(
          this.bus, this.session_id, this.workspace,
          String(context["permission"] || ""),
        );
      } catch {
        // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
      }
    }

    const follow_up = await this.queue.poll_follow_up();
    if (follow_up) {
      await this.queue.send_message(follow_up.content, DeliverAs.NEXT_TURN);
    }

    // Persist token usage for this turn, once, now that every LLM call in the
    // loop has reported in. Recording per-step would triple the turn count.
    const turn_usage = this._record_turn_usage(context);
    await this._emit_usage_frame(turn_usage);

    // LLM 主环路技能归因：本轮真的注入了技能指导、且关键词路径尚未记账
    // （其经验 id 已挂在 result.meta），按回合结果补一条经验——同一技能的
    // 履历因此覆盖两条执行路径。用户主动取消不算技能失败。
    const _inj = context["skill_injected"];
    if (_inj && !(((result.meta || {}) as any)["skill_experience_id"])
      && !(((result.meta || {}) as any)["cancelled"])) {
      try {
        const _exp_id = this.storage.record_skill_experience(_inj["name"], {
          skill_version: _inj["version"],
          goal_id: String(context["goal_id"] || ""),
          run_id: String(context["run_id"] || ""),
          session_id: this.session_id,
          // 选择原因由产生它的那条路径给出：触发匹配注入是
          // llm_context_match，模型自己调 skill_load 是 skill_load_tool。
          // 写死一个会让履历谎报"是我们推给它的"。
          selection_reason: String(_inj["reason"] || "llm_context_match"),

          preconditions_met: true,
          steps_attempted: 1, steps_succeeded: result.ok ? 1 : 0,
          outcome: result.ok ? "success" : "failure",
          failure_class: result.ok ? "" : pyStr(pyGetAttr(result, "error", "") || "").slice(0, 200),
        });
        if (isDict(result.meta)) {
          (result.meta as any)["skill_experience_id"] = _exp_id;
        }
        const _rr = String(context["run_id"] || "");
        if (_rr) {
          this.storage.add_relation(
            "run", _rr, "USES", "skill", _inj["name"],
            `exp:${_exp_id}`,
          );
        }
      } catch (_e) {
        // BUG(port): 源为 `except Exception as _e`，宽吞逐字保留。
        console.log(`[skills] llm-path experience failed: ${excStr(_e)}`);
      }
    }

    // ── task-level experience（P0-2）────────────────────────────────────
    // 之前只有"命中技能"才写履历，于是学习闭环恰好对最该学的情况瞎了：
    // 没有任何技能覆盖的任务，是"缺一个技能"的最强证据，却一行都不留。
    // observation 构造器读的就是这张表，空表 → 无从提议 → 入口断。
    //
    // 只在本轮确实没有技能履历时补写，不与技能行重复计数——否则
    // classify_observation 的成功/失败计数会凭空多出一条。
    // skill_id 用 Storage.TASK_LEVEL_SKILL_ID 哨兵，读侧默认过滤。
    // turn_id 刻意用 `turn-N`：与 turn_usage.turn_id 同一套编号，
    // 这条履历因此能和真实 token / 花费 join 上（旧的 uuid 方案不能）。
    //
    // 被打断的一轮也要留一行，outcome="cancelled"：用户在这里叫停本身
    // 就是证据（"这条路走到这里被人拦下了"），而之前它一行都不留。它不会
    // 污染任何计数——成功/失败的统计都是精确匹配 success / failure，
    // 技能孵化也只看 success，cancelled 两边都不算。
    if (!(((result.meta || {}) as any)["skill_experience_id"])) {
      const _cancelled = Boolean(((result.meta || {}) as any)["cancelled"]);
      try {
        const _cost = Number((turn_usage || {})["cost_micros"] || 0) / 1000000.0;
        // steps = 本轮 LLM 调用次数。不是工具步数——目前没有逐轮工具
        // 计数器，写一个假的"步数"比写一个诚实的近似更糟。
        const _calls = pyInt((turn_usage || {})["calls"] || 0);
        const _task_exp_id = this.storage.record_skill_experience(
          this.storage.TASK_LEVEL_SKILL_ID,
          {
            turn_id: `turn-${this._turn_seq}`,
            goal_id: String(context["goal_id"] || ""),
            run_id: String(context["run_id"] || ""),
            session_id: this.session_id,
            selection_reason: "no_skill",
            preconditions_met: true,
            steps_attempted: _calls,
            steps_succeeded: (result.ok && !_cancelled) ? _calls : 0,
            outcome: _cancelled ? "cancelled" : (result.ok ? "success" : "failure"),
            failure_class: _cancelled
              ? "user_cancelled"
              : (result.ok ? "" : pyStr(pyGetAttr(result, "error", "") || "unknown").slice(0, 200)),
            cost: _cost,
            latency_ms: (ADMISSION_SEAMS.now()
              - (("_turn_start" in context ? context["_turn_start"] : ADMISSION_SEAMS.now()) as number))
              * 1000,
          },
        );

        if (isDict(result.meta)) {
          (result.meta as any)["task_experience_id"] = _task_exp_id;
        }
      } catch (_e) {
        // BUG(port): 源为 `except Exception as _e`，宽吞逐字保留。
        console.log(`[skills] task-level experience failed: ${excStr(_e)}`);
      }
    }

    // Cancel honesty: a stopped turn still crosses TURN_COMPLETED here, so
    // the cancelled flag rides along on the phase — the trace bridge turns
    // it into AGENT_TURN_CANCELLED, and a replayed ledger never shows an
    // interrupted turn as a successful one.
    await emit_phase(this.bus, TurnPhase.TURN_COMPLETED, {
      session_id: this.session_id,
      extra: {
        ok: Boolean(result.ok),
        cancelled: Boolean(((result.meta || {}) as any)["cancelled"]),
      },
    });

    // Context-pressure evolution check and active compaction post TURN_COMPLETED
    await this._maybe_fold_on_pressure(context);

    // The usage figures ride along in meta so a programmatic caller (the goal
    // scheduler) can charge this turn's real spend to its budget. Previously
    // the worker had no way to learn what a turn cost and billed a flat
    // constant, which is why a $0.50 cap was never reached.
    let meta: Record<string, any> = isDict(result.meta) ? { ...(result.meta as any) } : {};
    // 执行轮记下的方案审批信息并入终态（否则 approved_with 无消费者）。
    meta = _merge_plan_meta(meta, context);
    // Plan 档：成功轮次自动把方案存成一等产物（缺口 B）。
    // 放在终态判定前：cancelled / needs_confirmation 都不算"方案已交付"。
    if (result.ok && !meta["cancelled"] && !meta["needs_confirmation"]) {
      try {
        const _pre_capture_meta = meta;
        await this._maybe_capture_plan(context, output);
        if (context["plan_id"]) {
          _pre_capture_meta["plan_id"] = context["plan_id"];
        }
      } catch {
        // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
      }
    }
    const _cancelled = Boolean(meta["cancelled"]);
    const _incomplete = Boolean(meta["incomplete"]);
    const _needs_confirm = Boolean(meta["needs_confirmation"]);
    const _partial = Boolean(meta["partial"]);

    try {
      const TS: AnyMod = ADMISSION_SEAMS.taskStatesModule();
      const record_task_state_transition = TS["record_task_state_transition"] as (o: any) => unknown;
      const TStatus: any = TS["TurnStatus"];
      const _final_st = _cancelled
        ? TStatus.CANCELLED
        : (_needs_confirm
          ? TStatus.WAITING_CONFIRMATION
          : (result.ok ? TStatus.COMPLETED : TStatus.FAILED));
      record_task_state_transition({
        layer: "turn",
        task_id: String(context["turn_id"] || `turn_${this._turn_seq}`),
        old_state: TStatus.RUNNING,
        new_state: _final_st,
        session_id: this.session_id,
        meta: { outcome: meta["turn_outcome"] },
      });
    } catch {
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留。
    }

    await this._teardown_steer_inbox();

    if (_cancelled) {
      meta["turn_outcome"] = "cancelled";
      return Result.failure("已中断（用户点击了停止）", meta, { usage: turn_usage });
    } else if (_incomplete) {
      meta["turn_outcome"] = "incomplete";
      return Result.failure(pyStr(pyGetAttr(result, "error", "") || "") || pyStr(output), meta,
        { usage: turn_usage });
    } else if (_needs_confirm) {
      meta["turn_outcome"] = "waiting_user";
      return Result.success(output, meta, { usage: turn_usage });
    } else if (_partial) {
      meta["turn_outcome"] = "partial";
      return Result.success(output, meta, { usage: turn_usage });
    } else if (!result.ok) {
      meta["turn_outcome"] = "failed";
      return Result.failure(pyStr(pyGetAttr(result, "error", "") || "") || pyStr(output), meta,
        { usage: turn_usage });
    } else {
      meta["turn_outcome"] = "completed";
      return Result.success(output, meta, { usage: turn_usage });
    }
  }

  // ── 宿主提供的方法（其它 mixin；未落地时抛出） ────────────────────────────

  _bind_turn_model(_requested: string): any {
    return hostMissing("_bind_turn_model");
  }

  async _agent_loop(_user_message: string, _context: Record<string, any>): Promise<[Result, any[]]> {
    return hostMissing("_agent_loop");
  }

  async _keyword_turn(_user_message: string, _context: Record<string, any>): Promise<Result> {
    return hostMissing("_keyword_turn");
  }

  _model_can_read_images(): boolean {
    return hostMissing("_model_can_read_images");
  }

  async _persist_turn_images(_context: Record<string, any>): Promise<any[]> {
    return hostMissing("_persist_turn_images");
  }

  async _maybe_capture_plan(_context: Record<string, any>, _output: string): Promise<void> {
    return hostMissing("_maybe_capture_plan");
  }

  _audit(_result: Result, _dispatch: Record<string, any>, _context: Record<string, any>): any {
    return hostMissing("_audit");
  }

  _present(_result: Result, _dispatch: Record<string, any>, _context: Record<string, any>): string {
    return hostMissing("_present");
  }

  get_system_prompt(_context: Record<string, any> = {}): string {
    return hostMissing("get_system_prompt");
  }
}
