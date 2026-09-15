/**
 * @deprecated @orphan
 * [CRITICAL ARCHITECTURAL NOTICE]
 * This TypeScript implementation is an unwired orphan module not active in production.
 * Production reasoning/thinking configuration is handled authoritatively by the Python backend in
 * `app/backend/model_registry.py` (4 levels: off/low/high/max with declarative set/unset).
 *
 * DO NOT wire this module directly without resolving known vendor constraint violations:
 * - B1: Anthropic budget_tokens >= max_tokens violates strict `<` bound (e.g. medium=8192 on 8192 limit).
 * - B2: Anthropic temperature conflict (extended thinking strictly rejects temperature).
 * - B3: Google thinkingBudget exceeds Gemini 2.5 Pro ceiling (32768) at xhigh/max.
 * - B4: DeepSeek thinking parameters computed then dropped in deepseek.ts:237.
 * - B5: OpenAI minimal lacks model-family guard (sent to o3 where only gpt-5 accepts it).
 *
 * See docs/THINKING_LEVELS_DEV_GUIDE.md for the authoritative architecture.
 */

import type { ThinkingLevel, ProviderType, ModelConfig } from './types.js';

// ---------------------------------------------------------------------------
// Provider-specific parameter shapes
// ---------------------------------------------------------------------------

export interface OpenAIThinkingParams {
  reasoning_effort: 'minimal' | 'low' | 'medium' | 'high';
}

export interface AnthropicThinkingParams {
  thinking: {
    type: 'enabled';
    budget_tokens: number;
  };
}

export interface GoogleThinkingParams {
  thinkingConfig: {
    includeThoughts: boolean;
    thinkingBudget: number;
  };
}

export interface DeepSeekThinkingParams {
  thinking_budget: number;
}

export interface BedrockThinkingParams {
  thinking: {
    type: 'enabled';
    budget_tokens: number;
  };
}

export type ProviderThinkingParams =
  | OpenAIThinkingParams
  | AnthropicThinkingParams
  | GoogleThinkingParams
  | DeepSeekThinkingParams
  | BedrockThinkingParams
  | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Budget tables (tokens reserved for reasoning)
// ---------------------------------------------------------------------------

const OPENAI_REASONING_MAP: Record<ThinkingLevel, OpenAIThinkingParams['reasoning_effort']> = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

const ANTHROPIC_BUDGET_MAP: Record<ThinkingLevel, number> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 65536,
};

const GOOGLE_BUDGET_MAP: Record<ThinkingLevel, number> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 65536,
};

const DEEPSEEK_BUDGET_MAP: Record<ThinkingLevel, number> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 65536,
};

const BEDROCK_BUDGET_MAP: Record<ThinkingLevel, number> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 65536,
};

// ---------------------------------------------------------------------------
// Mapping functions
// ---------------------------------------------------------------------------

/**
 * Map a unified thinking level to provider-specific request parameters.
 */
export function mapThinkingLevel(
  provider: ProviderType,
  level: ThinkingLevel,
  model: ModelConfig,
): ProviderThinkingParams {
  // If the model doesn't support thinking, return empty.
  if (!model.supportsThinking) return {};

  switch (provider) {
    case 'openai':
      return { reasoning_effort: OPENAI_REASONING_MAP[level] };

    case 'anthropic':
      return {
        thinking: {
          type: 'enabled',
          budget_tokens: ANTHROPIC_BUDGET_MAP[level],
        },
      };

    case 'google':
      return {
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: GOOGLE_BUDGET_MAP[level],
        },
      };

    case 'deepseek':
      return {
        thinking_budget: DEEPSEEK_BUDGET_MAP[level],
      };

    case 'bedrock':
      return {
        thinking: {
          type: 'enabled',
          budget_tokens: BEDROCK_BUDGET_MAP[level],
        },
      };

    case 'azure':
      // Azure OpenAI mirrors OpenAI.
      return { reasoning_effort: OPENAI_REASONING_MAP[level] };

    case 'custom':
    default:
      // Custom providers: pass through as a generic parameter.
      return { thinking_level: level };
  }
}

/**
 * Check if a provider supports a given thinking level.
 */
export function supportsThinkingLevel(
  provider: ProviderType,
  level: ThinkingLevel,
  model: ModelConfig,
): boolean {
  if (!model.supportsThinking) return false;

  // OpenAI only supports up to 'high'.
  if (provider === 'openai' || provider === 'azure') {
    return level !== 'xhigh' && level !== 'max';
  }

  return true;
}

/**
 * Get the default thinking level for a provider.
 */
export function getDefaultThinkingLevel(provider: ProviderType): ThinkingLevel {
  switch (provider) {
    case 'openai':
    case 'azure':
      return 'medium';
    case 'anthropic':
      return 'medium';
    case 'google':
      return 'medium';
    case 'deepseek':
      return 'high';
    case 'bedrock':
      return 'medium';
    case 'custom':
    default:
      return 'medium';
  }
}
