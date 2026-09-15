/**
 * @oa/projection — ProjectionEngine
 *
 * Main projection engine that projects events into application state.
 * Supports:
 * - Full projection from the event stream
 * - Incremental projection from the last snapshot
 * - Single event application
 * - Snapshot creation and retrieval
 * - Rebuilding from explicit event lists
 *
 * Design:
 * - Snapshot + incremental: start from the latest snapshot, then apply only
 *   events after the snapshot's atSeq.
 * - Cache: projected states are cached per-session with a TTL.
 * - Zero-copy fork: forked sessions share events up to fork_point_seq;
 *   the projection engine reads from the same event stream.
 */

import { createHash } from 'node:crypto';
import type { AgentEvent, EventType, IEventStore } from '@oa/event-store';
import type { DatabaseManager } from '@oa/storage';
import type {
  ProjectionState,
  ProjectionResult,
  ReducerFunction,
  ProjectionEngineConfig,
  IProjectionEngine,
} from './types';
import { createInitialProjectionState, cloneProjectionState } from './state-builder';
import { reducers as defaultReducers } from './reducers';

// ---------------------------------------------------------------------------
// Internal cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  state: ProjectionState;
  atSeq: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// ProjectionEngine implementation
// ---------------------------------------------------------------------------

export class ProjectionEngine implements IProjectionEngine {
  private readonly db: DatabaseManager;
  private readonly eventStore: IEventStore;
  private readonly reducers: Partial<Record<EventType, ReducerFunction>>;
  private readonly initialState: () => ProjectionState;
  private readonly cacheTtlMs: number;
  private readonly enableCache: boolean;

  /** Projection cache (sessionId -> cached state). */
  private readonly cache: Map<string, CacheEntry> = new Map();

  constructor(config: ProjectionEngineConfig) {
    if (!config.database) {
      throw new Error('ProjectionEngine requires a DatabaseManager instance');
    }
    if (!config.eventStore) {
      throw new Error('ProjectionEngine requires an IEventStore instance');
    }

    this.db = config.database;
    this.eventStore = config.eventStore;
    this.reducers = config.reducers ?? defaultReducers;
    this.initialState = config.initialState ?? (() => createInitialProjectionState('', Date.now() * 1000));
    this.cacheTtlMs = config.cacheTtlMs ?? 30000;
    this.enableCache = config.enableCache ?? true;
  }

  // -------------------------------------------------------------------------
  // Full projection
  // -------------------------------------------------------------------------

  /**
   * Project the full state for a session from its events. Uses snapshot +
   * incremental strategy: starts from the latest snapshot (or initial state)
   * and applies events from that point forward.
   *
   * @param sessionId - The session ID.
   * @param targetSeq - Project up to this seq (default: latest event).
   * @returns The projected state.
   */
  async project<S = ProjectionState>(
    sessionId: string,
    targetSeq?: number
  ): Promise<S> {
    const startTime = performance.now();

    // Determine starting point
    let state: ProjectionState = this.initialState();
    state.sessionId = sessionId;
    let fromSeq = 0;
    let fromSnapshot = false;
    let snapshotSeq: number | undefined;

    // Try to start from the latest snapshot
    const snapshot = await this.getSnapshot(sessionId);
    if (snapshot && (!targetSeq || snapshot.atSeq <= targetSeq)) {
      fromSeq = snapshot.atSeq;
      state = cloneProjectionState(snapshot.state);
      fromSnapshot = true;
      snapshotSeq = snapshot.atSeq;
    }

    // If we have a cache that's more recent and valid, use it
    if (this.enableCache) {
      const cached = this.getValidCache(sessionId);
      if (cached && cached.atSeq > fromSeq && (!targetSeq || cached.atSeq <= targetSeq)) {
        fromSeq = cached.atSeq;
        state = cloneProjectionState(cached.state);
        fromSnapshot = false;
        snapshotSeq = undefined;
      }
    }

    // Read events from the starting point
    const events = await this.eventStore.readStream(sessionId, {
      fromSeq: fromSeq + 1,
      toSeq: targetSeq,
    });

    // Apply each event
    for (const event of events) {
      state = this.applyEvent(state, event);
    }

    // Update cache
    const latestSeq = events.length > 0
      ? events[events.length - 1].seq
      : fromSeq;

    if (latestSeq > 0 && this.enableCache) {
      this.setCache(sessionId, state, latestSeq);
    }

    return state as S;
  }

  // -------------------------------------------------------------------------
  // Incremental projection
  // -------------------------------------------------------------------------

  /**
   * Project incrementally from a given seq. Reads events after `fromSeq`
   * and applies them to the provided or initial state.
   *
   * @param sessionId - The session ID.
   * @param fromSeq - Start from this seq (exclusive).
   * @returns The projected state.
   */
  async projectIncremental<S = ProjectionState>(
    sessionId: string,
    fromSeq: number
  ): Promise<S> {
    // Try to get the state at fromSeq from cache
    let state: ProjectionState = this.initialState();
    state.sessionId = sessionId;

    if (this.enableCache) {
      const cached = this.getValidCache(sessionId);
      if (cached && cached.atSeq <= fromSeq) {
        state = cloneProjectionState(cached.state);
        fromSeq = cached.atSeq;
      }
    }

    // Read events after fromSeq
    const events = await this.eventStore.readStream(sessionId, {
      fromSeq: fromSeq + 1,
    });

    // Apply each event
    for (const event of events) {
      state = this.applyEvent(state, event);
    }

    // Update cache
    if (events.length > 0 && this.enableCache) {
      const latestSeq = events[events.length - 1].seq;
      this.setCache(sessionId, state, latestSeq);
    }

    return state as S;
  }

  // -------------------------------------------------------------------------
  // Apply single event
  // -------------------------------------------------------------------------

  /**
   * Apply a single event to the given state. Looks up the reducer for the
   * event type and invokes it. If no reducer is registered, the state is
   * returned unchanged.
   *
   * @param state - Current state.
   * @param event - Event to apply.
   * @returns New state after applying the event.
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
  // Snapshots
  // -------------------------------------------------------------------------

  /**
   * Create a state snapshot for a session. Projects the current state and
   * persists it to the snapshots table.
   *
   * @param sessionId - The session ID.
   */
  async createSnapshot(sessionId: string): Promise<void> {
    const state = await this.project<ProjectionState>(sessionId);
    const atSeq = state.lastSeq;

    if (atSeq <= 0) return; // Nothing to snapshot

    const timestamp = Date.now() * 1000;
    const stateJson = JSON.stringify(state);
    const stateHash = createHash('sha256').update(stateJson).digest('hex');

    this.db.prepare(`
      INSERT INTO snapshots (session_id, at_seq, state, state_hash, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, atSeq, stateJson, stateHash, timestamp);
  }

  /**
   * Get the latest snapshot for a session.
   *
   * @param sessionId - The session ID.
   * @returns The snapshot data or null.
   */
  async getSnapshot(
    sessionId: string
  ): Promise<{ atSeq: number; state: ProjectionState } | null> {
    const row = this.db.prepare(`
      SELECT at_seq, state
      FROM snapshots
      WHERE session_id = ?
      ORDER BY at_seq DESC
      LIMIT 1
    `).get(sessionId) as { at_seq: number; state: string } | undefined;

    if (!row) return null;

    return {
      atSeq: row.at_seq,
      state: JSON.parse(row.state) as ProjectionState,
    };
  }

  // -------------------------------------------------------------------------
  // Rebuild from explicit events
  // -------------------------------------------------------------------------

  /**
   * Rebuild state from an explicit list of events. No database reads —
   * useful for testing, fork preview, or rebuilding from a known event set.
   *
   * @param events - Events to project (must be in seq order).
   * @returns The projected state.
   */
  rebuildFromEvents<S = ProjectionState>(events: AgentEvent[]): S {
    let state: ProjectionState = this.initialState();

    if (events.length > 0) {
      state.sessionId = events[0].sessionId;
    }

    for (const event of events) {
      state = this.applyEvent(state, event);
    }

    return state as S;
  }

  // -------------------------------------------------------------------------
  // Cache management
  // -------------------------------------------------------------------------

  /**
   * Invalidate the cached projection for a session.
   *
   * @param sessionId - The session ID.
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
   * Get the cached state for a session (if valid).
   */
  getCachedState<S = ProjectionState>(sessionId: string): { atSeq: number; state: S } | null {
    const cached = this.getValidCache(sessionId);
    if (!cached) return null;
    return { atSeq: cached.atSeq, state: cached.state as S };
  }

  // -------------------------------------------------------------------------
  // Internal cache helpers
  // -------------------------------------------------------------------------

  private getValidCache(sessionId: string): CacheEntry | null {
    const entry = this.cache.get(sessionId);
    if (!entry) return null;

    // Check TTL
    const age = Date.now() - entry.timestamp;
    if (age > this.cacheTtlMs) {
      this.cache.delete(sessionId);
      return null;
    }

    return entry;
  }

  private setCache(sessionId: string, state: ProjectionState, atSeq: number): void {
    this.cache.set(sessionId, {
      state: cloneProjectionState(state),
      atSeq,
      timestamp: Date.now(),
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProjectionEngine(config: ProjectionEngineConfig): ProjectionEngine {
  return new ProjectionEngine(config);
}
