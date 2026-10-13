/**
 * model_catalog_loader.ts — Multi-tier dynamic model catalog & pricing loader.
 *
 * Ported from `app/backend/model_catalog_loader.py` (333 lines).
 *
 * Resolves model capabilities (thinking profiles, pricing, limits) dynamically
 * without requiring hardcoded source updates.
 *
 * Hierarchy (SmartMerge priority):
 * 1. Project-level:   <workspace>/.ovolve/models.json (Highest priority)
 * 2. User-level:      ~/.ovolve/models.json
 * 3. Dynamic cache:   ~/.ovolve/cache/model_pricing_catalog.json (24h sync)
 * 4. Protocol-first:  Inferred by provider protocol (kind)
 * 5. Shipped fallback: Built-in tables in model_registry.ts
 *
 * Search-path order (source get_search_paths): cache → user → project; the
 * merge loop processes them in that order so the HIGHEST-priority project
 * file loads LAST and overwrites earlier entries in the same-key maps.
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only (node:fs, node:path; user_dirs.ts).
 *   §2  `logging.warning` → console.warn (established substitute).
 *   §2  `except Exception` around each file load → per-file warn + continue,
 *       never a load failure for the whole chain.
 *   §2  tuple levels → readonly string arrays; ModelThinkingProfile imported
 *       from model_registry.ts (same type object, so registry and loader
 *       share one profile identity).
 *   §4  naming: model_catalog_loader.py → model_catalog_loader.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { BRAND_DIR, homeDir } from "./user_dirs.js";
import {
  EFFORT_LEVELS,
  EFFORT_OFF,
  EFFORT_LOW,
  EFFORT_HIGH,
  EFFORT_MAX,
  EFFORT_STYLE_NONE,
  EFFORT_STYLE_OPENAI,
  EFFORT_STYLE_ANTHROPIC,
  EFFORT_STYLE_GOOGLE,
  EFFORT_STYLE_DEEPSEEK,
  EFFORT_STYLE_QWEN,
  type ModelThinkingProfile,
  _price_key,
} from "./model_registry.js";

export const WIRE_FORMAT_MAP: Readonly<Record<string, string>> = {
  reasoning_effort: EFFORT_STYLE_OPENAI,
  openai: EFFORT_STYLE_OPENAI,
  thinking: EFFORT_STYLE_ANTHROPIC,
  anthropic: EFFORT_STYLE_ANTHROPIC,
  thinking_config: EFFORT_STYLE_GOOGLE,
  google: EFFORT_STYLE_GOOGLE,
  gemini: EFFORT_STYLE_GOOGLE,
  deepseek_thinking: EFFORT_STYLE_DEEPSEEK,
  deepseek: EFFORT_STYLE_DEEPSEEK,
  enable_thinking: EFFORT_STYLE_QWEN,
  qwen: EFFORT_STYLE_QWEN,
  none: EFFORT_STYLE_NONE,
};

/** Normalize whatever cost shape a catalog entry carries into the standard
 * {input, output, cache_read, cache_write} USD-per-1M table shape.
 *
 * Handles three real-world shapes (verbatim from the source):
 * 1. {input, output, cache_read, cache_write} — already per-1M.
 * 2. {input_cost_per_token, ...} — per-token; × 1e6.
 * 3. {prompt, completion} — ambiguous; if the values look like per-token
 *    rates (< 0.001) scale them up, else treat as per-1M.
 * Returns null for anything that isn't a usable cost dict. */
export function _normalize_cost_dict(raw: unknown): Record<string, number> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const num = (k: string): number => {
    const v = Number(r[k] ?? 0);
    return Number.isFinite(v) ? v : 0.0;
  };
  let inp = 0.0;
  let out = 0.0;
  let cr = 0.0;
  let cw = 0.0;
  if ("input" in r || "output" in r) {
    inp = num("input");
    out = num("output");
    cr = num("cache_read");
    cw = num("cache_write");
  } else if ("input_cost_per_token" in r || "output_cost_per_token" in r) {
    inp = num("input_cost_per_token") * 1_000_000.0;
    out = num("output_cost_per_token") * 1_000_000.0;
    cr = num("cache_read_input_token_cost") * 1_000_000.0;
  } else if ("prompt" in r || "completion" in r) {
    inp = num("prompt");
    out = num("completion");
    if (0.0 < inp && inp < 0.001) {
      inp *= 1_000_000.0;
    }
    if (0.0 < out && out < 0.001) {
      out *= 1_000_000.0;
    }
  }
  return { input: inp, output: out, cache_read: cr, cache_write: cw };
}

export class ModelCatalogLoader {
  workspace_dir: string | null;
  _cached_profiles: Record<string, ModelThinkingProfile> = {};
  _cached_prices: Record<string, Record<string, number>> = {};
  _loaded_paths: string[] = [];
  _initialized = false;

  constructor(workspace_dir?: string | null) {
    this.workspace_dir = workspace_dir ? path.resolve(workspace_dir) : null;
  }

  /** Cache file → user file → project file (project wins on merge). */
  get_search_paths(): string[] {
    const home = homeDir();
    const paths: string[] = [];
    paths.push(path.join(home, "cache", "model_pricing_catalog.json"));
    paths.push(path.join(home, "models.json"));
    const ws = this.workspace_dir ?? process.cwd();
    paths.push(path.join(ws, BRAND_DIR, "models.json"));
    return paths;
  }

  load_catalog(force = false): void {
    if (this._initialized && !force) {
      return;
    }
    this._cached_profiles = {};
    this._cached_prices = {};
    this._loaded_paths = [];

    for (const p of this.get_search_paths()) {
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
        continue;
      }
      try {
        const content = fs.readFileSync(p, "utf-8");
        const data = JSON.parse(content) as unknown;
        this._merge_config_data(data);
        this._loaded_paths.push(p);
      } catch (e) {
        // except Exception: warn + keep loading the rest of the chain
        console.warn(`Failed to load model catalog from ${p}: ${e}`);
      }
    }
    this._initialized = true;
  }

  _merge_config_data(data: unknown): void {
    let models_list: Record<string, unknown>[] = [];
    let prices_dict: Record<string, unknown> = {};

    if (Array.isArray(data)) {
      models_list = data.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item)
      );
    } else if (data !== null && typeof data === "object") {
      const d = data as Record<string, unknown>;
      if ("models" in d && Array.isArray(d["models"])) {
        models_list = (d["models"] as unknown[]).filter(
          (item): item is Record<string, unknown> =>
            item !== null && typeof item === "object" && !Array.isArray(item)
        );
      } else if ("models" in d && d["models"] !== null && typeof d["models"] === "object") {
        models_list = Object.entries(d["models"] as Record<string, unknown>)
          .filter(([, v]) => v !== null && typeof v === "object" && !Array.isArray(v))
          .map(([k, v]) => ({ id: k, ...(v as Record<string, unknown>) }));
      }
      if ("prices" in d && d["prices"] !== null && typeof d["prices"] === "object" && !Array.isArray(d["prices"])) {
        prices_dict = d["prices"] as Record<string, unknown>;
      }
    }

    for (const [model_id, cost_spec] of Object.entries(prices_dict)) {
      const norm_cost = _normalize_cost_dict(cost_spec);
      if (norm_cost) {
        const key = _price_key(model_id);
        if (key) {
          this._cached_prices[key] = norm_cost;
        }
      }
    }

    for (const m of models_list) {
      const model_id = String(m["id"] ?? m["model_id"] ?? m["name"] ?? "").trim();
      if (!model_id) {
        continue;
      }
      const key = _price_key(model_id);
      if (!key) {
        continue;
      }

      const cost_raw = m["cost"] ?? m["pricing"] ?? m["price"];
      const norm_cost = _normalize_cost_dict(cost_raw);
      if (norm_cost) {
        this._cached_prices[key] = norm_cost;
      }

      const raw_wire = String(
        m["wireFormat"] ?? m["wire_format"] ?? m["family"] ?? ""
      )
        .trim()
        .toLowerCase();
      const family = String(m["family"] ?? "custom").trim().toLowerCase();
      let wire_format = WIRE_FORMAT_MAP[raw_wire] ?? EFFORT_STYLE_NONE;
      if (wire_format === EFFORT_STYLE_NONE) {
        wire_format = WIRE_FORMAT_MAP[family] ?? EFFORT_STYLE_NONE;
      }

      const can_disable = Boolean(
        m["canDisableThinking"] ?? m["can_disable_thinking"] ?? true
      );
      const supp_levels = m["supportedLevels"] ?? m["supported_levels"];
      let levels: string[];
      if (Array.isArray(supp_levels)) {
        levels = supp_levels
          .map((x) => String(x).toLowerCase())
          .filter((x) => (EFFORT_LEVELS as readonly string[]).includes(x));
      } else {
        if (wire_format === EFFORT_STYLE_DEEPSEEK || wire_format === EFFORT_STYLE_QWEN) {
          levels = [EFFORT_OFF, EFFORT_HIGH];
        } else if (wire_format === EFFORT_STYLE_OPENAI && !can_disable) {
          levels = [EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX];
        } else {
          levels = [EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX];
        }
      }

      let def_level = String(m["defaultLevel"] ?? m["default_level"] ?? EFFORT_HIGH).toLowerCase();
      if (!levels.includes(def_level) && levels.length > 0) {
        def_level = levels[0]!;
      }

      const budget_raw = m["budgetRange"] ?? m["budget_range"];
      let budget_range: readonly [number, number];
      if (Array.isArray(budget_raw) && budget_raw.length === 2) {
        budget_range = [Math.trunc(Number(budget_raw[0])), Math.trunc(Number(budget_raw[1]))];
      } else {
        budget_range = [1024, 32768];
      }

      const temp_policy = String(
        m["temperaturePolicy"] ?? m["temperature_policy"] ?? "allowed"
      );

      if (
        wire_format !== EFFORT_STYLE_NONE ||
        m["supports_reasoning"] ||
        m["reasoning"]
      ) {
        const prof: ModelThinkingProfile = {
          model_id_prefix: key,
          family,
          wire_format,
          supported_levels: levels,
          can_disable_thinking: can_disable,
          default_level: def_level,
          budget_range,
          temperature_policy: temp_policy,
        };
        this._cached_profiles[key] = prof;
      }
    }
  }

  lookup_profile(model_id: string, kind = ""): ModelThinkingProfile | null {
    void kind; // 源签名保留 kind 参数（此层不用，照抄）
    if (!this._initialized) {
      this.load_catalog();
    }
    const key = _price_key(model_id);
    if (!key) {
      return null;
    }
    if (key in this._cached_profiles) {
      return this._cached_profiles[key]!;
    }
    const hits = Object.keys(this._cached_profiles).filter(
      (k) => key.startsWith(k) || k.startsWith(key)
    );
    if (hits.length > 0) {
      const best = hits.reduce((a, b) => (b.length > a.length ? b : a));
      return this._cached_profiles[best]!;
    }
    return null;
  }

  lookup_price(model_id: string): Record<string, number> | null {
    if (!this._initialized) {
      this.load_catalog();
    }
    const key = _price_key(model_id);
    if (!key) {
      return null;
    }
    if (key in this._cached_prices) {
      return { ...this._cached_prices[key]! };
    }
    const hits = Object.keys(this._cached_prices).filter((k) => key.startsWith(k));
    if (hits.length > 0) {
      const best = hits.reduce((a, b) => (b.length > a.length ? b : a));
      return { ...this._cached_prices[best]! };
    }
    return null;
  }

  infer_profile_from_protocol(model_id: string, kind = ""): ModelThinkingProfile | null {
    const k = String(kind ?? "").trim().toLowerCase();
    if (!k) {
      return null;
    }
    const key = _price_key(model_id);
    if (k === "deepseek") {
      return {
        model_id_prefix: key,
        family: "deepseek",
        wire_format: EFFORT_STYLE_DEEPSEEK,
        supported_levels: [EFFORT_OFF, EFFORT_HIGH],
        can_disable_thinking: true,
        default_level: EFFORT_HIGH,
        budget_range: [1024, 32768],
        temperature_policy: "allowed",
      };
    }
    if (k === "google" || k === "gemini") {
      return {
        model_id_prefix: key,
        family: "google",
        wire_format: EFFORT_STYLE_GOOGLE,
        supported_levels: [EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX],
        can_disable_thinking: true,
        default_level: EFFORT_HIGH,
        budget_range: [1024, 32768],
        temperature_policy: "allowed",
      };
    }
    if (k === "anthropic") {
      return {
        model_id_prefix: key,
        family: "anthropic",
        wire_format: EFFORT_STYLE_ANTHROPIC,
        supported_levels: [EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX],
        can_disable_thinking: true,
        default_level: EFFORT_HIGH,
        budget_range: [1024, 64000],
        temperature_policy: "strip",
      };
    }
    if (k === "qwen" || k === "glm") {
      return {
        model_id_prefix: key,
        family: "qwen",
        wire_format: EFFORT_STYLE_QWEN,
        supported_levels: [EFFORT_OFF, EFFORT_HIGH],
        can_disable_thinking: true,
        default_level: EFFORT_HIGH,
        budget_range: [1024, 32768],
        temperature_policy: "allowed",
      };
    }
    return null;
  }

  update_pricing_cache(catalog_data: unknown): string {
    /** Persist a fresh catalog download and force a reload. */
    const cache_dir = path.join(homeDir(), "cache");
    fs.mkdirSync(cache_dir, { recursive: true });
    const cache_file = path.join(cache_dir, "model_pricing_catalog.json");
    fs.writeFileSync(cache_file, JSON.stringify(catalog_data, null, 2), "utf-8");
    this.load_catalog(true);
    return cache_file;
  }
}

let _GLOBAL_LOADER: ModelCatalogLoader | null = null;

export function get_catalog_loader(workspace_dir?: string | null): ModelCatalogLoader {
  if (
    _GLOBAL_LOADER === null ||
    (workspace_dir && _GLOBAL_LOADER.workspace_dir !== path.resolve(workspace_dir))
  ) {
    _GLOBAL_LOADER = new ModelCatalogLoader(workspace_dir);
    _GLOBAL_LOADER.load_catalog();
  }
  return _GLOBAL_LOADER;
}

export function reset_catalog_loader(): void {
  _GLOBAL_LOADER = null;
}

export function lookup_catalog_profile(
  model_id: string,
  kind = ""
): ModelThinkingProfile | null {
  const loader = get_catalog_loader();
  const prof = loader.lookup_profile(model_id, kind);
  if (prof !== null) {
    return prof;
  }
  return loader.infer_profile_from_protocol(model_id, kind);
}

export function lookup_catalog_price(model_id: string): Record<string, number> | null {
  return get_catalog_loader().lookup_price(model_id);
}
