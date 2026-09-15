"""
orchestration_advisory.py — six-criteria scoring for sub-agent batches.

What this does
--------------
After a ``spawn_batch`` (or DAG run) finishes, the parent agent receives a
merged text blob. That blob tells the parent WHAT happened but not whether
the batch was well-orchestrated. This module scores the batch on six
deterministic criteria and produces:

  * a per-criterion score (0..1)
  * an overall orchestration score (mean of the six)
  * a ``parent_note`` — a short, factual sentence the parent can read to
    decide whether to retry, re-plan, or accept.

Design discipline: **advisory only**. This module never blocks, never rejects,
never writes to the database. It is a pure function of the batch results —
callers decide what to do with the score. A score that can't be computed
(e.g. no token data) is reported as ``None``, never faked.

The six criteria
----------------
  1. success_rate      — fraction of sub-agents that returned ok=True
  2. contract_pass_rate — fraction that passed ResultContract enforcement
  3. parallelism_util  — how much of the concurrency cap was actually used
  4. cost_efficiency   — results returned per unit cost (tokens)
  5. lease_health      — 1.0 if no lease contention recorded, lower if blocked
  6. result_quality    — presence of final_marker + non-trivial output length
"""
from __future__ import annotations

import dataclasses
from typing import List, Optional


@dataclasses.dataclass
class Advisory:
    """The advisory output for one batch run.

    Attributes:
        scores: per-criterion score (0..1) or None if not computable.
        overall: mean of non-None criterion scores, or None if none computable.
        parent_note: one-sentence summary for the parent agent.
        details: per-criterion human-readable breakdown.
    """
    scores: dict[str, Optional[float]]
    overall: Optional[float]
    parent_note: str
    details: dict[str, str]


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, float(x)))


def _frac(numer: int, denom: int) -> Optional[float]:
    """Safe fraction: None when denominator is 0 (not computable)."""
    if denom <= 0:
        return None
    return _clamp01(numer / denom)


def assess_batch(results: list[dict]) -> Advisory:
    """Score a batch of sub-agent results on six criteria.

    Args:
        results: list of dicts as returned by ``SubagentRuntime.spawn_batch``
            (keys: ok, type, label, text, error, subagent_id, stale,
            final_marker, mergeNote, status, blockedReason).

    Returns:
        An ``Advisory`` with per-criterion scores, overall score, and a
        parent-facing note.
    """
    n = len(results)
    if n == 0:
        return Advisory(
            scores={k: None for k in _CRITERIA},
            overall=None,
            parent_note="No sub-agents were dispatched.",
            details={k: "no data" for k in _CRITERIA},
        )

    # ── 1. success_rate ─────────────────────────────────────────────────
    ok_count = sum(1 for r in results if r.get("ok") is True)
    success_rate = _frac(ok_count, n)

    # ── 2. contract_pass_rate ──────────────────────────────────────────
    # A result "passed contract" if it is ok AND was not later flipped to
    # rejected by enforce_contracts. Since enforce_contracts mutates results
    # in place (flips ok=False on rejection), we infer pass rate from the
    # final ok state + absence of "result contract rejected" in error.
    contract_passes = sum(
        1 for r in results
        if r.get("ok") is True and "result contract rejected" not in str(r.get("error", ""))
    )
    # Also count results that were explicitly rejected (ok=False with contract error).
    rejected_by_contract = sum(
        1 for r in results
        if r.get("ok") is False and "result contract rejected" in str(r.get("error", ""))
    )
    contract_pass_rate = _frac(contract_passes, contract_passes + rejected_by_contract)

    # ── 3. parallelism_util ────────────────────────────────────────────
    # How many ran truly in parallel vs sequentially. We approximate by
    # counting results that started within a small time window. Without
    # timing data, we fall back to: if all succeeded, assume full parallelism.
    started_at = [r.get("startedAt", 0) or 0 for r in results]
    if any(t > 0 for t in started_at):
        min_t = min(t for t in started_at if t > 0)
        max_t = max(t for t in started_at if t > 0)
        # If all started within 2s of each other → full parallelism.
        span = max_t - min_t
        parallelism_util = 1.0 if span <= 2.0 else _clamp01(1.0 - (span / 30.0))
    else:
        # No timing data: assume full parallelism if all ok.
        parallelism_util = 1.0 if ok_count == n else 0.5

    # ── 4. cost_efficiency ─────────────────────────────────────────────
    # Results per 10k tokens of total output. Rewards batches that return
    # useful results without burning excessive tokens.
    total_chars = sum(len(str(r.get("text", "") or "")) for r in results)
    # Rough token estimate: 1 token ≈ 4 chars (English) to 2 chars (CJK).
    # Use a conservative 3 chars/token.
    est_tokens = total_chars / 3.0
    if est_tokens > 0:
        # Normalize: 1 result per 2000 tokens = perfect (1.0).
        cost_efficiency = _clamp01(ok_count / (est_tokens / 2000.0))
    else:
        cost_efficiency = None

    # ── 5. lease_health ────────────────────────────────────────────────
    # Count results that were blocked due to lease contention.
    blocked = sum(
        1 for r in results
        if r.get("status") == "blocked" or "租约" in str(r.get("blockedReason", ""))
        or "lease" in str(r.get("blockedReason", "")).lower()
    )
    lease_health = _frac(n - blocked, n)

    # ── 6. result_quality ──────────────────────────────────────────────
    # Rewards: final_marker emitted (sub-agent declared done) + non-trivial output.
    marked_done = sum(1 for r in results if r.get("final_marker") is True)
    has_output = sum(1 for r in results if len(str(r.get("text", "") or "").strip()) > 20)
    # Average of the two sub-metrics.
    m1 = _frac(marked_done, n)
    m2 = _frac(has_output, n)
    if m1 is not None and m2 is not None:
        result_quality = (m1 + m2) / 2.0
    elif m1 is not None:
        result_quality = m1
    elif m2 is not None:
        result_quality = m2
    else:
        result_quality = None

    # ── aggregate ───────────────────────────────────────────────────────
    scores = {
        "success_rate": success_rate,
        "contract_pass_rate": contract_pass_rate,
        "parallelism_util": parallelism_util,
        "cost_efficiency": cost_efficiency,
        "lease_health": lease_health,
        "result_quality": result_quality,
    }
    present = [v for v in scores.values() if v is not None]
    overall = round(sum(present) / len(present), 3) if present else None

    # ── details ────────────────────────────────────────────────────────
    details = {
        "success_rate": f"{ok_count}/{n} succeeded",
        "contract_pass_rate": (
            f"{contract_passes} passed, {rejected_by_contract} rejected by contract"
            if (contract_passes + rejected_by_contract) > 0
            else "no contract data"
        ),
        "parallelism_util": f"parallelism utilization: {parallelism_util:.0%}",
        "cost_efficiency": (
            f"~{int(est_tokens)} tokens for {ok_count} results"
            if cost_efficiency is not None
            else "no output data"
        ),
        "lease_health": f"{blocked} blocked by lease contention",
        "result_quality": (
            f"{marked_done} declared done, {has_output} have substantive output"
        ),
    }

    parent_note = _compose_note(scores, overall, ok_count, n, blocked)

    return Advisory(
        scores=scores,
        overall=overall,
        parent_note=parent_note,
        details=details,
    )


_CRITERIA = [
    "success_rate",
    "contract_pass_rate",
    "parallelism_util",
    "cost_efficiency",
    "lease_health",
    "result_quality",
]


def _compose_note(
    scores: dict[str, Optional[float]],
    overall: Optional[float],
    ok_count: int,
    total: int,
    blocked: int,
) -> str:
    """One factual sentence for the parent agent."""
    if total == 0:
        return "No sub-agents were dispatched."

    parts = [f"{total} 个子代理中 {ok_count} 个成功"]

    if blocked > 0:
        parts.append(f"{blocked} 个因租约冲突被阻塞")

    if overall is not None:
        if overall >= 0.85:
            parts.append("整体协调优秀")
        elif overall >= 0.6:
            parts.append("整体协调良好")
        elif overall >= 0.4:
            parts.append("协调一般，建议检查失败项")
        else:
            parts.append("协调较差，建议重试或重新规划")

    # Flag the weakest criterion (if any is below 0.5).
    weak = [(k, v) for k, v in scores.items() if v is not None and v < 0.5]
    if weak:
        weakest = min(weak, key=lambda kv: kv[1])
        parts.append(f"最弱项: {_CRITERIA_CN[weakest[0]]} ({weakest[1]:.0%})")

    return "；".join(parts) + "。"


_CRITERIA_CN = {
    "success_rate": "成功率",
    "contract_pass_rate": "契约通过率",
    "parallelism_util": "并行利用率",
    "cost_efficiency": "成本效率",
    "lease_health": "租约健康度",
    "result_quality": "结果质量",
}
