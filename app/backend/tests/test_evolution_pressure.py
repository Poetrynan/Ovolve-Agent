"""Tests for context-pressure triggered self-evolution.

Based on community reference implementation for context pressure evolution triggers.
"""
import pytest
from unittest.mock import MagicMock, patch

from evolution import FailureKind
from evolution_bridge import notify_context_pressure
from evolution_pressure import should_trigger_pressure_evolution


def test_failure_kind_has_context_pressure():
    assert hasattr(FailureKind, "CONTEXT_PRESSURE")
    assert FailureKind.CONTEXT_PRESSURE == "context_pressure"
    assert FailureKind.CONTEXT_PRESSURE.value == "context_pressure"


def test_empty_messages_or_zero_budget_returns_false():
    # Empty messages -> False
    triggered, ratio = should_trigger_pressure_evolution([], max_context_tokens=8000)
    assert triggered is False
    assert ratio == 0.0

    # Zero budget -> False (fail-open)
    triggered, ratio = should_trigger_pressure_evolution(
        [{"role": "user", "content": "hello"}], max_context_tokens=0
    )
    assert triggered is False
    assert ratio == 0.0

    # Negative budget -> False
    triggered, ratio = should_trigger_pressure_evolution(
        [{"role": "user", "content": "hello"}], max_context_tokens=-500
    )
    assert triggered is False
    assert ratio == 0.0


def test_tokens_below_threshold_returns_false(monkeypatch):
    import context_compactor
    monkeypatch.setattr(context_compactor, "estimate_tokens_multi", lambda msgs: 5000)

    triggered, ratio = should_trigger_pressure_evolution(
        [{"role": "user", "content": "test"}],
        max_context_tokens=10000,
        threshold=0.8,
    )
    assert triggered is False
    assert ratio == 0.5


def test_tokens_above_threshold_triggers(monkeypatch):
    import context_compactor
    monkeypatch.setattr(context_compactor, "estimate_tokens_multi", lambda msgs: 8500)

    triggered, ratio = should_trigger_pressure_evolution(
        [{"role": "user", "content": "test"}],
        max_context_tokens=10000,
        threshold=0.8,
    )
    assert triggered is True
    assert ratio == 0.85


def test_notify_context_pressure_dispatches_signal(monkeypatch):
    mock_engine = MagicMock()
    mock_engine.enabled.return_value = True
    mock_engine.record.return_value = "sig-123"

    import evolution
    monkeypatch.setattr(evolution, "get_evolution_engine", lambda: mock_engine)

    sig_id = notify_context_pressure("sess-abc", "turn-7", 0.88)
    assert sig_id == "sig-123"
    mock_engine.record.assert_called_once()
    kwargs = mock_engine.record.call_args[1]
    assert kwargs.get("kind") == "context_pressure"
    assert kwargs.get("failure_kind") == "context_pressure"
    assert kwargs.get("session_id") == "sess-abc"
    assert "88.0%" in kwargs.get("detail", "")

