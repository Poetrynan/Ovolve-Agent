/**
 * @oa/session-core — Public Exports
 *
 * Session lifecycle management for OvolveAgent.
 *
 * @example
 * ```ts
 * import { createSessionManager } from '@oa/session-core';
 * import { createEventStore } from '@oa/event-store';
 * import { createStorage } from '@oa/storage';
 * import { createProjectionEngine } from '@oa/projection';
 *
 * const storage = createStorage({ dbPath: './data/agent.db' });
 * const eventStore = createEventStore({ database: storage.database });
 * const projectionEngine = createProjectionEngine({ ... });
 *
 * const sessionManager = createSessionManager({
 *   eventStore,
 *   database: storage.database,
 *   projectionEngine,
 * });
 *
 * const session = await sessionManager.createSession({ title: 'New Task' });
 * ```
 */

// Types
export type {
  Session,
  SessionSummary,
  SessionActivity,
  SessionConfig,
  CreateSessionOptions,
  ForkSessionOptions,
  GetHistoryOptions,
  ListSessionsOptions,
  SearchSessionOptions,
  WorkspaceInfo,
  WorkspaceRecord,
  ParkedSession,
  TurnState,
  PendingToolCall,
  CompletedToolCall,
  TokenUsage,
  ParkReason,
  TurnPhase,
  SessionCreatedPayload,
  SessionForkedPayload,
  SessionRenamedPayload,
  SessionWorkspaceChangedPayload,
  SessionArchivedPayload,
  SessionDeletedPayload,
  SessionTagsUpdatedPayload,
} from './types';

// Re-export SessionState and SessionPhase from event-store
export type { SessionState, SessionPhase } from '@oa/event-store';

// SessionManager
export {
  SessionManager,
  createSessionManager,
} from './session-manager';

// WorkspaceManager
export {
  WorkspaceManager,
  createWorkspaceManager,
  WORKSPACES_TABLE_SQL,
  WORKSPACES_PINNED_INDEX_SQL,
} from './workspace-manager';

// SessionBuffers (session parking)
export {
  SessionBuffers,
  createSessionBuffers,
  createInitialTurnState,
  createZeroTokenUsage,
  SESSION_STATE_CACHE_TABLE_SQL,
  SESSION_STATE_CACHE_SESSION_INDEX_SQL,
} from './session-buffers';
