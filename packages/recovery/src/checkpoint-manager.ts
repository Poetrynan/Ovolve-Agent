/**
 * @oa/recovery — Checkpoint Manager
 *
 * Manages session state checkpoints — named, user-facing state markers that
 * can be restored to. Checkpoints capture the full projected state at a given
 * seq and persist it in the checkpoints table.
 *
 * Features:
 * - Manual checkpoints (user-created with labels)
 * - Auto-checkpoints (created before risky operations)
 * - TTL-based expiration
 * - Max-per-session limit with FIFO eviction
 * - Restore to any checkpoint
 */

import { randomUUID } from 'node:crypto';
import type { EventType, IEventStore } from '@oa/event-store';
import type { DatabaseManager } from '@oa/storage';
import type { SessionState } from '@oa/event-store';
import type { IProjectionEngine } from '@oa/projection';
import type {
  CheckpointConfig,
  Checkpoint,
  CheckpointListItem,
  CheckpointCreatedPayload,
  CheckpointRestoredPayload,
} from './types';
import { DEFAULT_CHECKPOINT_CONFIG } from './types';

// ---------------------------------------------------------------------------
// CheckpointManager
// -------------------------------------------------------------------------

export interface CheckpointManagerConfig {
  /** Database manager for checkpoint persistence. */
  database: DatabaseManager;
  /** Event store for emitting checkpoint events. */
  eventStore: IEventStore;
  /** Projection engine for state capture. */
  projectionEngine: IProjectionEngine;
  /** Checkpoint-specific configuration. */
  checkpoint?: Partial<CheckpointConfig>;
}

export class CheckpointManager {
  private readonly db: DatabaseManager;
  private readonly eventStore: IEventStore;
  private readonly projectionEngine: IProjectionEngine;
  private readonly config: CheckpointConfig;

  // Prepared statements
  private readonly _stmtInsert: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtSelectById: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtSelectBySession: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtCountBySession: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtDeleteById: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtDeleteExpired: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtDeleteOldest: ReturnType<DatabaseManager['prepare']> | null = null;

  constructor(config: CheckpointManagerConfig) {
    if (!config.database) {
      throw new Error('CheckpointManager requires a DatabaseManager instance');
    }
    if (!config.eventStore) {
      throw new Error('CheckpointManager requires an IEventStore instance');
    }
    if (!config.projectionEngine) {
      throw new Error('CheckpointManager requires an IProjectionEngine instance');
    }

    this.db = config.database;
    this.eventStore = config.eventStore;
    this.projectionEngine = config.projectionEngine;
    this.config = { ...DEFAULT_CHECKPOINT_CONFIG, ...config.checkpoint };

    this.ensureSchema();

    this._stmtInsert = this.db.prepare(`
      INSERT INTO checkpoints (id, session_id, at_seq, state, timestamp, label, expires_at)
      VALUES (@id, @sessionId, @atSeq, @state, @timestamp, @label, @expiresAt)
    `);

    this._stmtSelectById = this.db.prepare(`
      SELECT id, session_id, at_seq, state, timestamp, label, expires_at
      FROM checkpoints WHERE id = ?
    `);

    this._stmtSelectBySession = this.db.prepare(`
      SELECT id, session_id, at_seq, state, timestamp, label, expires_at
      FROM checkpoints
      WHERE session_id = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY at_seq DESC
      LIMIT ? OFFSET ?
    `);

    this._stmtCountBySession = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM checkpoints
      WHERE session_id = ? AND (expires_at IS NULL OR expires_at > ?)
    `);

    this._stmtDeleteById = this.db.prepare(`
      DELETE FROM checkpoints WHERE id = ?
    `);

    this._stmtDeleteExpired = this.db.prepare(`
      DELETE FROM checkpoints WHERE expires_at IS NOT NULL AND expires_at < ?
    `);

    this._stmtDeleteOldest = this.db.prepare(`
      DELETE FROM checkpoints
      WHERE id IN (
        SELECT id FROM checkpoints
        WHERE session_id = ?
        ORDER BY at_seq DESC
        LIMIT -1 OFFSET ?
      )
    `);
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private ensureSchema(): void {
    // Ensure the checkpoints table exists (matches event-store schema)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id          TEXT    PRIMARY KEY,
        session_id  TEXT    NOT NULL,
        at_seq      INTEGER NOT NULL,
        state       TEXT    NOT NULL,
        timestamp   INTEGER NOT NULL,
        label       TEXT    DEFAULT NULL,
        expires_at  INTEGER DEFAULT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session
        ON checkpoints (session_id);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_checkpoints_expires
        ON checkpoints (expires_at)
        WHERE expires_at IS NOT NULL;
    `);
  }

  // -------------------------------------------------------------------------
  // Manual checkpoint
  // -------------------------------------------------------------------------

  /**
   * Create a manual checkpoint for a session. Captures the current projected
   * state and persists it with an optional label.
   *
   * @param sessionId - The session ID.
   * @param label - Optional user-facing label.
   * @param ttlMicros - Optional TTL in microseconds.
   * @returns The created checkpoint.
   */
  async createCheckpoint(
    sessionId: string,
    label?: string,
    ttlMicros?: number
  ): Promise<Checkpoint> {
    // Project current state
    const state = await this.projectionEngine.project<SessionState>(sessionId);
    const atSeq = state.lastSeq;

    if (atSeq <= 0) {
      throw new Error(`Cannot checkpoint session "${sessionId}": no events to checkpoint`);
    }

    return this.saveCheckpoint(sessionId, atSeq, state, label, ttlMicros, false);
  }

  /**
   * Create an automatic checkpoint before risky operations. Uses the default
   * TTL from config.
   *
   * @param sessionId - The session ID.
   * @returns The created checkpoint.
   */
  async autoCheckpoint(sessionId: string): Promise<Checkpoint> {
    const state = await this.projectionEngine.project<SessionState>(sessionId);
    const atSeq = state.lastSeq;

    if (atSeq <= 0) {
      throw new Error(`Cannot auto-checkpoint session "${sessionId}": no events to checkpoint`);
    }

    return this.saveCheckpoint(
      sessionId,
      atSeq,
      state,
      'auto',
      this.config.defaultTtlMicros,
      true
    );
  }

  // -------------------------------------------------------------------------
  // Restore
  // -------------------------------------------------------------------------

  /**
   * Restore a session to a previous checkpoint. Emits a CheckpointRestored
   * event and updates the session state.
   *
   * @param checkpointId - The checkpoint ID to restore.
   * @returns The checkpoint that was restored.
   */
  async restoreCheckpoint(checkpointId: string): Promise<Checkpoint> {
    const checkpoint = this.getCheckpoint(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint "${checkpointId}" not found`);
    }

    // Emit restore event
    const payload: CheckpointRestoredPayload = {
      checkpointId,
      restoredAtSeq: checkpoint.atSeq,
      previousSeq: checkpoint.state.lastSeq,
    };

    await this.eventStore.append({
      eventType: EventType.CheckpointRestored,
      sessionId: checkpoint.sessionId,
      payload,
    });

    // Invalidate projection cache so the next projection reads from events
    this.projectionEngine.invalidateCache(checkpoint.sessionId);

    return checkpoint;
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /**
   * Get a checkpoint by ID.
   *
   * @param checkpointId - The checkpoint ID.
   * @returns The checkpoint or null.
   */
  getCheckpoint(checkpointId: string): Checkpoint | null {
    const row = this._stmtSelectById!.get(checkpointId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToCheckpoint(row);
  }

  /**
   * List checkpoints for a session (most recent first, excluding expired).
   *
   * @param sessionId - The session ID.
   * @param limit - Maximum results.
   * @param offset - Pagination offset.
   * @returns Array of checkpoint list items.
   */
  listCheckpoints(
    sessionId: string,
    limit: number = 50,
    offset: number = 0
  ): CheckpointListItem[] {
    const now = Date.now() * 1000;
    const rows = this._stmtSelectBySession!.all(sessionId, now, limit, offset) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      atSeq: row.at_seq as number,
      timestamp: row.timestamp as number,
      label: row.label as string | undefined,
      expiresAt: row.expires_at as number | undefined,
      auto: (row.label as string) === 'auto',
    }));
  }

  /**
   * Count active (non-expired) checkpoints for a session.
   *
   * @param sessionId - The session ID.
   * @returns The checkpoint count.
   */
  countCheckpoints(sessionId: string): number {
    const now = Date.now() * 1000;
    const row = this._stmtCountBySession!.get(sessionId, now) as { count: number };
    return row.count;
  }

  /**
   * Delete a specific checkpoint.
   *
   * @param checkpointId - The checkpoint ID.
   * @returns True if deleted.
   */
  deleteCheckpoint(checkpointId: string): boolean {
    const result = this._stmtDeleteById!.run(checkpointId);
    return result.changes > 0;
  }

  /**
   * Delete all checkpoints for a session.
   *
   * @param sessionId - The session ID.
   * @returns Number deleted.
   */
  deleteAllForSession(sessionId: string): number {
    const result = this.db.prepare('DELETE FROM checkpoints WHERE session_id = ?').run(sessionId);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /**
   * Prune all expired checkpoints.
   *
   * @returns Number of checkpoints pruned.
   */
  pruneExpired(): number {
    const now = Date.now() * 1000;
    const result = this._stmtDeleteExpired!.run(now);
    return result.changes;
  }

  /**
   * Enforce the max-per-session limit by deleting oldest checkpoints.
   *
   * @param sessionId - The session ID.
   * @returns Number of checkpoints evicted.
   */
  enforceMaxLimit(sessionId: string): number {
    const count = this.countCheckpoints(sessionId);
    if (count <= this.config.maxCheckpointsPerSession) return 0;

    const toDelete = count - this.config.maxCheckpointsPerSession;
    // Delete oldest (lowest at_seq)
    const result = this.db.prepare(`
      DELETE FROM checkpoints
      WHERE id IN (
        SELECT id FROM checkpoints
        WHERE session_id = ? AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY at_seq ASC
        LIMIT ?
      )
    `).run(sessionId, Date.now() * 1000, toDelete);

    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async saveCheckpoint(
    sessionId: string,
    atSeq: number,
    state: SessionState,
    label?: string,
    ttlMicros?: number,
    auto: boolean = false
  ): Promise<Checkpoint> {
    const id = `ckpt_${randomUUID()}`;
    const timestamp = Date.now() * 1000;
    const expiresAt = ttlMicros ? timestamp + ttlMicros : undefined;

    this._stmtInsert!.run({
      id,
      sessionId,
      atSeq,
      state: JSON.stringify(state),
      timestamp,
      label: label ?? null,
      expiresAt: expiresAt ?? null,
    });

    // Enforce max limit
    this.enforceMaxLimit(sessionId);

    // Emit event
    const payload: CheckpointCreatedPayload = {
      checkpointId: id,
      atSeq,
      label,
      auto,
    };

    await this.eventStore.append({
      eventType: EventType.CheckpointCreated,
      sessionId,
      payload,
    });

    return {
      id,
      sessionId,
      atSeq,
      state,
      timestamp,
      label,
      expiresAt,
      auto,
    };
  }

  private rowToCheckpoint(row: Record<string, unknown>): Checkpoint {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      atSeq: row.at_seq as number,
      state: JSON.parse(row.state as string) as SessionState,
      timestamp: row.timestamp as number,
      label: row.label as string | undefined,
      expiresAt: row.expires_at as number | undefined,
      auto: (row.label as string) === 'auto',
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCheckpointManager(config: CheckpointManagerConfig): CheckpointManager {
  return new CheckpointManager(config);
}
