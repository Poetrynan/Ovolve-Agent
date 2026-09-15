"""approve_plan → 执行轮合同注入的最小闭环测试（Task 3，不起 aiohttp）。"""
import sys, os, asyncio
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from plan_artifact import (
    save_plan_artifact, approve_plan_artifact, get_plan_artifact,
    render_contract, discard_plan_artifact,
)


def test_full_approve_flow_produces_contract_text():
    art = save_plan_artifact("sess_ap", "- [ ] 一步\n- [ ] 二步")
    ok = approve_plan_artifact(art["plan_id"], approved_with="full")
    assert ok["status"] == "approved"
    stored = get_plan_artifact(art["plan_id"])
    contract = render_contract(stored)
    assert "已获用户批准" in contract and "一步" in contract
    assert stored["approved_with"] == "full"


def test_discard_flow():
    art = save_plan_artifact("sess_dp", "草稿")
    assert discard_plan_artifact(art["plan_id"]) is True
    assert get_plan_artifact(art["plan_id"])["status"] == "discarded"
    # discarded 不可再批准
    assert approve_plan_artifact(art["plan_id"], approved_with="auto") is None


def test_approved_plan_context_injects_contract():
    """执行轮前置处理：approved_plan 存在 → 合同消息注入 + meta 附加。"""
    art = save_plan_artifact("sess_inj", "- [ ] 注入步骤")
    approve_plan_artifact(art["plan_id"], approved_with="auto")

    from router import _approved_plan_context
    ctx = {"approved_plan": art["plan_id"], "permission": "full"}
    msgs, meta_extra = _approved_plan_context(
        [{"role": "user", "content": "开工"}], ctx)
    assert any("已获用户批准" in m["content"] for m in msgs)
    assert meta_extra["approved_with"] == "auto"
    assert meta_extra["approved_plan_id"] == art["plan_id"]
    # 原始 user 消息必须仍在（合同在前，不丢用户请求）
    assert msgs[-1]["content"] == "开工"


def test_plan_meta_merges_into_terminal_meta():
    """``_plan_meta`` 必须有消费者，否则审批信息永远到不了轮次终态 meta。"""
    from router import _merge_plan_meta
    meta = {"turn_outcome": "completed"}
    context = {"_plan_meta": {"approved_with": "auto", "approved_plan_id": "pa_x"}}
    out = _merge_plan_meta(meta, context)
    assert out["approved_with"] == "auto"
    assert out["approved_plan_id"] == "pa_x"
    # 既有 meta 字段不被冲掉
    assert out["turn_outcome"] == "completed"
    # 消费后从 context 摘掉，避免污染后续轮次
    assert "_plan_meta" not in context


def test_merge_plan_meta_noop_cases():
    from router import _merge_plan_meta
    assert _merge_plan_meta({"a": 1}, {}) == {"a": 1}
    assert _merge_plan_meta({"a": 1}, {"_plan_meta": None}) == {"a": 1}
    assert _merge_plan_meta({"a": 1}, {"_plan_meta": {}}) == {"a": 1}
    # context 不是 dict 时 fail-open，不抛异常
    assert _merge_plan_meta({"a": 1}, None) == {"a": 1}


def test_approved_plan_context_noop_cases():
    from router import _approved_plan_context
    # 无 approved_plan 键 → 原样返回
    msgs, meta = _approved_plan_context([{"role": "user", "content": "hi"}], {})
    assert meta == {} and len(msgs) == 1
    # 不存在的 plan_id → 原样返回（fail-open）
    msgs, meta = _approved_plan_context([{"role": "user", "content": "hi"}],
                                        {"approved_plan": "pa_nonexistent"})
    assert meta == {} and len(msgs) == 1
    # 未批准（ready）的方案 → 不注入
    art = save_plan_artifact("sess_noop", "还没批准的方案")
    msgs, meta = _approved_plan_context([{"role": "user", "content": "hi"}],
                                        {"approved_plan": art["plan_id"]})
    assert meta == {} and len(msgs) == 1
