/**
 * Custom OpenAI-compatible provider adapter.
 *
 * Allows connecting to any OpenAI-compatible API endpoint (local LLMs,
 * proxies, vLM, Ollama in OpenAI mode, etc.)
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

interface CustomMessage {
  role: string;
  content: string | CustomContentBlock[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: CustomToolCall[];
}

type CustomContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface CustomToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface CustomRequestBody {
  model: string;
  messages: CustomMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: CustomTool[];
  tool_choice?: string | object;
  response_format?: { type: string };
  stop?: string[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  [key: string]: unknown;
}

interface CustomTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface CustomResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: CustomToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Build a custom provider config.
 */
export function createCustomConfig(
  id: string,
  apiKey: string,
  baseUrl: string,
  models: ModelConfig[],
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id,
    type: 'custom',
    apiKey,
    baseUrl,
    timeout: 120_000,
    maxRetries: 5,
    enabled: true,
    priority: 50,
    models,
    ...overrides,
  } as ProviderConfig;
}

function convertMessages(messages: LlmMessage[]): CustomMessage[] {
  return messages.map((msg) => {
    const out: CustomMessage = { role: msg.role, content: '' };

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

    return out;
  });
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

export class CustomAdapter implements ProviderAdapter {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly config: ProviderConfig;
  private extraParams: Record<string, unknown>;

  constructor(config: ProviderConfig, extraParams: Record<string, unknown> = {}) {
    this.id = config.id;
    this.config = config;
    this.extraParams = extraParams;
  }

  buildRequestBody(request: LlmRequest, _model: ModelConfig): CustomRequestBody {
    const body: CustomRequestBody = {
      model: request.model,
      messages: convertMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...this.extraParams,
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

    return body;
  }

  getEndpoint(_streaming: boolean): string {
    const base = this.config.baseUrl.replace(/\/$/, '');
    return `${base}/chat/completions`;
  }

  parseResponse(body: unknown): LlmResponse {
    const resp = body as CustomResponse;
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
      reasoning: '',
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
          };
          finish_reason?: string | null;
        }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
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
              cachedTokens: 0,
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
    const resp = body as CustomResponse;
    const usage = resp.usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      cachedTokens: 0,
      cost: 0,
      duration: 0,
    };
  }

  mapThinkingLevel(_level: ThinkingLevel): unknown {
    return { thinking_level: _level };
  }

  buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    return { ...headers, ...this.config.extraHeaders };
  }
}
