/**
 * @oa/compaction — Layer 2: Heuristic-Based Extraction
 *
 * Rule-based extraction that identifies and preserves important messages
 * while dropping less important ones. Does not require an LLM call.
 *
 * Heuristics used:
 * - Preserve user messages (they contain intent and constraints).
 * - Preserve assistant messages with tool calls (they show actions taken).
 * - Preserve messages containing identifiers (paths, URLs, error codes).
 * - Drop verbose assistant explanations that don't add new information.
 * - Always preserve the most recent N messages.
 */

import type { CompactionMessage, FoldConfig, FoldResult } from '../types';
import { FoldLayer } from '../types';

// ---------------------------------------------------------------------------
// Heuristic scoring
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate a message contains important information.
 */
const IMPORTANCE_PATTERNS = [
  /https?:\/\//i,                  // URLs
  /[\w\-./\\]+\.\w{2,4}/i,        // File paths
  /\b0x[0-9a-fA-F]+\b/i,          // Hex values
  /\b[A-Z]{2,}_ERROR\b/i,         // Error codes
  /\b(?:error|fail|exception|critical|warn)/i, // Error keywords
  /\b(?:decided|chose|will use|approach|plan):/i, // Decisions
  /\b(?:important|note|warning|caution|remember)/i, // Emphasis
  /`[^`]+`/i,                      // Inline code
  /```/i,                          // Code blocks
];

/**
 * Score a message's importance for retention.
 * Higher score = more important = more likely to keep.
 */
function scoreMessageImportance(msg: CompactionMessage): number {
  let score = 0;
  const content = msg.content;

  // User messages are important (they carry intent)
  if (msg.role === 'user') {
    score += 5;
  }

  // Messages with tool calls show actions taken
  if (msg.toolCalls && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
    score += 3;
  }

  // System messages with instructions
  if (msg.role === 'system' && !content.startsWith('[COMPACTED')) {
    score += 2;
  }

  // Check for important patterns
  for (const pattern of IMPORTANCE_PATTERNS) {
    if (pattern.test(content)) {
      score += 2;
    }
  }

  // Longer messages might have more information (but cap it)
  score += Math.min(3, content.length / 500);

  // Penalize very short assistant messages (likely acknowledgments)
  if (msg.role === 'assistant' && content.length < 50) {
    score -= 2;
  }

  // Penalize repeated content (similar to previous messages)
  if (content.length > 200) {
    const sentences = content.split(/[.!?]+/);
    const uniqueSentences = new Set(sentences.map((s) => s.trim().toLowerCase()));
    const repetitionRatio = uniqueSentences.size / Math.max(sentences.length, 1);
    if (repetitionRatio < 0.5) {
      score -= 2; // Penalize repetitive content
    }
  }

  return score;
}

// ---------------------------------------------------------------------------
// Heuristic fold implementation
// ---------------------------------------------------------------------------

export interface HeuristicResult {
  /** Messages after heuristic fold. */
  messages: CompactionMessage[];
  /** Number of messages removed. */
  removedCount: number;
  /** Tokens saved. */
  tokensSaved: number;
  /** Scores for each message (for debugging). */
  scores: Map<string, number>;
}

/**
 * Perform rule-based heuristic extraction fold.
 *
 * Scores each candidate message by importance and retains the top-scoring
 * ones within a token budget. Always preserves first N and recent messages.
 *
 * Paper: StreamingLLM - Attention Sink phenomenon (LLM attention is highest
 * at start and end, forming a U-shaped curve).
 *
 * @param messages The full message list.
 * @param config The fold configuration.
 */
export function heuristicFold(
  messages: CompactionMessage[],
  config: FoldConfig
): HeuristicResult {
  if (messages.length <= config.keepRecentCount + (config.keepFirstCount ?? 0)) {
    return { messages, removedCount: 0, tokensSaved: 0, scores: new Map() };
  }

  // Attention Sink: preserve first N messages (system prompt + initial context)
  const keepFirst = config.keepFirstCount ?? 0;
  const firstMessages = messages.slice(0, keepFirst);

  // Preserve recent N messages
  const keepStart = Math.max(keepFirst, messages.length - config.keepRecentCount);
  const candidates = messages.slice(keepFirst, keepStart);
  const recentMessages = messages.slice(keepStart);

  // Score each candidate
  const scored: { msg: CompactionMessage; score: number }[] = [];
  const scores = new Map<string, number>();

  for (const msg of candidates) {
    const score = scoreMessageImportance(msg);
    scored.push({ msg, score });
    scores.set(msg.id, score);
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Calculate token budget for retained messages (target minus what we keep)
  const keepTokens = recentMessages.reduce((s, m) => s + m.tokenCount, 0) +
                     firstMessages.reduce((s, m) => s + m.tokenCount, 0);
  const targetTokens = config.targetTokenCount;
  const budget = Math.max(500, targetTokens - keepTokens);

  // Select top-scoring messages within budget
  let usedTokens = 0;
  const selected: CompactionMessage[] = [];

  for (const { msg, score } of scored) {
    // Always keep messages with score >= 7 (very important)
    if (score >= 7) {
      selected.push(msg);
      usedTokens += msg.tokenCount;
    } else if (usedTokens + msg.tokenCount <= budget) {
      selected.push(msg);
      usedTokens += msg.tokenCount;
    }
    // Otherwise drop the message
  }

  // Sort selected back to chronological order
  selected.sort((a, b) => a.originalIndex - b.originalIndex);

  // Reconstruct: first messages (attention sink) + selected + recent messages
  const resultMessages = [...firstMessages, ...selected, ...recentMessages];
  const tokensBefore = messages.reduce((s, m) => s + m.tokenCount, 0);
  const tokensAfter = resultMessages.reduce((s, m) => s + m.tokenCount, 0);

  return {
    messages: resultMessages,
    removedCount: candidates.length - selected.length,
    tokensSaved: Math.max(0, tokensBefore - tokensAfter),
    scores,
  };
}

/**
 * Create a FoldResult from a heuristic fold operation.
 */
export function createHeuristicResult(
  sessionId: string,
  messagesBefore: CompactionMessage[],
  result: HeuristicResult,
  durationMs: number,
  targetMet: boolean,
  qualityPassed: boolean,
  qualityDetails?: FoldResult['qualityDetails']
): FoldResult {
  return {
    layer: FoldLayer.HEURISTIC,
    layerName: 'HEURISTIC',
    messagesBefore: messagesBefore.length,
    messagesAfter: result.messages.length,
    tokensBefore: messagesBefore.reduce((s, m) => s + m.tokenCount, 0),
    tokensAfter: result.messages.reduce((s, m) => s + m.tokenCount, 0),
    targetMet,
    durationMs,
    qualityPassed,
    qualityDetails,
    timestamp: Date.now(),
    sessionId,
  };
}
