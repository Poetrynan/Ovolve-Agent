"""Phase 3 切片：AcceptanceContract + Validator Registry。

最小验证预算：合同回填与持久化、完成门的交付物/验证计划判定、
注册表的 file/schema/human 验证器。
"""
import json
import os
import tempfile
from pathlib import Path

from acceptance_contract import (
    check_completion, get_goal_contract, normalize_contract, set_goal_contract,
)
from storage import Storage
from validator_registry import run_verification_plan


def make_storage_with_goal(base_dir, gid="goal-p3"):
    db_dir = os.path.join(base_dir, "db")
    st = Storage(db_dir=db_dir)
    gc = st._db("goals")
    gc.execute(
        "INSERT INTO goals (id, description, status, session_id, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?)",
        (gid, "发布新版本", "running", "sess-p3", 1, 1),
    )
    gc.commit()
    return st


# ── 合同：旧目标回填 + 自定义持久化 ────────────────────────────────────────

def test_contract_backfill_and_roundtrip():
    with tempfile.TemporaryDirectory() as td:
        st = make_storage_with_goal(td)
        try:
            # 旧目标没有合同 → 首次读取从 GoalBrief 派生回填（version 1）
            c1 = get_goal_contract(st, "goal-p3")
            assert c1 is not None and c1["version"] == 1
            assert c1["goal_id"] == "goal-p3"
            assert "max_repair_attempts" in c1["budget"]

            # 自定义合同落库再读，字段不丢
            custom = normalize_contract({
                "summary": "发布",
                "required_artifacts": ["CHANGELOG.md"],
                "verification_plan": [{"type": "file", "path": "CHANGELOG.md",
                                       "contains": "v2"}],
                "budget": {"max_repair_attempts": 5, "max_iterations": 6},
                "human_acceptance_required": True,
            }, "goal-p3")
            assert set_goal_contract(st, "goal-p3", custom) is True
            c2 = get_goal_contract(st, "goal-p3")
            assert c2["budget"]["max_repair_attempts"] == 5
            assert c2["budget"]["max_iterations"] == 6
            assert c2["human_acceptance_required"] is True
            assert c2["verification_plan"][0]["type"] == "file"
        finally:
            st.close()


# ── 完成门：交付物缺失拦下，补齐放行；未知验证类型记 error 不静默 ────────────

def test_check_completion_gates_artifacts_and_plan():
    with tempfile.TemporaryDirectory() as td:
        st = make_storage_with_goal(td)
        ws = os.path.join(td, "ws")
        os.makedirs(ws, exist_ok=True)
        try:
            contract = normalize_contract({
                "required_artifacts": ["CHANGELOG.md"],
                "verification_plan": [
                    {"type": "file", "path": "CHANGELOG.md", "contains": "v2"},
                    {"type": "schema", "file": "pkg.json",
                     "required_keys": ["name", "version"]},
                ],
            }, "goal-p3")

            ok, unmet, results = check_completion(contract, ws)
            assert not ok
            assert any("missing artifact" in u for u in unmet)
            assert any(r["status"] == "failed" and r["validator_id"].startswith("file.")
                       for r in results)

            with open(os.path.join(ws, "CHANGELOG.md"), "w", encoding="utf-8") as f:
                f.write("# v2.0 release notes\n")
            with open(os.path.join(ws, "pkg.json"), "w", encoding="utf-8") as f:
                json.dump({"name": "x", "version": "2.0"}, f)

            ok2, unmet2, results2 = check_completion(contract, ws)
            assert ok2, unmet2
            assert all(r["status"] == "passed" for r in results2)

            # 路径逃逸：合同里的交付物指向 workspace 外 → 判不满足，不是崩溃
            evil = normalize_contract({"required_artifacts": ["../secrets.txt"]}, "goal-p3")
            ok3, unmet3, _ = check_completion(evil, ws)
            assert not ok3 and any("escapes workspace" in u for u in unmet3)

            # 未知验证类型 → error 计入未满足，绝不静默当通过
            weird = normalize_contract(
                {"verification_plan": [{"type": "vibes", "path": "x"}]}, "goal-p3")
            ok4, unmet4, results4 = check_completion(weird, ws)
            assert not ok4 and any(r["status"] == "error" for r in results4)
        finally:
            st.close()


# ── 注册表：hash/contains/required_keys/human ──────────────────────────────

def test_validator_registry_behaviors():
    with tempfile.TemporaryDirectory() as td:
        ws = os.path.join(td, "ws")
        os.makedirs(ws, exist_ok=True)
        with open(os.path.join(ws, "a.txt"), "w", encoding="utf-8") as f:
            f.write("hello world")
        with open(os.path.join(ws, "cfg.json"), "w", encoding="utf-8") as f:
            f.write('{"name": "n"}')

        results, all_ok = run_verification_plan([
            {"type": "file", "path": "a.txt", "contains": "world"},
            {"type": "schema", "file": "cfg.json", "required_keys": ["name"]},
            {"type": "human"},
            # hash 不匹配 → failed
            {"type": "file", "path": "a.txt", "sha256": "0" * 64},
        ], ws)
        # 前两个 file 条目共用 id（同路径不同检查），按位置断言
        assert results[0]["status"] == "passed"
        assert results[3]["status"] == "failed", "hash 不匹配必须 failed"
        assert {r["validator_id"]: r["status"] for r in results}["schema.cfg.json"] == "passed"
        human = [r for r in results if r["validator_id"] == "human.confirmation"]
        assert human and human[0]["status"] == "skipped", \
            "人工确认如实记 skipped，不伪装成自动证据"
        assert all_ok is False, "有一条 failed 整体就不绿"
