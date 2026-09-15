/**
 * @oa/event-store — ProjectionEngine
 * 
 * Projects events into application state. Supports full replay, incremental
 * updates, and custom reducers per event type.
 */

import { createHash } from 'node:crypto';
import type {
  AgentEvent,
  EventReducer,
  ProjectionEngineConfig,
} from './types';
import { EventType } from './types';
import type { DatabaseManager } from '@oa/storage';

// ---------------------------------------------------------------------------
// ProjectionEngine
// ---------------------------------------------------------------------------

export interface IProjectionEngine {
  project<S>(sessionId: string, targetSeq?: number): Promise<S>;
  projectFromEvents<S>(events: AgentEvent[]): S;
  applyEvent<S>(state: S, event: AgentEvent): S;
  scheduleUpdate(sessionId: string, seq: number): void;
}

export class ProjectionEngine implements IProjectionEngine {
  private readonly db: DatabaseManager;
  private readonly reducers: Partial<Record<EventType, EventReducer>>;
  private readonly initialState: () => unknown;

  /** Pending projection updates (sessionId -> latest seq). */
  private readonly pendingUpdates: Map<string, number> = new Map();
  /** Projection cache (sessionId -> cached projected state). */
  private readonly cache: Map<string, { atSeq: number; state: unknown }> = new Map();
  /** Whether a projection update is currently running. */
  private updateRunning: boolean = false;

  constructor(config: ProjectionEngineConfig) {
    if (!config.database) {
      throw new Error('ProjectionEngine requires a DatabaseManager instance');
    }
    this.db = config.database;
    this.reducers = config.reducers;
    this.initialState = config.initialState;
  }

  // -------------------------------------------------------------------------
  // Full projection
  // -------------------------------------------------------------------------

  /**
   * Project current state from events. If `targetSeq` is provided, project
   * state up to and including that seq; otherwise project the full stream.
   */
  async project<S>(sessionId: string, targetSeq?: number): Promise<S> {
    // Try to start from the latest cached state or snapshot
    const cached = this.cache.get(sessionId);
    let fromSeq = 0;
    let state: unknown = this.initialState();

    // First, try to find a snapshot to start from
    const snapshot = this.getLatestSnapshotRow(sessionId);
    if (snapshot && (!targetSeq || snapshot.at_seq <= targetSeq)) {
      fromSeq = snapshot.at_seq;
      state = JSON.parse(snapshot.state as string);
    }

    // If we have a cache that's more recent, use it
    if (cached && cached.atSeq > fromSeq && (!targetSeq || cached.atSeq <= targetSeq)) {
      fromSeq = cached.atSeq;
      state = cached.state;
    }

    // Read events from the starting point
    const events = this.readEventsFrom(sessionId, fromSeq + 1, targetSeq);

    // Apply each event
    for (const event of events) {
      state = this.applyEvent(state, event);
    }

    // Cache the result
    const latestSeq = events.length > 0
      ? events[events.length - 1].seq
      : fromSeq;

    if (latestSeq > 0) {
      this.cache.set(sessionId, { atSeq: latestSeq, state });
    }

    return state as S;
  }

  /**
   * Project from an explicit list of events (no database reads).
   */
  projectFromEvents<S>(events: AgentEvent[]): S {
    let state: unknown = this.initialState();
    for (const event of events) {
      state = this.applyEvent(state, event);
    }
    return state as S;
  }

  /**
   * Apply a single event to the given state.
   */
  applyEvent<S>(state: S, event: AgentEvent): S {
    const reducer = this.reducers[event.eventType];
    if (reducer) {
      return reducer(state, event) as S;
    }
    // No reducer for this event type — state unchanged
    return state;
  }

  // -------------------------------------------------------------------------
  // Async update scheduling
  // -------------------------------------------------------------------------

  /**
   * Schedule an async projection update. Coalesces multiple updates for the
   * same session into a single update with the latest seq.
   */
  scheduleUpdate(sessionId: string, seq: number): void {
    const existing = this.pendingUpdates.get(sessionId);
    if (!existing || seq > existing) {
      this.pendingUpdates.set(sessionId, seq);
    }

    // Kick off processing if not already running
    if (!this.updateRunning) {
      this.processPendingUpdates();
    }
  }

  private async processPendingUpdates(): Promise<void> {
    if (this.updateRunning) return;
    this.updateRunning = true;

    try {
      while (this.pendingUpdates.size > 0) {
        const entries = Array.from(this.pendingUpdates.entries());
        for (const [sessionId, seq] of entries) {
          this.pendingUpdates.delete(sessionId);
          await this.project(sessionId, seq);
        }
      }
    } finally {
      this.updateRunning = false;
    }
  }

  // -------------------------------------------------------------------------
  // Cache management
  // -------------------------------------------------------------------------

  /**
   * Invalidate the projection cache for a session.
   */
  invalidateCache(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  /**
   * Clear all cached projections.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get the cached projection state for a session (if any).
   */
  getCachedState<S>(sessionId: string): { atSeq: number; state: S } | null {
    const cached = this.cache.get(sessionId);
    if (!cached) return null;
    return { atSeq: cached.atSeq, state: cached.state as S };
  }

  // -------------------------------------------------------------------------
  // Snapshot helpers
  // -------------------------------------------------------------------------

  private getLatestSnapshotRow(
    sessionId: string
  ): { at_seq: number; state: string } | null {
    const stmt = this.db.prepare(`
      SELECT at_seq, state
      FROM snapshots
      WHERE session_id = ?
      ORDER BY at_seq DESC
      LIMIT 1
    `);
    return stmt.get(sessionId) as { at_seq: number; state: string } | null;
  }

  private readEventsFrom(
    sessionId: string,
    fromSeq: number,
    toSeq?: number
  ): AgentEvent[] {
    const conditions: string[] = ['session_id = ?', 'seq >= ?'];
    const params: unknown[] = [sessionId, fromSeq];

    if (toSeq !== undefined) {
      conditions.push('seq <= ?');
      params.push(toSeq);
    }

    const sql = `
      SELECT seq, event_type, session_id, timestamp, payload, chain_hash, metadata
      FROM events
      WHERE ${conditions.join(' AND ')}
      ORDER BY seq ASC
    `;

    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => ({
      seq: row.seq as number,
      eventType: row.event_type as EventType,
      sessionId: row.session_id as string,
      timestamp: row.timestamp as number,
      payload: JSON.parse(row.payload as string),
      chainHash: row.chain_hash as string,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    }));
  }

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  /**
   * Compute a deterministic hash of a projected state.
   */
  static hashState(state: unknown): string {
    return createHash('sha256').update(JSON.stringify(state)).digest('hex');
  }

  /**
   * Verify that a projected state matches its expected hash.
   */
  static verifyState(state: unknown, expectedHash: string): boolean {
    return ProjectionEngine.hashState(state) === expectedHash;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProjectionEngine(
  config: ProjectionEngineConfig
): ProjectionEngine {
  return new ProjectionEngine(config);
}
