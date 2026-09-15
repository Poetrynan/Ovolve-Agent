"""
test_evolution_reflection_and_composition.py — 测试显式语义反思 (Reflexion) 与技能组合性引擎 (Voyager Skill Composer).
"""
import time
import pytest
from storage import Storage
from evolution import (
    EvolutionObservation,
    ReflectionGenerator,
    SemanticReflection,
    materialize_observation,
    get_evolution_engine,
    MODE_ACTIVE,
)
from skill_lifecycle import (
    CompositePattern,
    SkillComposer,
)
from memory_tiers import MemoryTier


@pytest.fixture(autouse=True)
def _isolate_evolution_engine_singleton(monkeypatch):
    """用例结束后还原进程级单例 evolution._engine，堵住跨文件状态泄漏。

    get_evolution_engine() 是懒单例：第一次调用会把引擎写进模块全局
    ``evolution._engine``，而本文件的用例还会 ``set_mode(MODE_ACTIVE)``。
    若不还原，这个 ACTIVE 档位的残留引擎会被 approvals_projection 的只读
    投影读到（它默认取 ``evolution._engine``），让后续测试（如
    test_mailbox_approvals）聚合出幽灵"待审提案"。monkeypatch 保证即使
    用例中途失败也会还原为用例前的值。
    """
    import evolution as _evolution_mod
    monkeypatch.setattr(
        _evolution_mod, "_engine", getattr(_evolution_mod, "_engine", None)
    )


def test_reflection_generator_failure_synthesis():
    """测试失败轨迹下的根因分析与预防规则生成。"""
    obs = EvolutionObservation(
        goal_id="goal_fail_01",
        failure_class="permission_denied",
        failed_experiences=["permission_denied"],
        user_feedback="Access was blocked by readonly rule",
    )
    ref = ReflectionGenerator.generate_reflection(obs)
    assert ref is not None
    assert ref.outcome == "failure"
    assert "权限" in ref.root_cause
    assert "严禁" in ref.preventative_rule
    assert ref.confidence >= 0.8


def test_reflection_generator_success_synthesis():
    """测试成功轨迹下的正面经验固化。"""
    obs = EvolutionObservation(
        goal_id="goal_succ_01",
        reusable_steps=["find_files", "replace_file_content", "pytest"],
        validator_result={"passed": True},
    )
    ref = ReflectionGenerator.generate_reflection(obs)
    assert ref is not None
    assert ref.outcome == "success"
    assert "正常执行" in ref.root_cause
    assert "find_files" in ref.preventative_rule


def test_reflection_store_and_retrieve_semantic_tier(tmp_path):
    """测试反思存入 SEMANTIC 层（严禁存入短期激进衰减层）及相关性召回。"""
    st = Storage(db_dir=str(tmp_path))
    ref = SemanticReflection(
        reflection_id="ref_test_01",
        goal_id="goal_100",
        root_cause="工具入参格式错误 (Schema Validation Mismatch)",
        alternative_strategy="严格核对必填字段",
        preventative_rule="JSON Schema 格式精确输出",
        boundary="所有 Backend Tool",
        outcome="failure",
    )

    eid = ReflectionGenerator.store_reflection_as_memory(ref, st, root_dir=str(tmp_path))
    assert eid == "ref_test_01"

    # 验证底层存储 tier 绝非 short-term-recall
    row = st._db("memory").execute("SELECT tier, type, content, tags FROM memory_entries WHERE id=?", (eid,)).fetchone()
    assert row is not None
    assert row["tier"] in (MemoryTier.SEMANTIC.value, MemoryTier.DREAMING.value, "semantic", "dreaming")
    assert row["tier"] != MemoryTier.SHORT_TERM_RECALL.value
    assert row["type"] == "reflection"
    assert "Schema Validation" in row["content"]

    # 检索召回
    recalled = ReflectionGenerator.retrieve_reflections(st, query="Schema", root_dir=str(tmp_path), limit=2)
    assert len(recalled) == 1
    assert recalled[0]["id"] == "ref_test_01"


def test_materialize_observation_with_reflection(tmp_path):
    """测试 materialize_observation 能够自动生成语义反思并注册为一等 LearningItem。"""
    st = Storage(db_dir=str(tmp_path))
    engine = get_evolution_engine(workspace_root=str(tmp_path))
    engine.set_mode(MODE_ACTIVE)

    obs = EvolutionObservation(
        goal_id="goal_mat_01",
        failure_class="timeout",
        failed_experiences=["timeout"],
        decision="MEMORY_ONLY",
        new_facts=["Project uses port 8080 for dev server"],
    )

    out = materialize_observation(obs, st, engine)
    assert "reflection" in out
    assert out["reflection"]["outcome"] == "failure"


def test_skill_composer_find_patterns_and_generate_candidate(tmp_path):
    """测试 SkillComposer 频繁技能调用链挖掘与复合技能候选生成。"""
    st = Storage(db_dir=str(tmp_path))
    
    # 模拟在三个不同 goal 中成功按序调用了 skill_alpha -> skill_beta
    for i in range(3):
        gid = f"goal_comp_{i}"
        st.record_skill_experience(
            skill_id="skill_alpha",
            run_id=f"run_{i}",
            turn_id=f"turn_{i}_1",
            goal_id=gid,
            session_id=f"sess_{i}",
            outcome="success",
        )
        st.record_skill_experience(
            skill_id="skill_beta",
            run_id=f"run_{i}",
            turn_id=f"turn_{i}_2",
            goal_id=gid,
            session_id=f"sess_{i}",
            outcome="success",
        )

    patterns = SkillComposer.find_composition_patterns(st, min_support=2)
    assert len(patterns) >= 1
    top_p = patterns[0]
    assert top_p.skills == ["skill_alpha", "skill_beta"]
    assert top_p.frequency == 3
    assert len(top_p.goals_covered) == 3

    # 生成复合技能候选
    res = SkillComposer.generate_composite_candidate(st, top_p, name="composite-alpha-beta")
    assert res.ok is True
    cand = res.value
    assert cand["name"] == "composite-alpha-beta"
    assert "skill_alpha -> skill_beta" in cand["description"]
    assert len(cand["steps"]) >= 3
