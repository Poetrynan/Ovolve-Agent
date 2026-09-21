# -*- coding: utf-8 -*-
"""U5 交付语义提示的 goal_scheduler 侧测试。

两条铁律各有专门用例：
- 语义旁路必须被拒——只有 delivery_hint、物理/启发判据不满足时，门禁照样拒绝；
- 空证据不拼接——纯提示不能把"无证据"翻成"有证据"。
"""

import asyncio
import time

import pytest

import goal_scheduler as gs
from goal_manager import GoalStatus
from goal_scheduler import (
    collect_delivery_hints,
    delivery_evidence_note,
    empty_delivery_hints,
    evidence_with_hints,
    merge_delivery_hints,
)
from result import Result
from storage import get_storage


@pytest.fixture
def store():
    return get_storage()


def _new_goal(store, desc="test goal"):
    gid = f"t-{time.time_ns()}"
    store.save_goal(gid, desc, GoalStatus.STARTED, 0, "sess-test", "")
    return gid


def _deliverable_row(text="目标页面已加载"):
    return {"tool": "cua_action", "status": "ok",
            "result": {"ok": True, "action": "element_info",
                       "delivery_hint": "deliverable", "summary": text}}


def _handoff_row(reason="改密码提交需要用户亲自执行"):
    return {"tool": "cua_action", "status": "ok",
            "result": {"ok": True, "action": "element_info",
                       "delivery_hint": "handoff", "reason": reason}}


# ── 收集器（纯函数）──────────────────────────────────────────────────────────


def test_collect_normal_aggregation():
    trace = [_deliverable_row(), _deliverable_row(), _handoff_row("需要人接")]
    hints = collect_delivery_hints(trace)
    assert hints["deliverable_count"] == 2
    assert hints["handoff_count"] == 1
    assert "需要人接" in hints["latest_handoff_detail"]


def test_collect_flattens_round_lists():
    """整条轨迹 = 每轮一个行列表，摊平后同样能扫到。"""
    trace = [[_deliverable_row()], [_deliverable_row(), _handoff_row("b")]]
    hints = collect_delivery_hints(trace)
    assert hints["deliverable_count"] == 2 and hints["handoff_count"] == 1


def test_collect_dirty_payloads_are_silent_zero():
    dirty = [None, "字符串", 42, {"delivery_hint": "Deliverable"},
             {"delivery_hint": ""}, {"delivery_hint": None},
             {"delivery_hint": "deliverable "}, {"tool": "x"}]
    hints = collect_delivery_hints(dirty)
    assert hints == empty_delivery_hints()


def test_collect_empty_trace_is_zero():
    assert collect_delivery_hints(None) == empty_delivery_hints()
    assert collect_delivery_hints([]) == empty_delivery_hints()


def test_detail_priority_and_truncation():
    row = {"tool": "cua_action", "delivery_hint": "handoff",
           "note": "次要来源", "error": "主要来源应当优先"}
    detail = collect_delivery_hints([row])["latest_handoff_detail"]
    assert detail.startswith("主要来源")
    long = {"tool": "cua_action", "delivery_hint": "handoff",
            "summary": "长" * 500}
    assert len(collect_delivery_hints([long])["latest_handoff_detail"]) == 200


def test_nested_payload_mount_points():
    """契约没钉挂载点——result/value/output/details 四个内层键都要能接住。"""
    for mount in ("value", "output", "details"):
        row = {"tool": "cua_action", mount: {"delivery_hint": "deliverable"}}
        assert collect_delivery_hints([row])["deliverable_count"] == 1, mount


def test_merge_accumulates_and_latest_detail_wins():
    base = collect_delivery_hints([_handoff_row("旧原因")])
    add = collect_delivery_hints([_deliverable_row(), _handoff_row("新原因")])
    merged = merge_delivery_hints(base, add)
    assert merged["deliverable_count"] == 1 and merged["handoff_count"] == 2
    assert "新原因" in merged["latest_handoff_detail"]
    assert merge_delivery_hints(base, None)["handoff_count"] == 1


def test_evidence_note_zero_is_silent():
    assert delivery_evidence_note(empty_delivery_hints()) == ""
    assert delivery_evidence_note(None) == ""


def test_evidence_note_carries_disclaimer_and_counts():
    note = delivery_evidence_note(collect_delivery_hints(
        [_deliverable_row(), _handoff_row("细节")]))
    assert note.startswith("[delivery-hints]")
    assert "仅佐证" in note
    assert "deliverable×1" in note and "handoff×1" in note


def test_evidence_with_hints_empty_evidence_guardrail():
    """铁律：原始证据为空时一个字不加——纯提示翻不转 heuristic 判据。"""
    hints = collect_delivery_hints([_deliverable_row()])
    assert evidence_with_hints("", hints) == ""
    assert evidence_with_hints("   \n  ", hints).strip() == ""
    assert evidence_with_hints(None, hints) == ""
    combined = evidence_with_hints("真实证据", hints)
    assert combined.startswith("真实证据")
    assert "仅佐证" in combined


# ── 调度器集成（复用 test_goal_scheduler 的 fake 手法）──────────────────────


class _FakeBus:
    def __init__(self):
        self.events = []

    async def emit(self, kind, payload):
        self.events.append((kind, payload))

    def states_for(self, gid):
        return [p.get("status") for k, p in self.events
                if k == "goal_state_change" and p.get("goal_id") == gid]


class _HintRouter:
    """按轮注入 tool_trace 的路由替身；证据文本逐轮不同防误触卡死熔断。"""

    def __init__(self, traces, replies):
        self._traces = list(traces)
        self._replies = list(replies)
        self._i = 0
        self.workspace = ""
        self.bus = None

    async def handle(self, prompt, context=None):
        idx = min(self._i, len(self._traces) - 1)
        context["tool_trace"] = self._traces[idx]
        r = self._replies[min(self._i, len(self._replies) - 1)]
        self._i += 1
        return Result.success(r)


@pytest.fixture
def scheduler_factory(monkeypatch, store):
    monkeypatch.setattr(gs, "_scheduler", None)

    def make(router, heuristic=None, verdicts=None):
        bus = _FakeBus()
        sched = gs.GoalScheduler(router, bus)

        async def fake_verify(goal_id, evidence=""):
            if verdicts:
                return verdicts.pop(0)
            text = str(evidence or "")
            passed = bool(text.strip()) and "not done" not in text.lower()
            return {"passed": passed,
                    "reason": "" if passed else "无可用证据"}

        sched._goal_manager.verify_completion = fake_verify  # type: ignore
        return sched, bus
    return make


def _stage_events(bus, gid, stage):
    return [p for k, p in bus.events if k == "goal_state_change"
            and p.get("goal_id") == gid and p.get("stage") == stage]


@pytest.mark.asyncio
async def test_dual_condition_pass_carries_hints(scheduler_factory, store):
    """物理/启发判据满足 + deliverable 提示 → 完成且 verify/完成事件带佐证。"""
    gid = _new_goal(store, "write hello")
    traces = [[_deliverable_row(), _deliverable_row()]]
    sched, bus = scheduler_factory(
        _HintRouter(traces, ["created hello.txt"]), verdicts=[{"passed": True}])
    sched.enqueue(gid)
    await asyncio.wait_for(sched._workers[gid], timeout=5.0)
    await asyncio.sleep(0.05)  # _emit_change 是 call_soon 派发——等 emit 任务落 bus

    assert store.get_goal(gid)["status"] == GoalStatus.COMPLETED
    verify_events = _stage_events(bus, gid, "verify")
    assert verify_events and verify_events[-1]["delivery_hints"]["deliverable_count"] == 2
    completed = [p for k, p in bus.events
                 if k == "goal_state_change" and p.get("status") == "completed"]
    assert completed and completed[0]["delivery_hints"]["deliverable_count"] == 2


@pytest.mark.asyncio
async def test_semantic_bypass_is_rejected(scheduler_factory, store):
    """核心用例：全程 deliverable 提示、启发判据不满足 → 门禁照样拒绝。

    fake 判据 = "有非空证据且不含 not done"。证据本身写着 not done——
    提示再多也翻不转。提示必须"被看到"（verify 事件带出）但"不被服从"。
    """
    gid = _new_goal(store, "cannot finish")
    store.update_goal_fields(gid, max_iterations=2)
    traces = [[_deliverable_row()], [_deliverable_row(), _deliverable_row()]]
    sched, bus = scheduler_factory(
        _HintRouter(traces, ["not done A", "not done B"]))
    sched.enqueue(gid)
    await asyncio.wait_for(sched._workers[gid], timeout=5.0)
    await asyncio.sleep(0.05)  # _emit_change 是 call_soon 派发——等 emit 任务落 bus

    row = store.get_goal(gid)
    assert row["status"] != GoalStatus.COMPLETED
    verify_events = _stage_events(bus, gid, "verify")
    assert verify_events
    for ev in verify_events:
        assert ev["delivery_hints"]["deliverable_count"] >= 1, "提示被看到"


@pytest.mark.asyncio
async def test_empty_evidence_with_hints_still_rejected(scheduler_factory, store):
    """空证据 + 纯提示：heuristic 的"有证据才算过"不得被提示填满。"""
    gid = _new_goal(store, "silent finish")
    store.update_goal_fields(gid, max_iterations=2)
    traces = [[_deliverable_row()], [_deliverable_row()]]
    sched, bus = scheduler_factory(_HintRouter(traces, ["", ""]))
    sched.enqueue(gid)
    await asyncio.wait_for(sched._workers[gid], timeout=5.0)
    await asyncio.sleep(0.05)  # _emit_change 是 call_soon 派发——等 emit 任务落 bus
    assert store.get_goal(gid)["status"] != GoalStatus.COMPLETED


@pytest.mark.asyncio
async def test_handoff_signal_dedup_then_rearm(scheduler_factory, store):
    """一轮多条 handoff 只发一条信号；新一轮计数上升再发并更新 detail。"""
    gid = _new_goal(store, "needs human")
    store.update_goal_fields(gid, max_iterations=3)
    traces = [
        [_handoff_row("第一轮需要人接")],
        [_handoff_row("第二轮重复"), _handoff_row("第二轮重复2")],
        [_handoff_row("第三轮新情况"), _handoff_row("第三轮另一条")],
    ]
    sched, bus = scheduler_factory(
        _HintRouter(traces, ["not done α", "not done β", "not done γ"]))
    sched.enqueue(gid)
    await asyncio.wait_for(sched._workers[gid], timeout=5.0)
    await asyncio.sleep(0.05)  # _emit_change 是 call_soon 派发——等 emit 任务落 bus

    signals = [p for k, p in bus.events if k == "goal_state_change"
               and p.get("goal_id") == gid and p.get("handoff_required") is True]
    assert len(signals) == 3, "轮内去重、跨轮计数上升即再arm（1→3→5）"
    assert "第一轮需要人接" in signals[0]["handoff_detail"]
    assert "第二轮重复2" in signals[1]["handoff_detail"]
    assert signals[1]["delivery_hints"]["handoff_count"] == 3
    assert "第三轮另一条" in signals[2]["handoff_detail"]
    assert signals[2]["delivery_hints"]["handoff_count"] == 5
    for sig in signals:
        assert sig.get("stage") is None, "接管信号不混入阶段序列"
        assert sig["status"] == GoalStatus.RUNNING


@pytest.mark.asyncio
async def test_no_hints_zero_aggregation_and_stage_order(scheduler_factory, store):
    """无提示轨迹：verify 事件带零值聚合，阶段序列与既有行为完全一致。"""
    gid = _new_goal(store, "plain run")
    traces = [[]]
    sched, bus = scheduler_factory(
        _HintRouter(traces, ["created hello.txt"]), verdicts=[{"passed": True}])
    sched.enqueue(gid)
    await asyncio.wait_for(sched._workers[gid], timeout=5.0)
    await asyncio.sleep(0.05)  # _emit_change 是 call_soon 派发——等 emit 任务落 bus

    assert store.get_goal(gid)["status"] == GoalStatus.COMPLETED
    verify_events = _stage_events(bus, gid, "verify")
    assert verify_events and verify_events[-1]["delivery_hints"] == empty_delivery_hints()
    stages = [p.get("stage") for p in
              (p for k, p in bus.events
               if k == "goal_state_change" and p.get("goal_id") == gid)
              if p.get("stage")]
    assert stages == sorted(stages, key=["plan", "execute", "verify"].index)


@pytest.mark.asyncio
async def test_emit_stage_extra_tolerates_non_dict(scheduler_factory, store):
    """_emit_stage 的 extra 传非 dict 时 fail-open 为空，不炸事件。"""
    gid = _new_goal(store, "emit robust")
    sched, bus = scheduler_factory(_HintRouter([], ["x"]))
    sched._emit_stage(gid, "verify", 1, 3, extra="不是 dict")
    await asyncio.sleep(0.05)
    events = _stage_events(bus, gid, "verify")
    assert events and events[0]["iteration"] == 1
