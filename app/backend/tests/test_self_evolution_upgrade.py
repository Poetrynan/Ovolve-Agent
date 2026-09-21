"""
test_self_evolution_upgrade.py — 全面自进化系统（Reflexion, Voyager, Curriculum）自动化测试。
"""
import json
import os
import tempfile
import pytest
from reflection_engine import Reflection, ReflectionGenerator, ReflectionStore
from skill_composition import CompositePattern, SkillComposer
from curriculum_engine import CurriculumEngine, SkillGap, ExplorationTask
from storage import Storage


def make_test_storage(td: str) -> Storage:
    db_dir = os.path.join(td, "db")
    os.makedirs(db_dir, exist_ok=True)
    return Storage(db_dir=db_dir)


# ── 1. Reflexion 显式自我反思生成与存储召回测试 ──────────────────────────────

@pytest.mark.asyncio
async def test_reflection_generator_tool_failure():
    gen = ReflectionGenerator()
    # 模拟路径不存在报错
    ref = await gen.generate_from_tool_failure(
        tool_name="view_file",
        arguments={"AbsolutePath": "d:/not_exist/foo.py"},
        error_message="File not found: d:/not_exist/foo.py does not exist",
        session_id="sess-ref-1",
    )
    assert ref is not None
    assert ref.source_tool == "view_file"
    assert "不存在" in ref.root_cause or "not exist" in ref.root_cause.lower()
    assert "list_dir" in ref.alternative_strategy or "find_by_name" in ref.alternative_strategy
    assert "reflection" in ref.tags

    prompt_str = ref.format_for_prompt()
    assert "[view_file]" in prompt_str
    assert "根因分析" in prompt_str


@pytest.mark.asyncio
async def test_reflection_generator_gate_failure():
    gen = ReflectionGenerator()
    ref = await gen.generate_from_gate_failure(
        unmet_criteria=["missing artifact: dist/bundle.js", "command failed: pytest test_core.py"],
        session_id="sess-ref-2",
    )
    assert ref is not None
    assert ref.source_tool == "verification_gate"
    assert "dist/bundle.js" in ref.root_cause
    assert "全绿" in ref.alternative_strategy or "自测" in ref.prevention_rule


def test_reflection_store_roundtrip():
    with tempfile.TemporaryDirectory() as td:
        st = make_test_storage(td)
        try:
            store = ReflectionStore(storage=st)
            ref = Reflection(
                id="ref-test-1",
                scenario="replace_file_content 缩进错误",
                root_cause="源文件缩进为 4 空格，替换块为 2 空格导致无法匹配",
                alternative_strategy="先调用 view_file 确认精确缩进",
                prevention_rule="严禁猜测缩进",
                source_tool="replace_file_content",
                tags=["reflection", "replace_file_content"],
                session_id="sess-store",
            )
            saved = store.save_reflection(ref)
            assert saved is True

            # 检索反思
            recalled = store.retrieve_reflections(tool_names=["replace_file_content"], limit=5)
            assert len(recalled) > 0
            assert recalled[0].source_tool == "replace_file_content"

            # 格式化上下文
            ctx = store.format_reflection_context(tool_names=["replace_file_content"])
            assert "<reflections>" in ctx
            assert "replace_file_content" in ctx
        finally:
            st.close()


# ── 2. Voyager 技能组合性挖掘与合成测试 ─────────────────────────────────────

def test_skill_composer_mining_and_synthesis():
    with tempfile.TemporaryDirectory() as td:
        st = make_test_storage(td)
        try:
            # 灌入成功执行的经验时序链条
            for i in range(3):
                sid = f"sess_comp_{i}"
                for tool in ("find_by_name", "view_file", "replace_file_content"):
                    st.record_skill_experience(
                        skill_id=tool,
                        session_id=sid,
                        outcome="success",
                    )

            composer = SkillComposer(storage=st)
            patterns = composer.mine_patterns(min_support=2)
            assert len(patterns) > 0

            # 检查挖掘出的最频繁组合模式
            top = patterns[0]
            assert len(top.sequence) >= 2
            assert top.frequency >= 2

            # 生成候选技能
            cand = composer.generate_composite_candidate(top)
            assert cand is not None
            assert "steps" in cand
            assert len(cand["steps"]) == len(top.sequence)
            assert "composite" in cand["tags"]

            # 合成并送入生命周期门禁
            ok, msg = composer.synthesize_and_stage(top)
            assert ok is True, f"合成应成功: {msg}"
        finally:
            st.close()


# ── 3. Voyager 自主课程学习与能力缺口发现测试 ──────────────────────────────

def test_curriculum_engine_gap_discovery():
    with tempfile.TemporaryDirectory() as td:
        st = make_test_storage(td)
        try:
            c = st._db("sessions")
            # 插入重复高频意图的会话
            c.execute("INSERT INTO sessions (id, title, updated_at) VALUES ('s1', '需要做复杂的重构 refactor', 100)")
            c.execute("INSERT INTO sessions (id, title, updated_at) VALUES ('s2', '继续 refactor 模块', 200)")
            c.execute("INSERT INTO sessions (id, title, updated_at) VALUES ('s3', '编写自动化测试 test cases', 300)")
            c.execute("INSERT INTO sessions (id, title, updated_at) VALUES ('s4', '补全单元测试 test', 400)")
            c.commit()

            curric = CurriculumEngine(storage=st)
            gaps = curric.identify_skill_gaps(min_recurrence=2)
            assert len(gaps) >= 1

            # 验证生成的探索目标
            gap = gaps[0]
            assert gap.frequency >= 2
            task = curric.generate_exploration_goal(gap)
            assert isinstance(task, ExplorationTask)
            assert gap.suggested_skill_name in task.title
            assert len(task.verification_criteria) > 0
        finally:
            st.close()
