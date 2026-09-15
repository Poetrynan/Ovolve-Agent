# -*- coding: utf-8 -*-
import pytest
from team import (
    DispatchPipeline,
    TaskSpec,
    TeamBoard,
    build_task_spec,
    prefetch_context_refs,
    validate_task_spec,
)
from storage import Storage


def test_task_spec_dataclass_and_serialization():
    spec = TaskSpec(
        goal="Refactor auth middleware to use JWT",
        in_scope=["app/backend/auth.py", "app/backend/jwt_utils.py"],
        out_of_scope=["app/frontend/*", "database schema migrations"],
        acceptance=[
            "All unit tests in test_auth.py pass",
            "Tokens expire in 3600 seconds",
        ],
        context_refs=[
            {"symbol": "verify_token", "path": "app/backend/auth.py", "line": 42}
        ],
    )
    d = spec.to_dict()
    assert d["goal"] == "Refactor auth middleware to use JWT"
    assert "app/backend/auth.py" in d["in_scope"]
    assert "database schema migrations" in d["out_of_scope"]
    assert len(d["acceptance"]) == 2
    assert len(d["context_refs"]) == 1

    restored = TaskSpec.from_dict(d)
    assert restored.goal == spec.goal
    assert restored.in_scope == spec.in_scope
    assert restored.out_of_scope == spec.out_of_scope
    assert restored.acceptance == spec.acceptance
    assert restored.context_refs == spec.context_refs


def test_build_and_validate_task_spec():
    # 1. Valid spec
    spec_dict = build_task_spec(
        goal="Implement caching layer",
        in_scope=["cache.py"],
        out_of_scope=["db.py"],
        acceptance=["Cache hit ratio >= 80%"],
    )
    ok, problems = validate_task_spec(spec_dict)
    assert ok is True
    assert len(problems) == 0

    # 2. Ambiguous / incomplete spec: missing goal
    with pytest.raises(ValueError, match="goal must be a non-empty string"):
        build_task_spec(goal="")

    # 3. Missing acceptance assertions detected as spec ambiguity
    incomplete_spec = {
        "goal": "Do something vague",
        "in_scope": [],
        "out_of_scope": [],
        "acceptance": [],
        "context_refs": [],
    }
    ok, problems = validate_task_spec(incomplete_spec)
    assert ok is False
    assert any("acceptance" in p.lower() for p in problems)


def test_dispatch_pipeline_with_spec_contract():
    pipeline = DispatchPipeline()
    spec = build_task_spec(
        goal="Audit endpoint security",
        in_scope=["endpoints.py"],
        out_of_scope=["test_*.py"],
        acceptance=["No SQL injection or XSS"],
        context_refs=[{"symbol": "login_handler", "path": "endpoints.py"}],
    )

    steer_info = {"role": "reviewer", "persona": "reviewer"}
    dispatched = pipeline.dispatch(
        task_id="sec-audit-1",
        role_info=steer_info,
        parent_session_id="parent-session-999",
        task_spec=spec,
    )

    assert dispatched["task_id"] == "sec-audit-1"
    assert "spec" in dispatched
    assert dispatched["spec"]["goal"] == "Audit endpoint security"
    assert dispatched["spec"]["in_scope"] == ["endpoints.py"]
    assert dispatched["spec"]["context_refs"][0]["symbol"] == "login_handler"


def test_teamboard_stores_and_queries_spec(tmp_path):
    storage = Storage(db_dir=str(tmp_path / "db"))
    board = TeamBoard(storage, "parent-run-spec")

    spec = TaskSpec(
        goal="Optimize SQL queries",
        in_scope=["query.py"],
        acceptance=["Latency must be less than 50ms"],
    )

    entry = board.add_task("task-opt-sql", "coder", task_spec=spec)
    assert "spec_contract" in entry
    assert entry["spec_contract"]["goal"] == "Optimize SQL queries"

    retrieved = board.get_task_spec("task-opt-sql")
    assert retrieved is not None
    assert retrieved.goal == "Optimize SQL queries"
    assert retrieved.in_scope == ["query.py"]


def test_prefetch_context_refs_fallback():
    refs = prefetch_context_refs(["non_existent_symbol_xyz"], root_dir="/dummy")
    assert isinstance(refs, list)
