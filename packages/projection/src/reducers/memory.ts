/**
 * @oa/projection — Memory Injection Reducer
 *
 * Handles memory entry events: added, updated, deleted, and injected into
 * session context. Tracks which memory entries are associated with each
 * session and how many have been injected.
 */

import type { AgentEvent } from '@oa/event-store';
import type { ProjectionState } from '../types';
import { cloneProjectionState } from '../state-builder';

export interface MemoryEntryAddedPayload {
  entryId: string;
  content: string;
  importance: number;
  tags: string[];
  source: 'user' | 'auto' | 'extracted';
}

export interface MemoryEntryUpdatedPayload {
  entryId: string;
  content?: string;
  importance?: number;
  tags?: string[];
}

export interface MemoryEntryDeletedPayload {
  entryId: string;
}

export interface MemoryInjectedPayload {
  entryIds: string[];
  injectionPoint: 'system_prompt' | 'context_window' | 'tool_result';
  tokensUsed: number;
}

/**
 * Reducer for memory entry added events. Adds the entry ID to the session's
 * memory list and updates the metadata.
 */
export function memoryEntryAddedReducer(
  state: ProjectionState,
  event: AgentEvent<MemoryEntryAddedPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;

  // Add to memory entry list if not already present
  if (!next.memoryEntryIds.includes(payload.entryId)) {
    next.memoryEntryIds.push(payload.entryId);
  }

  // Track in metadata
  const memoryAddedCount = (next.metadata['memoryAddedCount'] as number) ?? 0;
  next.metadata['memoryAddedCount'] = memoryAddedCount + 1;

  return next;
}

/**
 * Reducer for memory entry updated events. The entry is already in the list;
 * we just update the event tracking.
 */
export function memoryEntryUpdatedReducer(
  state: ProjectionState,
  event: AgentEvent<MemoryEntryUpdatedPayload>
): ProjectionState {
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;

  // Track update count
  const memoryUpdatedCount = (next.metadata['memoryUpdatedCount'] as number) ?? 0;
  next.metadata['memoryUpdatedCount'] = memoryUpdatedCount + 1;

  return next;
}

/**
 * Reducer for memory entry deleted events. Removes the entry ID from the
 * session's memory list.
 */
export function memoryEntryDeletedReducer(
  state: ProjectionState,
  event: AgentEvent<MemoryEntryDeletedPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;

  // Remove from memory entry list
  const idx = next.memoryEntryIds.indexOf(payload.entryId);
  if (idx >= 0) {
    next.memoryEntryIds.splice(idx, 1);
  }

  // Track deletion count
  const memoryDeletedCount = (next.metadata['memoryDeletedCount'] as number) ?? 0;
  next.metadata['memoryDeletedCount'] = memoryDeletedCount + 1;

  return next;
}

/**
 * Reducer for memory injection events. Records that memory entries were
 * injected into the session context and updates the token count.
 */
export function memoryInjectedReducer(
  state: ProjectionState,
  event: AgentEvent<MemoryInjectedPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;

  // Increment injected count
  next.injectedMemoryCount += payload.entryIds.length;

  // Update context window tokens
  next.contextWindow.currentTokens += payload.tokensUsed;

  // Track in metadata
  const injectionCount = (next.metadata['memoryInjectionCount'] as number) ?? 0;
  next.metadata['memoryInjectionCount'] = injectionCount + 1;
  next.metadata['lastMemoryInjection'] = {
    entryCount: payload.entryIds.length,
    injectionPoint: payload.injectionPoint,
    tokensUsed: payload.tokensUsed,
    at: event.timestamp,
  };

  return next;
}
