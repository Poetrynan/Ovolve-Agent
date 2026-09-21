"""Golden-flow tests for durable execution (P0/P1 收口的验收线).

These are product-level flows, not unit corners:

* a killed subprocess-isolated tool settles its side effect as UNKNOWN
  (never failed), and the resumed-run advisory tells the model to verify;
* a corrupt checkpoint blocks the worker from ever entering running
  (preflight contract);
* a failing migration rolls back to its backup, boots in compat mode, defers
  the step, and an explicit retry completes the upgrade;
* LearningBundles tie Memory proposals and Skill candidates to ONE evidence
  set — including the NO_OP case ("why nothing was learned");
* the backend instance lock refuses a second holder and adopts dead ones.
"""
import asyncio
import json
import os
import sys
import textwrap
import time

import pytest

from result import Result


# ---------------------------------------------------------------------------
# Subprocess isolation: killed tool → unknown side effect
# ---------------------------------------------------------------------------

@pytest.fixture
def isolated_registry(tmp_path):
    """A fresh registry holding one subprocess-isolated tool that hangs."""
    from tools import ToolDef, ToolRegistry

    mod_name = f"_tmp_hang_tool_{os.getpid()}"
    mod_path = str(tmp_path / f"{mod_name}.py")
    with open(mod_path, "w", encoding="utf-8") as fh:
        fh.write(textwrap.dedent('''
            """Temporary test fixture: a hanging subprocess-isolated tool."""
            import time
            from result import Result


            def hang_then_touch(args, ctx):
                target = args.get("target") or ""
                if target:
                    with open(target, "a", encoding="utf-8") as fh:
                        fh.write("partial\\n")
                time.sleep(float(args.get("seconds") or 30))
                return Result.success("finished")
        '''))
    orig_path = list(sys.path)
    orig_py_path = os.environ.get("PYTHONPATH", "")
    sys.path.insert(0, str(tmp_path))
    os.environ["PYTHONPATH"] = (str(tmp_path) + os.pathsep + orig_py_path).rstrip(os.pathsep)
    try:
        for mod in [m for m in list(sys.modules) if m == mod_name]:
            del sys.modules[mod]
        __import__(mod_name)
        fn = getattr(sys.modules[mod_name], "hang_then_touch")

        reg = ToolRegistry()
        reg.register(ToolDef(
            "hang_then_touch", "test tool",
            {"type": "object", "properties": {
                "target": {"type": "string"},
                "seconds": {"type": "integer"},
            }, "required": []},
            fn, domain="file", risk_level="medium",
            requires_subprocess=True,
        ))
        yield reg, mod_name
    finally:
        sys.path[:] = orig_path
        if orig_py_path:
            os.environ["PYTHONPATH"] = orig_py_path
        else:
            os.environ.pop("PYTHONPATH", None)
        try:
            os.unlink(mod_path)
        except OSError:
            pass


def test_subprocess_plan_and_autonomous_guard(isolated_registry):
    """Contract derivation: declared isolation wins; thread fallback refuses."""
    import activity_exec

    reg, _mod = isolated_registry
    tool = reg.get("hang_then_touch")
    plan = reg.execution_plan(tool)
    assert plan["class"] == activity_exec.EXEC_SUBPROCESS
    assert plan["contract"] == activity_exec.CANCEL_KILLABLE
    assert plan["interruptible"] is True

    # An unresolvable callable that wants isolation degrades HONESTLY.
    closure_based = type("T", (), {})()
    closure_based.name = "closure_tool"
    closure_based.execute = (lambda args, ctx: Result.success("x"))
    closure_based.risk_level = "critical"
    closure_based.requires_subprocess = True
    closure_based.manages_own_killable_child = False
    plan2 = activity_exec.classify_execution(closure_based)
    assert plan2["class"] == activity_exec.EXEC_THREAD
    assert plan2["contract"] == activity_exec.CANCEL_ABANDONED_THREAD
    assert plan2["interruptible"] is False


@pytest.mark.asyncio
async def test_killed_subprocess_reports_unknown_effect(
        isolated_registry, tmp_path):
    """超时被杀的子进程工具：结果失败、effect unknown，账本不得记成 failed。

    这是"重启后不把事情做两遍"的地基：failed 会读作"安全重做"，而子进程
    死前可能已经写了半个文件。
    """
    import activity_exec
    from storage import Storage

    reg, _mod = isolated_registry
    tool = reg.get("hang_then_touch")
    plan = reg.execution_plan(tool)

    st = Storage(db_dir=str(tmp_path / "db"))
    try:
        target = tmp_path / "artifact.txt"
        ctx = {"call_id": "call-unknown-1",
               "workspace_root": str(tmp_path)}
        t0 = time.time()
        result = await asyncio.wait_for(
            asyncio.to_thread(
                activity_exec.run_sync_in_subprocess,
                plan["ref"], {"target": str(target), "seconds": 60}, ctx,
                timeout=1.0, call_id="call-unknown-1",
            ),
            timeout=1.0 + activity_exec.KILL_GRACE_SEC + 10,
        )
        assert not result.ok
        assert (result.meta or {}).get("effect_status") == "unknown"
        assert result.meta.get("timed_out") is True
        assert time.time() - t0 < 20, "杀树没有生效——进程挂住了测试"
        # 死前的部分效果真实存在——这正是 unknown 而不是 failed 的原因。
        if target.exists():
            assert "partial" in target.read_text(encoding="utf-8")

        # Mirror the router's settle rule: forced unknown beats derived failed.
        import hashlib
        args_hash = hashlib.sha256(json.dumps(
            {"target": str(target), "seconds": 60}, sort_keys=True).encode()
        ).hexdigest()
        st.record_side_effect("sess-x", "goal-x", "call-unknown-1",
                              "hang_then_touch", args_hash)
        forced = ("unknown"
                  if (not result.ok
                      and str((result.meta or {}).get("effect_status")) == "unknown")
                  else "")
        st.settle_side_effect("call-unknown-1", ok=bool(result.ok),
                              result_preview=str(result.error),
                              status=forced)
        rows = st.unknown_side_effects("goal-x")
        assert [r["status"] for r in rows] == ["unknown"]
        completed = st.completed_side_effects("goal-x")
        assert completed == []

        # And the resumed-run advisory names it as verify-first, not redo.
        from recovery import render_unknown_side_effects
        advisory = render_unknown_side_effects("goal-x", st)
        assert "核对" in advisory
    finally:
        try:
            st.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Checkpoint preflight blocks a corrupt resume
# ---------------------------------------------------------------------------

def _bare_scheduler(store, tmp_path):
    """GoalScheduler wired to a stub router/bus over a private Storage."""
    from goal_scheduler import GoalScheduler

    class _Bus:
        async def emit(self, kind, payload):
            pass

    class _Router:
        bus = None
        workspace = ""

        async def handle(self, prompt, context=None):
            return Result.success("should never run")

    sched = GoalScheduler(_Router(), _Bus())
    sched._storage = store
    return sched


@pytest.mark.asyncio
async def test_corrupt_checkpoint_blocks_running(tmp_path):
    """预检失败的目标不得进入 running，更不许跑掉一轮预算。"""
    from goal_manager import GoalStatus
    from storage import Storage

    st = Storage(db_dir=str(tmp_path / "db"))
    try:
        gid = "g-preflight-fail"
        st.save_goal(gid, "resume me", GoalStatus.STARTED, 2, "", "")
        # A checkpoint claiming a seq that does not exist in any stream —
        # exactly what a truncated/rewritten ledger looks like.
        st.trace_event(
            session_id="sess-pf",
            event_type="system.checkpoint_created",
            payload={
                "goal_id": gid,
                "session_id": "sess-pf",
                "last_event_seq": 10 ** 9,
                "retained_tail": [],
                "completed_side_effects": [],
                "unresolved_side_effects": [],
                "goal_snapshot": {},
            },
            importance="critical",
            goal_id=gid,
        )

        sched = _bare_scheduler(st, tmp_path)
        row = st.get_goal(gid)
        ok, why, _block = await sched._preflight_checkpoint(gid, row)
        assert ok is False
        assert "预检" in why or "seq" in why

        # And the full worker honours it: fail fast, zero rounds burned.
        await sched._run_worker(gid)
        final = st.get_goal(gid)
        assert final["status"] == GoalStatus.FAILED_FINAL
        assert "预检" in (final["last_error"] or "")
        assert st.list_goal_iterations(gid) == []
    finally:
        try:
            st.close()
        except Exception:
            pass


@pytest.mark.asyncio
async def test_healthy_resume_passes_preflight_and_announces_it(tmp_path):
    """健康续跑：预检通过、事件落地、账本结论进入提示词。"""
    from goal_manager import GoalStatus
    from storage import Storage

    st = Storage(db_dir=str(tmp_path / "db"))
    try:
        gid = "g-preflight-ok"
        sid = "sess-pf-ok"
        st.create_session(sid, title="t")
        st.add_message(sid, "user", "please do the thing")
        st.save_goal(gid, "resume me", GoalStatus.STARTED, 1, sid, "")
        st.record_side_effect(sid, gid, "call-ok-1", "write_file", "hash1")
        st.settle_side_effect("call-ok-1", ok=True, result_preview="written")
        from checkpoint import build_checkpoint, load_latest_checkpoint
        cp = build_checkpoint(st, session_id=sid, goal_id=gid, run_id="r1",
                              turn_state="paused", scope=f"{gid}:paused")
        assert cp is not None
        picked = load_latest_checkpoint(st, goal_id=gid)
        assert picked is not None
        assert str(picked.get("goal_id")) == gid

        sched = _bare_scheduler(st, tmp_path)
        row = st.get_goal(gid)
        ok, why, block = await sched._preflight_checkpoint(gid, row)
        assert ok is True, why
        assert "不要原样重做" in block
        events = st.get_event_store().read_by_dimension("goal_id", gid)
        resumed = [e for e in events
                   if e.event_type == "goal.resumed_from_checkpoint"]
        assert len(resumed) == 1
        assert resumed[0].payload.get("dont_redo_count") == 1
    finally:
        try:
            st.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Migration failure → rollback → compat → explicit retry
# ---------------------------------------------------------------------------

def test_migration_failure_rolls_back_and_defers(tmp_path, monkeypatch):
    """迁移失败三层恢复：回滚成功→compat 模式；重试成功→升级完成。"""
    from storage import Storage

    orig_mig = Storage._mig_0001_subagent_runs
    calls = {"n": 0}

    def _boom(self):
        calls["n"] += 1
        raise RuntimeError("simulated dirty data")

    monkeypatch.setattr(Storage, "_mig_0001_subagent_runs", _boom)

    # 构造即触发迁移路径；失败被三层恢复接住，构造本身绝不抛。
    try:
        st = Storage(db_dir=str(tmp_path / "db"))
    except Exception as exc:  # pragma: no cover - 不应走到这里
        pytest.fail(f"migration failure must not crash boot: {exc}")

    assert st.recovery_mode == "compat"
    ms = st.migration_status()
    deferred_ids = [d.get("id") for d in ms.get("deferred") or []]
    assert "0001_subagent_runs" in deferred_ids
    assert os.path.isdir(os.path.join(str(tmp_path / "db"), "backups"))

    # 升级未完成必须可见（health/repair 面板读的就是这个）。
    rm = st.get_config("migration.recovery_mode") or {}
    assert rm.get("mode") == "compat"
    assert rm.get("failedMigration") == "0001_subagent_runs"

    # 下一次启动不再自动踩同一颗雷：pending 里仍列着它，但不会在构造时执行。
    calls_before = calls["n"]
    st2 = Storage(db_dir=str(tmp_path / "db"))
    assert calls["n"] == calls_before, "deferred 迁移不该在下次启动自动重试"

    # 显式修复：撤掉炸弹后重试，升级闭环、compat 撤销。
    monkeypatch.setattr(Storage, "_mig_0001_subagent_runs", orig_mig)
    res = st2.retry_deferred_migration("0001_subagent_runs")
    assert res["ok"] is True, res
    assert st2.recovery_mode == ""
    cleared = (st2.get_config("migration.recovery_mode") or {}).get("mode")
    assert cleared == "", "重试成功后 compat 标志必须清掉"
    assert "0001_subagent_runs" in [
        r["id"] for r in st2.migration_status()["applied"]]
    try:
        st.close()
        st2.close()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# LearningBundle: one experience, two projections
# ---------------------------------------------------------------------------

def test_learning_bundle_links_memory_and_skill(tmp_path):
    from evolution import (
        EvolutionObservation, EvolutionEngine, EvolutionStore,
        DECISION_BOTH, DECISION_NO_OP,
    )

    store = EvolutionStore(db_path=str(tmp_path / "evo.db"))
    engine = EvolutionEngine(store=store, mode="active",
                             workspace_root=str(tmp_path))
    exp_ids = ["exp-1", "exp-2"]

    obs = EvolutionObservation(
        goal_id="g-bundle", run_id="r-bundle", session_id="s-bundle",
        skill_experiences=list(exp_ids),
        new_facts=["项目统一使用 pnpm 作为包管理器"],
        reusable_steps=["build 流程三步走通"],
        validator_result={"status": "completed"},
        decision=DECISION_BOTH, reason="facts + steps", created_at=time.time(),
    )
    made = {"memoryProposals": ["prop-a", "prop-b"],
            "skillCandidate": "cand-1"}
    learning_id = engine.emit_learning_bundle(obs, made, turn_ids=["t1", "t2"])

    bundles = store.bundles_for_goal("g-bundle")
    assert len(bundles) == 1
    b = bundles[0]
    assert b["learningId"] == learning_id
    assert b["decision"] == DECISION_BOTH
    assert b["memoryProposalIds"] == ["prop-a", "prop-b"]
    assert b["skillCandidateId"] == "cand-1"
    # 共享证据：两类产物引用的是同一组经验与轮次。
    assert b["experienceIds"] == exp_ids
    assert b["turnIds"] == ["t1", "t2"]

    # 审批联动：提案被拒 → bundle 的 user_verdict 记录人的裁决。
    from evolution import Proposal
    p = Proposal(id="prop-a", signature="sig", kind="learned_fact",
                 tool_name="", target_file="MEMORY.md",
                 draft="- x", rationale="", hits=1, status="pending",
                 created_at=time.time())
    store.insert_proposal(p)
    engine.decide("prop-a", accept=False)
    refreshed = store.bundles_for_goal("g-bundle")[0]
    assert refreshed["userVerdict"] == "rejected"

    # NO_OP 也留档："为什么没学"是审计问题，不是可以静默跳过的分支。
    noop_obs = EvolutionObservation(
        goal_id="g-noop", decision=DECISION_NO_OP,
        reason="偶发失败：一次失败不配固化成任何长期改变",
        created_at=time.time())
    engine.emit_learning_bundle(noop_obs, {})
    noop_rows = store.bundles_for_goal("g-noop")
    assert len(noop_rows) == 1
    assert noop_rows[0]["decision"] == DECISION_NO_OP
    assert "偶发失败" in noop_rows[0]["rationale"]
    store.close()


# ---------------------------------------------------------------------------
# Instance lock
# ---------------------------------------------------------------------------

def test_instance_lock_refuses_second_holder(tmp_path):
    import instance_lock

    first = instance_lock.acquire(str(tmp_path))
    assert first["acquired"] is True
    try:
        second = instance_lock.acquire(str(tmp_path))
        assert second["acquired"] is False
        assert str(os.getpid()) in second["reason"]
        assert second["existing"]["pid"] == os.getpid()

        status = instance_lock.status()
        assert status["held"] is True
    finally:
        assert instance_lock.release() is True

    # 释放之后可以再次获取。
    again = instance_lock.acquire(str(tmp_path))
    assert again["acquired"] is True
    instance_lock.release()


def test_instance_lock_adopts_dead_holder(tmp_path):
    import instance_lock

    lock_path = os.path.join(str(tmp_path), instance_lock.LOCK_FILE_NAME)
    with open(lock_path, "w", encoding="utf-8") as fh:
        json.dump({"pid": 0, "started_at": 1, "argv0": "dead"}, fh)
    got = instance_lock.acquire(str(tmp_path))
    assert got["acquired"] is True
    assert "took over" in (got.get("reason") or "")
    instance_lock.release()
