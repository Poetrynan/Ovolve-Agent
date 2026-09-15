/**
 * @oa/compaction — Layer 3: Hard Truncation (Last Resort)
 *
 * The most aggressive compaction layer. Simply drops the oldest messages
 * beyond a keep window. This is the last resort when all other layers
 * have failed to achieve the target reduction.
 *
 * Strategy:
 * - Keep only the most recent N messages (keepRecentCount + buffer).
 * - Insert a truncation notice so the model knows context was dropped.
 * - Never fails — always achieves reduction if there are messages to drop.
 */

import type { CompactionMessage, FoldConfig, FoldResult } from '../types';
import { FoldLayer } from '../types';

// ---------------------------------------------------------------------------
// Truncation implementation
// ---------------------------------------------------------------------------

export interface TruncationResult {
  /** Messages after truncation. */
  messages: CompactionMessage[];
  /** Number of messages dropped. */
  droppedCount: number;
  /** Tokens saved. */
  tokensSaved: number;
  /** The seq range of dropped messages (for audit). */
  droppedRange: { start: number; end: number };
}

/**
 * Perform hard truncation — drop oldest messages beyond the keep window.
 *
 * This is the most aggressive fold. It always succeeds in reducing context
 * but loses information. A truncation notice is inserted to inform the
 * model that context was dropped.
 *
 * @param messages The full message list.
 * @param config The fold configuration.
 */
export function truncateFold(
  messages: CompactionMessage[],
  config: FoldConfig
): TruncationResult {
  // Calculate how many messages to keep
  // Use a tighter window than keepRecentCount for truncation
  const keepCount = Math.max(2, Math.min(config.keepRecentCount, Math.floor(messages.length * 0.4)));

  if (messages.length <= keepCount) {
    return {
      messages,
      droppedCount: 0,
      tokensSaved: 0,
      droppedRange: { start: 0, end: 0 },
    };
  }

  const droppedCount = messages.length - keepCount;
  const droppedMessages = messages.slice(0, droppedCount);
  const keptMessages = messages.slice(droppedCount);

  // Calculate tokens saved
  const tokensBefore = messages.reduce((s, m) => s + m.tokenCount, 0);
  const tokensAfter = keptMessages.reduce((s, m) => s + m.tokenCount, 0);
  const tokensSaved = tokensBefore - tokensAfter;

  // Create truncation notice
  const truncationNotice: CompactionMessage = {
    id: `truncation_notice_${Date.now()}`,
    role: 'system',
    content: `[CONTEXT TRUNCATED — ${droppedCount} older messages were dropped to manage context window. ` +
      `The conversation continues from this point. If earlier context is needed, ask the user to re-explain.]`,
    tokenCount: 40,
    protected: true,
    originalIndex: 0,
    timestamp: Date.now(),
  };

  return {
    messages: [truncationNotice, ...keptMessages],
    droppedCount,
    tokensSaved,
    droppedRange: {
      start: droppedMessages[0]?.originalIndex ?? 0,
      end: droppedMessages[droppedMessages.length - 1]?.originalIndex ?? 0,
    },
  };
}

/**
 * Create a FoldResult from a truncation operation.
 */
export function createTruncationResult(
  sessionId: string,
  messagesBefore: CompactionMessage[],
  result: TruncationResult,
  durationMs: number,
  targetMet: boolean
): FoldResult {
  return {
    layer: FoldLayer.TRUNCATION,
    layerName: 'TRUNCATION',
    messagesBefore: messagesBefore.length,
    messagesAfter: result.messages.length,
    tokensBefore: messagesBefore.reduce((s, m) => s + m.tokenCount, 0),
    tokensAfter: result.messages.reduce((s, m) => s + m.tokenCount, 0),
    targetMet,
    durationMs,
    qualityPassed: true, // Truncation is always "safe" — no summary to audit
    timestamp: Date.now(),
    sessionId,
  };
}

/**
 * Calculate the effective keep count for truncation.
 */
export function calculateTruncationKeepCount(
  totalMessages: number,
  keepRecentCount: number
): number {
  return Math.max(2, Math.min(keepRecentCount, Math.floor(totalMessages * 0.4)));
}
