"""test_p0_cache_governance.py — Automated tests for P0 Cache Governance:
1. ActiveMemory scope isolation (Session A memories not leaked to Session B).
2. Workspace-specific surgical invalidation (Workspace A invalidation leaves Workspace B intact).
3. Provider usage token normalization & TokenAnalytics hit rate formula (DeepSeek, OpenAI, Anthropic).
4. Prompt stable prefix invariance across turns despite dynamic hints.
"""
import pytest
from unittest.mock import MagicMock
from storage import Storage
from active_memory import ActiveMemory, TTLCache, _hash_key
from memory_layer import MemoryLayer
from token_analytics import TokenAnalytics
from router import Router


def make_storage(tmp_path):
    return Storage(db_dir=str(tmp_path / "db"))


def test_active_memory_workspace_surgical_invalidation():
    """Test that invalidating workspace A does not drop workspace B's cache."""
    calls = {"A": 0, "B": 0}

    def dummy_retrieval(query, limit=5, root="", session_id="", branch_id=""):
        if "ws_A" in root:
            calls["A"] += 1
            return f"<fact>Fact A {calls['A']}</fact>"
        else:
            calls["B"] += 1
            return f"<fact>Fact B {calls['B']}</fact>"

    am = ActiveMemory(dummy_retrieval, ttl=60.0)

    # 1. Warm up cache for both workspaces
    res_a1, meta_a1 = am.recall("c:/ws_A", "query 1", session_id="sess-1")
    res_b1, meta_b1 = am.recall("c:/ws_B", "query 1", session_id="sess-1")
    assert meta_a1["path"] == "live"
    assert meta_b1["path"] == "live"
    assert calls["A"] == 1
    assert calls["B"] == 1

    # 2. Check both hit cache
    res_a2, meta_a2 = am.recall("c:/ws_A", "query 1", session_id="sess-1")
    res_b2, meta_b2 = am.recall("c:/ws_B", "query 1", session_id="sess-1")
    assert meta_a2["path"] == "cache"
    assert meta_b2["path"] == "cache"
    assert calls["A"] == 1
    assert calls["B"] == 1

    # 3. Surgically invalidate workspace A only
    dropped = am.invalidate("c:/ws_A")
    assert dropped >= 1

    # 4. Workspace A must be a cache miss (live call), but Workspace B must STILL be a cache hit!
    res_a3, meta_a3 = am.recall("c:/ws_A", "query 1", session_id="sess-1")
    res_b3, meta_b3 = am.recall("c:/ws_B", "query 1", session_id="sess-1")
    assert meta_a3["path"] == "live"
    assert calls["A"] == 2
    assert meta_b3["path"] == "cache", "Workspace B's cache must NOT be wiped when Workspace A is invalidated!"
    assert calls["B"] == 1


def test_memory_session_scope_isolation(tmp_path):
    """Test that session-scoped memory is never retrieved in another session."""
    st = make_storage(tmp_path)
    root = "c:/workspace/proj1"

    # Insert a session-scoped memory for Session A
    st.save_memory_entry(
        eid="mem_sess_A",
        sid="session_A",
        root=root,
        scope="session",
        content="User secret preference in session A only",
    )

    # Insert a workspace/project memory
    st.save_memory_entry(
        eid="mem_proj",
        sid="session_A",
        root=root,
        scope="project",
        content="General project fact: Python 3.12",
    )

    # Query with Session A for session memory
    rows_a, _ = st.search_memory_hybrid(root=root, query_text="secret preference", session_id="session_A")
    contents_a = [r["content"] for r in rows_a]
    assert any("secret preference" in c for c in contents_a), f"Session A should recall its own session memory, got: {contents_a}"

    # Query with Session B for session memory
    rows_b, _ = st.search_memory_hybrid(root=root, query_text="secret preference", session_id="session_B")
    contents_b = [r["content"] for r in rows_b]
    assert not any("secret preference" in c for c in contents_b), "Session B must NOT see Session A's session-scoped memory!"

    # Query with no session_id
    rows_none, _ = st.search_memory_hybrid(root=root, query_text="secret preference", session_id="")
    contents_none = [r["content"] for r in rows_none]
    assert not any("secret preference" in c for c in contents_none), "Empty session_id must NOT see session-scoped memory!"

    # Query for project memory with Session B (should succeed since project scope is shared in workspace)
    rows_proj, _ = st.search_memory_hybrid(root=root, query_text="General project Python", session_id="session_B")
    contents_proj = [r["content"] for r in rows_proj]
    assert any("General project fact" in c for c in contents_proj), "Project memory should be visible in Session B"


def test_provider_usage_normalization_and_analytics():
    """Test usage normalization and TokenAnalytics hit rate formula."""
    # 1. DeepSeek usage: 100 hit, 300 miss -> 25% hit rate
    u_deepseek = {
        "prompt_tokens": 400,
        "completion_tokens": 50,
        "prompt_cache_hit_tokens": 100,
        "prompt_cache_miss_tokens": 300,
        "total_tokens": 450,
    }
    norm_ds = Router._normalize_usage(u_deepseek)
    assert norm_ds["cache_read"] == 100
    assert norm_ds["cache_miss"] == 300
    assert norm_ds["has_cache_info"] is True

    ta_ds = TokenAnalytics()
    ta_ds.update_from_usage(
        context_tokens=400,
        cache_read=norm_ds["cache_read"],
        cache_miss=norm_ds["cache_miss"],
        cache_creation=norm_ds["cache_creation"],
        has_cache_info=norm_ds["has_cache_info"],
    )
    snap_ds = ta_ds.snapshot()
    assert snap_ds["cache"]["averageHitRate"] == 0.25, f"Expected 0.25 (25%), got {snap_ds['cache']['averageHitRate']}"
    assert snap_ds["cache"]["cacheReadTokens"] == 100
    assert snap_ds["cache"]["cacheMissTokens"] == 300

    # 2. Anthropic usage: 200 read, 600 input (miss), 50 creation
    #    -> 200 / (200 + 600 + 50) = 200/850 = 23.53%
    #
    #    creation 必须进分母：它是新写进缓存的 token，不是命中。这里曾经算成
    #    200/800 = 25%（注释当年就写的 200/800），漏掉 creation；对 Anthropic
    #    尤其致命——它的 cache_miss 取的是 input_tokens（非缓存输入，不含
    #    creation），所以只要 input 很小，分母就只剩 read 自己，命中率恒等于
    #    1.0，界面永远显示 100%。app/tests/test_p3_ui_honesty.py 里那条
    #    test_hit_rate_is_not_a_flat_hundred_percent 守的就是这件事，但那棵树
    #    长期没被执行，所以两套口径一直各说各话、没人发现矛盾。
    u_anthropic = {
        "input_tokens": 600,
        "output_tokens": 80,
        "cache_read_input_tokens": 200,
        "cache_creation_input_tokens": 50,
        "total_tokens": 880,
    }
    norm_ant = Router._normalize_usage(u_anthropic)
    assert norm_ant["cache_read"] == 200
    assert norm_ant["cache_miss"] == 600
    assert norm_ant["cache_creation"] == 50
    assert norm_ant["input_is_exclusive"] is True

    ta_ant = TokenAnalytics()
    ta_ant.update_from_usage(
        context_tokens=800,
        cache_read=norm_ant["cache_read"],
        cache_miss=norm_ant["cache_miss"],
        cache_creation=norm_ant["cache_creation"],
        has_cache_info=norm_ant["has_cache_info"],
    )
    snap_ant = ta_ant.snapshot()
    # 200/850 —— creation 计入分母。见上方用例注释。
    assert snap_ant["cache"]["averageHitRate"] == pytest.approx(200 / 850, abs=1e-4)
    assert snap_ant["cache"]["cacheCreationTokens"] == 50

    # 3. Provider with no cache telemetry -> averageHitRate is None
    u_generic = {
        "prompt_tokens": 500,
        "completion_tokens": 100,
        "total_tokens": 600,
    }
    norm_gen = Router._normalize_usage(u_generic)
    assert norm_gen["has_cache_info"] is False
    assert norm_gen["cache_read"] == 0
    assert norm_gen["cache_miss"] == 0

    ta_gen = TokenAnalytics()
    ta_gen.update_from_usage(
        context_tokens=500,
        cache_read=norm_gen["cache_read"],
        cache_miss=norm_gen["cache_miss"],
        cache_creation=norm_gen["cache_creation"],
        has_cache_info=norm_gen["has_cache_info"],
    )
    snap_gen = ta_gen.snapshot()
    assert snap_gen["cache"]["averageHitRate"] is None, "No cache telemetry should yield None (unknown), not 0.0 or 1.0"


def test_prompt_stable_prefix_invariance_with_dynamic_hints():
    """Test that dynamic capability_hints do not alter the stable cache prefix."""
    from prompt_layers import PromptLayerLoader, CACHE_STABLE_LAYERS

    loader = PromptLayerLoader()

    # Turn 1: No capability hints
    overrides_1 = {
        "TOOLS": "## Available Skills\n- skill A\n- skill B",
        "MEMORY": "## Memory\n- user fact 1",
    }
    rendered_1, stable_1 = loader.render_and_prefix(overrides_1)

    # Turn 2: Different memory and dynamic hints in MEMORY
    overrides_2 = {
        "TOOLS": "## Available Skills\n- skill A\n- skill B",  # Stable
        "MEMORY": "## Memory\n- user fact 1\n\n## Recommended Capabilities for This Turn\n- hint X, hint Y",
    }
    rendered_2, stable_2 = loader.render_and_prefix(overrides_2)

    # The rendered full prompt changes, but stable prefix must be 100% identical!
    assert rendered_1 != rendered_2
    assert stable_1 == stable_2
    assert len(stable_1) > 50
