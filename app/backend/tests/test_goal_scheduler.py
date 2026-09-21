"""Tests for autonomous goal execution (goal_scheduler + goals REST).

Covers the guardrails that make unattended execution safe rather than the
happy path only: cost cap, iteration ceiling, stuck-loop detection, claim
atomicity, and the fact that partial DB writes no longer wipe sibling columns.
"""
import asyncio
import json
import time

import pytest

from goal_scheduler import (
    GoalScheduler,
    _plan_progress,
    goal_view,
    DEFAULT_COST_CAP_MICROS,
    DEFAULT_MAX_ITERATIONS,
    MAX_SAME_ACTION_REPEATS,
    MAX_WORKERS,
    RUNNING,
    QUEUED,
)
from goal_manager import GoalStatus
from result import Result
from storage import get_storage


# ---------------------------------------------------------------------------
# Progress derivation
# ---------------------------------------------------------------------------

def test_plan_progress_empty_returns_none_ratio():
    """No plan → ratio is None so the UI shows a label, not a fake percentage."""
    assert _plan_progress("[]") == {"completed": 0, "total": 0, "ratio": None}
    assert _plan_progress("") == {"completed": 0, "total": 0, "ratio": None}


def test_plan_progress_counts_completed_subtasks():
    plan = json.dumps([
        {"id": "1", "title": "a", "status": "completed"},
        {"id": "2", "title": "b", "status": "completed"},
        {"id": "3", "title": "c", "status": "pending"},
        {"id": "4", "title": "d", "status": "in_progress"},
    ])
    got = _plan_progress(plan)
    assert got["completed"] == 2
    assert got["total"] == 4
    assert got["ratio"] == 0.5


def test_plan_progress_survives_malformed_json():
    """A corrupt plan column must not take the whole goals list down."""
    assert _plan_progress("{not json")["ratio"] is None
    assert _plan_progress('{"a": 1}')["ratio"] is None  # dict, not list


def test_goal_view_converts_micros_to_dollars():
    row = {
        "id": "g1", "description": "test", "status": "running",
        "iteration": 3, "max_iterations": 10,
        "cost_micros": 1_250_000, "cost_cap_micros": 5_000_000,
        "plan_json": "[]", "verification_result": "",
    }
    view = goal_view(row)
    assert view["costUsd"] == 1.25
    assert view["costCapUsd"] == 5.0
    assert view["iteration"] == 3
    assert view["maxIterations"] == 10
    assert view["progressRatio"] is None


def test_goal_view_parses_verification_json():
    row = {
        "id": "g1", "description": "d", "status": "completed",
        "verification_result": json.dumps(
            {"passed": True, "reason": "file exists", "suggestions": []}
        ),
        "plan_json": "[]",
    }
    view = goal_view(row)
    assert view["verification"]["passed"] is True
    assert view["verification"]["reason"] == "file exists"


def test_goal_view_tolerates_non_json_verification():
    row = {"id": "g", "description": "d", "status": "active",
           "verification_result": "plain text", "plan_json": "[]"}
    assert goal_view(row)["verification"] is None


# ---------------------------------------------------------------------------
# Storage: partial writes and claim atomicity
# ---------------------------------------------------------------------------

@pytest.fixture
def store():
    return get_storage()


def _new_goal(store, desc="test goal"):
    gid = f"t-{time.time_ns()}"
    store.save_goal(gid, desc, GoalStatus.STARTED, 0, "sess-test", "")
    return gid


def test_save_goal_preserves_new_columns(store):
    """The regression this whole change hinges on.

    save_goal used INSERT OR REPLACE, which deletes and re-inserts the row —
    so every column not named in the INSERT (spend, plan, cap) reverted to its
    default. A status change would silently zero the spend ledger, letting a
    goal spend its cap over and over without ever tripping the breaker.
    """
    gid = _new_goal(store)
    store.update_goal_fields(gid, cost_micros=2_000_000, plan_json='[{"status":"completed"}]')

    # A plain status update must not disturb the ledger or the plan.
    store.save_goal(gid, "test goal", GoalStatus.PAUSED, 4, "sess-test", "")

    row = store.get_goal(gid)
    assert row["status"] == GoalStatus.PAUSED
    assert row["iteration"] == 4
    assert row["cost_micros"] == 2_000_000, "spend ledger was wiped"
    assert row["plan_json"] == '[{"status":"completed"}]', "plan was wiped"


def test_save_goal_preserves_created_at(store):
    """created_at is set once. Re-saving must not make the goal look brand new."""
    gid = _new_goal(store)
    original = store.get_goal(gid)["created_at"]
    time.sleep(1.1)
    store.save_goal(gid, "test goal", GoalStatus.ACTIVE, 1, "sess-test", "")
    assert store.get_goal(gid)["created_at"] == original


def test_update_goal_fields_rejects_unknown_columns(store):
    """Field names reach an f-string, so the allowlist is the injection guard."""
    gid = _new_goal(store)
    assert store.update_goal_fields(gid, id="hijacked") is False
    assert store.update_goal_fields(gid, **{"status=1; DROP TABLE goals; --": "x"}) is False
    assert store.get_goal(gid) is not None


def test_update_goal_fields_reports_missing_row(store):
    assert store.update_goal_fields("does-not-exist", status="paused") is False


def test_claim_goal_is_exclusive(store):
    """Two claimants, one winner — this is the concurrency lock."""
    gid = _new_goal(store)
    assert store.claim_goal(gid) is True
    assert store.claim_goal(gid) is False, "second claim must lose"
    store.release_goal(gid)
    assert store.claim_goal(gid) is True, "released goal is claimable again"


def test_claim_goal_reclaims_stale_lock(store):
    """A crashed process must not strand a goal as permanently un-runnable."""
    gid = _new_goal(store)
    assert store.claim_goal(gid) is True
    # Backdate the claim beyond the staleness window.
    store.update_goal_fields(gid, claimed_at=int(time.time()) - 5000)
    assert store.claim_goal(gid, stale_after=900) is True


def test_add_goal_spend_accumulates(store):
    gid = _new_goal(store)
    store.add_goal_spend(gid, 1000, tokens=50)
    got = store.add_goal_spend(gid, 2500, tokens=70)
    assert got["cost_micros"] == 3500
    assert got["tokens_used"] == 120


def test_new_goal_has_default_budget(store):
    gid = _new_goal(store)
    row = store.get_goal(gid)
    assert row["max_iterations"] == DEFAULT_MAX_ITERATIONS
    assert row["cost_cap_micros"] == DEFAULT_COST_CAP_MICROS
    assert row["cost_micros"] == 0
    assert row["claimed_at"] == 0


# ---------------------------------------------------------------------------
# Scheduler behavior
# ---------------------------------------------------------------------------

class _FakeBus:
    """In-memory event bus. Records every emit for assertion."""
    def __init__(self):
        self.events: list[tuple[str, dict]] = []

    async def emit(self, kind, payload):
        self.events.append((kind, payload))

    def states_for(self, gid):
        return [p.get("status") for k, p in self.events
                if k == "goal_state_change" and p.get("goal_id") == gid]


class _CompletingRouter:
    """Router stub that answers turns; verify_completion is patched separately."""
    def __init__(self, replies=None):
        self._replies = replies or ["created hello.txt"]
        self._i = 0
        self.bus = None

    async def handle(self, prompt, context=None):
        # The worker now passes a per-turn context ({"goal_id": ...}) and reads
        # ``tool_trace`` back out of it. The stub ignores it but must accept it,
        # mirroring the real Router.handle(user_message, context=None).
        r = self._replies[min(self._i, len(self._replies) - 1)]
        self._i += 1
        return Result.success(r)


@pytest.fixture
def scheduler_factory(monkeypatch, store):
    """Yields a factory that builds a scheduler wired to fakes.

    Also resets the singleton so tests don't share state — the module-level
    ``_scheduler`` singleton is what production uses, but per-test isolation
    matters more here.
    """
    import goal_scheduler as gs
    monkeypatch.setattr(gs, "_scheduler", None)

    def make(router, verdict_sequence):
        bus = _FakeBus()
        sched = GoalScheduler(router, bus)
        # Patch the goal manager's LLM verifier without touching the real one:
        # feed a deterministic sequence of {passed, reason}.
        verdicts = list(verdict_sequence)

        async def fake_verify(goal_id, evidence=""):
            v = verdicts.pop(0) if verdicts else {"passed": False, "reason": "no verdict"}
            return v

        sched._goal_manager.verify_completion = fake_verify  # type: ignore
        return sched, bus
    return make


@pytest.mark.asyncio
async def test_scheduler_runs_goal_to_completion(scheduler_factory, store):
    """Happy path: one iteration, verifier says done, status → completed."""
    gid = _new_goal(store, "write hello")
    sched, bus = scheduler_factory(
        _CompletingRouter(["done"]),
        [{"passed": True, "reason": "file exists", "suggestions": []}],
    )
    r = sched.enqueue(gid)
    assert r.ok, r.error
    # Wait for the worker to finish. The worker is spawned in enqueue().
    task = sched._workers[gid]
    await asyncio.wait_for(task, timeout=5.0)

    row = store.get_goal(gid)
    assert row["status"] == GoalStatus.COMPLETED
    assert row["claimed_at"] == 0, "claim must be released on completion"
    assert "running" in bus.states_for(gid)
    assert "completed" in bus.states_for(gid)


@pytest.mark.asyncio
async def test_scheduler_stops_at_max_iterations(scheduler_factory, store):
    """Verifier never passes → status becomes ovolve_failed_final at the ceiling."""
    gid = _new_goal(store, "converge maybe")
    store.update_goal_fields(gid, max_iterations=3)
    # Verdict never passes — cheap way to force the loop to the ceiling.
    # Evidence must be DISTINCT per round (and non-numeric, since the signature
    # strips digits): identical output would trip the stuck-loop breaker first,
    # and this test is about the iteration ceiling, not the loop detector.
    always_fail = [{"passed": False, "reason": "not yet", "suggestions": []}] * 20
    distinct = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]
    sched, bus = scheduler_factory(_CompletingRouter(distinct), always_fail)

    sched.enqueue(gid)
    await asyncio.wait_for(sched._workers[gid], timeout=5.0)

    row = store.get_goal(gid)
    assert row["status"] == GoalStatus.FAILED_FINAL
    # The DB iteration counter increments once per handle() call, so with
    # max_iterations=3 we should have burned through 3 rounds — not 20.
    assert row["iteration"] <= 3
    assert "iterations" in (row["last_error"] or "").lower()


@pytest.mark.asyncio
async def test_scheduler_detects_stuck_loop(scheduler_factory, store):
    """Same evidence three times in a row aborts the goal.

    This is the AutoGPT failure mode — a model that keeps "improving" the same
    file forever because its own verifier never returns done. The breaker fires
    before the iteration ceiling.
    """
    gid = _new_goal(store, "loop")
    store.update_goal_fields(gid, max_iterations=20)
    identical = "identical output"
    sched, bus = scheduler_factory(
        _CompletingRouter([identical] * 10),
        [{"passed": False, "reason": "no"}] * 20,
    )
    sched.enqueue(gid)
    await asyncio.wait_for(sched._workers[gid], timeout=5.0)

    row = store.get_goal(gid)
    assert row["status"] == GoalStatus.FAILED_FINAL
    assert "stuck" in (row["last_error"] or "").lower()
    # Terminated well before hitting max_iterations (=20). The iteration
    # counter records both the handle() call and the continuation reminder,
    # so 3 repeated evidences ≈ 5-6 rows depending on where the breaker fires.
    assert row["iteration"] < 20


@pytest.mark.asyncio
async def test_scheduler_enforces_cost_cap(scheduler_factory, store):
    """Cost cap trips the breaker even if verify would eventually pass."""
    gid = _new_goal(store, "expensive")
    # Cap at $0.005 (5000 micros) → three iterations at 3000 micros each blow past.
    store.update_goal_fields(gid, cost_cap_micros=5_000, max_iterations=20)
    sched, bus = scheduler_factory(
        _CompletingRouter(["a", "b", "c", "d", "e"]),
        [{"passed": False, "reason": "keep going"}] * 20,
    )
    sched.enqueue(gid)
    await asyncio.wait_for(sched._workers[gid], timeout=5.0)

    row = store.get_goal(gid)
    assert row["status"] == GoalStatus.FAILED_FINAL
    assert "cost cap" in (row["last_error"] or "").lower()
    assert row["cost_micros"] >= 5_000


@pytest.mark.asyncio
async def test_enqueue_rejects_double_run(scheduler_factory, store):
    gid = _new_goal(store)
    sched, _ = scheduler_factory(
        _CompletingRouter(["ok"]),
        [{"passed": True, "reason": "done"}],
    )
    sched.enqueue(gid)  # starts running
    second = sched.enqueue(gid)
    assert second.ok is False
    await asyncio.wait_for(sched._workers[gid], timeout=5.0)


@pytest.mark.asyncio
async def test_enqueue_queues_when_at_capacity(scheduler_factory, store, monkeypatch):
    """Exceeding MAX_WORKERS parks the goal in the queue, not on the ground."""
    import goal_scheduler as gs
    # Two goals running at capacity, third one must queue.
    monkeypatch.setattr(gs, "MAX_WORKERS", 1)
    g1 = _new_goal(store, "one")
    g2 = _new_goal(store, "two")

    # Router that hangs so g1 stays in flight.
    hang = asyncio.Event()

    class HangingRouter(_CompletingRouter):
        async def handle(self, prompt, context=None):
            await hang.wait()
            return Result.success("done")

    sched, _ = scheduler_factory(HangingRouter(), [{"passed": True, "reason": "ok"}] * 10)

    r1 = sched.enqueue(g1)
    r2 = sched.enqueue(g2)
    assert r1.value["status"] == RUNNING
    assert r2.value["status"] == QUEUED

    hang.set()
    # Cancel to keep the test fast.
    sched._workers.get(g1) and sched._workers[g1].cancel()


# ── 续跑：轮次是累计的，断电前的逐轮证据不能被覆盖 ──────────────────────────

@pytest.mark.asyncio
async def test_resumed_goal_continues_ordinals_instead_of_overwriting(
        scheduler_factory, store):
    """续跑第一轮必须拿 ordinal=3，不是 1。

    goal_iterations 对 (goal_id, ordinal) 是 UPDATE 幂等，而 worker 以前每次启动
    都把 iteration 重置为 0——于是重启后的第一轮直接覆盖掉断电前第一轮的证据，
    "round 1 做了什么"永久消失，而这张表存在的唯一理由就是回答这个问题。
    """
    gid = _new_goal(store, "resume me")
    store.update_goal_fields(gid, max_iterations=5, iteration=2)
    store.add_goal_iteration(gid, 1, evidence="pre-crash-1", verdict="rejected")
    store.add_goal_iteration(gid, 2, evidence="pre-crash-2", verdict="rejected")

    sched, _bus = scheduler_factory(
        _CompletingRouter(["resumed work"]),
        [{"passed": True, "reason": "done", "suggestions": []}],
    )
    sched.enqueue(gid)
    await asyncio.wait_for(sched._workers[gid], timeout=5.0)

    rows = store.list_goal_iterations(gid)
    ordinals = [r["ordinal"] for r in rows]
    assert ordinals == [1, 2, 3], f"续跑应续号，实际 {ordinals}"
    assert rows[0]["evidence_digest"] == "pre-crash-1", "断电前的证据被覆盖了"
    assert rows[1]["evidence_digest"] == "pre-crash-2"
    assert "resumed work" in rows[2]["evidence_digest"]


@pytest.mark.asyncio
async def test_resumed_goal_with_spent_budget_stops_and_says_so(
        scheduler_factory, store):
    """预算在上次运行里花完了 → 如实失败，而不是又跑满一整轮预算。

    以前 limit 每次启动都重新给满 max_iter，所以一个 10 轮上限的目标只要反复
    重启就能无限跑下去——上限形同虚设（成本上限没这问题，它按累计额判断）。
    """
    gid = _new_goal(store, "already spent")
    store.update_goal_fields(gid, max_iterations=3, iteration=3)

    sched, _bus = scheduler_factory(
        _CompletingRouter(["should not run"]),
        [{"passed": True, "reason": "done", "suggestions": []}],
    )
    sched.enqueue(gid)
    await asyncio.wait_for(sched._workers[gid], timeout=5.0)

    row = store.get_goal(gid)
    assert row["status"] == GoalStatus.FAILED_FINAL
    assert "预算" in (row["last_error"] or ""), row["last_error"]
    assert row["iteration"] == 3, "不该再消耗轮次"
    assert store.list_goal_iterations(gid) == [], "一轮都没跑，不该写迭代行"


# ---------------------------------------------------------------------------
# One live worker per goal（注册表被覆盖 = Pause 失去句柄）
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_spawn_worker_refuses_when_a_live_task_exists(scheduler_factory, store):
    """已有活 worker 时不得再起一个——否则第一个从注册表消失，永远停不下来。

    `_spawn_worker` 里 `self._workers[goal_id] = task` 是覆盖写，而注册表是
    pause()/stop() 唯一的句柄来源。旧行为下第二次 spawn 会让第一个 task 变成
    幽灵：Pause 返回成功，那个 task 却还在跑、还在花预算、还在写文件。
    """
    gid = _new_goal(store, "double spawn")
    sched, _bus = scheduler_factory(_CompletingRouter(["x"]), [])

    forever: asyncio.Future = asyncio.get_running_loop().create_future()
    sched._workers[gid] = forever  # type: ignore[assignment]
    # 累计已超过过期窗口 + 状态是 active：这正是 PATCH {"status":"active"} 之后
    # claim 会放行的那个组合。
    store.update_goal_fields(gid, claimed_at=int(time.time()) - 5000,
                             status=GoalStatus.ACTIVE)

    sched._spawn_worker(gid)

    assert sched._workers[gid] is forever, "注册表条目被覆盖了"
    assert not forever.done()
    forever.cancel()


@pytest.mark.asyncio
async def test_spawned_worker_is_still_reachable_by_pause(scheduler_factory, store):
    """端到端：盲写 active 后再 spawn，Pause 仍能停下唯一那个 worker。"""
    gid = _new_goal(store, "pause reachability")
    sched, _bus = scheduler_factory(_CompletingRouter(["working"]),
                                    [{"passed": False, "reason": "not yet"}])
    store.update_goal_fields(gid, max_iterations=50)
    sched.enqueue(gid)
    first = sched._workers[gid]

    # 等价于 PATCH /api/goals/{id} {"status":"active"} 落到盲写分支
    store.update_goal_fields(gid, status=GoalStatus.ACTIVE)
    sched._spawn_worker(gid)
    assert sched._workers[gid] is first, "第二次 spawn 不该换掉句柄"

    assert (await sched.pause(gid)).ok
    with pytest.raises(asyncio.CancelledError):
        await first


def test_claim_goal_refuses_closed_goals(store):
    """已完成/已取消的目标不得被派活；失败与暂停必须仍可 claim。

    后者是 Retry / Resume 按钮的实际路径（两者都走 POST /run → enqueue →
    claim），claim 失败是静默 return，写成白名单漏一个状态就等于按钮点了没反应。
    """
    for status in (GoalStatus.COMPLETED, GoalStatus.CANCELLED):
        gid = _new_goal(store)
        store.update_goal_fields(gid, status=status, claimed_at=0)
        assert store.claim_goal(gid) is False, f"{status} 不该能被 claim"

    for status in (GoalStatus.FAILED, GoalStatus.FAILED_FINAL, GoalStatus.PAUSED,
                   GoalStatus.QUEUED, GoalStatus.ACTIVE, GoalStatus.STARTED):
        gid = _new_goal(store)
        store.update_goal_fields(gid, status=status, claimed_at=0)
        assert store.claim_goal(gid) is True, f"{status} 必须仍可 claim（Retry/Resume）"


def test_round_record_failure_lands_in_the_ledger(scheduler_factory, tmp_path):
    """写不进轮次行 = 轨迹上少一号。只 print 等于没人知道。

    用独立 Storage 而不是共享单例：这条断言要读事件流，而共享单例的
    event store 会被别的测试关掉（全量跑时表现为 NoneType 上下文管理器）。
    """
    from event_types import EventType
    from storage import Storage

    st = Storage(db_dir=str(tmp_path / "db"))
    try:
        sched, _bus = scheduler_factory(_CompletingRouter(["x"]), [])
        sched._storage = st  # type: ignore[assignment]
        gid = "g-ledger-hole"

        def boom(*a, **k):
            raise RuntimeError("disk full")

        st.add_goal_iteration = boom  # type: ignore[assignment]
        sched._record_round(gid, 2, int(time.time()), "evidence", "pass", "", 0, 0)

        events = st.get_event_store().read_by_dimension("goal_id", gid)
        kinds = [e.payload.get("kind") for e in events
                 if e.event_type == EventType.SYSTEM_ERROR_LOGGED.value]
        assert "goal.round_record_failed" in kinds
        assert [e.payload.get("ordinal") for e in events] == [2]
    finally:
        st.close()


# ---------------------------------------------------------------------------
# Pause has to actually stop the work
# ---------------------------------------------------------------------------

class _HardCancelRouter:
    """Router stub that hangs, and records whether the hard cancel reached it."""

    def __init__(self, live=("execute_command",)):
        self.bus = None
        self.hard_cancels = 0
        self._live = list(live)
        self.started = asyncio.Event()

    def live_call_names(self):
        return list(self._live)

    def cancel_hard(self):
        self.hard_cancels += 1
        killed, self._live = len(self._live), []
        return killed

    async def handle(self, prompt, context=None):
        self.started.set()
        await asyncio.sleep(60)  # never returns on its own
        return Result.success("unreachable")


@pytest.mark.asyncio
async def test_pause_kills_inflight_commands_and_confirms_the_stop(
        scheduler_factory, store):
    """Pause 必须先杀掉在跑的命令，再确认 worker 真停了才回报成功。

    旧实现只 task.cancel() 就立刻回 success：工具跑在线程里，取消 await 不会
    结束子进程——UI 显示"已暂停"，构建还在跑、文件还在写。
    """
    gid = _new_goal(store, "pause must bite")
    router = _HardCancelRouter()
    sched, _bus = scheduler_factory(router, [])
    sched.enqueue(gid)
    task = sched._workers[gid]
    await asyncio.wait_for(router.started.wait(), timeout=2)

    res = await sched.pause(gid)

    assert res.ok, res.error
    assert router.hard_cancels == 1, "没有对在跑的命令下杀手"
    assert res.value["killedCalls"] == 1
    assert task.done(), "回报成功时 worker 必须已经结束"
    assert gid not in sched._workers
    assert store.get_goal(gid)["status"] == GoalStatus.PAUSED
    assert store.get_goal(gid)["claimed_at"] == 0, "停了就要把 claim 放回去"


class _UnstoppableRouter:
    """A turn that swallows the first cancel and keeps working.

    The failure mode Pause has to survive is code that does not honour the stop:
    a suppressed ``CancelledError``, a shielded await, a blocking call the loop
    cannot interrupt. Whatever the cause, Pause must not claim success while the
    turn is still running.
    """

    def __init__(self, seconds=0.6):
        self.bus = None
        self._seconds = seconds
        self.started = asyncio.Event()

    def cancel_hard(self):
        return 0  # nothing killable: no child command, just a turn that ignores us

    def live_call_names(self):
        return ["some_slow_tool"]

    async def handle(self, prompt, context=None):
        self.started.set()
        try:
            await asyncio.sleep(self._seconds)
        except asyncio.CancelledError:
            await asyncio.sleep(self._seconds)  # 吞掉取消，继续干活
        return Result.success("finished anyway")


@pytest.mark.asyncio
async def test_pause_reports_failure_when_the_worker_will_not_stop(
        scheduler_factory, store, monkeypatch):
    """停不下来就要说停不下来：状态落 stop_timeout，而不是谎报 paused。

    旧行为把超时的目标也写成 paused——数据库说已暂停、worker 还在跑，UI 拿
    两条矛盾的信息只能挑一条信。现在超时是第三种状态：resume/run 被拒绝，
    句柄留在名册里，只有 confirm_stopped 确认进程真死透了才回到 paused。
    """
    import goal_scheduler as gs
    monkeypatch.setattr(gs, "PAUSE_GRACE_SEC", 0.05)

    gid = _new_goal(store, "unstoppable worker")
    router = _UnstoppableRouter()
    sched, _bus = scheduler_factory(router, [])
    sched.enqueue(gid)
    task = sched._workers[gid]
    await asyncio.wait_for(router.started.wait(), timeout=2)

    res = await sched.pause(gid)

    assert not res.ok, "worker 还在跑，不能回报成功"
    assert "还没停" in res.error
    assert sched._workers.get(gid) is task, "句柄必须留着，否则再也没人能停它"
    # 关键断言：不是 paused。stop_timeout 才是诚实的答案。
    row = store.get_goal(gid)
    assert row["status"] == GoalStatus.STOP_TIMEOUT
    # worker 还活着，claim 必须还被持有——释放了就等于允许第二个 worker 进场。
    info = store.claim_info(gid)
    assert info["claimed"], "stop_timeout 期间 claim 不能被放掉"

    # stop_timeout 下不得再派活。
    refused = sched.enqueue(gid)
    assert not refused.ok and "confirm-stopped" in refused.error

    # worker 最终被外部掐掉后，confirm_stopped 是唯一回到 paused 的路。
    task.cancel()
    with pytest.raises((asyncio.CancelledError, Exception)):
        await task
    confirmed = await sched.confirm_stopped(gid)
    assert confirmed.ok, confirmed.error
    assert store.get_goal(gid)["status"] == GoalStatus.PAUSED


def test_claim_release_is_owner_conditioned(store):
    """旧句柄不能清掉新持有者的 claim（第 8 条竞态的回归测试）。"""
    gid = _new_goal(store)
    assert store.claim_goal(gid, owner="worker-A", lease_seconds=60) is True
    # 无身份的释放碰不到有主且租约活着的 claim。
    assert store.release_goal(gid) is False
    assert store.get_goal(gid)["claimed_at"] != 0
    # 错误身份同样不行。
    assert store.release_goal(gid, owner="worker-B") is False
    # 正主可以释放；重复释放如实返回 False。
    assert store.release_goal(gid, owner="worker-A") is True
    assert store.release_goal(gid, owner="worker-A") is False


def test_heartbeat_lease_expiry_not_total_runtime(store):
    """健康长跑不该被抢：租约看 heartbeat，不看 claimed_at 的年龄。"""
    gid = _new_goal(store)
    assert store.claim_goal(gid, owner="runner", lease_seconds=600) is True
    # 把 claimed_at 回拨到远超任何静态窗口：总运行时长极长……
    store.update_goal_fields(gid, claimed_at=int(time.time()) - 5000)
    # ……但租约还活着，就不许抢。
    assert store.claim_goal(gid, stale_after=900,
                            owner="thief", lease_seconds=60) is False
    # 心跳续期把租约往前推。
    assert store.renew_goal_claim(gid, "runner", 600) is True
    info = store.claim_info(gid)
    assert info["claimOwner"] == "runner"
    assert info["leaseUntil"] >= int(time.time()) + 500
    # 心跳停止、租约过期之后才可以接管——这是崩溃恢复的路径。
    # 直接改列而不走 update_goal_fields：租约列只允许 claim/renew/release/reap
    # 写，通用写入口会拒绝并大声报错。这里要模拟的正是"进程崩了、没人再续租"。
    _c = store._db("goals")
    _c.execute("UPDATE goals SET lease_until=? WHERE id=?",
               (int(time.time()) - 10, gid))
    _c.commit()
    assert store.claim_goal(gid, stale_after=900,
                            owner="next", lease_seconds=60) is True


def test_stopping_and_stop_timeout_are_unclaimable(store):
    """stopping/stop_timeout 不接受新 claim：停止没确认前不许开第二个 worker。"""
    for status in (GoalStatus.STOPPING, GoalStatus.STOP_TIMEOUT):
        gid = _new_goal(store)
        store.update_goal_fields(gid, status=status, claimed_at=0)
        assert store.claim_goal(gid, owner="x", lease_seconds=30) is False


def test_router_cancel_hard_kills_every_live_call(monkeypatch):
    """Router.cancel_hard 把在飞的 call_id 一个个交给 executors.cancel_call。

    直接绑方法调用，不构造整个 Router：这里要验的就是「登记表 → 杀进程」这一跳。
    """
    import router as router_mod

    killed: list = []
    monkeypatch.setattr(router_mod, "cancel_call",
                        lambda cid: (killed.append(cid), True)[1])

    class _Bare:
        pass

    r = _Bare()
    r._cancelled = asyncio.Event()
    r._live_calls = {"c1": "execute_command", "c2": "write_file"}

    n = router_mod.Router.cancel_hard(r)

    assert n == 2
    assert sorted(killed) == ["c1", "c2"]
    assert r._cancelled.is_set(), "硬取消也必须置上协作取消位，防止再开下一步"
    assert router_mod.Router.live_call_names(r) == ["execute_command", "write_file"]


# ---------------------------------------------------------------------------
# Wave E: fine-grained pipeline stage events（plan → execute → verify）
# 用例按 Ovolve 夹具适配，
# ---------------------------------------------------------------------------

def _stage_events(bus, gid):
    """All stage-bearing goal_state_change payloads emitted for one goal."""
    return [p for k, p in bus.events
            if k == "goal_state_change" and p.get("goal_id") == gid
            and p.get("stage")]


async def _flush_detached_emits():
    """Let the fire-and-forget emit tasks actually run before asserting.

    ``_emit_change`` schedules ``bus.emit`` via call_soon + ensure_future, so
    the events land one loop turn AFTER the worker task completes — an
    assertion right behind ``wait_for`` would read an empty bus.
    """
    await asyncio.sleep(0.05)
    me = asyncio.current_task()
    for t in list(asyncio.all_tasks()):
        if t is me or t.done():
            continue
        try:
            await t
        except (RuntimeError, asyncio.CancelledError):
            pass


@pytest.mark.asyncio
async def test_worker_emits_pipeline_stage_events(scheduler_factory, store):
    """一轮跑通的目标应依次发 plan → execute → verify 三枚阶段事件。

    事件走既有 goal_state_change 通道、只新增 ``stage`` 字段——WS 桥与演化
    等老消费者零改动，前端流水线 UI 发了即生效。
    """
    gid = _new_goal(store, "stage events please")
    store.update_goal_fields(gid, max_iterations=5)
    sched, bus = scheduler_factory(
        _CompletingRouter(["round one work"]),
        [{"passed": True, "reason": "done", "suggestions": []}],
    )
    r = sched.enqueue(gid)
    assert r.ok, r.error
    await asyncio.wait_for(sched._workers[gid], timeout=5.0)
    await _flush_detached_emits()

    stage_events = _stage_events(bus, gid)
    assert [p["stage"] for p in stage_events] == ["plan", "execute", "verify"]
    for p in stage_events:
        assert p["status"] == RUNNING, "阶段是 running 的细分，不是新状态"
        assert isinstance(p["ts"], int) and p["ts"] > 0, "载荷要带时间戳"
        assert "session_id" in p, "WS 桥按 session 路由，这个字段不能丢"
    verify_event = stage_events[-1]
    assert verify_event["iteration"] == 1
    assert verify_event["max_iterations"] == 5


@pytest.mark.asyncio
async def test_stage_events_cycle_execute_verify_each_round(scheduler_factory, store):
    """验证不过就再来一轮：execute/verify 每轮成对出现，plan 只在开头一次。"""
    gid = _new_goal(store, "three rounds")
    store.update_goal_fields(gid, max_iterations=5)
    sched, bus = scheduler_factory(
        _CompletingRouter(["alpha", "bravo", "charlie"]),
        [{"passed": False, "reason": "not yet", "suggestions": []},
         {"passed": False, "reason": "not yet", "suggestions": []},
         {"passed": True, "reason": "done", "suggestions": []}],
    )
    r = sched.enqueue(gid)
    assert r.ok, r.error
    await asyncio.wait_for(sched._workers[gid], timeout=5.0)
    await _flush_detached_emits()

    stages = [p["stage"] for p in _stage_events(bus, gid)]
    assert stages == ["plan", "execute", "verify",
                      "execute", "verify", "execute", "verify"]
    executes = [p for p in _stage_events(bus, gid) if p["stage"] == "execute"]
    assert [p["iteration"] for p in executes] == [1, 2, 3], "轮次要随事件递增"


@pytest.mark.asyncio
async def test_emit_stage_swallows_sync_emit_failures(scheduler_factory, store,
                                                      monkeypatch):
    """_emit_stage 的 fail-open 层：同步炸掉也绝不上抛。"""
    gid = _new_goal(store, "sync stage fail")
    sched, _bus = scheduler_factory(_CompletingRouter(["ok"]), [])
    original = sched._emit_change

    def flaky(goal_id, status, **extra):
        if "stage" in extra:
            raise RuntimeError("payload blew up")
        return original(goal_id, status, **extra)

    monkeypatch.setattr(sched, "_emit_change", flaky)
    # 不得抛异常；普通状态事件也不受影响。
    sched._emit_stage(gid, "execute", iteration=1, max_iterations=3)


@pytest.mark.asyncio
async def test_stage_event_failure_does_not_block_the_worker(scheduler_factory,
                                                             store):
    """fail-open 端到端：阶段事件发不出去，目标照样跑完。

    阶段事件是纯信息。分离派发的 emit 任务在旁边炸掉，worker 的状态机
    （含终态 emit）必须完全无感。
    """
    gid = _new_goal(store, "stage events fail open")
    sched, _bus = scheduler_factory(
        _CompletingRouter(["ok"]),
        [{"passed": True, "reason": "done", "suggestions": []}],
    )

    class _StageExplodingBus:
        """阶段事件一律炸；普通状态事件照常记录。"""
        def __init__(self):
            self.stage_failures = 0
            self.ok_events: list = []

        async def emit(self, kind, payload):
            if payload.get("stage"):
                self.stage_failures += 1
                raise RuntimeError("bus down")
            self.ok_events.append((kind, payload))

    exploding = _StageExplodingBus()
    sched._bus = exploding  # type: ignore[assignment]
    r = sched.enqueue(gid)
    assert r.ok, r.error
    await asyncio.wait_for(sched._workers[gid], timeout=5.0)
    # 等分离的 emit 任务真正跑完，再回收它们（预期中的）异常，避免
    # "exception was never retrieved" 噪音。
    await _flush_detached_emits()

    assert exploding.stage_failures == 3, "plan/execute/verify 三枚都尝试过发送"
    assert store.get_goal(gid)["status"] == GoalStatus.COMPLETED
    assert any(p.get("status") == "completed" for _k, p in exploding.ok_events)
