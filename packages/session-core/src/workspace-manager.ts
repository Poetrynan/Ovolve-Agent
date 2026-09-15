/**
 * @oa/session-core — Workspace Manager
 *
 * Manages workspaces — directories on the local filesystem where sessions
 * are scoped. Workspaces can be pinned (top of list), hidden (excluded from
 * default views), and renamed (custom display label).
 *
 * Workspaces are persisted in the `workspaces` table. The manager caches
 * workspace metadata in memory for fast lookups and emits events for
 * audit-trail tracking.
 */

import type { WorkspaceInfo, WorkspaceRecord } from './types';
import type { DatabaseManager } from '@oa/storage';

// ---------------------------------------------------------------------------
// SQL schema for workspaces table
// ---------------------------------------------------------------------------

export const WORKSPACES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS workspaces (
    path            TEXT    PRIMARY KEY,
    label           TEXT    DEFAULT NULL,
    pinned          INTEGER NOT NULL DEFAULT 0,
    hidden          INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    last_access_at  INTEGER NOT NULL
  );
`;

export const WORKSPACES_PINNED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_workspaces_pinned
    ON workspaces (pinned DESC, last_access_at DESC);
`;

// ---------------------------------------------------------------------------
// WorkspaceManager
// -------------------------------------------------------------------------

export interface WorkspaceManagerConfig {
  /** Storage database manager. */
  database: DatabaseManager;
  /** Default workspace path (used when no workspace is specified). */
  defaultWorkspace?: string;
}

export class WorkspaceManager {
  private readonly db: DatabaseManager;
  private readonly defaultWorkspace: string;

  // Prepared statements
  private readonly _stmtInsert: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtSelectByPath: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtUpdate: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtDelete: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtList: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtCountSessions: ReturnType<DatabaseManager['prepare']> | null = null;

  constructor(config: WorkspaceManagerConfig) {
    if (!config.database) {
      throw new Error('WorkspaceManager requires a DatabaseManager instance');
    }
    this.db = config.database;
    this.defaultWorkspace = config.defaultWorkspace ?? process.cwd();
    this.ensureSchema();

    this._stmtInsert = this.db.prepare(`
      INSERT OR REPLACE INTO workspaces (path, label, pinned, hidden, created_at, last_access_at)
      VALUES (@path, @label, @pinned, @hidden, @createdAt, @lastAccessAt)
    `);

    this._stmtSelectByPath = this.db.prepare(`
      SELECT path, label, pinned, hidden, created_at, last_access_at
      FROM workspaces WHERE path = ?
    `);

    this._stmtUpdate = this.db.prepare(`
      UPDATE workspaces SET
        label = COALESCE(@label, label),
        pinned = COALESCE(@pinned, pinned),
        hidden = COALESCE(@hidden, hidden),
        last_access_at = COALESCE(@lastAccessAt, last_access_at)
      WHERE path = @path
    `);

    this._stmtDelete = this.db.prepare(`
      DELETE FROM workspaces WHERE path = ?
    `);

    this._stmtList = this.db.prepare(`
      SELECT path, label, pinned, hidden, created_at, last_access_at
      FROM workspaces
      WHERE (@includeHidden = 1 OR hidden = 0)
      ORDER BY pinned DESC, last_access_at DESC
      LIMIT ? OFFSET ?
    `);

    this._stmtCountSessions = this.db.prepare(`
      SELECT COUNT(*) as count FROM sessions WHERE phase != 'deleted' AND id IN (
        SELECT DISTINCT session_id FROM events
        WHERE session_id LIKE 'sess_%'
      )
    `);

    // Ensure default workspace is registered
    this.ensureDefaultWorkspace();
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private ensureSchema(): void {
    this.db.exec(WORKSPACES_TABLE_SQL);
    this.db.exec(WORKSPACES_PINNED_INDEX_SQL);
  }

  private ensureDefaultWorkspace(): void {
    if (!this.exists(this.defaultWorkspace)) {
      const now = Date.now() * 1000;
      this._stmtInsert!.run({
        path: this.defaultWorkspace,
        label: null,
        pinned: 0,
        hidden: 0,
        createdAt: now,
        lastAccessAt: now,
      });
    }
  }

  // -------------------------------------------------------------------------
  // CRUD operations
  // -------------------------------------------------------------------------

  /**
   * List all workspaces (excluding hidden ones by default).
   *
   * @param includeHidden - Include hidden workspaces.
   * @param limit - Maximum results.
   * @param offset - Pagination offset.
   * @returns Array of workspace info objects.
   */
  listWorkspaces(
    includeHidden: boolean = false,
    limit: number = 50,
    offset: number = 0
  ): WorkspaceInfo[] {
    const rows = this._stmtList!.all(
      { includeHidden: includeHidden ? 1 : 0 },
      limit,
      offset
    ) as WorkspaceRecord[];

    return rows.map((row) => this.recordToInfo(row));
  }

  /**
   * Register a new workspace or update access time if it already exists.
   *
   * @param path - Absolute filesystem path to the workspace.
   * @returns The workspace info.
   */
  createWorkspace(path: string): WorkspaceInfo {
    const now = Date.now() * 1000;
    const existing = this.getByPath(path);

    if (existing) {
      // Update access time
      this._stmtUpdate!.run({
        path,
        label: null,
        pinned: null,
        hidden: null,
        lastAccessAt: now,
      });
      return { ...existing, lastAccessAt: now };
    }

    this._stmtInsert!.run({
      path,
      label: null,
      pinned: 0,
      hidden: 0,
      createdAt: now,
      lastAccessAt: now,
    });

    return {
      path,
      label: null,
      pinned: false,
      hidden: false,
      sessionCount: 0,
      createdAt: now,
      lastAccessAt: now,
    };
  }

  /**
   * Pin or unpin a workspace. Pinned workspaces appear at the top of lists.
   *
   * @param path - Workspace path.
   * @param pinned - True to pin, false to unpin.
   * @returns The updated workspace info, or null if not found.
   */
  pinWorkspace(path: string, pinned: boolean): WorkspaceInfo | null {
    const existing = this.getByPath(path);
    if (!existing) return null;

    this._stmtUpdate!.run({
      path,
      label: null,
      pinned: pinned ? 1 : 0,
      hidden: null,
      lastAccessAt: null,
    });

    return { ...existing, pinned };
  }

  /**
   * Hide or unhide a workspace. Hidden workspaces are excluded from default
   * list views but still accessible programmatically.
   *
   * @param path - Workspace path.
   * @param hidden - True to hide, false to unhide.
   * @returns The updated workspace info, or null if not found.
   */
  hideWorkspace(path: string, hidden: boolean): WorkspaceInfo | null {
    const existing = this.getByPath(path);
    if (!existing) return null;

    this._stmtUpdate!.run({
      path,
      label: null,
      pinned: null,
      hidden: hidden ? 1 : 0,
      lastAccessAt: null,
    });

    return { ...existing, hidden };
  }

  /**
   * Set a custom display label for a workspace.
   *
   * @param path - Workspace path.
   * @param name - Custom display label (null to reset to default).
   * @returns The updated workspace info, or null if not found.
   */
  renameWorkspace(path: string, name: string | null): WorkspaceInfo | null {
    const existing = this.getByPath(path);
    if (!existing) return null;

    this._stmtUpdate!.run({
      path,
      label: name,
      pinned: null,
      hidden: null,
      lastAccessAt: null,
    });

    return { ...existing, label: name };
  }

  /**
   * Remove a workspace from the registry.
   *
   * @param path - Workspace path.
   * @returns True if the workspace was deleted.
   */
  removeWorkspace(path: string): boolean {
    const result = this._stmtDelete!.run(path);
    return result.changes > 0;
  }

  /**
   * Get a workspace by its path.
   *
   * @param path - Workspace path.
   * @returns Workspace info or null.
   */
  getByPath(path: string): WorkspaceInfo | null {
    const row = this._stmtSelectByPath!.get(path) as WorkspaceRecord | undefined;
    if (!row) return null;
    return this.recordToInfo(row);
  }

  /**
   * Check if a workspace is registered.
   *
   * @param path - Workspace path.
   * @returns True if registered.
   */
  exists(path: string): boolean {
    return this.getByPath(path) !== null;
  }

  /**
   * Update the last access timestamp for a workspace.
   *
   * @param path - Workspace path.
   */
  touchWorkspace(path: string): void {
    const now = Date.now() * 1000;
    this._stmtUpdate!.run({
      path,
      label: null,
      pinned: null,
      hidden: null,
      lastAccessAt: now,
    });
  }

  /**
   * Get the default workspace path.
   */
  getDefaultWorkspace(): string {
    return this.defaultWorkspace;
  }

  /**
   * Get the total number of registered workspaces.
   */
  count(includeHidden: boolean = false): number {
    const sql = includeHidden
      ? 'SELECT COUNT(*) as count FROM workspaces'
      : 'SELECT COUNT(*) as count FROM workspaces WHERE hidden = 0';
    const row = this.db.prepare(sql).get() as { count: number };
    return row.count;
  }

  // -------------------------------------------------------------------------
  // Row mapper
  // -------------------------------------------------------------------------

  private recordToInfo(record: WorkspaceRecord): WorkspaceInfo {
    return {
      path: record.path,
      label: record.label,
      pinned: record.pinned === 1,
      hidden: record.hidden === 1,
      sessionCount: 0, // Populated separately if needed
      createdAt: record.created_at,
      lastAccessAt: record.last_access_at,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// -------------------------------------------------------------------------

export function createWorkspaceManager(config: WorkspaceManagerConfig): WorkspaceManager {
  return new WorkspaceManager(config);
}
