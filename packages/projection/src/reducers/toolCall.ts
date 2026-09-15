/**
 * @oa/projection — Tool Call Reducer
 *
 * Handles tool call lifecycle events: requested, started, completed, failed,
 * and cancelled. Tracks active/completed tool calls and updates counts.
 */

import type { AgentEvent, EventType } from '@oa/event-store';
import type { ProjectionState, ActiveToolCallInfo, CompletedToolCallInfo } from '../types';
import { cloneProjectionState } from '../state-builder';

export interface ToolCallRequestedPayload {
  callId: string;
  toolName: string;
  arguments: unknown;
  turnId: string;
}

export interface ToolCallStartedPayload {
  callId: string;
  toolName: string;
  startedAt: number;
}

export interface ToolCallCompletedPayload {
  callId: string;
  toolName: string;
  result: unknown;
  durationMs: number;
  filePaths?: string[];
}

export interface ToolCallFailedPayload {
  callId: string;
  toolName: string;
  error: string;
  durationMs: number;
}

export interface ToolCallCancelledPayload {
  callId: string;
  toolName: string;
  reason: string;
}

/**
 * Reducer for tool call requested events. Registers the tool call in the
 * active list and increments counters.
 */
export function toolCallRequestedReducer(
  state: ProjectionState,
  event: AgentEvent<ToolCallRequestedPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;

  // Add to active tool calls
  const activeCall: ActiveToolCallInfo = {
    callId: payload.callId,
    toolName: payload.toolName,
    startedAt: event.timestamp,
    arguments: payload.arguments,
  };
  next.activeToolCalls.push(activeCall);
  next.toolCallCounts.total++;
  next.toolCallCounts.running++;

  // Transition to tool-calling phase
  if (next.phase === 'executing' || next.phase === 'planning') {
    next.phase = 'calling_tools';
  }

  return next;
}

/**
 * Reducer for tool call started events. Updates the start timestamp.
 */
export function toolCallStartedReducer(
  state: ProjectionState,
  event: AgentEvent<ToolCallStartedPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;

  // Update the start time on the existing active call
  const call = next.activeToolCalls.find((c) => c.callId === payload.callId);
  if (call) {
    call.startedAt = payload.startedAt;
  }

  return next;
}

/**
 * Reducer for tool call completion. Moves the call from active to completed,
 * updates file tracking, and adjusts counters.
 */
export function toolCallCompletedReducer(
  state: ProjectionState,
  event: AgentEvent<ToolCallCompletedPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;

  // Remove from active
  const idx = next.activeToolCalls.findIndex((c) => c.callId === payload.callId);
  if (idx >= 0) {
    next.activeToolCalls.splice(idx, 1);
    next.toolCallCounts.running--;
    next.toolCallCounts.completed++;
  }

  // Add to completed
  const completedCall: CompletedToolCallInfo = {
    callId: payload.callId,
    toolName: payload.toolName,
    status: 'completed',
    durationMs: payload.durationMs,
    completedAt: event.timestamp,
  };
  next.completedToolCalls.push(completedCall);

  // Track modified files
  if (payload.filePaths) {
    for (const fp of payload.filePaths) {
      next.addModifiedFile(fp);
    }
  }

  // If no more active tool calls, transition back to executing
  if (next.toolCallCounts.running === 0 && next.phase === 'calling_tools') {
    next.phase = 'executing';
  }

  return next;
}

/**
 * Reducer for tool call failure. Moves the call to completed with failed
 * status and increments error count.
 */
export function toolCallFailedReducer(
  state: ProjectionState,
  event: AgentEvent<ToolCallFailedPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;

  // Remove from active
  const idx = next.activeToolCalls.findIndex((c) => c.callId === payload.callId);
  if (idx >= 0) {
    next.activeToolCalls.splice(idx, 1);
    next.toolCallCounts.running--;
    next.toolCallCounts.failed++;
  }

  // Add to completed with failed status
  const completedCall: CompletedToolCallInfo = {
    callId: payload.callId,
    toolName: payload.toolName,
    status: 'failed',
    durationMs: payload.durationMs,
    completedAt: event.timestamp,
  };
  next.completedToolCalls.push(completedCall);

  // Track error
  next.errorCount++;
  next.lastError = `Tool "${payload.toolName}" failed: ${payload.error}`;

  // If no more active tool calls, transition back
  if (next.toolCallCounts.running === 0 && next.phase === 'calling_tools') {
    next.phase = 'executing';
  }

  return next;
}

/**
 * Reducer for tool call cancellation. Moves the call to completed with
 * cancelled status.
 */
export function toolCallCancelledReducer(
  state: ProjectionState,
  event: AgentEvent<ToolCallCancelledPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;

  // Remove from active
  const idx = next.activeToolCalls.findIndex((c) => c.callId === payload.callId);
  if (idx >= 0) {
    next.activeToolCalls.splice(idx, 1);
    next.toolCallCounts.running--;
    next.toolCallCounts.cancelled++;
  }

  // Add to completed with cancelled status
  const completedCall: CompletedToolCallInfo = {
    callId: payload.callId,
    toolName: payload.toolName,
    status: 'cancelled',
    durationMs: 0,
    completedAt: event.timestamp,
  };
  next.completedToolCalls.push(completedCall);

  // If no more active tool calls, transition back
  if (next.toolCallCounts.running === 0 && next.phase === 'calling_tools') {
    next.phase = 'executing';
  }

  return next;
}
