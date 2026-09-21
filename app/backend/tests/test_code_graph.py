# -*- coding: utf-8 -*-
"""Unit and integration tests for CKG-lite (Code Knowledge Graph lite) Phase 1."""
from __future__ import annotations

import os
import sys
import time
import tempfile
import pytest

from code_graph import CodeKnowledgeGraph, CodeSymbol, CodeEdge, ASTGraphExtractor
from result import Result


@pytest.fixture
def temp_kg(tmp_path):
    """Fixture providing a fresh in-memory or temp-file CodeKnowledgeGraph."""
    db_path = str(tmp_path / "test_code_graph.db")
    kg = CodeKnowledgeGraph(db_path=db_path)
    yield kg
    kg.close()


def test_schema_initialization(temp_kg):
    """Verify that tables and indexes are created properly on init."""
    tables = temp_kg._conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    table_names = {r["name"] for r in tables}
    assert "cg_files" in table_names
    assert "cg_symbols" in table_names
    assert "cg_edges" in table_names

    indices = temp_kg._conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index'"
    ).fetchall()
    index_names = {r["name"] for r in indices}
    assert "idx_symbols_name" in index_names
    assert "idx_edges_dst" in index_names


def test_ast_extraction_functions_and_classes(tmp_path, temp_kg):
    """Verify extraction of functions, classes, methods, docstrings, and inheritance."""
    code = '''"""Module docstring."""

class BaseService:
    pass

class DataProcessor(BaseService):
    """Processor docstring."""
    def __init__(self, name: str):
        self.name = name

    def process(self, item):
        return item * 2

def helper_function(x):
    return x + 1
'''
    py_file = tmp_path / "sample.py"
    py_file.write_text(code, encoding="utf-8")

    indexed = temp_kg.index_file(str(py_file))
    assert indexed is True

    # Check definitions
    classes = temp_kg.find_definitions("DataProcessor")
    assert len(classes) == 1
    assert classes[0]["kind"] == "class"
    assert classes[0]["line"] == 6
    assert "Processor docstring." in (classes[0]["docstring"] or "")

    methods = temp_kg.find_definitions("process")
    assert len(methods) == 1
    assert methods[0]["kind"] == "method"
    assert methods[0]["scope"] == "DataProcessor"

    funcs = temp_kg.find_definitions("helper_function")
    assert len(funcs) == 1
    assert funcs[0]["kind"] == "function"
    assert funcs[0]["line"] == 14

    # Check inheritance edge
    edges = temp_kg.find_references("BaseService")
    inherit_edges = [e for e in edges if e["kind"] == "inherits"]
    assert len(inherit_edges) >= 1
    assert inherit_edges[0]["src_name"] == "DataProcessor"


def test_ast_extraction_calls_and_imports(tmp_path, temp_kg):
    """Verify extraction of function/method calls and import dependencies."""
    code = '''import os
from math import sqrt

def calculate(val):
    res = sqrt(val)
    return res

def run():
    v = calculate(16)
    print(v)
'''
    py_file = tmp_path / "caller_sample.py"
    py_file.write_text(code, encoding="utf-8")

    temp_kg.index_file(str(py_file))

    # Check imports
    sqrt_refs = temp_kg.find_references("sqrt")
    import_refs = [r for r in sqrt_refs if r["kind"] == "imports"]
    assert len(import_refs) >= 1
    assert import_refs[0]["file"] == str(py_file)

    # Check call references to 'calculate'
    calc_refs = temp_kg.find_references("calculate")
    call_refs = [r for r in calc_refs if r["kind"] == "calls"]
    assert len(call_refs) >= 1
    assert call_refs[0]["caller_name"] == "run"
    assert call_refs[0]["line"] == 9


def test_find_callees(tmp_path, temp_kg):
    """Verify finding what a function calls (callees)."""
    code = '''def step_a(): pass
def step_b(): pass

def orchestrate():
    step_a()
    step_b()
'''
    py_file = tmp_path / "orch.py"
    py_file.write_text(code, encoding="utf-8")
    temp_kg.index_file(str(py_file))

    callees = temp_kg.find_callees("orchestrate")
    callee_names = {c["dst_name"] for c in callees}
    assert "step_a" in callee_names
    assert "step_b" in callee_names


def test_neighbors_graph_traversal(tmp_path, temp_kg):
    """Verify 1-hop and 2-hop neighborhood expansion."""
    code = '''def func_c(): pass
def func_b(): func_c()
def func_a(): func_b()
'''
    py_file = tmp_path / "chain.py"
    py_file.write_text(code, encoding="utf-8")
    temp_kg.index_file(str(py_file))

    # 1-hop from func_b: should see func_c (callee) and func_a (caller)
    nbrs_1 = temp_kg.neighbors("func_b", depth=1)
    connected_nodes = {n["name"] for n in nbrs_1["nodes"]}
    assert "func_b" in connected_nodes
    assert "func_c" in connected_nodes
    assert "func_a" in connected_nodes

    # 2-hop from func_a: should reach func_c
    nbrs_2 = temp_kg.neighbors("func_a", depth=2)
    connected_2 = {n["name"] for n in nbrs_2["nodes"]}
    assert "func_c" in connected_2


def test_incremental_indexing(tmp_path, temp_kg):
    """Verify mtime caching, incremental update and deletion cleanup."""
    py_file = tmp_path / "incremental.py"
    py_file.write_text("def v1_func(): pass\n", encoding="utf-8")

    # 1. Initial index
    res1 = temp_kg.index_file(str(py_file))
    assert res1 is True
    assert len(temp_kg.find_definitions("v1_func")) == 1

    # 2. Re-index without change -> skipped
    res2 = temp_kg.index_file(str(py_file))
    assert res2 is False

    # 3. Modify file
    time.sleep(0.05)
    py_file.write_text("def v2_func(): pass\n", encoding="utf-8")
    res3 = temp_kg.index_file(str(py_file))
    assert res3 is True

    # Old symbol should be gone, new symbol present
    assert len(temp_kg.find_definitions("v1_func")) == 0
    assert len(temp_kg.find_definitions("v2_func")) == 1

    # 4. Remove file
    temp_kg.remove_file(str(py_file))
    assert len(temp_kg.find_definitions("v2_func")) == 0
    assert temp_kg.get_summary()["total_files"] == 0


def test_syntax_error_resilience(tmp_path, temp_kg):
    """Verify that malformed Python files fail-open without raising exceptions."""
    bad_file = tmp_path / "broken.py"
    bad_file.write_text("def broken_syntax(:\n   ???", encoding="utf-8")

    res = temp_kg.index_file(str(bad_file))
    assert res is False

    # Valid file in same directory indexes fine
    good_file = tmp_path / "good.py"
    good_file.write_text("def good_func(): return True\n", encoding="utf-8")
    res_good = temp_kg.index_file(str(good_file))
    assert res_good is True
    assert len(temp_kg.find_definitions("good_func")) == 1


def test_workspace_indexing_and_speed(tmp_path, temp_kg):
    """Verify multi-file workspace indexing and <100ms reference query latency."""
    # Create a small multi-module workspace
    pkg = tmp_path / "my_package"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "core.py").write_text('''
def execute_task(task_id: str):
    return f"done_{task_id}"
''', encoding="utf-8")

    (pkg / "service.py").write_text('''
from my_package.core import execute_task

def run_service():
    return execute_task("job_1")
''', encoding="utf-8")

    (pkg / "controller.py").write_text('''
from my_package.core import execute_task

def handle_request():
    return execute_task("web_1")
''', encoding="utf-8")

    stats = temp_kg.index_workspace(str(tmp_path))
    assert stats["indexed_files"] >= 3
    assert stats["total_symbols"] >= 3

    # Measure latency of find_references
    t0 = time.perf_counter()
    refs = temp_kg.find_references("execute_task")
    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    assert len(refs) >= 2
    caller_names = {r.get("caller_name") for r in refs if r["kind"] == "calls"}
    assert "run_service" in caller_names
    assert "handle_request" in caller_names
    # Strict requirement: < 100ms
    assert elapsed_ms < 100.0


def test_tool_integration_code_references(tmp_path):
    """Verify code_references tool definition and execution output."""
    from code_graph import execute_code_references_tool
    db_file = tmp_path / "kg.db"
    kg = CodeKnowledgeGraph(db_path=str(db_file))

    f = tmp_path / "app.py"
    f.write_text('''
def my_api_entry():
    return 42

def caller_view():
    return my_api_entry()
''', encoding="utf-8")
    kg.index_file(str(f))

    # Query tool
    res = execute_code_references_tool(
        {"symbol": "my_api_entry", "include_callers": True, "depth": 1},
        ctx={"code_graph": kg, "workspace_root": str(tmp_path)},
    )
    assert res.ok is True
    assert "my_api_entry" in res.value
    assert "caller_view" in res.value
    kg.close()


def test_shadow_precheck_impact_assessment(tmp_path, temp_kg):
    """Verify caller count and affected files query for pre-refactor impact assessment."""
    f1 = tmp_path / "mod1.py"
    f1.write_text("def target_symbol(): pass\n", encoding="utf-8")
    f2 = tmp_path / "mod2.py"
    f2.write_text("from mod1 import target_symbol\ndef call1(): target_symbol()\n", encoding="utf-8")
    f3 = tmp_path / "mod3.py"
    f3.write_text("from mod1 import target_symbol\ndef call2(): target_symbol()\n", encoding="utf-8")

    temp_kg.index_workspace(str(tmp_path))

    impact = temp_kg.assess_symbol_impact("target_symbol")
    assert impact["symbol"] == "target_symbol"
    assert impact["caller_count"] == 2
    assert len(impact["affected_files"]) >= 2
    assert "call1" in impact["callers"]
    assert "call2" in impact["callers"]
