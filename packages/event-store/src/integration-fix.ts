/**
 * @oa/event-store — Integration Fix
 *
 * Additional exports and type bridges needed by other packages.
 * Ensures interface alignment across the monorepo.
 */

import type { DatabaseManager } from '@oa/storage';
import type { AgentEvent, EventType, NewEvent, ReadStreamOptions } from './types';

// ---------------------------------------------------------------------------
// Re-exports for cross-package compatibility
// ---------------------------------------------------------------------------

export type { AgentEvent, NewEvent, ReadStreamOptions };
export { EventType, EVENT_TYPE_COUNT } from './types';

// ---------------------------------------------------------------------------
// Event type constants for use in switch/if statements
// ---------------------------------------------------------------------------

export const EVENT_TYPES = {
  // Session lifecycle
  SessionCreated: EventType.SessionCreated,
  SessionUpdated: EventType.SessionUpdated,
  SessionDeleted: EventType.SessionDeleted,
  SessionArchived: EventType.SessionArchived,
  SessionRestored: EventType.SessionRestored,
  // Message lifecycle
  MessageCreated: EventType.MessageCreated,
  MessageUpdated: EventType.MessageUpdated,
  MessageDeleted: EventType.MessageDeleted,
  MessageReactionAdded: EventType.MessageReactionAdded,
  MessageReactionRemoved: EventType.MessageReactionRemoved,
  // Task lifecycle
  TaskCreated: EventType.TaskCreated,
  TaskUpdated: EventType.TaskUpdated,
  TaskCompleted: EventType.TaskCompleted,
  TaskFailed: EventType.TaskFailed,
  TaskCancelled: EventType.TaskCancelled,
  // Tool execution
  ToolCallRequested: EventType.ToolCallRequested,
  ToolCallStarted: EventType.ToolCallStarted,
  ToolCallCompleted: EventType.ToolCallCompleted,
  ToolCallFailed: EventType.ToolCallFailed,
  ToolCallCancelled: EventType.ToolCallCancelled,
  // File operations
  FileRead: EventType.FileRead,
  FileWritten: EventType.FileWritten,
  FileDeleted: EventType.FileDeleted,
  FileSnapshotCreated: EventType.FileSnapshotCreated,
  FileSnapshotRestored: EventType.FileSnapshotRestored,
  // Memory & context
  MemoryEntryAdded: EventType.MemoryEntryAdded,
  MemoryEntryUpdated: EventType.MemoryEntryUpdated,
  MemoryEntryDeleted: EventType.MemoryEntryDeleted,
  ContextWindowAdjusted: EventType.ContextWindowAdjusted,
  // Agent state
  AgentStateChanged: EventType.AgentStateChanged,
  AgentErrorOccurred: EventType.AgentErrorOccurred,
  CheckpointCreated: EventType.CheckpointCreated,
  CheckpointRestored: EventType.CheckpointRestored,
} as const;

// ---------------------------------------------------------------------------
// Helper functions for cross-package use
// ---------------------------------------------------------------------------

/**
 * Type guard to check if a value is a valid EventType.
 */
export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && Object.values(EventType).includes(value as EventType);
}

/**
 * Convert a raw event_type string to EventType enum.
 * Throws if the string is not a valid EventType.
 */
export function parseEventType(value: string): EventType {
  if (isEventType(value)) {
    return value;
  }
  throw new Error(`Invalid EventType: ${value}`);
}

/**
 * Create a new event with default values filled in.
 */
export function createNewEvent<T = unknown>(
  eventType: EventType,
  sessionId: string,
  payload: T,
  metadata?: Record<string, string>
): NewEvent<T> {
  return {
    eventType,
    sessionId,
    payload,
    timestamp: Date.now() * 1000,
    metadata,
  };
}

/**
 * Event type groups for filtering.
 */
export const EVENT_TYPE_GROUPS = {
  session: [
    EventType.SessionCreated,
    EventType.SessionUpdated,
    EventType.SessionDeleted,
    EventType.SessionArchived,
    EventType.SessionRestored,
  ] as EventType[],
  message: [
    EventType.MessageCreated,
    EventType.MessageUpdated,
    EventType.MessageDeleted,
    EventType.MessageReactionAdded,
    EventType.MessageReactionRemoved,
  ] as EventType[],
  task: [
    EventType.TaskCreated,
    EventType.TaskUpdated,
    EventType.TaskCompleted,
    EventType.TaskFailed,
    EventType.TaskCancelled,
  ] as EventType[],
  tool: [
    EventType.ToolCallRequested,
    EventType.ToolCallStarted,
    EventType.ToolCallCompleted,
    EventType.ToolCallFailed,
    EventType.ToolCallCancelled,
  ] as EventType[],
  file: [
    EventType.FileRead,
    EventType.FileWritten,
    EventType.FileDeleted,
    EventType.FileSnapshotCreated,
    EventType.FileSnapshotRestored,
  ] as EventType[],
  memory: [
    EventType.MemoryEntryAdded,
    EventType.MemoryEntryUpdated,
    EventType.MemoryEntryDeleted,
    EventType.ContextWindowAdjusted,
  ] as EventType[],
  agent: [
    EventType.AgentStateChanged,
    EventType.AgentErrorOccurred,
    EventType.CheckpointCreated,
    EventType.CheckpointRestored,
  ] as EventType[],
};

// ---------------------------------------------------------------------------
// DatabaseManager type re-export for convenience
// ---------------------------------------------------------------------------

export type { DatabaseManager } from '@oa/storage';
