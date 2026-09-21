# -*- coding: utf-8 -*-
"""test_workflow_evolution.py — 工作流自进化提炼技能（Workflow → Skill）测试。

覆盖：
1. WorkflowMetricsTracker 的成功率/漂移率账本与晋升候选判定。
2. WorkflowSlotExtractor 的硬编码参数槽位化与 JSON Schema 产出。
3. WorkflowSkillPromoter 的 SKILL.md 物化与槽位占位符注入。
4. WorkflowReplayer 指标 Hook 与 GEPA 反思桥接。
"""
import pytest
from workflow_evolution import WorkflowMetricsTracker

def test_workflow_metrics_tracker_promotion():
    tracker = WorkflowMetricsTracker()
    wf_id = "wf_daily_export"

    # 初始无候选
    assert len(tracker.get_promotion_candidates()) == 0

    # 记录 2 次成功，仍不足 3 次阈值
    tracker.record_run(wf_id, success=True, drift=False)
    tracker.record_run(wf_id, success=True, drift=False)
    assert len(tracker.get_promotion_candidates()) == 0

    # 第 3 次成功，满足候选资格
    metrics = tracker.record_run(wf_id, success=True, drift=False)
    assert metrics.success_runs == 3
    assert metrics.success_rate == 1.0
    assert metrics.is_promotion_candidate

    candidates = tracker.get_promotion_candidates(min_success=3)
    assert wf_id in candidates


from workflow_evolution import WorkflowSlotExtractor
from workflow_recorder import Workflow, WorkflowStep

def test_workflow_slot_extraction():
    extractor = WorkflowSlotExtractor()
    step1 = WorkflowStep(
        step_index=0,
        tool_name="browser_navigate",
        params={"url": "https://intranet.example.com/reports/2026"},
    )
    step2 = WorkflowStep(
        step_index=1,
        tool_name="fs_read",
        params={"path": "D:/data/reports/input.csv"},
    )
    wf = Workflow(id="wf_sample", name="Sample", steps=[step1, step2])

    parameterized_wf, slots, json_schema = extractor.extract_slots(wf)

    # 应识别出 target_url 与 file_path 槽位
    slot_names = [s.slot_name for s in slots]
    assert "target_url" in slot_names or any("url" in s for s in slot_names)
    assert "file_path" in slot_names or any("path" in s for s in slot_names)

    # 原始步骤中的具体路径应被槽位化占位符替代
    p0_url = parameterized_wf.steps[0].params["url"]
    assert p0_url.startswith("{{") and p0_url.endswith("}}")

    # 验证生成的 JSON Schema 结构
    assert json_schema["type"] == "object"
    assert "properties" in json_schema


import tempfile
import shutil
from pathlib import Path
from workflow_evolution import WorkflowSkillPromoter

@pytest.fixture
def temp_skills_dir():
    d = tempfile.mkdtemp(prefix="evolve_skills_")
    yield d
    shutil.rmtree(d, ignore_errors=True)

def test_workflow_skill_promoter_materialization(temp_skills_dir):
    promoter = WorkflowSkillPromoter()
    step1 = WorkflowStep(
        step_index=0,
        tool_name="browser_navigate",
        params={"url": "https://example.com/demo"},
    )
    wf = Workflow(
        id="wf_auto_test_101",
        name="自动化测试上报",
        description="用于每日自动打卡与报告导出",
        steps=[step1],
    )

    res = promoter.promote_to_skill(wf, skills_root=temp_skills_dir)
    assert res.ok
    skill_dir = Path(res.value["skill_dir"])
    skill_md = skill_dir / "SKILL.md"
    assert skill_md.exists()

    # 验证 SKILL.md 遵循 skill_loader 的标准 frontmatter
    content = skill_md.read_text(encoding="utf-8")
    assert "name: wf-" in content
    assert "description: 用于每日自动打卡与报告导出" in content
    assert "user-invocable: true" in content
    assert "include-in-runtime-registry: true" in content

    # 热挂载：产物必须能被 skill_loader 真正解析进运行时注册表
    assert res.value["hot_mount"] == "mounted"
    from skill_loader import get_skill_loader
    entry = get_skill_loader().get_skill(res.value["skill_name"])
    assert entry is not None
    assert entry.description == "用于每日自动打卡与报告导出"


from unittest.mock import MagicMock
from result import Result
from workflow_recorder import WorkflowReplayer
from workflow_evolution import WorkflowEvolutionBridge

def test_workflow_replayer_records_metrics():
    """回放结束时必须自动把成功率/漂移率写进账本。"""
    tracker = WorkflowMetricsTracker()
    fake_guard = MagicMock()
    fake_guard.wait_for_bare_state.return_value = (True, "Clean")

    wf_ok = Workflow(
        id="wf_hook_ok",
        name="ok",
        steps=[WorkflowStep(step_index=0, tool_name="tool_a", params={})],
    )
    replayer = WorkflowReplayer(
        guard=fake_guard,
        executor=lambda t, p: Result.success({}),
        pre_checker=lambda step: (True, "Pre-check passed"),
    )
    replayer.set_metrics_tracker(tracker)
    assert replayer.replay(wf_ok).ok

    m = tracker.get_metrics("wf_hook_ok")
    assert m is not None
    assert m.total_runs == 1
    assert m.success_runs == 1
    assert m.drift_runs == 0

    # 漂移用例：pre_checker 判定目标缺失 → 熔断，应记为 drift 而非普通失败
    wf_drift = Workflow(
        id="wf_hook_drift",
        name="drift",
        steps=[WorkflowStep(step_index=0, tool_name="tool_a", params={})],
    )
    drift_replayer = WorkflowReplayer(
        guard=fake_guard,
        executor=lambda t, p: Result.success({}),
        pre_checker=lambda step: (False, "target element disappeared"),
    )
    drift_replayer.set_metrics_tracker(tracker)
    drift_res = drift_replayer.replay(wf_drift)
    assert not drift_res.ok

    dm = tracker.get_metrics("wf_hook_drift")
    assert dm is not None
    assert dm.total_runs == 1
    assert dm.drift_runs == 1
    assert dm.success_runs == 0
    assert not dm.is_promotion_candidate


def test_workflow_evolution_bridge_reflection_patch():
    """失败轨迹必须被翻译成 GEPA 基因候选并拿到反思 patch。"""
    bridge = WorkflowEvolutionBridge()
    wf = Workflow(
        id="wf_bridge",
        name="读取报表",
        description="读取报表文件",
        steps=[WorkflowStep(step_index=0, tool_name="fs_read", params={"path": "D:/nope.csv"})],
    )
    failure = Result.failure(
        "Execution failed at step 0 (fs_read): No such file or directory",
        failed_step=0,
    )

    res = bridge.reflect_on_failure(wf, failure)
    assert res.ok
    candidate = res.value

    assert candidate["mutationType"] == "reflection_patch"
    assert candidate["generation"] == 1
    assert candidate["parentIds"], "反思产物必须携带父代基因"
    # fs_read 的 not found 错误应触发"先验证路径存在"的守卫建议
    assert any("fs_read" in g for g in candidate["guardrails"])
    assert candidate["reflectionNotes"]


def test_workflow_evolution_bridge_gated_promotion(temp_skills_dir):
    """闭环：账本未达标不得晋级，达标后才物化出技能包。"""
    tracker = WorkflowMetricsTracker()
    bridge = WorkflowEvolutionBridge(tracker=tracker)
    wf = Workflow(
        id="wf_gated",
        name="每日导出",
        description="导出每日报表",
        steps=[WorkflowStep(step_index=0, tool_name="fs_read", params={"path": "D:/data/in.csv"})],
    )

    # 尚无记录 / 未达门槛 → 拒绝晋级
    assert not bridge.promote_if_ready(wf, skills_root=temp_skills_dir).ok
    for _ in range(2):
        tracker.record_run(wf.id, success=True)
    assert not bridge.promote_if_ready(wf, skills_root=temp_skills_dir).ok

    # 第 3 次成功且零漂移 → 晋级
    tracker.record_run(wf.id, success=True)
    res = bridge.promote_if_ready(wf, skills_root=temp_skills_dir)
    assert res.ok, res.error
    assert res.value["skill_name"] == "wf-wf_gated"

    # 一旦出现漂移，即使成功次数够也不再晋级
    tracker.record_run(wf.id, success=False, drift=True)
    assert not bridge.promote_if_ready(wf, skills_root=temp_skills_dir).ok


def test_workflow_skill_promoter_gate1_structure_validation(temp_skills_dir):
    """Gate 1: SKILL.md 结构校验，非法字符或空描述必须被拒。"""
    from workflow_evolution import validate_skill_structure
    
    # 缺少 frontmatter
    res1 = validate_skill_structure("Just plain text without frontmatter")
    assert not res1.ok
    assert "Gate 1" in res1.error

    # 缺少有效 name
    bad_fm = "---\ndescription: test\n---\n# Title"
    res2 = validate_skill_structure(bad_fm)
    assert not res2.ok
    assert "name" in res2.error

    # 缺少有效 body
    empty_body = "---\nname: my-skill\ndescription: test\n---\n"
    res3 = validate_skill_structure(empty_body)
    assert not res3.ok
    assert "正文" in res3.error


def test_workflow_skill_promoter_gate2_trial_failure(temp_skills_dir):
    """Gate 2: trial 试运行失败必须拒绝物化。"""
    promoter = WorkflowSkillPromoter()
    step_invalid = WorkflowStep(
        step_index=0,
        tool_name="",  # 空的 tool_name
        params={},
    )
    wf = Workflow(id="wf_trial_fail", name="TrialFail", steps=[step_invalid])

    res = promoter.promote_to_skill(wf, skills_root=temp_skills_dir)
    assert not res.ok
    assert "Gate 2" in res.error

    # 测试自定义失败的 trial runner
    step_ok = WorkflowStep(step_index=0, tool_name="fs_read", params={"path": "a.txt"})
    wf2 = Workflow(id="wf_trial_fail_runner", name="TrialFailRunner", steps=[step_ok])
    
    def failing_runner(wf, slots):
        return Result.failure("Mock trial sandbox execution crashed")
        
    res2 = promoter.promote_to_skill(wf2, skills_root=temp_skills_dir, trial_runner=failing_runner)
    assert not res2.ok
    assert "Mock trial sandbox execution crashed" in res2.error


def test_workflow_skill_promoter_gate3_idempotent_version_update(temp_skills_dir):
    """Gate 3: 幂等挂载与版本递增（重复 promote 同名工作流不产生重复条目）。"""
    from skill_loader import get_skill_loader, SkillStatus
    
    promoter = WorkflowSkillPromoter()
    step1 = WorkflowStep(step_index=0, tool_name="browser_navigate", params={"url": "https://a.com"})
    wf = Workflow(id="wf_idempotent_test", name="幂等性测试", description="测试重复物化", steps=[step1])

    # 第一次 promote: version 1.0.0, status promoted
    res1 = promoter.promote_to_skill(wf, skills_root=temp_skills_dir)
    assert res1.ok
    assert res1.value["status"] == "promoted"
    assert res1.value["version"] == "1.0.0"
    assert res1.value["hot_mount"] == "mounted"

    # 第二次 promote: 幂等更新，版本递增至 1.0.1，status updated
    res2 = promoter.promote_to_skill(wf, skills_root=temp_skills_dir)
    assert res2.ok
    assert res2.value["status"] == "updated"
    assert res2.value["version"] == "1.0.1"
    assert res2.value["hot_mount"] == "mounted"

    # 验证运行时注册表内仅有该技能一个实例，且状态为 IMPORTED
    loader = get_skill_loader()
    skill_name = res1.value["skill_name"]
    entry = loader.get_skill(skill_name)
    assert entry is not None
    assert entry.status == SkillStatus.IMPORTED
    matching_skills = [s for s in loader.list_skills() if s["name"] == skill_name]
    assert len(matching_skills) == 1

