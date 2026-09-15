/**
 * @oa/session-core — Core Types
 *
 * Session lifecycle, workspace management, and session parking types.
 * Extends the base SessionState from @oa/event-store with runtime metadata.
 */

import type { SessionState, SessionPhase } from '@oa/event-store';

// ---------------------------------------------------------------------------
// Re-exports from event-store (for convenience)
// ---------------------------------------------------------------------------

export type { SessionState, SessionPhase };

// ---------------------------------------------------------------------------
// Session — runtime representation of a session
// ---------------------------------------------------------------------------

/**
 * Full session representation combining persisted state with runtime metadata.
 * The `state` field is the projected state from the projection engine; the
 * rest are runtime-only fields not stored in the events/sessions tables.
 */
export interface Session {
  /** Session identifier (UUID_prefixed). */
  readonly id: string;
  /** Human-readable title (auto-generated or user-set). */
  title: string;
  /** Whether the session is archived (soft-hidable). */
  archived: boolean;
  /** Whether the session is soft-deleted. */
  deleted: boolean;
  /** Current agent loop phase. */
  phase: SessionPhase;
  /** Projected state — kept in sync by the projection engine. */
  state: SessionState;
  /** Workspace path this session belongs to. */
  workspace: string;
  /** Parent session ID if this session was forked (null otherwise). */
  forkedFrom: string | null;
  /** The seq at which the fork occurred (null if not forked). */
  forkPointSeq: number | null;
  /** Custom user-defined tags. */
  tags: string[];
  /** Creation timestamp (microseconds). */
  readonly createdAt: number;
  /** Last update timestamp (microseconds). */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// SessionSummary — lightweight representation for list views
// ---------------------------------------------------------------------------

export interface SessionSummary {
  readonly id: string;
  title: string;
  archived: boolean;
  phase: SessionPhase;
  workspace: string;
  messageCount: number;
  eventCount: number;
  errorCount: number;
  forkedFrom: string | null;
  tags: string[];
  readonly createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// SessionActivity — activity tracking for stall detection & display
// ---------------------------------------------------------------------------

export interface SessionActivity {
  readonly sessionId: number;
  /** Seq of the last event applied to this session. */
  lastEventSeq: number;
  /** Timestamp of the last event (microseconds). */
  lastEventTimestamp: number;
  /** Whether the session currently has an in-flight turn. */
  hasActiveTurn: boolean;
  /** The turn ID currently executing (if any). */
  activeTurnId: string | null;
  /** Number of consecutive stalls detected. */
  stallCount: number;
  /** Timestamp of last stall detection (microseconds, 0 if none). */
  lastStallTimestamp: number;
  /** Current turn phase. */
  turnPhase: TurnPhase;
}

export type TurnPhase =
  | 'idle'
  | 'thinking'
  | 'calling_tools'
  | 'awaiting_tool'
  | 'streaming_response'
  | 'completing'
  | 'paused'
  | 'error';

// ---------------------------------------------------------------------------
// SessionConfig — configuration for session creation
// ---------------------------------------------------------------------------

export interface CreateSessionOptions {
  /** Explicit session ID (auto-generated if omitted). */
  id?: string;
  /** Initial title (auto-generated from first message if omitted). */
  title?: string;
  /** Workspace path (defaults to active workspace). */
  workspace?: string;
  /** Tags to apply to the session. */
  tags?: string[];
  /** Initial metadata merged into the session state. */
  metadata?: Record<string, unknown>;
  /** Set the initial phase (defaults to 'idle'). */
  phase?: SessionPhase;
}

export interface ForkSessionOptions {
  /** Explicit session ID for the fork (auto-generated if omitted). */
  id?: string;
  /** Title for the forked session (defaults to "Fork of <source>"). */
  title?: string;
  /** Override the fork point (defaults to latest event seq). */
  forkPointSeq?: number;
  /** Copy tags from source session (default: true). */
  copyTags?: boolean;
  /** Additional metadata merged into the forked session. */
  metadata?: Record<string, unknown>;
}

export interface GetHistoryOptions {
  /** Start seq (inclusive). */
  fromSeq?: number;
  /** End seq (inclusive). */
  toSeq?: number;
  /** Filter to specific event types. */
  eventTypes?: import('@oa/event-store').EventType[];
  /** Maximum number of events to return. */
  limit?: number;
  /** Return events in descending seq order. */
  reverse?: boolean;
}

export interface ListSessionsOptions {
  /** Include archived sessions. */
  includeArchived?: boolean;
  /** Include soft-deleted sessions. */
  includeDeleted?: boolean;
  /** Filter by workspace path. */
  workspace?: string;
  /** Filter by phase. */
  phase?: SessionPhase;
  /** Filter by tags (must have all specified). */
  tags?: string[];
  /** Filter sessions forked from this session ID. */
  forkedFrom?: string;
  /** Pagination offset. */
  offset?: number;
  /** Pagination limit (default: 50). */
  limit?: number;
  /** Sort field. */
  sortBy?: 'updatedAt' | 'createdAt' | 'title' | 'eventCount';
  /** Sort direction. */
  sortDirection?: 'asc' | 'desc';
}

export interface SearchSessionOptions {
  /** Maximum results (default: 20). */
  limit?: number;
  /** Filter by event types. */
  eventTypes?: import('@oa/event-store').EventType[];
  /** Search events after this seq. */
  fromSeq?: number;
  /** Search events before this seq. */
  toSeq?: number;
}

// ---------------------------------------------------------------------------
// SessionConfig — global configuration for SessionManager
// ---------------------------------------------------------------------------

export interface SessionConfig {
  /** Event store instance for appending session lifecycle events. */
  eventStore: import('@oa/event-store').IEventStore;
  /** Storage database manager for session records. */
  database: import('@oa/storage').DatabaseManager;
  /** Projection engine for state reconstruction. */
  projectionEngine: import('@oa/projection').IProjectionEngine;
  /** Default workspace path for new sessions. */
  defaultWorkspace?: string;
  /** Auto-archive sessions after N microseconds of inactivity (0 = disabled). */
  autoArchiveAfter?: number;
  /** Maximum number of sessions to retain (0 = unlimited). */
  maxSessions?: number;
  /** Custom ID generator (defaults to `sess_${uuid()}`). */
  idGenerator?: () => string;
}

// ---------------------------------------------------------------------------
// Workspace types
// ---------------------------------------------------------------------------

export interface WorkspaceInfo {
  /** Absolute filesystem path. */
  path: string;
  /** Custom display label (null = use directory name). */
  label: string | null;
  /** Whether the workspace is pinned to the top of lists. */
  pinned: boolean;
  /** Whether the workspace is hidden from default views. */
  hidden: boolean;
  /** Number of active sessions in this workspace. */
  sessionCount: number;
  /** Creation timestamp (microseconds). */
  createdAt: number;
  /** Last access timestamp (microseconds). */
  lastAccessAt: number;
}

export interface WorkspaceRecord {
  path: string;
  label: string | null;
  pinned: number; // 0 | 1
  hidden: number; // 0 | 1;
  created_at: number;
  last_access_at: number;
}

// ---------------------------------------------------------------------------
// Session parking buffer types
// ---------------------------------------------------------------------------

export interface ParkedSession {
  /** Session ID. */
  sessionId: string;
  /** Serialized projected state at park time. */
  state: SessionState;
  /** Serialized turn state (in-flight tool calls, partial responses). */
  turnState: TurnState;
  /** Timestamp the session was parked (microseconds). */
  parkedAt: number;
  /** Reason for parking. */
  reason: ParkReason;
  /** Sequence number at park time. */
  atSeq: number;
}

export interface TurnState {
  /** The turn ID executing when parked. */
  turnId: string;
  /** Current turn phase. */
  phase: TurnPhase;
  /** Partial streamed response text (if streaming). */
  partialResponse: string;
  /** Tool calls that were in-flight. */
  pendingToolCalls: PendingToolCall[];
  /** Tool call results received so far. */
  completedToolCalls: CompletedToolCall[];
  /** Token usage accumulated so far. */
  tokenUsage: TokenUsage;
  /** Custom turn metadata. */
  metadata: Record<string, unknown>;
}

export interface PendingToolCall {
  callId: string;
  toolName: string;
  arguments: unknown;
  startedAt: number;
}

export interface CompletedToolCall {
  callId: string;
  toolName: string;
  arguments: unknown;
  result: unknown;
  durationMs: number;
  completedAt: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type ParkReason =
  | 'app_closing'
  | 'workspace_switch'
  | 'manual'
  | 'stall_detected'
  | 'error_recovery';

// ---------------------------------------------------------------------------
// Event payloads for session lifecycle events
// ---------------------------------------------------------------------------

export interface SessionCreatedPayload {
  title: string;
  workspace: string;
  tags: string[];
  forkedFrom: string | null;
  forkPointSeq: number | null;
  metadata: Record<string, unknown>;
}

export interface SessionForkedPayload {
  sourceSessionId: string;
  forkPointSeq: number;
  sourceTitle: string;
}

export interface SessionRenamedPayload {
  oldTitle: string;
  newTitle: string;
}

export interface SessionWorkspaceChangedPayload {
  oldWorkspace: string;
  newWorkspace: string;
}

export interface SessionArchivedPayload {
  reason?: string;
}

export interface SessionDeletedPayload {
  hardDelete: boolean;
}

export interface SessionTagsUpdatedPayload {
  added: string[];
  removed: string[];
}
