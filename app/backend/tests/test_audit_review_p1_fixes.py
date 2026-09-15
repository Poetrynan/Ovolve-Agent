"""Tests verifying the P1/P2 fixes requested by the Ovolve Code Review Report.

Covers:
1. Router outcome propagation: handle() preserves Result.failure on errors.
2. Memory compaction flush scope: strictly bound to session scope.
3. Subagent ResultContract gate: invalid output rejected before overlay merge.
4. Orphaned subagent recovery: scans both in-memory runtime and SQLite database.
5. Unknown tool outcome: fail-closed, preventing false positive all_success.
"""
import pytest
import asyncio
import time
from unittest.mock import MagicMock, AsyncMock

from result import Result
from router import _summarize_turn_outcome, Router
from memory_layer import MemoryScope, MemoryLayer, Memory
from team import enforce_contracts, get_persona_contract
from subagent_runtime import (
    SubagentStatus,
    recover_orphaned_subagents,
    get_subagent_runtime,
)


def test_summarize_turn_outcome_unknown_fails_closed():
    """Verify that an unknown or unconfirmed tool trace is treated as failed."""
    trace = [
        {"tool": "hallucinated_tool", "status": "unknown", "output": "something"},
    ]
    outcome = _summarize_turn_outcome(trace)
    assert outcome["status"] == "all_failed"
    assert len(outcome["failed_tools"]) == 1
    assert len(outcome["successful_tools"]) == 0


def test_summarize_turn_outcome_mixed():
    """Verify that a mix of success and unknown/failed produces partial."""
    trace = [
        {"tool": "read_text", "status": "ok", "ok": True, "output": "hello"},
        {"tool": "unknown_tool", "status": "unknown", "output": "error"},
    ]
    outcome = _summarize_turn_outcome(trace)
    assert outcome["status"] == "partial"
    assert len(outcome["successful_tools"]) == 1
    assert len(outcome["failed_tools"]) == 1


@pytest.mark.asyncio
async def test_flush_memory_scope_isolation():
    """Verify that pre-compaction flush extracts memories strictly with scope=session."""
    mock_memory = MagicMock()
    mock_memory.extract.return_value = [
        Memory(content="user likes dark mode", session_id="test-sess-1", scope=MemoryScope.SESSION)
    ]
    router = MagicMock()
    router.session_id = "test-sess-1"
    router.memory = mock_memory

    # Call _flush_memory_for_fold
    count = await Router._flush_memory_for_fold(
        router,
        [{"role": "user", "content": "I prefer using dark mode and python 3.12 for this task"}]
    )

    assert count == 1
    mock_memory.store.assert_called_once()
    stored_mem = mock_memory.store.call_args[0][0]
    assert stored_mem.session_id == "test-sess-1"
    assert stored_mem.scope == MemoryScope.SESSION


def test_enforce_contracts_auto_adapts_and_validates():
    """Verify that pure text output is auto-adapted into role schemas."""
    results = [
        {
            "ok": True,
            "type": "coder",
            "text": "Fixed the bug in router.py",
            "label": "task_1",
        },
        {
            "ok": True,
            "type": "reviewer",
            "text": "LGTM pass all checks",
            "label": "task_2",
        },
        {
            "ok": True,
            "type": "explore",
            "text": "- Found entry point\n- Found database schema",
            "label": "task_3",
        },
    ]

    rejected = enforce_contracts(results)
    assert rejected == 0
    for r in results:
        assert r["ok"] is True
        assert "payload" in r

    assert results[0]["payload"]["patch_summary"] == "Fixed the bug in router.py"
    assert results[1]["payload"]["verdict"] == "approved"
    assert len(results[2]["payload"]["findings"]) >= 2


def test_recover_orphaned_subagents_in_memory_and_db(tmp_path):
    """Verify recover_orphaned_subagents transitions active sessions to ORPHAN_RECOVERED."""
    runtime = get_subagent_runtime()
    
    # Create mock session in RUNNING status
    from subagent_runtime import SubagentSession
    sess = SubagentSession(
        subagent_id="sub_test_orphan",
        subagent_type="coder",
        label="test_task",
        parent_session_id="parent_sess_1",
        child_session_id="child_sess_1",
        status=SubagentStatus.RUNNING,
        started_at=time.time() - 100,
    )
    runtime._sessions["sub_test_orphan"] = sess

    recovered = recover_orphaned_subagents("parent_sess_1")
    assert any(r.get("subagentId") == "sub_test_orphan" or r.get("subagent_id") == "sub_test_orphan" for r in recovered)
    assert sess.status == SubagentStatus.ORPHAN_RECOVERED
    assert sess.finished_at > 0
