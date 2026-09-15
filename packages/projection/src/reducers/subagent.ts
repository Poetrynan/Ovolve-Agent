/**
 * @oa/projection — Sub-Agent Reducer
 *
 * Handles sub-agent lifecycle events: spawned, completed, failed.
 * Tracks sub-agent sessions spawned from a parent session.
 */

import type { AgentEvent } from '@oa/event-store';
import type { ProjectionState } from '../types';
import { cloneProjectionState } from '../state-builder';

export interface SubagentSpawnedPayload {
  childSessionId: string;
  parentSessionId: string;
  taskDescription: string;
  model?: string;
}

export interface SubagentCompletedPayload {
  childSessionId: string;
  result: string;
  durationMs: number;
  tokensUsed: number;
}

export interface SubagentFailedPayload {
  childSessionId: string;
  error: string;
  durationMs: number;
}

/**
 * Reducer for sub-agent spawned events. Registers the child session ID
 * in the parent's subagent list.
 */
export function subagentSpawnedReducer(
  state: ProjectionState,
  event: AgentEvent<SubagentSpawnedPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;

  // Add child session ID
  if (!next.subagentSessionIds.includes(payload.childSessionId)) {
    next.subagentSessionIds.push(payload.childSessionId);
  }

  // Track in metadata
  const spawnedCount = (next.metadata['subagentSpawnedCount'] as number) ?? 0;
  next.metadata['subagentSpawnedCount'] = spawnedCount + 1;
  next.metadata['lastSubagentSpawned'] = {
    childSessionId: payload.childSessionId,
    taskDescription: payload.taskDescription,
    at: event.timestamp,
  };

  return next;
}

/**
 * Reducer for sub-agent completed events. Updates the sub-agent tracking
 * with completion info.
 */
export function subagentCompletedReducer(
  state: ProjectionState,
  event: AgentEvent<SubagentCompletedPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;

  // Track completion
  const completedCount = (next.metadata['subagentCompletedCount'] as number) ?? 0;
  next.metadata['subagentCompletedCount'] = completedCount + 1;
  next.metadata[`subagentResult_${payload.childSessionId}`] = {
    status: 'completed',
    result: payload.result.slice(0, 200),
    durationMs: payload.durationMs,
    tokensUsed: payload.tokensUsed,
    completedAt: event.timestamp,
  };

  // Update token usage
  next.tokenUsage.totalTokens += payload.tokensUsed;

  return next;
}

/**
 * Reducer for sub-agent failed events. Records the failure in metadata.
 */
export function subagentFailedReducer(
  state: ProjectionState,
  event: AgentEvent<SubagentFailedPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;

  // Track failure
  const failedCount = (next.metadata['subagentFailedCount'] as number) ?? 0;
  next.metadata['subagentFailedCount'] = failedCount + 1;
  next.metadata[`subagentResult_${payload.childSessionId}`] = {
    status: 'failed',
    error: payload.error,
    durationMs: payload.durationMs,
    failedAt: event.timestamp,
  };

  next.errorCount++;
  next.lastError = `Sub-agent ${payload.childSessionId} failed: ${payload.error}`;

  return next;
}
