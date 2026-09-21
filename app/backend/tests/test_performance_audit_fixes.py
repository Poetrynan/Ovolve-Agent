import asyncio
import os
import time
import pytest
from active_memory import ActiveMemory, CircuitBreaker
from rate_limiter import get_rate_limiter, RateLimiter
from router import EnvironmentSnapshot, Router
from storage import Storage
from llm_client import close_shared_sessions, _get_shared_session


def test_rate_limiter_configure():
    limiter = get_rate_limiter()
    config = {
        "model": {
            "base_url": "https://api.test-provider.com/v1",
            "rate_limit": {"rpm": 120, "tpm": 100000}
        }
    }
    installed = limiter.configure(config)
    assert installed >= 1
    assert "https://api.test-provider.com/v1" in limiter._quotas


def test_active_memory_single_flight():
    call_count = 0

    def slow_retrieve(query, limit=5, root="", session_id="", branch_id=""):
        nonlocal call_count
        call_count += 1
        time.sleep(0.05)
        return f"result for {query}"

    mem = ActiveMemory(retrieval_fn=slow_retrieve, timeout=2.0)

    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        f1 = ex.submit(mem._submit, "test_query", 5, root="ws")
        f2 = ex.submit(mem._submit, "test_query", 5, root="ws")
        r1 = f1.result()
        r2 = f2.result()

    assert r1 == "result for test_query"
    assert r2 == "result for test_query"
    assert call_count == 1
    assert mem.stats["singleflight_dedupes"] == 1


def test_active_memory_single_flight_timeout_retention():
    call_count = 0

    def very_slow_retrieve(query, limit=5, root="", session_id="", branch_id=""):
        nonlocal call_count
        call_count += 1
        time.sleep(0.2)
        return f"slow result for {query}"

    # Set caller timeout to 0.05s, while retrieval takes 0.2s
    mem = ActiveMemory(retrieval_fn=very_slow_retrieve, timeout=0.05)

    # Caller 1: times out
    with pytest.raises(TimeoutError):
        mem._submit("slow_query", 5, root="ws")

    # Verify Future is STILL running and retained in _in_flight (not popped prematurely on timeout!)
    with mem._in_flight_lock:
        assert len(mem._in_flight) == 1

    # Caller 2 with longer timeout connects to the existing in-flight future
    mem.timeout = 0.5
    res = mem._submit("slow_query", 5, root="ws")
    assert res == "slow result for slow_query"
    assert call_count == 1  # No duplicate background thread was launched!
    assert mem.stats["singleflight_dedupes"] == 1

    # After completion, verify atomic cleanup
    time.sleep(0.05)
    with mem._in_flight_lock:
        assert len(mem._in_flight) == 0


def test_search_memory_fts_scope_isolation(tmp_path):
    db_path = str(tmp_path / "test_fts_scope.db")
    storage = Storage(db_path)
    root = str(tmp_path)

    # Entry 1: session-scoped for sess-1
    storage.save_memory_entry(
        "mem-s1", "sess-1", root, "session",
        "Python typing guidelines for session 1",
        mem_type="fact", importance=0.9
    )
    # Entry 2: session-scoped for sess-2
    storage.save_memory_entry(
        "mem-s2", "sess-2", root, "session",
        "Python typing guidelines for session 2",
        mem_type="fact", importance=0.95
    )
    # Entry 3: project-scoped (global to workspace)
    storage.save_memory_entry(
        "mem-global", "sess-3", root, "project",
        "Python standard library global guidelines",
        mem_type="fact", importance=0.8
    )

    # Query FTS with session_id="sess-1"
    hits = storage.search_memory_fts(root, "Python", limit=10, session_id="sess-1")
    assert "mem-s1" in hits
    assert "mem-global" in hits
    assert "mem-s2" not in hits  # Must be filtered out at SQL layer!


def test_environment_snapshot_invalidation(tmp_path):
    ws = str(tmp_path)
    s1 = EnvironmentSnapshot.build(ws)
    assert s1 is not None

    (tmp_path / "test.txt").write_text("hello", encoding="utf-8")
    EnvironmentSnapshot.invalidate(ws)

    s2 = EnvironmentSnapshot.build(ws)
    assert s2 is not None
    assert "test.txt" in s2


def test_mutating_workspace_tools_whitelist():
    from router import MUTATING_WORKSPACE_TOOLS
    assert "write_file" in MUTATING_WORKSPACE_TOOLS
    assert "edit_file" in MUTATING_WORKSPACE_TOOLS
    assert "apply_patch" in MUTATING_WORKSPACE_TOOLS
    assert "replace_file_content" in MUTATING_WORKSPACE_TOOLS
    assert "write_to_file" in MUTATING_WORKSPACE_TOOLS
    assert "delete_file" in MUTATING_WORKSPACE_TOOLS
    assert "run_command" in MUTATING_WORKSPACE_TOOLS
    assert "git_commit" in MUTATING_WORKSPACE_TOOLS


def test_hybrid_search_bounded_candidates(tmp_path):
    db_path = str(tmp_path / "test_mem.db")
    storage = Storage(db_path)
    root = str(tmp_path)

    for i in range(15):
        storage.save_memory_entry(
            f"mem-{i}", "sess-1", root, "project",
            f"Memory content {i} regarding python programming",
            mem_type="fact", importance=(i + 1) / 20.0
        )

    fused, coverage = storage.search_memory_hybrid(
        root, query_text="python", keywords=["python"], limit=5
    )
    assert len(fused) > 0
    assert len(fused) <= 15
    assert "_fused" in fused[0] or "id" in fused[0]


@pytest.mark.asyncio
async def test_close_shared_sessions():
    session = await _get_shared_session(5.0)
    assert session is not None
    assert not session.closed

    await close_shared_sessions()
    assert session.closed


def test_active_memory_fast_future_no_leak():
    """Verify that synchronous / ultra-fast future returns never leak into _in_flight."""
    def instant_retrieve(query, limit=5, root="", session_id="", branch_id=""):
        return f"instant {query}"

    mem = ActiveMemory(retrieval_fn=instant_retrieve, timeout=2.0)
    for i in range(20):
        res = mem._submit(f"q_{i}", 5, root="ws")
        assert res == f"instant q_{i}"

    time.sleep(0.02)
    with mem._in_flight_lock:
        assert len(mem._in_flight) == 0


def test_search_memory_fts_fail_closed(tmp_path):
    """Verify that search_memory_fts fails closed on malformed query and never leaks un-scoped rows."""
    db_path = str(tmp_path / "test_fts_fail.db")
    storage = Storage(db_path)
    root = str(tmp_path)

    # Malformed FTS query (unclosed quote / special syntax)
    res = storage.search_memory_fts(root, '"""NOT_A_VALID_FTS_QUERY', limit=10, session_id="sess-1")
    assert res == {}


def test_search_memory_semantic_scoped(tmp_path):
    """Verify that search_memory_semantic adheres strictly to session and branch scopes."""
    db_path = str(tmp_path / "test_semantic_scoped.db")
    storage = Storage(db_path)
    root = str(tmp_path)

    storage.save_memory_entry("m1", "sess-1", root, "session", "apple banana")
    storage.save_memory_entry("m2", "sess-2", root, "session", "apple cherry")
    storage.save_memory_entry("m3", "", root, "project", "apple durian")

    # When searching with sess-1, m2 from sess-2 must NOT appear
    hits = storage.search_memory_semantic(root, keywords=["apple"], session_id="sess-1")
    hit_ids = [h["id"] for h in hits]
    assert "m1" in hit_ids
    assert "m3" in hit_ids
    assert "m2" not in hit_ids
