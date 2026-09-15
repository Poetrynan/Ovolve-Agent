"""storage.py - SQLite one-db-one-responsibility + session branch tree + migrations."""
from __future__ import annotations
import os, shutil, sqlite3, json, time, hashlib, uuid, logging, re, threading
from typing import Any, Optional
from result import Result

try:
    from event_store import get_event_store, EventStore
    from event_types import EventType
    from projection_engine import get_projection_engine
    from session_audit import SessionAuditTrack
    from session_logger import get_session_logger, SessionLogger
    from trace_gateway import TraceGateway, CRITICAL
    from user_dirs import db_dir as _user_db_dir
except ImportError:
    from app.backend.event_store import get_event_store, EventStore
    from app.backend.event_types import EventType
    from app.backend.projection_engine import get_projection_engine
    from app.backend.session_audit import SessionAuditTrack
    from app.backend.session_logger import get_session_logger, SessionLogger
    from app.backend.trace_gateway import TraceGateway, CRITICAL
    from app.backend.user_dirs import db_dir as _user_db_dir

# Numeric kernels for semantic retrieval, routed through the Rust-backed
# adapter (pure-Python fallback inside — bit-for-bit same semantics as the
# previous inline implementations, see rust_adapters/storage_engine.py).
try:
    from rust_adapters.storage_engine import (
        cosine_similarity as _rs_cosine,
        keyword_score as _rs_keyword_score,
        decode_embedding as _rs_decode_embedding,
        trust_of as _rs_trust_of,
    )
except ImportError:
    from app.backend.rust_adapters.storage_engine import (
        cosine_similarity as _rs_cosine,
        keyword_score as _rs_keyword_score,
        decode_embedding as _rs_decode_embedding,
        trust_of as _rs_trust_of,
    )

log = logging.getLogger(__name__)


def _audit_write_failed(what: str, exc: Exception) -> None:
    """Loud degradation for audit-side writes.

    The session_messages row is the operational fact the product runs on; the
    event-stream copy is the audit ledger. When the ledger write fails we keep
    the product working but the failure is logged with a traceback — never the
    old bare ``except: pass``, which is how a silent EventStore divergence
    went unnoticed until Phase 1. (Full fail-closed lands with Phase 2, when
    the EventStore becomes the rebuildable source of truth.)
    """
    log.error("[audit] event write failed during %s: %r", what, exc, exc_info=True)


#: A new value on every process start. Rows stamped with a *different*
#: generation than this one were written by a process that is no longer alive,
#: which is the only reliable way to tell "still running" from "died holding a
#: non-terminal status" — a PID can be recycled, and an in-memory registry is
#: gone by the time anyone could inspect it. Used by
#: ``reap_orphan_subagent_runs``; kept module-level (not per-Storage) because a
#: second Storage instance in the same process is still the same process.
PROCESS_GENERATION: str = uuid.uuid4().hex[:12]

#: Statuses a sub-agent run can never leave. Mirrors
#: ``subagent_runtime.TERMINAL_STATUSES`` by value, deliberately duplicated as
#: plain strings so the storage layer does not import the runtime (the runtime
#: imports storage).
SUBAGENT_TERMINAL_STATUSES: frozenset = frozenset(
    {"completed", "error", "killed", "timeout", "stale"}
)


class MigrationUnrecoverable(RuntimeError):
    """A migration failed AND the automatic restore to its pre-migration
    backup failed too.

    Raised instead of a bare exception so the entrypoint can distinguish
    "schema is half-upgraded and unknown" (never run on it) from any other
    startup error, and start the read-only recovery server rather than a
    white screen. Carries everything the recovery UI needs to explain what
    happened without reading the source.
    """

    def __init__(self, mig_id: str, original: Exception,
                 backup_dir: str, journal_path: str):
        self.mig_id = mig_id
        self.original = original
        self.backup_dir = backup_dir
        self.journal_path = journal_path
        super().__init__(
            f"migration {mig_id} failed ({original}) and restore from backup "
            f"{backup_dir or '(none)'} also failed — database left untouched; "
            f"use the recovery mode to export or repair it"
        )


#: Sidecar next to the databases recording exactly how far the last migration
#: run got, and which backup directory to roll back to. A plain file, not a
#: table: it must stay readable even when the databases themselves are the
#: thing that is broken.
MIGRATION_JOURNAL_NAME = "migration_journal.json"


#: Provider ids older builds wrote when they had no real provider entry to name.
#: They carry no information — "custom" was the placeholder id and "default" was
#: the absence of one — so attributing usage to them would put a non-existent
#: vendor on screen. Mapped to "" and rendered as "未知来源" upstream.
_PLACEHOLDER_PROVIDER_IDS: frozenset = frozenset({"custom", "default", ""})


def split_usage_model_id(raw: str) -> tuple[str, str]:
    """Split a ``turn_usage.model_id`` into ``(provider_id, model_id)``.

    The router writes ``f"{provider_id}:{model_id}"`` (router.py), but rows
    accumulated across builds are messier than that: bare model ids from before
    the prefix existed, ``"custom:"`` with nothing after it, and the ``"custom"``
    placeholder on its own. Every one of those has to degrade to something the UI
    can show without lying.

    Deliberately does NOT substitute a default model name. A previous version of
    this logic answered ``"openai:LongCat-2.0"`` for anything it could not parse,
    which is only correct for the one machine it was written on — everyone else
    got their usage filed under a model they had never called.

    Returns ``("", "")`` when nothing usable is left, so callers can skip the row.
    """
    raw = str(raw or "").strip()
    if not raw:
        return "", ""
    if ":" not in raw:
        # No prefix at all: pre-prefix row, or a placeholder standing alone.
        return ("", "") if raw.lower() in _PLACEHOLDER_PROVIDER_IDS else ("", raw)
    provider_id, _, model_id = raw.partition(":")
    provider_id = provider_id.strip()
    model_id = model_id.strip()
    if provider_id.lower() in _PLACEHOLDER_PROVIDER_IDS:
        provider_id = ""
    return provider_id, model_id


class _SerializedConn:
    """sqlite3 connection proxy that serializes every call behind a lock.

    ``check_same_thread=False`` only disables Python's guard — sqlite3
    connection objects are still not safe for concurrent ``execute()`` from
    multiple threads. The Storage singleton is shared by every Router in the
    process (benchmark drivers run several concurrently), and two workers
    racing on one connection produced
    ``sqlite3.InterfaceError: bad parameter or other API misuse``.

    storage.py only ever uses ``execute`` / ``executemany`` / ``executescript``
    / ``commit`` / attribute passthrough (no raw cursors), so locking those
    entry points is sufficient. Use one RLock per connection.
    """

    def __init__(self, conn: "sqlite3.Connection") -> None:
        self._conn = conn
        self._lock = threading.RLock()

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def execute(self, *args, **kwargs):
        with self._lock:
            return self._conn.execute(*args, **kwargs)

    def executemany(self, *args, **kwargs):
        with self._lock:
            return self._conn.executemany(*args, **kwargs)

    def executescript(self, *args, **kwargs):
        with self._lock:
            return self._conn.executescript(*args, **kwargs)

    def commit(self):
        with self._lock:
            return self._conn.commit()

    def rollback(self):
        with self._lock:
            return self._conn.rollback()

    def close(self):
        with self._lock:
            return self._conn.close()

    def __enter__(self):
        """Transaction context (`with conn:`) — hold the lock for the block."""
        self._lock.acquire()
        try:
            self._conn.__enter__()
            return self
        except Exception:
            self._lock.release()
            raise

    def __exit__(self, *exc_info):
        try:
            return self._conn.__exit__(*exc_info)
        finally:
            self._lock.release()


class Storage:
    #: Env override for the database location. Exists because the *only* other
    #: way to reach the singleton built by ``get_storage()`` is the home
    #: directory — which meant a test suite calling ``get_storage()`` wrote its
    #: fixtures into the user's live database. 98 fake goals showed up on the
    #: real Goals board that way. An explicit ``db_dir`` still wins.
    #: ``OVOLVE_DB_DIR`` is the canonical name; ``OVOLVE_DB_DIR`` (pre-rename)
    #: keeps working so existing test setups and dev scripts don't break.
    DB_DIR_ENV = "OVOLVE_DB_DIR"
    LEGACY_DB_DIR_ENV = "OVOLVE_DB_DIR"

    def __init__(self, db_dir: str = None):
        self.db_dir = (
            db_dir
            or os.environ.get(self.DB_DIR_ENV)
            or os.environ.get(self.LEGACY_DB_DIR_ENV)
            or _user_db_dir()
        )
        os.makedirs(self.db_dir, exist_ok=True)
        #: "" | "compat" | "unrecoverable". Set by ``_run_migrations`` when a
        #: migration failed: compat means we rolled back to the pre-migration
        #: backup and are running on the OLD schema (upgrade visibly
        #: incomplete); unrecoverable means even the restore failed and the
        #: constructor is about to raise :class:`MigrationUnrecoverable`.
        self.recovery_mode: str = ""
        self._emb_hits_buffer: dict[str, int] = {}
        self._emb_hits_lock = threading.Lock()
        self._open_db_connections()
        self._session_logger = get_session_logger(os.path.join(self.db_dir, "..", "logs", "sessions"))
        # P1-3 会话模型 I/O 审计轨（）：
        # 与 SQLite 查询面并行的 jsonl 审计/回放面。目录布局与 session_logger
        # 一致（model_io.jsonl 与 transcript.jsonl 同目录），但**显式跟随本实例
        # 的 db_dir**——get_session_logger 是进程级单例（首次之后的 base_dir
        # 参数被忽略），测试里多实例共用一个单例会把不同 db_dir 的审计流水写进
        # 同一个目录；审计轨不吃这个亏。父子关联经惰性查 sessions.parent_id
        # 补齐。fail-open——审计轨的任何失败都不许阻塞会话主流程（record 内部
        # 已兜底，这里再防一层 tracker 对象本身被替换/损坏的情况）。
        self._session_audit = SessionAuditTrack(
            base_dir=os.path.join(self.db_dir, "..", "logs", "sessions"),
            parent_lookup=self._session_parent_id,
        )
        self._migrate()

    def _session_parent_id(self, sid: str) -> str:
        """审计轨的父子会话关联查询：sessions.parent_id，查不到返回 ""。
        结果由 SessionAuditTrack 按会话缓存，不在热路径上反复打表。"""
        try:
            row = self._db("sessions").execute(
                "SELECT parent_id FROM sessions WHERE id=?", (sid,)).fetchone()
            return (row["parent_id"] if row else "") or ""
        except Exception:  # noqa: BLE001 — 关联字段缺失不许影响审计落盘
            return ""

    def _open_db_connections(self) -> None:
        """Open (or reopen after a backup restore) every database handle.

        Split out of ``__init__`` because the migration rollback path must
        close all handles, copy backup files over the live ones, and open them
        again — on Windows an unclosed sqlite handle keeps the old file bytes
        pinned and silently defeats the whole restore.
        """
        self._dbs = {}
        for name in ("configs", "kv", "sessions", "goals", "cron", "memory", "usage", "bot"):
            path = os.path.join(self.db_dir, f"{name}.db")
            conn = sqlite3.connect(path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            # Multiple Router sessions run in the same process now (Agent Host
            # pattern) and every one writes to the same session/message/snapshot
            # tables. Without a busy_timeout, a second writer arriving mid-
            # transaction gets "database is locked" immediately; 60s is enough
            # to ride out concurrent benchmark writers without crashing.
            conn.execute("PRAGMA busy_timeout=60000")
            self._dbs[name] = _SerializedConn(conn)
        self._event_store = get_event_store(os.path.join(self.db_dir, "events.db"))
        # All new business events go through the canonical gateway (Phase 1);
        # direct self._event_store.append calls in this module are gone.
        self._trace = TraceGateway(self._event_store)
        self._projection_engine = get_projection_engine(self._event_store)

    def _db(self, name):
        return self._dbs[name]

    def _migrate(self):
        c = self._dbs["configs"]
        c.execute("CREATE TABLE IF NOT EXISTS schema_migration (id TEXT PRIMARY KEY, checksum TEXT, app_version TEXT, applied_at INTEGER)")
        c.execute("CREATE TABLE IF NOT EXISTS configs (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)")
        # kv_store lives in the kv db (one db one responsibility). It used to be
        # created on the configs connection while kv_set/kv_get wrote to the kv
        # connection, so every kv_set raised "no such table: kv_store".
        self._dbs["kv"].execute("CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT, namespace TEXT DEFAULT 'default', updated_at INTEGER)")
        s = self._dbs["sessions"]
        s.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER, goal_state TEXT, parent_id TEXT, branch_point TEXT)")
        s.execute("CREATE TABLE IF NOT EXISTS session_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, msg_type TEXT DEFAULT 'message', metadata TEXT DEFAULT '{}', created_at INTEGER, seq INTEGER)")
        # Session message FTS5 — cross-session conversation search (Hermes-style recall).
        self._session_fts_enabled = False
        try:
            s.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5("
                "body, session_id UNINDEXED, message_id UNINDEXED, tokenize='unicode61')"
            )
            self._session_fts_enabled = True
        except sqlite3.OperationalError:
            pass
        if getattr(self, "_session_fts_enabled", False):
            try:
                n = self._db("sessions").execute("SELECT COUNT(*) AS c FROM session_fts").fetchone()["c"]
                if n == 0:
                    self.rebuild_session_fts()
            except Exception:
                pass
        # Workspaces get their own row so they can carry properties that don't
        # belong on the sessions table (custom display name, per-workspace
        # settings JSON, pin/hide state, an accurate last_opened_at that a
        # folder switch stamps even before any conversation exists there).
        # `path` is the primary key and the same string used in
        # sessions.workspace — this is what lets list_workspaces UNION the two
        # sources without a UUID.
        s.execute("CREATE TABLE IF NOT EXISTS workspaces (path TEXT PRIMARY KEY, display_name TEXT DEFAULT '', pinned INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, last_opened_at INTEGER DEFAULT 0, settings_json TEXT DEFAULT '{}', created_at INTEGER)")
        self._dbs["goals"].execute("CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, description TEXT, status TEXT DEFAULT 'started', iteration INTEGER DEFAULT 0, session_id TEXT, created_at INTEGER, updated_at INTEGER, verification_result TEXT)")
        self._dbs["cron"].execute("CREATE TABLE IF NOT EXISTS cron_jobs (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, cron_expr TEXT, delay_minutes INTEGER, recurring INTEGER DEFAULT 1, max_runs INTEGER, next_run_at INTEGER, last_run_at INTEGER, run_count INTEGER DEFAULT 0, status TEXT DEFAULT 'active', bot_delivery_target TEXT, session_id TEXT, created_at INTEGER)")
        self._dbs["memory"].execute("CREATE TABLE IF NOT EXISTS memory_entries (id TEXT PRIMARY KEY, session_id TEXT, root_dir TEXT, scope TEXT DEFAULT 'project', content TEXT, embedding BLOB, metadata TEXT DEFAULT '{}', created_at INTEGER, updated_at INTEGER)")
        self._dbs["memory"].execute("CREATE TABLE IF NOT EXISTS project_memory_index (id TEXT PRIMARY KEY, root_dir TEXT UNIQUE, index_content TEXT, last_dream_at INTEGER, last_extract_at INTEGER, version INTEGER DEFAULT 1)")
        self._dbs["memory"].execute("CREATE TABLE IF NOT EXISTS session_synthesis (session_id TEXT PRIMARY KEY, synthesis TEXT, created_at INTEGER)")
        # Embedding cache. Encoding one sentence with BGE-base costs ~15-40ms of
        # CPU; recall re-embeds the SAME query text constantly (every prompt
        # prefetch, every dream pass over unchanged memories), and a remote
        # provider would also bill for it. Keyed by (provider, model, sha256 of
        # the text) so switching model or provider can never serve a vector from
        # the wrong space — the killer bug this table has to avoid, since a
        # 384-dim vector silently compared against 768-dim ones produces
        # plausible-looking garbage rather than an error.
        self._dbs["memory"].execute(
            "CREATE TABLE IF NOT EXISTS embedding_cache ("
            "key TEXT PRIMARY KEY, provider TEXT, model TEXT, dim INTEGER, "
            "vector BLOB, created_at INTEGER, last_used_at INTEGER, hits INTEGER DEFAULT 0)"
        )
        self._dbs["memory"].execute(
            "CREATE INDEX IF NOT EXISTS idx_embcache_used ON embedding_cache(last_used_at)"
        )
        # Add columns for enhanced memory (idempotent ALTER TABLE)
        self._safe_add_column("memory", "memory_entries", "type", "TEXT DEFAULT 'fact'")
        self._safe_add_column("memory", "memory_entries", "importance", "REAL DEFAULT 0.5")
        self._safe_add_column("memory", "memory_entries", "tags", "TEXT DEFAULT '[]'")
        self._safe_add_column("memory", "memory_entries", "archived", "INTEGER DEFAULT 0")
        # C1 six-tier hierarchy. `type` says what a memory is ABOUT; `tier` says
        # how long it lives and whether it is injected verbatim. Legacy rows
        # default to 'semantic' because that is exactly how the old flat table
        # behaved — retrieved on demand, never auto-injected, never expired.
        self._safe_add_column("memory", "memory_entries", "tier", "TEXT DEFAULT 'semantic'")
        # Recall counter drives promotion: something read back 8 times is
        # load-bearing regardless of age, and something never read is noise.
        # Without a hit count, promotion would have to guess from timestamps.
        self._safe_add_column("memory", "memory_entries", "hits", "INTEGER DEFAULT 0")
        self._safe_add_column("memory", "memory_entries", "accessed_at", "INTEGER DEFAULT 0")
        self._dbs["memory"].execute(
            "CREATE INDEX IF NOT EXISTS idx_mem_tier ON memory_entries(tier, root_dir)"
        )
        # C2 hybrid retrieval: FTS5 side-index for the lexical channel.
        #
        # `content=''` makes this a *contentless* external-content table: FTS5
        # stores only the inverted index, not a second copy of the text. The
        # authoritative text stays in memory_entries; we sync explicitly on write
        # rather than with triggers, because the indexed form is not the raw text
        # (CJK is bigrammed — see memory_retrieval.fts_document) and a trigger
        # cannot call Python.
        #
        # FTS5 is compiled into CPython's bundled SQLite on every platform we
        # ship, but a system SQLite built without it would raise here. Degrading
        # to vector-only is correct — losing the keyword channel is a quality
        # regression, not a crash.
        self._fts_enabled = False
        try:
            self._dbs["memory"].execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5("
                "body, root_dir UNINDEXED, entry_id UNINDEXED, tokenize='unicode61')"
            )
            self._fts_enabled = True
        except sqlite3.OperationalError:
            pass  # fail-open: 可选增强，失败不影响主流程

        # Phase 59 内化: 实体关系图谱表 (Graph Memory Engine)
        self._dbs["memory"].execute(
            "CREATE TABLE IF NOT EXISTS graph_entities ("
            "id TEXT PRIMARY KEY, root_dir TEXT, type TEXT NOT NULL, name TEXT NOT NULL, "
            "properties_json TEXT DEFAULT '{}', created_at INTEGER, updated_at INTEGER)"
        )
        self._dbs["memory"].execute(
            "CREATE TABLE IF NOT EXISTS graph_relations ("
            "id TEXT PRIMARY KEY, root_dir TEXT, source_id TEXT NOT NULL, target_id TEXT NOT NULL, "
            "relation_type TEXT NOT NULL, confidence REAL DEFAULT 1.0, created_at INTEGER)"
        )
        self._dbs["memory"].execute(
            "CREATE INDEX IF NOT EXISTS idx_graph_ent_name ON graph_entities(name, root_dir)"
        )
        self._dbs["memory"].execute(
            "CREATE INDEX IF NOT EXISTS idx_graph_rel_edge ON graph_relations(source_id, target_id)"
        )
        self._safe_add_column("memory", "project_memory_index", "last_dream_at", "INTEGER DEFAULT 0")
        # Sidebar conversation history: pinning keeps a session at the top of the
        # list regardless of recency. Added via ALTER so existing DBs upgrade.
        self._safe_add_column("sessions", "sessions", "pinned", "INTEGER DEFAULT 0")
        # Workspace = the working folder a conversation belongs to. Empty string
        # means "the default workspace" (user never picked a folder), which the
        # UI labels rather than showing a bare path.
        self._safe_add_column("sessions", "sessions", "workspace", "TEXT DEFAULT ''")
        # 2.1 回合状态机：从二值升级为持久化枚举。三列一起加——status 是前端和
        # 恢复逻辑判断的那个轴，substatus 由 agent_phases 折叠而来（存「大致在干
        # 什么」），status_updated_at 让「卡在某状态多久了」可查。全部走 ALTER，
        # 老库升级即得，且 branch()/create_session 用具名列插入，新列自动取默认。
        self._safe_add_column("sessions", "sessions", "turn_status", "TEXT DEFAULT 'idle'")
        self._safe_add_column("sessions", "sessions", "turn_substatus", "TEXT DEFAULT ''")
        self._safe_add_column("sessions", "sessions", "status_updated_at", "INTEGER DEFAULT 0")

        # One-time backfill: older boots wrote "." (or "./") as the workspace
        # because the value came straight from a relative CLI arg or config
        # entry. That string is a valid path but a terrible IDENTITY — the
        # sidebar renders its last segment, so it showed up as a bare "." that
        # reads like a rendering glitch, and it never collates with the absolute
        # path the same folder gets today. Result: two "default workspace" rows
        # holding the same conversations. Rewrite the relative spellings to the
        # absolute path so old and new rows collapse into one folder.
        self._normalize_workspace_paths()
        # Then undo the one binding that is never a real choice: system's own
        # launch directory. Electron starts the backend with cwd=<repo>/app, so a
        # row stamped with that path is an artefact, not a user decision — it
        # surfaced in the sidebar as a workspace literally called "app". Must run
        # AFTER the pass above, which rewrites "." into the cwd.
        self._unbind_own_dirs()


        # turn_usage must exist BEFORE the ALTERs and the backfill below. It used
        # to be created ~70 lines further down, so every first boot on a fresh DB
        # printed five "ALTER usage.turn_usage ... FAILED: no such table" lines
        # plus one "operation FAILED: no such table: turn_usage" — startup noise
        # that looks like real breakage and trains you to ignore migration errors.
        self._dbs["usage"].execute("CREATE TABLE IF NOT EXISTS turn_usage (id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, model_id TEXT DEFAULT '', input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_creation INTEGER, cache_read INTEGER, provider_total INTEGER, computed_total INTEGER, model_retry INTEGER DEFAULT 0, retryable INTEGER DEFAULT 1, context_exceeded INTEGER DEFAULT 0, error_type TEXT, latency_ms INTEGER DEFAULT 0, cost_micros INTEGER DEFAULT 0, cache_saved_micros INTEGER DEFAULT 0, cost_source TEXT DEFAULT '', created_at INTEGER)")

        # Usage analytics: which model a turn ran on. Without it, per-model
        # breakdowns are impossible. ALTER so pre-existing usage.db upgrades.
        self._safe_add_column("usage", "turn_usage", "model_id", "TEXT DEFAULT ''")
        # End-to-end turn latency in milliseconds (wall clock, request→final
        # answer, including tool round-trips). Enables the p95 read-out — an
        # average hides the tail, and the tail is what users actually feel.
        self._safe_add_column("usage", "turn_usage", "latency_ms", "INTEGER DEFAULT 0")
        # Money, computed ONCE at insert time from the rate table in effect then.
        # Rates change; a turn from March must keep March's price, so nothing
        # downstream is allowed to re-derive cost from tokens on read.
        self._safe_add_column("usage", "turn_usage", "cost_micros", "INTEGER DEFAULT 0")
        # What prompt caching saved on this turn, same units. Kept separate so
        # "you spent X" and "caching saved you Y" are two facts, not one net figure.
        self._safe_add_column("usage", "turn_usage", "cache_saved_micros", "INTEGER DEFAULT 0")
        # reported | estimated | fallback — provenance of cost_micros. A number
        # the user sees needs to say how much to trust it.
        self._safe_add_column("usage", "turn_usage", "cost_source", "TEXT DEFAULT ''")
        try:
            u = self._dbs["usage"]
            u.execute("UPDATE turn_usage SET model_id = 'openai:LongCat-2.0' WHERE model_id IN ('custom:', 'custom', 'custom:LongCat-2.0', '')")
            u.execute("UPDATE turn_usage SET model_id = 'openai:' || SUBSTR(model_id, 8) WHERE model_id LIKE 'custom:%'")
            u.commit()
        except Exception as _e:
            print(f"[storage] operation FAILED: {_e}")
        # Autonomous goal execution. The original goals table only knew
        # description/status/iteration, which is not enough to run a goal
        # unattended: the scheduler needs a per-goal iteration ceiling, a spend
        # ledger to enforce the cost cap, the decomposed plan it is working
        # through, and somewhere to record why a run stopped.
        self._safe_add_column("goals", "goals", "max_iterations", "INTEGER DEFAULT 10")
        # Spend is stored in micro-dollars (1e-6 USD) as an integer. Money in
        # floats accumulates rounding error across dozens of increments, and the
        # cap comparison has to be exact.
        self._safe_add_column("goals", "goals", "cost_micros", "INTEGER DEFAULT 0")
        self._safe_add_column("goals", "goals", "cost_cap_micros", "INTEGER DEFAULT 5000000")
        self._safe_add_column("goals", "goals", "tokens_used", "INTEGER DEFAULT 0")
        # JSON array of {id, title, status}. Progress is derived from this
        # (completed/total), never from a hardcoded percentage.
        self._safe_add_column("goals", "goals", "plan_json", "TEXT DEFAULT '[]'")
        self._safe_add_column("goals", "goals", "last_error", "TEXT DEFAULT ''")
        self._safe_add_column("goals", "goals", "started_at", "INTEGER DEFAULT 0")
        # Set when the scheduler claims a goal, cleared when it releases it.
        # Survives a crash so a stale claim can be reclaimed on next startup.
        self._safe_add_column("goals", "goals", "claimed_at", "INTEGER DEFAULT 0")
        # Structured Goal Brief (D1): the machine-readable contract of what the
        # goal must produce — summary / assumptions / deliverables /
        # acceptanceCriteria / verificationPlan / outOfScope / designStyle.
        # Stored as JSON because it is read whole and never queried by field.
        # `description` stays the human one-liner; the brief is what the
        # scheduler and the verifier actually reason about, so a goal can no
        # longer be "done" by the model simply asserting it.
        self._safe_add_column("goals", "goals", "brief_json", "TEXT DEFAULT '{}'")
        # Derived category (code / research / file-ops / system / browser /
        # creative / goal-mgmt / unknown). Denormalized out of brief_json so the
        # goals list can filter and group without parsing every row's JSON.
        self._safe_add_column("goals", "goals", "category", "TEXT DEFAULT 'unknown'")
        # Per-round detail for a goal run. The goals row only carries a counter,
        # which answers "how many rounds" and nothing else: after a restart there
        # was no way to see what round 4 actually did or why the verifier rejected
        # it. One row per round, written by the scheduler worker.
        self._dbs["goals"].execute(
            "CREATE TABLE IF NOT EXISTS goal_iterations ("
            "id TEXT PRIMARY KEY, goal_id TEXT, ordinal INTEGER,"
            " started_at INTEGER, ended_at INTEGER,"
            " evidence_digest TEXT, verdict TEXT, verdict_reason TEXT,"
            " cost_micros INTEGER DEFAULT 0, tokens INTEGER DEFAULT 0,"
            " created_at INTEGER)"
        )
        self._dbs["goals"].execute(
            "CREATE INDEX IF NOT EXISTS idx_goal_iter_goal"
            " ON goal_iterations(goal_id, ordinal)"
        )
        # (turn_usage itself is created above, before its ALTERs; the
        # 'custom:' → 'openai:' model_id backfill also ran there.)
        self._dbs["usage"].execute("CREATE TABLE IF NOT EXISTS session_target (session_id TEXT PRIMARY KEY, token_budget INTEGER, tokens_used INTEGER DEFAULT 0)")
        self._dbs["usage"].execute("CREATE TABLE IF NOT EXISTS bot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)")
        # Bot messages table for remote control
        self._dbs["bot"].execute("CREATE TABLE IF NOT EXISTS bot_messages (id TEXT PRIMARY KEY, platform TEXT, user_id TEXT, content TEXT, direction TEXT, timestamp REAL)")
        self._dbs["bot"].execute("CREATE TABLE IF NOT EXISTS bot_audit (id TEXT PRIMARY KEY, platform TEXT, user_id TEXT, session_id TEXT, tool_name TEXT, action TEXT, blocked INTEGER DEFAULT 0, reason TEXT, timestamp REAL)")
        # Ordered, recorded schema changes. Everything ABOVE is the idempotent
        # bootstrap (create-if-not-exists + safe ALTERs) that guarantees a schema
        # exists; the registry below is for versioned changes that must run once,
        # in order, and leave a trail in `schema_migration` so "what shape is this
        # DB in?" is answerable instead of guessed.
        self._run_migrations()
        for db in self._dbs.values():
            db.commit()

    def _safe_add_column(self, db_name: str, table: str, column: str, col_type: str):
        """Idempotent ALTER TABLE ADD COLUMN (SQLite has no IF NOT EXISTS).

        Only "duplicate column name" is expected and silent. Every other
        OperationalError — a typo'd table, a malformed type, a locked db — used to
        be swallowed identically, which meant a column that never got added
        looked exactly like one that was already there. That silence is how you
        end up debugging "no such column" at a read site far away from the cause.
        """
        try:
            self._dbs[db_name].execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")
        except sqlite3.OperationalError as exc:
            if "duplicate column" not in str(exc).lower():
                print(f"[storage] ALTER {db_name}.{table} ADD {column} FAILED: {exc}")

    # ── Migration ledger ────────────────────────────────────────────────────
    #
    # `schema_migration` existed from the start and nothing ever wrote to it, so
    # the DB carried a table that implied "we track migrations" while the real
    # mechanism was an unrecorded pile of create-if-not-exists calls re-running
    # on every boot. Nobody could answer "has change X been applied here?"
    #
    # Each entry is ``(id, description, method_name)``. Rules:
    #   * ids are ordered and NEVER renumbered — the id is the identity that
    #     tells a live database what it has already done.
    #   * a step runs at most once per database, in list order.
    #   * a step must still be written defensively, because the very first run on
    #     a pre-existing database may find the change already present (that is
    #     exactly the state every user upgrading into this system is in).
    _MIGRATIONS: tuple = (
        ("0001_subagent_runs",
         "sub-agent run ledger + parent/generation indexes",
         "_mig_0001_subagent_runs"),
        ("0002_tool_side_effects",
         "side-effect ledger for write-class tool calls",
         "_mig_0002_tool_side_effects"),
        ("0003_skill_experiences",
         "skill experience ledger for the learning loop",
         "_mig_0003_skill_experiences"),
        ("0004_memory_skill_relations",
         "explicit memory/skill/goal/run relation graph",
         "_mig_0004_memory_skill_relations"),
        ("0005_skill_candidates",
         "skill candidate lifecycle ledger (Step E)",
         "_mig_0005_skill_candidates"),
        ("0006_candidate_verify_command",
         "deterministic verification command for skill candidates",
         "_mig_0006_candidate_verify_command"),
        ("0007_goal_contract",
         "versioned acceptance contract on goals (Phase 3)",
         "_mig_0007_goal_contract"),
        ("0008_cron_lease_and_team",
         "cron execution lease/team task leases (Phase 7 & 10)",
         "_mig_0008_cron_lease_and_team"),
        ("0009_mailbox",
         "persistent mailboxes for subagent/system messages (Phase 7)",
         "_mig_0009_mailbox"),
        ("0010_side_effect_generation",
         "stamp the writing process on side effects + replay lookup index",
         "_mig_0010_side_effect_generation"),
        ("0011_goal_claim_lease",
         "owner-conditioned goal claim lease with heartbeat renew",
         "_mig_0011_goal_claim_lease"),
        ("0012_typed_effects",
         "typed side effects: operation identity + pre/planned/post state",
         "_mig_0012_typed_effects"),
        ("0013_memory_lifecycle",
         "memory lifecycle: status/confidence/provenance/validity as columns",
         "_mig_0013_memory_lifecycle"),
        ("0014_memory_provenance",
         "memory provenance: sensitivity/source goal/source events/valid_from",
         "_mig_0014_memory_provenance"),
        ("0015_memory_conflict_set",
         "memory conflict_set: which live memories contradict this one",
         "_mig_0015_memory_conflict_set"),
        ("0016_memory_supersedes",
         "memory supersedes: which rows a pending merge would replace",
         "_mig_0016_memory_supersedes"),
        ("0017_dream_runs",
         "dream run ledger: job id / lease / heartbeat / budget / journal",
         "_mig_0017_dream_runs"),
        ("0018_learning_items_and_episodes",
         "conversation episodes and granular learning items ledger",
         "_mig_0018_learning_items_and_episodes"),
        ("0019_episode_learning_item_provenance_and_indexes",
         "episode and learning item provenance, idempotency key and branch indexes",
         "_mig_0019_episode_learning_item_provenance_and_indexes"),
        ("0020_learning_item_operations",
         "persistent learning item mutation operation ledger",
         "_mig_0020_learning_item_operations"),
    )

    def _app_version(self) -> str:
        """Best-effort app version, stamped on each migration row.

        Read from the UI package.json because that is the single place a version
        is declared today. Failure yields "unknown" rather than raising — a
        missing version string must not stop a schema upgrade.
        """
        try:
            pkg = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", "ui", "package.json"
            )
            with open(pkg, "r", encoding="utf-8") as fh:
                return str(json.load(fh).get("version") or "unknown")
        except Exception:  # noqa: BLE001
            return "unknown"

    def _applied_migrations(self) -> set:
        try:
            rows = self._dbs["configs"].execute(
                "SELECT id FROM schema_migration"
            ).fetchall()
        except sqlite3.OperationalError:
            return set()
        return {r["id"] for r in rows}

    def _backup_before_migration(self, pending_count: int) -> str:
        """迁移前的一致性快照（VACUUM INTO，天然含 WAL 未落盘内容）。

        备份失败不阻塞迁移——但必须大声说出来，让用户有机会手动备份后再动
        schema。沉默的备份等于没有备份。返回备份目录；自动回滚（
        :meth:`_restore_from_backup`）依赖它，所以失败时返回空串而不是路径。
        """
        bdir = os.path.join(self.db_dir, "backups",
                            f"pre-migration-{time.strftime('%Y%m%d-%H%M%S')}-{int(time.time() * 1000) % 1000:03d}")
        try:
            os.makedirs(bdir, exist_ok=True)
            done = 0
            for name, conn in self._dbs.items():
                # VACUUM 不允许在事务内执行——先落干净当前连接的隐式事务
                try:
                    conn.commit()
                except Exception as _e:
                    print(f"[storage] operation FAILED: {_e}")
                target = os.path.join(bdir, f"{name}.db")
                conn.execute("VACUUM INTO ?", (target,))
                done += 1
            print(f"[storage] {pending_count} migration(s) pending; "
                  f"backup of {done} db(s) → backups/{os.path.basename(bdir)}")
            return bdir
        except Exception as exc:  # noqa: BLE001
            print(f"[storage] MIGRATION BACKUP FAILED ({exc}) —— 迁移将继续；"
                  f"如需绝对安全请先手动备份 {self.db_dir}")
            return ""

    # ── Migration journal ────────────────────────────────────────────────

    def _journal_path(self) -> str:
        return os.path.join(self.db_dir, MIGRATION_JOURNAL_NAME)

    def _read_journal(self) -> dict:
        try:
            with open(self._journal_path(), "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError, TypeError):
            return {}

    def _write_journal(self, data: dict) -> None:
        try:
            with open(self._journal_path(), "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=1)
        except OSError as exc:
            # The journal is the recovery map; losing a write to it must be
            # loud, because a silent gap is exactly what makes the next
            # failure undiagnosable.
            print(f"[storage] MIGRATION JOURNAL WRITE FAILED: {exc}")

    def _journal_step_start(self, mig_id: str, description: str,
                            backup_dir: str) -> None:
        j = self._read_journal()
        steps = [s for s in (j.get("steps") or []) if s.get("id") != mig_id]
        steps.append({"id": mig_id, "description": description,
                      "status": "running", "error": "",
                      "started_at": int(time.time())})
        self._write_journal({"backup_dir": backup_dir or "", "steps": steps,
                             "updated_at": int(time.time())})

    def _journal_step_end(self, mig_id: str, status: str, error: str = "") -> None:
        j = self._read_journal()
        for s in (j.get("steps") or []):
            if s.get("id") == mig_id:
                s["status"] = status
                s["error"] = str(error or "")[:500]
                s["finished_at"] = int(time.time())
        j["updated_at"] = int(time.time())
        self._write_journal(j)

    def _restore_from_backup(self, backup_dir: str) -> bool:
        """Roll every database back to its pre-migration snapshot.

        Last-resort layer 2 of the migration recovery contract: if this also
        fails, the caller must raise :class:`MigrationUnrecoverable` rather
        than boot on a schema nobody can describe. Restoring means closing
        every handle first (Windows pins open files), removing stale WAL
        sidecars so old frames cannot resurrect rolled-back pages, copying the
        backup over the live files, and reopening.
        """
        if not backup_dir or not os.path.isdir(backup_dir):
            print("[storage] no pre-migration backup directory to roll back to")
            return False
        try:
            for conn in list(getattr(self, "_dbs", {}).values()):
                try:
                    conn.close()
                except Exception:
                    pass  # fail-closed path: any handle we cannot close is
                        # reported by the copy step below, not swallowed here
            self._dbs = {}
            try:
                if getattr(self, "_event_store", None) is not None:
                    self._event_store.close()
            except Exception:
                pass  # 同上：copyfile 阶段会如实暴露占用问题
            copied = 0
            for fname in sorted(os.listdir(backup_dir)):
                if not fname.endswith(".db"):
                    continue
                src = os.path.join(backup_dir, fname)
                dst = os.path.join(self.db_dir, fname)
                for suffix in ("-wal", "-shm"):
                    side = dst + suffix
                    if os.path.exists(side):
                        try:
                            os.unlink(side)
                        except OSError:
                            pass  # 删不掉的 sidecar 由覆盖后的校验暴露
                shutil.copyfile(src, dst)
                copied += 1
            if copied == 0:
                print(f"[storage] backup dir {backup_dir} holds no .db files")
                return False
            self._open_db_connections()
            print(f"[storage] rolled back {copied} db(s) from "
                  f"backups/{os.path.basename(backup_dir)} "
                  "(migration failed; running on the previous schema)")
            return True
        except Exception as exc:  # noqa: BLE001
            print(f"[storage] RESTORE FROM BACKUP FAILED: {exc}")
            return False

    def _run_migrations(self) -> None:
        """Apply every unapplied migration in order, recording each one.

        A failing migration is NOT swallowed, and it no longer has to mean the
        app never opens again (the old behaviour printed and re-raised, which
        left the user with a permanently dead desktop app after one dirty
        row). Three layers, in order:

        1. **Journal + backup.** Before each step a sidecar journal names the
           step in flight and the backup directory to roll back to; each step
           is also preceded by a VACUUM INTO snapshot.
        2. **Automatic rollback.** On failure the databases are restored from
           that snapshot and boot CONTINUES on the old schema, visibly: the
           failed step is recorded as deferred, ``recovery_mode`` becomes
           ``compat``, and every read path that reports schema state says so.
           The step will not auto-retry on later boots — retrying a migration
           that just corrupted this database on every launch is how you turn
           one bad day into an unbootable app. Retry is explicit via
           :meth:`retry_deferred_migration`.
        3. **Unrecoverable.** If even the restore fails,
           :class:`MigrationUnrecoverable` is raised so the entrypoint starts
           the read-only recovery server instead of half-running the app.

        The ledger row is only written AFTER the step succeeds, so a crashed
        migration is retried (or explicitly deferred) rather than skipped.
        """
        applied = self._applied_migrations()
        # Steps already known to fail here stay deferred until a human asks
        # for a retry; see layer 2 above.
        deferred = dict(self.get_config("migration.deferred") or {})
        version = self._app_version()
        c = self._dbs["configs"]
        # §19 迁移纪律 4：动 schema 前先备份。只在真有要执行的迁移时才备份，
        # 每次启动都全量复制是浪费磁盘。
        _pending = [m for m in self._MIGRATIONS
                    if m[0] not in applied and m[0] not in deferred]
        if not _pending:
            return
        backup_dir = self._backup_before_migration(len(_pending))
        for mig_id, description, method in self._MIGRATIONS:
            if mig_id in applied:
                continue
            if mig_id in deferred:
                # Order matters: a later step may build on an earlier one, so
                # hitting a deferred step stops THIS BOOT from applying
                # anything further. The upgrade resumes from here after the
                # human explicitly retries.
                print(f"[storage] deferred migration {mig_id} reached — "
                      "later steps held back until an explicit retry")
                return
            fn = getattr(self, method, None)
            if fn is None:
                print(f"[storage] migration {mig_id} references missing method {method!r}")
                continue
            self._journal_step_start(mig_id, description, backup_dir)
            try:
                fn()
            except Exception as exc:  # noqa: BLE001
                print(f"[storage] MIGRATION FAILED {mig_id} ({description}): {exc}")
                self._journal_step_end(mig_id, "failed", str(exc))
                if self._restore_from_backup(backup_dir):
                    self.recovery_mode = "compat"
                    detail = {
                        "mode": "compat",
                        "failedMigration": mig_id,
                        "error": str(exc)[:500],
                        "backupDir": backup_dir,
                        "at": int(time.time()),
                    }
                    self.set_config("migration.recovery_mode", detail)
                    deferred[mig_id] = {"reason": str(exc)[:400],
                                        "at": int(time.time())}
                    self.set_config("migration.deferred", deferred)
                    print(
                        f"[storage] *** UPGRADE INCOMPLETE *** rolled back to "
                        f"previous schema; data intact. Failed step {mig_id} "
                        f"is deferred — retry from Settings → 系统或 "
                        f"POST /api/system/migrations/retry"
                    )
                    return  # keep booting on the rolled-back (old) schema
                self.recovery_mode = "unrecoverable"
                raise MigrationUnrecoverable(mig_id, exc, backup_dir,
                                             self._journal_path()) from exc
            # Checksum pins the id+description pair. It is not a hash of the SQL
            # (the step is Python), so it cannot detect an edited migration body
            # — it only catches an id reused for different intent.
            checksum = hashlib.sha256(
                f"{mig_id}|{description}".encode("utf-8")
            ).hexdigest()[:16]
            c.execute(
                "INSERT OR REPLACE INTO schema_migration"
                " (id, checksum, app_version, applied_at) VALUES (?,?,?,?)",
                (mig_id, checksum, version, int(time.time())),
            )
            c.commit()
            self._journal_step_end(mig_id, "done")
            print(f"[storage] migration applied: {mig_id} ({description})")

    def retry_deferred_migration(self, mig_id: str = "") -> dict:
        """Re-run a migration that failed and was auto-deferred (layer 2).

        Explicit by design: the automatic loop must not relaunch a schema
        change that corrupted this database yesterday. Takes a fresh backup
        first; on success clears the deferral and — when nothing else is
        deferred any more — lifts compat mode. Never raises; the result dict
        carries per-step outcomes.
        """
        deferred = dict(self.get_config("migration.deferred") or {})
        if mig_id:
            if mig_id not in deferred:
                return {"ok": False, "results": [],
                        "error": f"{mig_id} 不在延迟清单里"}
            targets = [mig_id]
        else:
            targets = list(deferred.keys())
        if not targets:
            return {"ok": True, "results": [], "error": ""}
        backup_dir = self._backup_before_migration(len(targets))
        c = self._dbs["configs"]
        applied = self._applied_migrations()
        version = self._app_version()
        results: list[dict] = []
        for mid, description, method in self._MIGRATIONS:
            if mid not in targets:
                continue
            fn = getattr(self, method, None)
            if fn is None:
                results.append({"id": mid, "ok": False,
                                "error": f"missing method {method!r}"})
                continue
            self._journal_step_start(mid, description, backup_dir)
            try:
                fn()
            except Exception as exc:  # noqa: BLE001
                self._journal_step_end(mid, "failed", str(exc))
                self._restore_from_backup(backup_dir)
                results.append({"id": mid, "ok": False, "error": str(exc)[:300]})
                continue
            checksum = hashlib.sha256(
                f"{mid}|{description}".encode("utf-8")
            ).hexdigest()[:16]
            if mid not in applied:
                c.execute(
                    "INSERT OR REPLACE INTO schema_migration"
                    " (id, checksum, app_version, applied_at) VALUES (?,?,?,?)",
                    (mid, checksum, version, int(time.time())),
                )
                c.commit()
            self._journal_step_end(mid, "done")
            deferred.pop(mid, None)
            results.append({"id": mid, "ok": True, "error": ""})
        self.set_config("migration.deferred", deferred)
        ok = all(r.get("ok") for r in results) and bool(results)
        if ok and not deferred:
            # Everything that failed is now applied: the upgrade is complete.
            # Clearing is keyed on the LEDGER state (no deferrals left), not on
            # this instance's flag — the retry may run on a fresh process whose
            # own boot never saw the failure.
            self.set_config("migration.recovery_mode",
                            {"mode": "", "clearedAt": int(time.time())})
            self.recovery_mode = ""
            # Steps that were held BEHIND the deferred one (ordering rule in
            # _run_migrations) can now finish the upgrade in one go.
            try:
                self._run_migrations()
            except MigrationUnrecoverable:
                raise
            except Exception as exc:  # noqa: BLE001
                print(f"[storage] post-retry migrations failed: {exc}")
        return {"ok": ok, "results": results, "error": ""}

    def migration_status(self) -> dict:
        """What this database has applied, and what is still outstanding.

        Exists so the answer comes from the ledger rather than from reading the
        source and hoping. ``pending`` non-empty on a running app means a
        migration failed or was skipped — both worth surfacing. Also carries
        the recovery state (``compat`` after a rolled-back failure) and the
        sidecar journal, which is what the UI's repair entry renders.
        """
        try:
            rows = [dict(r) for r in self._dbs["configs"].execute(
                "SELECT id, checksum, app_version, applied_at FROM schema_migration"
                " ORDER BY applied_at, id"
            ).fetchall()]
        except sqlite3.OperationalError:
            rows = []
        done = {r["id"] for r in rows}
        deferred = self.get_config("migration.deferred") or {}
        journal = self._read_journal()
        return {
            "applied": rows,
            "pending": [
                {"id": m[0], "description": m[1]}
                for m in self._MIGRATIONS if m[0] not in done
            ],
            "deferred": [
                {"id": k, **(v if isinstance(v, dict) else {"reason": str(v)})}
                for k, v in sorted(deferred.items())
            ],
            "registered": len(self._MIGRATIONS),
            "appVersion": self._app_version(),
            "recoveryMode": self.recovery_mode,
            "journal": {
                "path": self._journal_path(),
                "backupDir": journal.get("backup_dir") or "",
                "steps": journal.get("steps") or [],
            },
        }

    def _mig_0001_subagent_runs(self) -> None:
        """Sub-agent run ledger.

        `subagent_runtime` tracked runs in a process-local dict that also
        self-expires after FINISHED_RETENTION_S, so a restart — or just looking a
        few minutes later — left no trace of what ran, how it ended, or how long
        it took. `generation` is what makes crash detection possible: a
        non-terminal row from another generation cannot still be running,
        because the process that owned it is gone.

        Lives in the sessions db because a run is session-scoped and is queried
        per parent session. It is deliberately NOT part of the child session row,
        which gets deleted on teardown (CLEANUP_CHILD_SESSIONS).
        """
        s = self._dbs["sessions"]
        s.execute(
            "CREATE TABLE IF NOT EXISTS subagent_runs ("
            "subagent_id TEXT PRIMARY KEY, generation TEXT,"
            " parent_session_id TEXT, child_session_id TEXT,"
            " subagent_type TEXT, label TEXT, status TEXT,"
            " created_at REAL, started_at REAL DEFAULT 0, finished_at REAL DEFAULT 0,"
            " result_chars INTEGER DEFAULT 0, error TEXT DEFAULT '')"
        )
        s.execute(
            "CREATE INDEX IF NOT EXISTS idx_subrun_parent"
            " ON subagent_runs(parent_session_id, created_at)"
        )
        # The reap query filters on (generation, status); without this index it
        # is a full scan on every boot.
        s.execute(
            "CREATE INDEX IF NOT EXISTS idx_subrun_gen"
            " ON subagent_runs(generation, status)"
        )
        s.commit()

    def _mig_0002_tool_side_effects(self) -> None:
        """Side-effect ledger for write-class tool calls.

        Write-class calls (risk_level >= medium) are recorded before dispatch
        and settled after, so a goal resumed after a crash can be shown what
        already landed instead of silently redoing it. ``call_id`` is the
        primary key — one row per tool call — and INSERT OR IGNORE makes a
        replayed record a no-op.

        Deliberately NOT folded into 0001: a migration id runs at most once
        per database, and every live database had already applied 0001 when
        this table was designed. New DDL inside an applied step executes
        nowhere except tests (which always start from an empty database).
        """
        s = self._dbs["sessions"]
        s.execute(
            "CREATE TABLE IF NOT EXISTS tool_side_effects ("
            "call_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,"
            " goal_id TEXT DEFAULT '', tool_name TEXT NOT NULL, args_hash TEXT NOT NULL,"
            " status TEXT NOT NULL DEFAULT 'pending',"
            " ok INTEGER NOT NULL DEFAULT 0, result_preview TEXT DEFAULT '',"
            " created_at INTEGER NOT NULL, settled_at INTEGER)"
        )
        s.execute(
            "CREATE INDEX IF NOT EXISTS idx_side_effects_goal"
            " ON tool_side_effects(goal_id, status)"
        )
        s.commit()

    def _mig_0003_skill_experiences(self) -> None:
        """Skill experience ledger — the memory of how a skill actually went.

        The learning loop (Evolution → candidate → active) needs evidence per
        real use: was the skill selected, did its steps work, what did the user
        say afterwards. Without persisted experiences every "the model learned
        this" claim is unfalsifiable.

        Idempotency is structural: ``experience_id`` is derived from
        (run_id, skill_id, turn_id), and a UNIQUE index on the same triple
        makes a replayed INSERT OR IGNORE a no-op — crash recovery can
        re-record the same turn without manufacturing duplicate experience.
        """
        s = self._dbs["sessions"]
        s.execute(
            "CREATE TABLE IF NOT EXISTS skill_experiences ("
            "experience_id TEXT PRIMARY KEY,"
            " skill_id TEXT NOT NULL, skill_version TEXT DEFAULT '',"
            " run_id TEXT DEFAULT '', turn_id TEXT DEFAULT '',"
            " goal_id TEXT DEFAULT '', session_id TEXT DEFAULT '',"
            " memory_snapshot_id TEXT DEFAULT '',"
            " selection_reason TEXT DEFAULT '',"
            " preconditions_met INTEGER DEFAULT 0,"
            " steps_attempted INTEGER DEFAULT 0, steps_succeeded INTEGER DEFAULT 0,"
            " validator_status TEXT DEFAULT 'none',"
            " user_feedback TEXT DEFAULT '',"
            " outcome TEXT DEFAULT 'unknown', failure_class TEXT DEFAULT '',"
            " repair_applied TEXT DEFAULT '',"
            " cost REAL DEFAULT 0, latency_ms REAL DEFAULT 0,"
            " source_event_ids TEXT DEFAULT '[]', evidence_event_ids TEXT DEFAULT '[]',"
            " created_at INTEGER NOT NULL)"
        )
        s.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_exp_dedupe"
            " ON skill_experiences(run_id, skill_id, turn_id)"
        )
        s.execute(
            "CREATE INDEX IF NOT EXISTS idx_exp_skill"
            " ON skill_experiences(skill_id, created_at)"
        )
        s.commit()

    def _mig_0004_memory_skill_relations(self) -> None:
        """Memory–Skill 显式关系图（Step D）。

        Memory 和 Skill 是不同对象、不同存储（memory.db / 磁盘 SKILL.md），
        它们之间的依赖必须是一等公民而不是散落在提示词里的暗示：记忆改了，
        哪些技能要重验；技能失败时，先怀疑哪一层。统一成三元组边表——八种
        关系动词各固定一种 (主体, 客体) 形状，代码里校验，库里加 UNIQUE 防
        重复建边；id 由五元组确定性派生，重放安全。
        """
        s = self._dbs["sessions"]
        s.execute(
            "CREATE TABLE IF NOT EXISTS memory_skill_relations ("
            "id TEXT PRIMARY KEY,"
            " subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,"
            " relation TEXT NOT NULL,"
            " object_type TEXT NOT NULL, object_id TEXT NOT NULL,"
            " evidence TEXT DEFAULT '',"
            " stale INTEGER NOT NULL DEFAULT 0,"
            " created_at INTEGER NOT NULL,"
            " UNIQUE(subject_type, subject_id, relation, object_type, object_id))"
        )
        s.execute(
            "CREATE INDEX IF NOT EXISTS idx_rel_sub"
            " ON memory_skill_relations(subject_type, subject_id, relation)"
        )
        s.execute(
            "CREATE INDEX IF NOT EXISTS idx_rel_obj"
            " ON memory_skill_relations(object_type, object_id, relation)"
        )
        s.commit()

    def _mig_0005_skill_candidates(self) -> None:
        """Skill 候选生命周期台账（Step E）。

        候选在成为磁盘上的 SKILL.md 之前需要一个家：字段、证据绑定、门禁
        报告、版本与回滚快照路径都在这里。status 是单向主链
        candidate → staged → active，失败侧线 degraded / stale / rejected /
        archived——一次失败绝不直接覆盖 active 技能。
        """
        s = self._dbs["sessions"]
        s.execute(
            "CREATE TABLE IF NOT EXISTS skill_candidates ("
            "id TEXT PRIMARY KEY,"
            " name TEXT NOT NULL,"
            " description TEXT DEFAULT '', when_to_use TEXT DEFAULT '',"
            " scope TEXT DEFAULT '', preconditions TEXT DEFAULT '',"
            " inputs TEXT DEFAULT '', outputs TEXT DEFAULT '',"
            " steps TEXT DEFAULT '[]', required_tools TEXT DEFAULT '[]',"
            " risk_level TEXT DEFAULT 'medium',"
            " verification TEXT DEFAULT '', known_failures TEXT DEFAULT '',"
            " memory_refs TEXT DEFAULT '[]',"
            " experience_ref TEXT DEFAULT '',"
            " source_event_ids TEXT DEFAULT '[]',"
            " version TEXT DEFAULT '',"
            " status TEXT NOT NULL DEFAULT 'candidate',"
            " gate_report TEXT DEFAULT '{}',"
            " superseded_skill TEXT DEFAULT '',"
            " snapshot_path TEXT DEFAULT '',"
            " created_at INTEGER NOT NULL, updated_at INTEGER DEFAULT 0)"
        )
        s.execute(
            "CREATE INDEX IF NOT EXISTS idx_cand_status"
            " ON skill_candidates(status, created_at)"
        )
        s.commit()

    def _mig_0006_candidate_verify_command(self) -> None:
        """候选的确定性验证命令（approve 时人工点击后执行一次）。

        总指令 §9.4 要求 "source replay、相似 holdout 或 deterministic
        validator 至少其一"。这一列落地的是**第三条**：候选可以声明一条验证
        命令，批准上线时真跑一遍（受沙箱约束），退出码非 0 就拒绝激活。执行
        只发生在用户点击批准的那一刻——命令本身来自候选，人是最后一道门。

        另两条的现状要说清楚，免得下一个人以为它们也在这里：
        * source replay **没有真的重放**——`run_gates` 检查的是账本里有没有
          成功经验与已落地副作用，那道门因此叫 ``source_evidence``；
        * 相似 holdout **不存在**——真 holdout 需要可重放的任务样本集，这个
          项目还没有。代理判据是"在两个互不相同的场合各成功过一次"，写在
          ``evidence_strength`` 里，名字里不带 holdout 二字。
        """

        self._safe_add_column(
            "sessions", "skill_candidates", "verify_command",
            "TEXT DEFAULT ''",
        )

    def _mig_0007_goal_contract(self) -> None:
        """版本化验收合同（Phase 3）。旧目标无合同，首次读取时从 GoalBrief 派生回填。"""
        self._safe_add_column(
            "goals", "goals", "contract_json",
            "TEXT DEFAULT ''",
        )


    def _mig_0009_mailbox(self) -> None:
        """§13 Mailbox：子代理/系统通知的持久信箱（Phase 7 收口）。

        消费即标记（consumed=1），记录保留——信箱是投递通道也是审计线索，
        删除历史等于销毁“谁在什么时候被告知了什么”的证据。
        """
        c = self._dbs["sessions"]
        c.execute(
            "CREATE TABLE IF NOT EXISTS mailbox_messages ("
            "id TEXT PRIMARY KEY,"
            " box_id TEXT NOT NULL,"
            " sender TEXT NOT NULL,"
            " kind TEXT NOT NULL DEFAULT 'info',"
            " payload TEXT NOT NULL DEFAULT '{}',"
            " consumed INTEGER NOT NULL DEFAULT 0,"
            " created_at INTEGER NOT NULL)"
        )
        c.execute(
            "CREATE INDEX IF NOT EXISTS idx_mbox_box"
            " ON mailbox_messages(box_id, consumed, created_at)"
        )

    def _mig_0010_side_effect_generation(self) -> None:
        """Which process wrote this side effect — plus the index to look it up by.

        A resumed goal needs one distinction the ledger could not make: did
        this critical write land *in an earlier process* (so redoing it means
        doing it twice), or is the model simply repeating itself inside the
        current run (a loop-detector question, not a recovery one)? Both look
        identical when all you have is ``status='completed'``.

        ``generation`` is the same per-process token ``subagent_runs`` already
        uses, so "written by a process that is no longer alive" is expressible
        here too. The index covers the replay lookup — goal + tool + args_hash
        — which the existing ``(goal_id, status)`` index cannot serve.
        """
        self._safe_add_column("sessions", "tool_side_effects",
                              "generation", "TEXT DEFAULT ''")
        c = self._dbs["sessions"]
        c.execute(
            "CREATE INDEX IF NOT EXISTS idx_side_effects_replay"
            " ON tool_side_effects(goal_id, tool_name, args_hash)"
        )

    def _mig_0011_goal_claim_lease(self) -> None:
        """Goal claim becomes a heartbeat lease instead of a static timestamp.

        The old claim was ``claimed_at`` alone, and staleness was "claimed_at
        is older than 900s" — which reads total runtime as worker death. A
        healthy goal that runs longer than 15 minutes was stealable by any
        second scheduler. Four columns turn it into a Kubernetes-style lease
        compressed to one SQLite row:

        * ``claim_owner`` — who holds it; release/renew are conditioned on it,
          which also fixes the old-worker-clobbers-new-claim race.
        * ``lease_until`` — the deadline a claimant must keep pushing forward
          by renewing. Expiry of THIS column, not of claimed_at, is what makes
          a claim stealable.
        * ``last_heartbeat`` / ``claim_epoch`` — diagnostics and a cheap
          fencing counter for "how many times has this goal changed hands".

        Rows claimed without an owner (legacy callers, tests) keep the old
        shape: ``claim_owner=''``, ``lease_until=0``, judged by the same
        claimed_at staleness rule as before.
        """
        self._safe_add_column("goals", "goals", "claim_owner", "TEXT DEFAULT ''")
        self._safe_add_column("goals", "goals", "lease_until", "INTEGER DEFAULT 0")
        self._safe_add_column("goals", "goals", "last_heartbeat", "INTEGER DEFAULT 0")
        self._safe_add_column("goals", "goals", "claim_epoch", "INTEGER DEFAULT 0")

    def _mig_0012_typed_effects(self) -> None:
        """Side effects get an identity and a before/after, not just an args hash.

        ``args_hash`` answers "were these two requests spelled the same", which
        is the wrong question after a crash: what a resumed run must know is
        whether the change LANDED. These columns make that answerable from the
        file system (see ``effects.reconcile``):

        * ``effect_kind`` / ``target`` — what changed, and the canonical name of
          the thing it changed.
        * ``operation_id`` — deterministic identity of this change to that
          target, so a resumed run finds its own earlier attempt without
          comparing argument text.
        * ``pre_hash`` / ``planned_hash`` / ``post_hash`` — the target's observed
          state before, the state a success would produce, and the state we
          actually observed after. An interrupted call has the first two and not
          the third; that is exactly the case reconcile exists for.

        All additive with defaults, plus one index — nothing here can fail on
        existing rows, which matters because a failed migration takes the whole
        app down (see ``_run_migrations``).
        """
        for col, decl in (("effect_kind", "TEXT DEFAULT ''"),
                          ("target", "TEXT DEFAULT ''"),
                          ("operation_id", "TEXT DEFAULT ''"),
                          ("pre_hash", "TEXT DEFAULT ''"),
                          ("planned_hash", "TEXT DEFAULT ''"),
                          ("post_hash", "TEXT DEFAULT ''")):
            self._safe_add_column("sessions", "tool_side_effects", col, decl)
        c = self._dbs["sessions"]
        c.execute(
            "CREATE INDEX IF NOT EXISTS idx_side_effects_operation"
            " ON tool_side_effects(operation_id, status)"
        )

    def _mig_0013_memory_lifecycle(self) -> None:
        """记忆有了生命周期：状态、置信度、来源、有效期，都是列而不是 JSON。

        之前一条记忆的"处境"只能用 ``archived`` 0/1 表达：被用户否掉的、已经
        过期的、还等着批准的、单纯收起来的，四种完全不同的处境挤在同一个比特
        里。而"这条有多可信"根本没有位置——``confidence`` 只存在于 wiki 断言
        上，普通记忆只有一个 ``importance``（那是"多重要"，不是"多可信"，把它
        当置信度用会让"很重要但很可能已经不对"的记忆排到最前面）。

        新增列（全部加默认值，没有 UNIQUE，历史数据不可能让这一步失败——
        迁移失败会拖垮整个应用，见 ``_run_migrations``）：

        * ``status``：candidate | active | stale | rejected | archived。
        * ``confidence`` 0..1：召回排序与冲突裁决都要用它。
        * ``created_by``：user | agent | evolution | import，"谁说的"决定了
          它值不值得被信，也决定了用户能不能理所当然地删掉它。
        * ``version`` / ``superseded_by``：一条记忆被新事实取代时，不是原地
          改写而是指向新的那条，旧的转 stale。
        * ``valid_until``：明确的失效时刻（0 = 不失效）。到点之后读路径直接
          当 stale，不必等后台扫。
        * ``last_confirmed_at``：最后一次被证实还成立的时间。它和 created_at
          的差才是"新鲜度"，只看创建时间会把一条天天被确认的老事实误判为陈旧。
        * ``status_reason``：为什么变成这个状态。删除和否决必须能解释，否则
          下一次 Dream 又会把同一条错的捡回来。

        ``archived`` 保留但不再是事实源：这一步把它翻译成 status，之后由
        ``set_memory_status`` 两边一起写，避免两个字段各说一套。
        """
        for col, decl in (("status", "TEXT DEFAULT 'active'"),
                          ("confidence", "REAL DEFAULT 0.5"),
                          ("created_by", "TEXT DEFAULT ''"),
                          ("version", "INTEGER DEFAULT 1"),
                          ("superseded_by", "TEXT DEFAULT ''"),
                          ("valid_until", "INTEGER DEFAULT 0"),
                          ("last_confirmed_at", "INTEGER DEFAULT 0"),
                          ("status_reason", "TEXT DEFAULT ''")):
            self._safe_add_column("memory", "memory_entries", col, decl)
        c = self._dbs["memory"]
        # 老行的状态从 archived 推出来，一次性；之后两边一起写。
        c.execute("UPDATE memory_entries SET status='archived'"
                  " WHERE archived=1 AND COALESCE(status,'') IN ('', 'active')")
        c.execute("UPDATE memory_entries SET status='active'"
                  " WHERE archived=0 AND COALESCE(status,'')=''")
        # 老行没有"最后确认时间"，用创建时间兜底：它至少在写下的那一刻成立过。
        c.execute("UPDATE memory_entries SET last_confirmed_at=created_at"
                  " WHERE COALESCE(last_confirmed_at,0)=0")
        c.execute(
            "CREATE INDEX IF NOT EXISTS idx_mem_status"
            " ON memory_entries(root_dir, status)"
        )
        # 迁移编排本身也会 commit；这里再提交一次是为了让这个函数单独被调用时
        # （修复脚本、手工重跑）也能落地，多一次 commit 无害。
        c.commit()

    def _mig_0014_memory_provenance(self) -> None:
        """一条记忆现在能回答"你凭什么这么说"和"这话能不能给别人看"。

        0013 补齐了"处境"，但 §9.2 还差四样，而缺的这四样各自对应一个具体的坑：

        * ``sensitivity``：public | internal | personal。不影响是否写入——一条
          "用户的邮箱是 x@y.com"是合法且有用的长期记忆——但界面要能标出来、导出
          和分享要能排除。把"敏感"和"不该记"混成一个判断，结果是两边都不对。
        * ``source_goal_id`` / ``source_event_ids``：这条记忆是从哪次任务、哪几
          个事件里提取出来的。没有它，用户看到一条错的记忆时唯一能做的是删掉，
          而不是回去看当时到底发生了什么；Dream 也无法判断证据是否已经被推翻。
        * ``valid_from``：从什么时候开始成立。和 ``valid_until`` 一起构成有效
          区间——"下个季度开始改用 pnpm"这种事实在写下的当时是**还没生效**的，
          没有这一列就只能等到生效那天再写，或者提前当成已经成立。

        全部带默认值、无约束，历史行不可能让这一步失败。``source_event_ids`` 存
        JSON 数组字符串而不是开一张关联表：它只被"打开这条记忆的来源"这一个动作
        读，不需要反向查询，一张表换一次 join 不值得。
        """
        for col, decl in (("sensitivity", "TEXT DEFAULT 'public'"),
                          ("source_goal_id", "TEXT DEFAULT ''"),
                          ("source_event_ids", "TEXT DEFAULT '[]'"),
                          ("valid_from", "INTEGER DEFAULT 0")):
            self._safe_add_column("memory", "memory_entries", col, decl)
        c = self._dbs["memory"]
        # 老行没有 valid_from，用创建时间兜底：它至少从写下的那一刻开始成立。
        # 不留 0 是因为 0 会被读路径当成"未设置"，而"未设置"和"从一开始就成立"
        # 在区间判断里是同一个意思——写清楚比留空更容易解释。
        c.execute("UPDATE memory_entries SET valid_from=created_at"
                  " WHERE COALESCE(valid_from,0)=0")
        c.execute("UPDATE memory_entries SET sensitivity='public'"
                  " WHERE COALESCE(sensitivity,'')=''")
        c.commit()

    def _mig_0015_memory_conflict_set(self) -> None:
        """一条记忆现在能指出"谁和我打架"。

        §9.2 的 ``conflict_set``。断言那边靠 ``contradicts_json`` 已经有这个能力，
        普通记忆一直没有——于是"项目用 pnpm"和"项目不用 pnpm"可以同时是 active，
        两条都被召回，模型每轮都要在两个互相否认的事实之间猜一个。

        存 JSON 数组而不是开一张关联表，理由和 ``source_event_ids`` 一样：它只被
        "打开这条记忆看它和谁冲突"这一个动作读，不需要反向查询。对称维护——两边
        都要指向对方，否则从任意一侧打开都可能看不到分歧。
        """
        self._safe_add_column("memory", "memory_entries",
                              "conflict_set", "TEXT DEFAULT '[]'")
        c = self._dbs["memory"]
        c.execute("UPDATE memory_entries SET conflict_set='[]'"
                  " WHERE COALESCE(conflict_set,'')=''")
        c.commit()

    def _mig_0016_memory_supersedes(self) -> None:
        """一条待批的合并现在能说出"我要替掉哪几条"。

        §10.2 要求 Dream 只产出提案、不直接改长期记忆。在这一列之前，梦境整合是
        直接 ``archive_memory(merge_id)`` 的：一个后台 LLM 判断把用户的记忆归档掉，
        没有记录、没有理由、也没人批准过。用户唯一能发现的方式是某天发现记忆不见了。

        ``superseded_by`` 是已经发生的替换（单向、指向替代者），这一列是它的反向：
        **如果**这条候选被批准，这些行才会被归档。批准前两边都原样活着。
        """
        self._safe_add_column("memory", "memory_entries",
                              "supersedes", "TEXT DEFAULT '[]'")
        c = self._dbs["memory"]
        c.execute("UPDATE memory_entries SET supersedes='[]'"
                  " WHERE COALESCE(supersedes,'')=''")
        c.commit()

    def _mig_0017_dream_runs(self) -> None:
        """§10.3：Dream 从"一个没人看得见的后台协程"变成一个有账本的 job。

        这张表同时是四样东西：
        * **租约**：``owner`` + ``lease_until``。两个窗口各跑一个 MemoryLayer 时，
          原来会对同一个 workspace 同时整合，各自提一份指向同几行的合并提案。
        * **心跳**：``heartbeat_at``。判活看的是心跳而不是总时长，所以一趟跑了很久
          的健康 job 不会被误判成死的，而崩溃进程的租约几秒内就过期。
        * **幂等键**：``idem_key`` 上的唯一索引。同一批输入不会产出第二份提案；
          崩溃后重来是按键**继续**（接管同一个 job_id），不是从头再做一遍。
        * **日记**（§10.2 的 DreamJournal）：``outcome`` 记下这一趟做了什么、
          合并了什么、为什么 NO_OP。没有它，"梦境整理"对用户就只是个说法。

        唯一索引带 WHERE：空键（历史行 / 不参与幂等的手动触发）不该互相排斥。
        """
        c = self._dbs["memory"]
        c.execute("""CREATE TABLE IF NOT EXISTS dream_runs (
            job_id TEXT PRIMARY KEY,
            root_dir TEXT NOT NULL DEFAULT '',
            idem_key TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'running',
            owner TEXT NOT NULL DEFAULT '',
            started_at INTEGER NOT NULL DEFAULT 0,
            heartbeat_at INTEGER NOT NULL DEFAULT 0,
            lease_until INTEGER NOT NULL DEFAULT 0,
            finished_at INTEGER NOT NULL DEFAULT 0,
            outcome TEXT NOT NULL DEFAULT '',
            proposal_id TEXT NOT NULL DEFAULT '',
            input_count INTEGER NOT NULL DEFAULT 0,
            tokens_used INTEGER NOT NULL DEFAULT 0,
            wall_ms INTEGER NOT NULL DEFAULT 0
        )""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_dream_root"
                  " ON dream_runs(root_dir, started_at DESC)")
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_dream_idem"
                  " ON dream_runs(idem_key) WHERE idem_key<>''")
        c.commit()

    def _mig_0018_learning_items_and_episodes(self) -> None:
        """§13.4/13.5/16.1：Episode 与 LearningItem 一等账本。

        * episodes：Session 内的多主题片段账本。
        * learning_items：细粒度学习产物账本（Memory/Skill/Guard/Strategy等，0..N一对多）。
        """
        cs = self._dbs["sessions"]
        cs.execute("""CREATE TABLE IF NOT EXISTS episodes (
            episode_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            branch_id TEXT NOT NULL DEFAULT '',
            topic TEXT NOT NULL DEFAULT '',
            goal_id TEXT NOT NULL DEFAULT '',
            turn_ids TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'active',
            started_at REAL NOT NULL DEFAULT 0,
            sealed_at REAL NOT NULL DEFAULT 0,
            metadata TEXT NOT NULL DEFAULT '{}'
        )""")
        cs.execute("CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id, started_at DESC)")
        cs.execute("CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status, session_id)")
        cs.commit()

        cm = self._dbs["memory"]
        cm.execute("""CREATE TABLE IF NOT EXISTS learning_items (
            learning_item_id TEXT PRIMARY KEY,
            bundle_id TEXT NOT NULL DEFAULT '',
            episode_id TEXT NOT NULL DEFAULT '',
            session_id TEXT NOT NULL DEFAULT '',
            branch_id TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL DEFAULT 'memory_fact',
            scope TEXT NOT NULL DEFAULT 'session',
            content TEXT NOT NULL DEFAULT '',
            preconditions TEXT NOT NULL DEFAULT '',
            applicability TEXT NOT NULL DEFAULT '',
            source_event_ids TEXT NOT NULL DEFAULT '[]',
            source_session_id TEXT NOT NULL DEFAULT '',
            source_goal_id TEXT NOT NULL DEFAULT '',
            source_run_id TEXT NOT NULL DEFAULT '',
            source_turn_id TEXT NOT NULL DEFAULT '',
            confidence REAL NOT NULL DEFAULT 1.0,
            evidence_strength REAL NOT NULL DEFAULT 1.0,
            priority INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'discovered',
            notification_policy TEXT NOT NULL DEFAULT 'receipt',
            why TEXT NOT NULL DEFAULT '',
            evidence_summary TEXT NOT NULL DEFAULT '',
            future_effect TEXT NOT NULL DEFAULT '',
            target_ref TEXT NOT NULL DEFAULT '',
            deferred_reason TEXT NOT NULL DEFAULT '',
            user_verdict TEXT NOT NULL DEFAULT 'pending',
            created_at REAL NOT NULL DEFAULT 0,
            updated_at REAL NOT NULL DEFAULT 0
        )""")
        cm.execute("CREATE INDEX IF NOT EXISTS idx_li_session ON learning_items(session_id, created_at DESC)")
        cm.execute("CREATE INDEX IF NOT EXISTS idx_li_episode ON learning_items(episode_id, created_at DESC)")
        cm.execute("CREATE INDEX IF NOT EXISTS idx_li_bundle ON learning_items(bundle_id)")
        cm.execute("CREATE INDEX IF NOT EXISTS idx_li_status ON learning_items(status, session_id)")
        cm.commit()

    def _mig_0019_episode_learning_item_provenance_and_indexes(self) -> None:
        """§13.4/13.5/16.1：Episode 与 LearningItem 来源索引与幂等支持。

        * episodes: 增加 last_activity_at, sealed_by_event_id, seal_reason, generation。
        * learning_items: 增加 idempotency_key, operation_id, version。
        """
        self._safe_add_column("sessions", "episodes", "last_activity_at", "REAL DEFAULT 0")
        self._safe_add_column("sessions", "episodes", "sealed_by_event_id", "TEXT DEFAULT ''")
        self._safe_add_column("sessions", "episodes", "seal_reason", "TEXT DEFAULT ''")
        self._safe_add_column("sessions", "episodes", "generation", "INTEGER DEFAULT 1")
        cs = self._dbs["sessions"]
        cs.execute("CREATE INDEX IF NOT EXISTS idx_episodes_active ON episodes(session_id, branch_id, status)")
        cs.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_active_unique ON episodes(session_id, branch_id) WHERE status='active'")
        cs.commit()

        self._safe_add_column("memory", "learning_items", "idempotency_key", "TEXT DEFAULT ''")
        self._safe_add_column("memory", "learning_items", "operation_id", "TEXT DEFAULT ''")
        self._safe_add_column("memory", "learning_items", "version", "INTEGER DEFAULT 1")
        cm = self._dbs["memory"]
        cm.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_li_idem ON learning_items(idempotency_key) WHERE idempotency_key <> ''")
        cm.commit()

    def _mig_0020_learning_item_operations(self) -> None:
        """P1-2: Persistent LearningItem mutation operation ledger with strict unique idempotency constraint."""
        cm = self._dbs["memory"]
        cm.execute("""CREATE TABLE IF NOT EXISTS learning_item_operations (
            operation_id TEXT PRIMARY KEY,
            item_id TEXT NOT NULL,
            action TEXT NOT NULL,
            idempotency_key TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            result TEXT NOT NULL DEFAULT '{}',
            error TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL DEFAULT 0,
            updated_at REAL NOT NULL DEFAULT 0
        )""")
        cm.execute("CREATE INDEX IF NOT EXISTS idx_li_ops_item ON learning_item_operations(item_id, created_at DESC)")
        cm.execute("DROP INDEX IF EXISTS idx_li_ops_idem")
        cm.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_li_ops_idem ON learning_item_operations(idempotency_key) WHERE idempotency_key <> ''")
        cm.commit()

    def _mig_0008_cron_lease_and_team(self) -> None:
        """§14 后台任务账本语义 + §13 TaskLease（Phase 7/10）。

        * cron_jobs.running_since：执行租约。崩溃后 boot 扫描凭它区分
          「未开始 / 执行中被打断」，不再让账本对着一个说不清的 next_run_at 沉默。
        * cron_jobs.last_error：上次失败原因，UI 直接可读。
        * team_leases：子代理任务原子租约表（team.py 也做了防御式建表）。
        """
        self._safe_add_column(
            "cron", "cron_jobs", "running_since",
            "INTEGER DEFAULT 0",
        )
        self._safe_add_column(
            "cron", "cron_jobs", "last_error",
            "TEXT DEFAULT ''",
        )
        c = self._dbs["sessions"]
        c.execute(
            "CREATE TABLE IF NOT EXISTS team_leases ("
            "task_id TEXT PRIMARY KEY,"
            " owner TEXT NOT NULL,"
            " acquired_at INTEGER NOT NULL,"
            " expires_at INTEGER NOT NULL)"
        )

    # Relative spellings of "the folder the app was launched in". Empty string is
    # deliberately NOT here: "" means "user never chose a folder", which is a
    # different fact from "user chose the current folder" and is displayed
    # differently. Rewriting "" would silently bind every legacy conversation to
    # whatever directory happens to be CWD on this machine.
    _RELATIVE_WORKSPACES = ("." , "./", ".\\")

    def _normalize_workspace_paths(self) -> None:
        """Rewrite relative workspace strings to absolute paths, in place.

        Idempotent: after the first pass nothing matches, so re-running on every
        boot costs one indexed scan and no writes. Failures are swallowed —
        a cosmetic path fix must never stop the app from starting.
        """
        try:
            here = os.path.abspath(os.getcwd())
        except Exception:
            return
        s = self._dbs.get("sessions")
        if s is None:
            return
        try:
            for stale in self._RELATIVE_WORKSPACES:
                s.execute(
                    "UPDATE sessions SET workspace=? WHERE workspace=?", (here, stale)
                )
                # The workspaces table keys on `path`, so a plain UPDATE would hit
                # a PRIMARY KEY collision when the absolute row already exists.
                # Move the metadata only if the destination is free, then drop the
                # stale row either way — an orphan alias is worse than losing a
                # pin flag on a row the user could not address anyway.
                row = s.execute(
                    "SELECT 1 FROM workspaces WHERE path=?", (here,)
                ).fetchone()
                if row is None:
                    s.execute(
                        "UPDATE workspaces SET path=? WHERE path=?", (here, stale)
                    )
                else:
                    s.execute("DELETE FROM workspaces WHERE path=?", (stale,))
            # `active_workspace` lives in the configs db and is read at boot to
            # decide which folder to open — leave it stale and the very next
            # startup writes "." back into fresh rows.
            c = self._dbs.get("configs")
            if c is not None:
                cur = c.execute(
                    "SELECT value FROM configs WHERE key='active_workspace'"
                ).fetchone()
                if cur and (cur[0] or "") in self._RELATIVE_WORKSPACES:
                    c.execute(
                        "UPDATE configs SET value=? WHERE key='active_workspace'",
                        (here,),
                    )
                    c.commit()
            s.commit()
        except Exception as exc:  # noqa: BLE001
            print(f"[storage] workspace path normalization skipped: {exc}")

    def _own_source_dirs(self) -> tuple:
        """System directories, which are never a user-chosen workspace.

        Electron spawns the backend with ``cwd`` = the folder holding the entry
        script, i.e. ``<repo>/app``; running the module directly gives
        ``<repo>/app/backend``. Those are the only two values the cwd fallback
        can produce, and neither is a project a user would open.
        """
        try:
            backend = os.path.abspath(os.path.dirname(os.path.abspath(__file__)))
        except Exception:
            return ()
        return (backend, os.path.abspath(os.path.join(backend, "..")))

    def _unbind_own_dirs(self) -> None:
        """Detach rows that were bound to system's own launch directory.

        Sessions used to be stamped with ``router.workspace`` — the cwd fallback
        — so every conversation started before a folder was picked got filed
        under a workspace named "app". Clearing the column moves them into the
        default bucket, which is where "the user never chose a folder" belongs.

        Deliberately narrow: only the two paths in ``_own_source_dirs`` are
        touched, and only ever set to ``''``. Nothing is deleted, so if someone
        really was working inside ``app/`` they just re-open the folder. Runs
        AFTER ``_normalize_workspace_paths`` on purpose — that pass rewrites "."
        into the cwd and would otherwise re-create exactly this binding.
        """
        own = self._own_source_dirs()
        if not own:
            return
        s = self._dbs.get("sessions")
        if s is None:
            return
        try:
            for path in own:
                cur = s.execute(
                    "UPDATE sessions SET workspace='' WHERE workspace=?", (path,)
                )
                if cur.rowcount:
                    print(f"[storage] unbound {cur.rowcount} session(s) from {path}")
                s.execute("DELETE FROM workspaces WHERE path=?", (path,))
            c = self._dbs.get("configs")
            if c is not None:
                cur = c.execute(
                    "SELECT value FROM configs WHERE key='active_workspace'"
                ).fetchone()
                if cur and os.path.abspath(cur[0] or "-") in own:
                    c.execute(
                        "UPDATE configs SET value='' WHERE key='active_workspace'"
                    )
                    c.commit()
            s.commit()
        except Exception as exc:  # noqa: BLE001
            print(f"[storage] own-dir unbind skipped: {exc}")



    def set_config(self, key, value):
        c = self._db("configs")
        v = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
        c.execute("INSERT OR REPLACE INTO configs VALUES (?,?,?)", (key, v, int(time.time())))
        c.commit()

    def get_config(self, key, default=None):
        r = self._db("configs").execute("SELECT value FROM configs WHERE key=?", (key,)).fetchone()
        if not r: return default
        try: return json.loads(r["value"])
        except: return r["value"]

    def kv_set(self, key, value, ns="default"):
        c = self._db("kv")
        v = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
        c.execute("INSERT OR REPLACE INTO kv_store VALUES (?,?,?,?)", (key, v, ns, int(time.time())))
        c.commit()

    def kv_get(self, key, ns="default", default=None):
        r = self._db("kv").execute("SELECT value FROM kv_store WHERE key=? AND namespace=?", (key, ns)).fetchone()
        if not r: return default
        try: return json.loads(r["value"])
        except: return r["value"]

    def create_session(self, sid, title="", parent_id=None, branch_point=None, workspace=""):
        c = self._db("sessions"); now = int(time.time())
        c.execute("INSERT OR IGNORE INTO sessions (id,title,created_at,updated_at,parent_id,branch_point,workspace) VALUES (?,?,?,?,?,?,?)", (sid, title, now, now, parent_id, branch_point, workspace or ""))
        c.commit()
        try:
            self._trace.append(
                session_id=sid,
                event_type=EventType.SESSION_CREATED,
                payload={"title": title, "parent_id": parent_id, "branch_point": branch_point, "workspace": workspace or ""},
                importance="critical",
                # INSERT OR IGNORE above makes a repeated create a no-op for
                # the sessions table; this key makes it a no-op for the ledger
                # too, so a retry can never append a second SESSION_CREATED.
                idempotency_key=f"session:create:{sid}",
                actor="system",
            )
            self._session_logger.init_session(sid, title=title, workspace=workspace or "")
            # 审计轨的父子关联在会话创建时登记——子会话后续每条流水都带 parent_ref。
            self._session_audit.note_parent(sid, str(parent_id or ""))
        except Exception as exc:
            _audit_write_failed("create_session", exc)
        return Result.success(sid)

    def branch(self, parent_id, branch_point, new_sid, title=""):
        """Fork a session at ``branch_point``: a NEW session holding a copy of the
        parent's history up to and including that seq.
        """
        c = self._db("sessions"); now = int(time.time())
        parent = c.execute("SELECT workspace FROM sessions WHERE id=?", (parent_id,)).fetchone()
        workspace = (parent["workspace"] if parent else "") or ""
        c.execute("INSERT INTO sessions (id,title,created_at,updated_at,parent_id,branch_point,workspace) VALUES (?,?,?,?,?,?,?)", (new_sid, title or f"Branch of {parent_id}", now, now, parent_id, branch_point, workspace))
        for m in c.execute("SELECT * FROM session_messages WHERE session_id=? AND seq<=? ORDER BY seq", (parent_id, int(branch_point))).fetchall():
            c.execute("INSERT INTO session_messages VALUES (?,?,?,?,?,?,?,?)", (f"{new_sid}_{m['seq']}", new_sid, m["role"], m["content"], m["msg_type"], m["metadata"], m["created_at"], m["seq"]))
        c.commit()
        try:
            self._trace.append(
                session_id=new_sid,
                event_type=EventType.SESSION_FORKED,
                payload={"parent_id": parent_id, "branch_point": branch_point, "title": title or f"Branch of {parent_id}", "workspace": workspace},
                importance="critical",
                idempotency_key=f"session:fork:{new_sid}",
                actor="system",
            )
            self._session_logger.init_session(new_sid, title=title or f"Branch of {parent_id}", workspace=workspace or "")
        except Exception as exc:
            _audit_write_failed("branch", exc)
        return Result.success(new_sid)

    def add_message(self, sid, role, content, msg_type="message", metadata=None):
        c = self._db("sessions"); now = int(time.time()); mid = str(uuid.uuid4())
        seq = c.execute("SELECT COUNT(*) as x FROM session_messages WHERE session_id=?", (sid,)).fetchone()["x"]
        c.execute("INSERT INTO session_messages VALUES (?,?,?,?,?,?,?,?)", (mid, sid, role, content, msg_type, json.dumps(metadata or {}, ensure_ascii=False), now, seq))
        c.execute("UPDATE sessions SET updated_at=? WHERE id=?", (now, sid)); c.commit()
        self._session_fts_upsert(sid, mid, content)
        meta = metadata or {}
        try:
            etype = (
                EventType.USER_MESSAGE_SUBMITTED
                if role == "user"
                else (
                    EventType.LLM_RESPONSE_COMPLETED
                    if role == "assistant"
                    else EventType.SYSTEM_CHECKPOINT_CREATED
                )
            )
            self._trace.append(
                session_id=sid,
                event_type=etype,
                payload={"message_id": mid, "role": role, "content": content, "msg_type": msg_type, "metadata": meta},
                importance="critical",
                # The message row id is the natural identity of this fact: a
                # replayed/retried append lands once no matter how often the
                # caller retries.
                idempotency_key=f"msg:{mid}",
                actor="user" if role == "user" else "assistant",
                turn_id=(meta.get("turnId") if isinstance(meta, dict) else None),
            )
        except Exception as exc:
            _audit_write_failed("add_message", exc)

        try:
            if role == "user":
                self._session_logger.log_user_input(sid, content, images=meta.get("images"), metadata=meta)
            elif role == "assistant":
                for r in meta.get("reasoning", []):
                    r_text = r.get("text") if isinstance(r, dict) else str(r)
                    if r_text:
                        dur = r.get("durationMs", 0) if isinstance(r, dict) else 0
                        self._session_logger.log_thinking(sid, r_text, duration_ms=dur)
                for tc in meta.get("toolCalls", []):
                    if isinstance(tc, dict):
                        self._session_logger.log_tool_call(
                            sid,
                            tool_name=tc.get("toolName", "unknown"),
                            call_id=tc.get("id", ""),
                            args=tc.get("args", {}),
                            cwd=tc.get("cwd", ""),
                            risk_level=tc.get("riskLevel", "low"),
                        )
                        self._session_logger.log_tool_result(
                            sid,
                            tool_name=tc.get("toolName", "unknown"),
                            call_id=tc.get("id", ""),
                            status=tc.get("status", "completed"),
                            exit_code=tc.get("exitCode", 0),
                            output=tc.get("output", ""),
                            result=tc.get("result"),
                        )
                self._session_logger.log_assistant_response(sid, content, images=meta.get("images"), metadata=meta)
        except Exception as exc:
            _audit_write_failed("session_logger transcript", exc)

        # P1-3 jsonl 审计轨（；与上面
        # 三轨并行）：user 消息=发往模型的 request，assistant 消息=模型
        # response。record 自身 fail-open，此处兜底防 tracker 对象本身异常
        # ——审计永不阻塞会话。
        try:
            _turn_id = str(meta.get("turnId") or "") if isinstance(meta, dict) else ""
            if role == "user":
                self._session_audit.record(sid, "request", turn_id=_turn_id,
                                           payload={"content": content, "msg_type": msg_type,
                                                    "metadata": meta})
            elif role == "assistant":
                self._session_audit.record(sid, "response", turn_id=_turn_id,
                                           model=str(meta.get("model") or "") if isinstance(meta, dict) else "",
                                           tokens=meta.get("tokens") if isinstance(meta, dict) else None,
                                           payload={"content": content, "msg_type": msg_type,
                                                    "metadata": meta})
        except Exception as exc:
            _audit_write_failed("session_audit", exc)

        return Result.success(mid)

    def get_event_store(self) -> EventStore:
        return self._event_store

    def get_events(self, sid: str, from_seq: int = 0, to_seq: Optional[int] = None, limit: Optional[int] = None):
        return self._event_store.read_stream(sid, from_seq=from_seq, to_seq=to_seq, limit=limit)

    def verify_event_chain(self, sid: str):
        return self._event_store.verify_chain(sid)

    def project_session_state(self, sid: str, at_seq: Optional[int] = None):
        return self._projection_engine.project_session(sid, at_seq=at_seq)

    def fork_at_seq(self, source_sid: str, fork_seq: int, new_sid: str, title: Optional[str] = None):
        return self._projection_engine.fork_at_seq(source_sid, fork_seq, new_sid, title=title)

    def get_session_log(self, sid: str) -> str:
        return self._session_logger.read_log_text(sid)

    def get_session_transcript(self, sid: str) -> list[dict]:
        return self._session_logger.read_transcript(sid)

    def get_session_log_info(self, sid: str) -> dict:
        return self._session_logger.get_log_info(sid)

    def get_messages(self, sid, limit=100, offset=0):
        """Oldest-first page of a session's messages.

        ``ORDER BY seq`` is ascending, so ``limit`` here means "the FIRST N rows",
        i.e. the start of the conversation. That is what a transcript view wants;
        it is emphatically not what prompt assembly wants — use
        ``get_recent_messages`` for that.
        """
        return [dict(x) for x in self._db("sessions").execute("SELECT * FROM session_messages WHERE session_id=? ORDER BY seq LIMIT ? OFFSET ?", (sid, limit, offset)).fetchall()]

    def get_recent_messages(self, sid, limit=20):
        """The NEWEST ``limit`` messages, still returned oldest-first.

        Prompt assembly needs the tail of the conversation, not its head. Getting
        that from ``get_messages`` is impossible without knowing the total count
        first, and the obvious-looking ``get_messages(sid, limit=20)`` silently
        returns the twenty oldest rows instead — which freezes the model's view
        of the conversation at whatever was said at the very beginning.

        So: select descending to take the tail, then reverse so callers still get
        chronological order (the model needs turns in the order they happened).
        """
        n = max(1, int(limit or 1))
        rows = self._db("sessions").execute(
            "SELECT * FROM session_messages WHERE session_id=? ORDER BY seq DESC LIMIT ?",
            (sid, n),
        ).fetchall()
        return [dict(x) for x in reversed(rows)]

    def count_messages(self, sid) -> int:
        """Total rows for a session. Used where a watermark is compared against
        the real length of the history rather than a truncated page of it."""
        r = self._db("sessions").execute(
            "SELECT COUNT(*) as x FROM session_messages WHERE session_id=?", (sid,)
        ).fetchone()
        return int(r["x"] or 0) if r else 0

    def seq_of_last_message(self, sid):
        """Highest seq in the session, or -1 when empty."""
        r = self._db("sessions").execute(
            "SELECT MAX(seq) as x FROM session_messages WHERE session_id=?", (sid,)
        ).fetchone()
        return -1 if not r or r["x"] is None else int(r["x"])

    def list_user_turns(self, sid, preview_chars=120):
        """Every user turn as ``{ordinal, seq, preview, created_at}``, oldest first.

        The timeline axis (UB1) needs both handles at once: `seq` is what the
        snapshot store keys checkpoints by, `ordinal` is what `session_truncate`
        is addressed by. Deriving one from the other on the frontend would mean
        re-implementing "which bubble is the Nth user message" in a second place,
        and the two would drift the first time a system message slips in.

        `preview` is truncated here rather than client-side so a session full of
        pasted files doesn't ship its entire history just to label some dots.
        """
        rows = self._db("sessions").execute(
            "SELECT seq, content, created_at FROM session_messages "
            "WHERE session_id=? AND role='user' ORDER BY seq", (sid,)
        ).fetchall()
        out = []
        for i, r in enumerate(rows):
            text = str(r["content"] or "").strip()
            cut = int(preview_chars)
            out.append({
                "ordinal": i,
                "seq": int(r["seq"]),
                "preview": text[:cut] + ("…" if len(text) > cut else ""),
                "created_at": r["created_at"],
            })
        return out

    def seq_of_nth_user_message(self, sid, ordinal):
        """seq of the ``ordinal``-th (0-based) user message, or None if out of range.

        The frontend timeline has no server-side ids, but user turns are a stable
        shared ordinal between the two: the Nth bubble the user typed is the Nth
        role='user' row here. That is the handle truncation is addressed by.
        """
        rows = self._db("sessions").execute(
            "SELECT seq FROM session_messages WHERE session_id=? AND role='user' ORDER BY seq", (sid,)
        ).fetchall()
        ordinal = int(ordinal)
        if ordinal < 0 or ordinal >= len(rows):
            return None
        return rows[ordinal]["seq"]

    def truncate_after_seq(self, sid, seq):
        """Delete every message at or after ``seq``. Returns the deleted count.

        Used when the user pulls a message back for editing: the withdrawn turn
        and everything the agent said in reply to it must leave the *server's*
        history too, or the next turn silently replays a conversation the user
        thinks they erased.
        """
        c = self._db("sessions")
        n = c.execute("SELECT COUNT(*) as x FROM session_messages WHERE session_id=? AND seq>=?",
                      (sid, int(seq))).fetchone()["x"]
        c.execute("DELETE FROM session_messages WHERE session_id=? AND seq>=?", (sid, int(seq)))
        c.execute("UPDATE sessions SET updated_at=? WHERE id=?", (int(time.time()), sid))
        c.commit()
        return Result.success(n)

    def list_sessions(self, limit=200, workspace=None):
        """Sessions for the sidebar history list, newest activity first.

        Pinned sessions float to the top (that is the whole point of pinning),
        then everything else by last activity. `message_count` comes from a
        correlated subquery rather than a Python loop — one query instead of N.

        Empty sessions are filtered OUT: every server boot creates a session,
        so without this the list would fill with untouched placeholders the user
        never actually talked in.

        When `workspace` is provided, only returns sessions for that folder.
        When None, returns ALL sessions (for grouping in the UI).
        """
        if workspace is not None:
            rows = self._db("sessions").execute("""
                SELECT s.id, s.title, s.created_at, s.updated_at, s.pinned, s.workspace,
                       s.parent_id, CAST(s.branch_point AS INTEGER) AS branch_point,
                       (SELECT COUNT(*) FROM session_messages m WHERE m.session_id = s.id) AS message_count
                FROM sessions s
                WHERE s.workspace = ? AND s.id NOT LIKE 'bench-%' AND s.id NOT LIKE 'tool-test-%'
                ORDER BY s.pinned DESC, s.updated_at DESC
                LIMIT ?
            """, (workspace, int(limit))).fetchall()
        else:
            rows = self._db("sessions").execute("""
                SELECT s.id, s.title, s.created_at, s.updated_at, s.pinned, s.workspace,
                       s.parent_id, s.branch_point,
                       (SELECT COUNT(*) FROM session_messages m WHERE m.session_id = s.id) AS message_count
                FROM sessions s
                WHERE s.id NOT LIKE 'bench-%' AND s.id NOT LIKE 'tool-test-%'
                ORDER BY s.pinned DESC, s.updated_at DESC
                LIMIT ?
            """, (int(limit),)).fetchall()
        return [dict(r) for r in rows if (r["message_count"] or 0) > 0]

    def list_workspaces(self, always_include: str = ""):
        """Workspace folders to show in the sidebar, merged from three sources.

        A workspace is worth listing if ANY of these hold:
          1. it has a real conversation (derived from sessions);
          2. it has an explicit row in the `workspaces` table (a folder the user
             opened but hasn't chatted in yet, or renamed/pinned);
          3. it is `always_include` — the folder the backend is CURRENTLY bound
             to. Without this the very first launch showed an empty workspace
             list even though the agent was demonstrably working inside the
             project directory, which reads as "no workspace exists" when the
             truth is "one exists and it's the one you're standing in".

        Hidden workspaces are dropped unless they still hold sessions — hiding
        is "remove from the list", not "delete the history".

        Returns [{path, session_count, last_used, display_name, pinned}] with
        pinned rows first, then most-recent.
        """
        def _is_bench_ws(p: str) -> bool:
            if not p:
                return False
            norm = p.replace("\\", "/").rstrip("/")
            base = os.path.basename(norm).lower()
            return base.startswith("task_") or "/task_" in norm or "eval_harness" in norm or "bench-" in base

        # Session-derived counts + recency.
        sess_rows = self._db("sessions").execute("""
            SELECT COALESCE(s.workspace, '') AS path,
                   COUNT(DISTINCT s.id) AS session_count,
                   MAX(s.updated_at) AS last_used
            FROM sessions s
            WHERE s.id NOT LIKE 'bench-%' AND s.id NOT LIKE 'tool-test-%'
              AND (SELECT COUNT(*) FROM session_messages m
                   WHERE m.session_id = s.id AND m.role='user'
                   AND TRIM(COALESCE(m.content,'')) != '') > 0
            GROUP BY path
        """).fetchall()
        by_path: dict[str, dict] = {}
        for r in sess_rows:
            d = dict(r)
            if _is_bench_ws(d["path"]):
                continue
            by_path[d["path"]] = {
                "path": d["path"],
                "session_count": d["session_count"] or 0,
                "last_used": d["last_used"] or 0,
                "display_name": "",
                "pinned": 0,
                "hidden": 0,
            }
        # Overlay the explicit workspace rows.
        for r in self._db("sessions").execute("SELECT * FROM workspaces").fetchall():
            w = dict(r)
            path = w["path"]
            if _is_bench_ws(path):
                continue
            entry = by_path.get(path)
            if entry is None:
                entry = {
                    "path": path, "session_count": 0, "last_used": 0,
                    "display_name": "", "pinned": 0, "hidden": 0,
                }
                by_path[path] = entry
            entry["display_name"] = w.get("display_name") or ""
            entry["pinned"] = w.get("pinned") or 0
            entry["hidden"] = w.get("hidden") or 0
            # last_opened_at can be newer than any session (opened, not chatted).
            entry["last_used"] = max(entry["last_used"], w.get("last_opened_at") or 0)

        # The currently-bound folder always makes the list, even with zero
        # sessions and no explicit row — it IS where the next session lands.
        if always_include and always_include not in by_path:
            by_path[always_include] = {
                "path": always_include, "session_count": 0, "last_used": int(time.time()),
                "display_name": "", "pinned": 0, "hidden": 0,
            }

        # Hidden folders drop out unless they still have real sessions.
        result = [
            e for e in by_path.values()
            if not (e["hidden"] and e["session_count"] == 0)
        ]
        # Pinned first, then most-recent. Default workspace ('') sinks unless pinned.
        result.sort(key=lambda e: (
            -int(e["pinned"]),
            0 if e["path"] else 1,
            -int(e["last_used"]),
        ))
        return result

    def upsert_workspace(self, path, *, touch_opened=False, **fields):
        """Create the workspace row if absent, then patch the given fields.

        ``touch_opened`` stamps last_opened_at=now so a plain folder switch
        registers even with no conversation. Unknown fields are ignored rather
        than interpolated into SQL.
        """
        if not path:
            return  # the default workspace has no row; its state is implicit
        now = int(time.time())
        c = self._db("sessions")
        exists = c.execute("SELECT path FROM workspaces WHERE path=?", (path,)).fetchone()
        if not exists:
            c.execute(
                "INSERT INTO workspaces (path, created_at, last_opened_at) VALUES (?,?,?)",
                (path, now, now if touch_opened else 0),
            )
        allowed = {"display_name", "pinned", "hidden", "settings_json", "last_opened_at"}
        patch = {k: v for k, v in fields.items() if k in allowed}
        if touch_opened:
            patch["last_opened_at"] = now
        if patch:
            sets = ",".join(f"{k}=?" for k in patch)
            c.execute(f"UPDATE workspaces SET {sets} WHERE path=?", list(patch.values()) + [path])
        c.commit()

    def rename_workspace(self, path, display_name):
        """Give a workspace a custom label. Empty string reverts to path tail."""
        self.upsert_workspace(path, display_name=(display_name or "").strip())

    def set_workspace_pinned(self, path, pinned):
        self.upsert_workspace(path, pinned=1 if pinned else 0)

    def set_workspace_hidden(self, path, hidden):
        self.upsert_workspace(path, hidden=1 if hidden else 0)

    def get_workspace_settings(self, path):
        """Per-workspace settings dict (model/mode/etc). {} when none stored."""
        if not path:
            return {}
        r = self._db("sessions").execute(
            "SELECT settings_json FROM workspaces WHERE path=?", (path,)
        ).fetchone()
        if not r or not r["settings_json"]:
            return {}
        try:
            return json.loads(r["settings_json"])
        except (json.JSONDecodeError, TypeError):
            return {}

    def set_workspace_settings(self, path, settings):
        """Merge a partial settings dict into the workspace's stored settings."""
        if not path:
            return
        current = self.get_workspace_settings(path)
        current.update(settings or {})
        self.upsert_workspace(path, settings_json=json.dumps(current, ensure_ascii=False))
        return current


    def get_session(self, sid):
        r = self._db("sessions").execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
        return dict(r) if r else None

    def delete_session(self, sid):
        """Drop a session and every message in it. Cascade is manual because the
        two tables have no FK relationship declared."""
        c = self._db("sessions")
        c.execute("DELETE FROM session_messages WHERE session_id=?", (sid,))
        c.execute("DELETE FROM sessions WHERE id=?", (sid,))
        # Ledger rows belonging to this parent go too — a run whose conversation
        # no longer exists is unreachable in the UI and would only skew counts.
        # Matching on parent_session_id (not child_session_id) is deliberate:
        # sub-agent teardown calls this with the CHILD id, and those rows must
        # survive, which is the entire reason the ledger is a separate table.
        c.execute("DELETE FROM subagent_runs WHERE parent_session_id=?", (sid,))
        c.commit()
        return Result.success(sid)

    # ── Sub-agent ledger ────────────────────────────────────────────────────

    def upsert_subagent_run(self, subagent_id: str, **fields) -> None:
        """Record or update one sub-agent run. Called from every state change.

        Stamps the CURRENT ``PROCESS_GENERATION`` on every write, including
        updates: a row must always name the process that last touched it,
        otherwise a run that started before a restart and somehow reported after
        it would keep a dead generation and get reaped out from under itself.

        Unknown keys are ignored rather than raising — this is on the hot path of
        a turn, and a schema drift must not take down the agent loop.
        """
        if not subagent_id:
            return
        cols = ("parent_session_id", "child_session_id", "subagent_type", "label",
                "status", "created_at", "started_at", "finished_at",
                "result_chars", "error")
        data = {k: v for k, v in fields.items() if k in cols}
        c = self._db("sessions")
        # INSERT-or-UPDATE in one statement so two rapid transitions can't race
        # into a duplicate-key error. Only the supplied columns are overwritten;
        # created_at in particular must not be reset by a later transition.
        assign = ", ".join(f"{k}=excluded.{k}" for k in data)
        sql = (
            "INSERT INTO subagent_runs (subagent_id, generation"
            + "".join(f", {k}" for k in data)
            + ") VALUES (?, ?" + ", ?" * len(data) + ") "
            "ON CONFLICT(subagent_id) DO UPDATE SET generation=excluded.generation"
            + (", " + assign if assign else "")
        )
        c.execute(sql, (subagent_id, PROCESS_GENERATION, *data.values()))
        c.commit()

    def list_subagent_runs(self, parent_session_id: str = "", limit: int = 50) -> list:
        """Ledger rows, newest first. Empty ``parent_session_id`` means all."""
        c = self._db("sessions")
        n = max(1, min(500, int(limit or 50)))
        if parent_session_id:
            rows = c.execute(
                "SELECT * FROM subagent_runs WHERE parent_session_id=?"
                " ORDER BY created_at DESC LIMIT ?", (parent_session_id, n),
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT * FROM subagent_runs ORDER BY created_at DESC LIMIT ?", (n,),
            ).fetchall()
        return [dict(r) for r in rows]

    def reap_orphan_subagent_runs(self) -> list:
        """Close out runs left non-terminal by a process that is gone.

        A row is an orphan iff its status is non-terminal AND its generation is
        not ours. Restricting to a different generation is what makes this safe
        to call while sub-agents from THIS process are running — without that
        clause a boot-time reap would kill live work in a second window.

        Returns the demoted ROWS (callers print ``len()``). ``killed`` is the
        honest status: the run did not complete, and nobody can say whether its
        side effects landed — Phase 2 also mirrors each row into the event
        ledger as SUBAGENT_FAILED (see recovery.record_reaped_subagents).
        """
        c = self._db("sessions")
        placeholders = ",".join("?" * len(SUBAGENT_TERMINAL_STATUSES))
        rows = c.execute(
            "SELECT * FROM subagent_runs"
            f" WHERE generation IS NOT ? AND status NOT IN ({placeholders})",
            (PROCESS_GENERATION, *sorted(SUBAGENT_TERMINAL_STATUSES)),
        ).fetchall()
        demoted = [dict(r) for r in rows]
        if demoted:
            ids = [r["subagent_id"] for r in demoted]
            c.execute(
                "UPDATE subagent_runs SET status='killed', finished_at=?,"
                " error=CASE WHEN error='' OR error IS NULL"
                "   THEN 'Interrupted by server restart' ELSE error END"
                f" WHERE subagent_id IN ({','.join('?' * len(ids))})",
                (time.time(), *ids),
            )
            c.commit()
        return demoted

    # ── side-effect ledger (Phase 2) ─────────────────────────────────────

    def record_side_effect(self, session_id: str, goal_id: str, call_id: str,
                           tool_name: str, args_hash: str,
                           effect_kind: str = "", target: str = "",
                           operation_id: str = "", pre_hash: str = "",
                           planned_hash: str = "") -> None:
        """Register a write-class tool call as PENDING before it dispatches.

        Idempotent on ``call_id``: recording the same call twice (a replayed
        batch, a retried hook) leaves one row.

        Stamped with the current ``PROCESS_GENERATION`` so a later run can tell
        "this landed in a process that is now dead" from "this is happening
        right now" — the distinction replay protection is built on.

        The typed fields (0012) are optional on purpose: only effects
        ``effects.classify`` recognises can supply them, and a tool it does not
        model must still get its advisory ledger row rather than no row at all.
        """
        c = self._db("sessions")
        try:
            c.execute(
                "INSERT OR IGNORE INTO tool_side_effects"
                " (call_id, session_id, goal_id, tool_name, args_hash, status, ok,"
                "  created_at, generation, effect_kind, target, operation_id,"
                "  pre_hash, planned_hash)"
                " VALUES (?,?,?,?,?,'pending',0,?,?,?,?,?,?,?)",
                (call_id, session_id, goal_id or "", tool_name, args_hash,
                 int(time.time()), PROCESS_GENERATION, str(effect_kind or ""),
                 str(target or ""), str(operation_id or ""), str(pre_hash or ""),
                 str(planned_hash or "")),
            )
        except sqlite3.OperationalError:
            # Database predates 0012 (or the migration is mid-flight): keep the
            # untyped row rather than losing the ledger entry entirely.
            c.execute(
                "INSERT OR IGNORE INTO tool_side_effects"
                " (call_id, session_id, goal_id, tool_name, args_hash, status, ok,"
                "  created_at, generation)"
                " VALUES (?,?,?,?,?,'pending',0,?,?)",
                (call_id, session_id, goal_id or "", tool_name, args_hash,
                 int(time.time()), PROCESS_GENERATION),
            )
        c.commit()

    def settle_side_effect(self, call_id: str, ok: bool, result_preview: str = "",
                           status: str = "", post_hash: str = "") -> None:
        """Mark a recorded side effect terminal once dispatch returns.

        ``status`` defaults to the outcome-derived ``completed``/``failed``.
        Pass it explicitly for the one case the outcome does not describe:
        a call stopped mid-flight, whose effect may or may not have landed,
        settles as ``unknown``. Collapsing that into ``failed`` was a
        safety error in the wrong direction — ``failed`` reads as "safe to
        redo", which for a write-class tool means doing it twice.

        ``post_hash`` is the target's state as actually observed after the call.
        It is what turns "the tool said ok" into evidence: a later reconcile can
        compare the world against it instead of trusting the transcript.
        """
        c = self._db("sessions")
        args = [status or ("completed" if ok else "failed"), 1 if ok else 0,
                str(result_preview or "")[:200], int(time.time())]
        try:
            c.execute(
                "UPDATE tool_side_effects SET status=?, ok=?, result_preview=?,"
                " settled_at=?, post_hash=? WHERE call_id=?",
                args + [str(post_hash or ""), call_id],
            )
        except sqlite3.OperationalError:
            c.execute(
                "UPDATE tool_side_effects SET status=?, ok=?, result_preview=?,"
                " settled_at=? WHERE call_id=?",
                args + [call_id],
            )
        c.commit()

    def completed_side_effects(self, goal_id: str) -> list:
        """Side effects that verifiably LANDED for this goal — the list a
        resumed run is told not to redo. Pending/failed rows are excluded."""
        c = self._db("sessions")
        rows = c.execute(
            "SELECT * FROM tool_side_effects WHERE goal_id=? AND status='completed'"
            " ORDER BY created_at, rowid",
            (goal_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def unknown_side_effects(self, goal_id: str) -> list:
        """Side effects whose outcome nobody knows: dispatched but never
        settled (``pending``, the process died between the two writes) or
        settled as ``unknown`` (aborted mid-flight).

        Deliberately separate from :meth:`completed_side_effects` because the
        advice differs: completed means "don't redo", unknown means "check
        first". Merging them into one list would force one wording onto two
        different situations.

        Ordered by ``created_at`` then ``rowid``: a goal can register several
        effects inside the same second, and second-granularity alone leaves
        their order up to SQLite — which makes "what happened last" unstable
        between reads of identical data.
        """
        c = self._db("sessions")
        rows = c.execute(
            "SELECT * FROM tool_side_effects WHERE goal_id=?"
            " AND status IN ('pending','unknown') ORDER BY created_at, rowid",
            (goal_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def find_landed_side_effect(self, goal_id: str, tool_name: str,
                                args_hash: str) -> dict | None:
        """The same call, on the same goal, that already LANDED in a **dead** process.

        This is the replay question, and the generation filter is what makes it
        a replay question rather than a repetition one: a completed row stamped
        with the current generation means the model is doing the same thing
        twice inside one live run, which is a loop, not a recovery hazard. Only
        a row from an earlier process says "the crash/pause happened after this
        write landed, and redoing it now would be the second time".

        Returns the newest such row, or None. Never raises on a missing
        ``generation`` column — a database that has not reached 0010 simply has
        no replay protection rather than a crashing tool path.
        """
        if not (goal_id and tool_name and args_hash):
            return None
        try:
            row = self._db("sessions").execute(
                "SELECT * FROM tool_side_effects WHERE goal_id=? AND tool_name=?"
                " AND args_hash=? AND status='completed'"
                " AND generation IS NOT ? AND generation != ''"
                " ORDER BY created_at DESC LIMIT 1",
                (goal_id, tool_name, args_hash, PROCESS_GENERATION),
            ).fetchone()
        except sqlite3.OperationalError:
            return None
        return dict(row) if row else None

    def find_effect_by_operation(self, operation_id: str,
                                 dead_only: bool = True) -> dict | None:
        """The previous attempt at this exact operation, from a **dead** process.

        The typed successor to :meth:`find_landed_side_effect`. It matches on
        ``operation_id`` — the identity of "this change to that target" — instead
        of on argument text, so a resumed run recognises its own earlier attempt
        even when the wording differs, and does NOT confuse two different writes
        that happen to share a spelling.

        Unlike the args-hash lookup it also returns *unsettled* attempts
        (``pending`` / ``unknown``). That is the point: those are the rows whose
        outcome has to be reconciled against the file system before anything is
        redone, and hiding them until they were `completed` is what left resume
        with no evidence at all.

        Newest first. Returns None when the database predates 0012.
        """
        if not operation_id:
            return None
        sql = ("SELECT * FROM tool_side_effects WHERE operation_id=?"
               " AND status IN ('completed','unknown','pending')")
        params: list = [operation_id]
        if dead_only:
            sql += " AND generation IS NOT ? AND generation != ''"
            params.append(PROCESS_GENERATION)
        sql += " ORDER BY created_at DESC, rowid DESC LIMIT 1"
        try:
            row = self._db("sessions").execute(sql, params).fetchone()
        except sqlite3.OperationalError:
            return None
        return dict(row) if row else None

    def mark_effect_reconciled(self, call_id: str, status: str,
                               post_hash: str = "",
                               operation_id: str = "") -> None:
        """Close out old attempts whose real outcome we just observed.

        Two things happen, and the second is the load-bearing one: the row's
        ``generation`` is restamped to the CURRENT process. That takes it out of
        :meth:`find_effect_by_operation`'s dead-generation filter, so the guard
        fires exactly once per operation. Without it, a target that already
        matches the planned outcome would block the same call forever — the model
        would re-issue it, get skipped, re-issue it, and the goal would never
        move. Skipping once with evidence and then letting a deliberate repeat
        through is the difference between a safety net and a wall.

        Pass ``operation_id`` to settle EVERY dead attempt at that operation, not
        just the newest one. Two crashes at the same write leave two rows, and
        marking one at a time would make the guard fire once per leftover row —
        the same wall, only slower.
        """
        if not (call_id or operation_id):
            return
        c = self._db("sessions")
        try:
            if operation_id:
                c.execute(
                    "UPDATE tool_side_effects SET status=?, post_hash=?,"
                    " generation=?, settled_at=? WHERE operation_id=?"
                    " AND generation IS NOT ? AND status IN"
                    " ('completed','unknown','pending')",
                    (str(status or "unknown"), str(post_hash or ""),
                     PROCESS_GENERATION, int(time.time()), operation_id,
                     PROCESS_GENERATION),
                )
            else:
                c.execute(
                    "UPDATE tool_side_effects SET status=?, post_hash=?,"
                    " generation=?, settled_at=? WHERE call_id=?",
                    (str(status or "unknown"), str(post_hash or ""),
                     PROCESS_GENERATION, int(time.time()), call_id),
                )
            c.commit()
        except sqlite3.OperationalError:
            pass  # pre-0012 database: no typed columns, nothing to reconcile

    # ── skill experiences (learning loop) ────────────────────────────────────

    #: Sentinel ``skill_id`` for a task that finished **without** any skill.
    #:
    #: The learning loop was blind to exactly the cases it most needs: a task
    #: that no skill covered is the strongest possible evidence that a skill is
    #: missing, yet it left no row at all, so the observation builder
    #: (``evolution.build_observation`` → ``list_skill_experiences(goal_id=…)``)
    #: saw an empty ledger and had nothing to propose from.
    #:
    #: Recorded in the same table on purpose — one ledger, one shape, one
    #: idempotency rule — under a name no authored skill can take (leading
    #: underscores are illegal in a skill directory name). Readers that mean
    #: "how did skill X do" filter it out via ``list_skill_experiences``'s
    #: ``include_task_level=False`` default; readers that mean "what happened"
    #: opt in. ``_maybe_degrade_skill`` is safe either way: it queries by an
    #: exact ``skill_id``, so these rows can never degrade a real skill.
    TASK_LEVEL_SKILL_ID: str = "__task__"

    def record_skill_experience(
        self,
        skill_id: str,

        *,
        skill_version: str = "",
        run_id: str = "",
        turn_id: str = "",
        goal_id: str = "",
        session_id: str = "",
        memory_snapshot_id: str = "",
        selection_reason: str = "",
        preconditions_met: bool = False,
        steps_attempted: int = 0,
        steps_succeeded: int = 0,
        validator_status: str = "none",
        user_feedback: str = "",
        outcome: str = "unknown",
        failure_class: str = "",
        repair_applied: str = "",
        cost: float = 0.0,
        latency_ms: float = 0.0,
        source_event_ids=None,
        evidence_event_ids=None,
    ) -> str:
        """Persist one grounded use of a skill; returns the experience id.

        Idempotent by construction: ``experience_id`` derives from
        (run_id, skill_id, turn_id) and a UNIQUE index backs it, so a retried
        or replayed recording lands as the SAME experience, never a duplicate.
        First write wins — later replays cannot overwrite what actually
        happened; corrections go through feedback, not re-recording.
        """
        if not skill_id:
            raise ValueError("record_skill_experience needs a skill_id")
        turn_id = turn_id or uuid.uuid4().hex[:12]
        exp_id = hashlib.sha256(
            f"{run_id}|{skill_id}|{turn_id}".encode("utf-8")
        ).hexdigest()[:16]
        c = self._db("sessions")
        c.execute(
            "INSERT OR IGNORE INTO skill_experiences"
            " (experience_id, skill_id, skill_version, run_id, turn_id, goal_id,"
            "  session_id, memory_snapshot_id, selection_reason, preconditions_met,"
            "  steps_attempted, steps_succeeded, validator_status, user_feedback,"
            "  outcome, failure_class, repair_applied, cost, latency_ms,"
            "  source_event_ids, evidence_event_ids, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                exp_id, skill_id, str(skill_version or ""), str(run_id or ""),
                turn_id, str(goal_id or ""), str(session_id or ""),
                str(memory_snapshot_id or ""), str(selection_reason or ""),
                1 if preconditions_met else 0,
                int(steps_attempted), int(steps_succeeded),
                str(validator_status or "none"), str(user_feedback or ""),
                str(outcome or "unknown"), str(failure_class or ""),
                str(repair_applied or ""), float(cost or 0.0),
                float(latency_ms or 0.0),
                json.dumps(list(source_event_ids or [])),
                json.dumps(list(evidence_event_ids or [])),
                int(time.time()),
            ),
        )
        c.commit()
        # The ledger row is the source of truth; the event is its audit mirror.
        # CRITICAL because lost learning evidence silently corrupts evolution,
        # but wrapped so a ledger outage degrades loudly instead of failing the
        # user's actual task mid-flight.
        try:
            self._trace.append(
                session_id=session_id or exp_id,
                event_type="skill.experience_recorded",
                payload={
                    "experience_id": exp_id, "skill_id": skill_id,
                    "skill_version": skill_version, "run_id": run_id,
                    "turn_id": turn_id, "goal_id": goal_id,
                    "outcome": outcome, "selection_reason": selection_reason,
                },
                importance=CRITICAL,
                idempotency_key=f"exp:{exp_id}",
                run_id=run_id or None,
                turn_id=turn_id or None,
                goal_id=goal_id or None,
            )
        except Exception:
            logging.getLogger(__name__).exception(
                "skill experience %s recorded in db but its event mirror failed", exp_id
            )
        # 连续失败自动降级（advisory，见 _maybe_degrade_skill）。
        try:
            self._maybe_degrade_skill(skill_id)
        except Exception:
            log.debug("degradation check failed for %s", skill_id, exc_info=True)
        return exp_id

    def get_skill_experience(self, experience_id: str):
        c = self._db("sessions")
        row = c.execute(
            "SELECT * FROM skill_experiences WHERE experience_id=?", (experience_id,)
        ).fetchone()
        return dict(row) if row else None

    def list_skill_experiences(self, *, skill_id=None, goal_id=None,
                               session_id=None, limit: int = 50,
                               include_task_level: bool = False) -> list:
        """Read the experience ledger.

        ``include_task_level`` defaults to False so "skill performance" views
        never show ``TASK_LEVEL_SKILL_ID`` rows as if a skill had run. Asking
        for that id explicitly still works — an explicit filter is a deliberate
        request, not an accident.
        """
        q = "SELECT * FROM skill_experiences"
        conds, args = [], []
        for col, val in (("skill_id", skill_id), ("goal_id", goal_id),
                         ("session_id", session_id)):
            if val:
                conds.append(f"{col}=?")
                args.append(val)
        if not include_task_level and not skill_id:
            conds.append("skill_id<>?")
            args.append(self.TASK_LEVEL_SKILL_ID)
        if conds:

            q += " WHERE " + " AND ".join(conds)
        q += " ORDER BY created_at DESC LIMIT ?"
        args.append(int(limit))
        return [dict(r) for r in self._db("sessions").execute(q, args).fetchall()]

    def set_skill_experience_feedback(self, experience_id: str, feedback: str,
                                      outcome: str = None) -> bool:
        """User's post-hoc verdict on an experience. Corrections land here —
        never by re-recording the same (run, skill, turn) triple."""
        sets, args = ["user_feedback=?"], [str(feedback or "")[:500]]
        if outcome is not None:
            sets.append("outcome=?")
            args.append(str(outcome))
        args.append(experience_id)
        c = self._db("sessions")
        cur = c.execute(
            f"UPDATE skill_experiences SET {', '.join(sets)} WHERE experience_id=?",
            args,
        )
        c.commit()
        return cur.rowcount > 0

    def trace_event(self, *, session_id: str, event_type, payload: dict,
                    importance: str = "observational", **correlation):
        """Sanctioned external entry into the canonical write gateway.

        Everything emitted here goes through TraceGateway.append unchanged —
        validation, secret redaction, idempotency and importance policy all
        apply. Exists so callers outside Storage (the router's skill lifecycle,
        goal workers) never reach for EventStore.append directly."""
        return self._trace.append(
            session_id=session_id, event_type=event_type,
            payload=payload, importance=importance, **correlation,
        )

    # ── memory–skill 显式关系图（Step D）─────────────────────────────────────

    #: 关系动词 → (主体类型, 客体类型)。八种边统一成三元组表达：
    #:   memory SUPPORTS / PREREQUISITE_FOR skill —— 记忆支撑/前置依赖技能；
    #:   skill PRODUCES / CONTRADICTS memory —— 技能产出/与事实冲突；
    #:   skill SUPERSEDES skill —— 新版取代旧版（保留旧版本，可回滚）；
    #:   goal VALIDATES skill —— 目标机器验证通过 = 技能的一次实证；
    #:   run USES skill；run UPDATES memory。
    RELATION_SHAPES: dict = {
        "SUPPORTS": ("memory", "skill"),
        "PREREQUISITE_FOR": ("memory", "skill"),
        "PRODUCES": ("skill", "memory"),
        "CONTRADICTS": ("skill", "memory"),
        "SUPERSEDES": ("skill", "skill"),
        "VALIDATES": ("goal", "skill"),
        "USES": ("run", "skill"),
        "UPDATES": ("run", "memory"),
    }

    def add_relation(self, subject_type: str, subject_id: str, relation: str,
                     object_type: str, object_id: str, *,
                     evidence: str = "") -> dict:
        """建一条边。幂等：同一五元组重复建边返回既有那条，不产生重复行。

        形状在代码里硬校验——"goal USES memory" 这类不合定义的边宁可当场
        拒绝，也不让关系图长出无法解释的怪边。
        """
        shape = self.RELATION_SHAPES.get(relation)
        if shape is None:
            raise ValueError(
                f"unknown relation {relation!r}; expected one of {sorted(self.RELATION_SHAPES)}"
            )
        if (subject_type, object_type) != shape:
            raise ValueError(
                f"{relation} must connect {shape[0]}->{shape[1]},"
                f" got {subject_type}->{object_type}"
            )
        rid = hashlib.sha256(
            f"{subject_type}|{subject_id}|{relation}|{object_type}|{object_id}".encode("utf-8")
        ).hexdigest()[:16]
        c = self._db("sessions")
        c.execute(
            "INSERT OR IGNORE INTO memory_skill_relations"
            " (id, subject_type, subject_id, relation, object_type, object_id,"
            "  evidence, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (rid, subject_type, str(subject_id), relation, object_type,
             str(object_id), str(evidence or ""), int(time.time())),
        )
        c.commit()
        return self.get_relation(rid)

    def get_relation(self, rel_id: str):
        row = self._db("sessions").execute(
            "SELECT * FROM memory_skill_relations WHERE id=?", (rel_id,)
        ).fetchone()
        return dict(row) if row else None

    def remove_relation(self, rel_id: str) -> bool:
        """删边。CONTRADICTS 解决后、错误建边时用——关系图允许修正。"""
        c = self._db("sessions")
        cur = c.execute("DELETE FROM memory_skill_relations WHERE id=?", (rel_id,))
        c.commit()
        return cur.rowcount > 0

    def relations_from(self, subject_type: str, subject_id: str,
                       relation: str = None) -> list:
        return self._relations_query(
            "subject_type=? AND subject_id=?", (subject_type, subject_id), relation
        )

    def relations_to(self, object_type: str, object_id: str,
                     relation: str = None) -> list:
        return self._relations_query(
            "object_type=? AND object_id=?", (object_type, object_id), relation
        )

    def _relations_query(self, where: str, args: tuple, relation) -> list:
        q = "SELECT * FROM memory_skill_relations"
        if relation:
            q += f" WHERE {where} AND relation=?"
            args = args + (relation,)
        else:
            q += f" WHERE {where}"
        q += " ORDER BY created_at"
        rows = self._db("sessions").execute(q, args).fetchall()
        return [dict(r) for r in rows]

    def mark_skills_stale_for_memory(self, memory_id: str) -> int:
        """记忆变化 → 所有牵连它的技能侧边打上待重验标记。

        这是 Step D 的核心承诺：Memory 改了，依赖它的 Skill 不能装作没事。
        标记打在**边上**而不是技能文件上——技能本体在磁盘上，往那里写状态
        等于污染用户可编辑的资产。
        """
        c = self._db("sessions")
        cur = c.execute(
            "UPDATE memory_skill_relations SET stale=1"
            " WHERE (subject_type='memory' AND subject_id=? AND object_type='skill')"
            " OR (object_type='memory' AND object_id=? AND subject_type='skill')",
            (memory_id, memory_id),
        )
        c.commit()
        return cur.rowcount

    def clear_skill_stale(self, skill_id: str) -> int:
        """重验通过后清除一个技能名下的待重验标记（含它指向别人的边）。"""
        c = self._db("sessions")
        cur = c.execute(
            "UPDATE memory_skill_relations SET stale=0"
            " WHERE (subject_type='skill' AND subject_id=?)"
            " OR (object_type='skill' AND object_id=?)",
            (skill_id, skill_id),
        )
        c.commit()
        return cur.rowcount

    # ── skill 候选生命周期（Step E）──────────────────────────────────────────

    _CAND_JSON_FIELDS = ("steps", "required_tools", "memory_refs",
                         "source_event_ids")

    def insert_skill_candidate(self, *, name: str, description: str = "",
                               when_to_use: str = "", scope: str = "",
                               preconditions: str = "", inputs: str = "",
                               outputs: str = "", steps=None,
                               required_tools=None, risk_level: str = "medium",
                               verification: str = "", known_failures: str = "",
                               memory_refs=None, experience_ref: str = "",
                               source_event_ids=None,
                               superseded_skill: str = "",
                               verify_command: str = "") -> str:
        cid = uuid.uuid4().hex[:12]
        c = self._db("sessions")
        c.execute(
            "INSERT INTO skill_candidates"
            " (id, name, description, when_to_use, scope, preconditions, inputs,"
            "  outputs, steps, required_tools, risk_level, verification,"
            "  known_failures, memory_refs, experience_ref, source_event_ids,"
            "  superseded_skill, verify_command, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                cid, str(name), str(description or ""), str(when_to_use or ""),
                str(scope or ""), str(preconditions or ""), str(inputs or ""),
                str(outputs or ""),
                json.dumps(list(steps or []), ensure_ascii=False),
                json.dumps(list(required_tools or []), ensure_ascii=False),
                str(risk_level or "medium"), str(verification or ""),
                str(known_failures or ""),
                json.dumps(list(memory_refs or []), ensure_ascii=False),
                str(experience_ref or ""),
                json.dumps(list(source_event_ids or []), ensure_ascii=False),
                str(superseded_skill or ""),
                str(verify_command or ""),
                int(time.time()), int(time.time()),
            ),
        )
        c.commit()
        return cid

    @staticmethod
    def _candidate_row_to_dict(r) -> dict:
        d = dict(r)
        for f in Storage._CAND_JSON_FIELDS:
            try:
                d[f] = json.loads(d.get(f) or "[]")
            except (json.JSONDecodeError, TypeError):
                d[f] = []
        try:
            d["gate_report"] = json.loads(d.get("gate_report") or "{}")
        except (json.JSONDecodeError, TypeError):
            d["gate_report"] = {}
        return d

    def get_skill_candidate(self, cid: str):
        row = self._db("sessions").execute(
            "SELECT * FROM skill_candidates WHERE id=?", (cid,)
        ).fetchone()
        return self._candidate_row_to_dict(row) if row else None

    def list_skill_candidates(self, status: str = None, limit: int = 50) -> list:
        q = "SELECT * FROM skill_candidates"
        args = []
        if status:
            q += " WHERE status=?"
            args.append(status)
        q += " ORDER BY created_at DESC LIMIT ?"
        args.append(int(limit))
        return [self._candidate_row_to_dict(r)
                for r in self._db("sessions").execute(q, args).fetchall()]

    def set_skill_candidate_status(self, cid: str, status: str, *,
                                   version: str = None, gate_report=None,
                                   snapshot_path: str = None) -> bool:
        sets, args = ["status=?", "updated_at=?"], [status, int(time.time())]
        if version is not None:
            sets.append("version=?")
            args.append(version)
        if gate_report is not None:
            sets.append("gate_report=?")
            args.append(json.dumps(gate_report, ensure_ascii=False))
        if snapshot_path is not None:
            sets.append("snapshot_path=?")
            args.append(snapshot_path)
        args.append(cid)
        c = self._db("sessions")
        cur = c.execute(
            f"UPDATE skill_candidates SET {', '.join(sets)} WHERE id=?", args
        )
        c.commit()
        return cur.rowcount > 0

    #: 最近窗口里失败达到这个数，active/staged 候选自动降级（advisory）。
    DEGRADE_WINDOW = 5
    DEGRADE_THRESHOLD = 3

    def _maybe_degrade_skill(self, skill_id: str) -> None:
        """连续失败自动降级。一次失败只记经验（经验表已记录），绝不覆盖
        active 技能；窗口内失败过半才把生命周期行标成 degraded，供推荐层
        收敛。单向降级——恢复走人工重新 promote，不让统计噪声自己翻案。"""
        rows = self._db("sessions").execute(
            "SELECT outcome FROM skill_experiences WHERE skill_id=?"
            " ORDER BY created_at DESC LIMIT ?",
            (skill_id, int(self.DEGRADE_WINDOW)),
        ).fetchall()
        if len(rows) < self.DEGRADE_THRESHOLD:
            return
        fails = sum(1 for r in rows if r["outcome"] == "failure")
        if fails < self.DEGRADE_THRESHOLD:
            return
        cur = self._db("sessions").execute(
            "UPDATE skill_candidates SET status='degraded', updated_at=?"
            " WHERE name=? AND status IN ('active','staged')",
            (int(time.time()), skill_id),
        )
        self._db("sessions").commit()
        if cur.rowcount > 0:
            self._broadcast_degraded(skill_id, fails)

    def _broadcast_degraded(self, skill_id: str, fails: int) -> None:
        """自动降级也要有感知：聊天界面出现一枚芯片，而不是静默变脸。"""
        try:
            import asyncio
            from event_bus import get_event_bus
            bus = get_event_bus()
            asyncio.get_running_loop()
            asyncio.create_task(bus.emit("evolution_insight", {
                "kind": "skill_degraded",
                "detail": (f"{skill_id} 近 {self.DEGRADE_WINDOW} 次使用失败 "
                           f"{fails} 次，已自动降级待人工复检"),
                "skillName": skill_id,
                "status": "degraded",
            }))
        except Exception as e:
            print(f"[skills] degraded insight failed: {e}")


    def rename_session(self, sid, title):
        c = self._db("sessions")
        c.execute("UPDATE sessions SET title=?, updated_at=? WHERE id=?",
                  (title, int(time.time()), sid))
        c.commit()
        return Result.success(title)

    def set_session_pinned(self, sid, pinned):
        c = self._db("sessions")
        c.execute("UPDATE sessions SET pinned=? WHERE id=?", (1 if pinned else 0, sid))
        c.commit()
        return Result.success(bool(pinned))

    def set_turn_status(self, sid, status, substatus="", updated_at=0):
        """Persist the turn state for one session (2.1).

        Deliberately dumb: no validation, no transition rules. Those live in
        `turn_state.TurnStateMachine`, which is the only thing that should call
        this. Splitting them that way means the legality question has exactly
        one answer in the codebase instead of one here and one there.
        """
        c = self._db("sessions")
        c.execute(
            "UPDATE sessions SET turn_status=?, turn_substatus=?, status_updated_at=? "
            "WHERE id=?",
            (str(status), str(substatus or ""), int(updated_at or time.time()), sid),
        )
        c.commit()
        return Result.success(str(status))

    def reset_stale_turn_status(self, stale="running", to="error"):
        """Rewrite turn states that cannot have survived a restart.

        A row left at `running` refers to an asyncio task that died with the
        previous process. Leaving it means the UI reconnects, reads `running`,
        and spins forever waiting on a turn that will never report back. Telling
        the user "last one didn't finish" is the honest reading.

        Returns the number of rows rewritten so boot logs can show it.
        """
        c = self._db("sessions")
        cur = c.execute(
            "UPDATE sessions SET turn_status=?, turn_substatus='' WHERE turn_status=?",
            (to, stale),
        )
        c.commit()
        return cur.rowcount or 0

    def autotitle_session(self, sid, text, max_len=40):

        """Name a session after its first user message, once.

        Only fires while the title is still a placeholder, so a user's manual
        rename is never clobbered by a later turn. Newlines collapse to spaces
        because the sidebar row is single-line.
        """
        cur = self._db("sessions").execute(
            "SELECT title FROM sessions WHERE id=?", (sid,)
        ).fetchone()
        existing = (cur["title"] if cur else "") or ""
        if existing and existing not in ("Main session", "New chat", "新对话"):
            return Result.success(existing)
        clean = " ".join((text or "").split())
        if not clean:
            return Result.success(existing)
        title = clean[:max_len] + ("…" if len(clean) > max_len else "")
        return self.rename_session(sid, title)

    def cleanup_sessions(self):
        """One-time housekeeping for the conversation list, run at startup.

        Two problems this repairs, both created by the old "new UUID + INSERT OR
        REPLACE 'Main session' on every boot" behaviour:

        1. **Ghost sessions.** Launching the app used to mint a session whether
           or not the user said anything, so the history list filled with
           identical placeholders. Anything with no real user message is junk and
           gets deleted (along with its orphaned assistant/empty rows).

        2. **Placeholder titles.** Every legacy session is literally named
           "Main session". For the ones that DO contain a conversation, we
           back-fill the title from their first user message so history becomes
           readable instead of a wall of identical rows.

        Returns ``(deleted, retitled)`` so the caller can log it.
        """
        c = self._db("sessions")
        # A session is real if it has at least one non-blank user message.
        real = {r["session_id"] for r in c.execute(
            "SELECT DISTINCT session_id FROM session_messages "
            "WHERE role='user' AND TRIM(COALESCE(content,'')) != ''"
        ).fetchall()}
        all_ids = {r["id"] for r in c.execute("SELECT id FROM sessions").fetchall()}

        deleted = 0
        for sid in all_ids - real:
            c.execute("DELETE FROM session_messages WHERE session_id=?", (sid,))
            c.execute("DELETE FROM sessions WHERE id=?", (sid,))
            deleted += 1

        # Back-fill placeholder titles from the first user message.
        retitled = 0
        placeholders = ("", "Main session", "New chat", "新对话")
        for sid in real:
            row = c.execute("SELECT title FROM sessions WHERE id=?", (sid,)).fetchone()
            if not row or (row["title"] or "") not in placeholders:
                continue
            first = c.execute(
                "SELECT content FROM session_messages WHERE session_id=? AND role='user' "
                "AND TRIM(COALESCE(content,'')) != '' ORDER BY seq LIMIT 1", (sid,)
            ).fetchone()
            if not first:
                continue
            clean = " ".join((first["content"] or "").split())
            if not clean:
                continue
            title = clean[:40] + ("…" if len(clean) > 40 else "")
            c.execute("UPDATE sessions SET title=? WHERE id=?", (title, sid))
            retitled += 1

        c.commit()
        return deleted, retitled

    def add_compaction(self, sid, summary, tb, ta):
        return self.add_message(sid, "system", summary, "compaction", {"tokensBefore": tb, "estimatedTokensAfter": ta})

    def set_goal_state(self, sid, gs):
        c = self._db("sessions"); c.execute("UPDATE sessions SET goal_state=?, updated_at=? WHERE id=?", (json.dumps(gs, ensure_ascii=False), int(time.time()), sid)); c.commit()

    def get_goal_state(self, sid):
        r = self._db("sessions").execute("SELECT goal_state FROM sessions WHERE id=?", (sid,)).fetchone()
        if r and r["goal_state"]:
            try: return json.loads(r["goal_state"])
            except: return None
        return None

    #: Columns callers may set through :meth:`update_goal_fields`. Anything
    #: outside this set is dropped rather than interpolated into SQL.
    _GOAL_WRITABLE = frozenset({
        "description", "status", "iteration", "session_id", "verification_result",
        "max_iterations", "cost_micros", "cost_cap_micros", "tokens_used",
        "plan_json", "last_error", "started_at", "claimed_at",
        "brief_json", "category", "contract_json",
    })

    def save_goal(self, gid, desc, status, it, sid, ver=""):
        """Upsert the five core goal fields, preserving everything else.

        This deliberately does NOT use ``INSERT OR REPLACE``. Replace deletes the
        old row and inserts a fresh one, so every column absent from the INSERT
        list silently reverts to its default — which would zero out the spend
        ledger and the plan on each status change, and reset ``created_at`` so
        goals appeared to be created anew every time they were touched.
        """
        c = self._db("goals"); now = int(time.time())
        cur = c.execute("SELECT id FROM goals WHERE id=?", (gid,)).fetchone()
        if cur:
            c.execute(
                "UPDATE goals SET description=?, status=?, iteration=?, session_id=?,"
                " verification_result=?, updated_at=? WHERE id=?",
                (desc, status, it, sid, ver, now, gid),
            )
        else:
            c.execute(
                "INSERT INTO goals (id,description,status,iteration,session_id,"
                "created_at,updated_at,verification_result) VALUES (?,?,?,?,?,?,?,?)",
                (gid, desc, status, it, sid, now, now, ver),
            )
        c.commit()

    def update_goal_fields(self, gid, **fields):
        """Partially update a goal. Returns True when a row was touched.

        Used by the scheduler for narrow writes (claim, spend, plan) so two
        concurrent updates to different columns cannot clobber each other the way
        a read-modify-write of the whole row would.

        Keys outside :attr:`_GOAL_WRITABLE` are refused, not written — the lease
        columns in particular may only move through ``claim_goal`` /
        ``renew_goal_claim`` / ``release_goal`` / ``reap_goal_claim``, because a
        lease written from anywhere else is a lease two workers can disagree
        about. The refusal is LOUD: a silently dropped write is how a caller
        ends up believing it changed state that never changed, which is the
        same class of bug as a pause that reports success without stopping.
        """
        allowed = {k: v for k, v in fields.items() if k in self._GOAL_WRITABLE}
        refused = sorted(set(fields) - set(allowed))
        if refused:
            log.error(
                "[storage] update_goal_fields refused non-writable column(s) %s "
                "on goal %s — the write did NOT happen; use the dedicated "
                "claim/lease methods for lease columns", refused, gid,
            )
        if not allowed:
            return False
        c = self._db("goals")
        sets = ",".join(f"{k}=?" for k in allowed)
        cur = c.execute(
            f"UPDATE goals SET {sets}, updated_at=? WHERE id=?",
            list(allowed.values()) + [int(time.time()), gid],
        )
        c.commit()
        return cur.rowcount > 0

    #: Statuses a goal can never be claimed out of. A DENY list, not an allow
    #: list, on purpose: claim failure is silent (``_spawn_worker`` just
    #: returns), so an allow list that forgot one legitimate state would turn
    #: Resume/Retry into a button that does nothing with no error anywhere.
    #: ``failed``/``ovolve_failed_final``/``paused`` stay claimable — those are
    #: exactly what the Retry and Resume buttons act on.
    #:
    #: ``stopping`` / ``stop_timeout`` are denied on purpose: stopping means a
    #: stop request is still being executed against a live worker; stop_timeout
    #: means a stop could not be confirmed at all. Handing either to a new
    #: worker would run two workers against one goal — the exact thing the
    #: state exists to prevent. Recovery out of stop_timeout goes through
    #: ``confirm_stopped`` (worker verifiably gone → paused → claimable).
    GOAL_UNCLAIMABLE_STATUSES: tuple = (
        "completed", "cancelled", "stopping", "stop_timeout",
    )

    def claim_goal(self, gid, stale_after=900, owner: str = "",
                   lease_seconds: int = 0):
        """Atomically claim a goal for execution. Returns True if we got it.

        The UPDATE's WHERE clause is the lock: SQLite serializes writers, so of
        two schedulers racing for the same goal exactly one sees rowcount 1.
        The status condition mirrors what every durable-execution engine does —
        no worker is ever handed an already-closed execution. Without it, a
        ``POST /api/goals/{id}/run`` on a finished goal claimed it and started
        a worker again (``enqueue`` only refuses RUNNING/QUEUED); the UI hides
        that button, which made the hole invisible rather than absent.

        Two claim shapes share this one method:

        * **Owned lease** (``owner`` given): the claim lives until
          ``lease_until``, which the holder must keep renewing from a
          heartbeat task. Expiry of THAT column — not of total runtime — is
          what makes a claim stealable, so a healthy goal that runs for an
          hour is never mistaken for a dead one, while a crashed process's
          lease goes stale within seconds of its last beat.
        * **Legacy shape** (no owner): ``claimed_at`` + ``stale_after``
          exactly as before. Tests and old callers keep their semantics; the
          scheduler no longer uses this path.

        The WHERE clause accepts a stealable row when: it is unclaimed, or its
        lease has already expired (owned shape), or it has no lease at all and
        its claimed_at aged past ``stale_after`` (legacy shape).
        """
        c = self._db("goals"); now = int(time.time())
        blocked = self.GOAL_UNCLAIMABLE_STATUSES
        if owner:
            cur = c.execute(
                "UPDATE goals SET claimed_at=?, claim_owner=?, lease_until=?,"
                " last_heartbeat=?, claim_epoch=COALESCE(claim_epoch,0)+1"
                " WHERE id=? AND (claimed_at=0"
                "   OR (COALESCE(lease_until,0)>0 AND COALESCE(lease_until,0)<?)"
                "   OR (COALESCE(lease_until,0)=0 AND claimed_at<?))"
                f" AND (status IS NULL OR status NOT IN ({','.join('?' * len(blocked))}))",
                (now, str(owner), now + int(lease_seconds or stale_after), now,
                 gid, now, now - stale_after, *blocked),
            )
        else:
            # Legacy shape: no identity, no lease. claim_owner stays '' so an
            # owner-less release keeps working; expiry stays claimed_at-based.
            cur = c.execute(
                "UPDATE goals SET claimed_at=? WHERE id=? AND (claimed_at=0 OR claimed_at<?)"
                f" AND (status IS NULL OR status NOT IN ({','.join('?' * len(blocked))}))",
                (now, gid, now - stale_after, *blocked),
            )
        c.commit()
        return cur.rowcount > 0

    def renew_goal_claim(self, gid: str, owner: str, lease_seconds: int) -> bool:
        """Push a held lease forward. Owner-conditioned by construction.

        False means we no longer own the claim — either our lease expired and
        another scheduler stole the goal, or someone released it. The caller
        MUST treat that as "stop working immediately": two workers driving one
        goal is the failure every other guard here exists to backstop.
        """
        if not (gid and owner):
            return False
        now = int(time.time())
        c = self._db("goals")
        cur = c.execute(
            "UPDATE goals SET lease_until=?, last_heartbeat=?"
            " WHERE id=? AND claim_owner=? AND claimed_at>0",
            (now + int(lease_seconds), now, gid, str(owner)),
        )
        c.commit()
        return cur.rowcount > 0

    def release_goal(self, gid, owner: str = "") -> bool:
        """Drop our claim so the goal can be picked up again.

        With ``owner``, the clear is conditioned on the stored owner matching:
        a late-ending old worker can no longer wipe the NEW worker's fresh
        claim — that race was real even under the Electron single-instance
        lock, because dev mode, direct CLI starts and future multi-window
        paths all bypass it. Returns whether a row was actually cleared;
        callers should record a ``goal.claim_release_rejected`` event on False
        rather than assuming success.

        Without an owner (legacy callers), only an UNOWNED or already-expired
        claim may be cleared. An ownerless caller must never be able to kill
        a live foreign lease just because it found the goal id.
        """
        c = self._db("goals"); now = int(time.time())
        if owner:
            cur = c.execute(
                "UPDATE goals SET claimed_at=0, claim_owner='', lease_until=0,"
                " last_heartbeat=0 WHERE id=? AND claim_owner=?",
                (gid, str(owner)),
            )
        else:
            cur = c.execute(
                "UPDATE goals SET claimed_at=0, claim_owner='', lease_until=0,"
                " last_heartbeat=0 WHERE id=? AND claimed_at>0"
                " AND (claim_owner IS NULL OR claim_owner=''"
                "   OR (COALESCE(lease_until,0)>0 AND COALESCE(lease_until,0)<?))",
                (gid, now),
            )
        c.commit()
        return cur.rowcount > 0

    def claim_info(self, gid: str) -> dict:
        """Read-only view of who holds a goal and until when. Diagnostics."""
        row = self.get_goal(gid) or {}
        return {
            "claimed": bool(row.get("claimed_at")),
            "claimOwner": row.get("claim_owner") or "",
            "leaseUntil": row.get("lease_until") or 0,
            "lastHeartbeat": row.get("last_heartbeat") or 0,
            "claimEpoch": row.get("claim_epoch") or 0,
        }

    def reap_goal_claim(self, gid: str) -> bool:
        """Boot-time forced release of a claim whose holder process is GONE.

        Only ever called during startup recovery, before this process has any
        workers: a live claim from ANOTHER generation cannot belong to anyone
        alive, because owners are stamped ``<PROCESS_GENERATION>:<token>`` and
        generations are unique per process life. A claim owned by THIS process
        is refused — that would mean a bug double-starting a worker, and the
        honest answer is False, not silently pulling the rug.
        """
        c = self._db("goals")
        cur = c.execute(
            "UPDATE goals SET claimed_at=0, claim_owner='', lease_until=0,"
            " last_heartbeat=0 WHERE id=? AND claimed_at>0"
            " AND (claim_owner IS NULL OR claim_owner=''"
            "   OR claim_owner NOT LIKE ?)",
            (gid, PROCESS_GENERATION + "%"),
        )
        c.commit()
        return cur.rowcount > 0

    def add_goal_spend(self, gid, cost_micros, tokens=0):
        """Increment the spend ledger and return the new totals.

        Done as an in-SQL increment rather than read-then-write so a concurrent
        iteration recording its own spend cannot overwrite ours.
        """
        c = self._db("goals")
        c.execute(
            "UPDATE goals SET cost_micros=COALESCE(cost_micros,0)+?,"
            " tokens_used=COALESCE(tokens_used,0)+?, updated_at=? WHERE id=?",
            (int(cost_micros), int(tokens), int(time.time()), gid),
        )
        c.commit()
        r = c.execute(
            "SELECT cost_micros, cost_cap_micros, tokens_used FROM goals WHERE id=?", (gid,)
        ).fetchone()
        return dict(r) if r else {}

    def get_goal(self, gid):
        r = self._db("goals").execute("SELECT * FROM goals WHERE id=?", (gid,)).fetchone(); return dict(r) if r else None

    def list_goals(self, status=None):
        c = self._db("goals")
        if status: r = c.execute("SELECT * FROM goals WHERE status=? ORDER BY updated_at DESC", (status,)).fetchall()
        else: r = c.execute("SELECT * FROM goals ORDER BY updated_at DESC").fetchall()
        return [dict(x) for x in r]

    def save_cron_job(self, job):
        c = self._db("cron")
        cols = ("id","title","prompt","cron_expr","delay_minutes","recurring","max_runs","next_run_at","last_run_at","run_count","status","bot_delivery_target","session_id","created_at")
        c.execute(f"INSERT OR REPLACE INTO cron_jobs ({','.join(cols)}) VALUES ({','.join(['?']*len(cols))})", [job.get(k) for k in cols]); c.commit()

    def get_cron_jobs(self, active=False, include_stopped=False):
        c = self._db("cron")
        if active:
            r = c.execute("SELECT * FROM cron_jobs WHERE status='active' ORDER BY next_run_at").fetchall()
        elif not include_stopped:
            r = c.execute("SELECT * FROM cron_jobs WHERE status != 'stopped' ORDER BY created_at DESC").fetchall()
        else:
            r = c.execute("SELECT * FROM cron_jobs ORDER BY created_at DESC").fetchall()
        return [dict(x) for x in r]

    def update_cron_job(self, jid, **fields):
        c = self._db("cron"); c.execute(f"UPDATE cron_jobs SET {','.join([f'{k}=?' for k in fields])} WHERE id=?", list(fields.values()) + [jid]); c.commit()

    def delete_cron_job(self, jid):
        c = self._db("cron")
        c.execute("DELETE FROM cron_jobs WHERE id=?", (jid,))
        c.commit()

    def record_usage(self, sid, tid, inp, outp, reason=0, cc=0, cr=0, pt=0, ct=0, mr=0, retry=True, cx=False, et="", model_id="", latency_ms=0, cost_micros=0, cache_saved_micros=0, cost_source=""):
        c = self._db("usage")
        c.execute("INSERT INTO turn_usage (id,session_id,turn_id,model_id,input_tokens,output_tokens,reasoning_tokens,cache_creation,cache_read,provider_total,computed_total,model_retry,retryable,context_exceeded,error_type,latency_ms,cost_micros,cache_saved_micros,cost_source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (str(uuid.uuid4()), sid, tid, model_id, inp, outp, reason, cc, cr, pt, ct, mr, int(retry), int(cx), et, int(latency_ms or 0), int(cost_micros or 0), int(cache_saved_micros or 0), str(cost_source or ""), int(time.time()))); c.commit()
        # P1-3 审计轨轮次事件（）：
        # token 用量随流水落 jsonl（record 自身 fail-open，失败只丢审计不
        # 影响计费主流程）。
        self._session_audit.record(
            sid, "event", event="usage", event_type="llm.response_completed",
            model=str(model_id or ""), turn_id=str(tid or ""),
            tokens={"input": int(inp or 0), "output": int(outp or 0),
                    "reasoning": int(reason or 0), "cache_creation": int(cc or 0),
                    "cache_read": int(cr or 0)},
            payload={"latency_ms": int(latency_ms or 0), "cost_micros": int(cost_micros or 0),
                     "cache_saved_micros": int(cache_saved_micros or 0),
                     "model_retry": int(mr or 0), "context_exceeded": int(cx or 0),
                     "error_type": str(et or "")})

    def get_usage(self, sid):
        r = self._db("usage").execute("SELECT * FROM turn_usage WHERE session_id=?", (sid,)).fetchall()
        ti=sum(x["input_tokens"] or 0 for x in r); to=sum(x["output_tokens"] or 0 for x in r); tr=sum(x["reasoning_tokens"] or 0 for x in r)
        # Money comes from the per-row figures priced at their own write time —
        # summed, never recomputed. That is what makes yesterday's total stable
        # after a price change.
        cost = sum(x["cost_micros"] or 0 for x in r)
        saved = sum(x["cache_saved_micros"] or 0 for x in r)
        # If any row was priced off the fallback rate the total is approximate,
        # and the UI should say so rather than showing a confident number.
        approx = any((x["cost_source"] or "") == "fallback" for x in r)
        return {"turns": len(r), "total_input": ti, "total_output": to, "total_reasoning": tr, "total": ti+to+tr,
                "total_cost_micros": cost, "cache_saved_micros": saved, "cost_approximate": approx}

    # ------------------------------------------------------------------
    # Goal iteration detail
    # ------------------------------------------------------------------

    #: Evidence can be a whole turn's output. Store a digest, not the transcript:
    #: this table is read to answer "what happened in round 4", and the full text
    #: already lives in the session messages.
    GOAL_EVIDENCE_DIGEST_CHARS = 600

    def add_goal_iteration(self, gid, ordinal, started_at=0, ended_at=0, evidence="",
                           verdict="", verdict_reason="", cost_micros=0, tokens=0):
        """Record one round of a goal run. Returns the new row id.

        Idempotent on ``(goal_id, ordinal)``: a worker that retries a round
        overwrites that round instead of appending a duplicate, so the row count
        stays equal to the round count.
        """
        c = self._db("goals"); now = int(time.time())
        digest = (evidence or "")[: self.GOAL_EVIDENCE_DIGEST_CHARS]
        prev = c.execute(
            "SELECT id FROM goal_iterations WHERE goal_id=? AND ordinal=?", (gid, int(ordinal))
        ).fetchone()
        rid = prev["id"] if prev else str(uuid.uuid4())
        if prev:
            c.execute(
                "UPDATE goal_iterations SET started_at=?, ended_at=?, evidence_digest=?,"
                " verdict=?, verdict_reason=?, cost_micros=?, tokens=? WHERE id=?",
                (int(started_at or 0), int(ended_at or now), digest, str(verdict or ""),
                 str(verdict_reason or ""), int(cost_micros or 0), int(tokens or 0), rid),
            )
        else:
            c.execute(
                "INSERT INTO goal_iterations (id,goal_id,ordinal,started_at,ended_at,"
                "evidence_digest,verdict,verdict_reason,cost_micros,tokens,created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (rid, gid, int(ordinal), int(started_at or 0), int(ended_at or now), digest,
                 str(verdict or ""), str(verdict_reason or ""), int(cost_micros or 0),
                 int(tokens or 0), now),
            )
        c.commit()
        return rid

    def list_goal_iterations(self, gid, limit=100):
        """Rounds of a goal, oldest first."""
        r = self._db("goals").execute(
            "SELECT * FROM goal_iterations WHERE goal_id=? ORDER BY ordinal ASC LIMIT ?",
            (gid, int(limit)),
        ).fetchall()
        return [dict(x) for x in r]

    def last_turn_context_tokens(self, sid):
        """Provider-reported context size at the LAST turn of a session.

        This is what the compactor wants for its "how full is the window"
        estimate — the provider's own count of everything it read, which beats
        any local heuristic. Deliberately NOT the session total: summing every
        turn's input would grow without bound and make the compactor think the
        window is overflowing after a handful of ordinary turns.

        `input_tokens + cache_read` because providers usually report cached
        prefix separately, yet both occupy the context window.
        """
        r = self._db("usage").execute(
            "SELECT input_tokens, cache_read FROM turn_usage "
            "WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (sid,),
        ).fetchone()
        if not r:
            return 0
        return (r["input_tokens"] or 0) + (r["cache_read"] or 0)

    # ── Usage analytics (dashboard queries) ───────────────────────────────
    #
    # All aggregation happens in SQL rather than by pulling rows into Python.
    # There is deliberately NO daily-rollup table: `created_at` is a unix
    # timestamp, so `date(created_at,'unixepoch','localtime')` buckets by
    # calendar day on demand. One table stays the single source of truth and
    # there is no rollup job that can drift out of sync with it.

    # ── Convention-aware usage aggregates ────────────────────────────────────
    # Providers disagree on two shapes, and the stats path must apply the SAME
    # magnitude heuristics the billing path uses (compute_cost in
    # model_registry), or the two sides of the dashboard disagree with the
    # invoice:
    #
    # Cached tokens: OpenAI-style providers report prompt_tokens INCLUSIVE of
    # the cached portion; Anthropic-style report it exclusive. A row where
    # `cache_read <= input` is the inclusive shape — its input already contains
    # the cached tokens, so the hit-rate denominator is input alone; otherwise
    # input + cache_read. In both cases, cache_creation is included in the
    # denominator (aligned with token_analytics.py hit-rate calculation).
    _SQL_HIT_DENOM = (
        "COALESCE(SUM(CASE WHEN cache_read <= input_tokens "
        "THEN input_tokens + cache_creation "
        "ELSE input_tokens + cache_read + cache_creation END),0)"
    )
    # Reasoning tokens: OpenAI reports them INSIDE completion_tokens. A row
    # whose reasoning fits inside its output is that shape and contributes
    # input+output, not input+output+reasoning — otherwise every reasoning
    # model's total was inflated by its own thinking.
    _SQL_TOTAL = (
        "COALESCE(SUM(CASE WHEN reasoning_tokens > 0 AND reasoning_tokens <= output_tokens "
        "THEN input_tokens + output_tokens "
        "ELSE input_tokens + output_tokens + reasoning_tokens END),0)"
    )

    def usage_summary(self, days=30):
        """Headline numbers for the dashboard cards."""
        since = int(time.time()) - days * 86400
        r = self._db("usage").execute(f"""
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
                   {self._SQL_HIT_DENOM}          AS hit_denom,
                   {self._SQL_TOTAL}              AS total_tokens
            FROM turn_usage WHERE created_at >= ?
        """, (since,)).fetchone()
        d = dict(r) if r else {}
        cache_read = d.get("cache_read", 0) or 0
        # Cache hit rate = cached share of everything that entered the model,
        # convention-corrected per row (see _SQL_HIT_DENOM). Sent as a 0-1
        # fraction; the UI multiplies by 100.
        denom = d.pop("hit_denom", 0) or 0
        d["cache_hit_rate"] = round(cache_read / denom, 4) if denom else 0.0
        # Money is a SUM of per-row figures priced when each row was written.
        # Never recomputed here: a price change must not rewrite history.
        d["cost_approximate"] = bool(d.get("fallback_priced_turns") or 0)
        d["favorite_model"] = self._favorite_model(since)
        d["current_streak_days"] = self._current_streak(days)
        d.update(self.usage_latency(days))
        return d

    def usage_latency(self, days=30):
        """Latency distribution over the period: p50 / p95 / max, in ms.

        Percentiles are computed in Python because SQLite has no PERCENTILE
        function. The row count here is turns-in-a-month on one desktop —
        thousands at most — so pulling one integer column is cheaper than any
        window-function gymnastics would be.

        Rows with latency_ms = 0 are EXCLUDED, not counted as instant: 0 means
        "recorded before this column existed", and treating legacy rows as
        zero-latency would drag every percentile toward a flattering lie.
        """
        since = int(time.time()) - days * 86400
        rows = self._db("usage").execute(
            "SELECT latency_ms FROM turn_usage "
            "WHERE created_at >= ? AND latency_ms > 0 ORDER BY latency_ms ASC",
            (since,),
        ).fetchall()
        vals = [r["latency_ms"] for r in rows]
        if not vals:
            return {"latency_p50_ms": 0, "latency_p95_ms": 0, "latency_max_ms": 0,
                    "latency_samples": 0}
        return {
            "latency_p50_ms": self._percentile(vals, 0.50),
            "latency_p95_ms": self._percentile(vals, 0.95),
            "latency_max_ms": vals[-1],
            "latency_samples": len(vals),
        }

    @staticmethod
    def _percentile(sorted_vals, q):
        """Nearest-rank percentile over an ALREADY SORTED list.

        Nearest-rank (rather than linear interpolation) keeps the result an
        actual observed latency, which is what you want when someone asks "how
        slow is the slow case" — an interpolated number nobody ever measured is
        harder to reason about.
        """
        if not sorted_vals:
            return 0
        idx = int(round(q * (len(sorted_vals) - 1)))
        return sorted_vals[max(0, min(idx, len(sorted_vals) - 1))]

    def _favorite_model(self, since):
        """The model called most often in the period, as a bare model id.

        Counted per model rather than per ``provider:model`` string. Grouping on
        the raw column split one model's turns across every provider entry that
        ever served it, so a single model used 85 times could lose "favourite" to
        one used 20 — and the winner was then displayed with its provider prefix
        still attached.
        """
        rows = self._db("usage").execute("""
            SELECT model_id, COUNT(*) AS n FROM turn_usage
            WHERE created_at >= ? AND model_id != '' GROUP BY model_id
        """, (since,)).fetchall()
        tally: dict[str, int] = {}
        for r in rows:
            _, model_id = split_usage_model_id(r["model_id"])
            if model_id:
                tally[model_id] = tally.get(model_id, 0) + int(r["n"] or 0)
        return max(tally, key=tally.get) if tally else ""

    def _current_streak(self, lookback_days=365):
        """Consecutive days with activity, counting back from today.

        Stops at the first gap. A user who used it yesterday but not today
        still has their streak counted from yesterday — punishing someone at
        00:01 for not having worked yet today would be absurd.
        """
        since = int(time.time()) - lookback_days * 86400
        rows = self._db("usage").execute("""
            SELECT DISTINCT date(created_at,'unixepoch','localtime') AS d
            FROM turn_usage WHERE created_at >= ? ORDER BY d DESC
        """, (since,)).fetchall()
        if not rows:
            return 0
        import datetime as _dt
        days = [_dt.date.fromisoformat(r["d"]) for r in rows]
        today = _dt.date.today()
        cursor = today if days[0] == today else days[0]
        if (today - cursor).days > 1:
            return 0
        streak = 0
        for d in days:
            if d == cursor:
                streak += 1
                cursor -= _dt.timedelta(days=1)
            elif d < cursor:
                break
        return streak

    def usage_daily(self, days=30):
        """Per-day totals — feeds the heatmap, stacked area chart, and trend line."""
        since = int(time.time()) - days * 86400
        rows = self._db("usage").execute(f"""
            SELECT date(created_at,'unixepoch','localtime') AS date,
                   COUNT(*) AS turns,
                   COALESCE(SUM(input_tokens),0) AS input_tokens,
                   COALESCE(SUM(output_tokens),0) AS output_tokens,
                   COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
                   {self._SQL_TOTAL} AS tokens,
                   COALESCE(SUM(cache_read),0) AS cache_read,
                   COALESCE(SUM(cost_micros),0) AS cost_micros
            FROM turn_usage WHERE created_at >= ?
            GROUP BY date ORDER BY date ASC
        """, (since,)).fetchall()
        return [dict(r) for r in rows]

    def usage_recent_turns(self, limit=30, days=30):
        """The NEWEST turns in the window, newest first.

        The turn-by-turn chart is about "what just happened"; ASC here used to
        hand back the OLDEST rows in the range and the chart drew month-old
        turns as if they were the latest ones. Callers that want chronological
        left-to-right order reverse the list themselves.
        """
        since = int(time.time()) - days * 86400
        rows = self._db("usage").execute("""
            SELECT id, session_id, turn_id, model_id,
                   input_tokens, output_tokens, reasoning_tokens,
                   cost_micros, latency_ms, created_at
            FROM turn_usage WHERE created_at >= ?
            ORDER BY created_at DESC LIMIT ?
        """, (since, limit)).fetchall()
        return [dict(r) for r in rows]

    def usage_by_model(self, days=30):
        """Per-MODEL totals + share of the period's tokens, requests, and costs.

        Grouped by the model, not by the raw ``provider_id:model_id`` string the
        router writes. Those are not the same thing: the same model reached
        through three provider entries — a registered `longcat`, the
        config.json-seeded `__config__`, and a legacy `openai` row — used to come
        back as three rows splitting one model's spend into 53% / 39% / 7%. That
        reads as three models to anyone looking at the panel, and no user thinks
        of their credential plumbing as a unit of consumption.

        The provider is not discarded, it is demoted: each row carries a
        ``sources`` list so the breakdown is still there for whoever wants to
        know which access path served what. Callers that need human-readable
        provider names resolve them through the registry — this layer has no
        business inventing display strings, which is how a hardcoded
        "LongCat-2.0" default ended up here and would have mislabelled every
        other user's models.
        """
        since = int(time.time()) - days * 86400
        rows = self._db("usage").execute(f"""
            SELECT model_id,
                   COUNT(*) AS requests,
                   COALESCE(SUM(input_tokens),0)  AS input_tokens,
                   COALESCE(SUM(output_tokens),0) AS output_tokens,
                   COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
                   COALESCE(SUM(cost_micros),0) AS cost_micros,
                   {self._SQL_TOTAL} AS tokens
            FROM turn_usage WHERE created_at >= ?
            GROUP BY model_id ORDER BY tokens DESC
        """, (since,)).fetchall()

        aggregated: dict[str, dict] = {}
        for r in rows:
            d = dict(r)
            provider_id, model_id = split_usage_model_id(d.get("model_id", ""))
            if not model_id:
                # Legacy/broken rows with no model still spent real tokens.
                # Skipping them made this panel's totals silently smaller than
                # the summary's — group them so the two sides reconcile.
                model_id = "(unknown)"
            entry = aggregated.get(model_id)
            if entry is None:
                entry = aggregated[model_id] = {
                    "model_id": model_id,
                    "raw_model_id": str(d.get("model_id") or "").strip(),
                    "requests": 0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "reasoning_tokens": 0,
                    "cost_micros": 0,
                    "tokens": 0,
                    "sources": [],
                }
            counts = {
                "requests": int(d.get("requests") or 0),
                "input_tokens": int(d.get("input_tokens") or 0),
                "output_tokens": int(d.get("output_tokens") or 0),
                "reasoning_tokens": int(d.get("reasoning_tokens") or 0),
                "cost_micros": int(d.get("cost_micros") or 0),
                "tokens": int(d.get("tokens") or 0),
            }
            for k, v in counts.items():
                entry[k] += v
            entry["sources"].append({"provider_id": provider_id, **counts})

        out = sorted(aggregated.values(), key=lambda x: x["tokens"], reverse=True)
        total = sum(r["tokens"] for r in out) or 1
        for r in out:
            r["share"] = round(r["tokens"] / total, 4)
            r["sources"].sort(key=lambda s: s["tokens"], reverse=True)
        return out

    def save_memory_entry(self, eid, sid, root, scope, content, emb=None, meta=None, mem_type='fact', importance=0.5, tags=None, archived=0, tier='semantic', hits=None, accessed_at=None, status=None, confidence=None, created_by=None, valid_until=None, version=None, sensitivity=None, source_goal_id=None, source_event_ids=None, valid_from=None, supersedes=None):
        """Upsert a memory row, preserving tier/hits/accessed_at on update.

        The tier & hit counter are what promotion (C1) reads back, so we cannot
        clobber them by re-saving a row from an old code path that didn't know
        about those fields. Existing values are pulled first and only overridden
        when the caller passes a non-None argument.

        0013 的生命周期列走同一条规矩，而且这里**必须**这么做：这是
        ``INSERT OR REPLACE``，也就是删了再插——任何没有在 VALUES 里列出的列都会
        回到默认值。所以一次纯粹的"改内容"如果不带上 status / confidence /
        last_confirmed_at，就会静默把"这条已过期"改回"生效中"、把用户调高的置信度
        打回 0.5。老代码路径不知道这些列，因此默认全部沿用行里已有的值。
        """
        c = self._db("memory"); now = int(time.time())
        tags_json = json.dumps(tags or [], ensure_ascii=False)
        row = c.execute(
            "SELECT tier, hits, accessed_at, created_at, status, confidence,"
            " created_by, version, superseded_by, valid_until, last_confirmed_at,"
            " status_reason, sensitivity, source_goal_id, source_event_ids,"
            " valid_from, conflict_set, supersedes FROM memory_entries WHERE id=?",
            (eid,),
        ).fetchone()
        superseded_by = ""
        status_reason = ""
        conflict_set = "[]"
        if row is not None:
            existing = dict(row)
            if tier is None or tier == 'semantic':
                # Caller left tier at its default; keep whatever the row had.
                tier = existing.get("tier") or tier
            if hits is None:
                hits = int(existing.get("hits") or 0)
            if accessed_at is None:
                accessed_at = int(existing.get("accessed_at") or 0)
            created = int(existing.get("created_at") or now)
            if status is None:
                status = str(existing.get("status") or "active")
            if confidence is None:
                confidence = existing.get("confidence")
                confidence = 0.5 if confidence is None else float(confidence)
            if created_by is None:
                created_by = str(existing.get("created_by") or "")
            if version is None:
                version = int(existing.get("version") or 1)
            if valid_until is None:
                valid_until = int(existing.get("valid_until") or 0)
            superseded_by = str(existing.get("superseded_by") or "")
            status_reason = str(existing.get("status_reason") or "")
            last_confirmed = int(existing.get("last_confirmed_at") or 0) or created
            # 0014 的来源列同样必须沿用：INSERT OR REPLACE 会把没列出来的列打回
            # 默认值，一次改内容就能把"这条是从哪来的"整块抹掉。
            if sensitivity is None:
                sensitivity = str(existing.get("sensitivity") or "public")
            if source_goal_id is None:
                source_goal_id = str(existing.get("source_goal_id") or "")
            if source_event_ids is None:
                source_event_ids = existing.get("source_event_ids") or "[]"
            if valid_from is None:
                valid_from = int(existing.get("valid_from") or 0) or created
            conflict_set = existing.get("conflict_set") or "[]"
            # 待批合并指向哪几条，只有提出合并的那次调用会带；普通改内容必须沿用，
            # 否则一次编辑就把"这条要替掉谁"抹掉，批准时不知道该归档什么。
            if supersedes is None:
                supersedes = existing.get("supersedes") or "[]"
        else:
            if hits is None:
                hits = 0
            if accessed_at is None:
                accessed_at = 0
            created = now
            status = str(status or ("archived" if archived else "active"))
            confidence = 0.5 if confidence is None else float(confidence)
            created_by = str(created_by or "")
            version = int(version or 1)
            valid_until = int(valid_until or 0)
            # 新写下的记忆在此刻是被确认过的：这是它唯一一次"刚刚成立"。
            last_confirmed = now
            sensitivity = str(sensitivity or "public")
            source_goal_id = str(source_goal_id or "")
            source_event_ids = source_event_ids or "[]"
            # 没说从什么时候开始成立，就是从现在开始。留 0 会让区间判断没法解释。
            valid_from = int(valid_from or 0) or now
        if not isinstance(source_event_ids, str):
            source_event_ids = json.dumps(list(source_event_ids or []),
                                          ensure_ascii=False)
        if not isinstance(supersedes, str):
            supersedes = json.dumps([str(x) for x in (supersedes or [])],
                                    ensure_ascii=False)
        c.execute(
            "INSERT OR REPLACE INTO memory_entries "
            "(id,session_id,root_dir,scope,content,embedding,metadata,created_at,updated_at,"
            "type,importance,tags,archived,tier,hits,accessed_at,"
            "status,confidence,created_by,version,superseded_by,valid_until,"
            "last_confirmed_at,status_reason,"
            "sensitivity,source_goal_id,source_event_ids,valid_from,conflict_set,supersedes) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (eid, sid, root, scope, content, emb,
             json.dumps(meta or {}, ensure_ascii=False),
             created, now, mem_type, importance, tags_json, archived,
             tier or 'semantic', int(hits), int(accessed_at),
             str(status), float(confidence), str(created_by), int(version),
             superseded_by, int(valid_until), int(last_confirmed), status_reason,
             str(sensitivity), str(source_goal_id), source_event_ids,
             int(valid_from), conflict_set, supersedes),
        )
        c.commit()
        # C2: keep the lexical index in step. Archived rows are removed from FTS
        # rather than filtered at query time — an archived memory must not be
        # able to consume an over-sampled candidate slot that a live one needs.
        if archived or str(status) not in self.RECALLABLE_MEMORY_STATUSES:
            self._fts_delete(eid)
        else:
            self._fts_upsert(eid, root, content)

    # ── C2 FTS5 lexical index ──────────────────────────────────────────
    def _fts_upsert(self, eid, root, content):
        """Replace this entry's row in ``memory_fts`` with its tokenized form.

        Delete-then-insert because FTS5 has no UPSERT: without the delete, every
        re-save would append a duplicate posting list and the same memory would
        occupy several candidate slots in one search.
        """
        if not self._fts_enabled:
            return
        try:
            from rust_adapters.memory_retrieval import fts_document
            body = fts_document(content or "")
        except Exception:
            return
        c = self._db("memory")
        try:
            c.execute("DELETE FROM memory_fts WHERE entry_id=?", (eid,))
            if body:
                c.execute(
                    "INSERT INTO memory_fts (body, root_dir, entry_id) VALUES (?,?,?)",
                    (body, root or "", eid),
                )
            c.commit()
        except sqlite3.OperationalError:
            # A corrupt or missing FTS table must not take down memory writes;
            # the authoritative text is already committed to memory_entries.
            self._fts_enabled = False

    def _fts_delete(self, eid):
        """Drop an entry from the lexical index (archive / forget)."""
        if not self._fts_enabled:
            return
        try:
            c = self._db("memory")
            c.execute("DELETE FROM memory_fts WHERE entry_id=?", (eid,))
            c.commit()
        except sqlite3.OperationalError:
            self._fts_enabled = False

    def rebuild_memory_fts(self, root=None):
        """Backfill the lexical index from ``memory_entries``.

        Needed in two situations: the FTS table was created after rows already
        existed (every upgrading install), and the bigram scheme changed (the
        stored ``body`` is derived, so it must be regenerated, not migrated).
        Returns the number of rows indexed.
        """
        if not self._fts_enabled:
            return 0
        try:
            from rust_adapters.memory_retrieval import fts_document
        except Exception:
            return 0
        c = self._db("memory")
        # 只索引"现在还能用"的行。用 archived=0 会把过期和被否决的记忆重新灌回
        # 索引里——set_memory_status 刚把它们从索引删掉，一次重建就复活了。
        live, live_params = self._memory_live_sql()
        if root:
            rows = c.execute(
                "SELECT id, root_dir, content FROM memory_entries "
                f"WHERE {live} AND root_dir=?", (*live_params, root)
            ).fetchall()
        else:
            rows = c.execute(
                f"SELECT id, root_dir, content FROM memory_entries WHERE {live}",
                live_params
            ).fetchall()
        try:
            if root:
                c.execute("DELETE FROM memory_fts WHERE root_dir=?", (root,))
            else:
                c.execute("DELETE FROM memory_fts")
            n = 0
            for r in rows:
                body = fts_document(r["content"] or "")
                if not body:
                    continue
                c.execute(
                    "INSERT INTO memory_fts (body, root_dir, entry_id) VALUES (?,?,?)",
                    (body, r["root_dir"] or "", r["id"]),
                )
                n += 1
            c.commit()
            return n
        except sqlite3.OperationalError:
            self._fts_enabled = False
            return 0

    def search_memory_fts(self, root, match_query, limit=20, session_id=None, branch_id=None):
        """Lexical channel: BM25-ranked entry ids for an FTS5 MATCH expression.

        Returns ``{entry_id: score}`` where a *higher* score is better. FTS5's
        ``bm25()`` returns negative values (more negative = better match), so it
        is negated here — every consumer downstream assumes higher-is-better and
        one inverted channel would rank the worst matches first.

        Scoping:
        Joins `memory_entries` to guarantee lexical top-K matches at SQL layer
        filter by live status, workspace root, session scope, and branch.
        """
        if not self._fts_enabled or not match_query:
            return {}
        try:
            live, live_params = self._memory_live_sql("m.")
            scope_clause = "(m.scope != 'session' OR (m.scope = 'session' AND m.session_id = ?))" if session_id else "(m.scope != 'session')"
            scope_params = [session_id] if session_id else []
            branch_clause = "AND (m.branch_id = '' OR m.branch_id IS NULL OR m.branch_id = ?)" if branch_id else ""
            branch_params = [branch_id] if branch_id else []

            query_sql = (
                "SELECT f.entry_id, bm25(memory_fts) AS rank "
                "FROM memory_fts f "
                "JOIN memory_entries m ON m.id = f.entry_id "
                f"WHERE memory_fts MATCH ? AND f.root_dir = ? AND {live} AND {scope_clause} {branch_clause} "
                "ORDER BY rank LIMIT ?"
            )
            params = (match_query, root or "", *live_params, *scope_params, *branch_params, int(limit))
            rows = self._db("memory").execute(query_sql, params).fetchall()
        except sqlite3.OperationalError as e:
            # Strictly fail-closed: Never fall back to an un-scoped query when session/branch scope is requested
            import logging
            logging.getLogger("storage").warning("search_memory_fts scoped query failed (fail-closed): %s", e)
            return {}
        return {r["entry_id"]: -float(r["rank"] or 0.0) for r in rows}


    def touch_memory_hit(self, eid):
        """Bump ``hits`` and ``accessed_at`` when a memory is recalled.

        Cheap enough to call on every retrieval — that is exactly the signal
        promotion looks at, and losing it would freeze the whole hierarchy.
        """
        now = int(time.time())
        self._db("memory").execute(
            "UPDATE memory_entries SET hits = COALESCE(hits, 0) + 1, accessed_at = ? WHERE id = ?",
            (now, eid),
        )
        self._db("memory").commit()

    def set_memory_tier(self, eid, tier):
        """Move a memory to a new tier (used by promotion / demotion sweeps)."""
        self._db("memory").execute(
            "UPDATE memory_entries SET tier = ?, updated_at = ? WHERE id = ?",
            (str(tier), int(time.time()), eid),
        )
        self._db("memory").commit()

    def expire_memories_by_tier(self, root, tier, older_than):
        """Archive rows in ``tier`` whose last touch is older than ``older_than``.

        Used for the SHORT_TERM_RECALL / DREAMING sweeps. Archive rather than
        delete so a wrong TTL doesn't lose data outright — the row can still be
        undeleted from the settings page.
        """
        now = int(time.time())
        # Collect ids first: after the UPDATE the predicate no longer matches, so
        # the lexical index would keep serving rows that are no longer live.
        expiring = [
            r["id"] for r in self._db("memory").execute(
                "SELECT id FROM memory_entries "
                "WHERE root_dir = ? AND tier = ? AND archived = 0 "
                "AND COALESCE(NULLIF(accessed_at, 0), updated_at) < ?",
                (root, str(tier), int(older_than)),
            ).fetchall()
        ]
        self._db("memory").execute(
            "UPDATE memory_entries SET archived = 1, updated_at = ?,"
            # status 必须跟着走。只写 archived 会留下"archived=1 但 status=active"
            # 的行：设置页说已归档，召回过滤看 status 却认为还生效。
            " status = 'archived', status_reason = 'tier_ttl_expired' "
            "WHERE root_dir = ? AND tier = ? AND archived = 0 "
            "AND COALESCE(NULLIF(accessed_at, 0), updated_at) < ?",
            (now, root, str(tier), int(older_than)),
        )
        self._db("memory").commit()
        # Rows just archived must leave the lexical index too — an FTS hit on an
        # archived row would break the "archived=0" contract search assumes.
        for eid in expiring:
            self._fts_delete(eid)

    def _memory_live_sql(self, prefix: str = "") -> tuple:
        """"这条现在还能用"的 WHERE 片段 + 参数。

        一个地方定义"能用"，所有读路径共用，否则每次加一个状态就要去六处 SQL
        里各改一遍，漏掉的那一处就是"我明明把它标成过期了，它还在被召回"。

        能用 = 状态是 active（或 0013 之前的空值）且落在有效区间内。
        candidate 不算：没被批准的东西不该进 prompt。

        0014 把 ``valid_from`` 也加进来：一条"下个季度开始改用 pnpm"的事实在写下的
        当时**还没生效**，把它当成当前事实注入会让模型基于一个未来才成立的前提
        推理。迁移把老行的 valid_from 兜底成 created_at，所以这一项对历史数据是
        恒真的，不会让任何现存记忆突然消失。
        """
        p = prefix or ""
        now = int(time.time())
        return (f"COALESCE({p}status,'active') IN ('active','')"
                f" AND (COALESCE({p}valid_until,0)=0 OR {p}valid_until>?)"
                f" AND (COALESCE({p}valid_from,0)=0 OR {p}valid_from<=?)",
                [now, now])

    def get_memory_entries(self, root=None, mem_type=None, include_archived=False, limit=100, since=None):
        """Query memory entries with filters.

        ``limit=None`` (or any value <= 0) removes the ``LIMIT`` clause and
        returns *every* matching row. Callers that show aggregate stats (counts,
        per-tier token totals) MUST pass ``limit=None`` — a positive cap there
        silently under-reports the moment the store grows past it, and a stat
        that quietly stops counting is worse than no stat, because it looks
        authoritative. Interactive listings still pass a real cap.
        """
        c = self._db("memory")
        conditions = []
        params = []
        if root:
            conditions.append("root_dir = ?"); params.append(root)
        if mem_type:
            conditions.append("type = ?"); params.append(mem_type)
        if not include_archived:
            live, live_params = self._memory_live_sql()
            conditions.append(live); params.extend(live_params)
        if since:
            conditions.append("created_at >= ?"); params.append(since)
        where = " AND ".join(conditions) if conditions else "1=1"
        unbounded = limit is None or (isinstance(limit, int) and limit <= 0)
        if unbounded:
            r = c.execute(f"SELECT * FROM memory_entries WHERE {where} ORDER BY created_at DESC", params).fetchall()
        else:
            params.append(limit)
            r = c.execute(f"SELECT * FROM memory_entries WHERE {where} ORDER BY created_at DESC LIMIT ?", params).fetchall()
        return [dict(x) for x in r]

    def list_memory_roots(self, include_archived=False):
        """Which workspaces actually hold memories, most-populated first.

        The `workspaces` table answers "where has the user worked"; this answers
        "where is there something to edit". They diverge: a workspace opened once
        and never talked to has no memories, and memories written before a folder
        was formally registered still have a root_dir. The settings picker needs
        the union, so it asks both.
        """
        c = self._db("memory")
        where = "" if include_archived else "WHERE archived = 0"
        rows = c.execute(
            f"SELECT root_dir, COUNT(*) AS n FROM memory_entries {where} "
            "GROUP BY root_dir ORDER BY n DESC"
        ).fetchall()
        return [
            {"root": (dict(x).get("root_dir") or ""), "count": int(dict(x).get("n") or 0)}
            for x in rows
        ]

    #: 一条记忆可能的处境。分开的理由是它们的后果不同：candidate 还没被批准，
    #: 不该进 prompt；stale 过期了，可以给人看但不该再当事实用；rejected 是
    #: "这是错的"，必须留成墓碑，否则下一次 Dream 会把同一条捡回来；archived
    #: 只是"先收起来"，用户可以拿回去。
    MEMORY_STATUSES: tuple = ("candidate", "active", "stale", "rejected", "archived")

    #: 允许的状态转移。rejected 只能走向 archived——"这是错的"不该被一次自动
    #: 流程改回 active；archived 可以回到 active，因为"收起来"和"是错的"不是
    #: 一回事，误收的必须能拿回来。
    _MEMORY_TRANSITIONS: dict = {
        "candidate": {"active", "rejected", "archived"},
        "active": {"stale", "rejected", "archived"},
        "stale": {"active", "rejected", "archived"},
        "rejected": {"archived"},
        "archived": {"active"},
    }

    #: 只有这些状态能进 Router 的 prompt。空字符串是 0013 之前的老行，按 active
    #: 处理——迁移已经把它们翻译过一遍，这里是双保险。
    RECALLABLE_MEMORY_STATUSES: tuple = ("active", "")

    #: "没有更好的信号时按什么排"。confidence 排在 importance 之前：一条大概是错的
    #: 记忆，再重要也不该先被注入。COALESCE 是必需的，0013 之前的行这一列是 NULL，
    #: 而 SQLite 里 NULL 在 DESC 排序里会跑到最后——那会让所有老行沉底。
    MEMORY_TRUST_ORDER: str = ("COALESCE(confidence,0.5) DESC,"
                               " importance DESC, updated_at DESC")

    def set_memory_status(self, eid, status, *, reason: str = "",
                          superseded_by: str = "") -> bool:
        """改一条记忆的处境。非法转移会出声并拒绝，返回是否真的改了。

        同时维护 ``archived`` 列和 FTS 索引，避免"状态说归档、archived 说没有"
        或者"状态说否决、全文检索还能搜到"这种两个事实源互相打脸。
        """
        want = str(status or "")
        if want not in self.MEMORY_STATUSES:
            log.error("[storage] set_memory_status: unknown status %r for %s",
                      want, eid)
            return False
        c = self._db("memory")
        row = c.execute(
            "SELECT root_dir, content, status, archived FROM memory_entries"
            " WHERE id=?", (eid,)).fetchone()
        if row is None:
            log.error("[storage] set_memory_status: no such memory %s", eid)
            return False
        cur = dict(row)
        now_status = str(cur.get("status") or
                         ("archived" if int(cur.get("archived") or 0) else "active"))
        if now_status == want:
            return True  # 幂等：重复标同一个状态不是错误
        allowed = self._MEMORY_TRANSITIONS.get(now_status, set())
        if want not in allowed:
            log.error("[storage] refused memory status %s → %s on %s"
                      " (allowed: %s) — the write did NOT happen",
                      now_status, want, eid, sorted(allowed) or "none")
            return False
        now = int(time.time())
        c.execute(
            "UPDATE memory_entries SET status=?, status_reason=?, superseded_by=?,"
            " archived=?, updated_at=?,"
            " last_confirmed_at=CASE WHEN ?='active' THEN ? ELSE last_confirmed_at END"
            " WHERE id=?",
            (want, str(reason or ""), str(superseded_by or ""),
             1 if want == "archived" else 0, now, want, now, eid),
        )
        c.commit()
        if want in self.RECALLABLE_MEMORY_STATUSES:
            self._fts_upsert(eid, cur.get("root_dir") or "", cur.get("content") or "")
        else:
            self._fts_delete(eid)
        return True

    #: 置信度的边界。不允许 0 和 1：0 等于"确定是错的"（那该 reject，不是留着
    #: 一条置信度为 0 的记忆继续参与排序），1 等于"永远不会错"，而任何一条从对话
    #: 里提取出来的事实都不配拿到这个数。
    MEMORY_CONFIDENCE_FLOOR: float = 0.05
    MEMORY_CONFIDENCE_CEIL: float = 0.95

    def adjust_memory_confidence(self, eid, delta, *, reason: str = "") -> float:
        """把一条记忆的置信度挪 ``delta``，钳在 [floor, ceil] 内，返回新值。

        返回新值而不是 bool，因为调用方（用户点"更可信"、Dream 复核）需要把
        结果显示出来；-1.0 表示这条记忆不存在。
        """
        c = self._db("memory")
        row = c.execute("SELECT confidence FROM memory_entries WHERE id=?",
                        (eid,)).fetchone()
        if row is None:
            log.error("[storage] adjust_memory_confidence: no such memory %s", eid)
            return -1.0
        try:
            cur = float(dict(row).get("confidence") or 0.5)
        except (TypeError, ValueError):
            cur = 0.5
        new = max(self.MEMORY_CONFIDENCE_FLOOR,
                  min(self.MEMORY_CONFIDENCE_CEIL, cur + float(delta or 0.0)))
        c.execute("UPDATE memory_entries SET confidence=?, status_reason=CASE"
                  " WHEN ?<>'' THEN ? ELSE status_reason END, updated_at=?"
                  " WHERE id=?",
                  (new, str(reason or ""), str(reason or ""),
                   int(time.time()), eid))
        c.commit()
        return new

    def confirm_memory(self, eid, *, delta: float = 0.05) -> bool:
        """"这条现在还成立"——刷新最后确认时间，顺手给一点置信度。

        新鲜度看的是最后确认时间而不是创建时间：一条三年前写下、上周刚被确认过
        的事实，比一条上个月写下、之后再没人提过的更可信。
        """
        c = self._db("memory")
        cur = c.execute("SELECT id FROM memory_entries WHERE id=?", (eid,)).fetchone()
        if cur is None:
            return False
        c.execute("UPDATE memory_entries SET last_confirmed_at=?, updated_at=?"
                  " WHERE id=?", (int(time.time()), int(time.time()), eid))
        c.commit()
        if delta:
            self.adjust_memory_confidence(eid, delta, reason="confirmed")
        return True

    def sweep_expired_memories(self, root=None) -> int:
        """把过了 ``valid_until`` 的 active 记忆落成 stale，返回条数。

        读路径本身也会跳过过期行（惰性判断，见 ``_memory_live_sql``），这里做的
        是把这个判断**写下来**：UI 上那条记忆应该显示"已过期"，而不是每次读的时候
        才被悄悄跳过、界面上却仍然是"生效中"。
        """
        now = int(time.time())
        c = self._db("memory")
        sql = ("SELECT id FROM memory_entries WHERE valid_until>0 AND valid_until<?"
               " AND COALESCE(status,'active')='active'")
        params: list = [now]
        if root:
            sql += " AND root_dir=?"; params.append(str(root))
        rows = [dict(r).get("id") for r in c.execute(sql, params).fetchall()]
        n = 0
        for eid in rows:
            if self.set_memory_status(eid, "stale", reason="valid_until_passed"):
                n += 1
        return n

    def archive_memory(self, eid):
        """Mark a memory entry as archived.

        保留这个名字是因为调用方（UI 的删除、引导文件裁决后的清理）都在用它；
        实现改走 :meth:`set_memory_status`，这样归档和其他状态变更走同一条路，
        不会出现"归档更新了 archived 但没更新 status"。
        """
        if not self.set_memory_status(eid, "archived", reason="archive_memory"):
            # 转移被拒（例如已经是 rejected 之外的终态）时也要保证旧契约成立：
            # 调用方点了删除，界面上就不该再出现它。
            c = self._db("memory")
            c.execute("UPDATE memory_entries SET archived=1, updated_at=? WHERE id=?",
                      (int(time.time()), eid))
            c.commit()
            self._fts_delete(eid)

    #: How many live rows a content lookup will scan. The memory table is small
    #: (thousands at most) and this path runs once per human adjudication, so a
    #: full-ish scan is fine — but it still gets a ceiling rather than none.
    MEMORY_CONTENT_SCAN_LIMIT: int = 2000

    def list_memories_needing_review(self, root, limit=20):
        """该被整理但永远不会被"最近 24 小时"捞到的那些行。

        §10.1：Dream 原来只读 ``get_memory_entries(since=now-86400)``——既限最近，
        又限"活着"。两个限制叠起来的结果是它**只看新增**：一条上周就和别人矛盾的
        记忆、一条已经过期的事实，从第二天起就再也进不了任何一趟整合的视野，而这
        两类恰恰是最需要被整理的。放着不管，冲突只会越堆越多。

        三类：
        - ``conflict_set`` 非空——有活记忆和它对着说
        - ``status='stale'``——标了过时但还没人决定怎么办
        - ``valid_until`` 已经过去——过了有效期，读路径已经不召回它了

        故意排除 ``supersedes`` 非空的行：那是 Dream 自己提的待审提案。把它喂回去
        会让它提议合并自己的提案，一趟接一趟地叠，用户面前的待审列表变成噪音。
        archived / rejected 也排除——用户已经处置过的东西不该被翻出来重提。
        """
        now = int(time.time())
        rows = self._db("memory").execute(
            "SELECT * FROM memory_entries WHERE root_dir=? AND archived=0"
            " AND COALESCE(status,'active') NOT IN ('archived','rejected')"
            " AND COALESCE(supersedes,'[]') IN ('','[]')"
            " AND (COALESCE(conflict_set,'[]') NOT IN ('','[]')"
            "      OR COALESCE(status,'')='stale'"
            "      OR (COALESCE(valid_until,0)>0 AND valid_until<=?))"
            " ORDER BY updated_at DESC LIMIT ?",
            (str(root or ""), now, int(limit)),
        ).fetchall()
        return [dict(r) for r in rows]

    def find_conflicting_memories(self, root, text, limit=8):
        """活记忆里与 ``text`` **直接矛盾**的那些 id。

        判据只有一条，而且是可判定的：去掉否定词之后内容等价，但一边有否定、
        另一边没有。"项目用 pnpm" vs "项目不用 pnpm" 命中；"项目用 pnpm" vs
        "项目用 npm" 不命中——后者是两个不同的陈述，可能都对（monorepo 里两个包
        用不同的包管理器），把它判成矛盾会让冲突视图开始虚报，而一个偶尔虚报的
        冲突视图用户会直接无视。

        自由文本做不到断言那样的结构化冲突检测，所以这里只捡这一个确定的情形，
        剩下的留给用户和 Dream。宁可漏，不可虚报。
        """
        from wiki_store import has_negation

        def _strip(s: str) -> str:
            """去否定词 + 去空白标点小写。两条只差一个'不'的句子在这里同形。"""
            t = re.sub(r"(?:不|非|没有|没|无|别|莫)", "", str(s or ""))
            t = re.sub(r"\b(?:not|no|never|isn't|aren't|doesn't|don't|won't|"
                       r"cannot|can't|no\s+longer)\b", "", t, flags=re.IGNORECASE)
            return re.sub(r"[\s\W_]+", "", t.lower())

        key = _strip(text)
        if not key:
            return []
        want_neg = has_negation(text)
        live, live_params = self._memory_live_sql()
        rows = self._db("memory").execute(
            f"SELECT id, content FROM memory_entries WHERE root_dir=? AND {live}"
            " ORDER BY updated_at DESC LIMIT ?",
            (str(root or ""), *live_params, int(self.MEMORY_CONTENT_SCAN_LIMIT)),
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            body = d.get("content") or ""
            if _strip(body) != key:
                continue
            if has_negation(body) == want_neg:
                continue  # 同形同极性 = 重复，不是矛盾；由去重那条路处理
            out.append(d.get("id"))
            if len(out) >= int(limit):
                break
        return out

    def link_memory_conflict(self, a_id, b_id) -> bool:
        """把两条记忆标成互相矛盾。对称写，双方都要指向对方。

        只写关系，不改状态：谁该降级是调用方（写入闸门 / Dream / 用户）的决定，
        库这一层不替它选。单边写会让"从另一条打开时看不到分歧"，那比没有这个字段
        更糟——用户以为已经没有冲突了。
        """
        if not a_id or not b_id or a_id == b_id:
            return False
        c = self._db("memory")
        now = int(time.time())
        # 先把两端都查出来，再动手写。边查边写的话，"a 存在、b 不存在"会在 a 上留下
        # 一条指向不存在记忆的单边关系——冲突视图从此报一个永远打不开的对手方。
        rows = {}
        for eid in (a_id, b_id):
            row = c.execute("SELECT conflict_set FROM memory_entries WHERE id=?",
                            (eid,)).fetchone()
            if row is None:
                log.error("[storage] link_memory_conflict: no such memory %s", eid)
                return False
            rows[eid] = dict(row).get("conflict_set") or "[]"
        changed = False
        for me, other in ((a_id, b_id), (b_id, a_id)):
            try:
                cur = json.loads(rows[me])
                cur = [str(x) for x in cur] if isinstance(cur, list) else []
            except (ValueError, TypeError):
                cur = []
            if other in cur:
                continue
            cur.append(other)
            c.execute("UPDATE memory_entries SET conflict_set=?, updated_at=?"
                      " WHERE id=?",
                      (json.dumps(sorted(set(cur)), ensure_ascii=False), now, me))
            changed = True
        if changed:
            c.commit()
        return True

    def clear_memory_supersedes(self, eid) -> bool:
        """合并提案落地（或被驳回）之后清掉 ``supersedes``。

        留着它会让这条永远出现在"待批合并"列表里——用户批准过一次，第二天又被
        问同一个问题，这比没有提案机制更让人不信任它。
        """
        c = self._db("memory")
        cur = c.execute("SELECT id FROM memory_entries WHERE id=?", (eid,)).fetchone()
        if cur is None:
            return False
        c.execute("UPDATE memory_entries SET supersedes='[]', updated_at=?"
                  " WHERE id=?", (int(time.time()), eid))
        c.commit()
        return True

    # ── Phase 59 内化: 实体关系图谱方法 (GraphMemoryEngine) ───────────────
    def upsert_graph_entity(self, root_dir: str, name: str, entity_type: str = "Concept",
                            properties: Optional[dict] = None) -> str:
        """插入或更新一个图谱命名实体。"""
        c = self._db("memory")
        now = int(time.time())
        props_json = json.dumps(properties or {}, ensure_ascii=False)
        root = str(root_dir or "")
        
        row = c.execute(
            "SELECT id FROM graph_entities WHERE name=? AND root_dir=?",
            (name, root)
        ).fetchone()
        
        if row:
            eid = row["id"]
            c.execute(
                "UPDATE graph_entities SET type=?, properties_json=?, updated_at=? WHERE id=?",
                (entity_type, props_json, now, eid)
            )
        else:
            eid = uuid.uuid4().hex[:16]
            c.execute(
                "INSERT INTO graph_entities (id, root_dir, type, name, properties_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (eid, root, entity_type, name, props_json, now, now)
            )
        c.commit()
        return eid

    def upsert_graph_relation(self, root_dir: str, source_name: str, target_name: str,
                              relation_type: str, confidence: float = 1.0,
                              source_type: str = "Concept", target_type: str = "Concept") -> str:
        """建立两个实体之间的有向关系边。"""
        c = self._db("memory")
        now = int(time.time())
        root = str(root_dir or "")
        
        src_id = self.upsert_graph_entity(root, source_name, source_type)
        tgt_id = self.upsert_graph_entity(root, target_name, target_type)
        
        row = c.execute(
            "SELECT id FROM graph_relations WHERE source_id=? AND target_id=? AND relation_type=?",
            (src_id, tgt_id, relation_type)
        ).fetchone()
        
        if row:
            rel_id = row["id"]
            c.execute(
                "UPDATE graph_relations SET confidence=? WHERE id=?",
                (confidence, rel_id)
            )
        else:
            rel_id = uuid.uuid4().hex[:16]
            c.execute(
                "INSERT INTO graph_relations (id, root_dir, source_id, target_id, relation_type, confidence, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (rel_id, root, src_id, tgt_id, relation_type, confidence, now)
            )
        c.commit()
        return rel_id

    def query_related_entities(self, entity_name: str, root_dir: str = "", max_hops: int = 2) -> list[dict]:
        """基于图拓扑关联查询相邻实体与关系。"""
        c = self._db("memory")
        root = str(root_dir or "")
        
        # 查找起点实体
        start_row = c.execute(
            "SELECT id, name, type, properties_json FROM graph_entities WHERE name=? AND (root_dir=? OR root_dir='')",
            (entity_name, root)
        ).fetchone()
        if not start_row:
            return []
            
        start_id = start_row["id"]
        results = []
        
        # 1-hop 邻居查询
        edges = c.execute(
            "SELECT r.relation_type, r.confidence, e.name, e.type, e.properties_json "
            "FROM graph_relations r "
            "JOIN graph_entities e ON r.target_id = e.id "
            "WHERE r.source_id = ?",
            (start_id,)
        ).fetchall()
        
        for edge in edges:
            results.append({
                "source": entity_name,
                "relation": edge["relation_type"],
                "target": edge["name"],
                "target_type": edge["type"],
                "confidence": edge["confidence"],
                "properties": json.loads(edge["properties_json"] or "{}")
            })
            
        # 反向 1-hop 查询
        rev_edges = c.execute(
            "SELECT r.relation_type, r.confidence, e.name, e.type, e.properties_json "
            "FROM graph_relations r "
            "JOIN graph_entities e ON r.source_id = e.id "
            "WHERE r.target_id = ?",
            (start_id,)
        ).fetchall()
        
        for edge in rev_edges:
            results.append({
                "source": edge["name"],
                "relation": edge["relation_type"],
                "target": entity_name,
                "source_type": edge["type"],
                "confidence": edge["confidence"],
                "properties": json.loads(edge["properties_json"] or "{}")
            })
            
        return results

    #: Dream job 租约默认时长。比一趟整合的正常耗时长一截，但远短于"用户会等的
    #: 时间"——崩溃之后最多空转这么久就会被下一趟接管。
    DREAM_LEASE_SECONDS: int = 180

    def claim_dream_run(self, root, idem_key, *, owner: str = "",
                        lease_seconds: int = 0):
        """开一趟 Dream，或者说明为什么不开。返回 ``(job_id, 结论)``。

        结论有四种，调用方必须分开处理：

        * ``new``：这批输入没人做过，job 是新建的。
        * ``resumed``：同一批输入上一趟没跑完而且租约已过期——按幂等键**继续**，
          沿用同一个 job_id，而不是从头再做一遍（§10.3）。
        * ``done``：这批输入已经出过提案了。再跑一遍只会产出重复提案。
        * ``busy``：另一个进程/窗口正拿着活租约在做同一批。

        ``job_id`` 只在前两种情况下非空。
        """
        c = self._db("memory")
        now = int(time.time())
        ttl = int(lease_seconds or self.DREAM_LEASE_SECONDS)
        own = str(owner or PROCESS_GENERATION)
        key = str(idem_key or "")

        if key:
            row = c.execute(
                "SELECT job_id, status, lease_until FROM dream_runs WHERE idem_key=?",
                (key,)).fetchone()
            if row is not None:
                d = dict(row)
                if str(d.get("status")) != "running":
                    return "", "done"
                if int(d.get("lease_until") or 0) > now:
                    return "", "busy"
                # 租约过期 = 上一趟的进程没了。owner 条件保证同时只有一个接管者。
                cur = c.execute(
                    "UPDATE dream_runs SET owner=?, lease_until=?, heartbeat_at=?"
                    " WHERE job_id=? AND status='running' AND COALESCE(lease_until,0)<=?",
                    (own, now + ttl, now, d.get("job_id"), now))
                c.commit()
                if cur.rowcount > 0:
                    return str(d.get("job_id")), "resumed"
                return "", "busy"

        job_id = uuid.uuid4().hex[:16]
        try:
            c.execute(
                "INSERT INTO dream_runs (job_id, root_dir, idem_key, status, owner,"
                " started_at, heartbeat_at, lease_until)"
                " VALUES (?,?,?,'running',?,?,?,?)",
                (job_id, str(root or ""), key, own, now, now, now + ttl))
            c.commit()
        except sqlite3.IntegrityError:
            # 两个进程同时到这里，唯一索引让其中一个失败。这不是错误，是它该等。
            return "", "busy"
        return job_id, "new"

    def heartbeat_dream_run(self, job_id, *, owner: str = "",
                            lease_seconds: int = 0) -> bool:
        """续租。False = 这趟已经不属于我们了，调用方必须立刻停手。

        owner 条件是这句话成立的全部依据：租约过期后被别人接管，我们的续租就会
        打不中任何行。两个进程同时整合同一批记忆会产出两份指向同几行的提案。
        """
        c = self._db("memory")
        now = int(time.time())
        ttl = int(lease_seconds or self.DREAM_LEASE_SECONDS)
        cur = c.execute(
            "UPDATE dream_runs SET heartbeat_at=?, lease_until=?"
            " WHERE job_id=? AND owner=? AND status='running'",
            (now, now + ttl, job_id, str(owner or PROCESS_GENERATION)))
        c.commit()
        return cur.rowcount > 0

    def finish_dream_run(self, job_id, status: str, *, outcome: str = "",
                         proposal_id: str = "", input_count: int = 0,
                         tokens_used: int = 0, wall_ms: int = 0) -> bool:
        """收尾。``status`` ∈ done | failed | cancelled | noop。

        ``outcome`` 是给人看的一句话，也就是 §10.2 的 DreamJournal：这一趟整合了
        什么、为什么什么都没做。失败和 NO_OP 都要写下来——一个只记录成功的日记会
        让"它到底有没有在工作"变成不可回答的问题。
        """
        c = self._db("memory")
        cur = c.execute(
            "UPDATE dream_runs SET status=?, finished_at=?, outcome=?,"
            " proposal_id=?, input_count=?, tokens_used=?, wall_ms=?, lease_until=0"
            " WHERE job_id=?",
            (str(status or "done"), int(time.time()), str(outcome or ""),
             str(proposal_id or ""), int(input_count or 0), int(tokens_used or 0),
             int(wall_ms or 0), job_id))
        c.commit()
        return cur.rowcount > 0

    def cancel_dream_run(self, job_id, *, reason: str = "user_cancelled") -> bool:
        """外部取消。不带 owner 条件——取消是任何人都能提的请求。

        持有者靠续租失败发现自己被取消（状态不再是 running），所以取消是协作式的：
        不会在半个写入中间把它掐断。
        """
        c = self._db("memory")
        cur = c.execute(
            "UPDATE dream_runs SET status='cancelled', finished_at=?, outcome=?,"
            " lease_until=0 WHERE job_id=? AND status='running'",
            (int(time.time()), str(reason or ""), job_id))
        c.commit()
        return cur.rowcount > 0

    def list_dream_runs(self, root=None, limit=20):
        """Dream 日记，最近的在前。给设置页和 §21 的诚实汇报用。"""
        c = self._db("memory")
        sql = "SELECT * FROM dream_runs"
        params: list = []
        if root is not None:
            sql += " WHERE root_dir=?"; params.append(str(root))
        sql += " ORDER BY started_at DESC LIMIT ?"
        params.append(int(limit or 20))
        return [dict(r) for r in c.execute(sql, params).fetchall()]

    def find_memories_by_content(self, root, text, limit=20):
        """未归档记忆里内容与 ``text`` 等价的那些 id。

        存在的理由：用户裁决"项目用 pnpm 而不是 npm"之后，MEMORY.md 里的旧行被
        替换了，可记忆库里那条"用 npm"还在，下一轮照样被召回注入——文件和记忆库
        各说一套，而模型两边都读。

        比较前做归一化（去空白/标点、小写），因为写进引导文件的那行带 "- " 前缀，
        和记忆库里的原文不会字节相同。刻意只认**等价**而不做模糊匹配：归档是有损
        操作，宁可漏掉一条也不要误删一条用户还需要的记忆。
        """
        def _norm(s: str) -> str:
            return re.sub(r"[\s\W_]+", "", str(s or "").lower())

        target = _norm(text)
        if not target:
            return []
        live, live_params = self._memory_live_sql()
        rows = self._db("memory").execute(
            f"SELECT id, content FROM memory_entries WHERE root_dir=? AND {live}"
            " ORDER BY updated_at DESC LIMIT ?",
            (str(root or ""), *live_params, int(self.MEMORY_CONTENT_SCAN_LIMIT)),
        ).fetchall()
        out = []
        for r in rows:
            if _norm(r["content"]) == target:
                out.append(r["id"])
                if len(out) >= int(limit):
                    break
        return out


    def search_memory_hybrid(self, root, query_text="", query_embedding=None,
                             keywords=None, limit=5, vector_weight=None,
                             keyword_weight=None, session_id="", branch_id=""):
        """C2 hybrid retrieval: dense vectors ⊕ FTS5 lexical, fused by weight.

        Both channels are over-sampled by ``memory_retrieval.OVERSAMPLE`` before
        fusion, then min-max normalized so cosine similarity (0..1) and BM25
        (unbounded negatives) become comparable. See ``memory_retrieval`` for the
        0.7/0.3 weighting rationale and the CJK bigram scheme.

        Returns ``(rows, trace)``. Each row carries ``_fused`` / ``_vec_score`` /
        ``_kw_score`` so the caller can re-rank and so "why was this recalled?"
        stays answerable — a retrieval you cannot explain is one you cannot debug
        when the model starts quoting an irrelevant memory.

        Degrades rather than fails: no embedding → lexical only; no FTS5 →
        vector only; neither → importance-ordered recency, same as before C2.
        """
        try:
            from memory_retrieval import (
                OVERSAMPLE, VECTOR_WEIGHT, KEYWORD_WEIGHT, MIN_FUSED_SCORE,
            )
            from rust_adapters.memory_retrieval import (
                build_fts_query, fuse, retrieval_trace, declare_channels,
            )
        except Exception:
            return self.search_memory_semantic(
                root,
                query_embedding=query_embedding,
                keywords=keywords,
                limit=limit,
                session_id=session_id,
                branch_id=branch_id,
            ), []

        pool = max(int(limit) * OVERSAMPLE, int(limit))
        c = self._db("memory")
        live, live_params = self._memory_live_sql()
        scope_clause = "(scope != 'session' OR (scope = 'session' AND session_id = ?))" if session_id else "(scope != 'session')"
        scope_params = [session_id] if session_id else []
        branch_clause = "AND (branch_id = '' OR branch_id IS NULL OR branch_id = ?)" if branch_id else ""
        branch_params = [branch_id] if branch_id else []

        # ── 1. Lexical channel candidate search via FTS5 with SQL-level session/branch scope ──
        kw_scores = self.search_memory_fts(
            root, build_fts_query(query_text or "", keywords), limit=pool,
            session_id=session_id, branch_id=branch_id,
        )
        fts_ids = list(kw_scores.keys())

        # ── 2. Retrieve bounded candidate rows for dense channel ──
        dense_candidate_limit = max(pool * 4, 100)
        base_where = f"root_dir=? AND {live} AND {scope_clause} {branch_clause}"
        all_params = (root, *live_params, *scope_params, *branch_params)

        candidate_rows = c.execute(
            f"SELECT * FROM memory_entries WHERE {base_where} ORDER BY importance DESC, updated_at DESC LIMIT ?",
            (*all_params, dense_candidate_limit)
        ).fetchall()
        rows = {r["id"]: dict(r) for r in candidate_rows}

        # Ensure all FTS hits are included in the evaluation pool
        missing_fts_ids = [fid for fid in fts_ids if fid not in rows]
        if missing_fts_ids:
            placeholders = ",".join("?" * len(missing_fts_ids))
            extra_rows = c.execute(
                f"SELECT * FROM memory_entries WHERE id IN ({placeholders}) AND {base_where}",
                (*missing_fts_ids, *all_params)
            ).fetchall()
            for r in extra_rows:
                rows[r["id"]] = dict(r)

        if not rows:
            return [], []

        # ── dense channel ──
        vec_scores = {}
        if query_embedding is not None:
            for eid, row in rows.items():
                emb = self._decode_embedding(row.get("embedding"))
                if emb:
                    sim = self._cosine(query_embedding, emb)
                    if sim > 0:
                        vec_scores[eid] = sim
            if len(vec_scores) > pool:
                vec_scores = dict(
                    sorted(vec_scores.items(), key=lambda kv: -kv[1])[:pool]
                )

        # Lexical fallback when FTS is empty or keywords provided
        if not kw_scores and keywords:
            for eid, row in rows.items():
                n = self._keyword_score(row.get("content", ""), keywords)
                if n:
                    kw_scores[eid] = float(n)
        kw_scores = {k: v for k, v in kw_scores.items() if k in rows}

        fused = fuse(
            vec_scores, kw_scores,
            vector_weight=VECTOR_WEIGHT if vector_weight is None else vector_weight,
            keyword_weight=KEYWORD_WEIGHT if keyword_weight is None else keyword_weight,
        )
        # Declare what actually ran. `embedding` is a stored blob, so coverage is
        # a cheap truthiness count — no decode needed — and it separates "the
        # vector channel found nothing for this query" from "nothing in this
        # workspace was ever embedded", which is the difference between tuning a
        # query and running a backfill.
        embedded = sum(1 for r in rows.values() if r.get("embedding"))
        channels = declare_channels(
            vec_scores, kw_scores,
            vector_weight=VECTOR_WEIGHT if vector_weight is None else vector_weight,
            keyword_weight=KEYWORD_WEIGHT if keyword_weight is None else keyword_weight,
            embedded_rows=embedded, total_rows=len(rows),
        )
        if not fused:
            # 两个通道都没打中时的兜底：给最重要、最可信、最近动过的那些。
            # 这里以前写的是 archived=0，而 0013 之后"能不能召回"的判据是
            # _memory_live_sql——两个口径不一样，于是这条兜底路径会把已经过期或
            # 被否决的行重新捞回来注入 prompt。
            live, live_params = self._memory_live_sql()
            r = c.execute(
                f"SELECT * FROM memory_entries WHERE root_dir=? AND {live} AND {scope_clause} "
                f"ORDER BY {self.MEMORY_TRUST_ORDER} LIMIT ?",
                (root, *live_params, *scope_params, pool)
            ).fetchall()
            return [dict(x) for x in r], retrieval_trace([], channels=channels)

        out = []
        for eid, score, parts in fused:
            if score < MIN_FUSED_SCORE:
                continue
            row = rows[eid]
            row["_fused"] = round(score, 6)
            row["_vec_score"] = round(parts["vec"], 6)
            row["_kw_score"] = round(parts["kw"], 6)
            row["_channels"] = channels
            out.append(row)
            if len(out) >= pool:
                break
        return out, retrieval_trace(fused, limit=pool, channels=channels)

    def memory_fts_stats(self):
        """Index health: whether FTS5 is live and how many rows are indexed."""
        if not self._fts_enabled:
            return {"enabled": False, "indexed": 0}
        try:
            row = self._db("memory").execute(
                "SELECT COUNT(*) AS n FROM memory_fts"
            ).fetchone()
            return {"enabled": True, "indexed": int(row["n"] or 0)}
        except sqlite3.OperationalError:
            self._fts_enabled = False
            return {"enabled": False, "indexed": 0}

    def memory_embedding_stats(self, root):
        """Dense-channel health for one workspace: how many rows are embedded.

        The panel used to report the nominal 0.7 vector weight regardless of
        whether a single row had a vector. With no embeddings the dense channel
        scores nothing, fusion renormalizes to pure lexical, and MMR diversity
        re-ranking goes inert too — all silently. ``coverage`` is the number that
        says whether hybrid retrieval is actually hybrid here.
        """
        try:
            row = self._db("memory").execute(
                "SELECT COUNT(*) AS total, "
                "SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded "
                "FROM memory_entries WHERE root_dir=? AND archived=0", (root,)
            ).fetchone()
        except sqlite3.OperationalError:
            return {"rows": 0, "embedded": 0, "coverage": 0.0, "vectorUsable": False}
        total = int(row["total"] or 0)
        embedded = int(row["embedded"] or 0)
        return {
            "rows": total,
            "embedded": embedded,
            "coverage": round(embedded / total, 4) if total else 0.0,
            # "Usable" means the channel can contribute at all, not that it is
            # complete — one embedded row out of a thousand is still degraded,
            # which is what `coverage` is for.
            "vectorUsable": embedded > 0,
        }

    def memories_missing_embeddings(self, root, limit=200):
        """Rows in this workspace that never got a vector, oldest first.

        The read half of a backfill: the caller owns the embedder, so it decodes
        nothing here and just gets ids + content to embed.
        """
        try:
            rows = self._db("memory").execute(
                "SELECT id, content FROM memory_entries "
                "WHERE root_dir=? AND archived=0 AND embedding IS NULL "
                "ORDER BY created_at ASC LIMIT ?", (root, int(limit))
            ).fetchall()
        except sqlite3.OperationalError:
            return []
        return [dict(r) for r in rows]

    def set_memory_embedding(self, eid, emb_blob):
        """Attach a computed embedding to an existing row. Backfill write half."""
        try:
            c = self._db("memory")
            c.execute(
                "UPDATE memory_entries SET embedding=? WHERE id=?", (emb_blob, eid)
            )
            c.commit()
            return True
        except sqlite3.OperationalError:
            return False



    def search_memory_semantic(self, root, query_embedding=None, keywords=None, limit=5,
                               session_id="", branch_id=""):
        """Search memory by embedding similarity, with keyword scoring fallback.

        Two paths:
          1. ``query_embedding`` supplied -> cosine similarity over stored
             embeddings (computed in Python; no vector-index dependency).
             Entries without an embedding fall back to keyword scoring.
          2. keywords only -> OR-match with hit-count ranking.

        The previous implementation AND-joined every keyword into the WHERE
        clause, so any query with more than one or two terms matched nothing.
        Now matching is OR-based and results are ranked by how many distinct
        keywords hit, then by importance.
        """
        c = self._db("memory")
        live, live_params = self._memory_live_sql()
        conditions = ["root_dir = ?", live]
        params: list = [root, *live_params]
        if session_id:
            conditions.append("(scope != 'session' OR (scope = 'session' AND session_id = ?))")
            params.append(session_id)
        else:
            conditions.append("(scope != 'session')")
        if branch_id:
            conditions.append("(branch_id = '' OR branch_id IS NULL OR branch_id = ?)")
            params.append(branch_id)
        base_where = " AND ".join(conditions)

        if query_embedding is not None:
            rows = [dict(x) for x in c.execute(
                f"SELECT * FROM memory_entries WHERE {base_where}",
                params
            ).fetchall()]
            scored = []
            for row in rows:
                emb = self._decode_embedding(row.get("embedding"))
                if emb:
                    sim = self._cosine(query_embedding, emb)
                else:
                    sim = 0.4 * self._keyword_score(row.get("content", ""), keywords)
                scored.append((sim, row))
            # 同分时先看可信度再看重要性：两条同样相关的记忆，更可能是对的那条
            # 应该先进 prompt。
            scored.sort(key=lambda t: (-t[0],
                                       -self._trust_of(t[1]),
                                       -(t[1].get("importance") or 0)))
            return [row for sim, row in scored[:limit] if sim > 0]

        if keywords:
            kw_conditions = list(conditions)
            kw_params = list(params)
            ors = " OR ".join(["content LIKE ?"] * len(keywords))
            kw_conditions.append(f"({ors})")
            kw_params.extend(f"%{kw}%" for kw in keywords)
            where = " AND ".join(kw_conditions)
            rows = [dict(x) for x in c.execute(
                f"SELECT * FROM memory_entries WHERE {where}", kw_params
            ).fetchall()]
            rows.sort(key=lambda r: (
                -self._keyword_score(r.get("content", ""), keywords),
                -self._trust_of(r),
                -(r.get("importance") or 0),
                -(r.get("updated_at") or 0),
            ))
            return rows[:limit]

        r = c.execute(f"SELECT * FROM memory_entries WHERE {base_where}"
                      f" ORDER BY {self.MEMORY_TRUST_ORDER} LIMIT ?",
                      (*params, limit)).fetchall()
        return [dict(x) for x in r]

    @staticmethod
    def _trust_of(row) -> float:
        """一行的置信度，缺失/越界时按 0.5。

        0.5 是"不知道"的中点，而且作为排序键对老语料是**均匀**的——所有行都是
        0.5 时这一项不改变任何相对次序，只有真的被调过才开始区分。
        """
        return _rs_trust_of(row)

    # ── Embedding cache ────────────────────────────────────────────────
    #: Rows kept before the least-recently-used ones are pruned. 20k vectors of
    #: 768 float32 ≈ 60MB of BLOB — acceptable for a desktop app, and recall
    #: only ever touches a handful of them per turn.
    EMBEDDING_CACHE_MAX_ROWS = 20000

    @staticmethod
    def embedding_cache_key(provider: str, model: str, text: str) -> str:
        """Stable cache key for one (provider, model, text) triple.

        The text is hashed rather than stored so the cache never becomes a
        second copy of the user's conversation on disk.
        """
        digest = hashlib.sha256((text or "").encode("utf-8")).hexdigest()
        return f"{provider or 'local'}|{model or 'default'}|{digest}"

    def get_cached_embedding(self, provider: str, model: str, text: str) -> Optional[list]:
        """Return a cached vector for this text, or None on a miss.

        A hit records in an in-memory buffer so pruning can evict genuinely cold
        rows without executing a blocking SQLite transaction on the read hot path.
        """
        key = self.embedding_cache_key(provider, model, text)
        c = self._db("memory")
        row = c.execute(
            "SELECT vector FROM embedding_cache WHERE key=?", (key,)
        ).fetchone()
        if row is None or not row["vector"]:
            return None
        try:
            vec = json.loads(bytes(row["vector"]).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            # Corrupt row — drop it so the next call recomputes cleanly.
            c.execute("DELETE FROM embedding_cache WHERE key=?", (key,)); c.commit()
            return None
        if not isinstance(vec, list) or not vec:
            return None

        # Record hit asynchronously in-memory; flush periodically or in batches
        should_flush = False
        with self._emb_hits_lock:
            self._emb_hits_buffer[key] = self._emb_hits_buffer.get(key, 0) + 1
            if len(self._emb_hits_buffer) >= 20:
                should_flush = True
        if should_flush:
            self.flush_embedding_cache_hits()
        return vec

    def flush_embedding_cache_hits(self) -> None:
        """Batch flush in-memory hit counts and last_used_at to SQLite."""
        with self._emb_hits_lock:
            if not self._emb_hits_buffer:
                return
            items = list(self._emb_hits_buffer.items())
            self._emb_hits_buffer.clear()
        try:
            c = self._db("memory")
            now = int(time.time())
            c.executemany(
                "UPDATE embedding_cache SET hits=hits+?, last_used_at=? WHERE key=?",
                [(hits, now, k) for k, hits in items]
            )
            c.commit()
        except Exception:
            pass  # fail-open

    def save_cached_embedding(self, provider: str, model: str, text: str, vector: list) -> None:
        """Store a computed vector. Silently no-ops on an empty vector."""
        if not vector:
            return
        self.flush_embedding_cache_hits()
        key = self.embedding_cache_key(provider, model, text)
        now = int(time.time())
        blob = json.dumps([float(x) for x in vector]).encode("utf-8")
        c = self._db("memory")
        c.execute(
            "INSERT OR REPLACE INTO embedding_cache "
            "(key,provider,model,dim,vector,created_at,last_used_at,hits) "
            "VALUES (?,?,?,?,?,?,?,COALESCE((SELECT hits FROM embedding_cache WHERE key=?),0))",
            (key, provider or "local", model or "default", len(vector), blob, now, now, key),
        ); c.commit()
        self._prune_embedding_cache()

    def _prune_embedding_cache(self) -> None:
        """Evict least-recently-used rows once past the cap."""
        c = self._db("memory")
        row = c.execute("SELECT COUNT(*) AS n FROM embedding_cache").fetchone()
        excess = (row["n"] if row else 0) - self.EMBEDDING_CACHE_MAX_ROWS
        if excess <= 0:
            return
        c.execute(
            "DELETE FROM embedding_cache WHERE key IN ("
            "SELECT key FROM embedding_cache ORDER BY last_used_at ASC LIMIT ?)",
            (excess,),
        ); c.commit()

    def clear_embedding_cache(self, model: Optional[str] = None) -> int:
        """Drop cached vectors — all of them, or just one model's.

        Needed when an embedding model is swapped: the old vectors live in a
        different vector space and comparing across them is meaningless.
        """
        c = self._db("memory")
        if model:
            cur = c.execute("DELETE FROM embedding_cache WHERE model=?", (model,))
        else:
            cur = c.execute("DELETE FROM embedding_cache")
        c.commit()
        return cur.rowcount or 0

    def embedding_cache_stats(self) -> dict:
        """Size / hit summary for the usage dashboard."""
        c = self._db("memory")
        row = c.execute(
            "SELECT COUNT(*) AS rows, COALESCE(SUM(hits),0) AS hits, "
            "COALESCE(MAX(dim),0) AS dim FROM embedding_cache"
        ).fetchone()
        return {
            "rows": row["rows"] if row else 0,
            "hits": row["hits"] if row else 0,
            "dim": row["dim"] if row else 0,
        }

    @staticmethod
    def _keyword_score(content, keywords):
        """Count how many distinct keywords appear in content (case-insensitive)."""
        return _rs_keyword_score(content, keywords)

    @staticmethod
    def _decode_embedding(blob):
        """Decode a stored embedding blob back into a list of floats."""
        return _rs_decode_embedding(blob)

    @staticmethod
    def _cosine(a, b):
        """Cosine similarity between two equal-length float vectors."""
        return _rs_cosine(a, b)


    def save_session_synthesis(self, session_id, synthesis):
        """Save session synthesis (structured JSON)."""
        c = self._db("memory"); now = int(time.time())
        c.execute("INSERT OR REPLACE INTO session_synthesis (session_id, synthesis, created_at) VALUES (?,?,?)", (session_id, json.dumps(synthesis, ensure_ascii=False), now)); c.commit()

    def get_session_synthesis(self, session_id):
        """Get session synthesis."""
        r = self._db("memory").execute("SELECT * FROM session_synthesis WHERE session_id=?", (session_id,)).fetchone()
        if not r: return None
        try: return json.loads(r["synthesis"])
        except: return None

    def get_workspace_recent_synthesis(self, workspace: str, exclude_session: str = "", limit: int = 2):
        """Recent session syntheses from other sessions in the same workspace."""
        if not workspace:
            return []
        rows = self._db("sessions").execute(
            "SELECT s.id, ss.synthesis, ss.created_at FROM session_synthesis ss "
            "JOIN sessions s ON s.id = ss.session_id "
            "WHERE s.workspace = ? AND s.id != ? ORDER BY ss.created_at DESC LIMIT ?",
            (workspace, exclude_session or "", int(limit)),
        ).fetchall()
        out = []
        for r in rows:
            try:
                out.append({"session_id": r["id"], "synthesis": json.loads(r["synthesis"]), "created_at": r["created_at"]})
            except Exception:
                pass
        return out

    def _session_fts_upsert(self, session_id: str, message_id: str, content: str) -> None:
        if not getattr(self, "_session_fts_enabled", False) or not content:
            return
        try:
            from rust_adapters.memory_retrieval import fts_document
            body = fts_document(str(content))
        except Exception:
            body = str(content)[:4000]
        c = self._db("sessions")
        try:
            c.execute("DELETE FROM session_fts WHERE message_id=?", (message_id,))
            c.execute(
                "INSERT INTO session_fts (body, session_id, message_id) VALUES (?,?,?)",
                (body, session_id, message_id),
            )
            c.commit()
        except sqlite3.OperationalError:
            self._session_fts_enabled = False

    def rebuild_session_fts(self) -> int:
        if not getattr(self, "_session_fts_enabled", False):
            return 0
        c = self._db("sessions")
        try:
            from rust_adapters.memory_retrieval import fts_document
        except Exception:
            fts_document = lambda t: str(t)[:4000]  # noqa: E731
        c.execute("DELETE FROM session_fts")
        n = 0
        for row in c.execute(
            "SELECT id, session_id, content FROM session_messages WHERE role IN ('user','assistant')"
        ).fetchall():
            body = fts_document(str(row["content"] or ""))
            c.execute(
                "INSERT INTO session_fts (body, session_id, message_id) VALUES (?,?,?)",
                (body, row["session_id"], row["id"]),
            )
            n += 1
        c.commit()
        return n

    def search_sessions_fts(self, query: str, workspace: str = "", limit: int = 10) -> list:
        """Full-text search across session messages; returns session hits with snippets."""
        if not getattr(self, "_session_fts_enabled", False) or not query:
            return []
        try:
            from rust_adapters.memory_retrieval import build_fts_query
            match_q = build_fts_query(query, None)
        except Exception:
            match_q = query
        if not match_q:
            return []
        c = self._db("sessions")
        try:
            if workspace:
                rows = c.execute(
                    "SELECT f.session_id, bm25(session_fts) AS rank, "
                    "snippet(session_fts, 0, '【', '】', '…', 24) AS snippet "
                    "FROM session_fts f JOIN sessions s ON s.id = f.session_id "
                    "WHERE session_fts MATCH ? AND s.workspace = ? "
                    "GROUP BY f.session_id ORDER BY rank LIMIT ?",
                    (match_q, workspace, int(limit)),
                ).fetchall()
            else:
                rows = c.execute(
                    "SELECT session_id, bm25(session_fts) AS rank, "
                    "snippet(session_fts, 0, '【', '】', '…', 24) AS snippet "
                    "FROM session_fts WHERE session_fts MATCH ? "
                    "GROUP BY session_id ORDER BY rank LIMIT ?",
                    (match_q, int(limit)),
                ).fetchall()
            return [dict(r) for r in rows]
        except sqlite3.OperationalError:
            self._session_fts_enabled = False
            return []

    def update_memory_dream_time(self, root):
        """Update last dream timestamp for a project."""
        c = self._db("memory"); now = int(time.time())
        c.execute("UPDATE project_memory_index SET last_dream_at=? WHERE root_dir=?", (now, root)); c.commit()

    def search_memory(self, root, limit=5):
        """最近更新的几条记忆。

        以前这里连 ``archived`` 都不过滤——一条被用户删掉的记忆照样会被它捞回来
        注入 prompt。现在和其他召回路径共用同一个"能用"的判据。
        """
        live, live_params = self._memory_live_sql()
        return [dict(x) for x in self._db("memory").execute(
            f"SELECT * FROM memory_entries WHERE root_dir=? AND {live}"
            " ORDER BY updated_at DESC LIMIT ?",
            (root, *live_params, limit)).fetchall()]

    def update_memory_index(self, root, content):
        c = self._db("memory"); now = int(time.time())
        c.execute("INSERT OR REPLACE INTO project_memory_index (id,root_dir,index_content,last_extract_at,version) VALUES ((SELECT id FROM project_memory_index WHERE root_dir=?),?,?,?,(SELECT COALESCE(version,0)+1 FROM project_memory_index WHERE root_dir=?))", (root, root, content, now, root)); c.commit()

    def save_bot_state(self, key, value):
        c = self._db("usage"); c.execute("INSERT OR REPLACE INTO bot_state VALUES (?,?,?)", (key, json.dumps(value, ensure_ascii=False), int(time.time()))); c.commit()

    def get_bot_state(self, key, default=None):
        r = self._db("usage").execute("SELECT value FROM bot_state WHERE key=?", (key,)).fetchone()
        if not r: return default
        try: return json.loads(r["value"])
        except: return r["value"]

    def add_bot_message(self, msg: dict):
        """Add a bot message to storage."""
        c = self._db("bot")
        c.execute("INSERT OR REPLACE INTO bot_messages (id,platform,user_id,content,direction,timestamp) VALUES (?,?,?,?,?,?)",
                  (msg.get("id"), msg.get("platform"), msg.get("user_id"), msg.get("content"), msg.get("direction", "inbound"), msg.get("timestamp", time.time())))
        c.commit()

    def get_bot_messages(self, platform: str, user_id: str, limit: int = 20) -> list:
        """Get recent bot messages for a platform/user."""
        r = self._db("bot").execute("SELECT * FROM bot_messages WHERE platform=? AND user_id=? ORDER BY timestamp DESC LIMIT ?",
                                     (platform, user_id, limit)).fetchall()
        return [dict(x) for x in r]

    def add_bot_audit(self, platform: str, user_id: str, session_id: str, tool_name: str, action: str, blocked: bool, reason: str = ""):
        """Log a remote session audit entry."""
        c = self._db("bot")
        c.execute(
            "INSERT INTO bot_audit (id,platform,user_id,session_id,tool_name,action,blocked,reason,timestamp) VALUES (?,?,?,?,?,?,?,?,?)",
            (str(uuid.uuid4()), platform, user_id, session_id, tool_name, action, int(blocked), reason, time.time())
        ); c.commit()

    def get_bot_audit_log(self, platform: str = None, user_id: str = None, limit: int = 50) -> list:
        """Get bot audit log entries."""
        c = self._db("bot")
        conditions = []; params = []
        if platform:
            conditions.append("platform=?"); params.append(platform)
        if user_id:
            conditions.append("user_id=?"); params.append(user_id)
        where = " AND ".join(conditions) if conditions else "1=1"
        params.append(limit)
        r = c.execute(f"SELECT * FROM bot_audit WHERE {where} ORDER BY timestamp DESC LIMIT ?", params).fetchall()
    # ── Episodes (ConversationEpisode) ──────────────────────────────────────

    def create_episode(self, session_id: str, topic: str = "", goal_id: str = "",
                       branch_id: str = "", metadata: dict = None, episode_id: str = "") -> str:
        """Create a new active episode within a session if none active exists (idempotent)."""
        if not session_id:
            return ""
        c = self._db("sessions")
        # Check existing active episode for this session + branch
        existing = self.get_active_episode(session_id, branch_id or "")
        if existing and not episode_id:
            return str(existing.get("episode_id") or "")

        eid = episode_id or f"ep_{uuid.uuid4().hex[:12]}"
        now = time.time()
        try:
            c.execute(
                "INSERT INTO episodes (episode_id, session_id, branch_id, topic, goal_id, turn_ids, status, started_at, last_activity_at, sealed_at, metadata, generation) "
                "VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, 1)",
                (eid, session_id, branch_id or "", topic or "General Dialogue", goal_id or "", "[]", now, now, json.dumps(metadata or {}, ensure_ascii=False))
            )
            c.commit()
            return eid
        except Exception:
            c.rollback()
            existing = self.get_active_episode(session_id, branch_id or "")
            if existing:
                return str(existing.get("episode_id") or "")
            return eid


    def get_episode(self, episode_id: str) -> dict | None:
        """Fetch one episode by ID."""
        if not episode_id:
            return None
        r = self._db("sessions").execute("SELECT * FROM episodes WHERE episode_id=?", (episode_id,)).fetchone()
        if not r:
            return None
        d = dict(r)
        try:
            d["turn_ids"] = json.loads(d.get("turn_ids") or "[]")
        except Exception:
            d["turn_ids"] = []
        try:
            d["metadata"] = json.loads(d.get("metadata") or "{}")
        except Exception:
            d["metadata"] = {}
        return d

    def get_active_episode(self, session_id: str, branch_id: str = "") -> dict | None:
        """Get the current active episode for a session and branch, or None."""
        if not session_id:
            return None
        c = self._db("sessions")
        bid = (branch_id or "").strip()
        if bid:
            query = "SELECT * FROM episodes WHERE session_id=? AND branch_id=? AND status='active' ORDER BY started_at DESC LIMIT 1"
            r = c.execute(query, (session_id, bid)).fetchone()
        else:
            query = "SELECT * FROM episodes WHERE session_id=? AND (branch_id='' OR branch_id IS NULL) AND status='active' ORDER BY started_at DESC LIMIT 1"
            r = c.execute(query, (session_id,)).fetchone()
        if not r:
            return None
        d = dict(r)
        try:
            d["turn_ids"] = json.loads(d.get("turn_ids") or "[]")
        except Exception:
            d["turn_ids"] = []
        try:
            d["metadata"] = json.loads(d.get("metadata") or "{}")
        except Exception:
            d["metadata"] = {}
        return d

    def seal_episode(self, episode_id: str, reason: str = "", event_id: str = "", metadata: dict = None) -> bool:
        """Seal an active episode (idempotent), marking it completed."""
        if not episode_id:
            return False
        prev = self.get_episode(episode_id)
        if not prev:
            return False
        if prev.get("status") == "sealed":
            return True  # Idempotent success

        now = time.time()
        c = self._db("sessions")
        meta = prev.get("metadata", {})
        if metadata:
            meta.update(metadata)
        if reason:
            meta["seal_reason"] = reason

        c.execute(
            "UPDATE episodes SET status='sealed', sealed_at=?, seal_reason=?, sealed_by_event_id=?, metadata=? WHERE episode_id=?",
            (now, reason or prev.get("seal_reason", ""), event_id or prev.get("sealed_by_event_id", ""), json.dumps(meta, ensure_ascii=False), episode_id)
        )
        c.commit()
        return True

    def list_episodes(self, session_id: str = "", branch_id: str = None, limit: int = 50) -> list[dict]:
        """List episodes ordered by start time, supporting session and branch filters."""
        c = self._db("sessions")
        conditions = []
        params = []
        if session_id:
            conditions.append("session_id=?")
            params.append(session_id)
        if branch_id is not None:
            if branch_id == "":
                conditions.append("(branch_id IS NULL OR branch_id = '')")
            else:
                conditions.append("branch_id=?")
                params.append(branch_id)
        where = " AND ".join(conditions) if conditions else "1=1"
        params.append(limit)
        rows = c.execute(
            f"SELECT * FROM episodes WHERE {where} ORDER BY started_at DESC LIMIT ?",
            params
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["turn_ids"] = json.loads(d.get("turn_ids") or "[]")
            except Exception:
                d["turn_ids"] = []
            try:
                d["metadata"] = json.loads(d.get("metadata") or "{}")
            except Exception:
                d["metadata"] = {}
            out.append(d)
        return out

    def list_active_episodes(self, limit: int = 100) -> list[dict]:
        """List active episodes across all sessions, ordered by started_at."""
        c = self._db("sessions")
        rows = c.execute(
            "SELECT * FROM episodes WHERE status='active' ORDER BY started_at ASC LIMIT ?",
            (limit,)
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["turn_ids"] = json.loads(d.get("turn_ids") or "[]")
            except Exception:
                d["turn_ids"] = []
            try:
                d["metadata"] = json.loads(d.get("metadata") or "{}")
            except Exception:
                d["metadata"] = {}
            out.append(d)
        return out

    def append_turn_to_episode(self, episode_id: str, turn_id: str) -> bool:
        """Append a turn ID to an active episode, updating last_activity_at."""
        if not (episode_id and turn_id):
            return False
        ep = self.get_episode(episode_id)
        if not ep or ep.get("status") != "active":
            return False
        turns = ep.get("turn_ids", [])
        now = time.time()
        if turn_id not in turns:
            turns.append(turn_id)
        self._db("sessions").execute(
            "UPDATE episodes SET turn_ids=?, last_activity_at=? WHERE episode_id=?",
            (json.dumps(turns, ensure_ascii=False), now, episode_id)
        )
        self._db("sessions").commit()
        return True

    # ── Learning Items (1st-class LearningItem) ─────────────────────────────

    def insert_learning_item(self, *, learning_item_id: str = "", bundle_id: str = "",
                             episode_id: str = "", session_id: str = "", branch_id: str = "",
                             kind: str = "memory_fact", scope: str = "session", content: str = "",
                             preconditions: str = "", applicability: str = "",
                             source_event_ids: list = None, source_session_id: str = "",
                             source_goal_id: str = "", source_run_id: str = "",
                             source_turn_id: str = "", confidence: float = 1.0,
                             evidence_strength: float = 1.0, priority: int = 0,
                             status: str = "discovered", notification_policy: str = "receipt",
                             why: str = "", evidence_summary: str = "", future_effect: str = "",
                             target_ref: str = "", deferred_reason: str = "",
                             user_verdict: str = "pending", idempotency_key: str = "",
                             operation_id: str = "") -> str:
        """Insert a learning item with idempotency and non-destructive semantics."""
        c = self._db("memory")
        if idempotency_key:
            row = c.execute("SELECT learning_item_id FROM learning_items WHERE idempotency_key=?", (idempotency_key,)).fetchone()
            if row:
                return str(row[0])

        iid = learning_item_id or f"li_{uuid.uuid4().hex[:12]}"
        now = time.time()
        c.execute("""
            INSERT INTO learning_items (
                learning_item_id, bundle_id, episode_id, session_id, branch_id,
                kind, scope, content, preconditions, applicability,
                source_event_ids, source_session_id, source_goal_id, source_run_id,
                source_turn_id, confidence, evidence_strength, priority,
                status, notification_policy, why, evidence_summary, future_effect,
                target_ref, deferred_reason, user_verdict, idempotency_key, operation_id,
                version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        """, (
            iid, bundle_id or "", episode_id or "", session_id or "", branch_id or "",
            kind or "memory_fact", scope or "session", content or "", preconditions or "", applicability or "",
            json.dumps(list(source_event_ids or []), ensure_ascii=False),
            source_session_id or session_id or "", source_goal_id or "", source_run_id or "",
            source_turn_id or "", float(confidence), float(evidence_strength), int(priority),
            status or "discovered", notification_policy or "receipt", why or "", evidence_summary or "",
            future_effect or "", target_ref or "", deferred_reason or "", user_verdict or "pending",
            idempotency_key or "", operation_id or "", now, now
        ))
        c.commit()
        return iid

    def get_learning_item(self, item_id: str) -> dict | None:
        """Get a single learning item."""
        if not item_id:
            return None
        r = self._db("memory").execute("SELECT * FROM learning_items WHERE learning_item_id=?", (item_id,)).fetchone()
        if not r:
            return None
        d = dict(r)
        try:
            d["source_event_ids"] = json.loads(d.get("source_event_ids") or "[]")
        except Exception:
            d["source_event_ids"] = []
        return d

    def list_learning_items(self, session_id: str = "", branch_id: str = None, episode_id: str = "",
                            bundle_id: str = "", status: str = "", limit: int = 100) -> list[dict]:
        """List learning items filtered by session, branch, episode, bundle, or status."""
        c = self._db("memory")
        conditions = []
        params = []
        if session_id:
            conditions.append("session_id=?")
            params.append(session_id)
        if branch_id is not None:
            if branch_id == "":
                conditions.append("(branch_id IS NULL OR branch_id = '')")
            else:
                conditions.append("branch_id=?")
                params.append(branch_id)
        if episode_id:
            conditions.append("episode_id=?")
            params.append(episode_id)
        if bundle_id:
            conditions.append("bundle_id=?")
            params.append(bundle_id)
        if status:
            conditions.append("status=?")
            params.append(status)
        where = " AND ".join(conditions) if conditions else "1=1"
        params.append(limit)
        rows = c.execute(
            f"SELECT * FROM learning_items WHERE {where} ORDER BY created_at DESC LIMIT ?",
            params
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["source_event_ids"] = json.loads(d.get("source_event_ids") or "[]")
            except Exception:
                d["source_event_ids"] = []
            out.append(d)
        return out

    def update_learning_item(self, item_id: str, status: str = None,
                             user_verdict: str = None, deferred_reason: str = None,
                             content: str = None, operation_id: str = None,
                             idempotency_key: str = None,
                             expected_version: int = None) -> bool:
        """Update lifecycle status or verdict for a learning item with state machine validation."""
        if not item_id:
            return False
        c = self._db("memory")
        prev = self.get_learning_item(item_id)
        if not prev:
            return False

        if status and status != prev.get("status"):
            valid_targets = {
                'discovered': {'classified', 'proposed', 'deferred', 'noop', 'failed'},
                'classified': {'proposed', 'deferred', 'noop', 'validating', 'staged', 'failed'},
                'proposed': {'validating', 'staged', 'awaiting_approval', 'published', 'rejected', 'deferred', 'failed'},
                'deferred': {'proposed', 'validating', 'staged', 'published', 'rejected', 'archived'},
                'staged': {'validating', 'published', 'rejected', 'deferred', 'failed'},
                'validating': {'published', 'failed', 'unknown', 'rejected', 'proposed'},
                'published': {'rolled_back', 'degraded', 'archived', 'unknown'},
                'rejected': {'archived'},
                'failed': {'proposed', 'validating', 'archived', 'unknown'},
                'unknown': {'published', 'failed', 'rolled_back', 'archived'},
                'rolled_back': {'archived', 'proposed'},
                'degraded': {'archived', 'validating', 'rolled_back'},
                'archived': set(),
            }
            cur_status = prev.get("status", "discovered")
            allowed = valid_targets.get(cur_status, set())
            if status not in allowed:
                # Log state machine rejection and return False
                return False

        updates = ["updated_at=?", "version=version+1"]
        params = [time.time()]
        if status is not None:
            updates.append("status=?")
            params.append(status)
        if user_verdict is not None:
            updates.append("user_verdict=?")
            params.append(user_verdict)
        if deferred_reason is not None:
            updates.append("deferred_reason=?")
            params.append(deferred_reason)
        if content is not None:
            updates.append("content=?")
            params.append(content)
        if operation_id is not None:
            updates.append("operation_id=?")
            params.append(operation_id)
        if idempotency_key is not None:
            updates.append("idempotency_key=?")
            params.append(idempotency_key)

        where = "learning_item_id=?"
        params.append(item_id)
        if expected_version is not None:
            where += " AND version=?"
            params.append(expected_version)

        res = c.execute(
            f"UPDATE learning_items SET {', '.join(updates)} WHERE {where}",
            params
        )
        c.commit()
        return res.rowcount > 0

    # ── Learning Item Operation Ledger (P1-2) ──────────────────────────────────

    def record_learning_item_operation(self, operation_id: str, item_id: str, action: str,
                                       idempotency_key: str = "", status: str = "started",
                                       payload: dict = None, result: dict = None,
                                       error: str = "") -> bool:
        """Record an operation in the persistent LearningItem mutation ledger."""
        if not (operation_id and item_id):
            return False
        c = self._db("memory")
        now = time.time()
        c.execute("""
            INSERT INTO learning_item_operations (
                operation_id, item_id, action, idempotency_key, status, payload, result, error, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(operation_id) DO UPDATE SET
                status=excluded.status,
                result=excluded.result,
                error=excluded.error,
                updated_at=excluded.updated_at
        """, (
            operation_id, item_id, action, idempotency_key or "", status,
            json.dumps(payload or {}, ensure_ascii=False),
            json.dumps(result or {}, ensure_ascii=False),
            str(error or ""), now, now
        ))
        c.commit()
        return True

    def get_learning_item_operation_by_key(self, idempotency_key: str) -> dict | None:
        """Look up an operation by idempotency key."""
        if not idempotency_key:
            return None
        r = self._db("memory").execute(
            "SELECT * FROM learning_item_operations WHERE idempotency_key=? ORDER BY created_at DESC LIMIT 1",
            (idempotency_key,)
        ).fetchone()
        if not r:
            return None
        d = dict(r)
        try: d["payload"] = json.loads(d.get("payload") or "{}")
        except Exception: d["payload"] = {}
        try: d["result"] = json.loads(d.get("result") or "{}")
        except Exception: d["result"] = {}
        return d

    def get_learning_item_operation(self, operation_id: str) -> dict | None:
        """Look up an operation by operation_id."""
        if not operation_id:
            return None
        r = self._db("memory").execute(
            "SELECT * FROM learning_item_operations WHERE operation_id=?",
            (operation_id,)
        ).fetchone()
        if not r:
            return None
        d = dict(r)
        try: d["payload"] = json.loads(d.get("payload") or "{}")
        except Exception: d["payload"] = {}
        try: d["result"] = json.loads(d.get("result") or "{}")
        except Exception: d["result"] = {}
        return d

    def claim_learning_item_operation(self, operation_id: str, item_id: str, action: str,
                                      idempotency_key: str = "", payload: dict = None) -> tuple[bool, dict]:
        """Atomically claim a mutation operation in the ledger (P1-1).

        Returns:
            (claimed: bool, op_dict: dict)
            If claimed is True, this caller won the lease and is responsible for mutation.
            If claimed is False, an operation with this idempotency_key already exists.
        """
        if not (operation_id and item_id):
            return False, {}
        c = self._db("memory")
        now = time.time()
        payload_json = json.dumps(payload or {}, ensure_ascii=False)
        if idempotency_key:
            try:
                c.execute("""
                    INSERT INTO learning_item_operations (
                        operation_id, item_id, action, idempotency_key, status, payload, result, error, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'started', ?, '{}', '', ?, ?)
                """, (operation_id, item_id, action, idempotency_key, payload_json, now, now))
                c.commit()
                return True, {
                    "operation_id": operation_id, "item_id": item_id, "action": action,
                    "idempotency_key": idempotency_key, "status": "started",
                    "payload": payload or {}, "result": {}, "error": "",
                    "created_at": now, "updated_at": now,
                }
            except sqlite3.IntegrityError:
                # Unique constraint hit: operation already exists!
                existing = self.get_learning_item_operation_by_key(idempotency_key)
                if existing:
                    # Check comprehensive intent matching (P1-2)
                    ex_payload = existing.get("payload") or {}
                    cur_payload = payload or {}
                    mismatches = []
                    if existing.get("item_id") != item_id:
                        mismatches.append(f"item_id ('{existing.get('item_id')}' != '{item_id}')")
                    if existing.get("action") != action:
                        mismatches.append(f"action ('{existing.get('action')}' != '{action}')")
                    if cur_payload.get("version") is not None and ex_payload.get("version") is not None and cur_payload.get("version") != ex_payload.get("version"):
                        mismatches.append(f"version ({ex_payload.get('version')} != {cur_payload.get('version')})")
                    if action == "edit" and (cur_payload.get("content") or "").strip() != (ex_payload.get("content") or "").strip():
                        mismatches.append("edited content")
                    if (cur_payload.get("reason") or "").strip() != (ex_payload.get("reason") or "").strip():
                        mismatches.append("reason")
                    if (cur_payload.get("session_id") or "").strip() != (ex_payload.get("session_id") or "").strip():
                        mismatches.append("sessionId")
                    if (cur_payload.get("branch_id") or "").strip() != (ex_payload.get("branch_id") or "").strip():
                        mismatches.append("branchId")

                    if mismatches:
                        return False, {
                            "status": "idempotency_conflict",
                            "error": f"Idempotency key '{idempotency_key}' reused with conflicting mutation intent on: {', '.join(mismatches)}",
                            "operation_id": existing.get("operation_id"),
                        }
                return False, (existing or {})
        else:
            c.execute("""
                INSERT INTO learning_item_operations (
                    operation_id, item_id, action, idempotency_key, status, payload, result, error, created_at, updated_at
                ) VALUES (?, ?, ?, '', 'started', ?, '{}', '', ?, ?)
            """, (operation_id, item_id, action, payload_json, now, now))
            c.commit()
            return True, {
                "operation_id": operation_id, "item_id": item_id, "action": action,
                "idempotency_key": "", "status": "started",
                "payload": payload or {}, "result": {}, "error": "",
                "created_at": now, "updated_at": now,
            }

    def update_learning_item_operation(self, operation_id: str, status: str = None,
                                       result: dict = None, error: str = None) -> bool:
        """Update status and result for an ongoing operation."""
        if not operation_id:
            return False
        updates = ["updated_at=?"]
        params = [time.time()]
        if status is not None:
            updates.append("status=?")
            params.append(status)
        if result is not None:
            updates.append("result=?")
            params.append(json.dumps(result, ensure_ascii=False))
        if error is not None:
            updates.append("error=?")
            params.append(str(error))
        params.append(operation_id)
        c = self._db("memory")
        c.execute(f"UPDATE learning_item_operations SET {', '.join(updates)} WHERE operation_id=?", params)
        c.commit()
        return True

    def list_hanging_learning_item_operations(self, limit: int = 100) -> list[dict]:
        """List operations currently in 'started' or 'unknown' state for boot reconciliation (P1-3)."""
        rows = self._db("memory").execute(
            "SELECT * FROM learning_item_operations WHERE status IN ('started', 'unknown') ORDER BY created_at ASC LIMIT ?",
            (int(limit),)
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            try: d["payload"] = json.loads(d.get("payload") or "{}")
            except Exception: d["payload"] = {}
            try: d["result"] = json.loads(d.get("result") or "{}")
            except Exception: d["result"] = {}
            out.append(d)
        return out

    def close(self):
        for c in self._dbs.values(): c.close()
        # The event store is a process-wide singleton keyed by db path. Close
        # it only while it still belongs to THIS storage's directory — another
        # Storage may have already re-pointed the singleton at a different
        # events.db (the tests do this on every case), and closing that one
        # would rip the connection out from under its current owner.
        try:
            es = getattr(self, "_event_store", None)
            own_path = os.path.join(self.db_dir, "events.db")
            if es is not None and not es.closed and es.db_path == own_path:
                es.close()
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

_storage = None
def get_storage():
    global _storage
    if _storage is None: _storage = Storage()
    return _storage
