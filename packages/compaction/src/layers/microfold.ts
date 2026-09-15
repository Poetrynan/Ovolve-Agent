/**
 * @oa/compaction — Layer 0: Microfold
 *
 * Zero-cost compaction layer that clears stale tool results from context.
 * Removes tool result messages that are no longer needed by subsequent
 * messages, reducing context size without any LLM calls.
 *
 * Strategy:
 * - Identify tool result messages that are older than the keep window.
 * - Remove tool results whose corresponding tool calls have been "consumed"
 *   (i.e., the assistant has already responded to them).
 * - Always preserve the most recent N messages.
 */

import type { CompactionMessage, FoldConfig, FoldResult } from '../types';
import { FoldLayer } from '../types';

// ---------------------------------------------------------------------------
// Microfold implementation
// ---------------------------------------------------------------------------

export interface MicrofoldResult {
  /** Messages after microfold. */
  messages: CompactionMessage[];
  /** Number of messages removed. */
  removedCount: number;
  /** Tokens saved. */
  tokensSaved: number;
}

/**
 * Perform zero-cost microfold on messages.
 *
 * Removes stale tool results that are no longer referenced by subsequent
 * conversation. This is always safe because once an assistant message
 * references a tool result, that result is part of the "consumed" history.
 *
 * @param messages The messages to microfold.
 * @param config The fold configuration.
 */
export function microfold(messages: CompactionMessage[], config: FoldConfig): MicrofoldResult {
  if (messages.length <= config.keepRecentCount) {
    return { messages, removedCount: 0, tokensSaved: 0 };
  }

  const keepStart = Math.max(0, messages.length - config.keepRecentCount);
  const candidates = messages.slice(0, keepStart);
  const toKeep = messages.slice(keepStart);

  // Track which tool call IDs have been "consumed" by an assistant message
  const consumedToolCallIds = new Set<string>();

  // Scan from newest to oldest to find consumed tool results
  for (let i = candidates.length - 1; i >= 0; i--) {
    const msg = candidates[i];

    // If this is an assistant message with tool_calls, mark those IDs
    if (msg.role === 'assistant' && msg.toolCalls) {
      const toolCalls = msg.toolCalls as Array<{ id?: string }>;
      for (const tc of toolCalls) {
        if (tc.id) {
          consumedToolCallIds.add(tc.id);
        }
      }
    }
  }

  // Filter: remove tool results that have been consumed
  const filtered: CompactionMessage[] = [];
  let removedCount = 0;
  let tokensSaved = 0;

  for (const msg of candidates) {
    const isStaleToolResult =
      msg.role === 'tool' &&
      msg.toolCallId !== undefined &&
      consumedToolCallIds.has(msg.toolCallId);

    if (isStaleToolResult) {
      removedCount++;
      tokensSaved += msg.tokenCount;
    } else {
      filtered.push(msg);
    }
  }

  return {
    messages: [...filtered, ...toKeep],
    removedCount,
    tokensSaved,
  };
}

/**
 * Create a FoldResult from a microfold operation.
 */
export function createMicrofoldResult(
  sessionId: string,
  messagesBefore: CompactionMessage[],
  result: MicrofoldResult,
  durationMs: number,
  targetMet: boolean
): FoldResult {
  return {
    layer: FoldLayer.MICROFOLD,
    layerName: 'MICROFOLD',
    messagesBefore: messagesBefore.length,
    messagesAfter: result.messages.length,
    tokensBefore: messagesBefore.reduce((s, m) => s + m.tokenCount, 0),
    tokensAfter: result.messages.reduce((s, m) => s + m.tokenCount, 0),
    targetMet,
    durationMs,
    qualityPassed: true,
    timestamp: Date.now(),
    sessionId,
  };
}

/**
 * Check if microfold would remove any messages.
 */
export function canMicrofold(messages: CompactionMessage[], keepRecentCount: number): boolean {
  if (messages.length <= keepRecentCount) return false;

  const candidates = messages.slice(0, messages.length - keepRecentCount);
  const consumedIds = new Set<string>();

  for (let i = candidates.length - 1; i >= 0; i--) {
    const msg = candidates[i];
    if (msg.role === 'assistant' && msg.toolCalls) {
      const toolCalls = msg.toolCalls as Array<{ id?: string }>;
      for (const tc of toolCalls) {
        if (tc.id) consumedIds.add(tc.id);
      }
    }
  }

  return candidates.some(
    (m) => m.role === 'tool' && m.toolCallId && consumedIds.has(m.toolCallId)
  );
}
