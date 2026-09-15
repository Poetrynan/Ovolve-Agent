/**
 * @oa/llm — Integration Fix
 *
 * Additional exports and type bridges needed by other packages.
 * Ensures interface alignment across the monorepo.
 */

import type {
  ProviderConfig,
  ModelConfig,
  LlmRequest,
  LlmResponse,
  LlmMessage,
  ToolCall,
  ToolDefinition,
  TokenUsage,
  StreamChunk,
  ThinkingLevel,
} from './types';

// ---------------------------------------------------------------------------
// Re-exports for cross-package compatibility
// ---------------------------------------------------------------------------

export type {
  ProviderConfig,
  ModelConfig,
  LlmRequest,
  LlmResponse,
  LlmMessage,
  ToolCall,
  ToolDefinition,
  TokenUsage,
  StreamChunk,
  ThinkingLevel,
};

// ---------------------------------------------------------------------------
// LLM type to tools package bridges
// ---------------------------------------------------------------------------

/**
 * Convert LLM ToolDefinition to tools package ToolDefinition format.
 * This is a simplified conversion for basic tools.
 */
export function fromLlmToolDefinition(
  llmTool: ToolDefinition,
  options?: {
    executionMode?: import('@oa/tools').ToolExecutionMode;
    riskLevel?: import('@oa/plugins').RiskLevel;
    scope?: import('@oa/tools').ToolScope;
    timeoutMs?: number;
  }
): import('@oa/tools').ToolDefinition {
  return {
    name: llmTool.function.name,
    description: llmTool.function.description,
    inputSchema: llmTool.function.parameters as import('@oa/tools').InputSchema,
    executionMode: options?.executionMode ?? 'PARALLEL' as import('@oa/tools').ToolExecutionMode,
    riskLevel: options?.riskLevel ?? 'LOW' as import('@oa/plugins').RiskLevel,
    scope: options?.scope ?? 'GLOBAL' as import('@oa/tools').ToolScope,
    requiresConfirmation: false,
    timeoutMs: options?.timeoutMs ?? 30000,
    retryable: false,
    maxRetries: 0,
    execute: async () => ({
      success: true,
      content: [],
      metadata: { toolName: llmTool.function.name, durationMs: 0, retryCount: 0, truncated: false },
    }),
  };
}

/**
 * Convert LLM ToolCall to tools package ToolCall format.
 */
export function fromLlmToolCall(llmCall: ToolCall): import('@oa/tools').ToolCall {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(llmCall.function.arguments);
  } catch {
    args = { _raw: llmCall.function.arguments };
  }

  return {
    id: llmCall.id,
    name: llmCall.function.name,
    args,
    timestamp: new Date(),
    status: 'PENDING' as import('@oa/tools').ToolCallStatus,
  };
}

/**
 * Convert tools package ToolDefinition to LLM format.
 */
export function toLlmToolDefinition(tool: import('@oa/tools').ToolDefinition): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  };
}

/**
 * Convert tools package ToolCall to LLM format.
 */
export function toLlmToolCall(call: import('@oa/tools').ToolCall): ToolCall {
  return {
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: JSON.stringify(call.args),
    },
  };
}

// ---------------------------------------------------------------------------
// LlmRequest helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal LlmRequest.
 */
export function createLlmRequest(
  messages: LlmMessage[],
  model: string,
  options?: Partial<LlmRequest>
): LlmRequest {
  return {
    messages,
    model,
    temperature: 0.7,
    maxTokens: 4096,
    ...options,
  };
}

/**
 * Create a system message.
 */
export function systemMessage(content: string): LlmMessage {
  return { role: 'system', content };
}

/**
 * Create a user message.
 */
export function userMessage(content: string): LlmMessage {
  return { role: 'user', content };
}

/**
 * Create an assistant message.
 */
export function assistantMessage(content: string): LlmMessage {
  return { role: 'assistant', content };
}

/**
 * Create a tool result message.
 */
export function toolResultMessage(toolCallId: string, content: string, isError?: boolean): LlmMessage {
  return {
    role: 'tool',
    content: JSON.stringify([{ type: 'tool_result', toolUseId: toolCallId, content, isError }]),
    toolCallId,
  };
}

// ---------------------------------------------------------------------------
// TokenUsage helpers
// ---------------------------------------------------------------------------

/**
 * Create zero TokenUsage.
 */
export function zeroTokenUsage(): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cost: 0,
    duration: 0,
  };
}

/**
 * Add two TokenUsage objects together.
 */
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cost: a.cost + b.cost,
    duration: a.duration + b.duration,
  };
}

// ---------------------------------------------------------------------------
// ThinkingLevel helpers
// ---------------------------------------------------------------------------

/**
 * All thinking levels in order.
 */
export const THINKING_LEVELS: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Compare two thinking levels.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareThinkingLevel(a: ThinkingLevel, b: ThinkingLevel): number {
  return THINKING_LEVELS.indexOf(a) - THINKING_LEVELS.indexOf(b);
}
