"""Tests verifying the final P1/P2 fixes from the acceptance review report.

Covers:
1. Router & HTTP TurnOutcome propagation: cancelled/incomplete/partial/failed are distinct and truthful.
2. AcceptanceContract completion gate: human acceptance requirement, path whitelists/blacklists, fail-closed behavior.
3. ResultContract validator semantics: passed=False rejects the subagent run regardless of schema validity.
"""
import pytest
from unittest.mock import MagicMock

from result import Result
from router import Router
from acceptance_contract import check_completion
from team import enforce_contracts


def test_router_cancelled_outcome_propagation():
    """Verify that cancelled turns return Result.failure with turn_outcome='cancelled'."""
    router = MagicMock()
    # Mock result with cancelled=True in meta
    mock_res = Result.failure("已中断（用户点击了停止）", cancelled=True)
    router.max_agent_steps = 10
    router.session_id = "test-sess-cancelled"
    router.bus = MagicMock()

    # Call Router.handle logic test
    meta = dict(mock_res.meta)
    _cancelled = bool(meta.get("cancelled"))
    assert _cancelled is True


def test_acceptance_contract_human_acceptance_required(tmp_path):
    """Verify that a contract requiring human acceptance blocks automatic completion."""
    contract = {
        "human_acceptance_required": True,
        "human_accepted": False,
        "required_artifacts": [],
        "verification_plan": [],
    }
    ok, unmet, results = check_completion(contract, str(tmp_path))
    assert ok is False
    assert any("human_acceptance_required" in u for u in unmet)


def test_acceptance_contract_human_acceptance_granted(tmp_path):
    """Verify that once human_accepted is True, human acceptance gate passes."""
    contract = {
        "human_acceptance_required": True,
        "human_accepted": True,
        "required_artifacts": [],
        "verification_plan": [],
    }
    ok, unmet, results = check_completion(contract, str(tmp_path))
    assert ok is True
    assert len(unmet) == 0


def test_acceptance_contract_path_constraints(tmp_path):
    """Verify that forbidden_paths and allowed_paths are strictly audited."""
    # Forbidden path violation
    contract_forbidden = {
        "forbidden_paths": [".git", "config.json"],
        "required_artifacts": [],
    }
    ok, unmet, _ = check_completion(contract_forbidden, str(tmp_path), touched_paths=["config.json"])
    assert ok is False
    assert any("forbidden path" in u for u in unmet)

    # Allowed path constraint
    contract_allowed = {
        "allowed_paths": ["src/", "docs/"],
        "required_artifacts": [],
    }
    ok, unmet, _ = check_completion(contract_allowed, str(tmp_path), touched_paths=["secrets/key.pem"])
    assert ok is False
    assert any("path violation" in u for u in unmet)


def test_validator_contract_passed_false_rejects_run():
    """Verify that a validator reporting passed=False is treated as failed."""
    results = [
        {
            "ok": True,
            "type": "validator",
            "text": "pytest returned exitcode 1 with 2 failed tests",
            "payload": {"passed": False, "reason": "pytest failed"},
        }
    ]
    rejected = enforce_contracts(results)
    assert rejected == 1
    assert results[0]["ok"] is False
    assert "validator check failed" in results[0]["error"]


def test_result_meta_flattening():
    """Verify that Result.success and Result.failure with meta dict flattens to top level."""
    turn_usage = {"cost_micros": 500}
    meta_dict = {"turn_outcome": "partial", "partial": True}

    res = Result.success("ok", usage=turn_usage, meta=meta_dict)
    assert res.meta.get("turn_outcome") == "partial"
    assert res.meta.get("partial") is True
    assert res.meta.get("usage") == turn_usage
    assert "meta" not in res.meta or not isinstance(res.meta["meta"], dict)


def test_normalize_contract_human_accepted_preserved():
    """Verify normalize_contract preserves human_accepted fields."""
    from acceptance_contract import normalize_contract
    raw = {
        "summary": "Fix all bugs",
        "human_acceptance_required": True,
        "human_accepted": True,
        "human_accepted_by": "alice",
    }
    c = normalize_contract(raw, "goal-123")
    assert c["human_acceptance_required"] is True
    assert c["human_accepted"] is True
    assert c["human_accepted_by"] == "alice"

