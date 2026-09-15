/**
 * @oa/session-core — SessionManager
 *
 * Central orchestrator for the full session lifecycle:
 * - Create, fork, resume, archive, delete, rename, switch workspace
 * - State retrieval via the projection engine
 * - Event history access and full-text search
 * - Session listing with filtering and pagination
 *
 * All mutating operations emit events to the event store for audit trail.
 * Zero-copy fork shares events up to fork_point_seq — no event data is
 * duplicated; the forked session simply references the same events.
 */

import { randomUUID } from 'node:crypto';
import type {
  Session,
  SessionSummary,
  SessionState,
  SessionConfig,
  CreateSessionOptions,
  ForkSessionOptions,
  GetHistoryOptions,
  ListSessionsOptions,
  SearchSessionOptions,
  SessionCreatedPayload,
  SessionForkedPayload,
  SessionRenamedPayload,
  SessionWorkspaceChangedPayload,
  SessionArchivedPayload,
  SessionDeletedPayload,
  SessionTagsUpdatedPayload,
} from './types';
import type { AgentEvent, EventType, IEventStore, SearchResult } from '@oa/event-store';
import type { DatabaseManager } from '@oa/storage';
import type { IProjectionEngine } from '@oa/projection';
import { SessionBuffers, createSessionBuffers } from './session-buffers';
import { WorkspaceManager, createWorkspaceManager } from './workspace-manager';
import { createInitialSessionState } from '@oa/event-store';

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private readonly eventStore: IEventStore;
  private readonly database: DatabaseManager;
  private readonly projectionEngine: IProjectionEngine;
  private readonly sessionBuffers: SessionBuffers;
  private readonly workspaceManager: WorkspaceManager;
  private readonly defaultWorkspace: string;
  private readonly autoArchiveAfter: number;
  private readonly maxSessions: number;
  private readonly idGenerator: () => string;

  /** In-memory session cache (sessionId -> Session). */
  private readonly sessionCache: Map<string, Session> = new Map();

  constructor(config: SessionConfig) {
    if (!config.eventStore) {
      throw new Error('SessionManager requires an IEventStore instance');
    }
    if (!config.database) {
      throw new Error('SessionManager requires a DatabaseManager instance');
    }
    if (!config.projectionEngine) {
      throw new Error('SessionManager requires an IProjectionEngine instance');
    }

    this.eventStore = config.eventStore;
    this.database = config.database;
    this.projectionEngine = config.projectionEngine;
    this.defaultWorkspace = config.defaultWorkspace ?? process.cwd();
    this.autoArchiveAfter = config.autoArchiveAfter ?? 0;
    this.maxSessions = config.maxSessions ?? 0;
    this.idGenerator = config.idGenerator ?? (() => `sess_${randomUUID()}`);

    this.sessionBuffers = createSessionBuffers({ database: config.database });
    this.workspaceManager = createWorkspaceManager({
      database: config.database,
      defaultWorkspace: this.defaultWorkspace,
    });
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  /**
   * Create a new session. Emits a SessionCreated event and registers the
   * session in the sessions table.
   *
   * @param options - Session creation options.
   * @returns The newly created Session.
   */
  async createSession(options: CreateSessionOptions = {}): Promise<Session> {
    const id = options.id ?? this.idGenerator();
    const now = Date.now() * 1000;
    const workspace = options.workspace ?? this.defaultWorkspace;
    const title = options.title ?? this.generateDefaultTitle();
    const tags = options.tags ?? [];
    const phase = options.phase ?? 'idle';
    const metadata = options.metadata ?? {};

    // Ensure workspace is registered
    this.workspaceManager.createWorkspace(workspace);

    // Build initial state
    const initialState = createInitialSessionState(id, now);
    initialState.title = title;
    initialState.phase = phase;
    initialState.metadata = { ...metadata };

    // Create session record in the sessions table
    this.database.prepare(`
      INSERT INTO sessions (
        id, title, archived, deleted, phase, last_seq, last_event_timestamp,
        event_count, message_count, error_count, last_error, metadata,
        created_at, updated_at
      ) VALUES (?, ?, 0, 0, ?, 0, ?, 0, 0, 0, NULL, ?, ?, ?)
    `).run(
      id,
      title,
      phase,
      now,
      JSON.stringify(metadata),
      now,
      now
    );

    // Emit SessionCreated event
    const payload: SessionCreatedPayload = {
      title,
      workspace,
      tags,
      forkedFrom: null,
      forkPointSeq: null,
      metadata,
    };
    await this.eventStore.append({
      eventType: EventType.SessionCreated,
      sessionId: id,
      payload,
    });

    // Build the Session object
    const session: Session = {
      id,
      title,
      archived: false,
      deleted: false,
      phase,
      state: initialState,
      workspace,
      forkedFrom: null,
      forkPointSeq: null,
      tags: [...tags],
      createdAt: now,
      updatedAt: now,
    };

    // Cache it
    this.sessionCache.set(id, session);

    // Enforce max sessions limit
    this.enforceMaxSessions();

    return session;
  }

  // -------------------------------------------------------------------------
  // Fork — zero-copy fork sharing events up to fork_point_seq
  // -------------------------------------------------------------------------

  /**
   * Fork a session at a given seq. Zero-copy: the forked session shares
   * all events up to fork_point_seq with the source. No event data is
   * duplicated — the fork simply references the source's event stream.
   *
   * @param sourceId - The source session ID.
   * @param forkPointSeq - Seq to fork at (defaults to source's lastSeq).
   * @param options - Fork options.
   * @returns The newly forked Session.
   */
  async forkSession(
    sourceId: string,
    forkPointSeq?: number,
    options: ForkSessionOptions = {}
  ): Promise<Session> {
    const source = await this.resolveSession(sourceId);
    if (!source) {
      throw new Error(`Cannot fork: source session "${sourceId}" not found`);
    }

    const forkSeq = forkPointSeq ?? source.state.lastSeq;
    if (forkSeq <= 0) {
      throw new Error(`Cannot fork: invalid fork point seq ${forkSeq}`);
    }

    const id = options.id ?? this.idGenerator();
    const now = Date.now() * 1000;
    const title = options.title ?? `Fork of ${source.title || sourceId}`;
    const tags = options.copyTags !== false ? [...source.tags, ...(options.tags ?? [])] : (options.tags ?? []);
    const metadata = { ...source.state.metadata, ...options.metadata };

    // Project state at the fork point
    const forkedState = await this.projectionEngine.project<SessionState>(sourceId, forkSeq);
    forkedState.sessionId = id;
    forkedState.title = title;
    forkedState.lastSeq = forkSeq;
    forkedState.lastEventTimestamp = now;
    forkedState.metadata = metadata;
    forkedState.createdAt = now;
    forkedState.updatedAt = now;

    // Create session record
    this.database.prepare(`
      INSERT INTO sessions (
        id, title, archived, deleted, phase, last_seq, last_event_timestamp,
        event_count, message_count, error_count, last_error, metadata,
        created_at, updated_at
      ) VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
    `).run(
      id,
      title,
      'idle',
      forkSeq,
      now,
      forkedState.eventCount,
      forkedState.messageCount,
      JSON.stringify(metadata),
      now,
      now
    );

    // Emit SessionCreated event with fork metadata
    const payload: SessionCreatedPayload = {
      title,
      workspace: source.workspace,
      tags,
      forkedFrom: sourceId,
      forkPointSeq: forkSeq,
      metadata,
    };
    await this.eventStore.append({
      eventType: EventType.SessionCreated,
      sessionId: id,
      payload,
    });

    // Emit SessionForked event on the source session
    const forkPayload: SessionForkedPayload = {
      sourceSessionId: sourceId,
      forkPointSeq: forkSeq,
      sourceTitle: source.title,
    };
    await this.eventStore.append({
      eventType: EventType.SessionUpdated,
      sessionId: sourceId,
      payload: forkPayload,
    });

    const session: Session = {
      id,
      title,
      archived: false,
      deleted: false,
      phase: 'idle',
      state: forkedState,
      workspace: source.workspace,
      forkedFrom: sourceId,
      forkPointSeq: forkSeq,
      tags,
      createdAt: now,
      updatedAt: now,
    };

    this.sessionCache.set(id, session);
    return session;
  }

  // -------------------------------------------------------------------------
  // Resume — restore a session after restart
  // -------------------------------------------------------------------------

  /**
   * Resume a session after application restart. Reconstructs the session
   * from its persisted state and checks for any parked state to restore.
   *
   * @param sessionId - The session to resume.
   * @returns The resumed Session, or null if not found.
   */
  async resumeSession(sessionId: string): Promise<Session | null> {
    // Check cache first
    const cached = this.sessionCache.get(sessionId);
    if (cached && !cached.deleted) {
      return cached;
    }

    // Load from database
    const record = this.database.prepare(`
      SELECT * FROM sessions WHERE id = ?
    `).get(sessionId) as Record<string, unknown> | undefined;

    if (!record || record.deleted === 1) return null;

    // Project current state from events
    const state = await this.projectionEngine.project<SessionState>(sessionId);

    const session: Session = {
      id: sessionId,
      title: record.title as string,
      archived: record.archived === 1,
      deleted: record.deleted === 1,
      phase: record.phase as Session['phase'],
      state,
      workspace: this.extractWorkspace(state),
      forkedFrom: (state.metadata['forkedFrom'] as string) ?? null,
      forkPointSeq: (state.metadata['forkPointSeq'] as number) ?? null,
      tags: this.extractTags(state),
      createdAt: record.created_at as number,
      updatedAt: record.updated_at as number,
    };

    // Check for parked state to restore
    if (this.sessionBuffers.hasParkedState(sessionId)) {
      const parked = this.sessionBuffers.getParkedSession(sessionId);
      if (parked && parked.state.lastSeq > state.lastSeq) {
        // Parked state is newer — use it
        session.state = parked.state;
      }
    }

    this.sessionCache.set(sessionId, session);
    return session;
  }

  // -------------------------------------------------------------------------
  // Get state — retrieve current projected state
  // -------------------------------------------------------------------------

  /**
   * Get the current projected state of a session.
   *
   * @param sessionId - The session ID.
   * @returns The projected SessionState.
   */
  async getState(sessionId: string): Promise<SessionState> {
    return this.projectionEngine.project<SessionState>(sessionId);
  }

  // -------------------------------------------------------------------------
  // Get history — retrieve event history
  // -------------------------------------------------------------------------

  /**
   * Get the event history for a session with optional filtering.
   *
   * @param sessionId - The session ID.
   * @param options - History retrieval options.
   * @returns Array of events.
   */
  async getHistory(
    sessionId: string,
    options: GetHistoryOptions = {}
  ): Promise<AgentEvent[]> {
    return this.eventStore.readStream(sessionId, {
      fromSeq: options.fromSeq,
      toSeq: options.toSeq,
      eventTypes: options.eventTypes,
      limit: options.limit,
      reverse: options.reverse,
    });
  }

  // -------------------------------------------------------------------------
  // Search — full-text search within a session
  // -------------------------------------------------------------------------

  /**
   * Full-text search within a session's events.
   *
   * @param sessionId - The session ID.
   * @param query - Search query string.
   * @param options - Search options.
   * @returns Array of search results.
   */
  async searchSession(
    sessionId: string,
    query: string,
    options: SearchSessionOptions = {}
  ): Promise<SearchResult[]> {
    return this.eventStore.search(sessionId, query, {
      limit: options.limit,
      eventTypes: options.eventTypes,
      fromSeq: options.fromSeq,
      toSeq: options.toSeq,
    });
  }

  // -------------------------------------------------------------------------
  // List — list sessions with filtering
  // -------------------------------------------------------------------------

  /**
   * List sessions with filtering, pagination, and sorting.
   *
   * @param options - List options.
   * @returns Array of session summaries.
   */
  listSessions(options: ListSessionsOptions = {}): SessionSummary[] {
    const {
      includeArchived = false,
      includeDeleted = false,
      workspace,
      phase,
      tags,
      forkedFrom,
      offset = 0,
      limit = 50,
      sortBy = 'updatedAt',
      sortDirection = 'desc',
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
    if (workspace) {
      // Filter sessions whose metadata contains the workspace
      conditions.push("json_extract(metadata, '$.workspace') = ?");
      params.push(workspace);
    }
    if (forkedFrom) {
      conditions.push("json_extract(metadata, '$.forkedFrom') = ?");
      params.push(forkedFrom);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    // Map sort field to column
    const sortColumn: string = (() => {
      switch (sortBy) {
        case 'createdAt': return 'created_at';
        case 'title': return 'title';
        case 'eventCount': return 'event_count';
        case 'updatedAt':
        default: return 'updated_at';
      }
    })();

    const dir = sortDirection === 'asc' ? 'ASC' : 'DESC';

    const sql = `
      SELECT id, title, archived, phase, last_seq, last_event_timestamp,
             event_count, message_count, error_count, metadata,
             created_at, updated_at
      FROM sessions
      ${whereClause}
      ORDER BY ${sortColumn} ${dir}
      LIMIT ? OFFSET ?
    `;

    const rows = this.database.prepare(sql).all(...params, limit, offset) as Record<string, unknown>[];

    let summaries: SessionSummary[] = rows.map((row) => {
      const metadata = JSON.parse((row.metadata as string) ?? '{}') as Record<string, unknown>;
      return {
        id: row.id as string,
        title: row.title as string,
        archived: row.archived === 1,
        phase: row.phase as SessionSummary['phase'],
        workspace: (metadata['workspace'] as string) ?? '',
        messageCount: row.message_count as number,
        eventCount: row.event_count as number,
        errorCount: row.error_count as number,
        forkedFrom: (metadata['forkedFrom'] as string) ?? null,
        tags: (metadata['tags'] as string[]) ?? [],
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      };
    });

    // Post-filter by tags if specified (tags are in metadata JSON)
    if (tags && tags.length > 0) {
      summaries = summaries.filter((s) =>
        tags.every((t) => s.tags.includes(t))
      );
    }

    return summaries;
  }

  // -------------------------------------------------------------------------
  // Archive — soft delete
  // -------------------------------------------------------------------------

  /**
   * Archive a session (soft hide). The session is not deleted but excluded
   * from default list views.
   *
   * @param sessionId - The session to archive.
   * @returns True if the session was archived.
   */
  async archiveSession(sessionId: string): Promise<boolean> {
    const session = await this.resolveSession(sessionId);
    if (!session || session.deleted) return false;

    const now = Date.now() * 1000;

    const result = this.database.prepare(`
      UPDATE sessions SET archived = 1, updated_at = ? WHERE id = ?
    `).run(now, sessionId);

    if (result.changes === 0) return false;

    // Emit event
    const payload: SessionArchivedPayload = { reason: 'user_initiated' };
    await this.eventStore.append({
      eventType: EventType.SessionArchived,
      sessionId,
      payload,
    });

    // Update cache
    session.archived = true;
    session.updatedAt = now;

    return true;
  }

  // -------------------------------------------------------------------------
  // Delete — hard delete
  // -------------------------------------------------------------------------

  /**
   * Hard-delete a session. Permanently removes the session record and all
   * associated data. This is irreversible.
   *
   * @param sessionId - The session to delete.
   * @returns True if the session was deleted.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const session = this.sessionCache.get(sessionId);
    if (!session) {
      // Check database
      const record = this.database.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
      if (!record) return false;
    }

    const now = Date.now() * 1000;

    // Delete session record
    const result = this.database.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

    // Clean up parked state
    this.sessionBuffers.clearParkedState(sessionId);

    // Emit event (before deletion so we have the session context)
    const payload: SessionDeletedPayload = { hardDelete: true };
    await this.eventStore.append({
      eventType: EventType.SessionDeleted,
      sessionId,
      payload,
    });

    // Invalidate cache
    this.sessionCache.delete(sessionId);
    this.projectionEngine.invalidateCache(sessionId);

    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Rename
  // -------------------------------------------------------------------------

  /**
   * Rename a session.
   *
   * @param sessionId - The session to rename.
   * @param title - The new title.
   * @returns True if the session was renamed.
   */
  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const session = await this.resolveSession(sessionId);
    if (!session) return false;

    const now = Date.now() * 1000;
    const oldTitle = session.title;

    const result = this.database.prepare(`
      UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?
    `).run(title, now, sessionId);

    if (result.changes === 0) return false;

    // Emit event
    const payload: SessionRenamedPayload = { oldTitle, newTitle: title };
    await this.eventStore.append({
      eventType: EventType.SessionUpdated,
      sessionId,
      payload,
    });

    // Update cache
    session.title = title;
    session.updatedAt = now;
    session.state.title = title;

    return true;
  }

  // -------------------------------------------------------------------------
  // Switch workspace
  // -------------------------------------------------------------------------

  /**
   * Switch a session to a different workspace.
   *
   * @param sessionId - The session to move.
   * @param workspace - The target workspace path.
   * @returns True if the workspace was changed.
   */
  async switchWorkspace(sessionId: string, workspace: string): Promise<boolean> {
    const session = await this.resolveSession(sessionId);
    if (!session) return false;

    const now = Date.now() * 1000;
    const oldWorkspace = session.workspace;

    // Ensure target workspace exists
    this.workspaceManager.createWorkspace(workspace);

    // Update metadata
    const metadata = { ...session.state.metadata, workspace };
    const result = this.database.prepare(`
      UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(metadata), now, sessionId);

    if (result.changes === 0) return false;

    // Emit event
    const payload: SessionWorkspaceChangedPayload = {
      oldWorkspace,
      newWorkspace: workspace,
    };
    await this.eventStore.append({
      eventType: EventType.SessionUpdated,
      sessionId,
      payload,
    });

    // Update cache
    session.workspace = workspace;
    session.updatedAt = now;
    session.state.metadata = metadata;

    return true;
  }

  // -------------------------------------------------------------------------
  // Tags management
  // -------------------------------------------------------------------------

  /**
   * Update the tags on a session.
   *
   * @param sessionId - The session to update.
   * @param tags - The new set of tags (replaces existing).
   * @returns True if tags were updated.
   */
  async updateTags(sessionId: string, tags: string[]): Promise<boolean> {
    const session = await this.resolveSession(sessionId);
    if (!session) return false;

    const now = Date.now() * 1000;
    const oldTags = [...session.tags];
    const added = tags.filter((t) => !oldTags.includes(t));
    const removed = oldTags.filter((t) => !tags.includes(t));

    const metadata = { ...session.state.metadata, tags };
    const result = this.database.prepare(`
      UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(metadata), now, sessionId);

    if (result.changes === 0) return false;

    const payload: SessionTagsUpdatedPayload = { added, removed };
    await this.eventStore.append({
      eventType: EventType.SessionUpdated,
      sessionId,
      payload,
    });

    session.tags = [...tags];
    session.updatedAt = now;
    session.state.metadata = metadata;

    return true;
  }

  // -------------------------------------------------------------------------
  // Cache management
  // -------------------------------------------------------------------------

  /**
   * Invalidate the cached session data.
   *
   * @param sessionId - The session to invalidate.
   */
  invalidateCache(sessionId: string): void {
    this.sessionCache.delete(sessionId);
  }

  /**
   * Clear the entire session cache.
   */
  clearCache(): void {
    this.sessionCache.clear();
  }

  /**
   * Get a session from cache (or null).
   */
  getCachedSession(sessionId: string): Session | null {
    return this.sessionCache.get(sessionId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve a session by ID — from cache or by projecting from events.
   */
  private async resolveSession(sessionId: string): Promise<Session | null> {
    const cached = this.sessionCache.get(sessionId);
    if (cached) return cached;

    return this.resumeSession(sessionId);
  }

  /**
   * Generate a default title for a new session.
   */
  private generateDefaultTitle(): string {
    const now = new Date();
    return `Session ${now.toISOString().slice(0, 16).replace('T', ' ')}`;
  }

  /**
   * Extract workspace from session state metadata.
   */
  private extractWorkspace(state: SessionState): string {
    return (state.metadata['workspace'] as string) ?? this.defaultWorkspace;
  }

  /**
   * Extract tags from session state metadata.
   */
  private extractTags(state: SessionState): string[] {
    return (state.metadata['tags'] as string[]) ?? [];
  }

  /**
   * Enforce the max sessions limit by archiving oldest sessions.
   */
  private enforceMaxSessions(): void {
    if (this.maxSessions <= 0) return;

    const count = this.database.prepare(
      'SELECT COUNT(*) as count FROM sessions WHERE deleted = 0 AND archived = 0'
    ).get() as { count: number };

    if (count.count > this.maxSessions) {
      const excess = count.count - this.maxSessions;
      // Archive oldest sessions
      this.database.prepare(`
        UPDATE sessions SET archived = 1, updated_at = ?
        WHERE id IN (
          SELECT id FROM sessions
          WHERE deleted = 0 AND archived = 0
          ORDER BY updated_at ASC
          LIMIT ?
        )
      `).run(Date.now() * 1000, excess);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionManager(config: SessionConfig): SessionManager {
  return new SessionManager(config);
}
