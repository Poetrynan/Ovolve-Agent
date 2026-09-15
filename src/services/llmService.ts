/**
 * Real LLM Stream Client for DeepSeek / OpenAI compatible API
 * Zero Mock - Directly connects to configured endpoint & streaming completions
 */

import { useSettingsStore } from '../store/settingsStore';
import { useAgentStore } from '../store/agentStore';
import type { MessageData } from '../components/chat/MessageBubble';

export interface ChatCompletionChunk {
  id: string;
  choices: Array<{
    delta: {
      role?: string;
      content?: string;
      reasoning_content?: string;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

export async function sendRealLLMRequest({
  userPrompt,
  history,
  model = 'deepseek-chat',
  onChunk,
  onFinish,
  onError,
}: {
  userPrompt: string;
  history: MessageData[];
  model?: string;
  onChunk: (delta: string, reasoningDelta?: string) => void;
  onFinish: (
    fullContent: string,
    tokens: number,
    duration: number,
    reasoning?: string,
    usageDetails?: {
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
    }
  ) => void;
  onError: (error: string) => void;
}) {
  const { apiKey, baseUrl, temperature } = useSettingsStore.getState();

  // 1. Enforce API Key validation
  if (!apiKey || !apiKey.trim()) {
    onError(
      '【未配置 API Key】当前尚未配置有效的推理模型 API Key。\n请点击左下角【偏好设置 (Settings)】，填入您的 DeepSeek API Key（如 sk-...）以启动真实模型推理。'
    );
    return;
  }

  // Model name normalization based on endpoint provider
  let normalizedModel = model;
  const isSiliconFlow = baseUrl.includes('siliconflow');
  const isOfficialDeepSeek = baseUrl.includes('api.deepseek.com');

  if (isSiliconFlow) {
    if (model === 'DeepSeek-V3' || model === 'deepseek-chat') {
      normalizedModel = 'deepseek-ai/DeepSeek-V3.2';
    } else if (model === 'DeepSeek-R1' || model === 'deepseek-reasoner') {
      normalizedModel = 'deepseek-ai/DeepSeek-R1';
    } else if (model === 'deepseek-ai/DeepSeek-V3.2' || model.includes('/')) {
      normalizedModel = model;
    } else {
      normalizedModel = `deepseek-ai/${model}`;
    }
  } else if (isOfficialDeepSeek) {
    if (model.includes('V3') || model === 'DeepSeek-V3') normalizedModel = 'deepseek-chat';
    if (model.includes('R1') || model === 'DeepSeek-R1') normalizedModel = 'deepseek-reasoner';
  }

  // Construct message array
  const formattedMessages = [
    {
      role: 'system',
      content:
        'You are Ovolve Agent, an autonomous software engineering AI with deep code intelligence, multi-file reasoning, and production-grade coding skills. Be direct, precise, and practical.',
    },
    ...history.slice(-10).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    {
      role: 'user',
      content: userPrompt,
    },
  ];

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const startTime = Date.now();

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: normalizedModel,
        messages: formattedMessages,
        temperature: Math.max(0, Math.min(2, temperature || 0.2)),
        stream: true,
        stream_options: { include_usage: true },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      let parsedErr = errText;
      try {
        const json = JSON.parse(errText);
        parsedErr = json.error?.message || errText;
      } catch {
        // Use raw text
      }

      if (response.status === 401) {
        throw new Error(
          `API Key 鉴权失败 (401 Unauthorized)。请检查设置中的 DeepSeek API Key 是否正确。\n详细原因: ${parsedErr}`
        );
      } else if (response.status === 429) {
        throw new Error(
          `API 调用频次超限或账户余额不足 (429 Rate Limit / Quota Exceeded)。\n详细原因: ${parsedErr}`
        );
      } else {
        throw new Error(`API 请求失败 (HTTP ${response.status}): ${parsedErr}`);
      }
    }

    if (!response.body) {
      throw new Error('未收到服务器返回的数据流 (ReadableStream 为空)');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = '';
    let fullReasoning = '';
    let buffer = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') continue;

        if (trimmed.startsWith('data: ')) {
          try {
            const data: any = JSON.parse(trimmed.slice(6));
            if (data.usage) {
              promptTokens = data.usage.prompt_tokens || promptTokens;
              completionTokens = data.usage.completion_tokens || completionTokens;
              cachedTokens =
                data.usage.prompt_tokens_details?.cached_tokens ||
                data.usage.prompt_cache_hit_tokens ||
                0;
            }

            const delta = data.choices?.[0]?.delta;
            if (delta) {
              if (delta.reasoning_content) {
                fullReasoning += delta.reasoning_content;
                onChunk('', delta.reasoning_content);
              }
              if (delta.content) {
                fullText += delta.content;
                onChunk(delta.content, undefined);
              }
            }
          } catch {
            // Ignore parse errors on partial chunks
          }
        }
      }
    }

    const duration = Date.now() - startTime;
    if (promptTokens === 0) {
      promptTokens = Math.ceil(userPrompt.length / 3.5);
    }
    if (completionTokens === 0) {
      completionTokens = Math.ceil(fullText.length / 3.5);
    }
    const totalTokens = promptTokens + completionTokens;

    onFinish(fullText, totalTokens, duration, fullReasoning, {
      promptTokens,
      completionTokens,
      cachedTokens,
    });
  } catch (err: any) {
    onError(err.message || '网络连接失败，请检查 API Endpoint 地址与网络状态。');
  }
}
