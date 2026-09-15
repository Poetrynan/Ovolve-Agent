/**
 * Core types for the @oa/llm package.
 * Defines provider configs, LLM requests/responses, streaming chunks, and tool schemas.
 */

// ---------------------------------------------------------------------------
// Provider Types
// ---------------------------------------------------------------------------

export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'bedrock'
  | 'azure'
  | 'custom';

export interface ProviderConfig {
  id: string;
  type: ProviderType;
  apiKey: string;
  /** Optional custom base URL (e.g. proxy, local LLM, Azure endpoint). */
  baseUrl?: string;
  /** Region for Bedrock / Azure. */
  region?: string;
  /** Deployment name for Azure. */
  deployment?: string;
  /** API version for Azure. */
  apiVersion?: string;
  /** Models available through this provider. */
  models: ModelConfig[];
  /** Request timeout in ms (default 120_000). */
  timeout: number;
  /** Max retries before giving up (default 5). */
  maxRetries: number;
  /** Whether this provider is enabled. */
  enabled: boolean;
  /** Priority for auto-selection (lower = preferred). */
  priority: number;
  /** Extra headers sent on every request. */
  extraHeaders?: Record<string, string>;
}

export interface ModelConfig {
  id: string;
  /** Human-readable name. */
  name: string;
  /** Context window size in tokens. */
  contextWindow: number;
  /** Max output tokens. */
  maxTokens: number;
  /** Supported input modalities. */
  inputTypes: ('text' | 'image' | 'audio' | 'video')[];
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsThinking: boolean;
  supportsVision: boolean;
  /** Cost per 1M tokens (input / output) in USD. */
  costPer1mTokens: { input: number; output: number };
  /** Model status for routing decisions. */
  status: 'active' | 'deprecated' | 'maintenance';
}

// ---------------------------------------------------------------------------
// LLM Request / Response
// ---------------------------------------------------------------------------

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ToolCallType = 'function';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  /** Cache control marker (Anthropic prompt caching). */
  cacheControl?: { type: 'ephemeral' };
}

export type ContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock
  | ThinkingContentBlock;

export interface TextContentBlock {
  type: 'text';
  text: string;
  cacheControl?: { type: 'ephemeral' };
}

export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    mediaType: string;
    data?: string;
    url?: string;
  };
}

export interface ToolUseContentBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContentBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ThinkingContentBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

export type StopReason = 'stop' | 'length' | 'tool_calls' | 'error' | 'content_filter';

export interface LlmRequest {
  messages: LlmMessage[];
  model: string;
  /** Target provider id (optional, auto-selected otherwise). */
  providerId?: string;
  temperature: number;
  maxTokens: number;
  topP?: number;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  thinking?: ThinkingLevel;
  stopSequences?: string[];
  responseFormat?: 'text' | 'json_object' | 'json_schema';
  jsonSchema?: Record<string, unknown>;
  /** Arbitrary metadata propagated to events & logs. */
  metadata?: Record<string, unknown>;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Tokens served from cache (if provider supports it). */
  cachedTokens: number;
  /** Cost in USD. */
  cost: number;
  /** Duration in ms. */
  duration: number;
}

export interface LlmResponse {
  id: string;
  model: string;
  providerId: string;
  message: LlmMessage;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: StopReason;
  /** Any reasoning / thinking blocks produced by the model. */
  reasoning: string;
  /** Raw provider response for debugging. */
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface StreamChunk {
  id: string;
  model: string;
  providerId: string;
  delta: {
    role?: 'assistant';
    content?: string | null;
    toolCalls?: ToolCallDelta[];
    reasoning?: string | null;
  };
  usage: TokenUsage | null;
  finishReason: StopReason | null;
  /** True on the final chunk for a given stream. */
  done: boolean;
}

// ---------------------------------------------------------------------------
// Provider Adapter Interface
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  readonly id: string;
  readonly type: ProviderType;
  readonly config: ProviderConfig;

  /** Convert a unified LlmRequest to the provider-native body. */
  buildRequestBody(request: LlmRequest, model: ModelConfig): unknown;

  /** The fetch endpoint for this request. */
  getEndpoint(streaming: boolean): string;

  /** Parse a non-streaming response into LlmResponse. */
  parseResponse(body: unknown): LlmResponse;

  /** Parse a single SSE chunk line into a StreamChunk (or null to skip). */
  parseSseChunk(line: string): StreamChunk | null;

  /** Extract usage from a raw response. */
  extractUsage(body: unknown): TokenUsage;

  /** Map a unified thinking level to provider-specific parameter. */
  mapThinkingLevel(level: ThinkingLevel): unknown;

  /** Build extra headers for the request. */
  buildHeaders(): Record<string, string>;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type LlmEventType =
  | 'llm:request'
  | 'llm:response'
  | 'llm:chunk'
  | 'llm:error'
  | 'llm:retry';

export interface LlmEvent {
  type: LlmEventType;
  providerId: string;
  model: string;
  timestamp: number;
  data?: unknown;
  error?: Error;
}
