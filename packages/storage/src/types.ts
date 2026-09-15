/**
 * @oa/storage — Database Types
 * 
 * Core database types for the OvolveAgent storage layer.
 */

// ---------------------------------------------------------------------------
// Database configuration
// ---------------------------------------------------------------------------

export interface StorageConfig {
  /** Path to the SQLite database file. */
  dbPath: string;
  /** Busy timeout in milliseconds (default: 5000). */
  busyTimeout?: number;
  /** Enable WAL mode (default: true). */
  walMode?: boolean;
  /** Enable foreign keys (default: true). */
  foreignKeys?: boolean;
  /** Run migrations on startup (default: true). */
  autoMigrate?: boolean;
  /** Custom pragmas to apply on connection. */
  pragmas?: Record<string, string | number>;
}

// ---------------------------------------------------------------------------
// Session record
// ---------------------------------------------------------------------------

export interface SessionRecord {
  id: string;
  title: string;
  archived: number; // 0 | 1
  deleted: number; // 0 | 1
  phase: string;
  last_seq: number;
  last_event_timestamp: number;
  event_count: number;
  message_count: number;
  error_count: number;
  last_error: string | null;
  metadata: string; // JSON
  created_at: number; // microseconds
  updated_at: number; // microseconds
}

// ---------------------------------------------------------------------------
// Event record (raw database row)
// ---------------------------------------------------------------------------

export interface EventRecord {
  seq: number;
  event_type: string;
  session_id: string;
  timestamp: number;
  payload: string; // JSON
  chain_hash: string;
  metadata: string | null; // JSON
}

// ---------------------------------------------------------------------------
// File snapshot record
// ---------------------------------------------------------------------------

export interface FileSnapshotRecord {
  id: string;
  session_id: string;
  file_path: string;
  content: string;
  content_hash: string;
  version: number;
  byte_size: number;
  created_at: number; // microseconds
  metadata: string | null; // JSON
}

// ---------------------------------------------------------------------------
// Checkpoint record
// ---------------------------------------------------------------------------

export interface CheckpointRecord {
  id: string;
  session_id: string;
  at_seq: number;
  state: string; // JSON
  timestamp: number; // microseconds
  label: string | null;
  expires_at: number | null; // microseconds
}

// ---------------------------------------------------------------------------
// Memory entry record
// ---------------------------------------------------------------------------

export interface MemoryEntryRecord {
  id: string;
  session_id: string;
  content: string;
  embedding: Buffer | null; // Vector embedding
  embedding_model: string | null;
  metadata: string | null; // JSON
  importance: number; // 0-1
  created_at: number; // microseconds
  updated_at: number; // microseconds
  accessed_at: number | null; // microseconds
  access_count: number;
}

// ---------------------------------------------------------------------------
// Migration record
// ---------------------------------------------------------------------------

export interface MigrationRecord {
  namespace: string;
  version: number;
  applied_at: number; // microseconds
}

// ---------------------------------------------------------------------------
// Query options
// ---------------------------------------------------------------------------

export interface PaginationOptions {
  offset?: number;
  limit?: number;
}

export interface TimeRangeOptions {
  fromTimestamp?: number; // microseconds
  toTimestamp?: number; // microseconds
}

export interface ListSessionsOptions extends PaginationOptions {
  includeArchived?: boolean;
  includeDeleted?: boolean;
  phase?: string;
}

export interface ListEventsOptions extends PaginationOptions, TimeRangeOptions {
  eventTypes?: string[];
  fromSeq?: number;
  toSeq?: number;
}

export interface ListFileSnapshotsOptions extends PaginationOptions {
  filePath?: string;
}

export interface ListCheckpointsOptions extends PaginationOptions {
  includeExpired?: boolean;
}

export interface ListMemoryOptions extends PaginationOptions {
  minImportance?: number;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Search types
// ---------------------------------------------------------------------------

export interface VectorSearchOptions {
  /** Query embedding vector. */
  queryEmbedding: Float32Array | number[];
  /** Number of results to return. */
  limit?: number;
  /** Minimum similarity threshold (0-1). */
  minSimilarity?: number;
  /** Filter by session ID. */
  sessionId?: string;
}

export interface VectorSearchResult {
  entry: MemoryEntryRecord;
  /** Cosine similarity (0-1, higher = more similar). */
  similarity: number;
}

// ---------------------------------------------------------------------------
// Transaction types
// ---------------------------------------------------------------------------

export type TransactionFn<T> = () => T;

// ---------------------------------------------------------------------------
// Prepared statement types (better-sqlite3 compatible)
// ---------------------------------------------------------------------------

export interface PreparedStatement {
  run: (...params: unknown[]) => RunResult;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  iterate: (...params: unknown[]) => IterableIterator<unknown>;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}
