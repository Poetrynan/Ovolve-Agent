/**
 * @oa/event-store — Core Types
 * 
 * Event-sourced architecture types for OvolveAgent.
 * Append-only event sourcing for session history.
 */

// ---------------------------------------------------------------------------
// EventType — 33 distinct event types covering the full agent lifecycle
// ---------------------------------------------------------------------------

export enum EventType {
  // Session lifecycle (0-4)
  SessionCreated = 'session.created',
  SessionUpdated = 'session.updated',
  SessionDeleted = 'session.deleted',
  SessionArchived = 'session.archived',
  SessionRestored = 'session.restored',

  // Message lifecycle (5-9)
  MessageCreated = 'message.created',
  MessageUpdated = 'message.updated',
  MessageDeleted = 'message.deleted',
  MessageReactionAdded = 'message.reaction.added',
  MessageReactionRemoved = 'message.reaction.removed',

  // Task lifecycle (10-14)
  TaskCreated = 'task.created',
  TaskUpdated = 'task.updated',
  TaskCompleted = 'task.completed',
  TaskFailed = 'task.failed',
  TaskCancelled = 'task.cancelled',

  // Tool execution (15-19)
  ToolCallRequested = 'tool.call.requested',
  ToolCallStarted = 'tool.call.started',
  ToolCallCompleted = 'tool.call.completed',
  ToolCallFailed = 'tool.call.failed',
  ToolCallCancelled = 'tool.call.cancelled',

  // File operations (20-24)
  FileRead = 'file.read',
  FileWritten = 'file.written',
  FileDeleted = 'file.deleted',
  FileSnapshotCreated = 'file.snapshot.created',
  FileSnapshotRestored = 'file.snapshot.restored',

  // Memory & context (25-28)
  MemoryEntryAdded = 'memory.entry.added',
  MemoryEntryUpdated = 'memory.entry.updated',
  MemoryEntryDeleted = 'memory.entry.deleted',
  ContextWindowAdjusted = 'context.window.adjusted',

  // Agent state (29-32)
  AgentStateChanged = 'agent.state.changed',
  AgentErrorOccurred = 'agent.error.occurred',
  CheckpointCreated = 'checkpoint.created',
  CheckpointRestored = 'checkpoint.restored',
}

/** Total number of EventType values — MUST stay at 33 */
export const EVENT_TYPE_COUNT = 33;

// ---------------------------------------------------------------------------
// Core event shapes
// ---------------------------------------------------------------------------

/**
 * A fully-persisted agent event. The `seq` field is the auto-incremented
 * primary key assigned by the database; it is the global ordering key.
 */
export interface AgentEvent<T = unknown> {
  /** Auto-incremented sequence number (primary key). */
  seq: number;
  /** Event type discriminator. */
  eventType: EventType;
  /** Session this event belongs to. */
  sessionId: string;
  /** Microsecond-precision timestamp (Date.now() * 1000). */
  timestamp: number;
  /** Arbitrary JSON payload. */
  payload: T;
  /**
   * Chain hash — SHA-256 of (prev_chain_hash + eventType + sessionId +
   * timestamp + JSON(payload)). Ensures tamper-evident append-only log.
   */
  chainHash: string;
  /** Optional metadata (source, correlation IDs, etc). */
  metadata?: Record<string, string>;
}

/**
 * Event as submitted by callers — missing the fields the store fills in.
 */
export interface NewEvent<T = unknown> {
  eventType: EventType;
  sessionId: string;
  payload: T;
  /** Override timestamp (defaults to Date.now() * 1000). */
  timestamp?: number;
  /** Optional metadata. */
  metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Read options
// ---------------------------------------------------------------------------

export interface ReadStreamOptions {
  /** Start seq (inclusive). */
  fromSeq?: number;
  /** End seq (inclusive). */
  toSeq?: number;
  /** Filter to specific event types. */
  eventTypes?: EventType[];
  /** Maximum number of events to return. */
  limit?: number;
  /** Return events in descending seq order. */
  reverse?: boolean;
}

// ---------------------------------------------------------------------------
// Snapshot & checkpoint types
// ---------------------------------------------------------------------------

export interface Snapshot<T = unknown> {
  seq: number;
  sessionId: string;
  /** The seq of the event the snapshot was taken at. */
  atSeq: number;
  /** Projected state at `atSeq`. */
  state: T;
  /** Microsecond timestamp. */
  timestamp: number;
  /** Hash of the snapshot state for integrity verification. */
  stateHash: string;
}

export interface Checkpoint<T = unknown> {
  id: string;
  sessionId: string;
  /** The seq the checkpoint was created at. */
  atSeq: number;
  /** Full state snapshot. */
  state: T;
  /** Microsecond timestamp. */
  timestamp: number;
  /** Optional label for user-facing identification. */
  label?: string;
  /** Optional TTL (microseconds) after which the checkpoint expires. */
  expiresAt?: number;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchResult<T = unknown> {
  event: AgentEvent<T>;
  /** FTS5 relevance rank (lower = more relevant). */
  rank: number;
  /** Snippet of the matching text. */
  snippet?: string;
}

export interface SearchOptions {
  /** Maximum results. */
  limit?: number;
  /** Filter by event types. */
  eventTypes?: EventType[];
  /** Filter events after this seq. */
  fromSeq?: number;
  /** Filter events before this seq. */
  toSeq?: number;
}

// ---------------------------------------------------------------------------
// Chain verification
// ---------------------------------------------------------------------------

export interface ChainVerificationResult {
  /** Whether the chain integrity is intact. */
  valid: boolean;
  /** Number of events verified. */
  eventsVerified: number;
  /** First seq where the chain broke (if any). */
  brokenAtSeq?: number;
  /** Expected hash at the break point. */
  expectedHash?: string;
  /** Actual hash at the break point. */
  actualHash?: string;
}

// ---------------------------------------------------------------------------
// Store configuration
// ---------------------------------------------------------------------------

export interface EventStoreConfig {
  /** Database manager instance (from @oa/storage). */
  database: import('@oa/storage').DatabaseManager;
  /** Enable automatic snapshot creation (default: true). */
  autoSnapshot?: boolean;
  /** Create a snapshot every N events (default: 100). */
  snapshotInterval?: number;
  /** Custom snapshot state projector. */
  snapshotProjector?: <T>(events: AgentEvent[]) => T;
}

// ---------------------------------------------------------------------------
// Projection types
// ---------------------------------------------------------------------------

export interface ProjectionEngineConfig {
  database: import('@oa/storage').DatabaseManager;
  /** Map of event type to reducer function. */
  reducers: Partial<Record<EventType, EventReducer>>;
  /** Default state factory. */
  initialState: () => unknown;
}

export type EventReducer<S = unknown, E = unknown> = (
  state: S,
  event: AgentEvent<E>
) => S;
