/**
 * @oa/projection — Core Types
 *
 * Projection engine types for projecting events into application state.
 * Includes reducer function types, projection results, and state builder types.
 */

import type {
  AgentEvent,
  EventType,
  SessionState,
  SessionPhase,
  TaskCounts,
  ToolCallCounts,
  ContextWindowState,
} from '@oa/event-store';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { AgentEvent, SessionState, SessionPhase, TaskCounts, ToolCallCounts, ContextWindowState };

// ---------------------------------------------------------------------------
// ReducerFunction — maps (state, event) -> state
// ---------------------------------------------------------------------------

export type ReducerFunction<S = SessionState, E = unknown> = (
  state: S,
  event: AgentEvent<E>
) => S;

// ---------------------------------------------------------------------------
// ProjectionState — extended state with all session fields
// ---------------------------------------------------------------------------

/**
 * Extended projection state that includes all fields needed by the application.
 * This is the state shape produced by the projection engine and consumed by
 * the SessionManager and UI.
 */
export interface ProjectionState extends SessionState {
  /** The most recent user message content (truncated). */
  lastUserMessage: string;
  /** The most recent assistant message content (truncated). */
  lastAssistantMessage: string;
  /** Tool calls currently in progress. */
  activeToolCalls: ActiveToolCallInfo[];
  /** Tool calls completed in the current turn. */
  completedToolCalls: CompletedToolCallInfo[];
  /** Files modified in the current turn. */
  modifiedFiles: string[];
  /** Current token usage for the session. */
  tokenUsage: ProjectionTokenUsage;
  /** Whether the session is currently streaming a response. */
  isStreaming: boolean;
  /** Whether the session is awaiting user input. */
  awaitingUser: boolean;
  /** Compact summary of the session's current task. */
  currentTaskSummary: string;
  /** Sub-agent sessions spawned from this session. */
  subagentSessionIds: string[];
  /** Memory entries injected during the session. */
  injectedMemoryCount: number;
}

export interface ActiveToolCallInfo {
  callId: string;
  toolName: string;
  startedAt: number;
  arguments: unknown;
}

export interface CompletedToolCallInfo {
  callId: string;
  toolName: string;
  status: 'completed' | 'failed' | 'cancelled';
  durationMs: number;
  completedAt: number;
}

export interface ProjectionTokenUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turnInputTokens: number;
  turnOutputTokens: number;
}

// ---------------------------------------------------------------------------
// ProjectionResult — wraps projected state with metadata
// ---------------------------------------------------------------------------

export interface ProjectionResult<S = ProjectionState> {
  /** The projected state. */
  state: S;
  /** The seq up to which the state was projected. */
  atSeq: number;
  /** Number of events applied. */
  eventsApplied: number;
  /** Whether the projection started from a snapshot. */
  fromSnapshot: boolean;
  /** The seq the snapshot was taken at (if fromSnapshot). */
  snapshotSeq?: number;
  /** Projection duration in milliseconds. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// ProjectionEngineConfig — configuration for the projection engine
// ---------------------------------------------------------------------------

export interface ProjectionEngineConfig {
  /** Storage database manager for reading events and snapshots. */
  database: import('@oa/storage').DatabaseManager;
  /** Event store instance for reading event streams. */
  eventStore: import('@oa/event-store').IEventStore;
  /** Map of event type to reducer function. */
  reducers: Partial<Record<EventType, ReducerFunction>>;
  /** Default state factory. */
  initialState: () => ProjectionState;
  /** Cache TTL in milliseconds (default: 30000). */
  cacheTtlMs?: number;
  /** Enable projection caching (default: true). */
  enableCache?: boolean;
}

// ---------------------------------------------------------------------------
// IProjectionEngine — interface for projection engines
// ---------------------------------------------------------------------------

export interface IProjectionEngine {
  /**
   * Project the full state for a session from its events.
   * @param sessionId - The session ID.
   * @param targetSeq - Project up to this seq (default: latest).
   */
  project<S = ProjectionState>(sessionId: string, targetSeq?: number): Promise<S>;

  /**
   * Project incrementally from a snapshot.
   * @param sessionId - The session ID.
   * @param fromSeq - Start from this seq (after snapshot).
   */
  projectIncremental<S = ProjectionState>(sessionId: string, fromSeq: number): Promise<S>;

  /**
   * Apply a single event to the given state.
   * @param state - Current state.
   * @param event - Event to apply.
   */
  applyEvent<S>(state: S, event: AgentEvent): S;

  /**
   * Create a state snapshot for a session.
   * @param sessionId - The session ID.
   */
  createSnapshot(sessionId: string): Promise<void>;

  /**
   * Get the latest snapshot for a session.
   * @param sessionId - The session ID.
   */
  getSnapshot(sessionId: string): Promise<{ atSeq: number; state: ProjectionState } | null>;

  /**
   * Rebuild state from an explicit list of events (no database reads).
   * @param events - Events to project.
   */
  rebuildFromEvents<S = ProjectionState>(events: AgentEvent[]): S;

  /**
   * Invalidate the cached projection for a session.
   * @param sessionId - The session ID.
   */
  invalidateCache(sessionId: string): void;

  /**
   * Clear all cached projections.
   */
  clearCache(): void;
}

// ---------------------------------------------------------------------------
// Snapshot metadata
// ---------------------------------------------------------------------------

export interface SnapshotMetadata {
  sessionId: string;
  atSeq: number;
  timestamp: number;
  eventCount: number;
  stateHash: string;
}
