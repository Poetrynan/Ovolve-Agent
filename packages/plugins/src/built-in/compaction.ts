/**
 * @oa/plugins — Auto-Fold (Compaction) Plugin (built-in)
 *
 * Monitors conversation context length and automatically triggers
 * folding (compaction) when the context window exceeds thresholds.
 * Supports multiple compaction strategies: summarize, truncate, and selective.
 */

import {
  IPlugin,
  PluginManifest,
  HookPoint,
  HookRegistry,
  PluginContext,
  HookHandler,
  RiskLevel,
  HealthStatus,
} from '../types';

/**
 * Compaction strategies.
 */
export enum CompactionStrategy {
  /** Replace old messages with a summary. */
  SUMMARIZE = 'SUMMARIZE',
  /** Drop oldest messages beyond a keep window. */
  TRUNCATE = 'TRUNCATE',
  /** Keep important messages, drop rest. */
  SELECTIVE = 'SELECTIVE',
  /** Combine adjacent messages from the same role. */
  MERGE = 'MERGE',
}

/**
 * Configuration for the compaction plugin.
 */
export interface CompactionConfig {
  /** Strategy to use for compaction. */
  strategy: CompactionStrategy;
  /** Token threshold that triggers compaction. */
  tokenThreshold: number;
  /** Number of recent messages to always preserve. */
  keepRecentCount: number;
  /** Minimum messages before compaction is allowed. */
  minMessages: number;
  /** Custom token counter function. */
  countTokens?: (text: string) => number;
  /** Custom summarizer function. */
  summarizer?: (messages: CompactionMessage[]) => Promise<string>;
  /** Whether to emit events when compaction occurs. */
  emitEvents: boolean;
}

/**
 * A message in the compaction context.
 */
export interface CompactionMessage {
  id: string;
  role: string;
  content: string;
  timestamp: Date;
  tokenCount: number;
  important?: boolean;
  toolCalls?: unknown[];
  toolCallId?: string;
}

/**
 * Payload for PRE_FOLD hook.
 */
export interface PreFoldPayload {
  messages: CompactionMessage[];
  currentTokenCount: number;
  threshold: number;
  strategy: CompactionStrategy;
}

/**
 * Payload for POST_FOLD hook.
 */
export interface PostFoldPayload {
  originalMessages: CompactionMessage[];
  compactedMessages: CompactionMessage[];
  removedCount: number;
  strategy: CompactionStrategy;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Result of a compaction operation.
 */
export interface CompactionResult {
  messages: CompactionMessage[];
  removedCount: number;
  tokensBefore: number;
  tokensAfter: number;
  strategy: CompactionStrategy;
}

/**
 * Default token counter (rough estimation: ~4 chars per token).
 */
function defaultCountTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: CompactionConfig = {
  strategy: CompactionStrategy.SUMMARIZE,
  tokenThreshold: 4000,
  keepRecentCount: 10,
  minMessages: 20,
  emitEvents: true,
};

/**
 * Compaction plugin implementation.
 */
export class CompactionPlugin implements IPlugin {
  readonly manifest: PluginManifest = {
    name: 'compaction',
    version: '1.0.0',
    description: 'Automatically compacts conversation context when it exceeds thresholds',
    author: 'OvolveAgent',
    hookPoints: [HookPoint.PRE_LLM_REQUEST, HookPoint.PRE_FOLD, HookPoint.POST_FOLD],
    riskLevel: RiskLevel.LOW,
  };

  private config: CompactionConfig;
  private compactionCount = 0;
  private lastCompactionAt?: Date;

  constructor(config: Partial<CompactionConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      countTokens: config.countTokens ?? defaultCountTokens,
      summarizer: config.summarizer,
    };
  }

  /**
   * Register hooks with the plugin system.
   */
  register(registry: HookRegistry, _context: PluginContext): void {
    // Check context size before each LLM request.
    const preLLMHandler: HookHandler<{ messages: CompactionMessage[]; metadata?: Record<string, unknown> }> = async (payload) => {
      return this.checkAndCompact(payload);
    };
    registry.on(HookPoint.PRE_LLM_REQUEST, preLLMHandler, 5);

    // Allow other plugins to modify compaction behavior.
    const preFoldHandler: HookHandler<PreFoldPayload> = async (payload) => {
      // Pass through — other plugins can modify strategy or payload.
      return payload;
    };
    registry.on(HookPoint.PRE_FOLD, preFoldHandler, 50);

    // Allow other plugins to react to compaction results.
    const postFoldHandler: HookHandler<PostFoldPayload> = async (payload) => {
      return payload;
    };
    registry.on(HookPoint.POST_FOLD, postFoldHandler, 50);
  }

  /**
   * Check if compaction is needed and execute it.
   */
  private async checkAndCompact(payload: {
    messages: CompactionMessage[];
    metadata?: Record<string, unknown>;
  }): Promise<typeof payload> {
    const { messages } = payload;
    if (messages.length < this.config.minMessages) {
      return payload;
    }

    // Calculate total tokens.
    const totalTokens = messages.reduce(
      (sum, msg) => sum + (msg.tokenCount || this.countTokens(msg.content)),
      0
    );

    if (totalTokens < this.config.tokenThreshold) {
      return payload;
    }

    // Emit pre-fold event.
    const preFoldPayload: PreFoldPayload = {
      messages,
      currentTokenCount: totalTokens,
      threshold: this.config.tokenThreshold,
      strategy: this.config.strategy,
    };

    // Perform compaction.
    const result = await this.compact(messages);

    if (result.removedCount === 0) {
      return payload;
    }

    // Track stats.
    this.compactionCount++;
    this.lastCompactionAt = new Date();

    // Emit post-fold event.
    const postFoldPayload: PostFoldPayload = {
      originalMessages: messages,
      compactedMessages: result.messages,
      removedCount: result.removedCount,
      strategy: result.strategy,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
    };

    return {
      ...payload,
      messages: result.messages,
      metadata: {
        ...payload.metadata,
        compacted: true,
        compactionCount: this.compactionCount,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      },
    };
  }

  /**
   * Execute compaction using the configured strategy.
   */
  async compact(messages: CompactionMessage[]): Promise<CompactionResult> {
    // Ensure token counts are populated.
    const enrichedMessages = messages.map((msg) => ({
      ...msg,
      tokenCount: msg.tokenCount || this.countTokens(msg.content),
    }));

    const tokensBefore = enrichedMessages.reduce((sum, m) => sum + m.tokenCount, 0);

    let result: CompactionResult;

    switch (this.config.strategy) {
      case CompactionStrategy.SUMMARIZE:
        result = await this.compactBySummarize(enrichedMessages);
        break;
      case CompactionStrategy.TRUNCATE:
        result = this.compactByTruncate(enrichedMessages);
        break;
      case CompactionStrategy.SELECTIVE:
        result = this.compactBySelective(enrichedMessages);
        break;
      case CompactionStrategy.MERGE:
        result = this.compactByMerge(enrichedMessages);
        break;
      default:
        result = await this.compactBySummarize(enrichedMessages);
    }

    return {
      ...result,
      tokensBefore,
      strategy: this.config.strategy,
    };
  }

  /**
   * Compact by summarizing older messages.
   */
  private async compactBySummarize(
    messages: CompactionMessage[]
  ): Promise<CompactionResult> {
    const keepStart = Math.max(0, messages.length - this.config.keepRecentCount);
    const toCompact = messages.slice(0, keepStart);
    const toKeep = messages.slice(keepStart);

    let summary: string;

    if (this.config.summarizer) {
      summary = await this.config.summarizer(toCompact);
    } else {
      // Default summary: extract key points from each message.
      const points = toCompact.map((msg) => {
        const preview = msg.content.slice(0, 100);
        return `[${msg.role}]: ${preview}${msg.content.length > 100 ? '...' : ''}`;
      });
      summary = `Previous conversation summary (${toCompact.length} messages):\n${points.join('\n')}`;
    }

    const summaryMessage: CompactionMessage = {
      id: `compact_summary_${Date.now()}`,
      role: 'system',
      content: summary,
      timestamp: new Date(),
      tokenCount: this.countTokens(summary),
    };

    const compactedMessages = [summaryMessage, ...toKeep];
    const tokensAfter = compactedMessages.reduce((sum, m) => sum + m.tokenCount, 0);

    return {
      messages: compactedMessages,
      removedCount: toCompact.length,
      tokensBefore: messages.reduce((sum, m) => sum + m.tokenCount, 0),
      tokensAfter,
      strategy: CompactionStrategy.SUMMARIZE,
    };
  }

  /**
   * Compact by truncating oldest messages.
   */
  private compactByTruncate(messages: CompactionMessage[]): CompactionResult {
    const keepStart = Math.max(0, messages.length - this.config.keepRecentCount);
    const removedCount = keepStart;
    const keptMessages = messages.slice(keepStart);
    const tokensAfter = keptMessages.reduce((sum, m) => sum + m.tokenCount, 0);

    return {
      messages: keptMessages,
      removedCount,
      tokensBefore: messages.reduce((sum, m) => sum + m.tokenCount, 0),
      tokensAfter,
      strategy: CompactionStrategy.TRUNCATE,
    };
  }

  /**
   * Compact by keeping important messages and recent ones.
   */
  private compactBySelective(messages: CompactionMessage[]): CompactionResult {
    const keepStart = Math.max(0, messages.length - this.config.keepRecentCount);
    const candidates = messages.slice(0, keepStart);
    const toKeep = messages.slice(keepStart);

    // Score messages by importance.
    const scored = candidates.map((msg) => {
      let score = msg.important ? 3 : 0;

      // Messages with tool calls are more important.
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        score += 2;
      }

      // User messages tend to be more important than assistant.
      if (msg.role === 'user') {
        score += 1;
      }

      // Longer messages might have more information.
      score += Math.min(2, msg.tokenCount / 500);

      return { msg, score };
    });

    // Keep top-scoring messages that fit within budget.
    scored.sort((a, b) => b.score - a.score);
    const tokenBudget = this.config.tokenThreshold * 0.4;
    let usedTokens = 0;
    const selected: CompactionMessage[] = [];

    for (const { msg } of scored) {
      if (usedTokens + msg.tokenCount <= tokenBudget) {
        selected.push(msg);
        usedTokens += msg.tokenCount;
      }
    }

    // Sort selected messages back to chronological order.
    selected.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const compactedMessages = [...selected, ...toKeep];
    const tokensAfter = compactedMessages.reduce((sum, m) => sum + m.tokenCount, 0);

    return {
      messages: compactedMessages,
      removedCount: candidates.length - selected.length,
      tokensBefore: messages.reduce((sum, m) => sum + m.tokenCount, 0),
      tokensAfter,
      strategy: CompactionStrategy.SELECTIVE,
    };
  }

  /**
   * Compact by merging adjacent messages from the same role.
   */
  private compactByMerge(messages: CompactionMessage[]): CompactionResult {
    const merged: CompactionMessage[] = [];

    for (const msg of messages) {
      const last = merged[merged.length - 1];
      if (last && last.role === msg.role && !last.toolCalls && !msg.toolCalls) {
        // Merge with previous message.
        last.content += '\n\n' + msg.content;
        last.tokenCount = this.countTokens(last.content);
      } else {
        merged.push({ ...msg });
      }
    }

    const tokensAfter = merged.reduce((sum, m) => sum + m.tokenCount, 0);

    return {
      messages: merged,
      removedCount: messages.length - merged.length,
      tokensBefore: messages.reduce((sum, m) => sum + m.tokenCount, 0),
      tokensAfter,
      strategy: CompactionStrategy.MERGE,
    };
  }

  /**
   * Count tokens in a text string.
   */
  private countTokens(text: string): number {
    return this.config.countTokens!(text);
  }

  /**
   * Get compaction statistics.
   */
  getStats(): { compactionCount: number; lastCompactionAt?: Date } {
    return {
      compactionCount: this.compactionCount,
      lastCompactionAt: this.lastCompactionAt,
    };
  }

  /**
   * Health check.
   */
  async onHealthCheck(): Promise<HealthStatus> {
    return {
      healthy: true,
      message: `Compaction active: ${this.compactionCount} compactions performed`,
      details: {
        compactionCount: this.compactionCount,
        lastCompactionAt: this.lastCompactionAt?.toISOString(),
        strategy: this.config.strategy,
      },
    };
  }
}

/**
 * Factory function to create a CompactionPlugin.
 */
export function createCompactionPlugin(config?: Partial<CompactionConfig>): CompactionPlugin {
  return new CompactionPlugin(config);
}
