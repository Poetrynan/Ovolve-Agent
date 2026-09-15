"""model_registry.py - Multi-model management + auth + token billing + encryption.

Provider config: provider.<uuid>.{name, kind, options{apiKey, baseURL}, enabled, models{}}
Credentials are encrypted at rest behind an ``enc:`` prefix; apiKey and
refresh_token are never written in plaintext.
Token billing: turn_usage table tracks input/output/reasoning/cache tokens.
OAuth: refresh_token flow with 401 interception and automatic retry.
"""
from __future__ import annotations
import asyncio, os, json, time, base64, hashlib, urllib.error, urllib.parse, urllib.request, uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional
from result import Result
from storage import get_storage

# Model downgrade (UD2). There used to be a hardcoded DOWNGRADE_CHAIN here plus
# a DEFAULT_RETRY_POLICY dict; both had zero call sites, and the chain listed
# model ids (`claude-sonnet-4`, `gpt-4o`) that did not intersect the models this
# app actually configures — so even if something had called it, every lookup
# would have missed. Candidates are now generated from the registry by
# capability (see `downgrade_candidates`), and the retry ladder lives where it is
# actually used, in llm_client.RETRY_DELAYS.

#: Consecutive hard failures before a provider is skipped, and for how long.
#: Without this, a provider that is down costs one full timeout per turn forever.
PROVIDER_FAIL_THRESHOLD = 3
PROVIDER_COOLDOWN_SECONDS = 120.0

# ---------------------------------------------------------------------------
# Pricing table
# ---------------------------------------------------------------------------
# Pure data: no network, no LLM, no guessing at call time. A cost figure the
# product shows to the user has to be reproducible, so the rates live here as a
# versioned literal with a provenance stamp, and every computed cost is stamped
# with the rate source that produced it.
#
# Unit: USD per 1_000_000 tokens. Because 1 micro-dollar = 1e-6 USD, cost in
# micros is simply ``tokens * rate`` — no division, no float drift in the ledger.

#: Where the shipped defaults came from, and when they were transcribed. Rates
#: change; a stored cost must never be recomputed with today's numbers, which is
#: why the cost column is written once at insert time (see storage.record_usage).
PRICE_TABLE_SOURCE = "vendor public list prices"
PRICE_TABLE_FETCHED = "2026-08"

#: Storage config key holding user overrides, same shape as MODEL_PRICES.
#: A user on an enterprise contract does not pay list price, and hardcoding list
#: price for them would be wrong in a way they cannot correct.
PRICE_OVERRIDE_KEY = "model_prices"

#: model key -> {input, output, cache_read, cache_write}. Keys are matched
#: longest-prefix (see :func:`lookup_price`) so dated snapshots such as
#: ``gpt-4o-2024-11-20`` resolve without an entry per release.
MODEL_PRICES: dict[str, dict] = {
    # Anthropic
    "claude-opus-4":     {"input": 15.0, "output": 75.0, "cache_read": 1.50,  "cache_write": 18.75},
    "claude-3-opus":     {"input": 15.0, "output": 75.0, "cache_read": 1.50,  "cache_write": 18.75},
    "claude-sonnet-4":   {"input": 3.0,  "output": 15.0, "cache_read": 0.30,  "cache_write": 3.75},
    "claude-3-7-sonnet": {"input": 3.0,  "output": 15.0, "cache_read": 0.30,  "cache_write": 3.75},
    "claude-3-5-sonnet": {"input": 3.0,  "output": 15.0, "cache_read": 0.30,  "cache_write": 3.75},
    "claude-3-5-haiku":  {"input": 0.80, "output": 4.0,  "cache_read": 0.08,  "cache_write": 1.0},
    "claude-3-haiku":    {"input": 0.25, "output": 1.25, "cache_read": 0.03,  "cache_write": 0.30},
    # OpenAI
    "gpt-5-mini":        {"input": 0.25, "output": 2.0,  "cache_read": 0.025, "cache_write": 0.0},
    "gpt-5":             {"input": 1.25, "output": 10.0, "cache_read": 0.125, "cache_write": 0.0},
    "gpt-4.1-nano":      {"input": 0.10, "output": 0.40, "cache_read": 0.025, "cache_write": 0.0},
    "gpt-4.1-mini":      {"input": 0.40, "output": 1.60, "cache_read": 0.10,  "cache_write": 0.0},
    "gpt-4.1":           {"input": 2.0,  "output": 8.0,  "cache_read": 0.50,  "cache_write": 0.0},
    "gpt-4o-mini":       {"input": 0.15, "output": 0.60, "cache_read": 0.075, "cache_write": 0.0},
    "gpt-4o":            {"input": 2.50, "output": 10.0, "cache_read": 1.25,  "cache_write": 0.0},
    "gpt-4":             {"input": 30.0, "output": 60.0, "cache_read": 0.0,   "cache_write": 0.0},
    "o4-mini":           {"input": 1.10, "output": 4.40, "cache_read": 0.275, "cache_write": 0.0},
    "o3-mini":           {"input": 1.10, "output": 4.40, "cache_read": 0.55,  "cache_write": 0.0},
    "o3":                {"input": 2.0,  "output": 8.0,  "cache_read": 0.50,  "cache_write": 0.0},
    # DeepSeek
    "deepseek-reasoner": {"input": 0.55, "output": 2.19, "cache_read": 0.14,  "cache_write": 0.0},
    "deepseek-chat":     {"input": 0.27, "output": 1.10, "cache_read": 0.07,  "cache_write": 0.0},
    # Google
    "gemini-2.5-pro":    {"input": 1.25, "output": 10.0, "cache_read": 0.31,  "cache_write": 0.0},
    "gemini-2.5-flash":  {"input": 0.30, "output": 2.50, "cache_read": 0.075, "cache_write": 0.0},
    "gemini-2.0-flash":  {"input": 0.10, "output": 0.40, "cache_read": 0.025, "cache_write": 0.0},
    # Open-weight hosted
    "kimi-k2":           {"input": 0.60, "output": 2.50, "cache_read": 0.15,  "cache_write": 0.0},
    "glm-4.5":           {"input": 0.60, "output": 2.20, "cache_read": 0.11,  "cache_write": 0.0},
    "qwen-max":          {"input": 1.60, "output": 6.40, "cache_read": 0.40,  "cache_write": 0.0},
}

#: Used when the model is not in the table. Deliberately NOT zero: a cost of
#: zero reads as "this was free", which is the one thing we know it wasn't. The
#: figure is a mid-market rate and every row computed from it is stamped
#: ``fallback`` so the UI can say "approximate" instead of implying precision.
FALLBACK_PRICE = {"input": 1.0, "output": 4.0, "cache_read": 0.25, "cache_write": 0.0}

#: Cost provenance, written next to every cost figure.
COST_REPORTED = "reported"    # the provider told us what it charged
COST_ESTIMATED = "estimated"  # our table had this model
COST_FALLBACK = "fallback"    # our table did not; mid-market rate used


def _price_key(model_id: str) -> str:
    """Reduce a model identifier to the key the price table is indexed by.

    Strips our ``providerId:modelId`` composite and vendor path prefixes
    (``anthropic/claude-...``, ``openai/gpt-4o``) that OpenRouter-style proxies
    add, then lowercases. Without this, every proxied model is a table miss.
    """
    s = str(model_id or "").strip().lower()
    if ":" in s:
        s = s.split(":", 1)[1]
    if "/" in s:
        s = s.rsplit("/", 1)[1]
    return s.strip()


def lookup_price(model_id: str, overrides: dict = None) -> tuple[dict, str]:
    """Resolve rates for a model.

    Returns ``(rates, source)`` where source is :data:`COST_ESTIMATED` for a
    table hit and :data:`COST_FALLBACK` otherwise. Matching is longest-prefix so
    ``claude-3-5-sonnet-20241022`` hits ``claude-3-5-sonnet`` — and ``gpt-4o``
    cannot shadow ``gpt-4o-mini``, which a shortest-prefix scan would do.
    """
    key = _price_key(model_id)
    if not key:
        return dict(FALLBACK_PRICE), COST_FALLBACK
    table = dict(MODEL_PRICES)
    try:
        from model_catalog_loader import lookup_catalog_price
        cat_price = lookup_catalog_price(model_id)
        if cat_price and isinstance(cat_price, dict):
            table[key] = cat_price
    except Exception:
        pass
    if isinstance(overrides, dict):
        for k, v in overrides.items():
            if isinstance(v, dict):
                table[_price_key(k)] = v
    if key in table:
        return {**FALLBACK_PRICE, **table[key]}, COST_ESTIMATED
    hits = [k for k in table if key.startswith(k)]
    if hits:
        best = max(hits, key=len)
        return {**FALLBACK_PRICE, **table[best]}, COST_ESTIMATED
    return dict(FALLBACK_PRICE), COST_FALLBACK


def compute_cost(model_id: str, usage: dict, overrides: dict = None) -> dict:
    """Price one turn's token counts.

    Args:
        model_id: ``providerId:modelId`` or a bare model id.
        usage: ``{input, output, reasoning, cache_read, cache_creation}`` —
            the shape ``Router._normalize_usage`` produces. ``cost`` (USD), when
            a provider reports it, overrides the table entirely.
        overrides: User rate table, same shape as :data:`MODEL_PRICES`.

    Returns:
        ``{cost_micros, cache_saved_micros, cost_source, price_key}``.

    Billing note: providers disagree on whether ``input`` already contains the
    cached tokens. OpenAI-likes report ``prompt_tokens`` inclusive of
    ``cached_tokens``; Anthropic reports ``input_tokens`` exclusive of
    ``cache_read_input_tokens``. We subtract only when the numbers are
    consistent with the inclusive convention (``cache_read <= input``), which
    lands correctly on both instead of double-billing one and under-billing the
    other.
    """
    usage = usage if isinstance(usage, dict) else {}
    rates, source = lookup_price(model_id, overrides)

    reported = usage.get("cost")
    if isinstance(reported, (int, float)) and reported > 0:
        return {
            "cost_micros": int(round(float(reported) * 1_000_000)),
            "cache_saved_micros": 0,
            "cost_source": COST_REPORTED,
            "price_key": _price_key(model_id),
        }

    def _n(key: str) -> int:
        try:
            return max(int(usage.get(key) or 0), 0)
        except (TypeError, ValueError):
            return 0

    inp, outp = _n("input"), _n("output")
    reasoning, cache_read, cache_write = _n("reasoning"), _n("cache_read"), _n("cache_creation")
    is_exclusive = bool(usage.get("input_is_exclusive", False))

    if is_exclusive:
        billable_input = inp
    else:
        billable_input = inp - cache_read if 0 < cache_read <= inp else inp
    # Reasoning tokens are billed at the output rate everywhere that bills them
    # separately, and are usually already inside output_tokens — counting them
    # again would inflate every reasoning-model turn.
    billable_output = outp if outp >= reasoning else outp + reasoning

    micros = (
        billable_input * rates["input"]
        + billable_output * rates["output"]
        + cache_read * rates["cache_read"]
        + cache_write * rates["cache_write"]
    )
    # What the cache actually saved: those tokens would have been full-rate
    # input. This is the number that justifies the caching machinery existing.
    saved = cache_read * max(rates["input"] - rates["cache_read"], 0.0)
    return {
        "cost_micros": int(round(micros)),
        "cache_saved_micros": int(round(saved)),
        "cost_source": source,
        "price_key": _price_key(model_id),
    }


# ---------------------------------------------------------------------------
# Capability tiers & named call scenes (UD1)
# ---------------------------------------------------------------------------
# A turn's LLM calls are not equivalent. Writing a commit message, extracting a
# memory, summarizing a fold and judging whether a goal is done all have far
# lower intellectual density than the main reasoning loop — yet every one of them
# ran on the same (usually most expensive) client, because `get_llm_client()` is
# a process singleton and the cheap paths call `llm.call` on it directly.
#
# The fix is a capability floor per scene, not a hardcoded cheap model: which
# models exist is the user's decision, so the registry picks the cheapest model
# ALREADY CONFIGURED that clears the bar.

TIER_LIGHT = 1      # fast, cheap; fine for extraction / rewriting / formatting
TIER_STANDARD = 2   # general reasoning, tool use, most conversation
TIER_HEAVY = 3      # frontier; only where depth genuinely changes the answer

#: Named scenes. `min_tier` is a capability FLOOR, not a target — the router
#: still takes the cheapest candidate at or above it, so a user who configured
#: only one model always gets that one.
SCENE_CHAT = "chat"
SCENE_MEMORY_EXTRACT = "memory_extract"
SCENE_FOLD_SUMMARY = "fold_summary"
SCENE_GOAL_VERDICT = "goal_verdict"
SCENE_COMMIT_MESSAGE = "commit_message"
SCENE_AUTO_RESOLVE = "auto_resolve"

SCENES: dict[str, dict] = {
    # Main conversation is listed for completeness but never routed: the user
    # picked a model in the composer and that choice is absolute.
    SCENE_CHAT:            {"min_tier": TIER_STANDARD, "route": False,
                            "needs_tools": True},
    # Pull facts out of a file diff into JSON. Pattern work; a light model does
    # it as well as a frontier one and there is a regex fallback beneath it.
    SCENE_MEMORY_EXTRACT:  {"min_tier": TIER_LIGHT, "route": True},
    # Compress old messages. Losing nuance here is bounded — the audit pass
    # rejects a summary that dropped the important tokens.
    SCENE_FOLD_SUMMARY:    {"min_tier": TIER_LIGHT, "route": True},
    # One-line conventional-commit subject from a diff.
    SCENE_COMMIT_MESSAGE:  {"min_tier": TIER_LIGHT, "route": True},
    # Answer the agent's own clarifying question from conversation history.
    # Schema-constrained and low-stakes (a wrong self-answer is visible on the
    # card), so light is acceptable.
    SCENE_AUTO_RESOLVE:    {"min_tier": TIER_LIGHT, "route": True},
    # "Is this goal actually finished?" gates autonomous iteration, so a wrong
    # verdict either loops forever or stops early. Held at STANDARD.
    SCENE_GOAL_VERDICT:    {"min_tier": TIER_STANDARD, "route": True},
}

#: Output price (USD / 1M tokens) at or below which a model counts as LIGHT,
#: and the ceiling for STANDARD. Derived from the price table rather than a
#: second hand-maintained list — the thing that makes a model "cheap" IS its
#: rate, and one table cannot drift from the other if there is only one table.
#: 5.0 puts the small/fast families (nano, mini, flash, haiku) on one side and
#: the general-purpose ones (sonnet, gpt-4o, gemini pro) on the other; 20.0
#: separates those from the frontier tier (opus, gpt-4).
TIER_LIGHT_MAX_OUTPUT = 5.0
TIER_STANDARD_MAX_OUTPUT = 20.0

#: Model ids that must never be treated as light regardless of rate, because
#: reasoning models bill a lot of invisible thinking tokens on top of the
#: visible output — the sticker rate understates them.
REASONING_HINTS = ("o1", "o3", "o4", "-thinking", "reasoner", "-r1", "longcat")


def is_reasoning_model(model_id: str) -> bool:
    """Whether this model spends billable hidden thinking tokens."""
    key = _price_key(model_id)
    return any(h in key for h in REASONING_HINTS)


def infer_capability(model_id: str, overrides: dict = None) -> dict:
    """Guess a model's tier and relative cost from its published rates.

    Returns ``{tier, cost_weight, reasoning, priced}``. ``cost_weight`` is the
    output rate — the dimension that actually differs by an order of magnitude
    between tiers — so "cheapest that clears the bar" is a plain min().

    ``priced`` is False when the model was not in the table. Those land at
    STANDARD rather than LIGHT: an unknown model routed as cheap could be the
    user's only frontier model, and quietly sending memory extraction to it is
    recoverable, while quietly sending a goal verdict to something unfit is not.
    """
    rates, source = lookup_price(model_id, overrides)
    priced = source != COST_FALLBACK
    out = float(rates.get("output") or 0.0)
    reasoning = is_reasoning_model(model_id)
    if not priced:
        tier = TIER_STANDARD
    elif out > TIER_STANDARD_MAX_OUTPUT:
        tier = TIER_HEAVY
    elif out <= TIER_LIGHT_MAX_OUTPUT:
        # Reasoning models bill hidden thinking tokens on top of the visible
        # output, so the sticker rate understates them — never route one as light.
        tier = TIER_STANDARD if reasoning else TIER_LIGHT
    else:
        tier = TIER_STANDARD
    return {
        "tier": tier,
        "cost_weight": out,
        "reasoning": reasoning,
        "priced": priced,
    }


# ---------------------------------------------------------------------------
# Reasoning effort / thinking budget (UD4)
# ---------------------------------------------------------------------------
# Reasoning models think before they answer. That thinking is billed at the
# output rate and takes wall-clock time, and until now every call used whatever
# the model's own default was — so renaming a variable got the same 30 seconds of
# deliberation as a cross-file refactor.
#
# The knob exists at every major vendor but under a different name, a different
# type, and a different set of legal values. So the product speaks ONE vocabulary
# (the four levels below) and this module translates. Two rules make the whole
# thing safe:
#
#  1. `unset` is not `off`. Not sending the parameter (model decides) and asking
#     for no thinking are different requests, and collapsing them would silently
#     change behaviour for every existing user the moment this shipped.
#  2. A model that does not take the parameter gets NOTHING sent. Providers answer
#     an unknown field with 400, which `llm_errors` correctly classifies as
#     permanent — one wrong field would kill the whole turn rather than degrade.

#: The product-facing ladder. `EFFORT_UNSET` is the default and means "don't
#: mention it"; it is deliberately falsy so `if effort:` reads correctly.
EFFORT_UNSET = ""
EFFORT_OFF = "off"
EFFORT_LOW = "low"
EFFORT_HIGH = "high"
EFFORT_MAX = "max"
EFFORT_LEVELS = (EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX)

#: How a given model wants to be told. Not a vendor list — a WIRE FORMAT list,
#: because an OpenAI-compatible proxy in front of Claude speaks
#: `reasoning_effort`, while Anthropic's own API speaks `thinking`.
EFFORT_STYLE_NONE = ""              # no knob; do not send anything
EFFORT_STYLE_OPENAI = "reasoning_effort"
EFFORT_STYLE_ANTHROPIC = "thinking"
EFFORT_STYLE_GOOGLE = "thinking_config"
EFFORT_STYLE_DEEPSEEK = "deepseek_thinking"
EFFORT_STYLE_QWEN = "enable_thinking"

#: Model families that accept `reasoning_effort`. gpt-5 additionally accepts
#: "minimal", which is the only real "off" any OpenAI-style model has.
_EFFORT_OPENAI_HINTS = ("o1", "o3", "o4", "gpt-5", "longcat")
_EFFORT_MINIMAL_HINTS = ("gpt-5",)

#: Claude generations with extended thinking. Older Claudes take no knob at all,
#: and sending them one is exactly the 400 rule 2 above is about.
_EFFORT_ANTHROPIC_HINTS = ("claude-3-7", "claude-sonnet-4", "claude-opus-4")

#: Google Gemini generations with thinking capabilities (Gemini 2.5 / 3.0 / Thinking).
_EFFORT_GOOGLE_HINTS = ("gemini-2.5", "gemini-3", "gemini-thinking")

#: DeepSeek reasoning generations (DeepSeek-R1 / Reasoner / V3).
_EFFORT_DEEPSEEK_HINTS = ("deepseek-r1", "deepseek-reasoner", "deepseek-v3")

#: Qwen and Zhipu models with thinking toggles.
_EFFORT_QWEN_HINTS = ("qwq", "qwen-max-thinking", "qwen-thinking", "glm-zero", "glm-4-thinking")

#: Anthropic bills thinking against `budget_tokens`, and requires
#: `budget_tokens >= 1024` and strictly less than `max_tokens`. Both bounds are
#: enforced at send time (see llm_client._reasoning_body) rather than trusted
#: here, because the legal range depends on the caller's max_tokens.
ANTHROPIC_MIN_THINKING = 1024
ANTHROPIC_BUDGETS = {
    EFFORT_LOW: 2048,
    EFFORT_HIGH: 8192,
    EFFORT_MAX: 24576,
}

#: Google Gemini thinkingConfig specifications.
#: Gemini 2.5 Pro enforces an absolute maximum thinking budget ceiling of 32768.
GOOGLE_MIN_THINKING = 1024
GOOGLE_MAX_THINKING = 32768
GOOGLE_BUDGETS = {
    EFFORT_LOW: 2048,
    EFFORT_HIGH: 8192,
    EFFORT_MAX: 24576,
}
GOOGLE_LEVELS = {
    EFFORT_LOW: "LOW",
    EFFORT_HIGH: "HIGH",
    EFFORT_MAX: "HIGH",
}


@dataclass(frozen=True)
class ModelThinkingProfile:
    """Single model thinking and reasoning protocol capability profile."""
    model_id_prefix: str                        # Prefix or characteristic keyword
    family: str                                 # Vendor family (openai, anthropic, google, deepseek, qwen, moonshot)
    wire_format: str                            # Wire dialect (reasoning_effort, thinking, thinking_config, enable_thinking, deepseek_thinking)
    supported_levels: tuple[str, ...]           # Actual supported effort level variants
    can_disable_thinking: bool                  # Whether thinking can genuinely be turned off
    default_level: str = EFFORT_HIGH            # Default effort level
    budget_range: tuple[int, int] = (1024, 32768) # Thinking budget boundaries (min, max)
    temperature_policy: str = "allowed"         # "allowed" | "strip" | "fixed_1.0"


BUILTIN_MODEL_PROFILES: list[ModelThinkingProfile] = [
    # 1. OpenAI o-series: cannot disable thinking, sampling knobs stripped
    ModelThinkingProfile(
        model_id_prefix="o1",
        family="openai",
        wire_format=EFFORT_STYLE_OPENAI,
        supported_levels=(EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX),
        can_disable_thinking=False,
        temperature_policy="strip",
    ),
    ModelThinkingProfile(
        model_id_prefix="o3",
        family="openai",
        wire_format=EFFORT_STYLE_OPENAI,
        supported_levels=(EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX),
        can_disable_thinking=False,
        temperature_policy="strip",
    ),
    ModelThinkingProfile(
        model_id_prefix="o4",
        family="openai",
        wire_format=EFFORT_STYLE_OPENAI,
        supported_levels=(EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX),
        can_disable_thinking=False,
        temperature_policy="strip",
    ),
    # 2. GPT-5: supports minimal, equivalent to true off
    ModelThinkingProfile(
        model_id_prefix="gpt-5",
        family="openai",
        wire_format=EFFORT_STYLE_OPENAI,
        supported_levels=(EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX),
        can_disable_thinking=True,
        temperature_policy="strip",
    ),
    # 3. Anthropic Extended Thinking
    ModelThinkingProfile(
        model_id_prefix="claude-3-7",
        family="anthropic",
        wire_format=EFFORT_STYLE_ANTHROPIC,
        supported_levels=(EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX),
        can_disable_thinking=True,
        budget_range=(1024, 64000),
        temperature_policy="strip",
    ),
    ModelThinkingProfile(
        model_id_prefix="claude-sonnet-4",
        family="anthropic",
        wire_format=EFFORT_STYLE_ANTHROPIC,
        supported_levels=(EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX),
        can_disable_thinking=True,
        budget_range=(1024, 64000),
        temperature_policy="strip",
    ),
    ModelThinkingProfile(
        model_id_prefix="claude-opus-4",
        family="anthropic",
        wire_format=EFFORT_STYLE_ANTHROPIC,
        supported_levels=(EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX),
        can_disable_thinking=True,
        budget_range=(1024, 64000),
        temperature_policy="strip",
    ),
    # 4. Google Gemini 2.5 / 3.0
    ModelThinkingProfile(
        model_id_prefix="gemini-2.5",
        family="google",
        wire_format=EFFORT_STYLE_GOOGLE,
        supported_levels=(EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX),
        can_disable_thinking=True,
        budget_range=(1024, 32768),
        temperature_policy="allowed",
    ),
    ModelThinkingProfile(
        model_id_prefix="gemini-3",
        family="google",
        wire_format=EFFORT_STYLE_GOOGLE,
        supported_levels=(EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX),
        can_disable_thinking=True,
        budget_range=(1024, 32768),
        temperature_policy="allowed",
    ),
    ModelThinkingProfile(
        model_id_prefix="gemini-thinking",
        family="google",
        wire_format=EFFORT_STYLE_GOOGLE,
        supported_levels=(EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX),
        can_disable_thinking=True,
        budget_range=(1024, 32768),
        temperature_policy="allowed",
    ),
    # 5. DeepSeek Reasoning series
    ModelThinkingProfile(
        model_id_prefix="deepseek-r1",
        family="deepseek",
        wire_format=EFFORT_STYLE_DEEPSEEK,
        supported_levels=(EFFORT_OFF, EFFORT_HIGH),
        can_disable_thinking=True,
        temperature_policy="allowed",
    ),
    ModelThinkingProfile(
        model_id_prefix="deepseek-reasoner",
        family="deepseek",
        wire_format=EFFORT_STYLE_DEEPSEEK,
        supported_levels=(EFFORT_OFF, EFFORT_HIGH),
        can_disable_thinking=True,
        temperature_policy="allowed",
    ),
    # 6. Qwen QwQ series
    ModelThinkingProfile(
        model_id_prefix="qwq",
        family="qwen",
        wire_format=EFFORT_STYLE_QWEN,
        supported_levels=(EFFORT_OFF, EFFORT_HIGH),
        can_disable_thinking=True,
        temperature_policy="allowed",
    ),
    ModelThinkingProfile(
        model_id_prefix="qwen-max-thinking",
        family="qwen",
        wire_format=EFFORT_STYLE_QWEN,
        supported_levels=(EFFORT_OFF, EFFORT_HIGH),
        can_disable_thinking=True,
        temperature_policy="allowed",
    ),
    ModelThinkingProfile(
        model_id_prefix="qwen-thinking",
        family="qwen",
        wire_format=EFFORT_STYLE_QWEN,
        supported_levels=(EFFORT_OFF, EFFORT_HIGH),
        can_disable_thinking=True,
        temperature_policy="allowed",
    ),
    ModelThinkingProfile(
        model_id_prefix="glm-zero",
        family="qwen",
        wire_format=EFFORT_STYLE_QWEN,
        supported_levels=(EFFORT_OFF, EFFORT_HIGH),
        can_disable_thinking=True,
        temperature_policy="allowed",
    ),
    ModelThinkingProfile(
        model_id_prefix="glm-4-thinking",
        family="qwen",
        wire_format=EFFORT_STYLE_QWEN,
        supported_levels=(EFFORT_OFF, EFFORT_HIGH),
        can_disable_thinking=True,
        temperature_policy="allowed",
    ),
    # 7. Moonshot / Kimi series
    ModelThinkingProfile(
        model_id_prefix="kimi-k2.5",
        family="moonshot",
        wire_format=EFFORT_STYLE_NONE,
        supported_levels=(),
        can_disable_thinking=False,
        temperature_policy="fixed_1.0",
    ),
    ModelThinkingProfile(
        model_id_prefix="kimi-k2.6",
        family="moonshot",
        wire_format=EFFORT_STYLE_NONE,
        supported_levels=(),
        can_disable_thinking=False,
        temperature_policy="fixed_1.0",
    ),
    ModelThinkingProfile(
        model_id_prefix="kimi-k3",
        family="moonshot",
        wire_format=EFFORT_STYLE_NONE,
        supported_levels=(),
        can_disable_thinking=False,
        temperature_policy="strip",
    ),
]

_EXTERNAL_MODEL_PROFILES: list[ModelThinkingProfile] = []


def register_model_profile(profile: ModelThinkingProfile) -> None:
    """Register an external or runtime model profile with highest priority."""
    _EXTERNAL_MODEL_PROFILES.insert(0, profile)


def lookup_model_profile(model_id: str, kind: str = "") -> Optional[ModelThinkingProfile]:
    """Resolve ModelThinkingProfile for model_id.

    Precedence:
    1. Runtime programmatic overrides (_EXTERNAL_MODEL_PROFILES)
    2. Dynamic models.json catalog (project & user level)
    3. Built-in hardcoded profiles (BUILTIN_MODEL_PROFILES)
    4. Protocol-first inference (inferred from provider protocol kind)
    """
    key = _price_key(model_id)
    if not key:
        return None
    for prof in _EXTERNAL_MODEL_PROFILES:
        if prof.model_id_prefix in key:
            return prof

    loader = None
    try:
        from model_catalog_loader import get_catalog_loader
        loader = get_catalog_loader()
        cat_prof = loader.lookup_profile(model_id, kind)
        if cat_prof is not None:
            return cat_prof
    except Exception:
        pass

    for prof in BUILTIN_MODEL_PROFILES:
        if prof.model_id_prefix in key:
            return prof

    if loader is not None and kind:
        try:
            inferred = loader.infer_profile_from_protocol(model_id, kind)
            if inferred is not None:
                return inferred
        except Exception:
            pass

    return None

get_model_thinking_profile = lookup_model_profile


def normalize_effort(level: str) -> str:
    """Coerce anything to a known level, defaulting to ``EFFORT_UNSET``.

    Unknown input becomes "don't send it" rather than a guess: a typo in a config
    file must not silently spend a maximum thinking budget on every turn.
    """
    s = str(level or "").strip().lower()
    return s if s in EFFORT_LEVELS else EFFORT_UNSET


def effort_style(model_id: str, kind: str = "", declared: bool = None) -> str:
    """Which wire format ``model_id`` accepts, or ``EFFORT_STYLE_NONE``.

    ``kind`` is the provider's protocol (``anthropic`` / ``openai-compatible``).
    It is checked first for Claude because the same model reached through an
    OpenAI-compatible proxy takes `reasoning_effort` instead of `thinking` — the
    model name alone cannot answer this.

    ``declared`` is the user's three-state override (#151). Name matching is a
    guess, and it fails in both directions on a proxy: a relabelled reasoning
    model gets no dial, and something merely named like one gets a dial it will
    reject. ``True`` forces a dialect (the provider protocol picks which),
    ``False`` forces silence, ``None`` keeps the guess.
    """
    if declared is False:
        return EFFORT_STYLE_NONE
    key = _price_key(model_id)
    k = str(kind or "").lower()
    anthropic = k == "anthropic"
    google = k in ("google", "gemini")
    deepseek = k == "deepseek"
    qwen = k in ("qwen", "glm")

    # 1. Check profile registry first
    prof = lookup_model_profile(model_id, kind)
    if prof is not None and prof.wire_format != EFFORT_STYLE_NONE:
        if prof.family == "anthropic" and not anthropic:
            return EFFORT_STYLE_OPENAI
        return prof.wire_format

    # 2. Heuristic hints fallback
    if key and any(h in key for h in _EFFORT_ANTHROPIC_HINTS):
        return EFFORT_STYLE_ANTHROPIC if anthropic else EFFORT_STYLE_OPENAI
    if key and any(h in key for h in _EFFORT_GOOGLE_HINTS):
        return EFFORT_STYLE_GOOGLE
    if key and any(h in key for h in _EFFORT_DEEPSEEK_HINTS):
        return EFFORT_STYLE_DEEPSEEK
    if key and any(h in key for h in _EFFORT_QWEN_HINTS):
        return EFFORT_STYLE_QWEN
    if key and any(h in key for h in _EFFORT_OPENAI_HINTS):
        return EFFORT_STYLE_OPENAI
    if declared is True:
        if anthropic:
            return EFFORT_STYLE_ANTHROPIC
        if google:
            return EFFORT_STYLE_GOOGLE
        if deepseek:
            return EFFORT_STYLE_DEEPSEEK
        if qwen:
            return EFFORT_STYLE_QWEN
        return EFFORT_STYLE_OPENAI
    # Everything else — including non-reasoning models.
    return EFFORT_STYLE_NONE


def supports_effort(model_id: str, kind: str = "", declared: bool = None) -> bool:
    """Whether this model has a thinking dial the user can move at all."""
    return effort_style(model_id, kind, declared) != EFFORT_STYLE_NONE


def build_thinking_capability(
    model_id: str,
    kind: str = "",
    declared: bool = None,
    *,
    catalog_reasoning: bool = False,
) -> dict:
    """Resolved thinking UI + wire metadata for one model.

    Single source of truth for the composer dial. Priority:
    user override (declared) > catalog/profile > registry heuristics > unknown.
    """
    style = effort_style(model_id, kind, declared)
    internal = is_reasoning_model(model_id)
    profile = lookup_model_profile(model_id, kind)

    if declared is False:
        state, source, confidence = "unsupported", "user_override", 1.0
    elif declared is True or style != EFFORT_STYLE_NONE:
        state = "supported"
        if declared is True:
            source, confidence = "user_override", 1.0
        elif profile is not None or catalog_reasoning:
            source, confidence = "model_profile", 0.95
        else:
            source, confidence = "heuristic", 0.78
    else:
        state, source, confidence = "unknown", "none", 0.0

    can_disable = profile.can_disable_thinking if profile is not None else True
    if profile is not None and profile.supported_levels:
        variants = list(profile.supported_levels)
    else:
        variants = list(EFFORT_LEVELS)

    if not can_disable:
        variants = [v for v in variants if v != EFFORT_OFF]

    default_variant = profile.default_level if profile else EFFORT_HIGH
    if variants and default_variant not in variants:
        default_variant = variants[0]

    show_dial = state == "supported"
    control = None
    if show_dial and style:
        param = "reasoning_effort"
        if style == EFFORT_STYLE_ANTHROPIC:
            param = "thinking"
        elif style == EFFORT_STYLE_GOOGLE:
            param = "thinkingConfig"
        elif style == EFFORT_STYLE_DEEPSEEK:
            param = "thinking"
        elif style == EFFORT_STYLE_QWEN:
            param = "enable_thinking"
        control = {
            "kind": "effort",
            "parameter": param,
            "wireFormat": style,
            "values": variants,
            "default": default_variant,
        }

    # Observed reasoning output in stream is separate from controllable effort.
    if internal:
        output = "visible"
    elif state == "supported":
        output = "unknown"
    else:
        output = "hidden"

    return {
        "thinking": {
            "state": state,
            "source": source,
            "confidence": confidence,
            "output": output,
            "canDisable": can_disable,
        },
        "control": control,
        "ui": {
            "showDial": show_dial,
            "variants": variants if show_dial else [],
            "defaultVariant": default_variant,
        },
    }


def reasoning_params(model_id: str, level: str, kind: str = "",
                     declared: bool = None) -> dict:
    """Body fields that express ``level`` for this model. ``{}`` when it can't.

    Returns an empty dict for an unsupported model, an unknown level, and for
    ``EFFORT_UNSET`` — three different reasons that all mean the same thing on
    the wire: send nothing and let the model do what it does by default.

    ``off`` is the interesting case. Anthropic thinking is opt-in, so off is
    simply the absence of the block. OpenAI's o-series cannot be turned off at
    all and floors at ``low``; only gpt-5 has a real ``minimal``. Pretending
    otherwise would promise the user a switch that does nothing.
    """
    level = normalize_effort(level)
    if not level:
        return {}
    style = effort_style(model_id, kind, declared)
    if style == EFFORT_STYLE_OPENAI:
        key = _price_key(model_id)
        if level == EFFORT_OFF:
            if any(h in key for h in _EFFORT_MINIMAL_HINTS):
                return {"reasoning_effort": "minimal"}
            return {"reasoning_effort": "low"}
        # "max" collapses to "high": the vendor ladder has three rungs, and
        # inventing a fourth value would be rejected outright.
        return {"reasoning_effort": "high" if level == EFFORT_MAX else level}
    if style == EFFORT_STYLE_ANTHROPIC:
        if level == EFFORT_OFF:
            return {}
        budget = ANTHROPIC_BUDGETS.get(level)
        if not budget:
            return {}
        return {"thinking": {"type": "enabled", "budget_tokens": int(budget)}}
    if style == EFFORT_STYLE_GOOGLE:
        if level == EFFORT_OFF:
            # Google Gemini 2.5 Pro/Flash default to thinking enabled;
            # to genuinely disable thinking, the API strictly requires thinkingBudget: 0.
            return {"thinkingConfig": {"thinkingBudget": 0}}
        budget = int(GOOGLE_BUDGETS.get(level, 8192))
        return {
            "thinkingConfig": {
                "includeThoughts": True,
                "thinkingBudget": min(budget, GOOGLE_MAX_THINKING),
                "thinkingLevel": GOOGLE_LEVELS.get(level, "HIGH"),
            }
        }
    if style == EFFORT_STYLE_DEEPSEEK:
        state = "disabled" if level == EFFORT_OFF else "enabled"
        return {"thinking": {"type": state}}
    if style == EFFORT_STYLE_QWEN:
        return {"enable_thinking": level != EFFORT_OFF}
    return {}


#: Per-scene thinking level, the middle of the three override layers
#: (global default → scene → this turn). Background work that produces a single
#: line or a JSON blob gains nothing from deliberation and pays for it twice, in
#: latency and in hidden output tokens. `SCENE_CHAT` is deliberately absent: the
#: conversation follows the user's own setting, never a table.
SCENE_EFFORTS: dict[str, str] = {
    SCENE_COMMIT_MESSAGE: EFFORT_OFF,
    SCENE_MEMORY_EXTRACT: EFFORT_OFF,
    SCENE_FOLD_SUMMARY: EFFORT_OFF,
    SCENE_AUTO_RESOLVE: EFFORT_LOW,
    # "Is this goal finished?" gates autonomous iteration, so a shallow wrong
    # verdict either loops forever or stops early — worth some thinking.
    SCENE_GOAL_VERDICT: EFFORT_LOW,
}


def scene_effort(scene: str) -> str:
    """Thinking level for a named scene, or ``EFFORT_UNSET`` if it has no opinion."""
    return SCENE_EFFORTS.get(str(scene or ""), EFFORT_UNSET)


# ---------------------------------------------------------------------------
# Provider compatibility matrix (#151)
# ---------------------------------------------------------------------------
# "OpenAI-compatible" is a family resemblance, not a contract. The same request
# body that works on gpt-4o is rejected outright by o3, because the reasoning
# generation renamed `max_tokens` to `max_completion_tokens` and dropped
# `temperature` entirely. We were sending both unconditionally, so every turn on
# an o-series model died on an HTTP 400 — and since `llm_errors` (correctly)
# treats 400 as permanent, it neither retried nor downgraded. One wrong field
# name made those models completely unusable.
#
# So the differences get declared here, as data, and the body is assembled from
# a PLAN rather than by branching at each call site. The plan has two verbs:
#
#   set   — write this field
#   unset — remove this field if present
#
# `unset` is the verb the previous implementation lacked, and the reason it could
# only ever be wrong: several of these rules are *subtractive*. Anthropic's
# extended thinking rejects a request that also carries `temperature`, and a
# rename is just unset-old + set-new.

#: The field carrying the output allowance. Two spellings, one meaning.
COMPAT_MAX_TOKENS = "max_tokens"
COMPAT_MAX_COMPLETION_TOKENS = "max_completion_tokens"

#: Model families that speak the reasoning-era dialect: `max_completion_tokens`,
#: and no sampling knobs (temperature / top_p are fixed server-side).
_COMPAT_REASONING_ERA = ("o1", "o3", "o4", "gpt-5")

#: Moonshot / Kimi compatibility rules: k2.x requires fixed temperature=1.0,
#: while k3 is reasoning-era and rejects temperature / top_p entirely.
_COMPAT_KIMI_K2 = ("k2.5", "k2.6", "kimi-k2.5", "kimi-k2.6", "moonshot-v1-k2.5", "moonshot-v1-k2.6")
_COMPAT_KIMI_K3 = ("k3", "kimi-k3", "moonshot-k3")

#: Fields Anthropic rejects once extended thinking is enabled. Thinking replaces
#: sampling — the model is not free to also be told how random to be.
_COMPAT_THINKING_CONFLICTS = ("temperature", "top_p", "top_k")

#: Ceiling used when we don't know the model's real output limit. Deliberately
#: generous but finite: the budget math needs *some* bound, and silently
#: uncapping would let a max-effort request ask for more than the model allows.
DEFAULT_OUTPUT_CEILING = 32000


def normalize_modalities(raw) -> list:
    """Flatten whatever shape the caller has into a flat INPUT modality list.

    Two shapes reach us. Storage and config.json use a flat
    ``["text", "image"]``; the Electron provider catalogue uses
    ``{"input": [...], "output": [...]}`` and ``syncToBackend`` forwards it
    verbatim. Only the flat form was ever handled, so for every UI-synced
    provider ``"image" in modalities`` tested a DICT and answered on its keys —
    always False. Vision inference could not fire for the only providers users
    actually configure.

    Output modalities are dropped on purpose: this list answers "what can I put
    IN", which is the only question the image gate asks.
    """
    if isinstance(raw, dict):
        got = raw.get("input")
        raw = got if isinstance(got, (list, tuple)) else ["text"]
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, (list, tuple)):
        return ["text"]
    out = [str(m).strip().lower() for m in raw if str(m).strip()]
    return out or ["text"]


def model_compat(model_id: str, kind: str = "", effort_declared: bool = None) -> dict:
    """Which body dialect this model speaks.

    Returns ``{max_tokens_field, supports_temperature, fixed_temperature, supports_effort,
    thinking_conflicts}``. Keyed on the model family rather than the provider,
    because a proxy in front of o3 still has to obey o3's field names.
    """
    key = _price_key(model_id)
    reasoning_era = any(h in key for h in _COMPAT_REASONING_ERA)
    is_kimi_k3 = any(h in key for h in _COMPAT_KIMI_K3)
    is_kimi_k2 = any(h in key for h in _COMPAT_KIMI_K2)
    style = effort_style(model_id, kind, effort_declared)
    return {
        "max_tokens_field": (COMPAT_MAX_COMPLETION_TOKENS if reasoning_era
                             else COMPAT_MAX_TOKENS),
        "supports_temperature": not (reasoning_era or is_kimi_k3),
        "fixed_temperature": 1.0 if is_kimi_k2 else None,
        "supports_effort": style != EFFORT_STYLE_NONE,
        "effort_style": style,
        "thinking_conflicts": _COMPAT_THINKING_CONFLICTS,
    }


def thinking_allowance(base_max_tokens: int, budget: int, output_ceiling: int = 0) -> dict:
    """How much output room to ask for once ``budget`` tokens go to thinking.

    Returns ``{max_tokens, budget}``, both already legal.

    The budget is **added on top of** the base answer allowance, then capped by
    the model's own output ceiling. The first implementation subtracted it
    instead — carving thinking room out of ``max_tokens`` — which meant turning
    the dial up SHRANK the answer. That is backwards: asking to think harder is
    not asking to say less.

    Only when the ceiling can't accommodate both does the budget give way, and
    even then it keeps :data:`ANTHROPIC_MIN_THINKING` of answer room in reserve.
    Returns a zero budget when there isn't room for the vendor minimum, which the
    caller must read as "don't enable thinking at all" rather than "enable it
    with a tiny budget" — the latter is an illegal request.
    """
    base = max(int(base_max_tokens or 0), 0)
    budget = max(int(budget or 0), 0)
    ceiling = int(output_ceiling or 0) or DEFAULT_OUTPUT_CEILING
    if not budget:
        return {"max_tokens": base or ceiling, "budget": 0}
    want = base + budget
    if want <= ceiling:
        return {"max_tokens": want, "budget": budget}
    # Doesn't fit. Keep answer room first, then give thinking whatever is left.
    room = ceiling - ANTHROPIC_MIN_THINKING
    if room < ANTHROPIC_MIN_THINKING:
        return {"max_tokens": min(base or ceiling, ceiling), "budget": 0}
    return {"max_tokens": ceiling, "budget": min(budget, room)}


def body_plan(model_id: str, kind: str = "", effort: str = "",
              base_max_tokens: int = 0, output_ceiling: int = 0,
              effort_declared: bool = None) -> dict:
    """The full set/unset plan for one request body.

    Returns ``{"set": dict, "unset": tuple, "compat": dict}``. Callers apply
    ``set`` then ``unset`` — subtraction last, so a rule that removes a field
    always wins over one that wrote it.

    Every dialect difference is resolved here, once, from data. Assembling this
    at the call site is what let the o-series bug exist: each of `chat`,
    `chat_stream` and `call` built its own body and none of them knew that one
    model family spells the output limit differently.

    ``effort_declared`` is the provider's three-state thinking declaration
    (``None`` infer / ``True`` force on / ``False`` force off). It only ever
    reaches the thinking rules — the output-field and sampling rules are facts
    about the model's API, not user preferences, so a declaration must not be
    able to turn a legal body into an illegal one.
    """
    compat = model_compat(model_id, kind, effort_declared)
    set_: dict = {}
    unset: list = []

    # 1. Output allowance under whichever name this family accepts.
    field = compat["max_tokens_field"]
    if field != COMPAT_MAX_TOKENS:
        unset.append(COMPAT_MAX_TOKENS)
        if base_max_tokens:
            set_[field] = int(base_max_tokens)

    # 2. Sampling knobs the model rejects outright or forces fixed.
    if compat.get("fixed_temperature") is not None:
        set_["temperature"] = float(compat["fixed_temperature"])
    elif not compat["supports_temperature"]:
        unset.extend(("temperature", "top_p"))

    # 3. Thinking. `reasoning_params` already returns {} for models with no dial
    #    and for EFFORT_UNSET, so an unsupported knob is never mentioned.
    params = reasoning_params(model_id, effort, kind, effort_declared)
    think = params.get("thinking") if isinstance(params, dict) else None
    google_think = params.get("thinkingConfig") if isinstance(params, dict) else None
    if isinstance(think, dict):
        if compat.get("effort_style") == EFFORT_STYLE_DEEPSEEK:
            set_["thinking"] = think
            unset.append("reasoning_effort")
        else:
            allowance = thinking_allowance(
                base_max_tokens, int(think.get("budget_tokens") or 0), output_ceiling,
            )
            if allowance["budget"]:
                set_[field] = allowance["max_tokens"]
                set_["thinking"] = {**think, "budget_tokens": allowance["budget"]}
                unset.extend(compat["thinking_conflicts"])
    elif isinstance(google_think, dict):
        budget = int(google_think.get("thinkingBudget") or 0)
        ceiling = int(output_ceiling or 0) or GOOGLE_MAX_THINKING
        actual_ceiling = min(ceiling, GOOGLE_MAX_THINKING)
        clamped_budget = min(budget, actual_ceiling)
        set_["thinkingConfig"] = {
            **google_think,
            "thinkingBudget": clamped_budget,
        }
        unset.append("reasoning_effort")
    elif compat.get("effort_style") == EFFORT_STYLE_QWEN and params:
        set_.update(params)
        unset.append("reasoning_effort")
    elif params:
        set_.update(params)

    # dict.fromkeys de-dupes while keeping order, so the plan reads the same way
    # twice — a plan that shuffles makes "why did this request differ" moot.
    return {"set": set_, "unset": tuple(dict.fromkeys(unset)), "compat": compat}


#: Env var holding the master key used to derive the credential encryption key.
MASTER_KEY_ENV = "OVOLVE_MASTER_KEY"

#: Reserved provider id for the entry seeded from config.json's ``model`` block.
#: Reserved (not a uuid) so it can never collide with a user-registered provider
#: and so ``_save_to_storage`` can skip it — config.json owns that credential.
CONFIG_PROVIDER_ID = "__config__"


class CipherUnavailable(RuntimeError):
    """Raised when real encryption is unavailable and fallback is disallowed."""


class CredentialCipher:
    """Credential encryption behind an ``enc:`` prefix.

    Uses Fernet (AES-128-CBC + HMAC-SHA256) from ``cryptography`` when it is
    installed. If it is missing, encryption is **not** silently downgraded to
    base64 — ``available`` reports False and ``encrypt`` marks the value
    ``plain:`` so callers and audits can tell real protection apart from
    obfuscation.

    The master key comes from ``OVOLVE_MASTER_KEY``. Without it a
    machine-derived key is used, which protects against casual disk reads but
    not against an attacker who can run code as this user.
    """

    PREFIX_ENC = "enc:"
    PREFIX_PLAIN = "plain:"

    def __init__(self, master_key: str = None) -> None:
        secret = master_key or os.environ.get(MASTER_KEY_ENV) or self._machine_key()
        self._key = self._derive_key(secret)
        self._fernet = self._build_fernet()

    @staticmethod
    def _machine_key() -> str:
        """Derive a per-machine, per-user fallback secret."""
        seed = f"{os.path.expanduser('~')}|{uuid.getnode()}"
        return hashlib.sha256(seed.encode()).hexdigest()

    def _derive_key(self, password: str) -> bytes:
        return hashlib.pbkdf2_hmac("sha256", password.encode(), b"ovolve-salt", 100000, 32)

    def _build_fernet(self):
        """Construct a Fernet instance, or None when cryptography is absent."""
        try:
            from cryptography.fernet import Fernet
            return Fernet(base64.urlsafe_b64encode(self._key))
        except ImportError:
            return None

    @property
    def available(self) -> bool:
        """Whether real (authenticated) encryption is in use."""
        return self._fernet is not None

    def encrypt(self, plaintext: str) -> str:
        """Encrypt a secret for storage.

        Returns:
            ``enc:<token>`` when cryptography is available, otherwise
            ``plain:<base64>`` so the weaker protection is visible.
        """
        if not plaintext:
            return ""
        if self._fernet is None:
            return self.PREFIX_PLAIN + base64.b64encode(plaintext.encode()).decode()
        return self.PREFIX_ENC + self._fernet.encrypt(plaintext.encode()).decode()

    def decrypt(self, stored: str) -> str:
        """Decrypt a stored secret, returning "" on any failure.

        Never raises: a corrupt or foreign-key ciphertext must not crash
        registry construction (and therefore app startup).
        """
        if not stored:
            return ""
        if stored.startswith(self.PREFIX_PLAIN):
            try:
                return base64.b64decode(stored[len(self.PREFIX_PLAIN):]).decode()
            except Exception:
                return ""
        if not stored.startswith(self.PREFIX_ENC):
            return stored  # legacy plaintext value
        token = stored[len(self.PREFIX_ENC):]
        if self._fernet is None:
            # Written by an older base64 fallback that also used enc:
            try:
                return base64.b64decode(token.encode()).decode()
            except Exception:
                return ""
        try:
            return self._fernet.decrypt(token.encode()).decode()
        except Exception:
            return ""

class ModelInfo:
    def __init__(self, model_id: str, context_limit: int = 200000, output_limit: int = 8192,
                 modalities: list = None, tier: int = 0, cost_weight: float = None,
                 supports_tools: bool = None, supports_vision: bool = None,
                 supports_thinking: bool = None, disabled_reason: str = ""):
        self.model_id = model_id
        self.context_limit = context_limit
        self.output_limit = output_limit
        self.modalities = normalize_modalities(modalities)
        # Capability tags (UD1). Zero/None mean "not declared" → inferred from
        # the price table on demand. An explicit value from config always wins,
        # so a user who knows their proxy exposes a strong model under a cheap
        # name can say so and stop it being routed cheap work it can't do.
        self._tier = int(tier or 0)
        self._cost_weight = cost_weight
        self._supports_tools = supports_tools
        # Three-state on purpose (#151): None = not declared, True/False = the
        # user said so. A plain boolean would make "the settings page has never
        # been opened" indistinguishable from "explicitly unsupported", which
        # would blank out every model's capabilities on first render.
        self._supports_vision = supports_vision
        self._supports_thinking = supports_thinking
        #: Why this model is unselectable, shown next to it instead of a silent
        #: absence. "" = selectable.
        self.disabled_reason = str(disabled_reason or "")

    @property
    def supports_thinking_declared(self):
        """The raw tri-state thinking declaration (None / True / False).

        Exposed separately from :meth:`capability` because a consumer that has to
        DECIDE (the body builder) needs to know whether the user spoke, while a
        consumer that only has to DISPLAY wants the resolved boolean.
        """
        return self._supports_thinking

    @property
    def supports_vision_declared(self):
        """The raw tri-state vision declaration (None / True / False)."""
        return self._supports_vision

    def capability(self, overrides: dict = None, kind: str = "") -> dict:
        """Resolved ``{tier, cost_weight, reasoning, supports_tools,
        supports_vision, supports_thinking, declared}``.

        Declared fields win; anything left unset is inferred — tier and cost from
        the price table, vision from the modality list, thinking from the model
        family. ``declared`` reports which of the three-state flags the user
        actually set, so the UI can render "inherited" differently from "chosen".
        """
        inferred = infer_capability(self.model_id, overrides)
        tier = self._tier or inferred["tier"]
        weight = self._cost_weight if self._cost_weight is not None else inferred["cost_weight"]
        tools = self._supports_tools if self._supports_tools is not None else True
        vision = (self._supports_vision if self._supports_vision is not None
                  else "image" in (self.modalities or []))
        thinking = (self._supports_thinking if self._supports_thinking is not None
                    else supports_effort(self.model_id, kind))
        return {
            "tier": tier,
            "cost_weight": float(weight),
            "reasoning": inferred["reasoning"],
            "supports_tools": bool(tools),
            "supports_vision": bool(vision),
            "supports_thinking": bool(thinking),
            "declared": {
                "tier": bool(self._tier),
                "costWeight": self._cost_weight is not None,
                "supportsTools": self._supports_tools is not None,
                "supportsVision": self._supports_vision is not None,
                "supportsThinking": self._supports_thinking is not None,
            },
        }

class ProviderConfig:
    def __init__(self, provider_id: str, name: str, kind: str = "anthropic",
                 api_key: str = "", base_url: str = "", enabled: bool = True,
                 refresh_token: str = "", token_endpoint: str = "",
                 client_id: str = "", token_expires_at: float = 0.0):
        self.provider_id = provider_id
        self.name = name
        self.kind = kind  # anthropic / openai-compatible / oauth
        self.api_key = api_key
        self.base_url = base_url
        self.enabled = enabled
        self.models: dict[str, ModelInfo] = {}
        # OAuth fields (TODO §5.1)
        self.refresh_token = refresh_token
        self.token_endpoint = token_endpoint
        self.client_id = client_id
        self.token_expires_at = token_expires_at

    def add_model(self, model: ModelInfo):
        self.models[model.model_id] = model

    @property
    def has_oauth(self) -> bool:
        """Whether this provider uses OAuth refresh tokens."""
        return bool(self.refresh_token and self.token_endpoint)

    @property
    def token_expired(self) -> bool:
        """Whether the current access token is expired or about to expire."""
        if self.token_expires_at <= 0:
            return False  # No expiry tracking = assume valid
        return time.time() >= (self.token_expires_at - 60)  # 1 min buffer

class ModelRegistry:
    """Multi-model registry with auth + token billing."""
    def __init__(self):
        self._providers: dict[str, ProviderConfig] = {}
        self._cipher = CredentialCipher()
        self._active_model: str = ""
        self._active_provider: str = ""
        #: Filled by :meth:`seed_from_config`; the last-resort answer for resolve().
        self._config_fallback: dict = {}
        #: provider_id -> {fails, until, code}. In-memory on purpose: a cooldown
        #: is a statement about the last two minutes, and persisting it would
        #: outlive the outage and skip a provider that has since recovered.
        self._provider_health: dict[str, dict] = {}
        self._storage = get_storage()
        self._load_from_storage()

    def _load_from_storage(self):
        """Load provider configs from storage."""
        raw = self._storage.get_config("providers", {})
        if not isinstance(raw, dict): return
        for pid, pcfg in raw.items():
            provider = ProviderConfig(
                pid, pcfg.get("name", ""), pcfg.get("kind", "anthropic"),
                self._cipher.decrypt(pcfg.get("apiKey", "")),
                pcfg.get("baseURL", ""), pcfg.get("enabled", True),
                refresh_token=self._cipher.decrypt(pcfg.get("refreshToken", "")),
                token_endpoint=pcfg.get("tokenEndpoint", ""),
                client_id=pcfg.get("clientId", ""),
                token_expires_at=float(pcfg.get("tokenExpiresAt", 0) or 0),
            )
            for mid, mcfg in pcfg.get("models", {}).items():
                lim = mcfg.get("limit", {})
                cap = mcfg.get("capability", {}) if isinstance(mcfg.get("capability"), dict) else {}
                provider.add_model(ModelInfo(
                    mid, lim.get("context", 200000), lim.get("output", 8192),
                    mcfg.get("modalities", ["text"]),
                    tier=cap.get("tier", 0),
                    cost_weight=cap.get("costWeight"),
                    supports_tools=cap.get("supportsTools"),
                    supports_vision=cap.get("supportsVision"),
                    supports_thinking=cap.get("supportsThinking"),
                    disabled_reason=mcfg.get("disabledReason", ""),
                ))
            self._providers[pid] = provider

    def _save_to_storage(self):
        """Save provider configs to storage (apiKey + refreshToken encrypted)."""
        data = {}
        for pid, p in self._providers.items():
            if pid == CONFIG_PROVIDER_ID: continue  # owned by config.json
            models = {}
            for mid, m in p.models.items():
                entry = {"limit": {"context": m.context_limit, "output": m.output_limit},
                         "modalities": m.modalities}
                # Only persist DECLARED capability, never the inferred values —
                # writing back a guess would freeze it, and the guess should
                # follow the price table when that table is updated.
                cap = {}
                if m._tier:
                    cap["tier"] = m._tier
                if m._cost_weight is not None:
                    cap["costWeight"] = m._cost_weight
                if m._supports_tools is not None:
                    cap["supportsTools"] = m._supports_tools
                if m._supports_vision is not None:
                    cap["supportsVision"] = m._supports_vision
                if m._supports_thinking is not None:
                    cap["supportsThinking"] = m._supports_thinking
                if cap:
                    entry["capability"] = cap
                if m.disabled_reason:
                    entry["disabledReason"] = m.disabled_reason
                models[mid] = entry
            data[pid] = {
                "name": p.name, "kind": p.kind,
                "apiKey": self._cipher.encrypt(p.api_key) if p.api_key else "",
                "baseURL": p.base_url, "enabled": p.enabled, "models": models,
                "refreshToken": self._cipher.encrypt(p.refresh_token) if p.refresh_token else "",
                "tokenEndpoint": p.token_endpoint,
                "clientId": p.client_id,
                "tokenExpiresAt": p.token_expires_at,
            }
        self._storage.set_config("providers", data)

    def register_provider(self, name: str, kind: str = "anthropic", api_key: str = "",
                          base_url: str = "", enabled: bool = True,
                          refresh_token: str = "", token_endpoint: str = "",
                          client_id: str = "", token_expires_at: float = 0.0) -> str:
        """Register a new provider.

        Args:
            name: Display name.
            kind: anthropic / openai-compatible / oauth.
            api_key: Access token or API key (encrypted at rest).
            base_url: Optional API base URL override.
            enabled: Whether the provider is selectable.
            refresh_token: OAuth refresh token (encrypted at rest).
            token_endpoint: OAuth token endpoint used for refresh.
            client_id: OAuth client id.
            token_expires_at: Unix timestamp when the access token expires.

        Returns:
            The new provider id.
        """
        pid = str(uuid.uuid4())
        self._providers[pid] = ProviderConfig(
            pid, name, kind, api_key, base_url, enabled,
            refresh_token=refresh_token, token_endpoint=token_endpoint,
            client_id=client_id, token_expires_at=token_expires_at,
        )
        self._save_to_storage()
        return pid

    @staticmethod
    def _capability_payload(p: "ProviderConfig", info: Optional["ModelInfo"]) -> dict:
        """The capability half of a :meth:`resolve` payload.

        Split out because three code paths build that payload and the vision /
        thinking declarations must not diverge between them — the whole point of
        the three-state declaration is that "the user said so" survives all the
        way to the wire, and a field missing on one path would silently fall back
        to inference exactly on the path that was taken.

        ``supports_thinking_declared`` is deliberately the RAW tri-state (None /
        True / False), not the resolved boolean: downstream has to know whether
        to obey it or to re-infer per model, and a bool cannot carry that.
        """
        if info is None:
            return {"modalities": ["text"], "supports_vision": False,
                    "supports_thinking": supports_effort("", p.kind),
                    "supports_thinking_declared": None, "disabled_reason": ""}
        cap = info.capability(kind=p.kind)
        return {
            "modalities": info.modalities,
            "supports_vision": cap["supports_vision"],
            "supports_thinking": cap["supports_thinking"],
            "supports_thinking_declared": info.supports_thinking_declared,
            "disabled_reason": info.disabled_reason,
        }

    def resolve(self, model_id: str = None, scene: str = None) -> Result:
        """Resolve a model to its provider + auth credentials.

        Accepts either a bare ``model_id`` or the frontend's ``"providerId:modelId"``
        composite, because that string is what the session picker stores and the
        UI now sends it verbatim.

        ``scene`` (UD1) names what the call is FOR — see :data:`SCENES`. When
        given without an explicit ``model_id``, the cheapest configured model
        that clears the scene's capability floor is chosen instead of the active
        one, so a commit message stops being written by a frontier model.

        **An explicit ``model_id`` always wins.** Scene routing is an answer to
        "we were not told which model", never an override of a user's pick.
        """
        target = model_id or ""
        if not target and scene:
            picked = self._resolve_scene(scene)
            if picked is not None:
                return Result.success(picked)
        target = target or self._active_model
        want_pid = ""
        if target and ":" in target:
            want_pid, target = target.split(":", 1)

        # Explicit provider wins: two providers can expose the same model name
        # (an OpenAI-compatible proxy and the vendor itself), and picking the
        # wrong one means a valid model id with the wrong key.
        if want_pid:
            p = self._providers.get(want_pid)
            if p is not None and p.enabled:
                info = p.models.get(target)
                return Result.success({
                    "provider_id": want_pid, "provider_name": p.name, "kind": p.kind,
                    "api_key": p.api_key, "base_url": p.base_url,
                    "model_id": target, "source": "registry",
                    "context_limit": info.context_limit if info else 0,
                    "output_limit": info.output_limit if info else 0,
                    **self._capability_payload(p, info),
                })

        for pid, p in self._providers.items():
            if not p.enabled: continue
            if target and target in p.models:
                return Result.success({
                    "provider_id": pid, "provider_name": p.name, "kind": p.kind,
                    "api_key": p.api_key, "base_url": p.base_url,
                    "model_id": target, "source": "registry",
                    "context_limit": p.models[target].context_limit,
                    "output_limit": p.models[target].output_limit,
                    **self._capability_payload(p, p.models[target]),
                })
        # Nothing matched. The old code answered with "first enabled provider"
        # while still stamping the REQUESTED model id on it — a valid key paired
        # with a model that provider has never heard of, i.e. a guaranteed 404
        # dressed up as a success. config.json is the one entry we know works, so
        # an unresolvable pick degrades to it instead.
        #
        # This also revives the callers that silently gave up when the registry
        # was empty (nothing ever called register_provider): the compaction fold
        # budget and the image-modality gate.
        if self._config_fallback:
            return Result.success({**self._config_fallback, "source": "config"})
        for pid, p in self._providers.items():
            if p.enabled and (not target or target in p.models):
                m = p.models.get(target or "")
                return Result.success({
                    "provider_id": pid, "provider_name": p.name, "kind": p.kind,
                    "api_key": p.api_key, "base_url": p.base_url,
                    "model_id": target or "", "source": "fallback",
                    "context_limit": m.context_limit if m else 0,
                    "output_limit": m.output_limit if m else 0,
                    **self._capability_payload(p, m),
                })
        return Result.failure("No provider available")

    def thinking_capability(self, model_id: str = "") -> dict:
        """Thinking dial metadata for the UI — one resolved payload per model."""
        resolved = self.resolve(model_id)
        if not resolved.ok or not isinstance(resolved.value, dict):
            return build_thinking_capability(model_id or "")
        payload = resolved.value
        pid = str(payload.get("provider_id") or "")
        mid = str(payload.get("model_id") or "")
        kind = str(payload.get("kind") or "")
        declared = payload.get("supports_thinking_declared")
        p = self._providers.get(pid)
        info = p.models.get(mid) if p else None
        catalog = False
        if info is not None and info._supports_thinking is True:
            catalog = True
        return build_thinking_capability(
            mid or model_id,
            kind,
            declared,
            catalog_reasoning=catalog,
        )

    # ------------------------------------------------------------------
    # Scene routing (UD1)
    # ------------------------------------------------------------------

    def scene_candidates(self, scene: str) -> list[dict]:
        """Configured models eligible for ``scene``, cheapest first.

        Eligibility is: provider enabled, provider has a usable credential, the
        model clears the scene's tier floor, and it supports tools when the
        scene needs them. The credential check matters — routing background work
        to a provider the user configured but never keyed would turn a working
        feature into a silent 401.
        """
        spec = SCENES.get(scene) or {}
        floor = int(spec.get("min_tier") or TIER_STANDARD)
        needs_tools = bool(spec.get("needs_tools"))
        overrides = self.price_overrides()
        out: list[dict] = []
        for pid, p in self._providers.items():
            if not p.enabled or not p.api_key:
                continue
            for mid, info in p.models.items():
                cap = info.capability(overrides, kind=p.kind)
                if cap["tier"] < floor:
                    continue
                if needs_tools and not cap["supports_tools"]:
                    continue
                out.append({
                    "provider_id": pid, "provider_name": p.name, "kind": p.kind,
                    "api_key": p.api_key, "base_url": p.base_url,
                    "model_id": mid, "source": f"scene:{scene}",
                    "context_limit": info.context_limit,
                    "output_limit": info.output_limit,
                    "modalities": info.modalities,
                    "tier": cap["tier"], "cost_weight": cap["cost_weight"],
                    "scene": scene,
                })
        # Cheapest first, then lowest tier, then a stable name so the choice is
        # reproducible — a router that silently alternates between two equally
        # priced models makes "why was this turn different" unanswerable.
        out.sort(key=lambda c: (c["cost_weight"], c["tier"], c["model_id"]))
        return out

    def _resolve_scene(self, scene: str) -> Optional[dict]:
        """Cheapest eligible model for ``scene``, or None to use normal resolve.

        Returns None (rather than failing) whenever routing cannot improve on the
        default: an unknown scene, one marked ``route: False``, or no candidate
        clearing the floor. The caller then behaves exactly as before, which is
        the property that makes this safe to switch on everywhere at once.
        """
        spec = SCENES.get(scene)
        if not spec or not spec.get("route"):
            return None
        candidates = self.scene_candidates(scene)
        if not candidates:
            return None
        best = candidates[0]
        # Routing to the model we would have used anyway is not routing; say so
        # in `source` so telemetry doesn't over-report savings.
        if best["model_id"] == self._active_model:
            best = {**best, "source": "scene:default"}
        return best

    def scene_plan(self) -> list[dict]:
        """What each scene currently resolves to. For diagnostics / settings UI."""
        rows = []
        for name, spec in SCENES.items():
            picked = self._resolve_scene(name) if spec.get("route") else None
            rows.append({
                "scene": name,
                "minTier": spec.get("min_tier"),
                "routed": bool(picked),
                "modelId": (picked or {}).get("model_id", ""),
                "providerName": (picked or {}).get("provider_name", ""),
                "costWeight": (picked or {}).get("cost_weight"),
            })
        return rows


    def seed_from_config(self, model_cfg: dict) -> None:
        """Adopt config.json's ``model`` block as a real, resolvable provider.

        config.json is the only place the shipped app actually has credentials,
        so the registry has to know about it or every ``resolve()`` is a miss.
        Registered under a reserved id and deliberately NOT persisted to SQLite:
        config.json stays the owner of this entry, and a copy in two stores would
        drift the moment one of them is edited.
        """
        if not isinstance(model_cfg, dict):
            return
        model_id = str(model_cfg.get("model_id") or "").strip()
        base_url = str(model_cfg.get("base_url") or "").strip()
        api_key = str(model_cfg.get("api_key") or "")
        if not model_id and not base_url:
            return
        name = str(model_cfg.get("provider") or "config") or "config"
        ctx = int(model_cfg.get("context_limit") or 200000)
        out = int(model_cfg.get("max_tokens") or 8192)

        provider = ProviderConfig(
            CONFIG_PROVIDER_ID, name, "openai-compatible",
            api_key, base_url, True,
        )
        if model_id:
            provider.add_model(ModelInfo(model_id, ctx, out, ["text"]))
        self._providers[CONFIG_PROVIDER_ID] = provider

        self._config_fallback = {
            "provider_id": CONFIG_PROVIDER_ID, "provider_name": name,
            "kind": "openai-compatible", "api_key": api_key,
            "base_url": base_url, "model_id": model_id,
            "context_limit": ctx, "modalities": ["text"],
        }
        # Nothing ever called set_active_model, so `resolve()` with no argument
        # had no default to fall back on either.
        if not self._active_model and model_id:
            self.set_active_model(model_id, CONFIG_PROVIDER_ID)


    def upsert_provider(self, provider_id: str, spec: dict) -> Result:
        """Create or update a provider under a CALLER-supplied id.

        ``register_provider`` mints a uuid, which is useless for syncing the
        desktop UI's catalogue: the UI already owns the ids the session picker
        emits in its ``"providerId:modelId"`` strings, so the backend has to
        store them verbatim or every lookup misses.

        An empty ``apiKey`` in ``spec`` means "unchanged" rather than "clear",
        because the settings UI reads keys back masked and would otherwise wipe
        the real one on a round trip.

        Args:
            provider_id: Id owned by the caller (the UI's provider key).
            spec: ``{name, kind, apiKey, baseURL, enabled, models: {id: {limit:
                {context, output}, modalities}}}``.
        """
        pid = str(provider_id or "").strip()
        if not pid:
            return Result.failure("provider_id is required")
        if pid == CONFIG_PROVIDER_ID:
            return Result.failure("reserved provider id")
        if not isinstance(spec, dict):
            return Result.failure("spec must be an object")

        prev = self._providers.get(pid)
        api_key = str(spec.get("apiKey") or "")
        if not api_key and prev is not None:
            api_key = prev.api_key

        provider = ProviderConfig(
            pid,
            str(spec.get("name") or (prev.name if prev else pid)),
            str(spec.get("kind") or (prev.kind if prev else "openai-compatible")),
            api_key,
            str(spec.get("baseURL") or (prev.base_url if prev else "")),
            bool(spec.get("enabled", prev.enabled if prev else True)),
        )
        models = spec.get("models")
        if isinstance(models, dict):
            for mid, mcfg in models.items():
                mcfg = mcfg if isinstance(mcfg, dict) else {}
                lim = mcfg.get("limit") if isinstance(mcfg.get("limit"), dict) else {}
                cap = mcfg.get("capability") if isinstance(mcfg.get("capability"), dict) else {}
                reasoning_cfg = (
                    mcfg.get("reasoning") if isinstance(mcfg.get("reasoning"), dict) else {}
                )
                thinking_decl = cap.get("supportsThinking")
                if thinking_decl is None and reasoning_cfg.get("enabled"):
                    thinking_decl = True
                provider.add_model(ModelInfo(
                    str(mid),
                    int(lim.get("context") or 200000),
                    int(lim.get("output") or 8192),
                    mcfg.get("modalities") or ["text"],
                    tier=int(cap.get("tier") or 0),
                    cost_weight=cap.get("costWeight"),
                    supports_tools=cap.get("supportsTools"),
                    supports_vision=cap.get("supportsVision"),
                    supports_thinking=thinking_decl,
                    disabled_reason=mcfg.get("disabledReason", ""),
                ))
        elif prev is not None:
            provider.models = prev.models  # catalogue omitted → keep what we had

        self._providers[pid] = provider
        self._save_to_storage()
        return Result.success({"id": pid, "models": list(provider.models.keys())})

    def prune_providers(self, keep: list) -> list:
        """Drop every provider except ``keep`` (and the config-owned entry).

        Used by the UI sync when its payload is authoritative. Without it a
        deleted provider stays resolvable forever — the registry would keep
        answering with credentials the user believes they removed.
        """
        keep_set = {str(k) for k in (keep or [])} | {CONFIG_PROVIDER_ID}
        gone = [pid for pid in self._providers if pid not in keep_set]
        for pid in gone:
            self._providers.pop(pid, None)
        if gone:
            self._save_to_storage()
        return gone

    def set_active_model(self, model_id: str, provider_id: str = None):
        self._active_model = model_id
        if provider_id:
            self._active_provider = provider_id

    def refresh_models(self, provider_id: str) -> Result:
        """Dynamically refresh model list from provider API."""
        # In production, this would call the provider's /models endpoint
        provider = self._providers.get(provider_id)
        if not provider:
            return Result.failure(f"Provider not found: {provider_id}")
        return Result.success({"provider": provider.name, "models": list(provider.models.keys())})

    # ------------------------------------------------------------------
    # Provider health & dynamic downgrade (UD2)
    # ------------------------------------------------------------------

    def note_provider_failure(self, provider_id: str, code: str = "") -> dict:
        """Record one hard failure against a provider.

        Only *hard* failures belong here — a rate limit means the provider is
        alive and we were too fast, so counting it would open a cooldown on a
        healthy provider under load. The caller decides using
        :func:`llm_errors.is_permanent` / the failure code; this method just
        counts what it is given.
        """
        pid = str(provider_id or "")
        if not pid:
            return {}
        h = self._provider_health.setdefault(pid, {"fails": 0, "until": 0.0, "code": ""})
        h["fails"] = int(h.get("fails") or 0) + 1
        h["code"] = str(code or "")
        if h["fails"] >= PROVIDER_FAIL_THRESHOLD:
            h["until"] = time.time() + PROVIDER_COOLDOWN_SECONDS
        return dict(h)

    def note_provider_success(self, provider_id: str) -> None:
        """Clear a provider's failure streak. One success ends the cooldown.

        Not a decay: if a call just went through, the outage is over, and making
        the provider serve its full remaining cooldown would waste a resource we
        have proof is working.
        """
        self._provider_health.pop(str(provider_id or ""), None)

    def provider_healthy(self, provider_id: str) -> bool:
        """Whether ``provider_id`` is outside its cooldown window."""
        h = self._provider_health.get(str(provider_id or ""))
        if not h:
            return True
        until = float(h.get("until") or 0.0)
        if until <= 0.0:
            return True
        if time.time() >= until:
            # Window elapsed. Reset the streak too, otherwise the very next
            # failure re-opens a cooldown immediately and the provider is
            # effectively banned for good after one bad minute.
            self._provider_health.pop(str(provider_id or ""), None)
            return True
        return False

    def provider_health(self) -> list[dict]:
        """Current cooldown state, for diagnostics."""
        now = time.time()
        rows = []
        for pid, h in self._provider_health.items():
            p = self._providers.get(pid)
            until = float(h.get("until") or 0.0)
            rows.append({
                "providerId": pid,
                "providerName": p.name if p else "",
                "fails": int(h.get("fails") or 0),
                "code": h.get("code") or "",
                "cooldownRemaining": max(round(until - now, 1), 0.0) if until else 0.0,
            })
        return rows

    def downgrade_candidates(self, current: str, recovery: str = "",
                             needed_context: int = 0, limit: int = 3) -> list[dict]:
        """Models worth retrying with after ``current`` failed, best hop first.

        ``recovery`` comes from :data:`llm_errors.RECOVERY` and decides what
        "better" means — this is the whole point of the method. A context
        overflow needs a BIGGER window (going cheaper makes it fail faster); an
        exhausted quota needs a DIFFERENT provider (the same one fails for free);
        a bad model id needs anything that exists. One ordering cannot serve all
        three, so the sort key is chosen per direction.

        Each candidate carries ``downgrade_reason`` so the event we show the user
        can say *why* their model changed, and ``source`` records the direction.

        Args:
            current: The model that failed (bare id or ``providerId:modelId``).
            recovery: One of the ``llm_errors.RECOVER_*`` values.
            needed_context: Tokens the failing prompt needed; only candidates
                with a strictly larger window qualify for a context recovery.
            limit: Max hops to return.

        Returns:
            Up to ``limit`` resolve()-shaped dicts. Empty when nothing would be
            an improvement — the caller must then surface the original failure
            rather than retrying something equivalent.
        """
        from llm_errors import (
            RECOVER_ANY_MODEL, RECOVER_LARGER_CONTEXT, RECOVER_OTHER_PROVIDER,
        )
        if not recovery:
            return []
        cur_pid, cur_model = "", str(current or "")
        if ":" in cur_model:
            cur_pid, cur_model = cur_model.split(":", 1)
        if not cur_pid:
            cur_pid = self._resolved_provider_for(cur_model)
        cur_info = self._model_info(cur_pid, cur_model)
        overrides = self.price_overrides()
        cur_cap = cur_info.capability(overrides) if cur_info else None
        cur_limit = cur_info.context_limit if cur_info else 0

        out: list[dict] = []
        for pid, p in self._providers.items():
            if not p.enabled or not p.api_key:
                continue
            if not self.provider_healthy(pid):
                continue
            if recovery == RECOVER_OTHER_PROVIDER and pid == cur_pid:
                continue
            for mid, info in p.models.items():
                if pid == cur_pid and mid == cur_model:
                    continue
                cap = info.capability(overrides, kind=p.kind)
                if recovery == RECOVER_LARGER_CONTEXT:
                    # A window no bigger than the one that just overflowed is
                    # not a candidate, it is the same failure one round-trip later.
                    if info.context_limit <= max(needed_context, cur_limit):
                        continue
                elif recovery == RECOVER_OTHER_PROVIDER:
                    # No capability filter here on purpose. A quota wall on the
                    # user's only frontier model must not leave them with
                    # nothing — a weaker answer from another provider beats a
                    # failed turn. The preference is expressed in the sort
                    # instead, so same-or-better models are simply tried first.
                    pass
                out.append({
                    "provider_id": pid, "provider_name": p.name, "kind": p.kind,
                    "api_key": p.api_key, "base_url": p.base_url,
                    "model_id": mid, "source": f"downgrade:{recovery}",
                    "context_limit": info.context_limit,
                    "output_limit": info.output_limit,
                    "modalities": info.modalities,
                    "tier": cap["tier"], "cost_weight": cap["cost_weight"],
                    "downgrade_reason": recovery,
                })
        if recovery == RECOVER_LARGER_CONTEXT:
            # Smallest window that still fits, so we don't jump to the most
            # expensive frontier model for a prompt that overflowed by 2k tokens.
            out.sort(key=lambda c: (c["context_limit"], c["cost_weight"], c["model_id"]))
        elif recovery == RECOVER_ANY_MODEL:
            out.sort(key=lambda c: (c["cost_weight"], c["tier"], c["model_id"]))
        else:
            # Two bands. Anything at or above the current tier already clears the
            # bar, so inside that band cheapest wins. Below the bar we are giving
            # the user a weaker answer than they asked for, so take the strongest
            # available — the cheapest-of-the-weak would be the worst possible
            # substitute for a frontier model.
            floor = cur_cap["tier"] if cur_cap else TIER_LIGHT
            out.sort(key=lambda c: (
                (0, c["cost_weight"], c["model_id"]) if c["tier"] >= floor
                else (1, -c["tier"], c["cost_weight"], c["model_id"])
            ))
        return out[: max(int(limit or 1), 1)]

    def _resolved_provider_for(self, model_id: str) -> str:
        """Which provider currently serves a bare model id ("" if unknown)."""
        if not model_id:
            return ""
        for pid, p in self._providers.items():
            if model_id in p.models:
                return pid
        return ""

    def _model_info(self, provider_id: str, model_id: str) -> Optional[ModelInfo]:
        p = self._providers.get(str(provider_id or ""))
        if p is None:
            return None
        return p.models.get(str(model_id or ""))


    # ------------------------------------------------------------------
    # OAuth refresh (TODO §5.1)
    # ------------------------------------------------------------------

    async def refresh_oauth_token(self, provider_id: str) -> Result:
        """Refresh an OAuth access token using the stored refresh_token.

        The new access token is re-encrypted and persisted. The expiry is
        recorded so subsequent calls can decide "expired" without a network
        round-trip.

        Args:
            provider_id: Provider to refresh.

        Returns:
            Result with the new access token and expiry on success.
        """
        provider = self._providers.get(provider_id)
        if not provider:
            return Result.failure(f"Provider not found: {provider_id}", code="ProviderNotFound")
        if not provider.has_oauth:
            return Result.failure(
                "Provider has no refresh_token / token_endpoint configured",
                code="NoOAuthConfig",
            )
        body = urllib.parse.urlencode({
            "grant_type": "refresh_token",
            "refresh_token": provider.refresh_token,
            "client_id": provider.client_id,
        }).encode("utf-8")
        try:
            resp = await asyncio.to_thread(self._http_post_form, provider.token_endpoint, body)
        except Exception as exc:  # transport failure
            return Result.failure(f"OAuth refresh transport error: {exc}", code="RefreshTransport")
        if not resp.ok:
            # Refresh token itself may be expired -> caller must trigger re-auth.
            code = "RefreshExpired" if "invalid_grant" in resp.error.lower() else "RefreshFailed"
            return Result.failure(resp.error, code=code)
        data = resp.value
        access = data.get("access_token", "")
        if not access:
            return Result.failure("Token endpoint returned no access_token", code="NoAccessToken")
        provider.api_key = access
        expires_in = int(data.get("expires_in", 0) or 0)
        if expires_in:
            provider.token_expires_at = time.time() + expires_in
        # Some providers rotate the refresh_token
        new_refresh = data.get("refresh_token")
        if new_refresh:
            provider.refresh_token = new_refresh
        self._save_to_storage()
        return Result.success({
            "access_token": access,
            "expires_at": provider.token_expires_at,
            "rotated_refresh_token": bool(new_refresh),
        })

    async def call_with_refresh(
        self,
        provider_id: str,
        do_request: Callable[[str], Awaitable[dict]],
        max_refresh: int = 1,
    ) -> Result:
        """Run a request with automatic 401 -> refresh -> retry.

        This is the interception point TODO §5.1 asks for. Callers pass a
        coroutine that takes the current access token, performs one request,
        and returns a dict::

            {"status": int, "body": Any}

        A 401 status triggers a token refresh (once, by default) and retry.
        Any other status is returned as-is inside a successful Result so
        callers can handle domain-level errors themselves.

        Args:
            provider_id: Provider used to sign the request.
            do_request: Async request function taking an access token.
            max_refresh: Maximum number of refresh attempts.

        Returns:
            Result wrapping ``{status, body}`` on any completed request, or a
            failure when refresh itself is impossible.
        """
        provider = self._providers.get(provider_id)
        if not provider:
            return Result.failure(f"Provider not found: {provider_id}", code="ProviderNotFound")

        # Proactive refresh when we know the token is expired.
        if provider.has_oauth and provider.token_expired:
            r = await self.refresh_oauth_token(provider_id)
            if not r.ok:
                return r

        attempts = 0
        while True:
            try:
                resp = await do_request(provider.api_key)
            except Exception as exc:
                return Result.failure(f"Request failed: {exc}", code="RequestError")
            status = int(resp.get("status", 0) or 0)
            if status != 401 or attempts >= max_refresh or not provider.has_oauth:
                return Result.success(resp)
            attempts += 1
            r = await self.refresh_oauth_token(provider_id)
            if not r.ok:
                # Refresh token no longer usable — caller must re-auth the user.
                r.meta["needs_reauth"] = True
                return r

    @staticmethod
    def _http_post_form(url: str, body: bytes) -> Result:
        """Blocking POST used by OAuth refresh (called via to_thread)."""
        req = urllib.request.Request(
            url, data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return Result.success(data)
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8")
            except Exception:
                detail = ""
            return Result.failure(f"HTTP {e.code} {e.reason} {detail}")
        except urllib.error.URLError as e:
            return Result.failure(f"URL error: {e.reason}")

    def list_providers(self) -> list:
        return [{"id": p.provider_id, "name": p.name, "kind": p.kind,
                 "enabled": p.enabled, "models": list(p.models.keys())}
                for p in self._providers.values()]

    def provider_label(self, provider_id: str) -> str:
        """Human-readable name for a provider id, or "" when there isn't one.

        Exists because ``__config__`` is a sentinel, not a vendor. The usage panel
        was rendering raw ids, so a turn served by the config.json-seeded entry
        showed up as the literal ``__CONFIG__`` next to a real provider name — an
        internal implementation detail on screen, and one the user cannot act on.

        Returns "" rather than a placeholder string for the unnameable cases (no
        id, or the config entry when config.json omitted ``provider`` and
        ``seed_from_config`` defaulted its name to the literal "config"). The
        caller owns that copy: this process has no locale, and inventing Chinese
        or English here would hardcode one of them into the API.

        Falls back to the id itself for a provider that has since been deleted —
        historical usage rows outlive the entry that produced them, and the id is
        the honest answer to "which access path was this".
        """
        pid = str(provider_id or "").strip()
        if not pid:
            return ""
        provider = self._providers.get(pid)
        name = str(provider.name).strip() if provider else ""
        if pid == CONFIG_PROVIDER_ID:
            return "" if name.lower() in ("", "config") else name
        return name or pid



    def record_usage(self, session_id: str, turn_id: str, input_tokens: int, output_tokens: int,
                     reasoning_tokens: int = 0, cache_creation: int = 0, cache_read: int = 0,
                     provider_total: int = 0, model_retry: int = 0, error_type: str = ""):
        self._storage.record_usage(session_id, turn_id, input_tokens, output_tokens,
                                    reasoning_tokens, cache_creation, cache_read,
                                    provider_total, input_tokens + output_tokens + reasoning_tokens,
                                    model_retry, error_type=error_type)

    def get_usage(self, session_id: str) -> dict:
        return self._storage.get_usage(session_id)

    def price_overrides(self) -> dict:
        """User-supplied rate overrides, or {} when none are configured."""
        raw = self._storage.get_config(PRICE_OVERRIDE_KEY, {})
        return raw if isinstance(raw, dict) else {}

    def cost_of(self, model_id: str, usage: dict) -> dict:
        """Price one turn's usage, honoring any user rate overrides.

        Thin wrapper over :func:`compute_cost` so callers (the router recording a
        turn, the goal worker converting tokens to spend) never have to know
        where the override table lives. Returns the same
        ``{cost_micros, cache_saved_micros, cost_source, price_key}`` dict.
        """
        return compute_cost(model_id, usage, self.price_overrides())

_registry: Optional[ModelRegistry] = None
def get_model_registry() -> ModelRegistry:
    global _registry
    if _registry is None: _registry = ModelRegistry()
    return _registry
