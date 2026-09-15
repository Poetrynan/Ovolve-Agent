# -*- coding: utf-8 -*-
"""Tests for model thinking levels and declarative body_plan reconciliation.

Tests vendor constraint adherence (Anthropic, OpenAI reasoning-era, Google),
wire format selection, and defensive value normalization.
"""
from __future__ import annotations

import pytest
from model_registry import (
    EFFORT_OFF,
    EFFORT_LOW,
    EFFORT_HIGH,
    EFFORT_MAX,
    EFFORT_UNSET,
    EFFORT_LEVELS,
    EFFORT_STYLE_NONE,
    EFFORT_STYLE_OPENAI,
    EFFORT_STYLE_ANTHROPIC,
    EFFORT_STYLE_GOOGLE,
    EFFORT_STYLE_DEEPSEEK,
    EFFORT_STYLE_QWEN,
    normalize_effort,
    effort_style,
    supports_effort,
    build_thinking_capability,
    ModelThinkingProfile,
    lookup_model_profile,
    reasoning_params,
    thinking_allowance,
    body_plan,
    scene_effort,
    SCENE_COMMIT_MESSAGE,
    SCENE_MEMORY_EXTRACT,
    SCENE_FOLD_SUMMARY,
    SCENE_AUTO_RESOLVE,
    SCENE_GOAL_VERDICT,
)


# ---------------------------------------------------------------------------
# 1. Normalization & Sanitization Tests
# ---------------------------------------------------------------------------

def test_normalize_effort_valid_levels():
    assert normalize_effort("off") == EFFORT_OFF
    assert normalize_effort("low") == EFFORT_LOW
    assert normalize_effort("high") == EFFORT_HIGH
    assert normalize_effort("max") == EFFORT_MAX


def test_normalize_effort_whitespace_and_case():
    assert normalize_effort("  LOW  ") == EFFORT_LOW
    assert normalize_effort("HIGH") == EFFORT_HIGH
    assert normalize_effort("  mAx  ") == EFFORT_MAX


def test_normalize_effort_invalid_values_silently_unset():
    # Unknown rungs from other ladders must NEVER guess or explode — they become unset.
    assert normalize_effort("xhigh") == EFFORT_UNSET
    assert normalize_effort("medium") == EFFORT_UNSET
    assert normalize_effort("minimal") == EFFORT_UNSET
    assert normalize_effort("bogus") == EFFORT_UNSET
    assert normalize_effort("") == EFFORT_UNSET
    assert normalize_effort(None) == EFFORT_UNSET


# ---------------------------------------------------------------------------
# 2. Thinking Allowance & Boundary Tests
# ---------------------------------------------------------------------------

def test_thinking_allowance_zero_budget():
    res = thinking_allowance(base_max_tokens=8192, budget=0, output_ceiling=0)
    assert res["budget"] == 0
    assert res["max_tokens"] == 8192


def test_thinking_allowance_additive_budget():
    # Budget must be added on top of base answer tokens
    res = thinking_allowance(base_max_tokens=8192, budget=8192, output_ceiling=0)
    assert res["max_tokens"] == 16384
    assert res["budget"] == 8192
    assert res["budget"] < res["max_tokens"]


def test_thinking_allowance_ceiling_clamp():
    # When base + budget > ceiling, clamp to ceiling and keep answer room first
    res = thinking_allowance(base_max_tokens=8192, budget=24576, output_ceiling=20000)
    assert res["max_tokens"] == 20000
    # Answer room preserved, remaining allocated to thinking
    assert res["budget"] <= 20000 - 1024
    assert res["budget"] >= 1024
    assert res["budget"] < res["max_tokens"]


def test_thinking_allowance_insufficient_room_disables_thinking():
    # If ceiling cannot accommodate even min thinking tokens (1024), disable thinking
    res = thinking_allowance(base_max_tokens=8192, budget=8192, output_ceiling=1500)
    assert res["budget"] == 0
    assert res["max_tokens"] == 1500


# ---------------------------------------------------------------------------
# 3. Scene Effort Tests
# ---------------------------------------------------------------------------

def test_scene_effort_mappings():
    assert scene_effort(SCENE_COMMIT_MESSAGE) == EFFORT_OFF
    assert scene_effort(SCENE_MEMORY_EXTRACT) == EFFORT_OFF
    assert scene_effort(SCENE_FOLD_SUMMARY) == EFFORT_OFF
    assert scene_effort(SCENE_AUTO_RESOLVE) == EFFORT_LOW
    assert scene_effort(SCENE_GOAL_VERDICT) == EFFORT_LOW
    assert scene_effort("unregistered_scene") == EFFORT_UNSET


# ---------------------------------------------------------------------------
# 4. Declarative body_plan Matrix: OpenAI Reasoning Era
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("model_id", ["o3", "o1-mini", "gpt-5"])
def test_reasoning_era_models_set_max_completion_tokens_and_unset_conflicts(model_id):
    plan = body_plan(model_id, kind="openai-compatible", effort="high", base_max_tokens=4096)
    s = plan["set"]
    u = plan["unset"]

    assert s.get("max_completion_tokens") == 4096
    assert "max_tokens" in u
    assert "temperature" in u
    assert "top_p" in u
    assert s.get("reasoning_effort") == "high"


def test_gpt5_off_emits_minimal():
    plan = body_plan("gpt-5", kind="openai-compatible", effort="off", base_max_tokens=4096)
    assert plan["set"].get("reasoning_effort") == "minimal"


def test_o3_off_floors_at_low():
    # OpenAI o-series does not accept 'off' or 'minimal'; floors safely at 'low'
    plan = body_plan("o3", kind="openai-compatible", effort="off", base_max_tokens=4096)
    assert plan["set"].get("reasoning_effort") == "low"


def test_reasoning_era_invalid_effort_does_not_emit_reasoning_effort():
    plan = body_plan("o3", kind="openai-compatible", effort="xhigh", base_max_tokens=4096)
    assert "reasoning_effort" not in plan["set"]


# ---------------------------------------------------------------------------
# 5. Declarative body_plan Matrix: Anthropic Extended Thinking
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("effort,expected_budget", [
    ("low", 2048),
    ("high", 8192),
    ("max", 24576),
])
def test_anthropic_thinking_enables_budget_and_unsets_sampling_knobs(effort, expected_budget):
    plan = body_plan("claude-sonnet-4-20250514", kind="anthropic", effort=effort, base_max_tokens=8192)
    s = plan["set"]
    u = plan["unset"]

    assert "thinking" in s
    th = s["thinking"]
    assert th["type"] == "enabled"
    assert th["budget_tokens"] == expected_budget
    # budget_tokens must be strictly less than max_tokens
    assert th["budget_tokens"] < s["max_tokens"]
    # Thinking replaces sampling
    assert "temperature" in u
    assert "top_p" in u
    assert "top_k" in u


def test_anthropic_thinking_off_emits_no_thinking_block():
    plan = body_plan("claude-sonnet-4-20250514", kind="anthropic", effort="off", base_max_tokens=8192)
    assert "thinking" not in plan["set"]
    assert "temperature" not in plan["unset"]


# ---------------------------------------------------------------------------
# 6. Non-Reasoning Models
# ---------------------------------------------------------------------------

def test_non_reasoning_models_emit_no_effort():
    plan = body_plan("gpt-4o", kind="openai-compatible", effort="high", base_max_tokens=4096)
    assert "reasoning_effort" not in plan["set"]
    assert "thinking" not in plan["set"]
    assert "max_tokens" not in plan["unset"]
    assert "temperature" not in plan["unset"]


def test_declared_override():
    # User override declared=False forces silence even for known reasoning models
    plan_off = body_plan("o3", kind="openai-compatible", effort="high", base_max_tokens=4096, effort_declared=False)
    assert "reasoning_effort" not in plan_off["set"]

    # User override declared=True forces dialect resolution
    plan_on = body_plan("custom-reasoner", kind="openai-compatible", effort="high", base_max_tokens=4096, effort_declared=True)
    assert plan_on["set"].get("reasoning_effort") == "high"


# ---------------------------------------------------------------------------
# 7. Google / Gemini Thinking Tests
# ---------------------------------------------------------------------------

def test_google_gemini_effort_style_and_support():
    assert effort_style("gemini-2.5-pro", kind="google") == EFFORT_STYLE_GOOGLE
    assert effort_style("gemini-2.5-flash", kind="gemini") == EFFORT_STYLE_GOOGLE
    assert effort_style("gemini-2.5-pro", kind="openai-compatible") == EFFORT_STYLE_GOOGLE
    assert supports_effort("gemini-2.5-pro", kind="google") is True


@pytest.mark.parametrize("effort,expected_budget,expected_level", [
    ("low", 2048, "LOW"),
    ("high", 8192, "HIGH"),
    ("max", 24576, "HIGH"),
])
def test_google_gemini_thinking_body_plan(effort, expected_budget, expected_level):
    plan = body_plan("gemini-2.5-pro", kind="google", effort=effort, base_max_tokens=8192)
    s = plan["set"]
    assert "thinkingConfig" in s
    tc = s["thinkingConfig"]
    assert tc.get("includeThoughts") is True
    assert tc.get("thinkingBudget") == expected_budget
    assert tc.get("thinkingLevel") == expected_level
    # Gemini 2.5 Pro has hard ceiling of 32768
    assert tc.get("thinkingBudget") <= 32768
    # reasoning_effort must be unset if present
    assert "reasoning_effort" in plan["unset"]


def test_google_gemini_thinking_off():
    plan = body_plan("gemini-2.5-pro", kind="google", effort="off", base_max_tokens=8192)
    assert plan["set"].get("thinkingConfig") == {"thinkingBudget": 0}


def test_google_gemini_budget_ceiling_clamped():
    # Even if an excessive budget were requested, it must strictly be <= 32768
    plan = body_plan("gemini-2.5-pro", kind="google", effort="max", base_max_tokens=8192, output_ceiling=10000)
    tc = plan["set"]["thinkingConfig"]
    assert tc["thinkingBudget"] <= 10000
    assert tc["thinkingBudget"] <= 32768


def test_build_thinking_capability_for_gemini():
    cap = build_thinking_capability("gemini-2.5-pro", "google")
    assert cap["thinking"]["state"] == "supported"
    assert cap["ui"]["showDial"] is True
    assert cap["control"]["wireFormat"] == EFFORT_STYLE_GOOGLE
    assert cap["control"]["parameter"] == "thinkingConfig"


# ---------------------------------------------------------------------------
# 8. Phase 2: Provider Dialects (DeepSeek, Qwen/GLM, Moonshot Kimi) Tests
# ---------------------------------------------------------------------------

def test_deepseek_effort_style_and_wire_format():
    assert effort_style("deepseek-reasoner", kind="openai-compatible") == EFFORT_STYLE_DEEPSEEK
    assert effort_style("deepseek-r1", kind="deepseek") == EFFORT_STYLE_DEEPSEEK

    # DeepSeek thinking on
    plan_on = body_plan("deepseek-reasoner", effort="high", base_max_tokens=4096)
    assert plan_on["set"].get("thinking") == {"type": "enabled"}
    assert "reasoning_effort" in plan_on["unset"]

    # DeepSeek thinking off
    plan_off = body_plan("deepseek-reasoner", effort="off", base_max_tokens=4096)
    assert plan_off["set"].get("thinking") == {"type": "disabled"}
    assert "reasoning_effort" in plan_off["unset"]


def test_qwen_effort_style_and_wire_format():
    assert effort_style("qwq-32b", kind="openai-compatible") == EFFORT_STYLE_QWEN
    assert effort_style("qwen-max-thinking", kind="qwen") == EFFORT_STYLE_QWEN

    # Qwen thinking on
    plan_on = body_plan("qwq-32b", effort="high", base_max_tokens=4096)
    assert plan_on["set"].get("enable_thinking") is True
    assert "reasoning_effort" in plan_on["unset"]

    # Qwen thinking off
    plan_off = body_plan("qwq-32b", effort="off", base_max_tokens=4096)
    assert plan_off["set"].get("enable_thinking") is False
    assert "reasoning_effort" in plan_off["unset"]


def test_kimi_temperature_policies():
    # Kimi k2.5 / k2.6 locks temperature to 1.0
    plan_k2 = body_plan("kimi-k2.5", base_max_tokens=4096)
    assert plan_k2["set"].get("temperature") == 1.0

    plan_k26 = body_plan("moonshot-v1-k2.6", base_max_tokens=4096)
    assert plan_k26["set"].get("temperature") == 1.0

    # Kimi k3 strips temperature and top_p
    plan_k3 = body_plan("kimi-k3", base_max_tokens=4096)
    assert "temperature" in plan_k3["unset"]
    assert "top_p" in plan_k3["unset"]
    assert "temperature" not in plan_k3["set"]


def test_llm_client_reasoning_content_backfill():
    from llm_client import LLMClient
    client = LLMClient({"model": {"model_id": "deepseek-reasoner", "api_key": "dummy"}})
    msgs = [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "world"},
        {"role": "user", "content": "how are you?"},
    ]
    client._backfill_reasoning_content(msgs)
    # Assistant turn must have empty string reasoning_content added
    assert msgs[1].get("reasoning_content") == ""
    # Existing reasoning_content is preserved for reasoning models
    msgs2 = [
        {"role": "assistant", "content": "world", "reasoning_content": "thought"},
    ]
    client._backfill_reasoning_content(msgs2)
    assert msgs2[0].get("reasoning_content") == "thought"

    # Switching to a standard non-reasoning client strips reasoning_content
    client_standard = LLMClient({"model": {"model_id": "gpt-4o", "api_key": "dummy"}})
    msgs3 = [
        {"role": "assistant", "content": "world", "reasoning_content": "thought"},
    ]
    client_standard._backfill_reasoning_content(msgs3)
    assert "reasoning_content" not in msgs3[0]


# ---------------------------------------------------------------------------
# 9. Phase 3: Model Capability Profiles & Truth-in-Dial Governance Tests
# ---------------------------------------------------------------------------

def test_model_profile_lookup():
    prof_o3 = lookup_model_profile("o3")
    assert prof_o3 is not None
    assert prof_o3.family == "openai"
    assert prof_o3.can_disable_thinking is False
    assert prof_o3.supported_levels == (EFFORT_LOW, EFFORT_HIGH, EFFORT_MAX)

    prof_ds = lookup_model_profile("deepseek-reasoner")
    assert prof_ds is not None
    assert prof_ds.family == "deepseek"
    assert prof_ds.can_disable_thinking is True
    assert prof_ds.supported_levels == (EFFORT_OFF, EFFORT_HIGH)

    prof_gemini = lookup_model_profile("gemini-2.5-pro")
    assert prof_gemini is not None
    assert prof_gemini.budget_range == (1024, 32768)


def test_truth_in_dial_variants_for_o_series():
    # o3 cannot disable thinking: "off" MUST be stripped from UI variants
    cap = build_thinking_capability("o3")
    assert cap["thinking"]["canDisable"] is False
    assert "off" not in cap["ui"]["variants"]
    assert cap["ui"]["variants"] == ["low", "high", "max"]
    assert cap["control"]["values"] == ["low", "high", "max"]


def test_binary_dial_for_deepseek_and_qwq():
    # Binary switch models only expose off and high
    cap_ds = build_thinking_capability("deepseek-reasoner")
    assert cap_ds["ui"]["variants"] == ["off", "high"]

    cap_qwq = build_thinking_capability("qwq-32b")
    assert cap_qwq["ui"]["variants"] == ["off", "high"]


def test_full_dial_for_claude_and_gemini():
    cap_claude = build_thinking_capability("claude-3-7-sonnet-20250219", "anthropic")
    assert cap_claude["thinking"]["canDisable"] is True
    assert cap_claude["ui"]["variants"] == ["off", "low", "high", "max"]

    cap_gemini = build_thinking_capability("gemini-2.5-pro", "google")
    assert cap_gemini["thinking"]["canDisable"] is True
    assert cap_gemini["ui"]["variants"] == ["off", "low", "high", "max"]



