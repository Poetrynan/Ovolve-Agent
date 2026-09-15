/**
 * @oa/storage — Memory Repository
 * 
 * CRUD operations for memory entries with vector search support.
 * Memory entries store contextual information for the agent and support
 * similarity-based retrieval via embeddings.
 */

import { createHash } from 'node:crypto';
import type { DatabaseManager } from '../database';
import type {
  ListMemoryOptions,
  MemoryEntryRecord,
  VectorSearchOptions,
  VectorSearchResult,
} from '../types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const MEMORY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memory_entries (
    id                TEXT    PRIMARY KEY,
    session_id        TEXT    NOT NULL,
    content           TEXT    NOT NULL,
    embedding         BLOB    DEFAULT NULL,
    embedding_model   TEXT    DEFAULT NULL,
    metadata          TEXT    DEFAULT NULL,
    importance        REAL    NOT NULL DEFAULT 0.5,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    accessed_at       INTEGER DEFAULT NULL,
    access_count      INTEGER NOT NULL DEFAULT 0
  );
`;

export const MEMORY_SESSION_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_memory_session
    ON memory_entries (session_id);
`;

export const MEMORY_IMPORTANCE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_memory_importance
    ON memory_entries (importance DESC);
`;

export const MEMORY_CREATED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_memory_created
    ON memory_entries (created_at DESC);
`;

export const MEMORY_ACCESSED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_memory_accessed
    ON memory_entries (accessed_at DESC);
`;

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export const MEMORY_MIGRATIONS = [
  { version: 1, name: 'memory_entries', sql: MEMORY_TABLE_SQL },
  { version: 2, name: 'memory_session_index', sql: MEMORY_SESSION_INDEX_SQL },
  { version: 3, name: 'memory_importance_index', sql: MEMORY_IMPORTANCE_INDEX_SQL },
  { version: 4, name: 'memory_created_index', sql: MEMORY_CREATED_INDEX_SQL },
  { version: 5, name: 'memory_accessed_index', sql: MEMORY_ACCESSED_INDEX_SQL },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a Float32Array to a Buffer for storage.
 */
function embeddingToBuffer(embedding: Float32Array | number[]): Buffer {
  const arr = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Deserialize a Buffer to a Float32Array.
 */
function bufferToEmbedding(buffer: Buffer): Float32Array {
  return new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Generate a deterministic ID from content.
 */
function generateId(content: string, sessionId: string): string {
  return createHash('sha256')
    .update(sessionId + content + Date.now().toString())
    .digest('hex')
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// MemoryRepository
// ---------------------------------------------------------------------------

export class MemoryRepository {
  private readonly db: DatabaseManager;

  // Prepared statements
  private readonly _stmtInsert: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtGetById: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtUpdate: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtDeleteById: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtDeleteForSession: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtTouchAccess: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtCountForSession: ReturnType<DatabaseManager['prepare']> | null = null;
  private readonly _stmtHasEmbedding: ReturnType<DatabaseManager['prepare']> | null = null;

  constructor(db: DatabaseManager) {
    this.db = db;
    this.ensureSchema();

    // Prepare statements
    this._stmtInsert = this.db.prepare(`
      INSERT INTO memory_entries (
        id, session_id, content, embedding, embedding_model,
        metadata, importance, created_at, updated_at, accessed_at, access_count
      ) VALUES (
        @id, @sessionId, @content, @embedding, @embeddingModel,
        @metadata, @importance, @createdAt, @updatedAt, @accessedAt, @accessCount
      )
    `);

    this._stmtGetById = this.db.prepare(`
      SELECT * FROM memory_entries WHERE id = ?
    `);

    this._stmtUpdate = this.db.prepare(`
      UPDATE memory_entries SET
        content = @content,
        embedding = @embedding,
        embedding_model = @embeddingModel,
        metadata = @metadata,
        importance = @importance,
        updated_at = @updatedAt
      WHERE id = @id
    `);

    this._stmtDeleteById = this.db.prepare(`
      DELETE FROM memory_entries WHERE id = ?
    `);

    this._stmtDeleteForSession = this.db.prepare(`
      DELETE FROM memory_entries WHERE session_id = ?
    `);

    this._stmtTouchAccess = this.db.prepare(`
      UPDATE memory_entries
      SET accessed_at = ?, access_count = access_count + 1
      WHERE id = ?
    `);

    this._stmtCountForSession = this.db.prepare(`
      SELECT COUNT(*) as count FROM memory_entries WHERE session_id = ?
    `);

    this._stmtHasEmbedding = this.db.prepare(`
      SELECT 1 FROM memory_entries WHERE id = ? AND embedding IS NOT NULL
    `);
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private ensureSchema(): void {
    this.db.migrate('memory', MEMORY_MIGRATIONS);
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /**
   * Create a new memory entry.
   */
  create(
    sessionId: string,
    content: string,
    options: {
      embedding?: Float32Array | number[];
      embeddingModel?: string;
      metadata?: Record<string, unknown>;
      importance?: number;
      id?: string;
    } = {}
  ): MemoryEntryRecord {
    const now = Date.now() * 1000;
    const id = options.id ?? generateId(content, sessionId);
    const embedding = options.embedding
      ? embeddingToBuffer(options.embedding)
      : null;

    this._stmtInsert!.run({
      id,
      sessionId,
      content,
      embedding,
      embeddingModel: options.embeddingModel ?? null,
      metadata: options.metadata ? JSON.stringify(options.metadata) : null,
      importance: options.importance ?? 0.5,
      createdAt: now,
      updatedAt: now,
      accessedAt: null,
      accessCount: 0,
    });

    return {
      id,
      session_id: sessionId,
      content,
      embedding,
      embedding_model: options.embeddingModel ?? null,
      metadata: options.metadata ? JSON.stringify(options.metadata) : null,
      importance: options.importance ?? 0.5,
      created_at: now,
      updated_at: now,
      accessed_at: null,
      access_count: 0,
    };
  }

  /**
   * Get a memory entry by ID.
   */
  getById(id: string): MemoryEntryRecord | null {
    return this._stmtGetById!.get(id) as MemoryEntryRecord | null;
  }

  /**
   * Get a memory entry by ID and update its access tracking.
   */
  getByIdAndTouch(id: string, accessTime: number): MemoryEntryRecord | null {
    this._stmtTouchAccess!.run(accessTime, id);
    return this.getById(id);
  }

  /**
   * Update a memory entry.
   */
  update(
    id: string,
    updates: Partial<Omit<MemoryEntryRecord, 'id' | 'session_id' | 'created_at'>>,
    updatedAt: number
  ): boolean {
    const existing = this.getById(id);
    if (!existing) return false;

    const embedding = updates.embedding
      ? embeddingToBuffer(updates.embedding)
      : existing.embedding;

    const result = this._stmtUpdate!.run({
      id,
      content: updates.content ?? existing.content,
      embedding,
      embeddingModel: updates.embedding_model ?? existing.embedding_model,
      metadata: updates.metadata ?? existing.metadata,
      importance: updates.importance ?? existing.importance,
      updatedAt,
    });

    return result.changes > 0;
  }

  /**
   * Set the embedding for a memory entry.
   */
  setEmbedding(
    id: string,
    embedding: Float32Array | number[],
    model: string
  ): boolean {
    const buffer = embeddingToBuffer(embedding);
    const result = this.db.prepare(`
      UPDATE memory_entries
      SET embedding = ?, embedding_model = ?, updated_at = ?
      WHERE id = ?
    `).run(buffer, model, Date.now() * 1000, id);
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Deletion
  // -------------------------------------------------------------------------

  /**
   * Delete a memory entry by ID.
   */
  deleteById(id: string): boolean {
    const result = this._stmtDeleteById!.run(id);
    return result.changes > 0;
  }

  /**
   * Delete all memory entries for a session.
   */
  deleteForSession(sessionId: string): number {
    const result = this._stmtDeleteForSession!.run(sessionId);
    return result.changes;
  }

  /**
   * Delete memory entries older than a given timestamp.
   */
  deleteOlderThan(olderThan: number): number {
    const result = this.db.prepare(`
      DELETE FROM memory_entries WHERE created_at < ?
    `).run(olderThan);
    return result.changes;
  }

  /**
   * Delete memory entries with importance below a threshold.
   */
  deleteLowImportance(minImportance: number): number {
    const result = this.db.prepare(`
      DELETE FROM memory_entries WHERE importance < ?
    `).run(minImportance);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * List memory entries with filtering.
   */
  list(
    options: ListMemoryOptions = {}
  ): MemoryEntryRecord[] {
    const {
      offset = 0,
      limit = 50,
      minImportance,
      sessionId,
    } = options;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (sessionId) {
      conditions.push('session_id = ?');
      params.push(sessionId);
    }
    if (minImportance !== undefined) {
      conditions.push('importance >= ?');
      params.push(minImportance);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const sql = `
      SELECT * FROM memory_entries
      ${whereClause}
      ORDER BY importance DESC, created_at DESC
      LIMIT ? OFFSET ?
    `;

    return this.db.prepare(sql).all(...params, limit, offset) as MemoryEntryRecord[];
  }

  /**
   * Get the most recent memory entries.
   */
  getRecent(sessionId: string, limit: number = 20): MemoryEntryRecord[] {
    const sql = `
      SELECT * FROM memory_entries
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `;
    return this.db.prepare(sql).all(sessionId, limit) as MemoryEntryRecord[];
  }

  /**
   * Get the most frequently accessed memory entries.
  */
  getMostAccessed(sessionId: string, limit: number = 10): MemoryEntryRecord[] {
    const sql = `
      SELECT * FROM memory_entries
      WHERE session_id = ?
      ORDER BY access_count DESC, accessed_at DESC
      LIMIT ?
    `;
    return this.db.prepare(sql).all(sessionId, limit) as MemoryEntryRecord[];
  }

  /**
   * Count memory entries for a session.
   */
  countForSession(sessionId: string): number {
    const row = this._stmtCountForSession!.get(sessionId) as { count: number };
    return row.count;
  }

  /**
   * Count memory entries with embeddings for a session.
   */
  countWithEmbeddings(sessionId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM memory_entries
      WHERE session_id = ? AND embedding IS NOT NULL
    `).get(sessionId) as { count: number };
    return row.count;
  }

  /**
   * Check if an entry has an embedding.
   */
  hasEmbedding(id: string): boolean {
    return this._stmtHasEmbedding!.get(id) !== undefined;
  }

  // -------------------------------------------------------------------------
  // Vector search
  // -------------------------------------------------------------------------

  /**
   * Search for similar memory entries using cosine similarity.
   * 
   * Note: This is a brute-force search. For large datasets, consider using
   * a dedicated vector database or SQLite extensions like sqlite-vec.
   */
  vectorSearch(options: VectorSearchOptions): VectorSearchResult[] {
    const {
      queryEmbedding,
      limit = 10,
      minSimilarity = 0,
      sessionId,
    } = options;

    const query = queryEmbedding instanceof Float32Array
      ? queryEmbedding
      : new Float32Array(queryEmbedding);

    // Build query - filter to entries with embeddings
    const conditions: string[] = ['embedding IS NOT NULL'];
    const params: unknown[] = [];

    if (sessionId) {
      conditions.push('session_id = ?');
      params.push(sessionId);
    }

    const whereClause = conditions.join(' AND ');
    const sql = `
      SELECT * FROM memory_entries
      WHERE ${whereClause}
    `;

    const rows = this.db.prepare(sql).all(...params) as MemoryEntryRecord[];

    // Compute similarities
    const results: VectorSearchResult[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const embedding = bufferToEmbedding(row.embedding as Buffer);
      const similarity = cosineSimilarity(query, embedding);
      if (similarity >= minSimilarity) {
        results.push({ entry: row, similarity });
      }
    }

    // Sort by similarity (descending) and limit
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  /**
   * Search within a specific embedding model's entries.
   */
  vectorSearchByModel(
    options: VectorSearchOptions & { model: string }
  ): VectorSearchResult[] {
    const { model, ...baseOptions } = options;

    const query = options.queryEmbedding instanceof Float32Array
      ? options.queryEmbedding
      : new Float32Array(options.queryEmbedding);

    const conditions: string[] = ['embedding IS NOT NULL', 'embedding_model = ?'];
    const params: unknown[] = [model];

    if (options.sessionId) {
      conditions.push('session_id = ?');
      params.push(options.sessionId);
    }

    const whereClause = conditions.join(' AND ');
    const sql = `SELECT * FROM memory_entries WHERE ${whereClause}`;

    const rows = this.db.prepare(sql).all(...params) as MemoryEntryRecord[];

    const results: VectorSearchResult[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const embedding = bufferToEmbedding(row.embedding as Buffer);
      const similarity = cosineSimilarity(query, embedding);
      if (similarity >= (options.minSimilarity ?? 0)) {
        results.push({ entry: row, similarity });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, options.limit ?? 10);
  }

  // -------------------------------------------------------------------------
  // Embedding management
  // -------------------------------------------------------------------------

  /**
   * Get all entries without embeddings (for batch embedding generation).
   */
  getWithoutEmbeddings(sessionId: string, limit: number = 100): MemoryEntryRecord[] {
    const sql = `
      SELECT * FROM memory_entries
      WHERE session_id = ? AND embedding IS NULL
      ORDER BY importance DESC
      LIMIT ?
    `;
    return this.db.prepare(sql).all(sessionId, limit) as MemoryEntryRecord[];
  }

  /**
   * Batch update embeddings.
   */
  batchSetEmbeddings(
    entries: Array<{ id: string; embedding: Float32Array | number[]; model: string }>
  ): number {
    const stmt = this.db.prepare(`
      UPDATE memory_entries
      SET embedding = ?, embedding_model = ?, updated_at = ?
      WHERE id = ?
    `);

    return this.db.transaction(() => {
      let updated = 0;
      const now = Date.now() * 1000;
      for (const entry of entries) {
        const buffer = embeddingToBuffer(entry.embedding);
        const result = stmt.run(buffer, entry.model, now, entry.id);
        updated += result.changes;
      }
      return updated;
    })();
  }

  /**
   * Get the most common embedding model used in the database.
   */
  getMostCommonModel(): string | null {
    const row = this.db.prepare(`
      SELECT embedding_model, COUNT(*) as count
      FROM memory_entries
      WHERE embedding_model IS NOT NULL
      GROUP BY embedding_model
      ORDER BY count DESC
      LIMIT 1
    `).get() as { embedding_model: string } | undefined;
    return row?.embedding_model ?? null;
  }

  /**
   * Get all distinct embedding models.
   */
  getDistinctModels(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT embedding_model
      FROM memory_entries
      WHERE embedding_model IS NOT NULL
      ORDER BY embedding_model
    `).all() as Array<{ embedding_model: string }>;
    return rows.map((r) => r.embedding_model);
  }

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  /**
   * Get statistics for memory entries in a session.
   */
  getStats(sessionId: string): {
    total: number;
    withEmbeddings: number;
    avgImportance: number;
    totalAccesses: number;
  } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) as withEmbeddings,
        COALESCE(AVG(importance), 0) as avgImportance,
        COALESCE(SUM(access_count), 0) as totalAccesses
      FROM memory_entries
      WHERE session_id = ?
    `).get(sessionId) as {
      total: number;
      withEmbeddings: number;
      avgImportance: number;
      totalAccesses: number;
    };

    return row;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMemoryRepository(db: DatabaseManager): MemoryRepository {
  return new MemoryRepository(db);
}
