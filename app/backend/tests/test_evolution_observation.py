"""Step C 切片：EvolutionObservation 与 MEMORY_ONLY/SKILL_ONLY/BOTH/NO_OP 四路分类。

最小验证预算：一个分类规则表测试（纯函数）、一个真实消费集成测试
（经验台账 → 观察 → 归档）、一个失败路径测试（偶发失败绝不立项）。
"""
import json

from evolution import (DECISION_BOTH, DECISION_MEMORY_ONLY, DECISION_NO_OP,
                       DECISION_SKILL_ONLY, EvolutionEngine, EvolutionObservation,
                       EvolutionStore, build_goal_observation,
                       classify_observation, materialize_observation, MODE_ACTIVE)
from storage import Storage


def make_engine(tmp_path):
    store = EvolutionStore(db_path=str(tmp_path / "evo.db"))
    return EvolutionEngine(store=store, mode=MODE_ACTIVE), store


def make_storage_with_goal(tmp_path, goal_id="goal-c1", session_id="sess-c",
                           status="completed"):
    st = Storage(db_dir=str(tmp_path / "db"))
    gc = st._db("goals")
    gc.execute(
        "INSERT INTO goals (id, description, status, session_id, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?)",
        (goal_id, "do things", status, session_id, 1, 1),
    )
    gc.commit()
    return st


# ── 分类规则表：判据是证据，不是模型自述 ────────────────────────────────────

def test_classification_table():
    cases = [
        ({"new_facts": ["用户偏好深色主题"]}, DECISION_MEMORY_ONLY),
        ({"reusable_steps": ["deploy-check（成功 3 步）"]}, DECISION_SKILL_ONLY),
        ({"new_facts": ["项目用 pnpm"], "reusable_steps": ["x（成功 1 步）"]},
         DECISION_BOTH),
        # NO_OP 五类：秘密嫌疑 / 偶发失败 / 复发失败 / 纯口头反馈 / 证据不足
        ({"new_facts": ["api_key=sk-abcdefghijklmnop"]}, DECISION_NO_OP),
        ({"failed_experiences": ["timeout"]}, DECISION_NO_OP),
        ({"failed_experiences": ["timeout", "timeout"]}, DECISION_NO_OP),
        ({"user_feedback": "挺好的"}, DECISION_NO_OP),
        ({}, DECISION_NO_OP),
    ]
    for kw, expected in cases:
        decision, reason = classify_observation(EvolutionObservation(**kw))
        assert decision == expected, f"{kw} -> {decision}（{reason}），期望 {expected}"
        assert reason, "每个决策都必须带得出手的理由，UI 和审计要引用它"


# ── 集成：观察真的消费落盘的经验数据，决策归档可查 ──────────────────────────

def test_observation_consumes_real_experiences(tmp_path):
    engine, store = make_engine(tmp_path)
    st = make_storage_with_goal(tmp_path)
    try:
        exp_id = st.record_skill_experience(
            "deploy-check", goal_id="goal-c1", session_id="sess-c",
            steps_attempted=3, steps_succeeded=3, outcome="success",
        )
        obs = build_goal_observation("goal-c1", st)
        assert obs is not None
        assert obs.used_skills == ["deploy-check"]
        assert exp_id in obs.skill_experiences
        assert len(obs.reusable_steps) == 1

        out = engine.observe(obs)
        assert out.decision == DECISION_SKILL_ONLY

        saved = store.list_observations(limit=10)
        assert len(saved) == 1 and saved[0]["decision"] == DECISION_SKILL_ONLY
        assert saved[0]["goalId"] == "goal-c1"
        assert exp_id in json.dumps(saved[0], ensure_ascii=False), \
            "归档必须带上来源经验 id——没有出处的学习不可审计"
    finally:
        st.close()


# ── 失败路径：一次偶发失败不产生任何学习写入，但观察在案 ─────────────────────

def test_incidental_failure_never_becomes_learning(tmp_path):
    engine, store = make_engine(tmp_path)
    st = make_storage_with_goal(tmp_path, status="failed_final")
    try:
        st.record_skill_experience(
            "deploy-check", goal_id="goal-c1", session_id="sess-c",
            outcome="failure", failure_class="timeout",
        )
        obs = engine.observe(build_goal_observation("goal-c1", st))
        assert obs.decision == DECISION_NO_OP

        assert len(store.list_observations()) == 1, "NO_OP 也要入账：为什么不学同样是审计问题"
        assert engine.store.count_open() == 0, \
            "观察层只记录不写入：任何学习产物必须走提案-审批管线"
    finally:
        st.close()


# ── P0-3：决策必须产出真实待审物，否则 observe() 只是个终点水槽 ──────────────

def test_memory_only_produces_pending_proposal(tmp_path):
    engine, store = make_engine(tmp_path)
    st = make_storage_with_goal(tmp_path)
    try:
        obs = engine.observe(EvolutionObservation(
            goal_id="goal-c1", new_facts=["这个项目用 pnpm 而不是 npm"],
        ))
        assert obs.decision == DECISION_MEMORY_ONLY

        made = materialize_observation(obs, st, engine)
        assert len(made["memoryProposals"]) == 1, made
        p = store.get_proposal(made["memoryProposals"][0])
        assert p.status == "pending", "只能产待审物，不能直接生效"
        assert p.target_file == "MEMORY.md"
        assert "pnpm" in p.draft, "用户批的是原话，不是归一化后的形状"
        assert p.applied == 0, "没人点接受，盘上不该有任何改动"

        # 同一条事实第二次观察不得重复立项（签名去重）
        again = materialize_observation(obs, st, engine)
        assert again["memoryProposals"] == []
        assert store.count_open() == 1
    finally:
        st.close()


def test_secret_shaped_fact_never_becomes_a_proposal(tmp_path):
    engine, store = make_engine(tmp_path)
    st = make_storage_with_goal(tmp_path)
    try:
        # classify 已经会整包拦下；这里直接绕过分类，验证产出侧的第二道防线：
        # 把一条带密钥的事实塞进已判定 MEMORY_ONLY 的观察里。
        obs = EvolutionObservation(
            goal_id="goal-c1", new_facts=["token=sk-abcdefghijklmnop 可以用"],
            decision=DECISION_MEMORY_ONLY, reason="人为构造",
        )
        made = materialize_observation(obs, st, engine)
        assert made["memoryProposals"] == []
        assert store.count_open() == 0, "秘密形状的事实一条都不能进审批队列"
    finally:
        st.close()


def test_uncovered_success_incubates_a_skill_candidate(tmp_path):
    """无技能覆盖但成功的任务 → 自动产一个技能候选。

    这是全链路的"入口"：在此之前 create_candidate 只有 HTTP handler 一个
    调用者，所谓自动进化其实要人先手动 POST 一个候选。
    """
    engine, _store = make_engine(tmp_path)
    st = make_storage_with_goal(tmp_path)
    try:
        st.record_skill_experience(
            st.TASK_LEVEL_SKILL_ID, goal_id="goal-c1", turn_id="turn-1",
            session_id="sess-c", selection_reason="no_skill",
            steps_attempted=4, steps_succeeded=4, outcome="success",
        )
        obs = engine.observe(build_goal_observation("goal-c1", st))
        assert obs.decision == DECISION_SKILL_ONLY
        assert obs.used_skills == [], "哨兵不得冒充一个真技能"

        made = materialize_observation(obs, st, engine)
        cid = made["skillCandidate"]
        assert cid, made
        cand = st.get_skill_candidate(cid)
        assert cand["status"] == "candidate", "只能停在候选：门禁与审批在下游"
        assert cand["name"].startswith("auto-"), cand["name"]
        assert cand["experience_ref"], "候选必须绑定产生它的那条真实经验"
        assert cand["steps"], "结构门禁要求至少一步"

        # 同一个目标再观察一次不得重复孵化
        again = materialize_observation(obs, st, engine)
        assert again["skillCandidate"] == ""
        assert len(st.list_skill_candidates(limit=50)) == 1
    finally:
        st.close()


def test_covered_success_does_not_incubate_a_duplicate_skill(tmp_path):
    """已有技能跑通 → 不再造一个同义技能。重复不是学习。"""
    engine, _store = make_engine(tmp_path)
    st = make_storage_with_goal(tmp_path)
    try:
        st.record_skill_experience(
            "deploy-check", goal_id="goal-c1", session_id="sess-c",
            steps_attempted=3, steps_succeeded=3, outcome="success",
        )
        obs = engine.observe(build_goal_observation("goal-c1", st))
        assert obs.decision == DECISION_SKILL_ONLY

        made = materialize_observation(obs, st, engine)
        assert made["skillCandidate"] == ""
        assert st.list_skill_candidates(limit=50) == []
        assert made["reason"], "没产出也要说清为什么没产出"
    finally:
        st.close()


# ── 人工裁决：批准才写盘，拒绝一个字都不写 ──────────────────────────────────

def _pending(store, pid="p-d1", target="MEMORY.md", draft="- 部署脚本在 ops/deploy.ps1"):
    from evolution import Proposal
    p = Proposal(id=pid, signature="sig-" + pid, kind="learned_fact", tool_name="",
                 target_file=target, draft=draft, rationale="本次任务确认过",
                 hits=1, status="pending", created_at=1.0)
    store.insert_proposal(p)
    return p


def test_accepting_a_proposal_writes_the_draft_and_reports_the_target(tmp_path):
    """批准是这个环里唯一的写盘授权，也是唯一没被测过的一步。

    ``applied`` 必须反映盘上的实情，``targetFile`` 必须跟着回——提案一裁决就从
    待审列表消失，前端之后再也查不到它本来要写去哪儿。
    """
    store = EvolutionStore(db_path=str(tmp_path / "evo.db"))
    ws = tmp_path / "ws"
    ws.mkdir()
    engine = EvolutionEngine(store=store, mode=MODE_ACTIVE, workspace_root=str(ws))
    _pending(store)

    res = engine.decide("p-d1", accept=True)
    assert res["applied"] is True, res
    assert res["targetFile"] == "MEMORY.md"
    body = (ws / "MEMORY.md").read_text(encoding="utf-8")
    assert "ops/deploy.ps1" in body
    assert "Learned Rules" in body, "写入必须落在可审计的小节里"

    # 同一条不得二次裁决——重复批准会把同一行追加两次
    assert engine.decide("p-d1", accept=True)["ok"] is False
    store.close()


def test_rejecting_a_proposal_writes_nothing(tmp_path):
    store = EvolutionStore(db_path=str(tmp_path / "evo.db"))
    ws = tmp_path / "ws"
    ws.mkdir()
    engine = EvolutionEngine(store=store, mode=MODE_ACTIVE, workspace_root=str(ws))
    _pending(store, pid="p-d2")

    res = engine.decide("p-d2", accept=False)
    assert res["status"] == "rejected" and res["applied"] is False
    assert not (ws / "MEMORY.md").exists(), "拒绝就是不写，连文件都不该出现"
    store.close()


def test_accept_reports_failure_when_target_is_not_allowed(tmp_path):
    """越界目标不写、不静默：applied False 且带着 targetFile 说清是哪个。"""
    store = EvolutionStore(db_path=str(tmp_path / "evo.db"))
    ws = tmp_path / "ws"
    ws.mkdir()
    engine = EvolutionEngine(store=store, mode=MODE_ACTIVE, workspace_root=str(ws))
    _pending(store, pid="p-d3", target="secrets.env")

    res = engine.decide("p-d3", accept=True)
    assert res["applied"] is False and res["error"]
    assert res["targetFile"] == "secrets.env"
    assert not (ws / "secrets.env").exists()
    store.close()


# ── 冲突裁决：同一件事的两种结论不得并存 ────────────────────────────────────

def test_conflict_detector_only_fires_on_same_topic_different_conclusion():
    from evolution import find_conflicting_line

    existing = ["- 项目用 npm 装依赖", "- 部署脚本在 ops/deploy.ps1"]
    # 同一件事、结论不同 → 命中
    assert find_conflicting_line("项目用 pnpm 装依赖", existing) == "- 项目用 npm 装依赖"
    # 完全相同 → 不是冲突，是"已经知道了"
    assert find_conflicting_line("项目用 npm 装依赖", existing) == ""
    # 无关事实 → 不得误报，否则裁决界面会让用户删掉有用的记忆
    assert find_conflicting_line("测试要跑 pytest -q", existing) == ""


def test_conflicting_fact_becomes_an_adjudication_and_replaces_in_place(tmp_path):
    """改写一条已落盘的事实：提案标成 fact_conflict，批准后旧行原地被换掉。

    两条都留下是最坏结果——MEMORY.md 每轮注入模型，自相矛盾的上下文比没有更坏。
    """
    from evolution import EvolutionObservation, materialize_observation

    store = EvolutionStore(db_path=str(tmp_path / "evo.db"))
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "MEMORY.md").write_text(
        "# Memory\n\n## Learned Rules (evolution)\n- 项目用 npm 装依赖\n- 别动 vendor/\n",
        encoding="utf-8")
    engine = EvolutionEngine(store=store, mode=MODE_ACTIVE, workspace_root=str(ws))
    st = make_storage_with_goal(tmp_path)
    try:
        obs = EvolutionObservation(
            goal_id="goal-c1", session_id="sess-c",
            new_facts=["项目用 pnpm 装依赖"], decision=DECISION_MEMORY_ONLY,
            reason="用户当场纠正")
        made = materialize_observation(obs, st, engine)
        pid = (made["memoryProposals"] or [""])[0]
        assert pid, made
        p = store.get_proposal(pid)
        assert p.kind == "fact_conflict", "改写不能伪装成新增"
        assert p.supersedes == "- 项目用 npm 装依赖"

        assert engine.decide(pid, accept=True)["applied"] is True
        body = (ws / "MEMORY.md").read_text(encoding="utf-8")
        assert "pnpm" in body
        assert "npm 装依赖" not in body.replace("pnpm 装依赖", ""), "旧结论必须消失"
        # 位置保留：改写不该把这条挪到小节末尾
        lines = [l for l in body.splitlines() if l.startswith("- ")]
        assert lines == ["- 项目用 pnpm 装依赖", "- 别动 vendor/"]
    finally:
        st.close()
        store.close()


def test_already_written_fact_is_not_proposed_again(tmp_path):
    """盘上已有一模一样的一行 → 不再提案。签名去重只看未决提案，拦不住这条。"""
    from evolution import EvolutionObservation, materialize_observation

    store = EvolutionStore(db_path=str(tmp_path / "evo.db"))
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "MEMORY.md").write_text(
        "## Learned Rules (evolution)\n- 项目用 npm 装依赖\n", encoding="utf-8")
    engine = EvolutionEngine(store=store, mode=MODE_ACTIVE, workspace_root=str(ws))
    st = make_storage_with_goal(tmp_path)
    try:
        obs = EvolutionObservation(
            goal_id="goal-c1", session_id="sess-c",
            new_facts=["项目用 npm 装依赖"], decision=DECISION_MEMORY_ONLY,
            reason="又抽到同一句")
        made = materialize_observation(obs, st, engine)
        assert made["memoryProposals"] == []
        assert store.count_open() == 0
    finally:
        st.close()
        store.close()


def test_accepting_a_conflict_retires_the_superseded_memory(tmp_path):
    """裁决要传导到记忆库，不能只改文件。

    召回读的是 memory_entries。只把 MEMORY.md 里的旧行换掉，那条"用 npm"还躺在
    库里，下一轮照样被召回注入——文件说 pnpm、记忆说 npm，而模型两边都读。
    """
    from storage import get_storage

    store = EvolutionStore(db_path=str(tmp_path / "evo.db"))
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "MEMORY.md").write_text(
        "## Learned Rules (evolution)\n- 项目用 npm 装依赖\n", encoding="utf-8")
    engine = EvolutionEngine(store=store, mode=MODE_ACTIVE, workspace_root=str(ws))
    st = get_storage()
    root = str(ws)
    st.save_memory_entry(eid="mem-old", sid="sess-c", root=root, scope="project",
                         content="项目用 npm 装依赖")
    st.save_memory_entry(eid="mem-keep", sid="sess-c", root=root, scope="project",
                         content="别动 vendor/")
    try:
        _pending(store, pid="p-r1", draft="- 项目用 pnpm 装依赖")
        store._conn.execute("UPDATE proposals SET kind=?, supersedes=? WHERE id=?",
                            ("fact_conflict", "- 项目用 npm 装依赖", "p-r1"))
        store._conn.commit()

        res = engine.decide("p-r1", accept=True)
        assert res["applied"] is True
        assert res["retiredMemories"] == 1, res

        def archived(eid):
            r = st._db("memory").execute(
                "SELECT archived FROM memory_entries WHERE id=?", (eid,)).fetchone()
            return int(r["archived"] or 0)

        assert archived("mem-old") == 1, "被裁决掉的结论还留在记忆库里"
        assert archived("mem-keep") == 0, "无关记忆不得被牵连归档"
    finally:
        store.close()
