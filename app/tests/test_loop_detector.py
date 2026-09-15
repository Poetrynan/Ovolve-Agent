"""Tool-call loop detection (C5).

The chat main loop had no no-progress check at all: a model could re-issue the
same failing call until `max_agent_steps` ran out, and the user got "thought for
a long time, achieved nothing". These tests pin each detector, the severity
ordering between them, and the threshold validation that keeps a hand-edited
config from leaving the circuit breaker unreachable.
"""
import pytest

from loop_detector import (
    KNOWN_POLL_TOOLS,
    LoopConfig,
    LoopDetector,
    Verdict,
    args_signature,
    result_signature,
)


# ── 语料 1 · 签名 ───────────────────────────────────────────────────────────

def test_arg_order_does_not_change_the_signature():
    """Providers do not promise key order; treating {a,b} and {b,a} as different
    calls would silently disable every detector."""
    assert args_signature("t", {"a": 1, "b": 2}) == args_signature("t", {"b": 2, "a": 1})


def test_different_args_give_different_signatures():
    assert args_signature("t", {"path": "a.py"}) != args_signature("t", {"path": "b.py"})


def test_the_tool_name_is_part_of_the_signature():
    assert args_signature("read", {"x": 1}) != args_signature("write", {"x": 1})


def test_unserializable_args_still_hash():
    class Weird:
        pass

    assert args_signature("t", {"o": Weird()})


def test_result_signature_ignores_line_numbers_and_timings():
    """The same failure reports a different line number and duration every time.
    Hashing it raw means "the result never changes" can never be observed."""
    a = result_signature("Error at line 41: failed in 12ms")
    b = result_signature("Error at line 87: failed in 30ms")
    assert a == b


def test_result_signature_still_separates_genuinely_different_text():
    assert result_signature("file not found") != result_signature("permission denied")


def test_no_result_yet_is_the_empty_signature():
    assert result_signature("") == ""


# ── 语料 2 · 阈值校验 ───────────────────────────────────────────────────────

def test_thresholds_are_forced_to_increase():
    """A config where warning >= critical means the harsher tier can never win the
    verdict — the circuit breaker is silently off. Clamp instead of trusting it."""
    c = LoopConfig(warning_threshold=9, critical_threshold=2,
                   global_circuit_breaker=1).validated()
    assert c.warning_threshold < c.critical_threshold < c.global_circuit_breaker


def test_a_bad_config_does_not_refuse_to_start():
    """A typo in one number must not take the whole agent down with it."""
    c = LoopConfig(warning_threshold=0, critical_threshold=-5,
                   global_circuit_breaker=0).validated()
    assert c.warning_threshold >= 1


def test_config_reads_the_agent_block():
    cfg = {"agent": {"loop_detection": {"warning_threshold": 4,
                                        "critical_threshold": 7,
                                        "global_circuit_breaker": 20}}}
    c = LoopConfig.from_config(cfg)
    assert (c.warning_threshold, c.critical_threshold, c.global_circuit_breaker) == (4, 7, 20)


def test_missing_config_falls_back_to_defaults():
    assert LoopConfig.from_config({}) == LoopConfig().validated()
    assert LoopConfig.from_config(None) == LoopConfig().validated()


def test_history_cannot_be_shorter_than_the_breaker_needs():
    """A history of 3 makes a breaker threshold of 10 unreachable by construction."""
    c = LoopConfig(global_circuit_breaker=10, history_size=3).validated()
    assert c.history_size >= c.global_circuit_breaker


def test_disabled_detector_never_reports():
    det = LoopDetector(LoopConfig(enabled=False))
    for _ in range(50):
        assert det.check("write_file", {"path": "a"}).level == ""
        slot = det.record("write_file", {"path": "a"})
        det.observe(slot, "same error every time")


# ── 语料 3 · generic_repeat（警告级）─────────────────────────────────────────

def _repeat(det, tool, args, times, result="identical failure"):
    """Run `times` full check/record/observe cycles, returning every verdict."""
    verdicts = []
    for _ in range(times):
        verdicts.append(det.check(tool, args))
        slot = det.record(tool, args)
        det.observe(slot, result)
    return verdicts


WRITE = "write_file"
ARGS = {"path": "a.py", "content": "x"}


def test_the_first_two_identical_calls_are_allowed():
    """Retrying once is normal behaviour, not a loop. A detector that fires on the
    second attempt would break far more than it fixes."""
    v = _repeat(LoopDetector(), WRITE, ARGS, 2)
    assert [x.level for x in v] == ["", ""]


def test_the_third_identical_call_gets_a_warning():
    v = _repeat(LoopDetector(), WRITE, ARGS, 3)
    assert v[2].level == "warning"
    assert v[2].detector == "generic_repeat"
    assert not v[2].blocks          # the call still runs; the model just gets told


def test_the_warning_names_the_tool_and_the_count():
    """The message is the whole intervention — a vague nudge teaches the model
    nothing about what to stop doing."""
    v = _repeat(LoopDetector(), WRITE, ARGS, 3)
    assert WRITE in v[2].message
    assert "3" in v[2].message


def test_a_polling_tool_is_exempt_from_the_repeat_warning():
    """Calling list_dir repeatedly is how the tool is meant to be used. Warning on
    it would train the model to distrust a correct habit."""
    poll = sorted(KNOWN_POLL_TOOLS)[0]
    det = LoopDetector()
    verdicts = []
    for i in range(4):
        verdicts.append(det.check(poll, {"path": "."}))
        slot = det.record(poll, {"path": "."})
        det.observe(slot, f"listing changed {i}")     # results differ → progress
    assert [x.level for x in verdicts] == ["", "", "", ""]


# ── 语料 4 · no_progress（临界级，双哈希）───────────────────────────────────

def test_identical_args_and_identical_results_get_blocked():
    v = _repeat(LoopDetector(), WRITE, ARGS, 5)
    assert v[4].level == "critical"
    assert v[4].detector == "no_progress"
    assert v[4].blocks


def test_changing_results_are_never_a_loop():
    """Same call, moving world: a build that reports a different error each time is
    making progress. Blocking it would stop real work."""
    det = LoopDetector()
    verdicts = []
    for i in range(9):
        verdicts.append(det.check(WRITE, ARGS))
        slot = det.record(WRITE, ARGS)
        det.observe(slot, f"distinct outcome {chr(97 + i)}")
    assert all(not x.blocks for x in verdicts)


def test_changing_args_are_never_a_loop():
    det = LoopDetector()
    verdicts = []
    for i in range(9):
        args = {"path": f"file{i}.py"}
        verdicts.append(det.check(WRITE, args))
        slot = det.record(WRITE, args)
        det.observe(slot, "same error every time")
    assert all(x.level == "" for x in verdicts)


def test_a_result_we_never_observed_does_not_count_as_no_progress():
    """A call whose result was never recorded is not evidence that nothing changed."""
    det = LoopDetector()
    for _ in range(9):
        det.record(WRITE, ARGS)          # recorded, never observed
    assert det.check(WRITE, ARGS).detector != "no_progress"


# ── 语料 5 · 轮询工具的无进展 ───────────────────────────────────────────────

def test_a_polling_tool_is_blocked_when_even_the_result_stops_changing():
    """Polling is legitimate; polling that never observes a change is not. This is
    the only tier polling tools are subject to."""
    poll = "git_status"
    det = LoopDetector()
    verdicts = []
    for _ in range(5):
        verdicts.append(det.check(poll, {}))
        slot = det.record(poll, {})
        det.observe(slot, "nothing to commit, working tree clean")
    assert verdicts[4].detector == "known_poll_no_progress"
    assert verdicts[4].blocks


# ── 语料 6 · 全局熔断 ───────────────────────────────────────────────────────

def test_the_breaker_is_reachable_because_refusals_are_recorded():
    """The regression this guards: if a blocked call is not recorded, the streak
    freezes at whatever tripped `critical` and the breaker becomes dead code —
    a mechanism that exists in the config and can never fire."""
    det = LoopDetector()
    seen = []
    for _ in range(14):
        v = det.check(WRITE, ARGS)
        seen.append(v)
        if v.blocks:
            det.record_blocked(WRITE, ARGS)      # what the router does
            continue
        slot = det.record(WRITE, ARGS)
        det.observe(slot, "identical failure")
    assert any(v.detector == "global_circuit_breaker" for v in seen)


def test_the_breaker_message_is_final_not_advisory():
    det = LoopDetector()
    for _ in range(14):
        v = det.check(WRITE, ARGS)
        if v.detector == "global_circuit_breaker":
            assert "熔断" in v.message
            return
        if v.blocks:
            det.record_blocked(WRITE, ARGS)
            continue
        slot = det.record(WRITE, ARGS)
        det.observe(slot, "identical failure")
    pytest.fail("global circuit breaker never fired")


def test_escalation_goes_warning_then_critical_then_breaker():
    """Order matters: a harsher tier that sits below a gentler one in the check
    sequence can never win a verdict."""
    det = LoopDetector()
    detectors = []
    for _ in range(14):
        v = det.check(WRITE, ARGS)
        detectors.append(v.detector)
        if v.blocks:
            det.record_blocked(WRITE, ARGS)
            continue
        slot = det.record(WRITE, ARGS)
        det.observe(slot, "identical failure")
    first_warn = detectors.index("generic_repeat")
    first_crit = detectors.index("no_progress")
    first_breaker = detectors.index("global_circuit_breaker")
    assert first_warn < first_crit < first_breaker


# ── 语料 7 · ping-pong ──────────────────────────────────────────────────────

def test_alternating_between_two_actions_is_detected():
    """A→B→A→B burns the budget exactly like A→A→A, but no same-action counter
    can see it — the signature is different every single step."""
    det = LoopDetector()
    a = {"path": "a.py"}
    b = {"path": "b.py"}
    verdict = None
    for i in range(10):
        args = a if i % 2 == 0 else b
        verdict = det.check(WRITE, args)
        if verdict.blocks:
            break
        slot = det.record(WRITE, args)
        det.observe(slot, f"outcome {i}")        # results differ → not no_progress
    assert verdict is not None and verdict.detector == "ping_pong"


def test_pure_repetition_is_not_reported_as_ping_pong():
    """It is a loop, but it is the other detector's loop; mislabelling it would make
    the message wrong and the logs misleading."""
    det = LoopDetector()
    for _ in range(4):
        slot = det.record(WRITE, ARGS)
        det.observe(slot, "identical failure")
    assert det.check(WRITE, ARGS).detector != "ping_pong"


def test_three_distinct_actions_are_not_ping_pong():
    """Cycling through three things is exploration, not oscillation."""
    det = LoopDetector()
    verdicts = []
    for i in range(12):
        args = {"path": f"{'abc'[i % 3]}.py"}
        verdicts.append(det.check(WRITE, args))
        slot = det.record(WRITE, args)
        det.observe(slot, f"outcome {i}")
    assert all(v.detector != "ping_pong" for v in verdicts)


# ── 语料 8 · unknown_tool_repeat ────────────────────────────────────────────

def test_repeating_a_hallucinated_tool_is_blocked_first():
    """A name that does not exist will not start existing on retry; this is the
    least useful loop of all, so it is checked before anything else."""
    det = LoopDetector()
    verdict = None
    for _ in range(4):
        verdict = det.check("make_it_work", {"x": 1}, tool_known=False)
        if verdict.blocks:
            break
        det.record("make_it_work", {"x": 1})
    assert verdict is not None and verdict.detector == "unknown_tool_repeat"


def test_a_known_tool_is_never_unknown_tool_repeat():
    v = _repeat_known(LoopDetector(), WRITE, ARGS, 4)
    assert all(x.detector != "unknown_tool_repeat" for x in v)


def _repeat_known(det, tool, args, times, result="identical failure"):
    out = []
    for _ in range(times):
        out.append(det.check(tool, args, tool_known=True))
        slot = det.record(tool, args)
        det.observe(slot, result)
    return out


# ── 语料 9 · 折叠后收紧 ─────────────────────────────────────────────────────

def test_post_compaction_guard_blocks_sooner():
    """Compaction wipes the model's short-term memory of what it already tried,
    which is exactly when it re-walks a dead end — so critical fires earlier."""
    det = LoopDetector(LoopConfig(critical_threshold=5, post_compaction_guard=3))
    det.note_compaction()
    verdicts = []
    for _ in range(4):
        verdicts.append(det.check(WRITE, ARGS))
        slot = det.record(WRITE, ARGS)
        det.observe(slot, "identical failure")
    # Guard tightens critical to ~post_compaction_guard+1 (=4) instead of 5.
    assert any(v.blocks for v in verdicts[:4])


def test_guard_expires_after_its_window():
    """The tightening is temporary; once the guard steps are spent the normal
    threshold returns, or every long session would run permanently twitchy."""
    det = LoopDetector(LoopConfig(critical_threshold=5, post_compaction_guard=2))
    det.note_compaction()
    # Burn the guard on a DIFFERENT, progressing action.
    for i in range(3):
        args = {"path": f"warm{i}.py"}
        det.check(WRITE, args)
        slot = det.record(WRITE, args)
        det.observe(slot, f"different {i}")
    assert det._guard_steps == 0


# ── 语料 10 · 历史有界 ──────────────────────────────────────────────────────

def test_history_is_bounded():
    """An unbounded history would grow for the whole turn; the deque is capped."""
    det = LoopDetector(LoopConfig(history_size=16))
    for i in range(500):
        det.record(WRITE, {"path": f"f{i}.py"})
    assert len(det._history) <= 16
