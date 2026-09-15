"""test_p0_p1_speed_and_cache.py - Verification for P0 and P1 Speed and Cache optimizations."""
import time
import pytest
from active_memory import CircuitBreaker, BreakerState, build_active_memory
from router import EnvironmentSnapshot
from storage import Storage
from context_compactor import ContextCompactor
from tools import shorten_path


def test_circuit_breaker_single_probe_in_half_open():
    """Verify that only a single probe is admitted during HALF_OPEN state."""
    breaker = CircuitBreaker(failure_threshold=2, cooldown_seconds=1.0)
    now = 1000.0

    # Normal state
    assert breaker.state == BreakerState.CLOSED
    assert breaker.allow(now) is True

    # 2 failures trip to OPEN
    breaker.mark_failure(now)
    breaker.mark_failure(now)
    assert breaker.state == BreakerState.OPEN
    assert breaker.allow(now + 0.5) is False

    # After cooldown: first call transitions to HALF_OPEN and acquires probe
    assert breaker.allow(now + 1.1) is True
    assert breaker.state == BreakerState.HALF_OPEN

    # Concurrent second call while probe is in flight MUST fail-fast
    assert breaker.allow(now + 1.2) is False

    # Successful probe closes breaker and resets probe flag
    breaker.mark_success()
    assert breaker.state == BreakerState.CLOSED
    assert breaker.allow(now + 1.3) is True


def test_build_active_memory_fail_closed():
    """Verify that exceptions in prefetch do not fallback to unscoped calls."""
    class FlakyLayer:
        def __init__(self):
            self.calls = []

        def prefetch(self, query, **kwargs):
            self.calls.append((query, kwargs))
            if "root" in kwargs or "root_dir" in kwargs:
                raise RuntimeError("Scoped DB error")
            return "unscoped data"

    layer = FlakyLayer()
    active = build_active_memory(layer)

    wrapped_xml, meta = active.recall("ws_1", "test query", session_id="s_1", branch_id="b_1")
    # Must fail-closed (empty string), NOT falling back to unscoped prefetch
    assert wrapped_xml == ""
    # Scoped parameters were passed in the single attempted call
    assert len(layer.calls) == 1
    assert layer.calls[0][1].get("root") == "ws_1" or layer.calls[0][1].get("root_dir") == "ws_1"


def test_environment_snapshot_caching_and_invalidation(tmp_path):
    """Verify EnvironmentSnapshot short TTL cache and explicit invalidation."""
    ws = str(tmp_path)
    snap1 = EnvironmentSnapshot.build(ws)
    assert shorten_path(ws) in snap1 or ws in snap1

    # Immediate second call should be cached (identical output within 2.5s)
    snap2 = EnvironmentSnapshot.build(ws)
    assert snap1 == snap2

    # Invalidation clears cache
    EnvironmentSnapshot.invalidate(ws)
    snap3 = EnvironmentSnapshot.build(ws)
    assert snap3 == snap1


def test_context_compactor_incremental_precheck():
    """Verify precheck_inline trims oversized tool outputs incrementally."""
    compactor = ContextCompactor(max_tokens=5000)
    compactor.inline_precheck_ratio = 0.8
    compactor.inline_keep_recent = 1
    compactor.inline_trim_chars = 4000

    # Create messages where an older tool message is massive
    massive_tool_content = "LOG LINE " * 2000
    messages = [
        {"role": "user", "content": "run task"},
        {"role": "assistant", "content": "running command"},
        {"role": "tool", "tool_call_id": "c1", "content": massive_tool_content},
        {"role": "assistant", "content": "next command"},
        {"role": "tool", "tool_call_id": "c2", "content": "ok"},
    ]

    report = compactor.precheck_inline(messages, overhead_tokens=100)
    assert report["pruned"] >= 1
    assert report["fits"] is True
    assert "[本轮上下文超额，此条工具输出已就地剪短" in messages[2]["content"]
    assert messages[4]["content"] == "ok"  # recent tool message kept intact


def test_storage_embedding_cache_batch_flush(tmp_path):
    """Verify storage embedding cache buffers hits and flushes properly."""
    storage = Storage(db_dir=str(tmp_path))

    vec = [0.1, 0.2, 0.3, 0.4]
    storage.save_cached_embedding("local", "model-1", "test prompt", vec)

    # Read back hit
    retrieved = storage.get_cached_embedding("local", "model-1", "test prompt")
    assert retrieved == vec
    assert len(storage._emb_hits_buffer) == 1

    # Explicit flush
    storage.flush_embedding_cache_hits()
    assert len(storage._emb_hits_buffer) == 0

    stats = storage.embedding_cache_stats()
    assert stats["rows"] == 1
    assert stats["hits"] >= 1
