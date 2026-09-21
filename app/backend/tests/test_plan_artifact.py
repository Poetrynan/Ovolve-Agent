"""plan_artifact.py — Plan 模式产物存储/批准/合同渲染的专项测试。"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from plan_artifact import (
    save_plan_artifact, get_plan_artifact, latest_ready_for_session,
    approve_plan_artifact, render_contract, extract_plan_block,
)


def test_save_and_get_roundtrip():
    a = save_plan_artifact("s1", "# 方案\n- [ ] 改 a.py\n- [ ] 跑测试")
    assert a["plan_id"] and a["status"] == "ready" and a["chars"] > 0
    got = get_plan_artifact(a["plan_id"])
    assert got and got["plan_md"].startswith("# 方案")


def test_latest_ready_returns_newest_and_skips_approved():
    a1 = save_plan_artifact("s2", "方案一")
    a2 = save_plan_artifact("s2", "方案二")
    assert latest_ready_for_session("s2")["plan_id"] == a2["plan_id"]
    approve_plan_artifact(a2["plan_id"], approved_with="full")
    assert latest_ready_for_session("s2")["plan_id"] == a1["plan_id"]


def test_approve_records_snapshot_and_idempotent_guard():
    a = save_plan_artifact("s3", "方案三")
    ok = approve_plan_artifact(a["plan_id"], approved_with="auto")
    assert ok and ok["status"] == "approved" and ok["approved_with"] == "auto"
    # 二次批准同一 artifact 应被拒绝（None），防重复执行轮
    assert approve_plan_artifact(a["plan_id"], approved_with="auto") is None


def test_render_contract_contains_plan_and_rules():
    a = save_plan_artifact("s4", "- [ ] 步骤一\n- [ ] 步骤二")
    c = render_contract(a)
    assert "步骤一" in c and "已获用户批准" in c and "PlanStepStatus" in c


def test_extract_plan_block_fenced_and_fallback():
    fenced = "前言\n```plan\n- [ ] A\n```\n后记"
    assert extract_plan_block(fenced) == "- [ ] A"
    assert extract_plan_block("无围栏方案正文") == "无围栏方案正文"
    assert extract_plan_block("") == ""
