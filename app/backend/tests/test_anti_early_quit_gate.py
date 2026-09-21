"""
test_anti_early_quit_gate.py — Factory 启发式防早退机器门禁与防弱化测试。
"""
import json
import os
import tempfile
import pytest
from acceptance_contract import normalize_contract, set_goal_contract, get_goal_contract, check_anti_weakening
from goal_manager import GoalManager
from storage import Storage


def make_test_env(base_dir: str):
    db_dir = os.path.join(base_dir, "db")
    ws_dir = os.path.join(base_dir, "workspace")
    os.makedirs(db_dir, exist_ok=True)
    os.makedirs(ws_dir, exist_ok=True)
    st = Storage(db_dir=db_dir)
    gm = GoalManager()
    gm.storage = st
    gm.set_workspace(ws_dir)
    gm.set_session("sess-test")
    return st, gm, ws_dir


@pytest.mark.asyncio
async def test_anti_early_quit_blocks_completion_when_artifact_missing():
    with tempfile.TemporaryDirectory() as td:
        st, gm, ws = make_test_env(td)
        try:
            goal = gm.create_goal("构建前端产物")
            # 绑定验收契约：必须产出 dist/bundle.js
            contract = normalize_contract({
                "summary": "构建前端产物",
                "required_artifacts": ["dist/bundle.js"],
                "verification_plan": [{"type": "file", "path": "dist/bundle.js", "must_exist": True}],
            }, goal.id)
            set_goal_contract(st, goal.id, contract)

            # 此时文件不存在，Agent 谎称已完成
            verdict = await gm.verify_completion(goal.id, evidence="I have built everything, done!")
            assert verdict["passed"] is False, "必须拦截：缺少产物时严禁标记完成"
            assert any("missing artifact" in u for u in verdict["unmet"])

            # 检查注入的系统提醒
            reminder = gm.get_active_goal_context()
            assert reminder is not None
            assert "ANTI-EARLY-QUIT GATE FAILED" in reminder
            assert "dist/bundle.js" in reminder

            # 修复：真正产出文件
            dist_dir = os.path.join(ws, "dist")
            os.makedirs(dist_dir, exist_ok=True)
            with open(os.path.join(dist_dir, "bundle.js"), "w", encoding="utf-8") as f:
                f.write("console.log('bundled');")

            # 再次验证：全绿通过
            verdict2 = await gm.verify_completion(goal.id, evidence="dist/bundle.js created")
            assert verdict2["passed"] is True, "文件补齐后应放行"
        finally:
            st.close()


@pytest.mark.asyncio
async def test_anti_early_quit_blocks_completion_when_command_fails():
    with tempfile.TemporaryDirectory() as td:
        st, gm, ws = make_test_env(td)
        try:
            goal = gm.create_goal("计算器单元测试")
            # 写入一个失败的计算器脚本
            calc_path = os.path.join(ws, "calc.py")
            with open(calc_path, "w", encoding="utf-8") as f:
                f.write("import sys\nsys.exit(1)\n")

            contract = normalize_contract({
                "summary": "计算器测试",
                "verification_plan": [
                    {"type": "command", "command": "python calc.py", "expect_exit": 0, "timeout_s": 5},
                ],
            }, goal.id)
            set_goal_contract(st, goal.id, contract)

            # 验证门禁必须拦截
            verdict = await gm.verify_completion(goal.id, evidence="All unit tests passed")
            assert verdict["passed"] is False, "命令退出码非 0 必须拦截"
            assert len(verdict["unmet"]) > 0

            # 修复 calc.py
            with open(calc_path, "w", encoding="utf-8") as f:
                f.write("import sys\nsys.exit(0)\n")

            # 再次验证
            verdict2 = await gm.verify_completion(goal.id, evidence="Tests fixed")
            assert verdict2["passed"] is True
        finally:
            st.close()


def test_anti_weakening_blocks_dropping_tests():
    c1 = normalize_contract({
        "acceptance_criteria": ["必须支持 加法", "必须支持 减法", "必须支持 乘法"],
        "required_artifacts": ["math.py", "test_math.py"],
        "verification_plan": [
            {"type": "file", "path": "math.py"},
            {"type": "file", "path": "test_math.py"},
        ],
    }, "g1")

    # 尝试在中途更新合同丢弃“乘法”标准
    c2 = normalize_contract({
        "acceptance_criteria": ["必须支持 加法", "必须支持 减法"],
        "required_artifacts": ["math.py", "test_math.py"],
        "verification_plan": [
            {"type": "file", "path": "math.py"},
            {"type": "file", "path": "test_math.py"},
        ],
    }, "g1")

    ok, reason = check_anti_weakening(c1, c2)
    assert ok is False
    assert "禁止弱化合同" in reason
    assert "乘法" in reason

    # 尝试中途删去必交付产物
    c3 = normalize_contract({
        "acceptance_criteria": ["必须支持 加法", "必须支持 减法", "必须支持 乘法"],
        "required_artifacts": ["math.py"],
        "verification_plan": [
            {"type": "file", "path": "math.py"},
            {"type": "file", "path": "test_math.py"},
        ],
    }, "g1")
    ok3, reason3 = check_anti_weakening(c1, c3)
    assert ok3 is False
    assert "test_math.py" in reason3
