/**
 * @oa/event-store — SQL Schema Constants
 * 
 * Schema definitions for event-store tables. All SQL is centralized here
 * for easy migration management and cross-package consistency.
 */

// ---------------------------------------------------------------------------
// Core events table — append-only log
// ---------------------------------------------------------------------------

export const EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS events (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type      TEXT    NOT NULL,
    session_id      TEXT    NOT NULL,
    timestamp       INTEGER NOT NULL,
    payload         TEXT    NOT NULL DEFAULT '{}',
    chain_hash      TEXT    NOT NULL UNIQUE,
    metadata        TEXT    DEFAULT NULL
  );
`;

/** Index for fast session-scoped event retrieval ordered by seq. */
export const EVENTS_SESSION_SEQ_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_events_session_seq
    ON events (session_id, seq);
`;

/** Index for fast time-range queries within a session. */
export const EVENTS_SESSION_TIME_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_events_session_time
    ON events (session_id, timestamp);
`;

/** Index for event-type filtering. */
export const EVENTS_TYPE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_events_type
    ON events (event_type);
`;

// ---------------------------------------------------------------------------
// FTS5 full-text search virtual table
// ---------------------------------------------------------------------------

export const EVENTS_FTS_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    session_id,
    event_type,
    payload,
    content='events',
    content_rowid='seq',
    tokenize='porter unicode61'
  );
`;

/** FTS insert trigger — keeps the FTS index in sync with events. */
export const EVENTS_FTS_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts (rowid, session_id, event_type, payload)
    VALUES (new.seq, new.session_id, new.event_type, new.payload);
  END;
`;

/** FTS delete trigger. */
export const EVENTS_FTS_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
    INSERT INTO events_fts (events_fts, rowid, session_id, event_type, payload)
    VALUES ('delete', old.seq, old.session_id, old.event_type, old.payload);
  END;
`;

/** FTS update trigger. */
export const EVENTS_FTS_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
    INSERT INTO events_fts (events_fts, rowid, session_id, event_type, payload)
    VALUES ('delete', old.seq, old.session_id, old.event_type, old.payload);
    INSERT INTO events_fts (rowid, session_id, event_type, payload)
    VALUES (new.seq, new.session_id, new.event_type, new.payload);
  END;
`;

// ---------------------------------------------------------------------------
// Snapshots table — materialized projected state at a given seq
// ---------------------------------------------------------------------------

export const SNAPSHOTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS snapshots (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT    NOT NULL,
    at_seq      INTEGER NOT NULL,
    state       TEXT    NOT NULL,
    state_hash  TEXT    NOT NULL,
    timestamp   INTEGER NOT NULL,
    FOREIGN KEY (at_seq) REFERENCES events(seq)
  );
`;

/** Index to fetch the latest snapshot for a session efficiently. */
export const SNAPSHOTS_SESSION_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_snapshots_session_atseq
    ON snapshots (session_id, at_seq DESC);
`;

// ---------------------------------------------------------------------------
// Checkpoints table — named, user-facing state markers
// ---------------------------------------------------------------------------

export const CHECKPOINTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS checkpoints (
    id          TEXT    PRIMARY KEY,
    session_id  TEXT    NOT NULL,
    at_seq      INTEGER NOT NULL,
    state       TEXT    NOT NULL,
    timestamp   INTEGER NOT NULL,
    label       TEXT    DEFAULT NULL,
    expires_at  INTEGER DEFAULT NULL
  );
`;

export const CHECKPOINTS_SESSION_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_checkpoints_session
    ON checkpoints (session_id);
`;

export const CHECKPOINTS_EXPIRY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_checkpoints_expires
    ON checkpoints (expires_at)
    WHERE expires_at IS NOT NULL;
`;

// ---------------------------------------------------------------------------
// Migration registry — ordered list of schema versions
// ---------------------------------------------------------------------------

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const EVENT_STORE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_events',
    sql: EVENTS_TABLE_SQL,
  },
  {
    version: 2,
    name: 'events_session_seq_index',
    sql: EVENTS_SESSION_SEQ_INDEX_SQL,
  },
  {
    version: 3,
    name: 'events_session_time_index',
    sql: EVENTS_SESSION_TIME_INDEX_SQL,
  },
  {
    version: 4,
    name: 'events_type_index',
    sql: EVENTS_TYPE_INDEX_SQL,
  },
  {
    version: 5,
    name: 'events_fts',
    sql: EVENTS_FTS_TABLE_SQL,
  },
  {
    version: 6,
    name: 'events_fts_triggers',
    sql: [
      EVENTS_FTS_INSERT_TRIGGER_SQL,
      EVENTS_FTS_DELETE_TRIGGER_SQL,
      EVENTS_FTS_UPDATE_TRIGGER_SQL,
    ].join('\n'),
  },
  {
    version: 7,
    name: 'snapshots',
    sql: SNAPSHOTS_TABLE_SQL,
  },
  {
    version: 8,
    name: 'snapshots_session_index',
    sql: SNAPSHOTS_SESSION_INDEX_SQL,
  },
  {
    version: 9,
    name: 'checkpoints',
    sql: CHECKPOINTS_TABLE_SQL,
  },
  {
    version: 10,
    name: 'checkpoints_session_index',
    sql: CHECKPOINTS_SESSION_INDEX_SQL,
  },
  {
    version: 11,
    name: 'checkpoints_expiry_index',
    sql: CHECKPOINTS_EXPIRY_INDEX_SQL,
  },
];

/** Latest schema version — used by the migration runner. */
export const LATEST_EVENT_STORE_SCHEMA_VERSION = EVENT_STORE_MIGRATIONS.length;
