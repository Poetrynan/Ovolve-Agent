"""Step F 切片：Goal 断电重启闭环——真实组件模拟，不 mock 恢复路径。

验收链对应纠偏文档 Step F：启动 → 执行若干步 → 副作用落账 → 进程消失
（关闭实例模拟断电）→ 重载 → 状态恢复 → 续跑提示只含剩余步骤与已落地
副作用（不重做）→ 收敛后验证结论与状态同源落库。
"""
import json

import goal_plan
from event_types import EventType
from recovery import recover_interrupted_goals, render_completed_side_effects
from storage import Storage


def seed_running_goal(st, monkeypatch=None, sid="sess-f", gid="goal-f1"):
    # goal_plan 走模块级 get_storage()；不重定向的话计划会写进进程默认库，
    # 与本测试的 tmp 库脑裂——这正是要在测试里堵住的第一类假阳性。
    if monkeypatch is not None:
        monkeypatch.setattr(goal_plan, "get_storage", lambda: st)
    st.create_session(sid, "restart")
    gc = st._db("goals")
    gc.execute(
        "INSERT INTO goals (id, description, status, session_id, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?)",
        (gid, "发布新版本", "running", sid, 1, 1),
    )
    gc.commit()
    assert goal_plan.save_plan(gid, [
        {"title": "跑通测试套件", "status": "completed"},
        {"title": "更新变更日志", "status": "pending"},
        {"title": "打 tag 并推送", "status": "pending"},
    ]), "计划必须真实落到目标行上"


def test_crash_resume_continues_without_redoing_side_effects(tmp_path, monkeypatch):
    db_dir = str(tmp_path / "db")
    # ── 第一次"进程"：目标运行中，一步已完成，两个副作用落地，一个悬空 ──
    st1 = Storage(db_dir=db_dir)
    try:
        seed_running_goal(st1, monkeypatch)
        st1.record_side_effect("sess-f", "goal-f1", "call-1", "write_file", "a" * 64)
        st1.settle_side_effect("call-1", ok=True, result_preview="wrote CHANGELOG.md")
        st1.record_side_effect("sess-f", "goal-f1", "call-2", "run_shell", "b" * 64)
        st1.settle_side_effect("call-2", ok=True, result_preview="tests passed")
        # call-3 只登记未 settle——进程恰好死在它执行途中
        st1.record_side_effect("sess-f", "goal-f1", "call-3", "run_shell", "c" * 64)
    finally:
        st1.close()  # ← 这就是断电

    # ── 第二次"进程"启动 ────────────────────────────────────────────────
    st2 = Storage(db_dir=db_dir)
    monkeypatch.setattr(goal_plan, "get_storage", lambda: st2)
    try:
        demoted = recover_interrupted_goals(st2)
        assert [g["id"] for g in demoted] == ["goal-f1"]
        row = st2.get_goal("goal-f1")
        assert row["status"] == "paused"
        assert "Interrupted" in (row.get("last_error") or "")

        kinds = [e.event_type for e in st2.get_event_store().read_stream("sess-f")]
        assert EventType.SYSTEM_RECOVERY_INITIATED.value in kinds, \
            "重启恢复必须留审计痕迹"

        # 续跑提示原料一：已落地副作用清单（悬空的 call-3 不得谎报为已完成）
        advisory = render_completed_side_effects("goal-f1", st2)
        assert "write_file" in advisory and "run_shell" in advisory
        assert "do NOT redo" in advisory
        landed = {e["call_id"] for e in st2.completed_side_effects("goal-f1")}
        assert landed == {"call-1", "call-2"}

        # 续跑提示原料二：只剩未完成步骤——已完成工作不得再进清单
        remaining = goal_plan.render_unfinished(goal_plan.load_plan("goal-f1"))
        assert "更新变更日志" in remaining and "打 tag" in remaining
        assert "跑通测试套件" not in remaining

        # ── 续跑收敛：剩余步骤完成，机器验证通过，状态与证据同源落库 ──
        new_items, flipped = goal_plan.apply_completion(
            goal_plan.load_plan("goal-f1"), None, all_done=True)
        assert flipped == 2
        goal_plan.save_plan("goal-f1", new_items)
        st2.update_goal_fields(
            "goal-f1", status="completed",
            verification_result=json.dumps({"reason": "all steps verified"}),
        )
        final = st2.get_goal("goal-f1")
        assert final["status"] == "completed"
        verdict = json.loads(final["verification_result"])
        assert verdict["reason"] == "all steps verified"
        # 观察层能读到机器验证结论
        from evolution import build_goal_observation
        obs = build_goal_observation("goal-f1", st2)
        assert obs.validator_result["machineVerified"] is True
        assert obs.validator_result["status"] == "completed"
    finally:
        st2.close()


def test_recovery_is_idempotent_and_leaves_paused_goals_alone(tmp_path, monkeypatch):
    db_dir = str(tmp_path / "db")
    st1 = Storage(db_dir=db_dir)
    try:
        seed_running_goal(st1, monkeypatch, gid="goal-x")
    finally:
        st1.close()

    st2 = Storage(db_dir=db_dir)
    try:
        assert len(recover_interrupted_goals(st2)) == 1
        # 用户手动恢复成 running 再崩溃？不——第二次启动时它已是 paused，
        # paused 不是运行态，二次恢复不得碰它。
        assert recover_interrupted_goals(st2) == []
        assert st2.get_goal("goal-x")["status"] == "paused"
    finally:
        st2.close()


def test_advisory_failure_is_told_to_the_model(tmp_path, monkeypatch):
    """副作用清单读不出来时，续跑提示必须说出来，而不是静默少一段。

    以前两处 advisory 各自 `except: pass`，模型在信息缺失的情况下继续，并不
    知道自己不知道——它会照原计划把已经生效的操作再做一遍。
    """
    import asyncio

    import recovery
    from goal_manager import GoalManager

    st = Storage(db_dir=str(tmp_path / "db"))
    try:
        seed_running_goal(st, monkeypatch, gid="goal-adv")

        def boom(*a, **k):
            raise RuntimeError("db locked")

        monkeypatch.setattr(recovery, "render_completed_side_effects", boom)
        monkeypatch.setattr(recovery, "render_unknown_side_effects", boom)

        mgr = GoalManager()
        mgr.storage = st
        res = asyncio.run(mgr.continue_goal("goal-adv"))

        assert res.ok, res.error
        reminder = res.value["system_reminder"]
        assert "已落地副作用清单读取失败" in reminder
        assert "未结算副作用清单读取失败" in reminder
    finally:
        st.close()


def test_auto_rehydrate_and_minimal_checkpoint_prompt(tmp_path, monkeypatch):
    """Verify GoalScheduler auto rehydration and minimal Checkpoint Snapshot prompt."""
    import asyncio
    from goal_scheduler import GoalScheduler

    db_dir = str(tmp_path / "db")
    st1 = Storage(db_dir=db_dir)
    try:
        seed_running_goal(st1, monkeypatch, gid="goal-auto-1")
        st1.record_side_effect("sess-f", "goal-auto-1", "c-1", "write_file", "x" * 64)
        st1.settle_side_effect("c-1", ok=True, result_preview="wrote config.py")
    finally:
        st1.close()

    # Second process:
    st2 = Storage(db_dir=db_dir)
    monkeypatch.setattr(goal_plan, "get_storage", lambda: st2)
    try:
        # Checkpoint prompt assembly
        prompt = goal_plan.build_resume_checkpoint_prompt("goal-auto-1", storage=st2)
        assert "目标断点续跑快照" in prompt
        assert "write_file" in prompt
        assert "do NOT redo" in prompt
        assert "更新变更日志" in prompt
        assert "严禁重复执行已落地的操作" in prompt

        # GoalScheduler rehydrate
        sched = GoalScheduler(storage=st2, bus=None)
        rehydrated = sched.rehydrate_interrupted_goals(auto_resume=False)
        assert "goal-auto-1" in rehydrated
        row = st2.get_goal("goal-auto-1")
        assert row["status"] == "paused"
    finally:
        st2.close()
