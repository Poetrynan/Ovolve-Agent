/**
 * Stream handler for LLM responses.
 *
 * Handles token accumulation, tool call delta parsing, reasoning content
 * extraction, and usage tracking from streaming chunks.
 */

import { v4 as uuid } from 'uuid';
import type {
  StreamChunk,
  LlmMessage,
  ToolCall,
  ToolCallDelta,
  TokenUsage,
  AgentEvent,
} from './types.js';

export interface StreamHandlerResult {
  message: LlmMessage;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  reasoning: string;
  /** Raw chunks for debugging. */
  rawChunks: StreamChunk[];
}

export interface StreamHandlerOptions {
  onEvent?: (event: AgentEvent) => void;
  sessionId: string;
}

/**
 * Accumulates streaming chunks into a complete response.
 */
export class StreamHandler {
  private contentParts: string[] = [];
  private reasoningParts: string[] = [];
  private toolCallMap = new Map<number, ToolCall>();
  private usage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cost: 0,
    duration: 0,
  };
  private finishReason: string | null = null;
  private rawChunks: StreamChunk[] = [];
  private startTime = Date.now();
  private options: StreamHandlerOptions;

  constructor(options: StreamHandlerOptions) {
    this.options = options;
  }

  /**
   * Process a single stream chunk.
   */
  processChunk(chunk: StreamChunk): void {
    this.rawChunks.push(chunk);

    // Accumulate content.
    if (chunk.delta.content) {
      this.contentParts.push(chunk.delta.content);
    }

    // Accumulate reasoning.
    if (chunk.delta.reasoning) {
      this.reasoningParts.push(chunk.delta.reasoning);
      this.options.onEvent?.({
        type: 'agent:thinking',
        sessionId: this.options.sessionId,
        timestamp: Date.now(),
        data: { content: chunk.delta.reasoning },
      });
    }

    // Accumulate tool call deltas.
    if (chunk.delta.toolCalls) {
      for (const delta of chunk.delta.toolCalls) {
        this.accumulateToolCall(delta);
      }
    }

    // Update usage (latest wins for streaming).
    if (chunk.usage) {
      this.usage = { ...chunk.usage };
    }

    // Track finish reason.
    if (chunk.finishReason) {
      this.finishReason = chunk.finishReason;
    }
  }

  /**
   * Accumulate a tool call delta into the tool call map.
   */
  private accumulateToolCall(delta: ToolCallDelta): void {
    const index = delta.index;

    let existing = this.toolCallMap.get(index);
    if (!existing) {
      existing = {
        id: delta.id ?? `call_${uuid()}`,
        type: 'function',
        function: { name: '', arguments: '' },
      };
      this.toolCallMap.set(index, existing);
    }

    // Update fields if present.
    if (delta.id) existing.id = delta.id;
    if (delta.function?.name) existing.function.name += delta.function.name;
    if (delta.function?.arguments) existing.function.arguments += delta.function.arguments;
  }

  /**
   * Finalize the stream and return the accumulated result.
   */
  finalize(): StreamHandlerResult {
    const content = this.contentParts.join('');
    const reasoning = this.reasoningParts.join('');

    // Convert tool call map to array (sorted by index).
    const toolCalls = Array.from(this.toolCallMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);

    // Filter out incomplete tool calls (no name or invalid JSON).
    const validToolCalls = toolCalls.filter((call) => {
      if (!call.function.name) return false;
      try {
        JSON.parse(call.function.arguments);
        return true;
      } catch {
        return false;
      }
    });

    const message: LlmMessage = {
      role: 'assistant',
      content,
      toolCalls: validToolCalls.length > 0 ? validToolCalls : undefined,
    };

    const duration = Date.now() - this.startTime;

    return {
      message,
      toolCalls: validToolCalls,
      usage: { ...this.usage, duration },
      reasoning,
      rawChunks: this.rawChunks,
    };
  }

  /**
   * Get current accumulated content (for real-time display).
   */
  getCurrentContent(): string {
    return this.contentParts.join('');
  }

  /**
   * Get current accumulated reasoning (for real-time display).
   */
  getCurrentReasoning(): string {
    return this.reasoningParts.join('');
  }

  /**
   * Check if there are pending tool calls.
   */
  hasToolCalls(): boolean {
    return this.toolCallMap.size > 0;
  }

  /**
   * Get the number of accumulated tool calls.
   */
  getToolCallCount(): number {
    return this.toolCallMap.size;
  }
}

/**
 * Create a new stream handler.
 */
export function createStreamHandler(options: StreamHandlerOptions): StreamHandler {
  return new StreamHandler(options);
}
