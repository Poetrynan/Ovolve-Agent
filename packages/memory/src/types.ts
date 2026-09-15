/**
 * @oa/memory — Type definitions
 * 
 * Ovolve's 6-tier memory hierarchy with semantic recall.
 * Tiers: WORKING → SHORT_TERM_RECALL → LONG_TERM → SEMANTIC → WIKI → DREAMING
 * Promotion is hit-count driven (not time driven).
 */

/** The six memory tiers in the hierarchy */
export enum MemoryTier {
  /** Turn-scoped, no persistence, 600 token budget */
  WORKING = 'WORKING',
  /** 12h TTL, on-demand recall, trust 0.85 */
  SHORT_TERM_RECALL = 'SHORT_TERM_RECALL',
  /** Permanent, 2500 token budget, trust 1.0 */
  LONG_TERM = 'LONG_TERM',
  /** Permanent, on-demand, trust 0.8 */
  SEMANTIC = 'SEMANTIC',
  /** Permanent, on-demand, trust 0.9 */
  WIKI = 'WIKI',
  /** 30d TTL, on-demand, trust 0.55 */
  DREAMING = 'DREAMING',
}

/** Memory content classification */
export enum MemoryType {
  /** Raw conversation turn */
  CONVERSATION = 'CONVERSATION',
  /** User preference or setting */
  PREFERENCE = 'PREFERENCE',
  /** Fact extracted from conversation */
  FACT = 'FACT',
  /** Project-specific knowledge */
  PROJECT = 'PROJECT',
  /** User identity information */
  IDENTITY = 'IDENTITY',
  /** Task or todo item */
  TASK = 'TASK',
  /** Pattern recognized during dreaming */
  PATTERN = 'PATTERN',
  /** Link between two memories */
  LINK = 'LINK',
}

/** Scope of a memory — who owns it */
export enum MemoryScope {
  /** Shared across all sessions */
  GLOBAL = 'GLOBAL',
  /** Tied to a specific session */
  SESSION = 'SESSION',
  /** Tied to a specific user */
  USER = 'USER',
  /** Tied to a specific project */
  PROJECT = 'PROJECT',
}

/** Persistence mode for a tier */
export enum PersistenceMode {
  /** Never persisted, memory is lost after session */
  NONE = 'NONE',
  /** Persisted with TTL, auto-expires */
  TTL = 'TTL',
  /** Persisted permanently */
  PERMANENT = 'PERMANENT',
}

/** Recall trigger mode */
export enum RecallMode {
  /** Always loaded at context construction */
  ALWAYS = 'ALWAYS',
  /** Loaded only when query matches */
  ON_DEMAND = 'ON_DEMAND',
}

/** Policy configuration for a single tier */
export interface TierPolicy {
  /** The tier this policy governs */
  tier: MemoryTier;
  /** Persistence mode */
  persistence: PersistenceMode;
  /** TTL in milliseconds (only for TTL persistence) */
  ttlMs?: number;
  /** Maximum tokens this tier can consume in context window */
  tokenBudget: number;
  /** Trust level for memories at this tier (0-1) */
  trust: number;
  /** How this tier is recalled */
  recallMode: RecallMode;
  /** Number of hits before promotion to next tier */
  promotionThreshold: number;
  /** Next tier in hierarchy (null for top tier) */
  nextTier: MemoryTier | null;
  /** Whether decay applies to this tier */
  decayEnabled: boolean;
  /** Decay half-life in days (default 30) */
  decayHalfLifeDays: number;
}

/** A single memory entry stored in the database */
export interface MemoryEntry {
  /** Unique identifier (UUID) */
  id: string;
  /** The memory tier */
  tier: MemoryTier;
  /** Memory content type */
  type: MemoryType;
  /** Who owns this memory */
  scope: MemoryScope;
  /** Session ID this memory belongs to */
  sessionId: string;
  /** The actual memory content */
  content: string;
  /** Vector embedding (768-dim for bge-base-zh-v1.5) */
  embedding: Float32Array;
  /** Keywords extracted from content for FTS5 */
  keywords: string[];
  /** Importance score (0-1) */
  importance: number;
  /** Number of times accessed */
  hitCount: number;
  /** Creation timestamp */
  createdAt: number;
  /** Last access timestamp */
  accessedAt: number;
  /** Expiration timestamp (for TTL tiers) */
  expiresAt: number | null;
  /** Source of extraction */
  source: string;
  /** Whether this memory is archived */
  archived: boolean;
  /** Metadata for extensibility */
  metadata: Record<string, unknown>;
}

/** Options for recall operation */
export interface RecallOptions {
  /** Maximum number of results to return */
  limit?: number;
  /** Tiers to search (default: all) */
  tiers?: MemoryTier[];
  /** Minimum similarity threshold (0-1) */
  minScore?: number;
  /** MMR diversity parameter (0 = max diversity, 1 = max relevance) */
  mmrLambda?: number;
  /** Whether to include drift warnings */
  includeDriftWarnings?: boolean;
  /** Over-fetch multiplier (default 4x) */
  overFetchMultiplier?: number;
  /** Whether to update hit counts */
  trackHits?: boolean;
  /** Time decay weight factor (0-1) */
  decayWeight?: number;
}

/** Result of a single recall hit */
export interface RecallResult {
  /** The memory entry */
  entry: MemoryEntry;
  /** Relevance score after all weighting */
  score: number;
  /** Raw vector similarity */
  vectorScore: number;
  /** FTS5 keyword match score */
  keywordScore: number;
  /** Combined hybrid score before MMR */
  hybridScore: number;
  /** Time decay factor applied */
  decayFactor: number;
  /** Days since creation */
  ageDays: number;
  /** Drift warning flag */
  driftWarning: boolean;
  /** Whether this was promoted during recall */
  promoted: boolean;
}

/** Result of recall operation */
export interface RecallOutcome {
  /** Ranked results */
  results: RecallResult[];
  /** Total candidates considered */
  totalCandidates: number;
  /** Drift warnings detected */
  driftWarnings: DriftWarning[];
  /** Promotions that occurred */
  promotions: string[];
  /** Query embedding used */
  queryEmbedding: Float32Array;
  /** Keywords extracted from query */
  keywords: string[];
  /** Time taken in milliseconds */
  elapsedMs: number;
}

/** Drift warning for old memories */
export interface DriftWarning {
  /** Memory ID */
  entryId: string;
  /** Days since creation */
  ageDays: number;
  /** Warning message */
  message: string;
}

/** Options for extraction */
export interface ExtractOptions {
  /** Whether to use LLM for refinement (vs heuristic only) */
  useLLM?: boolean;
  /** Minimum importance to extract */
  minImportance?: number;
  /** Types to extract (default: all) */
  types?: MemoryType[];
  /** Whether to create links between extracted memories */
  createLinks?: boolean;
}

/** Result of extraction */
export interface ExtractOutcome {
  /** Memories created */
  created: MemoryEntry[];
  /** Links created */
  links: MemoryLink[];
  /** Raw extractions before dedup */
  rawCount: number;
  /** Deduplicated count */
  dedupedCount: number;
  /** Time taken in milliseconds */
  elapsedMs: number;
}

/** Link between two memories */
export interface MemoryLink {
  /** Link ID */
  id: string;
  /** Source memory ID */
  sourceId: string;
  /** Target memory ID */
  targetId: string;
  /** Link type */
  type: string;
  /** Link strength (0-1) */
  strength: number;
}

/** Result of injection */
export interface InjectOutcome {
  /** Memories injected */
  injected: MemoryEntry[];
  /** Total tokens consumed */
  tokensUsed: number;
  /** Tiers represented */
  tiersUsed: MemoryTier[];
  /** Formatted context string */
  context: string;
}

/** Result of consolidation */
export interface ConsolidateOutcome {
  /** Patterns discovered */
  patterns: MemoryEntry[];
  /** Memories promoted */
  promoted: string[];
  /** Memories archived */
  archived: string[];
  /** Links created */
  linksCreated: number;
  /** Time taken in milliseconds */
  elapsedMs: number;
}

/** Configuration for MemoryLayer */
export interface MemoryLayerConfig {
  /** Database file path */
  dbPath: string;
  /** Embedding model name (default: BAAI/bge-base-zh-v1.5) */
  embeddingModel?: string;
  /** Embedding dimensions (default: 768) */
  embeddingDimensions?: number;
  /** LRU cache size for embeddings (default: 4096) */
  embeddingCacheSize?: number;
  /** Extraction debounce in ms (default: 60000) */
  extractionDebounceMs?: number;
  /** Default recall limit */
  defaultRecallLimit?: number;
  /** Over-fetch multiplier (default: 4) */
  overFetchMultiplier?: number;
  /** MMR lambda (default: 0.7) */
  mmrLambda?: number;
  /** Drift warning threshold in days (default: 90) */
  driftThresholdDays?: number;
  /** Decay half-life in days (default: 30) */
  decayHalfLifeDays?: number;
  /** Workspace root for context */
  workspaceRoot?: string;
  /** LLM function for extraction refinement */
  llmRefine?: (prompt: string) => Promise<string>;
  /** Plugin manager for event subscription */
  pluginManager?: PluginManager;
}

/** Plugin manager interface for event subscription */
export interface PluginManager {
  subscribe(event: string, handler: (payload: unknown) => void): () => void;
  emit(event: string, payload: unknown): void;
}

/** Search candidate from hybrid search */
export interface SearchCandidate {
  entry: MemoryEntry;
  vectorScore: number;
  keywordScore: number;
  hybridScore: number;
}

/** Tier statistics */
export interface TierStats {
  tier: MemoryTier;
  count: number;
  totalTokens: number;
  avgImportance: number;
  avgHitCount: number;
}

/** Memory system statistics */
export interface MemoryStats {
  totalEntries: number;
  totalLinks: number;
  tierStats: TierStats[];
  dbSizeBytes: number;
  cacheHitRate: number;
}
