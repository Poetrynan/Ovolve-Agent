"""UI-honesty batch (D1–D8).

Every 语料 here pins a place where the interface stated something as fact that
was not true — and, in most cases, could never have been true, because the code
path that would have made it true had no callers at all.

  D1  cache hit rate was a flat 100% (the denominator was dropped from a dict)
  D2  cache savings were priced with hardcoded Anthropic rates for every model
  D4  the 精确/近似 badge keyed off "is there data", not "is it accurate"
  D5  the context-window denominator was hardcoded 200k every single turn
  D6  two of three action counters had no callers; the third never reset
  D7  three of four breakdown segments were structurally pinned to zero
  D8  a dead MCP server stayed "connected" forever, tools still registered

The shared discipline: for each mechanism, assert it ACTUALLY FIRES, not merely
that its arithmetic would be right if it did.
"""
import asyncio
import inspect

import pytest

import token_analytics
from token_analytics import TokenAnalytics, _classify_tool
from router import Router


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def ta():
    """A fresh engine — the module singleton would leak state across tests."""
    return TokenAnalytics()


# ── 语料 1 · D1 缓存命中率的分母被丢掉了 ──────────────────────────────────

class _BareUsage:
    """Just enough Router to exercise `_record_turn_usage`."""

    _record_turn_usage = Router._record_turn_usage
    _active_model_id = staticmethod(lambda: "openai:gpt-4o")

    def __init__(self):
        self._turn_seq = 1
        self.session_id = "s1"
        self.recorded = {}

        class _Models:
            @staticmethod
            def cost_of(model_id, acc):
                return {"cost_micros": 1234, "cache_saved_micros": 99,
                        "cost_source": "estimated"}

        class _Storage:
            def record_usage(inner, *a, **kw):
                self.recorded = kw

        self.models = _Models()
        self.storage = _Storage()


ACC = {
    "input": 1000, "output": 200, "reasoning": 0,
    "cache_read": 800, "cache_creation": 300, "provider_total": 1200, "calls": 1,
}


def test_summary_carries_cache_creation():
    """The bug in one line: `acc` had it, `summary` didn't, so every consumer
    downstream read a silent 0."""
    summary = _BareUsage()._record_turn_usage({"_usage_accum": dict(ACC)})
    assert summary["cache_creation"] == 300


def test_summary_carries_every_number_its_docstring_promises():
    summary = _BareUsage()._record_turn_usage({"_usage_accum": dict(ACC)})
    for key in ("tokens", "input", "output", "cache_read", "cache_creation",
                "cost_micros", "cache_saved_micros", "cost_source",
                "model_id", "calls"):
        assert key in summary, f"summary is missing {key}"


def test_hit_rate_is_not_a_flat_hundred_percent(ta):
    """800 read + 300 created = 72.7%, not 100%.

    This is the assertion the old code could never have passed: with
    cache_creation forced to 0 the rate was `read / (read + 0)` == 1.0 for any
    turn that touched the cache at all.
    """
    ta.update_from_usage(context_tokens=1800, cache_read=800, cache_creation=300)
    snap = ta.snapshot()
    assert snap["cache"]["averageHitRate"] == pytest.approx(800 / 1100, abs=1e-4)
    assert snap["cache"]["averageHitRate"] < 1.0


def test_a_pure_cache_hit_may_legitimately_be_one(ta):
    """Guard against over-correcting: with nothing created, 100% is the truth."""
    ta.update_from_usage(context_tokens=900, cache_read=900, cache_creation=0)
    assert ta.snapshot()["cache"]["averageHitRate"] == pytest.approx(1.0)


def test_cache_creation_tokens_reach_the_snapshot(ta):
    ta.update_from_usage(context_tokens=1800, cache_read=800, cache_creation=300)
    assert ta.snapshot()["cache"]["cacheCreationTokens"] == 300


# ── 语料 2 · D2 定价只能有一个来源 ────────────────────────────────────────

def test_analytics_module_hardcodes_no_prices():
    """The three Sonnet-tier constants are gone.

    They were applied to every model, so the green "节省 $X" figure was fiction
    for anything that was not Sonnet. `model_registry.compute_cost` already had
    per-model rates, user overrides and provider-reported bills; this module now
    consumes that instead of inventing a second, worse pricing table.
    """
    src = inspect.getsource(token_analytics)
    for banned in ("_CACHE_READ_PRICE_PER_M", "_NORMAL_INPUT_PRICE_PER_M",
                   "_CACHE_WRITE_PRICE_PER_M"):
        assert banned not in src, f"{banned} is back — pricing forked again"


def test_savings_come_from_the_caller(ta):
    ta.update_from_usage(context_tokens=1800, cache_read=800, cache_creation=300,
                         savings_micros=4200, cost_source="estimated")
    assert ta.snapshot()["cache"]["estimatedSavingsMicros"] == 4200


def test_savings_accumulate_across_turns(ta):
    for _ in range(3):
        ta.update_from_usage(context_tokens=100, cache_read=50, savings_micros=1000)
    assert ta.snapshot()["cache"]["estimatedSavingsMicros"] == 3000


def test_cost_source_is_exposed_so_the_ui_can_add_an_approx_sign(ta):
    """A rate-table number and a real bill must not render identically."""
    ta.update_from_usage(context_tokens=100, cache_read=50, savings_micros=10,
                         cost_source="fallback")
    assert ta.snapshot()["cache"]["costSource"] == "fallback"


def test_no_savings_reported_when_the_caller_prices_nothing(ta):
    """Better a missing figure than a made-up one."""
    ta.update_from_usage(context_tokens=100, cache_read=50, cache_creation=10)
    assert ta.snapshot()["cache"]["estimatedSavingsMicros"] == 0


# ── 语料 3 · D4 「精确/近似」徽章的判据 ───────────────────────────────────

def test_having_data_does_not_make_it_exact(ta):
    """The old predicate was `used == 0`, i.e. any data at all read "精确" —
    while the tooltip claimed per-token accuracy from the model's tokenizer."""
    ta.update_from_usage(context_tokens=5000, used_is_exact=False)
    assert ta.snapshot()["isEstimated"] is True


def test_provider_reported_numbers_are_marked_exact(ta):
    ta.update_from_usage(context_tokens=5000, used_is_exact=True)
    assert ta.snapshot()["isEstimated"] is False


def test_a_zero_turn_is_never_called_exact(ta):
    """Nothing measured yet — claiming exactness would be claiming to know 0."""
    assert ta.snapshot()["isEstimated"] is True


# ── 语料 4 · D5 上下文窗口分母 ────────────────────────────────────────────

def test_window_is_unknown_until_someone_says_otherwise(ta):
    """No hardcoded 200k. `total`/`percent` come back None and `windowKnown`
    is False, so the UI shows "窗口未知" instead of a confident wrong colour."""
    ta.update_from_usage(context_tokens=30_000)
    snap = ta.snapshot()
    assert snap["windowKnown"] is False
    assert snap["total"] is None
    assert snap["percent"] is None


def test_the_real_model_window_is_used_when_supplied(ta):
    """30k of a 32k window is 93.75% — the old code called it 15.0% (safe green)."""
    ta.update_from_usage(context_tokens=30_000, context_window=32_000)
    snap = ta.snapshot()
    assert snap["total"] == 32_000
    assert snap["percent"] == pytest.approx(93.8, abs=0.1)
    assert snap["windowKnown"] is True


def test_a_later_turn_without_a_window_does_not_erase_a_known_one(ta):
    """`update_from_usage` runs every turn; passing 0 must mean "no news",
    not "forget what you knew"."""
    ta.update_from_usage(context_tokens=1000, context_window=32_000)
    ta.update_from_usage(context_tokens=2000, context_window=0)
    assert ta.snapshot()["total"] == 32_000


def test_no_hardcoded_window_is_written_on_every_turn():
    src = inspect.getsource(TokenAnalytics.update_from_usage)
    assert "200_000" not in src and "200000" not in src


# ── 语料 5 · D6 三个行为计数 ──────────────────────────────────────────────

def test_rule_counter_increments(ta):
    """`on_rule_applied` existed and had zero callers, so the chip read 0
    forever. It is now called from RiskController.decide."""
    ta.on_rule_applied()
    ta.on_rule_applied()
    assert ta.snapshot()["actions"]["rulesApplied"] == 2


def test_subagent_counter_increments(ta):
    ta.on_subagent_delegate()
    assert ta.snapshot()["actions"]["subagentsDelegated"] == 1


def test_reset_turn_clears_the_per_turn_counters(ta):
    ta.on_tool_call("read_file")
    ta.on_rule_applied()
    ta.on_subagent_delegate()
    ta.reset_turn()
    acts = ta.snapshot()["actions"]
    assert acts == {"toolCalls": 0, "rulesApplied": 0,
                    "subagentsDelegated": 0, "toolBreakdown": {}}


def test_reset_turn_keeps_the_lifetime_totals(ta):
    """The popover says "本轮"; the totals block is the cumulative view. Both
    have to exist, or resetting one destroys the other's information."""
    ta.on_tool_call("read_file")
    ta.on_rule_applied()
    ta.on_subagent_delegate()
    ta.reset_turn()
    totals = ta.snapshot()["totals"]
    assert totals["toolCalls"] == 1
    assert totals["rulesApplied"] == 1
    assert totals["subagentsDelegated"] == 1


def test_action_stats_no_longer_lie_about_what_reset_means():
    """The old `_ActionStats.reset_turn` cleared only the category map and left
    a comment saying the counters were "cumulative" — while sitting inside a
    per-turn snapshot object. The method is gone; TokenAnalytics.reset_turn
    replaces the whole object."""
    assert not hasattr(token_analytics._ActionStats, "reset_turn")


def test_the_router_actually_calls_reset_turn():
    """The counter reset is only real if the turn entrypoint invokes it."""
    assert "reset_turn()" in inspect.getsource(Router.handle)


def test_tool_calls_are_still_counted_and_categorised(ta):
    ta.on_tool_call("read_file")
    ta.on_tool_call("run_command")
    acts = ta.snapshot()["actions"]
    assert acts["toolCalls"] == 2
    assert acts["toolBreakdown"] == {_classify_tool("read_file"): 1,
                                     _classify_tool("run_command"): 1}


# ── 语料 6 · D7 分段拆分的三段恒零 ────────────────────────────────────────

def test_all_four_segments_can_be_non_zero(ta):
    ta.update_from_usage(context_tokens=10_000, system_prompt_tokens=1_500,
                         tool_def_tokens=2_000, skill_tokens=500)
    b = ta.snapshot()["breakdown"]
    assert b == {"messages": 6_000, "systemPrompt": 1_500,
                 "tools": 2_000, "skills": 500}


def test_messages_absorbs_the_remainder_and_never_goes_negative(ta):
    """Known segments can exceed the reported total (different estimators);
    that must not render as a negative bar."""
    ta.update_from_usage(context_tokens=100, system_prompt_tokens=1_000)
    assert ta.snapshot()["breakdown"]["messages"] == 0


def test_the_system_prompt_is_built_not_probed_for():
    """`_emit_usage_frame` used to do `hasattr(self, '_system_prompt_text')`
    against a method that does not exist anywhere in the file — so `hasattr`
    was permanently False and that segment was permanently 0.

    Matched on the `hasattr` guard rather than the bare name, since the fix's own
    comment names the dead attribute while explaining it.
    """
    src = inspect.getsource(Router._emit_usage_frame)
    assert "hasattr(self, '_system_prompt_text')" not in src
    assert 'hasattr(self, "_system_prompt_text")' not in src
    assert "get_system_prompt()" in src


def test_get_system_prompt_actually_exists():
    """The other half of the same check: the replacement must be real."""
    assert callable(getattr(Router, "get_system_prompt", None))


# ── 语料 7 · D8 MCP 死连接不再显示「已连接」 ──────────────────────────────

class _DeadSession:
    """A session whose peer has gone away: every call raises."""

    def __init__(self, exc=None):
        self.exc = exc or ConnectionResetError("peer went away")
        self.pings = 0

    async def send_ping(self):
        self.pings += 1
        raise self.exc


class _HangingSession:
    """A session that accepts the ping and never answers — the stdio-child-was-
    SIGKILLed shape, which is exactly what a bare `await` cannot detect."""

    async def send_ping(self):
        await asyncio.sleep(3600)


class _LiveSession:
    def __init__(self):
        self.pings = 0

    async def send_ping(self):
        self.pings += 1


def _conn():
    """A connection object with only the fields the probe/hold path touches."""
    import mcp_manager
    obj = object.__new__(mcp_manager.MCPServerConnection)
    obj.status = "connected"
    obj.error = ""
    obj.tools = []
    obj.session = None
    obj.started_at = 0.0
    obj._stop = asyncio.Event()
    obj._ready = asyncio.Event()
    return obj


def test_probe_reports_a_reset_connection_as_dead():
    conn = _conn()
    alive, detail = run(conn._probe(_DeadSession()))
    assert alive is False
    assert "ConnectionResetError" in detail


def test_probe_reports_a_hang_as_dead_not_as_healthy(monkeypatch):
    """The whole point: silence is not health. Without a timeout this is the
    case that kept `status` at "connected" indefinitely."""
    import mcp_manager
    monkeypatch.setattr(mcp_manager, "HEARTBEAT_TIMEOUT", 0.05)
    conn = _conn()
    alive, detail = run(conn._probe(_HangingSession()))
    assert alive is False
    assert "超时" in detail


def test_probe_passes_a_live_session():
    conn = _conn()
    session = _LiveSession()
    alive, detail = run(conn._probe(session))
    assert alive is True and detail == ""
    assert session.pings == 1


def test_probe_does_not_kill_a_server_it_cannot_probe():
    """No ping and no list_tools available (older SDK): report alive rather than
    tearing down a server that may be perfectly fine."""
    conn = _conn()
    alive, _ = run(conn._probe(object()))
    assert alive is True


def test_a_failed_heartbeat_marks_the_server_lost(monkeypatch):
    import mcp_manager
    monkeypatch.setattr(mcp_manager, "HEARTBEAT_INTERVAL", 0.01)
    monkeypatch.setattr(mcp_manager, "HEARTBEAT_TIMEOUT", 0.05)
    conn = _conn()
    run(conn._hold_until_stopped(_DeadSession()))
    assert conn.status == "lost"
    assert conn.error


def test_a_stop_request_is_still_a_clean_shutdown(monkeypatch):
    """The heartbeat must not turn an intentional stop into a "lost" server."""
    import mcp_manager
    monkeypatch.setattr(mcp_manager, "HEARTBEAT_INTERVAL", 5.0)
    conn = _conn()

    async def scenario():
        conn._stop.set()
        await conn._hold_until_stopped(_LiveSession())

    run(scenario())
    assert conn.status == "connected"


def test_a_live_server_is_left_alone(monkeypatch):
    """A healthy session keeps getting probed and keeps its status."""
    import mcp_manager
    monkeypatch.setattr(mcp_manager, "HEARTBEAT_INTERVAL", 0.01)
    conn = _conn()
    session = _LiveSession()

    async def scenario():
        task = asyncio.ensure_future(conn._hold_until_stopped(session))
        await asyncio.sleep(0.06)
        conn._stop.set()
        await task

    run(scenario())
    assert conn.status == "connected"
    assert session.pings >= 2


def test_stop_preserves_lost_instead_of_relabelling_it_idle():
    """`lost` is the only signal that a server died on its own; an explicit stop
    afterwards must not overwrite it with a tidy `idle`."""
    src = inspect.getsource(__import__("mcp_manager").MCPServerConnection.stop)
    assert '("failed", "lost")' in src


def test_the_runner_unregisters_tools_when_the_server_dies():
    """Status alone is not enough — a dead server's tools must leave the
    registry, or the model keeps being offered calls that cannot work."""
    src = inspect.getsource(__import__("mcp_manager").MCPServerConnection._runner)
    assert "_unregister_tools" in src
    assert '("failed", "lost")' in src
