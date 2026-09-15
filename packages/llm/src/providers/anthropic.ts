/**
 * Anthropic Claude provider adapter.
 *
 * Supports Claude 3.5/3.7/4 series with extended thinking, tool use, and
 * prompt caching.
 */

import { v4 as uuid } from 'uuid';
import type {
  ProviderConfig,
  ModelConfig,
  LlmRequest,
  LlmResponse,
  LlmMessage,
  TokenUsage,
  StreamChunk,
  ToolCall,
  ToolCallDelta,
  ContentBlock,
  StopReason,
  ProviderAdapter,
  ThinkingLevel,
} from '../types.js';
import { mapThinkingLevel } from '../thinking-levels.js';

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | {
      type: 'image';
      source: { type: 'base64' | 'url'; media_type: string; data?: string; url?: string };
      cache_control?: { type: 'ephemeral' };
    }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
      cache_control?: { type: 'ephemeral' };
    }
  | {
      type: 'thinking';
      thinking: string;
      signature?: string;
    };

interface AnthropicRequestBody {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  tools?: AnthropicTool[];
  tool_choice?: { type: string; name?: string; disable_parallel_tool_use?: boolean };
  thinking?: { type: string; budget_tokens: number };
  stop_sequences?: string[];
  stream?: boolean;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicResponse {
  id: string;
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  role: string;
}

/**
 * Build the default Anthropic provider config.
 */
export function createAnthropicConfig(
  apiKey: string,
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id: 'anthropic',
    type: 'anthropic',
    apiKey,
    baseUrl: 'https://api.anthropic.com/v1',
    timeout: 120_000,
    maxRetries: 5,
    enabled: true,
    priority: 5,
    models: [
      {
        id: 'claude-sonnet-4-20250514',
        name: 'Claude 4 Sonnet',
        contextWindow: 200_000,
        maxTokens: 16_384,
        inputTypes: ['text', 'image'],
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
        supportsVision: true,
        costPer1mTokens: { input: 3, output: 15 },
        status: 'active',
      },
      {
        id: 'claude-opus-4-20250514',
        name: 'Claude 4 Opus',
        contextWindow: 200_000,
        maxTokens: 32_768,
        inputTypes: ['text', 'image'],
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
        supportsVision: true,
        costPer1mTokens: { input: 15, output: 75 },
        status: 'active',
      },
      {
        id: 'claude-3-5-sonnet-latest',
        name: 'Claude 3.5 Sonnet',
        contextWindow: 200_000,
        maxTokens: 8192,
        inputTypes: ['text', 'image'],
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
        supportsVision: true,
        costPer1mTokens: { input: 3, output: 15 },
        status: 'active',
      },
      {
        id: 'claude-3-5-haiku-latest',
        name: 'Claude 3.5 Haiku',
        contextWindow: 200_000,
        maxTokens: 8192,
        inputTypes: ['text', 'image'],
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: false,
        supportsVision: true,
        costPer1mTokens: { input: 0.25, output: 1.25 },
        status: 'active',
      },
    ],
    ...overrides,
  } as ProviderConfig;
}

/**
 * Convert unified messages to Anthropic format.
 * System messages are extracted and returned separately.
 */
function convertMessages(
  messages: LlmMessage[],
): { converted: AnthropicMessage[]; systemBlocks: AnthropicContentBlock[] } {
  const converted: AnthropicMessage[] = [];
  const systemBlocks: AnthropicContentBlock[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') {
        systemBlocks.push({ type: 'text', text: msg.content });
      } else {
        systemBlocks.push(
          ...msg.content.map(convertContentBlock).filter(Boolean).map((cb) => cb as AnthropicContentBlock),
        );
      }
      continue;
    }

    const out: AnthropicMessage = { role: msg.role, content: '' };

    if (typeof msg.content === 'string') {
      out.content = msg.content;
    } else {
      out.content = msg.content
        .map(convertContentBlock)
        .filter(Boolean)
        .map((cb) => cb as AnthropicContentBlock);
    }

    converted.push(out);
  }

  return { converted, systemBlocks };
}

function convertContentBlock(block: ContentBlock): AnthropicContentBlock | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
      return {
        type: 'image',
        source: {
          type: block.source.type,
          media_type: block.source.mediaType,
          data: block.source.data,
          url: block.source.url,
        },
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking, signature: block.signature };
    default:
      return null;
  }
}

/**
 * Map Anthropic stop reason to unified StopReason.
 */
function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'stop_sequence':
      return 'stop';
    default:
      return 'stop';
  }
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id: string;
  readonly type = 'anthropic' as const;
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.config = config;
  }

  buildRequestBody(request: LlmRequest, model: ModelConfig): AnthropicRequestBody {
    const { converted, systemBlocks } = convertMessages(request.messages);

    const body: AnthropicRequestBody = {
      model: request.model,
      messages: converted,
      max_tokens: request.maxTokens,
    };

    if (systemBlocks.length > 0) {
      body.system = systemBlocks;
    }

    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.stopSequences) body.stop_sequences = request.stopSequences;

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    if (request.toolChoice) {
      if (typeof request.toolChoice === 'string') {
        body.tool_choice = { type: request.toolChoice };
      } else {
        body.tool_choice = {
          type: 'function',
          name: request.toolChoice.function.name,
        };
      }
    }

    if (request.thinking && model.supportsThinking) {
      const thinkingParams = mapThinkingLevel(this.type, request.thinking, model) as {
        thinking: { type: string; budget_tokens: number };
      };
      body.thinking = thinkingParams.thinking;
    }

    return body;
  }

  getEndpoint(_streaming: boolean): string {
    return `${this.config.baseUrl}/messages`;
  }

  parseResponse(body: unknown): LlmResponse {
    const resp = body as AnthropicResponse;

    const toolCalls: ToolCall[] = [];
    let textContent = '';
    let reasoning = '';

    for (const block of resp.content) {
      switch (block.type) {
        case 'text':
          textContent += block.text;
          break;
        case 'tool_use':
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
          break;
        case 'thinking':
          reasoning += block.thinking;
          break;
      }
    }

    const message: LlmMessage = {
      role: 'assistant',
      content: textContent,
      toolCalls,
    };

    return {
      id: resp.id,
      model: resp.model,
      providerId: this.id,
      message,
      toolCalls,
      usage: this.extractUsage(body),
      finishReason: mapStopReason(resp.stop_reason),
      reasoning,
    };
  }

  parseSseChunk(line: string): StreamChunk | null {
    // Anthropic SSE format: event: ...\ndata: {...}
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return null;

    const data = trimmed.slice(5).trim();

    try {
      const parsed = JSON.parse(data) as {
        type: string;
        message?: {
          id: string;
          model: string;
          role: string;
          content: AnthropicContentBlock[];
          stop_reason?: string;
          usage?: {
            input_tokens: number;
            output_tokens: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
        };
        content_block?: AnthropicContentBlock;
        delta?: {
          type: string;
          text?: string;
          partial_json?: string;
          thinking?: string;
        };
        index?: number;
        usage?: { input_tokens?: number; output_tokens?: number };
        error?: { type: string; message: string };
      };

      if (parsed.type === 'message_start' && parsed.message) {
        return {
          id: parsed.message.id,
          model: parsed.message.model,
          providerId: this.id,
          delta: { role: 'assistant' },
          usage: {
            promptTokens: parsed.message.usage?.input_tokens ?? 0,
            completionTokens: 0,
            totalTokens: parsed.message.usage?.input_tokens ?? 0,
            cachedTokens: parsed.message.usage?.cache_read_input_tokens ?? 0,
            cost: 0,
            duration: 0,
          },
          finishReason: null,
          done: false,
        };
      }

      if (parsed.type === 'content_block_delta' && parsed.delta) {
        const toolCallDeltas: ToolCallDelta[] = [];
        if (parsed.delta.partial_json !== undefined) {
          toolCallDeltas.push({
            index: parsed.index ?? 0,
            function: { arguments: parsed.delta.partial_json },
          });
        }

        return {
          id: '',
          model: '',
          providerId: this.id,
          delta: {
            content: parsed.delta.text,
            reasoning: parsed.delta.thinking,
            toolCalls: toolCallDeltas.length > 0 ? toolCallDeltas : undefined,
          },
          usage: null,
          finishReason: null,
          done: false,
        };
      }

      if (parsed.type === 'message_delta') {
        return {
          id: '',
          model: '',
          providerId: this.id,
          delta: {},
          usage: null,
          finishReason: mapStopReason(parsed.message?.stop_reason ?? null),
          done: true,
        };
      }

      if (parsed.type === 'message_stop') {
        return {
          id: '',
          model: '',
          providerId: this.id,
          delta: {},
          usage: null,
          finishReason: 'stop',
          done: true,
        };
      }

      if (parsed.type === 'ping') return null;

      return null;
    } catch {
      return null;
    }
  }

  extractUsage(body: unknown): TokenUsage {
    const resp = body as AnthropicResponse;
    const usage = resp.usage ?? { input_tokens: 0, output_tokens: 0 };

    return {
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens,
      cachedTokens: usage.cache_read_input_tokens ?? 0,
      cost: 0,
      duration: 0,
    };
  }

  mapThinkingLevel(level: ThinkingLevel): unknown {
    return mapThinkingLevel(this.type, level, this.config.models[0]);
  }

  buildHeaders(): Record<string, string> {
    return {
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'Content-Type': 'application/json',
      ...this.config.extraHeaders,
    };
  }
}
