/**
 * @oa/event-store — SessionState Interface & Helpers
 * 
 * SessionState is a pure data interface — no methods. It represents the
 * projected, denormalized state of an agent session at a point in time.
 */

import type { AgentEvent } from './types';

// ---------------------------------------------------------------------------
// SessionState — pure data, no methods
// ---------------------------------------------------------------------------

/**
 * Projected state of a session. Pure data interface with no methods.
 * 
 * Consumers project events into this shape (or an extended version of it)
 * using the ProjectionEngine.
 */
export interface SessionState {
  /** Session identifier. */
  sessionId: string;
  /** Human-readable session title. */
  title: string;
  /** Whether the session is archived. */
  archived: boolean;
  /** Whether the session has been soft-deleted. */
  deleted: boolean;
  /** Current phase of the agent loop. */
  phase: SessionPhase;
  /** The seq of the most recent event applied to this state. */
  lastSeq: number;
  /** The seq of the most recent event applied to this state. */
  lastEventTimestamp: number;
  /** Total number of events in the session. */
  eventCount: number;
  /** Total number of messages exchanged. */
  messageCount: number;
  /** Number of tasks in each phase. */
  taskCounts: TaskCounts;
  /** Number of tool calls by phase. */
  toolCallCounts: ToolCallCounts;
  /** Number of errors encountered. */
  errorCount: number;
  /** Most recent error message (if any). */
  lastError?: string;
  /** Files touched during the session. */
  filesTouched: string[];
  /** Active file snapshots. */
  fileSnapshots: FileSnapshotState[];
  /** Memory entry IDs associated with this session. */
  memoryEntryIds: string[];
  /** Context window configuration. */
  contextWindow: ContextWindowState;
  /** Arbitrary session metadata. */
  metadata: Record<string, unknown>;
  /** Creation timestamp (microseconds). */
  createdAt: number;
  /** Last update timestamp (microseconds). */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Supporting sub-types
// ---------------------------------------------------------------------------

export type SessionPhase =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'awaiting_user'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TaskCounts {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface ToolCallCounts {
  total: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface FileSnapshotState {
  id: string;
  filePath: string;
  version: number;
  createdAt: number;
}

export interface ContextWindowState {
  maxTokens: number;
  currentTokens: number;
  reservedTokens: number;
}

// ---------------------------------------------------------------------------
// Factory — create a blank SessionState for a new session
// ---------------------------------------------------------------------------

export function createInitialSessionState(
  sessionId: string,
  timestamp: number
): SessionState {
  return {
    sessionId,
    title: '',
    archived: false,
    deleted: false,
    phase: 'idle',
    lastSeq: 0,
    lastEventTimestamp: timestamp,
    eventCount: 0,
    messageCount: 0,
    taskCounts: {
      total: 0,
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    },
    toolCallCounts: {
      total: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    },
    errorCount: 0,
    lastError: undefined,
    filesTouched: [],
    fileSnapshots: [],
    memoryEntryIds: [],
    contextWindow: {
      maxTokens: 128000,
      currentTokens: 0,
      reservedTokens: 0,
    },
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a SessionState is empty (no events projected yet).
 */
export function isSessionStateEmpty(state: SessionState): boolean {
  return state.lastSeq === 0 && state.eventCount === 0;
}

/**
 * Clone a SessionState safely (deep clone).
 */
export function cloneSessionState(state: SessionState): SessionState {
  return {
    ...state,
    taskCounts: { ...state.taskCounts },
    toolCallCounts: { ...state.toolCallCounts },
    filesTouched: [...state.filesTouched],
    fileSnapshots: state.fileSnapshots.map((s) => ({ ...s })),
    memoryEntryIds: [...state.memoryEntryIds],
    contextWindow: { ...state.contextWindow },
    metadata: JSON.parse(JSON.stringify(state.metadata)),
    lastError: state.lastError,
  };
}

/**
 * Compute the progress percentage of tasks in a session.
 */
export function computeTaskProgress(state: SessionState): number {
  if (state.taskCounts.total === 0) return 0;
  const finished =
    state.taskCounts.completed +
    state.taskCounts.failed +
    state.taskCounts.cancelled;
  return Math.round((finished / state.taskCounts.total) * 100);
}

/**
 * Check if the session has any active (in-progress) tasks.
 */
export function hasActiveTasks(state: SessionState): boolean {
  return (
    state.taskCounts.inProgress > 0 ||
    state.taskCounts.pending > 0 ||
    state.toolCallCounts.running > 0
  );
}

/**
 * Summary of the session state for display purposes.
 */
export function summarizeSessionState(state: SessionState): string {
  const parts = [
    `Session ${state.sessionId}`,
    `Phase: ${state.phase}`,
    `Messages: ${state.messageCount}`,
    `Tasks: ${state.taskCounts.completed}/${state.taskCounts.total} done`,
    `Errors: ${state.errorCount}`,
  ];
  if (state.lastError) {
    parts.push(`Last error: ${state.lastError}`);
  }
  return parts.join(' | ');
}

/** Default export of related helpers keyed by name. */
export const SessionStateHelpers = {
  createInitial: createInitialSessionState,
  isEmpty: isSessionStateEmpty,
  clone: cloneSessionState,
  taskProgress: computeTaskProgress,
  hasActiveTasks,
  summarize: summarizeSessionState,
};
