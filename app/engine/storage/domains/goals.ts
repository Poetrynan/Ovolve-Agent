/**
 * goals.ts — storage domain mixin: goal state, claims/leases, cron jobs.
 *
 * Ported from `app/backend/storage.py` lines 3165–3446 (M4 domain).
 *
 * RULEBOOK CITATIONS:
 * - §1 node: builtins only.
 * - §2 The claim/lease UPDATE...WHERE clauses are the lock — reproduced
 *   statement-for-statement, parameter-for-parameter.
 * - §2 `log.error` refusal in update_goal_fields → console.error (loud).
 * - §2 `except: return None` on get_goal_state preserved.
 * - §4 naming: part of the storage unit (storage.py → storage/domains/).
 *
 * PORT STATUS: confidence=high todos=0
 */

import type { Row, JsonDict } from "../storage_types.js";
import { StorageBase, intSeconds } from "../../storage.js";
import { PROCESS_GENERATION } from "../storage_consts.js";
import { pyJsonDumps } from "../storage_funcs.js";

export interface GoalsDomainI {
  GOAL_UNCLAIMABLE_STATUSES: readonly string[];
  set_goal_state(sid: string, gs: JsonDict | null): void;
  get_goal_state(sid: string): JsonDict | null;
  save_goal(gid: string, desc: string, status: string, it: number, sid: string, ver?: string): void;
  update_goal_fields(gid: string, fields: JsonDict): boolean;
  claim_goal(
    gid: string,
    stale_after?: number,
    owner?: string,
    lease_seconds?: number
  ): boolean;
  renew_goal_claim(gid: string, owner: string, lease_seconds: number): boolean;
  release_goal(gid: string, owner?: string): boolean;
  claim_info(gid: string): JsonDict;
  reap_goal_claim(gid: string): boolean;
  add_goal_spend(gid: string, cost_micros: number, tokens?: number): JsonDict;
  get_goal(gid: string): JsonDict | null;
  list_goals(status?: string | null): JsonDict[];
  save_cron_job(job: JsonDict): void;
  get_cron_jobs(active?: boolean, include_stopped?: boolean): JsonDict[];
  update_cron_job(jid: string, fields: JsonDict): void;
  delete_cron_job(jid: string): void;
}

export function applyGoalsDomain(klass: typeof StorageBase): void {
  const proto = klass.prototype as unknown as Record<string, unknown>;

  (proto as unknown as { GOAL_UNCLAIMABLE_STATUSES: readonly string[] }).GOAL_UNCLAIMABLE_STATUSES = [
    "completed",
    "cancelled",
    "stopping",
    "stop_timeout",
  ];

  proto.set_goal_state = function (this: StorageBase & GoalsDomainI, sid: string, gs: JsonDict | null): void {
    const self = this;
    const c = self._db("sessions");
    c.execute("UPDATE sessions SET goal_state=?, updated_at=? WHERE id=?", [
      pyJsonDumps(gs),
      intSeconds(),
      sid,
    ]);
    c.commit();
  };

  proto.get_goal_state = function (this: StorageBase & GoalsDomainI, sid: string): JsonDict | null {
    const self = this;
    const r = self
      ._db("sessions")
      .execute("SELECT goal_state FROM sessions WHERE id=?", [sid])
      .fetchone() as Row | null;
    if (r && r["goal_state"]) {
      try {
        return JSON.parse(String(r["goal_state"])) as JsonDict;
      } catch {
        // bare except: return None
        return null;
      }
    }
    return null;
  };

  proto.save_goal = function (
    this: StorageBase & GoalsDomainI,
    gid: string,
    desc: string,
    status: string,
    it: number,
    sid: string,
    ver = ""
  ): void {
    const self = this;
    // Deliberately NOT INSERT OR REPLACE (see source: defaults would zero the
    // spend ledger and reset created_at).
    const c = self._db("goals");
    const now = intSeconds();
    const cur = c.execute("SELECT id FROM goals WHERE id=?", [gid]).fetchone();
    if (cur) {
      c.execute(
        "UPDATE goals SET description=?, status=?, iteration=?, session_id=?," +
          " verification_result=?, updated_at=? WHERE id=?",
        [desc, status, it, sid, ver, now, gid]
      );
    } else {
      c.execute(
        "INSERT INTO goals (id,description,status,iteration,session_id," +
          "created_at,updated_at,verification_result) VALUES (?,?,?,?,?,?,?,?)",
        [gid, desc, status, it, sid, now, now, ver]
      );
    }
    c.commit();
  };

  proto.update_goal_fields = function (
    this: StorageBase & GoalsDomainI,
    gid: string,
    fields: JsonDict
  ): boolean {
    const self = this;
    // Keys outside _GOAL_WRITABLE are refused, not written (LOUD refusal).
    const GOAL_WRITABLE = new Set([
      "description",
      "status",
      "iteration",
      "session_id",
      "verification_result",
      "max_iterations",
      "cost_micros",
      "cost_cap_micros",
      "tokens_used",
      "plan_json",
      "last_error",
      "started_at",
      "claimed_at",
      "brief_json",
      "category",
      "contract_json",
    ]);
    const allowed = new Map<string, unknown>();
    for (const [k, v] of Object.entries(fields)) {
      if (GOAL_WRITABLE.has(k)) allowed.set(k, v);
    }
    const refused = Object.keys(fields)
      .filter((k) => !GOAL_WRITABLE.has(k))
      .sort();
    if (refused.length > 0) {
      console.error(
        `[storage] update_goal_fields refused non-writable column(s) ${JSON.stringify(refused)} ` +
          `on goal ${gid} — the write did NOT happen; use the dedicated ` +
          `claim/lease methods for lease columns`
      );
    }
    if (allowed.size === 0) return false;
    const c = self._db("goals");
    const sets = Array.from(allowed.keys()).map((k) => `${k}=?`).join(",");
    const cur = c.execute(
      `UPDATE goals SET ${sets}, updated_at=? WHERE id=?`,
      [...allowed.values(), intSeconds(), gid]
    );
    c.commit();
    return cur.rowcount > 0;
  };

  proto.claim_goal = function (
    this: StorageBase & GoalsDomainI,
    gid: string,
    stale_after = 900,
    owner = "",
    lease_seconds = 0
  ): boolean {
    const self = this;
    // The UPDATE's WHERE clause is the lock; the status condition mirrors
    // durable-execution engines (no worker gets a closed execution).
    const c = self._db("goals");
    const now = intSeconds();
    const blocked = this.GOAL_UNCLAIMABLE_STATUSES;
    const blockedPh = blocked.map(() => "?").join(",");
    let cur: { rowcount: number };
    if (owner) {
      cur = c.execute(
        "UPDATE goals SET claimed_at=?, claim_owner=?, lease_until=?," +
          " last_heartbeat=?, claim_epoch=COALESCE(claim_epoch,0)+1" +
          " WHERE id=? AND (claimed_at=0" +
          "   OR (COALESCE(lease_until,0)>0 AND COALESCE(lease_until,0)<?)" +
          "   OR (COALESCE(lease_until,0)=0 AND claimed_at<?))" +
          ` AND (status IS NULL OR status NOT IN (${blockedPh}))`,
        [
          now,
          String(owner),
          now + Math.trunc(lease_seconds || stale_after),
          now,
          gid,
          now,
          now - stale_after,
          ...blocked,
        ]
      );
    } else {
      // Legacy shape: no identity, no lease; expiry stays claimed_at-based.
      cur = c.execute(
        "UPDATE goals SET claimed_at=? WHERE id=? AND (claimed_at=0 OR claimed_at<?)" +
          ` AND (status IS NULL OR status NOT IN (${blockedPh}))`,
        [now, gid, now - stale_after, ...blocked]
      );
    }
    c.commit();
    return cur.rowcount > 0;
  };

  proto.renew_goal_claim = function (
    this: StorageBase & GoalsDomainI,
    gid: string,
    owner: string,
    lease_seconds: number
  ): boolean {
    const self = this;
    if (!(gid && owner)) return false;
    const now = intSeconds();
    const c = self._db("goals");
    const cur = c.execute(
      "UPDATE goals SET lease_until=?, last_heartbeat=?" +
        " WHERE id=? AND claim_owner=? AND claimed_at>0",
      [now + Math.trunc(lease_seconds), now, gid, String(owner)]
    );
    c.commit();
    return cur.rowcount > 0;
  };

  proto.release_goal = function (this: StorageBase & GoalsDomainI, gid: string, owner = ""): boolean {
    const self = this;
    const c = self._db("goals");
    const now = intSeconds();
    let cur: { rowcount: number };
    if (owner) {
      cur = c.execute(
        "UPDATE goals SET claimed_at=0, claim_owner='', lease_until=0," +
          " last_heartbeat=0 WHERE id=? AND claim_owner=?",
        [gid, String(owner)]
      );
    } else {
      // Ownerless callers may only clear an UNOWNED or already-expired claim.
      cur = c.execute(
        "UPDATE goals SET claimed_at=0, claim_owner='', lease_until=0," +
          " last_heartbeat=0 WHERE id=? AND claimed_at>0" +
          " AND (claim_owner IS NULL OR claim_owner=''" +
          "   OR (COALESCE(lease_until,0)>0 AND COALESCE(lease_until,0)<?))",
        [gid, now]
      );
    }
    c.commit();
    return cur.rowcount > 0;
  };

  proto.claim_info = function (this: StorageBase & GoalsDomainI, gid: string): JsonDict {
    const self = this;
    // Read-only view of who holds a goal and until when. Diagnostics.
    const row = (this.get_goal(gid) ?? {}) as JsonDict;
    return {
      claimed: Boolean(row["claimed_at"]),
      claimOwner: String(row["claim_owner"] ?? ""),
      leaseUntil: Number(row["lease_until"] ?? 0),
      lastHeartbeat: Number(row["last_heartbeat"] ?? 0),
      claimEpoch: Number(row["claim_epoch"] ?? 0),
    };
  };

  proto.reap_goal_claim = function (this: StorageBase & GoalsDomainI, gid: string): boolean {
    const self = this;
    // Boot-time forced release of a claim whose holder process is GONE.
    // A claim owned by THIS process is refused (a bug double-starting a
    // worker — the honest answer is False).
    const c = self._db("goals");
    const cur = c.execute(
      "UPDATE goals SET claimed_at=0, claim_owner='', lease_until=0," +
        " last_heartbeat=0 WHERE id=? AND claimed_at>0" +
        " AND (claim_owner IS NULL OR claim_owner=''" +
        "   OR claim_owner NOT LIKE ?)",
      [gid, PROCESS_GENERATION + "%"]
    );
    c.commit();
    return cur.rowcount > 0;
  };

  proto.add_goal_spend = function (
    this: StorageBase & GoalsDomainI,
    gid: string,
    cost_micros: number,
    tokens = 0
  ): JsonDict {
    const self = this;
    // In-SQL increment (not read-then-write) so concurrent iterations can't
    // overwrite each other.
    const c = self._db("goals");
    c.execute(
      "UPDATE goals SET cost_micros=COALESCE(cost_micros,0)+?," +
        " tokens_used=COALESCE(tokens_used,0)+?, updated_at=? WHERE id=?",
      [Math.trunc(cost_micros), Math.trunc(tokens), intSeconds(), gid]
    );
    c.commit();
    const r = c
      .execute("SELECT cost_micros, cost_cap_micros, tokens_used FROM goals WHERE id=?", [gid])
      .fetchone() as Row | null;
    return r ? ({ ...(r as Row) }) as JsonDict : {};
  };

  proto.get_goal = function (this: StorageBase & GoalsDomainI, gid: string): JsonDict | null {
    const self = this;
    const r = self
      ._db("goals")
      .execute("SELECT * FROM goals WHERE id=?", [gid])
      .fetchone() as Row | null;
    return r ? ({ ...(r as Row) }) as JsonDict : null;
  };

  proto.list_goals = function (this: StorageBase & GoalsDomainI, status?: string | null): JsonDict[] {
    const self = this;
    const c = self._db("goals");
    const r = status
      ? (c
          .execute("SELECT * FROM goals WHERE status=? ORDER BY updated_at DESC", [status])
          .fetchall() as Row[])
      : (c.execute("SELECT * FROM goals ORDER BY updated_at DESC").fetchall() as Row[]);
    return r.map((x) => ({ ...(x as Row) }) as JsonDict);
  };

  proto.save_cron_job = function (this: StorageBase & GoalsDomainI, job: JsonDict): void {
    const self = this;
    const c = self._db("cron");
    const cols = [
      "id",
      "title",
      "prompt",
      "cron_expr",
      "delay_minutes",
      "recurring",
      "max_runs",
      "next_run_at",
      "last_run_at",
      "run_count",
      "status",
      "bot_delivery_target",
      "session_id",
      "created_at",
    ] as const;
    c.execute(
      `INSERT OR REPLACE INTO cron_jobs (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      cols.map((k) => (job as JsonDict)[k] ?? null)
    );
    c.commit();
  };

  proto.get_cron_jobs = function (
    this: StorageBase & GoalsDomainI,
    active = false,
    include_stopped = false
  ): JsonDict[] {
    const self = this;
    const c = self._db("cron");
    let r: Row[];
    if (active) {
      r = c
        .execute("SELECT * FROM cron_jobs WHERE status='active' ORDER BY next_run_at")
        .fetchall() as Row[];
    } else if (!include_stopped) {
      r = c
        .execute("SELECT * FROM cron_jobs WHERE status != 'stopped' ORDER BY created_at DESC")
        .fetchall() as Row[];
    } else {
      r = c.execute("SELECT * FROM cron_jobs ORDER BY created_at DESC").fetchall() as Row[];
    }
    return r.map((x) => ({ ...(x as Row) }) as JsonDict);
  };

  proto.update_cron_job = function (
    this: StorageBase & GoalsDomainI,
    jid: string,
    fields: JsonDict
  ): void {
    const self = this;
    const c = self._db("cron");
    const keys = Object.keys(fields);
    c.execute(
      `UPDATE cron_jobs SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`,
      [...keys.map((k) => fields[k]), jid]
    );
    c.commit();
  };

  proto.delete_cron_job = function (this: StorageBase & GoalsDomainI, jid: string): void {
    const self = this;
    const c = self._db("cron");
    c.execute("DELETE FROM cron_jobs WHERE id=?", [jid]);
    c.commit();
  };
}
