/**
 * AWS Bedrock provider adapter.
 *
 * Supports Anthropic Claude, Amazon Nova, and other models through the
 * Bedrock Converse API with streaming support.
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

interface BedrockContentBlock {
  text?: string;
  image?: { format: string; source: { bytes: string } };
  toolUse?: { toolUseId: string; name: string; input: Record<string, unknown> };
  toolResult?: { toolUseId: string; content: Array<{ text: string }>; status?: string };
  reasoningContent?: { reasoningText: { text: string; signature?: string } };
}

interface BedrockMessage {
  role: string;
  content: BedrockContentBlock[];
}

interface BedrockRequestBody {
  modelId: string;
  messages: BedrockMessage[];
  system?: Array<{ text: string }>;
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };
  toolConfig?: {
    tools?: Array<{
      toolSpec: { name: string; description: string; inputSchema: { json: Record<string, unknown> } };
    }>;
    toolChoice?: { auto?: object; any?: object; tool?: { name: string } };
  };
  additionalModelRequestFields?: Record<string, unknown>;
}

interface BedrockResponse {
  output: {
    message: {
      role: string;
      content: BedrockContentBlock[];
    };
  };
  stopReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  modelId: string;
}

/**
 * Build the default Bedrock provider config.
 */
export function createBedrockConfig(
  apiKey: string,
  region: string = 'us-east-1',
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id: 'bedrock',
    type: 'bedrock',
    apiKey,
    baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
    region,
    timeout: 120_000,
    maxRetries: 5,
    enabled: true,
    priority: 25,
    models: [
      {
        id: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
        name: 'Claude 4 Sonnet (Bedrock)',
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
        id: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        name: 'Claude 3.5 Sonnet (Bedrock)',
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
        id: 'amazon.nova-pro-v1:0',
        name: 'Nova Pro',
        contextWindow: 300_000,
        maxTokens: 5120,
        inputTypes: ['text', 'image', 'video'],
        supportsStreaming: true,
        supportsTools: true,
        supportsThinking: false,
        supportsVision: true,
        costPer1mTokens: { input: 0.8, output: 3.2 },
        status: 'active',
      },
    ],
    ...overrides,
  } as ProviderConfig;
}

function convertMessages(messages: LlmMessage[]): { converted: BedrockMessage[]; systemBlocks: Array<{ text: string }> } {
  const converted: BedrockMessage[] = [];
  const systemBlocks: Array<{ text: string }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') {
        systemBlocks.push({ text: msg.content });
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') systemBlocks.push({ text: block.text });
        }
      }
      continue;
    }

    const content: BedrockContentBlock[] = [];

    if (typeof msg.content === 'string') {
      if (msg.content) content.push({ text: msg.content });
    } else {
      for (const block of msg.content) {
        const bc = convertContentBlock(block);
        if (bc) content.push(bc);
      }
    }

    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        try {
          const input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          content.push({ toolUse: { toolUseId: tc.id, name: tc.function.name, input } });
        } catch {
          content.push({
            toolUse: { toolUseId: tc.id, name: tc.function.name, input: {} },
          });
        }
      }
    }

    if (content.length > 0) {
      converted.push({ role: msg.role, content });
    }
  }

  return { converted, systemBlocks };
}

function convertContentBlock(block: ContentBlock): BedrockContentBlock | null {
  switch (block.type) {
    case 'text':
      return { text: block.text };
    case 'image':
      return {
        image: {
          format: block.source.mediaType.split('/')[1] ?? 'png',
          source: { bytes: block.source.data ?? '' },
        },
      };
    case 'tool_result':
      return {
        toolResult: {
          toolUseId: block.toolUseId,
          content: [{ text: block.content }],
          status: block.isError ? 'error' : 'success',
        },
      };
    default:
      return null;
  }
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'content_filtered':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export class BedrockAdapter implements ProviderAdapter {
  readonly id: string;
  readonly type = 'bedrock' as const;
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.config = config;
  }

  buildRequestBody(request: LlmRequest, model: ModelConfig): BedrockRequestBody {
    const { converted, systemBlocks } = convertMessages(request.messages);

    const body: BedrockRequestBody = {
      modelId: request.model,
      messages: converted,
    };

    if (systemBlocks.length > 0) {
      body.system = systemBlocks;
    }

    body.inferenceConfig = {};
    if (request.maxTokens) body.inferenceConfig.maxTokens = request.maxTokens;
    if (request.temperature !== undefined) body.inferenceConfig.temperature = request.temperature;
    if (request.topP !== undefined) body.inferenceConfig.topP = request.topP;
    if (request.stopSequences) body.inferenceConfig.stopSequences = request.stopSequences;

    if (request.tools && request.tools.length > 0) {
      body.toolConfig = {
        tools: request.tools.map((t) => ({
          toolSpec: {
            name: t.function.name,
            description: t.function.description,
            inputSchema: { json: t.function.parameters },
          },
        })),
      };

      if (request.toolChoice) {
        if (typeof request.toolChoice === 'string') {
          const mode = request.toolChoice.toUpperCase();
          if (mode === 'AUTO') body.toolConfig.toolChoice = { auto: {} };
          else if (mode === 'ANY') body.toolConfig.toolChoice = { any: {} };
        } else {
          body.toolConfig.toolChoice = { tool: { name: request.toolChoice.function.name } };
        }
      }
    }

    // Add thinking config for supported models.
    if (request.thinking && model.supportsThinking) {
      const thinkingParams = mapThinkingLevel(this.type, request.thinking, model) as {
        thinking: { type: string; budget_tokens: number };
      };
      body.additionalModelRequestFields = {
        thinking: thinkingParams.thinking,
      };
    }

    return body;
  }

  getEndpoint(streaming: boolean): string {
    const suffix = streaming ? '-with-response-stream' : '';
    return `${this.config.baseUrl}/model/${this.config.models[0].id}/invoke${suffix}`;
  }

  parseResponse(body: unknown): LlmResponse {
    const resp = body as BedrockResponse;
    const msg = resp.output.message;

    const toolCalls: ToolCall[] = [];
    let textContent = '';
    let reasoning = '';

    for (const block of msg.content) {
      if (block.text) textContent += block.text;
      if (block.toolUse) {
        toolCalls.push({
          id: block.toolUse.toolUseId,
          type: 'function',
          function: {
            name: block.toolUse.name,
            arguments: JSON.stringify(block.toolUse.input),
          },
        });
      }
      if (block.reasoningContent) {
        reasoning += block.reasoningContent.reasoningText.text;
      }
    }

    const message: LlmMessage = {
      role: 'assistant',
      content: textContent,
      toolCalls,
    };

    return {
      id: `bedrock-${Date.now()}`,
      model: resp.modelId,
      providerId: this.id,
      message,
      toolCalls,
      usage: this.extractUsage(body),
      finishReason: mapStopReason(resp.stopReason),
      reasoning,
    };
  }

  parseSseChunk(line: string): StreamChunk | null {
    // Bedrock uses a JSON streaming format with headers.
    const trimmed = line.trim();

    // Skip chunk headers (hex length + headers).
    if (trimmed.startsWith(':')) return null;
    if (/^[0-9a-fA-F]+$/.test(trimmed)) return null;

    // Extract JSON payload after the headers.
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart === -1) return null;

    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart)) as {
        messageStart?: { role: string };
        contentBlockStart?: {
          start?: { toolUse?: { toolUseId: string; name: string } };
          contentBlockIndex: number;
        };
        contentBlockDelta?: {
          delta?: {
            text?: string;
            toolUse?: { input: string };
            reasoningContent?: { text: string };
          };
          contentBlockIndex: number;
        };
        contentBlockStop?: { contentBlockIndex: number };
        messageStop?: { stopReason: string };
        metadata?: {
          usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
        };
      };

      if (parsed.messageStart) {
        return {
          id: '',
          model: '',
          providerId: this.id,
          delta: { role: 'assistant' },
          usage: null,
          finishReason: null,
          done: false,
        };
      }

      if (parsed.contentBlockDelta) {
        const delta = parsed.contentBlockDelta.delta;
        const toolCallDeltas: ToolCallDelta[] = [];

        if (delta?.toolUse?.input) {
          toolCallDeltas.push({
            index: parsed.contentBlockDelta.contentBlockIndex,
            function: { arguments: delta.toolUse.input },
          });
        }

        return {
          id: '',
          model: '',
          providerId: this.id,
          delta: {
            content: delta?.text,
            reasoning: delta?.reasoningContent?.text,
            toolCalls: toolCallDeltas.length > 0 ? toolCallDeltas : undefined,
          },
          usage: null,
          finishReason: null,
          done: false,
        };
      }

      if (parsed.messageStop) {
        return {
          id: '',
          model: '',
          providerId: this.id,
          delta: {},
          usage: null,
          finishReason: mapStopReason(parsed.messageStop.stopReason),
          done: true,
        };
      }

      if (parsed.metadata?.usage) {
        const u = parsed.metadata.usage;
        return {
          id: '',
          model: '',
          providerId: this.id,
          delta: {},
          usage: {
            promptTokens: u.inputTokens,
            completionTokens: u.outputTokens,
            totalTokens: u.totalTokens,
            cachedTokens: 0,
            cost: 0,
            duration: 0,
          },
          finishReason: null,
          done: false,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  extractUsage(body: unknown): TokenUsage {
    const resp = body as BedrockResponse;
    const usage = resp.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    return {
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
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
      Authorization: `Bearer ${this.config.apiKey}`,
      ...this.config.extraHeaders,
    };
  }
}
