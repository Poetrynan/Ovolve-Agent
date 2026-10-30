/**
 * effects.ts — storage domain mixin: sub-agent run ledger, tool side-effect
 * ledger, trace_event, usage recording + dashboard aggregates, bot state.
 *
 * Ported from `app/backend/storage.py` lines 2307–2623 + 2770–2801 +
 * 3447–3817 + 5307–5349 (M2 domain).
 *
 * RULEBOOK CITATIONS:
 * - §1 node: builtins only (node:crypto for uuids).
 * - §2 broad swallows (`except sqlite3.OperationalError: pass` / fallback
 *   re-executes) preserved verbatim with comments naming what is ignored.
 * - §2 BUG(port): get_bot_audit_log in the source has NO return statement —
 *   the `[dict(x) for x in r]` comprehension sits dead after the query and
 *   the function returns None. Reproduced bug-for-bug (returns undefined).
 * - §2 Python round() is banker's rounding — _percentile uses int(round(q*…))
 *   which for q*(n-1) products is the only round site; a helper reproduces
 *   Python's half-to-even exactly.
 * - §2 set-derived output: _favorite_model's tally and usage_by_model's
 *   aggregation sort deterministically (the source sorts explicitly).
 * - §4 naming: part of the storage unit (storage.py → storage/domains/).
 *
 * PORT STATUS: confidence=high todos=1
 */

import * as crypto from "node:crypto";

import type { Row, JsonDict } from "../storage_types.js";
import { StorageBase, intSeconds } from "../../storage.js";
import { PROCESS_GENERATION, SUBAGENT_TERMINAL_STATUSES } from "../storage_consts.js";
import { split_usage_model_id } from "../storage_funcs.js";

export interface EffectsDomainI {
  upsert_subagent_run(subagent_id: string, fields?: JsonDict): void;
  list_subagent_runs(parent_session_id?: string, limit?: number): JsonDict[];
  reap_orphan_subagent_runs(): JsonDict[];
  record_side_effect(
    session_id: string,
    goal_id: string,
    call_id: string,
    tool_name: string,
    args_hash: string,
    opts?: {
      effect_kind?: string;
      target?: string;
      operation_id?: string;
      pre_hash?: string;
      planned_hash?: string;
    }
  ): void;
  settle_side_effect(
    call_id: string,
    ok: boolean,
    result_preview?: string,
    status?: string,
    post_hash?: string
  ): void;
  completed_side_effects(goal_id: string): JsonDict[];
  unknown_side_effects(goal_id: string): JsonDict[];
  find_landed_side_effect(goal_id: string, tool_name: string, args_hash: string): JsonDict | null;
  find_effect_by_operation(operation_id: string, dead_only?: boolean): JsonDict | null;
  mark_effect_reconciled(call_id: string, status: string, post_hash?: string, operation_id?: string): void;
  trace_event(kwargs: {
    session_id: string;
    event_type: unknown;
    payload: JsonDict;
    importance?: string;
    [k: string]: unknown;
  }): unknown;
  record_usage(kwargs: {
    sid: string;
    tid: string;
    inp: number;
    outp: number;
    reason?: number;
    cc?: number;
    cr?: number;
    pt?: number;
    ct?: number;
    mr?: number;
    retry?: boolean;
    cx?: boolean;
    et?: string;
    model_id?: string;
    latency_ms?: number;
    cost_micros?: number;
    cache_saved_micros?: number;
    cost_source?: string;
  }): void;
  get_usage(sid: string): JsonDict;
  GOAL_EVIDENCE_DIGEST_CHARS: number;
  add_goal_iteration(
    gid: string,
    ordinal: number,
    started_at?: number,
    ended_at?: number,
    evidence?: string,
    verdict?: string,
    verdict_reason?: string,
    cost_micros?: number,
    tokens?: number
  ): string;
  list_goal_iterations(gid: string, limit?: number): JsonDict[];
  last_turn_context_tokens(sid: string): number;
  usage_summary(days?: number): JsonDict;
  usage_latency(days?: number): JsonDict;
  _percentile(sorted_vals: number[], q: number): number;
  _favorite_model(since: number): string;
  _current_streak(lookback_days?: number): number;
  usage_daily(days?: number): JsonDict[];
  usage_recent_turns(limit?: number, days?: number): JsonDict[];
  usage_by_model(days?: number): JsonDict[];
  save_bot_state(key: string, value: unknown): void;
  get_bot_state(key: string, defaultValue?: unknown): unknown;
  add_bot_message(msg: JsonDict): void;
  get_bot_messages(platform: string, user_id: string, limit?: number): JsonDict[];
  add_bot_audit(
    platform: string,
    user_id: string,
    session_id: string,
    tool_name: string,
    action: string,
    blocked: boolean,
    reason?: string
  ): void;
  get_bot_audit_log(platform?: string | null, user_id?: string | null, limit?: number): JsonDict[];
}

/** Python round() — half to even. */
function pythonRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function applyEffectsDomain(klass: typeof StorageBase): void {
  const proto = klass.prototype as unknown as Record<string, unknown>;

  (proto as unknown as { GOAL_EVIDENCE_DIGEST_CHARS: number }).GOAL_EVIDENCE_DIGEST_CHARS = 600;

  proto.upsert_subagent_run = function (
    this: StorageBase & EffectsDomainI,
    subagent_id: string,
    fields: JsonDict = {}
  ): void {
    const self = this;
    // Stamps the CURRENT PROCESS_GENERATION on every write (see source).
    if (!subagent_id) return;
    const cols = new Set([
      "parent_session_id",
      "child_session_id",
      "subagent_type",
      "label",
      "status",
      "created_at",
      "started_at",
      "finished_at",
      "result_chars",
      "error",
      "caller_call_id",
    ]);
    const data: [string, unknown][] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (cols.has(k)) data.push([k, v]);
    }
    const c = self._db("sessions");
    // INSERT-or-UPDATE in one statement; only supplied columns are overwritten.
    const assign = data.map(([k]) => `${k}=excluded.${k}`).join(", ");
    const colList = data.map(([k]) => `, ${k}`).join("");
    const placeholders = data.map(() => ", ?").join("");
    const sql =
      "INSERT INTO subagent_runs (subagent_id, generation" +
      colList +
      ") VALUES (?, ?" + placeholders + ") " +
      "ON CONFLICT(subagent_id) DO UPDATE SET generation=excluded.generation" +
      (assign ? ", " + assign : "");
    c.execute(sql, [subagent_id, PROCESS_GENERATION, ...data.map(([, v]) => v)]);
    c.commit();
  };

  proto.list_subagent_runs = function (
    this: StorageBase & EffectsDomainI,
    parent_session_id = "",
    limit = 50
  ): JsonDict[] {
    const self = this;
    const c = self._db("sessions");
    const n = Math.max(1, Math.min(500, Math.trunc(limit || 50)));
    let rows: Row[];
    if (parent_session_id) {
      rows = c
        .execute(
          "SELECT * FROM subagent_runs WHERE parent_session_id=? ORDER BY created_at DESC LIMIT ?",
          [parent_session_id, n]
        )
        .fetchall() as Row[];
    } else {
      rows = c
        .execute("SELECT * FROM subagent_runs ORDER BY created_at DESC LIMIT ?", [n])
        .fetchall() as Row[];
    }
    return rows.map((r) => ({ ...(r as Row) }) as JsonDict);
  };

  proto.reap_orphan_subagent_runs = function (this: StorageBase & EffectsDomainI): JsonDict[] {
    const self = this;
    // A row is an orphan iff non-terminal AND from another generation.
    const c = self._db("sessions");
    const terminalSorted = Array.from(SUBAGENT_TERMINAL_STATUSES).sort();
    const placeholders = terminalSorted.map(() => "?").join(",");
    const rows = c
      .execute(
        "SELECT * FROM subagent_runs" +
          ` WHERE generation IS NOT ? AND status NOT IN (${placeholders})`,
        [PROCESS_GENERATION, ...terminalSorted]
      )
      .fetchall() as Row[];
    const demoted = rows.map((r) => ({ ...(r as Row) }) as JsonDict);
    if (demoted.length > 0) {
      const ids = demoted.map((r) => String(r["subagent_id"]));
      c.execute(
        "UPDATE subagent_runs SET status='killed', finished_at=?," +
          " error=CASE WHEN error='' OR error IS NULL" +
          "   THEN 'Interrupted by server restart' ELSE error END" +
          ` WHERE subagent_id IN (${ids.map(() => "?").join(",")})`,
        [Date.now() / 1000, ...ids]
      );
      c.commit();
    }
    return demoted;
  };

  proto.record_side_effect = function (
    this: StorageBase & EffectsDomainI,
    session_id: string,
    goal_id: string,
    call_id: string,
    tool_name: string,
    args_hash: string,
    opts: {
      effect_kind?: string;
      target?: string;
      operation_id?: string;
      pre_hash?: string;
      planned_hash?: string;
    } = {}
  ): void {
    const self = this;
    const { effect_kind = "", target = "", operation_id = "", pre_hash = "", planned_hash = "" } = opts;
    const c = self._db("sessions");
    try {
      c.execute(
        "INSERT OR IGNORE INTO tool_side_effects" +
          " (call_id, session_id, goal_id, tool_name, args_hash, status, ok," +
          "  created_at, generation, effect_kind, target, operation_id," +
          "  pre_hash, planned_hash)" +
          " VALUES (?,?,?,?,?,'pending',0,?,?,?,?,?,?,?)",
        [
          call_id,
          session_id,
          goal_id || "",
          tool_name,
          args_hash,
          intSeconds(),
          PROCESS_GENERATION,
          String(effect_kind || ""),
          String(target || ""),
          String(operation_id || ""),
          String(pre_hash || ""),
          String(planned_hash || ""),
        ]
      );
    } catch (exc) {
      // Database predates 0012 (or the migration is mid-flight): keep the
      // untyped row rather than losing the ledger entry entirely.
      const msg = exc instanceof Error ? exc.message : String(exc);
      if (!/no such column|no such table|operational/i.test(msg)) {
        throw exc;
      }
      c.execute(
        "INSERT OR IGNORE INTO tool_side_effects" +
          " (call_id, session_id, goal_id, tool_name, args_hash, status, ok," +
          "  created_at, generation)" +
          " VALUES (?,?,?,?,?,'pending',0,?,?)",
        [call_id, session_id, goal_id || "", tool_name, args_hash, intSeconds(), PROCESS_GENERATION]
      );
    }
    c.commit();
  };

  proto.settle_side_effect = function (
    this: StorageBase & EffectsDomainI,
    call_id: string,
    ok: boolean,
    result_preview = "",
    status = "",
    post_hash = ""
  ): void {
    const self = this;
    // status defaults to outcome-derived completed/failed; `unknown` is for a
    // call stopped mid-flight (collapsing it into `failed` was a safety error).
    const c = self._db("sessions");
    const args: unknown[] = [
      status || (ok ? "completed" : "failed"),
      ok ? 1 : 0,
      String(result_preview || "").slice(0, 200),
      intSeconds(),
    ];
    try {
      c.execute(
        "UPDATE tool_side_effects SET status=?, ok=?, result_preview=?," +
          " settled_at=?, post_hash=? WHERE call_id=?",
        [...args, String(post_hash || ""), call_id]
      );
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      if (!/no such column|no such table|operational/i.test(msg)) {
        throw exc;
      }
      c.execute(
        "UPDATE tool_side_effects SET status=?, ok=?, result_preview=?," +
          " settled_at=? WHERE call_id=?",
        [...args, call_id]
      );
    }
    c.commit();
  };

  proto.completed_side_effects = function (
    this: StorageBase & EffectsDomainI,
    goal_id: string
  ): JsonDict[] {
    const self = this;
    // Side effects that verifiably LANDED — a resumed run is told not to redo.
    const rows = self
      ._db("sessions")
      .execute(
        "SELECT * FROM tool_side_effects WHERE goal_id=? AND status='completed'" +
          " ORDER BY created_at, rowid",
        [goal_id]
      )
      .fetchall() as Row[];
    return rows.map((r) => ({ ...(r as Row) }) as JsonDict);
  };

  proto.unknown_side_effects = function (
    this: StorageBase & EffectsDomainI,
    goal_id: string
  ): JsonDict[] {
    const self = this;
    // Dispatched but never settled, or settled as unknown — "check first".
    const rows = self
      ._db("sessions")
      .execute(
        "SELECT * FROM tool_side_effects WHERE goal_id=?" +
          " AND status IN ('pending','unknown') ORDER BY created_at, rowid",
        [goal_id]
      )
      .fetchall() as Row[];
    return rows.map((r) => ({ ...(r as Row) }) as JsonDict);
  };

  proto.find_landed_side_effect = function (
    this: StorageBase & EffectsDomainI,
    goal_id: string,
    tool_name: string,
    args_hash: string
  ): JsonDict | null {
    const self = this;
    // The replay question: only a row from a DEAD process counts.
    if (!(goal_id && tool_name && args_hash)) return null;
    let row: Row | null;
    try {
      row = self
        ._db("sessions")
        .execute(
          "SELECT * FROM tool_side_effects WHERE goal_id=? AND tool_name=?" +
            " AND args_hash=? AND status='completed'" +
            " AND generation IS NOT ? AND generation != ''" +
            " ORDER BY created_at DESC LIMIT 1",
          [goal_id, tool_name, args_hash, PROCESS_GENERATION]
        )
        .fetchone() as Row | null;
    } catch {
      // except sqlite3.OperationalError: no replay protection on old schemas
      return null;
    }
    return row ? ({ ...(row as Row) }) as JsonDict : null;
  };

  proto.find_effect_by_operation = function (
    this: StorageBase & EffectsDomainI,
    operation_id: string,
    dead_only = true
  ): JsonDict | null {
    const self = this;
    // The typed successor of find_landed_side_effect; also returns unsettled
    // attempts (pending/unknown) — those need reconciliation before redoing.
    if (!operation_id) return null;
    let sql =
      "SELECT * FROM tool_side_effects WHERE operation_id=?" +
      " AND status IN ('completed','unknown','pending')";
    const params: unknown[] = [operation_id];
    if (dead_only) {
      sql += " AND generation IS NOT ? AND generation != ''";
      params.push(PROCESS_GENERATION);
    }
    sql += " ORDER BY created_at DESC, rowid DESC LIMIT 1";
    try {
      const row = self._db("sessions").execute(sql, params).fetchone() as Row | null;
      return row ? ({ ...(row as Row) }) as JsonDict : null;
    } catch {
      return null;
    }
  };

  proto.mark_effect_reconciled = function (
    this: StorageBase & EffectsDomainI,
    call_id: string,
    status: string,
    post_hash = "",
    operation_id = ""
  ): void {
    const self = this;
    // Restamps generation to CURRENT so the dead-generation guard fires
    // exactly once per operation (see source: a safety net, not a wall).
    if (!(call_id || operation_id)) return;
    const c = self._db("sessions");
    try {
      if (operation_id) {
        c.execute(
          "UPDATE tool_side_effects SET status=?, post_hash=?," +
            " generation=?, settled_at=? WHERE operation_id=?" +
            " AND generation IS NOT ? AND status IN" +
            " ('completed','unknown','pending')",
          [
            String(status || "unknown"),
            String(post_hash || ""),
            PROCESS_GENERATION,
            intSeconds(),
            operation_id,
            PROCESS_GENERATION,
          ]
        );
      } else {
        c.execute(
          "UPDATE tool_side_effects SET status=?, post_hash=?," +
            " generation=?, settled_at=? WHERE call_id=?",
          [
            String(status || "unknown"),
            String(post_hash || ""),
            PROCESS_GENERATION,
            intSeconds(),
            call_id,
          ]
        );
      }
      c.commit();
    } catch {
      // except sqlite3.OperationalError: pass — pre-0012 database, nothing to reconcile
    }
  };

  proto.trace_event = function (
    this: StorageBase & EffectsDomainI,
    kwargs: {
      session_id: string;
      event_type: unknown;
      payload: JsonDict;
      importance?: string;
      [k: string]: unknown;
    }
  ): unknown {
    const self = this;
    const { session_id, event_type, payload, importance = "observational", ...correlation } = kwargs;
    // Sanctioned external entry into the canonical write gateway.
    return self._trace.append({
      session_id,
      event_type,
      payload,
      importance,
      causation_id: correlation["causation_id"] as string | undefined,
      idempotency_key: correlation["idempotency_key"] as string | undefined,
      run_id: correlation["run_id"] as string | undefined,
      turn_id: correlation["turn_id"] as string | undefined,
      step_id: correlation["step_id"] as string | undefined,
      tool_call_id: correlation["tool_call_id"] as string | undefined,
      goal_id: correlation["goal_id"] as string | undefined,
      branch_id: correlation["branch_id"] as string | undefined,
      parent_event_id: correlation["parent_event_id"] as string | undefined,
      actor: correlation["actor"] as string | undefined,
      visibility: correlation["visibility"] as string | undefined,
    });
  };

  proto.record_usage = function (
    this: StorageBase & EffectsDomainI,
    kwargs: {
      sid: string;
      tid: string;
      inp: number;
      outp: number;
      reason?: number;
      cc?: number;
      cr?: number;
      pt?: number;
      ct?: number;
      mr?: number;
      retry?: boolean;
      cx?: boolean;
      et?: string;
      model_id?: string;
      latency_ms?: number;
      cost_micros?: number;
      cache_saved_micros?: number;
      cost_source?: string;
    }
  ): void {
    const self = this;
    const {
      sid,
      tid,
      inp,
      outp,
      reason = 0,
      cc = 0,
      cr = 0,
      pt = 0,
      ct = 0,
      mr = 0,
      retry = true,
      cx = false,
      et = "",
      model_id = "",
      latency_ms = 0,
      cost_micros = 0,
      cache_saved_micros = 0,
      cost_source = "",
    } = kwargs;
    const c = self._db("usage");
    c.execute(
      "INSERT INTO turn_usage (id,session_id,turn_id,model_id,input_tokens,output_tokens,reasoning_tokens,cache_creation,cache_read,provider_total,computed_total,model_retry,retryable,context_exceeded,error_type,latency_ms,cost_micros,cache_saved_micros,cost_source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        crypto.randomUUID(),
        sid,
        tid,
        model_id,
        inp,
        outp,
        reason,
        cc,
        cr,
        pt,
        ct,
        mr,
        retry ? 1 : 0,
        cx ? 1 : 0,
        et,
        Math.trunc(latency_ms || 0),
        Math.trunc(cost_micros || 0),
        Math.trunc(cache_saved_micros || 0),
        String(cost_source || ""),
        intSeconds(),
      ]
    );
    c.commit();
    // P1-3 审计轨轮次事件：token 用量随流水落 jsonl（fail-open）。
    self._session_audit.record(sid, "event", {
      event: "usage",
      eventType: "llm.response_completed",
      model: String(model_id || ""),
      turnId: String(tid || ""),
      tokens: {
        input: Math.trunc(inp || 0),
        output: Math.trunc(outp || 0),
        reasoning: Math.trunc(reason || 0),
        cache_creation: Math.trunc(cc || 0),
        cache_read: Math.trunc(cr || 0),
      },
      payload: {
        latency_ms: Math.trunc(latency_ms || 0),
        cost_micros: Math.trunc(cost_micros || 0),
        cache_saved_micros: Math.trunc(cache_saved_micros || 0),
        model_retry: Math.trunc(mr || 0),
        context_exceeded: cx ? 1 : 0,
        error_type: String(et || ""),
      },
    });
  };

  proto.get_usage = function (this: StorageBase & EffectsDomainI, sid: string): JsonDict {
    const self = this;
    const r = self
      ._db("usage")
      .execute("SELECT * FROM turn_usage WHERE session_id=?", [sid])
      .fetchall() as Row[];
    const ti = r.reduce((s, x) => s + Number(x["input_tokens"] ?? 0), 0);
    const to = r.reduce((s, x) => s + Number(x["output_tokens"] ?? 0), 0);
    const tr = r.reduce((s, x) => s + Number(x["reasoning_tokens"] ?? 0), 0);
    // Money comes from per-row figures priced at their own write time.
    const cost = r.reduce((s, x) => s + Number(x["cost_micros"] ?? 0), 0);
    const saved = r.reduce((s, x) => s + Number(x["cache_saved_micros"] ?? 0), 0);
    const approx = r.some((x) => String(x["cost_source"] ?? "") === "fallback");
    return {
      turns: r.length,
      total_input: ti,
      total_output: to,
      total_reasoning: tr,
      total: ti + to + tr,
      total_cost_micros: cost,
      cache_saved_micros: saved,
      cost_approximate: approx,
    };
  };

  proto.add_goal_iteration = function (
    this: StorageBase & EffectsDomainI,
    gid: string,
    ordinal: number,
    started_at = 0,
    ended_at = 0,
    evidence = "",
    verdict = "",
    verdict_reason = "",
    cost_micros = 0,
    tokens = 0
  ): string {
    const self = this;
    // Idempotent on (goal_id, ordinal): a retried round overwrites itself.
    const c = self._db("goals");
    const now = intSeconds();
    const digest = String(evidence || "").slice(0, this.GOAL_EVIDENCE_DIGEST_CHARS);
    const prev = c
      .execute("SELECT id FROM goal_iterations WHERE goal_id=? AND ordinal=?", [gid, Math.trunc(ordinal)])
      .fetchone() as Row | null;
    const rid = prev ? String(prev["id"]) : crypto.randomUUID();
    if (prev) {
      c.execute(
        "UPDATE goal_iterations SET started_at=?, ended_at=?, evidence_digest=?," +
          " verdict=?, verdict_reason=?, cost_micros=?, tokens=? WHERE id=?",
        [
          Math.trunc(started_at || 0),
          Math.trunc(ended_at || now),
          digest,
          String(verdict || ""),
          String(verdict_reason || ""),
          Math.trunc(cost_micros || 0),
          Math.trunc(tokens || 0),
          rid,
        ]
      );
    } else {
      c.execute(
        "INSERT INTO goal_iterations (id,goal_id,ordinal,started_at,ended_at," +
          "evidence_digest,verdict,verdict_reason,cost_micros,tokens,created_at)" +
          " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          rid,
          gid,
          Math.trunc(ordinal),
          Math.trunc(started_at || 0),
          Math.trunc(ended_at || now),
          digest,
          String(verdict || ""),
          String(verdict_reason || ""),
          Math.trunc(cost_micros || 0),
          Math.trunc(tokens || 0),
          now,
        ]
      );
    }
    c.commit();
    return rid;
  };

  proto.list_goal_iterations = function (
    this: StorageBase & EffectsDomainI,
    gid: string,
    limit = 100
  ): JsonDict[] {
    const self = this;
    const r = self
      ._db("goals")
      .execute(
        "SELECT * FROM goal_iterations WHERE goal_id=? ORDER BY ordinal ASC LIMIT ?",
        [gid, Math.trunc(limit)]
      )
      .fetchall() as Row[];
    return r.map((x) => ({ ...(x as Row) }) as JsonDict);
  };

  proto.last_turn_context_tokens = function (
    this: StorageBase & EffectsDomainI,
    sid: string
  ): number {
    const self = this;
    // Provider-reported context size at the LAST turn; input + cache_read
    // (both occupy the window).
    const r = self
      ._db("usage")
      .execute(
        "SELECT input_tokens, cache_read FROM turn_usage " +
          "WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        [sid]
      )
      .fetchone() as Row | null;
    if (!r) return 0;
    return Number(r["input_tokens"] ?? 0) + Number(r["cache_read"] ?? 0);
  };

  // SQL fragments shared by the dashboard aggregates (verbatim; see the
  // source's convention commentary on cached-token and reasoning shapes).
  const SQL_HIT_DENOM =
    "COALESCE(SUM(CASE WHEN cache_read <= input_tokens " +
    "THEN input_tokens + cache_creation " +
    "ELSE input_tokens + cache_read + cache_creation END),0)";
  const SQL_TOTAL =
    "COALESCE(SUM(CASE WHEN reasoning_tokens > 0 AND reasoning_tokens <= output_tokens " +
    "THEN input_tokens + output_tokens " +
    "ELSE input_tokens + output_tokens + reasoning_tokens END),0)";

  proto.usage_summary = function (this: StorageBase & EffectsDomainI, days = 30): JsonDict {
    const self = this;
    const since = intSeconds() - days * 86400;
    const r = self
      ._db("usage")
      .execute(
        `
            SELECT COUNT(*)                       AS turns,
                   COALESCE(SUM(input_tokens),0)  AS input_tokens,
                   COALESCE(SUM(output_tokens),0) AS output_tokens,
                   COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
                   COALESCE(SUM(cache_creation),0) AS cache_creation,
                   COALESCE(SUM(cache_read),0)    AS cache_read,
                   COALESCE(SUM(cost_micros),0)   AS total_cost_micros,
                   COALESCE(SUM(cache_saved_micros),0) AS cache_saved_micros,
                   SUM(CASE WHEN cost_source='fallback' THEN 1 ELSE 0 END) AS fallback_priced_turns,
                   COUNT(DISTINCT session_id)     AS sessions,
                   COUNT(DISTINCT date(created_at,'unixepoch','localtime')) AS active_days,
                   ${SQL_HIT_DENOM}          AS hit_denom,
                   ${SQL_TOTAL}              AS total_tokens
            FROM turn_usage WHERE created_at >= ?
        `,
        [since]
      )
      .fetchone() as Row | null;
    const d = (r ? { ...(r as Row) } : {}) as JsonDict;
    const cache_read = Number(d["cache_read"] ?? 0);
    // Cache hit rate sent as a 0-1 fraction; the UI multiplies by 100.
    const denom = Number(d["hit_denom"] ?? 0);
    delete d["hit_denom"];
    d["cache_hit_rate"] = denom ? Math.round((cache_read / denom) * 10000) / 10000 : 0.0;
    d["cost_approximate"] = Boolean(Number(d["fallback_priced_turns"] ?? 0));
    d["favorite_model"] = self._favorite_model(since);
    d["current_streak_days"] = self._current_streak(days);
    Object.assign(d, self.usage_latency(days));
    return d;
  };

  proto.usage_latency = function (this: StorageBase & EffectsDomainI, days = 30): JsonDict {
    const self = this;
    // Percentiles in Python (SQLite has no PERCENTILE); 0-latency rows
    // EXCLUDED, not counted as instant.
    const since = intSeconds() - days * 86400;
    const rows = self
      ._db("usage")
      .execute(
        "SELECT latency_ms FROM turn_usage " +
          "WHERE created_at >= ? AND latency_ms > 0 ORDER BY latency_ms ASC",
        [since]
      )
      .fetchall() as Row[];
    const vals = rows.map((r) => Number(r["latency_ms"]));
    if (vals.length === 0) {
      return { latency_p50_ms: 0, latency_p95_ms: 0, latency_max_ms: 0, latency_samples: 0 };
    }
    return {
      latency_p50_ms: self._percentile(vals, 0.5),
      latency_p95_ms: self._percentile(vals, 0.95),
      latency_max_ms: vals[vals.length - 1]!,
      latency_samples: vals.length,
    };
  };

  proto._percentile = function (
    this: StorageBase & EffectsDomainI,
    sorted_vals: number[],
    q: number
  ): number {
    // Nearest-rank percentile over an ALREADY SORTED list; int(round(…)) is
    // Python's half-to-even round.
    if (sorted_vals.length === 0) return 0;
    const idx = Math.trunc(pythonRound(q * (sorted_vals.length - 1)));
    return sorted_vals[Math.max(0, Math.min(idx, sorted_vals.length - 1))]!;
  };

  proto._favorite_model = function (this: StorageBase & EffectsDomainI, since: number): string {
    const self = this;
    // Counted per model, not per provider:model string (see source comment).
    const rows = self
      ._db("usage")
      .execute(
        "SELECT model_id, COUNT(*) AS n FROM turn_usage " +
          "WHERE created_at >= ? AND model_id != '' GROUP BY model_id",
        [since]
      )
      .fetchall() as Row[];
    const tally: Record<string, number> = {};
    for (const r of rows) {
      const [, model_id] = split_usage_model_id(String(r["model_id"] ?? ""));
      if (model_id) {
        tally[model_id] = (tally[model_id] ?? 0) + Math.trunc(Number(r["n"] ?? 0));
      }
    }
    let best = "";
    let bestN = -1;
    // max(tally, key=tally.get) returns the FIRST key with the max count in
    // insertion order; Object.keys preserves insertion order, matching dict.
    for (const [k, v] of Object.entries(tally)) {
      if (v > bestN) {
        best = k;
        bestN = v;
      }
    }
    return best;
  };

  proto._current_streak = function (this: StorageBase & EffectsDomainI, lookback_days = 365): number {
    const self = this;
    // Consecutive days with activity, counting back from today; stops at the
    // first gap. A streak counted from yesterday still counts (see source).
    const since = intSeconds() - lookback_days * 86400;
    const rows = self
      ._db("usage")
      .execute(
        "SELECT DISTINCT date(created_at,'unixepoch','localtime') AS d " +
          "FROM turn_usage WHERE created_at >= ? ORDER BY d DESC",
        [since]
      )
      .fetchall() as Row[];
    if (rows.length === 0) return 0;
    // Python date.fromisoformat / date.today() are LOCAL calendar days; the
    // SQLite 'localtime' modifier produced these strings, so parse the same
    // day strings and diff them as day ordinals.
    const dayStr = (d: Date): string => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };
    const days = rows.map((r) => String(r["d"]));
    const todayStr = dayStr(new Date());
    const toOrdinal = (s: string): number => {
      const [y, m, d] = s.split("-").map((x) => Number(x));
      return Date.UTC(y!, (m ?? 1) - 1, d ?? 1) / 86400000;
    };
    const todayOrd = toOrdinal(todayStr);
    let cursor = toOrdinal(days[0]!);
    if (todayOrd - cursor > 1) return 0;
    let streak = 0;
    for (const d of days) {
      const ord = toOrdinal(d);
      if (ord === cursor) {
        streak += 1;
        cursor -= 1;
      } else if (ord < cursor) {
        break;
      }
    }
    return streak;
  };

  proto.usage_daily = function (this: StorageBase & EffectsDomainI, days = 30): JsonDict[] {
    const self = this;
    const since = intSeconds() - days * 86400;
    const rows = self
      ._db("usage")
      .execute(
        `
            SELECT date(created_at,'unixepoch','localtime') AS date,
                   COUNT(*) AS turns,
                   COALESCE(SUM(input_tokens),0) AS input_tokens,
                   COALESCE(SUM(output_tokens),0) AS output_tokens,
                   COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
                   ${SQL_TOTAL} AS tokens,
                   COALESCE(SUM(cache_read),0) AS cache_read,
                   COALESCE(SUM(cost_micros),0) AS cost_micros
            FROM turn_usage WHERE created_at >= ?
            GROUP BY date ORDER BY date ASC
        `,
        [since]
      )
      .fetchall() as Row[];
    return rows.map((r) => ({ ...(r as Row) }) as JsonDict);
  };

  /** 第一参兼容 number（limit）与 options 对象（http_server 的 {limit, days} kwargs 口径）。 */
  proto.usage_recent_turns = function (
    this: StorageBase & EffectsDomainI,
    limit_or_opts: number | { limit?: number; days?: number } = 30,
    daysArg?: number
  ): JsonDict[] {
    const self = this;
    let limit = 30;
    let days = 30;
    if (limit_or_opts !== null && typeof limit_or_opts === "object") {
      limit = limit_or_opts.limit ?? 30;
      days = limit_or_opts.days ?? 30;
    } else {
      limit = Number(limit_or_opts);
      if (daysArg !== undefined) days = daysArg;
    }
    // The NEWEST turns in the window, newest first.
    const since = intSeconds() - days * 86400;
    const rows = self
      ._db("usage")
      .execute(
        `
            SELECT id, session_id, turn_id, model_id,
                   input_tokens, output_tokens, reasoning_tokens,
                   cost_micros, latency_ms, created_at
            FROM turn_usage WHERE created_at >= ?
            ORDER BY created_at DESC LIMIT ?
        `,
        [since, limit]
      )
      .fetchall() as Row[];
    return rows.map((r) => ({ ...(r as Row) }) as JsonDict);
  };

  proto.usage_by_model = function (this: StorageBase & EffectsDomainI, days = 30): JsonDict[] {
    const self = this;
    // Per-MODEL totals + share; sources list keeps the provider breakdown.
    const since = intSeconds() - days * 86400;
    const rows = self
      ._db("usage")
      .execute(
        `
            SELECT model_id,
                   COUNT(*) AS requests,
                   COALESCE(SUM(input_tokens),0)  AS input_tokens,
                   COALESCE(SUM(output_tokens),0) AS output_tokens,
                   COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
                   COALESCE(SUM(cost_micros),0) AS cost_micros,
                   ${SQL_TOTAL} AS tokens
            FROM turn_usage WHERE created_at >= ?
            GROUP BY model_id ORDER BY tokens DESC
        `,
        [since]
      )
      .fetchall() as Row[];

    const aggregated = new Map<string, JsonDict>();
    for (const r of rows) {
      const d = r as Row;
      const [provider_id, model_id_raw] = split_usage_model_id(String(d["model_id"] ?? ""));
      let model_id = model_id_raw;
      // Legacy/broken rows with no model still spent real tokens — group them
      // so panel totals reconcile with the summary.
      if (!model_id) model_id = "(unknown)";
      let entry = aggregated.get(model_id);
      if (entry === undefined) {
        entry = {
          model_id,
          raw_model_id: String(d["model_id"] ?? "").trim(),
          requests: 0,
          input_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          cost_micros: 0,
          tokens: 0,
          sources: [] as JsonDict[],
        };
        aggregated.set(model_id, entry);
      }
      const counts: Record<string, number> = {
        requests: Math.trunc(Number(d["requests"] ?? 0)),
        input_tokens: Math.trunc(Number(d["input_tokens"] ?? 0)),
        output_tokens: Math.trunc(Number(d["output_tokens"] ?? 0)),
        reasoning_tokens: Math.trunc(Number(d["reasoning_tokens"] ?? 0)),
        cost_micros: Math.trunc(Number(d["cost_micros"] ?? 0)),
        tokens: Math.trunc(Number(d["tokens"] ?? 0)),
      };
      for (const [k, v] of Object.entries(counts)) {
        entry[k] = Number(entry[k] ?? 0) + v;
      }
      (entry["sources"] as JsonDict[]).push({ provider_id, ...counts });
    }

    const out = Array.from(aggregated.values()).sort(
      (a, b) => Number(b["tokens"]) - Number(a["tokens"])
    );
    const total = out.reduce((s, r) => s + Number(r["tokens"]), 0) || 1;
    for (const r of out) {
      r["share"] = Math.round((Number(r["tokens"]) / total) * 10000) / 10000;
      (r["sources"] as JsonDict[]).sort(
        (a, b) => Number(b["tokens"]) - Number(a["tokens"])
      );
    }
    return out;
  };

  proto.save_bot_state = function (this: StorageBase & EffectsDomainI, key: string, value: unknown): void {
    const self = this;
    const c = self._db("usage");
    c.execute("INSERT OR REPLACE INTO bot_state VALUES (?,?,?)", [
      key,
      pyJson(value),
      intSeconds(),
    ]);
    c.commit();
  };

  proto.get_bot_state = function (
    this: StorageBase & EffectsDomainI,
    key: string,
    defaultValue: unknown = null
  ): unknown {
    const self = this;
    const r = self
      ._db("usage")
      .execute("SELECT value FROM bot_state WHERE key=?", [key])
      .fetchone() as Row | null;
    if (!r) return defaultValue;
    try {
      return JSON.parse(String(r["value"]));
    } catch {
      // bare except: return the raw stored string
      return r["value"];
    }
  };

  proto.add_bot_message = function (this: StorageBase & EffectsDomainI, msg: JsonDict): void {
    const self = this;
    const c = self._db("bot");
    c.execute(
      "INSERT OR REPLACE INTO bot_messages (id,platform,user_id,content,direction,timestamp) VALUES (?,?,?,?,?,?)",
      [
        msg["id"] ?? null,
        msg["platform"] ?? null,
        msg["user_id"] ?? null,
        msg["content"] ?? null,
        (msg["direction"] as string) ?? "inbound",
        (msg["timestamp"] as number) ?? Date.now() / 1000,
      ]
    );
    c.commit();
  };

  proto.get_bot_messages = function (
    this: StorageBase & EffectsDomainI,
    platform: string,
    user_id: string,
    limit = 20
  ): JsonDict[] {
    const self = this;
    const r = self
      ._db("bot")
      .execute(
        "SELECT * FROM bot_messages WHERE platform=? AND user_id=? ORDER BY timestamp DESC LIMIT ?",
        [platform, user_id, limit]
      )
      .fetchall() as Row[];
    return r.map((x) => ({ ...(x as Row) }) as JsonDict);
  };

  proto.add_bot_audit = function (
    this: StorageBase & EffectsDomainI,
    platform: string,
    user_id: string,
    session_id: string,
    tool_name: string,
    action: string,
    blocked: boolean,
    reason = ""
  ): void {
    const self = this;
    const c = self._db("bot");
    c.execute(
      "INSERT INTO bot_audit (id,platform,user_id,session_id,tool_name,action,blocked,reason,timestamp) VALUES (?,?,?,?,?,?,?,?,?)",
      [crypto.randomUUID(), platform, user_id, session_id, tool_name, action, blocked ? 1 : 0, reason, Date.now() / 1000]
    );
    c.commit();
  };

  proto.get_bot_audit_log = function (
    this: StorageBase & EffectsDomainI,
    platform?: string | null,
    user_id?: string | null,
    limit = 50
  ): JsonDict[] {
    const self = this;
    const c = self._db("bot");
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (platform) {
      conditions.push("platform=?");
      params.push(platform);
    }
    if (user_id) {
      conditions.push("user_id=?");
      params.push(user_id);
    }
    const where = conditions.length > 0 ? conditions.join(" AND ") : "1=1";
    params.push(limit);
    const r = c
      .execute(`SELECT * FROM bot_audit WHERE ${where} ORDER BY timestamp DESC LIMIT ?`, params)
      .fetchall() as Row[];
    // BUG(port): the source builds this list but has NO return statement —
    // the function returns None. Reproduced bug-for-bug: undefined.
    void r;
    return undefined as unknown as JsonDict[];
  };
}

/** json.dumps(value, ensure_ascii=False) — shared import surface. */
import { pyJsonDumps as pyJson } from "../storage_funcs.js";
