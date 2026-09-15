/**
 * @oa/memory — Integration Fix
 *
 * Additional exports and type bridges needed by other packages.
 * Ensures interface alignment across the monorepo.
 */

import type {
  MemoryTier,
  MemoryType,
  MemoryScope,
  MemoryEntry,
  RecallOptions,
  RecallOutcome,
  MemoryLayerConfig,
} from './types';

// ---------------------------------------------------------------------------
// Re-exports for cross-package compatibility
// ---------------------------------------------------------------------------

export type {
  MemoryTier,
  MemoryType,
  MemoryScope,
  MemoryEntry,
  RecallOptions,
  RecallOutcome,
  MemoryLayerConfig,
};

export { MemoryTier, MemoryType, MemoryScope, PersistenceMode, RecallMode } from './types';

// ---------------------------------------------------------------------------
// MemoryTier constants and helpers
// ---------------------------------------------------------------------------

export const MEMORY_TIERS = {
  WORKING: MemoryTier.WORKING,
  SHORT_TERM_RECALL: MemoryTier.SHORT_TERM_RECALL,
  LONG_TERM: MemoryTier.LONG_TERM,
  SEMANTIC: MemoryTier.SEMANTIC,
  WIKI: MemoryTier.WIKI,
  DREAMING: MemoryTier.DREAMING,
} as const;

/**
 * Tier ordering in the hierarchy (bottom to top).
 */
export const TIER_HIERARCHY: MemoryTier[] = [
  MemoryTier.WORKING,
  MemoryTier.SHORT_TERM_RECALL,
  MemoryTier.LONG_TERM,
  MemoryTier.SEMANTIC,
  MemoryTier.WIKI,
  MemoryTier.DREAMING,
];

/**
 * Check if a string is a valid MemoryTier.
 */
export function isMemoryTier(value: string): value is MemoryTier {
  return Object.values(MemoryTier).includes(value as MemoryTier);
}

/**
 * Parse a MemoryTier from a string.
 */
export function parseMemoryTier(value: string): MemoryTier {
  if (isMemoryTier(value)) {
    return value;
  }
  throw new Error(`Invalid MemoryTier: ${value}`);
}

/**
 * Compare two memory tiers by hierarchy position.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareMemoryTier(a: MemoryTier, b: MemoryTier): number {
  return TIER_HIERARCHY.indexOf(a) - TIER_HIERARCHY.indexOf(b);
}

/**
 * Get the next tier in the hierarchy (for promotion).
 * Returns null if already at the top tier.
 */
export function getNextTier(tier: MemoryTier): MemoryTier | null {
  const index = TIER_HIERARCHY.indexOf(tier);
  if (index === -1 || index >= TIER_HIERARCHY.length - 1) {
    return null;
  }
  return TIER_HIERARCHY[index + 1];
}

/**
 * Get the previous tier in the hierarchy (for demotion).
 * Returns null if already at the bottom tier.
 */
export function getPreviousTier(tier: MemoryTier): MemoryTier | null {
  const index = TIER_HIERARCHY.indexOf(tier);
  if (index <= 0) {
    return null;
  }
  return TIER_HIERARCHY[index - 1];
}

// ---------------------------------------------------------------------------
// MemoryType helpers
// ---------------------------------------------------------------------------

export const MEMORY_TYPES = {
  CONVERSATION: MemoryType.CONVERSATION,
  PREFERENCE: MemoryType.PREFERENCE,
  FACT: MemoryType.FACT,
  PROJECT: MemoryType.PROJECT,
  IDENTITY: MemoryType.IDENTITY,
  TASK: MemoryType.TASK,
  PATTERN: MemoryType.PATTERN,
  LINK: MemoryType.LINK,
} as const;

/**
 * Check if a string is a valid MemoryType.
 */
export function isMemoryType(value: string): value is MemoryType {
  return Object.values(MemoryType).includes(value as MemoryType);
}

/**
 * Parse a MemoryType from a string.
 */
export function parseMemoryType(value: string): MemoryType {
  if (isMemoryType(value)) {
    return value;
  }
  throw new Error(`Invalid MemoryType: ${value}`);
}

// ---------------------------------------------------------------------------
// MemoryScope helpers
// ---------------------------------------------------------------------------

export const MEMORY_SCOPES = {
  GLOBAL: MemoryScope.GLOBAL,
  SESSION: MemoryScope.SESSION,
  USER: MemoryScope.USER,
  PROJECT: MemoryScope.PROJECT,
} as const;

/**
 * Check if a string is a valid MemoryScope.
 */
export function isMemoryScope(value: string): value is MemoryScope {
  return Object.values(MemoryScope).includes(value as MemoryScope);
}

// ---------------------------------------------------------------------------
// MemoryEntry helpers
// ---------------------------------------------------------------------------

/**
 * Create a new MemoryEntry with default values.
 */
export function createMemoryEntry(
  content: string,
  tier: MemoryTier,
  type: MemoryType,
  scope: MemoryScope,
  sessionId: string
): MemoryEntry {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    tier,
    type,
    scope,
    sessionId,
    content,
    embedding: new Float32Array(0),
    keywords: [],
    importance: 0.5,
    hitCount: 0,
    createdAt: now,
    accessedAt: now,
    expiresAt: null,
    source: 'manual',
    archived: false,
    metadata: {},
  };
}

/**
 * Check if a memory entry is expired.
 */
export function isMemoryEntryExpired(entry: MemoryEntry): boolean {
  if (entry.expiresAt === null) {
    return false;
  }
  return Date.now() > entry.expiresAt;
}

// ---------------------------------------------------------------------------
// RecallOptions defaults
// ---------------------------------------------------------------------------

export const DEFAULT_RECALL_OPTIONS: RecallOptions = {
  limit: 10,
  minScore: 0.3,
  mmrLambda: 0.7,
  includeDriftWarnings: false,
  overFetchMultiplier: 4,
  trackHits: true,
  decayWeight: 0.5,
};

/**
 * Merge RecallOptions with defaults.
 */
export function mergeRecallOptions(options?: RecallOptions): RecallOptions {
  return { ...DEFAULT_RECALL_OPTIONS, ...options };
}

// ---------------------------------------------------------------------------
// Bridge types for agent-loop integration
// ---------------------------------------------------------------------------

/**
 * Convert MemoryEntry to agent-loop MemoryItem format.
 */
export function toAgentLoopMemoryItem(entry: MemoryEntry): {
  id: string;
  content: string;
  type: 'fact' | 'preference' | 'context' | 'instruction';
  relevance: number;
  timestamp: number;
} {
  return {
    id: entry.id,
    content: entry.content,
    type: entry.type === MemoryType.PREFERENCE ? 'preference' as const :
          entry.type === MemoryType.FACT ? 'fact' as const :
          entry.type === MemoryType.TASK ? 'instruction' as const :
          'context' as const,
    relevance: entry.importance,
    timestamp: entry.createdAt,
  };
}

/**
 * Convert agent-loop MemoryItem to MemoryEntry format.
 */
export function fromAgentLoopMemoryItem(
  item: { id: string; content: string; type: string; relevance: number; timestamp: number },
  sessionId: string
): MemoryEntry {
  const now = Date.now();
  return {
    id: item.id,
    tier: MemoryTier.LONG_TERM,
    type: item.type === 'preference' ? MemoryType.PREFERENCE :
          item.type === 'fact' ? MemoryType.FACT :
          item.type === 'instruction' ? MemoryType.TASK :
          MemoryType.CONVERSATION,
    scope: MemoryScope.SESSION,
    sessionId,
    content: item.content,
    embedding: new Float32Array(0),
    keywords: [],
    importance: item.relevance,
    hitCount: 0,
    createdAt: item.timestamp,
    accessedAt: now,
    expiresAt: null,
    source: 'agent-loop',
    archived: false,
    metadata: {},
  };
}
