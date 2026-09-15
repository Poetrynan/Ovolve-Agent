/**
 * @oa/memory — Public exports
 * 
 * Memory system based on Ovolve's 6-tier hierarchy with semantic recall.
 * Tiers: WORKING → SHORT_TERM_RECALL → LONG_TERM → SEMANTIC → WIKI → DREAMING
 */

// Types
export {
  MemoryTier,
  MemoryType,
  MemoryScope,
  PersistenceMode,
  RecallMode,
  TierPolicy,
  MemoryEntry,
  RecallOptions,
  RecallResult,
  RecallOutcome,
  DriftWarning,
  ExtractOptions,
  ExtractOutcome,
  MemoryLink,
  InjectOutcome,
  ConsolidateOutcome,
  MemoryLayerConfig,
  PluginManager,
  SearchCandidate,
  TierStats,
  MemoryStats,
} from './types';

// Tier policies
export {
  TIER_POLICIES,
  TIER_HIERARCHY,
  getTierPolicy,
  isTierExpired,
  calculateDecayFactor,
  shouldPromote,
  getNextTier,
  getTotalTokenBudget,
  getTiersByTrust,
  getOnDemandTiers,
  getAlwaysRecallTiers,
} from './tiers';

// Embedding engine
export {
  Embedder,
  EmbeddingProvider,
  EmbedderConfig,
  l2Normalize,
  cosineSimilarity,
} from './embedder';

// Database repository
export {
  MemoryRepository,
  DatabaseAdapter,
  SQLiteConfig,
} from './repository';

// Recall engine
export {
  RecallEngine,
  extractKeywords,
} from './recall-engine';

// Extractor
export {
  MemoryExtractor,
  Message as ExtractorMessage,
} from './extractor';

// Main MemoryLayer class and factory
export {
  MemoryLayer,
  createMemoryLayer,
} from './memory-layer';
