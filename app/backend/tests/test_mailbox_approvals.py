"""Phase 7/10 收口：Mailbox 原语、TeamBoard ReviewStatus、Approvals 统一投影。"""
import pytest

from mailbox import consume, drain, send, unread
from storage import Storage
from team import TeamBoard


def make_storage(tmp_path):
    return Storage(db_dir=str(tmp_path / "db"))


# ── Mailbox：投递/消费/隔离，记录保留供审计 ─────────────────────────────────

def test_mailbox_send_drain_and_isolation(tmp_path):
    st = make_storage(tmp_path)
    try:
        send(st, "agent:child-1", "parent", kind="task",
             payload={"cmd": "read"})
        send(st, "agent:child-1", "system", kind="control",
             payload={"stop": True})
        send(st, "agent:child-2", "parent")

        assert len(unread(st, "agent:child-1")) == 2
        assert len(unread(st, "agent:child-2")) == 1, "信箱之间必须隔离"

        msgs = drain(st, "agent:child-1")
        assert len(msgs) == 2 and all(m["consumed"] == 1 for m in msgs)
        assert unread(st, "agent:child-1") == [], "每条只送达一次"

        # 消费即标记而非删除——"谁在什么时候被告知了什么"可审计
        total = st._db("sessions").execute(
            "SELECT COUNT(*) AS c FROM mailbox_messages").fetchone()["c"]
        assert total == 3
        assert consume(st, msgs[0]["id"]) is False, "已消费的不可重复消费"
    finally:
        st.close()


# ── ReviewStatus：reviewer gate 对 delivered 交付的复核裁决 ─────────────────

def test_review_status_gates_delivered_results(tmp_path):
    st = make_storage(tmp_path)
    try:
        board = TeamBoard(st, parent_run_id="run-rv")
        board.add_task("t1", "coder")
        board.claim("t1", "w1")
        board.deliver("t1", "w1", {"patch_summary": "done"})

        assert board.view()[0]["review_status"] == "none"
        with pytest.raises(ValueError):
            board.set_review("t1", "excellent"), "未知裁决必须拒绝"

        # changes_requested 打回修订但不推翻交付状态
        assert board.set_review("t1", "changes_requested", "缺测试") is True
        v = board.view()[0]
        assert v["status"] == "delivered" and v["review_status"] == "changes_requested"

        # rejected 即打回——父运行不得采信被复核否决的结果
        board.set_review("t1", "rejected", "方案方向错误")
        assert board.view()[0]["status"] == "rejected"

        # 非 delivered 状态无物可审，如实拒绝
        assert board.set_review("t1", "approved") is False
    finally:
        st.close()


def test_fresh_database_bootstraps_without_migration_errors(capsys, tmp_path):
    """空库首启不该刷任何迁移失败。

    turn_usage 的 ALTER 和回填曾排在建表之前，于是每次全新安装的第一次启动都会
    打五行 "no such table: turn_usage" ——看着像真坏了，久了就学会无视迁移报错，
    而那正是以后真出问题时唯一的信号。
    """
    st = Storage(db_dir=str(tmp_path / "fresh"))
    try:
        out = capsys.readouterr().out
        noisy = [ln for ln in out.splitlines()
                 if "FAILED" in ln or "no such table" in ln]
        assert noisy == [], f"空库首启有迁移噪声：{noisy}"
    finally:
        st.close()


# ── Approvals 统一投影：staged 候选与 pending 提案聚合可见 ──────────────────

def test_pending_approvals_lists_candidates_but_not_questions(tmp_path):
    """裁决屏只收"等人拍板的演化事项"，不收会话里的问题卡。"""
    from approvals_projection import pending_approvals
    from ask_user import AskUserStore

    st = make_storage(tmp_path)
    try:
        st.create_session("sess-ap", "approval-demo")
        ask = AskUserStore(storage=st)
        ask.record("call-9", "sess-ap", "需要确认", [
            {"question": "允许写入 README.md 吗？",
             "options": [{"label": "允许"}, {"label": "拒绝"}]},
        ])

        cand = st.insert_skill_candidate(
            name="staged-skill", description="等待批准的技能",
            experience_ref="exp-x")
        st.set_skill_candidate_status(cand, "staged")

        proj = pending_approvals(st)
        # 问题卡刻意不在这一屏（见 approvals_projection 模块注释：它是会话进行中的
        # 临时交互，卡片本来就在对话里渲染与回答）。这里把那个决定钉住，否则下一个
        # 人会以为"问题没出现"是漏了。
        assert "questions" not in proj
        assert "questions" not in proj["counts"]
        assert proj["counts"]["skillCandidates"] == 1
        assert proj["skillCandidates"][0]["name"] == "staged-skill"
        assert proj["counts"]["total"] == 1
        # 问题本身仍然在它自己的账本里，只是不归这一屏管。
        assert len(ask.pending_for("sess-ap")) == 1
    finally:
        st.close()


def test_pending_approvals_surfaces_open_evolution_proposals(tmp_path):
    """待审的记忆/指导提案必须出现在"谁在等我"这一屏。

    自进化环把"要记住的事"落成 pending 提案，可用户只在 Evolution 面板才看得到
    它们——闭环里"人在环中"那一步就等于藏起来了。
    """
    from approvals_projection import pending_approvals
    from evolution import EvolutionEngine, EvolutionStore, Proposal

    st = make_storage(tmp_path)
    engine = EvolutionEngine(
        store=EvolutionStore(db_path=str(tmp_path / "evo.db")),
        mode="cautious", workspace_root=str(tmp_path))
    try:
        engine.store.insert_proposal(Proposal(
            id="p-1", signature="sig-1", kind="learned_fact", tool_name="",
            target_file="MEMORY.md", draft="- 用户的部署脚本在 ops/deploy.ps1",
            rationale="本次任务确认过", hits=1, status="pending",
            created_at=1.0))

        proj = pending_approvals(st, evolution_engine=engine)
        assert proj["counts"]["evolutionProposals"] == 1
        assert proj["counts"]["total"] == 1
        p = proj["evolutionProposals"][0]
        assert p["targetFile"] == "MEMORY.md" and p["kind"] == "learned_fact"

        # off 档不查库也不报数——"没开就零 IO"这条纪律对读路径同样成立
        engine.set_mode("off")
        off = pending_approvals(st, evolution_engine=engine)
        assert off["evolutionProposals"] == [] and off["counts"]["total"] == 0
    finally:
        engine.store.close()
        st.close()
