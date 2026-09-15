/**
 * @oa/session-core — Session Parking Buffers
 *
 * Manages in-memory parking of in-flight session state. When the app is
 * closing, a workspace switch occurs, or a stall is detected, sessions are
 * "parked" — their full in-memory state is serialized to the session_state_cache
 * table so it can be restored seamlessly on next launch or upon resume.
 *
 * Design:
 * - Parking is synchronous and fast (single INSERT).
 * - Restoration reconstructs both SessionState and TurnState.
 * - The cache is append-only; old entries for the same session are pruned on
 *   successful restoration.
 */

import type {
  ParkedSession,
  SessionState,
  TurnState,
  ParkReason,
  TokenUsage,
} from './types';

// ---------------------------------------------------------------------------
// SQL schema for the session state cache table
// ---------------------------------------------------------------------------

export const SESSION_STATE_CACHE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_state_cache (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT    NOT NULL,
    state       TEXT    NOT NULL,
    turn_state  TEXT    NOT NULL NULL,
    parked_at   INTEGER NOT NULL,
    reason      TEXT    NOT NULL,
    at_seq      INTEGER NOT NULL DEFAULT 0
  );
`;

export const SESSION_STATE_CACHE_SESSION_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_session_state_cache_session
    ON session_state_cache (session_id, parked_at DESC);
`;

// ---------------------------------------------------------------------------
// Default turn state helpers
// ---------------------------------------------------------------------------

export function createInitialTurnState(): TurnState {
  return {
    turnId: '',
    phase: 'idle',
    partialResponse: '',
    pendingToolCalls: [],
    completedToolCalls: [],
    tokenUsage: createZeroTokenUsage(),
    metadata: {},
  };
}

export function createZeroTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

// ---------------------------------------------------------------------------
// SessionBuffers — manages parking and restoration
// ---------------------------------------------------------------------------

export interface SessionBuffersConfig {
  /** Storage database manager. */
  database: import('@oa/storage').DatabaseManager;
}

export class SessionBuffers {
  private readonly db: import('@oa/storage').DatabaseManager;

  // Prepared statements
  private readonly _stmtInsert: ReturnType<import('@oa/storage').DatabaseManager['prepare']> | null = null;
  private readonly _stmtSelectLatest: ReturnType<import('@oa/storage').DatabaseManager['prepare']> | null = null;
  private readonly _stmtSelectAll: ReturnType<import('@oa/storage').DatabaseManager['prepare']> | null = null;
  private readonly _stmtDeleteSession: ReturnType<import('@oa/storage').DatabaseManager['prepare']> | null = null;
  private readonly _stmtDeleteById: ReturnType<import('@oa/storage').DatabaseManager['prepare']> | null = null;

  constructor(config: SessionBuffersConfig) {
    if (!config.database) {
      throw new Error('SessionBuffers requires a DatabaseManager instance');
    }
    this.db = config.database;
    this.ensureSchema();

    this._stmtInsert = this.db.prepare(`
      INSERT INTO session_state_cache (session_id, state, turn_state, parked_at, reason, at_seq)
      VALUES (@sessionId, @state, @turnState, @parkedAt, @reason, @atSeq)
    `);

    this._stmtSelectLatest = this.db.prepare(`
      SELECT id, session_id, state, turn_state, parked_at, reason, at_seq
      FROM session_state_cache
      WHERE session_id = ?
      ORDER BY parked_at DESC
      LIMIT 1
    `);

    this._stmtSelectAll = this.db.prepare(`
      SELECT id, session_id, state, turn_state, parked_at, reason, at_seq
      FROM session_state_cache
      WHERE session_id = ?
      ORDER BY parked_at DESC
    `);

    this._stmtDeleteSession = this.db.prepare(`
      DELETE FROM session_state_cache WHERE session_id = ?
    `);

    this._stmtDeleteById = this.db.prepare(`
      DELETE FROM session_state_cache WHERE id = ?
    `);
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private ensureSchema(): void {
    this.db.exec(SESSION_STATE_CACHE_TABLE_SQL);
    this.db.exec(SESSION_STATE_CACHE_SESSION_INDEX_SQL);
  }

  // -------------------------------------------------------------------------
  // Park — save in-flight state
  // -------------------------------------------------------------------------

  /**
   * Park a session: serialize its projected state and turn state into the
   * session_state_cache table. This is the crash-recovery mechanism.
   *
   * @param sessionId - The session to park.
   * @param state - The current projected SessionState.
   * @param turnState - The in-flight turn state.
   * @param reason - Why the session is being parked.
   * @param atSeq - The seq at which the session is parked (defaults to state.lastSeq).
   * @returns The cache entry ID.
   */
  parkSession(
    sessionId: string,
    state: SessionState,
    turnState: TurnState,
    reason: ParkReason,
    atSeq?: number
  ): number {
    const parkedAt = Date.now() * 1000;
    const seq = atSeq ?? state.lastSeq;

    const result = this._stmtInsert!.run({
      sessionId,
      state: JSON.stringify(state),
      turnState: JSON.stringify(turnState),
      parkedAt,
      reason,
      atSeq: seq,
    });

    return Number(result.lastInsertRowid);
  }

  // -------------------------------------------------------------------------
  // Restore — retrieve parked state
  // -------------------------------------------------------------------------

  /**
   * Restore the most recently parked state for a session. After successful
   * restoration, the parked entries are deleted from the cache.
   *
   * @param sessionId - The session to restore.
   * @returns The parked session data, or null if none found.
   */
  restoreSession(sessionId: string): ParkedSession | null {
    const parked = this.getParkedSession(sessionId);
    if (!parked) return null;

    // Delete all parked entries for this session after successful read.
    this._stmtDeleteSession!.run(sessionId);

    return parked;
  }

  /**
   * Get the most recent parked entry without deleting it.
   *
   * @param sessionId - The session to look up.
   * @returns The parked session data, or null if none found.
   */
  getParkedSession(sessionId: string): ParkedSession | null {
    const row = this._stmtSelectLatest!.get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;

    return this.rowToParkedSession(row);
  }

  /**
   * List all parked entries for a session (most recent first).
   *
   * @param sessionId - The session to look up.
   * @returns Array of parked session entries.
   */
  listParkedSessions(sessionId: string): ParkedSession[] {
    const rows = this._stmtSelectAll!.all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToParkedSession(row));
  }

  // -------------------------------------------------------------------------
  // Cache management
  // -------------------------------------------------------------------------

  /**
   * Check if a session has any parked state.
   *
   * @param sessionId - The session to check.
   * @returns True if parked state exists.
   */
  hasParkedState(sessionId: string): boolean {
    return this.getParkedSession(sessionId) !== null;
  }

  /**
   * Remove all parked state for a session.
   *
   * @param sessionId - The session to clear.
   * @returns Number of entries removed.
   */
  clearParkedState(sessionId: string): number {
    const result = this._stmtDeleteSession!.run(sessionId);
    return result.changes;
  }

  /**
   * Remove a specific parked entry by ID.
   *
   * @param id - The cache entry ID.
   * @returns True if the entry was deleted.
   */
  deleteParkedEntry(id: number): boolean {
    const result = this._stmtDeleteById!.run(id);
    return result.changes > 0;
  }

  /**
   * Prune parked entries older than the given timestamp.
   *
   * @param olderThanTimestamp - Microsecond timestamp threshold.
   * @returns Number of entries pruned.
   */
  pruneOlderThan(olderThanTimestamp: number): number {
    const result = this.db.prepare(`
      DELETE FROM session_state_cache WHERE parked_at < ?
    `).run(olderThanTimestamp);
    return result.changes;
  }

  /**
   * Get the count of parked sessions across all sessions.
   */
  getParkedCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT session_id) as count FROM session_state_cache
    `).get() as { count: number };
    return row.count;
  }

  // -------------------------------------------------------------------------
  // Row mapper
  // -------------------------------------------------------------------------

  private rowToParkedSession(row: Record<string, unknown>): ParkedSession {
    return {
      sessionId: row.session_id as string,
      state: JSON.parse(row.state as string) as SessionState,
      turnState: JSON.parse(row.turn_state as string) as TurnState,
      parkedAt: row.parked_at as number,
      reason: row.reason as ParkReason,
      atSeq: row.at_seq as number,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// -------------------------------------------------------------------------

export function createSessionBuffers(config: SessionBuffersConfig): SessionBuffers {
  return new SessionBuffers(config);
}
