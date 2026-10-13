/**
 * tools.ts — Tool registry with definition/execution separation (Pi pattern).
 *
 * Ported from `app/backend/tools.py` (977 lines, SPLIT unit — TS half).
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/tools.py -> app/engine/tools.ts (SPLIT, TS half).
 *   §2  present-but-null: every `args.get(k, d)` is dictGet (a key present with
 *       a null value yields None, not the default); `context.get("blocked")`
 *       gates go through pyTruth, never JS truthiness.
 *   §2  crash semantics kept: the mixed call convention is a SOURCE quirk —
 *       dispatch invokes `execute(validated, context)` positionally, so the
 *       six named-signature impls (`_chrome_devtools_impl`, `_workflow_list_
 *       impl`, `_workflow_record_stop_impl`, `_evolution_undo_impl`,
 *       `_workflow_schedule_list_impl`, `_workflow_schedule_delete_impl`)
 *       raise "TypeError: ... positional arguments ..." when reached through
 *       the registry. pyBindPos reproduces Python's positional-binding errors
 *       byte-for-byte (JS would silently ignore the extra argument); the
 *       affected impls take `...callArgs` and bind slots by hand.
 *   §2  `audit = {...}` is built and never appended to _execution_history —
 *       the source's history is permanently empty. Kept bug-for-bug.
 *   §2  `int(max_chars * 0.6)` / `int(left)` truncate toward zero (Math.trunc);
 *       `{omitted:,}` thousands grouping is mirrored by pyIntFmt.
 *   §2  Python len()/slicing are code-point based; truncate() therefore works
 *       on Array.from(text) so astral characters count as 1 and head/tail
 *       budgets match the source exactly.
 *   §2  fnmatch.fnmatch normalizes case AND separators on Windows (os.path.
 *       normcase) — pyFnmatch mirrors that behind a win32 gate.
 *   §2  the `dirs[:] = [...]` walk prune replaces the list in place while
 *       os.walk's own recursion keeps iterating the same list — pyListAssign
 *       + the generator reproduce that mutation-while-descending behaviour.
 *
 * MIGRATION DECISIONS / DIVERGENCES (documented dispositions)
 *   host seams: `from tool_validator import validate_args` (Rust, wave 3) and
 *       `import activity_exec` (Rust, wave 2) are not landed TS. Both are
 *       bindable seams (executors.setPythonRuntime precedent). Unbound →
 *       calling throws `ModuleNotFoundError: ...`, which escapes dispatch /
 *       execution_plan exactly where Python's ImportError would (both call
 *       sites sit OUTSIDE the try block — verified line by line in the source:
 *       validate_args at dispatch head, classify_execution via
 *       execution_plan before the try). KILL_GRACE_SEC ships on the seam so
 *       the backstop budget (budget + grace) matches the real module.
 *   `_executors.bind_call_id(...)/unbind_call_id(token)` has no token API in
 *       executors.ts (documented AsyncLocalStorage divergence there): the
 *       awaited section of dispatch is wrapped in executors.callScope(cid, ...)
 *       instead; entry/exit scoping is equivalent for the spawn-tracking
 *       consumers underneath. DIVERGENCE(port): scope exits at the closure
 *       boundary rather than the `finally:` line — same promise, same window.
 *   `asyncio.iscoroutinefunction(execute)` → isCoroutineFn (constructor name
 *       check). DIVERGENCE(port, async bridge): a few TS landed handlers are
 *       async where their Python twins are sync (chrome_devtools_handler,
 *       WorkflowReplayer.replay, scheduler.create_schedule). Their impl
 *       wrappers are async, so introspected coroutine-ness differs from the
 *       Python twin; observable behaviour does not — dispatch awaits the
 *       outcome in both branches (the source itself defends with the
 *       `hasattr(outcome, "__await__")` re-await). Circuit-breaker counts and
 *       every message are identical.
 *   wait_for cancellation: rejecting the race only abandons the await; the
 *       orphaned promise (like Python's orphaned thread) keeps running. The
 *       timeout texts say exactly that, so the contract the model reads is
 *       the same on both sides.
 *   asyncio.CancelledError: TS has no cooperative turn cancellation; a host
 *       that cancels must reject with an error whose name is
 *       "CancelledError" — dispatch re-raises it un-counted, matching the
 *       source's `raise` branch.
 *   os.walk / readdir ordering is OS-defined on both sides; parity pins trees
 *       where the match order is deterministic or sorts before compare.
 *   open(..., errors="ignore") drops undecodable bytes; Node's utf8 decode
 *       replaces them with U+FFFD instead. Only observable for regex matches
 *       inside malformed bytes — noted, not emulated.
 *   Python `re` and JS RegExp are different dialects; patterns are passed
 *       through unchanged and invalid-pattern messages are engine-shaped
 *       ("Invalid regex: " prefix is identical, the tail is not).
 *   str(e) texts for errors we do not construct (RegExp SyntaxError, ENOENT)
 *       are engine-shaped; every message the source itself formats is verbatim.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { Result } from "./result.js";
import * as executors from "./executors.js";
import { bind_tools_module, create_ask_user_tool } from "./ask_user.js";
import { tool_search_handler } from "./tool_search.js";
import { execute_code_references_tool } from "./code_graph.js";
import { get_question_registry } from "./ask_user_question.js";
import { lsp_navigate_handler } from "./lsp_client.js";
import { get_workflow_recorder, load_workflow, list_workflows, WorkflowReplayer } from "./workflow_recorder.js";
import { WorkflowMetricsTracker } from "./workflow_evolution.js";
import { get_workflow_scheduler } from "./workflow_scheduler.js";
import { undo } from "./evolution_undo.js";
import type { JsonDict } from "./danger_classifier.js";

export type ToolExecuteFn = (args: JsonDict, ctx: JsonDict) => unknown;

// ── house Python-semantics helpers (per-file, project convention) ──────────

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

/** str(exc): our constructed Errors carry the Python-shaped message. */
function pyStrExc(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function isPyDict(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
  if (!isPyDict(obj)) {
    throw new Error(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  return key in obj ? (obj as Record<string, unknown>)[key] : dflt;
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (Array.isArray(v)) return "list";
  return "dict";
}

/** `str(a or b)` — falsy or-gate then str(). */
function pyStrOr(v: unknown, dflt: unknown): string {
  return pyStr(pyTruth(v) ? v : dflt);
}

/** python time.time() — float seconds. */
function timeNow(): number {
  return Date.now() / 1000;
}

/** python int() on a float truncates toward zero. */
function pyInt(v: number): number {
  return Math.trunc(v);
}

/** f"{n:,}" — base-10 group-by-threes. */
function pyIntFmt(n: number): string {
  return String(n).replace(/^-?\d+/, (m) => m.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
}

/** `a >= b` where b may be a non-number — raises the Python TypeError shape. */
function pyGe(a: number, b: unknown): boolean {
  if (typeof b !== "number") {
    throw new Error(
      `'>=' not supported between instances of 'int' and '${pyTypeName(b)}'`);
  }
  return a >= b;
}

/** asyncio.iscoroutinefunction(execute) — the only faithful JS probe. */
function isCoroutineFn(fn: unknown): boolean {
  return typeof fn === "function" &&
    (fn as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction";
}

/**
 * Python positional-binding emulation for the named-signature impls.
 *
 * dispatch calls every tool as `execute(validated, context)`. Six impls have
 * named parameters with **kwargs, so the second positional argument has no
 * slot and Python raises TypeError before the body runs; JS would silently
 * drop it. pyBindPos restores the error, message-for-message.
 */
function pyBindPos(fname: string, required: number, optional: number, got: number): void {
  if (got <= required + optional) return;
  let head: string;
  if (required === 0 && optional > 0) {
    head = `takes from 0 to ${optional} positional arguments`;
  } else if (required === 0) {
    head = `takes 0 positional arguments`;
  } else {
    const n = required + optional;
    head = `takes ${n} positional argument${n === 1 ? "" : "s"}`;
  }
  throw new TypeError(`${fname}() ${head} but ${got} were given`);
}

/** fnmatch.fnmatch with the Windows normcase pass Python performs. */
function pyNormcase(s: string): string {
  if (process.platform === "win32") return s.replaceAll("/", "\\").toLowerCase();
  return s;
}

function pyFnmatch(name: string, pat: string): boolean {
  name = pyNormcase(name);
  pat = pyNormcase(pat);
  let rx = _fnmatchCache.get(pat);
  if (rx === undefined) {
    rx = _translate(pat);
    _fnmatchCache.set(pat, rx);
  }
  return rx.test(name);
}
const _fnmatchCache = new Map<string, RegExp>();

function _translate(pat: string): RegExp {
  // fnmatch.translate: *, ?, [seq] (with leading ! negation), everything else
  // literal. Non-greedy-free char classes mirror Python's [] semantics.
  let out = "^";
  let i = 0;
  while (i < pat.length) {
    const c = pat[i] ?? "";
    if (c === "*") {
      out += ".*";
    } else if (c === "?") {
      out += ".";
    } else if (c === "[") {
      let j = i + 1;
      let neg = "";
      if (pat[j] === "!" || pat[j] === "^") { neg = "^"; j++; }
      let cls = "";
      // first ']' closes the set; consume until matching ']'
      let k = j;
      if (pat[k] === "]") k++;
      while (k < pat.length && pat[k] !== "]") k++;
      if (k >= pat.length) {
        cls = "]" + pat.slice(j).replace(/[\\^$.|?*+()[\]{}]/g, "\\$&"); // unterminated: literal
        out += "[" + neg + cls + "]";
        i = pat.length;
        continue;
      }
      const body = pat.slice(j, k);
      cls = body.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
      out += "[" + neg + cls + "]";
      i = k;
    } else {
      out += c.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
    }
    i++;
  }
  out += "$";
  return new RegExp(out, "s");
}

// ── Per-domain tool timeout (seconds) ─────────────────────────────────────────
// A stuck tool must not kill the whole turn. The dispatch wraps every call in
// asyncio.wait_for; on timeout the agent loop receives a readable error result
// and can decide to retry, use a fallback, or report the failure.
//
// Values are deliberately asymmetric: read tools have no network variance so
// they're short; shell/web tools may wait on real I/O so they get more budget.
// Anything not explicitly listed falls through to DEFAULT.
export const TOOL_TIMEOUT_BY_DOMAIN: Record<string, number> = {
  file: 30,
  search: 60,
  computer: 120,
  browser: 90,
  app: 60,
  general: 60,
};
export const TOOL_TIMEOUT_DEFAULT = 90;

/**
 * 错误三段式（message / suggestion / recovery）的标准文本形态。
 *
 * Result.error 是一个字符串，三段式以可读文本承载：第一段说清发生了什么，
 * 第二段给模型一个**具体可执行的下一步**，第三段（可选）给替代路线。写法
 * 纪律与工具描述的 when_to_use/when_not_to_use 同源——错误信息是模型最
 * 信任的教学时刻，只有症状没有出路的错误会让它原地重试同一个动作。
 */
export function format_tool_error(message: string, suggestion = "", recovery = ""): string {
  const parts = [(message || "").trim()];
  if (suggestion.trim()) parts.push(`下一步: ${suggestion.trim()}`);
  if (recovery.trim()) parts.push(`替代路线: ${recovery.trim()}`);
  return parts.filter((p) => p).join("\n");
}

/** Consecutive infrastructure failures before a tool is withheld (2.5). */
export const TOOL_FAIL_THRESHOLD = 3;

/** How long a tripped tool stays withheld. */
export const TOOL_BREAKER_COOLDOWN_S = 60.0;

// ── execution-contract surfaces (activity_exec seam) ──────────────────────────

export interface ExecPlan {
  class: string;      // "loop" | "thread" | "subprocess"
  contract: string;   // cancellation contract token
  interruptible: boolean;
  ref: JsonDict | null;
  reason: string;
}

export interface ActivityExecModule {
  classify_execution(tool: ToolDef): ExecPlan;
  autonomous_goal_allows(tool: ToolDef, plan: ExecPlan): [boolean, string];
  run_sync_in_subprocess(
    fn_ref: JsonDict,
    args: JsonDict,
    context: JsonDict,
    opts: { timeout: number; call_id?: string; cwd?: string | null },
  ): Result | Promise<Result>;
  KILL_GRACE_SEC: number;
}

let _activityExec: ActivityExecModule | null = null;
export function bind_activity_exec(mod: ActivityExecModule | null): void {
  _activityExec = mod;
}
function activity_exec(): ActivityExecModule {
  if (_activityExec === null) {
    throw new Error(
      "ModuleNotFoundError: No module named 'activity_exec' (host seam not bound)");
  }
  return _activityExec;
}

export type ValidateArgsFn = (schema: JsonDict, args: JsonDict) => [JsonDict, string | null];
let _validateArgs: ValidateArgsFn | null = null;
export function bind_tool_validator(fn: ValidateArgsFn | null): void {
  _validateArgs = fn;
}
function validateArgs(schema: JsonDict, args: JsonDict): [JsonDict, string | null] {
  if (_validateArgs === null) {
    throw new Error(
      "ModuleNotFoundError: No module named 'tool_validator' (host seam not bound)");
  }
  return _validateArgs(schema, args);
}

// ── ToolDef ───────────────────────────────────────────────────────────────────

export interface ToolDefOptions {
  domain?: string;
  risk_level?: string;
  needs_confirmation?: boolean;
  group?: string;
  when_to_use?: string;
  when_not_to_use?: string;
  halts_turn?: boolean;
  execution_class?: string;
  requires_subprocess?: boolean;
  manages_own_killable_child?: boolean;
  autonomous_write_safe?: boolean;
  timeout_seconds?: number | null;
}

export class ToolDef {
  name: string;
  description: string;
  schema: JsonDict;
  execute: ToolExecuteFn;
  /** 空则回落到 `domain`；只影响「模型看得见什么」（tool_catalog）。 */
  domain: string;
  risk_level: string;
  needs_confirmation: boolean;
  group: string;
  when_to_use: string;
  when_not_to_use: string;
  /** 回合终止标记（ask_user）——答案由前端卡片送回来，不在工具里 await。 */
  halts_turn: boolean;
  // ── 执行契约（durable activity，语义见 activity_exec seam）──
  execution_class: string;
  requires_subprocess: boolean;
  manages_own_killable_child: boolean;
  autonomous_write_safe: boolean;
  /** 推导缓存（classify_execution 结果；dataclass 的 init=False 字段）。 */
  _exec_plan: ExecPlan | null;

  call_count: number;
  last_called: number;
  timeout_seconds: number | null;
  fail_streak: number;
  open_until: number;

  /** 能力分身元数据 */
  parallel_safe: boolean;
  latency_hint: string;
  output_schema: JsonDict | null;

  constructor(
    name: string,
    description: string,
    schema: JsonDict,
    execute: ToolExecuteFn,
    opts: ToolDefOptions = {},
  ) {
    this.name = name;
    this.description = description;
    this.schema = schema;
    this.execute = execute;
    this.domain = opts.domain ?? "general";
    this.risk_level = opts.risk_level ?? "low";
    this.needs_confirmation = opts.needs_confirmation ?? false;
    this.group = opts.group ?? "";
    this.when_to_use = opts.when_to_use ?? "";
    this.when_not_to_use = opts.when_not_to_use ?? "";
    this.halts_turn = opts.halts_turn ?? false;
    this.execution_class = opts.execution_class ?? "";
    this.requires_subprocess = opts.requires_subprocess ?? false;
    this.manages_own_killable_child = opts.manages_own_killable_child ?? false;
    this.autonomous_write_safe = opts.autonomous_write_safe ?? false;
    this._exec_plan = null;
    this.call_count = 0;
    this.last_called = 0.0;
    this.timeout_seconds = opts.timeout_seconds ?? null;
    this.fail_streak = 0;
    this.open_until = 0.0;
    this.parallel_safe = true;
    this.latency_hint = "fast";
    this.output_schema = null;
  }

  /**
   * 发给模型的完整描述：一行摘要 + 用/不用两段（第四章）。
   *
   * 和 `description` 分开的意义是方向不同：`description` 面向**检索**
   * （关键词打分、tool_search），要短要密；这个面向**选择**（模型在 20 个
   * 工具里挑一个），要把边界说清楚。没填两段的工具原样返回。
   */
  llm_description(): string {
    const parts = [this.description || ""];
    if (this.when_to_use) parts.push(`When to use: ${this.when_to_use}`);
    if (this.when_not_to_use) parts.push(`When NOT to use: ${this.when_not_to_use}`);
    return parts.filter((p) => p).join("\n");
  }

  to_llm_schema(): JsonDict {
    return { name: this.name, description: this.llm_description(), inputSchema: this.schema };
  }
}

// ── internal dispatch error sentinels ────────────────────────────────────────

class DispatchTimeout extends Error {
  constructor() {
    super("wait_for timed out");
    this.name = "DispatchTimeout";
  }
}
function isCancelledError(e: unknown): boolean {
  return e instanceof Error && e.name === "CancelledError";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new DispatchTimeout()), ms);
    p.then(resolve, reject);
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ── ToolRegistry ──────────────────────────────────────────────────────────────

export class ToolRegistry {
  private _tools: Map<string, ToolDef>;
  private _execution_history: unknown[];

  constructor() {
    this._tools = new Map();
    this._execution_history = [];
  }

  register(tool: ToolDef): void {
    this._tools.set(tool.name, tool);
  }
  get(name: string): ToolDef | undefined {
    return this._tools.get(name);
  }
  list_tools(domain?: string | null): ToolDef[] {
    if (pyTruth(domain)) {
      return [...this._tools.values()].filter((t) => t.domain === domain);
    }
    return [...this._tools.values()];
  }
  to_llm_schemas(domain?: string | null): JsonDict[] {
    return this.list_tools(domain).map((t) => t.to_llm_schema());
  }

  /**
   * Return tools formatted for OpenAI/Chat-Completions ``tools`` param.
   *
   * Args:
   *     domain: Restrict to a single sub-agent domain (file/computer/…).
   *     exclude: Iterable of tool names to omit — used to hide risky
   *         tools from remote (bot) sessions.
   */
  to_openai_tools(
    domain?: string | null,
    exclude?: Iterable<string> | null,
  ): JsonDict[] {
    const ex = new Set(exclude ?? []);
    const specs: JsonDict[] = [];
    for (const tool of this.list_tools(domain)) {
      if (ex.has(tool.name)) continue;
      specs.push({
        type: "function",
        function: {
          name: tool.name,
          // 三段式描述（第四章）。这里用 llm_description 而不是
          // description：目录是模型**做选择**的地方，边界要说清楚。
          // 涨的 token 由 tool_catalog 的裁剪抵掉 —— 两件事必须一起
          // 做，只写厚描述不裁剪就是在 60 个工具上做加法。
          description: tool.llm_description(),
          parameters: pyTruth(tool.schema) ? tool.schema : { type: "object", properties: {} },
        },
      });
    }
    return specs;
  }

  /** Seconds this tool is allowed to run before the dispatch gives up. */
  timeout_for(tool: ToolDef): number {
    if (pyTruth(tool.timeout_seconds)) return pyInt(tool.timeout_seconds as number);
    return dictGet(TOOL_TIMEOUT_BY_DOMAIN, tool.domain, TOOL_TIMEOUT_DEFAULT) as number;
  }

  // ------------------------------------------------------------------
  // Circuit breaker (2.5)
  //
  // The problem it solves: every failure used to be handled the same way —
  // hand the error text back to the model and let it decide. For a wrong
  // argument that is exactly right. For a tool that is actually down (a dead
  // MCP server, a command that times out every time) it means a goal worker
  // retries the same dead call until its iteration budget is gone, and never
  // gets a nudge to try another route.
  // ------------------------------------------------------------------

  /**
   * Record one outcome against a tool's health.
   *
   * Only INFRASTRUCTURE failures count — a timeout or a raised exception,
   * i.e. "the tool did not get to answer". A tool that answered "old_string
   * not found" or "file does not exist" is working perfectly; it is the call
   * that was wrong. Counting those would withhold `edit_file` after three
   * near-misses, which is a far worse bug than the one being fixed.
   */
  breaker_note(tool: ToolDef, ok: boolean, infrastructure = false): void {
    if (ok) {
      tool.fail_streak = 0;
      tool.open_until = 0.0;
      return;
    }
    if (!infrastructure) return;
    tool.fail_streak += 1;
    if (tool.fail_streak >= TOOL_FAIL_THRESHOLD) {
      tool.open_until = timeNow() + TOOL_BREAKER_COOLDOWN_S;
    }
  }

  /**
   * The message to return instead of calling a withheld tool, or null.
   *
   * Also closes the breaker once the cooldown has passed, so recovery needs
   * no timer: the next call after the window simply goes through, and a
   * success resets the streak.
   */
  breaker_block(tool: ToolDef): string | null {
    if (!tool.open_until) return null;
    const left = tool.open_until - timeNow();
    if (left <= 0) {
      // Half-open: let one call through. It either succeeds (streak reset)
      // or fails again and re-arms the cooldown.
      tool.open_until = 0.0;
      return null;
    }
    const alternatives = [...this._tools.values()]
      .filter((t) => t.domain === tool.domain && t.name !== tool.name && !t.open_until)
      .slice(0, 4)
      .map((t) => t.name);
    const hint = alternatives.length
      ? `同类可用的工具：${alternatives.join("、")}`
      : "这一类没有其他可用工具了";
    return (
      `工具 \`${tool.name}\` 连续 ${tool.fail_streak} 次没能执行完（超时或崩溃），` +
      `已暂停 ${pyInt(left)} 秒，这次调用没有真的发出去。` +
      `不要原样重试——换一条路达成同一个目的，或者告诉用户这一步做不了。${hint}。`
    );
  }

  /** Per-tool health, for diagnostics. Cheap enough to call on demand. */
  health_snapshot(): JsonDict[] {
    const now = timeNow();
    return [...this._tools.values()]
      .filter((t) => pyTruth(t.fail_streak) || pyTruth(t.open_until))
      .map((t) => ({
        name: t.name, domain: t.domain, calls: t.call_count,
        failStreak: t.fail_streak,
        openForSeconds: pyTruth(t.open_until)
          ? Math.max(0, pyInt(t.open_until - now)) : 0,
      }));
  }

  /**
   * Derive (once per tool) the real execution class + cancel contract.
   *
   * The plan is what Pause, the scheduler and the UI quote when they tell
   * a user whether "stop" means stop. Cached on the ToolDef because the
   * inputs — coroutine-ness and module resolution — never change at runtime.
   */
  execution_plan(tool: ToolDef): ExecPlan {
    if (tool._exec_plan === null) {
      tool._exec_plan = activity_exec().classify_execution(tool);
    }
    return tool._exec_plan;
  }

  /** Per-tool contract summary for honest UI / diagnostics. */
  execution_contracts(): JsonDict[] {
    return [...this._tools.values()].map((t) => {
      const plan = this.execution_plan(t);
      return {
        name: t.name,
        domain: t.domain,
        riskLevel: t.risk_level,
        executionClass: plan.class,
        cancellationContract: plan.contract,
        interruptible: Boolean(plan.interruptible),
      };
    });
  }

  /**
   * Run one tool under its execution contract, returning a Result.
   *
   * Why the timeout lives here: this is the single chokepoint every tool call
   * passes through, so one guard covers the builtin tools, the MCP-injected
   * ones, and anything a skill registers later. Without it a tool that never
   * returns — a hung subprocess, an un-timeouted HTTP call, an os.walk over a
   * network mount — freezes the entire turn.
   *
   * Three execution classes come through here:
   *
   * * ``loop`` — native coroutines. Cancelling the awaitable really stops them.
   * * ``thread`` — sync callables on a worker thread. The timeout cancels only
   *   our WAIT — Python cannot interrupt a running thread, so the orphan runs
   *   on. That is exactly why the contract field exists.
   * * ``subprocess`` — sync callables executed in a fresh interpreter via
   *   activity_exec; the parent owns the process tree, so timeout/cancel KILLS
   *   it. A killed child's effects settle as ``unknown`` in the ledger rather
   *   than ``failed``, because dead ≠ didn't happen.
   */
  async dispatch(
    name: string,
    args: JsonDict,
    context: JsonDict = {},
  ): Promise<Result> {
    context = context ?? {};
    // Latent source quirk: this audit record is built and never appended —
    // _execution_history stays empty. Kept bug-for-bug.
    const audit: JsonDict = { tool: name, args: args, ts: timeNow() };
    void audit;
    const tool = this._tools.get(name);
    if (!tool) {
      return Result.failure(`Tool not found: ${name}`);
    }
    const [validated, validationError] = validateArgs(tool.schema, args);
    if (validationError) {
      return Result.failure(`Validation failed: ${validationError}`);
    }
    if (pyTruth(dictGet(context, "blocked"))) {
      return Result.failure(dictGet(context, "block_reason", "Blocked") as string);
    }
    // 2.5: a tool that has been failing to even run is withheld for a while.
    // Checked here rather than in the router so it covers sub-agents and
    // MCP-injected tools too — same reason the timeout lives here.
    const withheld = this.breaker_block(tool);
    if (withheld !== null) {
      return Result.failure(withheld, { code: "ToolCircuitOpen" });
    }

    const plan = this.execution_plan(tool);
    // Autonomous-goal guard: a non-interruptible write has no place in an
    // unattended goal — Pause cannot promise it stops, so the goal would
    // keep writing files after its worker is gone. Interactive sessions
    // keep full access: the user is present and can see a stuck call.
    if (pyTruth(dictGet(context, "goal_id")) && !plan.interruptible) {
      const [allowed, why] = activity_exec().autonomous_goal_allows(tool, plan);
      if (!allowed) {
        return Result.failure(why);
      }
    }

    tool.call_count += 1;
    tool.last_called = timeNow();
    const budget = this.timeout_for(tool);
    const execute = tool.execute;
    // Publish the call id to everything spawned underneath. Internal spawn
    // points (guarded_spawn, native_run, the git helpers) never took a
    // call_id parameter, so their children were unreachable by cancel_call:
    // Stop killed the shell tool and left those running. This is the seam —
    // one binding here beats threading a parameter through every helper.
    const callId = pyStrOr(dictGet(context, "call_id"), "");
    const result = await executors.callScope(callId, async () => {
      try {
        if (plan.class === "subprocess") {
          // Killable boundary: blocking communicate() runs in a helper
          // thread while the REAL work happens in a child process whose
          // tree we can terminate. The internal timer kills at `budget`;
          // this wait_for is only a backstop against the runner itself
          // wedging past budget + kill grace.
          const ae = activity_exec();
          const cwdRaw = pyStrOr(dictGet(context, "workspace_root"), "");
          const p = Promise.resolve(
            ae.run_sync_in_subprocess(
              plan.ref as JsonDict, validated, context,
              { timeout: budget, call_id: callId, cwd: pyTruth(cwdRaw) ? cwdRaw : null },
            ),
          );
          return await withTimeout(p, (budget + ae.KILL_GRACE_SEC) * 1000);
        } else if (isCoroutineFn(execute)) {
          // Native coroutine — the timeout cancels the awaitable directly.
          return await withTimeout(
            Promise.resolve(execute(validated, context)) as Promise<Result>,
            budget * 1000,
          );
        } else {
          // Sync callable — hand it to a worker thread so a blocking call
          // does not freeze the event loop. wait_for can only cancel our
          // WAIT — Python cannot interrupt a running thread — so the orphan
          // may run to completion in the background. We prefer a leaked
          // thread to a frozen session, and call_count is already bumped so
          // the leak is visible in the stats instead of silent.
          let outcome = await withTimeout(
            Promise.resolve(execute(validated, context)),
            budget * 1000,
          ) as unknown;
          // Defensive: a sync tool that returns a coroutine/awaitable
          // (e.g. ``return _async_helper()``) still needs awaiting.
          if (outcome !== null && typeof outcome === "object" &&
              typeof (outcome as { then?: unknown }).then === "function") {
            outcome = await withTimeout(
              Promise.resolve(outcome as Result), budget * 1000);
          }
          return outcome as Result;
        }
      } catch (e) {
        if (e instanceof DispatchTimeout) {
          // Phrased for the MODEL, not the log: it has to decide what to do
          // next, so say what failed, how long we waited, and that a retry is
          // unlikely to behave differently.
          this.breaker_note(tool, false, true);
          if (plan.class === "subprocess") {
            // The child was killed by now (internal timer); whatever it
            // managed to do before dying is nobody's guess.
            return Result.failure(
              `Tool '${name}' was killed after ${budget}s in its isolated ` +
              `process. It may have PARTIALLY completed — verify the ` +
              `actual state before retrying or doing anything similar.`,
              { effect_status: "unknown" },
            );
          }
          return Result.failure(
            `Tool '${name}' timed out after ${budget}s and was abandoned. ` +
            `The operation may still be running in the background. ` +
            `Do not retry it unchanged — either narrow the arguments ` +
            `(smaller path, tighter filter, lower limit) or take a ` +
            `different approach.`
          );
        }
        if (isCancelledError(e)) {
          // The turn itself was cancelled (user hit stop). Propagate so the
          // agent loop unwinds instead of treating it as a tool failure.
          // Deliberately NOT counted against the tool: the user stopping the
          // turn says nothing about the tool's health.
          throw e;
        }
        this.breaker_note(tool, false, true);
        return Result.failure(`Execution error: ${pyStrExc(e)}`);
      }
    });
    // A Result the tool chose to return — success or a domain-level "no" —
    // both mean the tool ran. Only `ok` resets the streak; a domain failure
    // leaves it untouched rather than counting toward the breaker.
    this.breaker_note(tool, Boolean(dictGet(result, "ok", false)));
    return result;
  }

  get_execution_history(limit = 50): unknown[] {
    return this._execution_history.slice(-limit);
  }
}

// ── module helpers ────────────────────────────────────────────────────────────

export function shorten_path(abs_path: string, ws_root?: string | null): string {
  if (pyTruth(ws_root)) {
    try {
      // Python os.path.relpath raises ValueError for cross-drive paths; Node
      // returns an absolute instead — treat that as the same failure.
      let rel = path.relative(ws_root as string, abs_path);
      // os.path.relpath(same, same) is "."; Node's path.relative is "".
      if (rel === "") {
        rel = ".";
      }
      if (!path.isAbsolute(rel) && !rel.startsWith("..")) {
        return rel.replaceAll(path.sep, "/");
      }
    } catch {
      // fail-open: 可选增强，失败不影响主流程
    }
  }
  const p = abs_path.replaceAll("\\", "/");
  const m = /^[A-Za-z]:\/Users\/[^/]+\/(.+)/.exec(p);
  if (m) {
    return "~/" + m[1];
  }
  return p.replace(/\/Users\/[^/]+\//g, "/[USER]/");
}

/**
 * Head-Tail truncation: keep the first chunk + last chunk.
 *
 * For command outputs, the meaningful content is typically at the start
 * (invocation / arguments) and the end (error messages / exit codes). A naive
 * head-only cut loses exactly the information the model needs most.
 *
 * The ratio is ~60% head / ~40% tail — biased toward the head because many
 * outputs are "fine everywhere" and the head is more likely to contain the
 * leading context. The middle is replaced with a counter so the model knows
 * how much was elided.
 */
export function truncate(text: string, max_chars = 5000, suffix?: string | null): string {
  void suffix; // the source's `suffix` parameter is never read — kept as-is
  if (!pyTruth(text)) return "";
  // Code-point semantics: Python len() and slicing count characters, JS counts
  // UTF-16 units. Array.from keeps astral characters whole.
  const cps = Array.from(text);
  if (cps.length <= max_chars) return text;
  const head_budget = pyInt(max_chars * 0.6);
  const tail_budget = max_chars - head_budget;
  const omitted = cps.length - head_budget - tail_budget;
  const divider = `\n\n... [已省略中间 ${pyIntFmt(omitted)} 字符] ...\n\n`;
  return cps.slice(0, head_budget).join("") + divider +
    cps.slice(cps.length - tail_budget).join("");
}

function _load_gitignore(root: string): string[] {
  const patterns: string[] = [];
  const gi = path.join(root, ".gitignore");
  if (fs.existsSync(gi)) {
    try {
      const raw = fs.readFileSync(gi, { encoding: "utf8" });
      for (let line of raw.split(/\r\n|\r|\n/)) {
        line = line.trim();
        if (line && !line.startsWith("#")) patterns.push(line);
      }
    } catch {
      // fail-open: 可选增强，失败不影响主流程
    }
  }
  patterns.push(".git", "__pycache__", "node_modules", ".venv", "*.pyc");
  return patterns;
}

function _is_ignored(p: string, patterns: string[]): boolean {
  const bn = path.basename(p);
  for (const pat of patterns) {
    if (pyFnmatch(bn, pat) || p.replaceAll("\\", "/").endsWith(pat)) return true;
  }
  return false;
}

/**
 * os.walk (top-down, followlinks=False) with the caller's `dirs[:] = ...`
 * prune honoured: the returned dirs array is the one the recursion iterates,
 * so replacing its contents in place changes what gets descended into —
 * exactly like the source.
 */
function* pyWalk(top: string): Generator<[string, string[], string[]]> {
  let names: string[];
  try {
    names = fs.readdirSync(top);
  } catch {
    return; // os.walk swallows scandir errors (onerror=None)
  }
  const dirs: string[] = [];
  const files: string[] = [];
  for (const n of names) {
    try {
      if (fs.statSync(path.join(top, n)).isDirectory()) dirs.push(n);
      else files.push(n);
    } catch {
      files.push(n); // unreadable entries land in files like os.walk's fallback
    }
  }
  yield [top, dirs, files];
  for (const d of dirs) {
    yield* pyWalk(path.join(top, d));
  }
}

function pyListAssign(target: string[], source: string[]): void {
  target.length = 0;
  for (const s of source) target.push(s);
}

/** Python text-mode iteration: universal newlines, terminators kept. */
function pyIterLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") { out.push(text.slice(start, i + 1)); start = i + 1; }
    else if (c === "\r") {
      if (text[i + 1] === "\n") { out.push(text.slice(start, i + 2)); i++; }
      else { out.push(text.slice(start, i + 1)); }
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** str.rstrip() over the Python whitespace set (includes \x0b \x0c \x85 \xa0). */
function pyRstrip(s: string): string {
  return s.replace(
    /[\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/u,
    "");
}

function _search_code_impl(args: JsonDict, ctx: JsonDict): Result {
  const pattern = dictGet(args, "pattern", "") as string;
  const searchPath = dictGet(args, "path", ".") as string;
  const globF = dictGet(args, "glob") as string | null;
  const ic = dictGet(args, "ignore_case", false);
  const limit = dictGet(args, "limit", 100);
  if (!pyTruth(pattern)) {
    return Result.failure("pattern required");
  }
  let rx: RegExp;
  try {
    rx = new RegExp(pattern, pyTruth(ic) ? "i" : "");
  } catch (e) {
    return Result.failure(`Invalid regex: ${pyStrExc(e)}`);
  }
  const ig = _load_gitignore(searchPath);
  const res: string[] = [];
  let cnt = 0;
  const prune = new Set([".git", "__pycache__", "node_modules", ".venv"]);
  for (const [root, dirs, files] of pyWalk(searchPath)) {
    pyListAssign(dirs, dirs.filter(
      (d) => !_is_ignored(path.join(root, d), ig) && !prune.has(d)));
    for (const fn of files) {
      if (_is_ignored(path.join(root, fn), ig)) continue;
      if (pyTruth(globF) && !pyFnmatch(fn, globF as string)) continue;
      const fp = path.join(root, fn);
      let text: string;
      try {
        text = fs.readFileSync(fp, { encoding: "utf8" });
      } catch {
        // Python: except (OSError, UnicodeDecodeError): continue — only the
        // open/read is catchable; the cnt>=limit TypeError below escapes.
        // (UnicodeDecodeError cannot occur: Node utf8 replaces bad bytes —
        // documented divergence, see header.)
        continue;
      }
      let ln = 0;
      for (const line of pyIterLines(text)) {
        ln += 1;
        if (rx.test(line)) {
          res.push(
            `${shorten_path(fp, dictGet(ctx, "workspace_root", searchPath) as string)}:${ln}: ${pyRstrip(line)}`);
          cnt += 1;
          if (pyGe(cnt, limit)) {
            return Result.success(res.join("\n"));
          }
        }
      }
    }
  }
  return Result.success(res.length ? res.join("\n") : "No matches found.");
}

function _find_files_impl(args: JsonDict, ctx: JsonDict): Result {
  const pat = dictGet(args, "pattern", "*") as string;
  const searchPath = dictGet(args, "path", ".") as string;
  const limit = dictGet(args, "limit", 100);
  const ig = _load_gitignore(searchPath);
  const res: string[] = [];
  let cnt = 0;
  const prune = new Set([".git", "__pycache__", "node_modules", ".venv"]);
  outer: for (const [root, dirs, files] of pyWalk(searchPath)) {
    pyListAssign(dirs, dirs.filter(
      (d) => !_is_ignored(path.join(root, d), ig) && !prune.has(d)));
    for (const fn of files) {
      if (!_is_ignored(path.join(root, fn), ig) && pyFnmatch(fn, pat)) {
        res.push(shorten_path(path.join(root, fn), dictGet(ctx, "workspace_root", searchPath) as string));
        cnt += 1;
        if (pyGe(cnt, limit)) break;
      }
    }
    if (pyGe(cnt, limit)) break outer;
  }
  return Result.success(res.length ? res.join("\n") : "No files found.");
}

function _list_dir_impl(args: JsonDict, ctx: JsonDict): Result {
  const dirPath = dictGet(args, "path", ".") as string;
  const limit = dictGet(args, "limit", 200);
  let isDir = false;
  try { isDir = fs.statSync(dirPath).isDirectory(); } catch { isDir = false; }
  if (!isDir) {
    return Result.failure(`Not a directory: ${dirPath}`);
  }
  const ws = dictGet(ctx, "workspace_root", dirPath);
  const entries: string[] = [];
  let cnt = 0;
  const names = fs.readdirSync(dirPath).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const item of names) {
    if (item.startsWith(".") && item !== "." && item !== "..") continue;
    const full = path.join(dirPath, item);
    let subIsDir = false;
    try { subIsDir = fs.statSync(full).isDirectory(); } catch { subIsDir = false; }
    entries.push(subIsDir ? item + "/" : item);
    cnt += 1;
    if (pyGe(cnt, limit)) {
      entries.push(`... [${limit}]`);
      break;
    }
  }
  return Result.success(`${shorten_path(dirPath, ws as string)}\n` + entries.join("\n"));
}

function _code_references_impl(args: JsonDict, ctx: JsonDict): Result {
  return execute_code_references_tool(args, ctx);
}

function create_builtin_tools(): ToolDef[] {
  // The source imports ToolDef inside the factory to dodge the cycle; the TS
  // seam in ask_user.ts needs the concrete class before create_ask_user_tool.
  bind_tools_module({ ToolDef: ToolDef as unknown as ToolsModuleCtor });
  return [
    new ToolDef("code_references", "Find callers, definitions, and references of a symbol using the Code Knowledge Graph (AST).",
      { type: "object", properties: {
        symbol: { type: "string", description: "The function, class, or method name to look up." },
        include_callers: { type: "boolean", default: true, description: "Include caller functions and lines." },
        depth: { type: "integer", default: 1, description: "Graph neighborhood traversal depth (1 or 2)." } },
        required: ["symbol"] },
      _code_references_impl, { domain: "file", risk_level: "low",
        when_to_use: "You want to find all call sites, usages, or callers of a specific function or class.",
        when_not_to_use: "Looking for generic text or comments inside files — use `search_code`." }),
    new ToolDef("search_code", "Search file CONTENTS with a regex. Respects .gitignore.",
      { type: "object", properties: {
        pattern: { type: "string", description: "Python regex matched against each line's content. NOT a filename glob." },
        path: { type: "string", default: ".", description: "Directory to search under." },
        glob: { type: "string", description: "Only search files whose name matches this glob, e.g. '*.py'." },
        ignore_case: { type: "boolean", default: false },
        limit: { type: "integer", default: 100, description: "Max matching lines returned; results are truncated, not ranked." } },
        required: ["pattern"] },
      _search_code_impl, { domain: "file", risk_level: "low",
        when_to_use: "You know WHAT the code says but not WHERE it lives — a function " +
                     "name, an error string, a config key.",
        when_not_to_use: "You know the file's name or extension but not its contents — " +
                         "use `find_files`. To read one known file, use `read_text`." }),
    new ToolDef("find_files", "Find files by NAME using a glob pattern.",
      { type: "object", properties: {
        pattern: { type: "string", default: "*", description: "Filename glob such as '*.py' or 'test_*'. NOT a regex, and it is matched against the file NAME, not its contents." },
        path: { type: "string", default: ".", description: "Directory to search under." },
        limit: { type: "integer", default: 100 } },
        required: [] },
      _find_files_impl, { domain: "file", risk_level: "low",
        when_to_use: "You know something about the file's name or extension and want " +
                     "to locate it, or want an inventory of one file type.",
        when_not_to_use: "You are looking for a string INSIDE files — use `search_code`. " +
                         "To see one directory's immediate children, use `list_dir`." }),
    new ToolDef("list_dir", "List one directory's immediate entries. Dirs get trailing /.",
      { type: "object", properties: {
        path: { type: "string", default: ".", description: "The single directory to list. Not recursive." },
        limit: { type: "integer", default: 200 } },
        required: [] },
      _list_dir_impl, { domain: "file", risk_level: "low",
        when_to_use: "Orienting yourself in an unfamiliar directory — one level, " +
                     "cheap, shows what is actually there.",
        when_not_to_use: "You need to search recursively or match a pattern — use " +
                         "`find_files`. Hidden dot-entries are skipped, so do not use " +
                         "this to check for `.env` / `.git`." }),

    create_ask_user_tool() as ToolDef,
    new ToolDef(
      "tool_search",
      "Search available tools and capabilities by task description or semantic query.",
      {
        type: "object",
        properties: {
          query: { type: "string", description: "Semantic query or task intent to search matching tools." },
          limit: { type: "integer", default: 5, description: "Maximum number of tools to return." },
        },
        required: ["query"],
      },
      _tool_search_impl as ToolExecuteFn,
      { domain: "general", risk_level: "low",
        when_to_use: "When looking for specialized or domain tools when the catalog is large." },
    ),
    new ToolDef(
      "ask_user_question",
      "Prompt the user with a structured multi-choice decision modal card in the UI.",
      {
        type: "object",
        properties: {
          title: { type: "string", description: "The question title or decision prompt." },
          description: { type: "string", description: "Detailed explanation of the options and trade-offs." },
          options: {
            type: "array",
            items: { type: "object" },
            description: "List of options with 'id', 'label', 'is_recommended', 'description'.",
          },
          allow_multiple: { type: "boolean", default: false },
        },
        required: ["title", "options"],
      },
      _ask_user_question_impl as ToolExecuteFn,
      { domain: "general", risk_level: "low",
        when_to_use: "When facing multiple valid architectural trade-offs requiring explicit user choice." },
    ),
    new ToolDef(
      "chrome_devtools",
      "Bridge to Chrome DevTools Protocol (CDP) to capture console errors and network failures.",
      {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "summary",
              "tabs",
              "screencast_start",
              "screencast_stop",
              "screencast_status",
            ],
            default: "summary",
            description: "Diagnostic action to run on Chrome.",
          },
          tab_id: {
            type: "string",
            description: "Target tab id for screencast_start; defaults to the first CDP page tab.",
          },
          output_dir: {
            type: "string",
            description: "Directory to persist captured screencast frames for screencast_start.",
          },
        },
        required: [],
      },
      _chrome_devtools_impl as ToolExecuteFn,
      { domain: "browser", risk_level: "low",
        when_to_use: "When diagnosing frontend errors, console tracebacks, or broken API requests." },
    ),
    new ToolDef(
      "lsp_navigate",
      "Precise code navigation and symbol lookup (definition & references).",
      {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Function, class, or variable symbol name to lookup." },
          action: { type: "string", enum: ["definition", "references"], default: "definition" },
          workspace: { type: "string", default: ".", description: "Workspace root directory." },
        },
        required: ["symbol"],
      },
      _lsp_navigate_impl as ToolExecuteFn,
      { domain: "file", risk_level: "low",
        when_to_use: "When tracing exact function definitions or caller references across the codebase." },
    ),
    new ToolDef(
      "workflow_record_start",
      "Start recording subsequent agent CUA/browser/tool actions into a repeatable workflow.",
      {
        type: "object",
        properties: {
          name: { type: "string", description: "Human-readable name of the workflow." },
          description: { type: "string", description: "Optional workflow description." },
        },
        required: ["name"],
      },
      _workflow_record_start_impl as ToolExecuteFn,
      { domain: "app", risk_level: "low",
        when_to_use: "When beginning a multi-step repetitive operation you want to capture and replay later." },
    ),
    new ToolDef(
      "workflow_record_stop",
      "Stop recording the active workflow and persist it to disk.",
      {
        type: "object",
        properties: {
          save: { type: "boolean", default: true, description: "Whether to persist recorded workflow to disk." },
        },
        required: [],
      },
      _workflow_record_stop_impl as ToolExecuteFn,
      { domain: "app", risk_level: "low",
        when_to_use: "When finished executing the sequence of actions you intended to record." },
    ),
    new ToolDef(
      "workflow_replay",
      "Deterministically replay a recorded workflow with bare modifier safety and drift circuit breaker.",
      {
        type: "object",
        properties: {
          workflow_id: { type: "string", description: "ID of the saved workflow to replay." },
          stop_on_drift: { type: "boolean", default: true, description: "Whether to halt immediately if UI target/state drifts." },
        },
        required: ["workflow_id"],
      },
      _workflow_replay_impl as ToolExecuteFn,
      { domain: "app", risk_level: "medium",
        when_to_use: "When executing an existing captured workflow asset." },
    ),
    new ToolDef(
      "workflow_list",
      "List all recorded and available workflows.",
      {
        type: "object",
        properties: {},
        required: [],
      },
      _workflow_list_impl as ToolExecuteFn,
      { domain: "app", risk_level: "low",
        when_to_use: "When checking what workflows have been recorded and are available for replay." },
    ),
    new ToolDef(
      "evolution_undo",
      "Undo the most recently accepted self-evolution rule or revert a specific proposal, restoring the target file from pre-change backup.",
      {
        type: "object",
        properties: {
          proposal_id: {
            type: "string",
            description: "Optional proposal ID to revert. If omitted, reverts the most recent proposal change.",
          },
        },
        required: [],
      },
      _evolution_undo_impl as ToolExecuteFn,
      { domain: "system", risk_level: "medium",
        when_to_use: "When an accepted evolution rule needs to be reverted or caused unexpected behavior.",
        when_not_to_use: "Do not use for rolling back normal workspace source code files." },
    ),
    new ToolDef(
      "workflow_schedule_create",
      "Create a recurring cron schedule for an executable or promoted workflow.",
      {
        type: "object",
        properties: {
          workflow_id: {
            type: "string",
            description: "ID of the saved workflow to schedule.",
          },
          cron_expr: {
            type: "string",
            description: "Standard 5-field cron expression (e.g. '0 9 * * 1-5' or '*/15 * * * *') or macro (e.g. '@daily').",
          },
          session_id: {
            type: "string",
            description: "Optional session ID context for the scheduled execution.",
            default: "",
          },
        },
        required: ["workflow_id", "cron_expr"],
      },
      _workflow_schedule_create_impl as ToolExecuteFn,
      { domain: "app", risk_level: "medium",
        when_to_use: "When scheduling an automated, recurring execution of a recorded workflow." },
    ),
    new ToolDef(
      "workflow_schedule_list",
      "List all scheduled workflow jobs and their execution status.",
      {
        type: "object",
        properties: {
          enabled_only: {
            type: "boolean",
            description: "Filter to only active/enabled schedules.",
            default: false,
          },
        },
        required: [],
      },
      _workflow_schedule_list_impl as ToolExecuteFn,
      { domain: "app", risk_level: "low",
        when_to_use: "When inspecting active or configured workflow schedules." },
    ),
    new ToolDef(
      "workflow_schedule_delete",
      "Cancel and remove a scheduled workflow job by its schedule ID.",
      {
        type: "object",
        properties: {
          schedule_id: {
            type: "string",
            description: "ID of the schedule to remove.",
          },
        },
        required: ["schedule_id"],
      },
      _workflow_schedule_delete_impl as ToolExecuteFn,
      { domain: "app", risk_level: "medium",
        when_to_use: "When deleting or cancelling an automated workflow schedule." },
    ),
  ];
}

/** ask_user.ts's seam shape (structural; only the ctor is consumed). */
type ToolsModuleCtor = new (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  impl: (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown,
  kwargs: Record<string, unknown>,
) => unknown;

/**
 * 注意源签名是 (query, limit=5, **kwargs)，而 dispatch 以两个位置实参调用：
 * query 收到整个 validated dict、limit 收到 context dict —— 潜在源码怪癖，
 * 逐字保留（直接调用方按 kwargs 用则是正常路径）。
 */
function _tool_search_impl(...callArgs: unknown[]): Result {
  pyBindPos("_tool_search_impl", 1, 1, callArgs.length);
  const query = callArgs.length > 0 ? callArgs[0] : undefined;
  const limit = callArgs.length > 1 ? callArgs[1] : 5;
  const res = tool_search_handler(query as string, limit as number);
  const matches = dictGet(res, "matches", []);
  const revealed: unknown[] = [];
  for (const m of (Array.isArray(matches) ? matches : [])) {
    if (isPyDict(m) && "name" in (m as JsonDict)) revealed.push((m as JsonDict)["name"]);
  }
  return Result.success(res, { revealed_tools: revealed });
}

function _ask_user_question_impl(...callArgs: unknown[]): Result {
  pyBindPos("_ask_user_question_impl", 1, 3, callArgs.length);
  const title = callArgs.length > 0 ? callArgs[0] : undefined;
  const description = callArgs.length > 1 ? callArgs[1] : "";
  const options = callArgs.length > 2 ? callArgs[2] : null;
  const allow_multiple = callArgs.length > 3 ? callArgs[3] : false;
  const reg = get_question_registry();
  const q = reg.create_question(
    title as string,
    description as string,
    (pyTruth(options) ? options : []) as Array<Record<string, unknown>>,
    allow_multiple as boolean,
  );
  return Result.success({
    status: "question_created",
    question_id: q.question_id,
    title: q.title,
    options: q.options.map((o) => o.label),
  });
}

// DIVERGENCE(port, async bridge): Python's chrome_devtools_handler is sync;
// the landed TS one is async, so this impl became async. See header for why
// observable dispatch behaviour is unchanged. The module is dynamically
// imported exactly where the source lazily does `from chrome_devtools import
// chrome_devtools_handler` (its sharp/cdp dependency chain must not link into
// every tools.ts consumer).
async function _chrome_devtools_impl(...callArgs: unknown[]): Promise<Result> {
  pyBindPos("_chrome_devtools_impl", 0, 1, callArgs.length);
  const action = callArgs.length > 0 ? callArgs[0] : "summary";
  // **kwargs: the source only receives keyword arguments on the direct-call
  // path; dispatch's second positional can never reach them (pyBindPos above
  // throws first for 2 args), so the passthrough set is empty here too.
  const kwargs: JsonDict = callArgs.length > 1 ? (callArgs[1] as JsonDict) : {};
  const passthrough: JsonDict = {};
  for (const k of ["tab_id", "output_dir", "fps", "quality", "max_width", "max_height"]) {
    if (k in kwargs) passthrough[k] = kwargs[k];
  }
  const { chrome_devtools_handler } = await import("./chrome_devtools.js");
  const res = await chrome_devtools_handler(action as string, passthrough);
  return Result.success(res);
}

function _lsp_navigate_impl(...callArgs: unknown[]): Result {
  pyBindPos("_lsp_navigate_impl", 1, 2, callArgs.length);
  const symbol = callArgs.length > 0 ? callArgs[0] : undefined;
  const action = callArgs.length > 1 ? callArgs[1] : "definition";
  const workspace = callArgs.length > 2 ? callArgs[2] : ".";
  const res = lsp_navigate_handler(symbol as string, action as string, workspace as string);
  return Result.success(res);
}

function _workflow_record_start_impl(...callArgs: unknown[]): Result {
  pyBindPos("_workflow_record_start_impl", 1, 1, callArgs.length);
  const name = callArgs.length > 0 ? callArgs[0] : undefined;
  const description = callArgs.length > 1 ? callArgs[1] : "";
  const rec = get_workflow_recorder();
  const wf_id = rec.start_recording("", name as string, "", description as string);
  return Result.success({ status: "recording_started", workflow_id: wf_id, name: name });
}

// DIVERGENCE(port, async bridge): none here — stop is sync on both sides;
// kept sync. The positional TypeError from dispatch fires first anyway.
function _workflow_record_stop_impl(...callArgs: unknown[]): Result {
  pyBindPos("_workflow_record_stop_impl", 0, 1, callArgs.length);
  const save = callArgs.length > 0 ? callArgs[0] : true;
  const rec = get_workflow_recorder();
  if (!rec.is_recording()) {
    return Result.failure("No active workflow recording session");
  }
  const wf = rec.stop_recording(save as boolean);
  if (!wf) {
    return Result.failure("Failed to seal workflow recording");
  }
  return Result.success({ status: "recording_stopped", workflow_id: wf.id, step_count: wf.steps.length });
}

// DIVERGENCE(port, async bridge): WorkflowReplayer.replay is async in TS
// (Python sync); awaiting it here is the only observable difference.
async function _workflow_replay_impl(...callArgs: unknown[]): Promise<Result> {
  pyBindPos("_workflow_replay_impl", 1, 1, callArgs.length);
  const workflow_id = callArgs.length > 0 ? callArgs[0] : undefined;
  const stop_on_drift = callArgs.length > 1 ? callArgs[1] : true;
  const wf = load_workflow(workflow_id as string);
  if (!wf) {
    return Result.failure(`Workflow \`${workflow_id}\` not found`);
  }
  const replayer = new WorkflowReplayer();
  try {
    replayer.set_metrics_tracker(new WorkflowMetricsTracker());
  } catch {
    // fail-open: 可选增强，失败不影响主流程
  }
  return await replayer.replay(wf, stop_on_drift as boolean);
}

function _workflow_list_impl(...callArgs: unknown[]): Result {
  pyBindPos("_workflow_list_impl", 0, 0, callArgs.length);
  const wfs = list_workflows();
  return Result.success({ workflows: wfs, count: wfs.length });
}

function _evolution_undo_impl(...callArgs: unknown[]): Result {
  pyBindPos("_evolution_undo_impl", 0, 1, callArgs.length);
  const proposal_id = callArgs.length > 0 ? callArgs[0] : "";
  const kwargs: JsonDict = callArgs.length > 1 ? (callArgs[1] as JsonDict) : {};
  const ws = pyStrOr(dictGet(kwargs, "workspace_root"), "") || process.cwd();
  const pid = pyTruth(proposal_id) ? (proposal_id as string) : null;
  return undo(ws, pid);
}

// DIVERGENCE(port, async bridge): scheduler.create_schedule is async in TS.
async function _workflow_schedule_create_impl(...callArgs: unknown[]): Promise<Result> {
  pyBindPos("_workflow_schedule_create_impl", 2, 1, callArgs.length);
  const workflow_id = callArgs.length > 0 ? callArgs[0] : undefined;
  const cron_expr = callArgs.length > 1 ? callArgs[1] : undefined;
  const session_id = callArgs.length > 2 ? callArgs[2] : "";
  const scheduler = get_workflow_scheduler();
  return await scheduler.create_schedule(
    workflow_id as string, cron_expr as string, session_id as string);
}

function _workflow_schedule_list_impl(...callArgs: unknown[]): Result {
  pyBindPos("_workflow_schedule_list_impl", 0, 1, callArgs.length);
  const enabled_only = callArgs.length > 0 ? callArgs[0] : false;
  const scheduler = get_workflow_scheduler();
  const schedules = scheduler.list_schedules(enabled_only as boolean);
  return Result.success({ schedules: schedules, count: schedules.length });
}

function _workflow_schedule_delete_impl(...callArgs: unknown[]): Result {
  pyBindPos("_workflow_schedule_delete_impl", 1, 0, callArgs.length);
  const schedule_id = callArgs.length > 0 ? callArgs[0] : undefined;
  const scheduler = get_workflow_scheduler();
  return scheduler.delete_schedule(schedule_id as string);
}

let _registry: ToolRegistry | null = null;
export function get_tool_registry(): ToolRegistry {
  if (_registry === null) {
    _registry = new ToolRegistry();
    for (const t of create_builtin_tools()) {
      _registry.register(t);
    }
  }
  return _registry;
}

// PORT STATUS: confidence=high todos=[0]
