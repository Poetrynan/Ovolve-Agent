"""
test_evolution_graph_linkage.py — 自进化提案批准与知识图谱三元组沉淀联动测试 (Phase 60)。
"""
import pytest
import os
import sys
import tempfile

backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import time
from storage import Storage
from evolution import EvolutionEngine, Proposal
from memory_layer import get_graph_memory_engine


def test_evolution_decide_ingests_graph_triplets():
    with tempfile.TemporaryDirectory() as tmp_dir:
        st = Storage(db_dir=tmp_dir)
        engine = EvolutionEngine(workspace_root=tmp_dir, storage=st)

        # 1. 插入一条关于截图路径的自进化提案
        prop = Proposal(
            id="prop_screen_001",
            signature="test:screenshot:path",
            kind="learned_fact",
            tool_name="browser_take_screenshot",
            target_file="AGENTS.md",
            draft="Screenshots are saved to output/ directory.",
            rationale="规范产物统一存放",
            hits=2,
            status="pending",
            created_at=time.time(),
            user_title="截图输出路径约定",
            user_advice="屏幕快照统一保存至 output/",
            user_reason="统一管理"
        )
        engine.store.insert_proposal(prop)

        # 2. 模拟用户批准该提案
        res = engine.decide("prop_screen_001", accept=True)
        assert res["ok"] is True
        assert res["status"] == "accepted"

        # 3. 验证 GraphMemoryEngine 中是否自动建立了 ScreenCapture -> SAVED_TO -> output/ 的关联边
        graph_engine = get_graph_memory_engine(storage=st)
        edges = graph_engine.recall_associative_graph("ScreenCapture", root_dir=tmp_dir)
        
        assert len(edges) >= 1
        found_target = any(e.get("target") == "output/" and e.get("relation") == "SAVED_TO" for e in edges)
        assert found_target, f"Expected SAVED_TO output/ edge in {edges}"

        engine.store.close()
        st.close()
