/**
 * model_registry.ts — multi-model registry with auth + token billing. (Part 1)
 *
 * Ported from `app/backend/model_registry.py` (2101 lines, SPLIT unit).
 * This file holds the module-level surface: price table, cost computation,
 * capability tiers & scenes, reasoning-effort vocabulary + wire dialects,
 * thinking profiles, and the provider compatibility matrix.
 * `model_registry_impl.ts` holds CredentialCipher / ModelInfo /
 * ProviderConfig / ModelRegistry + the singleton.
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only (node:crypto pbkdf2 for the cipher in part 2).
 *   §2  Python `re`/frozenset/dataclass semantics mapped 1:1; the effort
 *       dialect tables are the security/compat contract and are verbatim.
 *   §2  `round` on cost micros: Python round() half-to-even vs Math.round
 *       half-up — micros come out of float token math where exact halves
 *       don't occur; flagged, not "fixed" (changing rounding would diverge
 *       from already-recorded usage rows).
 *   §4  naming: model_registry.py → model_registry.ts (+ _impl.ts split)
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as crypto from "node:crypto";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Provider health constants
// ---------------------------------------------------------------------------

/** Reserved id for the config.json-seeded provider (source: CONFIG_PROVIDER_ID). */
export const CONFIG_PROVIDER_ID = "__config__";

export const PROVIDER_FAIL_THRESHOLD = 3;
export const PROVIDER_COOLDOWN_SECONDS = 120.0;

// ---------------------------------------------------------------------------
// Price table
// ---------------------------------------------------------------------------

export const PRICE_TABLE_SOURCE = "vendor public list prices";
export const PRICE_TABLE_FETCHED = "2026-08";

/** Env var holding the user's rate-override key in storage. */
export const PRICE_OVERRIDE_KEY = "model_prices";

/** model key -> {input, output, cache_read, cache_write}. Keys are matched
 * longest-prefix (see lookup_price) so dated snapshots such as
 * `gpt-4o-2024-11-20` resolve without an entry per release. */
export const MODEL_PRICES: Record<string, Record<string, number>> = {
  // Anthropic
  "claude-opus-4":     { input: 15.0, output: 75.0, cache_read: 1.50,  cache_write: 18.75 },
  "claude-3-opus":     { input: 15.0, output: 75.0, cache_read: 1.50,  cache_write: 18.75 },
  "claude-sonnet-4":   { input: 3.0,  output: 15.0, cache_read: 0.30,  cache_write: 3.75 },
  "claude-3-7-sonnet": { input: 3.0,  output: 15.0, cache_read: 0.30,  cache_write: 3.75 },
  "claude-3-5-sonnet": { input: 3.0,  output: 15.0, cache_read: 0.30,  cache_write: 3.75 },
  "claude-3-5-haiku":  { input: 0.80, output: 4.0,  cache_read: 0.08,  cache_write: 1.0 },
  "claude-3-haiku":    { input: 0.25, output: 1.25, cache_read: 0.03,  cache_write: 0.30 },
  // OpenAI
  "gpt-5-mini":        { input: 0.25, output: 2.0,  cache_read: 0.025, cache_write: 0.0 },
  "gpt-5":             { input: 1.25, output: 10.0, cache_read: 0.125, cache_write: 0.0 },
  "gpt-4.1-nano":      { input: 0.10, output: 0.40, cache_read: 0.025, cache_write: 0.0 },
  "gpt-4.1-mini":      { input: 0.40, output: 1.60, cache_read: 0.10,  cache_write: 0.0 },
  "gpt-4.1":           { input: 2.0,  output: 8.0,  cache_read: 0.50,  cache_write: 0.0 },
  "gpt-4o-mini":       { input: 0.15, output: 0.60, cache_read: 0.075, cache_write: 0.0 },
  "gpt-4o":            { input: 2.50, output: 10.0, cache_read: 1.25,  cache_write: 0.0 },
  "gpt-4":             { input: 30.0, output: 60.0, cache_read: 0.0,   cache_write: 0.0 },
  "o4-mini":           { input: 1.10, output: 4.40, cache_read: 0.275, cache_write: 0.0 },
  "o3-mini":           { input: 1.10, output: 4.40, cache_read: 0.55,  cache_write: 0.0 },
  "o3":                { input: 2.0,  output: 8.0,  cache_read: 0.50,  cache_write: 0.0 },
  // DeepSeek
  "deepseek-reasoner": { input: 0.55, output: 2.19, cache_read: 0.14,  cache_write: 0.0 },
  "deepseek-chat":     { input: 0.27, output: 1.10, cache_read: 0.07,  cache_write: 0.0 },
  // Google
  "gemini-2.5-pro":    { input: 1.25, output: 10.0, cache_read: 0.31,  cache_write: 0.0 },
  "gemini-2.5-flash":  { input: 0.30, output: 2.50, cache_read: 0.075, cache_write: 0.0 },
  "gemini-2.0-flash":  { input: 0.10, output: 0.40, cache_read: 0.025, cache_write: 0.0 },
  // Open-weight hosted
  "kimi-k2":           { input: 0.60, output: 2.50, cache_read: 0.15,  cache_write: 0.0 },
  "glm-4.5":           { input: 0.60, output: 2.20, cache_read: 0.11,  cache_write: 0.0 },
  "qwen-max":          { input: 1.60, output: 6.40, cache_read: 0.40,  cache_write: 0.0 },
};

/** Used when the model is not in the table. Deliberately NOT zero: a cost of
 * zero reads as "this was free", which is the one thing we know it wasn't. */
export const FALLBACK_PRICE: Readonly<Record<string, number>> = {
  input: 1.0, output: 4.0, cache_read: 0.25, cache_write: 0.0,
};

export const COST_REPORTED = "reported";   // the provider told us what it charged
export const COST_ESTIMATED = "estimated"; // our table had this model
export const COST_FALLBACK = "fallback";   // our table did not; mid-market rate used

/** Reduce a model identifier to the key the price table is indexed by.
 *
 * Strips our `providerId:modelId` composite and vendor path prefixes
 * (`anthropic/claude-...`, `openai/gpt-4o`) that OpenRouter-style proxies
 * add, then lowercases. Without this, every proxied model is a table miss. */
export function _price_key(model_id: string): string {
  let s = String(model_id ?? "").trim().toLowerCase();
  if (s.includes(":")) {
    s = s.slice(s.indexOf(":") + 1);
  }
  if (s.includes("/")) {
    s = s.slice(s.lastIndexOf("/") + 1);
  }
  return s.trim();
}

/** Resolve rates for a model.
 *
 * Returns (rates, source) where source is COST_ESTIMATED for a table hit and
 * COST_FALLBACK otherwise. Matching is longest-prefix so
 * `claude-3-5-sonnet-20241022` hits `claude-3-5-sonnet` — and `gpt-4o` cannot
 * shadow `gpt-4o-mini`, which a shortest-prefix scan would do. */
export function lookup_price(
  model_id: string,
  overrides?: Record<string, Record<string, number>> | null
): [Record<string, number>, string] {
  const key = _price_key(model_id);
  if (!key) {
    return [{ ...FALLBACK_PRICE }, COST_FALLBACK];
  }
  const table: Record<string, Record<string, number>> = { ...MODEL_PRICES };
  try {
    // Dynamic import keeps the catalog optional (it may be absent in tests).
    const loaderMod = require_cache("model_catalog_loader.js") as {
      lookup_catalog_price?: (m: string) => Record<string, number> | null;
    } | null;
    if (loaderMod && typeof loaderMod["lookup_catalog_price"] === "function") {
      const cat_price = loaderMod["lookup_catalog_price"]!(model_id);
      if (cat_price && typeof cat_price === "object") {
        table[key] = cat_price as Record<string, number>;
      }
    }
  } catch {
    // except Exception: pass — catalog is an enhancement, not a requirement
  }
  if (overrides && typeof overrides === "object") {
    for (const [k, v] of Object.entries(overrides)) {
      if (v && typeof v === "object") {
        table[_price_key(k)] = v;
      }
    }
  }
  if (key in table) {
    return [{ ...FALLBACK_PRICE, ...table[key]! }, COST_ESTIMATED];
  }
  const hits = Object.keys(table)
    .filter((k) => key.startsWith(k))
    .sort((a, b) => b.length - a.length);
  if (hits.length > 0) {
    return [{ ...FALLBACK_PRICE, ...table[hits[0]!] }, COST_ESTIMATED];
  }
  return [{ ...FALLBACK_PRICE }, COST_FALLBACK];
}

/** CommonJS-style optional cache for the dynamic catalog loader. The engine
 * compiles as ESM ("type": "module"), so createRequire bridges to CJS-style
 * sibling resolution; failures (loader absent) return null. */
function require_cache(rel: string): Record<string, unknown> | null {
  try {
    const req = createRequire(import.meta.url);
    return req(`./${rel}`) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Price one turn's token counts.
 *
 * Billing note (source, kept): providers disagree on whether `input` already
 * contains the cached tokens. OpenAI-likes report prompt_tokens inclusive of
 * cached_tokens; Anthropic reports input_tokens exclusive. We subtract only
 * when the numbers are consistent with the inclusive convention
 * (`cache_read <= input`), which lands correctly on both. */
export function compute_cost(
  model_id: string,
  usage: Record<string, unknown>,
  overrides?: Record<string, Record<string, number>> | null
): Record<string, unknown> {
  const u = usage && typeof usage === "object" ? usage : {};
  const [rates_, source_] = lookup_price(model_id, overrides);

  const reported = u["cost"];
  if (typeof reported === "number" && reported > 0) {
    return {
      cost_micros: Math.round(reported * 1_000_000),
      cache_saved_micros: 0,
      cost_source: COST_REPORTED,
      price_key: _price_key(model_id),
    };
  }

  const n = (key: string): number => {
    const v = Number(u[key] ?? 0);
    return Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
  };

  const inp = n("input");
  const outp = n("output");
  const reasoning = n("reasoning");
  const cache_read = n("cache_read");
  const cache_write = n("cache_creation");
  const is_exclusive = Boolean(u["input_is_exclusive"]);

  const billable_input = is_exclusive
    ? inp
    : cache_read > 0 && cache_read <= inp
      ? inp - cache_read
      : inp;
  // Reasoning tokens are billed at the output rate everywhere that bills them
  // separately, and are usually already inside output_tokens — counting them
  // again would inflate every reasoning-model turn.
  const billable_output = outp >= reasoning ? outp : outp + reasoning;

  const micros =
    billable_input * (rates_["input"] ?? 0) +
    billable_output * (rates_["output"] ?? 0) +
    cache_read * (rates_["cache_read"] ?? 0) +
    cache_write * (rates_["cache_write"] ?? 0);
  // What the cache actually saved: those tokens would have been full-rate
  // input. This is the number that justifies the caching machinery existing.
  const saved = cache_read * Math.max((rates_["input"] ?? 0) - (rates_["cache_read"] ?? 0), 0.0);
  return {
    cost_micros: Math.round(micros),
    cache_saved_micros: Math.round(saved),
    cost_source: source_,
    price_key: _price_key(model_id),
  };
}

// ---------------------------------------------------------------------------
// Capability tiers & named call scenes (UD1)
// ---------------------------------------------------------------------------

export const TIER_LIGHT = 1;      // fast, cheap; fine for extraction / rewriting / formatting
export const TIER_STANDARD = 2;   // general reasoning, tool use, most conversation
export const TIER_HEAVY = 3;      // frontier; only where depth genuinely changes the answer

export const SCENE_CHAT = "chat";
export const SCENE_MEMORY_EXTRACT = "memory_extract";
export const SCENE_FOLD_SUMMARY = "fold_summary";
export const SCENE_GOAL_VERDICT = "goal_verdict";
export const SCENE_COMMIT_MESSAGE = "commit_message";
export const SCENE_AUTO_RESOLVE = "auto_resolve";

export const SCENES: Record<string, Record<string, unknown>> = {
  // Main conversation is listed for completeness but never routed: the user
  // picked a model in the composer and that choice is absolute.
  [SCENE_CHAT]:            { min_tier: TIER_STANDARD, route: false, needs_tools: true },
  // Pull facts out of a file diff into JSON. Pattern work; a light model does
  // it as well as a frontier one and there is a regex fallback beneath it.
  [SCENE_MEMORY_EXTRACT]:  { min_tier: TIER_LIGHT, route: true },
  // Compress old messages. Losing nuance here is bounded — the audit pass
  // rejects a summary that dropped the important tokens.
  [SCENE_FOLD_SUMMARY]:    { min_tier: TIER_LIGHT, route: true },
  // One-line conventional-commit subject from a diff.
  [SCENE_COMMIT_MESSAGE]:  { min_tier: TIER_LIGHT, route: true },
  // Answer the agent's own clarifying question from conversation history.
  [SCENE_AUTO_RESOLVE]:    { min_tier: TIER_LIGHT, route: true },
  // "Is this goal actually finished?" gates autonomous iteration, so a wrong
  // verdict either loops forever or stops early. Held at STANDARD.
  [SCENE_GOAL_VERDICT]:    { min_tier: TIER_STANDARD, route: true },
};

/** Output price (USD / 1M tokens) at or below which a model counts as LIGHT,
 * and the ceiling for STANDARD. Derived from the price table rather than a
 * second hand-maintained list. */
export const TIER_LIGHT_MAX_OUTPUT = 5.0;
export const TIER_STANDARD_MAX_OUTPUT = 20.0;

export const REASONING_HINTS: readonly string[] = [
  "o1", "o3", "o4", "-thinking", "reasoner", "-r1", "longcat",
];

/** Whether this model spends billable hidden thinking tokens. */
export function is_reasoning_model(model_id: string): boolean {
  const key = _price_key(model_id);
  return REASONING_HINTS.some((h) => key.includes(h));
}

/** Guess a model's tier and relative cost from its published rates.
 *
 * `priced` is False when the model was not in the table. Those land at
 * STANDARD rather than LIGHT: an unknown model routed as cheap could be the
 * user's only frontier model, and quietly sending memory extraction to it is
 * recoverable, while quietly sending a goal verdict to something unfit is not. */
export function infer_capability(
  model_id: string,
  overrides?: Record<string, Record<string, number>> | null
): Record<string, unknown> {
  const [rates, source] = lookup_price(model_id, overrides);
  const priced = source !== COST_FALLBACK;
  const out = Number(rates["output"] ?? 0.0);
  const reasoning = is_reasoning_model(model_id);
  let tier: number;
  if (!priced) {
    tier = TIER_STANDARD;
  } else if (out > TIER_STANDARD_MAX_OUTPUT) {
    tier = TIER_HEAVY;
  } else if (out <= TIER_LIGHT_MAX_OUTPUT) {
    // Reasoning models bill hidden thinking tokens on top of the visible
    // output, so the sticker rate understates them — never route one as light.
    tier = reasoning ? TIER_STANDARD : TIER_LIGHT;
  } else {
    tier = TIER_STANDARD;
  }
  return { tier, cost_weight: out, reasoning, priced };
}

// ---------------------------------------------------------------------------
// Reasoning effort / thinking budget (UD4)
// ---------------------------------------------------------------------------
// Two rules make the whole thing safe (source, kept as contract):
//  1. `unset` is not `off`. Not sending the parameter (model decides) and
//     asking for no thinking are different requests.
//  2. A model that does not take the parameter gets NOTHING sent. Providers
//     answer an unknown field with 400, which llm_errors correctly classifies
//     as permanent.

export const EFFORT_UNSET = "";
export const EFFORT_OFF = "off";
export const EFFORT_LOW = "low";
export const EFFORT_HIGH = "high";
export const EFFORT_MAX = "max";
export const EFFORT_LEVELS: readonly string[] = [EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX];

export const EFFORT_STYLE_NONE = "";              // no knob; do not send anything
export const EFFORT_STYLE_OPENAI = "reasoning_effort";
export const EFFORT_STYLE_ANTHROPIC = "thinking";
export const EFFORT_STYLE_GOOGLE = "thinking_config";
export const EFFORT_STYLE_DEEPSEEK = "deepseek_thinking";
export const EFFORT_STYLE_QWEN = "enable_thinking";

const _EFFORT_OPENAI_HINTS: readonly string[] = ["o1", "o3", "o4", "gpt-5", "longcat"];
const _EFFORT_MINIMAL_HINTS: readonly string[] = ["gpt-5"];
const _EFFORT_ANTHROPIC_HINTS: readonly string[] = ["claude-3-7", "claude-sonnet-4", "claude-opus-4"];
const _EFFORT_GOOGLE_HINTS: readonly string[] = ["gemini-2.5", "gemini-3", "gemini-thinking"];
const _EFFORT_DEEPSEEK_HINTS: readonly string[] = ["deepseek-r1", "deepseek-reasoner", "deepseek-v3"];
const _EFFORT_QWEN_HINTS: readonly string[] = ["qwq", "qwen-max-thinking", "qwen-thinking", "glm-zero", "glm-4-thinking"];

export const ANTHROPIC_MIN_THINKING = 1024;
export const ANTHROPIC_BUDGETS: Readonly<Record<string, number>> = {
  [EFFORT_LOW]: 2048,
  [EFFORT_HIGH]: 8192,
  [EFFORT_MAX]: 24576,
};

export const GOOGLE_MIN_THINKING = 1024;
export const GOOGLE_MAX_THINKING = 32768;
export const GOOGLE_BUDGETS: Readonly<Record<string, number>> = {
  [EFFORT_LOW]: 2048,
  [EFFORT_HIGH]: 8192,
  [EFFORT_MAX]: 24576,
};
export const GOOGLE_LEVELS: Readonly<Record<string, string>> = {
  [EFFORT_LOW]: "LOW",
  [EFFORT_HIGH]: "HIGH",
  [EFFORT_MAX]: "HIGH",
};

export interface ModelThinkingProfile {
  /** Single model thinking and reasoning protocol capability profile. */
  readonly model_id_prefix: string;
  readonly family: string;      // openai, anthropic, google, deepseek, qwen, moonshot
  readonly wire_format: string; // reasoning_effort, thinking, thinking_config, enable_thinking, deepseek_thinking
  readonly supported_levels: readonly string[];
  readonly can_disable_thinking: boolean;
  readonly default_level: string;
  readonly budget_range: readonly [number, number];
  /** "allowed" | "strip" | "fixed_1.0" */
  readonly temperature_policy: string;
}

function prof(
  model_id_prefix: string,
  family: string,
  wire_format: string,
  supported_levels: readonly string[],
  can_disable_thinking: boolean,
  temperature_policy = "allowed",
  budget_range: readonly [number, number] = [1024, 32768],
  default_level = EFFORT_HIGH
): ModelThinkingProfile {
  return {
    model_id_prefix, family, wire_format, supported_levels,
    can_disable_thinking, temperature_policy, budget_range, default_level,
  };
}

export const BUILTIN_MODEL_PROFILES: readonly ModelThinkingProfile[] = [
  // 1. OpenAI o-series: cannot disable thinking, sampling knobs stripped
  prof("o1", "openai", EFFORT_STYLE_OPENAI, [EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX], false, "strip"),
  prof("o3", "openai", EFFORT_STYLE_OPENAI, [EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX], false, "strip"),
  prof("o4", "openai", EFFORT_STYLE_OPENAI, [EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX], false, "strip"),
  // 2. GPT-5: supports minimal, equivalent to true off
  prof("gpt-5", "openai", EFFORT_STYLE_OPENAI, [EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX], true, "strip"),
  // 3. Anthropic Extended Thinking
  prof("claude-3-7", "anthropic", EFFORT_STYLE_ANTHROPIC, [EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX], true, "strip", [1024, 64000]),
  prof("claude-sonnet-4", "anthropic", EFFORT_STYLE_ANTHROPIC, [EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX], true, "strip", [1024, 64000]),
  prof("claude-opus-4", "anthropic", EFFORT_STYLE_ANTHROPIC, [EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX], true, "strip", [1024, 64000]),
  // 4. Google Gemini 2.5 / 3.0
  prof("gemini-2.5", "google", EFFORT_STYLE_GOOGLE, [EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX], true),
  prof("gemini-3", "google", EFFORT_STYLE_GOOGLE, [EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX], true),
  prof("gemini-thinking", "google", EFFORT_STYLE_GOOGLE, [EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX], true),
  // 5. DeepSeek Reasoning series
  prof("deepseek-r1", "deepseek", EFFORT_STYLE_DEEPSEEK, [EFFORT_OFF, EFFORT_HIGH], true),
  prof("deepseek-reasoner", "deepseek", EFFORT_STYLE_DEEPSEEK, [EFFORT_OFF, EFFORT_HIGH], true),
  // 6. Qwen QwQ series
  prof("qwq", "qwen", EFFORT_STYLE_QWEN, [EFFORT_OFF, EFFORT_HIGH], true),
  prof("qwen-max-thinking", "qwen", EFFORT_STYLE_QWEN, [EFFORT_OFF, EFFORT_HIGH], true),
  prof("qwen-thinking", "qwen", EFFORT_STYLE_QWEN, [EFFORT_OFF, EFFORT_HIGH], true),
  prof("glm-zero", "qwen", EFFORT_STYLE_QWEN, [EFFORT_OFF, EFFORT_HIGH], true),
  prof("glm-4-thinking", "qwen", EFFORT_STYLE_QWEN, [EFFORT_OFF, EFFORT_HIGH], true),
  // 7. Moonshot / Kimi series
  prof("kimi-k2.5", "moonshot", EFFORT_STYLE_NONE, [], false, "fixed_1.0"),
  prof("kimi-k2.6", "moonshot", EFFORT_STYLE_NONE, [], false, "fixed_1.0"),
  prof("kimi-k3", "moonshot", EFFORT_STYLE_NONE, [], false, "strip"),
];

const _EXTERNAL_MODEL_PROFILES: ModelThinkingProfile[] = [];

/** Register an external or runtime model profile with highest priority. */
export function register_model_profile(profile: ModelThinkingProfile): void {
  _EXTERNAL_MODEL_PROFILES.unshift(profile);
}

/** Resolve ModelThinkingProfile for model_id.
 *
 * Precedence: runtime overrides → dynamic catalog → builtin → protocol-first
 * inference. (Catalog lookups are wired in model_catalog_loader.ts and reach
 * this function through its exported helpers; the import is dynamic to keep
 * the loader optional.) */
export function lookup_model_profile(
  model_id: string,
  kind = ""
): ModelThinkingProfile | null {
  const key = _price_key(model_id);
  if (!key) {
    return null;
  }
  for (const p of _EXTERNAL_MODEL_PROFILES) {
    if (key.includes(p.model_id_prefix)) {
      return p;
    }
  }

  let loader: Record<string, unknown> | null = null;
  try {
    loader = require_cache("model_catalog_loader.js");
    const cat_prof = (loader as { lookup_profile?: (m: string, k: string) => ModelThinkingProfile | null })
      ?.lookup_profile?.(model_id, kind);
    if (cat_prof) {
      return cat_prof;
    }
  } catch {
    // except Exception: pass
  }

  for (const p of BUILTIN_MODEL_PROFILES) {
    if (key.includes(p.model_id_prefix)) {
      return p;
    }
  }

  if (loader !== null && kind) {
    try {
      const inferred = (loader as { infer_profile_from_protocol?: (m: string, k: string) => ModelThinkingProfile | null })
        ?.infer_profile_from_protocol?.(model_id, kind);
      if (inferred) {
        return inferred;
      }
    } catch {
      // except Exception: pass
    }
  }

  return null;
}

export const get_model_thinking_profile = lookup_model_profile;

/** Coerce anything to a known level, defaulting to EFFORT_UNSET.
 *
 * Unknown input becomes "don't send it" rather than a guess: a typo in a
 * config file must not silently spend a maximum thinking budget on every turn. */
export function normalize_effort(level: string): string {
  const s = String(level ?? "").trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(s) ? s : EFFORT_UNSET;
}

/** Which wire format `model_id` accepts, or EFFORT_STYLE_NONE.
 *
 * `kind` is the provider's protocol. It is checked first for Claude because
 * the same model reached through an OpenAI-compatible proxy takes
 * `reasoning_effort` instead of `thinking` — the model name alone cannot
 * answer this.
 *
 * `declared` is the user's three-state override (#151): True forces a dialect
 * (the provider protocol picks which), False forces silence, null keeps the
 * guess. */
export function effort_style(
  model_id: string,
  kind = "",
  declared?: boolean | null
): string {
  if (declared === false) {
    return EFFORT_STYLE_NONE;
  }
  const key = _price_key(model_id);
  const k = String(kind ?? "").toLowerCase();
  const anthropic = k === "anthropic";
  const google = k === "google" || k === "gemini";
  const deepseek = k === "deepseek";
  const qwen = k === "qwen" || k === "glm";

  // 1. Check profile registry first
  const prof0 = lookup_model_profile(model_id, kind);
  if (prof0 !== null && prof0.wire_format !== EFFORT_STYLE_NONE) {
    if (prof0.family === "anthropic" && !anthropic) {
      return EFFORT_STYLE_OPENAI;
    }
    return prof0.wire_format;
  }

  // 2. Heuristic hints fallback
  if (key && _EFFORT_ANTHROPIC_HINTS.some((h) => key.includes(h))) {
    return anthropic ? EFFORT_STYLE_ANTHROPIC : EFFORT_STYLE_OPENAI;
  }
  if (key && _EFFORT_GOOGLE_HINTS.some((h) => key.includes(h))) {
    return EFFORT_STYLE_GOOGLE;
  }
  if (key && _EFFORT_DEEPSEEK_HINTS.some((h) => key.includes(h))) {
    return EFFORT_STYLE_DEEPSEEK;
  }
  if (key && _EFFORT_QWEN_HINTS.some((h) => key.includes(h))) {
    return EFFORT_STYLE_QWEN;
  }
  if (key && _EFFORT_OPENAI_HINTS.some((h) => key.includes(h))) {
    return EFFORT_STYLE_OPENAI;
  }
  if (declared === true) {
    if (anthropic) return EFFORT_STYLE_ANTHROPIC;
    if (google) return EFFORT_STYLE_GOOGLE;
    if (deepseek) return EFFORT_STYLE_DEEPSEEK;
    if (qwen) return EFFORT_STYLE_QWEN;
    return EFFORT_STYLE_OPENAI;
  }
  // Everything else — including non-reasoning models.
  return EFFORT_STYLE_NONE;
}

/** Whether this model has a thinking dial the user can move at all. */
export function supports_effort(
  model_id: string,
  kind = "",
  declared?: boolean | null
): boolean {
  return effort_style(model_id, kind, declared) !== EFFORT_STYLE_NONE;
}

/** Resolved thinking UI + wire metadata for one model.
 *
 * Single source of truth for the composer dial. Priority:
 * user override (declared) > catalog/profile > registry heuristics > unknown. */
export function build_thinking_capability(
  model_id: string,
  kind = "",
  declared?: boolean | null,
  opts: { catalog_reasoning?: boolean } = {}
): Record<string, unknown> {
  const style = effort_style(model_id, kind, declared);
  const internal = is_reasoning_model(model_id);
  const profile = lookup_model_profile(model_id, kind);

  let state: string;
  let source: string;
  let confidence: number;
  if (declared === false) {
    state = "unsupported"; source = "user_override"; confidence = 1.0;
  } else if (declared === true || style !== EFFORT_STYLE_NONE) {
    state = "supported";
    if (declared === true) {
      source = "user_override"; confidence = 1.0;
    } else if (profile !== null || opts.catalog_reasoning) {
      source = "model_profile"; confidence = 0.95;
    } else {
      source = "heuristic"; confidence = 0.78;
    }
  } else {
    state = "unknown"; source = "none"; confidence = 0.0;
  }

  const can_disable = profile !== null ? profile.can_disable_thinking : true;
  let variants =
    profile !== null && profile.supported_levels.length > 0
      ? [...profile.supported_levels]
      : [...EFFORT_LEVELS];

  if (!can_disable) {
    variants = variants.filter((v) => v !== EFFORT_OFF);
  }

  let default_variant = profile !== null ? profile.default_level : EFFORT_HIGH;
  if (variants.length > 0 && !variants.includes(default_variant)) {
    default_variant = variants[0]!;
  }

  const show_dial = state === "supported";
  let control: Record<string, unknown> | null = null;
  if (show_dial && style) {
    let param = "reasoning_effort";
    if (style === EFFORT_STYLE_ANTHROPIC) param = "thinking";
    else if (style === EFFORT_STYLE_GOOGLE) param = "thinkingConfig";
    else if (style === EFFORT_STYLE_DEEPSEEK) param = "thinking";
    else if (style === EFFORT_STYLE_QWEN) param = "enable_thinking";
    control = {
      kind: "effort",
      parameter: param,
      wireFormat: style,
      values: variants,
      default: default_variant,
    };
  }

  // Observed reasoning output in stream is separate from controllable effort.
  const output = internal ? "visible" : state === "supported" ? "unknown" : "hidden";

  return {
    thinking: {
      state, source, confidence, output,
      canDisable: can_disable,
    },
    control,
    ui: {
      showDial: show_dial,
      variants: show_dial ? variants : [],
      defaultVariant: default_variant,
    },
  };
}

/** Body fields that express `level` for this model. `{}` when it can't.
 *
 * Returns an empty dict for an unsupported model, an unknown level, and for
 * EFFORT_UNSET — three different reasons that all mean the same thing on the
 * wire: send nothing and let the model do what it does by default. */
export function reasoning_params(
  model_id: string,
  level: string,
  kind = "",
  declared?: boolean | null
): Record<string, unknown> {
  const lvl = normalize_effort(level);
  if (!lvl) {
    return {};
  }
  const style = effort_style(model_id, kind, declared);
  if (style === EFFORT_STYLE_OPENAI) {
    const key = _price_key(model_id);
    if (lvl === EFFORT_OFF) {
      if (_EFFORT_MINIMAL_HINTS.some((h) => key.includes(h))) {
        return { reasoning_effort: "minimal" };
      }
      return { reasoning_effort: "low" };
    }
    // "max" collapses to "high": the vendor ladder has three rungs, and
    // inventing a fourth value would be rejected outright.
    return { reasoning_effort: lvl === EFFORT_MAX ? "high" : lvl };
  }
  if (style === EFFORT_STYLE_ANTHROPIC) {
    if (lvl === EFFORT_OFF) {
      return {};
    }
    const budget = ANTHROPIC_BUDGETS[lvl];
    if (!budget) {
      return {};
    }
    return { thinking: { type: "enabled", budget_tokens: Math.trunc(budget) } };
  }
  if (style === EFFORT_STYLE_GOOGLE) {
    if (lvl === EFFORT_OFF) {
      // Google Gemini 2.5 Pro/Flash default to thinking enabled; to genuinely
      // disable thinking, the API strictly requires thinkingBudget: 0.
      return { thinkingConfig: { thinkingBudget: 0 } };
    }
    const budget = GOOGLE_BUDGETS[lvl] ?? 8192;
    return {
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: Math.min(budget, GOOGLE_MAX_THINKING),
        thinkingLevel: GOOGLE_LEVELS[lvl] ?? "HIGH",
      },
    };
  }
  if (style === EFFORT_STYLE_DEEPSEEK) {
    const state = lvl === EFFORT_OFF ? "disabled" : "enabled";
    return { thinking: { type: state } };
  }
  if (style === EFFORT_STYLE_QWEN) {
    return { enable_thinking: lvl !== EFFORT_OFF };
  }
  return {};
}

/** Per-scene thinking level, the middle of the three override layers
 * (global default → scene → this turn). SCENE_CHAT is deliberately absent:
 * the conversation follows the user's own setting, never a table. */
export const SCENE_EFFORTS: Readonly<Record<string, string>> = {
  [SCENE_COMMIT_MESSAGE]: EFFORT_OFF,
  [SCENE_MEMORY_EXTRACT]: EFFORT_OFF,
  [SCENE_FOLD_SUMMARY]: EFFORT_OFF,
  [SCENE_AUTO_RESOLVE]: EFFORT_LOW,
  // "Is this goal finished?" gates autonomous iteration, so a shallow wrong
  // verdict either loops forever or stops early — worth some thinking.
  [SCENE_GOAL_VERDICT]: EFFORT_LOW,
};

/** Thinking level for a named scene, or EFFORT_UNSET if it has no opinion. */
export function scene_effort(scene: string): string {
  return SCENE_EFFORTS[String(scene ?? "")] ?? EFFORT_UNSET;
}

// ---------------------------------------------------------------------------
// Provider compatibility matrix (#151)
// ---------------------------------------------------------------------------

export const COMPAT_MAX_TOKENS = "max_tokens";
export const COMPAT_MAX_COMPLETION_TOKENS = "max_completion_tokens";

const _COMPAT_REASONING_ERA: readonly string[] = ["o1", "o3", "o4", "gpt-5"];
const _COMPAT_KIMI_K2: readonly string[] = ["k2.5", "k2.6", "kimi-k2.5", "kimi-k2.6", "moonshot-v1-k2.5", "moonshot-v1-k2.6"];
const _COMPAT_KIMI_K3: readonly string[] = ["k3", "kimi-k3", "moonshot-k3"];
export const _COMPAT_THINKING_CONFLICTS: readonly string[] = ["temperature", "top_p", "top_k"];

export const DEFAULT_OUTPUT_CEILING = 32000;

/** Flatten whatever shape the caller has into a flat INPUT modality list.
 *
 * Two shapes reach us: a flat ["text","image"] and the Electron catalogue's
 * {"input": [...], "output": [...]}. Only the flat form was ever handled in
 * the old code, so for every UI-synced provider `"image" in modalities`
 * tested a DICT and always answered False. Output modalities are dropped on
 * purpose: this list answers "what can I put IN". */
export function normalize_modalities(raw: unknown): string[] {
  let r = raw;
  if (r !== null && typeof r === "object" && !Array.isArray(r)) {
    const got = (r as Record<string, unknown>)["input"];
    r = Array.isArray(got) ? got : ["text"];
  }
  if (typeof r === "string") {
    r = [r];
  }
  if (!Array.isArray(r)) {
    return ["text"];
  }
  const out = r.map((m) => String(m).trim().toLowerCase()).filter((m) => m);
  return out.length > 0 ? out : ["text"];
}

/** Which body dialect this model speaks.
 *
 * Keyed on the model family rather than the provider, because a proxy in
 * front of o3 still has to obey o3's field names. */
export function model_compat(
  model_id: string,
  kind = "",
  effort_declared?: boolean | null
): Record<string, unknown> {
  const key = _price_key(model_id);
  const reasoning_era = _COMPAT_REASONING_ERA.some((h) => key.includes(h));
  const is_kimi_k3 = _COMPAT_KIMI_K3.some((h) => key.includes(h));
  const is_kimi_k2 = _COMPAT_KIMI_K2.some((h) => key.includes(h));
  const style = effort_style(model_id, kind, effort_declared);
  return {
    max_tokens_field: reasoning_era ? COMPAT_MAX_COMPLETION_TOKENS : COMPAT_MAX_TOKENS,
    supports_temperature: !(reasoning_era || is_kimi_k3),
    fixed_temperature: is_kimi_k2 ? 1.0 : null,
    supports_effort: style !== EFFORT_STYLE_NONE,
    effort_style: style,
    thinking_conflicts: _COMPAT_THINKING_CONFLICTS,
  };
}

/** How much output room to ask for once `budget` tokens go to thinking.
 *
 * The budget is **added on top of** the base answer allowance, then capped by
 * the model's own output ceiling. The first implementation subtracted it
 * instead — carving thinking room out of max_tokens — which meant turning the
 * dial up SHRANK the answer. That is backwards. Returns a zero budget when
 * there isn't room for the vendor minimum, which the caller must read as
 * "don't enable thinking at all". */
export function thinking_allowance(
  base_max_tokens: number,
  budget: number,
  output_ceiling = 0
): Record<string, number> {
  const base = Math.max(Math.trunc(base_max_tokens ?? 0), 0);
  const bud = Math.max(Math.trunc(budget ?? 0), 0);
  const ceiling = Math.trunc(output_ceiling ?? 0) || DEFAULT_OUTPUT_CEILING;
  if (!bud) {
    return { max_tokens: base || ceiling, budget: 0 };
  }
  const want = base + bud;
  if (want <= ceiling) {
    return { max_tokens: want, budget: bud };
  }
  // Doesn't fit. Keep answer room first, then give thinking whatever is left.
  const room = ceiling - ANTHROPIC_MIN_THINKING;
  if (room < ANTHROPIC_MIN_THINKING) {
    return { max_tokens: Math.min(base || ceiling, ceiling), budget: 0 };
  }
  return { max_tokens: ceiling, budget: Math.min(bud, room) };
}

/** The full set/unset plan for one request body.
 *
 * Returns {set, unset, compat}. Callers apply `set` then `unset` —
 * subtraction last, so a rule that removes a field always wins over one that
 * wrote it. Every dialect difference is resolved here, once, from data. */
export function body_plan(
  model_id: string,
  kind = "",
  effort = "",
  base_max_tokens = 0,
  output_ceiling = 0,
  effort_declared?: boolean | null
): Record<string, unknown> {
  const compat = model_compat(model_id, kind, effort_declared);
  const set_: Record<string, unknown> = {};
  const unset: string[] = [];

  // 1. Output allowance under whichever name this family accepts.
  const field = String(compat["max_tokens_field"]);
  if (field !== COMPAT_MAX_TOKENS) {
    unset.push(COMPAT_MAX_TOKENS);
    if (base_max_tokens) {
      set_[field] = Math.trunc(base_max_tokens);
    }
  }

  // 2. Sampling knobs the model rejects outright or forces fixed.
  if (compat["fixed_temperature"] !== null && compat["fixed_temperature"] !== undefined) {
    set_["temperature"] = Number(compat["fixed_temperature"]);
  } else if (!compat["supports_temperature"]) {
    unset.push("temperature", "top_p");
  }

  // 3. Thinking. reasoning_params already returns {} for models with no dial
  //    and for EFFORT_UNSET, so an unsupported knob is never mentioned.
  const params = reasoning_params(model_id, effort, kind, effort_declared);
  const think = params["thinking"] as Record<string, unknown> | undefined;
  const google_think = params["thinkingConfig"] as Record<string, unknown> | undefined;
  if (think && typeof think === "object") {
    if (compat["effort_style"] === EFFORT_STYLE_DEEPSEEK) {
      set_["thinking"] = think;
      unset.push("reasoning_effort");
    } else {
      const allowance = thinking_allowance(
        base_max_tokens, Number(think["budget_tokens"] ?? 0), output_ceiling
      );
      if (allowance["budget"]) {
        set_[field] = allowance["max_tokens"];
        set_["thinking"] = { ...think, budget_tokens: allowance["budget"] };
        unset.push(...(_COMPAT_THINKING_CONFLICTS as readonly string[]));
      }
    }
  } else if (google_think && typeof google_think === "object") {
    const budget = Number(google_think["thinkingBudget"] ?? 0);
    const ceiling = Math.trunc(output_ceiling ?? 0) || GOOGLE_MAX_THINKING;
    const actual_ceiling = Math.min(ceiling, GOOGLE_MAX_THINKING);
    const clamped_budget = Math.min(budget, actual_ceiling);
    set_["thinkingConfig"] = { ...google_think, thinkingBudget: clamped_budget };
    unset.push("reasoning_effort");
  } else if (compat["effort_style"] === EFFORT_STYLE_QWEN && Object.keys(params).length > 0) {
    Object.assign(set_, params);
    unset.push("reasoning_effort");
  } else if (Object.keys(params).length > 0) {
    Object.assign(set_, params);
  }

  // dict.fromkeys de-dupes while keeping order.
  return {
    set: set_,
    unset: Array.from(new Set(unset)),
    compat,
  };
}
