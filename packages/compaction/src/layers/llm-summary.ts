/**
 * @oa/compaction — Layer 1: LLM-Based Structured Summary
 *
 * Uses an LLM to produce a structured summary of older messages.
 * This is the most intelligent compaction layer, preserving key facts,
 * decisions, and context in a condensed format.
 *
 * The summary follows a structured template to ensure consistency:
 * - Key decisions made
 * - Important facts/identifiers established
 * - Current task state
 * - Open questions or pending items
 */

import type { LlmMessage } from '@oa/llm';
import type { CompactionMessage, FoldConfig, FoldResult } from '../types';
import { FoldLayer } from '../types';

// ---------------------------------------------------------------------------
// Summary prompt template
// ---------------------------------------------------------------------------

const DEFAULT_SUMMARY_PROMPT = `You are a context compaction assistant. Your task is to create a structured summary of the following conversation messages.

The summary MUST follow this exact format:

## Key Decisions
[List any decisions made, chosen approaches, or agreed-upon solutions]

## Important Facts & Identifiers
[List all critical identifiers: function names, file paths, URLs, error codes, versions, etc.]

## Current Task State
[Describe what is currently being worked on and progress so far]

## Open Items
[List any pending tasks, unresolved questions, or next steps]

## Context for Continuation
[Any other information needed to continue the conversation coherently]

CRITICAL RULES:
- Preserve ALL identifiers (function names, paths, URLs, error codes) exactly as written
- Be concise but complete — every fact needed to continue must be retained
- Do NOT omit technical details that future messages might reference
- Output in markdown format as shown above`;

// ---------------------------------------------------------------------------
// LLM Summary implementation
// ---------------------------------------------------------------------------

export interface LlmSummaryResult {
  /** Messages after summary fold. */
  messages: CompactionMessage[];
  /** The generated summary text. */
  summary: string;
  /** Number of original messages summarized. */
  summarizedCount: number;
  /** Tokens saved. */
  tokensSaved: number;
  /** Duration of the LLM call. */
  llmDurationMs: number;
}

/**
 * Perform LLM-based structured summary fold.
 *
 * Takes older messages, sends them to an LLM for summarization,
 * and replaces them with a single summary message.
 *
 * @param messages The full message list.
 * @param config The fold configuration.
 * @param customPrompt Optional custom summary prompt.
 */
export async function llmSummaryFold(
  messages: CompactionMessage[],
  config: FoldConfig,
  customPrompt?: string
): Promise<LlmSummaryResult> {
  const startTime = Date.now();

  if (!config.llmClient) {
    throw new Error('LLM client required for LLM_SUMMARY layer');
  }

  const keepStart = Math.max(0, messages.length - config.keepRecentCount);
  const toSummarize = messages.slice(0, keepStart);
  const toKeep = messages.slice(keepStart);

  if (toSummarize.length === 0) {
    return {
      messages,
      summary: '',
      summarizedCount: 0,
      tokensSaved: 0,
      llmDurationMs: 0,
    };
  }

  // Build the summary request
  const summaryText = toSummarize
    .map((m, i) => `[${i + 1}] ${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');

  const llmMessages: LlmMessage[] = [
    {
      role: 'system',
      content: customPrompt ?? DEFAULT_SUMMARY_PROMPT,
    } as LlmMessage,
    {
      role: 'user',
      content: `Summarize the following ${toSummarize.length} messages:\n\n${summaryText}`,
    } as LlmMessage,
  ];

  // Call LLM for summary
  const llmStartTime = Date.now();
  const response = await config.llmClient.chat({
    model: config.summaryModel ?? 'gpt-4o-mini',
    messages: llmMessages,
    max_tokens: 1024,
    temperature: 0.3,
  });
  const llmDurationMs = Date.now() - llmStartTime;

  const summary = response.content;

  // Create summary message
  const summaryMessage: CompactionMessage = {
    id: `fold_summary_${Date.now()}`,
    role: 'system',
    content: `[COMPACTED SUMMARY]\n\n${summary}`,
    tokenCount: estimateTokenCount(summary),
    protected: true,
    originalIndex: 0,
    timestamp: Date.now(),
  };

  const resultMessages = [summaryMessage, ...toKeep];
  const tokensBefore = messages.reduce((s, m) => s + m.tokenCount, 0);
  const tokensAfter = resultMessages.reduce((s, m) => s + m.tokenCount, 0);

  return {
    messages: resultMessages,
    summary,
    summarizedCount: toSummarize.length,
    tokensSaved: Math.max(0, tokensBefore - tokensAfter),
    llmDurationMs,
  };
}

/**
 * Create a FoldResult from an LLM summary operation.
 */
export function createLlmSummaryResult(
  sessionId: string,
  messagesBefore: CompactionMessage[],
  result: LlmSummaryResult,
  targetMet: boolean,
  qualityPassed: boolean,
  qualityDetails?: FoldResult['qualityDetails']
): FoldResult {
  return {
    layer: FoldLayer.LLM_SUMMARY,
    layerName: 'LLM_SUMMARY',
    messagesBefore: messagesBefore.length,
    messagesAfter: result.messages.length,
    tokensBefore: messagesBefore.reduce((s, m) => s + m.tokenCount, 0),
    tokensAfter: result.messages.reduce((s, m) => s + m.tokenCount, 0),
    targetMet,
    durationMs: result.llmDurationMs,
    summary: result.summary,
    qualityPassed,
    qualityDetails,
    timestamp: Date.now(),
    sessionId,
  };
}

/**
 * Estimate token count from text (rough: ~4 chars per token).
 */
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
