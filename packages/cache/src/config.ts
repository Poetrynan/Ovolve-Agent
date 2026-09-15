/**
 * OvolveAgent Cache Configuration
 * 
 * All cache optimization switches in one place.
 * All optimizations are enabled by default for best performance.
 * Disable any optimization if issues arise.
 */

export interface CacheConfig {
  /**
   * Semantic Embedding Cache
   * Paper: vCache (ICLR 2026) - 12.5x hit rate improvement
   * Default: true
   */
  semanticCache: {
    enabled: boolean;
    /** Similarity threshold (0-1). Higher = stricter match. Default: 0.85 */
    threshold: number;
  };

  /**
   * Attention Sink (Compaction)
   * Paper: StreamingLLM - LLM attention is highest at start and end (U-curve)
   * Default: true
   */
  attentionSink: {
    enabled: boolean;
    /** Number of first messages to preserve. Default: 2 */
    keepFirstCount: number;
    /** Number of recent messages to preserve. Default: 4 */
    keepRecentCount: number;
  };

  /**
   * Prompt Prefix Cache
   * Paper: OpenAI Prompt Caching, IC-Cache (2024)
   * Default: true
   */
  promptCache: {
    enabled: boolean;
    /** Number of early conversation turns to include in cacheable prefix. Default: 3 */
    prefixTurns: number;
    /** Minimum token count for prefix to be eligible. Default: 1000 */
    minPrefixTokens: number;
  };
}

/**
 * Default cache configuration - all optimizations enabled
 */
export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  semanticCache: {
    enabled: true,
    threshold: 0.85,
  },
  attentionSink: {
    enabled: true,
    keepFirstCount: 2,
    keepRecentCount: 4,
  },
  promptCache: {
    enabled: true,
    prefixTurns: 3,
    minPrefixTokens: 1000,
  },
};

/**
 * Example: Disable all optimizations (fallback to baseline)
 */
export const BASELINE_CACHE_CONFIG: CacheConfig = {
  semanticCache: { enabled: false, threshold: 0.85 },
  attentionSink: { enabled: false, keepFirstCount: 0, keepRecentCount: 4 },
  promptCache: { enabled: false, prefixTurns: 0, minPrefixTokens: 1000 },
};

/**
 * Example: Aggressive caching (maximum performance)
 */
export const AGGRESSIVE_CACHE_CONFIG: CacheConfig = {
  semanticCache: { enabled: true, threshold: 0.75 },
  attentionSink: { enabled: true, keepFirstCount: 3, keepRecentCount: 6 },
  promptCache: { enabled: true, prefixTurns: 5, minPrefixTokens: 500 },
};
