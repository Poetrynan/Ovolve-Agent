/**
 * memory.ts — storage domain mixin: memory entries, FTS5 lexical index,
 * graph entities/relations, Dream run leases.
 *
 * Ported from `app/backend/storage.py` lines 3818–4714 + 5286–5306 (M5 domain).
 *
 * RULEBOOK CITATIONS:
 * - §1 node: builtins only (node:crypto for ids).
 * - §2 broad swallows / sqlite3.OperationalError degrade paths preserved
 *   verbatim with comments (fts_upsert fail-open, set_memory_status refusal).
 * - §2 `from wiki_store import has_negation` → wiki_store.ts hasNegation
 *   (already ported with 1:1 semantics; the source's lazy import inside the
 *   function is a static import here — no init-order hazard).
 * - §2 set-derived output: link_memory_conflict sorts the merged conflict_set
 *   exactly like the source (`sorted(set(cur))`).
 * - §4 naming: part of the storage unit (storage.py → storage/domains/).
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as crypto from "node:crypto";

import type { Row, JsonDict } from "../storage_types.js";
import { StorageBase, intSeconds, uuidHex } from "../../storage.js";
import { pyJsonDumps } from "../storage_funcs.js";
import { fts_document } from "../../fts_support.js";
import { hasNegation } from "../../wiki_store.js";
import { PROCESS_GENERATION } from "../storage_consts.js";

export interface MemoryDomainI {
  MEMORY_STATUSES: readonly string[];
  RECALLABLE_MEMORY_STATUSES: readonly string[];
  MEMORY_TRUST_ORDER: string;
  MEMORY_CONTENT_SCAN_LIMIT: number;
  MEMORY_CONFIDENCE_FLOOR: number;
  MEMORY_CONFIDENCE_CEIL: number;
  DREAM_LEASE_SECONDS: number;
  save_memory_entry(eid: string, sid: string, root: string, scope: string, content: string, opts?: MemoryEntryOpts): void;
  _fts_upsert(eid: string, root: string, content: string): void;
  _fts_delete(eid: string): void;
  rebuild_memory_fts(root?: string | null): number;
  search_memory_fts(
    root: string,
    match_query: string,
    limit?: number,
    session_id?: string | null,
    branch_id?: string | null
  ): Record<string, number>;
  touch_memory_hit(eid: string): void;
  set_memory_tier(eid: string, tier: string): void;
  expire_memories_by_tier(root: string, tier: string, older_than: number): void;
  _memory_live_sql(prefix?: string): [string, unknown[]];
  get_memory_entries(
    root?: string | null,
    mem_type?: string | null,
    include_archived?: boolean,
    limit?: number | null,
    since?: number | null
  ): JsonDict[];
  list_memory_roots(include_archived?: boolean): JsonDict[];
  set_memory_status(
    eid: string,
    status: string,
    opts?: { reason?: string; superseded_by?: string }
  ): boolean;
  adjust_memory_confidence(eid: string, delta: number, opts?: { reason?: string }): number;
  confirm_memory(eid: string, opts?: { delta?: number }): boolean;
  sweep_expired_memories(root?: string | null): number;
  archive_memory(eid: string): void;
  list_memories_needing_review(root: string, limit?: number): JsonDict[];
  find_conflicting_memories(root: string, text: string, limit?: number): string[];
  link_memory_conflict(a_id: string, b_id: string): boolean;
  clear_memory_supersedes(eid: string): boolean;
  upsert_graph_entity(
    root_dir: string,
    name: string,
    entity_type?: string,
    properties?: JsonDict | null
  ): string;
  upsert_graph_relation(
    root_dir: string,
    source_name: string,
    target_name: string,
    relation_type: string,
    confidence?: number,
    source_type?: string,
    target_type?: string
  ): string;
  query_related_entities(entity_name: string, root_dir?: string, max_hops?: number): JsonDict[];
  claim_dream_run(
    root: string,
    idem_key: string,
    opts?: { owner?: string; lease_seconds?: number }
  ): [string, string];
  heartbeat_dream_run(job_id: string, opts?: { owner?: string; lease_seconds?: number }): boolean;
  finish_dream_run(
    job_id: string,
    status: string,
    opts?: {
      outcome?: string;
      proposal_id?: string;
      input_count?: number;
      tokens_used?: number;
      wall_ms?: number;
    }
  ): boolean;
  cancel_dream_run(job_id: string, opts?: { reason?: string }): boolean;
  list_dream_runs(root?: string | null, limit?: number): JsonDict[];
  update_memory_dream_time(root: string): void;
  search_memory(root: string, limit?: number): JsonDict[];
  update_memory_index(root: string, content: string): void;
}

export interface MemoryEntryOpts {
  emb?: Buffer | Uint8Array | null;
  meta?: JsonDict | null;
  mem_type?: string;
  importance?: number;
  tags?: string[] | null;
  archived?: number;
  tier?: string | null;
  hits?: number | null;
  accessed_at?: number | null;
  status?: string | null;
  confidence?: number | null;
  created_by?: string | null;
  valid_until?: number | null;
  version?: number | null;
  sensitivity?: string | null;
  source_goal_id?: string | null;
  source_event_ids?: unknown;
  valid_from?: number | null;
  supersedes?: unknown;
}

export function applyMemoryDomain(klass: typeof StorageBase): void {
  const proto = klass.prototype as unknown as Record<string, unknown>;

  // Class attributes from the source's class body (§2: class-level state is
  // behaviour).
  (proto as unknown as { MEMORY_STATUSES: readonly string[] }).MEMORY_STATUSES = [
    "candidate",
    "active",
    "stale",
    "rejected",
    "archived",
  ];
  (proto as unknown as { RECALLABLE_MEMORY_STATUSES: readonly string[] }).RECALLABLE_MEMORY_STATUSES =
    ["active", ""];
  (proto as unknown as { MEMORY_TRUST_ORDER: string }).MEMORY_TRUST_ORDER =
    "COALESCE(confidence,0.5) DESC, importance DESC, updated_at DESC";
  (proto as unknown as { MEMORY_CONTENT_SCAN_LIMIT: number }).MEMORY_CONTENT_SCAN_LIMIT = 2000;
  (proto as unknown as { MEMORY_CONFIDENCE_FLOOR: number }).MEMORY_CONFIDENCE_FLOOR = 0.05;
  (proto as unknown as { MEMORY_CONFIDENCE_CEIL: number }).MEMORY_CONFIDENCE_CEIL = 0.95;
  (proto as unknown as { DREAM_LEASE_SECONDS: number }).DREAM_LEASE_SECONDS = 180;

  proto.save_memory_entry = function (
    this: StorageBase & MemoryDomainI,
    eid: string,
    sid: string,
    root: string,
    scope: string,
    content: string,
    opts: MemoryEntryOpts = {}
  ): void {
    const self = this;
    const {
      emb = null,
      meta = null,
      mem_type = "fact",
      importance = 0.5,
      tags = null,
      archived = 0,
      tier: tier_in = "semantic",
      hits: hits_in = null,
      accessed_at: accessed_in = null,
      status: status_in = null,
      confidence: confidence_in = null,
      created_by: created_by_in = null,
      valid_until: valid_until_in = null,
      version: version_in = null,
      sensitivity: sensitivity_in = null,
      source_goal_id: source_goal_in = null,
      source_event_ids: source_events_in = null,
      valid_from: valid_from_in = null,
      supersedes: supersedes_in = null,
    } = opts;
    let tier = tier_in;
    let hits = hits_in;
    let accessed_at = accessed_in;
    let status = status_in;
    let confidence = confidence_in;
    let created_by = created_by_in;
    let version = version_in;
    let valid_until = valid_until_in;
    let sensitivity = sensitivity_in;
    let source_goal_id = source_goal_in;
    let source_event_ids: unknown = source_events_in;
    let valid_from = valid_from_in;
    let supersedes: unknown = supersedes_in;

    const c = self._db("memory");
    const now = intSeconds();
    const tags_json = pyJsonDumps(tags ?? []);
    const row = c
      .execute(
        "SELECT tier, hits, accessed_at, created_at, status, confidence," +
          " created_by, version, superseded_by, valid_until, last_confirmed_at," +
          " status_reason, sensitivity, source_goal_id, source_event_ids," +
          " valid_from, conflict_set, supersedes FROM memory_entries WHERE id=?",
        [eid]
      )
      .fetchone() as Row | null;
    let superseded_by = "";
    let status_reason = "";
    let conflict_set = "[]";
    let created: number;
    let last_confirmed: number;
    if (row !== null) {
      const existing = row as Row;
      if (tier === null || tier === "semantic") {
        // Caller left tier at its default; keep whatever the row had.
        tier = (existing["tier"] as string) || (tier as string);
      }
      if (hits === null) hits = Math.trunc(Number(existing["hits"] ?? 0));
      if (accessed_at === null) accessed_at = Math.trunc(Number(existing["accessed_at"] ?? 0));
      created = Math.trunc(Number(existing["created_at"] ?? 0)) || now;
      if (status === null) status = String(existing["status"] ?? "active");
      if (confidence === null) {
        const cv = existing["confidence"];
        confidence = cv === null || cv === undefined ? 0.5 : Number(cv);
      }
      if (created_by === null) created_by = String(existing["created_by"] ?? "");
      if (version === null) version = Math.trunc(Number(existing["version"] ?? 1));
      if (valid_until === null) valid_until = Math.trunc(Number(existing["valid_until"] ?? 0));
      superseded_by = String(existing["superseded_by"] ?? "");
      status_reason = String(existing["status_reason"] ?? "");
      last_confirmed = Math.trunc(Number(existing["last_confirmed_at"] ?? 0)) || created;
      // 0014 的来源列同样必须沿用：INSERT OR REPLACE 会把没列出来的列打回默认值。
      if (sensitivity === null) sensitivity = String(existing["sensitivity"] ?? "public");
      if (source_goal_id === null) source_goal_id = String(existing["source_goal_id"] ?? "");
      if (source_event_ids === null) source_event_ids = existing["source_event_ids"] ?? "[]";
      if (valid_from === null) valid_from = Math.trunc(Number(existing["valid_from"] ?? 0)) || created;
      conflict_set = String(existing["conflict_set"] ?? "[]") || "[]";
      if (supersedes === null) supersedes = existing["supersedes"] ?? "[]";
    } else {
      if (hits === null) hits = 0;
      if (accessed_at === null) accessed_at = 0;
      created = now;
      status = String(status ?? (archived ? "archived" : "active"));
      confidence = confidence === null ? 0.5 : Number(confidence);
      created_by = String(created_by ?? "");
      version = Math.trunc(Number(version ?? 1));
      valid_until = Math.trunc(Number(valid_until ?? 0));
      // 新写下的记忆在此刻是被确认过的：这是它唯一一次"刚刚成立"。
      last_confirmed = now;
      sensitivity = String(sensitivity ?? "public");
      source_goal_id = String(source_goal_id ?? "");
      source_event_ids = source_event_ids ?? "[]";
      // 没说从什么时候开始成立，就是从现在开始。
      valid_from = Math.trunc(Number(valid_from ?? 0)) || now;
    }
    if (typeof source_event_ids !== "string") {
      source_event_ids = pyJsonDumps(Array.from((source_event_ids as unknown[] | null) ?? []));
    }
    if (typeof supersedes !== "string") {
      supersedes = pyJsonDumps(
        ((supersedes as unknown[] | null) ?? []).map((x) => String(x))
      );
    }
    c.execute(
      "INSERT OR REPLACE INTO memory_entries " +
        "(id,session_id,root_dir,scope,content,embedding,metadata,created_at,updated_at," +
        "type,importance,tags,archived,tier,hits,accessed_at," +
        "status,confidence,created_by,version,superseded_by,valid_until," +
        "last_confirmed_at,status_reason," +
        "sensitivity,source_goal_id,source_event_ids,valid_from,conflict_set,supersedes) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        eid,
        sid,
        root,
        scope,
        content,
        emb,
        pyJsonDumps(meta ?? {}),
        created!,
        now,
        mem_type,
        importance,
        tags_json,
        archived,
        tier || "semantic",
        Math.trunc(hits!),
        Math.trunc(accessed_at!),
        String(status),
        Number(confidence),
        String(created_by),
        Math.trunc(version!),
        superseded_by,
        Math.trunc(valid_until!),
        Math.trunc(last_confirmed!),
        status_reason,
        String(sensitivity),
        String(source_goal_id),
        source_event_ids,
        Math.trunc(valid_from!),
        conflict_set,
        supersedes,
      ]
    );
    c.commit();
    // C2: archived rows leave the FTS index rather than being filtered at
    // query time.
    if (archived || !self.RECALLABLE_MEMORY_STATUSES.includes(String(status))) {
      self._fts_delete(eid);
    } else {
      self._fts_upsert(eid, root, content);
    }
  };

  proto._fts_upsert = function (
    this: StorageBase & MemoryDomainI,
    eid: string,
    root: string,
    content: string
  ): void {
    const self = this;
    if (!self.fts_enabled) return;
    let body: string;
    try {
      body = fts_document(content || "");
    } catch {
      return;
    }
    const c = self._db("memory");
    try {
      c.execute("DELETE FROM memory_fts WHERE entry_id=?", [eid]);
      if (body) {
        c.execute("INSERT INTO memory_fts (body, root_dir, entry_id) VALUES (?,?,?)", [
          body,
          root || "",
          eid,
        ]);
      }
      c.commit();
    } catch {
      // except sqlite3.OperationalError: the authoritative text is already
      // committed to memory_entries; degrade the index, keep the write.
      self.fts_enabled = false;
    }
  };

  proto._fts_delete = function (this: StorageBase & MemoryDomainI, eid: string): void {
    const self = this;
    if (!self.fts_enabled) return;
    try {
      const c = self._db("memory");
      c.execute("DELETE FROM memory_fts WHERE entry_id=?", [eid]);
      c.commit();
    } catch {
      // except sqlite3.OperationalError
      self.fts_enabled = false;
    }
  };

  proto.rebuild_memory_fts = function (
    this: StorageBase & MemoryDomainI,
    root?: string | null
  ): number {
    const self = this;
    if (!self.fts_enabled) return 0;
    const c = self._db("memory");
    // 只索引"现在还能用"的行（_memory_live_sql 判据，不是 archived=0）。
    const [live, liveParams] = self._memory_live_sql();
    let rows: Row[];
    if (root) {
      rows = c
        .execute(
          "SELECT id, root_dir, content FROM memory_entries " +
            `WHERE ${live} AND root_dir=?`,
          [...liveParams, root]
        )
        .fetchall() as Row[];
    } else {
      rows = c
        .execute(
          `SELECT id, root_dir, content FROM memory_entries WHERE ${live}`,
          liveParams
        )
        .fetchall() as Row[];
    }
    try {
      if (root) {
        c.execute("DELETE FROM memory_fts WHERE root_dir=?", [root]);
      } else {
        c.execute("DELETE FROM memory_fts");
      }
      let n = 0;
      for (const r of rows) {
        const body = fts_document(String(r["content"] ?? ""));
        if (!body) continue;
        c.execute("INSERT INTO memory_fts (body, root_dir, entry_id) VALUES (?,?,?)", [
          body,
          String(r["root_dir"] ?? ""),
          String(r["id"]),
        ]);
        n += 1;
      }
      c.commit();
      return n;
    } catch {
      // except sqlite3.OperationalError
      self.fts_enabled = false;
      return 0;
    }
  };

  proto.search_memory_fts = function (
    this: StorageBase & MemoryDomainI,
    root: string,
    match_query: string,
    limit = 20,
    session_id: string | null = null,
    branch_id: string | null = null
  ): Record<string, number> {
    const self = this;
    if (!self.fts_enabled || !match_query) return {};
    let rows: Row[];
    try {
      const [live, liveParams] = self._memory_live_sql("m.");
      const scope_clause = session_id
        ? "(m.scope != 'session' OR (m.scope = 'session' AND m.session_id = ?))"
        : "(m.scope != 'session')";
      const scope_params: unknown[] = session_id ? [session_id] : [];
      const branch_clause = branch_id
        ? "AND (m.branch_id = '' OR m.branch_id IS NULL OR m.branch_id = ?)"
        : "";
      const branch_params: unknown[] = branch_id ? [branch_id] : [];

      const query_sql =
        "SELECT f.entry_id, bm25(memory_fts) AS rank " +
        "FROM memory_fts f " +
        "JOIN memory_entries m ON m.id = f.entry_id " +
        `WHERE memory_fts MATCH ? AND f.root_dir = ? AND ${live} AND ${scope_clause} ${branch_clause} ` +
        "ORDER BY rank LIMIT ?";
      const params: unknown[] = [
        match_query,
        root || "",
        ...liveParams,
        ...scope_params,
        ...branch_params,
        Math.trunc(limit),
      ];
      rows = self._db("memory").execute(query_sql, params).fetchall() as Row[];
    } catch (e) {
      // Strictly fail-closed: never fall back to an un-scoped query when
      // session/branch scope was requested.
      console.warn(`search_memory_fts scoped query failed (fail-closed): ${e}`);
      return {};
    }
    const out: Record<string, number> = {};
    for (const r of rows) {
      out[String(r["entry_id"])] = -Number(r["rank"] ?? 0.0);
    }
    return out;
  };

  proto.touch_memory_hit = function (this: StorageBase & MemoryDomainI, eid: string): void {
    const self = this;
    const now = intSeconds();
    self
      ._db("memory")
      .execute(
        "UPDATE memory_entries SET hits = COALESCE(hits, 0) + 1, accessed_at = ? WHERE id = ?",
        [now, eid]
      );
    self._db("memory").commit();
  };

  proto.set_memory_tier = function (
    this: StorageBase & MemoryDomainI,
    eid: string,
    tier: string
  ): void {
    const self = this;
    self
      ._db("memory")
      .execute("UPDATE memory_entries SET tier = ?, updated_at = ? WHERE id = ?", [
        String(tier),
        intSeconds(),
        eid,
      ]);
    self._db("memory").commit();
  };

  proto.expire_memories_by_tier = function (
    this: StorageBase & MemoryDomainI,
    root: string,
    tier: string,
    older_than: number
  ): void {
    const self = this;
    const now = intSeconds();
    // Collect ids first: after the UPDATE the predicate no longer matches.
    const expiring = (
      self
        ._db("memory")
        .execute(
          "SELECT id FROM memory_entries " +
            "WHERE root_dir = ? AND tier = ? AND archived = 0 " +
            "AND COALESCE(NULLIF(accessed_at, 0), updated_at) < ?",
          [root, String(tier), Math.trunc(older_than)]
        )
        .fetchall() as Row[]
    ).map((r) => String(r["id"]));
    self
      ._db("memory")
      .execute(
        "UPDATE memory_entries SET archived = 1, updated_at = ?," +
          // status 必须跟着走（见源注释）。
          " status = 'archived', status_reason = 'tier_ttl_expired' " +
          "WHERE root_dir = ? AND tier = ? AND archived = 0 " +
          "AND COALESCE(NULLIF(accessed_at, 0), updated_at) < ?",
        [now, root, String(tier), Math.trunc(older_than)]
      );
    self._db("memory").commit();
    for (const eid of expiring) {
      self._fts_delete(eid);
    }
  };

  proto._memory_live_sql = function (
    this: StorageBase & MemoryDomainI,
    prefix = ""
  ): [string, unknown[]] {
    const self = this;
    // "这条现在还能用"的 WHERE 片段 + 参数（一处定义，所有读路径共用）。
    const p = prefix || "";
    const now = intSeconds();
    return [
      `COALESCE(${p}status,'active') IN ('active','')` +
        ` AND (COALESCE(${p}valid_until,0)=0 OR ${p}valid_until>?)` +
        ` AND (COALESCE(${p}valid_from,0)=0 OR ${p}valid_from<=?)`,
      [now, now],
    ];
  };

  proto.get_memory_entries = function (
    this: StorageBase & MemoryDomainI,
    root?: string | null,
    mem_type?: string | null,
    include_archived = false,
    limit: number | null = 100,
    since?: number | null
  ): JsonDict[] {
    const self = this;
    const c = self._db("memory");
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (root) {
      conditions.push("root_dir = ?");
      params.push(root);
    }
    if (mem_type) {
      conditions.push("type = ?");
      params.push(mem_type);
    }
    if (!include_archived) {
      const [live, liveParams] = self._memory_live_sql();
      conditions.push(live);
      params.push(...liveParams);
    }
    if (since) {
      conditions.push("created_at >= ?");
      params.push(since);
    }
    const where = conditions.length > 0 ? conditions.join(" AND ") : "1=1";
    // limit=null（或 <=0）移除 LIMIT 子句，返回全部匹配行。
    const unbounded = limit === null || limit === undefined || (typeof limit === "number" && limit <= 0);
    let r: Row[];
    if (unbounded) {
      r = c
        .execute(`SELECT * FROM memory_entries WHERE ${where} ORDER BY created_at DESC`, params)
        .fetchall() as Row[];
    } else {
      params.push(limit);
      r = c
        .execute(
          `SELECT * FROM memory_entries WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
          params
        )
        .fetchall() as Row[];
    }
    return r.map((x) => ({ ...(x as Row) }) as JsonDict);
  };

  proto.list_memory_roots = function (
    this: StorageBase & MemoryDomainI,
    include_archived = false
  ): JsonDict[] {
    const self = this;
    const c = self._db("memory");
    const where = include_archived ? "" : "WHERE archived = 0";
    const rows = c
      .execute(
        `SELECT root_dir, COUNT(*) AS n FROM memory_entries ${where} ` +
          "GROUP BY root_dir ORDER BY n DESC"
      )
      .fetchall() as Row[];
    return rows.map((x) => ({
      root: String(x["root_dir"] ?? ""),
      count: Math.trunc(Number(x["n"] ?? 0)),
    }));
  };

  proto.set_memory_status = function (
    this: StorageBase & MemoryDomainI,
    eid: string,
    status: string,
    opts: { reason?: string; superseded_by?: string } = {}
  ): boolean {
    const self = this;
    const { reason = "", superseded_by = "" } = opts;
    const want = String(status ?? "");
    if (!self.MEMORY_STATUSES.includes(want)) {
      console.error(`[storage] set_memory_status: unknown status ${JSON.stringify(want)} for ${eid}`);
      return false;
    }
    const c = self._db("memory");
    const row = c
      .execute(
        "SELECT root_dir, content, status, archived FROM memory_entries WHERE id=?",
        [eid]
      )
      .fetchone() as Row | null;
    if (row === null) {
      console.error(`[storage] set_memory_status: no such memory ${eid}`);
      return false;
    }
    const cur = row as Row;
    const now_status = String(
      cur["status"] ?? (Number(cur["archived"] ?? 0) ? "archived" : "active")
    );
    if (now_status === want) return true; // 幂等
    // 允许的状态转移（照抄源）。rejected 只能走向 archived；archived 可回 active。
    const MEMORY_TRANSITIONS: Record<string, ReadonlySet<string>> = {
      candidate: new Set(["active", "rejected", "archived"]),
      active: new Set(["stale", "rejected", "archived"]),
      stale: new Set(["active", "rejected", "archived"]),
      rejected: new Set(["archived"]),
      archived: new Set(["active"]),
    };
    const allowed = MEMORY_TRANSITIONS[now_status] ?? new Set<string>();
    if (!allowed.has(want)) {
      console.error(
        `[storage] refused memory status ${now_status} → ${want} on ${eid}` +
          ` (allowed: ${Array.from(allowed).sort().join(", ") || "none"}) — the write did NOT happen`
      );
      return false;
    }
    const now = intSeconds();
    c.execute(
      "UPDATE memory_entries SET status=?, status_reason=?, superseded_by=?," +
        " archived=?, updated_at=?," +
        " last_confirmed_at=CASE WHEN ?='active' THEN ? ELSE last_confirmed_at END" +
        " WHERE id=?",
      [
        want,
        String(reason || ""),
        String(superseded_by || ""),
        want === "archived" ? 1 : 0,
        now,
        want,
        now,
        eid,
      ]
    );
    c.commit();
    if (self.RECALLABLE_MEMORY_STATUSES.includes(want)) {
      self._fts_upsert(eid, String(cur["root_dir"] ?? ""), String(cur["content"] ?? ""));
    } else {
      self._fts_delete(eid);
    }
    return true;
  };

  proto.adjust_memory_confidence = function (
    this: StorageBase & MemoryDomainI,
    eid: string,
    delta: number,
    opts: { reason?: string } = {}
  ): number {
    const self = this;
    const { reason = "" } = opts;
    const c = self._db("memory");
    const row = c
      .execute("SELECT confidence FROM memory_entries WHERE id=?", [eid])
      .fetchone() as Row | null;
    if (row === null) {
      console.error(`[storage] adjust_memory_confidence: no such memory ${eid}`);
      return -1.0;
    }
    let cur: number;
    try {
      cur = Number(row["confidence"] ?? 0.5) || 0.5;
    } catch {
      // (TypeError, ValueError) -> 0.5
      cur = 0.5;
    }
    const newV = Math.max(
      self.MEMORY_CONFIDENCE_FLOOR,
      Math.min(self.MEMORY_CONFIDENCE_CEIL, cur + Number(delta || 0.0))
    );
    c.execute(
      "UPDATE memory_entries SET confidence=?, status_reason=CASE" +
        " WHEN ?<>'' THEN ? ELSE status_reason END, updated_at=?" +
        " WHERE id=?",
      [newV, String(reason || ""), String(reason || ""), intSeconds(), eid]
    );
    c.commit();
    return newV;
  };

  proto.confirm_memory = function (
    this: StorageBase & MemoryDomainI,
    eid: string,
    opts: { delta?: number } = {}
  ): boolean {
    const self = this;
    const { delta = 0.05 } = opts;
    const c = self._db("memory");
    const cur = c.execute("SELECT id FROM memory_entries WHERE id=?", [eid]).fetchone();
    if (cur === null) return false;
    c.execute(
      "UPDATE memory_entries SET last_confirmed_at=?, updated_at=? WHERE id=?",
      [intSeconds(), intSeconds(), eid]
    );
    c.commit();
    if (delta) {
      self.adjust_memory_confidence(eid, delta, { reason: "confirmed" });
    }
    return true;
  };

  proto.sweep_expired_memories = function (
    this: StorageBase & MemoryDomainI,
    root?: string | null
  ): number {
    const self = this;
    const now = intSeconds();
    const c = self._db("memory");
    let sql =
      "SELECT id FROM memory_entries WHERE valid_until>0 AND valid_until<?" +
      " AND COALESCE(status,'active')='active'";
    const params: unknown[] = [now];
    if (root) {
      sql += " AND root_dir=?";
      params.push(String(root));
    }
    const rows = (c.execute(sql, params).fetchall() as Row[]).map((r) => String(r["id"]));
    let n = 0;
    for (const eid of rows) {
      if (self.set_memory_status(eid, "stale", { reason: "valid_until_passed" })) {
        n += 1;
      }
    }
    return n;
  };

  proto.archive_memory = function (this: StorageBase & MemoryDomainI, eid: string): void {
    const self = this;
    // 实现走 set_memory_status，归档和其他状态变更同一条路。
    if (!self.set_memory_status(eid, "archived", { reason: "archive_memory" })) {
      // 转移被拒时也要保证旧契约成立：调用方点了删除，界面上就不该再出现它。
      const c = self._db("memory");
      c.execute("UPDATE memory_entries SET archived=1, updated_at=? WHERE id=?", [
        intSeconds(),
        eid,
      ]);
      c.commit();
      self._fts_delete(eid);
    }
  };

  proto.list_memories_needing_review = function (
    this: StorageBase & MemoryDomainI,
    root: string,
    limit = 20
  ): JsonDict[] {
    const self = this;
    const now = intSeconds();
    const rows = self
      ._db("memory")
      .execute(
        "SELECT * FROM memory_entries WHERE root_dir=? AND archived=0" +
          " AND COALESCE(status,'active') NOT IN ('archived','rejected')" +
          " AND COALESCE(supersedes,'[]') IN ('','[]')" +
          " AND (COALESCE(conflict_set,'[]') NOT IN ('','[]')" +
          "      OR COALESCE(status,'')='stale'" +
          "      OR (COALESCE(valid_until,0)>0 AND valid_until<=?))" +
          " ORDER BY updated_at DESC LIMIT ?",
        [String(root ?? ""), now, Math.trunc(limit)]
      )
      .fetchall() as Row[];
    return rows.map((r) => ({ ...(r as Row) }) as JsonDict);
  };

  proto.find_conflicting_memories = function (
    this: StorageBase & MemoryDomainI,
    root: string,
    text: string,
    limit = 8
  ): string[] {
    const self = this;
    // 判据只有一条且可判定：去否定词后内容等价，但否定极性相反。
    const strip = (s: unknown): string => {
      let t = String(s ?? "").replace(/(?:不|非|没有|没|无|别|莫)/g, "");
      t = t.replace(/\b(?:not|no|never|isn't|aren't|doesn't|don't|won't|cannot|can't|no\s+longer)\b/gi, "");
      return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    };
    const key = strip(text);
    if (!key) return [];
    const want_neg = hasNegation(text);
    const [live, liveParams] = self._memory_live_sql();
    const rows = self
      ._db("memory")
      .execute(
        `SELECT id, content FROM memory_entries WHERE root_dir=? AND ${live}` +
          " ORDER BY updated_at DESC LIMIT ?",
        [String(root ?? ""), ...liveParams, Math.trunc(self.MEMORY_CONTENT_SCAN_LIMIT)]
      )
      .fetchall() as Row[];
    const out: string[] = [];
    for (const r of rows) {
      const body = String(r["content"] ?? "");
      if (strip(body) !== key) continue;
      if (hasNegation(body) === want_neg) continue; // 同形同极性 = 重复，不是矛盾
      out.push(String(r["id"]));
      if (out.length >= Math.trunc(limit)) break;
    }
    return out;
  };

  proto.link_memory_conflict = function (
    this: StorageBase & MemoryDomainI,
    a_id: string,
    b_id: string
  ): boolean {
    const self = this;
    if (!a_id || !b_id || a_id === b_id) return false;
    const c = self._db("memory");
    const now = intSeconds();
    // 先把两端都查出来，再动手写（避免单边关系）。
    const rows: Record<string, string> = {};
    for (const eid of [a_id, b_id]) {
      const row = c
        .execute("SELECT conflict_set FROM memory_entries WHERE id=?", [eid])
        .fetchone() as Row | null;
      if (row === null) {
        console.error(`[storage] link_memory_conflict: no such memory ${eid}`);
        return false;
      }
      rows[eid] = String(row["conflict_set"] ?? "") || "[]";
    }
    let changed = false;
    for (const [me, other] of [
      [a_id, b_id],
      [b_id, a_id],
    ] as const) {
      let cur: string[] = [];
      try {
        const parsed = JSON.parse(rows[me]!) as unknown;
        cur = Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
      } catch {
        // (ValueError, TypeError) -> []
        cur = [];
      }
      if (cur.includes(other)) continue;
      cur.push(other);
      c.execute(
        "UPDATE memory_entries SET conflict_set=?, updated_at=? WHERE id=?",
        [pyJsonDumps(Array.from(new Set(cur)).sort()), now, me]
      );
      changed = true;
    }
    if (changed) {
      c.commit();
    }
    return true;
  };

  proto.clear_memory_supersedes = function (this: StorageBase & MemoryDomainI, eid: string): boolean {
    const self = this;
    const c = self._db("memory");
    const cur = c.execute("SELECT id FROM memory_entries WHERE id=?", [eid]).fetchone();
    if (cur === null) return false;
    c.execute("UPDATE memory_entries SET supersedes='[]', updated_at=? WHERE id=?", [
      intSeconds(),
      eid,
    ]);
    c.commit();
    return true;
  };

  // ——— Phase 59 内化: 实体关系图谱方法 (GraphMemoryEngine) ———

  proto.upsert_graph_entity = function (
    this: StorageBase & MemoryDomainI,
    root_dir: string,
    name: string,
    entity_type = "Concept",
    properties: JsonDict | null = null
  ): string {
    const self = this;
    const c = self._db("memory");
    const now = intSeconds();
    const props_json = pyJsonDumps(properties ?? {});
    const root = String(root_dir ?? "");

    const row = c
      .execute("SELECT id FROM graph_entities WHERE name=? AND root_dir=?", [name, root])
      .fetchone() as Row | null;

    if (row) {
      const eid = String(row["id"]);
      c.execute(
        "UPDATE graph_entities SET type=?, properties_json=?, updated_at=? WHERE id=?",
        [entity_type, props_json, now, eid]
      );
      c.commit();
      return eid;
    }
    const eid = uuidHex().slice(0, 16);
    c.execute(
      "INSERT INTO graph_entities (id, root_dir, type, name, properties_json, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
      [eid, root, entity_type, name, props_json, now, now]
    );
    c.commit();
    return eid;
  };

  proto.upsert_graph_relation = function (
    this: StorageBase & MemoryDomainI,
    root_dir: string,
    source_name: string,
    target_name: string,
    relation_type: string,
    confidence = 1.0,
    source_type = "Concept",
    target_type = "Concept"
  ): string {
    const self = this;
    const c = self._db("memory");
    const now = intSeconds();
    const root = String(root_dir ?? "");

    const src_id = self.upsert_graph_entity(root, source_name, source_type);
    const tgt_id = self.upsert_graph_entity(root, target_name, target_type);

    const row = c
      .execute(
        "SELECT id FROM graph_relations WHERE source_id=? AND target_id=? AND relation_type=?",
        [src_id, tgt_id, relation_type]
      )
      .fetchone() as Row | null;

    if (row) {
      const rel_id = String(row["id"]);
      c.execute("UPDATE graph_relations SET confidence=? WHERE id=?", [confidence, rel_id]);
      c.commit();
      return rel_id;
    }
    const rel_id = uuidHex().slice(0, 16);
    c.execute(
      "INSERT INTO graph_relations (id, root_dir, source_id, target_id, relation_type, confidence, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
      [rel_id, root, src_id, tgt_id, relation_type, confidence, now]
    );
    c.commit();
    return rel_id;
  };

  proto.query_related_entities = function (
    this: StorageBase & MemoryDomainI,
    entity_name: string,
    root_dir = "",
    max_hops = 2
  ): JsonDict[] {
    const self = this;
    void max_hops; // 源码同样未使用该参数（保留签名）
    const c = self._db("memory");
    const root = String(root_dir ?? "");

    const start_row = c
      .execute(
        "SELECT id, name, type, properties_json FROM graph_entities WHERE name=? AND (root_dir=? OR root_dir='')",
        [entity_name, root]
      )
      .fetchone() as Row | null;
    if (!start_row) return [];

    const start_id = String(start_row["id"]);
    const results: JsonDict[] = [];

    const edges = c
      .execute(
        "SELECT r.relation_type, r.confidence, e.name, e.type, e.properties_json " +
          "FROM graph_relations r " +
          "JOIN graph_entities e ON r.target_id = e.id " +
          "WHERE r.source_id = ?",
        [start_id]
      )
      .fetchall() as Row[];

    for (const edge of edges) {
      results.push({
        source: entity_name,
        relation: edge["relation_type"],
        target: edge["name"],
        target_type: edge["type"],
        confidence: edge["confidence"],
        properties: JSON.parse(String(edge["properties_json"] ?? "{}")),
      });
    }

    const rev_edges = c
      .execute(
        "SELECT r.relation_type, r.confidence, e.name, e.type, e.properties_json " +
          "FROM graph_relations r " +
          "JOIN graph_entities e ON r.source_id = e.id " +
          "WHERE r.target_id = ?",
        [start_id]
      )
      .fetchall() as Row[];

    for (const edge of rev_edges) {
      results.push({
        source: edge["name"],
        relation: edge["relation_type"],
        target: entity_name,
        source_type: edge["type"],
        confidence: edge["confidence"],
        properties: JSON.parse(String(edge["properties_json"] ?? "{}")),
      });
    }

    return results;
  };

  // ——— Dream run leases ———

  proto.claim_dream_run = function (
    this: StorageBase & MemoryDomainI,
    root: string,
    idem_key: string,
    opts: { owner?: string; lease_seconds?: number } = {}
  ): [string, string] {
    const self = this;
    const { owner = "", lease_seconds = 0 } = opts;
    const c = self._db("memory");
    const now = intSeconds();
    const ttl = Math.trunc(lease_seconds || self.DREAM_LEASE_SECONDS);
    const own = String(owner || PROCESS_GENERATION);
    const key = String(idem_key || "");

    if (key) {
      const row = c
        .execute("SELECT job_id, status, lease_until FROM dream_runs WHERE idem_key=?", [key])
        .fetchone() as Row | null;
      if (row !== null) {
        const d = row as Row;
        if (String(d["status"]) !== "running") return ["", "done"];
        if (Math.trunc(Number(d["lease_until"] ?? 0)) > now) return ["", "busy"];
        // 租约过期 = 上一趟的进程没了。owner 条件保证同时只有一个接管者。
        const cur = c.execute(
          "UPDATE dream_runs SET owner=?, lease_until=?, heartbeat_at=?" +
            " WHERE job_id=? AND status='running' AND COALESCE(lease_until,0)<=?",
          [own, now + ttl, now, String(d["job_id"]), now]
        );
        c.commit();
        if (cur.rowcount > 0) return [String(d["job_id"]), "resumed"];
        return ["", "busy"];
      }
    }

    const job_id = uuidHex().slice(0, 16);
    try {
      c.execute(
        "INSERT INTO dream_runs (job_id, root_dir, idem_key, status, owner," +
          " started_at, heartbeat_at, lease_until)" +
          " VALUES (?,?,?,'running',?,?,?,?)",
        [job_id, String(root ?? ""), key, own, now, now, now + ttl]
      );
      c.commit();
    } catch (exc) {
      // sqlite3.IntegrityError（唯一索引冲突）→ 另一个进程先到了，它该等。
      const msg = exc instanceof Error ? exc.message : String(exc);
      if (!/unique|constraint/i.test(msg)) {
        throw exc;
      }
      return ["", "busy"];
    }
    return [job_id, "new"];
  };

  proto.heartbeat_dream_run = function (
    this: StorageBase & MemoryDomainI,
    job_id: string,
    opts: { owner?: string; lease_seconds?: number } = {}
  ): boolean {
    const self = this;
    const { owner = "", lease_seconds = 0 } = opts;
    const c = self._db("memory");
    const now = intSeconds();
    const ttl = Math.trunc(lease_seconds || self.DREAM_LEASE_SECONDS);
    const cur = c.execute(
      "UPDATE dream_runs SET heartbeat_at=?, lease_until=?" +
        " WHERE job_id=? AND owner=? AND status='running'",
      [now, now + ttl, job_id, String(owner || PROCESS_GENERATION)]
    );
    c.commit();
    return cur.rowcount > 0;
  };

  proto.finish_dream_run = function (
    this: StorageBase & MemoryDomainI,
    job_id: string,
    status: string,
    opts: {
      outcome?: string;
      proposal_id?: string;
      input_count?: number;
      tokens_used?: number;
      wall_ms?: number;
    } = {}
  ): boolean {
    const self = this;
    const { outcome = "", proposal_id = "", input_count = 0, tokens_used = 0, wall_ms = 0 } = opts;
    const c = self._db("memory");
    const cur = c.execute(
      "UPDATE dream_runs SET status=?, finished_at=?, outcome=?," +
        " proposal_id=?, input_count=?, tokens_used=?, wall_ms=?, lease_until=0" +
        " WHERE job_id=?",
      [
        String(status || "done"),
        intSeconds(),
        String(outcome || ""),
        String(proposal_id || ""),
        Math.trunc(input_count || 0),
        Math.trunc(tokens_used || 0),
        Math.trunc(wall_ms || 0),
        job_id,
      ]
    );
    c.commit();
    return cur.rowcount > 0;
  };

  proto.cancel_dream_run = function (
    this: StorageBase & MemoryDomainI,
    job_id: string,
    opts: { reason?: string } = {}
  ): boolean {
    const self = this;
    const { reason = "user_cancelled" } = opts;
    const c = self._db("memory");
    const cur = c.execute(
      "UPDATE dream_runs SET status='cancelled', finished_at=?, outcome=?," +
        " lease_until=0 WHERE job_id=? AND status='running'",
      [intSeconds(), String(reason || ""), job_id]
    );
    c.commit();
    return cur.rowcount > 0;
  };

  proto.list_dream_runs = function (
    this: StorageBase & MemoryDomainI,
    root?: string | null,
    limit = 20
  ): JsonDict[] {
    const self = this;
    const c = self._db("memory");
    let sql = "SELECT * FROM dream_runs";
    const params: unknown[] = [];
    if (root !== null && root !== undefined) {
      sql += " WHERE root_dir=?";
      params.push(String(root));
    }
    sql += " ORDER BY started_at DESC LIMIT ?";
    params.push(Math.trunc(limit || 20));
    return (c.execute(sql, params).fetchall() as Row[]).map((r) => ({ ...(r as Row) }) as JsonDict);
  };

  proto.update_memory_dream_time = function (this: StorageBase & MemoryDomainI, root: string): void {
    const self = this;
    const c = self._db("memory");
    const now = intSeconds();
    c.execute("UPDATE project_memory_index SET last_dream_at=? WHERE root_dir=?", [now, root]);
    c.commit();
  };

  proto.search_memory = function (
    this: StorageBase & MemoryDomainI,
    root: string,
    limit = 5
  ): JsonDict[] {
    const self = this;
    const [live, liveParams] = self._memory_live_sql();
    const rows = self
      ._db("memory")
      .execute(
        `SELECT * FROM memory_entries WHERE root_dir=? AND ${live}` +
          " ORDER BY updated_at DESC LIMIT ?",
        [root, ...liveParams, Math.trunc(limit)]
      )
      .fetchall() as Row[];
    return rows.map((x) => ({ ...(x as Row) }) as JsonDict);
  };

  proto.update_memory_index = function (
    this: StorageBase & MemoryDomainI,
    root: string,
    content: string
  ): void {
    const self = this;
    const c = self._db("memory");
    const now = intSeconds();
    c.execute(
      "INSERT OR REPLACE INTO project_memory_index (id,root_dir,index_content,last_extract_at,version) VALUES ((SELECT id FROM project_memory_index WHERE root_dir=?),?,?,?,(SELECT COALESCE(version,0)+1 FROM project_memory_index WHERE root_dir=?))",
      [root, root, content, now, root]
    );
    c.commit();
  };
}
