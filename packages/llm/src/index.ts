/**
 * @oa/llm — Unified LLM client with multi-provider support.
 *
 * Provides a single interface for streaming and non-streaming LLM calls
 * across OpenAI, Anthropic, Google, DeepSeek, AWS Bedrock, Azure, and
 * custom OpenAI-compatible providers.
 */

// Core client
export { LlmClient, DEFAULT_LLM_CONFIG } from './llm-client.js';
export type { LlmClientConfig } from './llm-client.js';

// Types
export type {
  ProviderType,
  ProviderConfig,
  ModelConfig,
  ThinkingLevel,
  LlmRequest,
  LlmResponse,
  LlmMessage,
  ContentBlock,
  TextContentBlock,
  ImageContentBlock,
  ToolUseContentBlock,
  ToolResultContentBlock,
  ThinkingContentBlock,
  ToolCall,
  ToolCallDelta,
  ToolDefinition,
  ToolChoice,
  TokenUsage,
  StreamChunk,
  StopReason,
  ProviderAdapter,
  LlmEvent,
  LlmEventType,
} from './types.js';

// Provider registry
export { ProviderRegistry } from './provider-registry.js';
export type { ProviderRegistryOptions } from './provider-registry.js';

// Token tracking
export { TokenTracker, zeroUsage, addUsage, computeCost } from './token-tracker.js';
export type { TurnUsage, SessionUsage, TokenTrackerOptions } from './token-tracker.js';

// Prompt caching (OpenAI/IC-Cache paper)
export { splitMessagesForCache, supportsPromptCaching, DEFAULT_PROMPT_CACHE_CONFIG } from './prompt-cache.js';
export type { PromptCacheConfig, SplitMessages } from './prompt-cache.js';

// Retry logic
export { withRetry, computeDelay, sleep, isRetryableError, DEFAULT_RETRY_CONFIG } from './retry.js';
export type { RetryConfig } from './retry.js';

// Thinking levels
export { mapThinkingLevel, supportsThinkingLevel, getDefaultThinkingLevel } from './thinking-levels.js';
export type {
  OpenAIThinkingParams,
  AnthropicThinkingParams,
  GoogleThinkingParams,
  DeepSeekThinkingParams,
  BedrockThinkingParams,
  ProviderThinkingParams,
} from './thinking-levels.js';

// Provider adapters
export { OpenAIAdapter, createOpenAIConfig } from './providers/openai.js';
export { AnthropicAdapter, createAnthropicConfig } from './providers/anthropic.js';
export { GoogleAdapter, createGoogleConfig } from './providers/google.js';
export { DeepSeekAdapter, createDeepSeekConfig } from './providers/deepseek.js';
export { BedrockAdapter, createBedrockConfig } from './providers/bedrock.js';
export { AzureAdapter, createAzureConfig } from './providers/azure.js';
export { CustomAdapter, createCustomConfig } from './providers/custom.js';

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

import { LlmClient } from './llm-client.js';
import type { LlmClientConfig } from './llm-client.js';

/**
 * Create an LLM client with the given configuration.
 */
export function createLlmClient(config: LlmClientConfig): LlmClient {
  return new LlmClient(config);
}
