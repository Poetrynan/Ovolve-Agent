/**
 * MemoryTiers.ts — Six-Tier Memory Hierarchy & Policy Matrix
 *
 * Implements C1 6-tier memory architecture:
 * 1. WORKING: In-process scratchpad, turn-scoped, non-persisted (600 token budget, always inject, trust 0.9)
 * 2. SHORT_TERM_RECALL: Session recall, 12h TTL, persisted in SQLite (on demand, trust 0.85)
 * 3. LONG_TERM: MEMORY.md, user-editable, hard capped at 2500 tokens (always inject, trust 1.0)
 * 4. SEMANTIC: Vector/lexical store, SQLite memory_entries, bulk store (on demand, trust 0.8)
 * 5. WIKI: Declarative claims with confidence + evidence (on demand, trust 0.9)
 * 6. DREAMING: Background consolidated insights, 30d TTL (on demand, trust 0.55)
 *
 * Total verbatim injection budget: 3100 tokens (Working 600 + Long-Term 2500).
 */

export enum MemoryTier {
  WORKING = 'working',
  SHORT_TERM_RECALL = 'short-term-recall',
  LONG_TERM = 'long-term',
  SEMANTIC = 'semantic',
  WIKI = 'wiki',
  DREAMING = 'dreaming',
}

export const TIER_ORDER: readonly MemoryTier[] = Object.freeze([
  MemoryTier.WORKING,
  MemoryTier.SHORT_TERM_RECALL,
  MemoryTier.LONG_TERM,
  MemoryTier.SEMANTIC,
  MemoryTier.WIKI,
  MemoryTier.DREAMING,
])

export interface TierPolicy {
  persisted: boolean
  ttlSeconds: number
  tokenBudget: number
  alwaysInject: boolean
  userEditable: boolean
  trust: number
  promoteAfterHits: number
  promoteTo?: MemoryTier
}

const HOUR = 3600
const DAY = 86400

export const TIER_POLICIES: Readonly<Record<MemoryTier, TierPolicy>> = Object.freeze({
  [MemoryTier.WORKING]: {
    persisted: false,
    ttlSeconds: 0,
    tokenBudget: 600,
    alwaysInject: true,
    userEditable: false,
    trust: 0.9,
    promoteAfterHits: 2,
    promoteTo: MemoryTier.SHORT_TERM_RECALL,
  },
  [MemoryTier.SHORT_TERM_RECALL]: {
    persisted: true,
    ttlSeconds: 12 * HOUR,
    tokenBudget: 0,
    alwaysInject: false,
    userEditable: false,
    trust: 0.85,
    promoteAfterHits: 3,
    promoteTo: MemoryTier.SEMANTIC,
  },
  [MemoryTier.LONG_TERM]: {
    persisted: true,
    ttlSeconds: 0,
    tokenBudget: 2500,
    alwaysInject: true,
    userEditable: true,
    trust: 1.0,
    promoteAfterHits: 0,
  },
  [MemoryTier.SEMANTIC]: {
    persisted: true,
    ttlSeconds: 0,
    tokenBudget: 0,
    alwaysInject: false,
    userEditable: false,
    trust: 0.8,
    promoteAfterHits: 8,
    promoteTo: MemoryTier.LONG_TERM,
  },
  [MemoryTier.WIKI]: {
    persisted: true,
    ttlSeconds: 0,
    tokenBudget: 0,
    alwaysInject: false,
    userEditable: true,
    trust: 0.9,
    promoteAfterHits: 0,
  },
  [MemoryTier.DREAMING]: {
    persisted: true,
    ttlSeconds: 30 * DAY,
    tokenBudget: 0,
    alwaysInject: false,
    userEditable: false,
    trust: 0.55,
    promoteAfterHits: 5,
    promoteTo: MemoryTier.SEMANTIC,
  },
})

export const ALWAYS_INJECT_TIERS: readonly MemoryTier[] = Object.freeze(
  TIER_ORDER.filter((t) => TIER_POLICIES[t].alwaysInject)
)

export const TOTAL_INJECT_BUDGET: number = ALWAYS_INJECT_TIERS.reduce(
  (sum, t) => sum + TIER_POLICIES[t].tokenBudget,
  0
)

export function policyFor(tier: MemoryTier | string): TierPolicy {
  if (typeof tier === 'string') {
    if (Object.values(MemoryTier).includes(tier as MemoryTier)) {
      return TIER_POLICIES[tier as MemoryTier]
    }
    return TIER_POLICIES[MemoryTier.SEMANTIC]
  }
  return TIER_POLICIES[tier] || TIER_POLICIES[MemoryTier.SEMANTIC]
}

export function normalizeTier(value: unknown): MemoryTier {
  if (typeof value === 'string' && Object.values(MemoryTier).includes(value as MemoryTier)) {
    return value as MemoryTier
  }
  return MemoryTier.SEMANTIC
}

// ---------------------------------------------------------------------------
// Canonical Token Estimator
// ---------------------------------------------------------------------------

const WIDE_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g
export const CHARS_PER_TOKEN = 4
export const BYTES_PER_TOKEN = 3.5

export function wideChars(text: string): number {
  if (!text) return 0
  const matches = text.match(WIDE_RE)
  return matches ? matches.length : 0
}

export function estimateTokens(text: string): number {
  if (!text) return 0
  const wide = wideChars(text)
  const rest = text.length - wide
  return wide + Math.ceil(Math.max(0, rest) / CHARS_PER_TOKEN)
}

export function estimateBytes(text: string): number {
  if (!text) return 0
  const byteLen = Buffer.byteLength(text, 'utf8')
  return Math.floor(byteLen / BYTES_PER_TOKEN)
}

export function estimateTokensOf(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'string') return estimateTokens(value)
  try {
    return estimateTokens(JSON.stringify(value))
  } catch {
    return estimateTokens(String(value))
  }
}

// ---------------------------------------------------------------------------
// Expiry, Promotion & Budget Trimming
// ---------------------------------------------------------------------------

export function isExpired(tier: MemoryTier | string, lastTouch: number, now?: number): boolean {
  const pol = policyFor(tier)
  if (pol.ttlSeconds <= 0) return false
  const current = now !== undefined ? now : Date.now() / 1000
  const touch = lastTouch > 1e11 ? lastTouch / 1000 : lastTouch
  return current - (touch || 0) > pol.ttlSeconds
}

export function shouldPromote(tier: MemoryTier | string, hits: number): MemoryTier | null {
  const pol = policyFor(tier)
  if (pol.promoteAfterHits <= 0 || !pol.promoteTo) return null
  return hits >= pol.promoteAfterHits ? pol.promoteTo : null
}

export function trimToBudget<T extends Record<string, any>>(
  entries: T[],
  tier: MemoryTier | string,
  textKey = 'content'
): { kept: T[]; droppedCount: number } {
  const pol = policyFor(tier)
  if (pol.tokenBudget <= 0 || !entries || entries.length === 0) {
    return { kept: [...entries], droppedCount: 0 }
  }

  // Sort descending by importance, then descending by recency
  const ranked = [...entries].sort((a, b) => {
    const impA = typeof a.importance === 'number' ? a.importance : 0.5
    const impB = typeof b.importance === 'number' ? b.importance : 0.5
    if (impA !== impB) return impB - impA

    const updA = typeof a.updated_at === 'number' ? a.updated_at : (a.updatedAt || 0)
    const updB = typeof b.updated_at === 'number' ? b.updated_at : (b.updatedAt || 0)
    return updB - updA
  })

  const kept: T[] = []
  let used = 0

  for (const entry of ranked) {
    const text = String(entry[textKey] || '')
    const cost = estimateTokens(text)
    if (used + cost > pol.tokenBudget) {
      continue
    }
    kept.push(entry)
    used += cost
  }

  return {
    kept,
    droppedCount: entries.length - kept.length,
  }
}

export interface TierStats {
  tier: string
  count: number
  tokens: number
  expired: number
  overBudget: boolean
  tokenBudget: number
  ttlSeconds: number
  alwaysInject: boolean
  userEditable: boolean
  trust: number
  persisted: boolean
}

export function summarizeTiers(rows: Record<string, any>[], now?: number): TierStats[] {
  const current = now !== undefined ? now : Date.now() / 1000
  const buckets: Record<MemoryTier, { count: number; tokens: number; expired: number }> = {
    [MemoryTier.WORKING]: { count: 0, tokens: 0, expired: 0 },
    [MemoryTier.SHORT_TERM_RECALL]: { count: 0, tokens: 0, expired: 0 },
    [MemoryTier.LONG_TERM]: { count: 0, tokens: 0, expired: 0 },
    [MemoryTier.SEMANTIC]: { count: 0, tokens: 0, expired: 0 },
    [MemoryTier.WIKI]: { count: 0, tokens: 0, expired: 0 },
    [MemoryTier.DREAMING]: { count: 0, tokens: 0, expired: 0 },
  }

  for (const r of rows) {
    const tier = normalizeTier(r.tier)
    const st = buckets[tier]
    st.count += 1
    st.tokens += estimateTokens(String(r.content || ''))
    const touch = Math.max(Number(r.updated_at || r.updatedAt || 0), Number(r.accessed_at || r.accessedAt || 0))
    if (isExpired(tier, touch, current)) {
      st.expired += 1
    }
  }

  return TIER_ORDER.map((t) => {
    const pol = policyFor(t)
    const st = buckets[t]
    const overBudget = pol.tokenBudget > 0 && st.tokens > pol.tokenBudget
    return {
      tier: t,
      count: st.count,
      tokens: st.tokens,
      expired: st.expired,
      overBudget,
      tokenBudget: pol.tokenBudget,
      ttlSeconds: pol.ttlSeconds,
      alwaysInject: pol.alwaysInject,
      userEditable: pol.userEditable,
      trust: pol.trust,
      persisted: pol.persisted,
    }
  })
}
