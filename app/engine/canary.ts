/**
 * canary.ts — 金丝雀门禁（Phase 11 收口切片）。
 *
 * Ported from `app/backend/canary.py` (99 lines).
 *
 * 总指令 §11(Phase 11)：改动先离线 replay，通过基线才可 canary；回归自动
 * 阻止。本模块把 eval_harness 的 golden 套件变成一道**门**：
 *
 *     import { canary_gate } from "./canary.js";
 *     const [allow, summary] = await canary_gate(storage);
 *     if (!allow) ...   // 回归未过，自动阻止进入下一阶段/发布
 *
 * 零 golden 基线时门是关着的（fail-closed）——没有基线就没有"没回归"可言。
 *
 * RULEBOOK CITATIONS
 *   §1  node:fs / node:path / node:os（临时隔离 store）。
 *   §2  `from eval_harness import GOLDEN_DIR, check_golden, list_golden,
 *       replay_golden` → 静态 import（本批次已移植）。
 *   §2  `from event_store import EventStore` → 静态 import（已移植）。
 *   §2  tempfile.mkdtemp(prefix="canary-") → fs.mkdtempSync(os.tmpdir()/canary-)。
 *   §2  canary_gate 返回 tuple[bool, dict] → [boolean, Record]。
 *   §4  naming: canary.py → canary.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  GOLDEN_DIR,
  check_golden,
  list_golden,
  replay_golden,
  type GoldenReport,
} from "./eval_harness.js";
import { EventStore } from "./event_store.js";

/** None → 内置基线目录的绝对路径。
 *
 * list_golden 返回的是裸文件名；调用方拿它拼路径时若不先解析目录，就会拼
 * 出相对 CWD 的路径——从仓库根跑 CI 时四条基线全部"找不到文件"，门禁虽然
 * fail-closed 但永远放不过任何发布。 */
function _resolve_dir(golden_dir?: string | null): string {
  return path.resolve(golden_dir || GOLDEN_DIR);
}

interface CanaryTask {
  task: string;
  chain_valid: boolean;
  replay_ok: boolean;
  events?: number;
  problems?: string[];
  harness_error?: string;
}

/** 跑全部 golden 基线。返回逐任务结果与汇总。 */
export function run_canary_suite(
  golden_dir?: string | null,
  storage?: unknown
): Record<string, unknown> {
  const d = _resolve_dir(golden_dir);
  const files = list_golden(d);
  const tasks: CanaryTask[] = [];
  for (const f of files) {
    const p = path.join(d, f);
    try {
      const report = check_golden(p, storage as Parameters<typeof check_golden>[1]);
      tasks.push({
        // §4 bug-for-bug fix: CPython str.replace replaces ALL occurrences; JS
        // String.replace(str,str) replaces only the FIRST. A baseline named
        // "x.golden.json.golden.json" must strip to "x" on both runtimes.
        // Evidence: tmp/canar_divergence_evidence.py -> tmp/canar_divergence.log.
        task: f.split(".golden.json").join(""),
        chain_valid: report.chain_valid,
        replay_ok: report.replay_ok,
        events: report.event_count,
        problems: report.problems,
      });
    } catch (e) {
      tasks.push({
        task: f,
        chain_valid: false,
        replay_ok: false,
        problems: [`harness error: ${e instanceof Error ? e.message : String(e)}`],
      });
    }
  }
  const passed = tasks.filter((t) => t.chain_valid && t.replay_ok).length;
  return {
    tasks: tasks.length,
    passed,
    failed: tasks.filter((t) => !(t.chain_valid && t.replay_ok)).map((t) => t.task),
    results: tasks,
  };
}

/** 门禁：全绿（或达到比例）才放行。
 *
 * fail-closed 语义：
 * - 没有任何基线 → 不放行（"没有证据"不等于"没有回归"）；
 * - 任一基线链校验失败或回放漂移 → 不放行。 */
export function canary_gate(
  storage: unknown,
  opts?: { golden_dir?: string | null; min_pass_ratio?: number }
): [boolean, Record<string, unknown>] {
  const { golden_dir = null, min_pass_ratio = 1.0 } = opts ?? {};
  const suite = run_canary_suite(golden_dir, storage) as Record<string, unknown>;
  if (Number(suite["tasks"]) === 0) {
    return [false, { ...suite, reason: "no golden baselines —— 门禁 fail-closed" }];
  }
  const ratio = Number(suite["passed"]) / Number(suite["tasks"]);
  const allow = ratio >= min_pass_ratio;
  const failedCount = Array.isArray(suite["failed"]) ? (suite["failed"] as string[]).length : 0;
  const summary = {
    ...suite,
    pass_ratio: Math.round(ratio * 1000) / 1000,
    reason: allow ? "" : `canary 未达标：${failedCount} 条基线漂移/损坏`,
  };
  return [allow, summary];
}

/** **回放式**门禁：不依赖运行实例——把每条基线重放进隔离临时 store。
 *
 * CI / 发布流水线友好：机器上无需真实用户数据库。fail-closed 语义同上。 */
export function canary_replay_gate(
  opts?: { golden_dir?: string | null; min_pass_ratio?: number }
): [boolean, Record<string, unknown>] {
  const { golden_dir = null, min_pass_ratio = 1.0 } = opts ?? {};

  const d = _resolve_dir(golden_dir);
  const files = list_golden(d);
  if (files.length === 0) {
    return [
      false,
      {
        tasks: 0,
        passed: 0,
        failed: [],
        reason: "no golden baselines —— 门禁 fail-closed",
      },
    ];
  }
  const results: Record<string, unknown>[] = [];
  const failed: string[] = [];
  for (const f of files) {
    const p = path.join(d, f);
    const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "canary-")), "events.db");
    const store = new EventStore(db);
    let ok = false;
    let report: GoldenReport | null = null;
    try {
      report = replay_golden(p, store);
      ok = report.replay_ok && report.chain_valid;
    } catch (e) {
      ok = false;
      report = null;
      results.push({
        task: f,
        harness_error: String(e instanceof Error ? e.message : String(e)).slice(0, 200),
      });
      failed.push(f);
      continue;
    } finally {
      store.close();
    }
    results.push({ task: f, replay_ok: ok, events: report!.event_count, problems: report!.problems });
    if (!ok) {
      failed.push(f);
    }
  }
  const passed = files.length - failed.length;
  const ratio = passed / files.length;
  const allow = ratio >= min_pass_ratio && failed.length === 0;
  return [
    allow,
    {
      tasks: files.length,
      passed,
      failed,
      pass_ratio: Math.round(ratio * 1000) / 1000,
      reason: allow ? "" : "canary replay 未达标",
      results,
    },
  ];
}
