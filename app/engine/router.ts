/**
 * router.ts — Main Router facade with the 5-step decision chain.
 *
 * Ported from `app/backend/router.py` (525 lines, 28237 bytes, wave-8,
 * unit 188). Bug-for-bug, per RULEBOOK §2: every fail-open `except`, every
 * dead import and every short-circuit call count in the source is reproduced
 * at the same call site, not "improved" away.
 *
 * Modularized into 5 components in router_modules/ (the source's own docstring,
 * kept as the contract for what this class actually is):
 * - admission: Session lifecycle, workspace, usage tracking, cancellation, handle
 * - loop: Agent loop core (_agent_loop), streaming LLM chat, MoA council
 * - dispatch: Tool execution, dispatching, ask-user, audit, output presentation
 * - prompt: System prompt assembly, guidance files, EnvironmentSnapshot
 * - goal: Long-horizon goal continuation and execution
 *
 * Step 1: Intent recognition & risk classification
 * Step 2: Task dispatch (sub-agent / skill / direct tool)
 * Step 3: Execution strategy (single / sequential / parallel)
 * Step 4: Acceptance & artifact audit
 * Step 5: Result presentation
 *
 * RULEBOOK CITATIONS
 *   §2  `print(...)` -> `ROUTER_SEAMS.print_` (console.log); `except Exception`
 *       (broad swallow) preserved verbatim and marked `BUG(port)` at each site;
 *       `except (TypeError, ValueError)` stays narrow (the `int()` arm).
 *   §2  `a or b` / `if x` are CPython truthiness -> `pyOr` / `pyTruth`
 *       (the probe-pinned fold from router_modules/dispatch.ts:182, incl. a
 *       plain class instance being ALWAYS true).
 *   §2  `dict.get(k[,default])` -> local `dictGet`; `os.path.*` -> seams, so
 *       the parity probes never touch a real filesystem (红线5).
 *   §4  naming: app/backend/router.py -> app/engine/router.ts.
 *
 * DIVERGENCE(port) — the five-way mixin inheritance becomes prototype
 * composition (forced by TS, no observable data change):
 *   1. python's `class Router(RouterAdmissionMixin, RouterLoopMixin,
 *      RouterDispatchMixin, RouterPromptMixin, RouterGoalMixin)` resolves every
 *      attribute through the MRO (admission first). TS has no multiple
 *      inheritance, so `compose_router_proto` copies every own prototype member
 *      of the five mixins onto `Router.prototype` IN MRO ORDER, first-wins,
 *      carrying property DESCRIPTORS (so python's `effective_workspace`
 *      @property survives as a real accessor).
 *   2. The mixin modules each compile standalone, which means the ones written
 *      earlier carry `hostMissing()` placeholder stubs for methods python
 *      resolves from a DIFFERENT mixin (e.g. admission's `_agent_loop`, loop's
 *      `_tool_specs_for`). Those stubs do not exist in python, so a stub must
 *      never shadow a real implementation further down the MRO: the copier
 *      tracks placed names as real/stub and lets a real definition overwrite a
 *      previously placed stub, never the other way round. `HOST_STUB_NAMES`
 *      (the exact `hostMissing()` call sites of admission.ts/loop.ts) is
 *      asserted against the prototypes at load time, so a rename in a mixin
 *      fails loudly instead of silently re-shadowing a real method.
 *   3. python's class attributes that the mixin files express as TS *instance*
 *      field initializers (`router_modules/prompt.ts:307-308`
 *      GUIDANCE_FILES / GUIDANCE_MAX_CHARS, read through `self.`) are never run
 *      by a prototype merge, because no mixin constructor is called. They are
 *      re-attached to `Router.prototype` verbatim from a field-only template
 *      instance. (`RouterAdmissionMixin` already solved the same problem for
 *      FOLD_SCAN_LIMIT / MAX_AGENT_STEPS / SOFT_LANDING_STEP with static +
 *      accessor pairs, so those need nothing here.)
 *
 * DIVERGENCE(port) — sync `__init__` vs ESM:
 *   4. `self._register_analysis_tools()` (router.py:426) is sync in python;
 *      `importlib.import_module` became `await import()` in admission.ts:606, so
 *      the port starts it in the constructor and keeps the promise on
 *      `this._analysis_ready`. Every body of that method is individually
 *      try/except-guarded in the source, so the promise cannot reject; no caller
 *      in either language can observe the registry *during* __init__, and the
 *      microtask boundary lands long before the first turn's tool catalogue is
 *      read. Registered-name and registration ORDER are unchanged.
 *   5. python's four positional-or-keyword `__init__` parameters become one
 *      `RouterInit` record, because the already-landed consumer
 *      `session_host.ts:119` (`RouterCtor`) constructs with a record. Every
 *      source call site uses keywords (`Router(workspace=...)`, session_host's
 *      `Router(workspace=..., system_prompt=..., session_id=...,
 *      mount_shared=...)`), so the mapping is 1:1 and no positional call
 *      exists. The keyword-only `*` of `_init_event_subscribers` became the
 *      same record at the same slot.
 *   6. Bound methods: python's `self._synthesize_for_fold` / `_flush_memory_for_fold`
 *      / `_on_before_compact` are already bound; TS needs explicit `.bind(this)`
 *      for the three callbacks handed to the compactor and the bus. Same
 *      function objects, same `this`.
 *   7. `asyncio.Event()` -> `MESSAGING_SEAMS.makeEvent()` (the repo's
 *      AsyncEvent stand-in in messaging.ts:304; `.set()/.clear()/.is_set()/.wait()`
 *      are the surface admission.ts actually uses).
 *   8. `asyncio.get_running_loop()` has no "no loop running" state under Node,
 *      so the source's `except RuntimeError: pass` arm is production-unreachable
 *      (same conclusion as storage/domains/skills.ts:835). It stays as a seam
 *      that MAY throw, so the probe can still drive that branch.
 *   9. `str(uuid.uuid4())` -> `randomUUID()` (same 36-char dashed form).
 *      `frozenset()` -> `Set` (membership, iteration and falsiness of the empty
 *      set match; nothing in either codebase mutates it).
 *   10. `logging.getLogger(__name__).exception(...)` -> `ROUTER_SEAMS.log_line`
 *       (noop by default, the closed-unit convention of dispatch.ts:673 —
 *       observational output only, never part of the turn's data).
 *   11. The source's dead module-level imports of the stdlib names `platform`,
 *       `subprocess`, `threading`, `time` have no use site anywhere in
 *       router.py and no TS runtime object; they are recorded here instead of
 *       being faked with an import that would change nothing.
 *
 * PORT STATUS: 本文件无 TODO(port)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { randomUUID } from "node:crypto";

import { embed_text } from "./embedder.js";
import { Event, EventBus, getEventBus as get_event_bus } from "./event_bus.js";
import { getPathGuard as get_path_guard } from "./path_guard.js";
import { get_anti_scraping_guard } from "./browser_agent.js";
import {
  ContextCompactor,
  compaction_kwargs_from_config,
  get_compactor,
} from "./context_compactor.js";
import { GoalManager, get_goal_manager } from "./goal_manager.js";
import { get_llm_client } from "./llm_client.js";
import { get_memory_layer } from "./memory_layer.js";
import { DeliverAs, MAX_STEER_MERGED_CHARS, MessageQueue, get_message_queue, MESSAGING_SEAMS } from "./messaging.js";
// DIVERGENCE(port): python 的 `model_registry` 在本仓拆成 model_registry.ts
// （常量/画像）与 model_registry_impl.ts（ModelRegistry 类 + get_model_registry），
// `get_model_registry` 落在 impl 侧，与 llm_client.ts:30 / skill_loader.ts:57 同。
import { get_model_registry } from "./model_registry_impl.js";
import { OutputGuard, get_output_guard } from "./output_guard.js";
import { get_prompt_loader, LAYER_ORDER } from "./prompt_layers.js";
import { get_stable_prefix_registry } from "./prompt_cache_planner.js";
import { Result } from "./result.js";
import {
  PermissionMode,
  RiskController,
  RiskLevel,
  coerce_permission,
  get_remote_risk_decorator,
  get_risk_controller,
  parse_consent,
  prompt_block as permission_prompt_block,
} from "./risk_control.js";
import { get_rule_engine } from "./rule_engine.js";
import { get_output_sanitizer } from "./sanitizer.js";
import { get_skill_loader } from "./skill_loader.js";
import { get_storage } from "./storage.js";
import { HookStage, get_tool_hooks } from "./tool_hooks.js";
import { ToolRegistry, get_tool_registry, shorten_path, truncate } from "./tools.js";
import {
  ASK_WAIT_TIMEOUT_S,
  AUTO_RESOLVE_SYSTEM,
  PendingQuestion,
  build_auto_resolve_user_prompt,
  drop_waiter,
  get_ask_user_store,
  normalize_questions,
  parse_auto_resolution,
  prompt_block as ask_user_prompt_block,
  register_waiter,
  render_answer,
} from "./ask_user.js";
import { MODE_DANGER_FULL, MODE_REFUSED, risk_to_rlevel, select_execution } from "./execution_provider.js";
import { cancelCall as cancel_call, registerOutputSink as register_output_sink, unregisterOutputSink as unregister_output_sink } from "./executors.js";
import { placeholder as _image_placeholder, save_ref as _save_image_ref } from "./image_store.js";
import * as token_estimate from "./token_estimate.js";

// 函数内 `from x import y` 的宿主模块（本仓惯例：静态 `import * as _x_mod`，
// 再由 *Module() 惰性工厂暴露给探针，见 ROUTER_SEAMS 下方）。
import * as _loop_detector_mod from "./loop_detector.js";
import * as _steer_protocol_mod from "./steer_protocol.js";
import * as _repeat_tool_guard_mod from "./repeat_tool_guard.js";
import * as _hook_runner_mod from "./hook_runner.js";
import * as _recommender_mod from "./recommender.js";
import * as _post_edit_verifier_mod from "./post_edit_verifier.js";
import * as _router_trace_mod from "./router_trace.js";

// Re-exports from router_modules — the source's import contract, kept verbatim.
import {
  EnvironmentSnapshot,
  _is_cot_content_leak,
  _strip_leading_junk,
  _approved_plan_context,
  _merge_plan_meta,
  RouterPromptMixin,
} from "./router_modules/prompt.js";
import {
  AGENT_ROLES,
  PARALLEL_SAFE_TOOLS,
  _summarize_turn_outcome,
  RouterDispatchMixin,
} from "./router_modules/dispatch.js";
import {
  IMAGE_HINT_DELAY,
  TOOL_ARG_FRAME_INTERVAL,
  INTERRUPT_NOTE_TYPE,
  INTERRUPT_NUDGE,
  SOFT_LANDING_NOTICE,
  RouterLoopMixin,
} from "./router_modules/loop.js";
import { RouterAdmissionMixin } from "./router_modules/admission.js";
import { RouterGoalMixin } from "./router_modules/goal.js";

// The source binds all of these at module level and never reads them inside
// router.py (the mixins reach them through `self`). Reproduced as the import
// contract, exactly like admission.ts:85-91 does.
void MessageQueue;
void get_message_queue;
void DeliverAs;
void MAX_STEER_MERGED_CHARS;
void embed_text;
void get_goal_manager;
void get_compactor;
void get_prompt_loader;
void LAYER_ORDER;
void get_stable_prefix_registry;
void Result;
void RiskController;
void RiskLevel;
void PermissionMode;
void parse_consent;
void permission_prompt_block;
void ask_user_prompt_block;
void OutputGuard;
void HookStage;
void get_tool_hooks;
void ToolRegistry;
void shorten_path;
void truncate;
void ASK_WAIT_TIMEOUT_S;
void AUTO_RESOLVE_SYSTEM;
void PendingQuestion;
void build_auto_resolve_user_prompt;
void drop_waiter;
void get_ask_user_store;
void normalize_questions;
void parse_auto_resolution;
void register_waiter;
void render_answer;
void MODE_DANGER_FULL;
void MODE_REFUSED;
void risk_to_rlevel;
void select_execution;
void cancel_call;
void register_output_sink;
void unregister_output_sink;
void _image_placeholder;
void _save_image_ref;
void token_estimate;
void Event;
void EventBus;
void EnvironmentSnapshot;
void _is_cot_content_leak;
void _strip_leading_junk;
void _approved_plan_context;
void _merge_plan_meta;
void AGENT_ROLES;
void PARALLEL_SAFE_TOOLS;
void _summarize_turn_outcome;
void IMAGE_HINT_DELAY;
void TOOL_ARG_FRAME_INTERVAL;
void INTERRUPT_NOTE_TYPE;
void INTERRUPT_NUDGE;
void SOFT_LANDING_NOTICE;

// ── python 语义小工具（本仓惯例：各文件自带局部实现） ─────────────────────────

/** CPython str.strip() whitespace set (probe-pinned; see bot_remote.ts). */
const PY_WS = "\\t\\n\\v\\f\\r\\x1c\\x1d\\x1e\\xf \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

function pyStrip(s: string): string {
  return s.replace(new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g"), "");
}
void pyStrip; // the source never strips in this module; kept with the fold set.

/** python `bool(x)`. Pinned fold (dispatch.ts:182): a plain class instance is
 *  ALWAYS true — only `__bool__`/`__len__` can make an object falsy. */
function pyTruth(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      const b = (v as { __bool__?: () => unknown }).__bool__;
      if (typeof b === "function") return pyTruth(b.call(v));
      const ln = (v as { __len__?: () => unknown }).__len__;
      if (typeof ln === "function") return pyTruth(ln.call(v));
      return true;
    }
    const asMap = v as Map<unknown, unknown> & Record<string, unknown>;
    if (typeof asMap.__bool__ === "function") return pyTruth(asMap.__bool__());
    if (typeof asMap.__len__ === "function") return pyTruth(asMap.__len__());
    return Object.keys(v as object).length > 0;
  }
  return true;
}

/** python `a or b` — returns the *value*, not a boolean. `b` is passed already
 *  evaluated, so call sites with an expensive/effectful `b` must guard the call
 *  itself (the source's laziness is a call COUNT, and probes count it). */
function pyOr(a: unknown, b: unknown): unknown {
  return pyTruth(a) ? a : b;
}

/** python `dict.get(k[, default])` (admission.ts:192 fold; a non-mapping
 *  receiver raises, exactly like `.get` on a list does). */
function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    throw new TypeError(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  return key in (obj as object) ? (obj as Record<string, unknown>)[key] : dflt;
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (Array.isArray(v)) return "list";
  if (v instanceof Set) return "set";
  if (v instanceof Map) return "dict";
  if (typeof v === "object") {
    const ctor = (v as { constructor?: { name?: string } }).constructor;
    return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
  }
  return "object";
}

/** python `str(e)` inside an f-string: message only, no type prefix. */
function excStr(e: unknown): string {
  const m = (e as { pyMsg?: string })?.pyMsg;
  if (m !== undefined) {
    return m;
  }
  return String((e as Error)?.message ?? e);
}

/** python `int(x)` for the config knob: truncates toward zero, throws on a
 *  non-numeric string (ValueError) and on a bool-carrying non-number
 *  (TypeError). Only these two exception classes are caught by the source. */
class ValueErrorP extends Error {
  pyMsg: string;
  constructor(msg: string) {
    super(`ValueError: ${msg}`);
    this.name = "ValueError";
    this.pyMsg = msg;
  }
}
class TypeErrorP extends Error {
  pyMsg: string;
  constructor(msg: string) {
    super(`TypeError: ${msg}`);
    this.name = "TypeError";
    this.pyMsg = msg;
  }
}

function pyInt(x: unknown): number {
  if (typeof x === "number") {
    return Number.isNaN(x) ? x : Math.trunc(x);
  }
  if (typeof x === "boolean") {
    return x ? 1 : 0;
  }
  if (typeof x === "string") {
    const t = pyStrip(x);
    if (!/^[+-]?\d+$/.test(t)) {
      throw new ValueErrorP(`invalid literal for int() with base 10: '${x}'`);
    }
    return parseInt(t, 10);
  }
  throw new TypeErrorP(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(x)}'`);
}

function pyMax(a: number, b: number): number {
  return a > b ? a : b;
}

class KeyErrorP extends Error {
  pyMsg: string;
  constructor(msg: string) {
    super(`KeyError: ${msg}`);
    this.name = "KeyError";
    this.pyMsg = msg;
  }
}

/** python subscript `obj[key]` — a missing key RAISES, it does not read back
 *  `undefined`. Same shape as router_modules/loop.ts:426. */
function pySub(obj: unknown, key: string): any {
  if (obj !== null && typeof obj === "object") {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) throw new KeyErrorP(`'${key}'`);
    return (obj as Record<string, any>)[key];
  }
  throw new TypeErrorP(`'${pyTypeName(obj)}' object is not subscriptable`);
}

// ── 模块级常量（wire 契约，逐字保留） ─────────────────────────────────────────

/** Explicit whitelist of tools that mutate workspace files or git state.
 *  DIVERGENCE(port): python's `set` literal -> `Set`. router.py:111 and
 *  router_modules/dispatch.py's copy stay TWO DISTINCT set objects here as
 *  well — the source never aliases them, and neither side mutates either. */
export const MUTATING_WORKSPACE_TOOLS = new Set([
  "write_file", "edit_file", "apply_patch", "delete_file", "move_file", "rename_file",
  "create_file", "append_file", "replace_file_content", "write_to_file", "file_write", "file_edit",
  "run_shell", "run_command", "git_commit", "git_checkout", "git_add", "git_reset",
  "git_merge", "git_rebase", "git_cherry_pick", "git_stash", "git_pull", "git_branch",
  "worktree_create", "worktree_switch", "worktree_delete",
]);

// ── seams（python 的模块级/函数级依赖在这里可替换；默认值 = 真端口） ──────────

type AnyMod = Record<string, any>;

/** `os.path` / `uuid` / `print` / `asyncio` 的宿主触点。探针全部换成内存假象，
 *  因此本单元可以在不碰一个真实文件、真实数据库的前提下跑完（红线5）。 */
export const ROUTER_SEAMS = {
  // ── stdlib ──
  /** python `os.getcwd()`。 */
  getcwd: (): string => process.cwd(),
  /** python `os.path.abspath(p)`。 */
  abspath: (p: string): string => path.resolve(p),
  /** python `os.path.isdir(p)`。 */
  isdir: (p: string): boolean => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  /** python `os.makedirs(p, exist_ok=...)`。 */
  makedirs: (p: string, exist_ok: boolean): void => {
    fs.mkdirSync(p, { recursive: exist_ok });
  },
  /** python `os.path.dirname(os.path.abspath(__file__))` + `".."` + config.json
   *  —— 与 context_compactor.ts:397-399 同一落点（app/config.json）。 */
  configPath: (): string => path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "config.json"),
  /** python 的 `open(_cfg_path, "r", encoding="utf-8")` 读全文。 */
  readConfigText: (p: string): string => fs.readFileSync(p, "utf-8"),
  /** python `str(uuid.uuid4())`。 */
  uuid4: (): string => randomUUID(),
  /** python `print(...)`。 */
  print_: (line: string): void => {
    console.log(line);
  },
  /** python `logging.getLogger(__name__).exception(...)`（观测面，默认 noop，
   *  与 dispatch.ts:673 同规约）。 */
  log_line: (_level: string, _channel: string, _message: string): void => {
    /* noop */
  },
  /** python `asyncio.Event()`（DIVERGENCE(port) 7）。 */
  asyncioEvent: (): ReturnType<typeof MESSAGING_SEAMS.makeEvent> => MESSAGING_SEAMS.makeEvent(),
  /** python `asyncio.get_running_loop()`；`.create_task(coro)` 把协程交给循环。
   *  Node 恒有事件循环，所以源里那条 `except RuntimeError` 生产不可达
   *  （DIVERGENCE(port) 8），但探针可以让它抛。 */
  getRunningLoop: (): { createTask: (coro: unknown) => unknown } => ({
    createTask: (coro: unknown): unknown => {
      Promise.resolve(coro).catch(() => {
        /* python：异常留在 Task 句柄上，没人取就只是不显示。JS 侧必须挂一个
           catch，否则是 unhandled rejection，比源更响。 */
      });
      return { cancel: (): void => { /* python Task.cancel() 对本协程无调用方 */ } };
    },
  }),

  // ── 模块级导入（python 的模块全局，探针可逐个替换） ──
  get_storage: get_storage,
  get_event_bus: get_event_bus,
  get_risk_controller: get_risk_controller,
  get_output_guard: get_output_guard,
  get_tool_registry: get_tool_registry,
  get_skill_loader: get_skill_loader,
  get_model_registry: get_model_registry,
  get_memory_layer: get_memory_layer,
  get_rule_engine: get_rule_engine,
  get_llm_client: get_llm_client,
  get_path_guard: get_path_guard,
  get_anti_scraping_guard: get_anti_scraping_guard,
  get_remote_risk_decorator: get_remote_risk_decorator,
  get_output_sanitizer: get_output_sanitizer,
  coerce_permission: coerce_permission,
  embed_text: embed_text,
  ContextCompactor: ContextCompactor,
  MessageQueue: MessageQueue,
  GoalManager: GoalManager,

  // ── 函数内导入（惰性 *Module() 工厂，对应源的 `from x import y` 站点） ──
  promptCachePlannerModule: (): AnyMod => ({ get_stable_prefix_registry: get_stable_prefix_registry }),
  /** python 函数内 `from context_compactor import compaction_kwargs_from_config`
   *  —— 与模块级的 `ContextCompactor` 来自同一个模块，探针各换各的槽位。 */
  compactionKwargsFromConfig: (): any => compaction_kwargs_from_config(),
  loopDetectorModule: (): AnyMod => _loop_detector_mod as unknown as AnyMod,
  steerProtocolModule: (): AnyMod => _steer_protocol_mod as unknown as AnyMod,
  repeatToolGuardModule: (): AnyMod => _repeat_tool_guard_mod as unknown as AnyMod,
  hookRunnerModule: (): AnyMod => _hook_runner_mod as unknown as AnyMod,
  recommenderModule: (): AnyMod => _recommender_mod as unknown as AnyMod,
  postEditVerifierModule: (): AnyMod => _post_edit_verifier_mod as unknown as AnyMod,
  routerTraceModule: (): AnyMod => _router_trace_mod as unknown as AnyMod,
};

const _ROUTER_SEAMS_DEFAULTS = { ...ROUTER_SEAMS };

/** 探针用：整体替换 seams（对应 python 侧 monkeypatch 模块全局）。 */
export function _set_seams_for_parity(patch: Partial<typeof ROUTER_SEAMS>): void {
  Object.assign(ROUTER_SEAMS, patch);
}

/** 探针用：恢复默认实现（对应 python 侧 reload）。 */
export function _reset_seams_for_parity(): void {
  Object.assign(ROUTER_SEAMS, _ROUTER_SEAMS_DEFAULTS);
}

// ── mixin 组合（DIVERGENCE(port) 1-3） ───────────────────────────────────────

/** python `class Router(A, B, C, D, E)` 的 MRO 顺序。 */
const MIXIN_ORDER: Array<Function> = [
  RouterAdmissionMixin,
  RouterLoopMixin,
  RouterDispatchMixin,
  RouterPromptMixin,
  RouterGoalMixin,
];

/** 各 mixin 里的 `hostMissing()` 占位桩名单——python 侧不存在这些方法，
 *  它们只是 TS 单文件编译所需的宿主契约。真实现在更低优先级的 mixin 里时
 *  必须让位（DIVERGENCE(port) 2）。 */
const HOST_STUB_NAMES: Map<Function, string[]> = new Map<Function, string[]>([
  [RouterAdmissionMixin, [
    "_bind_turn_model",
    "_agent_loop",
    "_keyword_turn",
    "_model_can_read_images",
    "_persist_turn_images",
    "_maybe_capture_plan",
    "_audit",
    "_present",
    "get_system_prompt",
  ]],
  [RouterLoopMixin, [
    "_tool_specs_for",
    "_outcome_ok",
    "_is_parallel_safe",
    "_run_tool_call",
    "_harvest_images",
    "_recognize_intent",
    "_determine_dispatch",
    "_execute",
    "get_system_prompt",
    "_skill_guidance_block",
    "_sync_turn_cache_prefix",
    "_inject_context_refs",
    "_compose_user_content",
    "_accumulate_usage",
    "_request_overhead_tokens",
    "_sync_fold_budget",
    "_cancel_requested",
    "_clear_cancel",
    "_drain_steer_into",
  ]],
]);

/** 把 5 个 mixin 的原型成员按 MRO 顺序铺到目标原型上（首个真实现胜出）。 */
function compose_router_proto(target: object): void {
  const placed = new Map<string, boolean>(); // name -> 是否已是真实现
  for (const Mixin of MIXIN_ORDER) {
    const stubs = new Set(HOST_STUB_NAMES.get(Mixin) ?? []);
    for (const name of Object.getOwnPropertyNames(Mixin.prototype)) {
      if (name === "constructor") {
        continue;
      }
      const is_stub = stubs.has(name);
      const existing = placed.get(name);
      if (existing === undefined) {
        Object.defineProperty(
          target, name, Object.getOwnPropertyDescriptor(Mixin.prototype, name) as PropertyDescriptor,
        );
        placed.set(name, !is_stub);
        continue;
      }
      if (!existing && !is_stub) {
        // 先前放的只是宿主契约占位，真实现来了才让位。
        Object.defineProperty(
          target, name, Object.getOwnPropertyDescriptor(Mixin.prototype, name) as PropertyDescriptor,
        );
        placed.set(name, true);
      }
      // 否则：MRO 上已有真实现（后续同名一律遮蔽），或这次本身就是占位桩。
    }
  }
}

/** 名单与实际桩的一致性检查：改名/删桩都要在装载时炸出来，而不悄悄留个影子。 */
function assert_host_stubs(): void {
  for (const [Mixin, names] of HOST_STUB_NAMES) {
    for (const name of names) {
      if (!(name in (Mixin.prototype as object))) {
        throw new Error(`router.ts: host-contract stub '${name}' is gone from ${Mixin.name}`);
      }
    }
  }
}

export class Router {
  /** One agent session: state + the 5-step decision chain that routes a turn.
   *
   * A Router instance IS a session. Everything mutable that a conversation owns
   * lives here — workspace, session_id, mode, permission, the context compactor,
   * the steer queue, the goal binding, the cancel token. Nothing about a turn is
   * read from module state, so N Routers can run concurrently in one process
   * without seeing each other. This is what lets `SessionHost` hand a different
   * Router to each connected window (the session lives in its own object,
   * clients attach to it).
   *
   * Low-level services ARE shared on purpose, because they hold no
   * conversation state: storage (SQLite, every row keyed by session), the tool
   * and skill registries, the model registry, the LLM client, the event bus.
   * Sharing them is what keeps a second session nearly free instead of another
   * 150MB.
   */
  [k: string]: any;

  constructor(init: RouterInit = {}) {
    const workspace: string | null = init.workspace === undefined ? null : init.workspace;
    const system_prompt: string | null = init.system_prompt === undefined ? null : init.system_prompt;
    const session_id: string | null = init.session_id === undefined ? null : init.session_id;
    const mount_shared: boolean = init.mount_shared === undefined ? true : init.mount_shared;

    this.system_prompt = pyOr(system_prompt, "");
    // Storage must exist before we can read the persisted workspace choice.
    this.storage = ROUTER_SEAMS.get_storage();
    // Boot into the folder the user last opened, if any. Falls back to the
    // value passed in (from config.workspace.root or CLI) and finally CWD.
    let saved_ws: string;
    try {
      saved_ws = (pyOr(this.storage.get_config("active_workspace", ""), "") as string);
    } catch {
      saved_ws = "";
    }
    // BUG(port): 源为 `except Exception`，宽吞逐字保留 —— 读不到 active_workspace
    //        只是回落到本次启动的目录，不该让会话建不起来。
    let chosen: string;
    if (pyTruth(saved_ws) && ROUTER_SEAMS.isdir(saved_ws)) {
      chosen = saved_ws;
    } else {
      // python `workspace or os.getcwd()`: getcwd() is only reached when the
      // caller gave nothing (call COUNT, not just value).
      chosen = (pyTruth(workspace) ? workspace : ROUTER_SEAMS.getcwd()) as string;
    }
    // An explicit workspace argument wins over the persisted one: the host
    // creates per-workspace sessions, and those must land where asked rather
    // than snapping back to whatever folder was open last.
    if (pyTruth(workspace) && ROUTER_SEAMS.isdir(workspace as string)) {
      chosen = workspace as string;
    }
    // Normalize to an ABSOLUTE path. Callers occasionally pass "." or an
    // already-relative path (the config file, an old bookmark, `os.getcwd()`
    // in a shell that was launched relative). Storing the raw string then
    // made the sidebar label say ".", which reads like a rendering bug.
    try {
      if (pyTruth(chosen)) {
        chosen = ROUTER_SEAMS.abspath(chosen);
      }
    } catch {
      // fail-open: 可选增强，失败不影响主流程
    }
    this.workspace = chosen;
    if (pyTruth(this.workspace)) {
      try {
        ROUTER_SEAMS.makedirs(this.workspace as string, true);
      } catch {
        // BUG(port): 源为 `except Exception: pass`。目录建不出来（只读盘、权限）
        //        之后每个写工具都会自己报错，没必要在构造期炸掉整个会话。
      }
    }
    // Whether the user has ACTUALLY picked a workspace, as opposed to the
    // process silently falling back to its own CWD (which, when running from
    // source, is inside Ovolve's own git repo — that is how the git panel
    // used to show hundreds of "changes" before any folder was opened).
    //
    // "Selected" means one of:
    //   * a persisted ``active_workspace`` exists and still resolves, OR
    //   * an explicit workspace argument was passed that is NOT just the
    //     process CWD (config's ``workspace.root: "."`` resolves to CWD, so
    //     that boot default must NOT count as a real selection).
    // ``switch_workspace`` flips this True the moment the user opens a folder.
    let startup_cwd: string;
    try {
      startup_cwd = ROUTER_SEAMS.abspath(ROUTER_SEAMS.getcwd());
    } catch {
      startup_cwd = "";
    }
    const has_saved = pyTruth(saved_ws) && ROUTER_SEAMS.isdir(saved_ws);
    const explicit_pick = pyTruth(workspace)
      && ROUTER_SEAMS.isdir(workspace as string)
      && ROUTER_SEAMS.abspath(workspace as string) !== startup_cwd;
    this.workspace_selected = pyTruth(has_saved || explicit_pick);
    if (pyTruth(session_id)) {
      // Host-driven: attach to a specific session row, create it if the
      // caller invented a fresh UUID.
      this.session_id = session_id;
      try {
        if (!pyTruth(this.storage.get_session(session_id as string))) {
          // `effective_workspace`, NOT `self.workspace`: the raw value
          // is the cwd fallback, and stamping it onto a session row is
          // what made a workspace called "app" (Ovolve's own launch
          // directory) appear in the sidebar the moment the user sent a
          // message. `workspace_selected` is computed just above, so
          // the property is already meaningful here.
          // DIVERGENCE(port): python 的关键字 `workspace=` 落在 TS 形参
          // `workspace` 的同一槽位（storage 端口把 python 的 5 个位置/关键字
          // 参数铺成了 init.max_tokens 那样的位置序列，见 sessions.ts:32）。
          this.storage.create_session(session_id as string, "New chat", null, null, this.effective_workspace);
        }
      } catch (exc) {
        ROUTER_SEAMS.print_(`[Router] create_session(${session_id}) failed: ${excStr(exc)}`);
      }
    } else {
      // Sweep ghost sessions (empty rows created by prior boots) and back-fill
      // placeholder titles from the first user message, THEN pick a real one to
      // resume. Doing this before the resume query guarantees we can't pick a
      // ghost as the "most recent" session.
      try {
        const [deleted, retitled] = this.storage.cleanup_sessions() as [number, number];
        if (pyTruth(deleted) || pyTruth(retitled)) {
          ROUTER_SEAMS.print_(`[Router] cleanup_sessions: deleted=${deleted} retitled=${retitled}`);
        }
      } catch (exc) {
        // BUG(port): 源为 `except Exception`，清扫失败不影响本次启动。
        ROUTER_SEAMS.print_(`[Router] cleanup_sessions failed: ${excStr(exc)}`);
      }
      // Reuse the most recent session with messages rather than spawning a new
      // UUID every startup. The old code created one per boot, which is why
      // the sidebar fills with untitled "Main session" ghosts.
      const existing = this.storage.list_sessions(1);
      if (pyTruth(existing)) {
        // python 的 `existing[0]["id"]` 是下标：缺键抛 KeyError，构造期直接失败，
        // 读回 undefined 会让会话挂到一个 "undefined" id 上。
        this.session_id = pySub((existing as any[])[0], "id");
      } else {
        this.session_id = ROUTER_SEAMS.uuid4();
        this.storage.create_session(this.session_id, "New chat");
      }
    }
    this.bus = ROUTER_SEAMS.get_event_bus();
    this.risk = ROUTER_SEAMS.get_risk_controller();
    this.guard = ROUTER_SEAMS.get_output_guard();
    this.tools = ROUTER_SEAMS.get_tool_registry();
    this.skills = ROUTER_SEAMS.get_skill_loader();
    this.models = ROUTER_SEAMS.get_model_registry();
    //: Where the unchanging head of the system prompt ends this turn (3.3).
    //: Written by get_system_prompt, read by _llm_chat_streamed. Empty until
    //: the first prompt is built, and an empty value simply means "no cache
    //: breakpoint" — so a caller that skips get_system_prompt is safe.
    this._sys_cache_prefix = "";
    //: 稳定前缀注册表（进程内共享）。get_system_prompt 每次算出新的
    //: stable 前缀就按会话作用域注册一次；后续拼接点（技能展开、
    //: 定时任务）也可以注册自己的静态脚手架，让缓存断点落在确切
    //: 字节边界而不是整块消息。
    this._stable_prefixes = ROUTER_SEAMS.promptCachePlannerModule().get_stable_prefix_registry();
    // Per-session, NOT singletons. The compactor accumulates read/modified
    // files and fold counters for one conversation; the queue is this
    // session's steer inbox. Sharing either one lets a fold triggered in
    // window A truncate window B's history, or a steer typed in A get
    // consumed by B's turn.
    // Config-tunable fold thresholds (`compaction` block in config.json) —
    // the same helper get_compactor() uses, applied to this session's own
    // compactor.
    // DIVERGENCE(port): python `ContextCompactor(**kwargs)` 的解包，在 TS 侧就是
    // 把同一个 record 交给 compactor 的 init 形参（context_compactor.ts:660）。
    this.compactor = new ROUTER_SEAMS.ContextCompactor(ROUTER_SEAMS.compactionKwargsFromConfig());
    this.queue = new ROUTER_SEAMS.MessageQueue();
    // The compactor emits `context_folded` on the shared bus; tag it with our
    // session so the fold card renders in the right window.
    this.compactor.session_id = this.session_id;
    // Point memory at the workspace the user actually opened. Without this the
    // layer keeps its constructor default of ``os.getcwd()`` forever — nothing
    // in the codebase used to scope it at all — so recall was reading a
    // bucket keyed by wherever the backend process happened to start, while
    // writes were stamped with the real workspace. Memories got saved and then
    // never recalled.
    //
    // `effective_workspace`, not `workspace`: when the user hasn't picked a
    // folder, memories belong to the default workspace (`''`) — the same key
    // the sessions table uses — not to the backend's launch directory.
    //
    // A per-Router handle, not a mutable global root: the layer is a process
    // singleton and the app keeps several sessions open on different folders.
    // A shared "current workspace" meant the most recently constructed Router
    // silently repointed every other session's recall at ITS workspace. The
    // handle shares all the machinery (one DB handle, one embedder, one dream
    // loop) — only the scope differs. Passing the session id keeps this
    // session's WORKING-tier scratch in its own bucket, so two windows never
    // inject each other's "we're editing foo.py right now" notes.
    this.memory = ROUTER_SEAMS.get_memory_layer().for_root(
      this.effective_workspace, this.session_id,
    );
    // Layer 2 semantic memory: give memory_layer a local sentence embedder so
    // recall switches from OR-keyword scoring to cosine similarity. embed_text
    // degrades to None if sentence-transformers isn't installed, so this is
    // safe to wire unconditionally — the memory layer keeps working either way.
    this.memory.set_embed_callback(ROUTER_SEAMS.embed_text);
    // Layer 1 rule memory: user-editable rules/*.md, injected into the prompt.
    // Cached per workspace path, so two sessions in the same folder share the
    // parsed rules while sessions in different folders never cross-read.
    this.rules = ROUTER_SEAMS.get_rule_engine(this.workspace);

    // One axis, chosen by the USER per turn (never by the model):
    //   permission — plan / readonly / confirm / auto / full
    // It lives in `risk_control`, because that module already owns the
    // "may this call happen" question; a second enum next to it just meant
    // two places to keep in sync. `plan` and `readonly` hard-block writes
    // (a GLOBAL-layer DENY, which short-circuits the pipeline and so can't be
    // rescued by a granted permission); the rest differ only in whether a
    // write needs approval. There used to be a second `mode` axis (ask/plan/
    // edit/agent) on top of this, but the product IS an agent — "should it act
    // like an agent" is not a question worth asking every turn. Plan was the
    // only mode carrying real intent, so it moved onto this axis.
    // Baseline = config.json's `permissions.mode`. This was hardcoded AUTO,
    // so a user who set `plan` there was silently ignored; a caller that
    // sends nothing (tests, old frontend) still lands on auto when the
    // config omits the key too. The same read also feeds the agent-loop
    // ceiling and the compactor knobs below — one file touch, one dict.
    let _cfg: Record<string, any> = {};
    try {
      const _cfg_path = ROUTER_SEAMS.configPath();
      _cfg = JSON.parse(ROUTER_SEAMS.readConfigText(_cfg_path));
    } catch {
      _cfg = {};
    }
    // BUG(port): 源为 `except Exception: _cfg = {}` —— 配置文件坏了、不存在、
    //        不是 JSON 都按"没配"处理；权限、步数、折叠阈值一起回落默认。
    this.permission = ROUTER_SEAMS.coerce_permission(
      dictGet(pyOr(dictGet(_cfg, "permissions", null), {}), "mode", null));
    // Per-turn tool-loop ceiling, user-tunable (`agent.max_steps_per_turn`).
    // 工业级 AI Agent 架构规范（业界主流方案对齐）：
    // 默认不设人为步数硬截断（_steps <= 0 代表无步数限制，持续执行直至自然收敛或用户打断）。
    // 若用户显式配置了正整数上限，则尊重用户设置，不再硬性钳位到 32 步。
    let _steps = 0;
    try {
      const _steps_val = dictGet(pyOr(dictGet(_cfg, "agent", null), {}), "max_steps_per_turn", null);
      _steps = _steps_val === null ? 0 : pyInt(_steps_val);
    } catch (exc) {
      // python `except (TypeError, ValueError)` — 窄吞照旧，别的异常继续往外抛。
      if (exc instanceof TypeErrorP || exc instanceof ValueErrorP) {
        _steps = 0;
      } else {
        throw exc;
      }
    }
    this.max_agent_steps = _steps > 0 ? _steps : 0;
    this.soft_landing_step = this.max_agent_steps > 0 ? pyMax(1, this.max_agent_steps - 2) : -1;
    //: Loop-detection thresholds (`agent.loop_detection`), read once and
    //: validated so a hand-edited config can't leave the circuit breaker
    //: unreachable. The detector itself is per-TURN (see `handle`); only its
    //: configuration is per-Router.
    this._loop_config = ROUTER_SEAMS.loopDetectorModule().LoopConfig.from_config(_cfg);
    this.loop_detector = new (ROUTER_SEAMS.loopDetectorModule().LoopDetector)(this._loop_config);
    this.steer_queue = new (ROUTER_SEAMS.steerProtocolModule().SteerQueue)(this.queue);
    this.repeat_tool_guard = new (ROUTER_SEAMS.repeatToolGuardModule().RepeatToolGuard)();
    // `ask_user` 自动消解开关。默认开：答案其实已经在上下文里的时候，多问一遍
    // 只是白烧一个回合还打断人。判定本身是一次独立的模型调用，判不出来就照常
    // 问人 —— 详见 ask_user.py 里那三条纪律。
    this.ask_auto_resolve = true;
    // Per-session goal binding. GoalManager caches `_active_goal` and
    // `_session_id`, so a shared instance means session B's `set_session`
    // silently repoints session A's active goal. Goal ROWS stay in the shared
    // SQLite, so nothing is duplicated — only the in-memory cursor is local.
    this.goals = new ROUTER_SEAMS.GoalManager();
    this.goals.set_session(this.session_id);
    this.llm = ROUTER_SEAMS.get_llm_client();
    //: The config.json-backed client. Every turn re-derives its working client
    //: from THIS one, so a model pick on one turn never leaks into the next:
    //: a turn that sends no model falls straight back to config's defaults.
    this._base_llm = this.llm;
    //: The composite model id the current turn asked for ("" = config default).
    this._turn_model = "";
    //: Workspace-level defaults persisted via per-workspace settings
    //: (`workspace_settings_set`). The per-turn payload wins, then these,
    //: then config.json. Previously these were written onto the router under
    //: names nothing ever read, so the settings page changed nothing.
    this.workspace_model = "";
    this.workspace_thought_level = "";
    //: Thinking level for the current turn (UD4). "" = don't send the
    //: parameter at all, which is NOT the same as asking for no thinking.
    this._turn_effort = "";
    //: 本轮 `tool_search` 已经浮出来的工具名（六·UC1）。**按回合清空**：
    //: 每个新请求都有自己的相关性画像，留着上一轮的命中会一路累积到目录
    //: 又变成全量，裁剪就白做了。真的还需要，重搜一次的代价只有一次调用。
    this._revealed_tools = new Set<string>();
    //: `_revealed_tools` 变宽后置位，由 `_agent_loop` 在下一个步边界消费并
    //: 重建 tool_specs。用标志位而不是在工具里直接改 specs，是因为步边界是
    //: 唯一能安全换目录的地方 —— 一次模型调用发出去之后目录就定了。
    this._catalogue_dirty = false;

    // NOTE: session creation happens above (reuse-or-create). Do NOT
    // create_session here — it's INSERT OR REPLACE, so on a reused session
    // it would reset the title back to a placeholder and stomp created_at.
    // Restore any active goal for this session
    this.goals.load_goal_state(this.session_id);
    this._session_started = false; // session_start fires lazily on first handle()
    //: Cooperative cancel token for the in-flight turn. Set by ``cancel()``,
    //: checked between agent-loop steps and before each tool call.
    this._cancelled = ROUTER_SEAMS.asyncioEvent();
    //: call_id → tool name for every tool call currently in flight. Tools run
    //: in worker threads, so cancelling the await unwinds the coroutine while
    //: the child command keeps running; this registry is what makes killing
    //: it possible. Mutated from the event loop only (dispatch is awaited),
    //: so no lock is needed on this side — `executors` guards its own table.
    this._live_calls = {};
    this._turn_seq = -1; // updated at the start of each handle() call
    //: Optional tool allowlist. None → full catalogue. A set of tool names →
    //: only those tools are exposed to the model AND accepted at dispatch.
    //: Set by the sub-agent runtime so a spawned ``explore`` agent physically
    //: cannot write, no matter what the model tries.
    this.allowed_tools = null;
    //: True when this Router is a spawned sub-agent (suppresses recursive
    //: ``task`` spawning and marks its turns as internal).
    this.is_subagent = false;
    //: Personas this sub-agent may hand the task onward to. Empty → it is a
    //: leaf and `task` stays hidden. Populated by the sub-agent runtime from
    //: the persona definition, never by the model.
    this.subagent_handoffs = new Set<string>();
    //: How many hand-offs deep we already are. 0 = the user's own turn.
    this.subagent_depth = 0;
    this._init_event_subscribers({ mount_shared });
    // Load on-disk skills (.agents/skills) — discover() existed but was never
    // called, so skills on disk were invisible. This makes SOP / domain
    // skills actually available at runtime.
    try {
      this.skills.discover();
    } catch (_e) {
      // 技能不可见 = 能力静默失效（§11 渐进披露整条链路空转），必须喊出来
      ROUTER_SEAMS.print_(`[router] skill discover failed: ${excStr(_e)}`);
    }
    // Register the asset-derived analysis tools (diagnose / security_audit /
    // red_team_scan / recommend) so they are available in every entry point.
    // DIVERGENCE(port) 4: python 的这一步在 `__init__` 返回前就跑完了；TS 侧
    // `_register_analysis_tools` 是 async（admission.ts:606），构造器不能 await，
    // 所以在这里起步、并把 promise 挂在 `_analysis_ready` 上。方法体每一行都
    // 自带 try/except，promise 不会 reject，注册名与注册顺序完全一致。
    this._analysis_ready = this._register_analysis_tools();
    // Kick off idle-driven dream loop (P0 fix: DreamConsolidator was never started).
    // Best-effort — if no running loop yet, the caller can start it later via
    // `await router.start_background()`.
    try {
      ROUTER_SEAMS.getRunningLoop().createTask(this.memory.start_background());
    } catch {
      // fail-open: 可选增强，失败不影响主流程
      // python `except RuntimeError` —— Node 恒有事件循环，这条分支生产不可达
      // （DIVERGENCE(port) 8），保留是因为 seam 可以抛。
    }
  }

  _init_event_subscribers(opts: { mount_shared?: boolean } = {}): void {
    /** Mount event subscribers onto the process-wide bus.
     *
     * Two categories:
     *   - Process-wide (guards, sanitizers, risk): should only be mounted once
     *     per process lifetime. `mount_shared=False` skips them; `SessionHost`
     *     passes this for every router after the first.
     *   - Per-session (compactor, memory layer hooks): always mounted because
     *     each router instance has its own compactor/memory wiring.
     */
    const mount_shared = opts.mount_shared === undefined ? true : opts.mount_shared;
    if (pyTruth(mount_shared)) {
      // PathGuard (priority 300): block writes escaping the workspace.
      ROUTER_SEAMS.get_path_guard().mount(this.bus);
      // AntiScrapingGuard (priority 120): escalate blacklisted platforms.
      ROUTER_SEAMS.get_anti_scraping_guard().mount(this.bus);
      this.risk.mount(this.bus);
      // Remote (Bot) sessions: enforce toolDenylist.
      ROUTER_SEAMS.get_remote_risk_decorator().mount(this.bus);
      this.guard.mount(this.bus);
      // OutputSanitizer (priority 50): strip MAC/abs paths from output.
      ROUTER_SEAMS.get_output_sanitizer().mount(this.bus);
      // HookRunner (priority -50): external script hooks on bus events.
      try {
        ROUTER_SEAMS.hookRunnerModule().get_hook_runner(this.workspace, this.session_id).mount(this.bus);
      } catch {
        // BUG(port): 源为 `except Exception: pass` —— 用户自己的 hook 脚本坏了
        //        不能拖垮宿主；没有 runner 就等于没有 hook。
      }
      // Capability recommender (priority 20): rank local skills/tools against
      // this turn and, only when the match is strong, name the top few in the
      // TOOLS layer. Process-wide because the ranker is a stateless singleton
      // — it scopes its cache by the workspace carried on the event.
      try {
        ROUTER_SEAMS.recommenderModule().get_recommender().mount(this.bus);
      } catch {
        // fail-open: 可选增强，失败不影响主流程
      }
    }

    // Per-session subscribers — safe to mount per router because the compactor
    // and memory instances are already per-session (owned by `self`).
    this.compactor.mount(this.bus);
    // Give the compactor its LLM layer. Injected rather than imported so the
    // compactor stays independent of Router/memory_layer.
    // DIVERGENCE(port) 6: python 的 `self._x` 本来就是 bound method；TS 侧方法
    // 当回调传出去会丢 `this`，所以显式 bind。函数对象与调用序列不变。
    this.compactor.set_summarizer(this._synthesize_for_fold.bind(this));
    // Pre-compaction memory flush: extract decisions/preferences BEFORE the
    // summariser eats the transcript, so compaction stops being a net loss.
    this.compactor.set_memory_flush(this._flush_memory_for_fold.bind(this));
    // Post-compaction memory warmup: prefetch relevant memories so the next
    // turn starts with both the summary skeleton and warm recall血肉.
    const _warmup = async (session_id: string, query: string): Promise<void> => {
      try {
        await this.memory.active_recall(query, 5, session_id);
      } catch {
        // fail-open: 可选增强，失败不影响主流程
      }
    };
    this.compactor.set_post_fold_warmup(_warmup);

    // Post-edit verification: verify the workspace after file edits.
    try {
      this._post_edit_verifier = new (ROUTER_SEAMS.postEditVerifierModule().PostEditVerifier)(this.bus);
      this._post_edit_verifier.mount(this.workspace, this.session_id);
    } catch (exc) {
      ROUTER_SEAMS.print_(`[Router] post-edit verifier mount skipped: ${excStr(exc)}`);
    }

    // P0 fix (audit §1 + §10): memory_layer had mount() but was never called.
    // Also wire session_before_compact -> synthesize_session for cross-session memory.
    this.memory.mount(this.bus);
    this.bus.on("session_before_compact", this._on_before_compact.bind(this), 5);
    // Phase 1: mirror this session's turn/step/tool traffic into the
    // EventStore via the canonical gateway. Observational by design — a
    // broken trace mirror must never break the turn it traces.
    try {
      this._trace_bridge = new (ROUTER_SEAMS.routerTraceModule().RouterTraceBridge)(this.bus, this.session_id);
      this._trace_bridge.mount();
    } catch {
      // Local import: this module predates the logging convention; a
      // NameError in the failure path would be worse than the failure.
      // python 的 `logger.exception(msg)` 打印的就是这条 msg，异常体走 exc_info
      // 的 traceback（跨语言不可比，见 DIVERGENCE(port) 10）；消息文本必须逐字一致。
      ROUTER_SEAMS.log_line("error", "router",
        "trace bridge failed to mount — turns run untraced");
    }
  }
}

/** `Router(workspace=..., system_prompt=..., session_id=..., mount_shared=...)`
 *  的记录形（DIVERGENCE(port) 5）；与 session_host.ts:119 的 `RouterCtor`
 *  形参逐字对齐。 */
export interface RouterInit {
  workspace?: string | null;
  system_prompt?: string | null;
  session_id?: string | null;
  mount_shared?: boolean;
}

assert_host_stubs();
compose_router_proto(Router.prototype);
// DIVERGENCE(port) 3: python 的 mixin 类属性在 TS 里是实例字段初始化器，
// 原型合并不执行任何 mixin 构造器，所以在这里按原值铺回 Router.prototype。
// 只搬这两条真正的 python 类属性：mixin 里那些 `workspace?: string` 之类的
// 字段声明在 ES2022 class field 语义下也会成为 own 的 `undefined`，一把
// Object.assign 会把这些 undefined 铺到 Router.prototype 上盖住真方法，
// 还会把 prompt mixin 自己声明的 `effective_workspace` 当数据字段去 set
// admission 的 getter（TypeError: has only a getter）。所以这里白名单逐条搬。
for (const name of ["GUIDANCE_FILES", "GUIDANCE_MAX_CHARS"]) {
  const template = new (RouterPromptMixin as unknown as new () => Record<string, any>)();
  Object.defineProperty(Router.prototype, name, {
    value: template[name],
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

let _ROUTER_INSTANCE: Router | null = null;

export function get_router(workspace: string | null = null): Router {
  /** Get or create the singleton Router instance. */
  if (_ROUTER_INSTANCE === null) {
    _ROUTER_INSTANCE = new Router({ workspace });
  }
  return _ROUTER_INSTANCE;
}

/** 探针/测试用：python 侧把 `router._ROUTER_INSTANCE = None` 当复位开关。 */
export function _set_router_instance(instance: Router | null): void {
  _ROUTER_INSTANCE = instance;
}
