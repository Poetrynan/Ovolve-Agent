"""test_model_catalog_loader.py - Test multi-tier dynamic model catalog & protocol-first inference."""
import json
import pytest
from pathlib import Path
from unittest.mock import patch

from user_dirs import BRAND_DIR
from model_registry import (
    EFFORT_OFF,
    EFFORT_HIGH,
    EFFORT_LOW,
    EFFORT_MAX,
    EFFORT_STYLE_DEEPSEEK,
    EFFORT_STYLE_GOOGLE,
    EFFORT_STYLE_ANTHROPIC,
    EFFORT_STYLE_OPENAI,
    EFFORT_STYLE_QWEN,
    COST_ESTIMATED,
    lookup_price,
    lookup_model_profile,
    body_plan,
    compute_cost,
)
from model_catalog_loader import (
    ModelCatalogLoader,
    get_catalog_loader,
    reset_catalog_loader,
    lookup_catalog_profile,
    lookup_catalog_price,
)


@pytest.fixture(autouse=True)
def cleanup_catalog():
    reset_catalog_loader()
    yield
    reset_catalog_loader()


def test_catalog_loader_smartmerge(tmp_path, monkeypatch):
    """Test project-level models.json overrides user-level models.json and merges distinct models."""
    user_home = tmp_path / "user_home"
    user_home.mkdir()
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    # User level config
    user_models = {
        "models": [
            {
                "id": "shared-model-v1",
                "family": "deepseek",
                "wireFormat": "deepseek_thinking",
                "cost": {"input": 1.0, "output": 2.0}
            },
            {
                "id": "user-only-model",
                "family": "google",
                "wireFormat": "thinking_config",
                "cost": {"input": 0.5, "output": 1.5}
            }
        ]
    }
    user_cfg_file = user_home / "models.json"
    user_cfg_file.write_text(json.dumps(user_models), encoding="utf-8")

    # Project level config (overrides shared-model-v1 pricing & wireFormat)
    proj_dir = workspace / BRAND_DIR
    proj_dir.mkdir(parents=True)
    project_models = {
        "models": [
            {
                "id": "shared-model-v1",
                "family": "openai",
                "wireFormat": "reasoning_effort",
                "canDisableThinking": False,
                "cost": {"input": 5.0, "output": 10.0}
            },
            {
                "id": "project-only-model",
                "family": "anthropic",
                "wireFormat": "thinking",
                "cost": {"input": 3.0, "output": 15.0}
            }
        ]
    }
    proj_cfg_file = proj_dir / "models.json"
    proj_cfg_file.write_text(json.dumps(project_models), encoding="utf-8")

    monkeypatch.setattr("model_catalog_loader.home_dir", lambda: user_home)

    loader = ModelCatalogLoader(workspace_dir=workspace)
    loader.load_catalog()

    # 1. Verify project overrides user for shared-model-v1
    prof_shared = loader.lookup_profile("shared-model-v1")
    assert prof_shared is not None
    assert prof_shared.wire_format == EFFORT_STYLE_OPENAI
    assert prof_shared.can_disable_thinking is False

    price_shared = loader.lookup_price("shared-model-v1")
    assert price_shared["input"] == 5.0
    assert price_shared["output"] == 10.0

    # 2. Verify user-only model is retained
    prof_user = loader.lookup_profile("user-only-model")
    assert prof_user is not None
    assert prof_user.wire_format == EFFORT_STYLE_GOOGLE
    assert loader.lookup_price("user-only-model")["input"] == 0.5

    # 3. Verify project-only model is present
    prof_proj = loader.lookup_profile("project-only-model")
    assert prof_proj is not None
    assert prof_proj.wire_format == EFFORT_STYLE_ANTHROPIC
    assert loader.lookup_price("project-only-model")["input"] == 3.0


def test_catalog_custom_model_wire_plan_and_pricing(tmp_path, monkeypatch):
    """Test custom models in catalog work transparently with body_plan and compute_cost."""
    user_home = tmp_path / "home"
    user_home.mkdir()
    models_cfg = {
        "models": [
            {
                "id": "corp-r1-custom",
                "family": "deepseek",
                "wireFormat": "deepseek_thinking",
                "cost": {"input": 0.55, "output": 2.19, "cache_read": 0.14, "cache_write": 0.0}
            }
        ]
    }
    (user_home / "models.json").write_text(json.dumps(models_cfg), encoding="utf-8")
    monkeypatch.setattr("model_catalog_loader.home_dir", lambda: user_home)

    # Trigger registry lookup
    prof = lookup_model_profile("corp-r1-custom")
    assert prof is not None
    assert prof.wire_format == EFFORT_STYLE_DEEPSEEK

    # Test body plan generation
    plan_on = body_plan("corp-r1-custom", effort="high")
    assert plan_on["set"]["thinking"] == {"type": "enabled"}

    plan_off = body_plan("corp-r1-custom", effort="off")
    assert plan_off["set"]["thinking"] == {"type": "disabled"}

    # Test pricing lookup & billing
    rates, source = lookup_price("corp-r1-custom")
    assert source == COST_ESTIMATED
    assert rates["input"] == 0.55
    assert rates["output"] == 2.19

    cost_info = compute_cost("corp-r1-custom", {"input": 1_000_000, "output": 100_000})
    assert cost_info["cost_source"] == COST_ESTIMATED
    assert cost_info["cost_micros"] > 0


def test_protocol_first_inference_deepseek():
    """Test protocol kind='deepseek' infers DeepSeek thinking for unknown custom model IDs."""
    unknown_model = "enterprise-ai-service-internal-99"

    # Without kind, unknown model has no profile
    prof_none = lookup_model_profile(unknown_model)
    assert prof_none is None

    # With kind="deepseek", protocol-first infers DeepSeek profile
    prof = lookup_model_profile(unknown_model, kind="deepseek")
    assert prof is not None
    assert prof.wire_format == EFFORT_STYLE_DEEPSEEK
    assert prof.can_disable_thinking is True

    plan = body_plan(unknown_model, effort="high", kind="deepseek")
    assert plan["set"]["thinking"] == {"type": "enabled"}


def test_protocol_first_inference_google_thinking_off():
    """Test protocol kind='google' infers Google profile and turns off thinking with thinkingBudget: 0."""
    unknown_google_model = "corp-vertex-gemini-custom"

    prof = lookup_model_profile(unknown_google_model, kind="google")
    assert prof is not None
    assert prof.wire_format == EFFORT_STYLE_GOOGLE

    plan_off = body_plan(unknown_google_model, effort="off", kind="google")
    assert plan_off["set"]["thinkingConfig"] == {"thinkingBudget": 0}

    plan_on = body_plan(unknown_google_model, effort="high", kind="google")
    assert plan_on["set"]["thinkingConfig"]["includeThoughts"] is True
    assert plan_on["set"]["thinkingConfig"]["thinkingBudget"] == 8192


def test_protocol_first_inference_anthropic():
    """Test protocol kind='anthropic' infers Anthropic thinking profile."""
    unknown_claude = "aws-bedrock-private-claude"

    prof = lookup_model_profile(unknown_claude, kind="anthropic")
    assert prof is not None
    assert prof.wire_format == EFFORT_STYLE_ANTHROPIC

    plan = body_plan(unknown_claude, effort="high", kind="anthropic")
    assert plan["set"]["thinking"] == {"type": "enabled", "budget_tokens": 8192}


def test_dynamic_pricing_cache_update(tmp_path, monkeypatch):
    """Test updating pricing cache dynamically makes new models available without source code edit."""
    user_home = tmp_path / "home"
    user_home.mkdir()
    monkeypatch.setattr("model_catalog_loader.home_dir", lambda: user_home)

    loader = get_catalog_loader()
    cache_data = {
        "prices": {
            "newly-released-model-2026": {
                "input": 0.88,
                "output": 3.45,
                "cache_read": 0.22,
                "cache_write": 0.0
            }
        }
    }
    cache_path = loader.update_pricing_cache(cache_data)
    assert cache_path.exists()

    rates, source = lookup_price("newly-released-model-2026")
    assert source == COST_ESTIMATED
    assert rates["input"] == 0.88
    assert rates["output"] == 3.45
