/**
 * memory_tiers.ts — Six-tier memory hierarchy (C1).
 *
 * Ported from `app/backend/memory_tiers.py` (310 lines).
 *
 * Before this, every remembered thing lived in one flat memory_entries table
 * with an importance float. That conflates three different questions:
 *   * How long should this live?        (retention)
 *   * Should it be in the prompt now?   (injection)
 *   * Can the user read/edit it?        (visibility)
 * One float can't answer all three. The six tiers, ordered by volatility
 * (most → least): WORKING / SHORT_TERM_RECALL / LONG_TERM / SEMANTIC / WIKI /
 * DREAMING — the source's per-tier rationale comments are preserved below as
 * the behavioral contract.
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only; estimate_tokens comes from token_estimate.ts
 *       (already ported — the shared single-source estimator).
 *   §2  (str, Enum) → string union + a values table; the DB stores string
 *       values, exactly what the source persists. `MemoryTier(value)` with a
 *       bad value → SEMANTIC (source behavior).
 *   §2  frozen dataclass TierPolicy → readonly interface (the source never
 *       mutates a policy; the type system now proves it).
 *   §2  trim_to_budget's sort is Python's tuple-compare on
 *       (importance DESC, updated_at DESC) — JS comparator inverts both.
 *       Ties keep the source's stable-order semantics (Array.sort is stable).
 *   §4  naming: memory_tiers.py → memory_tiers.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import { estimateTokens } from "./token_estimate.js";

/** The six tiers. String values are what gets persisted. */
export const MemoryTier = {
  WORKING: "working",
  SHORT_TERM_RECALL: "short-term-recall",
  LONG_TERM: "long-term",
  SEMANTIC: "semantic",
  WIKI: "wiki",
  DREAMING: "dreaming",
} as const;

export type MemoryTier = (typeof MemoryTier)[keyof typeof MemoryTier];

/** Volatility order, most volatile first. Used for eviction sweeps and for
 * deciding which tier a demoted memory falls into. */
export const TIER_ORDER: readonly MemoryTier[] = [
  MemoryTier.WORKING,
  MemoryTier.SHORT_TERM_RECALL,
  MemoryTier.LONG_TERM,
  MemoryTier.SEMANTIC,
  MemoryTier.WIKI,
  MemoryTier.DREAMING,
];

export interface TierPolicy {
  /** Retention + injection rules for one tier.
   *
   * persisted: False means in-process only; the tier never touches SQLite.
   * ttl_seconds: Age at which an untouched entry becomes evictable. 0 = never.
   * token_budget: Hard ceiling when the tier is injected verbatim. 0 = not
   *   injected verbatim (retrieved on demand instead), so no ceiling.
   * always_inject: True when the tier goes into every prompt regardless of
   *   the query. Only LONG_TERM does this — it's the "you always need to
   *   know this" tier.
   * user_editable: True when the user owns the content and we must never
   *   rewrite it wholesale (append/patch only).
   * trust: 1.0 = the user said it. Lower for model-authored content, so a
   *   dream can never outrank a stated preference during recall.
   * promote_after_hits: Recall count that earns promotion to the next
   *   less-volatile tier. 0 disables promotion out of this tier. */
  readonly persisted: boolean;
  readonly ttl_seconds: number;
  readonly token_budget: number;
  readonly always_inject: boolean;
  readonly user_editable: boolean;
  readonly trust: number;
  readonly promote_after_hits: number;
  readonly promote_to: MemoryTier | null;
}

/** One hour / one day in seconds, spelled out so the table reads clearly. */
const _HOUR = 3600;
const _DAY = 86400;

export const TIER_POLICIES: Readonly<Record<MemoryTier, TierPolicy>> = {
  // Never persisted: a working note that survives the turn is a stale note.
  [MemoryTier.WORKING]: {
    persisted: false, ttl_seconds: 0, token_budget: 600,
    always_inject: true, user_editable: false, trust: 0.9,
    promote_after_hits: 2, promote_to: MemoryTier.SHORT_TERM_RECALL,
  },
  // 12h TTL: long enough to span a working session, short enough that
  // yesterday's context doesn't bleed into today's.
  [MemoryTier.SHORT_TERM_RECALL]: {
    persisted: true, ttl_seconds: 12 * _HOUR, token_budget: 0,
    always_inject: false, user_editable: false, trust: 0.85,
    promote_after_hits: 3, promote_to: MemoryTier.SEMANTIC,
  },
  // The 2500-token cap is the whole point of this tier existing.
  [MemoryTier.LONG_TERM]: {
    persisted: true, ttl_seconds: 0, token_budget: 2500,
    always_inject: true, user_editable: true, trust: 1.0,
    promote_after_hits: 0, promote_to: null,
  },
  [MemoryTier.SEMANTIC]: {
    persisted: true, ttl_seconds: 0, token_budget: 0,
    always_inject: false, user_editable: false, trust: 0.8,
    promote_after_hits: 8, promote_to: MemoryTier.LONG_TERM,
  },
  // Claims carry their own confidence, so tier trust stays neutral-high and
  // the per-claim confidence does the discriminating (see C4).
  [MemoryTier.WIKI]: {
    persisted: true, ttl_seconds: 0, token_budget: 0,
    always_inject: false, user_editable: true, trust: 0.9,
    promote_after_hits: 0, promote_to: null,
  },
  // Model-authored consolidation: useful, but must never outrank a stated
  // fact, hence the lowest trust in the table.
  [MemoryTier.DREAMING]: {
    persisted: true, ttl_seconds: 30 * _DAY, token_budget: 0,
    always_inject: false, user_editable: false, trust: 0.55,
    promote_after_hits: 5, promote_to: MemoryTier.SEMANTIC,
  },
};

/** Tiers injected verbatim into every prompt, in render order. */
export const ALWAYS_INJECT_TIERS: readonly MemoryTier[] = TIER_ORDER.filter(
  (t) => TIER_POLICIES[t].always_inject
);

/** Total verbatim budget across always-injected tiers. Guards the case where
 * each tier is individually under budget but together they blow the window. */
export const TOTAL_INJECT_BUDGET: number = ALWAYS_INJECT_TIERS.reduce(
  (sum, t) => sum + TIER_POLICIES[t].token_budget,
  0
);

/** Look up a tier's policy, tolerating a raw string from the DB. */
export function policy_for(tier: MemoryTier | string): TierPolicy {
  if (typeof tier === "string") {
    let t: MemoryTier;
    if ((Object.values(MemoryTier) as string[]).includes(tier)) {
      t = tier as MemoryTier;
    } else {
      t = MemoryTier.SEMANTIC; // unknown tier behaves like the bulk store
    }
    return TIER_POLICIES[t];
  }
  return TIER_POLICIES[tier];
}

/** Coerce anything (null, legacy string, enum) into a valid tier.
 *
 * Legacy rows predate tiers and carry no value at all; they land in SEMANTIC,
 * which is exactly what the old flat table was. */
export function normalize_tier(value: unknown): MemoryTier {
  if (typeof value === "string" && value) {
    if ((Object.values(MemoryTier) as string[]).includes(value)) {
      return value as MemoryTier;
    }
    return MemoryTier.SEMANTIC;
  }
  return MemoryTier.SEMANTIC;
}

/** Rough token count for budget enforcement.
 *
 * Thin alias for token_estimate.estimateTokens — the whole backend shares one
 * estimator now. Kept as a name here because memory call sites and tests
 * import it from this module. */
export function estimate_tokens(text: string): number {
  return estimateTokens(text);
}

/** Has an entry outlived its tier's TTL?
 *
 * `last_touch` should be the later of created_at / accessed_at: a memory
 * that keeps being recalled is still in use even if it was written long ago. */
export function is_expired(
  tier: MemoryTier | string,
  last_touch: number,
  now?: number | null
): boolean {
  const pol = policy_for(tier);
  if (pol.ttl_seconds <= 0) {
    return false;
  }
  const ref = now === null || now === undefined ? Date.now() / 1000 : now;
  return ref - Number(last_touch ?? 0) > pol.ttl_seconds;
}

/** Return the tier this entry has earned, or null to leave it alone.
 *
 * Promotion is hit-count driven rather than time driven on purpose: something
 * recalled eight times is load-bearing regardless of how old it is, and
 * something written today that nobody ever reads back is noise. */
export function should_promote(
  tier: MemoryTier | string,
  hits: number
): MemoryTier | null {
  const pol = policy_for(tier);
  if (pol.promote_after_hits <= 0 || pol.promote_to === null) {
    return null;
  }
  return hits >= pol.promote_after_hits ? pol.promote_to : null;
}

/** Drop lowest-importance entries until the tier fits its token budget.
 *
 * Returns (kept, dropped_count). A tier with no budget (0) is returned
 * untouched. Sorting is by importance descending then recency descending, so
 * the thing that survives a squeeze is the important recent one — evicting by
 * insertion order would throw away a critical fact just because it was
 * written first. */
export function trim_to_budget(
  entries: Record<string, unknown>[],
  tier: MemoryTier | string,
  text_key = "content"
): [Record<string, unknown>[], number] {
  const pol = policy_for(tier);
  if (pol.token_budget <= 0 || !entries || entries.length === 0) {
    return [entries, 0];
  }

  const ranked = [...entries].sort((a, b) => {
    const ia = Number(a["importance"] ?? 0.5);
    const ib = Number(b["importance"] ?? 0.5);
    if (ib !== ia) return ib - ia;
    const ua = Number(a["updated_at"] ?? 0) || 0;
    const ub = Number(b["updated_at"] ?? 0) || 0;
    return ub - ua;
  });
  const kept: Record<string, unknown>[] = [];
  let used = 0;
  for (const e of ranked) {
    const cost = estimate_tokens(String(e[text_key] ?? ""));
    if (used + cost > pol.token_budget) {
      continue;
    }
    kept.push(e);
    used += cost;
  }
  return [kept, entries.length - kept.length];
}

export class TierStats {
  /** Per-tier counters for the settings UI / diagnostics. */
  tier: MemoryTier;
  count = 0;
  tokens = 0;
  expired = 0;
  over_budget = false;

  constructor(tier: MemoryTier) {
    this.tier = tier;
  }

  to_dict(): Record<string, unknown> {
    const pol = policy_for(this.tier);
    return {
      tier: this.tier,
      count: this.count,
      tokens: this.tokens,
      expired: this.expired,
      overBudget: this.over_budget,
      tokenBudget: pol.token_budget,
      ttlSeconds: pol.ttl_seconds,
      alwaysInject: pol.always_inject,
      userEditable: pol.user_editable,
      trust: pol.trust,
      persisted: pol.persisted,
    };
  }
}

/** Build per-tier stats from raw memory rows, for display.
 *
 * Returns one dict per tier in TIER_ORDER, always all six even when empty —
 * a tier missing from the UI reads as "broken", an empty one reads as
 * "nothing here yet", and those are very different messages. */
export function summarize_tiers(
  rows: Record<string, unknown>[],
  now?: number | null
): Record<string, unknown>[] {
  const ref = now === null || now === undefined ? Date.now() / 1000 : now;
  const buckets = new Map<MemoryTier, TierStats>();
  for (const t of TIER_ORDER) {
    buckets.set(t, new TierStats(t));
  }

  for (const r of rows ?? []) {
    const tier = normalize_tier(r["tier"]);
    const st = buckets.get(tier)!;
    st.count += 1;
    st.tokens += estimate_tokens(String(r["content"] ?? ""));
    const touch = Math.max(
      Number(r["updated_at"] ?? 0) || 0,
      Number(r["accessed_at"] ?? 0) || 0
    );
    if (is_expired(tier, touch, ref)) {
      st.expired += 1;
    }
  }

  for (const [, st] of buckets) {
    const budget = policy_for(st.tier).token_budget;
    st.over_budget = budget > 0 && st.tokens > budget;
  }

  return TIER_ORDER.map((t) => buckets.get(t)!.to_dict());
}
