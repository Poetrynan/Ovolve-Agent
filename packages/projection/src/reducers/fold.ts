/**
 * @oa/projection — Context Fold Reducer
 *
 * Handles context window folding events. When the context window is full,
 * older messages are "folded" (summarized/compressed) to free up token space.
 * This reducer tracks fold operations and adjusts the context window state.
 */

import type { AgentEvent } from '@oa/event-store';
import type { ProjectionState } from '../types';
import { cloneProjectionState } from '../state-builder';

export interface ContextFoldPayload {
  /** Number of messages folded. */
  messagesFolded: number;
  /** Tokens freed by the fold. */
  tokensFreed: number;
  /** Tokens used for the fold summary. */
  summaryTokens: number;
  /** The fold summary text (truncated). */
  summary: string;
  /** Fold strategy used. */
  strategy: 'summarize' | 'truncate' | 'sliding_window';
}

/**
 * Reducer for context fold events. Adjusts the context window token count
 * and records the fold in session metadata.
 */
export function contextFoldReducer(
  state: ProjectionState,
  event: AgentEvent<ContextFoldPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;

  // Adjust context window: freed tokens minus summary tokens
  const netTokensFreed = payload.tokensFreed - payload.summaryTokens;
  next.contextWindow.currentTokens = Math.max(
    0,
    next.contextWindow.currentTokens - netTokensFreed
  );

  // Track fold count in metadata
  const foldCount = (next.metadata['foldCount'] as number) ?? 0;
  next.metadata['foldCount'] = foldCount + 1;
  next.metadata['lastFoldAt'] = event.timestamp;
  next.metadata['lastFoldStrategy'] = payload.strategy;
  next.metadata['totalTokensFolded'] =
    ((next.metadata['totalTokensFolded'] as number) ?? 0) + payload.tokensFreed;

  return next;
}

/**
 * Reducer for context window adjustment events (manual or automatic).
 */
export interface ContextWindowAdjustedPayload {
  oldMaxTokens: number;
  newMaxTokens: number;
  reason: 'manual' | 'auto_scale' | 'model_change';
}

export function contextWindowAdjustedReducer(
  state: ProjectionState,
  event: AgentEvent<ContextWindowAdjustedPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;

  // Update context window max
  next.contextWindow.maxTokens = payload.newMaxTokens;

  // If current tokens exceed new max, clamp
  if (next.contextWindow.currentTokens > payload.newMaxTokens) {
    next.contextWindow.currentTokens = payload.newMaxTokens;
  }

  // Track adjustment in metadata
  next.metadata['contextWindowAdjustments'] =
    ((next.metadata['contextWindowAdjustments'] as number) ?? 0) + 1;
  next.metadata['lastContextAdjustment'] = {
    from: payload.oldMaxTokens,
    to: payload.newMaxTokens,
    reason: payload.reason,
    at: event.timestamp,
  };

  return next;
}
