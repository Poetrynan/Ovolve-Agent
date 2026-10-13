/**
 * eval_harness.ts — golden 基线录制 / 核验 / 确定性回放 / 合成基线生成。
 *
 * Ported from `app/backend/eval_harness.py` (335 lines).
 *
 * RULEBOOK CITATIONS
 *   §1  node:crypto (sha256) / node:fs / node:path / node:os (tmpdir)。
 *   §2  json.dumps(sort_keys=True, ensure_ascii=False) → pyJsonDumps(v, true)
 *       （与 storage_funcs.ts 共享，跨构建稳定；链哈希种子逐字保留）。
 *   §2  基线 JSON indent=1 → JSON.stringify(x, null, 1)（非哈希输入，形状
 *       对齐即可）。
 *   §2  `from event_store import EventStore` → 静态 import（已移植，接口
 *       append/read_stream/verify_chain 已核对）。
 *   §4  naming: eval_harness.py → eval_harness.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { EventStore } from "./event_store.js";
import { pyJsonDumps } from "./storage/storage_funcs.js";

/** 模块定位：源用 __file__ 定位 ../tests/golden；TS 引擎目录语义对应。 */
function _module_dir(): string {
  try {
    const d = (globalThis as Record<string, unknown>)["__dirname"];
    if (typeof d === "string") {
      return d;
    }
  } catch {
    // fall through
  }
  return process.cwd();
}

export const GOLDEN_DIR = path.join(_module_dir(), "..", "tests", "golden");

// ---------------------------------------------------------------------------
// GoldenReport
// ---------------------------------------------------------------------------

export interface GoldenReport {
  session_id: string;
  chain_valid: boolean;
  replay_ok: boolean;
  event_count: number;
  problems: string[];
}

export function golden_report_to_dict(r: GoldenReport): Record<string, unknown> {
  return { ...r };
}

// ---------------------------------------------------------------------------
// record_golden
// ---------------------------------------------------------------------------

/** 把一个会话的事件流定格为 golden 基线文件，返回文件路径。 */
export function record_golden(
  storage: { get_event_store: () => EventStore },
  session_id: string,
  opts?: { name?: string; out_dir?: string | null }
): string {
  const { name = "", out_dir = null } = opts ?? {};
  const events = storage.get_event_store().read_stream(session_id);
  const payload = {
    session_id,
    recorded_at: Date.now() / 1000,
    events: events.map((e) => ({
      seq: e.seq,
      // golden JSON 是落盘契约，保持源 snake_case 键；TS AgentEvent 是 camelCase
      event_type: e.eventType,
      payload: e.payload,
      chain_hash: e.chainHash,
      // 时间戳是链哈希的原材料——没有它基线无法自证未被篡改。
      timestamp: e.timestamp,
    })),
  };
  const dir = out_dir || GOLDEN_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const fname = `${name || session_id}.golden.json`;
  const p = path.join(dir, fname);
  fs.writeFileSync(p, JSON.stringify(payload, null, 1), "utf-8");
  return p;
}

// ---------------------------------------------------------------------------
// check_golden
// ---------------------------------------------------------------------------

interface GoldenEvent {
  seq: number;
  event_type: string;
  payload: Record<string, unknown>;
  chain_hash?: string;
  timestamp?: number;
}

/** 对照基线核验当前库里的同一条流。 */
export function check_golden(
  p: string,
  storage: { get_event_store: () => EventStore }
): GoldenReport {
  const golden = JSON.parse(fs.readFileSync(p, "utf-8")) as {
    session_id: string;
    events: GoldenEvent[];
  };
  const sid = golden["session_id"];
  const baseline = new Map<number, GoldenEvent>();
  for (const e of golden["events"]) {
    baseline.set(e["seq"], e);
  }
  const problems: string[] = [];

  // 1) 现库的链校验（EventStore 自带的 SHA-256 全链验证）
  let chain_valid = false;
  try {
    const verdict = storage.get_event_store().verify_chain(sid);
    chain_valid =
      typeof verdict === "object" && verdict !== null
        ? Boolean((verdict as Record<string, unknown>)["valid"])
        : Boolean(verdict);
  } catch (e) {
    chain_valid = false;
    problems.push(`verify_chain error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2) 与基线逐条比对：类型与载荷必须逐字一致（确定性投影的前提）
  const current = storage.get_event_store().read_stream(sid);
  const cur_by_seq = new Map<number, Record<string, unknown>>();
  for (const e of current) {
    cur_by_seq.set(e.seq, {
      seq: e.seq,
      event_type: e.eventType,
      payload: e.payload,
      chain_hash: e.chainHash,
    });
  }
  for (const [seq, base] of baseline) {
    const cur = cur_by_seq.get(seq);
    if (cur === undefined) {
      problems.push(`seq ${seq} vanished`);
      continue;
    }
    if (cur["event_type"] !== base["event_type"]) {
      problems.push(
        `seq ${seq} type drifted: ${base["event_type"]} → ${String(cur["event_type"])}`
      );
    } else if (
      pyJsonDumps(cur["payload"] ?? {}, true) !== pyJsonDumps(base["payload"] ?? {}, true)
    ) {
      problems.push(`seq ${seq} payload drifted`);
    } else if (
      cur["chain_hash"] &&
      base["chain_hash"] &&
      cur["chain_hash"] !== base["chain_hash"]
    ) {
      problems.push(`seq ${seq} chain hash changed`);
    }
  }

  const replay_ok = !problems.some((p) => p.includes("drifted") || p.includes("vanished"));
  return {
    session_id: sid,
    chain_valid,
    replay_ok,
    event_count: cur_by_seq.size,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Deterministic replay & baseline self-verification (Phase 11 扩充)
// ---------------------------------------------------------------------------

/** 把 store 里的流与基线逐 seq 比对（类型+载荷）。返回 (replay_ok, problems, n)。 */
function _compare_baseline(
  baseline_events: GoldenEvent[],
  store: EventStore,
  sid: string
): [boolean, string[], number] {
  const problems: string[] = [];
  const current = store.read_stream(sid);
  const cur_by_seq = new Map<number, { event_type: string; payload: Record<string, unknown> }>();
  for (const e of current) {
    cur_by_seq.set(e.seq, { event_type: e.eventType, payload: e.payload });
  }
  for (const base of baseline_events) {
    const seq = base["seq"];
    const cur = cur_by_seq.get(seq);
    if (cur === undefined) {
      problems.push(`seq ${seq} vanished`);
      continue;
    }
    if (cur.event_type !== base["event_type"]) {
      problems.push(`seq ${seq} type drifted: ${base["event_type"]} → ${cur.event_type}`);
    } else if (
      pyJsonDumps(cur.payload ?? {}, true) !== pyJsonDumps(base["payload"] ?? {}, true)
    ) {
      problems.push(`seq ${seq} payload drifted`);
    }
  }
  return [problems.length === 0, problems, cur_by_seq.size];
}

/** 离线核验基线文件**自身**的链完整性（篡改检测）。
 *
 * 基线里每条事件带着它入链时的 chain_hash。用与 EventStore 相同的级联公式
 * 从 (prev|sid|type|ts|payload) 重算比对：被改过 payload/类型/顺序的基线在
 * 这里现形。这一步不可省——回放比对对"基线自身被篡改"是盲的。
 *
 * 旧格式（无 timestamp）无法离线重算，跳过自证、只做回放比对。 */
function _baseline_chain_problems(golden: { session_id?: string; events?: GoldenEvent[] }): string[] {
  const events = golden["events"] ?? [];
  if (events.length === 0 || events.some((e) => !("timestamp" in e))) {
    return []; // legacy 基线：没有原材料，谈不上重算
  }
  const sid = String(golden["session_id"] ?? "");
  let prev = crypto
    .createHash("sha256")
    .update(`genesis:${sid}`, "utf-8")
    .digest("hex");
  const problems: string[] = [];
  for (const e of events) {
    const canonical = pyJsonDumps(e["payload"] ?? {}, true);
    const seed = `${prev}|${sid}|${e["event_type"]}|${e["timestamp"]}|${canonical}`;
    const calc = crypto.createHash("sha256").update(seed, "utf-8").digest("hex");
    const recorded = String(e["chain_hash"] ?? "");
    if (!recorded) {
      problems.push(`seq ${e["seq"]} baseline carries no chain hash`);
    } else if (calc !== recorded) {
      problems.push(
        `seq ${e["seq"]} baseline tampered: chain hash mismatch ` +
          `(expected ${calc.slice(0, 12)}…, recorded ${recorded.slice(0, 12)}…)`
      );
    }
    // 断点之后用"已记录值"继续推——一次篡改报一条，而不是雪崩成 N 条
    prev = recorded || calc;
  }
  return problems;
}

/** 把基线事件按序重放进一个**全新**的 store，再逐条比对。
 *
 * 确定性回放的纪律：只写事件、不触发任何真实副作用工具。重放流的链哈希因
 * 时间戳不同必然与基线不同——所以校验的是重放流自身的链完整性 + 类型/载荷
 * 逐条一致。重放之前先做基线自身的链自证（篡改检测）。 */
export function replay_golden(p: string, store: EventStore): GoldenReport {
  const golden = JSON.parse(fs.readFileSync(p, "utf-8")) as {
    session_id: string;
    events: GoldenEvent[];
  };
  const sid = golden["session_id"];
  const tamper = _baseline_chain_problems(golden);
  if (tamper.length > 0) {
    return {
      session_id: sid,
      chain_valid: false,
      replay_ok: false,
      event_count: 0,
      problems: tamper,
    };
  }
  try {
    for (const e of golden["events"]) {
      store.append(sid, e["event_type"], e["payload"]);
    }
  } catch (e) {
    return {
      session_id: sid,
      chain_valid: false,
      replay_ok: false,
      event_count: 0,
      problems: [`append failed: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
  const verdict = store.verify_chain(sid);
  const chain_valid =
    typeof verdict === "object" && verdict !== null
      ? Boolean((verdict as Record<string, unknown>)["valid"])
      : Boolean(verdict);
  const [replay_ok, problems, n] = _compare_baseline(golden["events"], store, sid);
  return {
    session_id: sid,
    chain_valid,
    replay_ok: replay_ok && chain_valid,
    event_count: n,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Synthetic golden (canary 门禁的常驻口粮)
// ---------------------------------------------------------------------------

/** 生成合成演示流基线。
 *
 * 合成而非录制真实会话是刻意的：golden 基线会进仓库，真实对话属于用户隐私。
 * scenario 覆盖三大事件族：chat / goal / skill。 */
export function build_synthetic_golden(out_path: string, scenario = "chat"): string {
  const flows: Record<string, Array<[string, Record<string, unknown>]>> = {
    chat: [
      ["session.created", { title: "合成基线演示" }],
      ["user.message_submitted", { text: "把 README 标题改成 Ovolve" }],
      ["tool.execution_started", { tool: "write_file", args: { path: "README.md" } }],
      ["tool.execution_completed", { tool: "write_file", ok: true, chars: 128 }],
      ["agent.turn_completed", { ok: true }],
    ],
    goal: [
      ["session.created", { title: "合成目标流" }],
      ["agent.turn_started", { turn: 1 }],
      ["tool.execution_started", { tool: "run_shell", args: { cmd: "pytest -q" } }],
      ["tool.execution_completed", { tool: "run_shell", ok: true }],
      ["agent.turn_completed", { ok: true }],
      ["system.checkpoint_created", { turn_state: "completed", scope: "synthetic" }],
      ["system.recovery_initiated", { reason: "synthetic drill" }],
    ],
    skill: [
      [
        "skill.started",
        { skill_id: "demo-skill", selection_reason: "trigger_match(score=3)" },
      ],
      ["tool.execution_started", { tool: "read_file", args: {} }],
      ["tool.execution_completed", { tool: "read_file", ok: true }],
      ["skill.completed", { skill_id: "demo-skill" }],
      ["skill.experience_recorded", { experience_id: "exp-synth-1", outcome: "success" }],
      ["memory.extracted", { facts: ["演示用事实一条"], count: 1 }],
    ],
  };
  if (!(scenario in flows)) {
    throw new Error(
      `unknown scenario ${JSON.stringify(scenario)}; expected one of ${Object.keys(flows).sort().join(", ")}`
    );
  }

  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "golden-src-")), "events.db");
  const store = new EventStore(db);
  const sid = `synthetic-${scenario}`;
  let events_out: Array<{
    seq: number;
    event_type: string;
    payload: Record<string, unknown>;
    timestamp: number;
    chain_hash: string;
  }> = [];
  try {
    for (const [etype, payload] of flows[scenario]!) {
      store.append(sid, etype, payload);
    }
    events_out = store
      .read_stream(sid)
      .map((e) => ({
        seq: e.seq,
        event_type: e.eventType,
        payload: e.payload,
        timestamp: e.timestamp,
        chain_hash: e.chainHash,
      }));
  } finally {
    store.close();
  }

  fs.mkdirSync(path.dirname(path.resolve(out_path)), { recursive: true });
  const payload_out = {
    session_id: sid,
    recorded_at: Date.now() / 1000,
    events: events_out,
  };
  fs.writeFileSync(out_path, JSON.stringify(payload_out, null, 1), "utf-8");
  return out_path;
}

/** 列出全部 golden 基线文件名（排序）。 */
export function list_golden(out_dir?: string | null): string[] {
  const d = out_dir || GOLDEN_DIR;
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) {
    return [];
  }
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".golden.json"))
    .sort();
}
