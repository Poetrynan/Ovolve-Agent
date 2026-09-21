"""Unit tests for 4-Stage DispatchPipeline and TeamBoard DAG dependency execution."""
import pytest
from team import DispatchPipeline, TeamBoard, check_result_contract, role_spec
from subagent_runtime import SubagentStatus, SubagentSession, recover_orphaned_subagents, get_subagent_runtime
from storage import Storage


def make_storage(tmp_path):
    return Storage(db_dir=str(tmp_path / "db"))


def test_dispatch_pipeline_four_stages():
    pipeline = DispatchPipeline(max_concurrent=8, max_depth=2)

    # Stage 1: Admission
    admitted, err = pipeline.admit(current_concurrent=2, depth=1, token_budget=50_000)
    assert admitted is True
    assert err == ""

    # Rejection on max concurrent
    admitted, err = pipeline.admit(current_concurrent=8, depth=1)
    assert admitted is False
    assert "concurrency limit reached" in err

    # Rejection on max depth
    admitted, err = pipeline.admit(current_concurrent=1, depth=3)
    assert admitted is False
    assert "depth exceeded" in err

    # Stage 2: Steer
    steer_review = pipeline.steer("Please review and check the diff")
    assert steer_review["role"] == "reviewer"

    steer_search = pipeline.steer("Please explore and search the database files")
    assert steer_search["role"] == "researcher"

    # Stage 3: Dispatch
    ctx = pipeline.dispatch("task-123", steer_review, "parent-session-abc")
    assert ctx["task_id"] == "task-123"
    assert ctx["parent_session_id"] == "parent-session-abc"
    assert ctx["child_session_id"].startswith("subagent-")

    # Stage 4: Delivery
    schema = {"required": ["summary"], "types": {"summary": str}}
    ok, probs = pipeline.deliver({"summary": "Done"}, schema)
    assert ok is True

    ok, probs = pipeline.deliver({"wrong": 123}, schema)
    assert ok is False
    assert any("missing key: summary" in p for p in probs)


def test_teamboard_dag_dependency_execution(tmp_path):
    storage = make_storage(tmp_path)
    board = TeamBoard(storage, "parent-run-dag")

    # Add DAG tasks: Task A -> Task B -> Task C
    # Task A has no dependencies
    board.add_task("task-a", "researcher")
    # Task B depends on Task A
    board.add_task("task-b", "coder", depends_on=["task-a"])
    # Task C depends on Task B
    board.add_task("task-c", "reviewer", depends_on=["task-b"])

    # Initially only Task A is runnable
    assert board.can_run("task-a") is True
    assert board.can_run("task-b") is False
    assert board.can_run("task-c") is False
    assert board.get_runnable_tasks() == ["task-a"]

    # Claim and deliver Task A
    board.claim("task-a", "worker-1")
    ok, probs = board.deliver("task-a", "worker-1", {"findings": ["Found files"]})
    assert ok is True

    # Now Task B becomes runnable
    assert board.can_run("task-b") is True
    assert board.can_run("task-c") is False
    assert board.get_runnable_tasks() == ["task-b"]

    # Claim and deliver Task B
    board.claim("task-b", "worker-2")
    ok, probs = board.deliver("task-b", "worker-2", {"patch_summary": "Added feature"})
    assert ok is True

    # Now Task C becomes runnable
    assert board.can_run("task-c") is True
    assert board.get_runnable_tasks() == ["task-c"]


def test_teamboard_dag_cascade_failure_blocking(tmp_path):
    storage = make_storage(tmp_path)
    board = TeamBoard(storage, "parent-run-cascade")

    board.add_task("task-1", "researcher")
    board.add_task("task-2", "coder", depends_on=["task-1"])

    # Task 1 fails delivery
    board.claim("task-1", "worker-1")
    ok, probs = board.deliver("task-1", "worker-1", {"invalid_payload": True})
    assert ok is False

    # Cascade failure should mark task-2 as blocked
    blocked = board.cascade_failures()
    assert blocked == 1
    assert board._tasks["task-2"]["status"] == "blocked"
    assert board.can_run("task-2") is False


def test_subagent_orphan_recovery():
    # Insert mock stuck session
    mock_sess = SubagentSession(
        subagent_id="stuck-sub-1",
        subagent_type="coder",
        label="Stuck Worker",
        parent_session_id="parent-sess-stuck",
        child_session_id="child-sess-stuck",
        status=SubagentStatus.RUNNING,
    )
    runtime = get_subagent_runtime()
    runtime._sessions["stuck-sub-1"] = mock_sess

    recovered = recover_orphaned_subagents("parent-sess-stuck")
    assert len(recovered) == 1
    assert recovered[0]["subagentId"] == "stuck-sub-1"
    assert mock_sess.status == SubagentStatus.ORPHAN_RECOVERED
    assert mock_sess.finished_at > 0
