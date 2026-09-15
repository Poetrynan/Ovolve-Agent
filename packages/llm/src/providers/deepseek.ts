/**
 * DeepSeek provider adapter.
 *
 * DeepSeek's API is OpenAI-compatible with minor differences. Supports
 * DeepSeek-V3 and DeepSeek-R1 (reasoning) models.
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

interface DeepSeekMessage {
  role: string;
  content: string | DeepSeekContentBlock[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: DeepSeekToolCall[];
  reasoning_content?: string | null;
}

type DeepSeekContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface DeepSeekToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface DeepSeekRequestBody {
  model: string;
  messages: DeepSeekMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: DeepSeekTool[];
  tool_choice?: string | object;
  response_format?: { type: string };
  stop?: string[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
}

interface DeepSeekTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface DeepSeekResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: DeepSeekToolCall[];
      reasoning_content?: string | null;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

/**
 * Build the default DeepSeek provider config.
 */
export function createDeepSeekConfig(
  apiKey: string,
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id: 'deepseek',
    type: 'deepseek',
    apiKey,
    baseUrl: 'https://api.deepseek.com/v1',
    timeout: 120_000,
    maxRetries: 5,
    enabled: true,
    priority: 20,
    models: [
      {
        id: 'deepseek-chat',
        name: 'DeepSeek V3',
        contextWindow: 64_000,
        maxTokens: 8192,
        inputTypes: ['text'],
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: false,
        supportsVision: false,
        costPer1mTokens: { input: 0.27, output: 1.1 },
        status: 'active',
      },
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek R1',
        contextWindow: 64_000,
        maxTokens: 8192,
        inputTypes: ['text'],
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
        supportsVision: false,
        costPer1mTokens: { input: 0.55, output: 2.19 },
        status: 'active',
      },
    ],
    ...overrides,
  } as ProviderConfig;
}

function convertMessages(messages: LlmMessage[]): DeepSeekMessage[] {
  const result: DeepSeekMessage[] = [];

  for (const msg of messages) {
    const out: DeepSeekMessage = { role: msg.role, content: '' };

    if (typeof msg.content === 'string') {
      out.content = msg.content;
    } else {
      out.content = msg.content
        .filter((b) => b.type === 'text' || b.type === 'image')
        .map((b) => {
          if (b.type === 'text') return { type: 'text' as const, text: b.text };
          return {
            type: 'image_url' as const,
            image_url: {
              url:
                b.source.type === 'url'
                  ? b.source.url!
                  : `data:${b.source.mediaType};base64,${b.source.data}`,
            },
          };
        });
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

export class DeepSeekAdapter implements ProviderAdapter {
  readonly id: string;
  readonly type = 'deepseek' as const;
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.config = config;
  }

  buildRequestBody(request: LlmRequest, model: ModelConfig): DeepSeekRequestBody {
    const body: DeepSeekRequestBody = {
      model: request.model,
      messages: convertMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens) body.max_tokens = request.maxTokens;
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

    if (request.responseFormat === 'json_object') {
      body.response_format = { type: 'json_object' };
    }

    // DeepSeek R1 models always reason; no explicit thinking parameter needed.
    if (request.thinking && model.supportsThinking) {
      const thinkingParams = mapThinkingLevel(this.type, request.thinking, model) as {
        thinking_budget?: number;
      };
      // DeepSeek R1 handles thinking internally.
    }

    return body;
  }

  getEndpoint(_streaming: boolean): string {
    return `${this.config.baseUrl}/chat/completions`;
  }

  parseResponse(body: unknown): LlmResponse {
    const resp = body as DeepSeekResponse;
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
      reasoning: choice.message.reasoning_content ?? '',
    };
  }

  parseSseChunk(line: string): StreamChunk | null {
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
            reasoning_content?: string | null;
          };
          finish_reason?: string | null;
        }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          prompt_cache_hit_tokens?: number;
        };
      };

      const choice = parsed.choices?.[0];
      if (!choice) {
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
              cachedTokens: parsed.usage.prompt_cache_hit_tokens ?? 0,
              cost: 0,
              duration: 0,
            },
            finishReason: null,
            done: false,
          };
        }
        return null;
      }

      const toolCallDeltas: ToolCallDelta[] = (choice.delta.tool_calls ?? []).map((tc) => ({
        index: tc.index,
        id: tc.id,
        type: tc.type as 'function' | undefined,
        function: tc.function
          ? { name: tc.function.name, arguments: tc.function.arguments }
          : undefined,
      }));

      return {
        id: parsed.id,
        model: parsed.model,
        providerId: this.id,
        delta: {
          role: choice.delta.role as 'assistant' | undefined,
          content: choice.delta.content,
          toolCalls: toolCallDeltas.length > 0 ? toolCallDeltas : undefined,
          reasoning: choice.delta.reasoning_content,
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
    const resp = body as DeepSeekResponse;
    const usage = resp.usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      cachedTokens: usage.prompt_cache_hit_tokens ?? 0,
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
