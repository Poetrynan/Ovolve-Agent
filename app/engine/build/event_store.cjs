"use strict";
/**
 * event_store.ts 鈥?High-Performance SQLite Event Store with SHA-256 Chain Hashing.
 *
 * Ported from `app/backend/event_store.py` (494 lines).
 *
 * Adheres to Event-Sourced Agent Runtime v1.0 specifications:
 * - Append-only immutable stream of AgentEvents
 * - Strictly monotonic sequence numbering
 * - Blockchain-style cascading SHA-256 chain integrity hashes
 * - O(1) state snapshotting and sub-millisecond replay capability
 *
 * RULEBOOK CITATIONS
 *   搂1  node:sqlite and node:crypto are builtins 鈥?no new dependency row.
 *   搂2  the Rust hash kernels (rust_adapters/event_engine.py) are pure
 *       SHA-256 over deterministic string concatenation; node:crypto
 *       reproduces them byte-for-byte. JSON canonicalization
 *       (sort_keys=True, ensure_ascii=False) is reimplemented here with
 *       Python's default separators (", " / ": ") so hash inputs are
 *       byte-identical.
 *   搂2  `_SerializedConn` serializes threads; the Node event loop is
 *       single-threaded, so the lock is structurally unnecessary here 鈥? *       same reasoning as path_lock.ts.
 *   搂2  `with self._conn:` transaction blocks: node:sqlite autocommits per
 *       statement (see sqlite_connection.ts), so the block shape carries no
 *       transaction boundary; comments mark the sites.
 *   搂4  naming: app/backend/event_store.py -> app/engine/event_store.ts
 *
 * PORT STATUS: confidence=high todos=1
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventStore = void 0;
exports.genesis_hash = genesis_hash;
exports.compute_chain_hash = compute_chain_hash;
exports.compute_snapshot_hash = compute_snapshot_hash;
exports.get_event_store = get_event_store;
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const event_types_js_1 = require("./event_types.cjs");
const user_dirs_js_1 = require("./user_dirs.cjs");
const sqlite_connection_js_1 = require("./sqlite_connection.cjs");
const storage_funcs_js_1 = require("./storage/storage_funcs.cjs");
// ---------------------------------------------------------------------------
// Python-compatible JSON serialization lives in storage/storage_funcs.ts
// (single implementation shared with the storage unit; both the stored
// ledger text and the hash seeds are byte-level contracts).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Hash kernels (mirror of rust_adapters/event_engine.py's pure-Python spec)
// ---------------------------------------------------------------------------
/** SHA-256("genesis:{session_id}") */
function genesis_hash(session_id) {
    return crypto.createHash("sha256").update(`genesis:${session_id}`, "utf8").digest("hex");
}
/**
 * SHA-256("{prev_hash}|{session_id}|{event_type}|{timestamp}|{canonical_payload}")
 */
function compute_chain_hash(prev_hash, session_id, event_type, timestamp, payload) {
    const canonical_payload = (0, storage_funcs_js_1.canonicalJson)(payload);
    const seed = `${prev_hash}|${session_id}|${event_type}|${timestamp}|${canonical_payload}`;
    return crypto.createHash("sha256").update(seed, "utf8").digest("hex");
}
/** SHA-256("{session_id}:{at_seq}:{state_json}") */
function compute_snapshot_hash(session_id, at_seq, state) {
    const state_str = (0, storage_funcs_js_1.canonicalJson)(state);
    return crypto
        .createHash("sha256")
        .update(`${session_id}:${at_seq}:${state_str}`, "utf8")
        .digest("hex");
}
/** Which correlation columns may be queried directly (a whitelist, 搂-commented below). */
const QUERYABLE_DIMENSIONS = [
    "goal_id",
    "run_id",
    "turn_id",
    "tool_call_id",
    "branch_id",
];
class EventStore {
    dbPath;
    _conn;
    _closed;
    constructor(db_path) {
        if (db_path == null) {
            db_path = (0, user_dirs_js_1.dbDir)() + path.sep + "events.db";
        }
        this.dbPath = db_path;
        fs.mkdirSync(path.dirname(path.resolve(db_path)), { recursive: true });
        // Python wraps the raw connection in storage._SerializedConn (lazy import
        // succeeds in the product). Node's event loop serializes naturally, so the
        // adapter's shape is preserved without a lock 鈥?same reasoning as
        // path_lock.ts's MutexLock TODO(port).
        this._conn = (0, sqlite_connection_js_1.openSqlite)(db_path);
        this._closed = false;
        this._init_schema();
    }
    close() {
        const conn = this._conn;
        if (conn !== null) {
            try {
                conn.close();
            }
            catch {
                // fail-open: 鍙€夊寮猴紝澶辫触涓嶅奖鍝嶄富娴佺▼
            }
            this._conn = null;
        }
        this._closed = true;
    }
    get closed() {
        return this._closed;
    }
    _init_schema() {
        const conn = this._conn;
        // `with self._conn:` 鈥?autocommit per statement on node:sqlite.
        conn.execute(`
                CREATE TABLE IF NOT EXISTS agent_events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    causation_id TEXT,
                    timestamp INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    state_hash TEXT,
                    resulting_hash TEXT,
                    chain_hash TEXT NOT NULL
                )
            `);
        // Phase 1 (canonical run/trace protocol): correlation + idempotency
        // columns. CREATE TABLE IF NOT EXISTS does not touch an existing table,
        // so an events.db written by an older build is migrated in place here 鈥?        // additive ALTERs only, repeatable, no data loss.
        // Python reads `row[1]` positionally; PRAGMA table_info's second column
        // is `name`, which is the named accessor on node:sqlite row objects.
        const existing = new Set(conn
            .execute("PRAGMA table_info(agent_events)")
            .fetchall()
            .map((r) => String(r["name"])));
        const col_ddls = [
            "schema_version INTEGER NOT NULL DEFAULT 1",
            "idempotency_key TEXT",
            "run_id TEXT",
            "turn_id TEXT",
            "step_id TEXT",
            "tool_call_id TEXT",
            "goal_id TEXT",
            "branch_id TEXT",
            "parent_event_id TEXT",
            "actor TEXT",
            "visibility TEXT NOT NULL DEFAULT 'audit'",
        ];
        for (const col_ddl of col_ddls) {
            const col_name = col_ddl.split(" ")[0];
            if (!existing.has(col_name)) {
                conn.execute(`ALTER TABLE agent_events ADD COLUMN ${col_ddl}`);
            }
        }
        // A retried write with the same key must land once. NULL keys (the
        // legacy/unkeyed path) are exempt 鈥?SQLite treats each NULL as distinct
        // in a UNIQUE index.
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency ON agent_events(idempotency_key)");
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_session_seq ON agent_events(session_id, seq)");
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_type ON agent_events(event_type)");
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_causation ON agent_events(causation_id)");
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_turn ON agent_events(session_id, turn_id)");
        // Goal/run are cross-session dimensions: a goal that pauses and resumes
        // writes into more than one session, so these deliberately do NOT lead
        // with session_id. `seq` second keeps the scan ordered.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_goal ON agent_events(goal_id, seq)");
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_run ON agent_events(run_id, seq)");
        conn.execute(`
                CREATE TABLE IF NOT EXISTS event_snapshots (
                    session_id TEXT NOT NULL,
                    at_seq INTEGER NOT NULL,
                    state_json TEXT NOT NULL,
                    snapshot_hash TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (session_id, at_seq)
                )
            `);
        conn.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_session ON event_snapshots(session_id, at_seq DESC)");
    }
    _genesis_hash(session_id) {
        return genesis_hash(session_id);
    }
    _compute_chain_hash(prev_hash, session_id, event_type, timestamp, payload) {
        return compute_chain_hash(prev_hash, session_id, event_type, timestamp, payload);
    }
    append(session_id, event_type, payload, opts = {}) {
        const { causation_id = null, timestamp = null, state_hash = null, resulting_hash = null, idempotency_key = null, run_id = null, turn_id = null, step_id = null, tool_call_id = null, goal_id = null, branch_id = null, parent_event_id = null, actor = null, visibility = "audit", } = opts;
        if (idempotency_key) {
            const existing = this.find_by_idempotency_key(idempotency_key);
            if (existing !== null) {
                return existing;
            }
        }
        const t_now = timestamp !== null && timestamp !== undefined ? timestamp : Date.now();
        // Python: str(event_type.value if isinstance(event_type, EventType) else
        // event_type). EventType members ARE their string values in TS, so the
        // branch is vacuous 鈥?String() reproduces both arms.
        const etype_str = String(event_type);
        const payload_str = (0, storage_funcs_js_1.pyJsonDumps)(payload);
        // `with self._conn:` 鈥?see class comment on transaction semantics.
        const conn = this._conn;
        const cur = conn.execute("SELECT chain_hash FROM agent_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1", [session_id]);
        const row = cur.fetchone();
        const prev_hash = row ? row["chain_hash"] : this._genesis_hash(session_id);
        const chain_hash = this._compute_chain_hash(prev_hash, session_id, etype_str, t_now, payload);
        const cursor = conn.execute(`
                INSERT INTO agent_events (
                    session_id, event_type, causation_id, timestamp, payload, state_hash, resulting_hash, chain_hash,
                    schema_version, idempotency_key, run_id, turn_id, step_id, tool_call_id, goal_id, branch_id,
                    parent_event_id, actor, visibility
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
            session_id,
            etype_str,
            causation_id,
            t_now,
            payload_str,
            state_hash,
            resulting_hash,
            chain_hash,
            idempotency_key,
            run_id,
            turn_id,
            step_id,
            tool_call_id,
            goal_id,
            branch_id,
            parent_event_id,
            actor,
            visibility,
        ]);
        const seq = cursor.lastrowid;
        return new event_types_js_1.AgentEvent({
            seq,
            eventType: etype_str,
            sessionId: session_id,
            timestamp: t_now,
            payload,
            chainHash: chain_hash,
            causationId: causation_id,
            stateHash: state_hash,
            resultingHash: resulting_hash,
            idempotencyKey: idempotency_key,
            runId: run_id,
            turnId: turn_id,
            stepId: step_id,
            toolCallId: tool_call_id,
            goalId: goal_id,
            branchId: branch_id,
            parentEventId: parent_event_id,
            actor,
            visibility,
        });
    }
    find_by_idempotency_key(key) {
        const cur = this._conn.execute("SELECT * FROM agent_events WHERE idempotency_key = ? ORDER BY seq LIMIT 1", [key]);
        const row = cur.fetchone();
        return row ? event_types_js_1.AgentEvent.fromRow(row) : null;
    }
    append_batch(session_id, events_data) {
        const results = [];
        if (events_data.length === 0) {
            return results;
        }
        const conn = this._conn;
        const cur = conn.execute("SELECT chain_hash FROM agent_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1", [session_id]);
        const row = cur.fetchone();
        let curr_hash = row ? row["chain_hash"] : this._genesis_hash(session_id);
        for (const item of events_data) {
            // Python: `item.get("timestamp") or int(time.time() * 1000)` 鈥?falsy 0
            // falls through to now. Preserved.
            const t_now = item.timestamp || Date.now();
            const etype_str = String(item.event_type);
            const payload = (item.payload ?? {});
            const payload_str = (0, storage_funcs_js_1.pyJsonDumps)(payload);
            const causation_id = item.causation_id ?? null;
            const state_hash = item.state_hash ?? null;
            const resulting_hash = item.resulting_hash ?? null;
            const chain_hash = this._compute_chain_hash(curr_hash, session_id, etype_str, t_now, payload);
            curr_hash = chain_hash;
            // Attribution travels with the event (see source comment: a forked
            // session's cloned history must carry run/turn/goal ids).
            const cursor = conn.execute(`
                    INSERT INTO agent_events (
                        session_id, event_type, causation_id, timestamp, payload,
                        state_hash, resulting_hash, chain_hash,
                        run_id, turn_id, step_id, tool_call_id, goal_id, branch_id, actor
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                session_id,
                etype_str,
                causation_id,
                t_now,
                payload_str,
                state_hash,
                resulting_hash,
                chain_hash,
                item.run_id ?? null,
                item.turn_id ?? null,
                item.step_id ?? null,
                item.tool_call_id ?? null,
                item.goal_id ?? null,
                item.branch_id ?? null,
                item.actor ?? null,
            ]);
            const seq = cursor.lastrowid;
            results.push(new event_types_js_1.AgentEvent({
                seq,
                eventType: etype_str,
                sessionId: session_id,
                timestamp: t_now,
                payload,
                chainHash: chain_hash,
                causationId: causation_id,
                stateHash: state_hash,
                resultingHash: resulting_hash,
                runId: item.run_id ?? null,
                turnId: item.turn_id ?? null,
                stepId: item.step_id ?? null,
                toolCallId: item.tool_call_id ?? null,
                goalId: item.goal_id ?? null,
                branchId: item.branch_id ?? null,
                actor: item.actor ?? null,
            }));
        }
        return results;
    }
    read_by_dimension(dimension, value, limit = 500, session_id = "") {
        // RULEBOOK 搂2: raise X -> throw a distinguishable type. Python ValueError
        // maps to RangeError (invalid value) in JS.
        if (!QUERYABLE_DIMENSIONS.includes(dimension)) {
            throw new RangeError(`not a queryable dimension: ${JSON.stringify(dimension)}`);
        }
        if (!value) {
            return [];
        }
        let query = `SELECT * FROM agent_events WHERE ${dimension} = ?`;
        const params = [value];
        if (session_id) {
            query += " AND session_id = ?";
            params.push(session_id);
        }
        query += " ORDER BY seq ASC LIMIT ?";
        // Python: max(1, min(5000, int(limit or 500)))
        const lim = Math.max(1, Math.min(5000, Math.trunc(limit || 500)));
        params.push(lim);
        const cur = this._conn.execute(query, params);
        return cur.fetchall().map((r) => event_types_js_1.AgentEvent.fromRow(r));
    }
    read_stream(session_id, from_seq = 0, to_seq = null, limit = null) {
        let query = "SELECT * FROM agent_events WHERE session_id = ? AND seq >= ?";
        const params = [session_id, from_seq];
        if (to_seq !== null) {
            query += " AND seq <= ?";
            params.push(to_seq);
        }
        query += " ORDER BY seq ASC";
        if (limit !== null) {
            query += " LIMIT ?";
            params.push(limit);
        }
        const cur = this._conn.execute(query, params);
        return cur.fetchall().map((r) => event_types_js_1.AgentEvent.fromRow(r));
    }
    get_latest_event(session_id) {
        const cur = this._conn.execute("SELECT * FROM agent_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1", [session_id]);
        const row = cur.fetchone();
        return row ? event_types_js_1.AgentEvent.fromRow(row) : null;
    }
    get_event_count(session_id) {
        const cur = this._conn.execute("SELECT COUNT(*) as cnt FROM agent_events WHERE session_id = ?", [session_id]);
        return Number(cur.fetchone()["cnt"]);
    }
    verify_chain(session_id) {
        const events = this.read_stream(session_id);
        if (events.length === 0) {
            return { valid: true, total_events: 0, broken_at_seq: null, error: null };
        }
        let expected_prev = this._genesis_hash(session_id);
        for (const ev of events) {
            const calc_hash = this._compute_chain_hash(expected_prev, session_id, ev.eventType, ev.timestamp, ev.payload);
            if (calc_hash !== ev.chainHash) {
                return {
                    valid: false,
                    total_events: events.length,
                    broken_at_seq: ev.seq,
                    error: `Chain hash mismatch at seq=${ev.seq} (expected ${calc_hash}, got ${ev.chainHash})`,
                };
            }
            expected_prev = ev.chainHash;
        }
        return { valid: true, total_events: events.length, broken_at_seq: null, error: null };
    }
    // 鈥斺€斺€?Snapshot Management 鈥斺€斺€?    create_snapshot(session_id, at_seq, state) {
        const t_now = Date.now();
        const state_str = (0, storage_funcs_js_1.canonicalJson)(state);
        const snap_hash = compute_snapshot_hash(session_id, at_seq, state);
        const conn = this._conn;
        conn.execute(`
                INSERT OR REPLACE INTO event_snapshots (session_id, at_seq, state_json, snapshot_hash, created_at)
                VALUES (?, ?, ?, ?, ?)
                `, [session_id, at_seq, state_str, snap_hash, t_now]);
        return new event_types_js_1.SessionSnapshot({
            sessionId: session_id,
            atSeq: at_seq,
            state,
            createdAt: t_now,
            snapshotHash: snap_hash,
        });
    }
    get_latest_snapshot(session_id) {
        const cur = this._conn.execute("SELECT * FROM event_snapshots WHERE session_id = ? ORDER BY at_seq DESC LIMIT 1", [session_id]);
        const row = cur.fetchone();
        if (!row) {
            return null;
        }
        const r = row;
        return new event_types_js_1.SessionSnapshot({
            sessionId: r["session_id"],
            atSeq: r["at_seq"],
            state: JSON.parse(String(r["state_json"] ?? "{}")),
            createdAt: r["created_at"],
            snapshotHash: r["snapshot_hash"],
        });
    }
}
exports.EventStore = EventStore;
let _event_store = null;
function get_event_store(db_path) {
    if (_event_store === null ||
        _event_store.closed ||
        (db_path != null && db_path !== "" && _event_store.dbPath !== db_path)) {
        // Replacing the singleton: close the outgoing store's connection so its
        // events.db handle doesn't leak for the rest of the process (tests point
        // the singleton at a fresh temp dir on every case).
        if (_event_store !== null && !_event_store.closed) {
            _event_store.close();
        }
        _event_store = new EventStore(db_path);
    }
    return _event_store;
}
// TODO(port): `pyJsonNumber` cannot distinguish an integral float (Python
// "1.0") from an int ("1"); event payloads currently carry only ints and
// strings, so the ledger text matches. Revisit if float payloads appear.
