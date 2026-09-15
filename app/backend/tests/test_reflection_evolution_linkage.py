"""
test_reflection_evolution_linkage.py — Reflexion 深度反思与自进化待审提案自动提议联动测试 (Phase 60)。
"""
import pytest
import os
import sys
import tempfile

backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from storage import Storage
from reflection_engine import Reflection, ReflectionStore
from evolution import EvolutionEngine


def test_reflection_bridges_to_evolution_proposal():
    with tempfile.TemporaryDirectory() as tmp_dir:
        st = Storage(db_dir=tmp_dir)
        setattr(st, "_active_workspace", tmp_dir)
        store = ReflectionStore(storage=st)

        # 1. 产生一条高置信度的工具执行失败反思
        ref = Reflection(
            id="ref_bash_001",
            scenario="执行系统级高危删除命令未做二次校验",
            root_cause="命令直接执行了 rm -rf，导致潜在文件误删风险",
            alternative_strategy="在执行高危命令前请求用户显式许可",
            prevention_rule="执行敏感系统命令前必须先向用户说明意图并等待确认",
            confidence=0.92,
            source_tool="run_command",
            tags=["safety", "bash"]
        )

        # 2. 保存反思
        ok = store.save_reflection(ref)
        assert ok is True

        # 3. 验证 EvolutionEngine 的待审提案列表中是否已自动生成对应的 pending proposal
        evo_engine = EvolutionEngine(workspace_root=tmp_dir, storage=st)
        proposals = evo_engine.store.open_proposals()
        assert len(proposals) >= 1

        matched = any("执行敏感系统命令前" in (p.draft or "") or "run_command" == p.tool_name for p in proposals)
        assert matched, f"Expected bridged proposal from reflection in {proposals}"

        evo_engine.store.close()
        st.close()
