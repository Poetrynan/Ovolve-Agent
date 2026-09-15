/**
 * Cache Stats & Waste Diagnostics — minimal agent runtime Architecture
 * Calculates cache read/write efficiency, token waste detection, and dollar cost savings.
 */

export const CACHE_TTL_MS = 5 * 60 * 1000;
const NOISE_FLOOR_TOKENS = 1024;

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export interface AssistantMessageMeta {
  id: string;
  role: 'assistant';
  provider: string;
  model: string;
  timestamp: number;
  usage: TokenUsage;
}

export interface CacheMiss {
  missedTokens: number;
  missedCost: number;
  idleMs: number;
  modelChanged: boolean;
}

export interface CacheWasteTotals {
  missedTokens: number;
  missedCost: number;
  missCount: number;
  totalSavedTokens: number;
  totalSavedDollars: number;
}

export interface ModelPriceSource {
  getModel(provider: string, modelId: string): { cost: { input: number; cacheRead: number; cacheWrite: number } } | undefined;
}

interface PreviousRequest {
  promptTokens: number;
  modelKey: string;
  timestamp: number;
  reportedCache: boolean;
}

/**
 * Default fallback price matrix ($ per million tokens)
 */
export const DEFAULT_MODEL_PRICES: Record<string, { input: number; cacheRead: number; cacheWrite: number }> = {
  'deepseek-chat': { input: 0.14, cacheRead: 0.014, cacheWrite: 0.14 },
  'deepseek-reasoner': { input: 0.55, cacheRead: 0.14, cacheWrite: 0.55 },
  'claude-3-7-sonnet': { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'gpt-4o': { input: 2.5, cacheRead: 1.25, cacheWrite: 2.5 },
};

export class DefaultModelPriceSource implements ModelPriceSource {
  getModel(_provider: string, modelId: string) {
    const key = Object.keys(DEFAULT_MODEL_PRICES).find((k) => modelId.toLowerCase().includes(k.toLowerCase()));
    if (key) return { cost: DEFAULT_MODEL_PRICES[key] };
    return { cost: { input: 0.2, cacheRead: 0.02, cacheWrite: 0.2 } };
  }
}

/**
 * Detect cache miss on a single assistant message
 */
export function detectMiss(
  prev: PreviousRequest | undefined,
  message: AssistantMessageMeta,
  models: ModelPriceSource = new DefaultModelPriceSource()
): CacheMiss | undefined {
  const usage = message.usage;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) {
    return undefined;
  }

  const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
  if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

  const paidTokens = usage.input + usage.cacheWrite;
  const paidPerToken =
    usage.cost && paidTokens > 0
      ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens
      : ((models.getModel(message.provider, message.model)?.cost.input ?? 0.2) / 1_000_000);

  const readPerToken =
    usage.cost && usage.cacheRead > 0
      ? usage.cost.cacheRead / usage.cacheRead
      : ((models.getModel(message.provider, message.model)?.cost.cacheRead ?? 0.02) / 1_000_000);

  return {
    missedTokens,
    missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
    idleMs: Math.max(0, message.timestamp - prev.timestamp),
    modelChanged: `${message.provider}/${message.model}` !== prev.modelKey,
  };
}

/**
 * Calculate total session cache efficiency and waste totals
 */
export function computeSessionCacheStats(
  messages: AssistantMessageMeta[],
  models: ModelPriceSource = new DefaultModelPriceSource()
): CacheWasteTotals {
  let prev: PreviousRequest | undefined;
  const totals: CacheWasteTotals = {
    missedTokens: 0,
    missedCost: 0,
    missCount: 0,
    totalSavedTokens: 0,
    totalSavedDollars: 0,
  };

  for (const msg of messages) {
    // Accumulate total saved tokens & cost
    if (msg.usage.cacheRead > 0) {
      totals.totalSavedTokens += msg.usage.cacheRead;
      const modelCost = models.getModel(msg.provider, msg.model)?.cost;
      const inputRate = modelCost?.input ?? 0.2;
      const readRate = modelCost?.cacheRead ?? 0.02;
      totals.totalSavedDollars += (msg.usage.cacheRead * (inputRate - readRate)) / 1_000_000;
    }

    const miss = detectMiss(prev, msg, models);
    if (miss) {
      totals.missedTokens += miss.missedTokens;
      totals.missedCost += miss.missedCost;
      totals.missCount += 1;
    }

    const usage = msg.usage;
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    if (promptTokens > 0) {
      prev = {
        promptTokens,
        modelKey: `${msg.provider}/${msg.model}`,
        timestamp: msg.timestamp,
        reportedCache: prev?.reportedCache || usage.cacheRead + usage.cacheWrite > 0,
      };
    }
  }

  return totals;
}
