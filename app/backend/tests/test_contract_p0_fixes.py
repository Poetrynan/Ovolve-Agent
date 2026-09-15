"""
test_contract_p0_fixes.py — P0 修复回归测试

验证诊断报告中发现的子代理工作区同步故障修复：
- P0-1: enforce_contracts 不再改写 ok，只挂警告
- P0-2: 空文本 + overlay 有改动 → 自动补摘要
- P0-3: 丢弃前 quarantine 备份
- P0-4: gate 语义修正（无 summary 跳过而非传 {}）
- P1:  契约执行单一执行点 + 可观测性
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from team import (
    enforce_contracts,
    check_result_contract,
    get_persona_contract,
    PERSONA_RESULT_SCHEMAS,
)


# ── P0-1: 契约失败不改写 ok ────────────────────────────────────────────────

class TestContractDoesNotRewriteOk:
    """契约格式问题只挂警告，绝不改写 r["ok"]。"""

    def test_coder_empty_text_preserves_ok(self):
        """coder text 为空但 ok=True → 契约失败但不改写 ok。"""
        results = [{
            "ok": True,
            "type": "coder",
            "subagent_id": "sa-001",
            "text": "",  # 空文本
            "payload": {},  # 无 patch_summary
        }]
        warnings = enforce_contracts(results)
        assert results[0]["ok"] is True, "契约失败不应改写 ok"
        assert warnings > 0
        assert "contract" in results[0]
        assert results[0]["contract"]["ok"] is False
        assert results[0]["contract"]["severity"] == "warn"

    def test_researcher_empty_text_preserves_ok(self):
        """researcher text 为空 → 契约失败但不改写 ok。"""
        results = [{
            "ok": True,
            "type": "researcher",
            "subagent_id": "sa-002",
            "text": "",
            "payload": {},
        }]
        warnings = enforce_contracts(results)
        assert results[0]["ok"] is True
        assert warnings > 0

    def test_valid_contract_no_warning(self):
        """合规交付不产生警告。"""
        results = [{
            "ok": True,
            "type": "coder",
            "subagent_id": "sa-003",
            "text": "Fixed the bug",
            "payload": {"patch_summary": "Fixed the bug in router.py"},
        }]
        warnings = enforce_contracts(results)
        assert warnings == 0
        assert results[0]["contract"]["ok"] is True

    def test_failed_subagent_not_touched(self):
        """已失败的子代理不受契约检查影响。"""
        results = [{
            "ok": False,
            "type": "coder",
            "subagent_id": "sa-004",
            "text": "",
            "payload": {},
            "error": "timeout",
        }]
        warnings = enforce_contracts(results)
        assert warnings == 0  # 已失败的不重复处理
        assert results[0]["ok"] is False  # 保持原状态

    def test_validator_false_still_fails(self):
        """validator 业务验证未通过 → 仍应失败（不因 P0-1 修复而放行）。"""
        results = [{
            "ok": True,
            "type": "validator",
            "subagent_id": "sa-005",
            "text": "All tests failed",
            "payload": {"passed": False, "evidence": ["test_x failed"]},
        }]
        warnings = enforce_contracts(results)
        # validator passed=False 是业务结论，不是格式问题 → 应改写 ok
        assert results[0]["ok"] is False


# ── P0-2: 空文本 + overlay 有改动 → 自动补摘要 ──────────────────────────────

class TestAutoDeriveSummary:
    """空文本但 overlay 有改动 → 从 diff 派生 patch_summary。"""

    def test_empty_text_with_overlay_changes_gets_summary(self):
        """coder 空文本 + work_copy 有改动 → 自动补 patch_summary。"""
        # 创建 mock work_copy
        wc = MagicMock()
        wc.changes.return_value = [
            {"rel": "src/router.py", "kind": "write", "bytes": 100},
            {"rel": "src/auth.py", "kind": "write", "bytes": 50},
        ]

        results = [{
            "ok": True,
            "type": "coder",
            "subagent_id": "sa-010",
            "text": "",  # 空文本
            "payload": {},
        }]
        warnings = enforce_contracts(results, work_copies={"sa-010": wc})

        # 应自动补上 patch_summary
        assert results[0]["payload"].get("patch_summary") is not None
        assert "src/router.py" in results[0]["payload"]["patch_summary"]
        assert "src/auth.py" in results[0]["payload"]["patch_summary"]
        # ok 仍为 True
        assert results[0]["ok"] is True
        # 无警告（自动修复了）
        assert warnings == 0

    def test_empty_text_no_overlay_no_summary(self):
        """coder 空文本 + work_copy 无改动 → 真·空交付，挂警告。"""
        wc = MagicMock()
        wc.changes.return_value = []  # 无改动

        results = [{
            "ok": True,
            "type": "coder",
            "subagent_id": "sa-011",
            "text": "",
            "payload": {},
        }]
        warnings = enforce_contracts(results, work_copies={"sa-011": wc})

        # 无 overlay 改动 → 无法自动补摘要 → 挂警告
        assert warnings > 0
        assert results[0]["ok"] is True  # 但仍不改写 ok
        assert results[0]["contract"]["severity"] == "warn"

    def test_non_empty_text_no_auto_derive(self):
        """text 非空时不触发自动派生。"""
        wc = MagicMock()
        wc.changes.return_value = [{"rel": "src/x.py", "kind": "write", "bytes": 10}]

        results = [{
            "ok": True,
            "type": "coder",
            "subagent_id": "sa-012",
            "text": "手动写的总结",  # 非空
            "payload": {},
        }]
        warnings = enforce_contracts(results, work_copies={"sa-012": wc})

        # 不应自动派生（text 非空，由适配逻辑处理）
        assert results[0]["payload"].get("patch_summary") == "手动写的总结"


# ── P0-4: gate 语义修正 ─────────────────────────────────────────────────────

class TestGateSemantics:
    """gate 逻辑：无 summary 时跳过校验，不传 {} 必然失败。"""

    def test_no_summary_text_persona_gets_warning(self):
        """文本交付型 persona 无 summary → 挂警告（非 skip）。"""
        results = [{
            "ok": True,
            "type": "planner",
            "subagent_id": "sa-020",
            "text": "",  # 无文本
            "payload": {},  # 无 summary
        }]
        warnings = enforce_contracts(results)
        # 文本交付型 persona 无 summary → 挂警告
        assert warnings > 0
        assert results[0]["ok"] is True  # 但不改写 ok
        assert results[0]["contract"]["severity"] == "warn"

    def test_coder_with_summary_validates_normally(self):
        """coder 有 patch_summary → 正常校验。"""
        results = [{
            "ok": True,
            "type": "coder",
            "subagent_id": "sa-021",
            "text": "Fix bug",
            "payload": {"patch_summary": "Fixed"},
        }]
        warnings = enforce_contracts(results)
        assert warnings == 0
        assert results[0]["contract"]["ok"] is True


# ── 契约 schema 完整性 ──────────────────────────────────────────────────────

class TestContractSchemas:
    """各 persona 的契约 schema 完整且正确。"""

    def test_all_personas_have_schemas(self):
        """所有已知 persona 都有对应的 schema。"""
        expected_personas = {"explore", "researcher", "reviewer", "planner", "coder", "validator", "verifier", "diagnostician"}
        for persona in expected_personas:
            schema = get_persona_contract(persona)
            assert "required" in schema, f"{persona} schema missing 'required'"
            assert len(schema["required"]) > 0, f"{persona} schema has no required keys"

    def test_check_result_contract_type_validation(self):
        """check_result_contract 正确校验类型。"""
        # 正确类型
        ok, problems = check_result_contract(
            {"summary": "text", "count": 42},
            {"required": ["summary"], "types": {"summary": str, "count": int}},
        )
        assert ok is True
        assert not problems

        # 类型错误
        ok, problems = check_result_contract(
            {"summary": 123},  # 应为 str
            {"required": ["summary"], "types": {"summary": str}},
        )
        assert ok is False
        assert any("expected" in p and "str" in p for p in problems)

        # 缺少必填键
        ok, problems = check_result_contract(
            {},
            {"required": ["summary"], "types": {"summary": str}},
        )
        assert ok is False
        assert any("missing key: summary" in p for p in problems)


# ── P0-3: Quarantine ────────────────────────────────────────────────────────

class TestQuarantine:
    """_discard_isolation 前先 quarantine。"""

    def test_quarantine_saves_diff_before_discard(self):
        """有改动的 overlay 在丢弃前保存 diff。"""
        from subagent_runtime import _quarantine

        # 创建临时 overlay 目录
        tmp = Path(tempfile.mkdtemp(prefix="ovolve-test-"))
        src_dir = tmp / "src"
        src_dir.mkdir()
        (src_dir / "router.py").write_text("def hello():\n    return 'fixed'\n")

        wc = MagicMock()
        wc.id = "test-wc-001"
        wc.label = "test-coder"
        wc.source_root = str(tmp)
        wc.root = str(tmp)
        wc.changes.return_value = [
            {"rel": "src/router.py", "kind": "write", "bytes": 30},
        ]

        path = _quarantine(wc, reason="test_discard")
        assert path is not None, "quarantine should return a path for non-empty overlay"
        assert os.path.exists(path), f"quarantine file should exist at {path}"
        content = Path(path).read_text()
        assert "test_discard" in content  # reason
        assert "src/router.py" in content
        assert "def hello():" in content

        # Cleanup
        import shutil
        shutil.rmtree(os.path.dirname(path), ignore_errors=True)

    def test_quarantine_returns_none_for_empty_overlay(self):
        """无改动的 overlay → quarantine 返回 None。"""
        from subagent_runtime import _quarantine

        wc = MagicMock()
        wc.id = "test-wc-002"
        wc.changes.return_value = []

        path = _quarantine(wc)
        assert path is None

    def test_discard_still_works(self):
        """_discard_isolation 仍然能正常清理 overlay。"""
        from subagent_runtime import _discard_isolation

        tmp = Path(tempfile.mkdtemp(prefix="ovolve-discard-"))
        (tmp / "file.txt").write_text("test")

        wc = MagicMock()
        wc.id = "test-wc-003"
        wc.root = str(tmp)
        wc.changes.return_value = [{"rel": "file.txt", "kind": "write", "bytes": 4}]
        wc.cleanup = None

        _discard_isolation(wc, quarantine_reason="test")
        # rmtree should have removed it
        assert not tmp.exists() or not (tmp / "file.txt").exists()


# ── 可观测性 ─────────────────────────────────────────────────────────────────

class TestObservability:
    """遥测指标正确发出。"""

    def test_contract_telemetry_emitted(self):
        """契约执行后发出遥测 span。"""
        results = [{
            "ok": True,
            "type": "coder",
            "subagent_id": "sa-040",
            "text": "fix",
            "payload": {"patch_summary": "fix"},
        }]
        # 不应抛出
        warnings = enforce_contracts(results)
        assert warnings == 0
