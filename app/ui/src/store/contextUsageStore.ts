// src/store/contextUsageStore.ts
// Context window accounting. Two sources, in this order of trust:
//   1. The backend's `usage` WS frame, emitted once per turn with the
//      provider-reported context size. applyUsage() writes it and clears
//      isEstimated.
//   2. Between those frames — i.e. while a turn is streaming — numbers are
//      ESTIMATED client-side from message content (see lib/tokens.ts), and
//      isEstimated stays true.
// So the meter is exact right after each turn settles and an approximation
// during it, rather than an approximation forever.
//
// v2: Added detailed breakdown (messages / systemPrompt / tools / skills),
// prompt-caching stats (cacheReadTokens / cacheCreationTokens / hitRate),
// and agent action stats (toolCalls / rulesApplied / subagentsDelegated).
// Populated from the backend's /api/token-analytics snapshot and the
// usage WS frame's cache_read / cache_creation fields.
import { create } from 'zustand'

export interface ContextUsage {
  currentTokens: number
  maxTokens: number
  usagePercent: number

  // ── Breakdown (all client-measurable) ──
  /** System prompt — only non-zero when the backend reports it. */
  systemPromptTokens: number
  /** Tool JSON-Schema definitions — backend-reported (heuristic estimate). */
  toolDefTokens: number
  /** Loaded skill content — backend-reported (heuristic estimate). */
  skillTokens: number
  /** Everything the user has typed and sent this session. */
  userTokens: number
  /** Assistant replies. */
  assistantTokens: number
  /** Tool call args + results. */
  toolResultTokens: number
  /** Reasoning / thinking blocks. */
  reasoningTokens: number
  /** Draft still sitting in the composer, not yet sent. */
  pendingInputTokens: number

  cachedTokens: number
  cacheHitRate: number
  estimatedRemainingTurns: number
  willExceedLimit: boolean
  /** True when numbers come from local estimation rather than the provider. */
  isEstimated: boolean
  /**
   * Whether `maxTokens` is the ACTIVE MODEL's real context window.
   *
   * False means nobody has told us the window yet, and every percentage drawn
   * from it would be fiction. The backend used to hard-write 200,000 on every
   * turn (overwriting the real value Composer had already set from the model
   * definition), so a 32k model showed 30k of usage as "15%, safe green".
   * When this is false the UI must show token counts without a percentage
   * rather than show a confident wrong one.
   */
  windowKnown: boolean
}

export interface CacheStats {
  totalMessages: number
  cachedMessages: number
  lastCacheHit: boolean
  cacheReadTokens: number
  // ── v2: detailed prompt-caching tracking ──
  cacheCreationTokens: number
  averageHitRate: number
  estimatedSavingsMicros: number
  /**
   * Where the savings figure's prices came from:
   * `reported` = the provider billed us this, `estimated` = our rate table had
   * this model, `fallback` = it did not and a mid-market rate was used,
   * `''` = no priced call yet. Anything but `reported` must be rendered with a
   * "≈" so a table lookup is not mistaken for a bill.
   */
  costSource: string
}

// ── v2: Agent action breakdown ──
export interface ActionStats {
  toolCalls: number
  rulesApplied: number
  subagentsDelegated: number
  toolBreakdown: Record<string, number>
}

interface ContextUsageState {
  usage: ContextUsage
  cache: CacheStats
  actions: ActionStats
  update: (partial: Partial<ContextUsage>) => void
  updateCache: (partial: Partial<CacheStats>) => void
  updateActions: (partial: Partial<ActionStats>) => void
  /**
   * Set the composer draft's token cost, keeping `currentTokens` consistent by
   * swapping the old pending value for the new one.
   */
  setPendingInput: (tokens: number) => void
  /**
   * Apply a backend analytics snapshot (from /api/token-analytics or a
   * WS frame). This takes precedence over local estimates.
   */
  applyAnalytics: (snap: AnalyticsSnapshot) => void
  reset: () => void
}

/** Shape returned by GET /api/token-analytics. */
export interface AnalyticsSnapshot {
  used: number
  /** null when the backend does not know the active model's window. */
  total: number | null
  /** null for the same reason — never a placeholder percentage. */
  percent: number | null
  modelId: string
  isEstimated: boolean
  windowKnown?: boolean
  breakdown: {
    messages: number
    systemPrompt: number
    tools: number
    skills: number
  }
  cache: {
    cacheReadTokens: number
    cacheCreationTokens: number
    averageHitRate: number
    estimatedSavingsMicros: number
    costSource?: string
  }
  actions: {
    toolCalls: number
    rulesApplied: number
    subagentsDelegated: number
    toolBreakdown: Record<string, number>
  }
  totals: {
    toolCalls: number
    rulesApplied: number
    subagentsDelegated: number
    turns: number
  }
  updatedAt: number
}

const DEFAULT_USAGE: ContextUsage = {
  currentTokens: 0,
  // Kept as a working divisor so nothing divides by zero, but `windowKnown`
  // below is what decides whether a percentage may be SHOWN. Composer sets the
  // real value from the active model definition as soon as one resolves.
  maxTokens: 200_000,
  usagePercent: 0,
  systemPromptTokens: 0,
  toolDefTokens: 0,
  skillTokens: 0,
  userTokens: 0,
  assistantTokens: 0,
  toolResultTokens: 0,
  reasoningTokens: 0,
  pendingInputTokens: 0,
  cachedTokens: 0,
  cacheHitRate: 0,
  estimatedRemainingTurns: 0,
  willExceedLimit: false,
  isEstimated: true,
  windowKnown: false,
}

const DEFAULT_CACHE: CacheStats = {
  totalMessages: 0,
  cachedMessages: 0,
  lastCacheHit: false,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  averageHitRate: 0,
  estimatedSavingsMicros: 0,
  costSource: '',
}

const DEFAULT_ACTIONS: ActionStats = {
  toolCalls: 0,
  rulesApplied: 0,
  subagentsDelegated: 0,
  toolBreakdown: {},
}

export const useContextUsageStore = create<ContextUsageState>((set) => ({
  usage: DEFAULT_USAGE,
  cache: DEFAULT_CACHE,
  actions: DEFAULT_ACTIONS,
  update: (partial) => set((s) => ({ usage: { ...s.usage, ...partial } })),
  updateCache: (partial) => set((s) => ({ cache: { ...s.cache, ...partial } })),
  updateActions: (partial) => set((s) => ({ actions: { ...s.actions, ...partial } })),
  setPendingInput: (tokens) =>
    set((s) => {
      const max = s.usage.maxTokens || 200_000
      const current = s.usage.currentTokens - s.usage.pendingInputTokens + tokens
      return {
        usage: {
          ...s.usage,
          pendingInputTokens: tokens,
          currentTokens: current,
          usagePercent: (current / max) * 100,
          willExceedLimit: current / max > 0.9,
        },
      }
    }),
  applyAnalytics: (snap) =>
    set((s) => {
      // A null `total` means the backend does not know the window. Keep the one
      // we already have (Composer sets it from the active model definition) and
      // keep `windowKnown` as-is — overwriting a known window with a guess is
      // exactly the bug this branch exists to prevent.
      const maxTokens = snap.total && snap.total > 0 ? snap.total : s.usage.maxTokens
      const backendKnows = snap.windowKnown ?? (snap.total != null && snap.total > 0)
      // Only ever upgrade "unknown" -> "known". A backend that does not know the
      // window must not downgrade a window Composer already resolved.
      const windowKnown = backendKnows || s.usage.windowKnown
      const percent = snap.percent != null
        ? snap.percent
        : (maxTokens > 0 ? (snap.used / maxTokens) * 100 : 0)
      return {
        usage: {
          ...s.usage,
          currentTokens: snap.used,
          maxTokens,
          windowKnown,
          usagePercent: percent,
          systemPromptTokens: snap.breakdown.systemPrompt,
          // These two used to be dropped on the floor here, which is why the
          // segmented bar rendered them as a flat 0.0%.
          toolDefTokens: snap.breakdown.tools,
          skillTokens: snap.breakdown.skills,
          isEstimated: snap.isEstimated,
          willExceedLimit: maxTokens > 0 ? snap.used / maxTokens > 0.9 : false,
          cacheHitRate: snap.cache.averageHitRate,
          cachedTokens: snap.cache.cacheReadTokens,
        },
        cache: {
          ...s.cache,
          cacheReadTokens: snap.cache.cacheReadTokens,
          cacheCreationTokens: snap.cache.cacheCreationTokens,
          averageHitRate: snap.cache.averageHitRate,
          estimatedSavingsMicros: snap.cache.estimatedSavingsMicros,
          costSource: snap.cache.costSource ?? s.cache.costSource,
        },
        actions: {
          toolCalls: snap.actions.toolCalls,
          rulesApplied: snap.actions.rulesApplied,
          subagentsDelegated: snap.actions.subagentsDelegated,
          toolBreakdown: snap.actions.toolBreakdown,
        },
      }
    }),
  reset: () => set({ usage: DEFAULT_USAGE, cache: DEFAULT_CACHE, actions: DEFAULT_ACTIONS }),
}))
