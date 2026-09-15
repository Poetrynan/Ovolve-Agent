# -*- coding: utf-8 -*-
"""Unit and integration tests for context pressure evolution closure."""
import inspect
import time
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from evolution import (
    EvolutionEngine,
    EvolutionStore,
    KIND_TARGET,
    MODE_ACTIVE,
    ALLOWED_TARGETS,
)
from evolution_pressure import (
    should_trigger_pressure_evolution,
    probe_context_pressure,
)


@pytest.fixture
def clean_evo_env(tmp_path):
    ws = tmp_path / "workspace"
    ws.mkdir()
    agents_md = ws / "AGENTS.md"
    agents_md.write_text("# Agent Guidelines\n", encoding="utf-8")
    memory_md = ws / "MEMORY.md"
    memory_md.write_text("# User Memory\n", encoding="utf-8")

    db_path = str(tmp_path / "evolution.db")
    store = EvolutionStore(db_path=db_path)
    engine = EvolutionEngine(store=store, mode=MODE_ACTIVE, workspace_root=str(ws))
    return {
        "ws": ws,
        "agents_md": agents_md,
        "memory_md": memory_md,
        "store": store,
        "engine": engine,
    }


def test_kind_target_and_draft_for_context_pressure(clean_evo_env):
    """验证 context_pressure 在 KIND_TARGET 中映射到 AGENTS.md 且产出正确草案。"""
    assert "context_pressure" in KIND_TARGET
    assert KIND_TARGET["context_pressure"] == "AGENTS.md"
    assert KIND_TARGET["context_pressure"] in ALLOWED_TARGETS

    engine = clean_evo_env["engine"]
    row = {
        "kind": "context_pressure",
        "tool": "context_engine",
        "detail": "Turn 4 context pressure at 85.0%",
        "signature": "sig_pressure_test_1",
        "hits": 3,
    }
    proposal = engine._draft(row)
    assert proposal is not None
    assert proposal.target_file == "AGENTS.md"
    assert proposal.kind == "context_pressure"
    assert "上下文" in proposal.draft
    assert "预算" in proposal.draft or "折叠" in proposal.draft


def test_mine_produces_context_pressure_proposal(clean_evo_env):
    """验证累积的 context_pressure 信号能被 mine() 正确挖掘为待审提案。"""
    engine = clean_evo_env["engine"]
    store = clean_evo_env["store"]

    # 记录 3 次满足 active 档阈值的 context_pressure 信号
    for i in range(3):
        store.record_signal(
            kind="context_pressure",
            tool_name="context_engine",
            detail="Turn context pressure breach threshold at 82%",
            session_id="s_test",
            failure_kind="context_pressure",
        )

    made = engine.mine()
    assert len(made) == 1
    p = made[0]
    assert p.kind == "context_pressure"
    assert p.target_file == "AGENTS.md"
    assert p.status == "pending"


def test_probe_context_pressure_is_sync_and_fail_open():
    """验证探针必须是纯同步函数，无协程逃逸且具有 fail-open 保护。"""
    res = probe_context_pressure(
        messages=[{"role": "user", "content": "x" * 3000}],
        max_context_tokens=1000,
        threshold=0.8,
        session_id="sess_sync_test",
        turn_id="turn_1",
    )
    # 必须是同步执行完成并直接返回元组，绝不是 coroutine
    assert not inspect.iscoroutine(res)
    assert isinstance(res, tuple)
    triggered, ratio, sig_id = res
    assert triggered is True
    assert ratio >= 0.8

    # 异常输入下必须 fail-open，不抛出任何异常
    bad_res = probe_context_pressure(None, -1, threshold=-0.5)
    assert bad_res == (False, 0.0, None)


@pytest.mark.asyncio
async def test_router_post_turn_pressure_triggers_async_fold_with_debounce():
    """验证 Router 在回合结束异步段调用 fold_context，并保持 10 分钟防抖。"""
    from router_modules.admission import RouterAdmissionMixin

    class MockRouter(RouterAdmissionMixin):
        def __init__(self):
            self.session_id = "sess_debounce_test"
            self._turn_seq = 1
            self.storage = MagicMock()
            self.storage.get_messages.return_value = [{"role": "user", "content": "hello"}]
            self.compactor = MagicMock()
            self.compactor.max_tokens = 100
            self.compactor.threshold = 0.5
            self.fold_context = AsyncMock()
            self.fold_context.return_value = MagicMock(ok=True)
            self._last_pressure_fold_at = 0.0

    router = MockRouter()
    context = {"turn_id": "turn_1", "context_pressure_triggered": True}

    # 模拟探针命中且上下文标记为 True
    with patch("evolution_pressure.probe_context_pressure", return_value=(True, 0.85, "sig_1")):
        # 第一次执行：应该触发 fold_context
        await router._maybe_fold_on_pressure(context)
        assert router.fold_context.await_count == 1

        # 紧接着第二次执行（未过 10 分钟防抖）：不应重复调用 fold_context
        await router._maybe_fold_on_pressure(context)
        assert router.fold_context.await_count == 1

        # 模拟 10 分钟后：再次触发
        router._last_pressure_fold_at = time.time() - 601.0
        await router._maybe_fold_on_pressure(context)
        assert router.fold_context.await_count == 2


@pytest.mark.asyncio
async def test_flush_memory_proposes_facts_to_evolution(clean_evo_env):
    """验证 fold 前抽取的记忆若包含新事实，能无缝送入 _propose_facts 并生成待审记忆。"""
    from router_modules.admission import RouterAdmissionMixin
    from memory_layer import Memory, MemoryScope

    class MockMemory:
        def extract(self, content, context=""):
            return [
                Memory(
                    content="用户要求前端必须使用 TypeScript 严格模式。",
                    scope=MemoryScope.SESSION,
                )
            ]

        def store(self, mem):
            pass

    class MockRouter(RouterAdmissionMixin):
        def __init__(self, ws):
            self.session_id = "sess_fact_test"
            self.workspace = str(ws)
            self.memory = MockMemory()
            self.storage = None

    router = MockRouter(clean_evo_env["ws"])
    messages = [{"role": "user", "content": "注意：前端项目统一要求使用 TypeScript 严格模式进行开发。"}]

    with patch("evolution.get_evolution_engine", return_value=clean_evo_env["engine"]):
        count = await router._flush_memory_for_fold(messages)
    assert count == 1

    # 验证 evolution.db 中已经生成了对应的 learned_fact 待审提案
    open_props = clean_evo_env["engine"].store.open_proposals()
    fact_props = [p for p in open_props if p.kind == "learned_fact"]
    assert len(fact_props) == 1
    assert fact_props[0].target_file == "MEMORY.md"
    assert "TypeScript" in fact_props[0].draft


def test_pressure_smoke_full_pipeline(clean_evo_env):
    """集成冒烟：高压信号入库 -> mine 产出 AGENTS.md 提案 -> decide(accept) -> undo 回滚。"""
    from evolution_undo import undo

    engine = clean_evo_env["engine"]
    store = clean_evo_env["store"]
    ws = clean_evo_env["ws"]
    agents_md = clean_evo_env["agents_md"]
    orig_agents_text = agents_md.read_text(encoding="utf-8")

    # 1. 模拟触发 3 次 context_pressure 信号
    for i in range(3):
        store.record_signal(
            kind="context_pressure",
            tool_name="context_engine",
            detail="Session tokens ratio at 88.5% exceeds threshold 0.8",
            session_id="smoke_sess",
            failure_kind="context_pressure",
        )

    # 2. mine() 产生提案
    props = engine.mine()
    assert len(props) == 1
    p = props[0]
    assert p.kind == "context_pressure"
    assert p.target_file == "AGENTS.md"

    # 3. 用户决定接受提案
    decide_res = engine.decide(p.id, accept=True)
    assert decide_res["ok"]
    assert decide_res["applied"]
    assert p.draft in agents_md.read_text(encoding="utf-8")

    # 4. 用户调用 undo 回滚
    undo_res = undo(workspace_root=str(ws), proposal_id=p.id, store=store)
    assert undo_res.ok
    assert agents_md.read_text(encoding="utf-8") == orig_agents_text

    # 5. 验证回滚记录了 user_correction
    signals = store.recent_signals(limit=5)
    corrections = [s for s in signals if s.get("kind") == "user_correction"]
    assert len(corrections) >= 1
    assert p.id in corrections[0].get("detail", "")

