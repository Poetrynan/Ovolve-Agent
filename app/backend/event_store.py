"""
event_store.py - High-Performance SQLite Event Store with SHA-256 Chain Hashing.

Adheres to Event-Sourced Agent Runtime v1.0 specifications:
- Append-only immutable stream of AgentEvents
- Strictly monotonic sequence numbering
- Blockchain-style cascading SHA-256 chain integrity hashes
- O(1) state snapshotting and sub-millisecond replay capability
"""
from __future__ import annotations
import os
import sqlite3
import json
import time
import hashlib
from typing import Optional, List, Dict, Any
from event_types import EventType, AgentEvent, SessionSnapshot

# Chain-hash kernels routed through the Rust-backed adapter. JSON
# canonicalization (sort_keys + ensure_ascii=False) stays on the Python
# side of the adapter contract, so hash bytes are identical across
# backends — see rust_adapters/event_engine.py.
try:
    from rust_adapters.event_engine import (
        genesis_hash as _re_genesis,
        compute_chain_hash as _re_chain,
        compute_snapshot_hash as _re_snapshot,
    )
except ImportError:
    from app.backend.rust_adapters.event_engine import (
        genesis_hash as _re_genesis,
        compute_chain_hash as _re_chain,
        compute_snapshot_hash as _re_snapshot,
    )

try:
    from user_dirs import db_dir as _default_db_dir
except ImportError:  # pragma: no cover - packaged import shape
    from app.backend.user_dirs import db_dir as _default_db_dir


class EventStore:
    """Production-grade SQLite Event Store."""

    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            db_path = _default_db_dir() + os.sep + "events.db"

        self.db_path = db_path
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        # Same concurrency hazard as Storage: this store is a process-wide
        # singleton shared by every Router thread — serialize all calls.
        try:
            from storage import _SerializedConn  # lazy: storage imports us

            self._conn = _SerializedConn(conn)
        except ImportError:  # pragma: no cover - standalone use
            self._conn = conn
        self._closed = False
        self._init_schema()

    def close(self) -> None:
        """Close the underlying connection. Idempotent.

        WAL mode keeps the -wal/-shm sidecar handles alive as long as the
        connection object exists; on Windows an open handle makes the whole
        db directory undeletable (WinError 32), which is what the storage
        tests hit at teardown when only Storage's own connections were
        closed and events.db stayed pinned by the singleton.
        """
        conn = getattr(self, "_conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
            self._conn = None
        self._closed = True

    @property
    def closed(self) -> bool:
        return bool(getattr(self, "_closed", False))

    def _init_schema(self):
        with self._conn:
            self._conn.execute("""
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
            """)
            # Phase 1 (canonical run/trace protocol): correlation + idempotency
            # columns. CREATE TABLE IF NOT EXISTS does not touch an existing
            # table, so an events.db written by an older build is migrated in
            # place here — additive ALTERs only, repeatable, no data loss.
            existing = {row[1] for row in self._conn.execute("PRAGMA table_info(agent_events)").fetchall()}
            for col_ddl in (
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
            ):
                col_name = col_ddl.split()[0]
                if col_name not in existing:
                    self._conn.execute(f"ALTER TABLE agent_events ADD COLUMN {col_ddl}")
            # A retried write with the same key must land once. NULL keys (the
            # legacy/unkeyed path) are exempt — SQLite treats each NULL as
            # distinct in a UNIQUE index.
            self._conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency ON agent_events(idempotency_key)"
            )
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_events_session_seq ON agent_events(session_id, seq)")
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_events_type ON agent_events(event_type)")
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_events_causation ON agent_events(causation_id)")
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_events_turn ON agent_events(session_id, turn_id)")
            # Goal/run are cross-session dimensions: a goal that pauses and
            # resumes writes into more than one session, so these deliberately
            # do NOT lead with session_id. `seq` second keeps the scan ordered
            # (read_by_dimension orders by seq) instead of sorting afterwards.
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_events_goal ON agent_events(goal_id, seq)")
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_events_run ON agent_events(run_id, seq)")

            self._conn.execute("""
                CREATE TABLE IF NOT EXISTS event_snapshots (
                    session_id TEXT NOT NULL,
                    at_seq INTEGER NOT NULL,
                    state_json TEXT NOT NULL,
                    snapshot_hash TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (session_id, at_seq)
                )
            """)
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_session ON event_snapshots(session_id, at_seq DESC)")

    def _genesis_hash(self, session_id: str) -> str:
        """Initial hash anchor for a session event stream."""
        return _re_genesis(session_id)

    def _compute_chain_hash(self, prev_hash: str, session_id: str, event_type: str, timestamp: int, payload: Dict[str, Any]) -> str:
        """Cascading SHA-256 tamper-evident chain hash."""
        return _re_chain(prev_hash, session_id, event_type, timestamp, payload)

    def append(
        self,
        session_id: str,
        event_type: str | EventType,
        payload: Dict[str, Any],
        causation_id: Optional[str] = None,
        timestamp: Optional[int] = None,
        state_hash: Optional[str] = None,
        resulting_hash: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        run_id: Optional[str] = None,
        turn_id: Optional[str] = None,
        step_id: Optional[str] = None,
        tool_call_id: Optional[str] = None,
        goal_id: Optional[str] = None,
        branch_id: Optional[str] = None,
        parent_event_id: Optional[str] = None,
        actor: Optional[str] = None,
        visibility: str = "audit",
    ) -> AgentEvent:
        """Appends a single atomic event to the session stream.

        ``idempotency_key``: a caller-supplied stable identity for the FACT
        being recorded ("session:create:<sid>", "msg:<message-row-id>"). A
        retry with the same key returns the already-stored event instead of
        appending a duplicate — recovery code can therefore re-run a whole
        batch of appends safely. Keys are optional; unkeyed events append
        unconditionally, exactly as before.
        """
        if idempotency_key:
            existing = self.find_by_idempotency_key(idempotency_key)
            if existing is not None:
                return existing

        t_now = timestamp if timestamp is not None else int(time.time() * 1000)
        etype_str = str(event_type.value if isinstance(event_type, EventType) else event_type)
        payload_str = json.dumps(payload, ensure_ascii=False)

        with self._conn:
            # Query the latest event for this session to get the latest chain hash
            cur = self._conn.execute(
                "SELECT chain_hash FROM agent_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
                (session_id,),
            )
            row = cur.fetchone()
            prev_hash = row["chain_hash"] if row else self._genesis_hash(session_id)

            chain_hash = self._compute_chain_hash(prev_hash, session_id, etype_str, t_now, payload)

            cursor = self._conn.execute(
                """
                INSERT INTO agent_events (
                    session_id, event_type, causation_id, timestamp, payload, state_hash, resulting_hash, chain_hash,
                    schema_version, idempotency_key, run_id, turn_id, step_id, tool_call_id, goal_id, branch_id,
                    parent_event_id, actor, visibility
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (session_id, etype_str, causation_id, t_now, payload_str, state_hash, resulting_hash, chain_hash,
                 idempotency_key, run_id, turn_id, step_id, tool_call_id, goal_id, branch_id,
                 parent_event_id, actor, visibility),
            )
            seq = cursor.lastrowid

        return AgentEvent(
            seq=seq,
            event_type=etype_str,
            session_id=session_id,
            timestamp=t_now,
            payload=payload,
            chain_hash=chain_hash,
            causation_id=causation_id,
            state_hash=state_hash,
            resulting_hash=resulting_hash,
            idempotency_key=idempotency_key,
            run_id=run_id,
            turn_id=turn_id,
            step_id=step_id,
            tool_call_id=tool_call_id,
            goal_id=goal_id,
            branch_id=branch_id,
            parent_event_id=parent_event_id,
            actor=actor,
            visibility=visibility,
        )

    def find_by_idempotency_key(self, key: str) -> Optional[AgentEvent]:
        """The event a previous append with this key stored, if any."""
        cur = self._conn.execute(
            "SELECT * FROM agent_events WHERE idempotency_key = ? ORDER BY seq LIMIT 1",
            (key,),
        )
        row = cur.fetchone()
        return AgentEvent.from_row(row) if row else None

    def append_batch(
        self,
        session_id: str,
        events_data: List[Dict[str, Any]],
    ) -> List[AgentEvent]:
        """Appends multiple events atomically with sequential chained hashes."""
        results: List[AgentEvent] = []
        if not events_data:
            return results

        with self._conn:
            cur = self._conn.execute(
                "SELECT chain_hash FROM agent_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
                (session_id,),
            )
            row = cur.fetchone()
            curr_hash = row["chain_hash"] if row else self._genesis_hash(session_id)

            for item in events_data:
                t_now = item.get("timestamp") or int(time.time() * 1000)
                etype_str = str(item["event_type"].value if isinstance(item["event_type"], EventType) else item["event_type"])
                payload = item.get("payload") or {}
                payload_str = json.dumps(payload, ensure_ascii=False)
                causation_id = item.get("causation_id")
                state_hash = item.get("state_hash")
                resulting_hash = item.get("resulting_hash")

                chain_hash = self._compute_chain_hash(curr_hash, session_id, etype_str, t_now, payload)
                curr_hash = chain_hash

                # Attribution travels with the event. This used to insert eight
                # columns and drop the rest, so a forked session's cloned
                # history arrived with every run/turn/goal id blanked — the
                # clone looked complete in the UI and answered nothing when
                # asked "which goal did this". Not part of the chain hash (the
                # hash covers session/type/timestamp/payload), so carrying them
                # over does not change verification.
                cursor = self._conn.execute(
                    """
                    INSERT INTO agent_events (
                        session_id, event_type, causation_id, timestamp, payload,
                        state_hash, resulting_hash, chain_hash,
                        run_id, turn_id, step_id, tool_call_id, goal_id, branch_id, actor
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (session_id, etype_str, causation_id, t_now, payload_str,
                     state_hash, resulting_hash, chain_hash,
                     item.get("run_id"), item.get("turn_id"), item.get("step_id"),
                     item.get("tool_call_id"), item.get("goal_id"),
                     item.get("branch_id"), item.get("actor")),
                )
                seq = cursor.lastrowid

                results.append(AgentEvent(
                    seq=seq,
                    event_type=etype_str,
                    session_id=session_id,
                    timestamp=t_now,
                    payload=payload,
                    chain_hash=chain_hash,
                    causation_id=causation_id,
                    state_hash=state_hash,
                    resulting_hash=resulting_hash,
                    run_id=item.get("run_id"),
                    turn_id=item.get("turn_id"),
                    step_id=item.get("step_id"),
                    tool_call_id=item.get("tool_call_id"),
                    goal_id=item.get("goal_id"),
                    branch_id=item.get("branch_id"),
                    actor=item.get("actor"),
                ))

        return results

    #: Which correlation columns may be queried directly. A whitelist, not a
    #: formatted-in column name — the value reaches SQL as an identifier, so
    #: anything outside this set must be refused rather than interpolated.
    QUERYABLE_DIMENSIONS: tuple = ("goal_id", "run_id", "turn_id", "tool_call_id", "branch_id")

    def read_by_dimension(
        self,
        dimension: str,
        value: str,
        limit: int = 500,
        session_id: str = "",
    ) -> List[AgentEvent]:
        """Events sharing one correlation id, oldest first, across sessions.

        The complement to :meth:`read_stream`: a goal spans several sessions
        (each resumed run may open a new one), so "what did this goal do" is not
        answerable from a single stream. Ordered by ``seq`` — global insert
        order, which for a single-writer store is real time order.

        Deliberately returns no chain-verification signal. The hash chain is
        per-session and starts at that session's genesis; any cross-cutting
        subset has gaps by construction, so a caller must not present it as
        "verified". Pass ``session_id`` to narrow to one session's slice.
        """
        if dimension not in self.QUERYABLE_DIMENSIONS:
            raise ValueError(f"not a queryable dimension: {dimension!r}")
        if not value:
            return []
        query = f"SELECT * FROM agent_events WHERE {dimension} = ?"
        params: List[Any] = [value]
        if session_id:
            query += " AND session_id = ?"
            params.append(session_id)
        query += " ORDER BY seq ASC LIMIT ?"
        params.append(max(1, min(5000, int(limit or 500))))
        cur = self._conn.execute(query, tuple(params))
        return [AgentEvent.from_row(r) for r in cur.fetchall()]

    def read_stream(
        self,
        session_id: str,
        from_seq: int = 0,
        to_seq: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> List[AgentEvent]:
        """Reads ordered event stream for a session."""
        query = "SELECT * FROM agent_events WHERE session_id = ? AND seq >= ?"
        params: List[Any] = [session_id, from_seq]

        if to_seq is not None:
            query += " AND seq <= ?"
            params.append(to_seq)

        query += " ORDER BY seq ASC"

        if limit is not None:
            query += " LIMIT ?"
            params.append(limit)

        cur = self._conn.execute(query, tuple(params))
        return [AgentEvent.from_row(r) for r in cur.fetchall()]

    def get_latest_event(self, session_id: str) -> Optional[AgentEvent]:
        """Returns the most recent event for a given session."""
        cur = self._conn.execute(
            "SELECT * FROM agent_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
            (session_id,),
        )
        row = cur.fetchone()
        return AgentEvent.from_row(row) if row else None

    def get_event_count(self, session_id: str) -> int:
        """Returns total event count in a session stream."""
        cur = self._conn.execute(
            "SELECT COUNT(*) as cnt FROM agent_events WHERE session_id = ?",
            (session_id,),
        )
        return int(cur.fetchone()["cnt"])

    def verify_chain(self, session_id: str) -> Dict[str, Any]:
        """
        Verifies the SHA-256 cryptographic chain integrity of a session.
        Returns:
            {"valid": bool, "total_events": int, "broken_at_seq": Optional[int], "error": Optional[str]}
        """
        events = self.read_stream(session_id)
        if not events:
            return {"valid": True, "total_events": 0, "broken_at_seq": None, "error": None}

        expected_prev = self._genesis_hash(session_id)
        for idx, ev in enumerate(events):
            calc_hash = self._compute_chain_hash(
                expected_prev,
                session_id,
                ev.event_type,
                ev.timestamp,
                ev.payload,
            )
            if calc_hash != ev.chain_hash:
                return {
                    "valid": False,
                    "total_events": len(events),
                    "broken_at_seq": ev.seq,
                    "error": f"Chain hash mismatch at seq={ev.seq} (expected {calc_hash}, got {ev.chain_hash})",
                }
            expected_prev = ev.chain_hash

        return {"valid": True, "total_events": len(events), "broken_at_seq": None, "error": None}

    # ─── Snapshot Management ──────────────────────────────────────────────────

    def create_snapshot(self, session_id: str, at_seq: int, state: Dict[str, Any]) -> SessionSnapshot:
        """Materializes state at sequence number for fast O(1) projection."""
        t_now = int(time.time() * 1000)
        state_str = json.dumps(state, sort_keys=True, ensure_ascii=False)
        snap_hash = _re_snapshot(session_id, at_seq, state)

        with self._conn:
            self._conn.execute(
                """
                INSERT OR REPLACE INTO event_snapshots (session_id, at_seq, state_json, snapshot_hash, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (session_id, at_seq, state_str, snap_hash, t_now),
            )

        return SessionSnapshot(
            session_id=session_id,
            at_seq=at_seq,
            state=state,
            created_at=t_now,
            snapshot_hash=snap_hash,
        )

    def get_latest_snapshot(self, session_id: str) -> Optional[SessionSnapshot]:
        """Fetches the latest state snapshot at or before current sequence."""
        cur = self._conn.execute(
            "SELECT * FROM event_snapshots WHERE session_id = ? ORDER BY at_seq DESC LIMIT 1",
            (session_id,),
        )
        row = cur.fetchone()
        if not row:
            return None
        return SessionSnapshot(
            session_id=row["session_id"],
            at_seq=row["at_seq"],
            state=json.loads(row["state_json"]),
            created_at=row["created_at"],
            snapshot_hash=row["snapshot_hash"],
        )


_event_store: Optional[EventStore] = None

def get_event_store(db_path: Optional[str] = None) -> EventStore:
    global _event_store
    if _event_store is None or _event_store.closed or (db_path and _event_store.db_path != db_path):
        # Replacing the singleton: close the outgoing store's connection so
        # its events.db handle doesn't leak for the rest of the process
        # (tests point the singleton at a fresh temp dir on every case).
        if _event_store is not None and not _event_store.closed:
            _event_store.close()
        _event_store = EventStore(db_path)
    return _event_store
