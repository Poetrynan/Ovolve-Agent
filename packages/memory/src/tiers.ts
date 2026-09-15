/**
 * @oa/memory — Six-tier policy definitions
 * 
 * Tiers ordered by priority (lowest to highest):
 * WORKING → SHORT_TERM_RECALL → LONG_TERM → SEMANTIC → WIKI → DREAMING
 * 
 * Promotion is hit-count driven: each tier has a promotionThreshold
 * that must be reached before the memory advances to the next tier.
 */

import {
  MemoryTier,
  TierPolicy,
  PersistenceMode,
  RecallMode,
} from './types';

/**
 * WORKING tier — Turn-scoped, no persistence.
 * Holds the current conversation context.
 * Evicted immediately after turn ends.
 */
const WORKING_POLICY: TierPolicy = {
  tier: MemoryTier.WORKING,
  persistence: PersistenceMode.NONE,
  tokenBudget: 600,
  trust: 0.9,
  recallMode: RecallMode.ALWAYS,
  promotionThreshold: 0, // Cannot promote from working (it's ephemeral)
  nextTier: MemoryTier.SHORT_TERM_RECALL,
  decayEnabled: false,
  decayHalfLifeDays: 0,
};

/**
 * SHORT_TERM_RECALL tier — 12h TTL, on-demand.
 * Holds recent memories from the current session.
 * Auto-expires after 12 hours.
 */
const SHORT_TERM_RECALL_POLICY: TierPolicy = {
  tier: MemoryTier.SHORT_TERM_RECALL,
  persistence: PersistenceMode.TTL,
  ttlMs: 12 * 60 * 60 * 1000, // 12 hours
  tokenBudget: 1200,
  trust: 0.85,
  recallMode: RecallMode.ON_DEMAND,
  promotionThreshold: 3, // 3 hits promotes to LONG_TERM
  nextTier: MemoryTier.LONG_TERM,
  decayEnabled: true,
  decayHalfLifeDays: 6, // Short half-life for recent memories
};

/**
 * LONG_TERM tier — Permanent, 2500 token budget.
 * Core persistent memories with highest trust.
 * This is the primary knowledge store.
 */
const LONG_TERM_POLICY: TierPolicy = {
  tier: MemoryTier.LONG_TERM,
  persistence: PersistenceMode.PERMANENT,
  tokenBudget: 2500,
  trust: 1.0,
  recallMode: RecallMode.ON_DEMAND,
  promotionThreshold: 5, // 5 hits promotes to SEMANTIC
  nextTier: MemoryTier.SEMANTIC,
  decayEnabled: true,
  decayHalfLifeDays: 60, // Longer half-life for important memories
};

/**
 * SEMANTIC tier — Permanent, on-demand.
 * Conceptually linked memories for associative recall.
 * Enables finding related memories across contexts.
 */
const SEMANTIC_POLICY: TierPolicy = {
  tier: MemoryTier.SEMANTIC,
  persistence: PersistenceMode.PERMANENT,
  tokenBudget: 1500,
  trust: 0.8,
  recallMode: RecallMode.ON_DEMAND,
  promotionThreshold: 8, // 8 hits promotes to WIKI
  nextTier: MemoryTier.WIKI,
  decayEnabled: false, // Semantic links don't decay
  decayHalfLifeDays: 0,
};

/**
 * WIKI tier — Permanent, on-demand.
 * Curated, verified knowledge with highest long-term trust.
 * These are the "facts" the system knows about the user/project.
 */
const WIKI_POLICY: TierPolicy = {
  tier: MemoryTier.WIKI,
  persistence: PersistenceMode.PERMANENT,
  tokenBudget: 2000,
  trust: 0.9,
  recallMode: RecallMode.ON_DEMAND,
  promotionThreshold: 10, // 10 hits promotes to DREAMING
  nextTier: MemoryTier.DREAMING,
  decayEnabled: false, // Wiki facts are permanent
  decayHalfLifeDays: 0,
};

/**
 * DREAMING tier — 30d TTL, on-demand.
 * Patterns discovered during consolidation (dreaming).
 * Lower trust because they're inferred, not explicitly stated.
 * Auto-expires after 30 days unless re-validated.
 */
const DREAMING_POLICY: TierPolicy = {
  tier: MemoryTier.DREAMING,
  persistence: PersistenceMode.TTL,
  ttlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  tokenBudget: 1000,
  trust: 0.55,
  recallMode: RecallMode.ON_DEMAND,
  promotionThreshold: 0, // Top tier — no promotion
  nextTier: null,
  decayEnabled: true,
  decayHalfLifeDays: 15, // Inferred patterns decay faster
};

/** Ordered map of all tier policies */
export const TIER_POLICIES: Record<MemoryTier, TierPolicy> = {
  [MemoryTier.WORKING]: WORKING_POLICY,
  [MemoryTier.SHORT_TERM_RECALL]: SHORT_TERM_RECALL_POLICY,
  [MemoryTier.LONG_TERM]: LONG_TERM_POLICY,
  [MemoryTier.SEMANTIC]: SEMANTIC_POLICY,
  [MemoryTier.WIKI]: WIKI_POLICY,
  [MemoryTier.DREAMING]: DREAMING_POLICY,
};

/** Ordered tier hierarchy for iteration */
export const TIER_HIERARCHY: MemoryTier[] = [
  MemoryTier.WORKING,
  MemoryTier.SHORT_TERM_RECALL,
  MemoryTier.LONG_TERM,
  MemoryTier.SEMANTIC,
  MemoryTier.WIKI,
  MemoryTier.DREAMING,
];

/**
 * Get policy for a specific tier.
 */
export function getTierPolicy(tier: MemoryTier): TierPolicy {
  return TIER_POLICIES[tier];
}

/**
 * Check if a tier is expired based on its TTL policy.
 */
export function isTierExpired(tier: MemoryTier, createdAt: number): boolean {
  const policy = TIER_POLICIES[tier];
  if (policy.persistence !== PersistenceMode.TTL || !policy.ttlMs) {
    return false;
  }
  const now = Date.now();
  return now - createdAt > policy.ttlMs;
}

/**
 * Calculate time decay factor for a memory entry.
 * Uses exponential decay: factor = 2^(-age_days / half_life_days)
 * 
 * @param ageDays - Age of the memory in days
 * @param halfLifeDays - Half-life in days from tier policy
 * @returns Decay factor between 0 and 1
 */
export function calculateDecayFactor(ageDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0 || ageDays <= 0) {
    return 1.0;
  }
  return Math.pow(2, -ageDays / halfLifeDays);
}

/**
 * Check if a memory should be promoted based on hit count.
 * 
 * @param tier - Current tier
 * @param hitCount - Current hit count
 * @returns True if promotion criteria met
 */
export function shouldPromote(tier: MemoryTier, hitCount: number): boolean {
  const policy = TIER_POLICIES[tier];
  if (!policy.nextTier) {
    return false; // Already at top tier
  }
  return hitCount >= policy.promotionThreshold;
}

/**
 * Get the next tier in the hierarchy.
 */
export function getNextTier(tier: MemoryTier): MemoryTier | null {
  return TIER_POLICIES[tier].nextTier;
}

/**
 * Calculate total token budget across all tiers.
 */
export function getTotalTokenBudget(): number {
  return TIER_HIERARCHY.reduce((sum, tier) => sum + TIER_POLICIES[tier].tokenBudget, 0);
}

/**
 * Get tiers sorted by trust level (highest first).
 */
export function getTiersByTrust(): MemoryTier[] {
  return [...TIER_HIERARCHY].sort(
    (a, b) => TIER_POLICIES[b].trust - TIER_POLICIES[a].trust
  );
}

/**
 * Get all tiers that support on-demand recall.
 */
export function getOnDemandTiers(): MemoryTier[] {
  return TIER_HIERARCHY.filter(
    (tier) => TIER_POLICIES[tier].recallMode === RecallMode.ON_DEMAND
  );
}

/**
 * Get all tiers that are always loaded.
 */
export function getAlwaysRecallTiers(): MemoryTier[] {
  return TIER_HIERARCHY.filter(
    (tier) => TIER_POLICIES[tier].recallMode === RecallMode.ALWAYS
  );
}
