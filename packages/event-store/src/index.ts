/**
 * @oa/event-store — Public Exports
 * 
 * Event-sourced architecture for OvolveAgent.
 * 
 * @example
 * ```ts
 * import { createEventStore, EventType } from '@oa/event-store';
 * import { createStorage } from '@oa/storage';
 * 
 * const storage = createStorage({ dbPath: './data/agent.db' });
 * const eventStore = createEventStore({ database: storage.database });
 * 
 * const seq = await eventStore.append({
 *   eventType: EventType.SessionCreated,
 *   sessionId: 'sess_123',
 *   payload: { title: 'New Session' },
 * });
 * ```
 */

// Types
export {
  EventType,
  EVENT_TYPE_COUNT,
  type AgentEvent,
  type NewEvent,
  type ReadStreamOptions,
  type Snapshot,
  type Checkpoint,
  type SearchResult,
  type SearchOptions,
  type ChainVerificationResult,
  type EventStoreConfig,
  type ProjectionEngineConfig,
  type EventReducer,
} from './types';

// Session state
export {
  type SessionState,
  type SessionPhase,
  type TaskCounts,
  type ToolCallCounts,
  type FileSnapshotState,
  type ContextWindowState,
  createInitialSessionState,
  isSessionStateEmpty,
  cloneSessionState,
  computeTaskProgress,
  hasActiveTasks,
  summarizeSessionState,
  SessionStateHelpers,
} from './session-state';

// Schema
export {
  EVENTS_TABLE_SQL,
  EVENTS_SESSION_SEQ_INDEX_SQL,
  EVENTS_SESSION_TIME_INDEX_SQL,
  EVENTS_TYPE_INDEX_SQL,
  EVENTS_FTS_TABLE_SQL,
  EVENTS_FTS_INSERT_TRIGGER_SQL,
  EVENTS_FTS_DELETE_TRIGGER_SQL,
  EVENTS_FTS_UPDATE_TRIGGER_SQL,
  SNAPSHOTS_TABLE_SQL,
  SNAPSHOTS_SESSION_INDEX_SQL,
  CHECKPOINTS_TABLE_SQL,
  CHECKPOINTS_SESSION_INDEX_SQL,
  CHECKPOINTS_EXPIRY_INDEX_SQL,
  EVENT_STORE_MIGRATIONS,
  LATEST_EVENT_STORE_SCHEMA_VERSION,
  type Migration,
} from './schema';

// EventStore
export {
  EventStore,
  createEventStore,
  type IEventStore,
} from './event-store';

// ProjectionEngine
export {
  ProjectionEngine,
  createProjectionEngine,
  type IProjectionEngine,
} from './projection';

// Log Exporter (Dual-track LogExport)
export {
  LogExporter,
  createLogExporter,
  type ExportConfig,
} from './log-exporter';
