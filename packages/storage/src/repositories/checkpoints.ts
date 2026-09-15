/**
 * @oa/storage — Checkpoints Repository
 * 
 * CRUD operations for checkpoints. Checkpoints are named, user-facing
 * state markers with optional TTL-based expiration.
 */

import type { DatabaseManager } from '../database';
import type {
  CheckpointRecord,
  ListCheckpointsOptions,
} from '../types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// Note: The checkpoints table is also defined in event-store/schema.ts
// This repository assumes the table already exists.

// ---------------------------------------------------------------------------
// CheckpointsRepository
// ---------------------------------------------------------------------------

export class CheckpointsRepository {
  private readonly db: DatabaseManager;

  // Prepared statements
  private readonly _stmtInsert: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtGetById: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtUpdateLabel: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtDeleteById: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtDeleteForSession: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtDeleteExpired: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtCountForSession: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtTouchAccess: ReturnType<DatabaseManager['prepare']> | null = null;

  constructor(db: DatabaseManager) {
    this.db = db;

    // Prepare statements
    this._stmtInsert = this.db.prepare(`
      INSERT INTO checkpoints (
        id, session_id, at_seq, state, timestamp, label, expires_at
      ) VALUES (
        @id, @sessionId, @atSeq, @state, @timestamp, @label, @expiresAt
      )
    `);

    this._stmtGetById = this.db.prepare(`
      SELECT * FROM checkpoints WHERE id = ?
    `);

    this._stmtUpdateLabel = this.db.prepare(`
      UPDATE checkpoints SET label = ? WHERE id = ?
    `);

    this._stmtDeleteById = this.db.prepare(`
      DELETE FROM checkpoints WHERE id = ?
    `);

    this._stmtDeleteForSession = this.db.prepare(`
      DELETE FROM checkpoints WHERE session_id = ?
    `);

    this._stmtDeleteExpired = this.db.prepare(`
      DELETE FROM checkpoints WHERE expires_at IS NOT NULL AND expires_at < ?
    `);

    this._stmtCountForSession = this.db.prepare(`
      SELECT COUNT(*) as count FROM checkpoints WHERE session_id = ?
    `);

    this._stmtTouchAccess = this.db.prepare(`
      UPDATE checkpoints SET timestamp = ? WHERE id = ?
    `);
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /**
   * Create a new checkpoint.
   */
  create(checkpoint: CheckpointRecord): void {
    this._stmtInsert!.run({
      id: checkpoint.id,
      sessionId: checkpoint.session_id,
      atSeq: checkpoint.at_seq,
      state: checkpoint.state,
      timestamp: checkpoint.timestamp,
      label: checkpoint.label ?? null,
      expiresAt: checkpoint.expires_at ?? null,
    });
  }

  /**
   * Get a checkpoint by ID.
   */
  getById(id: string): CheckpointRecord | null {
    return this._stmtGetById!.get(id) as CheckpointRecord | null;
  }

  /**
   * Get a checkpoint by ID, filtering out expired ones.
   */
  getValidById(id: string, now: number): CheckpointRecord | null {
    const sql = `
      SELECT * FROM checkpoints
      WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)
    `;
    return this.db.prepare(sql).get(id, now) as CheckpointRecord | null;
  }

  /**
   * Update the label of a checkpoint.
   */
  updateLabel(id: string, label: string): boolean {
    const result = this._stmtUpdateLabel!.run(label, id);
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Deletion
  // -------------------------------------------------------------------------

  /**
   * Delete a checkpoint by ID.
   */
  deleteById(id: string): boolean {
    const result = this._stmtDeleteById!.run(id);
    return result.changes > 0;
  }

  /**
   * Delete all checkpoints for a session.
   */
  deleteForSession(sessionId: string): number {
    const result = this._stmtDeleteForSession!.run(sessionId);
    return result.changes;
  }

  /**
   * Delete all expired checkpoints.
   */
  deleteExpired(now: number): number {
    const result = this._stmtDeleteExpired!.run(now);
    return result.changes;
  }

  /**
   * Delete checkpoints older than a given timestamp.
   */
  deleteOlderThan(sessionId: string, olderThan: number): number {
    const result = this.db.prepare(`
      DELETE FROM checkpoints
      WHERE session_id = ? AND timestamp < ?
    `).run(sessionId, olderThan);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * List checkpoints for a session.
   */
  list(
    sessionId: string,
    options: ListCheckpointsOptions = {}
  ): CheckpointRecord[] {
    const { offset = 0, limit = 50, includeExpired = false } = options;

    const conditions: string[] = ['session_id = ?'];
    const params: unknown[] = [sessionId];

    if (!includeExpired) {
      conditions.push('(expires_at IS NULL OR expires_at > ?)');
      params.push(Date.now() * 1000);
    }

    const whereClause = conditions.join(' AND ');

    const sql = `
      SELECT * FROM checkpoints
      WHERE ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `;

    return this.db.prepare(sql).all(...params, limit, offset) as CheckpointRecord[];
  }

  /**
   * Get the latest checkpoint for a session.
   */
  getLatest(sessionId: string, now: number): CheckpointRecord | null {
    const sql = `
      SELECT * FROM checkpoints
      WHERE session_id = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY timestamp DESC
      LIMIT 1
    `;
    return this.db.prepare(sql).get(sessionId, now) as CheckpointRecord | null;
  }

  /**
   * Get the checkpoint at or before a specific seq.
   */
  getAtOrBeforeSeq(
    sessionId: string,
    seq: number,
    now: number
  ): CheckpointRecord | null {
    const sql = `
      SELECT * FROM checkpoints
      WHERE session_id = ? AND at_seq <= ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY at_seq DESC
      LIMIT 1
    `;
    return this.db.prepare(sql).get(sessionId, seq, now) as CheckpointRecord | null;
  }

  /**
   * Get the checkpoint at or after a specific seq.
   */
  getAtOrAfterSeq(
    sessionId: string,
    seq: number,
    now: number
  ): CheckpointRecord | null {
    const sql = `
      SELECT * FROM checkpoints
      WHERE session_id = ? AND at_seq >= ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY at_seq ASC
      LIMIT 1
    `;
    return this.db.prepare(sql).get(sessionId, seq, now) as CheckpointRecord | null;
  }

  /**
   * Count checkpoints for a session.
   */
  countForSession(sessionId: string): number {
    const row = this._stmtCountForSession!.get(sessionId) as { count: number };
    return row.count;
  }

  /**
   * Count valid (non-expired) checkpoints for a session.
   */
  countValidForSession(sessionId: string, now: number): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM checkpoints
      WHERE session_id = ? AND (expires_at IS NULL OR expires_at > ?)
    `).get(sessionId, now) as { count: number };
    return row.count;
  }

  /**
   * Check if a checkpoint exists.
   */
  exists(id: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM checkpoints WHERE id = ?').get(id);
    return row !== undefined;
  }

  // -------------------------------------------------------------------------
  // Expiration management
  // -------------------------------------------------------------------------

  /**
   * Set or update the expiration of a checkpoint.
   */
  setExpiration(id: string, expiresAt: number | null): boolean {
    const result = this.db.prepare(`
      UPDATE checkpoints SET expires_at = ? WHERE id = ?
    `).run(expiresAt, id);
    return result.changes > 0;
  }

  /**
   * Extend the expiration of a checkpoint by a delta (microseconds).
   */
  extendExpiration(id: string, deltaMicros: number): boolean {
    const result = this.db.prepare(`
      UPDATE checkpoints
      SET expires_at = CASE
        WHEN expires_at IS NULL THEN NULL
        ELSE expires_at + ?
      END
      WHERE id = ?
    `).run(deltaMicros, id);
    return result.changes > 0;
  }

  /**
   * Get all checkpoints expiring before a given timestamp.
   */
  getExpiringBefore(timestamp: number): CheckpointRecord[] {
    const sql = `
      SELECT * FROM checkpoints
      WHERE expires_at IS NOT NULL AND expires_at < ?
      ORDER BY expires_at ASC
    `;
    return this.db.prepare(sql).all(timestamp) as CheckpointRecord[];
  }

  // -------------------------------------------------------------------------
  // Pruning
  // -------------------------------------------------------------------------

  /**
   * Keep only the latest N checkpoints for a session, delete the rest.
   */
  pruneToLatest(sessionId: string, keepLatest: number = 10): number {
    const result = this.db.prepare(`
      DELETE FROM checkpoints
      WHERE session_id = ?
        AND id NOT IN (
          SELECT id FROM checkpoints
          WHERE session_id = ?
          ORDER BY timestamp DESC
          LIMIT ?
        )
    `).run(sessionId, sessionId, keepLatest);
    return result.changes;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCheckpointsRepository(
  db: DatabaseManager
): CheckpointsRepository {
  return new CheckpointsRepository(db);
}
