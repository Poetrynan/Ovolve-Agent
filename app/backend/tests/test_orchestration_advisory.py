"""Unit tests for orchestration_advisory.py (A3).

Covers all six scoring criteria plus edge cases (empty batch, all-fail,
perfect batch, lease-blocked batch).
"""
from __future__ import annotations

import pytest

from orchestration_advisory import assess_batch


# ── helpers ──────────────────────────────────────────────────────────────────

def _ok_result(rid="r1", rtype="explore", text="findings here", **kw) -> dict:
    """A minimal ok result dict."""
    return {
        "ok": True, "type": rtype, "label": rid, "text": text,
        "error": "", "subagent_id": rid, "stale": False,
        "final_marker": True, "status": "completed",
        **kw,
    }


def _fail_result(rid="r1", error="boom", **kw) -> dict:
    return {
        "ok": False, "type": "explore", "label": rid, "text": "",
        "error": error, "subagent_id": rid, "stale": False,
        "final_marker": False, "status": "error",
        **kw,
    }


# ── tests ────────────────────────────────────────────────────────────────────

def test_empty_batch():
    adv = assess_batch([])
    assert adv.overall is None
    assert all(v is None for v in adv.scores.values())
    assert "No sub-agents" in adv.parent_note


def test_all_succeed_perfect_score():
    results = [_ok_result(f"r{i}") for i in range(5)]
    adv = assess_batch(results)

    assert adv.scores["success_rate"] == 1.0
    assert adv.scores["contract_pass_rate"] == 1.0
    assert adv.scores["lease_health"] == 1.0
    assert adv.overall is not None
    assert adv.overall >= 0.8
    assert "5 个子代理中 5 个成功" in adv.parent_note


def test_partial_success():
    results = [
        _ok_result("r1"),
        _ok_result("r2"),
        _fail_result("r3"),
    ]
    adv = assess_batch(results)

    assert adv.scores["success_rate"] == pytest.approx(2 / 3)
    assert adv.overall is not None
    assert 0.3 < adv.overall < 0.9
    assert "3 个子代理中 2 个成功" in adv.parent_note


def test_all_fail():
    results = [_fail_result(f"r{i}") for i in range(3)]
    adv = assess_batch(results)

    assert adv.scores["success_rate"] == 0.0
    assert adv.overall is not None
    assert adv.overall < 0.5
    assert "协调较差" in adv.parent_note or "0 个成功" in adv.parent_note


def test_contract_rejection_lowers_contract_pass_rate():
    """Results rejected by enforce_contracts drag down contract_pass_rate."""
    results = [
        _ok_result("r1"),
        _fail_result("r2", error="result contract rejected: missing key: summary"),
        _fail_result("r3", error="result contract rejected: key passed: expected bool, got str"),
    ]
    adv = assess_batch(results)

    # contract_pass_rate = 1 passed / (1 passed + 2 rejected) ≈ 0.333
    assert adv.scores["contract_pass_rate"] is not None
    assert adv.scores["contract_pass_rate"] < 0.5


def test_lease_blocked_lowers_lease_health():
    results = [
        _ok_result("r1"),
        _ok_result("r2"),
        _fail_result("r3", error="blocked", status="blocked",
                     blockedReason="任务 't3' 的执行租约被其他运行持有，本轮跳过"),
    ]
    adv = assess_batch(results)

    assert adv.scores["lease_health"] == pytest.approx(2 / 3)


def test_result_quality_with_short_output():
    """Results with very short text lower result_quality."""
    results = [
        _ok_result("r1", text="ok"),  # < 20 chars
        _ok_result("r2", text="done"),  # < 20 chars
    ]
    adv = assess_batch(results)

    # has_output = 0/2 = 0; final_marker = 2/2 = 1; quality = 0.5
    assert adv.scores["result_quality"] == pytest.approx(0.5)


def test_result_quality_full():
    results = [
        _ok_result("r1", text="A substantive finding " * 10, final_marker=True),
        _ok_result("r2", text="Another detailed result " * 10, final_marker=True),
    ]
    adv = assess_batch(results)
    assert adv.scores["result_quality"] == 1.0


def test_parallelism_util_with_timing():
    """Results starting within 2s get full parallelism credit."""
    import time
    now = time.time()
    results = [
        _ok_result("r1", startedAt=now),
        _ok_result("r2", startedAt=now + 0.5),
        _ok_result("r3", startedAt=now + 1.0),
    ]
    adv = assess_batch(results)
    assert adv.scores["parallelism_util"] == 1.0


def test_parallelism_util_staggered():
    """Results starting far apart get lower parallelism credit."""
    import time
    now = time.time()
    results = [
        _ok_result("r1", startedAt=now),
        _ok_result("r2", startedAt=now + 15),
    ]
    adv = assess_batch(results)
    assert adv.scores["parallelism_util"] < 1.0


def test_cost_efficiency_reasonable():
    """A batch with moderate output has a computable cost_efficiency."""
    results = [_ok_result(f"r{i}", text="x" * 3000) for i in range(3)]
    adv = assess_batch(results)
    assert adv.scores["cost_efficiency"] is not None
    assert 0.0 <= adv.scores["cost_efficiency"] <= 1.0


def test_details_populated():
    """Every criterion has a human-readable detail string."""
    results = [_ok_result("r1"), _fail_result("r2")]
    adv = assess_batch(results)
    for key in ["success_rate", "contract_pass_rate", "parallelism_util",
                "cost_efficiency", "lease_health", "result_quality"]:
        assert key in adv.details
        assert len(adv.details[key]) > 0


def test_weakest_criterion_flagged():
    """当某维度低于 50% 时，parent note 点名最弱的那一项。

    语义更新（六维评分版）：note 只点名"低于 0.5 的维度中最弱的一个"。
    本场景 1 成功 + 3 个契约拒收 → success_rate = contract_pass_rate = 0.25
    （两者恒等值，契约通过率不可能成为唯一最弱项），而 result_quality =
    (marked_done 1/4 + has_output 0/4)/2 = 0.125 严格最低 → 点名"结果质量"。
    契约拒收的拖累另行用分数断言钉住。
    """
    results = [
        _ok_result("r1"),
        _fail_result("r2", error="result contract rejected: missing key"),
        _fail_result("r3", error="result contract rejected: missing key"),
        _fail_result("r4", error="result contract rejected: missing key"),
    ]
    adv = assess_batch(results)
    assert adv.scores["contract_pass_rate"] == pytest.approx(0.25)
    assert adv.scores["result_quality"] == pytest.approx(0.125)
    assert "最弱项" in adv.parent_note
    assert "结果质量" in adv.parent_note
