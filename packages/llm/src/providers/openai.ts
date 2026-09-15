/**
 * OpenAI provider adapter.
 *
 * Supports OpenAI's chat completions API including tool calling, reasoning
 * effort levels, and structured output.
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

interface OpenAIChatBody {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  top_p?: number;
  tools?: OpenAITool[];
  tool_choice?: string | object;
  response_format?: object;
  stop?: string[];
  reasoning_effort?: string;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
}

interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentBlock[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
  reasoning_effort?: string;
}

type OpenAIContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'reasoning'; reasoning?: string }
  | { type: 'tool_result'; tool_result?: { tool_call_id: string; content: string } };

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAICompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: OpenAIToolCall[];
      reasoning?: string | null;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Build the default OpenAI provider config.
 */
export function createOpenAIConfig(
  apiKey: string,
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id: 'openai',
    type: 'openai',
    apiKey,
    baseUrl: 'https://api.openai.com/v1',
    timeout: 120_000,
    maxRetries: 5,
    enabled: true,
    priority: 10,
    models: [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        contextWindow: 128_000,
        maxTokens: 16_384,
        inputTypes: ['text', 'image'],
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: false,
        supportsVision: true,
        costPer1mTokens: { input: 2.5, output: 10 },
        status: 'active',
      },
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        contextWindow: 128_000,
        maxTokens: 16_384,
        inputTypes: ['text', 'image'],
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: false,
        supportsVision: true,
        costPer1mTokens: { input: 0.15, output: 0.6 },
        status: 'active',
      },
      {
        id: 'o1',
        name: 'o1',
        contextWindow: 200_000,
        maxTokens: 100_000,
        inputTypes: ['text'],
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
        supportsVision: false,
        costPer1mTokens: { input: 15, output: 60 },
        status: 'active',
      },
      {
        id: 'o3',
        name: 'o3',
        contextWindow: 200_000,
        maxTokens: 100_000,
        inputTypes: ['text', 'image'],
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
        supportsVision: true,
        costPer1mTokens: { input: 2, output: 8 },
        status: 'active',
      },
    ],
    ...overrides,
  } as ProviderConfig;
}

/**
 * Convert unified messages to OpenAI format.
 */
function convertMessages(messages: LlmMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of messages) {
    const out: OpenAIMessage = { role: msg.role, content: '' };

    if (typeof msg.content === 'string') {
      out.content = msg.content;
    } else {
      out.content = msg.content.map(convertContentBlock).filter(Boolean) as OpenAIContentBlock[];
    }

    if (msg.name) out.name = msg.name;
    if (msg.toolCallId) out.tool_call_id = msg.toolCallId;
    if (msg.toolCalls) {
      out.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
    }

    result.push(out);
  }

  return result;
}

function convertContentBlock(block: ContentBlock): OpenAIContentBlock | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
      if (block.source.type === 'url') {
        return { type: 'image_url', image_url: { url: block.source.url! } };
      }
      return {
        type: 'image_url',
        image_url: { url: `data:${block.source.mediaType};base64,${block.source.data}` },
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_result: { tool_call_id: block.toolUseId, content: block.content },
      };
    case 'thinking':
      return { type: 'reasoning', reasoning: block.thinking };
    default:
      return null;
  }
}

/**
 * Map OpenAI finish reason to unified StopReason.
 */
function mapFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/**
 * Parse a streaming tool call delta from OpenAI SSE format.
 */
function parseToolCallDelta(index: number, data: unknown): ToolCallDelta | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;

  return {
    index,
    id: obj.id as string | undefined,
    type: obj.type as 'function' | undefined,
    function: obj.function
      ? {
          name: (obj.function as Record<string, unknown>).name as string | undefined,
          arguments: (obj.function as Record<string, unknown>).arguments as string | undefined,
        }
      : undefined,
  };
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly id: string;
  readonly type = 'openai' as const;
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.config = config;
  }

  buildRequestBody(request: LlmRequest, model: ModelConfig): OpenAIChatBody {
    const body: OpenAIChatBody = {
      model: request.model,
      messages: convertMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens) {
      // o-series uses max_completion_tokens instead of max_tokens.
      if (model.id.startsWith('o1') || model.id.startsWith('o3') || model.id.startsWith('o4')) {
        body.max_completion_tokens = request.maxTokens;
      } else {
        body.max_tokens = request.maxTokens;
      }
    }
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.stopSequences) body.stop = request.stopSequences;

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      }));
    }

    if (request.toolChoice) {
      if (typeof request.toolChoice === 'string') {
        body.tool_choice = request.toolChoice;
      } else {
        body.tool_choice = request.toolChoice as unknown as object;
      }
    }

    if (request.responseFormat) {
      if (request.responseFormat === 'json_object') {
        body.response_format = { type: 'json_object' };
      } else if (request.responseFormat === 'json_schema' && request.jsonSchema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: request.jsonSchema,
        };
      }
    }

    if (request.thinking) {
      const thinkingParams = mapThinkingLevel(this.type, request.thinking, model) as {
        reasoning_effort?: string;
      };
      if (thinkingParams.reasoning_effort) {
        body.reasoning_effort = thinkingParams.reasoning_effort;
      }
    }

    return body;
  }

  getEndpoint(streaming: boolean): string {
    return `${this.config.baseUrl}/chat/completions`;
  }

  parseResponse(body: unknown): LlmResponse {
    const resp = body as OpenAICompletionResponse;
    const choice = resp.choices[0];

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

    const message: LlmMessage = {
      role: 'assistant',
      content: choice.message.content ?? '',
      toolCalls,
    };

    return {
      id: resp.id,
      model: resp.model,
      providerId: this.id,
      message,
      toolCalls,
      usage: this.extractUsage(body),
      finishReason: mapFinishReason(choice.finish_reason),
      reasoning: choice.message.reasoning ?? '',
    };
  }

  parseSseChunk(line: string): StreamChunk | null {
    // OpenAI SSE format: data: {...}
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return null;

    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') {
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

    try {
      const parsed = JSON.parse(data) as {
        id: string;
        model: string;
        choices?: Array<{
          index: number;
          delta: {
            role?: string;
            content?: string | null;
            tool_calls?: Array<{
              index: number;
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
            reasoning?: string | null;
          };
          finish_reason?: string | null;
        }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };

      const choice = parsed.choices?.[0];
      if (!choice) {
        // Could be usage-only chunk.
        if (parsed.usage) {
          return {
            id: parsed.id,
            model: parsed.model,
            providerId: this.id,
            delta: {},
            usage: {
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens,
              totalTokens: parsed.usage.total_tokens,
              cachedTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
              cost: 0,
              duration: 0,
            },
            finishReason: null,
            done: false,
          };
        }
        return null;
      }

      const toolCallDeltas: ToolCallDelta[] = (choice.delta.tool_calls ?? [])
        .filter((tc) => tc !== undefined)
        .map((tc) => parseToolCallDelta(tc.index, tc)!);

      return {
        id: parsed.id,
        model: parsed.model,
        providerId: this.id,
        delta: {
          role: choice.delta.role as 'assistant' | undefined,
          content: choice.delta.content,
          toolCalls: toolCallDeltas.length > 0 ? toolCallDeltas : undefined,
          reasoning: choice.delta.reasoning,
        },
        usage: null,
        finishReason: mapFinishReason(choice.finish_reason ?? null),
        done: choice.finish_reason !== null,
      };
    } catch {
      return null;
    }
  }

  extractUsage(body: unknown): TokenUsage {
    const resp = body as OpenAICompletionResponse;
    const usage = resp.usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      cost: 0,
      duration: 0,
    };
  }

  mapThinkingLevel(level: ThinkingLevel): unknown {
    return mapThinkingLevel(this.type, level, this.config.models[0]);
  }

  buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
      ...this.config.extraHeaders,
    };
  }
}
