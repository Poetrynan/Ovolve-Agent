/**
 * @oa/storage — File Snapshots Repository
 * 
 * CRUD operations for file snapshots. File snapshots capture the state of
 * a file at a point in time, enabling undo/redo and version tracking.
 */

import { createHash } from 'node:crypto';
import type { DatabaseManager } from '../database';
import type {
  FileSnapshotRecord,
  ListFileSnapshotsOptions,
  PaginationOptions,
} from '../types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const FILE_SNAPSHOTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS file_snapshots (
    id            TEXT    PRIMARY KEY,
    session_id    TEXT    NOT NULL,
    file_path     TEXT    NOT NULL,
    content       TEXT    NOT NULL,
    content_hash  TEXT    NOT NULL,
    version       INTEGER NOT NULL DEFAULT 1,
    byte_size     INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    metadata      TEXT    DEFAULT NULL
  );
`;

export const FILE_SNAPSHOTS_SESSION_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_file_snapshots_session
    ON file_snapshots (session_id);
`;

export const FILE_SNAPSHOTS_PATH_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_file_snapshots_path
    ON file_snapshots (session_id, file_path, version DESC);
`;

export const FILE_SNAPSHOTS_CREATED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_file_snapshots_created
    ON file_snapshots (created_at DESC);
`;

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export const FILE_SNAPSHOTS_MIGRATIONS = [
  { version: 1, name: 'file_snapshots', sql: FILE_SNAPSHOTS_TABLE_SQL },
  { version: 2, name: 'file_snapshots_session_index', sql: FILE_SNAPSHOTS_SESSION_INDEX_SQL },
  { version: 3, name: 'file_snapshots_path_index', sql: FILE_SNAPSHOTS_PATH_INDEX_SQL },
  { version: 4, name: 'file_snapshots_created_index', sql: FILE_SNAPSHOTS_CREATED_INDEX_SQL },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function getByteSize(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

// ---------------------------------------------------------------------------
// FileSnapshotsRepository
// ---------------------------------------------------------------------------

export class FileSnapshotsRepository {
  private readonly db: DatabaseManager;

  // Prepared statements
  private readonly _stmtInsert: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtGetById: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtGetLatestForPath: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtGetVersionsForPath: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtDeleteById: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtDeleteForSession: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtDeleteForPath: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtCountForSession: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtGetMaxVersion: ReturnType<DatabaseManager['prepare']> | null = null;

  constructor(db: DatabaseManager) {
    this.db = db;
    this.ensureSchema();

    // Prepare statements
    this._stmtInsert = this.db.prepare(`
      INSERT INTO file_snapshots (
        id, session_id, file_path, content, content_hash, version,
        byte_size, created_at, metadata
      ) VALUES (
        @id, @sessionId, @filePath, @content, @contentHash, @version,
        @byteSize, @createdAt, @metadata
      )
    `);

    this._stmtGetById = this.db.prepare(`
      SELECT * FROM file_snapshots WHERE id = ?
    `);

    this._stmtGetLatestForPath = this.db.prepare(`
      SELECT * FROM file_snapshots
      WHERE session_id = ? AND file_path = ?
      ORDER BY version DESC
      LIMIT 1
    `);

    this._stmtGetVersionsForPath = this.db.prepare(`
      SELECT * FROM file_snapshots
      WHERE session_id = ? AND file_path = ?
      ORDER BY version ASC
    `);

    this._stmtDeleteById = this.db.prepare(`
      DELETE FROM file_snapshots WHERE id = ?
    `);

    this._stmtDeleteForSession = this.db.prepare(`
      DELETE FROM file_snapshots WHERE session_id = ?
    `);

    this._stmtDeleteForPath = this.db.prepare(`
      DELETE FROM file_snapshots WHERE session_id = ? AND file_path = ?
    `);

    this._stmtCountForSession = this.db.prepare(`
      SELECT COUNT(*) as count FROM file_snapshots WHERE session_id = ?
    `);

    this._stmtGetMaxVersion = this.db.prepare(`
      SELECT MAX(version) as maxVersion
      FROM file_snapshots
      WHERE session_id = ? AND file_path = ?
    `);
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private ensureSchema(): void {
    this.db.migrate('file_snapshots', FILE_SNAPSHOTS_MIGRATIONS);
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /**
   * Create a new file snapshot.
   */
  create(
    id: string,
    sessionId: string,
    filePath: string,
    content: string,
    createdAt: number,
    metadata?: Record<string, unknown>
  ): FileSnapshotRecord {
    const contentHash = computeContentHash(content);
    const byteSize = getByteSize(content);
    const version = this.getNextVersion(sessionId, filePath);

    this._stmtInsert!.run({
      id,
      sessionId,
      filePath,
      content,
      contentHash,
      version,
      byteSize,
      createdAt,
      metadata: metadata ? JSON.stringify(metadata) : null,
    });

    return {
      id,
      sessionId,
      file_path: filePath,
      content,
      content_hash: contentHash,
      version,
      byte_size: byteSize,
      created_at: createdAt,
      metadata: metadata ? JSON.stringify(metadata) : null,
    };
  }

  /**
   * Get a file snapshot by ID.
   */
  getById(id: string): FileSnapshotRecord | null {
    return this._stmtGetById!.get(id) as FileSnapshotRecord | null;
  }

  /**
   * Get the latest snapshot for a file path.
   */
  getLatestForPath(
    sessionId: string,
    filePath: string
  ): FileSnapshotRecord | null {
    return this._stmtGetLatestForPath!.get(sessionId, filePath) as FileSnapshotRecord | null;
  }

  /**
   * Get all versions of a file path.
   */
  getVersionsForPath(
    sessionId: string,
    filePath: string
  ): FileSnapshotRecord[] {
    return this._stmtGetVersionsForPath!.all(sessionId, filePath) as FileSnapshotRecord[];
  }

  /**
   * Get a specific version of a file path.
   */
  getVersion(
    sessionId: string,
    filePath: string,
    version: number
  ): FileSnapshotRecord | null {
    const sql = `
      SELECT * FROM file_snapshots
      WHERE session_id = ? AND file_path = ? AND version = ?
    `;
    return this.db.prepare(sql).get(sessionId, filePath, version) as FileSnapshotRecord | null;
  }

  // -------------------------------------------------------------------------
  // Deletion
  // -------------------------------------------------------------------------

  /**
   * Delete a snapshot by ID.
   */
  deleteById(id: string): boolean {
    const result = this._stmtDeleteById!.run(id);
    return result.changes > 0;
  }

  /**
   * Delete all snapshots for a session.
   */
  deleteForSession(sessionId: string): number {
    const result = this._stmtDeleteForSession!.run(sessionId);
    return result.changes;
  }

  /**
   * Delete all snapshots for a specific file path.
   */
  deleteForPath(sessionId: string, filePath: string): number {
    const result = this._stmtDeleteForPath!.run(sessionId, filePath);
    return result.changes;
  }

  /**
   * Delete all versions except the latest N for a file path.
   */
  pruneVersions(
    sessionId: string,
    filePath: string,
    keepLatest: number = 5
  ): number {
    const result = this.db.prepare(`
      DELETE FROM file_snapshots
      WHERE session_id = ? AND file_path = ?
        AND id NOT IN (
          SELECT id FROM file_snapshots
          WHERE session_id = ? AND file_path = ?
          ORDER BY version DESC
          LIMIT ?
        )
    `).run(sessionId, filePath, sessionId, filePath, keepLatest);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * List file snapshots with filtering.
   */
  list(
    sessionId: string,
    options: ListFileSnapshotsOptions = {}
  ): FileSnapshotRecord[] {
    const { offset = 0, limit = 50, filePath } = options;

    const conditions: string[] = ['session_id = ?'];
    const params: unknown[] = [sessionId];

    if (filePath) {
      conditions.push('file_path = ?');
      params.push(filePath);
    }

    const whereClause = conditions.join(' AND ');

    const sql = `
      SELECT * FROM file_snapshots
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    return this.db.prepare(sql).all(...params, limit, offset) as FileSnapshotRecord[];
  }

  /**
   * Get the latest snapshot for each file path in a session.
   */
  getLatestForSession(sessionId: string): FileSnapshotRecord[] {
    const sql = `
      SELECT fs.*
      FROM file_snapshots fs
      INNER JOIN (
        SELECT file_path, MAX(version) as max_version
        FROM file_snapshots
        WHERE session_id = ?
        GROUP BY file_path
      ) latest ON fs.file_path = latest.file_path AND fs.version = latest.max_version
      WHERE fs.session_id = ?
      ORDER BY fs.file_path
    `;
    return this.db.prepare(sql).all(sessionId, sessionId) as FileSnapshotRecord[];
  }

  /**
   * Count snapshots for a session.
   */
  countForSession(sessionId: string): number {
    const row = this._stmtCountForSession!.get(sessionId) as { count: number };
    return row.count;
  }

  /**
   * Get distinct file paths with snapshots for a session.
   */
  getDistinctPaths(sessionId: string): string[] {
    const sql = `
      SELECT DISTINCT file_path
      FROM file_snapshots
      WHERE session_id = ?
      ORDER BY file_path
    `;
    const rows = this.db.prepare(sql).all(sessionId) as Array<{ file_path: string }>;
    return rows.map((r) => r.file_path);
  }

  /**
   * Get total byte size of all snapshots for a session.
   */
  getTotalByteSize(sessionId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(byte_size), 0) as total
      FROM file_snapshots
      WHERE session_id = ?
    `).get(sessionId) as { total: number };
    return row.total;
  }

  // -------------------------------------------------------------------------
  // Integrity
  // -------------------------------------------------------------------------

  /**
   * Verify content integrity of a snapshot.
   */
  verifyIntegrity(id: string): boolean {
    const snapshot = this.getById(id);
    if (!snapshot) return false;
    const expectedHash = computeContentHash(snapshot.content);
    return expectedHash === snapshot.content_hash;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private getNextVersion(sessionId: string, filePath: string): number {
    const row = this._stmtGetMaxVersion!.get(sessionId, filePath) as {
      maxVersion: number | null;
    };
    return (row.maxVersion ?? 0) + 1;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFileSnapshotsRepository(
  db: DatabaseManager
): FileSnapshotsRepository {
  return new FileSnapshotsRepository(db);
}
