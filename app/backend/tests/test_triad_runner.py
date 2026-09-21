"""
test_triad_runner.py — 测试 Factory AI 范式的行为衡具、掩码差分验证与三权分立盲测调度器。
"""
import os
import shutil
import tempfile
import pytest

from triad_runner import (
    BehavioralCase,
    BehavioralInstrument,
    Directive,
    OrchestratorEngine,
    TheWall,
    TriadEvaluationResult,
    TriadRunner,
    ValidatorEngine,
)
from validator_registry import (
    apply_differential_masking,
    differential_validator,
    instrument_validator,
)
from acceptance_contract import (
    check_anti_weakening,
    check_completion,
    normalize_contract,
)


def test_differential_masking_standard_patterns():
    """测试标准指针、时间戳、UUID、临时路径的掩码消除能力。"""
    raw_output = (
        "Allocated at 0x7ffeefbff5e0 and heap ptr 0x0000021c3b4a2b10\n"
        "Created at 2026-08-27T20:11:16.000Z by session 123e4567-e89b-12d3-a456-426614174000\n"
        "Saved to /tmp/temp_run_123/output.bin and C:\\Temp\\debug.log"
    )
    masked = apply_differential_masking(raw_output)
    assert "<PTR>" in masked
    assert "0x7ffeefbff5e0" not in masked
    assert "<TIMESTAMP>" in masked
    assert "2026-08-27T20:11:16.000Z" not in masked
    assert "<UUID>" in masked
    assert "123e4567-e89b-12d3-a456-426614174000" not in masked
    assert "<TMP_PATH>" in masked


def test_differential_validator_with_masking(tmp_path):
    """测试差分验证器对动态噪音的容差对齐能力。"""
    ws = str(tmp_path)
    file_act = tmp_path / "actual.log"
    file_act.write_text("Operation completed at 2026-08-27T20:11:16Z with handle 0xdeadbeef", encoding="utf-8")

    spec = {
        "name": "check_handle_log",
        "actual_file": "actual.log",
        "expected": "Operation completed at 2026-09-01T12:00:00Z with handle 0x12345678",
    }
    res = differential_validator(spec, ws)
    assert res["status"] == "passed"
    assert "strictly matches" in res["evidence"][0]


def test_instrument_validator_scoring(tmp_path):
    """测试行为衡具综合评测器的加权评分与阈值判定。"""
    ws = str(tmp_path)
    f1 = tmp_path / "mod1.txt"
    f1.write_text("hello 0x1234", encoding="utf-8")
    f2 = tmp_path / "mod2.txt"
    f2.write_text("wrong output", encoding="utf-8")

    spec = {
        "name": "cli_parity_suite",
        "threshold": 0.5,
        "cases": [
            {
                "id": "case_1",
                "description": "mod1 check",
                "actual_file": "mod1.txt",
                "expected": "hello 0x5678",
                "weight": 2.0,
            },
            {
                "id": "case_2",
                "description": "mod2 check",
                "actual_file": "mod2.txt",
                "expected": "expected output",
                "weight": 1.0,
            },
        ],
    }
    # 2.0 / 3.0 = 66.7% >= threshold 50% -> passed
    res = instrument_validator(spec, ws)
    assert res["status"] == "passed"
    assert "66.67%" in res["evidence"][0]

    # 当 threshold 设为 80% 时应判定失败
    spec["threshold"] = 0.80
    res_fail = instrument_validator(spec, ws)
    assert res_fail["status"] == "failed"


def test_orchestrator_directive_synthesis():
    """测试 Orchestrator 将底层失败聚类并升维为高阶 Directives。"""
    raw_failures = [
        {
            "case_id": "c1",
            "subsystem": "parser",
            "description": "JSON parsing fails on trailing comma",
            "weight": 1.0,
        },
        {
            "case_id": "c2",
            "subsystem": "parser",
            "description": "YAML parsing missing tag handler",
            "weight": 2.0,
        },
        {
            "case_id": "c3",
            "subsystem": "network",
            "description": "Connection timeout after 60s",
            "weight": 1.0,
        },
    ]
    directives = OrchestratorEngine.synthesize_directives(raw_failures)
    assert len(directives) == 2
    parser_dir = next(d for d in directives if d.subsystem == "parser")
    assert parser_dir.severity == "high"
    assert parser_dir.failing_cases_count == 2
    assert "Subsystem 'parser'" in parser_dir.issue_summary

    net_dir = next(d for d in directives if d.subsystem == "network")
    assert net_dir.subsystem == "network"
    assert "优化 network" in net_dir.suggested_action


def test_the_wall_prompt_sanitization(tmp_path):
    """测试信息防线剥离私有衡具目录路径。"""
    ws = str(tmp_path)
    priv_dir = TheWall.get_private_instrument_dir(ws)
    assert os.path.exists(priv_dir)

    raw_prompt = f"Run check on {TheWall.PRIVATE_SUBDIR}/suite.json"
    clean = TheWall.sanitize_implementer_prompt(raw_prompt)
    assert TheWall.PRIVATE_SUBDIR not in clean
    assert "<INTERNAL_EVAL>" in clean


def test_triad_runner_cycle(tmp_path):
    """测试 TriadRunner 多轮迭代闭环。"""
    ws = str(tmp_path)
    target = tmp_path / "app.py"
    target.write_text("v1", encoding="utf-8")

    instrument = BehavioralInstrument(
        instrument_id="inst_test",
        name="test_instrument",
        target_component="core",
        threshold=1.0,
        cases=[
            BehavioralCase(
                id="c1",
                description="check v2 content",
                actual_file="app.py",
                expected="v2",
                subsystem="core",
            )
        ],
    )

    runner = TriadRunner(ws)

    # 模拟 Implementer 在收到 Directives 后修复代码
    def implementer_action(directives, workspace):
        assert len(directives) > 0
        (tmp_path / "app.py").write_text("v2", encoding="utf-8")

    passed, history = runner.run_cycle(instrument, implementer_action, max_rounds=3)
    assert passed is True
    assert len(history) == 2
    assert history[0].passed is False
    assert history[1].passed is True


def test_anti_weakening_and_phase0_contract():
    """测试 AcceptanceContract 的防弱化门禁与 Phase 0 衡具检查。"""
    c_old = normalize_contract({
        "acceptance_criteria": ["crit 1", "crit 2"],
        "verification_plan": [{"type": "file", "path": "a.txt"}, {"type": "file", "path": "b.txt"}],
    }, "g1")

    # 弱化：删除了 crit 2
    c_weakened = normalize_contract({
        "acceptance_criteria": ["crit 1"],
        "verification_plan": [{"type": "file", "path": "a.txt"}],
    }, "g1")
    ok, why = check_anti_weakening(c_old, c_weakened)
    assert ok is False
    assert "禁止弱化合同" in why

    # Phase 0 门禁检查
    c_phase0 = normalize_contract({
        "instrument_required": True,
        "verification_plan": [],
    }, "g2")
    passed, unmet, _ = check_completion(c_phase0, ".")
    assert passed is False
    assert any("instrument_required" in u for u in unmet)
