/**
 * @oa/event-store — EventStore
 * 
 * Core event-sourced store implementing IEventStore. All events are appended
 * with a SHA-256 chain hash for tamper-evidence. Supports batch atomic
 * appends, filtered reads, snapshots, full-text search, and chain
 * verification.
 */

import { createHash } from 'node:crypto';
import type {
  AgentEvent,
  ChainVerificationResult,
  Checkpoint,
  EventStoreConfig,
  NewEvent,
  ReadStreamOptions,
  SearchOptions,
  SearchResult,
  Snapshot,
} from './types';
import { EventType } from './types';
import {
  LATEST_EVENT_STORE_SCHEMA_VERSION,
  EVENT_STORE_MIGRATIONS,
} from './schema';
import type { DatabaseManager } from '@oa/storage';

// ---------------------------------------------------------------------------
// IEventStore interface
// ---------------------------------------------------------------------------

export interface IEventStore {
  append(event: NewEvent): Promise<number>;
  appendBatch(events: NewEvent[]): Promise<number[]>;
  readStream(sessionId: string, options?: ReadStreamOptions): Promise<AgentEvent[]>;
  getEvent(seq: number): Promise<AgentEvent | null>;
  getLatestEvent(sessionId: string): Promise<AgentEvent | null>;
  getEventCount(sessionId: string): Promise<number>;
  verifyChain(sessionId: string, fromSeq?: number): Promise<ChainVerificationResult>;
  createSnapshot<T>(sessionId: string, atSeq: number, state: T): Promise<Snapshot<T>>;
  getLatestSnapshot<T>(sessionId: string): Promise<Snapshot<T> | null>;
  search<T = unknown>(sessionId: string, query: string, options?: SearchOptions): Promise<SearchResult<T>[]>;
  close(): void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the chain hash for an event.
 * SHA-256(prev_chain_hash + event_type + session_id + timestamp + JSON(payload))
 */
function computeChainHash(
  prevChainHash: string,
  eventType: EventType,
  sessionId: string,
  timestamp: number,
  payload: unknown
): string {
  const data =
    prevChainHash +
    eventType +
    sessionId +
    String(timestamp) +
    JSON.stringify(payload);
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute a hash of snapshot state for integrity verification.
 */
function computeStateHash(state: unknown): string {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

/**
 * Microsecond timestamp.
 */
function nowMicros(): number {
  return Date.now() * 1000;
}

// ---------------------------------------------------------------------------
// EventStore implementation
// ---------------------------------------------------------------------------

export class EventStore implements IEventStore {
  private readonly db: DatabaseManager;
  private readonly autoSnapshot: boolean;
  private readonly snapshotInterval: number;
  private readonly snapshotProjector?: (events: AgentEvent[]) => unknown;

  // Prepared statement handles (cached for performance)
  private readonly _stmtInsertEvent: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtSelectBySeq: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtSelectLatest: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtCountEvents: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtInsertSnapshot: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtSelectLatestSnapshot: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtInsertCheckpoint: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtSelectCheckpoint: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtDeleteExpiredCheckpoints: ReturnType<DatabaseManager['prepare']> | null = null;

  constructor(config: EventStoreConfig) {
    if (!config.database) {
      throw new Error('EventStore requires a DatabaseManager instance');
    }
    this.db = config.database;
    this.autoSnapshot = config.autoSnapshot ?? true;
    this.snapshotInterval = config.snapshotInterval ?? 100;
    this.snapshotProjector = config.snapshotProjector as
      | ((events: AgentEvent[]) => unknown)
      | undefined;

    // Ensure schema is up to date
    this.ensureSchema();

    // Prepare statements
    this._stmtInsertEvent = this.db.prepare(`
      INSERT INTO events (event_type, session_id, timestamp, payload, chain_hash, metadata)
      VALUES (@eventType, @sessionId, @timestamp, @payload, @chainHash, @metadata)
    `);
    this._stmtSelectBySeq = this.db.prepare(`
      SELECT seq, event_type, session_id, timestamp, payload, chain_hash, metadata
      FROM events WHERE seq = ?
    `);
    this._stmtSelectLatest = this.db.prepare(`
      SELECT seq, event_type, session_id, timestamp, payload, chain_hash, metadata
      FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 1
    `);
    this._stmtCountEvents = this.db.prepare(`
      SELECT COUNT(*) as count FROM events WHERE session_id = ?
    `);
    this._stmtInsertSnapshot = this.db.prepare(`
      INSERT INTO snapshots (session_id, at_seq, state, state_hash, timestamp)
      VALUES (@sessionId, @atSeq, @state, @stateHash, @timestamp)
    `);
    this._stmtSelectLatestSnapshot = this.db.prepare(`
      SELECT seq, session_id, at_seq, state, state_hash, timestamp
      FROM snapshots WHERE session_id = ? ORDER BY at_seq DESC LIMIT 1
    `);
    this._stmtInsertCheckpoint = this.db.prepare(`
      INSERT INTO checkpoints (id, session_id, at_seq, state, timestamp, label, expires_at)
      VALUES (@id, @sessionId, @atSeq, @state, @timestamp, @label, @expiresAt)
    `);
    this._stmtSelectCheckpoint = this.db.prepare(`
      SELECT id, session_id, at_seq, state, timestamp, label, expires_at
      FROM checkpoints WHERE id = ?
    `);
    this._stmtDeleteExpiredCheckpoints = this.db.prepare(`
      DELETE FROM checkpoints WHERE expires_at IS NOT NULL AND expires_at < ?
    `);
  }

  // -------------------------------------------------------------------------
  // Schema management
  // -------------------------------------------------------------------------

  private ensureSchema(): void {
    const currentVersion = this.db.getSchemaVersion('event_store');
    if (currentVersion < LATEST_EVENT_STORE_SCHEMA_VERSION) {
      for (const migration of EVENT_STORE_MIGRATIONS) {
        if (migration.version > currentVersion) {
          this.db.exec(migration.sql);
          this.db.setSchemaVersion('event_store', migration.version);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Append
  // -------------------------------------------------------------------------

  async append(event: NewEvent): Promise<number> {
    return this.db.transaction(() => {
      const timestamp = event.timestamp ?? nowMicros();
      const payload = JSON.stringify(event.payload);
      const metadata = event.metadata ? JSON.stringify(event.metadata) : null;

      // Get the previous chain hash
      const prevEvent = this.getLatestEventSync(event.sessionId);
      const prevChainHash = prevEvent?.chainHash ?? 'GENESIS';

      // Compute chain hash
      const chainHash = computeChainHash(
        prevChainHash,
        event.eventType,
        event.sessionId,
        timestamp,
        event.payload
      );

      // Insert
      const result = this._stmtInsertEvent!.run({
        eventType: event.eventType,
        sessionId: event.sessionId,
        timestamp,
        payload,
        chainHash,
        metadata,
      });

      const seq = Number(result.lastInsertRowid);

      // Auto-snapshot if enabled
      if (this.autoSnapshot && this.snapshotProjector) {
        const count = this.getEventCountSync(event.sessionId);
        if (count % this.snapshotInterval === 0) {
          this.createSnapshotSync(event.sessionId, seq);
        }
      }

      return seq;
    })();
  }

  async appendBatch(events: NewEvent[]): Promise<number[]> {
    if (events.length === 0) return [];

    return this.db.transaction(() => {
      const seqs: number[] = [];
      let lastChainHash = 'GENESIS';
      let lastSessionId = events[0].sessionId;

      // Get the starting chain hash from the latest event of the first session
      const prevEvent = this.getLatestEventSync(lastSessionId);
      if (prevEvent) {
        lastChainHash = prevEvent.chainHash;
      }

      for (const event of events) {
        const timestamp = event.timestamp ?? nowMicros();
        const payload = JSON.stringify(event.payload);
        const metadata = event.metadata ? JSON.stringify(event.metadata) : null;

        // If session changed, get the latest chain hash for that session
        if (event.sessionId !== lastSessionId) {
          const sessionPrev = this.getLatestEventSync(event.sessionId);
          lastChainHash = sessionPrev?.chainHash ?? 'GENESIS';
          lastSessionId = event.sessionId;
        }

        const chainHash = computeChainHash(
          lastChainHash,
          event.eventType,
          event.sessionId,
          timestamp,
          event.payload
        );

        const result = this._stmtInsertEvent!.run({
          eventType: event.eventType,
          sessionId: event.sessionId,
          timestamp,
          payload,
          chainHash,
          metadata,
        });

        const seq = Number(result.lastInsertRowid);
        seqs.push(seq);
        lastChainHash = chainHash;
      }

      return seqs;
    })();
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  async readStream(
    sessionId: string,
    options: ReadStreamOptions = {}
  ): Promise<AgentEvent[]> {
    const {
      fromSeq,
      toSeq,
      eventTypes,
      limit,
      reverse = false,
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
    if (eventTypes && eventTypes.length > 0) {
      const placeholders = eventTypes.map(() => '?').join(', ');
      conditions.push(`event_type IN (${placeholders})`);
      params.push(...eventTypes);
    }

    const whereClause = conditions.join(' AND ');
    const orderDir = reverse ? 'DESC' : 'ASC';
    const limitClause = limit ? `LIMIT ${Math.max(1, limit)}` : '';

    const sql = `
      SELECT seq, event_type, session_id, timestamp, payload, chain_hash, metadata
      FROM events
      WHERE ${whereClause}
      ORDER BY seq ${orderDir}
      ${limitClause}
    `;

    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => this.rowToEvent(row));
  }

  async getEvent(seq: number): Promise<AgentEvent | null> {
    const row = this._stmtSelectBySeq!.get(seq);
    return row ? this.rowToEvent(row) : null;
  }

  async getLatestEvent(sessionId: string): Promise<AgentEvent | null> {
    const row = this._stmtSelectLatest!.get(sessionId);
    return row ? this.rowToEvent(row) : null;
  }

  async getEventCount(sessionId: string): Promise<number> {
    const row = this._stmtCountEvents!.get(sessionId) as { count: number };
    return row.count;
  }

  // -------------------------------------------------------------------------
  // Chain verification
  // -------------------------------------------------------------------------

  async verifyChain(
    sessionId: string,
    fromSeq?: number
  ): Promise<ChainVerificationResult> {
    const events = await this.readStream(sessionId, {
      fromSeq,
      reverse: false,
    });

    if (events.length === 0) {
      return { valid: true, eventsVerified: 0 };
    }

    let prevChainHash = 'GENESIS';

    // If we're starting from a seq > 1, we need the previous event's hash
    if (events[0].seq > 1) {
      const prevEvent = await this.getEvent(events[0].seq - 1);
      if (prevEvent && prevEvent.sessionId === sessionId) {
        prevChainHash = prevEvent.chainHash;
      }
    }

    for (const event of events) {
      const expectedHash = computeChainHash(
        prevChainHash,
        event.eventType,
        event.sessionId,
        event.timestamp,
        event.payload
      );

      if (expectedHash !== event.chainHash) {
        return {
          valid: false,
          eventsVerified: events.indexOf(event),
          brokenAtSeq: event.seq,
          expectedHash,
          actualHash: event.chainHash,
        };
      }

      prevChainHash = event.chainHash;
    }

    return {
      valid: true,
      eventsVerified: events.length,
    };
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  async createSnapshot<T>(
    sessionId: string,
    atSeq: number,
    state: T
  ): Promise<Snapshot<T>> {
    return this.db.transaction(() => {
      const timestamp = nowMicros();
      const stateJson = JSON.stringify(state);
      const stateHash = computeStateHash(state);

      const result = this._stmtInsertSnapshot!.run({
        sessionId,
        atSeq,
        state: stateJson,
        stateHash,
        timestamp,
      });

      return {
        seq: Number(result.lastInsertRowid),
        sessionId,
        atSeq,
        state,
        timestamp,
        stateHash,
      };
    })();
  }

  async getLatestSnapshot<T>(sessionId: string): Promise<Snapshot<T> | null> {
    const row = this._stmtSelectLatestSnapshot!.get(sessionId);
    if (!row) return null;
    return this.rowToSnapshot<T>(row);
  }

  // -------------------------------------------------------------------------
  // Checkpoints
  // -------------------------------------------------------------------------

  async createCheckpoint<T>(
    sessionId: string,
    atSeq: number,
    state: T,
    label?: string,
    ttlMicros?: number
  ): Promise<Checkpoint<T>> {
    return this.db.transaction(() => {
      const id = `ckpt_${sessionId}_${atSeq}_${nowMicros()}`;
      const timestamp = nowMicros();
      const expiresAt = ttlMicros ? timestamp + ttlMicros : null;

      this._stmtInsertCheckpoint!.run({
        id,
        sessionId,
        atSeq,
        state: JSON.stringify(state),
        timestamp,
        label: label ?? null,
        expiresAt,
      });

      return {
        id,
        sessionId,
        atSeq,
        state,
        timestamp,
        label,
        expiresAt: expiresAt ?? undefined,
      };
    })();
  }

  async getCheckpoint<T>(id: string): Promise<Checkpoint<T> | null> {
    const row = this._stmtSelectCheckpoint!.get(id);
    if (!row) return null;
    return this.rowToCheckpoint<T>(row);
  }

  async deleteExpiredCheckpoints(): Promise<number> {
    const result = this._stmtDeleteExpiredCheckpoints!.run(nowMicros());
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Full-text search
  // -------------------------------------------------------------------------

  async search<T = unknown>(
    sessionId: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResult<T>[]> {
    const { limit = 50, eventTypes, fromSeq, toSeq } = options;

    // Build the FTS query — escape special characters
    const safeQuery = query
      .replace(/"/g, '""')
      .replace(/[*:-]/g, ' ')
      .trim();

    if (!safeQuery) return [];

    const conditions: string[] = [
      `events_fts MATCH ?`,
      `session_id = ?`,
    ];
    const params: unknown[] = [`"${safeQuery}"*`, sessionId];

    if (eventTypes && eventTypes.length > 0) {
      const placeholders = eventTypes.map(() => '?').join(', ');
      conditions.push(`event_type IN (${placeholders})`);
      params.push(...eventTypes);
    }
    if (fromSeq !== undefined) {
      conditions.push('e.seq >= ?');
      params.push(fromSeq);
    }
    if (toSeq !== undefined) {
      conditions.push('e.seq <= ?');
      params.push(toSeq);
    }

    const whereClause = conditions.join(' AND ');

    const sql = `
      SELECT e.seq, e.event_type, e.session_id, e.timestamp, e.payload,
             e.chain_hash, e.metadata,
             rank,
             snippet(events_fts, 2, '<mark>', '</mark>', '...', 32) as snippet
      FROM events_fts
      JOIN events e ON e.seq = events_fts.rowid
      WHERE ${whereClause}
      ORDER BY rank
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params, limit);
    return rows.map((row) => ({
      event: this.rowToEvent(row),
      rank: row.rank as number,
      snippet: row.snippet as string | undefined,
    }));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  close(): void {
    // Statements are managed by the DatabaseManager; nothing to close here.
  }

  // -------------------------------------------------------------------------
  // Internal sync helpers (used inside transactions)
  // -------------------------------------------------------------------------

  private getLatestEventSync(sessionId: string): AgentEvent | null {
    const row = this._stmtSelectLatest!.get(sessionId);
    return row ? this.rowToEvent(row) : null;
  }

  private getEventCountSync(sessionId: string): number {
    const row = this._stmtCountEvents!.get(sessionId) as { count: number };
    return row.count;
  }

  private createSnapshotSync(sessionId: string, atSeq: number): void {
    if (!this.snapshotProjector) return;
    const events = this.readStreamSync(sessionId, { toSeq: atSeq });
    const state = this.snapshotProjector(events);
    const timestamp = nowMicros();
    const stateJson = JSON.stringify(state);
    const stateHash = computeStateHash(state);

    this._stmtInsertSnapshot!.run({
      sessionId,
      atSeq,
      state: stateJson,
      stateHash,
      timestamp,
    });
  }

  private readStreamSync(
    sessionId: string,
    options: ReadStreamOptions = {}
  ): AgentEvent[] {
    const { fromSeq, toSeq, eventTypes, limit, reverse = false } = options;

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
    if (eventTypes && eventTypes.length > 0) {
      const placeholders = eventTypes.map(() => '?').join(', ');
      conditions.push(`event_type IN (${placeholders})`);
      params.push(...eventTypes);
    }

    const whereClause = conditions.join(' AND ');
    const orderDir = reverse ? 'DESC' : 'ASC';
    const limitClause = limit ? `LIMIT ${Math.max(1, limit)}` : '';

    const sql = `
      SELECT seq, event_type, session_id, timestamp, payload, chain_hash, metadata
      FROM events
      WHERE ${whereClause}
      ORDER BY seq ${orderDir}
      ${limitClause}
    `;

    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => this.rowToEvent(row));
  }

  // -------------------------------------------------------------------------
  // Row mappers
  // -------------------------------------------------------------------------

  private rowToEvent(row: Record<string, unknown>): AgentEvent {
    return {
      seq: row.seq as number,
      eventType: row.event_type as EventType,
      sessionId: row.session_id as string,
      timestamp: row.timestamp as number,
      payload: JSON.parse(row.payload as string),
      chainHash: row.chain_hash as string,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    };
  }

  private rowToSnapshot<T>(row: Record<string, unknown>): Snapshot<T> {
    return {
      seq: row.seq as number,
      sessionId: row.session_id as string,
      atSeq: row.at_seq as number,
      state: JSON.parse(row.state as string) as T,
      stateHash: row.state_hash as string,
      timestamp: row.timestamp as number,
    };
  }

  private rowToCheckpoint<T>(row: Record<string, unknown>): Checkpoint<T> {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      atSeq: row.at_seq as number,
      state: JSON.parse(row.state as string) as T,
      timestamp: row.timestamp as number,
      label: row.label as string | undefined,
      expiresAt: row.expires_at as number | undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEventStore(config: EventStoreConfig): EventStore {
  return new EventStore(config);
}
