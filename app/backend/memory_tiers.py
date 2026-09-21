"""
memory_tiers.py - Six-tier memory hierarchy (C1).

Before this, every remembered thing lived in one flat ``memory_entries`` table
with an ``importance`` float. That conflates three different questions:

  * How long should this live?        (retention)
  * Should it be in the prompt now?   (injection)
  * Can the user read/edit it?        (visibility)

One float can't answer all three, which is why a throwaway "user is looking at
foo.py right now" fact competed for prompt space with "this project never uses
default exports" — and why nothing could ever be safely evicted.

The six tiers, ordered by volatility (most → least):

  WORKING           Current-turn scratch. In-process only, never persisted.
                    Dies with the turn. Holds "the file we just opened", the
                    kind of thing that is wrong five minutes later.
  SHORT_TERM_RECALL Recent session activity. Persisted but aggressively decayed
                    (hours, not days). This is what makes "继续刚才那个" work.
  LONG_TERM         MEMORY.md — the hand-editable, human-owned tier. HARD
                    capped at 2500 tokens because it is injected verbatim into
                    every single prompt; an uncapped file silently eats the
                    context window and the user never sees why replies got worse.
  SEMANTIC          Vector-indexed ``memory_entries``. Unbounded size, retrieved
                    on demand by similarity. The bulk store.
  WIKI              Declarative claims with confidence + evidence (filled by C4).
                    Distinct from SEMANTIC because a claim can be *contradicted*
                    and needs provenance, where a semantic memory is just text.
  DREAMING          Consolidated insights produced by idle background passes.
                    Separated so a dream (model-authored, lower trust) is never
                    mistaken for something the user actually said.

Promotion is the interesting direction: a fact that keeps getting recalled earns
its way up into LONG_TERM; one that never gets touched decays out of
SHORT_TERM_RECALL. That loop is what keeps MEMORY.md from becoming a junk drawer.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from token_estimate import estimate_tokens as _shared_estimate


class MemoryTier(str, Enum):
    """The six tiers. String values are what gets persisted."""

    WORKING = "working"
    SHORT_TERM_RECALL = "short-term-recall"
    LONG_TERM = "long-term"
    SEMANTIC = "semantic"
    WIKI = "wiki"
    DREAMING = "dreaming"


#: Volatility order, most volatile first. Used for eviction sweeps and for
#: deciding which tier a demoted memory falls into.
TIER_ORDER: tuple[MemoryTier, ...] = (
    MemoryTier.WORKING,
    MemoryTier.SHORT_TERM_RECALL,
    MemoryTier.LONG_TERM,
    MemoryTier.SEMANTIC,
    MemoryTier.WIKI,
    MemoryTier.DREAMING,
)


@dataclass(frozen=True)
class TierPolicy:
    """Retention + injection rules for one tier.

    Attributes:
        persisted: False means in-process only; the tier never touches SQLite.
        ttl_seconds: Age at which an untouched entry becomes evictable. 0 = never.
        token_budget: Hard ceiling when the tier is injected verbatim. 0 = not
            injected verbatim (retrieved on demand instead), so no ceiling.
        always_inject: True when the tier goes into every prompt regardless of
            the query. Only LONG_TERM does this — it's the "you always need to
            know this" tier.
        user_editable: True when the user owns the content and we must never
            rewrite it wholesale (append/patch only).
        trust: 1.0 = the user said it. Lower for model-authored content, so a
            dream can never outrank a stated preference during recall.
        promote_after_hits: Recall count that earns promotion to the next
            less-volatile tier. 0 disables promotion out of this tier.
    """

    persisted: bool
    ttl_seconds: int
    token_budget: int
    always_inject: bool
    user_editable: bool
    trust: float
    promote_after_hits: int
    promote_to: Optional[MemoryTier] = None


#: One hour / one day in seconds, spelled out so the table below reads clearly.
_HOUR = 3600
_DAY = 86400

TIER_POLICIES: dict[MemoryTier, TierPolicy] = {
    # Never persisted: a working note that survives the turn is a stale note.
    MemoryTier.WORKING: TierPolicy(
        persisted=False, ttl_seconds=0, token_budget=600,
        always_inject=True, user_editable=False, trust=0.9,
        promote_after_hits=2, promote_to=MemoryTier.SHORT_TERM_RECALL,
    ),
    # 12h TTL: long enough to span a working session, short enough that
    # yesterday's context doesn't bleed into today's.
    MemoryTier.SHORT_TERM_RECALL: TierPolicy(
        persisted=True, ttl_seconds=12 * _HOUR, token_budget=0,
        always_inject=False, user_editable=False, trust=0.85,
        promote_after_hits=3, promote_to=MemoryTier.SEMANTIC,
    ),
    # The 2500-token cap is the whole point of this tier existing.
    MemoryTier.LONG_TERM: TierPolicy(
        persisted=True, ttl_seconds=0, token_budget=2500,
        always_inject=True, user_editable=True, trust=1.0,
        promote_after_hits=0,
    ),
    MemoryTier.SEMANTIC: TierPolicy(
        persisted=True, ttl_seconds=0, token_budget=0,
        always_inject=False, user_editable=False, trust=0.8,
        promote_after_hits=8, promote_to=MemoryTier.LONG_TERM,
    ),
    # Claims carry their own confidence, so tier trust stays neutral-high and
    # the per-claim confidence does the discriminating (see C4).
    MemoryTier.WIKI: TierPolicy(
        persisted=True, ttl_seconds=0, token_budget=0,
        always_inject=False, user_editable=True, trust=0.9,
        promote_after_hits=0,
    ),
    # Model-authored consolidation: useful, but must never outrank a stated
    # fact, hence the lowest trust in the table.
    MemoryTier.DREAMING: TierPolicy(
        persisted=True, ttl_seconds=30 * _DAY, token_budget=0,
        always_inject=False, user_editable=False, trust=0.55,
        promote_after_hits=5, promote_to=MemoryTier.SEMANTIC,
    ),
}

#: Tiers injected verbatim into every prompt, in render order.
ALWAYS_INJECT_TIERS: tuple[MemoryTier, ...] = tuple(
    t for t in TIER_ORDER if TIER_POLICIES[t].always_inject
)

#: Total verbatim budget across always-injected tiers. Guards the case where
#: each tier is individually under budget but together they blow the window.
TOTAL_INJECT_BUDGET = sum(TIER_POLICIES[t].token_budget for t in ALWAYS_INJECT_TIERS)


def policy_for(tier: MemoryTier | str) -> TierPolicy:
    """Look up a tier's policy, tolerating a raw string from the DB."""
    if isinstance(tier, str):
        try:
            tier = MemoryTier(tier)
        except ValueError:
            tier = MemoryTier.SEMANTIC  # unknown tier behaves like the bulk store
    return TIER_POLICIES[tier]


def normalize_tier(value: object) -> MemoryTier:
    """Coerce anything (None, legacy string, enum) into a valid tier.

    Legacy rows predate tiers and carry no value at all; they land in SEMANTIC,
    which is exactly what the old flat table was.
    """
    if isinstance(value, MemoryTier):
        return value
    if isinstance(value, str) and value:
        try:
            return MemoryTier(value)
        except ValueError:
            return MemoryTier.SEMANTIC
    return MemoryTier.SEMANTIC


def estimate_tokens(text: str) -> int:
    """Rough token count for budget enforcement.

    Thin alias for ``token_estimate.estimate_tokens`` — the whole backend shares
    one estimator now. Kept as a name here because memory call sites and tests
    import it from this module, and because "how does memory price an entry"
    is a question people answer by opening this file.
    """
    return _shared_estimate(text)


def is_expired(tier: MemoryTier | str, last_touch: float, now: Optional[float] = None) -> bool:
    """Has an entry outlived its tier's TTL?

    ``last_touch`` should be the later of created_at / accessed_at: a memory
    that keeps being recalled is still in use even if it was written long ago.
    """
    pol = policy_for(tier)
    if pol.ttl_seconds <= 0:
        return False
    now = time.time() if now is None else now
    return (now - float(last_touch or 0)) > pol.ttl_seconds


def should_promote(tier: MemoryTier | str, hits: int) -> Optional[MemoryTier]:
    """Return the tier this entry has earned, or None to leave it alone.

    Promotion is hit-count driven rather than time driven on purpose: something
    recalled eight times is load-bearing regardless of how old it is, and
    something written today that nobody ever reads back is noise.
    """
    pol = policy_for(tier)
    if pol.promote_after_hits <= 0 or pol.promote_to is None:
        return None
    return pol.promote_to if hits >= pol.promote_after_hits else None


def trim_to_budget(entries: list[dict], tier: MemoryTier | str,
                   text_key: str = "content") -> tuple[list[dict], int]:
    """Drop lowest-importance entries until the tier fits its token budget.

    Returns ``(kept, dropped_count)``. A tier with no budget (0) is returned
    untouched. Sorting is by importance descending then recency descending, so
    the thing that survives a squeeze is the important recent one — evicting by
    insertion order would throw away a critical fact just because it was
    written first.
    """
    pol = policy_for(tier)
    if pol.token_budget <= 0 or not entries:
        return entries, 0

    ranked = sorted(
        entries,
        key=lambda e: (float(e.get("importance", 0.5)),
                       float(e.get("updated_at", 0) or 0)),
        reverse=True,
    )
    kept: list[dict] = []
    used = 0
    for e in ranked:
        cost = estimate_tokens(str(e.get(text_key, "")))
        if used + cost > pol.token_budget:
            continue
        kept.append(e)
        used += cost
    return kept, len(entries) - len(kept)


@dataclass
class TierStats:
    """Per-tier counters for the settings UI / diagnostics."""

    tier: MemoryTier
    count: int = 0
    tokens: int = 0
    expired: int = 0
    over_budget: bool = False

    def to_dict(self) -> dict:
        pol = policy_for(self.tier)
        return {
            "tier": self.tier.value,
            "count": self.count,
            "tokens": self.tokens,
            "expired": self.expired,
            "overBudget": self.over_budget,
            "tokenBudget": pol.token_budget,
            "ttlSeconds": pol.ttl_seconds,
            "alwaysInject": pol.always_inject,
            "userEditable": pol.user_editable,
            "trust": pol.trust,
            "persisted": pol.persisted,
        }


def summarize_tiers(rows: list[dict], now: Optional[float] = None) -> list[dict]:
    """Build per-tier stats from raw memory rows, for display.

    Args:
        rows: memory_entries dicts (need ``tier``, ``content``, ``updated_at``).
        now: Injectable clock for tests.

    Returns:
        One dict per tier in :data:`TIER_ORDER`, always all six even when empty —
        a tier missing from the UI reads as "broken", an empty one reads as
        "nothing here yet", and those are very different messages.
    """
    now = time.time() if now is None else now
    buckets: dict[MemoryTier, TierStats] = {t: TierStats(tier=t) for t in TIER_ORDER}

    for r in rows:
        tier = normalize_tier(r.get("tier"))
        st = buckets[tier]
        st.count += 1
        st.tokens += estimate_tokens(str(r.get("content", "")))
        touch = max(float(r.get("updated_at", 0) or 0), float(r.get("accessed_at", 0) or 0))
        if is_expired(tier, touch, now):
            st.expired += 1

    for tier, st in buckets.items():
        budget = policy_for(tier).token_budget
        st.over_budget = budget > 0 and st.tokens > budget

    return [buckets[t].to_dict() for t in TIER_ORDER]
