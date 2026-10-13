"use strict";
/**
 * storage.ts 鈥?SQLite one-db-one-responsibility + session branch tree + migrations.
 *
 * Ported from `app/backend/storage.py` (5882 lines).
 *
 * ARCHITECTURE (RULEBOOK 搂0 redesign): one source module 鈫?one class split
 * across domain mixins under `storage/`. The Storage class composes all of
 * them and owns the shared connection pool, migration framework and the
 * config/KV surface every mixin relies on. One source module, one target
 * root: `storage/index.ts` re-exports the same names `import storage` gave
 * Python callers.
 *
 * RULEBOOK CITATIONS
 *   搂1  node:sqlite builtin via sqlite_connection.ts; no new dependency.
 *   搂2  _SerializedConn threading: Node's event loop serializes JS; the
 *       connection adapter remains synchronous, so the RLock's guarantee
 *       (no interleaved execute on one connection) holds structurally.
 *   搂2  broad swallows (`except Exception: pass` / bare `except:`) are
 *       preserved verbatim with BUG(port) comments at each site.
 *   搂2  Python float `time.time()` vs int `time.time()`: timestamps that the
 *       source wrote as INTEGER use intSeconds(); REAL columns use nowMs().
 *   搂4  naming: app/backend/storage.py -> app/engine/storage/ (+ index.ts)
 *
 * PORT STATUS: confidence=medium todos=2
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUBAGENT_TERMINAL_STATUSES = exports.PROCESS_GENERATION = exports.split_usage_model_id = exports.StorageBase = exports.MigrationUnrecoverable = void 0;
exports.intSeconds = intSeconds;
exports.nowMs = nowMs;
exports.uuidHex = uuidHex;
exports.uuidHex12 = uuidHex12;
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sqlite_connection_js_1 = require("../sqlite_connection.cjs");
const event_store_js_1 = require("../event_store.cjs");
const session_audit_js_1 = require("../session_audit.cjs");
const session_logger_js_1 = require("../session_logger.cjs");
const trace_gateway_js_1 = require("../trace_gateway.cjs");
const projection_engine_js_1 = require("../projection_engine.cjs");
const user_dirs_js_1 = require("../user_dirs.cjs");
const storage_funcs_js_1 = require("./storage_funcs.cjs");
Object.defineProperty(exports, "split_usage_model_id", { enumerable: true, get: function () { return storage_funcs_js_1.split_usage_model_id; } });
const storage_consts_js_1 = require("./storage_consts.cjs");
Object.defineProperty(exports, "PROCESS_GENERATION", { enumerable: true, get: function () { return storage_consts_js_1.PROCESS_GENERATION; } });
const storage_consts_js_2 = require("./storage_consts.cjs");
const storage_consts_js_3 = require("./storage_consts.cjs");
Object.defineProperty(exports, "SUBAGENT_TERMINAL_STATUSES", { enumerable: true, get: function () { return storage_consts_js_3.SUBAGENT_TERMINAL_STATUSES; } });
// 鈥斺€斺€?module-level helpers of storage.py 鈥斺€斺€?/** Loud degradation for audit-side writes (see source docstring). */
function _audit_write_failed(what, exc) {
    // log.error(..., exc_info=True) equivalent: print with the stack.
    console.error(`[audit] event write failed during ${what}:`, exc);
}
/** int(time.time()) equivalent. */
function intSeconds() {
    return Math.floor(Date.now() / 1000);
}
/** int(time.time() * 1000) equivalent. */
function nowMs() {
    return Date.now();
}
/** uuid4 hex (32 chars). */
function uuidHex() {
    return crypto.randomUUID().replace(/-/g, "");
}
/** uuid4().hex[:12] 鈥?12-char prefix used by several id fields. */
function uuidHex12() {
    return uuidHex().slice(0, 12);
}
class MigrationUnrecoverable extends Error {
    migId;
    original;
    backupDir;
    journalPath;
    constructor(mig_id, original, backup_dir, journal_path) {
        super(`migration ${mig_id} failed (${original}) and restore from backup ` +
            `${backup_dir || "(none)"} also failed 鈥?database left untouched; ` +
            `use the recovery mode to export or repair it`);
        this.name = "MigrationUnrecoverable";
        this.migId = mig_id;
        this.original = original;
        this.backupDir = backup_dir;
        this.journalPath = journal_path;
    }
}
exports.MigrationUnrecoverable = MigrationUnrecoverable;
/**
 * Base class carrying the connection pool, migration framework, config/KV and
 * the workspace normalization passes. Domain mixins add their methods onto
 * subclasses of this via plain TS mixin classes (see storage/*.ts).
 */
class StorageBase {
    db_dir;
    recovery_mode = "";
    dbs = {};
    event_store;
    trace;
    /** Python-name alias of {@link trace} 鈥?domain mixins use the source name. */
    get _trace() {
        return this.trace;
    }
    projection_engine;
    session_logger;
    session_audit;
    session_fts_enabled = false;
    fts_enabled = false;
    emb_hits_buffer = new Map();
    static DB_DIR_ENV = "OVOLVE_DB_DIR";
    static LEGACY_DB_DIR_ENV = "OVOLVE_DB_DIR";
    constructor(db_dir) {
        this.db_dir =
            db_dir ??
                process.env[StorageBase.DB_DIR_ENV] ??
                process.env[StorageBase.LEGACY_DB_DIR_ENV] ??
                (0, user_dirs_js_1.dbDir)();
        fs.mkdirSync(this.db_dir, { recursive: true });
        this._open_db_connections();
        this.session_logger = (0, session_logger_js_1.getSessionLogger)(path.join(this.db_dir, "..", "logs", "sessions"));
        this.session_audit = new session_audit_js_1.SessionAuditTrack(path.join(this.db_dir, "..", "logs", "sessions"), undefined, (sid) => this._session_parent_id(sid));
        this._migrate();
    }
    _session_parent_id(sid) {
        try {
            const row = this._db("sessions")
                .execute("SELECT parent_id FROM sessions WHERE id=?", [sid])
                .fetchone();
            if (!row)
                return "";
            return String(row["parent_id"] ?? "") || "";
        }
        catch {
            // RULEBOOK 搂2: `except Exception: return ""` 鈥?鍏宠仈瀛楁缂哄け涓嶈褰卞搷瀹¤钀界洏
            return "";
        }
    }
    _open_db_connections() {
        // Split out of __init__ because the migration rollback path must close
        // all handles, copy backup files over the live ones, and open them again
        // 鈥?on Windows an unclosed sqlite handle keeps the old file bytes pinned.
        this.dbs = {};
        for (const name of storage_consts_js_2.DB_NAMES) {
            const p = path.join(this.db_dir, `${name}.db`);
            this.dbs[name] = (0, sqlite_connection_js_1.openSqlite)(p);
            // PRAGMAs the source sets per connection. node:sqlite opens in WAL-
            // capable mode; journal_mode and busy_timeout are set explicitly to
            // keep behaviour identical under concurrent writers.
            this.dbs[name].execute("PRAGMA journal_mode=WAL");
            this.dbs[name].execute("PRAGMA foreign_keys=ON");
            this.dbs[name].execute("PRAGMA busy_timeout=60000");
        }
        this.event_store = (0, event_store_js_1.get_event_store)(path.join(this.db_dir, "events.db"));
        // All new business events go through the canonical gateway (Phase 1).
        this.trace = new trace_gateway_js_1.TraceGateway(this.event_store);
        this.projection_engine = (0, projection_engine_js_1.get_projection_engine)(this.event_store);
    }
    _db(name) {
        return this.dbs[name];
    }
    _migrate() {
        const c = this.dbs["configs"];
        c.execute("CREATE TABLE IF NOT EXISTS schema_migration (id TEXT PRIMARY KEY, checksum TEXT, app_version TEXT, applied_at INTEGER)");
        c.execute("CREATE TABLE IF NOT EXISTS configs (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)");
        this.dbs["kv"].execute("CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT, namespace TEXT DEFAULT 'default', updated_at INTEGER)");
        const s = this.dbs["sessions"];
        s.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER, goal_state TEXT, parent_id TEXT, branch_point TEXT)");
        s.execute("CREATE TABLE IF NOT EXISTS session_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, msg_type TEXT DEFAULT 'message', metadata TEXT DEFAULT '{}', created_at INTEGER, seq INTEGER)");
        // Session message FTS5 鈥?cross-session conversation search.
        this.session_fts_enabled = false;
        try {
            s.execute("CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(" +
                "body, session_id UNINDEXED, message_id UNINDEXED, tokenize='unicode61')");
            this.session_fts_enabled = true;
        }
        catch {
            // RULEBOOK 搂2: bare except -> swallow; FTS5 unavailable degrades search.
        }
        if (this.session_fts_enabled) {
            try {
                const n = Number(this._db("sessions").execute("SELECT COUNT(*) AS c FROM session_fts").fetchone()["c"]);
                if (n === 0) {
                    this.rebuild_session_fts();
                }
            }
            catch {
                // except Exception: pass
            }
        }
        s.execute("CREATE TABLE IF NOT EXISTS workspaces (path TEXT PRIMARY KEY, display_name TEXT DEFAULT '', pinned INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, last_opened_at INTEGER DEFAULT 0, settings_json TEXT DEFAULT '{}', created_at INTEGER)");
        this.dbs["goals"].execute("CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, description TEXT, status TEXT DEFAULT 'started', iteration INTEGER DEFAULT 0, session_id TEXT, created_at INTEGER, updated_at INTEGER, verification_result TEXT)");
        this.dbs["cron"].execute("CREATE TABLE IF NOT EXISTS cron_jobs (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, cron_expr TEXT, delay_minutes INTEGER, recurring INTEGER DEFAULT 1, max_runs INTEGER, next_run_at INTEGER, last_run_at INTEGER, run_count INTEGER DEFAULT 0, status TEXT DEFAULT 'active', bot_delivery_target TEXT, session_id TEXT, created_at INTEGER)");
        this.dbs["memory"].execute("CREATE TABLE IF NOT EXISTS memory_entries (id TEXT PRIMARY KEY, session_id TEXT, root_dir TEXT, scope TEXT DEFAULT 'project', content TEXT, embedding BLOB, metadata TEXT DEFAULT '{}', created_at INTEGER, updated_at INTEGER)");
        this.dbs["memory"].execute("CREATE TABLE IF NOT EXISTS project_memory_index (id TEXT PRIMARY KEY, root_dir TEXT UNIQUE, index_content TEXT, last_dream_at INTEGER, last_extract_at INTEGER, version INTEGER DEFAULT 1)");
        this.dbs["memory"].execute("CREATE TABLE IF NOT EXISTS session_synthesis (session_id TEXT PRIMARY KEY, synthesis TEXT, created_at INTEGER)");
        // Embedding cache (see source comment re: the 384-dim vs 768-dim killer bug).
        this.dbs["memory"].execute("CREATE TABLE IF NOT EXISTS embedding_cache (" +
            "key TEXT PRIMARY KEY, provider TEXT, model TEXT, dim INTEGER, " +
            "vector BLOB, created_at INTEGER, last_used_at INTEGER, hits INTEGER DEFAULT 0)");
        this.dbs["memory"].execute("CREATE INDEX IF NOT EXISTS idx_embcache_used ON embedding_cache(last_used_at)");
        // Add columns for enhanced memory (idempotent ALTER TABLE)
        this._safe_add_column("memory", "memory_entries", "type", "TEXT DEFAULT 'fact'");
        this._safe_add_column("memory", "memory_entries", "importance", "REAL DEFAULT 0.5");
        this._safe_add_column("memory", "memory_entries", "tags", "TEXT DEFAULT '[]'");
        this._safe_add_column("memory", "memory_entries", "archived", "INTEGER DEFAULT 0");
        this._safe_add_column("memory", "memory_entries", "tier", "TEXT DEFAULT 'semantic'");
        this._safe_add_column("memory", "memory_entries", "hits", "INTEGER DEFAULT 0");
        this._safe_add_column("memory", "memory_entries", "accessed_at", "INTEGER DEFAULT 0");
        this.dbs["memory"].execute("CREATE INDEX IF NOT EXISTS idx_mem_tier ON memory_entries(tier, root_dir)");
        // C2 hybrid retrieval: FTS5 side-index for the lexical channel.
        this.fts_enabled = false;
        try {
            this.dbs["memory"].execute("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(" +
                "body, root_dir UNINDEXED, entry_id UNINDEXED, tokenize='unicode61')");
            this.fts_enabled = true;
        }
        catch {
            // fail-open: 鍙€夊寮猴紝澶辫触涓嶅奖鍝嶄富娴佺▼
        }
        // Phase 59 鍐呭寲: 瀹炰綋鍏崇郴鍥捐氨琛?(Graph Memory Engine)
        this.dbs["memory"].execute("CREATE TABLE IF NOT EXISTS graph_entities (" +
            "id TEXT PRIMARY KEY, root_dir TEXT, type TEXT NOT NULL, name TEXT NOT NULL, " +
            "properties_json TEXT DEFAULT '{}', created_at INTEGER, updated_at INTEGER)");
        this.dbs["memory"].execute("CREATE TABLE IF NOT EXISTS graph_relations (" +
            "id TEXT PRIMARY KEY, root_dir TEXT, source_id TEXT NOT NULL, target_id TEXT NOT NULL, " +
            "relation_type TEXT NOT NULL, confidence REAL DEFAULT 1.0, created_at INTEGER)");
        this.dbs["memory"].execute("CREATE INDEX IF NOT EXISTS idx_graph_ent_name ON graph_entities(name, root_dir)");
        this.dbs["memory"].execute("CREATE INDEX IF NOT EXISTS idx_graph_rel_edge ON graph_relations(source_id, target_id)");
        this._safe_add_column("memory", "project_memory_index", "last_dream_at", "INTEGER DEFAULT 0");
        this._safe_add_column("sessions", "sessions", "pinned", "INTEGER DEFAULT 0");
        this._safe_add_column("sessions", "sessions", "workspace", "TEXT DEFAULT ''");
        this._safe_add_column("sessions", "sessions", "turn_status", "TEXT DEFAULT 'idle'");
        this._safe_add_column("sessions", "sessions", "turn_substatus", "TEXT DEFAULT ''");
        this._safe_add_column("sessions", "sessions", "status_updated_at", "INTEGER DEFAULT 0");
        this._normalize_workspace_paths();
        this._unbind_own_dirs();
        // turn_usage must exist BEFORE the ALTERs and the backfill below.
        this.dbs["usage"].execute("CREATE TABLE IF NOT EXISTS turn_usage (id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, model_id TEXT DEFAULT '', input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_creation INTEGER, cache_read INTEGER, provider_total INTEGER, computed_total INTEGER, model_retry INTEGER DEFAULT 0, retryable INTEGER DEFAULT 1, context_exceeded INTEGER DEFAULT 0, error_type TEXT, latency_ms INTEGER DEFAULT 0, cost_micros INTEGER DEFAULT 0, cache_saved_micros INTEGER DEFAULT 0, cost_source TEXT DEFAULT '', created_at INTEGER)");
        this._safe_add_column("usage", "turn_usage", "model_id", "TEXT DEFAULT ''");
        this._safe_add_column("usage", "turn_usage", "latency_ms", "INTEGER DEFAULT 0");
        this._safe_add_column("usage", "turn_usage", "cost_micros", "INTEGER DEFAULT 0");
        this._safe_add_column("usage", "turn_usage", "cache_saved_micros", "INTEGER DEFAULT 0");
        this._safe_add_column("usage", "turn_usage", "cost_source", "TEXT DEFAULT ''");
        try {
            const u = this.dbs["usage"];
            u.execute("UPDATE turn_usage SET model_id = 'openai:LongCat-2.0' WHERE model_id IN ('custom:', 'custom', 'custom:LongCat-2.0', '')");
            u.execute("UPDATE turn_usage SET model_id = 'openai:' || SUBSTR(model_id, 8) WHERE model_id LIKE 'custom:%'");
            u.commit();
        }
        catch (e) {
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
        this.dbs["goals"].execute("CREATE TABLE IF NOT EXISTS goal_iterations (" +
            "id TEXT PRIMARY KEY, goal_id TEXT, ordinal INTEGER," +
            " started_at INTEGER, ended_at INTEGER," +
            " evidence_digest TEXT, verdict TEXT, verdict_reason TEXT," +
            " cost_micros INTEGER DEFAULT 0, tokens INTEGER DEFAULT 0," +
            " created_at INTEGER)");
        this.dbs["goals"].execute("CREATE INDEX IF NOT EXISTS idx_goal_iter_goal ON goal_iterations(goal_id, ordinal)");
        this.dbs["usage"].execute("CREATE TABLE IF NOT EXISTS session_target (session_id TEXT PRIMARY KEY, token_budget INTEGER, tokens_used INTEGER DEFAULT 0)");
        this.dbs["usage"].execute("CREATE TABLE IF NOT EXISTS bot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)");
        this.dbs["bot"].execute("CREATE TABLE IF NOT EXISTS bot_messages (id TEXT PRIMARY KEY, platform TEXT, user_id TEXT, content TEXT, direction TEXT, timestamp REAL)");
        this.dbs["bot"].execute("CREATE TABLE IF NOT EXISTS bot_audit (id TEXT PRIMARY KEY, platform TEXT, user_id TEXT, session_id TEXT, tool_name TEXT, action TEXT, blocked INTEGER DEFAULT 0, reason TEXT, timestamp REAL)");
        this._run_migrations();
        for (const db of Object.values(this.dbs)) {
            db.commit();
        }
    }
    _safe_add_column(db_name, table, column, col_type) {
        // Idempotent ALTER TABLE ADD COLUMN. Only "duplicate column name" is
        // expected and silent; every other OperationalError prints.
        try {
            this.dbs[db_name].execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${col_type}`);
        }
        catch (exc) {
            const msg = exc instanceof Error ? exc.message : String(exc);
            if (!msg.toLowerCase().includes("duplicate column")) {
                console.log(`[storage] ALTER ${db_name}.${table} ADD ${column} FAILED: ${msg}`);
            }
        }
    }
    _app_version() {
        // Read from the UI package.json (the single place a version is declared).
        // Failure yields "unknown" rather than raising.
        try {
            // __file__ equivalent: this module's directory + ../ui/package.json.
            // The engine lives at <repo>/app/engine, mirroring backend's <repo>/app/backend.
            const here = path.dirname(new URL(import.meta.url).pathname);
            const pkg = path.join(here, "..", "ui", "package.json");
            const parsed = JSON.parse(fs.readFileSync(pkg, "utf-8"));
            return String(parsed.version || "unknown");
        }
        catch {
            return "unknown";
        }
    }
    _applied_migrations() {
        let rows;
        try {
            rows = this.dbs["configs"]
                .execute("SELECT id FROM schema_migration")
                .fetchall();
        }
        catch {
            // sqlite3.OperationalError -> table missing on a pristine db
            return new Set();
        }
        return new Set(rows.map((r) => String(r["id"])));
    }
    _backup_before_migration(pending_count) {
        // 杩佺Щ鍓嶇殑涓€鑷存€у揩鐓э紙VACUUM INTO锛屽ぉ鐒跺惈 WAL 鏈惤鐩樺唴瀹癸級銆?        // 澶囦唤澶辫触涓嶉樆濉炶縼绉烩€斺€斾絾蹇呴』澶у０璇村嚭鏉ャ€傚け璐ユ椂杩斿洖绌轰覆鑰屼笉鏄矾寰勩€?        const stamp = new Date()
            .toISOString()
            .replace(/[-:T]/g, "")
            .replace(/\..*$/, "")
            .slice(0, 14);
        const bdir = path.join(this.db_dir, "backups", `pre-migration-${stamp}-${String(Date.now() % 1000).padStart(3, "0")}`);
        try {
            fs.mkdirSync(bdir, { recursive: true });
            let done = 0;
            for (const [name, conn] of Object.entries(this.dbs)) {
                try {
                    conn.commit();
                }
                catch (e) {
                    console.log(`[storage] operation FAILED: ${e}`);
                }
                const target = path.join(bdir, `${name}.db`);
                conn.execute("VACUUM INTO ?", [target]);
                done += 1;
            }
            console.log(`[storage] ${pending_count} migration(s) pending; backup of ${done} db(s) 鈫?backups/${path.basename(bdir)}`);
            return bdir;
        }
        catch (exc) {
            console.log(`[storage] MIGRATION BACKUP FAILED (${exc}) 鈥?杩佺Щ灏嗙户缁紱濡傞渶缁濆瀹夊叏璇峰厛鎵嬪姩澶囦唤 ${this.db_dir}`);
            return "";
        }
    }
    // 鈥斺€斺€?Migration journal 鈥斺€斺€?    _journal_path() {
        return path.join(this.db_dir, storage_consts_js_3.MIGRATION_JOURNAL_NAME);
    }
    _read_journal() {
        try {
            const data = JSON.parse(fs.readFileSync(this._journal_path(), "utf-8"));
            return typeof data === "object" && data !== null && !Array.isArray(data)
                ? data
                : {};
        }
        catch {
            // (OSError, json.JSONDecodeError, TypeError) -> {}
            return {};
        }
    }
    _write_journal(data) {
        try {
            // json.dump(..., ensure_ascii=False, indent=1)
            fs.writeFileSync(this._journal_path(), (0, storage_funcs_js_1.pyJsonIndent)(data), "utf-8");
        }
        catch (exc) {
            console.log(`[storage] MIGRATION JOURNAL WRITE FAILED: ${exc}`);
        }
    }
    _journal_step_start(mig_id, description, backup_dir) {
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
    _journal_step_end(mig_id, status, error = "") {
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
    _restore_from_backup(backup_dir) {
        if (!backup_dir || !fs.existsSync(backup_dir) || !fs.statSync(backup_dir).isDirectory()) {
            console.log("[storage] no pre-migration backup directory to roll back to");
            return false;
        }
        try {
            for (const conn of Object.values(this.dbs)) {
                try {
                    conn.close();
                }
                catch {
                    // fail-closed path: any handle we cannot close is reported by the
                    // copy step below, not swallowed here
                }
            }
            this.dbs = {};
            try {
                if (this.event_store != null) {
                    this.event_store.close();
                }
            }
            catch {
                // 鍚屼笂锛歝opyfile 闃舵浼氬瀹炴毚闇插崰鐢ㄩ棶棰?            }
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
                        }
                        catch {
                            // 鍒犱笉鎺夌殑 sidecar 鐢辫鐩栧悗鐨勬牎楠屾毚闇?                        }
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
            console.log(`[storage] rolled back ${copied} db(s) from backups/${path.basename(backup_dir)} ` +
                "(migration failed; running on the previous schema)");
            return true;
        }
        catch (exc) {
            console.log(`[storage] RESTORE FROM BACKUP FAILED: ${exc}`);
            return false;
        }
    }
    _run_migrations() {
        // Apply every unapplied migration in order, recording each one.
        // Three layers: journal+backup, automatic rollback, unrecoverable.
        const applied = this._applied_migrations();
        const deferred = { ...(this.get_config("migration.deferred") || {}) };
        const version = this._app_version();
        const c = this.dbs["configs"];
        // 搂19 杩佺Щ绾緥 4锛氬姩 schema 鍓嶅厛澶囦唤銆傚彧鍦ㄧ湡鏈夎鎵ц鐨勮縼绉绘椂鎵嶅浠姐€?        const pending = storage_consts_js_3.MIGRATIONS.filter((m) => !applied.has(m[0]) && !(m[0] in deferred));
        if (pending.length === 0) {
            return;
        }
        const backup_dir = this._backup_before_migration(pending.length);
        for (const [mig_id, description, method] of storage_consts_js_3.MIGRATIONS) {
            if (applied.has(mig_id)) {
                continue;
            }
            if (mig_id in deferred) {
                console.log(`[storage] deferred migration ${mig_id} reached 鈥?later steps held back until an explicit retry`);
                return;
            }
            const fn = this[method];
            if (fn === undefined) {
                console.log(`[storage] migration ${mig_id} references missing method ${JSON.stringify(method)}`);
                continue;
            }
            this._journal_step_start(mig_id, description, backup_dir);
            try {
                fn.call(this);
            }
            catch (exc) {
                console.log(`[storage] MIGRATION FAILED ${mig_id} (${description}): ${exc}`);
                this._journal_step_end(mig_id, "failed", String(exc));
                if (this._restore_from_backup(backup_dir)) {
                    this.recovery_mode = "compat";
                    const detail = {
                        mode: "compat",
                        failedMigration: mig_id,
                        error: String(exc).slice(0, 500),
                        backupDir: backup_dir,
                        at: intSeconds(),
                    };
                    this.set_config("migration.recovery_mode", detail);
                    deferred[mig_id] = { reason: String(exc).slice(0, 400), at: intSeconds() };
                    this.set_config("migration.deferred", deferred);
                    console.log(`[storage] *** UPGRADE INCOMPLETE *** rolled back to previous schema; data intact. ` +
                        `Failed step ${mig_id} is deferred 鈥?retry from Settings 鈫?绯荤粺 or ` +
                        `POST /api/system/migrations/retry`);
                    return; // keep booting on the rolled-back (old) schema
                }
                this.recovery_mode = "unrecoverable";
                const err = new MigrationUnrecoverable(mig_id, exc, backup_dir, this._journal_path());
                // `raise ... from exc` 鈥?chain preserved via cause.
                err.cause = exc;
                throw err;
            }
            // Checksum pins the id+description pair (not a hash of the SQL).
            const checksum = crypto
                .createHash("sha256")
                .update(`${mig_id}|${description}`, "utf8")
                .digest("hex")
                .slice(0, 16);
            c.execute("INSERT OR REPLACE INTO schema_migration (id, checksum, app_version, applied_at) VALUES (?,?,?,?)", [mig_id, checksum, version, intSeconds()]);
            c.commit();
            this._journal_step_end(mig_id, "done");
            console.log(`[storage] migration applied: ${mig_id} (${description})`);
        }
    }
    retry_deferred_migration(mig_id = "") {
        // Re-run a migration that failed and was auto-deferred (layer 2).
        const deferred = { ...(this.get_config("migration.deferred") || {}) };
        let targets;
        if (mig_id) {
            if (!(mig_id in deferred)) {
                return { ok: false, results: [], error: `${mig_id} 涓嶅湪寤惰繜娓呭崟閲宍 };
            }
            targets = [mig_id];
        }
        else {
            targets = Object.keys(deferred);
        }
        if (targets.length === 0) {
            return { ok: true, results: [], error: "" };
        }
        const backup_dir = this._backup_before_migration(targets.length);
        const c = this.dbs["configs"];
        const applied = this._applied_migrations();
        const version = this._app_version();
        const results = [];
        for (const [mid, description, method] of storage_consts_js_3.MIGRATIONS) {
            if (!targets.includes(mid)) {
                continue;
            }
            const fn = this[method];
            if (fn === undefined) {
                results.push({ id: mid, ok: false, error: `missing method ${JSON.stringify(method)}` });
                continue;
            }
            this._journal_step_start(mid, description, backup_dir);
            try {
                fn.call(this);
            }
            catch (exc) {
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
                c.execute("INSERT OR REPLACE INTO schema_migration (id, checksum, app_version, applied_at) VALUES (?,?,?,?)", [mid, checksum, version, intSeconds()]);
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
            }
            catch (err) {
                if (err instanceof MigrationUnrecoverable) {
                    throw err;
                }
                console.log(`[storage] post-retry migrations failed: ${err}`);
            }
        }
        return { ok, results, error: "" };
    }
    migration_status() {
        let rows;
        try {
            rows = this.dbs["configs"]
                .execute("SELECT id, checksum, app_version, applied_at FROM schema_migration ORDER BY applied_at, id")
                .fetchall();
        }
        catch {
            rows = [];
        }
        const done = new Set(rows.map((r) => String(r["id"])));
        const deferred = (this.get_config("migration.deferred") || {});
        const journal = this._read_journal();
        return {
            applied: rows,
            pending: storage_consts_js_3.MIGRATIONS.filter((m) => !done.has(m[0])).map((m) => ({
                id: m[0],
                description: m[1],
            })),
            deferred: Object.keys(deferred)
                .sort()
                .map((k) => {
                const v = deferred[k];
                return typeof v === "object" && v !== null
                    ? { id: k, ...v }
                    : { id: k, reason: String(v) };
            }),
            registered: storage_consts_js_3.MIGRATIONS.length,
            appVersion: this._app_version(),
            recoveryMode: this.recovery_mode,
            journal: {
                path: this._journal_path(),
                backupDir: journal.backup_dir ?? "",
                steps: journal.steps ?? [],
            },
        };
    }
    _RELATIVE_WORKSPACES = [".", "./", ".\\"];
    _normalize_workspace_paths() {
        // Rewrite relative workspace strings to absolute paths, in place.
        let here;
        try {
            here = path.resolve(process.cwd());
        }
        catch {
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
                }
                else {
                    s.execute("DELETE FROM workspaces WHERE path=?", [stale]);
                }
            }
            const c = this.dbs["configs"];
            if (c !== undefined) {
                const cur = c
                    .execute("SELECT value FROM configs WHERE key='active_workspace'")
                    .fetchone();
                const val = cur ? String(cur["value"] ?? "") : "";
                if (cur && this._RELATIVE_WORKSPACES.includes(val)) {
                    c.execute("UPDATE configs SET value=? WHERE key='active_workspace'", [here]);
                    c.commit();
                }
            }
            s.commit();
        }
        catch (exc) {
            console.log(`[storage] workspace path normalization skipped: ${exc}`);
        }
    }
    _own_source_dirs() {
        // Electron spawns the backend with cwd = the folder holding the entry
        // script; running the module directly gives <repo>/app/backend. The two
        // values the cwd fallback can produce.
        try {
            // __file__ equivalent: <repo>/app/engine/storage (this file's dir).
            const backend = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "backend");
            return [backend, path.resolve(backend, "..")];
        }
        catch {
            return [];
        }
    }
    _unbind_own_dirs() {
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
                    .fetchone();
                const val = cur ? String(cur["value"] ?? "") : "";
                if (cur && own.includes(path.resolve(val || "-"))) {
                    c.execute("UPDATE configs SET value='' WHERE key='active_workspace'");
                    c.commit();
                }
            }
            s.commit();
        }
        catch (exc) {
            console.log(`[storage] own-dir unbind skipped: ${exc}`);
        }
    }
    // 鈥斺€斺€?config / kv 鈥斺€斺€?    set_config(key, value) {
        this.dbs["configs"].execute("INSERT OR REPLACE INTO configs (key, value, updated_at) VALUES (?, ?, ?)", [key, JSON.stringify(value), intSeconds()]);
    }
    get_config(key, defaultValue = null) {
        const row = this.dbs["configs"]
            .execute("SELECT value FROM configs WHERE key=?", [key])
            .fetchone();
        if (!row)
            return defaultValue;
        try {
            return JSON.parse(String(row["value"]));
        }
        catch {
            return defaultValue;
        }
    }
    kv_set(key, value, ns = "default") {
        this.dbs["kv"].execute("INSERT OR REPLACE INTO kv_store (key, value, namespace, updated_at) VALUES (?, ?, ?, ?)", [key, JSON.stringify(value), ns, intSeconds()]);
    }
    kv_get(key, ns = "default", defaultValue = null) {
        const row = this.dbs["kv"]
            .execute("SELECT value FROM kv_store WHERE key=? AND namespace=?", [key, ns])
            .fetchone();
        if (!row)
            return defaultValue;
        try {
            return JSON.parse(String(row["value"]));
        }
        catch {
            return defaultValue;
        }
    }
    close() {
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
        }
        catch {
            // fail-open: 鍙€夊寮猴紝澶辫触涓嶅奖鍝嶄富娴佺▼
        }
    }
}
exports.StorageBase = StorageBase;
