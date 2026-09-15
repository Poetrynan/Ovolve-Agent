/**
 * Unified LLM client with multi-provider support.
 *
 * Provides a single interface for streaming and non-streaming LLM calls
 * across all supported providers. Handles provider selection, retry,
 * failover, and event emission.
 */

import { v4 as uuid } from 'uuid';
import type {
  LlmRequest,
  LlmResponse,
  StreamChunk,
  ProviderConfig,
  ModelConfig,
  ProviderAdapter,
  TokenUsage,
  LlmEvent,
} from './types.js';
import { ProviderRegistry } from './provider-registry.js';
import { TokenTracker, computeCost } from './token-tracker.js';
import { withRetry, DEFAULT_RETRY_CONFIG } from './retry.js';
import { OpenAIAdapter } from './providers/openai.js';
import { AnthropicAdapter } from './providers/anthropic.js';
import { GoogleAdapter } from './providers/google.js';
import { DeepSeekAdapter } from './providers/deepseek.js';
import { BedrockAdapter } from './providers/bedrock.js';
import { AzureAdapter } from './providers/azure.js';
import { CustomAdapter } from './providers/custom.js';

// ---------------------------------------------------------------------------
// Client Configuration
// ---------------------------------------------------------------------------

export interface LlmClientConfig {
  providers: ProviderConfig[];
  /** Default model to use if not specified in request. */
  defaultModel: string;
  /** Default provider id to prefer. */
  defaultProviderId?: string;
  /** Retry configuration. */
  retry: typeof DEFAULT_RETRY_CONFIG;
  /** Token tracking options. */
  tokenTracker?: {
    onTurnComplete?: (usage: { turnId: string; promptTokens: number; completionTokens: number; cost: number; model: string; providerId: string }) => void;
    onSessionUpdate?: (usage: { sessionTotal: TokenUsage }) => void;
  };
  /** Event handler for all LLM events. */
  onEvent?: (event: LlmEvent) => void;
  /** Prompt cache toggle (default: true). Splits messages into cacheable prefix + dynamic suffix. */
  promptCacheEnabled?: boolean;
  /** Number of early conversation turns to include in cacheable prefix. @default 3 */
  promptCachePrefixTurns?: number;
}

export const DEFAULT_LLM_CONFIG: Partial<LlmClientConfig> = {
  retry: DEFAULT_RETRY_CONFIG,
  promptCacheEnabled: true,
  promptCachePrefixTurns: 3,
};

// ---------------------------------------------------------------------------
// LLM Client
// ---------------------------------------------------------------------------

export class LlmClient {
  private registry: ProviderRegistry;
  private tokenTracker: TokenTracker;
  private config: LlmClientConfig;
  private eventListeners = new Set<(event: LlmEvent) => void>();

  constructor(config: LlmClientConfig) {
    this.config = { ...DEFAULT_LLM_CONFIG, ...config };
    this.registry = new ProviderRegistry({
      onRegister: (cfg) => this.emit({
        type: 'llm:request',
        providerId: cfg.id,
        model: '',
        timestamp: Date.now(),
        data: { action: 'register' },
      }),
      onFailover: (from, to, reason) => this.emit({
        type: 'llm:error',
        providerId: from,
        model: '',
        timestamp: Date.now(),
        data: { action: 'failover', to, reason },
      }),
    });
    this.tokenTracker = new TokenTracker(config.tokenTracker);

    // Register all providers.
    for (const providerConfig of config.providers) {
      const adapter = this.createAdapter(providerConfig);
      this.registry.register(providerConfig, adapter);
    }
  }

  /**
   * Create a provider adapter from config.
   */
  private createAdapter(config: ProviderConfig): ProviderAdapter {
    switch (config.type) {
      case 'openai':
        return new OpenAIAdapter(config);
      case 'anthropic':
        return new AnthropicAdapter(config);
      case 'google':
        return new GoogleAdapter(config);
      case 'deepseek':
        return new DeepSeekAdapter(config);
      case 'bedrock':
        return new BedrockAdapter(config);
      case 'azure':
        return new AzureAdapter(config);
      case 'custom':
        return new CustomAdapter(config);
      default:
        throw new Error(`Unknown provider type: ${config.type}`);
    }
  }

  /**
   * Apply prompt prefix cache splitting.
   * Config switch: promptCacheEnabled (default true)
   * Paper: OpenAI Prompt Caching, IC-Cache (2024)
   */
  private applyPromptCache(request: LlmRequest): LlmRequest {
    const { splitMessagesForCache } = require('./prompt-cache.js');
    const prefixTurns = this.config.promptCachePrefixTurns ?? 3;

    const { prefix, dynamic, shouldCache } = splitMessagesForCache(
      request.messages,
      { prefixTurns, minPrefixTokens: 1000 }
    );

    if (!shouldCache) return request;

    // Reconstruct: prefix messages get cache_control markers
    // This is handled by the provider adapter (e.g., Anthropic cache_control)
    return {
      ...request,
      messages: [...prefix, ...dynamic],
      // Signal to provider adapter that prefix should be cached
      cacheControl: { prefixLength: prefix.length },
    } as LlmRequest;
  }

  /**
   * Register a provider adapter directly (for custom providers).
   */
  registerProvider(config: ProviderConfig, adapter: ProviderAdapter): void {
    this.registry.register(config, adapter);
  }

  /**
   * Unregister a provider.
   */
  unregisterProvider(providerId: string): void {
    this.registry.unregister(providerId);
  }

  /**
   * Subscribe to LLM events.
   */
  onEvent(listener: (event: LlmEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Emit an event to all listeners.
   */
  private emit(event: LlmEvent): void {
    this.config.onEvent?.(event);
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  /**
   * Select the best provider for a request.
   */
  private selectProvider(
    request: LlmRequest,
    excludeIds: string[] = [],
  ): { provider: ProviderConfig; adapter: ProviderAdapter; model: ModelConfig } {
    let providerId = request.providerId ?? this.config.defaultProviderId;

    if (providerId && !excludeIds.includes(providerId)) {
      const provider = this.registry.getProvider(providerId);
      const adapter = this.registry.getAdapter(providerId);
      const model = this.registry.getModel(providerId, request.model);
      if (provider && adapter && model) {
        return { provider, adapter, model };
      }
    }

    // Auto-select based on model availability.
    const provider = this.registry.autoSelectProvider(request.model, excludeIds);
    if (!provider) {
      throw new Error(`No provider available for model: ${request.model}`);
    }

    const adapter = this.registry.getAdapter(provider.id);
    const model = this.registry.getModel(provider.id, request.model);
    if (!adapter || !model) {
      throw new Error(`Provider ${provider.id} not properly configured for model ${request.model}`);
    }

    return { provider, adapter, model };
  }

  /**
   * Stream a chat completion. Yields StreamChunk events.
   *
   * Supports prompt prefix caching: splits messages into cacheable prefix + dynamic suffix.
   * Paper: OpenAI Prompt Caching, IC-Cache (2024)
   */
  async *stream(request: LlmRequest): AsyncGenerator<StreamChunk> {
    const requestId = uuid();
    const startTime = Date.now();
    const excludedProviders: string[] = [];
    let lastError: Error | undefined;

    // Prompt Cache: split messages if enabled (config switch)
    const effectiveRequest = this.config.promptCacheEnabled !== false
      ? this.applyPromptCache(request)
      : request;

    // Try providers until one succeeds (with failover).
    while (true) {
      let provider: ProviderConfig;
      let adapter: ProviderAdapter;
      let model: ModelConfig;

      try {
        ({ provider, adapter, model } = this.selectProvider(effectiveRequest, excludedProviders));
      } catch (err) {
        throw lastError ?? (err instanceof Error ? err : new Error(String(err)));
      }

      try {
        yield* this.streamWithProvider(effectiveRequest, adapter, model, requestId, startTime);
        this.registry.recordSuccess(provider.id);
        return; // Success, exit the failover loop.
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.registry.recordFailure(provider.id, this.config.retry.failoverThreshold);

        this.emit({
          type: 'llm:error',
          providerId: provider.id,
          model: request.model,
          timestamp: Date.now(),
          error: lastError,
        });

        excludedProviders.push(provider.id);

        // Check if we have more providers to try.
        const next = this.registry.autoSelectProvider(request.model, excludedProviders);
        if (!next) {
          throw lastError;
        }

        this.emit({
          type: 'llm:request',
          providerId: next.id,
          model: request.model,
          timestamp: Date.now(),
          data: { action: 'failover', from: provider.id },
        });
      }
    }
  }

  /**
   * Stream with a specific provider.
   */
  private async *streamWithProvider(
    request: LlmRequest,
    adapter: ProviderAdapter,
    model: ModelConfig,
    requestId: string,
    startTime: number,
  ): AsyncGenerator<StreamChunk> {
    const body = adapter.buildRequestBody(request, model);
    const endpoint = adapter.getEndpoint(true);
    const headers = adapter.buildHeaders();

    this.emit({
      type: 'llm:request',
      providerId: adapter.id,
      model: request.model,
      timestamp: Date.now(),
      data: { endpoint, requestId },
    });

    const response = await withRetry(
      async () => {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: request.signal,
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${errorText.slice(0, 200)}`);
        }

        return res;
      },
      this.config.retry,
      request.signal,
      (event) => this.emit(event),
    );

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines.
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const chunk = adapter.parseSseChunk(line);
          if (!chunk) continue;

          // Accumulate usage from chunks.
          if (chunk.usage) {
            promptTokens = Math.max(promptTokens, chunk.usage.promptTokens);
            completionTokens = Math.max(completionTokens, chunk.usage.completionTokens);
            cachedTokens = Math.max(cachedTokens, chunk.usage.cachedTokens);
          }

          // Set provider info on chunk.
          chunk.providerId = adapter.id;
          chunk.model = chunk.model || model.id;

          this.emit({
            type: 'llm:chunk',
            providerId: adapter.id,
            model: request.model,
            timestamp: Date.now(),
            data: { chunk },
          });

          yield chunk;
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Record token usage.
    const duration = Date.now() - startTime;
    this.tokenTracker.recordTurn(
      (request.metadata?.sessionId as string) ?? 'default',
      requestId,
      model,
      adapter.id,
      promptTokens,
      completionTokens,
      cachedTokens,
      duration,
    );

    this.emit({
      type: 'llm:response',
      providerId: adapter.id,
      model: request.model,
      timestamp: Date.now(),
      data: {
        requestId,
        usage: { promptTokens, completionTokens, duration },
        cost: computeCost(model, promptTokens, completionTokens, cachedTokens),
      },
    });
  }

  /**
   * Non-streaming chat completion.
   */
  async chat(request: LlmRequest): Promise<LlmResponse> {
    const requestId = uuid();
    const startTime = Date.now();
    const excludedProviders: string[] = [];
    let lastError: Error | undefined;

    while (true) {
      let provider: ProviderConfig;
      let adapter: ProviderAdapter;
      let model: ModelConfig;

      try {
        ({ provider, adapter, model } = this.selectProvider(request, excludedProviders));
      } catch (err) {
        throw lastError ?? (err instanceof Error ? err : new Error(String(err)));
      }

      try {
        const body = adapter.buildRequestBody({ ...request, signal: undefined }, model);
        // Disable streaming for non-streaming call.
        (body as Record<string, unknown>).stream = false;
        const endpoint = adapter.getEndpoint(false);
        const headers = adapter.buildHeaders();

        this.emit({
          type: 'llm:request',
          providerId: adapter.id,
          model: request.model,
          timestamp: Date.now(),
          data: { endpoint, requestId, streaming: false },
        });

        const response = await withRetry(
          async () => {
            const res = await fetch(endpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              signal: request.signal,
            });

            if (!res.ok) {
              const errorText = await res.text().catch(() => '');
              throw new Error(`HTTP ${res.status}: ${errorText.slice(0, 200)}`);
            }

            return res.json();
          },
          this.config.retry,
          request.signal,
          (event) => this.emit(event),
        );

        const result = adapter.parseResponse(response);
        this.registry.recordSuccess(provider.id);

        // Record token usage.
        const duration = Date.now() - startTime;
        this.tokenTracker.recordTurn(
          (request.metadata?.sessionId as string) ?? 'default',
          requestId,
          model,
          adapter.id,
          result.usage.promptTokens,
          result.usage.completionTokens,
          result.usage.cachedTokens,
          duration,
        );

        this.emit({
          type: 'llm:response',
          providerId: adapter.id,
          model: request.model,
          timestamp: Date.now(),
          data: { requestId, usage: result.usage, cost: result.usage.cost },
        });

        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.registry.recordFailure(provider.id, this.config.retry.failoverThreshold);

        this.emit({
          type: 'llm:error',
          providerId: provider.id,
          model: request.model,
          timestamp: Date.now(),
          error: lastError,
        });

        excludedProviders.push(provider.id);

        const next = this.registry.autoSelectProvider(request.model, excludedProviders);
        if (!next) {
          throw lastError;
        }
      }
    }
  }

  /**
   * Get the token tracker.
   */
  getTokenTracker(): TokenTracker {
    return this.tokenTracker;
  }

  /**
   * Get the provider registry.
   */
  getRegistry(): ProviderRegistry {
    return this.registry;
  }

  /**
   * Get all registered providers.
   */
  getProviders(): ProviderConfig[] {
    return this.registry.getAllProviders();
  }

  /**
   * Get available models across all providers.
   */
  getAvailableModels(): ModelConfig[] {
    const models: ModelConfig[] = [];
    for (const provider of this.registry.getEnabledProviders()) {
      models.push(...provider.models.filter((m) => m.status === 'active'));
    }
    return models;
  }
}
