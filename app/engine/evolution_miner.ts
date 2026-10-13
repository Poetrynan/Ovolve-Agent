/**
 * evolution_miner.ts — Background idle evolution miner and session finalizer.
 *
 * Ported from `app/backend/evolution_miner.py` (146 lines).
 *
 * Runs periodically to:
 * 1. Scan live sessions, skipping active/in-progress turns.
 * 2. Finalize inactive/idle sessions by flushing pre-compaction memories.
 * 3. Trigger workspace-level rule mining to synthesize accumulated signals
 *    into proposals.
 *
 * RULEBOOK CITATIONS
 *   §1  零依赖（turn_state 已移植 → 静态 import）。
 *   §2  asyncio.Task 循环 → setTimeout 链（引擎无 asyncio；run_loop 语义 =
 *       每 interval_s 执行 scan_once，可取消）；CancelledError → cleared
 *       timer 检查。session_host / turn_state.get_turn_state / evolution /
 *       router._flush_memory_for_fold 都是鸭子类型调用（hasattr 检查逐字
 *       保留为属性存在性检查）。
 *   §2  session_host / evolution（SPLIT，未移植）→ computed 动态 import，
 *       缺席时 host = None（源 ImportError → except 分支逐字等价）。
 *   §4  naming: evolution_miner.py → evolution_miner.ts
 *   §M  CPython 镜像单一来源：本文件不私造 py_ 副本，形参严格性/float()/
 *       str(exc) 全部走 `./server/http_server_keys.js`（py_float、py_or、
 *       exc_str、PyExcP、PyTypeErrorP）。
 *       · pyArity（本模块的调用签名守卫）镜像 CPython 的两种文案，逐字测得
 *         于 tmp/evolut_facts_py.json 的 arity 组：有默认值时
 *         `EvolutionMiner.__init__() takes from 1 to 5 positional arguments
 *         but 6 were given`，无默认值时 `is_enabled() takes 1 positional
 *         argument but 2 were given`；self 计入 "takes N"，绝不出现在
 *         missing 列表里；≥3 个缺失名用牛津逗号。
 *       · ValueErrorP：§M 异常族还没有 ValueError 子类（keys.ts 只有
 *         PyTypeErrorP/PyOSErrorP/…），这里只是**接上 §M 的 PyExcP 基类**补
 *         一个，不是复制 §M 的实现。keys.ts:303 的 py_float 早于 PyExcP，
 *         抛的是 message 里带 "ValueError: " 前缀的 TypeError，所以
 *         pyFloatOf 只把**类型标签**换回来（前缀剥掉），解析规则仍然只有
 *         §M 一份。CPython 证据：`float("abc")` →
 *         `ValueError: could not convert string to float: 'abc'`。
 *       · last_ts 用 py_or(...) 而不是 ??：CPython 的 `a or b or 0.0` 把
 *         0/"" 也当假值，JS 的 ?? 只认 null/undefined（DIVERGENCE 已消除）。
 *       · fail-open 的 error 字段用 exc_str(exc) == CPython str(exc)；
 *         JS 的 String(err) 会多出 "Error: " 前缀。
 *
 * PORT STATUS: confidence=high todos=0
 */

import { TurnStatus } from "./task_states.js";
import {
    PyExcP,
    PyTypeErrorP,
    exc_str,
    py_float,
    py_or,
} from "./server/http_server_keys.js";

/** §M 异常族的 ValueError 成员（message == CPython `str(exc)`，不带类名前缀）。 */
class ValueErrorP extends PyExcP {
  constructor(message: string) {
    super("ValueError", message);
  }
}

/** `float(x)` —— 解析规则交给 §M py_float，只把它旧式的前缀 TypeError 换回 ValueError 类型。 */
function pyFloatOf(v: unknown): number {
  try {
    return py_float(v);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m.startsWith("ValueError: ")) throw new ValueErrorP(m.slice("ValueError: ".length));
    throw e;
  }
}

function joinNames(names: readonly string[]): string {
  if (names.length === 1) return names[0] ?? "";
  if (names.length === 2) return (names[0] ?? "") + " and " + (names[1] ?? "");
  return names.slice(0, -1).join(", ") + ", and " + (names[names.length - 1] ?? "");
}

/**
 * CPython 的调用签名守卫。required 在前、optional（带默认值）在后，与源形参表同序；
 * selfCount 对方法传 1（CPython 把 self 算进 "takes N"，但绝不写进 missing 列表）。
 * 用 `arguments.length` 计数，端口自己的 TS 形参个数不参与（TS 会吞多余实参）。
 */
function pyArity(
  qualName: string,
  required: readonly string[],
  optional: readonly string[],
  selfCount: number,
  given: number
): void {
  const missing = required.slice(Math.max(0, given));
  if (missing.length > 0) {
    throw new PyTypeErrorP(
      `${qualName}() missing ${missing.length} required positional ` +
        `${missing.length === 1 ? "argument" : "arguments"}: ` +
        joinNames(missing.map((p) => `'${p}'`)),
    );
  }
  const min = selfCount + required.length;
  const max = min + optional.length;
  const got = selfCount + given;
  if (got > max) {
    const span = min === max
      ? `takes ${min} positional ${min === 1 ? "argument" : "arguments"}`
      : `takes from ${min} to ${max} positional arguments`;
    throw new PyTypeErrorP(`${qualName}() ${span} but ${got} ${got === 1 ? "was" : "were"} given`);
  }
}

/** 后台引擎扫描 idle sessions 并触发 workspace-level mining。 */
export class EvolutionMiner {
  session_host: unknown;
  workspace_root: string;
  idle_threshold_s: number;
  interval_s: number;
  _running = false;
  _timer: ReturnType<typeof setTimeout> | null = null;
  // session_id -> timestamp of last message finalized
  _finalized_sessions: Map<string, number>;

  constructor(opts?: {
    session_host?: unknown;
    interval_s?: number | null;
    idle_threshold_s?: number;
    workspace_root?: string | null;
  }) {
    pyArity("EvolutionMiner.__init__", [], ["session_host", "interval_s", "idle_threshold_s", "workspace_root"], 1, arguments.length);
    const {
      session_host = null,
      interval_s = null,
      idle_threshold_s = 300.0,
      workspace_root = null,
    } = opts ?? {};
    this.session_host = session_host;
    this.workspace_root = workspace_root || process.cwd();
    this.idle_threshold_s = idle_threshold_s;

    // Interval priority: explicit arg > env var > default 300s
    if (interval_s !== null && interval_s !== undefined) {
      this.interval_s = pyFloatOf(interval_s);
    } else {
      const env_val = process.env["OVOLVE_EVOLUTION_MINER_INTERVAL_S"];
      this.interval_s = env_val !== undefined ? pyFloatOf(env_val) : 300.0;
    }

    this._finalized_sessions = new Map();
  }

  is_enabled(): boolean {
    pyArity("EvolutionMiner.is_enabled", [], [], 1, arguments.length);
    return this.interval_s > 0;
  }

  /** Perform a single pass of idle session finalization and workspace mining. */
  async scan_once(): Promise<Record<string, unknown>> {
    pyArity("EvolutionMiner.scan_once", [], [], 1, arguments.length);
    if (!this.is_enabled()) {
      return { status: "disabled", ok: true };
    }

    const skipped_active: string[] = [];
    const finalized_idle: string[] = [];
    let proposals_made = 0;

    try {
      let host = this.session_host as Record<string, unknown> | null | undefined;
      if (host === null || host === undefined) {
        try {
          const spec = "./session_host" + ".js";
          const mod = (await import(/* @vite-ignore */ spec)) as unknown as {
            get_session_host?: () => unknown;
          };
          host = (mod.get_session_host ? mod.get_session_host() : null) as Record<string, unknown> | null;
        } catch {
          host = null;
        }
      }

      let session_ids: string[] = [];
      if (host !== null && host !== undefined && typeof host["list_sessions"] === "function") {
        session_ids = (host.list_sessions as () => string[])();
      }

      // turn_state 是未移植单元（TS 侧枚举等价物在 task_states.ts）；
      // get_turn_state 的运行时机器在 turn_state SPLIT 移植前缺席 →
      // state_machine = null（源 ImportError → except 分支逐字等价）。
      let state_machine: Record<string, unknown> | null = null;
      try {
        const spec = "./turn_state" + ".js";
        const mod = (await import(/* @vite-ignore */ spec)) as unknown as {
          get_turn_state?: () => unknown;
        };
        state_machine = (mod.get_turn_state ? mod.get_turn_state() : null) as Record<string, unknown> | null;
      } catch {
        state_machine = null;
      }

      const now = Date.now() / 1000;
      for (const sid of session_ids) {
        // Check active turn status
        if (state_machine && typeof state_machine["current"] === "function") {
          const current_status = (state_machine.current as (s: string) => unknown)(sid);
          // turn_state.py 的 TurnStatus（未移植 SPLIT）才有 WAITING_USER；
          // task_states.ts 的同名枚举是另一张表。字面量 "waiting_user" 与
          // turn_state.py:52 逐字一致。DIVERGENCE(port)：turn_state SPLIT 移植后
          // 改引其枚举（字面量 "waiting_user" 与该表值相同，行为已一致）。
          const WAITING_USER = "waiting_user";
          if (current_status === TurnStatus.RUNNING || current_status === WAITING_USER) {
            skipped_active.push(sid);
            continue;
          }
        }

        const router = host !== null && host !== undefined && typeof host["get"] === "function"
          ? ((host.get as (s: string) => unknown)(sid) as Record<string, unknown> | null)
          : null;
        if (!router) {
          continue;
        }

        // Query messages to assess idleness
        let msgs: Record<string, unknown>[] = [];
        if (router["storage"]) {
          try {
            const storage = router["storage"] as Record<string, unknown>;
            if (typeof storage["get_messages"] === "function") {
              msgs = ((storage.get_messages as (s: string, o: object) => unknown)(sid, { limit: 20 }) as Record<string, unknown>[]) || [];
            }
          } catch {
            msgs = [];
          }
        }

        if (msgs.length > 0) {
          const last_msg = msgs[msgs.length - 1]!;
          const last_ts = pyFloatOf(py_or(last_msg["timestamp"], py_or(last_msg["created_at"], 0.0)));
          if (now - last_ts >= this.idle_threshold_s) {
            const prev_finalized = this._finalized_sessions.get(sid) ?? 0.0;
            if (prev_finalized < last_ts) {
              if (typeof router["_flush_memory_for_fold"] === "function") {
                try {
                  await (router["_flush_memory_for_fold"] as (m: unknown) => Promise<void>)(msgs);
                } catch (flush_exc) {
                  console.log(`[evolution_miner] flush idle session ${sid} failed: ${exc_str(flush_exc)}`);
                }
              }
              this._finalized_sessions.set(sid, last_ts);
              finalized_idle.push(sid);
            }
          }
        }
      }

      // 2. Trigger workspace-level mining across shared signals database
      try {
        const spec = "./evolution" + ".js";
        const mod = (await import(/* @vite-ignore */ spec)) as unknown as {
          get_evolution_engine: (ws: string) => {
            enabled(): boolean;
            maybe_mine(): unknown[];
          } | null;
        };
        const engine = mod.get_evolution_engine(this.workspace_root);
        if (engine && engine.enabled()) {
          const made = engine.maybe_mine();
          proposals_made = Array.isArray(made) ? made.length : 0;
        }
      } catch (mine_exc) {
        console.log(`[evolution_miner] workspace mine failed (fail-open): ${exc_str(mine_exc)}`);
      }

      return {
        ok: true,
        skipped_active,
        finalized_idle,
        proposals_made,
      };
    } catch (exc) {
      // Absolute fail-open: background miner must never crash host process
      console.log(`[evolution_miner] scan_once error (fail-open): ${exc_str(exc)}`);
      return { ok: false, error: exc_str(exc) };
    }
  }

  /** Continuous polling loop（setTimeout 链替代 asyncio 循环）。 */
  async run_loop(): Promise<void> {
    pyArity("EvolutionMiner.run_loop", [], [], 1, arguments.length);
    this._running = true;
    while (this._running) {
      try {
        await this.scan_once();
      } catch (exc) {
        console.log(`[evolution_miner] run_loop cycle exception: ${exc_str(exc)}`);
      }
      // await asyncio.sleep(interval) with cancellation
      if (!this._running) {
        break;
      }
      const cancelled = await new Promise<boolean>((resolve) => {
        this._timer = setTimeout(() => resolve(false), this.interval_s * 1000);
      });
      if (cancelled || !this._running) {
        break;
      }
    }
  }

  /** Start the background miner task if enabled. */
  start(): boolean {
    pyArity("EvolutionMiner.start", [], ["loop"], 1, arguments.length);
    if (!this.is_enabled()) {
      return false;
    }
    if (this._running) {
      return true; // already running（源 _task.done() 检查的等价）
    }
    void this.run_loop();
    return true;
  }

  /** Stop background miner task. */
  stop(): void {
    pyArity("EvolutionMiner.stop", [], [], 1, arguments.length);
    this._running = false;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

let _miner: EvolutionMiner | null = null;

/** Process singleton accessor for EvolutionMiner. */
export function get_evolution_miner(
  session_host?: unknown,
  workspace_root?: string | null
): EvolutionMiner {
  pyArity("get_evolution_miner", [], ["session_host", "workspace_root"], 0, arguments.length);
  if (_miner === null) {
    _miner = new EvolutionMiner({
      session_host,
      workspace_root: workspace_root ?? null,
    });
  } else if (session_host && !_miner.session_host) {
    _miner.session_host = session_host;
  }
  return _miner;
}
