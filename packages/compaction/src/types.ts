/**
 * @oa/compaction — Core Types
 *
 * 4-layer context compaction engine types for OvolveAgent.
 * Implements progressive degradation: microfold → LLM summary → heuristic → truncation.
 *
 * Context compaction and management patterns for long sessions.
 */

import type { LlmMessage } from '@oa/llm';

// ---------------------------------------------------------------------------
// Fold layers — ordered by cost (cheapest first)
// ---------------------------------------------------------------------------

/**
 * The four compaction layers, ordered by cost and aggressiveness.
 *
 * - MICROFOLD (0): Zero-cost — clears stale tool results from context.
 * - LLM_SUMMARY (1): LLM-based structured summary of older messages.
 * - HEURISTIC (2): Rule-based extraction of key information.
 * - TRUNCATION (3): Hard truncation — last resort, drops oldest messages.
 */
export enum FoldLayer {
  MICROFOLD = 0,
  LLM_SUMMARY = 1,
  HEURISTIC = 2,
  TRUNCATION = 3,
}

/**
 * Result of a single fold operation.
 */
export interface FoldResult {
  /** The layer that was applied. */
  layer: FoldLayer;
  /** Human-readable name of the layer. */
  layerName: string;
  /** Messages before folding. */
  messagesBefore: number;
  /** Messages after folding. */
  messagesAfter: number;
  /** Estimated tokens before folding. */
  tokensBefore: number;
  /** Estimated tokens after folding. */
  tokensAfter: number;
  /** Whether the fold achieved the target reduction. */
  targetMet: boolean;
  /** Duration of the fold operation in milliseconds. */
  durationMs: number;
  /** Optional summary text (for LLM_SUMMARY layer). */
  summary?: string;
  /** Whether quality audit passed. */
  qualityPassed: boolean;
  /** Quality audit details. */
  qualityDetails?: QualityAuditResult;
  /** Timestamp of the fold. */
  timestamp: number;
  /** Session ID the fold was applied to. */
  sessionId: string;
}

/**
 * Configuration for the compaction engine.
 */
export interface FoldConfig {
  /**
   * Token threshold that triggers auto-folding.
   * When estimated tokens exceed this value, auto-fold is attempted.
   * @default 6000
   */
  tokenThreshold: number;
  /**
   * Target token count after folding.
   * The engine tries to reduce tokens to this level.
   * @default 3000
   */
  targetTokenCount: number;
  /**
   * Minimum messages required before any fold is attempted.
   * Prevents folding very short conversations.
   * @default 6
   */
  minMessages: number;
  /**
   * Number of recent messages to always preserve regardless of folding.
   * @default 4
   */
  keepRecentCount: number;
  /**
   * Number of first messages to preserve (Attention Sink optimization).
   * Paper: StreamingLLM - LLM attention is highest at start and end (U-curve).
   * @default 2
   */
  keepFirstCount: number;
  /**
   * Maximum number of messages to process in a single LLM summary call.
   * @default 20
   */
  maxSummaryMessages: number;
  /**
   * Custom token counter function. Falls back to ~4 chars per token.
   */
  countTokens?: (text: string) => number;
  /**
   * LLM client for summary generation. Required for LLM_SUMMARY layer.
   */
  llmClient?: import('@oa/llm').LlmClient;
  /**
   * Model to use for summarization.
   * @default 'gpt-4o-mini'
   */
  summaryModel?: string;
  /**
   * Whether to run quality audit after folding.
   * @default true
   */
  enableQualityAudit: boolean;
  /**
   * Minimum identifier retention ratio (0-1) for quality audit.
   * @default 0.3 (30%)
   */
  minIdentifierRetention: number;
  /**
   * Whether auto-folding is enabled.
   * @default true
   */
  autoFoldEnabled: boolean;
  /**
   * Cooldown in milliseconds between auto-folds.
   * @default 15000 (15 seconds)
   */
  cooldownMs: number;
  /**
   * Maximum number of consecutive folds before escalating to next layer.
   * @default 5
   */
  maxConsecutiveFolds: number;
  /**
   * Whether to emit events for audit trail.
   * @default true
   */
  emitEvents: boolean;
}

/**
 * Options for a manual fold operation.
 */
export interface FoldOptions {
  /** Force a specific layer (otherwise auto-selected). */
  forceLayer?: FoldLayer;
  /** Override the target token count. */
  targetTokens?: number;
  /** Override keep recent count. */
  keepRecent?: number;
  /** Skip quality audit. */
  skipQualityAudit?: boolean;
  /** Custom summary prompt. */
  summaryPrompt?: string;
}

/**
 * Guard state for anti-loop protection.
 */
export interface FoldGuard {
  /** Timestamp of the last auto-fold. */
  lastFoldTimestamp: number;
  /** Number of consecutive folds at the current layer. */
  consecutiveCount: number;
  /** The layer at which consecutive folds are counted. */
  consecutiveLayer: FoldLayer;
  /** Hash of content at last fold (for incremental check). */
  lastContentHash: string;
  /** Total folds performed in this session. */
  totalFolds: number;
  /** Total tokens saved across all folds. */
  totalTokensSaved: number;
}

/**
 * Statistics for folding operations on a session.
 */
export interface FoldStats {
  sessionId: string;
  totalFolds: number;
  foldsByLayer: Record<FoldLayer, number>;
  totalTokensBefore: number;
  totalTokensAfter: number;
  totalTokensSaved: number;
  averageReductionPercent: number;
  lastFoldAt?: number;
  qualityAuditPassRate: number;
  guard: FoldGuard;
}

/**
 * Quality audit result.
 */
export interface QualityAuditResult {
  /** Whether the audit passed. */
  passed: boolean;
  /** Ratio of identifiers retained (0-1). */
  identifierRetention: number;
  /** Identifiers found in original. */
  originalIdentifiers: string[];
  /** Identifiers preserved in folded result. */
  preservedIdentifiers: string[];
  /** Identifiers that were lost. */
  lostIdentifiers: string[];
  /** Overall quality score (0-1). */
  qualityScore: number;
  /** Human-readable audit message. */
  message: string;
}

/**
 * Event payload emitted when a fold occurs.
 */
export interface FoldEvent {
  type: 'compaction:fold';
  sessionId: string;
  timestamp: number;
  result: FoldResult;
}

/**
 * Event payload emitted when a fold is skipped.
 */
export interface FoldSkippedEvent {
  type: 'compaction:fold_skipped';
  sessionId: string;
  timestamp: number;
  reason: string;
  guard: FoldGuard;
}

/**
 * Event payload for quality audit failure.
 */
export interface QualityAuditEvent {
  type: 'compaction:quality_audit';
  sessionId: string;
  timestamp: number;
  result: QualityAuditResult;
  foldResult: FoldResult;
}

/**
 * A message in the compaction context — normalized from LlmMessage.
 */
export interface CompactionMessage {
  /** Unique message identifier. */
  id: string;
  /** Message role. */
  role: LlmMessage['role'];
  /** Text content. */
  content: string;
  /** Tool calls if present. */
  toolCalls?: LlmMessage extends { tool_calls: infer T } ? T : never;
  /** Tool call ID (for tool role messages). */
  toolCallId?: string;
  /** Estimated token count. */
  tokenCount: number;
  /** Whether this message is protected from folding. */
  protected: boolean;
  /** Original index in the message array. */
  originalIndex: number;
  /** Timestamp if available. */
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

export const DEFAULT_FOLD_CONFIG: FoldConfig = {
  tokenThreshold: 6000,
  targetTokenCount: 3000,
  minMessages: 6,
  keepRecentCount: 4,
  keepFirstCount: 2,
  maxSummaryMessages: 20,
  summaryModel: 'gpt-4o-mini',
  enableQualityAudit: true,
  minIdentifierRetention: 0.3,
  autoFoldEnabled: true,
  cooldownMs: 15000,
  maxConsecutiveFolds: 5,
  emitEvents: true,
};
