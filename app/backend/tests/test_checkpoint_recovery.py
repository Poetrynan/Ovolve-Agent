"""Phase 2 收口：自包含 checkpoint + 审批等待/崩溃两类恢复语义。

真实组件：Storage + TurnStateMachine + checkpoint 模块，关闭实例模拟断电。
"""
from turn_state import TurnStateMachine, TurnStatus
from checkpoint import build_checkpoint, resume_from_checkpoint
from storage import Storage


def make_storage(tmp_path):
    return Storage(db_dir=str(tmp_path / "db"))


def seed_session_with_side_effect(st, sid="sess-ck", goal_id="goal-ck"):
    st.create_session(sid, "checkpoint")
    if goal_id:
        gc = st._db("goals")
        gc.execute(
            "INSERT INTO goals (id, description, status, session_id, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?)",
            (goal_id, "t", "running", sid, 1, 1),
        )
        gc.commit()
        # 留下真实对话尾：checkpoint 的 retained_tail 从这里取
        st.add_message(sid, "user", "把 README 标题改成 Ovolve")
        st.add_message(sid, "assistant", "已修改并验证完成。")
        st.record_side_effect(sid, goal_id, "call-done", "write_file", "a" * 64)
        st.settle_side_effect("call-done", ok=True)


# ── checkpoint 内容与幂等 ──────────────────────────────────────────────────

def test_checkpoint_is_self_contained_and_idempotent(tmp_path):
    st = make_storage(tmp_path)
    try:
        seed_session_with_side_effect(st)
        cp = build_checkpoint(
            st, session_id="sess-ck", goal_id="goal-ck",
            run_id="run-1", turn_state="running", scope="goal-ck:1",
        )
        assert cp is not None
        assert cp["last_event_seq"] > 0 and cp["last_event_id"]
        assert cp["completed_side_effects"] == ["call-done"], \
            "checkpoint 必须能回答'哪些副作用不能重做'"
        assert cp["goal_snapshot"]["status"] == "running"
        # §5.2 收口：保留尾部 + 确定性快照指纹
        assert len(cp["retained_tail"]) >= 2, "恢复后模型首先看到的对话必须在场"
        assert cp["context_snapshot_id"].startswith("ctx:")
        # 内容不变 → 指纹不变（确定性）
        cp2 = build_checkpoint(
            st, session_id="sess-ck", goal_id="goal-ck",
            run_id="run-1", turn_state="running", scope="goal-ck:2",
        )
        assert cp2["context_snapshot_id"] == cp["context_snapshot_id"], \
            "同样的尾部内容必须得到同样的快照指纹"

        kinds = [e.event_type for e in st.get_event_store().read_stream("sess-ck")]
        assert "system.checkpoint_created" in kinds

        # 幂等保证的正确形态：同一个时刻（同一幂等键）重放不会产生第二条事实。
        # 落卡本身会推进流的 seq，所以再次构建是"新时刻"，出新事件是正确行为；
        # 这里直接对存储层验证同一键的幂等性。
        n_before = len(st.get_event_store().read_stream("sess-ck"))
        st.trace_event(
            session_id="sess-ck", event_type="system.checkpoint_created",
            payload={"replay": True}, importance="critical",
            idempotency_key=f"checkpoint:goal-ck:1:{cp['last_event_seq']}",
            goal_id="goal-ck",
        )
        n_mid = len(st.get_event_store().read_stream("sess-ck"))
        st.trace_event(
            session_id="sess-ck", event_type="system.checkpoint_created",
            payload={"replay": True}, importance="critical",
            idempotency_key=f"checkpoint:goal-ck:1:{cp['last_event_seq']}",
            goal_id="goal-ck",
        )
        n_after = len(st.get_event_store().read_stream("sess-ck"))
        assert n_mid == n_after, "同一幂等键的重放不得产生新事实"
        assert n_after >= n_before
    finally:
        st.close()


# ── 审批等待中断电：状态存活、不被陈旧清理误杀、可恢复；副作用账不动 ────────

def test_waiting_user_survives_restart_and_resumes(tmp_path):
    db_dir = str(tmp_path / "db")
    st1 = make_storage(tmp_path)
    try:
        seed_session_with_side_effect(st1)
        m = TurnStateMachine(st1)
        assert m.transition("sess-ck", TurnStatus.RUNNING)
        assert m.transition("sess-ck", TurnStatus.WAITING_USER) is True
    finally:
        st1.close()  # 断电

    st2 = Storage(db_dir=db_dir)
    try:
        m2 = TurnStateMachine(st2)
        # 等待人工输入的状态必须原样活过重启——它等的不是上一个进程
        assert m2.current("sess-ck") is TurnStatus.WAITING_USER
        # 开机陈旧清理只翻 running，不碰 waiting_user
        m2.reset_stale()
        assert m2.current("sess-ck") is TurnStatus.WAITING_USER
        # 恢复路径合法：waiting_user → running
        assert m2.transition("sess-ck", TurnStatus.RUNNING) is True
        # 状态恢复绝不碰副作用账本——已完成的还是已完成
        assert (st2.completed_side_effects("goal-ck")[0]["call_id"]) == "call-done"
    finally:
        st2.close()


# ── running 中崩溃：开机翻 error（不可恢复的回合），同样不动副作用账 ────────

def test_stale_running_becomes_error_on_restart(tmp_path):
    db_dir = str(tmp_path / "db")
    st1 = make_storage(tmp_path)
    try:
        seed_session_with_side_effect(st1)
        m = TurnStateMachine(st1)
        assert m.transition("sess-ck", TurnStatus.RUNNING) is True
    finally:
        st1.close()

    st2 = Storage(db_dir=db_dir)
    try:
        m2 = TurnStateMachine(st2)
        assert m2.reset_stale() >= 1
        assert m2.current("sess-ck") is TurnStatus.ERROR
        # error → running 是白名单内的显式恢复路径（§5.1），用户点恢复即走它
        assert m2.transition("sess-ck", TurnStatus.RUNNING) is True
        assert st2.completed_side_effects("goal-ck")[0]["call_id"] == "call-done"
    finally:
        st2.close()


# ── §5.3 resume：从 checkpoint 只读重建恢复现场 ─────────────────────────────

def test_resume_rebuilds_context_from_checkpoint(tmp_path):
    st = make_storage(tmp_path)
    try:
        seed_session_with_side_effect(st)
        cp = build_checkpoint(
            st, session_id="sess-ck", goal_id="goal-ck",
            run_id="run-1", turn_state="paused", scope="goal-ck:r",
        )
        res = resume_from_checkpoint(st, cp)
        assert res["ok"] is True, res["problems"]
        assert len(res["messages"]) >= 2, "尾部消息必须重建回来"
        assert res["dont_redo"] == ["call-done"], "不得重做清单原样上抛"
        assert res["goal_snapshot"]["status"] == "running"

        # 流被截断/分支移动：seq 不在流中 → 拒绝盲续
        broken = dict(cp)
        broken["last_event_seq"] = 99999
        res2 = build_checkpoint.__globals__["resume_from_checkpoint"](st, broken)
        assert res2["ok"] is False
        assert any("不在当前流中" in p for p in res2["problems"])

        # 主源断言：消息事件在场时，重建走事件投影（§5.3 replay 正源）
        assert res["rebuild_source"] == "events"

        # 尾部消息消失的检测位于存储兜底路径：造一个无消息事件的会话，
        # 手工塞入指向不存在内容的 retained_tail
        st.create_session("sess-ghost", "ghost")
        seqs = [e.seq for e in st.get_event_store().read_stream("sess-ghost")]
        ghost = {"session_id": "sess-ghost",
                 "last_event_seq": max(seqs) if seqs else 0,
                 "retained_tail": [{"role": "user",
                                    "content": "这条消息早已不存在"}],
                 "completed_side_effects": [], "goal_snapshot": {}}
        res3 = resume_from_checkpoint(st, ghost)
        assert any("找不到" in p_ for p_ in res3["problems"]), \
            "兜底路径必须如实报告尾部不可寻"
    finally:
        st.close()


def test_checkpoint_separates_unknown_effects_from_landed_ones(tmp_path):
    """结果未知的副作用必须单独成列，不能混进"别重做"。

    这两条指令在一个可能没生效的写操作面前是相反的：landed 说"跳过"，
    unknown 说"先核对"。以前 checkpoint 只记 landed，未知态在恢复现场里
    完全不可见——而看不见就会被原样重做。
    """
    st = make_storage(tmp_path)
    try:
        seed_session_with_side_effect(st)
        st.record_side_effect("sess-ck", "goal-ck", "call-mid", "shell", "b" * 64)
        st.settle_side_effect("call-mid", ok=False, status="unknown")
        st.record_side_effect("sess-ck", "goal-ck", "call-hang", "write_file", "c" * 64)

        cp = build_checkpoint(
            st, session_id="sess-ck", goal_id="goal-ck",
            run_id="run-1", turn_state="paused", scope="goal-ck:u",
        )
        assert cp["completed_side_effects"] == ["call-done"]
        assert [e["call_id"] for e in cp["unresolved_side_effects"]] == \
            ["call-mid", "call-hang"]
        assert {e["status"] for e in cp["unresolved_side_effects"]} == \
            {"unknown", "pending"}

        res = resume_from_checkpoint(st, cp)
        assert res["dont_redo"] == ["call-done"]
        assert [e["call_id"] for e in res["verify_before_redo"]] == \
            ["call-mid", "call-hang"]
    finally:
        st.close()
