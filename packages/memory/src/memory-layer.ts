/**
 * @oa/memory — Main MemoryLayer class
 * 
 * Orchestrates the full memory system:
 * - recall: Semantic recall with hybrid search
 * - extract: Extract memories from conversation
 * - inject: Inject relevant memories into context
 * - consolidate: Dream consolidation (idle background)
 * - promote: Promote memory to higher tier
 * - archive: Archive old memory
 * 
 * Subscribes to events via PluginManager for automatic operation.
 */

import {
  MemoryEntry,
  MemoryTier,
  MemoryType,
  MemoryScope,
  MemoryLayerConfig,
  PluginManager,
  RecallOptions,
  RecallOutcome,
  ExtractOptions,
  ExtractOutcome,
  InjectOutcome,
  ConsolidateOutcome,
  MemoryStats,
} from './types';
import { Embedder } from './embedder';
import { MemoryRepository, DatabaseAdapter } from './repository';
import { RecallEngine } from './recall-engine';
import { MemoryExtractor, Message } from './extractor';
import {
  getTierPolicy,
  shouldPromote,
  getNextTier,
  isTierExpired,
  TIER_HIERARCHY,
} from './tiers';

/** Generate a UUID v4 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * MemoryLayer — the main memory system facade.
 */
export class MemoryLayer {
  private embedder: Embedder;
  private repository: MemoryRepository;
  private recallEngine: RecallEngine;
  private extractor: MemoryExtractor;
  private config: Required<MemoryLayerConfig>;
  private pluginManager?: PluginManager;
  private unsubscribers: Array<() => void> = [];
  private consolidationRunning = false;
  private consolidationInterval?: ReturnType<typeof setInterval>;

  constructor(
    embedder: Embedder,
    repository: MemoryRepository,
    recallEngine: RecallEngine,
    extractor: MemoryExtractor,
    config: MemoryLayerConfig
  ) {
    this.embedder = embedder;
    this.repository = repository;
    this.recallEngine = recallEngine;
    this.extractor = extractor;
    this.config = {
      dbPath: config.dbPath,
      embeddingModel: config.embeddingModel ?? 'BAAI/bge-base-zh-v1.5',
      embeddingDimensions: config.embeddingDimensions ?? 768,
      embeddingCacheSize: config.embeddingCacheSize ?? 4096,
      extractionDebounceMs: config.extractionDebounceMs ?? 60000,
      defaultRecallLimit: config.defaultRecallLimit ?? 10,
      overFetchMultiplier: config.overFetchMultiplier ?? 4,
      mmrLambda: config.mmrLambda ?? 0.7,
      driftThresholdDays: config.driftThresholdDays ?? 90,
      decayHalfLifeDays: config.decayHalfLifeDays ?? 30,
      workspaceRoot: config.workspaceRoot ?? '',
      llmRefine: config.llmRefine ?? (async () => ''),
      pluginManager: config.pluginManager,
    };
    this.pluginManager = config.pluginManager;
  }

  /**
   * Initialize the memory layer and subscribe to events.
   */
  async initialize(): Promise<void> {
    // Subscribe to conversation events
    if (this.pluginManager) {
      const unsub1 = this.pluginManager.subscribe(
        'conversation:end',
        (payload) => this.onConversationEnd(payload as { sessionId: string; messages: Message[] })
      );
      const unsub2 = this.pluginManager.subscribe(
        'session:start',
        (payload) => this.onSessionStart(payload as { sessionId: string })
      );
      const unsub3 = this.pluginManager.subscribe(
        'session:end',
        (payload) => this.onSessionEnd(payload as { sessionId: string })
      );
      this.unsubscribers.push(unsub1, unsub2, unsub3);
    }

    // Start background consolidation
    this.startConsolidationLoop();
  }

  /**
   * Shutdown the memory layer.
   */
  async shutdown(): Promise<void> {
    // Unsubscribe from events
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    // Stop consolidation loop
    if (this.consolidationInterval) {
      clearInterval(this.consolidationInterval);
    }

    // Close database
    await this.repository.close();
  }

  /**
   * Semantic recall with hybrid search.
   */
  async recall(
    sessionId: string,
    query: string,
    options: RecallOptions = {}
  ): Promise<RecallOutcome> {
    return this.recallEngine.recall(sessionId, query, {
      ...options,
      limit: options.limit ?? this.config.defaultRecallLimit,
      overFetchMultiplier: options.overFetchMultiplier ?? this.config.overFetchMultiplier,
      mmrLambda: options.mmrLambda ?? this.config.mmrLambda,
      driftThresholdDays: options.driftThresholdDays ?? this.config.driftThresholdDays,
    });
  }

  /**
   * Extract memories from conversation.
   */
  async extract(
    sessionId: string,
    messages: Message[],
    options: ExtractOptions = {}
  ): Promise<ExtractOutcome> {
    return this.extractor.extract(sessionId, messages, options);
  }

  /**
   * Inject relevant memories into context.
   */
  async inject(
    sessionId: string,
    messages: Message[]
  ): Promise<InjectOutcome> {
    const result = await this.recallEngine.inject(sessionId, messages, {
      limit: this.config.defaultRecallLimit,
    });

    return {
      injected: result.entries,
      tokensUsed: result.tokensUsed,
      tiersUsed: result.tiersUsed,
      context: result.context,
    };
  }

  /**
   * Dream consolidation — runs during idle time.
   * Discovers patterns, promotes memories, creates links.
   */
  async consolidate(sessionId: string): Promise<ConsolidateOutcome> {
    const startTime = Date.now();

    if (this.consolidationRunning) {
      return {
        patterns: [],
        promoted: [],
        archived: [],
        linksCreated: 0,
        elapsedMs: 0,
      };
    }

    this.consolidationRunning = true;

    try {
      // Get recent memories for consolidation
      const sinceTimestamp = Date.now() - 24 * 60 * 60 * 1000; // Last 24h
      const recentMemories = await this.repository.getForConsolidation(sinceTimestamp);

      const patterns: MemoryEntry[] = [];
      const promoted: string[] = [];
      let linksCreated = 0;

      // Check for promotions
      for (const memory of recentMemories) {
        if (shouldPromote(memory.tier, memory.hitCount)) {
          const nextTier = getNextTier(memory.tier);
          if (nextTier) {
            await this.promote(memory.id);
            promoted.push(memory.id);
          }
        }
      }

      // Discover patterns (co-occurring themes)
      const patternsFound = await this.discoverPatterns(recentMemories);
      for (const pattern of patternsFound) {
        const [embedding] = await this.embedder.embed([pattern.content]);
        const entry = await this.repository.insert({
          tier: MemoryTier.DREAMING,
          type: MemoryType.PATTERN,
          scope: MemoryScope.SESSION,
          sessionId,
          content: pattern.content,
          embedding,
          keywords: pattern.keywords,
          importance: pattern.importance,
          hitCount: 0,
          createdAt: Date.now(),
          accessedAt: Date.now(),
          expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30d TTL
          source: 'consolidation',
          archived: false,
          metadata: { discoveredAt: Date.now() },
        });
        patterns.push(entry);
      }

      // Create links between related memories
      for (let i = 0; i < recentMemories.length; i++) {
        for (let j = i + 1; j < recentMemories.length; j++) {
          const similarity = this.cosineSim(
            recentMemories[i].embedding,
            recentMemories[j].embedding
          );
          if (similarity > 0.7) {
            await this.repository.createLink(
              recentMemories[i].id,
              recentMemories[j].id,
              'semantic',
              similarity
            );
            linksCreated++;
          }
        }
      }

      // Archive expired memories
      const expired = await this.repository.getExpired();
      const archived: string[] = [];
      for (const entry of expired) {
        await this.archive(entry.id);
        archived.push(entry.id);
      }

      return {
        patterns,
        promoted,
        archived,
        linksCreated,
        elapsedMs: Date.now() - startTime,
      };
    } finally {
      this.consolidationRunning = false;
    }
  }

  /**
   * Promote a memory to the next tier.
   */
  async promote(entryId: string): Promise<boolean> {
    const entry = await this.repository.getById(entryId);
    if (!entry) return false;

    const nextTier = getNextTier(entry.tier);
    if (!nextTier) return false; // Already at top tier

    const policy = getTierPolicy(nextTier);

    await this.repository.update(entryId, {
      tier: nextTier,
      hitCount: 0, // Reset hit count for new tier
      expiresAt:
        policy.ttlMs !== undefined && policy.ttlMs > 0
          ? Date.now() + policy.ttlMs
          : null,
    });

    return true;
  }

  /**
   * Archive a memory (soft delete).
   */
  async archive(entryId: string): Promise<boolean> {
    return this.repository.archive(entryId);
  }

  /**
   * Get memory statistics.
   */
  async getStats(): Promise<MemoryStats> {
    const totalEntries = await this.repository.getCount(false);
    const tierStats = await this.repository.getTierStats();
    const cacheStats = this.embedder.getCacheStats();

    return {
      totalEntries,
      totalLinks: 0, // Would need a count query
      tierStats,
      dbSizeBytes: 0, // Would need file size check
      cacheHitRate: cacheStats.hitRate,
    };
  }

  /**
   * Handle conversation end event.
   */
  private async onConversationEnd(payload: {
    sessionId: string;
    messages: Message[];
  }): Promise<void> {
    await this.extract(payload.sessionId, payload.messages);
  }

  /**
   * Handle session start event.
   */
  private async onSessionStart(payload: { sessionId: string }): Promise<void> {
    // Could pre-load relevant memories here
  }

  /**
   * Handle session end event.
   */
  private async onSessionEnd(payload: { sessionId: string }): Promise<void> {
    // Run consolidation at session end
    await this.consolidate(payload.sessionId);
    this.extractor.resetSession(payload.sessionId);
  }

  /**
   * Start background consolidation loop.
   */
  private startConsolidationLoop(): void {
    // Run consolidation every 5 minutes
    this.consolidationInterval = setInterval(async () => {
      try {
        // Get all active sessions and consolidate
        // This is a simplified version — production would track active sessions
        await this.consolidate('global');
      } catch (error) {
        console.error('[MemoryLayer] Consolidation error:', error);
      }
    }, 5 * 60 * 1000);
  }

  /**
   * Discover patterns in memories.
   */
  private async discoverPatterns(
    memories: MemoryEntry[]
  ): Promise<Array<{ content: string; importance: number; keywords: string[] }>> {
    if (memories.length < 3) return [];

    const patterns: Array<{ content: string; importance: number; keywords: string[] }> = [];

    // Group by type
    const byType = new Map<MemoryType, MemoryEntry[]>();
    for (const m of memories) {
      if (!byType.has(m.type)) byType.set(m.type, []);
      byType.get(m.type)!.push(m);
    }

    // Find types with multiple entries (potential pattern)
    for (const [type, entries] of byType) {
      if (entries.length >= 3) {
        // Extract common keywords
        const keywordCounts = new Map<string, number>();
        for (const entry of entries) {
          for (const kw of entry.keywords) {
            keywordCounts.set(kw, (keywordCounts.get(kw) ?? 0) + 1);
          }
        }

        const commonKeywords = [...keywordCounts.entries()]
          .filter(([, count]) => count >= 2)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([kw]) => kw);

        if (commonKeywords.length > 0) {
          patterns.push({
            content: `Pattern: User frequently discusses ${type.toLowerCase()} topics: ${commonKeywords.join(', ')}`,
            importance: 0.6,
            keywords: commonKeywords,
          });
        }
      }
    }

    return patterns;
  }

  /**
   * Cosine similarity between two vectors.
   */
  private cosineSim(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }
}

/**
 * Factory function to create a MemoryLayer instance.
 */
export async function createMemoryLayer(
  config: MemoryLayerConfig,
  dbAdapter?: DatabaseAdapter
): Promise<MemoryLayer> {
  // Create components
  const embedder = new Embedder({
    modelName: config.embeddingModel,
    dimensions: config.embeddingDimensions,
    cacheSize: config.embeddingCacheSize,
  });
  await embedder.initialize();

  // Create repository with provided or default adapter
  const repository = new MemoryRepository(
    dbAdapter ?? (await createDefaultDatabaseAdapter(config.dbPath)),
    config.embeddingDimensions ?? 768
  );
  await repository.initialize();

  // Create recall engine
  const recallEngine = new RecallEngine(embedder, repository, {
    overFetchMultiplier: config.overFetchMultiplier,
    mmrLambda: config.mmrLambda,
    driftThresholdDays: config.driftThresholdDays,
    decayHalfLifeDays: config.decayHalfLifeDays,
  });

  // Create extractor
  const extractor = new MemoryExtractor(embedder, repository, {
    debounceMs: config.extractionDebounceMs,
    llmRefine: config.llmRefine,
  });

  // Create and return the memory layer
  const layer = new MemoryLayer(embedder, repository, recallEngine, extractor, config);
  await layer.initialize();

  return layer;
}

/**
 * Create a default SQLite database adapter.
 */
async function createDefaultDatabaseAdapter(dbPath: string): Promise<DatabaseAdapter> {
  // In production, this would import better-sqlite3 or similar
  // For now, return a placeholder that throws on use
  throw new Error(
    'No database adapter provided. Pass a DatabaseAdapter to createMemoryLayer() or implement createDefaultDatabaseAdapter()'
  );
}
