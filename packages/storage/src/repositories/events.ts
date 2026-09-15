/**
 * @oa/storage — Events Repository
 * 
 * Event query operations. The EventStore class handles writes; this
 * repository provides read-only query access for other parts of the system.
 */

import type { DatabaseManager } from '../database';
import type {
  EventRecord,
  ListEventsOptions,
  PaginationOptions,
  TimeRangeOptions,
} from '../types';

// ---------------------------------------------------------------------------
// EventsRepository
// ---------------------------------------------------------------------------

export class EventsRepository {
  private readonly db: DatabaseManager;

  // Prepared statements
  private readonly _stmtGetBySeq: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtGetLatestForSession: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtCountForSession: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtGetByChainHash: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtGetMinSeq: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtGetMaxSeq: ReturnType<DatabaseManager['prepare']> | null = null;

  constructor(db: DatabaseManager) {
    this.db = db;

    // Prepare statements
    this._stmtGetBySeq = this.db.prepare(`
      SELECT * FROM events WHERE seq = ?
    `);

    this._stmtGetLatestForSession = this.db.prepare(`
      SELECT * FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 1
    `);

    this._stmtCountForSession = this.db.prepare(`
      SELECT COUNT(*) as count FROM events WHERE session_id = ?
    `);

    this._stmtGetByChainHash = this.db.prepare(`
      SELECT * FROM events WHERE chain_hash = ?
    `);

    this._stmtGetMinSeq = this.db.prepare(`
      SELECT MIN(seq) as minSeq FROM events WHERE session_id = ?
    `);

    this._stmtGetMaxSeq = this.db.prepare(`
      SELECT MAX(seq) as maxSeq FROM events WHERE session_id = ?
    `);
  }

  // -------------------------------------------------------------------------
  // Single event queries
  // -------------------------------------------------------------------------

  /**
   * Get an event by its sequence number.
   */
  getBySeq(seq: number): EventRecord | null {
    return this._stmtGetBySeq!.get(seq) as EventRecord | null;
  }

  /**
   * Get an event by its chain hash.
   */
  getByChainHash(chainHash: string): EventRecord | null {
    return this._stmtGetByChainHash!.get(chainHash) as EventRecord | null;
  }

  /**
   * Get the latest event for a session.
   */
  getLatestForSession(sessionId: string): EventRecord | null {
    return this._stmtGetLatestForSession!.get(sessionId) as EventRecord | null;
  }

  /**
   * Get the minimum seq for a session.
   */
  getMinSeq(sessionId: string): number | null {
    const row = this._stmtGetMinSeq!.get(sessionId) as { minSeq: number | null };
    return row.minSeq;
  }

  /**
   * Get the maximum seq for a session.
   */
  getMaxSeq(sessionId: string): number | null {
    const row = this._stmtGetMaxSeq!.get(sessionId) as { maxSeq: number | null };
    return row.maxSeq;
  }

  // -------------------------------------------------------------------------
  // Stream queries
  // -------------------------------------------------------------------------

  /**
   * Read a stream of events for a session with filtering.
   */
  readStream(
    sessionId: string,
    options: ListEventsOptions = {}
  ): EventRecord[] {
    const {
      offset = 0,
      limit = 100,
      fromTimestamp,
      toTimestamp,
      eventTypes,
      fromSeq,
      toSeq,
    } = options;

    const conditions: string[] = ['session_id = ?'];
    const params: unknown[] = [sessionId];

    if (fromSeq !== undefined) {
      conditions.push('seq >= ?');
      params.push(fromSeq);
    }
    if (toSeq !== undefined) {
      conditions.push('seq <= ?');
      params.push(toSeq);
    }
    if (fromTimestamp !== undefined) {
      conditions.push('timestamp >= ?');
      params.push(fromTimestamp);
    }
    if (toTimestamp !== undefined) {
      conditions.push('timestamp <= ?');
      params.push(toTimestamp);
    }
    if (eventTypes && eventTypes.length > 0) {
      const placeholders = eventTypes.map(() => '?').join(', ');
      conditions.push(`event_type IN (${placeholders})`);
      params.push(...eventTypes);
    }

    const whereClause = conditions.join(' AND ');

    const sql = `
      SELECT * FROM events
      WHERE ${whereClause}
      ORDER BY seq ASC
      LIMIT ? OFFSET ?
    `;

    return this.db.prepare(sql).all(...params, limit, offset) as EventRecord[];
  }

  /**
   * Read events in reverse order (latest first).
   */
  readStreamReverse(
    sessionId: string,
    options: ListEventsOptions = {}
  ): EventRecord[] {
    const {
      offset = 0,
      limit = 100,
      fromTimestamp,
      toTimestamp,
      eventTypes,
      fromSeq,
      toSeq,
    } = options;

    const conditions: string[] = ['session_id = ?'];
    const params: unknown[] = [sessionId];

    if (fromSeq !== undefined) {
      conditions.push('seq >= ?');
      params.push(fromSeq);
    }
    if (toSeq !== undefined) {
      conditions.push('seq <= ?');
      params.push(toSeq);
    }
    if (fromTimestamp !== undefined) {
      conditions.push('timestamp >= ?');
      params.push(fromTimestamp);
    }
    if (toTimestamp !== undefined) {
      conditions.push('timestamp <= ?');
      params.push(toTimestamp);
    }
    if (eventTypes && eventTypes.length > 0) {
      const placeholders = eventTypes.map(() => '?').join(', ');
      conditions.push(`event_type IN (${placeholders})`);
      params.push(...eventTypes);
    }

    const whereClause = conditions.join(' AND ');

    const sql = `
      SELECT * FROM events
      WHERE ${whereClause}
      ORDER BY seq DESC
      LIMIT ? OFFSET ?
    `;

    return this.db.prepare(sql).all(...params, limit, offset) as EventRecord[];
  }

  /**
   * Get events by seq range (inclusive).
   */
  getBySeqRange(
    sessionId: string,
    fromSeq: number,
    toSeq: number
  ): EventRecord[] {
    const sql = `
      SELECT * FROM events
      WHERE session_id = ? AND seq >= ? AND seq <= ?
      ORDER BY seq ASC
    `;
    return this.db.prepare(sql).all(sessionId, fromSeq, toSeq) as EventRecord[];
  }

  /**
   * Get events after a specific seq.
   */
  getAfterSeq(sessionId: string, seq: number, limit: number = 100): EventRecord[] {
    const sql = `
      SELECT * FROM events
      WHERE session_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `;
    return this.db.prepare(sql).all(sessionId, seq, limit) as EventRecord[];
  }

  // -------------------------------------------------------------------------
  // Counting
  // -------------------------------------------------------------------------

  /**
   * Count events for a session.
   */
  countForSession(sessionId: string): number {
    const row = this._stmtCountForSession!.get(sessionId) as { count: number };
    return row.count;
  }

  /**
   * Count events by type for a session.
   */
  countByType(sessionId: string): Record<string, number> {
    const sql = `
      SELECT event_type, COUNT(*) as count
      FROM events
      WHERE session_id = ?
      GROUP BY event_type
    `;
    const rows = this.db.prepare(sql).all(sessionId) as Array<{
      event_type: string;
      count: number;
    }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.event_type] = row.count;
    }
    return result;
  }

  /**
   * Count events across all sessions.
   */
  countAll(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };
    return row.count;
  }

  // -------------------------------------------------------------------------
  // Time-based queries
  // -------------------------------------------------------------------------

  /**
   * Get events within a time range.
   */
  getByTimeRange(
    sessionId: string,
    fromTimestamp: number,
    toTimestamp: number,
    options: PaginationOptions = {}
  ): EventRecord[] {
    const { offset = 0, limit = 100 } = options;
    const sql = `
      SELECT * FROM events
      WHERE session_id = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
      LIMIT ? OFFSET ?
    `;
    return this.db.prepare(sql).all(
      sessionId,
      fromTimestamp,
      toTimestamp,
      limit,
      offset
    ) as EventRecord[];
  }

  /**
   * Get the first event timestamp for a session.
   */
  getFirstTimestamp(sessionId: string): number | null {
    const row = this.db.prepare(`
      SELECT MIN(timestamp) as ts FROM events WHERE session_id = ?
    `).get(sessionId) as { ts: number | null };
    return row.ts;
  }

  /**
   * Get the last event timestamp for a session.
   */
  getLastTimestamp(sessionId: string): number | null {
    const row = this.db.prepare(`
      SELECT MAX(timestamp) as ts FROM events WHERE session_id = ?
    `).get(sessionId) as { ts: number | null };
    return row.ts;
  }

  // -------------------------------------------------------------------------
  // Type-based queries
  // -------------------------------------------------------------------------

  /**
   * Get events of a specific type for a session.
   */
  getByType(
    sessionId: string,
    eventType: string,
    options: PaginationOptions = {}
  ): EventRecord[] {
    const { offset = 0, limit = 100 } = options;
    const sql = `
      SELECT * FROM events
      WHERE session_id = ? AND event_type = ?
      ORDER BY seq ASC
      LIMIT ? OFFSET ?
    `;
    return this.db.prepare(sql).all(sessionId, eventType, limit, offset) as EventRecord[];
  }

  /**
   * Get distinct event types for a session.
   */
  getDistinctTypes(sessionId: string): string[] {
    const sql = `
      SELECT DISTINCT event_type FROM events WHERE session_id = ? ORDER BY event_type
    `;
    const rows = this.db.prepare(sql).all(sessionId) as Array<{ event_type: string }>;
    return rows.map((r) => r.event_type);
  }

  // -------------------------------------------------------------------------
  // Chain verification helpers
  // -------------------------------------------------------------------------

  /**
   * Get the chain hash for a specific seq.
   */
  getChainHash(seq: number): string | null {
    const row = this.db.prepare(`
      SELECT chain_hash FROM events WHERE seq = ?
    `).get(seq) as { chain_hash: string } | undefined;
    return row?.chain_hash ?? null;
  }

  /**
   * Get all events for chain verification (ordered by seq).
   */
  getForVerification(
    sessionId: string,
    fromSeq: number = 1
  ): EventRecord[] {
    const sql = `
      SELECT * FROM events
      WHERE session_id = ? AND seq >= ?
      ORDER BY seq ASC
    `;
    return this.db.prepare(sql).all(sessionId, fromSeq) as EventRecord[];
  }

  // -------------------------------------------------------------------------
  // Bulk operations
  // -------------------------------------------------------------------------

  /**
   * Get events for multiple sessions.
   */
  getForSessions(
    sessionIds: string[],
    options: PaginationOptions = {}
  ): EventRecord[] {
    if (sessionIds.length === 0) return [];
    const { offset = 0, limit = 100 } = options;
    const placeholders = sessionIds.map(() => '?').join(', ');
    const sql = `
      SELECT * FROM events
      WHERE session_id IN (${placeholders})
      ORDER BY session_id, seq ASC
      LIMIT ? OFFSET ?
    `;
    return this.db.prepare(sql).all(...sessionIds, limit, offset) as EventRecord[];
  }

  /**
   * Get the latest N events across all sessions.
   */
  getLatestGlobal(limit: number = 50): EventRecord[] {
    const sql = `
      SELECT * FROM events
      ORDER BY seq DESC
      LIMIT ?
    `;
    return this.db.prepare(sql).all(limit) as EventRecord[];
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEventsRepository(db: DatabaseManager): EventsRepository {
  return new EventsRepository(db);
}
