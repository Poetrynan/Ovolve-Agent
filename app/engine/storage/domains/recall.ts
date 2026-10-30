/**
 * recall.ts — storage domain mixin: hybrid retrieval, embedding cache,
 * session FTS, episodes, learning items + their operation ledger.
 *
 * Ported from `app/backend/storage.py` lines 4715–5878 (M6 domain).
 *
 * RULEBOOK CITATIONS:
 * - §1 node: builtins only (node:crypto for the cache key hash).
 * - §2 Python `round` (banker's rounding) → pythonRound helper; `fuse`/
 *   `declare_channels`/`retrieval_trace` follow the rust_adapters
 *   pure-Python spec (the Rust path returns the same values).
 * - §2 `except Exception: pass` swallows preserved verbatim with comments;
 *   `except sqlite3.OperationalError: disable flag` degrade paths preserved.
 * - §2 set-derived iteration (`set(nv) | set(nk)` in fuse) — union iterated
 *   in sorted order where output order is observable; fuse sorts output
 *   best-first explicitly, matching the source's explicit sort.
 * - §4 naming: part of the storage unit (storage.py → storage/domains/).
 *
 * PORT STATUS: confidence=medium todos=0
 */

import * as crypto from "node:crypto";

import type { Row, JsonDict } from "../storage_types.js";
import { StorageBase, intSeconds } from "../../storage.js";
import { pyJsonDumps } from "../storage_funcs.js";
import { fts_document, build_fts_query } from "../../fts_support.js";

export interface RecallDomainI {
  EMBEDDING_CACHE_MAX_ROWS: number;
  find_memories_by_content(root: string, text: string, limit?: number): string[];
  search_memory_hybrid(
    root: string,
    query_text?: string,
    query_embedding?: number[] | null,
    keywords?: string[] | null,
    limit?: number,
    vector_weight?: number | null,
    keyword_weight?: number | null,
    session_id?: string,
    branch_id?: string
  ): [JsonDict[], string[]];
  memory_fts_stats(): JsonDict;
  memory_embedding_stats(root: string): JsonDict;
  memories_missing_embeddings(root: string, limit?: number): JsonDict[];
  set_memory_embedding(eid: string, emb_blob: Buffer | Uint8Array | null): boolean;
  search_memory_semantic(
    root: string,
    query_embedding?: number[] | null,
    keywords?: string[] | null,
    limit?: number,
    session_id?: string,
    branch_id?: string
  ): JsonDict[];
  _trust_of(row: Row): number;
  embedding_cache_key(provider: string, model: string, text: string): string;
  get_cached_embedding(provider: string, model: string, text: string): number[] | null;
  flush_embedding_cache_hits(): void;
  save_cached_embedding(provider: string, model: string, text: string, vector: number[]): void;
  _prune_embedding_cache(): void;
  clear_embedding_cache(model?: string | null): number;
  embedding_cache_stats(): JsonDict;
  _keyword_score(content: string, keywords: string[] | null): number;
  _decode_embedding(blob: unknown): number[] | null;
  _cosine(a: number[], b: number[]): number;
  save_session_synthesis(session_id: string, synthesis: JsonDict): void;
  get_session_synthesis(session_id: string): JsonDict | null;
  get_workspace_recent_synthesis(workspace: string, exclude_session?: string, limit?: number): JsonDict[];
  _session_fts_upsert(session_id: string, message_id: string, content: string): void;
  rebuild_session_fts(): number;
  search_sessions_fts(
    query: string,
    workspace_or_opts?: string | { workspace?: string; limit?: number },
    limit?: number
  ): JsonDict[];
  update_memory_dream_time(root: string): void;
  search_memory(root: string, limit?: number): JsonDict[];
  update_memory_index(root: string, content: string): void;
  create_episode(
    session_id: string,
    topic?: string,
    goal_id?: string,
    branch_id?: string,
    metadata?: JsonDict | null,
    episode_id?: string
  ): string;
  get_episode(episode_id: string): JsonDict | null;
  get_active_episode(
    session_id_or_opts: string | { session_id?: string; branch_id?: string },
    branch_id?: string
  ): JsonDict | null;
  seal_episode(
    episode_id: string,
    reason?: string,
    event_id?: string,
    metadata?: JsonDict | null
  ): boolean;
  list_episodes(
    session_id_or_opts?:
      | string
      | { session_id?: string; branch_id?: string | null; limit?: number },
    branch_id?: string | null,
    limit?: number
  ): JsonDict[];
  list_active_episodes(limit?: number): JsonDict[];
  append_turn_to_episode(episode_id: string, turn_id: string): boolean;
  insert_learning_item(kwargs: Record<string, unknown>): string;
  get_learning_item(item_id: string): JsonDict | null;
  list_learning_items(
    session_id_or_opts?:
      | string
      | { session_id?: string; branch_id?: string | null; limit?: number },
    branch_id?: string | null,
    episode_id?: string,
    bundle_id?: string,
    status?: string,
    limit?: number
  ): JsonDict[];
  update_learning_item(
    item_id: string,
    status?: string | null,
    user_verdict?: string | null,
    deferred_reason?: string | null,
    content?: string | null,
    operation_id?: string | null,
    idempotency_key?: string | null,
    expected_version?: number | null
  ): boolean;
  record_learning_item_operation(
    operation_id: string,
    item_id: string,
    action: string,
    idempotency_key?: string,
    status?: string,
    payload?: JsonDict | null,
    result?: JsonDict | null,
    error?: string
  ): boolean;
  get_learning_item_operation_by_key(idempotency_key: string): JsonDict | null;
  get_learning_item_operation(operation_id: string): JsonDict | null;
  claim_learning_item_operation(
    operation_id: string,
    item_id: string,
    action: string,
    idempotency_key?: string,
    payload?: JsonDict | null
  ): [boolean, JsonDict];
  update_learning_item_operation(
    operation_id: string,
    status?: string | null,
    result?: JsonDict | null,
    error?: string | null
  ): boolean;
  list_hanging_learning_item_operations(limit?: number): JsonDict[];
}

// ——— retrieval kernel constants (memory_retrieval.py, verbatim) ———
const OVERSAMPLE = 4;
const VECTOR_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;
const MIN_FUSED_SCORE = 0.02;
const _DEFAULT_VECTOR_WEIGHT = 0.7;
const _DEFAULT_KEYWORD_WEIGHT = 0.3;

/** Python round(x, digits) — banker's rounding (half to even). */
function pythonRound(x: number, digits: number): number {
  const m = Math.pow(10, digits);
  const y = x * m;
  const floor = Math.floor(y);
  const diff = y - floor;
  let rounded: number;
  if (diff > 0.5) rounded = floor + 1;
  else if (diff < 0.5) rounded = floor;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  return rounded / m;
}

// ——— rust_adapters/memory_retrieval.py pure-Python spec ———

function normalize_scores(scores: Record<string, number>): Record<string, number> {
  const keys = Object.keys(scores);
  if (keys.length === 0) return {};
  const vals = keys.map((k) => scores[k]!);
  const min_v = Math.min(...vals);
  const max_v = Math.max(...vals);
  const range_v = max_v - min_v;
  if (range_v < 1e-10) {
    const out: Record<string, number> = {};
    for (const k of keys) out[k] = 1.0;
    return out;
  }
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (scores[k]! - min_v) / range_v;
  return out;
}

type FusedEntry = [string, number, { vec: number; kw: number }];

function fuse(
  vector_scores: Record<string, number>,
  keyword_scores: Record<string, number>,
  vector_weight: number,
  keyword_weight: number
): FusedEntry[] {
  const nv = normalize_scores(vector_scores);
  const nk = normalize_scores(keyword_scores);
  let wv = vector_weight;
  let wk = keyword_weight;
  const nvKeys = Object.keys(nv);
  const nkKeys = Object.keys(nk);
  if (nvKeys.length === 0 && nkKeys.length === 0) return [];
  if (nvKeys.length === 0) {
    wv = 0.0;
    wk = 1.0;
  } else if (nkKeys.length === 0) {
    wv = 1.0;
    wk = 0.0;
  } else {
    const total = wv + wk;
    if (total > 0) {
      wv = wv / total;
      wk = wk / total;
    }
  }
  // set(nv) | set(nk) — union; output is explicitly sorted below, so
  // iteration order here does not leak (RULEBOOK §2).
  const union = new Set([...nvKeys, ...nkKeys]);
  const out: FusedEntry[] = [];
  for (const key of union) {
    const v = nv[key] ?? 0.0;
    const k = nk[key] ?? 0.0;
    out.push([key, wv * v + wk * k, { vec: v, kw: k }]);
  }
  out.sort((a, b) => b[1] - a[1]);
  return out;
}

function declare_channels(
  vector_scores: Record<string, number>,
  keyword_scores: Record<string, number>,
  vector_weight: number,
  keyword_weight: number,
  embedded_rows: number | null,
  total_rows: number | null
): JsonDict {
  const vec_live = Object.keys(vector_scores).length > 0;
  const kw_live = Object.keys(keyword_scores).length > 0;
  let wv = vector_weight;
  let wk = keyword_weight;
  let mode: string;
  if (!vec_live && !kw_live) {
    wv = 0.0;
    wk = 0.0;
    mode = "none";
  } else if (!vec_live) {
    wv = 0.0;
    wk = 1.0;
    mode = "keyword_only";
  } else if (!kw_live) {
    wv = 1.0;
    wk = 0.0;
    mode = "vector_only";
  } else {
    const total = wv + wk;
    if (total > 0) {
      wv = wv / total;
      wk = wk / total;
    }
    mode = "hybrid";
  }
  const report: JsonDict = {
    mode,
    vectorLive: vec_live,
    keywordLive: kw_live,
    vectorCandidates: Object.keys(vector_scores).length,
    keywordCandidates: Object.keys(keyword_scores).length,
    effectiveVectorWeight: pythonRound(wv, 4),
    effectiveKeywordWeight: pythonRound(wk, 4),
    nominalVectorWeight: pythonRound(vector_weight, 4),
    nominalKeywordWeight: pythonRound(keyword_weight, 4),
    degraded: mode !== "hybrid",
  };
  if (total_rows !== null) {
    report["rows"] = Math.trunc(total_rows);
    report["embeddedRows"] = Math.trunc(embedded_rows ?? 0);
    report["embeddingCoverage"] =
      total_rows !== null && total_rows !== undefined && total_rows > 0
        ? pythonRound((embedded_rows ?? 0) / total_rows, 4)
        : 0.0;
    // The distinction the panel needs: a query that simply had no semantic
    // neighbours, versus a corpus that was never embedded at all.
    report["vectorUnavailable"] = !(embedded_rows ?? 0);
  }
  return report;
}

function describe_channels(report: JsonDict): string {
  if (!report || Object.keys(report).length === 0) return "";
  const parts = [
    `mode=${report["mode"]}`,
    `vec=${report["vectorLive"] ? "on" : "off"}(${report["vectorCandidates"] ?? 0} cand, w=${report["effectiveVectorWeight"] ?? 0.0})`,
    `kw=${report["keywordLive"] ? "on" : "off"}(${report["keywordCandidates"] ?? 0} cand, w=${report["effectiveKeywordWeight"] ?? 0.0})`,
  ];
  if ("embeddedRows" in report) {
    parts.push(`embedded=${report["embeddedRows"]}/${report["rows"] ?? 0}`);
  }
  return "channels: " + parts.join(" ");
}

function retrieval_trace(
  fused: FusedEntry[],
  limit = 10,
  channels?: JsonDict | null
): string[] {
  const lines: string[] = [];
  if (channels) {
    const head = describe_channels(channels);
    if (head) lines.push(head);
  }
  fused.slice(0, limit).forEach(([key, score, parts], i) => {
    const rank = i + 1;
    const origin =
      parts.vec > 0 && parts.kw > 0
        ? "both"
        : parts.vec > 0
          ? "vector-only"
          : "keyword-only";
    lines.push(
      `#${rank} ${key} fused=${score.toFixed(3)} vec=${parts.vec.toFixed(3)} kw=${parts.kw.toFixed(3)} (${origin})`
    );
  });
  return lines;
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export function applyRecallDomain(klass: typeof StorageBase): void {
  const proto = klass.prototype as unknown as Record<string, unknown>;

  (proto as unknown as { EMBEDDING_CACHE_MAX_ROWS: number }).EMBEDDING_CACHE_MAX_ROWS = 20000;

  proto.find_memories_by_content = function (
    this: StorageBase & RecallDomainI,
    root: string,
    text: string,
    limit = 20
  ): string[] {
    const self = this;
    // 比较前归一化（去空白/标点、小写）；刻意只认等价而不做模糊匹配。
    const norm = (s: unknown): string =>
      String(s ?? "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "");
    const target = norm(text);
    if (!target) return [];
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
      if (norm(r["content"]) === target) {
        out.push(String(r["id"]));
        if (out.length >= Math.trunc(limit)) break;
      }
    }
    return out;
  };

  proto.search_memory_hybrid = function (
    this: StorageBase & RecallDomainI,
    root: string,
    query_text = "",
    query_embedding: number[] | null = null,
    keywords: string[] | null = null,
    limit = 5,
    vector_weight: number | null = null,
    keyword_weight: number | null = null,
    session_id = "",
    branch_id = ""
  ): [JsonDict[], string[]] {
    const self = this;
    // The source imports the kernels lazily and falls back to semantic-only on
    // ImportError; the TS kernels are module-level (no import can fail), so
    // the fallback branch is structurally unreachable here. Semantics of the
    // taken path are preserved 1:1.
    const pool = Math.max(Math.trunc(limit) * OVERSAMPLE, Math.trunc(limit));
    const c = self._db("memory");
    const [live, liveParams] = self._memory_live_sql();
    const scope_clause = session_id
      ? "(scope != 'session' OR (scope = 'session' AND session_id = ?))"
      : "(scope != 'session')";
    const scope_params: unknown[] = session_id ? [session_id] : [];
    const branch_clause = branch_id
      ? "AND (branch_id = '' OR branch_id IS NULL OR branch_id = ?)"
      : "";
    const branch_params: unknown[] = branch_id ? [branch_id] : [];

    // 1. Lexical channel via FTS5
    const kw_scores: Record<string, number> = self.search_memory_fts(
      root,
      build_fts_query(query_text || "", keywords ?? undefined),
      pool,
      session_id,
      branch_id
    );
    const fts_ids = Object.keys(kw_scores);

    // 2. Bounded candidate rows for the dense channel
    const dense_candidate_limit = Math.max(pool * 4, 100);
    const base_where = `root_dir=? AND ${live} AND ${scope_clause} ${branch_clause}`;
    const all_params: unknown[] = [root, ...liveParams, ...scope_params, ...branch_params];

    const candidate_rows = c
      .execute(
        `SELECT * FROM memory_entries WHERE ${base_where} ORDER BY importance DESC, updated_at DESC LIMIT ?`,
        [...all_params, dense_candidate_limit]
      )
      .fetchall() as Row[];
    const rows = new Map<string, JsonDict>();
    for (const r of candidate_rows) rows.set(String(r["id"]), { ...(r as Row) } as JsonDict);

    // Ensure all FTS hits are in the evaluation pool
    const missing_fts_ids = fts_ids.filter((fid) => !rows.has(fid));
    if (missing_fts_ids.length > 0) {
      const placeholders = missing_fts_ids.map(() => "?").join(",");
      const extra_rows = c
        .execute(
          `SELECT * FROM memory_entries WHERE id IN (${placeholders}) AND ${base_where}`,
          [...missing_fts_ids, ...all_params]
        )
        .fetchall() as Row[];
      for (const r of extra_rows) rows.set(String(r["id"]), { ...(r as Row) } as JsonDict);
    }

    if (rows.size === 0) return [[], []];

    // dense channel
    const vec_scores: Record<string, number> = {};
    if (query_embedding !== null) {
      for (const [eid, row] of rows) {
        const emb = self._decode_embedding(row["embedding"]);
        if (emb) {
          const sim = self._cosine(query_embedding, emb);
          if (sim > 0) vec_scores[eid] = sim;
        }
      }
      const keys = Object.keys(vec_scores);
      if (keys.length > pool) {
        const kept = keys
          .sort((a, b) => vec_scores[b]! - vec_scores[a]!)
          .slice(0, pool);
        for (const k of keys) {
          if (!kept.includes(k)) delete vec_scores[k];
        }
      }
    }

    // Lexical fallback when FTS is empty or keywords provided
    if (Object.keys(kw_scores).length === 0 && keywords) {
      for (const [eid, row] of rows) {
        const n = self._keyword_score(String(row["content"] ?? ""), keywords);
        if (n) kw_scores[eid] = Number(n);
      }
    }
    for (const k of Object.keys(kw_scores)) {
      if (!rows.has(k)) delete kw_scores[k];
    }

    const wv0 = vector_weight ?? VECTOR_WEIGHT;
    const wk0 = keyword_weight ?? KEYWORD_WEIGHT;
    const fused = fuse(vec_scores, kw_scores, wv0, wk0);
    const embedded = Array.from(rows.values()).filter((r) => !!r["embedding"]).length;
    const channels = declare_channels(vec_scores, kw_scores, wv0, wk0, embedded, rows.size);
    if (fused.length === 0) {
      // 两个通道都没打中时的兜底：给最重要、最可信、最近动过的那些。
      // 注：这里源用 _memory_live_sql 判据（0013 之后的口径），不是 archived=0。
      const r = c
        .execute(
          `SELECT * FROM memory_entries WHERE root_dir=? AND ${live} AND ${scope_clause} ` +
            `ORDER BY ${self.MEMORY_TRUST_ORDER} LIMIT ?`,
          [root, ...liveParams, ...scope_params, pool]
        )
        .fetchall() as Row[];
      return [r.map((x) => ({ ...(x as Row) }) as JsonDict), retrieval_trace([], pool, channels)];
    }

    const out: JsonDict[] = [];
    for (const [eid, score, parts] of fused) {
      if (score < MIN_FUSED_SCORE) continue;
      const row = rows.get(eid)!;
      row["_fused"] = pythonRound(score, 6);
      row["_vec_score"] = pythonRound(parts.vec, 6);
      row["_kw_score"] = pythonRound(parts.kw, 6);
      row["_channels"] = channels;
      out.push(row);
      if (out.length >= pool) break;
    }
    return [out, retrieval_trace(fused, pool, channels)];
  };

  proto.memory_fts_stats = function (this: StorageBase & RecallDomainI): JsonDict {
    const self = this;
    // Index health: whether FTS5 is live and how many rows are indexed.
    if (!self.fts_enabled) {
      return { enabled: false, indexed: 0 };
    }
    try {
      const row = self
        ._db("memory")
        .execute("SELECT COUNT(*) AS n FROM memory_fts")
        .fetchone() as Row;
      return { enabled: true, indexed: Math.trunc(Number(row["n"] ?? 0)) };
    } catch {
      // except sqlite3.OperationalError: disable FTS and report off
      self.fts_enabled = false;
      return { enabled: false, indexed: 0 };
    }
  };

  proto.memory_embedding_stats = function (
    this: StorageBase & RecallDomainI,
    root: string
  ): JsonDict {
    const self = this;
    try {
      const row = self
        ._db("memory")
        .execute(
          "SELECT COUNT(*) AS total, " +
            "SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded " +
            "FROM memory_entries WHERE root_dir=? AND archived=0",
          [root]
        )
        .fetchone() as Row;
      const total = Math.trunc(Number(row["total"] ?? 0));
      const embedded = Math.trunc(Number(row["embedded"] ?? 0));
      return {
        rows: total,
        embedded,
        coverage: total ? pythonRound(embedded / total, 4) : 0.0,
        // "Usable" means the channel can contribute at all, not that it is complete.
        vectorUsable: embedded > 0,
      };
    } catch {
      // except sqlite3.OperationalError
      return { rows: 0, embedded: 0, coverage: 0.0, vectorUsable: false };
    }
  };

  proto.memories_missing_embeddings = function (
    this: StorageBase & RecallDomainI,
    root: string,
    limit = 200
  ): JsonDict[] {
    const self = this;
    try {
      const rows = self
        ._db("memory")
        .execute(
          "SELECT id, content FROM memory_entries " +
            "WHERE root_dir=? AND archived=0 AND embedding IS NULL " +
            "ORDER BY created_at ASC LIMIT ?",
          [root, Math.trunc(limit)]
        )
        .fetchall() as Row[];
      return rows.map((r) => ({ ...(r as Row) }) as JsonDict);
    } catch {
      // except sqlite3.OperationalError
      return [];
    }
  };

  proto.set_memory_embedding = function (
    this: StorageBase & RecallDomainI,
    eid: string,
    emb_blob: Buffer | Uint8Array | null
  ): boolean {
    const self = this;
    try {
      const c = self._db("memory");
      c.execute("UPDATE memory_entries SET embedding=? WHERE id=?", [emb_blob, eid]);
      c.commit();
      return true;
    } catch {
      // except sqlite3.OperationalError
      return false;
    }
  };

  proto.search_memory_semantic = function (
    this: StorageBase & RecallDomainI,
    root: string,
    query_embedding: number[] | null = null,
    keywords: string[] | null = null,
    limit = 5,
    session_id = "",
    branch_id = ""
  ): JsonDict[] {
    const self = this;
    const c = self._db("memory");
    const [live, liveParams] = self._memory_live_sql();
    const conditions: string[] = ["root_dir = ?", live];
    const params: unknown[] = [root, ...liveParams];
    if (session_id) {
      conditions.push("(scope != 'session' OR (scope = 'session' AND session_id = ?))");
      params.push(session_id);
    } else {
      conditions.push("(scope != 'session')");
    }
    if (branch_id) {
      conditions.push("(branch_id = '' OR branch_id IS NULL OR branch_id = ?)");
      params.push(branch_id);
    }
    const base_where = conditions.join(" AND ");

    if (query_embedding !== null) {
      const rows = (c.execute(`SELECT * FROM memory_entries WHERE ${base_where}`, params).fetchall() as Row[]).map(
        (x) => ({ ...(x as Row) }) as JsonDict
      );
      const scored: Array<[number, JsonDict]> = [];
      for (const row of rows) {
        const emb = self._decode_embedding(row["embedding"]);
        const sim = emb
          ? self._cosine(query_embedding, emb)
          : 0.4 * self._keyword_score(String(row["content"] ?? ""), keywords);
        scored.push([sim, row]);
      }
      // 同分时先看可信度再看重要性。
      scored.sort(
        (a, b) =>
          b[0] - a[0] ||
          self._trust_of(b[1] as Row) - self._trust_of(a[1] as Row) ||
          Number(b[1]["importance"] ?? 0) - Number(a[1]["importance"] ?? 0)
      );
      return scored.slice(0, Math.trunc(limit)).filter(([sim]) => sim > 0).map(([, row]) => row);
    }

    if (keywords) {
      const kw_conditions = [...conditions];
      const kw_params = [...params];
      const ors = keywords.map(() => "content LIKE ?").join(" OR ");
      kw_conditions.push(`(${ors})`);
      kw_params.push(...keywords.map((kw) => `%${kw}%`));
      const where = kw_conditions.join(" AND ");
      const rows = (c.execute(`SELECT * FROM memory_entries WHERE ${where}`, kw_params).fetchall() as Row[]).map(
        (x) => ({ ...(x as Row) }) as JsonDict
      );
      rows.sort(
        (a, b) =>
          self._keyword_score(String(b["content"] ?? ""), keywords) -
            self._keyword_score(String(a["content"] ?? ""), keywords) ||
          self._trust_of(b as Row) - self._trust_of(a as Row) ||
          Number(b["importance"] ?? 0) - Number(a["importance"] ?? 0) ||
          Number(b["updated_at"] ?? 0) - Number(a["updated_at"] ?? 0)
      );
      return rows.slice(0, Math.trunc(limit));
    }

    const r = c
      .execute(
        `SELECT * FROM memory_entries WHERE ${base_where}` +
          ` ORDER BY ${self.MEMORY_TRUST_ORDER} LIMIT ?`,
        [...params, Math.trunc(limit)]
      )
      .fetchall() as Row[];
    return r.map((x) => ({ ...(x as Row) }) as JsonDict);
  };

  proto._trust_of = function (this: StorageBase & RecallDomainI, row: Row): number {
    // DIVERGENCE(port): production routes through ovolve_core.storage_engine
    // (Rust — `_HAS_RUST` probes True on this machine). Parity probe
    // tmp/se_parity3.py: on the ONLY shape callers pass (a dict row), Rust
    // and the pure spec agree everywhere, and this body matches both.
    // Bounds follow the spec exactly: 0.0 < v <= 1.0, else 0.5 (v=0 and -0
    // ARE 0.5 — an earlier draft wrongly kept them; fixed).
    const v = Number(row["confidence"] ?? NaN);
    if (!Number.isFinite(v) || !(v > 0) || v > 1) return 0.5;
    return v;
  };

  proto.embedding_cache_key = function (
    this: StorageBase & RecallDomainI,
    provider: string,
    model: string,
    text: string
  ): string {
    // The text is hashed so the cache never becomes a second copy of the
    // user's conversation on disk.
    const digest = sha256Hex(text || "");
    return `${provider || "local"}|${model || "default"}|${digest}`;
  };

  proto.get_cached_embedding = function (
    this: StorageBase & RecallDomainI,
    provider: string,
    model: string,
    text: string
  ): number[] | null {
    const self = this;
    const key = self.embedding_cache_key(provider, model, text);
    const c = self._db("memory");
    const row = c.execute("SELECT vector FROM embedding_cache WHERE key=?", [key]).fetchone() as
      | Row
      | null;
    if (row === null || !row["vector"]) return null;
    let vec: unknown;
    try {
      vec = JSON.parse(Buffer.from(row["vector"] as Buffer).toString("utf-8"));
    } catch {
      // Corrupt row — drop it so the next call recomputes cleanly.
      c.execute("DELETE FROM embedding_cache WHERE key=?", [key]);
      c.commit();
      return null;
    }
    if (!Array.isArray(vec) || vec.length === 0) return null;

    // Record hit in-memory; flush when the buffer reaches 20. Node's event
    // loop serializes access — the source's threading.Lock is structurally
    // unnecessary here (RULEBOOK §2, same reasoning as path_lock.ts).
    self.emb_hits_buffer.set(key, (self.emb_hits_buffer.get(key) ?? 0) + 1);
    if (self.emb_hits_buffer.size >= 20) {
      self.flush_embedding_cache_hits();
    }
    return vec as number[];
  };

  proto.flush_embedding_cache_hits = function (this: StorageBase & RecallDomainI): void {
    const self = this;
    if (self.emb_hits_buffer.size === 0) return;
    const items = Array.from(self.emb_hits_buffer.entries());
    self.emb_hits_buffer.clear();
    try {
      const c = self._db("memory");
      const now = intSeconds();
      // executemany → one prepared UPDATE run per item (node:sqlite has no
      // executemany; the loop below is its exact shape).
      for (const [k, hits] of items) {
        c.execute("UPDATE embedding_cache SET hits=hits+?, last_used_at=? WHERE key=?", [
          hits,
          now,
          k,
        ]);
      }
      c.commit();
    } catch {
      // fail-open（源 except Exception: pass）
    }
  };

  proto.save_cached_embedding = function (
    this: StorageBase & RecallDomainI,
    provider: string,
    model: string,
    text: string,
    vector: number[]
  ): void {
    const self = this;
    // Silently no-ops on an empty vector.
    if (!vector || vector.length === 0) return;
    self.flush_embedding_cache_hits();
    const key = self.embedding_cache_key(provider, model, text);
    const now = intSeconds();
    const blob = Buffer.from(pyJsonDumps(vector.map((x) => Number(x))), "utf-8");
    const c = self._db("memory");
    c.execute(
      "INSERT OR REPLACE INTO embedding_cache " +
        "(key,provider,model,dim,vector,created_at,last_used_at,hits) " +
        "VALUES (?,?,?,?,?,?,?,COALESCE((SELECT hits FROM embedding_cache WHERE key=?),0))",
      [key, provider || "local", model || "default", vector.length, blob, now, now, key]
    );
    c.commit();
    self._prune_embedding_cache();
  };

  proto._prune_embedding_cache = function (this: StorageBase & RecallDomainI): void {
    const self = this;
    const c = self._db("memory");
    const row = c.execute("SELECT COUNT(*) AS n FROM embedding_cache").fetchone() as Row;
    const excess = Math.trunc(Number(row ? row["n"] : 0)) - self.EMBEDDING_CACHE_MAX_ROWS;
    if (excess <= 0) return;
    c.execute(
      "DELETE FROM embedding_cache WHERE key IN (" +
        "SELECT key FROM embedding_cache ORDER BY last_used_at ASC LIMIT ?)",
      [excess]
    );
    c.commit();
  };

  proto.clear_embedding_cache = function (
    this: StorageBase & RecallDomainI,
    model?: string | null
  ): number {
    const self = this;
    const c = self._db("memory");
    const cur = model
      ? c.execute("DELETE FROM embedding_cache WHERE model=?", [model])
      : c.execute("DELETE FROM embedding_cache");
    c.commit();
    return cur.rowcount || 0;
  };

  proto.embedding_cache_stats = function (this: StorageBase & RecallDomainI): JsonDict {
    const self = this;
    const c = self._db("memory");
    const row = c
      .execute(
        "SELECT COUNT(*) AS rows, COALESCE(SUM(hits),0) AS hits, " +
          "COALESCE(MAX(dim),0) AS dim FROM embedding_cache"
      )
      .fetchone() as Row;
    return {
      rows: row ? Number(row["rows"] ?? 0) : 0,
      hits: row ? Number(row["hits"] ?? 0) : 0,
      dim: row ? Number(row["dim"] ?? 0) : 0,
    };
  };

  proto._keyword_score = function (
    this: StorageBase & RecallDomainI,
    content: string,
    keywords: string[] | null
  ): number {
    // DIVERGENCE(port): production routes through ovolve_core.storage_engine
    // (Rust, `_HAS_RUST` True here). Parity probe tmp/se_parity3.py: Rust and
    // the pure spec agree on every reachable call shape (callers pass a
    // content string and a non-empty keywords list — storage.py:4839/5000/
    // 5020; the None-keywords shape raises in Rust and returns 0 in pure,
    // and no caller produces it). Distinct-keyword containment count,
    // case-insensitive — matched 1:1.
    if (!keywords) return 0;
    const hay = String(content ?? "").toLowerCase();
    let n = 0;
    for (const kw of keywords) {
      if (kw && hay.includes(String(kw).toLowerCase())) n += 1;
    }
    return n;
  };

  proto._decode_embedding = function (
    this: StorageBase & RecallDomainI,
    blob: unknown
  ): number[] | null {
    // DIVERGENCE(port): production routes through ovolve_core.storage_engine
    // (Rust). Probe tmp/se_parity3.py: for bytes/str JSON blobs Rust and the
    // pure spec decode the same values (Rust types ints as floats — [1,2,3] ->
    // [1.0,2.0,3.0]; numerically identical, and JS has no int/float JSON tag,
    // so this body matches both on every observable use: cosine scoring and
    // truthiness). Non-list JSON ({}) -> null per Rust; list/tuple blobs ->
    // null per Rust (sqlite BLOBs are never JS arrays). UTF-8 JSON array,
    // null on any failure.
    if (blob === null || blob === undefined) return null;
    try {
      const parsed = JSON.parse(
        Buffer.from(blob as Buffer).toString("utf-8")
      ) as unknown;
      return Array.isArray(parsed) ? (parsed as number[]) : null;
    } catch {
      return null;
    }
  };

  proto._cosine = function (
    this: StorageBase & RecallDomainI,
    a: number[],
    b: number[]
  ): number {
    // DIVERGENCE(port): production routes through ovolve_core.storage_engine
    // (Rust). Probe tmp/se_parity3.py: 60 random vector pairs + ragged +
    // zero-norm cases — Rust and the pure spec agree within 1e-12, and this
    // body replicates the spec's operation order (sequential dot/norms,
    // 0.0 on zero norm or length mismatch). Plain cosine over equal-length
    // vectors, 0.0 when either norm is zero.
    if (!a || !b || a.length === 0 || a.length !== b.length) return 0.0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      na += a[i]! * a[i]!;
      nb += b[i]! * b[i]!;
    }
    if (na === 0 || nb === 0) return 0.0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  };

  proto.save_session_synthesis = function (
    this: StorageBase & RecallDomainI,
    session_id: string,
    synthesis: JsonDict
  ): void {
    const self = this;
    const c = self._db("memory");
    const now = intSeconds();
    c.execute(
      "INSERT OR REPLACE INTO session_synthesis (session_id, synthesis, created_at) VALUES (?,?,?)",
      [session_id, pyJsonDumps(synthesis), now]
    );
    c.commit();
  };

  proto.get_session_synthesis = function (
    this: StorageBase & RecallDomainI,
    session_id: string
  ): JsonDict | null {
    const self = this;
    const r = self
      ._db("memory")
      .execute("SELECT * FROM session_synthesis WHERE session_id=?", [session_id])
      .fetchone() as Row | null;
    if (!r) return null;
    try {
      return JSON.parse(String(r["synthesis"])) as JsonDict;
    } catch {
      // bare except: return None
      return null;
    }
  };

  proto.get_workspace_recent_synthesis = function (
    this: StorageBase & RecallDomainI,
    workspace: string,
    exclude_session = "",
    limit = 2
  ): JsonDict[] {
    const self = this;
    if (!workspace) return [];
    const rows = self
      ._db("sessions")
      .execute(
        "SELECT s.id, ss.synthesis, ss.created_at FROM session_synthesis ss " +
          "JOIN sessions s ON s.id = ss.session_id " +
          "WHERE s.workspace = ? AND s.id != ? ORDER BY ss.created_at DESC LIMIT ?",
        [workspace, exclude_session || "", Math.trunc(limit)]
      )
      .fetchall() as Row[];
    const out: JsonDict[] = [];
    for (const r of rows) {
      try {
        out.push({
          session_id: r["id"],
          synthesis: JSON.parse(String(r["synthesis"])),
          created_at: r["created_at"],
        });
      } catch {
        // except Exception: pass
      }
    }
    return out;
  };

  proto._session_fts_upsert = function (
    this: StorageBase & RecallDomainI,
    session_id: string,
    message_id: string,
    content: string
  ): void {
    const self = this;
    if (!self.session_fts_enabled || !content) return;
    let body: string;
    try {
      body = fts_document(String(content));
    } catch {
      body = String(content).slice(0, 4000);
    }
    const c = self._db("sessions");
    try {
      c.execute("DELETE FROM session_fts WHERE message_id=?", [message_id]);
      c.execute("INSERT INTO session_fts (body, session_id, message_id) VALUES (?,?,?)", [
        body,
        session_id,
        message_id,
      ]);
      c.commit();
    } catch {
      // except sqlite3.OperationalError: disable the FTS side-index
      self.session_fts_enabled = false;
    }
  };

  proto.rebuild_session_fts = function (this: StorageBase & RecallDomainI): number {
    const self = this;
    if (!self.session_fts_enabled) return 0;
    const c = self._db("sessions");
    c.execute("DELETE FROM session_fts");
    let n = 0;
    const rows = c
      .execute(
        "SELECT id, session_id, content FROM session_messages WHERE role IN ('user','assistant')"
      )
      .fetchall() as Row[];
    for (const row of rows) {
      const body = fts_document(String(row["content"] ?? ""));
      c.execute("INSERT INTO session_fts (body, session_id, message_id) VALUES (?,?,?)", [
        body,
        row["session_id"],
        row["id"],
      ]);
      n += 1;
    }
    c.commit();
    return n;
  };

  proto.search_sessions_fts = function (
    this: StorageBase & RecallDomainI,
    query: string,
    workspace_or_opts: string | { workspace?: string; limit?: number } = "",
    limit = 10
  ): JsonDict[] {
    let workspace = "";
    if (workspace_or_opts !== null && typeof workspace_or_opts === "object") {
      workspace = String(workspace_or_opts.workspace ?? "");
      limit = Number(workspace_or_opts.limit ?? 10);
    } else {
      workspace = workspace_or_opts;
    }
    const self = this;
    if (!self.session_fts_enabled || !query) return [];
    let match_q: string;
    try {
      match_q = build_fts_query(query, undefined);
    } catch {
      match_q = query;
    }
    if (!match_q) return [];
    const c = self._db("sessions");
    try {
      const rows = workspace
        ? (c
            .execute(
              "SELECT f.session_id, bm25(session_fts) AS rank, " +
                "snippet(session_fts, 0, '【', '】', '…', 24) AS snippet " +
                "FROM session_fts f JOIN sessions s ON s.id = f.session_id " +
                "WHERE session_fts MATCH ? AND s.workspace = ? " +
                "GROUP BY f.session_id ORDER BY rank LIMIT ?",
              [match_q, workspace, Math.trunc(limit)]
            )
            .fetchall() as Row[])
        : (c
            .execute(
              "SELECT session_id, bm25(session_fts) AS rank, " +
                "snippet(session_fts, 0, '【', '】', '…', 24) AS snippet " +
                "FROM session_fts WHERE session_fts MATCH ? " +
                "GROUP BY session_id ORDER BY rank LIMIT ?",
              [match_q, Math.trunc(limit)]
            )
            .fetchall() as Row[]);
      return rows.map((r) => ({ ...(r as Row) }) as JsonDict);
    } catch {
      // except sqlite3.OperationalError: disable and return empty
      self.session_fts_enabled = false;
      return [];
    }
  };

  proto.update_memory_dream_time = function (this: StorageBase & RecallDomainI, root: string): void {
    const self = this;
    const c = self._db("memory");
    const now = intSeconds();
    c.execute("UPDATE project_memory_index SET last_dream_at=? WHERE root_dir=?", [now, root]);
    c.commit();
  };

  proto.search_memory = function (
    this: StorageBase & RecallDomainI,
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
    this: StorageBase & RecallDomainI,
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

  // ——— Episodes ———

  proto.create_episode = function (
    this: StorageBase & RecallDomainI,
    session_id: string,
    topic = "",
    goal_id = "",
    branch_id = "",
    metadata: JsonDict | null = null,
    episode_id = ""
  ): string {
    const self = this;
    if (!session_id) return "";
    const c = self._db("sessions");
    const existing = self.get_active_episode(session_id, branch_id || "");
    if (existing && !episode_id) {
      return String(existing["episode_id"] ?? "");
    }
    const eid = episode_id || `ep_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = Date.now() / 1000;
    try {
      c.execute(
        "INSERT INTO episodes (episode_id, session_id, branch_id, topic, goal_id, turn_ids, status, started_at, last_activity_at, sealed_at, metadata, generation) " +
          "VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, 1)",
        [
          eid,
          session_id,
          branch_id || "",
          topic || "General Dialogue",
          goal_id || "",
          "[]",
          now,
          now,
          pyJsonDumps(metadata ?? {}),
        ]
      );
      c.commit();
      return eid;
    } catch {
      c.execute("ROLLBACK");
      const existing2 = self.get_active_episode(session_id, branch_id || "");
      if (existing2) return String(existing2["episode_id"] ?? "");
      return eid;
    }
  };

  proto.get_episode = function (
    this: StorageBase & RecallDomainI,
    episode_id: string
  ): JsonDict | null {
    const self = this;
    if (!episode_id) return null;
    const r = self
      ._db("sessions")
      .execute("SELECT * FROM episodes WHERE episode_id=?", [episode_id])
      .fetchone() as Row | null;
    if (!r) return null;
    const d = { ...r } as JsonDict;
    try {
      d["turn_ids"] = JSON.parse(String(d["turn_ids"] ?? "[]"));
    } catch {
      d["turn_ids"] = [];
    }
    try {
      d["metadata"] = JSON.parse(String(d["metadata"] ?? "{}"));
    } catch {
      d["metadata"] = {};
    }
    return d;
  };

  proto.get_active_episode = function (
    this: StorageBase & RecallDomainI,
    session_id_or_opts: string | { session_id?: string; branch_id?: string } = "",
    branch_id = ""
  ): JsonDict | null {
    let session_id = "";
    if (session_id_or_opts !== null && typeof session_id_or_opts === "object") {
      session_id = String(session_id_or_opts.session_id ?? "");
      branch_id = String(session_id_or_opts.branch_id ?? "");
    } else {
      session_id = session_id_or_opts;
    }
    const self = this;
    if (!session_id) return null;
    const c = self._db("sessions");
    const bid = (branch_id || "").trim();
    let r: Row | null;
    if (bid) {
      r = c
        .execute(
          "SELECT * FROM episodes WHERE session_id=? AND branch_id=? AND status='active' ORDER BY started_at DESC LIMIT 1",
          [session_id, bid]
        )
        .fetchone() as Row | null;
    } else {
      r = c
        .execute(
          "SELECT * FROM episodes WHERE session_id=? AND (branch_id='' OR branch_id IS NULL) AND status='active' ORDER BY started_at DESC LIMIT 1",
          [session_id]
        )
        .fetchone() as Row | null;
    }
    if (!r) return null;
    const d = { ...r } as JsonDict;
    try {
      d["turn_ids"] = JSON.parse(String(d["turn_ids"] ?? "[]"));
    } catch {
      d["turn_ids"] = [];
    }
    try {
      d["metadata"] = JSON.parse(String(d["metadata"] ?? "{}"));
    } catch {
      d["metadata"] = {};
    }
    return d;
  };

  proto.seal_episode = function (
    this: StorageBase & RecallDomainI,
    episode_id: string,
    reason = "",
    event_id = "",
    metadata: JsonDict | null = null
  ): boolean {
    const self = this;
    if (!episode_id) return false;
    const prev = self.get_episode(episode_id);
    if (!prev) return false;
    if (prev["status"] === "sealed") return true; // Idempotent success

    const now = Date.now() / 1000;
    const c = self._db("sessions");
    const meta = (prev["metadata"] ?? {}) as JsonDict;
    if (metadata) Object.assign(meta, metadata);
    if (reason) meta["seal_reason"] = reason;

    c.execute(
      "UPDATE episodes SET status='sealed', sealed_at=?, seal_reason=?, sealed_by_event_id=?, metadata=? WHERE episode_id=?",
      [
        now,
        reason || String(prev["seal_reason"] ?? ""),
        event_id || String(prev["sealed_by_event_id"] ?? ""),
        pyJsonDumps(meta),
        episode_id,
      ]
    );
    c.commit();
    return true;
  };

  proto.list_episodes = function (
    this: StorageBase & RecallDomainI,
    session_id_or_opts:
      | string
      | { session_id?: string; branch_id?: string | null; limit?: number } = "",
    branch_id: string | null = null,
    limit = 50
  ): JsonDict[] {
    let session_id = "";
    if (session_id_or_opts !== null && typeof session_id_or_opts === "object") {
      session_id = String(session_id_or_opts.session_id ?? "");
      branch_id = session_id_or_opts.branch_id ?? null;
      limit = Number(session_id_or_opts.limit ?? 50);
    } else {
      session_id = session_id_or_opts;
    }
    const self = this;
    const c = self._db("sessions");
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (session_id) {
      conditions.push("session_id=?");
      params.push(session_id);
    }
    if (branch_id !== null) {
      if (branch_id === "") {
        conditions.push("(branch_id IS NULL OR branch_id = '')");
      } else {
        conditions.push("branch_id=?");
        params.push(branch_id);
      }
    }
    const where = conditions.length > 0 ? conditions.join(" AND ") : "1=1";
    params.push(Math.trunc(limit));
    const rows = c
      .execute(`SELECT * FROM episodes WHERE ${where} ORDER BY started_at DESC LIMIT ?`, params)
      .fetchall() as Row[];
    return rows.map((r) => {
      const d = { ...r } as JsonDict;
      try {
        d["turn_ids"] = JSON.parse(String(d["turn_ids"] ?? "[]"));
      } catch {
        d["turn_ids"] = [];
      }
      try {
        d["metadata"] = JSON.parse(String(d["metadata"] ?? "{}"));
      } catch {
        d["metadata"] = {};
      }
      return d;
    });
  };

  proto.list_active_episodes = function (
    this: StorageBase & RecallDomainI,
    limit = 100
  ): JsonDict[] {
    const self = this;
    const c = self._db("sessions");
    const rows = c
      .execute(
        "SELECT * FROM episodes WHERE status='active' ORDER BY started_at ASC LIMIT ?",
        [Math.trunc(limit)]
      )
      .fetchall() as Row[];
    return rows.map((r) => {
      const d = { ...r } as JsonDict;
      try {
        d["turn_ids"] = JSON.parse(String(d["turn_ids"] ?? "[]"));
      } catch {
        d["turn_ids"] = [];
      }
      try {
        d["metadata"] = JSON.parse(String(d["metadata"] ?? "{}"));
      } catch {
        d["metadata"] = {};
      }
      return d;
    });
  };

  proto.append_turn_to_episode = function (
    this: StorageBase & RecallDomainI,
    episode_id: string,
    turn_id: string
  ): boolean {
    const self = this;
    if (!(episode_id && turn_id)) return false;
    const ep = self.get_episode(episode_id);
    if (!ep || ep["status"] !== "active") return false;
    const turns = (ep["turn_ids"] ?? []) as string[];
    const now = Date.now() / 1000;
    if (!turns.includes(turn_id)) turns.push(turn_id);
    self
      ._db("sessions")
      .execute("UPDATE episodes SET turn_ids=?, last_activity_at=? WHERE episode_id=?", [
        pyJsonDumps(turns),
        now,
        episode_id,
      ]);
    self._db("sessions").commit();
    return true;
  };

  // ——— Learning Items ———

  proto.insert_learning_item = function (
    this: StorageBase & RecallDomainI,
    kwargs: Record<string, unknown>
  ): string {
    const self = this;
    const g = (k: string, dflt: unknown): unknown => kwargs[k] ?? dflt;
    const c = self._db("memory");
    const idempotency_key = String(g("idempotency_key", ""));
    if (idempotency_key) {
      const row = c
        .execute("SELECT learning_item_id FROM learning_items WHERE idempotency_key=?", [
          idempotency_key,
        ])
        .fetchone() as Row | null;
      if (row) return String(row[Object.keys(row)[0] ?? ""] ?? row["learning_item_id"]);
    }
    const iid = String(g("learning_item_id", "") || `li_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`);
    const now = Date.now() / 1000;
    const session_id = String(g("session_id", "") || "");
    c.execute(
      `
            INSERT INTO learning_items (
                learning_item_id, bundle_id, episode_id, session_id, branch_id,
                kind, scope, content, preconditions, applicability,
                source_event_ids, source_session_id, source_goal_id, source_run_id,
                source_turn_id, confidence, evidence_strength, priority,
                status, notification_policy, why, evidence_summary, future_effect,
                target_ref, deferred_reason, user_verdict, idempotency_key, operation_id,
                version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `,
      [
        iid,
        String(g("bundle_id", "") || ""),
        String(g("episode_id", "") || ""),
        session_id,
        String(g("branch_id", "") || ""),
        String(g("kind", "memory_fact") || "memory_fact"),
        String(g("scope", "session") || "session"),
        String(g("content", "") || ""),
        String(g("preconditions", "") || ""),
        String(g("applicability", "") || ""),
        pyJsonDumps(Array.from((g("source_event_ids", null) as unknown[] | null) ?? [])),
        String(g("source_session_id", "") || session_id || ""),
        String(g("source_goal_id", "") || ""),
        String(g("source_run_id", "") || ""),
        String(g("source_turn_id", "") || ""),
        Number(g("confidence", 1.0)),
        Number(g("evidence_strength", 1.0)),
        Math.trunc(Number(g("priority", 0))),
        String(g("status", "discovered") || "discovered"),
        String(g("notification_policy", "receipt") || "receipt"),
        String(g("why", "") || ""),
        String(g("evidence_summary", "") || ""),
        String(g("future_effect", "") || ""),
        String(g("target_ref", "") || ""),
        String(g("deferred_reason", "") || ""),
        String(g("user_verdict", "pending") || "pending"),
        idempotency_key || "",
        String(g("operation_id", "") || ""),
        now,
        now,
      ]
    );
    c.commit();
    return iid;
  };

  proto.get_learning_item = function (
    this: StorageBase & RecallDomainI,
    item_id: string
  ): JsonDict | null {
    const self = this;
    if (!item_id) return null;
    const r = self
      ._db("memory")
      .execute("SELECT * FROM learning_items WHERE learning_item_id=?", [item_id])
      .fetchone() as Row | null;
    if (!r) return null;
    const d = { ...r } as JsonDict;
    try {
      d["source_event_ids"] = JSON.parse(String(d["source_event_ids"] ?? "[]"));
    } catch {
      d["source_event_ids"] = [];
    }
    return d;
  };

  proto.list_learning_items = function (
    this: StorageBase & RecallDomainI,
    session_id_or_opts:
      | string
      | { session_id?: string; branch_id?: string | null; limit?: number } = "",
    branch_id: string | null = null,
    episode_id = "",
    bundle_id = "",
    status = "",
    limit = 100
  ): JsonDict[] {
    let session_id = "";
    if (session_id_or_opts !== null && typeof session_id_or_opts === "object") {
      session_id = String(session_id_or_opts.session_id ?? "");
      branch_id = session_id_or_opts.branch_id ?? null;
      limit = Number(session_id_or_opts.limit ?? 100);
    } else {
      session_id = session_id_or_opts;
    }
    const self = this;
    const c = self._db("memory");
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (session_id) {
      conditions.push("session_id=?");
      params.push(session_id);
    }
    if (branch_id !== null) {
      if (branch_id === "") {
        conditions.push("(branch_id IS NULL OR branch_id = '')");
      } else {
        conditions.push("branch_id=?");
        params.push(branch_id);
      }
    }
    if (episode_id) {
      conditions.push("episode_id=?");
      params.push(episode_id);
    }
    if (bundle_id) {
      conditions.push("bundle_id=?");
      params.push(bundle_id);
    }
    if (status) {
      conditions.push("status=?");
      params.push(status);
    }
    const where = conditions.length > 0 ? conditions.join(" AND ") : "1=1";
    params.push(Math.trunc(limit));
    const rows = c
      .execute(`SELECT * FROM learning_items WHERE ${where} ORDER BY created_at DESC LIMIT ?`, params)
      .fetchall() as Row[];
    return rows.map((r) => {
      const d = { ...r } as JsonDict;
      try {
        d["source_event_ids"] = JSON.parse(String(d["source_event_ids"] ?? "[]"));
      } catch {
        d["source_event_ids"] = [];
      }
      return d;
    });
  };

  proto.update_learning_item = function (
    this: StorageBase & RecallDomainI,
    item_id: string,
    status: string | null = null,
    user_verdict: string | null = null,
    deferred_reason: string | null = null,
    content: string | null = null,
    operation_id: string | null = null,
    idempotency_key: string | null = null,
    expected_version: number | null = null
  ): boolean {
    const self = this;
    if (!item_id) return false;
    const c = self._db("memory");
    const prev = self.get_learning_item(item_id);
    if (!prev) return false;

    if (status && status !== prev["status"]) {
      // 状态机校验（照抄源）。
      const valid_targets: Record<string, ReadonlySet<string>> = {
        discovered: new Set(["classified", "proposed", "deferred", "noop", "failed"]),
        classified: new Set(["proposed", "deferred", "noop", "validating", "staged", "failed"]),
        proposed: new Set([
          "validating",
          "staged",
          "awaiting_approval",
          "published",
          "rejected",
          "deferred",
          "failed",
        ]),
        deferred: new Set(["proposed", "validating", "staged", "published", "rejected", "archived"]),
        staged: new Set(["validating", "published", "rejected", "deferred", "failed"]),
        validating: new Set(["published", "failed", "unknown", "rejected", "proposed"]),
        published: new Set(["rolled_back", "degraded", "archived", "unknown"]),
        rejected: new Set(["archived"]),
        failed: new Set(["proposed", "validating", "archived", "unknown"]),
        unknown: new Set(["published", "failed", "rolled_back", "archived"]),
        rolled_back: new Set(["archived", "proposed"]),
        degraded: new Set(["archived", "validating", "rolled_back"]),
        archived: new Set([]),
      };
      const cur_status = String(prev["status"] ?? "discovered");
      const allowed = valid_targets[cur_status] ?? new Set<string>();
      if (!allowed.has(status)) {
        // Log state machine rejection and return False
        return false;
      }
    }

    const updates: string[] = ["updated_at=?", "version=version+1"];
    const params: unknown[] = [Date.now() / 1000];
    if (status !== null) {
      updates.push("status=?");
      params.push(status);
    }
    if (user_verdict !== null) {
      updates.push("user_verdict=?");
      params.push(user_verdict);
    }
    if (deferred_reason !== null) {
      updates.push("deferred_reason=?");
      params.push(deferred_reason);
    }
    if (content !== null) {
      updates.push("content=?");
      params.push(content);
    }
    if (operation_id !== null) {
      updates.push("operation_id=?");
      params.push(operation_id);
    }
    if (idempotency_key !== null) {
      updates.push("idempotency_key=?");
      params.push(idempotency_key);
    }

    let where = "learning_item_id=?";
    params.push(item_id);
    if (expected_version !== null) {
      where += " AND version=?";
      params.push(expected_version);
    }

    const res = c.execute(
      `UPDATE learning_items SET ${updates.join(", ")} WHERE ${where}`,
      params
    );
    c.commit();
    return res.rowcount > 0;
  };

  // ——— Learning Item Operation Ledger (P1-2) ———

  proto.record_learning_item_operation = function (
    this: StorageBase & RecallDomainI,
    operation_id: string,
    item_id: string,
    action: string,
    idempotency_key = "",
    status = "started",
    payload: JsonDict | null = null,
    result: JsonDict | null = null,
    error = ""
  ): boolean {
    const self = this;
    if (!(operation_id && item_id)) return false;
    const c = self._db("memory");
    const now = Date.now() / 1000;
    c.execute(
      `
            INSERT INTO learning_item_operations (
                operation_id, item_id, action, idempotency_key, status, payload, result, error, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(operation_id) DO UPDATE SET
                status=excluded.status,
                result=excluded.result,
                error=excluded.error,
                updated_at=excluded.updated_at
        `,
      [
        operation_id,
        item_id,
        action,
        idempotency_key || "",
        status,
        pyJsonDumps(payload ?? {}),
        pyJsonDumps(result ?? {}),
        String(error || ""),
        now,
        now,
      ]
    );
    c.commit();
    return true;
  };

  proto.get_learning_item_operation_by_key = function (
    this: StorageBase & RecallDomainI,
    idempotency_key: string
  ): JsonDict | null {
    const self = this;
    if (!idempotency_key) return null;
    const r = self
      ._db("memory")
      .execute(
        "SELECT * FROM learning_item_operations WHERE idempotency_key=? ORDER BY created_at DESC LIMIT 1",
        [idempotency_key]
      )
      .fetchone() as Row | null;
    if (!r) return null;
    const d = { ...r } as JsonDict;
    try {
      d["payload"] = JSON.parse(String(d["payload"] ?? "{}"));
    } catch {
      d["payload"] = {};
    }
    try {
      d["result"] = JSON.parse(String(d["result"] ?? "{}"));
    } catch {
      d["result"] = {};
    }
    return d;
  };

  proto.get_learning_item_operation = function (
    this: StorageBase & RecallDomainI,
    operation_id: string
  ): JsonDict | null {
    const self = this;
    if (!operation_id) return null;
    const r = self
      ._db("memory")
      .execute("SELECT * FROM learning_item_operations WHERE operation_id=?", [operation_id])
      .fetchone() as Row | null;
    if (!r) return null;
    const d = { ...r } as JsonDict;
    try {
      d["payload"] = JSON.parse(String(d["payload"] ?? "{}"));
    } catch {
      d["payload"] = {};
    }
    try {
      d["result"] = JSON.parse(String(d["result"] ?? "{}"));
    } catch {
      d["result"] = {};
    }
    return d;
  };

  proto.claim_learning_item_operation = function (
    this: StorageBase & RecallDomainI,
    operation_id: string,
    item_id: string,
    action: string,
    idempotency_key = "",
    payload: JsonDict | null = null
  ): [boolean, JsonDict] {
    const self = this;
    if (!(operation_id && item_id)) return [false, {}];
    const c = self._db("memory");
    const now = Date.now() / 1000;
    const payload_json = pyJsonDumps(payload ?? {});
    if (idempotency_key) {
      try {
        c.execute(
          `
                    INSERT INTO learning_item_operations (
                        operation_id, item_id, action, idempotency_key, status, payload, result, error, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'started', ?, '{}', '', ?, ?)
                `,
          [operation_id, item_id, action, idempotency_key, payload_json, now, now]
        );
        c.commit();
        return [
          true,
          {
            operation_id,
            item_id,
            action,
            idempotency_key,
            status: "started",
            payload: payload ?? {},
            result: {},
            error: "",
            created_at: now,
            updated_at: now,
          },
        ];
      } catch (exc) {
        // Unique constraint hit: operation already exists!
        // (sqlite3.IntegrityError → node:sqlite throws Error with constraint text)
        const msg = exc instanceof Error ? exc.message : String(exc);
        if (!/unique|constraint/i.test(msg)) {
          throw exc;
        }
        const existing = self.get_learning_item_operation_by_key(idempotency_key);
        if (existing) {
          // Check comprehensive intent matching (P1-2)
          const ex_payload = (existing["payload"] ?? {}) as JsonDict;
          const cur_payload = (payload ?? {}) as JsonDict;
          const mismatches: string[] = [];
          if (existing["item_id"] !== item_id) {
            mismatches.push(`item_id ('${existing["item_id"]}' != '${item_id}')`);
          }
          if (existing["action"] !== action) {
            mismatches.push(`action ('${existing["action"]}' != '${action}')`);
          }
          if (
            cur_payload["version"] !== null &&
            cur_payload["version"] !== undefined &&
            ex_payload["version"] !== null &&
            ex_payload["version"] !== undefined &&
            cur_payload["version"] !== ex_payload["version"]
          ) {
            mismatches.push(`version (${ex_payload["version"]} != ${cur_payload["version"]})`);
          }
          if (
            action === "edit" &&
            String(cur_payload["content"] ?? "").trim() !== String(ex_payload["content"] ?? "").trim()
          ) {
            mismatches.push("edited content");
          }
          if (
            String(cur_payload["reason"] ?? "").trim() !== String(ex_payload["reason"] ?? "").trim()
          ) {
            mismatches.push("reason");
          }
          if (
            String(cur_payload["session_id"] ?? "").trim() !==
            String(ex_payload["session_id"] ?? "").trim()
          ) {
            mismatches.push("sessionId");
          }
          if (
            String(cur_payload["branch_id"] ?? "").trim() !==
            String(ex_payload["branch_id"] ?? "").trim()
          ) {
            mismatches.push("branchId");
          }
          if (mismatches.length > 0) {
            return [
              false,
              {
                status: "idempotency_conflict",
                error: `Idempotency key '${idempotency_key}' reused with conflicting mutation intent on: ${mismatches.join(", ")}`,
                operation_id: existing["operation_id"],
              },
            ];
          }
        }
        return [false, existing ?? {}];
      }
    } else {
      c.execute(
        `
                INSERT INTO learning_item_operations (
                    operation_id, item_id, action, idempotency_key, status, payload, result, error, created_at, updated_at
                ) VALUES (?, ?, ?, '', 'started', ?, '{}', '', ?, ?)
            `,
        [operation_id, item_id, action, payload_json, now, now]
      );
      c.commit();
      return [
        true,
        {
          operation_id,
          item_id,
          action,
          idempotency_key: "",
          status: "started",
          payload: payload ?? {},
          result: {},
          error: "",
          created_at: now,
          updated_at: now,
        },
      ];
    }
  };

  proto.update_learning_item_operation = function (
    this: StorageBase & RecallDomainI,
    operation_id: string,
    status: string | null = null,
    result: JsonDict | null = null,
    error: string | null = null
  ): boolean {
    const self = this;
    if (!operation_id) return false;
    const updates: string[] = ["updated_at=?"];
    const params: unknown[] = [Date.now() / 1000];
    if (status !== null) {
      updates.push("status=?");
      params.push(status);
    }
    if (result !== null) {
      updates.push("result=?");
      params.push(pyJsonDumps(result));
    }
    if (error !== null) {
      updates.push("error=?");
      params.push(String(error));
    }
    params.push(operation_id);
    const c = self._db("memory");
    c.execute(
      `UPDATE learning_item_operations SET ${updates.join(", ")} WHERE operation_id=?`,
      params
    );
    c.commit();
    return true;
  };

  proto.list_hanging_learning_item_operations = function (
    this: StorageBase & RecallDomainI,
    limit = 100
  ): JsonDict[] {
    const self = this;
    const rows = self
      ._db("memory")
      .execute(
        "SELECT * FROM learning_item_operations WHERE status IN ('started', 'unknown') ORDER BY created_at ASC LIMIT ?",
        [Math.trunc(limit)]
      )
      .fetchall() as Row[];
    return rows.map((r) => {
      const d = { ...r } as JsonDict;
      try {
        d["payload"] = JSON.parse(String(d["payload"] ?? "{}"));
      } catch {
        d["payload"] = {};
      }
      try {
        d["result"] = JSON.parse(String(d["result"] ?? "{}"));
      } catch {
        d["result"] = {};
      }
      return d;
    });
  };
}
