"""Tests for unified thinking capability resolution."""
from model_registry import (
    build_thinking_capability,
    EFFORT_STYLE_OPENAI,
)


def test_longcat_heuristic_supported():
    cap = build_thinking_capability("LongCat-2.0", "openai-compatible")
    assert cap["thinking"]["state"] == "supported"
    assert cap["ui"]["showDial"] is True
    assert cap["control"]["wireFormat"] == EFFORT_STYLE_OPENAI
    assert "max" in cap["ui"]["variants"]


def test_user_override_blocks_dial():
    cap = build_thinking_capability("LongCat-2.0", "openai-compatible", declared=False)
    assert cap["thinking"]["state"] == "unsupported"
    assert cap["ui"]["showDial"] is False


def test_catalog_profile_beats_heuristic():
    cap = build_thinking_capability(
        "custom-weird-name",
        "openai-compatible",
        declared=True,
        catalog_reasoning=True,
    )
    assert cap["thinking"]["source"] == "user_override"
    assert cap["ui"]["showDial"] is True
