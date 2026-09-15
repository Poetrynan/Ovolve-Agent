"""Step D 切片：Memory–Skill 显式关系图。

最小验证预算：形状校验与幂等建边、观察层验证证据落 VALIDATES 边、
记忆变更触发依赖技能待重验。
"""
from evolution import (EvolutionEngine, EvolutionStore, MODE_ACTIVE,
                       build_goal_observation, record_goal_validation_edges)
from storage import Storage


def make_engine(tmp_path):
    store = EvolutionStore(db_path=str(tmp_path / "evo.db"))
    return EvolutionEngine(store=store, mode=MODE_ACTIVE), store


def make_storage(tmp_path):
    return Storage(db_dir=str(tmp_path / "db"))


# ── 形状是硬约束；同一五元组只留一条边 ─────────────────────────────────────

def test_shapes_enforced_and_edges_are_idempotent(tmp_path):
    st = make_storage(tmp_path)
    try:
        edge = st.add_relation("memory", "mem-1", "SUPPORTS", "skill", "deploy-check",
                               evidence="user pinned")
        assert edge["stale"] == 0 and edge["relation"] == "SUPPORTS"

        again = st.add_relation("memory", "mem-1", "SUPPORTS", "skill", "deploy-check")
        assert again["id"] == edge["id"], "重复建边必须返回既有那条"
        rows = st.relations_from("memory", "mem-1")
        assert len(rows) == 1

        # 八种动词里挑跨类型的再验两条
        st.add_relation("skill", "deploy-check-v2", "SUPERSEDES", "skill", "deploy-check")
        st.add_relation("goal", "goal-9", "VALIDATES", "skill", "deploy-check")
        # 入边三条：SUPPORTS + SUPERSEDES + VALIDATES（SUPERSEDES 的客体也是它）
        assert len(st.relations_to("skill", "deploy-check")) == 3
        assert len(st.relations_to("skill", "deploy-check", relation="VALIDATES")) == 1

        for bad in [
            ("goal", "g1", "USES", "memory", "m1"),   # USES 必须是 run->skill
            ("skill", "s1", "SUPPORTS", "memory", "m1"),  # 方向反了
        ]:
            try:
                st.add_relation(*bad)
                assert False, f"{bad} 不该被接受"
            except ValueError:
                pass  # fail-open: 可选增强，失败不影响主流程
        try:
            st.add_relation("memory", "m1", "MARRIES", "skill", "s1")
            assert False, "未知动词不该被接受"
        except ValueError:
            pass  # fail-open: 可选增强，失败不影响主流程

        assert st.remove_relation(edge["id"]) is True
        assert st.relations_from("memory", "mem-1") == []
    finally:
        st.close()


# ── 观察层挂点：目标验证通过 → VALIDATES 边（失败不建边） ───────────────────

def test_goal_validation_lands_validates_edge(tmp_path):
    engine, _ = make_engine(tmp_path)
    st = make_storage(tmp_path)
    gc = st._db("goals")
    gc.execute(
        "INSERT INTO goals (id, description, status, session_id, created_at, updated_at)"
        " VALUES ('goal-d1','t','completed','sess-d',1,1)")
    gc.commit()
    try:
        ok_exp = st.record_skill_experience(
            "deploy-check", goal_id="goal-d1", session_id="sess-d",
            steps_attempted=2, steps_succeeded=2, outcome="success")
        bad_exp = st.record_skill_experience(
            "flaky-skill", goal_id="goal-d1", session_id="sess-d",
            outcome="failure", failure_class="timeout")

        obs = build_goal_observation("goal-d1", st)
        assert set(obs.validated_skills) == {"deploy-check"}, "失败技能不得进入验证名单"
        engine.observe(obs)
        n = record_goal_validation_edges(obs, st)
        assert n == 1

        edges = st.relations_to("skill", "deploy-check", relation="VALIDATES")
        assert len(edges) == 1 and edges[0]["subject_id"] == "goal-d1"
        assert "validator" in (edges[0]["evidence"] or "")
        # 重放同一条观察不得翻倍——幂等由 UNIQUE 保证
        record_goal_validation_edges(obs, st)
        assert len(st.relations_to("skill", "deploy-check", relation="VALIDATES")) == 1
        assert st.relations_to("skill", "flaky-skill") == [], "没通过验证就没有边"
    finally:
        st.close()


# ── 失效传播：记忆变了/删了，依赖它的技能边上出现待重验标记 ──────────────────

def test_memory_change_marks_dependent_skills_stale(tmp_path):
    st = make_storage(tmp_path)
    try:
        e1 = st.add_relation("memory", "mem-1", "PREREQUISITE_FOR", "skill", "deploy-check")
        e2 = st.add_relation("skill", "writer", "PRODUCES", "memory", "mem-1")

        changed = st.mark_skills_stale_for_memory("mem-1")
        assert changed == 2, f"两侧牵连的技能边都要标记，实际 {changed}"
        assert st.get_relation(e1["id"])["stale"] == 1
        assert st.get_relation(e2["id"])["stale"] == 1

        cleared = st.clear_skill_stale("deploy-check")
        assert cleared >= 1
        assert st.get_relation(e1["id"])["stale"] == 0, "重验通过后标记必须能清掉"
        assert st.get_relation(e2["id"])["stale"] == 1, "没重验的技能保持待验"
    finally:
        st.close()
