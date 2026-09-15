/**
 * Google Gemini provider adapter.
 *
 * Supports Gemini 2.x models with thinking mode, tool calling, and
 * multimodal input.
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

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
  file_data?: { mime_type: string; file_uri: string };
  function_call?: { name: string; args: Record<string, unknown> };
  function_response?: { name: string; response: Record<string, unknown> };
  thought?: boolean;
}

interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

interface GeminiRequestBody {
  contents: GeminiContent[];
  system_instruction?: { parts: GeminiPart[] };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    stopSequences?: string[];
    responseMimeType?: string;
    responseSchema?: Record<string, unknown>;
  };
  tools?: Array<{ functionDeclarations: GeminiFunctionDecl[] }>;
  toolConfig?: { functionCallingConfig: { mode: string; allowedFunctionNames?: string[] } };
  thinkingConfig?: { includeThoughts: boolean; thinkingBudget: number };
}

interface GeminiFunctionDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiResponse {
  candidates: Array<{
    content: {
      role: string;
      parts: GeminiPart[];
    };
    finishReason: string;
    index: number;
  }>;
  modelVersion: string;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
    thoughtsTokenCount?: number;
  };
}

/**
 * Build the default Google provider config.
 */
export function createGoogleConfig(
  apiKey: string,
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id: 'google',
    type: 'google',
    apiKey,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    timeout: 120_000,
    maxRetries: 5,
    enabled: true,
    priority: 15,
    models: [
      {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        contextWindow: 1_048_576,
        maxTokens: 8192,
        inputTypes: ['text', 'image', 'audio', 'video'],
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
        supportsVision: true,
        costPer1mTokens: { input: 1.25, output: 10 },
        status: 'active',
      },
      {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        contextWindow: 1_048_576,
        maxTokens: 8192,
        inputTypes: ['text', 'image', 'audio', 'video'],
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: true,
        supportsVision: true,
        costPer1mTokens: { input: 0.15, output: 0.6 },
        status: 'active',
      },
      {
        id: 'gemini-2.0-flash',
        name: 'Gemini 2.0 Flash',
        contextWindow: 1_048_576,
        maxTokens: 8192,
        inputTypes: ['text', 'image', 'audio', 'video'],
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: false,
        supportsVision: true,
        costPer1mTokens: { input: 0.1, output: 0.4 },
        status: 'active',
      },
    ],
    ...overrides,
  } as ProviderConfig;
}

/**
 * Convert unified messages to Google Gemini format.
 */
function convertMessages(
  messages: LlmMessage[],
): { contents: GeminiContent[]; systemParts: GeminiPart[] } {
  const contents: GeminiContent[] = [];
  const systemParts: GeminiPart[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') {
        systemParts.push({ text: msg.content });
      } else {
        for (const block of msg.content) {
          const part = convertContentBlockToPart(block);
          if (part) systemParts.push(part);
        }
      }
      continue;
    }

    const role = msg.role === 'assistant' ? 'model' : msg.role === 'tool' ? 'user' : msg.role;
    const parts: GeminiPart[] = [];

    if (typeof msg.content === 'string') {
      if (msg.content) parts.push({ text: msg.content });
    } else {
      for (const block of msg.content) {
        const part = convertContentBlockToPart(block);
        if (part) parts.push(part);
      }
    }

    // Convert tool calls to function_call parts.
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        try {
          const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          parts.push({ function_call: { name: tc.function.name, args } });
        } catch {
          parts.push({
            function_call: { name: tc.function.name, args: {} },
          });
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  return { contents, systemParts };
}

function convertContentBlockToPart(block: ContentBlock): GeminiPart | null {
  switch (block.type) {
    case 'text':
      return { text: block.text };
    case 'image':
      if (block.source.type === 'base64') {
        return { inline_data: { mime_type: block.source.mediaType, data: block.source.data! } };
      }
      return { file_data: { mime_type: block.source.mediaType, file_uri: block.source.url! } };
    case 'tool_result':
      return {
        function_response: {
          name: '',
          response: { output: block.content },
        },
      };
    case 'thinking':
      return { text: block.thinking, thought: true };
    default:
      return null;
  }
}

/**
 * Map Gemini finish reason to unified StopReason.
 */
function mapFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
      return 'content_filter';
    case 'RECITATION':
      return 'content_filter';
    case 'TOOL_CODE':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

export class GoogleAdapter implements ProviderAdapter {
  readonly id: string;
  readonly type = 'google' as const;
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.config = config;
  }

  buildRequestBody(request: LlmRequest, _model: ModelConfig): GeminiRequestBody {
    const { contents, systemParts } = convertMessages(request.messages);

    const body: GeminiRequestBody = {
      contents,
      generationConfig: {},
    };

    if (systemParts.length > 0) {
      body.system_instruction = { parts: systemParts };
    }

    const genConfig = body.generationConfig!;
    if (request.temperature !== undefined) genConfig.temperature = request.temperature;
    if (request.maxTokens) genConfig.maxOutputTokens = request.maxTokens;
    if (request.topP !== undefined) genConfig.topP = request.topP;
    if (request.stopSequences) genConfig.stopSequences = request.stopSequences;

    if (request.responseFormat === 'json_object') {
      genConfig.responseMimeType = 'application/json';
    } else if (request.responseFormat === 'json_schema' && request.jsonSchema) {
      genConfig.responseMimeType = 'application/json';
      genConfig.responseSchema = request.jsonSchema;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          })),
        },
      ];
    }

    if (request.toolChoice) {
      if (typeof request.toolChoice === 'string') {
        body.toolConfig = {
          functionCallingConfig: { mode: request.toolChoice.toUpperCase() },
        };
      } else {
        body.toolConfig = {
          functionCallingConfig: {
            mode: 'ALLOWED',
            allowedFunctionNames: [request.toolChoice.function.name],
          },
        };
      }
    }

    if (request.thinking) {
      const thinkingParams = mapThinkingLevel(this.type, request.thinking, _model) as {
        thinkingConfig: { includeThoughts: boolean; thinkingBudget: number };
      };
      body.thinkingConfig = thinkingParams.thinkingConfig;
    }

    return body;
  }

  getEndpoint(streaming: boolean): string {
    const modelId = ':generateContent';
    const suffix = streaming ? ':streamGenerateContent?alt=sse' : modelId;
    return `${this.config.baseUrl}/models/${this.config.models[0].id}${suffix}&key=${this.config.apiKey}`;
  }

  parseResponse(body: unknown): LlmResponse {
    const resp = body as GeminiResponse;
    const candidate = resp.candidates?.[0];

    const toolCalls: ToolCall[] = [];
    let textContent = '';
    let reasoning = '';

    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.text && !part.thought) {
          textContent += part.text;
        }
        if (part.text && part.thought) {
          reasoning += part.text;
        }
        if (part.function_call) {
          toolCalls.push({
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: {
              name: part.function_call.name,
              arguments: JSON.stringify(part.function_call.args),
            },
          });
        }
      }
    }

    const message: LlmMessage = {
      role: 'assistant',
      content: textContent,
      toolCalls,
    };

    return {
      id: `gemini-${Date.now()}`,
      model: resp.modelVersion,
      providerId: this.id,
      message,
      toolCalls,
      usage: this.extractUsage(body),
      finishReason: mapFinishReason(candidate?.finishReason ?? null),
      reasoning,
    };
  }

  parseSseChunk(line: string): StreamChunk | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return null;

    const data = trimmed.slice(5).trim();

    try {
      const parsed = JSON.parse(data) as {
        candidates?: Array<{
          content: { role: string; parts: Array<{ text?: string; thought?: boolean; functionCall?: { name: string; args: Record<string, unknown> } }> };
          finishReason?: string;
        }>;
        usageMetadata?: {
          promptTokenCount: number;
          candidatesTokenCount: number;
          totalTokenCount: number;
          thoughtsTokenCount?: number;
        };
        modelVersion?: string;
      };

      const candidate = parsed.candidates?.[0];
      if (!candidate) {
        if (parsed.usageMetadata) {
          return {
            id: '',
            model: parsed.modelVersion ?? '',
            providerId: this.id,
            delta: {},
            usage: {
              promptTokens: parsed.usageMetadata.promptTokenCount,
              completionTokens: parsed.usageMetadata.candidatesTokenCount,
              totalTokens: parsed.usageMetadata.totalTokenCount,
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

      const toolCallDeltas: ToolCallDelta[] = [];
      let content: string | undefined;
      let reasoning: string | undefined;

      for (const part of candidate.content.parts) {
        if (part.text && !part.thought) {
          content = (content ?? '') + part.text;
        }
        if (part.text && part.thought) {
          reasoning = (reasoning ?? '') + part.text;
        }
        if (part.functionCall) {
          toolCallDeltas.push({
            index: 0,
            id: `call_${Date.now()}`,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args),
            },
          });
        }
      }

      return {
        id: '',
        model: parsed.modelVersion ?? '',
        providerId: this.id,
        delta: {
          role: 'assistant',
          content,
          reasoning,
          toolCalls: toolCallDeltas.length > 0 ? toolCallDeltas : undefined,
        },
        usage: null,
        finishReason: mapFinishReason(candidate.finishReason ?? null),
        done: candidate.finishReason !== undefined,
      };
    } catch {
      return null;
    }
  }

  extractUsage(body: unknown): TokenUsage {
    const resp = body as GeminiResponse;
    const usage = resp.usageMetadata ?? {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    };

    return {
      promptTokens: usage.promptTokenCount,
      completionTokens: usage.candidatesTokenCount,
      totalTokens: usage.totalTokenCount,
      cachedTokens: 0,
      cost: 0,
      duration: 0,
    };
  }

  mapThinkingLevel(level: ThinkingLevel): unknown {
    return mapThinkingLevel(this.type, level, this.config.models[0]);
  }

  buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...this.config.extraHeaders,
    };
  }
}
