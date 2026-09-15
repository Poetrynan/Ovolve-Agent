/**
 * @oa/storage — Integration Fix
 *
 * Additional exports and type bridges needed by other packages.
 * Ensures interface alignment across the monorepo.
 */

import type { EventType } from '@oa/event-store';
import type {
  SessionRecord,
  EventRecord,
  FileSnapshotRecord,
  CheckpointRecord,
  MemoryEntryRecord,
  StorageConfig,
} from './types';

// ---------------------------------------------------------------------------
// Re-exports for cross-package compatibility
// ---------------------------------------------------------------------------

export type {
  SessionRecord,
  EventRecord,
  FileSnapshotRecord,
  CheckpointRecord,
  MemoryEntryRecord,
  StorageConfig,
};

// ---------------------------------------------------------------------------
// Conversion helpers between storage records and domain types
// ---------------------------------------------------------------------------

/**
 * Convert an EventRecord (database row) to a storage-friendly event object.
 * The payload and metadata are parsed from JSON strings.
 */
export function parseEventRecord(record: EventRecord): {
  seq: number;
  eventType: string;
  sessionId: string;
  timestamp: number;
  payload: unknown;
  chainHash: string;
  metadata: Record<string, string> | null;
} {
  return {
    seq: record.seq,
    eventType: record.event_type,
    sessionId: record.session_id,
    timestamp: record.timestamp,
    payload: JSON.parse(record.payload),
    chainHash: record.chain_hash,
    metadata: record.metadata ? JSON.parse(record.metadata) : null,
  };
}

/**
 * Convert a domain event to an EventRecord (database row).
 * The payload and metadata are serialized to JSON strings.
 */
export function serializeEventRecord(event: {
  seq: number;
  eventType: EventType | string;
  sessionId: string;
  timestamp: number;
  payload: unknown;
  chainHash: string;
  metadata?: Record<string, string> | null;
}): EventRecord {
  return {
    seq: event.seq,
    event_type: String(event.eventType),
    session_id: event.sessionId,
    timestamp: event.timestamp,
    payload: JSON.stringify(event.payload),
    chain_hash: event.chainHash,
    metadata: event.metadata ? JSON.stringify(event.metadata) : null,
  };
}

/**
 * Convert a FileSnapshotRecord to a parsed object.
 */
export function parseFileSnapshotRecord(record: FileSnapshotRecord): {
  id: string;
  sessionId: string;
  filePath: string;
  content: string;
  contentHash: string;
  version: number;
  byteSize: number;
  createdAt: number;
  metadata: Record<string, unknown> | null;
} {
  return {
    id: record.id,
    sessionId: record.session_id,
    filePath: record.file_path,
    content: record.content,
    contentHash: record.content_hash,
    version: record.version,
    byteSize: record.byte_size,
    createdAt: record.created_at,
    metadata: record.metadata ? JSON.parse(record.metadata) : null,
  };
}

/**
 * Convert a CheckpointRecord to a parsed object.
 */
export function parseCheckpointRecord(record: CheckpointRecord): {
  id: string;
  sessionId: string;
  atSeq: number;
  state: unknown;
  timestamp: number;
  label: string | null;
  expiresAt: number | null;
} {
  return {
    id: record.id,
    sessionId: record.session_id,
    atSeq: record.at_seq,
    state: JSON.parse(record.state),
    timestamp: record.timestamp,
    label: record.label,
    expiresAt: record.expires_at,
  };
}

/**
 * Convert a MemoryEntryRecord to a parsed object.
 */
export function parseMemoryEntryRecord(record: MemoryEntryRecord): {
  id: string;
  sessionId: string;
  content: string;
  embedding: Buffer | null;
  embeddingModel: string | null;
  metadata: Record<string, unknown> | null;
  importance: number;
  createdAt: number;
  updatedAt: number;
  accessedAt: number | null;
  accessCount: number;
} {
  return {
    id: record.id,
    sessionId: record.session_id,
    content: record.content,
    embedding: record.embedding,
    embeddingModel: record.embedding_model,
    metadata: record.metadata ? JSON.parse(record.metadata) : null,
    importance: record.importance,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    accessedAt: record.accessed_at,
    accessCount: record.access_count,
  };
}

// ---------------------------------------------------------------------------
// Session record helpers
// ---------------------------------------------------------------------------

/**
 * Create a new SessionRecord with default values.
 */
export function createSessionRecord(id: string, title: string): SessionRecord {
  const now = Date.now() * 1000;
  return {
    id,
    title,
    archived: 0,
    deleted: 0,
    phase: 'idle',
    last_seq: 0,
    last_event_timestamp: now,
    event_count: 0,
    message_count: 0,
    error_count: 0,
    last_error: null,
    metadata: '{}',
    created_at: now,
    updated_at: now,
  };
}

/**
 * Parse session metadata from JSON string.
 */
export function parseSessionMetadata(record: SessionRecord): Record<string, unknown> {
  try {
    return JSON.parse(record.metadata);
  } catch {
    return {};
  }
}
