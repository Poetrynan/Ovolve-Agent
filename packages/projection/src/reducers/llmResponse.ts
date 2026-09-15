/**
 * @oa/projection — LLM Response Reducer
 *
 * Handles LLM response events: streaming start, chunk updates, and completion.
 * Tracks token usage, partial/final response text, and streaming state.
 */

import type { AgentEvent } from '@oa/event-store';
import type { ProjectionState, ProjectionTokenUsage } from '../types';
import { cloneProjectionState } from '../state-builder';

export interface LlmResponseStartedPayload {
  turnId: string;
  model: string;
  inputTokens: number;
}

export interface LlmResponseChunkPayload {
  turnId: string;
  delta: string;
  cumulativeResponse: string;
  outputTokens: number;
}

export interface LlmResponseCompletedPayload {
  turnId: string;
  fullResponse: string;
  outputTokens: number;
  totalTokens: number;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error';
  durationMs: number;
}

/**
 * Reducer for LLM response start events. Initializes streaming state and
 * records input token count.
 */
export function llmResponseStartedReducer(
  state: ProjectionState,
  event: AgentEvent<LlmResponseStartedPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;
  next.isStreaming = true;
  next.phase = 'executing';
  next.lastAssistantMessage = '';

  // Record input tokens for the turn
  next.tokenUsage.turnInputTokens = payload.inputTokens;
  next.tokenUsage.totalInputTokens += payload.inputTokens;
  next.contextWindow.currentTokens += payload.inputTokens;

  return next;
}

/**
 * Reducer for LLM response chunk events (streaming). Accumulates partial
 * response text and updates token counts.
 */
export function llmResponseChunkReducer(
  state: ProjectionState,
  event: AgentEvent<LlmResponseChunkPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;
  next.isStreaming = true;

  // Update partial response
  next.lastAssistantMessage = truncate(payload.cumulativeResponse, 1000);

  // Update turn output tokens
  next.tokenUsage.turnOutputTokens = payload.outputTokens;
  next.contextWindow.currentTokens += payload.outputTokens;

  return next;
}

/**
 * Reducer for LLM response completion. Finalizes the response text, updates
 * total token usage, and transitions phase.
 */
export function llmResponseCompletedReducer(
  state: ProjectionState,
  event: AgentEvent<LlmResponseCompletedPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;
  next.isStreaming = false;
  next.messageCount++;

  // Store final response (truncated for display)
  next.lastAssistantMessage = truncate(payload.fullResponse, 1000);

  // Update token usage totals
  next.tokenUsage.turnOutputTokens = payload.outputTokens;
  next.tokenUsage.totalOutputTokens += payload.outputTokens;
  next.tokenUsage.totalTokens += payload.totalTokens;
  next.contextWindow.currentTokens += payload.outputTokens;

  // Transition phase based on finish reason
  switch (payload.finishReason) {
    case 'stop':
      next.phase = 'awaiting_user';
      next.awaitingUser = true;
      break;
    case 'tool_calls':
      next.phase = 'calling_tools';
      break;
    case 'length':
      next.phase = 'awaiting_user';
      break;
    case 'error':
      next.phase = 'failed';
      next.errorCount++;
      next.lastError = 'LLM response terminated with error';
      break;
  }

  return next;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}
