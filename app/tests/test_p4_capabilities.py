"""Capability-layer batch (E1–E4).

Each 语料 pins a capability that was either divergent or entirely absent:

  E1  four backend token estimators disagreed by up to 1.8x on the same text;
      now they are one function and one CJK range.
  E2  step-0 had zero overflow protection — precheck was skipped on the first
      call, and never counted the system prompt + tool definitions at all.
  E4  tool-call arguments accumulated in silence and appeared whole at the end,
      so a long call looked like a hang; now they stream.

The shared discipline mirrors the D batch: assert the mechanism ACTUALLY FIRES
and that the numbers AGREE across module boundaries, not merely that each side's
arithmetic is internally consistent.
"""
import inspect

import pytest

import token_estimate


# ── 语料 1 · E1 全后端共用一个估算器 ──────────────────────────────────────

def test_backend_estimators_are_one_function():
    """memory_tiers / memory_retrieval / compactor must all defer to token_estimate.

    The bug this pins: each module had its own copy, and tuning one left the
    others behind. If someone re-inlines a formula, the delegation check here
    fails before the divergence can ship.
    """
    import memory_tiers
    import memory_retrieval
    from context_compactor import ContextCompactor

    text = "统一 token 估算 unified estimator 12345"
    canonical = token_estimate.estimate_tokens(text)
    assert memory_tiers.estimate_tokens(text) == canonical
    assert memory_retrieval._token_len(text) == canonical

    c = ContextCompactor.__new__(ContextCompactor)
    assert c.estimate_tokens(text) == canonical


def test_cjk_is_one_token_each_and_ascii_is_quartered():
    # 4 wide chars → 4 tokens; 8 ascii chars → 2 tokens.
    assert token_estimate.estimate_tokens("你好世界") == 4
    assert token_estimate.estimate_tokens("abcdefgh") == 2
    # Mixed: 2 wide + 4 ascii → 2 + ceil(4/4) = 3.
    assert token_estimate.estimate_tokens("你好abcd") == 3


def test_kana_and_punct_are_no_longer_undercounted():
    """The old compactor range (\\u4e00-\\u9fff only) divided kana by 4.

    Japanese and CJK punctuation are wide characters; counting them 1:1 is the
    whole reason the ranges were unified. A regression here is a silent
    under-count that skips a fold.
    """
    assert token_estimate.wide_chars("こんにちは") == 5      # hiragana
    assert token_estimate.wide_chars("カタカナ") == 4         # katakana
    assert token_estimate.wide_chars("、。「」") == 4         # CJK punctuation
    assert token_estimate.wide_chars("한글") == 2             # hangul


def test_empty_is_zero_nonempty_is_never_zero():
    assert token_estimate.estimate_tokens("") == 0
    assert token_estimate.estimate_tokens("a") >= 1


def test_estimate_of_serialises_objects():
    # A dict must cost more than 0 — tool-call args arrive as dicts, and a
    # 0-token schema is exactly the "everything is free" lie E1 removes.
    assert token_estimate.estimate_tokens_of({"path": "/a/b", "content": "x"}) > 0
    assert token_estimate.estimate_tokens_of(None) == 0


def test_no_module_reinlines_a_cjk_ratio():
    """Guard against the divergence coming back by copy-paste.

    Any re-introduced ``/ 1.8`` or a bespoke CJK regex in these modules is the
    signature of a forked estimator.
    """
    import memory_tiers
    import memory_retrieval
    for mod in (memory_tiers, memory_retrieval):
        src = inspect.getsource(mod)
        # The delegating alias is fine; a re-inlined arithmetic ratio is not.
        assert "/ 1.8" not in src, f"{mod.__name__} re-inlined a CJK ratio"


# ── 语料 2 · E2 step-0 窗口预检把 overhead 算进去 ─────────────────────────

def _real_compactor(usable):
    from context_compactor import ContextCompactor
    c = ContextCompactor.__new__(ContextCompactor)
    c.max_tokens = usable
    c.reserved_tokens = 0
    c.session_id = None
    return c


def test_precheck_counts_overhead_even_with_no_messages():
    """The step-0 case: no tool results exist yet, so the only lever is refusing.

    A huge system-prompt + tool-def overhead with an empty message list must
    report ``fits=False`` — the old code returned early on empty messages and
    declared everything fine.
    """
    c = _real_compactor(usable=1000)
    report = c.precheck_inline([], overhead_tokens=2000)
    assert report["fits"] is False
    assert report["reason"] == "overhead-alone-exceeds"
    assert report["overhead"] == 2000


def test_precheck_overhead_folds_into_the_total():
    c = _real_compactor(usable=100000)
    small = [{"role": "user", "content": "hi"}]
    without = c.precheck_inline(list(small), overhead_tokens=0)
    withoh = c.precheck_inline(list(small), overhead_tokens=5000)
    assert withoh["before"] == without["before"] + 5000


def test_precheck_fits_true_when_under_ceiling():
    c = _real_compactor(usable=100000)
    report = c.precheck_inline([{"role": "user", "content": "hi"}], overhead_tokens=10)
    assert report["fits"] is True


def test_router_precheck_runs_on_step_zero():
    """The `if step > 0` guard is gone — the first call is the most likely to
    overflow (full history + system prompt + every tool def, nothing to prune)."""
    from router import Router
    src = inspect.getsource(Router._agent_loop)
    assert "precheck_inline" in src
    assert "if step > 0:" not in src, "step-0 is skipped again — the overflow gap is back"
    assert "_request_overhead_tokens" in src


def test_precheck_event_is_actually_bridged():
    """`context_precheck_pruned` used to be emitted to nobody. The renamed
    `context_precheck` must be wired into the WS bridge or the warning dies
    inside the process again."""
    from server import http_server
    src = inspect.getsource(http_server.WebSocketHandler._bridge_bus_events)
    assert '"context_precheck"' in src


# ── 语料 3 · E4 工具调用参数流式 ─────────────────────────────────────────

def test_llm_client_yields_tool_call_deltas():
    """The accumulation loop used to have no `yield` — args appeared only at
    `done`. It must now surface each fragment as `tool_call_delta`."""
    from llm_client import LLMClient
    src = inspect.getsource(LLMClient.chat_stream)
    assert '"type": "tool_call_delta"' in src
    # Still accumulates for the final assembly — streaming must not drop the
    # buffer the `done` envelope is built from.
    assert 'slot["arguments"]' in src


def test_router_forwards_and_flushes_tool_args():
    from router import Router
    src = inspect.getsource(Router._llm_chat_streamed)
    assert 'tool_call_delta' in src
    # The final fragment must be force-flushed, or the throttle can leave the
    # preview a few characters short of the executed call.
    assert "_flush_tool_args" in src


def test_tool_arg_frames_are_bridged():
    from server import http_server
    src = inspect.getsource(http_server.WebSocketHandler._bridge_bus_events)
    assert '"tool_call_delta"' in src


# ── 语料 4 · E3 工具 schema 描述补齐 ─────────────────────────────────────

#: Tools whose `description` is itself multi-paragraph prose covering purpose and
#: boundaries, so the separate fields would be redundant. Anything NOT on this
#: list must carry both boundary fields.
_PROSE_DESCRIBED = {"task", "ask_user", "plan_write", "tool_search"}


def _all_tool_defs():
    """Every ToolDef the domain agents register, without booting a Router."""
    from tools import get_tool_registry
    from file_agent import FileAgent
    from computer_agent import ComputerAgent
    from browser_agent import BrowserAgent
    from app_agent import AppAgent
    from search_agent import SearchAgent

    defs = []
    for cls in (FileAgent, ComputerAgent, BrowserAgent, AppAgent, SearchAgent):
        agent = cls.__new__(cls)
        agent.tools = get_tool_registry()
        agent.workspace = "."
        try:
            defs.extend(agent._build_tool_defs())
        except Exception as exc:  # pragma: no cover - surfaces as a clear failure
            pytest.fail(f"{cls.__name__}._build_tool_defs() raised: {exc}")
    return defs


def test_every_domain_tool_states_its_boundaries():
    """A one-line description tells the model WHAT a tool is, never WHEN not to
    reach for it — and "when not to" is the half that prevents `git_push` from
    being treated as part of tidying up. Roughly 40 tools had neither field."""
    thin = [
        td.name for td in _all_tool_defs()
        if td.name not in _PROSE_DESCRIBED
        and not (getattr(td, "when_to_use", "") and getattr(td, "when_not_to_use", ""))
    ]
    assert thin == [], f"tools with no usage boundaries: {thin}"


def test_boundaries_reach_the_model():
    """`llm_description()` is what actually ships. If the composition ever stops
    including the boundary fields, the prose above becomes dead weight."""
    defs = {td.name: td for td in _all_tool_defs()}
    td = defs["git_push"]
    shipped = td.llm_description()
    assert td.when_to_use in shipped
    assert td.when_not_to_use in shipped


def test_high_risk_tools_name_the_irreversible_part():
    """For the tools that cannot be undone, the boundary text has to say so —
    that sentence is the only thing standing between a plausible-looking call
    and a destroyed machine."""
    defs = {td.name: td for td in _all_tool_defs()}
    # app_uninstall left this list with the virtual-office removal (d0b0b671);
    # process_kill / delete_file are the irreversible tools that remain.
    for name in ("process_kill", "delete_file"):
        text = (defs[name].when_not_to_use or "").lower()
        assert "undo" in text or "not undoable" in text, f"{name} never says it is irreversible"


def test_every_required_param_is_described():
    """An undescribed required parameter is a guess waiting to happen."""
    missing = []
    for td in _all_tool_defs():
        props = (td.schema or {}).get("properties") or {}
        for pname in (td.schema or {}).get("required") or []:
            spec = props.get(pname) or {}
            if not spec.get("description"):
                missing.append(f"{td.name}.{pname}")
    assert missing == [], f"required params with no description: {missing}"
