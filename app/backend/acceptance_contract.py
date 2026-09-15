"""
acceptance_contract.py — 版本化目标验收合同（Phase 3）。

总指令 §8.1：GoalBrief 回答"做什么"，AcceptanceContract 回答"做到什么程度
才算做完、由谁验证、哪些路径可碰、预算多少"。模型不能单独宣布完成——完成前
合同门必须全绿。

设计约束：
* 不破坏旧目标：没有合同的旧 goal 在首次读取时从 GoalBrief 派生回填（version 1）。
* 合同是数据不是代码：verification_plan 里只有 validator_registry 支持的类型，
  不存在"执行任意 Python 片段"的通道。
"""
from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, List, Sequence, Tuple

_CONTRACT_VERSION = 1

_BUDGET_DEFAULTS = {
    "max_iterations": 10,
    "max_tokens": 0,          # 0 = 不限
    "max_cost": 0.0,
    "max_wall_time_seconds": 0,
    "max_repair_attempts": 2,
}


def normalize_contract(raw: Any, goal_id: str) -> Dict[str, Any]:
    """把任何形态的输入收敛成一份合法合同。未知字段丢弃，缺省补齐。"""
    raw = raw if isinstance(raw, dict) else {}
    budget_in = raw.get("budget") if isinstance(raw.get("budget"), dict) else {}
    budget = dict(_BUDGET_DEFAULTS)
    for k in _BUDGET_DEFAULTS:
        try:
            v = budget_in.get(k)
            if v is not None:
                budget[k] = type(_BUDGET_DEFAULTS[k])(v)
        except (TypeError, ValueError):
            pass  # fail-open: 可选增强，失败不影响主流程
    return {
        "goal_id": str(goal_id),
        "version": int(raw.get("version") or _CONTRACT_VERSION),
        "summary": str(raw.get("summary") or ""),
        "assumptions": [str(a) for a in (raw.get("assumptions") or [])],
        "deliverables": [str(d) for d in (raw.get("deliverables") or [])],
        "acceptance_criteria": [str(c) for c in (raw.get("acceptance_criteria") or [])],
        # verification_plan 的条目交给 validator_registry 执行与校验
        "verification_plan": list(raw.get("verification_plan") or []),
        "required_artifacts": [str(a) for a in (raw.get("required_artifacts") or [])],
        "allowed_paths": [str(p) for p in (raw.get("allowed_paths") or [])],
        "forbidden_paths": [str(p) for p in (raw.get("forbidden_paths") or [])],
        "budget": budget,
        "out_of_scope": [str(o) for o in (raw.get("out_of_scope") or [])],
        "instrument_required": bool(raw.get("instrument_required", False)),
        "behavioral_instrument": raw.get("behavioral_instrument") if isinstance(raw.get("behavioral_instrument"), dict) else {},
        "human_acceptance_required": bool(raw.get("human_acceptance_required")),
        "human_accepted": bool(raw.get("human_accepted", False)),
        "human_accepted_at": raw.get("human_accepted_at"),
        "human_accepted_by": raw.get("human_accepted_by"),
    }


def check_anti_weakening(old_contract: Dict[str, Any] | None, new_contract: Dict[str, Any]) -> tuple[bool, str]:
    """防弱化门禁（Anti-Weakening Policy，Factory 启发）：
    
    严禁在执行中途单方面删除或弱化已确立的验收标准、衡具用例或交付物清单。
    """
    if not old_contract:
        return True, ""
    old_criteria = set(old_contract.get("acceptance_criteria") or [])
    new_criteria = set(new_contract.get("acceptance_criteria") or [])
    dropped_crit = old_criteria - new_criteria
    if dropped_crit:
        return False, f"禁止弱化合同：中途丢弃了既有验收标准: {list(dropped_crit)[:3]}"

    old_artifacts = set(old_contract.get("required_artifacts") or [])
    new_artifacts = set(new_contract.get("required_artifacts") or [])
    dropped_art = old_artifacts - new_artifacts
    if dropped_art:
        return False, f"禁止弱化合同：中途丢弃了既有必交付产物: {list(dropped_art)[:3]}"

    old_plan = old_contract.get("verification_plan") or []
    new_plan = new_contract.get("verification_plan") or []
    if len(new_plan) < len(old_plan):
        return False, f"禁止弱化合同：验证计划项减少 ({len(old_plan)} -> {len(new_plan)})"

    return True, ""



# ── 存取 ────────────────────────────────────────────────────────────────────

def get_goal_contract(storage, goal_id: str) -> Dict[str, Any] | None:
    """读目标合同；没有就从 GoalBrief 派生回填（旧目标升级路径）。"""
    row = storage.get_goal(goal_id) or {}
    raw = row.get("contract_json")
    if raw:
        try:
            return normalize_contract(json.loads(raw), goal_id)
        except (json.JSONDecodeError, TypeError):
            pass  # fail-open: 可选增强，失败不影响主流程
    # 回填：从既有 GoalBrief 派生，让老目标无感获得合同能力
    contract: Dict[str, Any] | None = None
    try:
        import goal_brief
        brief = goal_brief.build_brief_from_prompt(row.get("description") or "")
        contract = normalize_contract({
            "summary": row.get("description") or "",
            "deliverables": getattr(brief, "deliverables", None) or [],
        }, goal_id)
    except Exception:
        contract = normalize_contract({"summary": row.get("description") or ""}, goal_id)
    try:
        set_goal_contract(storage, goal_id, contract)
    except Exception:
        pass  # fail-open: 可选增强，失败不影响主流程
    return contract


def set_goal_contract(storage, goal_id: str, contract: Dict[str, Any]) -> bool:
    c = storage._db("goals")
    cur = c.execute(
        "UPDATE goals SET contract_json=?, updated_at=? WHERE id=?",
        (json.dumps(contract, ensure_ascii=False), int(time.time()), goal_id),
    )
    c.commit()
    return cur.rowcount > 0


# ── 完成门 ──────────────────────────────────────────────────────────────────

def check_completion(contract: Dict[str, Any], workspace: str,
                     *, run_plan_fn=None, touched_paths: Sequence[str] = ()) -> tuple[bool, List[str], list]:
    """§8.1 完成前置条件的机器与人工全闭环门禁。

    返回 (全部满足?, 未满足项描述, 验证器结果列表)。
    全闭环规则 (Fail-Closed):
    1. 人工确认门禁: 若声明了 human_acceptance_required 且未获得 human_accepted，阻止自动完成;
    2. 路径约束门禁: 检查 required_artifacts 与 touched_paths 是否命中 forbidden_paths 或脱离 allowed_paths;
    3. 交付物存在性检查: required_artifacts 必须真实落地;
    4. 验证计划执行: verification_plan 必须全绿。
    """
    unmet: List[str] = []
    try:
        # 1. 人工确认门禁
        if bool(contract.get("human_acceptance_required")) and not bool(contract.get("human_accepted")):
            unmet.append("human_acceptance_required: 需要用户显式审批确认，不可自动标记完成")

        base = os.path.realpath(workspace or ".")
        allowed = [str(p).strip() for p in (contract.get("allowed_paths") or []) if str(p).strip()]
        forbidden = [str(p).strip() for p in (contract.get("forbidden_paths") or []) if str(p).strip()]

        # 2. 交付物与路径合规检查
        all_paths_to_check = list(contract.get("required_artifacts") or []) + list(touched_paths or [])
        for art in contract.get("required_artifacts") or []:
            rel = str(art)
            target = os.path.realpath(os.path.join(base, rel))
            if not (target == base or target.startswith(base + os.sep)):
                unmet.append(f"artifact path escapes workspace: {rel}")
            elif not os.path.isfile(target):
                unmet.append(f"missing artifact: {rel}")

        for p_str in all_paths_to_check:
            p_rel = str(p_str).replace("\\", "/")
            if any(p_rel.startswith(f.replace("\\", "/")) for f in forbidden):
                unmet.append(f"forbidden path accessed: {p_rel}")
            if allowed and not any(p_rel.startswith(a.replace("\\", "/")) for a in allowed):
                unmet.append(f"path violation (not in allowed_paths): {p_rel}")

        # 3. 验证计划与前置衡具检查
        plan = list(contract.get("verification_plan") or [])
        if bool(contract.get("instrument_required")):
            has_instrument = any(
                str((p or {}).get("type")).lower() in ("instrument", "differential", "diff")
                for p in plan
            ) or bool(contract.get("behavioral_instrument"))
            if not has_instrument:
                unmet.append("Phase 0 衡具门禁未满足: instrument_required 已声明，但尚未构建有效的行为衡具 (Instrument)")

        results: list = []
        all_validators_passed = True
        if plan:
            if run_plan_fn is None:
                from validator_registry import run_verification_plan as run_plan_fn
            results, all_validators_passed = run_plan_fn(plan, workspace)
            for r in results:
                if r["status"] not in ("passed", "skipped"):
                    unmet.append(f"{r['validator_id']}: {r['status']} "
                                 f"({'; '.join(r['evidence'])[:120]})")


        return (not unmet), unmet, results
    except Exception as exc:
        return False, [f"acceptance contract verification error (fail-closed): {exc}"], []


def approve_goal_contract(storage, goal_id: str, user_id: str = "user") -> bool:
    """用户显式审批通过目标的 AcceptanceContract。"""
    contract = get_goal_contract(storage, goal_id)
    if not contract:
        return False
    contract["human_accepted"] = True
    contract["human_accepted_at"] = time.time()
    contract["human_accepted_by"] = str(user_id or "user")
    return set_goal_contract(storage, goal_id, contract)
