"""
test_model_role_routing.py — F3 ModelRole 分模型路由回归测试

验证 persona → 档位 → 实际模型的解析逻辑。
"""
from __future__ import annotations

import pytest

from team import (
    resolve_model_for_role,
    resolve_subagent_model,
    ROLE_MODEL_ROLE_DEFAULTS,
    MODEL_ROLES,
    ROLE_PRESETS,
)


class TestModelRoleConfig:
    """F3: 配置读取与解析。"""

    def test_resolve_lite_role_configured(self):
        """配置了 lite 档位 → 返回对应模型。"""
        config = {"subagent": {"model_roles": {"lite": "siliconflow:deepseek-v3-lite"}}}
        result = resolve_model_for_role("lite", config)
        assert result == "siliconflow:deepseek-v3-lite"

    def test_resolve_review_role_configured(self):
        config = {"subagent": {"model_roles": {"review": "siliconflow:deepseek-v3"}}}
        result = resolve_model_for_role("review", config)
        assert result == "siliconflow:deepseek-v3"

    def test_resolve_unconfigured_returns_none(self):
        """未配置档位 → 返回 None（继承父模型）。"""
        config = {"subagent": {"model_roles": {"lite": ""}}}
        assert resolve_model_for_role("lite", config) is None

    def test_resolve_no_config_returns_none(self):
        assert resolve_model_for_role("lite", None) is None
        assert resolve_model_for_role("lite", {}) is None

    def test_resolve_unknown_role_returns_none(self):
        config = {"subagent": {"model_roles": {"lite": "x"}}}
        assert resolve_model_for_role("unknown_role", config) is None


class TestSubagentModelResolution:
    """F3: 子代理模型解析优先级。"""

    def test_explicit_override_wins(self):
        """显式 override 永远赢。"""
        config = {"subagent": {"model_roles": {"lite": "lite-model"}}}
        model, role = resolve_subagent_model(
            persona="researcher",
            model_override="explicit-model",
            config=config,
        )
        assert model == "explicit-model"
        assert role == "explicit"

    def test_persona_model_wins_over_role(self):
        """persona 显式 model 赢过角色档位。"""
        config = {"subagent": {"model_roles": {"lite": "lite-model"}}}
        model, role = resolve_subagent_model(
            persona="researcher",
            persona_model="persona-explicit",
            config=config,
        )
        assert model == "persona-explicit"
        assert role == "explicit"

    def test_role_fallback(self):
        """无显式 → 按角色档位路由。"""
        config = {"subagent": {"model_roles": {"lite": "lite-model"}}}
        model, role = resolve_subagent_model(
            persona="researcher",  # researcher → lite
            config=config,
        )
        assert model == "lite-model"
        assert role == "lite"

    def test_inherit_when_no_config(self):
        """无任何配置 → 继承父模型。"""
        model, role = resolve_subagent_model(
            persona="researcher",
            config={},
        )
        assert model is None
        assert role == "inherit"

    def test_coder_routes_to_main(self):
        """coder 默认 → main 档位。"""
        config = {"subagent": {"model_roles": {"main": "main-model"}}}
        model, role = resolve_subagent_model(
            persona="coder",
            config=config,
        )
        assert model == "main-model"
        assert role == "main"

    def test_reviewer_routes_to_review(self):
        """reviewer 默认 → review 档位。"""
        config = {"subagent": {"model_roles": {"review": "review-model"}}}
        model, role = resolve_subagent_model(
            persona="reviewer",
            config=config,
        )
        assert model == "review-model"
        assert role == "review"


class TestRoleDefaults:
    """F3: persona → 档位映射正确。"""

    def test_explore_is_lite(self):
        assert ROLE_MODEL_ROLE_DEFAULTS["explore"] == "lite"

    def test_researcher_is_lite(self):
        assert ROLE_MODEL_ROLE_DEFAULTS["researcher"] == "lite"

    def test_coder_is_main(self):
        assert ROLE_MODEL_ROLE_DEFAULTS["coder"] == "main"

    def test_planner_is_main(self):
        assert ROLE_MODEL_ROLE_DEFAULTS["planner"] == "main"

    def test_reviewer_is_review(self):
        assert ROLE_MODEL_ROLE_DEFAULTS["reviewer"] == "review"

    def test_validator_is_review(self):
        assert ROLE_MODEL_ROLE_DEFAULTS["validator"] == "review"

    def test_diagnostician_is_lite(self):
        assert ROLE_MODEL_ROLE_DEFAULTS["diagnostician"] == "lite"

    def test_presets_have_model_role(self):
        """ROLE_PRESETS 里每个 persona 都有 model_role 键。"""
        for name, preset in ROLE_PRESETS.items():
            assert "model_role" in preset, f"{name} missing model_role"
            assert preset["model_role"] == ROLE_MODEL_ROLE_DEFAULTS.get(name, "subagent")
