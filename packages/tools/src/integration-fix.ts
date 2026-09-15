/**
 * @oa/tools — Integration Fix
 *
 * Additional exports and type bridges needed by other packages.
 * Ensures interface alignment across the monorepo.
 */

import type { RiskLevel } from '@oa/plugins';
import { ToolExecutionMode, ToolScope } from './types';
import type {
  ToolDefinition,
  ToolResult,
  ToolCall,
  ToolExecutionContext,
  ToolContent,
  ToolError,
  ToolResultMetadata,
  InputSchema,
} from './types';

// ---------------------------------------------------------------------------
// Re-exports for cross-package compatibility
// ---------------------------------------------------------------------------

export type {
  ToolDefinition,
  ToolResult,
  ToolCall,
  ToolExecutionContext,
  ToolContent,
  ToolError,
  ToolResultMetadata,
  InputSchema,
};

export { ToolExecutionMode, ToolScope } from './types';

// ---------------------------------------------------------------------------
// Conversion helpers between tools package and LLM package types
// ---------------------------------------------------------------------------

/**
 * Convert a ToolDefinition (tools package) to LLM-compatible format.
 * The LLM package uses a simpler OpenAI-style format.
 */
export function toLlmToolDefinition(tool: ToolDefinition): {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
} {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as unknown as Record<string, unknown>,
    },
  };
}

/**
 * Convert multiple ToolDefinitions to LLM-compatible format.
 */
export function toLlmToolDefinitions(tools: ToolDefinition[]): Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return tools.map(toLlmToolDefinition);
}

/**
 * Convert an LLM tool call to a ToolCall (tools package format).
 */
export function fromLlmToolCall(llmCall: {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}): ToolCall {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(llmCall.function.arguments);
  } catch {
    // If parsing fails, wrap the raw string
    args = { _raw: llmCall.function.arguments };
  }

  return {
    id: llmCall.id,
    name: llmCall.function.name,
    args,
    timestamp: new Date(),
    status: 'PENDING' as import('./types').ToolCallStatus,
  };
}

/**
 * Create a successful ToolResult.
 */
export function createToolResult(
  content: ToolContent[],
  metadata?: Partial<ToolResultMetadata>
): ToolResult {
  return {
    success: true,
    content,
    metadata: {
      toolName: metadata?.toolName ?? '',
      durationMs: metadata?.durationMs ?? 0,
      retryCount: metadata?.retryCount ?? 0,
      truncated: metadata?.truncated ?? false,
      tokenCount: metadata?.tokenCount,
      extra: metadata?.extra,
    },
  };
}

/**
 * Create a failed ToolResult.
 */
export function createToolError(
  error: ToolError,
  metadata?: Partial<ToolResultMetadata>
): ToolResult {
  return {
    success: false,
    content: [{ type: 'error', message: error.message, code: error.code }],
    error,
    metadata: {
      toolName: metadata?.toolName ?? '',
      durationMs: metadata?.durationMs ?? 0,
      retryCount: metadata?.retryCount ?? 0,
      truncated: metadata?.truncated ?? false,
      tokenCount: metadata?.tokenCount,
      extra: metadata?.extra,
    },
  };
}

/**
 * Create a text content block.
 */
export function textToolContent(text: string): ToolContent {
  return { type: 'text', text };
}

/**
 * Create a JSON content block.
 */
export function jsonToolContent(data: unknown): ToolContent {
  return { type: 'json', data };
}

/**
 * Create a minimal ToolDefinition for quick registration.
 */
export function createMinimalToolDefinition(
  name: string,
  description: string,
  execute: ToolDefinition['execute'],
  options?: {
    riskLevel?: RiskLevel;
    executionMode?: ToolExecutionMode;
    scope?: ToolScope;
    requiresConfirmation?: boolean;
    timeoutMs?: number;
  }
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
    executionMode: options?.executionMode ?? ToolExecutionMode.PARALLEL,
    riskLevel: options?.riskLevel ?? 'LOW' as RiskLevel,
    scope: options?.scope ?? ToolScope.GLOBAL,
    requiresConfirmation: options?.requiresConfirmation ?? false,
    timeoutMs: options?.timeoutMs ?? 30000,
    retryable: false,
    maxRetries: 0,
    execute,
  };
}

// ---------------------------------------------------------------------------
// Type bridges for agent-loop integration
// ---------------------------------------------------------------------------

/**
 * Bridge: Convert ToolResult (tools package) to agent-loop ToolResult format.
 */
export function toAgentLoopToolResult(
  toolCallId: string,
  toolName: string,
  result: ToolResult
): { toolCallId: string; toolName: string; content: string; isError: boolean; duration: number; metadata?: Record<string, unknown> } {
  const content = result.content
    .map((c) => {
      if (c.type === 'text') return c.text;
      if (c.type === 'json') return JSON.stringify(c.data);
      if (c.type === 'error') return c.message;
      return '';
    })
    .join('\n');

  return {
    toolCallId,
    toolName,
    content,
    isError: !result.success,
    duration: result.metadata.durationMs,
    metadata: result.metadata.extra,
  };
}
