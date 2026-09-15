/**
 * @oa/memory — Memory database operations
 * 
 * SQLite-based storage with FTS5 full-text search and vector operations.
 * Handles CRUD, tier management, search, and maintenance.
 */

import {
  MemoryEntry,
  MemoryTier,
  MemoryType,
  MemoryScope,
  MemoryLink,
  TierStats,
} from './types';

/** Database interface abstraction for testability */
export interface DatabaseAdapter {
  exec(sql: string): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ lastID: number; changes: number }>;
  close(): Promise<void>;
}

/** SQLite connection configuration */
export interface SQLiteConfig {
  path: string;
  verbose?: boolean;
}

/**
 * Generate a UUID v4.
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Serialize embedding for storage (Float32Array → Buffer).
 */
function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Deserialize embedding from storage (Buffer → Float32Array).
 */
function deserializeEmbedding(buffer: Buffer, dimensions: number): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, dimensions);
}

/**
 * Memory repository — handles all database operations.
 */
export class MemoryRepository {
  private db: DatabaseAdapter;
  private dimensions: number;

  constructor(db: DatabaseAdapter, embeddingDimensions: number = 768) {
    this.db = db;
    this.dimensions = embeddingDimensions;
  }

  /**
   * Initialize database schema.
   */
  async initialize(): Promise<void> {
    // Main memories table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL,
        keywords TEXT NOT NULL DEFAULT '',
        importance REAL NOT NULL DEFAULT 0.5,
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL,
        expires_at INTEGER,
        source TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}'
      );
    `);

    // FTS5 virtual table for keyword search
    await this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        keywords,
        content='memories',
        content_rowid='rowid'
      );
    `);

    // Links table for semantic connections
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_links (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'related',
        strength REAL NOT NULL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE
      );
    `);

    // Indexes
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
      CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at);
      CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived);
      CREATE INDEX IF NOT EXISTS idx_links_source ON memory_links(source_id);
      CREATE INDEX IF NOT EXISTS idx_links_target ON memory_links(target_id);
    `);

    // Triggers to keep FTS in sync
    await this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, keywords)
        VALUES (new.rowid, new.content, new.keywords);
      END;
    `);

    await this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, keywords)
        VALUES ('delete', old.rowid, old.content, old.keywords);
      END;
    `);

    await this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, keywords)
        VALUES ('delete', old.rowid, old.content, old.keywords);
        INSERT INTO memories_fts(rowid, content, keywords)
        VALUES (new.rowid, new.content, new.keywords);
      END;
    `);
  }

  /**
   * Insert a new memory entry.
   */
  async insert(entry: Omit<MemoryEntry, 'id'> & { id?: string }): Promise<MemoryEntry> {
    const id = entry.id ?? generateUUID();
    const fullEntry: MemoryEntry = { ...entry, id } as MemoryEntry;

    await this.db.run(
      `INSERT INTO memories (
        id, tier, type, scope, session_id, content, embedding,
        keywords, importance, hit_count, created_at, accessed_at,
        expires_at, source, archived, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fullEntry.id,
        fullEntry.tier,
        fullEntry.type,
        fullEntry.scope,
        fullEntry.sessionId,
        fullEntry.content,
        serializeEmbedding(fullEntry.embedding),
        fullEntry.keywords.join(','),
        fullEntry.importance,
        fullEntry.hitCount,
        fullEntry.createdAt,
        fullEntry.accessedAt,
        fullEntry.expiresAt,
        fullEntry.source,
        fullEntry.archived ? 1 : 0,
        JSON.stringify(fullEntry.metadata),
      ]
    );

    return fullEntry;
  }

  /**
   * Get a memory by ID.
   */
  async getById(id: string): Promise<MemoryEntry | null> {
    const row = await this.db.get<MemoryRow>(
      'SELECT * FROM memories WHERE id = ?',
      [id]
    );
    return row ? this.rowToEntry(row) : null;
  }

  /**
   * Update an existing memory.
   */
  async update(id: string, updates: Partial<MemoryEntry>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.tier !== undefined) { sets.push('tier = ?'); params.push(updates.tier); }
    if (updates.type !== undefined) { sets.push('type = ?'); params.push(updates.type); }
    if (updates.scope !== undefined) { sets.push('scope = ?'); params.push(updates.scope); }
    if (updates.content !== undefined) { sets.push('content = ?'); params.push(updates.content); }
    if (updates.embedding !== undefined) { sets.push('embedding = ?'); params.push(serializeEmbedding(updates.embedding)); }
    if (updates.keywords !== undefined) { sets.push('keywords = ?'); params.push(updates.keywords.join(',')); }
    if (updates.importance !== undefined) { sets.push('importance = ?'); params.push(updates.importance); }
    if (updates.hitCount !== undefined) { sets.push('hit_count = ?'); params.push(updates.hitCount); }
    if (updates.accessedAt !== undefined) { sets.push('accessed_at = ?'); params.push(updates.accessedAt); }
    if (updates.expiresAt !== undefined) { sets.push('expires_at = ?'); params.push(updates.expiresAt); }
    if (updates.archived !== undefined) { sets.push('archived = ?'); params.push(updates.archived ? 1 : 0); }
    if (updates.metadata !== undefined) { sets.push('metadata = ?'); params.push(JSON.stringify(updates.metadata)); }

    if (sets.length === 0) return;

    params.push(id);
    await this.db.run(
      `UPDATE memories SET ${sets.join(', ')} WHERE id = ?`,
      params
    );
  }

  /**
   * Increment hit count and update access time.
   */
  async incrementHitCount(id: string): Promise<void> {
    await this.db.run(
      'UPDATE memories SET hit_count = hit_count + 1, accessed_at = ? WHERE id = ?',
      [Date.now(), id]
    );
  }

  /**
   * Delete a memory.
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.db.run('DELETE FROM memories WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /**
   * Get all non-archived memories for a session.
   */
  async getBySession(sessionId: string, includeArchived = false): Promise<MemoryEntry[]> {
    const archivedFilter = includeArchived ? '' : 'AND archived = 0';
    const rows = await this.db.all<MemoryRow>(
      `SELECT * FROM memories WHERE session_id = ? ${archivedFilter} ORDER BY created_at DESC`,
      [sessionId]
    );
    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * Get memories by tier.
   */
  async getByTier(tier: MemoryTier, sessionId?: string): Promise<MemoryEntry[]> {
    const sessionFilter = sessionId ? 'AND session_id = ?' : '';
    const params: unknown[] = [tier];
    if (sessionId) params.push(sessionId);

    const rows = await this.db.all<MemoryRow>(
      `SELECT * FROM memories WHERE tier = ? ${sessionFilter} AND archived = 0 ORDER BY importance DESC, hit_count DESC`,
      params
    );
    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * Get all non-archived memories (for vector search).
   */
  async getAllActive(tiers?: MemoryTier[]): Promise<MemoryEntry[]> {
    let tierFilter = '';
    const params: unknown[] = [];

    if (tiers && tiers.length > 0) {
      tierFilter = `AND tier IN (${tiers.map(() => '?').join(', ')})`;
      params.push(...tiers);
    }

    const rows = await this.db.all<MemoryRow>(
      `SELECT * FROM memories WHERE archived = 0 ${tierFilter} ORDER BY created_at DESC`,
      params
    );
    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * Full-text search using FTS5.
   */
  async searchByKeywords(query: string, limit: number = 100): Promise<MemoryEntry[]> {
    // Sanitize query for FTS5
    const sanitized = query
      .replace(/["*]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => `"${term}"*`)
      .join(' OR ');

    if (!sanitized) return [];

    const rows = await this.db.all<MemoryRow>(
      `SELECT m.* FROM memories_fts fts
       JOIN memories m ON m.rowid = fts.rowid
       WHERE memories_fts MATCH ? AND m.archived = 0
       ORDER BY rank
       LIMIT ?`,
      [sanitized, limit]
    );
    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * Get all memories for consolidation (dreaming).
   */
  async getForConsolidation(sinceTimestamp: number): Promise<MemoryEntry[]> {
    const rows = await this.db.all<MemoryRow>(
      `SELECT * FROM memories WHERE created_at > ? AND archived = 0
       ORDER BY importance DESC, hit_count DESC`,
      [sinceTimestamp]
    );
    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * Get expired memories.
   */
  async getExpired(now: number = Date.now()): Promise<MemoryEntry[]> {
    const rows = await this.db.all<MemoryRow>(
      'SELECT * FROM memories WHERE expires_at IS NOT NULL AND expires_at < ? AND archived = 0',
      [now]
    );
    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * Archive a memory (soft delete).
   */
  async archive(id: string): Promise<boolean> {
    const result = await this.db.run(
      'UPDATE memories SET archived = 1 WHERE id = ?',
      [id]
    );
    return result.changes > 0;
  }

  /**
   * Permanently delete old archived memories.
   */
  async purgeOldArchived(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    const result = await this.db.run(
      'DELETE FROM memories WHERE archived = 1 AND created_at < ?',
      [cutoff]
    );
    return result.changes;
  }

  /**
   * Create a link between two memories.
   */
  async createLink(sourceId: string, targetId: string, type: string = 'related', strength: number = 0.5): Promise<MemoryLink> {
    const link: MemoryLink = {
      id: generateUUID(),
      sourceId,
      targetId,
      type,
      strength,
      createdAt: Date.now(),
    };

    await this.db.run(
      `INSERT INTO memory_links (id, source_id, target_id, type, strength, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [link.id, link.sourceId, link.targetId, link.type, link.strength, link.createdAt]
    );

    return link;
  }

  /**
   * Get links for a memory.
   */
  async getLinks(memoryId: string): Promise<MemoryLink[]> {
    const rows = await this.db.all<LinkRow>(
      `SELECT * FROM memory_links WHERE source_id = ? OR target_id = ?`,
      [memoryId, memoryId]
    );
    return rows.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      targetId: r.target_id,
      type: r.type,
      strength: r.strength,
      createdAt: r.created_at,
    }));
  }

  /**
   * Get tier statistics.
   */
  async getTierStats(): Promise<TierStats[]> {
    const rows = await this.db.all<{
      tier: MemoryTier;
      count: number;
      total_tokens: number;
      avg_importance: number;
      avg_hit_count: number;
    }>(
      `SELECT tier,
              COUNT(*) as count,
              SUM(LENGTH(content)) as total_tokens,
              AVG(importance) as avg_importance,
              AVG(hit_count) as avg_hit_count
       FROM memories WHERE archived = 0
       GROUP BY tier`
    );
    return rows.map((r) => ({
      tier: r.tier,
      count: r.count,
      totalTokens: r.total_tokens,
      avgImportance: r.avg_importance,
      avgHitCount: r.avg_hit_count,
    }));
  }

  /**
   * Get total memory count.
   */
  async getCount(archived = false): Promise<number> {
    const filter = archived ? '' : 'WHERE archived = 0';
    const row = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM memories ${filter}`
    );
    return row?.count ?? 0;
  }

  /**
   * Vacuum the database.
   */
  async vacuum(): Promise<void> {
    await this.db.exec('VACUUM');
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    await this.db.close();
  }

  /**
   * Convert a database row to a MemoryEntry.
   */
  private rowToEntry(row: MemoryRow): MemoryEntry {
    return {
      id: row.id,
      tier: row.tier as MemoryTier,
      type: row.type as MemoryType,
      scope: row.scope as MemoryScope,
      sessionId: row.session_id,
      content: row.content,
      embedding: deserializeEmbedding(row.embedding, this.dimensions),
      keywords: row.keywords ? row.keywords.split(',').filter(Boolean) : [],
      importance: row.importance,
      hitCount: row.hit_count,
      createdAt: row.created_at,
      accessedAt: row.accessed_at,
      expiresAt: row.expires_at,
      source: row.source,
      archived: row.archived === 1,
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }
}

/** Raw database row type */
interface MemoryRow {
  id: string;
  tier: string;
  type: string;
  scope: string;
  session_id: string;
  content: string;
  embedding: Buffer;
  keywords: string;
  importance: number;
  hit_count: number;
  created_at: number;
  accessed_at: number;
  expires_at: number | null;
  source: string;
  archived: number;
  metadata: string;
}

/** Raw link row type */
interface LinkRow {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  strength: number;
  created_at: number;
}
