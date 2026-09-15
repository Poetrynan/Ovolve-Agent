/**
 * @oa/storage — Sessions Repository
 * 
 * CRUD operations for session records. Uses prepared statements for
 * all queries.
 */

import type { DatabaseManager } from '../database';
import type {
  ListSessionsOptions,
  SessionRecord,
} from '../types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const SESSIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id                    TEXT    PRIMARY KEY,
    title                 TEXT    NOT NULL DEFAULT '',
    archived              INTEGER NOT NULL DEFAULT 0,
    deleted               INTEGER NOT NULL DEFAULT 0,
    phase                 TEXT    NOT NULL DEFAULT 'idle',
    last_seq              INTEGER NOT NULL DEFAULT 0,
    last_event_timestamp  INTEGER NOT NULL DEFAULT 0,
    event_count           INTEGER NOT NULL DEFAULT 0,
    message_count         INTEGER NOT NULL DEFAULT 0,
    error_count           INTEGER NOT NULL DEFAULT 0,
    last_error            TEXT    DEFAULT NULL,
    metadata              TEXT    NOT NULL DEFAULT '{}',
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
  );
`;

export const SESSIONS_PHASE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_sessions_phase
    ON sessions (phase);
`;

export const SESSIONS_ARCHIVED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_sessions_archived
    ON sessions (archived);
`;

export const SESSIONS_UPDATED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_sessions_updated
    ON sessions (updated_at DESC);
`;

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export const SESSIONS_MIGRATIONS = [
  { version: 1, name: 'sessions', sql: SESSIONS_TABLE_SQL },
  { version: 2, name: 'sessions_phase_index', sql: SESSIONS_PHASE_INDEX_SQL },
  { version: 3, name: 'sessions_archived_index', sql: SESSIONS_ARCHIVED_INDEX_SQL },
  { version: 4, name: 'sessions_updated_index', sql: SESSIONS_UPDATED_INDEX_SQL },
];

// ---------------------------------------------------------------------------
// SessionsRepository
// ---------------------------------------------------------------------------

export class SessionsRepository {
  private readonly db: DatabaseManager;

  // Prepared statements
  private readonly _stmtInsert: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtSelectById: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtUpdate: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtSoftDelete: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtHardDelete: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtArchive: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtRestore: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtCount: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtExists: ReturnType<DatabaseManager['prepare']> | null = null;

  constructor(db: DatabaseManager) {
    this.db = db;
    this.ensureSchema();

    // Prepare statements
    this._stmtInsert = this.db.prepare(`
      INSERT INTO sessions (
        id, title, archived, deleted, phase, last_seq, last_event_timestamp,
        event_count, message_count, error_count, last_error, metadata,
        created_at, updated_at
      ) VALUES (
        @id, @title, @archived, @deleted, @phase, @lastSeq, @lastEventTimestamp,
        @eventCount, @messageCount, @errorCount, @lastError, @metadata,
        @createdAt, @updatedAt
      )
    `);

    this._stmtSelectById = this.db.prepare(`
      SELECT * FROM sessions WHERE id = ?
    `);

    this._stmtUpdate = this.db.prepare(`
      UPDATE sessions SET
        title = @title,
        phase = @phase,
        last_seq = @lastSeq,
        last_event_timestamp = @lastEventTimestamp,
        event_count = @eventCount,
        message_count = @messageCount,
        error_count = @errorCount,
        last_error = @lastError,
        metadata = @metadata,
        updated_at = @updatedAt
      WHERE id = @id
    `);

    this._stmtSoftDelete = this.db.prepare(`
      UPDATE sessions SET deleted = 1, updated_at = ? WHERE id = ?
    `);

    this._stmtHardDelete = this.db.prepare(`
      DELETE FROM sessions WHERE id = ?
    `);

    this._stmtArchive = this.db.prepare(`
      UPDATE sessions SET archived = 1, updated_at = ? WHERE id = ?
    `);

    this._stmtRestore = this.db.prepare(`
      UPDATE sessions SET archived = 0, deleted = 0, updated_at = ? WHERE id = ?
    `);

    this._stmtCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM sessions
      WHERE deleted = 0
        AND (@includeArchived = 1 OR archived = 0)
        AND (@phase IS NULL OR phase = @phase)
    `);

    this._stmtExists = this.db.prepare(`
      SELECT 1 FROM sessions WHERE id = ?
    `);
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private ensureSchema(): void {
    this.db.migrate('sessions', SESSIONS_MIGRATIONS);
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /**
   * Create a new session.
   */
  create(session: SessionRecord): void {
    this._stmtInsert!.run({
      id: session.id,
      title: session.title,
      archived: session.archived,
      deleted: session.deleted,
      phase: session.phase,
      lastSeq: session.last_seq,
      lastEventTimestamp: session.last_event_timestamp,
      eventCount: session.event_count,
      messageCount: session.message_count,
      errorCount: session.error_count,
      lastError: session.last_error,
      metadata: session.metadata,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
    });
  }

  /**
   * Get a session by ID.
   */
  getById(id: string): SessionRecord | null {
    return this._stmtSelectById!.get(id) as SessionRecord | null;
  }

  /**
   * Update a session.
   */
  update(
    id: string,
    updates: Partial<Omit<SessionRecord, 'id' | 'created_at'>>,
    updatedAt: number
  ): boolean {
    const existing = this.getById(id);
    if (!existing) return false;

    const merged: SessionRecord = {
      ...existing,
      ...updates,
      id,
      created_at: existing.created_at,
      updated_at: updatedAt,
    };

    const result = this._stmtUpdate!.run({
      id: merged.id,
      title: merged.title,
      phase: merged.phase,
      lastSeq: merged.last_seq,
      lastEventTimestamp: merged.last_event_timestamp,
      eventCount: merged.event_count,
      messageCount: merged.message_count,
      errorCount: merged.error_count,
      lastError: merged.last_error,
      metadata: merged.metadata,
      updatedAt: merged.updated_at,
    });

    return result.changes > 0;
  }

  /**
   * Soft-delete a session (mark as deleted).
   */
  softDelete(id: string, timestamp: number): boolean {
    const result = this._stmtSoftDelete!.run(timestamp, id);
    return result.changes > 0;
  }

  /**
   * Hard-delete a session (permanently remove).
   */
  hardDelete(id: string): boolean {
    const result = this._stmtHardDelete!.run(id);
    return result.changes > 0;
  }

  /**
   * Archive a session.
   */
  archive(id: string, timestamp: number): boolean {
    const result = this._stmtArchive!.run(timestamp, id);
    return result.changes > 0;
  }

  /**
   * Restore an archived or deleted session.
   */
  restore(id: string, timestamp: number): boolean {
    const result = this._stmtRestore!.run(timestamp, id);
    return result.changes > 0;
  }

  /**
   * Check if a session exists.
   */
  exists(id: string): boolean {
    return this._stmtExists!.get(id) !== undefined;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * List sessions with optional filtering.
   */
  list(options: ListSessionsOptions = {}): SessionRecord[] {
    const {
      offset = 0,
      limit = 50,
      includeArchived = false,
      includeDeleted = false,
      phase,
    } = options;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (!includeDeleted) {
      conditions.push('deleted = 0');
    }
    if (!includeArchived) {
      conditions.push('archived = 0');
    }
    if (phase) {
      conditions.push('phase = ?');
      params.push(phase);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const sql = `
      SELECT * FROM sessions
      ${whereClause}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `;

    return this.db.prepare(sql).all(...params, limit, offset) as SessionRecord[];
  }

  /**
   * Count sessions with optional filtering.
   */
  count(
    includeArchived: boolean = false,
    phase?: string
  ): number {
    const row = this._stmtCount!.get({
      includeArchived: includeArchived ? 1 : 0,
      phase: phase ?? null,
    }) as { count: number };
    return row.count;
  }

  /**
   * Get the most recently updated sessions.
   */
  getRecent(limit: number = 10): SessionRecord[] {
    const sql = `
      SELECT * FROM sessions
      WHERE deleted = 0
      ORDER BY updated_at DESC
      LIMIT ?
    `;
    return this.db.prepare(sql).all(limit) as SessionRecord[];
  }

  /**
   * Search sessions by title (case-insensitive).
   */
  searchByTitle(query: string, limit: number = 20): SessionRecord[] {
    const sql = `
      SELECT * FROM sessions
      WHERE deleted = 0 AND title LIKE ?
      ORDER BY updated_at DESC
      LIMIT ?
    `;
    return this.db.prepare(sql).all(`%${query}%`, limit) as SessionRecord[];
  }

  /**
   * Update session statistics after an event is appended.
   */
  updateStats(
    id: string,
    stats: {
      lastSeq?: number;
      lastEventTimestamp?: number;
      eventCount?: number;
      messageCount?: number;
      errorCount?: number;
      lastError?: string | null;
      phase?: string;
    },
    updatedAt: number
  ): boolean {
    const existing = this.getById(id);
    if (!existing) return false;

    const result = this.db.prepare(`
      UPDATE sessions SET
        last_seq = COALESCE(@lastSeq, last_seq),
        last_event_timestamp = COALESCE(@lastEventTimestamp, last_event_timestamp),
        event_count = COALESCE(@eventCount, event_count),
        message_count = COALESCE(@messageCount, message_count),
        error_count = COALESCE(@errorCount, error_count),
        last_error = COALESCE(@lastError, last_error),
        phase = COALESCE(@phase, phase),
        updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id,
      lastSeq: stats.lastSeq ?? null,
      lastEventTimestamp: stats.lastEventTimestamp ?? null,
      eventCount: stats.eventCount ?? null,
      messageCount: stats.messageCount ?? null,
      errorCount: stats.errorCount ?? null,
      lastError: stats.lastError ?? null,
      phase: stats.phase ?? null,
      updatedAt,
    });

    return result.changes > 0;
  }

  /**
   * Delete all soft-deleted sessions older than the given timestamp.
   */
  purgeDeleted(olderThanTimestamp: number): number {
    const result = this.db.prepare(`
      DELETE FROM sessions WHERE deleted = 1 AND updated_at < ?
    `).run(olderThanTimestamp);
    return result.changes;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionsRepository(db: DatabaseManager): SessionsRepository {
  return new SessionsRepository(db);
}
