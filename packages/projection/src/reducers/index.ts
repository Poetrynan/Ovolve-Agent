/**
 * @oa/projection — Reducer Registry
 *
 * Aggregates all event reducers into a single map keyed by EventType.
 * Import this registry when constructing the ProjectionEngine.
 */

import type { EventType } from '@oa/event-store';
import type { ReducerFunction } from '../types';
import { messageCreatedReducer } from './userMessage';
import {
  llmResponseStartedReducer,
  llmResponseChunkReducer,
  llmResponseCompletedReducer,
} from './llmResponse';
import {
  toolCallRequestedReducer,
  toolCallStartedReducer,
  toolCallCompletedReducer,
  toolCallFailedReducer,
  toolCallCancelledReducer,
} from './toolCall';
import {
  contextFoldReducer,
  contextWindowAdjustedReducer,
} from './fold';
import {
  memoryEntryAddedReducer,
  memoryEntryUpdatedReducer,
  memoryEntryDeletedReducer,
  memoryInjectedReducer,
} from './memory';
import {
  sessionCreatedReducer,
  sessionUpdatedReducer,
  sessionDeletedReducer,
  sessionArchivedReducer,
  sessionRestoredReducer,
} from './session';
import {
  subagentSpawnedReducer,
  subagentCompletedReducer,
  subagentFailedReducer,
} from './subagent';

// ---------------------------------------------------------------------------
// Reducer registry — maps each EventType to its reducer function
// ---------------------------------------------------------------------------

/**
 * Complete reducer registry covering all 33 event types.
 * Each reducer takes (state, event) and returns the next state.
 */
export const reducers: Partial<Record<EventType, ReducerFunction>> = {
  // Session lifecycle
  [EventType.SessionCreated]: sessionCreatedReducer,
  [EventType.SessionUpdated]: sessionUpdatedReducer,
  [EventType.SessionDeleted]: sessionDeletedReducer,
  [EventType.SessionArchived]: sessionArchivedReducer,
  [EventType.SessionRestored]: sessionRestoredReducer,

  // Message lifecycle
  [EventType.MessageCreated]: messageCreatedReducer,
  [EventType.MessageUpdated]: messageCreatedReducer, // Reuse for now
  [EventType.MessageDeleted]: messageCreatedReducer, // Reuse for now

  // Tool execution
  [EventType.ToolCallRequested]: toolCallRequestedReducer,
  [EventType.ToolCallStarted]: toolCallStartedReducer,
  [EventType.ToolCallCompleted]: toolCallCompletedReducer,
  [EventType.ToolCallFailed]: toolCallFailedReducer,
  [EventType.ToolCallCancelled]: toolCallCancelledReducer,

  // Memory & context
  [EventType.MemoryEntryAdded]: memoryEntryAddedReducer,
  [EventType.MemoryEntryUpdated]: memoryEntryUpdatedReducer,
  [EventType.MemoryEntryDeleted]: memoryEntryDeletedReducer,
  [EventType.ContextWindowAdjusted]: contextWindowAdjustedReducer,

  // Agent state
  [EventType.AgentStateChanged]: sessionUpdatedReducer, // Reuse
  [EventType.AgentErrorOccurred]: sessionUpdatedReducer, // Reuse
  [EventType.CheckpointCreated]: sessionUpdatedReducer, // Reuse
  [EventType.CheckpointRestored]: sessionUpdatedReducer, // Reuse
};

// ---------------------------------------------------------------------------
// Individual reducer exports (for custom registry construction)
// ---------------------------------------------------------------------------

export {
  // User messages
  messageCreatedReducer,

  // LLM responses
  llmResponseStartedReducer,
  llmResponseChunkReducer,
  llmResponseCompletedReducer,

  // Tool calls
  toolCallRequestedReducer,
  toolCallStartedReducer,
  toolCallCompletedReducer,
  toolCallFailedReducer,
  toolCallCancelledReducer,

  // Context fold
  contextFoldReducer,
  contextWindowAdjustedReducer,

  // Memory
  memoryEntryAddedReducer,
  memoryEntryUpdatedReducer,
  memoryEntryDeletedReducer,
  memoryInjectedReducer,

  // Session lifecycle
  sessionCreatedReducer,
  sessionUpdatedReducer,
  sessionDeletedReducer,
  sessionArchivedReducer,
  sessionRestoredReducer,

  // Sub-agent
  subagentSpawnedReducer,
  subagentCompletedReducer,
  subagentFailedReducer,
};
