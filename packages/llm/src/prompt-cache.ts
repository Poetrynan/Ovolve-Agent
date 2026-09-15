/**
 * @oa/llm — Prompt Prefix Cache
 *
 * Splits messages into cacheable prefix and dynamic suffix.
 * The prefix (system prompt + early conversation) can be cached by LLM providers.
 *
 * Paper: OpenAI Prompt Caching, IC-Cache (2024)
 */

import type { LlmMessage } from './types';

export interface PromptCacheConfig {
  /** Number of early conversation turns to include in cacheable prefix. @default 3 */
  prefixTurns: number;
  /** Minimum token count for prefix to be eligible for caching. @default 1000 */
  minPrefixTokens: number;
}

export const DEFAULT_PROMPT_CACHE_CONFIG: PromptCacheConfig = {
  prefixTurns: 3,
  minPrefixTokens: 1000,
};

export interface SplitMessages {
  /** Cacheable prefix: system messages + early conversation turns. */
  prefix: LlmMessage[];
  /** Dynamic suffix: recent conversation (not cached). */
  dynamic: LlmMessage[];
  /** Whether the prefix meets minimum token threshold for caching. */
  shouldCache: boolean;
}

/**
 * Split messages into cacheable prefix and dynamic suffix.
 *
 * The prefix contains:
 * 1. All system messages (instructions, context files, injected memory)
 * 2. Early conversation turns (usually stable across requests)
 *
 * The dynamic suffix contains:
 * 1. Recent conversation turns (changes every request)
 *
 * This allows LLM providers to cache the prefix and reuse KV cache.
 */
export function splitMessagesForCache(
  messages: LlmMessage[],
  config: PromptCacheConfig = DEFAULT_PROMPT_CACHE_CONFIG
): SplitMessages {
  if (messages.length === 0) {
    return { prefix: [], dynamic: [], shouldCache: false };
  }

  // Separate system messages from conversation messages
  const systemMessages = messages.filter(m => m.role === 'system');
  const conversationMessages = messages.filter(m => m.role !== 'system');

  // Early turns go into prefix
  const prefixConversationTurns = Math.min(config.prefixTurns * 2, conversationMessages.length);
  const prefixConversation = conversationMessages.slice(0, prefixConversationTurns);
  const dynamicConversation = conversationMessages.slice(prefixConversationTurns);

  // Combine: system + early turns = prefix
  const prefix = [...systemMessages, ...prefixConversation];
  const dynamic = [...dynamicConversation];

  // Estimate token count for prefix
  const prefixTokens = estimateTokenCount(prefix);
  const shouldCache = prefixTokens >= config.minPrefixTokens;

  return { prefix, dynamic, shouldCache };
}

/**
 * Estimate token count for messages (rough: ~4 chars per token).
 */
function estimateTokenCount(messages: LlmMessage[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    totalChars += msg.content?.length ?? 0;
  }
  return Math.ceil(totalChars / 4);
}

/**
 * Check if a provider supports prompt caching.
 */
export function supportsPromptCaching(providerId: string): boolean {
  const cachedProviders = ['anthropic', 'openai', 'deepseek', 'bedrock'];
  return cachedProviders.includes(providerId);
}
