"""model_catalog_loader.py - Multi-tier dynamic model catalog & pricing loader.

Resolves model capabilities (thinking profiles, pricing, limits) dynamically without
requiring hardcoded Python source updates.

Hierarchy (SmartMerge priority):
1. Project-level:   <workspace>/.{brand}/models.json (Highest priority)
2. User-level:      ~/.{brand}/models.json
3. Dynamic cache:   ~/.{brand}/cache/model_pricing_catalog.json (24h background sync)
4. Protocol-first:  Inferred by provider protocol (kind: deepseek, google, anthropic, qwen)
5. Shipped fallback: Built-in tables in model_registry.py
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Optional

try:
    from user_dirs import BRAND_DIR, home_dir
except ImportError:
    from app.backend.user_dirs import BRAND_DIR, home_dir

try:
    from model_registry import (
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
        ModelThinkingProfile,
        _price_key,
    )
except ImportError:
    from app.backend.model_registry import (
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
        ModelThinkingProfile,
        _price_key,
    )

logger = logging.getLogger(__name__)

WIRE_FORMAT_MAP = {
    "reasoning_effort": EFFORT_STYLE_OPENAI,
    "openai": EFFORT_STYLE_OPENAI,
    "thinking": EFFORT_STYLE_ANTHROPIC,
    "anthropic": EFFORT_STYLE_ANTHROPIC,
    "thinking_config": EFFORT_STYLE_GOOGLE,
    "google": EFFORT_STYLE_GOOGLE,
    "gemini": EFFORT_STYLE_GOOGLE,
    "deepseek_thinking": EFFORT_STYLE_DEEPSEEK,
    "deepseek": EFFORT_STYLE_DEEPSEEK,
    "enable_thinking": EFFORT_STYLE_QWEN,
    "qwen": EFFORT_STYLE_QWEN,
    "none": EFFORT_STYLE_NONE,
}


def _normalize_cost_dict(raw: Any) -> Optional[dict[str, float]]:
    if not isinstance(raw, dict):
        return None
    inp = 0.0
    out = 0.0
    cr = 0.0
    cw = 0.0
    if "input" in raw or "output" in raw:
        inp = float(raw.get("input", 0.0) or 0.0)
        out = float(raw.get("output", 0.0) or 0.0)
        cr = float(raw.get("cache_read", 0.0) or 0.0)
        cw = float(raw.get("cache_write", 0.0) or 0.0)
    elif "input_cost_per_token" in raw or "output_cost_per_token" in raw:
        inp = float(raw.get("input_cost_per_token", 0.0) or 0.0) * 1_000_000.0
        out = float(raw.get("output_cost_per_token", 0.0) or 0.0) * 1_000_000.0
        cr = float(raw.get("cache_read_input_token_cost", 0.0) or 0.0) * 1_000_000.0
    elif "prompt" in raw or "completion" in raw:
        inp = float(raw.get("prompt", 0.0) or 0.0)
        out = float(raw.get("completion", 0.0) or 0.0)
        if 0.0 < inp < 0.001:
            inp *= 1_000_000.0
        if 0.0 < out < 0.001:
            out *= 1_000_000.0
    return {
        "input": inp,
        "output": out,
        "cache_read": cr,
        "cache_write": cw,
    }


class ModelCatalogLoader:
    def __init__(self, workspace_dir: Optional[Path | str] = None) -> None:
        self.workspace_dir: Optional[Path] = Path(workspace_dir) if workspace_dir else None
        self._cached_profiles: dict[str, ModelThinkingProfile] = {}
        self._cached_prices: dict[str, dict[str, float]] = {}
        self._loaded_paths: list[Path] = []
        self._initialized: bool = False

    def get_search_paths(self) -> list[Path]:
        paths: list[Path] = []
        cache_path = home_dir() / "cache" / "model_pricing_catalog.json"
        paths.append(cache_path)
        user_path = home_dir() / "models.json"
        paths.append(user_path)
        ws = self.workspace_dir or Path.cwd()
        project_path = ws / BRAND_DIR / "models.json"
        paths.append(project_path)
        return paths

    def load_catalog(self, force: bool = False) -> None:
        if self._initialized and not force:
            return
        self._cached_profiles.clear()
        self._cached_prices.clear()
        self._loaded_paths.clear()

        for path in self.get_search_paths():
            if not path.is_file():
                continue
            try:
                content = path.read_text(encoding="utf-8")
                data = json.loads(content)
                self._merge_config_data(data, source_path=path)
                self._loaded_paths.append(path)
            except Exception as e:
                logger.warning("Failed to load model catalog from %s: %s", path, e)
        self._initialized = True

    def _merge_config_data(self, data: Any, source_path: Path) -> None:
        models_list: list[dict] = []
        prices_dict: dict[str, Any] = {}

        if isinstance(data, list):
            models_list = [item for item in data if isinstance(item, dict)]
        elif isinstance(data, dict):
            if "models" in data and isinstance(data["models"], list):
                models_list = [item for item in data["models"] if isinstance(item, dict)]
            elif "models" in data and isinstance(data["models"], dict):
                models_list = [{"id": k, **v} for k, v in data["models"].items() if isinstance(v, dict)]
            if "prices" in data and isinstance(data["prices"], dict):
                prices_dict = data["prices"]

        for model_id, cost_spec in prices_dict.items():
            norm_cost = _normalize_cost_dict(cost_spec)
            if norm_cost:
                key = _price_key(model_id)
                if key:
                    self._cached_prices[key] = norm_cost

        for m in models_list:
            model_id = str(m.get("id") or m.get("model_id") or m.get("name") or "").strip()
            if not model_id:
                continue
            key = _price_key(model_id)
            if not key:
                continue

            cost_raw = m.get("cost") or m.get("pricing") or m.get("price")
            norm_cost = _normalize_cost_dict(cost_raw)
            if norm_cost:
                self._cached_prices[key] = norm_cost

            raw_wire = str(m.get("wireFormat") or m.get("wire_format") or m.get("family") or "").strip().lower()
            family = str(m.get("family") or "custom").strip().lower()
            wire_format = WIRE_FORMAT_MAP.get(raw_wire, EFFORT_STYLE_NONE)
            if wire_format == EFFORT_STYLE_NONE:
                wire_format = WIRE_FORMAT_MAP.get(family, EFFORT_STYLE_NONE)

            can_disable = bool(m.get("canDisableThinking", m.get("can_disable_thinking", True)))
            supp_levels = m.get("supportedLevels", m.get("supported_levels"))
            if isinstance(supp_levels, (list, tuple)):
                levels = tuple(str(x).lower() for x in supp_levels if str(x).lower() in EFFORT_LEVELS)
            else:
                if wire_format in (EFFORT_STYLE_DEEPSEEK, EFFORT_STYLE_QWEN):
                    levels = (EFFORT_OFF, EFFORT_HIGH)
                elif wire_format == EFFORT_STYLE_OPENAI and not can_disable:
                    levels = (EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX)
                else:
                    levels = (EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX)

            def_level = str(m.get("defaultLevel", m.get("default_level", EFFORT_HIGH))).lower()
            if def_level not in levels and levels:
                def_level = levels[0]

            budget_raw = m.get("budgetRange", m.get("budget_range"))
            if isinstance(budget_raw, (list, tuple)) and len(budget_raw) == 2:
                budget_range = (int(budget_raw[0]), int(budget_raw[1]))
            else:
                budget_range = (1024, 32768)

            temp_policy = str(m.get("temperaturePolicy", m.get("temperature_policy", "allowed")))

            if wire_format != EFFORT_STYLE_NONE or m.get("supports_reasoning") or m.get("reasoning"):
                prof = ModelThinkingProfile(
                    model_id_prefix=key,
                    family=family,
                    wire_format=wire_format,
                    supported_levels=levels,
                    can_disable_thinking=can_disable,
                    default_level=def_level,
                    budget_range=budget_range,
                    temperature_policy=temp_policy,
                )
                self._cached_profiles[key] = prof

    def lookup_profile(self, model_id: str, kind: str = "") -> Optional[ModelThinkingProfile]:
        if not self._initialized:
            self.load_catalog()
        key = _price_key(model_id)
        if not key:
            return None
        if key in self._cached_profiles:
            return self._cached_profiles[key]
        hits = [k for k in self._cached_profiles if key.startswith(k) or k.startswith(key)]
        if hits:
            best = max(hits, key=len)
            return self._cached_profiles[best]
        return None

    def lookup_price(self, model_id: str) -> Optional[dict[str, float]]:
        if not self._initialized:
            self.load_catalog()
        key = _price_key(model_id)
        if not key:
            return None
        if key in self._cached_prices:
            return dict(self._cached_prices[key])
        hits = [k for k in self._cached_prices if key.startswith(k)]
        if hits:
            best = max(hits, key=len)
            return dict(self._cached_prices[best])
        return None

    def infer_profile_from_protocol(self, model_id: str, kind: str = "") -> Optional[ModelThinkingProfile]:
        k = str(kind or "").strip().lower()
        if not k:
            return None
        key = _price_key(model_id)
        if k == "deepseek":
            return ModelThinkingProfile(
                model_id_prefix=key,
                family="deepseek",
                wire_format=EFFORT_STYLE_DEEPSEEK,
                supported_levels=(EFFORT_OFF, EFFORT_HIGH),
                can_disable_thinking=True,
                default_level=EFFORT_HIGH,
                temperature_policy="allowed",
            )
        if k in ("google", "gemini"):
            return ModelThinkingProfile(
                model_id_prefix=key,
                family="google",
                wire_format=EFFORT_STYLE_GOOGLE,
                supported_levels=(EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX),
                can_disable_thinking=True,
                default_level=EFFORT_HIGH,
                budget_range=(1024, 32768),
                temperature_policy="allowed",
            )
        if k == "anthropic":
            return ModelThinkingProfile(
                model_id_prefix=key,
                family="anthropic",
                wire_format=EFFORT_STYLE_ANTHROPIC,
                supported_levels=(EFFORT_OFF, EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX),
                can_disable_thinking=True,
                default_level=EFFORT_HIGH,
                budget_range=(1024, 64000),
                temperature_policy="strip",
            )
        if k in ("qwen", "glm"):
            return ModelThinkingProfile(
                model_id_prefix=key,
                family="qwen",
                wire_format=EFFORT_STYLE_QWEN,
                supported_levels=(EFFORT_OFF, EFFORT_HIGH),
                can_disable_thinking=True,
                default_level=EFFORT_HIGH,
                temperature_policy="allowed",
            )
        return None

    def update_pricing_cache(self, catalog_data: dict) -> Path:
        cache_dir = home_dir() / "cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / "model_pricing_catalog.json"
        cache_file.write_text(json.dumps(catalog_data, indent=2, ensure_ascii=False), encoding="utf-8")
        self.load_catalog(force=True)
        return cache_file


_GLOBAL_LOADER: Optional[ModelCatalogLoader] = None


def get_catalog_loader(workspace_dir: Optional[Path | str] = None) -> ModelCatalogLoader:
    global _GLOBAL_LOADER
    if _GLOBAL_LOADER is None or (workspace_dir and _GLOBAL_LOADER.workspace_dir != Path(workspace_dir)):
        _GLOBAL_LOADER = ModelCatalogLoader(workspace_dir=workspace_dir)
        _GLOBAL_LOADER.load_catalog()
    return _GLOBAL_LOADER


def reset_catalog_loader() -> None:
    global _GLOBAL_LOADER
    _GLOBAL_LOADER = None


def lookup_catalog_profile(model_id: str, kind: str = "") -> Optional[ModelThinkingProfile]:
    loader = get_catalog_loader()
    prof = loader.lookup_profile(model_id, kind)
    if prof is not None:
        return prof
    return loader.infer_profile_from_protocol(model_id, kind)


def lookup_catalog_price(model_id: str) -> Optional[dict[str, float]]:
    return get_catalog_loader().lookup_price(model_id)
