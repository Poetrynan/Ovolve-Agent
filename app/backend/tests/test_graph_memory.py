"""
test_graph_memory.py — 实体关系图谱长期记忆引擎单元测试。
"""
import pytest
import os
import sys
import tempfile

backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from storage import Storage
from memory_layer import GraphMemoryEngine


def test_graph_triplets_ingest_and_recall():
    with tempfile.TemporaryDirectory() as tmp_dir:
        st = Storage(db_dir=tmp_dir)
        engine = GraphMemoryEngine(storage=st)

        ws = r"d:\Example Workspace"
        # 1. Ingest triplet: (AntiEarlyQuitGate) --[GUARDS]--> (TurnStatus.COMPLETED)
        rel_id = engine.ingest_triplet(
            root_dir=ws,
            subject="AntiEarlyQuitGate",
            predicate="GUARDS",
            object_val="TurnStatus.COMPLETED",
            subject_type="ArchitecturePattern",
            object_type="StateEnum",
            confidence=0.98
        )
        assert rel_id

        # 2. Ingest another triplet: (AntiEarlyQuitGate) --[TRIGGERS]--> (ReflexionCard)
        engine.ingest_triplet(
            root_dir=ws,
            subject="AntiEarlyQuitGate",
            predicate="TRIGGERS",
            object_val="ReflexionCard",
            subject_type="ArchitecturePattern",
            object_type="UIComponent",
            confidence=0.95
        )

        # 3. Recall associative graph for "AntiEarlyQuitGate"
        edges = engine.recall_associative_graph("AntiEarlyQuitGate", root_dir=ws)
        assert len(edges) >= 2

        # 4. Format for prompt
        prompt_block = engine.format_graph_for_prompt(edges)
        assert "<knowledge_graph>" in prompt_block
        assert "GUARDS" in prompt_block
        assert "TRIGGERS" in prompt_block
        
        st.close()
