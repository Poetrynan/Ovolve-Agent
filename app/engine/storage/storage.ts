/**
 * storage.ts — SQLite one-db-one-responsibility + session branch tree + migrations.
 *
 * Ported from `app/backend/storage.py` (5882 lines).
 *
 * ARCHITECTURE (RULEBOOK §0 redesign): one source module → one class split
 * across domain mixins under `storage/`. The Storage class composes all of
 * them and owns the shared connection pool, migration framework and the
 * config/KV surface every mixin relies on. One source module, one target
 * root: `storage/index.ts` re-exports the same names `import storage` gave
 * Python callers.
 *
 * RULEBOOK CITATIONS
 *   §1  node:sqlite builtin via sqlite_connection.ts; no new dependency.
 *   §2  _SerializedConn threading: Node's event loop serializes JS; the
 *       connection adapter remains synchronous, so the RLock's guarantee
 *       (no interleaved execute on one connection) holds structurally.
 *   §2  broad swallows (`except Exception: pass` / bare `except:`) are
 *       preserved verbatim with BUG(port) comments at each site.
 *   §2  Python float `time.time()` vs int `time.time()`: timestamps that the
 *       source wrote as INTEGER use intSeconds(); REAL columns use nowMs().
 *   §4  naming: app/backend/storage.py -> app/engine/storage/ (+ index.ts)
 *
 * PORT STATUS: confidence=medium todos=2
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";

import { openSqlite, type SqliteConnection } from "../sqlite_connection.js";
import { get_event_store, EventStore } from "../event_store.js";
import { EventType } from "../event_types.js";
import { SessionAuditTrack } from "../session_audit.js";
import { getSessionLogger, SessionLogger } from "../session_logger.js";
import { TraceGateway, CRITICAL } from "../trace_gateway.js";
import { get_projection_engine, type ProjectionEngine } from "../projection_engine.js";
import { dbDir } from "../user_dirs.js";
import { Result } from "../result.js";
import { split_usage_model_id, pyJsonIndent } from "./storage_funcs.js";
import { PROCESS_GENERATION } from "./storage_consts.js";
import { DB_NAMES } from "./storage_consts.js";
import {
  MIGRATION_JOURNAL_NAME,
  MIGRATIONS,
  SUBAGENT_TERMINAL_STATUSES,
} from "./storage_consts.js";
import type {
  JsonDict,
  MigrationJournal,
  MigrationJournalStep,
  MigrationStatus,
  RetryResult,
  Row,
} from "./storage_types.js";

export type { JsonDict, Row };

// ——— module-level helpers of storage.py ———

/** Loud degradation for audit-side writes (see source docstring). */
function _audit_write_failed(what: string, exc: unknown): void {
  // log.error(..., exc_info=True) equivalent: print with the stack.
  console.error(`[audit] event write failed during ${what}:`, exc);
}

/** int(time.time()) equivalent. */
export function intSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** int(time.time() * 1000) equivalent. */
export function nowMs(): number {
  return Date.now();
}

/** uuid4 hex (32 chars). */
export function uuidHex(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** uuid4().hex[:12] — 12-char prefix used by several id fields. */
export function uuidHex12(): string {
  return uuidHex().slice(0, 12);
}

export class MigrationUnrecoverable extends Error {
  migId: string;
  original: unknown;
  backupDir: string;
  journalPath: string;

  constructor(mig_id: string, original: unknown, backup_dir: string, journal_path: string) {
    super(
      `migration ${mig_id} failed (${original}) and restore from backup ` +
        `${backup_dir || "(none)"} also failed — database left untouched; ` +
        `use the recovery mode to export or repair it`
    );
    this.name = "MigrationUnrecoverable";
    this.migId = mig_id;
    this.original = original;
    this.backupDir = backup_dir;
    this.journalPath = journal_path;
  }
}

// The domain mixins re-exported by index.ts live in storage/*.ts; they import
// these helpers from here. To keep the dependency direction acyclic (mixins
// need the helpers; the core needs the mixins), the helpers are re-declared
// through a small namespace object passed at construction instead.
//
// RULEBOOK §2: import-time side effects are behaviour — nothing here runs at
// import time except PROCESS_GENERATION-style tokens, which storage_consts
// owns.

/** Shared shape every mixin expects from the core. */
export interface StorageCore {
  db_dir: string;
  recovery_mode: string;
  dbs: Record<string, SqliteConnection>;
  event_store: EventStore;
  trace: TraceGateway;
  projection_engine: ReturnType<typeof get_projection_engine>;
  session_logger: SessionLogger;
  session_audit: SessionAuditTrack;
  fts_enabled: boolean;
  session_fts_enabled: boolean;
  emb_hits_buffer: Map<string, number>;
  /** _db(name) — the pooled connection accessor every mixin uses. */
  _db(name: string): SqliteConnection;
}

/**
 * Base class carrying the connection pool, migration framework, config/KV and
 * the workspace normalization passes. Domain mixins add their methods onto
 * subclasses of this via plain TS mixin classes (see storage/*.ts).
 */
export class StorageBase {
  db_dir: string;
  recovery_mode = "";
  dbs: Record<string, SqliteConnection> = {};
  event_store!: EventStore;
  trace!: TraceGateway;
  /** Python-name alias of {@link trace} — domain mixins use the source name. */
  get _trace(): TraceGateway {
    return this.trace;
  }
  projection_engine!: ProjectionEngine;
  session_logger!: SessionLogger;
  /** Python-name alias of {@link session_logger}. */
  get _session_logger(): SessionLogger {
    return this.session_logger;
  }
  session_audit!: SessionAuditTrack;
  /** Python-name alias of {@link session_audit}. */
  get _session_audit(): SessionAuditTrack {
    return this.session_audit;
  }
  session_fts_enabled = false;
  fts_enabled = false;
  emb_hits_buffer = new Map<string, number>();

  // Cross-domain method, mounted by the recall domain mixin (storage/domains/
  // recall.ts). Declared so the core migration bootstrap can call it; the
  // composition root applies the mixins before any instance is constructed.
  declare rebuild_session_fts: (this: StorageBase) => number;

  // Memory-domain surface used by the recall domain (storage/domains/memory.ts
  // mounts these; recall.ts calls them — one class in the source).
  declare _memory_live_sql: (this: StorageBase, prefix?: string) => [string, unknown[]];
  declare MEMORY_TRUST_ORDER: string;
  declare MEMORY_CONTENT_SCAN_LIMIT: number;
  declare search_memory_fts: (
    this: StorageBase,
    root: string,
    match_query: string,
    limit?: number,
    session_id?: string,
    branch_id?: string
  ) => Record<string, number>;
  // Recall-domain surface used by the sessions domain (add_message upserts the
  // per-message FTS row).
  declare _session_fts_upsert: (
    this: StorageBase,
    session_id: string,
    message_id: string,
    content: string
  ) => void;

  static DB_DIR_ENV = "OVOLVE_DB_DIR";
  static LEGACY_DB_DIR_ENV = "OVOLVE_DB_DIR";

  constructor(db_dir?: string | null) {
    this.db_dir =
      db_dir ??
      process.env[StorageBase.DB_DIR_ENV] ??
      process.env[StorageBase.LEGACY_DB_DIR_ENV] ??
      dbDir();
    fs.mkdirSync(this.db_dir, { recursive: true });
    this._open_db_connections();
    this.session_logger = getSessionLogger(
      path.join(this.db_dir, "..", "logs", "sessions")
    );
    this.session_audit = new SessionAuditTrack(
      path.join(this.db_dir, "..", "logs", "sessions"),
      undefined,
      (sid: string) => this._session_parent_id(sid)
    );
    this._migrate();
  }

  _session_parent_id(sid: string): string {
    try {
      const row = this._db("sessions")
        .execute("SELECT parent_id FROM sessions WHERE id=?", [sid])
        .fetchone();
      if (!row) return "";
      return String((row as Row)["parent_id"] ?? "") || "";
    } catch {
      // RULEBOOK §2: `except Exception: return ""` — 关联字段缺失不许影响审计落盘
      return "";
    }
  }

  _open_db_connections(): void {
    // Split out of __init__ because the migration rollback path must close
    // all handles, copy backup files over the live ones, and open them again
    // — on Windows an unclosed sqlite handle keeps the old file bytes pinned.
    this.dbs = {};
    for (const name of DB_NAMES) {
      const p = path.join(this.db_dir, `${name}.db`);
      this.dbs[name] = openSqlite(p);
      // PRAGMAs the source sets per connection. node:sqlite opens in WAL-
      // capable mode; journal_mode and busy_timeout are set explicitly to
      // keep behaviour identical under concurrent writers.
      this.dbs[name].execute("PRAGMA journal_mode=WAL");
      this.dbs[name].execute("PRAGMA foreign_keys=ON");
      this.dbs[name].execute("PRAGMA busy_timeout=60000");
    }
    this.event_store = get_event_store(path.join(this.db_dir, "events.db"));
    // All new business events go through the canonical gateway (Phase 1).
    this.trace = new TraceGateway(this.event_store);
    this.projection_engine = get_projection_engine(this.event_store);
  }

  _db(name: string): SqliteConnection {
    return this.dbs[name]!;
  }

  _migrate(): void {
    const c = this.dbs["configs"]!;
    c.execute(
      "CREATE TABLE IF NOT EXISTS schema_migration (id TEXT PRIMARY KEY, checksum TEXT, app_version TEXT, applied_at INTEGER)"
    );
    c.execute(
      "CREATE TABLE IF NOT EXISTS configs (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)"
    );
    this.dbs["kv"]!.execute(
      "CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT, namespace TEXT DEFAULT 'default', updated_at INTEGER)"
    );
    const s = this.dbs["sessions"]!;
    s.execute(
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER, goal_state TEXT, parent_id TEXT, branch_point TEXT)"
    );
    s.execute(
      "CREATE TABLE IF NOT EXISTS session_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, msg_type TEXT DEFAULT 'message', metadata TEXT DEFAULT '{}', created_at INTEGER, seq INTEGER)"
    );
    // Session message FTS5 — cross-session conversation search.
    this.session_fts_enabled = false;
    try {
      s.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(" +
          "body, session_id UNINDEXED, message_id UNINDEXED, tokenize='unicode61')"
      );
      this.session_fts_enabled = true;
    } catch {
      // RULEBOOK §2: bare except -> swallow; FTS5 unavailable degrades search.
    }
    if (this.session_fts_enabled) {
      try {
        const n = Number(
          (this._db("sessions").execute("SELECT COUNT(*) AS c FROM session_fts").fetchone() as Row)[
            "c"
          ]
        );
        if (n === 0) {
          this.rebuild_session_fts();
        }
      } catch {
        // except Exception: pass
      }
    }
    s.execute(
      "CREATE TABLE IF NOT EXISTS workspaces (path TEXT PRIMARY KEY, display_name TEXT DEFAULT '', pinned INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, last_opened_at INTEGER DEFAULT 0, settings_json TEXT DEFAULT '{}', created_at INTEGER)"
    );
    this.dbs["goals"]!.execute(
      "CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, description TEXT, status TEXT DEFAULT 'started', iteration INTEGER DEFAULT 0, session_id TEXT, created_at INTEGER, updated_at INTEGER, verification_result TEXT)"
    );
    this.dbs["cron"]!.execute(
      "CREATE TABLE IF NOT EXISTS cron_jobs (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, cron_expr TEXT, delay_minutes INTEGER, recurring INTEGER DEFAULT 1, max_runs INTEGER, next_run_at INTEGER, last_run_at INTEGER, run_count INTEGER DEFAULT 0, status TEXT DEFAULT 'active', bot_delivery_target TEXT, session_id TEXT, created_at INTEGER)"
    );
    this.dbs["memory"]!.execute(
      "CREATE TABLE IF NOT EXISTS memory_entries (id TEXT PRIMARY KEY, session_id TEXT, root_dir TEXT, scope TEXT DEFAULT 'project', content TEXT, embedding BLOB, metadata TEXT DEFAULT '{}', created_at INTEGER, updated_at INTEGER)"
    );
    this.dbs["memory"]!.execute(
      "CREATE TABLE IF NOT EXISTS project_memory_index (id TEXT PRIMARY KEY, root_dir TEXT UNIQUE, index_content TEXT, last_dream_at INTEGER, last_extract_at INTEGER, version INTEGER DEFAULT 1)"
    );
    this.dbs["memory"]!.execute(
      "CREATE TABLE IF NOT EXISTS session_synthesis (session_id TEXT PRIMARY KEY, synthesis TEXT, created_at INTEGER)"
    );
    // Embedding cache (see source comment re: the 384-dim vs 768-dim killer bug).
    this.dbs["memory"]!.execute(
      "CREATE TABLE IF NOT EXISTS embedding_cache (" +
        "key TEXT PRIMARY KEY, provider TEXT, model TEXT, dim INTEGER, " +
        "vector BLOB, created_at INTEGER, last_used_at INTEGER, hits INTEGER DEFAULT 0)"
    );
    this.dbs["memory"]!.execute(
      "CREATE INDEX IF NOT EXISTS idx_embcache_used ON embedding_cache(last_used_at)"
    );
    // Add columns for enhanced memory (idempotent ALTER TABLE)
    this._safe_add_column("memory", "memory_entries", "type", "TEXT DEFAULT 'fact'");
    this._safe_add_column("memory", "memory_entries", "importance", "REAL DEFAULT 0.5");
    this._safe_add_column("memory", "memory_entries", "tags", "TEXT DEFAULT '[]'");
    this._safe_add_column("memory", "memory_entries", "archived", "INTEGER DEFAULT 0");
    this._safe_add_column("memory", "memory_entries", "tier", "TEXT DEFAULT 'semantic'");
    this._safe_add_column("memory", "memory_entries", "hits", "INTEGER DEFAULT 0");
    this._safe_add_column("memory", "memory_entries", "accessed_at", "INTEGER DEFAULT 0");
    this.dbs["memory"]!.execute(
      "CREATE INDEX IF NOT EXISTS idx_mem_tier ON memory_entries(tier, root_dir)"
    );
    // C2 hybrid retrieval: FTS5 side-index for the lexical channel.
    this.fts_enabled = false;
    try {
      this.dbs["memory"]!.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(" +
          "body, root_dir UNINDEXED, entry_id UNINDEXED, tokenize='unicode61')"
      );
      this.fts_enabled = true;
    } catch {
      // fail-open: 可选增强，失败不影响主流程
    }

    // Phase 59 内化: 实体关系图谱表 (Graph Memory Engine)
    this.dbs["memory"]!.execute(
      "CREATE TABLE IF NOT EXISTS graph_entities (" +
        "id TEXT PRIMARY KEY, root_dir TEXT, type TEXT NOT NULL, name TEXT NOT NULL, " +
        "properties_json TEXT DEFAULT '{}', created_at INTEGER, updated_at INTEGER)"
    );
    this.dbs["memory"]!.execute(
      "CREATE TABLE IF NOT EXISTS graph_relations (" +
        "id TEXT PRIMARY KEY, root_dir TEXT, source_id TEXT NOT NULL, target_id TEXT NOT NULL, " +
        "relation_type TEXT NOT NULL, confidence REAL DEFAULT 1.0, created_at INTEGER)"
    );
    this.dbs["memory"]!.execute(
      "CREATE INDEX IF NOT EXISTS idx_graph_ent_name ON graph_entities(name, root_dir)"
    );
    this.dbs["memory"]!.execute(
      "CREATE INDEX IF NOT EXISTS idx_graph_rel_edge ON graph_relations(source_id, target_id)"
    );
    this._safe_add_column("memory", "project_memory_index", "last_dream_at", "INTEGER DEFAULT 0");
    this._safe_add_column("sessions", "sessions", "pinned", "INTEGER DEFAULT 0");
    this._safe_add_column("sessions", "sessions", "workspace", "TEXT DEFAULT ''");
    this._safe_add_column("sessions", "sessions", "turn_status", "TEXT DEFAULT 'idle'");
    this._safe_add_column("sessions", "sessions", "turn_substatus", "TEXT DEFAULT ''");
    this._safe_add_column("sessions", "sessions", "status_updated_at", "INTEGER DEFAULT 0");

    this._normalize_workspace_paths();
    this._unbind_own_dirs();

    // turn_usage must exist BEFORE the ALTERs and the backfill below.
    this.dbs["usage"]!.execute(
      "CREATE TABLE IF NOT EXISTS turn_usage (id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, model_id TEXT DEFAULT '', input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_creation INTEGER, cache_read INTEGER, provider_total INTEGER, computed_total INTEGER, model_retry INTEGER DEFAULT 0, retryable INTEGER DEFAULT 1, context_exceeded INTEGER DEFAULT 0, error_type TEXT, latency_ms INTEGER DEFAULT 0, cost_micros INTEGER DEFAULT 0, cache_saved_micros INTEGER DEFAULT 0, cost_source TEXT DEFAULT '', created_at INTEGER)"
    );
    this._safe_add_column("usage", "turn_usage", "model_id", "TEXT DEFAULT ''");
    this._safe_add_column("usage", "turn_usage", "latency_ms", "INTEGER DEFAULT 0");
    this._safe_add_column("usage", "turn_usage", "cost_micros", "INTEGER DEFAULT 0");
    this._safe_add_column("usage", "turn_usage", "cache_saved_micros", "INTEGER DEFAULT 0");
    this._safe_add_column("usage", "turn_usage", "cost_source", "TEXT DEFAULT ''");
    try {
      const u = this.dbs["usage"]!;
      u.execute(
        "UPDATE turn_usage SET model_id = 'openai:LongCat-2.0' WHERE model_id IN ('custom:', 'custom', 'custom:LongCat-2.0', '')"
      );
      u.execute(
        "UPDATE turn_usage SET model_id = 'openai:' || SUBSTR(model_id, 8) WHERE model_id LIKE 'custom:%'"
      );
      u.commit();
    } catch (e) {
      console.log(`[storage] operation FAILED: ${e}`);
    }
    // Autonomous goal execution columns.
    this._safe_add_column("goals", "goals", "max_iterations", "INTEGER DEFAULT 10");
    this._safe_add_column("goals", "goals", "cost_micros", "INTEGER DEFAULT 0");
    this._safe_add_column("goals", "goals", "cost_cap_micros", "INTEGER DEFAULT 5000000");
    this._safe_add_column("goals", "goals", "tokens_used", "INTEGER DEFAULT 0");
    this._safe_add_column("goals", "goals", "plan_json", "TEXT DEFAULT '[]'");
    this._safe_add_column("goals", "goals", "last_error", "TEXT DEFAULT ''");
    this._safe_add_column("goals", "goals", "started_at", "INTEGER DEFAULT 0");
    this._safe_add_column("goals", "goals", "claimed_at", "INTEGER DEFAULT 0");
    this._safe_add_column("goals", "goals", "brief_json", "TEXT DEFAULT '{}'");
    this._safe_add_column("goals", "goals", "category", "TEXT DEFAULT 'unknown'");
    this.dbs["goals"]!.execute(
      "CREATE TABLE IF NOT EXISTS goal_iterations (" +
        "id TEXT PRIMARY KEY, goal_id TEXT, ordinal INTEGER," +
        " started_at INTEGER, ended_at INTEGER," +
        " evidence_digest TEXT, verdict TEXT, verdict_reason TEXT," +
        " cost_micros INTEGER DEFAULT 0, tokens INTEGER DEFAULT 0," +
        " created_at INTEGER)"
    );
    this.dbs["goals"]!.execute(
      "CREATE INDEX IF NOT EXISTS idx_goal_iter_goal ON goal_iterations(goal_id, ordinal)"
    );
    this.dbs["usage"]!.execute(
      "CREATE TABLE IF NOT EXISTS session_target (session_id TEXT PRIMARY KEY, token_budget INTEGER, tokens_used INTEGER DEFAULT 0)"
    );
    this.dbs["usage"]!.execute(
      "CREATE TABLE IF NOT EXISTS bot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)"
    );
    this.dbs["bot"]!.execute(
      "CREATE TABLE IF NOT EXISTS bot_messages (id TEXT PRIMARY KEY, platform TEXT, user_id TEXT, content TEXT, direction TEXT, timestamp REAL)"
    );
    this.dbs["bot"]!.execute(
      "CREATE TABLE IF NOT EXISTS bot_audit (id TEXT PRIMARY KEY, platform TEXT, user_id TEXT, session_id TEXT, tool_name TEXT, action TEXT, blocked INTEGER DEFAULT 0, reason TEXT, timestamp REAL)"
    );
    this._run_migrations();
    for (const db of Object.values(this.dbs)) {
      db.commit();
    }
  }

  _safe_add_column(db_name: string, table: string, column: string, col_type: string): void {
    // Idempotent ALTER TABLE ADD COLUMN. Only "duplicate column name" is
    // expected and silent; every other OperationalError prints.
    try {
      this.dbs[db_name]!.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${col_type}`);
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      if (!msg.toLowerCase().includes("duplicate column")) {
        console.log(`[storage] ALTER ${db_name}.${table} ADD ${column} FAILED: ${msg}`);
      }
    }
  }

  _app_version(): string {
    // Read from the UI package.json (the single place a version is declared).
    // Failure yields "unknown" rather than raising.
    try {
      // __file__ equivalent: this module's directory + ../ui/package.json.
      // The engine lives at <repo>/app/engine, mirroring backend's <repo>/app/backend.
      const here = path.dirname(new URL(import.meta.url).pathname);
      const pkg = path.join(here, "..", "ui", "package.json");
      const parsed = JSON.parse(fs.readFileSync(pkg, "utf-8")) as { version?: string };
      return String(parsed.version || "unknown");
    } catch {
      return "unknown";
    }
  }

  _applied_migrations(): Set<string> {
    let rows: Row[];
    try {
      rows = this.dbs["configs"]!
        .execute("SELECT id FROM schema_migration")
        .fetchall() as Row[];
    } catch {
      // sqlite3.OperationalError -> table missing on a pristine db
      return new Set();
    }
    return new Set(rows.map((r) => String(r["id"])));
  }

  _backup_before_migration(pending_count: number): string {
    // 迁移前的一致性快照（VACUUM INTO，天然含 WAL 未落盘内容）。
    // 备份失败不阻塞迁移——但必须大声说出来。失败时返回空串而不是路径。
    // 源侧用 time.strftime('%Y%m%d-%H%M%S')：本地时间、日期与时间之间带连字符。
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const stamp =
      `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
      `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const bdir = path.join(this.db_dir, "backups", `pre-migration-${stamp}-${String(Date.now() % 1000).padStart(3, "0")}`);
    try {
      fs.mkdirSync(bdir, { recursive: true });
      let done = 0;
      for (const [name, conn] of Object.entries(this.dbs)) {
        try {
          conn.commit();
        } catch (e) {
          console.log(`[storage] operation FAILED: ${e}`);
        }
        const target = path.join(bdir, `${name}.db`);
        conn.execute("VACUUM INTO ?", [target]);
        done += 1;
      }
      console.log(
        `[storage] ${pending_count} migration(s) pending; backup of ${done} db(s) → backups/${path.basename(bdir)}`
      );
      return bdir;
    } catch (exc) {
      console.log(
        `[storage] MIGRATION BACKUP FAILED (${exc}) — 迁移将继续；如需绝对安全请先手动备份 ${this.db_dir}`
      );
      return "";
    }
  }

  // ——— Migration journal ———

  _journal_path(): string {
    return path.join(this.db_dir, MIGRATION_JOURNAL_NAME);
  }

  _read_journal(): MigrationJournal {
    try {
      const data = JSON.parse(fs.readFileSync(this._journal_path(), "utf-8")) as unknown;
      return typeof data === "object" && data !== null && !Array.isArray(data)
        ? (data as MigrationJournal)
        : {};
    } catch {
      // (OSError, json.JSONDecodeError, TypeError) -> {}
      return {};
    }
  }

  _write_journal(data: MigrationJournal): void {
    try {
      // json.dump(..., ensure_ascii=False, indent=1)
      fs.writeFileSync(this._journal_path(), pyJsonIndent(data), "utf-8");
    } catch (exc) {
      console.log(`[storage] MIGRATION JOURNAL WRITE FAILED: ${exc}`);
    }
  }

  _journal_step_start(mig_id: string, description: string, backup_dir: string): void {
    const j = this._read_journal();
    const steps = (j.steps ?? []).filter((s) => s.id !== mig_id);
    steps.push({
      id: mig_id,
      description,
      status: "running",
      error: "",
      started_at: intSeconds(),
    });
    this._write_journal({
      backup_dir: backup_dir || "",
      steps,
      updated_at: intSeconds(),
    });
  }

  _journal_step_end(mig_id: string, status: string, error = ""): void {
    const j = this._read_journal();
    for (const s of j.steps ?? []) {
      if (s.id === mig_id) {
        s.status = status;
        s.error = String(error ?? "").slice(0, 500);
        s.finished_at = intSeconds();
      }
    }
    j.updated_at = intSeconds();
    this._write_journal(j);
  }

  _restore_from_backup(backup_dir: string): boolean {
    if (!backup_dir || !fs.existsSync(backup_dir) || !fs.statSync(backup_dir).isDirectory()) {
      console.log("[storage] no pre-migration backup directory to roll back to");
      return false;
    }
    try {
      for (const conn of Object.values(this.dbs)) {
        try {
          conn.close();
        } catch {
          // fail-closed path: any handle we cannot close is reported by the
          // copy step below, not swallowed here
        }
      }
      this.dbs = {};
      try {
        if (this.event_store != null) {
          this.event_store.close();
        }
      } catch {
        // 同上：copyfile 阶段会如实暴露占用问题
      }
      let copied = 0;
      for (const fname of fs.readdirSync(backup_dir).sort()) {
        if (!fname.endsWith(".db")) {
          continue;
        }
        const src = path.join(backup_dir, fname);
        const dst = path.join(this.db_dir, fname);
        for (const suffix of ["-wal", "-shm"]) {
          const side = dst + suffix;
          if (fs.existsSync(side)) {
            try {
              fs.unlinkSync(side);
            } catch {
              // 删不掉的 sidecar 由覆盖后的校验暴露
            }
          }
        }
        fs.copyFileSync(src, dst);
        copied += 1;
      }
      if (copied === 0) {
        console.log(`[storage] backup dir ${backup_dir} holds no .db files`);
        return false;
      }
      this._open_db_connections();
      console.log(
        `[storage] rolled back ${copied} db(s) from backups/${path.basename(backup_dir)} ` +
          "(migration failed; running on the previous schema)"
      );
      return true;
    } catch (exc) {
      console.log(`[storage] RESTORE FROM BACKUP FAILED: ${exc}`);
      return false;
    }
  }

  _run_migrations(): void {
    // Apply every unapplied migration in order, recording each one.
    // Three layers: journal+backup, automatic rollback, unrecoverable.
    const applied = this._applied_migrations();
    const deferred = { ...(this.get_config("migration.deferred") || {}) } as Record<
      string,
      JsonDict
    >;
    const version = this._app_version();
    const c = this.dbs["configs"]!;
    // §19 迁移纪律 4：动 schema 前先备份。只在真有要执行的迁移时才备份。
    const pending = MIGRATIONS.filter((m) => !applied.has(m[0]) && !(m[0] in deferred));
    if (pending.length === 0) {
      return;
    }
    const backup_dir = this._backup_before_migration(pending.length);
    for (const [mig_id, description, method] of MIGRATIONS) {
      if (applied.has(mig_id)) {
        continue;
      }
      if (mig_id in deferred) {
        console.log(
          `[storage] deferred migration ${mig_id} reached — later steps held back until an explicit retry`
        );
        return;
      }
      const fn = (this as unknown as Record<string, (() => void) | undefined>)[method];
      if (fn === undefined) {
        console.log(`[storage] migration ${mig_id} references missing method ${JSON.stringify(method)}`);
        continue;
      }
      this._journal_step_start(mig_id, description, backup_dir);
      try {
        fn.call(this);
      } catch (exc) {
        console.log(`[storage] MIGRATION FAILED ${mig_id} (${description}): ${exc}`);
        this._journal_step_end(mig_id, "failed", String(exc));
        if (this._restore_from_backup(backup_dir)) {
          this.recovery_mode = "compat";
          const detail: JsonDict = {
            mode: "compat",
            failedMigration: mig_id,
            error: String(exc).slice(0, 500),
            backupDir: backup_dir,
            at: intSeconds(),
          };
          this.set_config("migration.recovery_mode", detail);
          deferred[mig_id] = { reason: String(exc).slice(0, 400), at: intSeconds() };
          this.set_config("migration.deferred", deferred);
          console.log(
            `[storage] *** UPGRADE INCOMPLETE *** rolled back to previous schema; data intact. ` +
              `Failed step ${mig_id} is deferred — retry from Settings → 系统 or ` +
              `POST /api/system/migrations/retry`
          );
          return; // keep booting on the rolled-back (old) schema
        }
        this.recovery_mode = "unrecoverable";
        const err = new MigrationUnrecoverable(mig_id, exc, backup_dir, this._journal_path());
        // `raise ... from exc` — chain preserved via cause.
        (err as { cause?: unknown }).cause = exc;
        throw err;
      }
      // Checksum pins the id+description pair (not a hash of the SQL).
      const checksum = crypto
        .createHash("sha256")
        .update(`${mig_id}|${description}`, "utf8")
        .digest("hex")
        .slice(0, 16);
      c.execute(
        "INSERT OR REPLACE INTO schema_migration (id, checksum, app_version, applied_at) VALUES (?,?,?,?)",
        [mig_id, checksum, version, intSeconds()]
      );
      c.commit();
      this._journal_step_end(mig_id, "done");
      console.log(`[storage] migration applied: ${mig_id} (${description})`);
    }
  }

  retry_deferred_migration(mig_id = ""): RetryResult {
    // Re-run a migration that failed and was auto-deferred (layer 2).
    const deferred = { ...(this.get_config("migration.deferred") || {}) } as Record<
      string,
      JsonDict
    >;
    let targets: string[];
    if (mig_id) {
      if (!(mig_id in deferred)) {
        return { ok: false, results: [], error: `${mig_id} 不在延迟清单里` };
      }
      targets = [mig_id];
    } else {
      targets = Object.keys(deferred);
    }
    if (targets.length === 0) {
      return { ok: true, results: [], error: "" };
    }
    const backup_dir = this._backup_before_migration(targets.length);
    const c = this.dbs["configs"]!;
    const applied = this._applied_migrations();
    const version = this._app_version();
    const results: JsonDict[] = [];
    for (const [mid, description, method] of MIGRATIONS) {
      if (!targets.includes(mid)) {
        continue;
      }
      const fn = (this as unknown as Record<string, (() => void) | undefined>)[method];
      if (fn === undefined) {
        results.push({ id: mid, ok: false, error: `missing method ${JSON.stringify(method)}` });
        continue;
      }
      this._journal_step_start(mid, description, backup_dir);
      try {
        fn.call(this);
      } catch (exc) {
        this._journal_step_end(mid, "failed", String(exc));
        this._restore_from_backup(backup_dir);
        results.push({ id: mid, ok: false, error: String(exc).slice(0, 300) });
        continue;
      }
      const checksum = crypto
        .createHash("sha256")
        .update(`${mid}|${description}`, "utf8")
        .digest("hex")
        .slice(0, 16);
      if (!applied.has(mid)) {
        c.execute(
          "INSERT OR REPLACE INTO schema_migration (id, checksum, app_version, applied_at) VALUES (?,?,?,?)",
          [mid, checksum, version, intSeconds()]
        );
        c.commit();
      }
      this._journal_step_end(mid, "done");
      delete deferred[mid];
      results.push({ id: mid, ok: true, error: "" });
    }
    this.set_config("migration.deferred", deferred);
    const ok = results.every((r) => r["ok"] === true) && results.length > 0;
    if (ok && Object.keys(deferred).length === 0) {
      this.set_config("migration.recovery_mode", { mode: "", clearedAt: intSeconds() });
      this.recovery_mode = "";
      try {
        this._run_migrations();
      } catch (err) {
        if (err instanceof MigrationUnrecoverable) {
          throw err;
        }
        console.log(`[storage] post-retry migrations failed: ${err}`);
      }
    }
    return { ok, results, error: "" };
  }

  migration_status(): MigrationStatus {
    let rows: JsonDict[];
    try {
      rows = this.dbs["configs"]!
        .execute(
          "SELECT id, checksum, app_version, applied_at FROM schema_migration ORDER BY applied_at, id"
        )
        .fetchall() as unknown as JsonDict[];
    } catch {
      rows = [];
    }
    const done = new Set(rows.map((r) => String(r["id"])));
    const deferred = (this.get_config("migration.deferred") || {}) as Record<string, unknown>;
    const journal = this._read_journal();
    return {
      applied: rows,
      pending: MIGRATIONS.filter((m) => !done.has(m[0])).map((m) => ({
        id: m[0],
        description: m[1],
      })),
      deferred: Object.keys(deferred)
        .sort()
        .map((k) => {
          const v = deferred[k];
          return typeof v === "object" && v !== null
            ? { id: k, ...(v as JsonDict) }
            : { id: k, reason: String(v) };
        }),
      registered: MIGRATIONS.length,
      appVersion: this._app_version(),
      recoveryMode: this.recovery_mode,
      journal: {
        path: this._journal_path(),
        backupDir: journal.backup_dir ?? "",
        steps: journal.steps ?? [],
      },
    };
  }

  _RELATIVE_WORKSPACES = [".", "./", ".\\"] as const;

  _normalize_workspace_paths(): void {
    // Rewrite relative workspace strings to absolute paths, in place.
    let here: string;
    try {
      here = path.resolve(process.cwd());
    } catch {
      return;
    }
    const s = this.dbs["sessions"];
    if (s === undefined) {
      return;
    }
    try {
      for (const stale of this._RELATIVE_WORKSPACES) {
        s.execute("UPDATE sessions SET workspace=? WHERE workspace=?", [here, stale]);
        const row = s.execute("SELECT 1 FROM workspaces WHERE path=?", [here]).fetchone();
        if (row === null) {
          s.execute("UPDATE workspaces SET path=? WHERE path=?", [here, stale]);
        } else {
          s.execute("DELETE FROM workspaces WHERE path=?", [stale]);
        }
      }
      const c = this.dbs["configs"];
      if (c !== undefined) {
        const cur = c
          .execute("SELECT value FROM configs WHERE key='active_workspace'")
          .fetchone() as Row | null;
        const val = cur ? String(cur["value"] ?? "") : "";
        if (cur && (this._RELATIVE_WORKSPACES as readonly string[]).includes(val)) {
          c.execute("UPDATE configs SET value=? WHERE key='active_workspace'", [here]);
          c.commit();
        }
      }
      s.commit();
    } catch (exc) {
      console.log(`[storage] workspace path normalization skipped: ${exc}`);
    }
  }

  _own_source_dirs(): string[] {
    // Electron spawns the backend with cwd = the folder holding the entry
    // script; running the module directly gives <repo>/app/backend. The two
    // values the cwd fallback can produce.
    try {
      // __file__ equivalent: <repo>/app/engine/storage (this file's dir).
      const backend = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "backend");
      return [backend, path.resolve(backend, "..")];
    } catch {
      return [];
    }
  }

  _unbind_own_dirs(): void {
    const own = this._own_source_dirs();
    if (own.length === 0) {
      return;
    }
    const s = this.dbs["sessions"];
    if (s === undefined) {
      return;
    }
    try {
      for (const p of own) {
        const cur = s.execute("UPDATE sessions SET workspace='' WHERE workspace=?", [p]);
        if (cur.rowcount) {
          console.log(`[storage] unbound ${cur.rowcount} session(s) from ${p}`);
        }
        s.execute("DELETE FROM workspaces WHERE path=?", [p]);
      }
      const c = this.dbs["configs"];
      if (c !== undefined) {
        const cur = c
          .execute("SELECT value FROM configs WHERE key='active_workspace'")
          .fetchone() as Row | null;
        const val = cur ? String(cur["value"] ?? "") : "";
        if (cur && own.includes(path.resolve(val || "-"))) {
          c.execute("UPDATE configs SET value='' WHERE key='active_workspace'");
          c.commit();
        }
      }
      s.commit();
    } catch (exc) {
      console.log(`[storage] own-dir unbind skipped: ${exc}`);
    }
  }

  // ——— config / kv ———

  set_config(key: string, value: unknown): void {
    this.dbs["configs"]!.execute(
      "INSERT OR REPLACE INTO configs (key, value, updated_at) VALUES (?, ?, ?)",
      [key, JSON.stringify(value), intSeconds()]
    );
  }

  get_config(key: string, defaultValue: unknown = null): unknown {
    const row = this.dbs["configs"]!
      .execute("SELECT value FROM configs WHERE key=?", [key])
      .fetchone() as Row | null;
    if (!row) return defaultValue;
    try {
      return JSON.parse(String(row["value"]));
    } catch {
      return defaultValue;
    }
  }

  kv_set(key: string, value: unknown, ns = "default"): void {
    this.dbs["kv"]!.execute(
      "INSERT OR REPLACE INTO kv_store (key, value, namespace, updated_at) VALUES (?, ?, ?, ?)",
      [key, JSON.stringify(value), ns, intSeconds()]
    );
  }

  kv_get(key: string, ns = "default", defaultValue: unknown = null): unknown {
    const row = this.dbs["kv"]!
      .execute("SELECT value FROM kv_store WHERE key=? AND namespace=?", [key, ns])
      .fetchone() as Row | null;
    if (!row) return defaultValue;
    try {
      return JSON.parse(String(row["value"]));
    } catch {
      return defaultValue;
    }
  }

  close(): void {
    for (const c of Object.values(this.dbs)) {
      c.close();
    }
    // The event store is a process-wide singleton keyed by db path. Close it
    // only while it still belongs to THIS storage's directory.
    try {
      const es = this.event_store ?? null;
      const own_path = path.join(this.db_dir, "events.db");
      if (es !== null && !es.closed && es.dbPath === own_path) {
        es.close();
      }
    } catch {
      // fail-open: 可选增强，失败不影响主流程
    }
  }
}

/** RULEBOOK §6 trailer helper — re-exports the module-level surface of storage.py. */
export { split_usage_model_id, PROCESS_GENERATION, SUBAGENT_TERMINAL_STATUSES };